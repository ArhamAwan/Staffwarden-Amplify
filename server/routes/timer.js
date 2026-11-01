'use strict';
const { need, int, isoDate, optStr } = require('../lib/http');

// The timer is a small state machine per person:  stopped -> running <-> paused -> stopped.
// Every transition may carry the moment it really happened (`at`), because the desktop app queues
// events while offline. A reported moment is clamped into the legal window instead of rejected, so a
// slightly wrong laptop clock can never wedge a session.
module.exports = (ctx) => {
  const { db, cfg, route, calc, emit, audit, touch, needConsentNow, removeShots, nowIso, clockNow, T, PAUSE_REASONS } = ctx;
  // 'idle' (older apps paused on idle) and 'away' (computer asleep, restarting or off) are set by the app itself.
  const REASONS = new Set([...PAUSE_REASONS.map((r) => r.id), 'idle', 'away']);

  // "Tue 27 Oct, 6:00 PM to 8:00 PM (2h 0m)" in the person's own time zone
  const spanText = (u, startMs, endMs) => {
    const tz = calc.userTz(u), f = (ms) => { const d = new Date(ms + tz * 60000); return { day: d.toUTCString().slice(0, 11), t: ctx.changes.clock(`${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`) }; };
    const a = f(startMs), b = f(endMs), mins = Math.round((endMs - startMs) / 60000);
    return `${a.day}, ${a.t} to ${b.t} (${Math.floor(mins / 60)}h ${mins % 60}m)`;
  };
  ctx.spanText = spanText;
  const openEntry = (userId) => db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND ended_at IS NULL').get(userId);
  const openPause = (entryId) => db.prepare('SELECT * FROM pauses WHERE entry_id = ? AND ended_at IS NULL').get(entryId);
  const openIdle = (entryId) => db.prepare('SELECT * FROM idle_periods WHERE entry_id = ? AND ended_at IS NULL').get(entryId);
  // The earliest moment a new pause or stop may be dated: after the session start and the last pause.
  // (Idle is not a boundary: a pause dated before an idle stretch simply removes that stretch.)
  const lastEventMs = (entry) => {
    const p = db.prepare('SELECT MAX(COALESCE(ended_at, started_at)) AS t FROM pauses WHERE entry_id = ?').get(entry.id);
    return Math.max(Date.parse(entry.started_at), p && p.t ? Date.parse(p.t) : 0);
  };
  const lastIdleEndMs = (entry) => {
    const i = db.prepare('SELECT MAX(ended_at) AS t FROM idle_periods WHERE entry_id = ?').get(entry.id);
    return i && i.t ? Date.parse(i.t) : 0;
  };
  // Ends idle at `at`. Idle that began at or after `at` (now inside a pause or after the stop) is dropped,
  // and idle that ran past `at` is cut back to it.
  function closeIdle(entryId, at) {
    db.prepare('DELETE FROM idle_periods WHERE entry_id = ? AND started_at >= ?').run(entryId, at);
    db.prepare('UPDATE idle_periods SET ended_at = ? WHERE entry_id = ? AND (ended_at IS NULL OR ended_at > ?)').run(at, entryId, at);
  }
  function when(body, key, lo) {
    const now = clockNow();
    if (body[key] == null) return now;
    return T.clamp(Date.parse(isoDate(body[key], key)), lo, now);
  }

  function closeEntry(entry, atMs, reason) {
    const at = T.iso(atMs);
    db.prepare('UPDATE pauses SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(at, entry.id);
    closeIdle(entry.id, at);
    db.prepare('UPDATE time_entries SET ended_at = ?, stop_reason = ? WHERE id = ?').run(at, reason, entry.id);
    return at;
  }

  // Time before `at` is real; anything the client recorded after it (idle minutes, a break that already began)
  // must not leave screenshots or activity behind. Keeps the rule "nothing is captured while paused" true.
  function trimShots(userId, atMs, why) {
    const at = T.iso(atMs);
    const shots = db.prepare('SELECT id, file, thumb FROM screenshots WHERE user_id = ? AND deleted = 0 AND taken_at >= ?').all(userId, at);
    if (shots.length) { removeShots(shots); audit(null, 'screenshots.trimmed', userId, `${shots.length} removed: taken after ${at} ${why}`); }
    return shots.length;
  }
  function trimAfter(userId, atMs) {
    const at = T.iso(atMs);
    const n = trimShots(userId, atMs, 'while not working');
    const slotMs = 10 * 60000; // activity is counted in 10-minute blocks (older apps used shorter ones)
    db.prepare('DELETE FROM activity_slots WHERE user_id = ? AND slot_start >= ?').run(userId, at);
    const edge = db.prepare('SELECT id, slot_start, tracked_secs, active_secs FROM activity_slots WHERE user_id = ? AND slot_start >= ? AND slot_start < ?')
      .all(userId, T.iso(atMs - slotMs), at);
    for (const s of edge) {
      const keep = Math.max(0, Math.round((atMs - Date.parse(s.slot_start)) / 1000));
      const tracked = Math.min(s.tracked_secs, keep);
      db.prepare('UPDATE activity_slots SET tracked_secs = ?, active_secs = ? WHERE id = ?').run(tracked, Math.min(s.active_secs, tracked), s.id);
    }
    return n;
  }

  const shape = (u) => {
    const e = openEntry(u.id);
    const p = e ? openPause(e.id) : null;
    const i = e && !p ? openIdle(e.id) : null;
    return {
      running: !!e && !p, paused: !!p, active: !!e, idle: !!i,
      shots_per_10: ctx.shotPolicy(u).per_10,
      entry: e ? { id: e.id, project_id: e.project_id, task_id: e.task_id, started_at: e.started_at } : null,
      pause: p ? { id: p.id, reason: p.reason, started_at: p.started_at } : null,
      server_time: nowIso(),
    };
  };

  route('GET', '/api/timer/current', ({ user }) => shape(user));

  // The timer only starts from the newest desktop app the server offers for that computer. A session that
  // is already running carries on; pausing, resuming and stopping always work.
  function needLatestApp(req) {
    if (cfg.requireLatestApp === false) return;
    const m = /^(\d{1,4}\.\d{1,4}\.\d{1,4}) (darwin|win32|linux) (x64|arm64|ia32)$/.exec(String(req.headers['x-workhelm-app'] || ''));
    if (!m) return;
    const latest = ctx.latestApp(m[2], m[3]);
    if (!latest.version || ctx.cmpVersion(latest.version, m[1]) <= 0) return;
    const self = ctx.cmpVersion(m[1], '0.9.4') >= 0;
    need(false, 426, `Update Staffwarden to ${latest.version} to start your timer. ${self ? 'Press Update in the app; it takes about a minute.' : 'Download it from the Staffwarden website and install it over this one.'}`);
  }

  route('POST', '/api/timer/start', ({ user, body, req }) => {
    needConsentNow(user);
    needLatestApp(req);
    let projectId = null, taskId = null;
    if (body.project_id != null) {
      projectId = int(body.project_id, 'project_id', 1, 1e9);
      const proj = db.prepare('SELECT * FROM projects WHERE id = ? AND archived = 0').get(projectId);
      need(proj && ctx.projectVisible(user, proj), 404, 'Project not found');
    }
    let task = null;
    if (body.task_id != null) {
      taskId = int(body.task_id, 'task_id', 1, 1e9);
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      need(task && ctx.taskVisible(user, task), 404, 'Task not found');
      need(task.status !== 'done', 409, 'That task is already done');
      if (projectId) need(!task.project_id || task.project_id === projectId, 404, 'Task not found in that project');
      projectId = projectId || task.project_id || null;
    }
    const now = clockNow();
    const prev = openEntry(user.id);
    if (prev) closeEntry(prev, Math.max(now, Date.parse(prev.started_at)), 'restarted');
    const startedAt = T.iso(now);
    const id = Number(db.prepare('INSERT INTO time_entries (user_id, project_id, task_id, started_at) VALUES (?,?,?,?)').run(user.id, projectId, taskId, startedAt).lastInsertRowid);
    // Starting work on a task that was waiting moves it to In progress.
    if (task && task.status === 'todo' && (task.assignee_id === user.id || (task.assignee_id == null && task.created_by === user.id))) ctx.changeTaskStatus(task, 'in_progress', user);
    if (!user.tracks_time) { db.prepare('UPDATE users SET tracks_time = 1 WHERE id = ?').run(user.id); audit(user, 'user.tracking_on', user.id, 'Started a timer'); }
    touch(user.id);
    emit('timer', user.id);
    return { entry_id: id, started_at: startedAt, project_id: projectId, task_id: taskId };
  });

  route('POST', '/api/timer/pause', ({ user, body }) => {
    const e = openEntry(user.id);
    need(e, 409, 'Timer is not running');
    const reason = body.reason == null ? 'break' : body.reason;
    need(REASONS.has(reason), 400, 'Unknown pause reason');
    const existing = openPause(e.id);
    if (existing) { touch(user.id); return { pause_id: existing.id, started_at: existing.started_at, already: true }; } // retry-safe
    const at = when(body, 'at', lastEventMs(e));
    const trimmed = at < clockNow() - 2000 ? trimAfter(user.id, at) : 0;
    closeIdle(e.id, T.iso(at));
    const id = Number(db.prepare('INSERT INTO pauses (entry_id, user_id, started_at, reason) VALUES (?,?,?,?)').run(e.id, user.id, T.iso(at), reason).lastInsertRowid);
    touch(user.id);
    emit('pause', user.id);
    return { pause_id: id, started_at: T.iso(at), reason, trimmed_screenshots: trimmed };
  });

  route('POST', '/api/timer/resume', ({ user, body }) => {
    const e = openEntry(user.id);
    need(e, 409, 'Timer is not running');
    const p = openPause(e.id);
    if (!p) { touch(user.id); return { already: true }; }
    const at = when(body, 'at', Date.parse(p.started_at));
    db.prepare('UPDATE pauses SET ended_at = ? WHERE id = ?').run(T.iso(at), p.id);
    touch(user.id);
    emit('pause', user.id);
    return { pause_id: p.id, ended_at: T.iso(at), break_secs: Math.round((at - Date.parse(p.started_at)) / 1000) };
  });

  // Idle while the timer keeps running: no keyboard or mouse for the idle limit. The time still counts as
  // worked, but it is shown as idle and no screenshots may exist inside it.
  route('POST', '/api/timer/idle', ({ user, body }) => {
    const e = openEntry(user.id);
    need(e, 409, 'Timer is not running');
    need(['start', 'end'].includes(body.state), 400, 'state must be start or end');
    const open = openIdle(e.id);
    if (body.state === 'start') {
      need(!openPause(e.id), 409, 'Timer is paused');
      if (open) { touch(user.id); return { idle_id: open.id, started_at: open.started_at, already: true }; }
      const at = when(body, 'at', Math.max(lastEventMs(e), lastIdleEndMs(e)));
      const trimmed = at < clockNow() - 2000 ? trimShots(user.id, at, 'while idle') : 0;
      const id = Number(db.prepare('INSERT INTO idle_periods (entry_id, user_id, started_at) VALUES (?,?,?)').run(e.id, user.id, T.iso(at)).lastInsertRowid);
      touch(user.id); emit('pause', user.id);
      return { idle_id: id, started_at: T.iso(at), trimmed_screenshots: trimmed };
    }
    if (!open) { touch(user.id); return { already: true }; }
    const at = when(body, 'at', Date.parse(open.started_at));
    db.prepare('UPDATE idle_periods SET ended_at = ? WHERE id = ?').run(T.iso(at), open.id);
    touch(user.id); emit('pause', user.id);
    return { idle_id: open.id, ended_at: T.iso(at), idle_secs: Math.round((at - Date.parse(open.started_at)) / 1000) };
  });

  route('POST', '/api/timer/stop', ({ user, body }) => {
    const e = openEntry(user.id);
    need(e, 409, 'Timer is not running');
    const p = openPause(e.id);
    const lo = Math.max(lastEventMs(e), p ? Date.parse(p.started_at) : 0);
    const at = when(body, 'ended_at', lo);
    if (at < clockNow() - 2000) trimAfter(user.id, at);
    const reason = ['manual', 'idle', 'quit', 'shutdown', 'shift_end'].includes(body.reason) ? body.reason : 'manual';
    if (body.note != null) db.prepare('UPDATE time_entries SET note = ? WHERE id = ?').run(optStr(body.note, 'note', 500), e.id);
    const endedAt = closeEntry(e, at, reason);
    touch(user.id);
    emit('timer', user.id);
    const day = T.localDay(at, calc.dayTz(user));
    const full = calc.computeDay(user, day, { detail: true });
    return { entry_id: e.id, ended_at: endedAt, summary: summaryOf(full) };
  });

  // What the employee sees after pressing Stop: the whole day, with every break.
  const summaryOf = (m) => ({
    day: m.day, worked_secs: m.worked_secs, break_secs: m.break_secs, idle_secs: m.idle_secs, break_count: m.break_count,
    first_start: m.first_start, last_end: m.last_end, sessions: m.sessions, activity_pct: m.activity_pct, shots: m.shots,
    breaks: m.breaks, entries: m.entries, by_project: m.by_project, tz_offset_min: m.tz_offset_min,
  });

  // Lightweight "still here" signal from the desktop app, also used to detect a timer that was closed elsewhere.
  route('POST', '/api/timer/ping', ({ user }) => {
    const s = shape(user);
    if (s.active) touch(user.id);
    return s;
  });

  // ---- manual time (managers) ----
  route('POST', '/api/time/manual', ({ user, body }) => {
    ctx.needManager(user);
    const uid = int(body.user_id, 'user_id', 1, 1e9);
    const t = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    need(t && ctx.canSee(user, uid), 404, 'User not found');
    const start = Date.parse(isoDate(body.start, 'start')), end = Date.parse(isoDate(body.end, 'end'));
    need(end > start, 400, 'The end must be after the start');
    need(end - start <= 16 * 3600000, 400, 'A manual entry can be at most 16 hours');
    need(end <= clockNow() + 60000, 400, 'Manual time cannot be in the future');
    const note = optStr(body.note, 'note', 500);
    need(note, 400, 'Add a note explaining why this time is being added');
    const clash = db.prepare('SELECT 1 FROM time_entries WHERE user_id = ? AND started_at < ? AND COALESCE(ended_at, ?) > ?').get(uid, T.iso(end), T.iso(clockNow()), T.iso(start));
    need(!clash, 409, 'That overlaps time already tracked');
    let projectId = null;
    if (body.project_id != null) { projectId = int(body.project_id, 'project_id', 1, 1e9); need(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId), 404, 'Project not found'); }
    const id = Number(db.prepare("INSERT INTO time_entries (user_id, project_id, started_at, ended_at, note, source, stop_reason, created_by) VALUES (?,?,?,?,?,'manual','manual',?)")
      .run(uid, projectId, T.iso(start), T.iso(end), note, user.id).lastInsertRowid);
    audit(user, 'time.manual_added', uid, `${T.iso(start)} to ${T.iso(end)}: ${note}`);
    ctx.changes.log(uid, user, { area: 'time', title: 'Time was added to your day', lines: [spanText(t, start, end)], reason: note, link: `#/timeline?day=${T.localDay(start, calc.dayTz(t))}` });
    emit('timer', uid);
    return { entry_id: id };
  });

  route('DELETE', '/api/time/entries/:id', ({ user, params, body, query }) => {
    ctx.needManager(user);
    const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(params.id));
    need(e && ctx.canSee(user, e.user_id), 404, 'Time entry not found');
    need(e.ended_at, 409, 'Stop the timer first');
    const reason = optStr((body && body.reason) || query.get('reason'), 'reason', 500);
    need(reason, 400, 'Say why this time is being removed. The person is told.');
    db.prepare('DELETE FROM time_entries WHERE id = ?').run(e.id);
    audit(user, 'time.deleted', e.user_id, `${e.started_at} to ${e.ended_at} (${e.source}): ${reason}`);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(e.user_id);
    ctx.changes.log(e.user_id, user, { area: 'time', title: 'Time was removed from your day', lines: [spanText(owner, Date.parse(e.started_at), Date.parse(e.ended_at))], reason, link: `#/timeline?day=${T.localDay(Date.parse(e.started_at), calc.dayTz(owner))}` });
    emit('timer', e.user_id);
    return { ok: true };
  });
};
