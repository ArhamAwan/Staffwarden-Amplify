'use strict';
// Developer access. The owner can give someone the tools to look after the system itself: server health
// and backups, a notice at the top of every screen, the desktop apps (who runs which version, uploading a
// new version from the browser, going back to the previous one), error reports, feature switches and test
// tools. A developer also has the owner's view and powers everywhere else (set when they sign in), except
// the owner's own account and giving this access to anyone. Everyone is told who has it, and every action
// here is audited.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, str, optStr, int, isoDate } = require('../lib/http');

// the features that can be switched off, or tried with a few people first
const FEATURES = {
  boost_clip: { name: 'Boost clip', desc: 'The full-screen owl clip when the owner sends a boost. Off: the boost still arrives as a notification.' },
  voice_notes: { name: 'Voice messages', desc: 'Recording and sending voice messages in chat. Off: people can still listen to ones already sent.' },
  gifs: { name: 'GIFs in chat', desc: 'Searching and sending GIFs in chat.' },
};
const NOTIFY_TESTS = {
  message: { title: 'Test: a new message', body: 'This is how a chat message notification looks.', link: '#/chat' },
  boost: { title: 'Test: a boost from the owner', body: 'This is how a boost looks when it arrives.', link: '#/' },
  checkin: { title: 'Test: a check-in', body: 'This is how a check-in reminder looks.', link: '#/' },
  urgent: { title: 'Test: an urgent notice', body: 'Urgent notices come through even in quiet hours.', link: '#/', urgent: true },
};

