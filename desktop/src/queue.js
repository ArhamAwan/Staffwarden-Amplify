'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { NetworkError, ApiError } = require('./client');

// Screenshots waiting to upload are encrypted on disk (AES-256-GCM) with a key the operating system's
// keychain protects, so they cannot be opened from the folder by anyone else on the computer.
function seal(key, buf) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(key, buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

// Durable outbox. Everything the tracker produces goes here first and is uploaded in
// order, so a dropped connection (or a crash) never loses data.
class OfflineQueue {
  constructor(dir, { maxItems = 2000, log = () => {}, key = null } = {}) {
    this.dir = dir;
    this.key = key && key.length === 32 ? key : null;
    this.file = path.join(dir, 'queue.json');
    this.shotDir = path.join(dir, 'shots');
    this.maxItems = maxItems;
    this.log = log;
    fs.mkdirSync(this.shotDir, { recursive: true });
    this.items = this.load();
    this.running = null;
    // whose work this is: "<server>|<user id>". Items are tagged with it and only sent with that same
    // account's sign-in, so after a switch nothing one person captured is ever uploaded as someone else.
    this.owner = null;
  }

  setOwner(owner) { this.owner = owner || null; }
  // An item tagged with an account is only ever sent with that account; untagged items (made before
  // anyone was known, or by versions before owners existed) go with whoever is signed in.
  mine(item) { return item.owner == null || item.owner === this.owner; }

  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.file); // atomic: a crash never leaves a half-written queue
  }

  get size() { return this.items.length; }

  readShot(f) {
    const b = fs.readFileSync(f);
    if (!f.endsWith('.bin')) return b;              // saved by an older version, before encryption
    if (!this.key) throw new Error('no key for this screenshot');
    return open(this.key, b);
  }

  add(item) {
    // A newer activity total for the same slot replaces the older one that has not been sent yet.
    if (item.type === 'activity') {
      // (never the one being uploaded right now: its upload already started with the older numbers)
      const same = this.items.find((x) => x !== this.sending && x.type === 'activity' && x.owner === (item.owner === undefined ? this.owner : item.owner) && x.payload.slot_start === item.payload.slot_start && x.payload.entry_id === item.payload.entry_id);
      if (same) { same.payload = item.payload; this.save(); return; }
    }
    if (item.owner === undefined) item.owner = this.owner;
    this.items.push(item);
    while (this.items.length > this.maxItems) {
      const i = this.items.findIndex((x) => x.type === 'screenshot'); // shed oldest screenshots first
      const [dropped] = this.items.splice(i === -1 ? 0 : i, 1);
      this.discard(dropped);
    }
    this.save();
  }

  addScreenshot({ slot_start, taken_at, buf, thumb, privacy = null }) {
    const stem = crypto.randomBytes(8).toString('hex');
    const ext = this.key ? '.bin' : '.jpg';
    const write = (f, b) => fs.writeFileSync(f, this.key ? seal(this.key, b) : b, { mode: 0o600 });
    const file = path.join(this.shotDir, stem + ext);
    write(file, buf);
    let thumbFile = null;
    if (thumb) { thumbFile = path.join(this.shotDir, stem + '_t' + ext); write(thumbFile, thumb); }
    this.add({ type: 'screenshot', slot_start, taken_at, file, thumbFile, privacy });
  }

  // Forget screenshots that were captured at or after `iso` and not yet uploaded (used when time is
  // backdated into a pause: nothing may remain from a moment the timer was not working).
  purgeShotsSince(iso) {
    const keep = [], drop = [];
    for (const x of this.items) (x.type === 'screenshot' && x.taken_at >= iso ? drop : keep).push(x);
    if (!drop.length) return 0;
    this.items = keep;
    drop.forEach((x) => this.discard(x));
    this.save();
    return drop.length;
  }

  discard(item) {
    if (item && item.type === 'screenshot') {
      for (const f of [item.file, item.thumbFile]) { if (f) { try { fs.unlinkSync(f); } catch { /* already gone */ } } }
    }
  }

  async send(client, item) {
    switch (item.type) {
      case 'activity': return client.postActivity(item.payload);
      case 'pause': return client.pauseTimer(item.reason, item.at);
      case 'resume': return client.resumeTimer(item.at);
      case 'idle': return client.idle(item.state, item.at);
      case 'stop': return client.stopTimer(item.ended_at, item.reason);
      case 'screenshot': {
        let buf, thumb = null;
        try { buf = this.readShot(item.file); } catch { return; } // file vanished (or cannot be opened): nothing to send
        if (item.thumbFile) { try { thumb = this.readShot(item.thumbFile); } catch { /* upload without */ } }
        return client.postScreenshot({ slot_start: item.slot_start, taken_at: item.taken_at, buf, thumb, privacy: item.privacy || null });
      }
      default: return undefined;
    }
  }

  // Uploads in order. Stops at the first transient failure (offline / 5xx / expired login)
  // and keeps the rest. Permanent rejections (other 4xx) are dropped so one bad item can't block the queue.
  // Calling flush while one is running joins that run, so callers can always `await` a complete upload.
  flush(client) {
    if (this.running) return this.running;
    this.running = this.run(client).finally(() => { this.running = null; });
    return this.running;
  }

  async run(client) {
    let sent = 0, blocked = null;
    for (;;) {
      // the next thing this account made (another account's waits for that account's sign-in)
      const item = this.items.find((x) => this.mine(x));
      if (!item) break;
      this.sending = item;
      try {
        await this.send(client, item);
        sent++;
      } catch (e) {
        if (e instanceof NetworkError) { blocked = 'offline'; break; }
        if (e instanceof ApiError && (e.status === 401 || e.status >= 500)) { blocked = e.status === 401 ? 'auth' : 'server'; break; }
        this.log(`dropping ${item.type}: ${e.message}`); // permanent failure
      } finally { this.sending = null; }
      const i = this.items.indexOf(item);   // the list may have changed while we awaited
      if (i >= 0) this.items.splice(i, 1);
      this.discard(item);
      this.save();
    }
    return { sent, remaining: this.items.filter((x) => this.mine(x)).length, blocked };
  }
}

module.exports = { OfflineQueue };
