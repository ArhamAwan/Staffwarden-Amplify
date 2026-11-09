'use strict';
const { need, int, isoDate, optStr, str } = require('../lib/http');

// Transparency, the employee's side:
//  - notes: a person explains a late start, an idle stretch, a screenshot or a whole day, in their words.
//    Managers see the note next to the thing it explains and are told when one is added.
//  - time requests: a person asks a manager to add time they forgot to track; the manager approves
//    (the time is added and the person is told) or declines with a reason.
//  - changes: the history of everything changed about a person's tracking, schedule or time.
//  - team now: what colleagues are doing right now, for everyone (the owner decides how far it reaches).
module.exports = (ctx) => {
  const { db, cfg, route, calc, emit, audit, needManager, isManager, canSee, targetUser, managersOf, visibleUsers, nowIso, clockNow, T } = ctx;
  const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const KINDS = ['late', 'idle', 'shot', 'day'];
  const nameOf = (id) => (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || 'Someone';

  const noteOut = (n) => ({ id: n.id, user_id: n.user_id, day: n.day, kind: n.kind, ref: n.ref, text: n.text, created_at: n.created_at, updated_at: n.updated_at });
  const reqOut = (r) => ({
    id: r.id, user_id: r.user_id, user_name: nameOf(r.user_id), day: r.day, start_at: r.start_at, end_at: r.end_at,
    project_id: r.project_id, project: r.project_id ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(r.project_id) || {}).name || null : null,
    reason: r.reason, status: r.status, created_at: r.created_at,
    decided_by: r.decided_by ? nameOf(r.decided_by) : null, decided_at: r.decided_at, decision_note: r.decision_note,
  });
  ctx.notesFor = (userId, day) => db.prepare('SELECT * FROM notes WHERE user_id = ? AND day = ? ORDER BY created_at').all(userId, day).map(noteOut);
  ctx.requestsFor = (userId, day) => db.prepare('SELECT * FROM time_requests WHERE user_id = ? AND day = ? ORDER BY created_at').all(userId, day).map(reqOut);

  // ---------- notes ----------
  // Only the person writes notes about their own day. One note per thing; saving again replaces it.
  route('PUT', '/api/notes', ({ user, body }) => {
    need(KINDS.includes(body.kind), 400, 'kind must be late, idle, shot or day');
    const text = str(body.text, 'text', 500).trim();
    need(text, 400, 'Write a note first');
    let day = body.day, ref;
    if (body.kind === 'idle') {
      const i = db.prepare('SELECT * FROM idle_periods WHERE id = ? AND user_id = ?').get(int(body.ref, 'ref', 1, 1e12), user.id);
      need(i, 404, 'Idle time not found');
      ref = String(i.id); day = T.localDay(Date.parse(i.started_at), calc.dayTz(user));
    } else if (body.kind === 'shot') {
      const sh = db.prepare('SELECT * FROM screenshots WHERE id = ? AND user_id = ? AND deleted = 0').get(int(body.ref, 'ref', 1, 1e12), user.id);
      need(sh, 404, 'Screenshot not found');
      ref = String(sh.id); day = T.localDay(Date.parse(sh.taken_at), calc.dayTz(user));
    } else {
      need(isDay(day), 400, 'day must look like 2026-10-28');
      need(day <= calc.todayOf(user), 400, 'That day has not happened yet');
      ref = day;
    }
    const prev = db.prepare('SELECT * FROM notes WHERE user_id = ? AND kind = ? AND ref = ?').get(user.id, body.kind, ref);
    const now = nowIso();
    if (prev) db.prepare('UPDATE notes SET text = ?, updated_at = ? WHERE id = ?').run(text, now, prev.id);
    else db.prepare('INSERT INTO notes (user_id, day, kind, ref, text, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(user.id, day, body.kind, ref, text, now, now);
    const what = { late: 'their late start', idle: 'an idle stretch', shot: 'a screenshot', day: 'their day' }[body.kind];
    ctx.notify.notify(managersOf(user.id), { kind: 'note_added', title: `${user.name} added a note about ${what}`, body: text.slice(0, 200), link: `#/timeline?user=${user.id}&day=${day}`, actor: user });
    emit('notes', user.id);
    return noteOut(db.prepare('SELECT * FROM notes WHERE user_id = ? AND kind = ? AND ref = ?').get(user.id, body.kind, ref));
  });
  route('DELETE', '/api/notes/:id', ({ user, params }) => {
    const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(params.id));
    need(n && n.user_id === user.id, 404, 'Note not found');
    db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
    emit('notes', user.id);
    return { ok: true };
  });
  // notes on one person's screenshots for a day, keyed by screenshot id (the screenshots page uses them)
  route('GET', '/api/notes', ({ user, query }) => {
    const u = query.get('user_id') && query.get('user_id') !== 'me' ? targetUser(user, query.get('user_id')) : user;
    const day = query.get('day');
    need(isDay(day), 400, 'day must look like 2026-10-28');
    return ctx.notesFor(u.id, day);
  });

  // ---------- time requests ----------
  const overlaps = (uid, s, e) => db.prepare('SELECT 1 FROM time_entries WHERE user_id = ? AND started_at < ? AND COALESCE(ended_at, ?) > ?').get(uid, T.iso(e), T.iso(clockNow()), T.iso(s));
  route('POST', '/api/time-requests', ({ user, body }) => {
    const s = Date.parse(isoDate(body.start, 'start')), e = Date.parse(isoDate(body.end, 'end'));
    need(e > s, 400, 'The end must be after the start');
    need(e - s <= 16 * 3600000, 400, 'Ask for at most 16 hours at a time');
    need(e <= clockNow() + 60000, 400, 'You can only ask for time that has already happened');
    need(s >= clockNow() - 14 * 86400000, 400, 'You can only ask for time in the last 14 days');
    need(!overlaps(user.id, s, e), 409, 'That overlaps time you already tracked');
    need(!db.prepare("SELECT 1 FROM time_requests WHERE user_id = ? AND status = 'pending' AND start_at < ? AND end_at > ?").get(user.id, T.iso(e), T.iso(s)), 409, 'You already asked for some of that time');
    const reason = str(body.reason, 'reason', 500).trim();
    need(reason, 400, 'Say what you were working on');
    let projectId = null;
    if (body.project_id != null && body.project_id !== '') {
      projectId = int(body.project_id, 'project_id', 1, 1e9);
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      need(p && ctx.projectVisible(user, p), 404, 'Project not found');
    }
    const day = T.localDay(s, calc.dayTz(user));
    const id = Number(db.prepare('INSERT INTO time_requests (user_id, day, start_at, end_at, project_id, reason, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(user.id, day, T.iso(s), T.iso(e), projectId, reason, nowIso()).lastInsertRowid);
    audit(user, 'time.requested', user.id, `${T.iso(s)} to ${T.iso(e)}: ${reason}`);
    ctx.notify.notify(managersOf(user.id), { kind: 'time_request', title: `${user.name} asked to add time`, body: `${ctx.spanText(user, s, e)}. ${reason}`.slice(0, 300), link: `#/timeline?user=${user.id}&day=${day}`, actor: user });
    emit('requests', user.id);
    return reqOut(db.prepare('SELECT * FROM time_requests WHERE id = ?').get(id));
  });
  route('GET', '/api/time-requests', ({ user, query }) => {
    const status = query.get('status');
    // everything still waiting, plus the last year of decisions. Visibility is checked before the cap, so a
    // manager in a big company never loses their own people's requests behind everyone else's.
    const since = new Date(Date.now() - 366 * 86400000).toISOString();
    const rows = isManager(user)
      ? db.prepare(`SELECT * FROM time_requests WHERE (status = 'pending' OR created_at >= ?) ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC`).all(since, ...(status ? [status] : [])).filter((r) => r.user_id === user.id || canSee(user, r.user_id)).slice(0, 3000)
      : db.prepare(`SELECT * FROM time_requests WHERE user_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 500`).all(user.id, ...(status ? [status] : []));
    return rows.map(reqOut);
  });
  route('DELETE', '/api/time-requests/:id', ({ user, params }) => {
    const r = db.prepare('SELECT * FROM time_requests WHERE id = ?').get(Number(params.id));
    need(r && r.user_id === user.id, 404, 'Request not found');
    need(r.status === 'pending', 409, 'That request has already been decided');
    db.prepare("UPDATE time_requests SET status = 'cancelled', decided_at = ? WHERE id = ?").run(nowIso(), r.id);
    emit('requests', user.id);
    return { ok: true };
  });
  route('POST', '/api/time-requests/:id/decide', ({ user, params, body }) => {
    needManager(user);
    const r = db.prepare('SELECT * FROM time_requests WHERE id = ?').get(Number(params.id));
    need(r && canSee(user, r.user_id), 404, 'Request not found');
    need(r.user_id !== user.id || ctx.isRealOwner(user), 403, 'Another manager has to decide your own request');
    need(r.status === 'pending', 409, 'That request has already been decided');
    need(typeof body.approve === 'boolean', 400, 'approve must be true or false');
    const note = optStr(body.note, 'note', 500);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
    const span = ctx.spanText(owner, Date.parse(r.start_at), Date.parse(r.end_at));
    const link = `#/timeline?day=${r.day}`;
    if (body.approve) {
      need(!overlaps(r.user_id, Date.parse(r.start_at), Date.parse(r.end_at)), 409, 'That now overlaps time already tracked');
      const entry = Number(db.prepare("INSERT INTO time_entries (user_id, project_id, started_at, ended_at, note, source, stop_reason, created_by) VALUES (?,?,?,?,?,'request','manual',?)")
        .run(r.user_id, r.project_id, r.start_at, r.end_at, r.reason, user.id).lastInsertRowid);
      db.prepare("UPDATE time_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, entry_id = ? WHERE id = ?").run(user.id, nowIso(), note, entry, r.id);
      audit(user, 'time.request_approved', r.user_id, span);
      ctx.changes.log(r.user_id, user, { area: 'time', title: 'Your time request was approved', lines: [`Added: ${span}`], reason: note || r.reason, link });
      emit('timer', r.user_id);
    } else {
      need(note, 400, 'Say why, so they know what to do');
      db.prepare("UPDATE time_requests SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? ").run(user.id, nowIso(), note, r.id);
      audit(user, 'time.request_declined', r.user_id, `${span}: ${note}`);
      ctx.notify.notify(r.user_id, { kind: 'time_request_decision', title: 'Your time request was declined', body: `${span}. ${user.name}: ${note}`.slice(0, 300), link, actor: user });
    }
    emit('requests', r.user_id);
    return reqOut(db.prepare('SELECT * FROM time_requests WHERE id = ?').get(r.id));
  });

  // ---------- change history ----------
  const changeOut = (c) => ({ id: c.id, area: c.area, title: c.title, lines: JSON.parse(c.lines || '[]'), reason: c.reason, by: c.actor_id ? nameOf(c.actor_id) : null, created_at: c.created_at });
  route('GET', '/api/me/changes', ({ user }) => db.prepare('SELECT * FROM changes WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(user.id).map(changeOut));
  route('GET', '/api/users/:id/changes', ({ user, params }) => {
    needManager(user);
    const t = targetUser(user, params.id);
    return db.prepare('SELECT * FROM changes WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(t.id).map(changeOut);
  });

  // ---------- the team, right now (everyone) ----------
  // Only whether each person is working, on a break, idle or not started, since when, and how long they
  // have worked today. Never screenshots, activity, projects or break reasons.
  route('GET', '/api/team/now', ({ user }) => {
    const mode = ['everyone', 'team', 'off'].includes(cfg.teamVisibility) ? cfg.teamVisibility : 'everyone';
    if (!isManager(user) && mode === 'off') return { visible: 'off', members: [] };
    let people = db.prepare('SELECT * FROM users WHERE active = 1 AND tracks_time = 1 ORDER BY name').all();
    if (isManager(user)) people = visibleUsers(user).filter((u) => u.tracks_time);
    else if (mode === 'team') people = people.filter((u) => user.team_id && u.team_id === user.team_id);
    const live = calc.liveStates(people);
    const day = calc.companyToday();
    const cal = calc.loadCalendar(people.map((u) => u.id), day, day);
    const teams = new Map(db.prepare('SELECT id, name FROM teams').all().map((t) => [t.id, t.name]));
    const members = people.map((u) => {
      const own = calc.todayOf(u);
      const m = calc.computeDay(u, own);
      const att = calc.attendanceFor(u, own, m, own === day ? cal : calc.loadCalendar([u.id], own, own));
      const lv = live.get(u.id) || { state: 'offline' };
      return {
        user_id: u.id, name: u.name, title: u.title || null, team: u.team_id ? teams.get(u.team_id) || null : null, me: u.id === user.id,
        state: lv.state, since: ['working', 'break', 'idle', 'no_signal'].includes(lv.state) ? lv.since : null,
        attendance: att.status, worked_secs: m.worked_secs, first_start: m.first_start, tz_offset_min: calc.userTz(u), tz_name: calc.zoneOf(u),
      };
    });
    return { visible: isManager(user) ? 'manager' : mode, day, members };
  });
};
