'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, str, int, isoDate } = require('../lib/http');

const isImage = (buf) => (buf[0] === 0xff && buf[1] === 0xd8) || buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

module.exports = (ctx) => {
  const { db, cfg, route, emit, audit, touch, needConsent, canSee, isManager, visibleUsers, targetUser, removeShots, shotDir, calc, clockNow, T, MAX_BODY } = ctx;
  const nowIso = () => new Date(clockNow()).toISOString();

  // --- activity: counts only (seconds of input), never key contents ---
  route('POST', '/api/activity', ({ user, body }) => {
    needConsent(user);
    const slot = isoDate(body.slot_start, 'slot_start');
    const tracked = int(body.tracked_secs, 'tracked_secs', 0, 3600);
    const active = int(body.active_secs, 'active_secs', 0, 3600);
    need(active <= tracked, 400, 'active_secs cannot exceed tracked_secs');
    need(tracked <= 10 * 60 + 60, 400, 'tracked_secs is longer than a 10-minute block');
    const entryId = body.entry_id == null ? null : int(body.entry_id, 'entry_id', 1, 1e9);
    if (entryId) need(db.prepare('SELECT 1 FROM time_entries WHERE id = ? AND user_id = ?').get(entryId, user.id), 404, 'Time entry not found');
    db.prepare(`INSERT INTO activity_slots (user_id, entry_id, slot_start, tracked_secs, active_secs)
                VALUES (?,?,?,?,?)
                ON CONFLICT(user_id, slot_start) DO UPDATE SET
                  tracked_secs = excluded.tracked_secs, active_secs = excluded.active_secs, entry_id = COALESCE(excluded.entry_id, entry_id)`)
      .run(user.id, entryId, slot, tracked, active);
    // (Older desktop apps may still send `apps`: which apps and sites were used is not tracked, so it is ignored.)
    touch(user.id);
    emit('activity', user.id);
    return { ok: true };
  });

  // --- screenshots ---
  route('POST', '/api/screenshots', ({ user, body }) => {
    needConsent(user);
    const slot = isoDate(body.slot_start, 'slot_start');
    const takenAt = isoDate(body.taken_at, 'taken_at');
    need(Date.parse(takenAt) <= clockNow() + 120000, 400, 'taken_at is in the future');
    const b64 = str(body.image_base64, 'image_base64', MAX_BODY);
    const buf = Buffer.from(b64, 'base64');
    need(buf.length > 0, 400, 'image is empty');
    need(isImage(buf), 400, 'image must be PNG or JPEG');

    // The rule that matters most: no screenshot may exist for a moment the timer was not running.
    const entry = db.prepare('SELECT id FROM time_entries WHERE user_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)').get(user.id, takenAt, takenAt);
    need(entry, 409, 'The timer was not running when this screenshot was taken');
    const paused = db.prepare('SELECT 1 FROM pauses WHERE entry_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)').get(entry.id, takenAt, takenAt);
    need(!paused, 409, 'The timer was paused when this screenshot was taken');
    const idle = db.prepare('SELECT 1 FROM idle_periods WHERE entry_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)').get(entry.id, takenAt, takenAt);
    need(!idle, 409, 'The person was idle when this screenshot was taken');
    need(ctx.shotPolicy(user).per_10 > 0, 403, 'Screenshots are turned off for you');
    const privacy = body.privacy == null ? null : body.privacy;
    need(privacy === null || privacy === 'partial' || privacy === 'full', 400, 'privacy must be partial or full');

    const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const stem = `${user.id}-${crypto.randomBytes(8).toString('hex')}`;
    const file = `${stem}${png ? '.png' : '.jpg'}`;
    fs.writeFileSync(path.join(shotDir, file), buf);
    let thumb = null;
    if (typeof body.thumb_base64 === 'string' && body.thumb_base64) {
      const tb = Buffer.from(body.thumb_base64, 'base64');
      if (tb.length && tb.length < 400 * 1024 && isImage(tb)) { thumb = `${stem}_t.jpg`; fs.writeFileSync(path.join(shotDir, thumb), tb); }
    }
    const id = Number(db.prepare('INSERT INTO screenshots (user_id, slot_start, taken_at, file, thumb, entry_id, privacy) VALUES (?,?,?,?,?,?,?)')
      .run(user.id, slot, takenAt, file, thumb, entry.id, privacy).lastInsertRowid);
    touch(user.id);
    emit('screenshot', user.id);
    return { id };
  });

  const shotRows = (userIds, startI, endI, limit) => {
    if (!userIds.length) return [];
    return db.prepare(`SELECT s.id, s.user_id, u.name AS user_name, s.slot_start, s.taken_at, s.thumb IS NOT NULL AS has_thumb, s.entry_id, s.privacy,
        (SELECT p.name FROM time_entries e JOIN projects p ON p.id = e.project_id WHERE e.id = s.entry_id) AS project,
        (SELECT n.text FROM notes n WHERE n.user_id = s.user_id AND n.kind = 'shot' AND n.ref = CAST(s.id AS TEXT)) AS note,
        (SELECT ROUND(100.0 * a.active_secs / NULLIF(a.tracked_secs,0)) FROM activity_slots a WHERE a.user_id = s.user_id AND a.slot_start <= s.taken_at AND a.slot_start > strftime('%Y-%m-%dT%H:%M:%fZ', s.taken_at, '-10 minutes') ORDER BY a.slot_start DESC LIMIT 1) AS activity
      FROM screenshots s JOIN users u ON u.id = s.user_id
      WHERE s.deleted = 0 AND s.taken_at >= ? AND s.taken_at < ? AND s.user_id IN (${userIds.map(() => '?').join(',')})
      ORDER BY s.taken_at DESC LIMIT ?`).all(startI, endI, ...userIds, limit).reverse();
  };

  ctx.shotRows = shotRows;

  route('GET', '/api/screenshots', ({ user, query }) => {
    const day = query.get('day');
    need(T.isDay(day), 400, 'day=YYYY-MM-DD is required');
    const who = query.get('user_id');
    let users;
    if (who === 'all') { need(isManager(user), 403, 'Not allowed'); users = visibleUsers(user, { tracking: true }); }
    else users = [targetUser(user, who)];
    // each person's own midnight-to-midnight
    const out = [];
    // your own screenshots say how many times others opened them
    const viewsOf = db.prepare('SELECT COUNT(*) n FROM shot_views WHERE shot_id = ?');
    for (const u of users) {
      const tz = calc.tzOn(u, day), mine = u.id === user.id;
      const [ws, we] = T.dayWindow(day, calc.dayTz(u, day));
      for (const r of shotRows([u.id], T.iso(ws), T.iso(we), 1500)) out.push({ ...r, has_thumb: !!r.has_thumb, tz_offset_min: tz, ...(mine ? { viewers: viewsOf.get(r.id).n } : {}) });
    }
    return out.sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1)).slice(-2000);
  });

  function loadShot(user, id) {
    const s = db.prepare('SELECT * FROM screenshots WHERE id = ? AND deleted = 0').get(Number(id));
    need(s, 404, 'Not found');
    need(s.user_id === user.id || canSee(user, s.user_id), 403, 'Not allowed');
    return s;
  }
  // A screenshot file never changes, so the browser may keep its thumbnail (a deleted one is no longer listed).
  const IMMUTABLE = { 'Cache-Control': 'private, max-age=604800, immutable' };
  function sendFile(file) {
    const p = path.join(shotDir, file);
    need(fs.existsSync(p), 404, 'Image missing');
    return { raw: fs.readFileSync(p), type: file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }
  // Many thumbnails in one answer, so a page of screenshots costs one round trip instead of dozens
  // (over a slow or far-away connection the waiting, not the size, is what makes them slow).
  // Binary: 4 bytes giving the length of a JSON index, the index [{id, type, offset, length}], then the images.
  // Thumbnails someone may not see, or that are gone, are simply left out.
  route('GET', '/api/screenshots/thumbs', ({ user, query }) => {
    const ids = [...new Set(String(query.get('ids') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 40);
    need(ids.length, 400, 'ids=1,2,3 is required');
    const parts = [], index = [];
    let offset = 0;
    for (const id of ids) {
      const s = db.prepare('SELECT * FROM screenshots WHERE id = ? AND deleted = 0').get(id);
      if (!s || !(s.user_id === user.id || canSee(user, s.user_id))) continue;
      const f = path.join(shotDir, s.thumb || s.file);
      let buf;
      try { buf = fs.readFileSync(f); } catch { continue; }
      index.push({ id, type: f.endsWith('.png') ? 'image/png' : 'image/jpeg', offset, length: buf.length });
      parts.push(buf); offset += buf.length;
    }
    const head = Buffer.from(JSON.stringify(index));
    const len = Buffer.alloc(4); len.writeUInt32BE(head.length, 0);
    return { raw: Buffer.concat([len, head, ...parts]), type: 'application/octet-stream', headers: { 'Cache-Control': 'private, max-age=86400' } };
  });
  // Opening someone else's screenshot full size is recorded; the person in it sees who looked and when.
  route('GET', '/api/screenshots/:id/image', ({ user, params }) => {
    const s = loadShot(user, params.id);
    if (s.user_id !== user.id) {
      db.prepare(`INSERT INTO shot_views (shot_id, viewer_id, first_at, last_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(shot_id, viewer_id) DO UPDATE SET last_at = excluded.last_at, times = times + 1`).run(s.id, user.id, nowIso(), nowIso());
    }
    return sendFile(s.file);
  });
  route('GET', '/api/screenshots/:id/views', ({ user, params }) => {
    const s = loadShot(user, params.id);
    need(s.user_id === user.id || user.role === 'owner', 403, 'Only the person in the screenshot can see who viewed it');
    return db.prepare('SELECT u.name, v.first_at, v.last_at, v.times FROM shot_views v JOIN users u ON u.id = v.viewer_id WHERE v.shot_id = ? ORDER BY v.last_at DESC').all(s.id);
  });
  route('GET', '/api/screenshots/:id/thumb', ({ user, params }) => { const s = loadShot(user, params.id); return { ...sendFile(s.thumb || s.file), headers: IMMUTABLE }; });
  route('GET', '/api/screenshots/:id', ({ user, params }) => {
    const s = loadShot(user, params.id);
    const [row] = shotRows([s.user_id], s.taken_at, T.iso(Date.parse(s.taken_at) + 1000), 5).filter((r) => r.id === s.id);
    return { ...row, has_thumb: !!row.has_thumb, tz_offset_min: calc.userTz(db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id), Date.parse(s.taken_at)) };
  });

  route('DELETE', '/api/screenshots/:id', ({ user, params }) => {
    const s = loadShot(user, params.id);
    if (s.user_id === user.id && !isManager(user)) need(cfg.employeesCanDeleteShots, 403, 'Your company has turned off deleting your own screenshots. Ask your manager.');
    // someone else's screenshot is removed only by the owner (a manager can delete only their own)
    if (s.user_id !== user.id) need(user.role === 'owner', 403, 'Only the owner can delete someone else’s screenshots');
    removeShots([s]);
    audit(user, 'screenshot.deleted', s.user_id, `Taken ${s.taken_at}`);
    if (s.user_id !== user.id) {
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      const at = Date.parse(s.taken_at);
      ctx.changes.log(s.user_id, user, { area: 'screenshots', title: 'One of your screenshots was deleted', lines: [`Taken ${ctx.spanText(owner, at, at).replace(/ to .*$/, '')}`], link: '#/screenshots' });
    }
    emit('screenshot', s.user_id);
    return { ok: true };
  });
};
