'use strict';
const { need, int } = require('../lib/http');

// The bell: a person's own notifications, newest first, and their notification settings: which of their
// devices each kind of thing reaches, quiet hours outside the shift, and their devices.
module.exports = (ctx) => {
  const { db, route, nowIso, emitTo, isManager, notify: N } = ctx;

  const out = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, created_at: r.created_at, read: !!r.read_at,
    actor: r.actor_id ? (db.prepare('SELECT id, name FROM users WHERE id = ?').get(r.actor_id) || null) : null });
  const unread = (uid) => db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL AND in_bell = 1').get(uid).n;
  // the desktop app asks with its own header: it gets what was meant for the desktop (chats too, never quiet-hour ones)
  const fromApp = (req) => !!(req && req.headers && req.headers['x-workhelm-app']);

  // ?limit=30&before=<id> pages back; ?after=<id> returns only newer ones (used by the desktop app and pop-ups).
  route('GET', '/api/notifications', ({ user, query, req }) => {
    // the web app or the desktop app checking in counts as chat messages reaching this person (double ticks)
    if (ctx.chatDelivered && user.kind !== 'client') ctx.chatDelivered(user);
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 30));
    const before = Number(query.get('before')) || null, after = query.has('after') ? Number(query.get('after')) || 0 : null;
    const app = fromApp(req);
    const which = app ? 'AND desktop = 1' : 'AND in_bell = 1';
    let rows;
    if (after != null) rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND id > ? ${which} ORDER BY id LIMIT ?`).all(user.id, after, limit);
    else rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${which} ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`).all(...[user.id, ...(before ? [before] : []), limit]);
    const last = db.prepare('SELECT MAX(id) m FROM notifications WHERE user_id = ?').get(user.id).m || 0;
    return { items: rows.map(out), unread: unread(user.id), last_id: last };
  });

  // { ids: [..] } or { all: true }
  route('POST', '/api/notifications/read', ({ user, body }) => {
    const at = nowIso();
    if (body.all) db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, user.id);
    else {
      need(Array.isArray(body.ids) && body.ids.length <= 200, 400, 'ids must be a list');
      const st = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?');
      for (const id of body.ids) st.run(at, int(id, 'id', 1, 1e12), user.id);
    }
    emitTo(user.id, 'notify');
    return { unread: unread(user.id) };
  });

  function prefsOut(user) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const p = N.prefsOf(u);
    const cats = Object.entries(N.CATEGORIES).filter(([k]) => isManager(user) || !N.MANAGER_ONLY.has(k))
      .map(([k, label]) => ({ key: k, label, sub: N.SUBS[k] || null, on: p.categories[k], locked: N.LOCKED.has(k), channels: p.channels[k] }));
    const h = ctx.calc.hoursOn(u, ctx.calc.todayOf(u));
    const subs = db.prepare("SELECT id, device, label, created_at, last_ok_at, fails FROM push_subs WHERE owner_kind = 'staff' AND owner_id = ? ORDER BY id").all(user.id);
    const appSeen = u.last_seen_at && ctx.now() - Date.parse(u.last_seen_at) < 15 * 60000;
    const devices = [
      ...subs.map((s) => ({ id: s.id, kind: N.isPhone(s.device) ? 'phone' : 'browser', name: s.label || s.device || 'This browser', last_ok_at: s.last_ok_at, ok: s.fails < 3 })),
      ...(u.app_version ? [{ id: 'app', kind: 'desktop', name: `${/^darwin/.test(u.app_platform || '') ? 'Mac' : /^win32/.test(u.app_platform || '') ? 'Windows' : 'Computer'}: desktop app`, sub: `Version ${u.app_version}`, ok: !!appSeen, running: !!appSeen }] : []),
    ];
    return { categories: cats, desktop: p.desktop, quiet: p.quiet, shift: { start: h.shift_start, end: h.shift_end }, devices, in_shift: N.inShift(u) };
  }
  route('GET', '/api/me/notify-prefs', ({ user }) => prefsOut(user));

  route('PUT', '/api/me/notify-prefs', ({ user, body }) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    let raw = {};
    try { raw = u.notify_prefs ? JSON.parse(u.notify_prefs) : {}; } catch { raw = {}; }
    const p = N.prefsOf(u);
    raw.channels = p.channels;
    delete raw.categories;   // the per-device choices replace the old on/off switches
    if (body.categories && typeof body.categories === 'object') {
      for (const [k, v] of Object.entries(body.categories)) { need(k in N.CATEGORIES, 400, `Unknown category ${k}`); if (!N.LOCKED.has(k)) for (const d of N.DEVICES) raw.channels[k][d] = !!v; }
    }
    if (body.channels && typeof body.channels === 'object') {
      for (const [k, v] of Object.entries(body.channels)) {
        need(k in N.CATEGORIES, 400, `Unknown category ${k}`);
        if (N.LOCKED.has(k) || !v || typeof v !== 'object') continue;
        for (const d of N.DEVICES) if (d in v) raw.channels[k][d] = !!v[d];
      }
    }
    if ('desktop' in body) raw.desktop = !!body.desktop;
    if ('quiet' in body) raw.quiet = !!body.quiet;
    db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify(raw), user.id);
    return prefsOut(user);
  });

  // a test that goes to every device the person has, now, quiet hours or not
  route('POST', '/api/me/notify-test', ({ user }) => {
    db.prepare(`INSERT INTO notifications (user_id, kind, title, body, link, created_at, desktop, in_bell) VALUES (?,?,?,?,?,?,1,1)`)
      .run(user.id, 'changed', 'This is a test from Staffwarden', 'If you can read this, notifications reach this device.', '#/profile?tab=notifications', nowIso());
    emitTo(user.id, 'notify');
    const n = db.prepare("SELECT COUNT(*) n FROM push_subs WHERE owner_kind = 'staff' AND owner_id = ?").get(user.id).n;
    if (ctx.pnotify) ctx.pnotify.pushTo('staff', user.id, { title: 'This is a test from Staffwarden', body: 'If you can read this, notifications reach this device.', link: '#/profile?tab=notifications', tag: 'test' });
    return { ok: true, phones_and_browsers: n };
  });
  route('DELETE', '/api/me/devices/:id', ({ user, params }) => {
    db.prepare("DELETE FROM push_subs WHERE id = ? AND owner_kind = 'staff' AND owner_id = ?").run(Number(params.id), user.id);
    return prefsOut(user);
  });
};
