'use strict';
// A live line to the server (the same one the website uses), so a new notification (a boost, a direct
// message) shows within a second instead of waiting for the next 20-second check. The 20-second check
// stays as the backup: if this line drops, nothing is missed, it is only slower until it reconnects.

class LiveFeed {
  constructor({ baseUrl, getToken, headers = {}, fetchImpl = globalThis.fetch, onEvent, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.getToken = getToken; this.headers = headers; this.fetch = fetchImpl; this.onEvent = onEvent; this.wait = wait;
    this.running = false; this.ctrl = null; this.connected = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  // drop the current line and reconnect (signing in or out, or a new server)
  reconnect() {
    if (this.ctrl) { try { this.ctrl.abort(); } catch { /* already closed */ } }
  }

  stop() {
    this.running = false; this.connected = false;
    if (this.ctrl) { try { this.ctrl.abort(); } catch { /* already closed */ } }
  }

  async loop() {
    let backoff = 2000;
    while (this.running) {
      const token = this.getToken();
      if (!token) { await this.wait(5000); continue; }
      try {
        await this.once(token);
        backoff = 2000;   // it was up; a server restart reconnects quickly
      } catch { /* offline or signed out: try again later */ }
      this.connected = false;
      if (!this.running) break;
      await this.wait(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }

  async once(token) {
    this.ctrl = new AbortController();
    const res = await this.fetch(`${this.baseUrl}/api/events`, {
      headers: { Accept: 'text/event-stream', ...this.headers, Authorization: `Bearer ${token}` },
      signal: this.ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
    this.connected = true;
    const dec = new TextDecoder();
    let buf = '';
    // the server pings every so often; if nothing at all arrives for 90 seconds the line is dead
    let quiet;
    const arm = () => { clearTimeout(quiet); quiet = setTimeout(() => { try { this.ctrl.abort(); } catch { /* gone */ } }, 90000); };
    arm();
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        arm();
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          if (ev && ev.type && ev.type !== 'ping') { try { this.onEvent(ev); } catch { /* one bad handler never drops the line */ } }
        }
      }
    } finally { clearTimeout(quiet); }
  }
}

module.exports = { LiveFeed };