module.exports = (ctx) => {
  const { db, cfg, route, audit } = ctx;
  const startedAt = Date.now();
  // only people the owner switched it on for (the owner too, only if he switches it on for himself)
  const isDev = (u) => !!u && u.kind !== 'client' && !u.preview && !!u.is_dev;
  const needDev = (u) => need(isDev(u), 403, 'Only people with developer access can do this');
  ctx.isDev = isDev;
  const backupDir = ctx.backupDir || process.env.WORKHELM_BACKUP_DIR || '/var/backups/workhelm';
  const offsiteLog = ctx.offsiteLog || process.env.WORKHELM_OFFSITE_LOG || '/var/log/workhelm-offsite.log';
  const dlDir = () => ctx.dlDir;

  // ---- feature switches ----
  const featureRow = (key) => db.prepare('SELECT * FROM features WHERE key = ?').get(key);
  function featureOn(key, userId) {
    const r = featureRow(key);
    if (!r || r.mode === 'everyone') return true;
    if (r.mode === 'off') return false;
    let beta = []; try { beta = JSON.parse(r.beta); } catch { /* none */ }
    return beta.includes(Number(userId));
  }
  ctx.featureOn = featureOn;
  ctx.featuresFor = (userId) => Object.keys(FEATURES).filter((k) => featureOn(k, userId));

  // ---- error reports ----
  // Grouped by what went wrong: the message and where in the code, with numbers and addresses taken out,
  // so a thousand copies of one problem are one row. Nothing typed, no window titles, no screenshots.
  const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, n);
  const scrub = (s) => s.replace(/(token|password|authorization|bearer)[=: ]+\S+/gi, '$1=…').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '…@…');
  const firstFrame = (stack) => (String(stack || '').split('\n').find((l) => /\bat\b|@/.test(l)) || '').replace(/\?[^\s:)]*/g, '').replace(/:\d+(:\d+)?/g, '').trim();
  const sigOf = (source, title, stack) => crypto.createHash('sha1').update(`${source}|${title.replace(/\d+/g, '#').replace(/'[^']*'|"[^"]*"/g, '…')}|${firstFrame(stack)}`).digest('hex').slice(0, 16);
  function recordError({ source, title, detail, version, platform, userId }) {
    source = ['web', 'desktop', 'server', 'portal'].includes(source) ? source : 'web';
    title = scrub(clean(title, 240)).trim() || 'Unknown error';
    detail = scrub(clean(detail, 4000));
    const sig = sigOf(source, title, detail);
    const now = ctx.nowIso();
    const row = db.prepare('SELECT status FROM error_groups WHERE sig = ?').get(sig);
    if (row) {
      // something marked fixed that comes back from a newer version than the fix is open again
      const reopen = row.status === 'fixed';
      db.prepare(`UPDATE error_groups SET count = count + 1, last_at = ?, version = COALESCE(?, version), platform = COALESCE(?, platform), detail = ?${reopen ? ", status = 'open'" : ''} WHERE sig = ?`)
        .run(now, version || null, platform || null, detail, sig);
    } else {
      db.prepare('INSERT INTO error_groups (sig, source, title, detail, version, platform, count, first_at, last_at) VALUES (?,?,?,?,?,?,1,?,?)')
        .run(sig, source, title, detail, version || null, platform || null, now, now);
    }
    if (userId) {
      db.prepare(`INSERT INTO error_people (sig, user_id, count, last_at) VALUES (?,?,1,?)
        ON CONFLICT(sig, user_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).run(sig, userId, now);
    }
    return sig;
  }
  ctx.recordError = (e, user) => {
    try { recordError({ source: 'server', title: e && e.message, detail: e && e.stack, version: null, platform: null, userId: user && user.kind !== 'client' ? user.id : null }); } catch { /* never fail twice */ }
  };
  // at most 30 reports a minute from one person, so a loop in someone's browser can't fill the database
  const sent = new Map();
  route('POST', '/api/errors', ({ user, body, req }) => {
    const key = user.kind === 'client' ? `c${user.id}` : `u${user.id}`;
    const now = Date.now();
    const w = (sent.get(key) || []).filter((t) => now - t < 60000);
    if (w.length >= 30) return { ok: true, dropped: true };
    w.push(now); sent.set(key, w);
    const m = /^(\d{1,4}\.\d{1,4}\.\d{1,4}) (\w+) (\w+)$/.exec(String(req.headers['x-workhelm-app'] || ''));
    const source = user.kind === 'client' ? 'portal' : body.source === 'desktop' ? 'desktop' : 'web';
    recordError({ source, title: body.message, detail: body.stack, version: m ? m[1] : clean(body.version, 20) || null, platform: m ? `${m[2]} ${m[3]}` : clean(body.platform, 40) || null, userId: user.kind === 'client' ? null : user.id });
    return { ok: true };
  }, { client: true });

  route('GET', '/api/dev/errors', ({ user, query }) => {
    needDev(user);
    const status = ['open', 'fixed', 'ignored'].includes(query.get('status')) ? query.get('status') : 'open';
    const rows = db.prepare('SELECT * FROM error_groups WHERE status = ? ORDER BY last_at DESC LIMIT 200').all(status);
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM error_groups GROUP BY status').all().map((r) => [r.status, r.n]));
    const day = new Date(ctx.now() - 86400000).toISOString();
    return {
      counts: { open: counts.open || 0, fixed: counts.fixed || 0, ignored: counts.ignored || 0 },
      new_today: db.prepare("SELECT COUNT(*) n FROM error_groups WHERE status = 'open' AND first_at > ?").get(day).n,
      groups: rows.map((r) => {
        const people = db.prepare('SELECT u.id, u.name FROM error_people p JOIN users u ON u.id = p.user_id WHERE p.sig = ? ORDER BY p.last_at DESC').all(r.sig);
        return { sig: r.sig, source: r.source, title: r.title, detail: r.detail, version: r.version, platform: r.platform, count: r.count, first_at: r.first_at, last_at: r.last_at, status: r.status, fixed_in: r.fixed_in, people: people.slice(0, 8), people_count: people.length };
      }),
    };
  });
  route('PATCH', '/api/dev/errors/:sig', ({ user, params, body }) => {
    needDev(user);
    const r = db.prepare('SELECT * FROM error_groups WHERE sig = ?').get(params.sig);
    need(r, 404, 'Error report not found');
    need(['open', 'fixed', 'ignored'].includes(body.status), 400, 'status must be open, fixed or ignored');
    db.prepare('UPDATE error_groups SET status = ?, fixed_in = ? WHERE sig = ?').run(body.status, body.status === 'fixed' ? optStr(body.fixed_in, 'fixed_in', 20) : null, r.sig);
    audit(user, `dev.error_${body.status}`, null, r.title.slice(0, 120));
    return { ok: true };
  });

  // ---- health ----
  const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  function backups() {
    let files = [];
    try { files = fs.readdirSync(backupDir).filter((f) => /\.db(\.gz)?$/.test(f)).map((f) => { const st = fs.statSync(path.join(backupDir, f)); return { file: f, size: st.size, at: st.mtime.toISOString() }; }); } catch { return { found: false, dir: backupDir, files: [] }; }
    files.sort((a, b) => (a.at < b.at ? 1 : -1));
    let offsite = null;
    try {
      const lines = fs.readFileSync(offsiteLog, 'utf8').trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      offsite = { last: last.slice(0, 200), at: fs.statSync(offsiteLog).mtime.toISOString(), ok: !/fail|error/i.test(last) };
    } catch { /* off-site copies not set up */ }
    return { found: true, dir: backupDir, files: files.slice(0, 14), count: files.length, offsite };
  }
  route('GET', '/api/dev/health', ({ user }) => {
    needDev(user);
    let disk = null;
    try { const s = fs.statfsSync(cfg.dataDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { /* not available */ }
    const live = ctx.liveCounts ? ctx.liveCounts() : { staff: 0, clients: 0 };
    const dbBytes = cfg.dbFile === ':memory:' ? 0 : fileSize(cfg.dbFile) + fileSize(`${cfg.dbFile}-wal`);
    const d = new Date(ctx.now() - 86400000).toISOString();
    return {
      build: ctx.BUILD, node: process.version, started_at: new Date(startedAt).toISOString(), uptime_s: Math.round((Date.now() - startedAt) / 1000),
      host_uptime_s: Math.round(os.uptime()),
      schema: db.prepare('PRAGMA user_version').get().user_version,
      db_bytes: dbBytes,
      disk, memory: { total: os.totalmem(), free: os.freemem(), process: process.memoryUsage().rss }, load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length,
      live,
      people: { active: db.prepare("SELECT COUNT(*) n FROM users WHERE active = 1").get().n, working: db.prepare('SELECT COUNT(*) n FROM time_entries WHERE ended_at IS NULL').get().n },
      errors: { open: db.prepare("SELECT COUNT(*) n FROM error_groups WHERE status = 'open'").get().n, today: db.prepare("SELECT COALESCE(SUM(count),0) n FROM error_groups WHERE last_at > ?").get(d).n },
      backups: backups(),
      banner: activeBanner(true),
    };
  });

  // ---- the notice at the top of every screen ----
  function activeBanner(all = false) {
    const b = cfg.banner;
    if (!b || !b.text) return null;
    const now = ctx.now();
    if (!all && ((b.from && Date.parse(b.from) > now) || (b.until && Date.parse(b.until) <= now))) return null;
    return { text: b.text, from: b.from || null, until: b.until || null, tone: b.tone || 'info', id: b.id, scheduled: !!(b.from && Date.parse(b.from) > now), ended: !!(b.until && Date.parse(b.until) <= now) };
  }
  route('GET', '/api/banner', () => ({ banner: activeBanner() }), { client: true });
  route('PUT', '/api/dev/banner', ({ user, body }) => {
    needDev(user);
    if (!body.text) {
      ctx.saveSetting('banner', null);
      audit(user, 'dev.banner_cleared');
    } else {
      const text = str(body.text, 'text', 200);
      const from = body.from ? isoDate(body.from, 'from') : null;
      const until = body.until ? isoDate(body.until, 'until') : null;
      need(!from || !until || from < until, 400, 'The notice has to end after it starts');
      const tone = body.tone === 'warn' ? 'warn' : 'info';
      ctx.saveSetting('banner', { text, from, until, tone, id: crypto.randomBytes(4).toString('hex'), by: user.id });
      audit(user, 'dev.banner_set', null, text.slice(0, 120));
    }
    ctx.emitAll && ctx.emitAll('banner');
    return { banner: activeBanner(true) };
  });

  // ---- desktop apps ----
  const kindOf = (platform) => (/^win32/.test(platform || '') ? 'windows' : /^darwin arm64/.test(platform || '') ? 'mac-arm' : /^darwin/.test(platform || '') ? 'mac-intel' : null);
  function latestByKind() {
    const out = {};
    for (const d of ctx.listDownloads()) if (d.version && !out[d.kind]) out[d.kind] = d.version;
    return out;
  }
  route('GET', '/api/dev/fleet', ({ user }) => {
    needDev(user);
    const latest = latestByKind();
    const people = db.prepare("SELECT id, name, role, app_version, app_platform, last_seen_at FROM users WHERE active = 1 ORDER BY name").all().map((u) => {
      const kind = kindOf(u.app_platform);
      const want = kind ? latest[kind] : null;
      return { id: u.id, name: u.name, role: u.role, version: u.app_version || null, platform: u.app_platform || null, kind, last_seen_at: u.last_seen_at || null,
        state: !u.app_version ? 'none' : want && ctx.cmpVersion(u.app_version, want) < 0 ? 'old' : 'current' };
    });
    return { latest, people };
  });
  route('POST', '/api/dev/fleet/remind', ({ user }) => {
    needDev(user);
    const latest = latestByKind();
    const ids = db.prepare('SELECT id, app_version, app_platform FROM users WHERE active = 1 AND app_version IS NOT NULL').all()
      .filter((u) => { const w = latest[kindOf(u.app_platform)]; return w && ctx.cmpVersion(u.app_version, w) < 0; }).map((u) => u.id);
    if (ids.length) ctx.notify.notify(ids, { kind: 'app_update', title: 'Please update the desktop app', body: 'A newer version is ready. Open the app and choose Update, or download it from the sign-in page.', link: '#/', dedupe: `app-update-${Object.values(latest).join('-')}` });
    audit(user, 'dev.fleet_reminded', null, `${ids.length} people`);
    return { reminded: ids.length };
  });

  // ---- releases: upload a new version from the browser, or go back to the previous one ----
  // The files arrive in pieces (a whole Mac app is over 100 MB, more than one request can carry), are
  // checked against their SHA-256, and only then replace the current ones. The current ones are kept in
  // archive/<version>, so going back is one click.
  const KIND = (f) => (/\.exe$/i.test(f) ? 'windows' : /mac.*(arm|apple)/i.test(f) ? 'mac-arm' : /mac.*(intel|x64)/i.test(f) || /\.(dmg|zip)$/i.test(f) ? 'mac-intel' : null);
  const VERSION = (f) => { const m = /(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(f); return m ? `${+m[1]}.${+m[2]}.${+m[3]}` : null; };
  const SAFE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;
  const uploads = new Map();       // id -> { files: [{name,size,sha256,got}], dir, by, at }
  const incoming = () => path.join(dlDir(), '.incoming');
  const archiveDir = () => path.join(dlDir(), 'archive');
  function readNotes(dir) { try { return fs.readFileSync(path.join(dir, 'release-notes.txt'), 'utf8').trim(); } catch { return ''; } }
  function archived() {
    let vs = [];
    try { vs = fs.readdirSync(archiveDir()).filter((v) => /^\d+\.\d+\.\d+$/.test(v)); } catch { return []; }
    return vs.sort((a, b) => ctx.cmpVersion(b, a)).map((v) => {
      const dir = path.join(archiveDir(), v);
      const files = fs.readdirSync(dir).filter((f) => KIND(f)).map((f) => ({ file: f, kind: KIND(f), size: fileSize(path.join(dir, f)) }));
      return { version: v, files, notes: readNotes(dir), at: fs.statSync(dir).mtime.toISOString() };
    });
  }
  route('GET', '/api/dev/releases', ({ user }) => {
    needDev(user);
    const cur = ctx.listDownloads();
    const fleet = db.prepare('SELECT app_version v, app_platform p FROM users WHERE active = 1 AND app_version IS NOT NULL').all();
    const on = (v) => fleet.filter((x) => x.v === v).length;
    return { current: cur, notes: readNotes(dlDir()), version: cur[0] ? cur[0].version : null, on_current: cur[0] ? on(cur[0].version) : 0, with_app: fleet.length, archive: archived().map((a) => ({ ...a, on: on(a.version) })) };
  });
  route('POST', '/api/dev/releases/start', ({ user, body }) => {
    needDev(user);
    need(Array.isArray(body.files) && body.files.length >= 1 && body.files.length <= 6, 400, 'Choose between 1 and 6 files');
    const files = body.files.map((f) => {
      need(f && typeof f.name === 'string' && SAFE.test(f.name), 400, 'File names can only use letters, numbers, spaces, dots and dashes');
      need(KIND(f.name), 400, `${f.name} isn't an installer this server knows: a Windows .exe, or a Mac .zip with Intel or AppleSilicon in its name`);
      need(VERSION(f.name), 400, `${f.name} has no version number in its name, like 0.9.22`);
      need(Number.isInteger(f.size) && f.size > 0 && f.size <= 400 * 1024 * 1024, 400, 'Each file must be under 400 MB');
      need(/^[0-9a-f]{64}$/.test(String(f.sha256 || '')), 400, 'sha256 is required');
      return { name: f.name, size: f.size, sha256: f.sha256, got: 0 };
    });
    const vs = new Set(files.map((f) => VERSION(f.name)));
    need(vs.size === 1, 400, 'All files must be the same version');
    need(new Set(files.map((f) => KIND(f.name))).size === files.length, 400, 'Only one file for each kind of computer');
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(incoming(), id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f.name), '');
    uploads.set(id, { files, dir, by: user.id, at: Date.now(), version: [...vs][0] });
    // forget uploads left half-done for a day
    for (const [k, u] of uploads) if (Date.now() - u.at > 86400000) { fs.rmSync(u.dir, { recursive: true, force: true }); uploads.delete(k); }
    return { id, version: [...vs][0], chunk: 4 * 1024 * 1024 };
  });
  route('POST', '/api/dev/releases/:id/chunk', ({ user, params, body }) => {
    needDev(user);
    const u = uploads.get(params.id);
    need(u && u.by === user.id, 404, 'Upload not found. Start again.');
    const f = u.files.find((x) => x.name === body.name);
    need(f, 400, 'That file is not part of this upload');
    need(body.offset === f.got, 409, `Expected the piece at ${f.got}`);
    need(typeof body.data === 'string', 400, 'data is required');
    const buf = Buffer.from(body.data, 'base64');
    need(buf.length > 0 && f.got + buf.length <= f.size, 400, 'That piece is larger than the file');
    fs.appendFileSync(path.join(u.dir, f.name), buf);
    f.got += buf.length;
    u.at = Date.now();
    return { name: f.name, got: f.got, size: f.size };
  });
  function moveInto(from, to) {   // rename, or copy when the folders are on different disks
    try { fs.renameSync(from, to); } catch { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); }
  }
  // The current installers (and their notes) are kept in archive/<version>, so this can be undone. Only the
  // kinds of computer being replaced leave the downloads: publishing just a Windows build keeps the Mac ones.
  function archiveCurrent(replacing) {
    const cur = fs.readdirSync(dlDir()).filter((f) => !f.startsWith('.') && KIND(f));
    if (!cur.length) return null;
    const v = cur.map(VERSION).filter(Boolean).sort((a, b) => ctx.cmpVersion(b, a))[0] || '0.0.0';
    const dir = path.join(archiveDir(), v);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of cur) {
      if (replacing.has(KIND(f))) moveInto(path.join(dlDir(), f), path.join(dir, f));
      else fs.copyFileSync(path.join(dlDir(), f), path.join(dir, f));
    }
    const n = path.join(dlDir(), 'release-notes.txt');
    if (fs.existsSync(n)) moveInto(n, path.join(dir, 'release-notes.txt'));
    // keep the last five versions
    for (const old of archived().slice(5)) fs.rmSync(path.join(archiveDir(), old.version), { recursive: true, force: true });
    return v;
  }
  route('POST', '/api/dev/releases/:id/publish', ({ user, params, body }) => {
    needDev(user);
    const u = uploads.get(params.id);
    need(u && u.by === user.id, 404, 'Upload not found. Start again.');
    for (const f of u.files) {
      need(f.got === f.size, 400, `${f.name} hasn't finished uploading`);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(u.dir, f.name))).digest('hex');
      need(sha === f.sha256, 400, `${f.name} didn't arrive intact (its SHA-256 doesn't match). Upload it again.`);
    }
    const notes = optStr(body.notes, 'notes', 1500) || '';
    const cur = ctx.listDownloads()[0];
    need(!cur || !cur.version || ctx.cmpVersion(u.version, cur.version) > 0 || body.replace === true, 400, `${u.version} isn't newer than ${cur && cur.version}. Apps only update to a newer version.`);
    fs.mkdirSync(dlDir(), { recursive: true });
    const prev = archiveCurrent(new Set(u.files.map((f) => KIND(f.name))));
    for (const f of u.files) moveInto(path.join(u.dir, f.name), path.join(dlDir(), f.name));
    if (notes) fs.writeFileSync(path.join(dlDir(), 'release-notes.txt'), notes + '\n');
    fs.rmSync(u.dir, { recursive: true, force: true });
    uploads.delete(params.id);
    audit(user, 'dev.release_published', null, `${u.version} (${u.files.map((f) => f.name).join(', ')})${prev ? `; ${prev} kept for going back` : ''}`);
    return { version: u.version, previous: prev };
  });
  route('POST', '/api/dev/releases/rollback', ({ user, body }) => {
    needDev(user);
    const v = String(body.version || '');
    const dir = path.join(archiveDir(), v);
    need(/^\d+\.\d+\.\d+$/.test(v) && fs.existsSync(dir), 404, 'That version isn\'t kept on the server');
    const files = fs.readdirSync(dir).filter((f) => KIND(f));
    need(files.length, 400, 'That version has no installers left');
    const prev = archiveCurrent(new Set(files.map(KIND)));
    for (const f of fs.readdirSync(dir)) moveInto(path.join(dir, f), path.join(dlDir(), f));
    fs.rmSync(dir, { recursive: true, force: true });
    audit(user, 'dev.release_rollback', null, `${prev || 'nothing'} → ${v}`);
    return { version: v, previous: prev };
  });

  // ---- features ----
  route('GET', '/api/dev/features', ({ user }) => {
    needDev(user);
    const names = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    return Object.entries(FEATURES).map(([key, f]) => {
      const r = featureRow(key) || { mode: 'everyone', beta: '[]', updated_at: null };
      let beta = []; try { beta = JSON.parse(r.beta); } catch { /* none */ }
      return { key, ...f, mode: r.mode, beta: beta.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) })), updated_at: r.updated_at };
    });
  });
  route('PUT', '/api/dev/features/:key', ({ user, params, body }) => {
    needDev(user);
    need(FEATURES[params.key], 404, 'Unknown feature');
    need(['off', 'beta', 'everyone'].includes(body.mode), 400, 'mode must be off, beta or everyone');
    const beta = Array.isArray(body.beta) ? [...new Set(body.beta.map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200) : null;
    const old = featureRow(params.key);
    const keep = beta || (old ? JSON.parse(old.beta || '[]') : []);
    for (const id of keep) need(db.prepare('SELECT 1 FROM users WHERE id = ?').get(id), 404, 'Person not found');
    db.prepare(`INSERT INTO features (key, mode, beta, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET mode = excluded.mode, beta = excluded.beta, updated_at = excluded.updated_at`).run(params.key, body.mode, JSON.stringify(keep), ctx.nowIso());
    audit(user, 'dev.feature', null, `${FEATURES[params.key].name}: ${body.mode}${body.mode === 'beta' ? ` (${keep.length} people)` : ''}`);
    ctx.emitAll && ctx.emitAll('me');
    return { key: params.key, mode: body.mode, beta: keep };
  });

  // ---- test tools ----
  // a test notification to the developer or to one person, on all their devices or just one kind: their
  // phone, their browsers or the desktop app. It says it is a test and who sent it, and it is audited.
  const DEVICE = { all: 'all their devices', phone: 'their phone', browser: 'their browser', desktop: 'the desktop app' };
  const isPhone = (d) => /^(iphone|ipad|android)/i.test(String(d || ''));
  function targetOf(user, body) {
    const uid = body.user_id == null || body.user_id === 'me' ? user.id : Number(body.user_id);
    const t = db.prepare('SELECT id, name, active, app_version, last_seen_at FROM users WHERE id = ?').get(uid);
    need(t && t.active, 404, 'Person not found');
    return t;
  }
  function devicesOf(uid) {
    const subs = db.prepare("SELECT device FROM push_subs WHERE owner_kind = 'staff' AND owner_id = ?").all(uid);
    const u = db.prepare('SELECT app_version, last_seen_at FROM users WHERE id = ?').get(uid) || {};
    return { phones: subs.filter((x) => isPhone(x.device)).length, browsers: subs.filter((x) => !isPhone(x.device)).length, desktop: !!u.app_version, desktop_version: u.app_version || null };
  }
  route('GET', '/api/dev/test-targets', ({ user }) => {
    needDev(user);
    return db.prepare('SELECT id, name, title FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all().map((u) => ({ ...u, me: u.id === user.id, ...devicesOf(u.id) }));
  });
  route('POST', '/api/dev/test-notify', ({ user, body }) => {
    needDev(user);
    const t = NOTIFY_TESTS[body.kind];
    need(t, 400, 'kind must be message, boost, checkin or urgent');
    const device = DEVICE[body.device] ? body.device : 'all';
    const to = targetOf(user, body);
    const mine = to.id === user.id;
    const d = devicesOf(to.id);
    const title = mine ? t.title : `${t.title} (sent by ${user.name})`;
    // the bell, and the desktop app when it is one of the targets
    const desktop = device === 'all' || device === 'desktop' ? 1 : 0;
    db.prepare('INSERT INTO notifications (user_id, kind, title, body, link, actor_id, dedupe, created_at, desktop, in_bell) VALUES (?,?,?,?,?,?,?,?,?,1)')
      .run(to.id, 'test', title.slice(0, 200), t.body, t.link, mine ? null : user.id, null, ctx.nowIso(), desktop);
    ctx.emitTo(to.id, 'notify');
    // phone and browser pushes, filtered to the device asked for
    const want = (s) => device === 'all' || (device === 'phone' ? isPhone(s.device) : device === 'browser' ? !isPhone(s.device) : false);
    if (device !== 'desktop' && ctx.pnotify) ctx.pnotify.pushTo('staff', to.id, { title: title.slice(0, 120), body: t.body, link: t.link, tag: `test${Date.now()}` }, want);
    if (!mine) audit(user, 'dev.test_notify', to.id, `${t.title} to ${DEVICE[device]}`);
    const reached = [];
    if ((device === 'all' || device === 'phone') && d.phones) reached.push(d.phones === 1 ? 'a phone' : `${d.phones} phones`);
    if ((device === 'all' || device === 'browser') && d.browsers) reached.push(d.browsers === 1 ? 'a browser' : `${d.browsers} browsers`);
    if (desktop && d.desktop) reached.push('the desktop app');
    return { ok: true, to: to.name, mine, device, reached, ...d };
  });
  // the boost clip on the developer's own laptop, to check it pops up: a test boost only they get, not
  // posted in the chat, not counted towards anyone's three a shift, and never shown as the last boost
  route('POST', '/api/dev/test-clip', ({ user, body }) => {
    needDev(user);
    const to = targetOf(user, body || {}), mine = to.id === user.id;
    const working = new Set(db.prepare('SELECT user_id FROM time_entries WHERE ended_at IS NULL').all().map((r) => r.user_id));
    const why = ctx.clipWhy ? ctx.clipWhy(to.id, working) : { ok: true, why: 'ok' };
    // the limit for the shift doesn't apply to a test; everything else would stop a real one too
    const blocking = !why.ok && why.why !== 'limit' && why.why !== 'feature_off' && why.why !== 'show_off' && why.why !== 'notes_only';
    if (blocking) return { sent: false, why: why.why, text: why.why === 'not_working' ? (mine ? 'Start your timer in the desktop app first: the clip only pops up while it runs' : `${to.name}’s timer isn’t running: the clip only pops up while it runs`) : why.why === 'no_app' ? (mine ? 'Sign in to the desktop app on this computer first' : `${to.name} isn’t using the desktop app`) : why.text };
    const line = mine ? 'Test clip from the developer tools. Only you can see this one.' : `A test of the boost clip from ${user.name}. Nothing to do: it closes by itself.`;
    const id = Number(db.prepare('INSERT INTO boosts (author_id, vibe, line, sent_to, clip, created_at, test) VALUES (?,?,?,?,?,?,1)').run(user.id, 'win', line, 1, 1, ctx.nowIso()).lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO boost_popups (boost_id, user_id, at) VALUES (?,?,?)').run(id, to.id, ctx.nowIso());
    if (!mine) audit(user, 'dev.test_clip', to.id, 'Test boost clip');
    ctx.notify.notify([to.id], { kind: 'boost_clip', title: 'Test boost', body: line, link: `#/?boost=${id}`, dedupe: `boost:${id}`, tag: 'boost', urgent: true });
    return { sent: true, id, why: why.why, text: why.ok ? (mine ? 'Sent to your desktop app' : `Sent to ${to.name}’s desktop app`) : `Sent. Note for real boosts: ${why.text}` };
  });

  // timers left running: who, since when and the last sign of life from their computer; never what they did
  route('GET', '/api/dev/timers', ({ user }) => {
    needDev(user);
    const now = ctx.now();
    return db.prepare(`SELECT e.id, e.user_id, e.started_at, u.name, u.last_seen_at, u.app_version FROM time_entries e JOIN users u ON u.id = e.user_id
      WHERE e.ended_at IS NULL ORDER BY COALESCE(u.last_seen_at, e.started_at)`).all().map((r) => {
      const seen = r.last_seen_at && r.last_seen_at > r.started_at ? r.last_seen_at : r.started_at;
      return { entry_id: r.id, user_id: r.user_id, name: r.name, started_at: r.started_at, last_seen_at: seen, silent_min: Math.max(0, Math.round((now - Date.parse(seen)) / 60000)), app_version: r.app_version };
    });
  });
  route('POST', '/api/dev/timers/:id/close', ({ user, params }) => {
    needDev(user);
    const e = db.prepare('SELECT e.*, u.last_seen_at, u.name FROM time_entries e JOIN users u ON u.id = e.user_id WHERE e.id = ? AND e.ended_at IS NULL').get(Number(params.id));
    need(e, 404, 'That timer is not running');
    // closed at the last sign of life, exactly as the server does by itself after a long silence
    const end = e.last_seen_at && e.last_seen_at > e.started_at ? e.last_seen_at : e.started_at;
    db.prepare('UPDATE pauses SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(end, e.id);
    db.prepare('UPDATE idle_periods SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(end, e.id);
    db.prepare("UPDATE time_entries SET ended_at = ?, stop_reason = 'lost' WHERE id = ?").run(end, e.id);
    audit(user, 'dev.timer_closed', e.user_id, `Closed at ${end}, the last sign of life`);
    ctx.notify.notify([e.user_id], { kind: 'changed', title: 'Your timer was stopped', body: `It had stopped hearing from your computer, so it was closed at the last sign of life. By ${user.name}.`, link: '#/' });
    ctx.emit('timer', e.user_id);
    return { closed_at: end };
  });

  // ---- who has developer access (everyone can see this) ----
  route('GET', '/api/developers', () => db.prepare("SELECT id, name, title FROM users WHERE active = 1 AND is_dev = 1 ORDER BY name").all());
};
