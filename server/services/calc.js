'use strict';
const T = require('../lib/time');

// Everything the dashboards show is computed here from the raw facts (time entries, pauses,
// activity slots, screenshots, leave). Nothing is stored twice, so numbers cannot drift apart.
function createCalc(ctx) {
  const { db, cfg } = ctx;
  const nowMs = () => ctx.now();

  // ---------- per-person schedule ----------
  // A person's zone is a place (America/New_York); their offset is worked out for the moment asked about,
  // so daylight saving is followed. Older records may hold only a fixed offset; the company zone is the
  // default for anyone with neither.
  const zoneOf = (u) => (u && u.tz_name) || (u && u.tz_offset_min != null ? null : cfg.tzName || null);
  const userTz = (u, at = nowMs()) => { const z = zoneOf(u); return z ? T.zoneOffset(z, at) : (u && u.tz_offset_min != null ? u.tz_offset_min : cfg.tzOffsetMin); };
  const companyTz = (at = nowMs()) => (cfg.tzName ? T.zoneOffset(cfg.tzName, at) : cfg.tzOffsetMin);
  const companyDayTz = (at = nowMs()) => companyTz(at) - T.dayStartMin(cfg.shiftStart, cfg.shiftEnd);
  const companyToday = () => T.localDay(nowMs(), companyDayTz());
  // the offset that applies on a work day (taken at midday, clear of the night-time switch)
  const tzOn = (u, day) => userTz(u, day ? T.middayOf(day) : nowMs());
  // Some people keep different hours on some days (a half day on Saturday). dayHours(u) is that list,
  // keyed by weekday; hoursOn(u, day) is the shift that applies on one work day. The work-day boundary
  // (dayStart) always comes from the person's usual shift, so days never shift around.
  const dayHours = (u) => { if (!u.day_hours) return {}; try { const o = JSON.parse(u.day_hours); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const hoursOn = (u, day) => {
    const o = day ? dayHours(u)[T.dow(day)] : null;
    if (o && o.shift_start && o.shift_end) return { shift_start: o.shift_start, shift_end: o.shift_end, break_start: o.break_start || null, break_end: o.break_end || null, special: true };
    return { shift_start: u.shift_start || cfg.shiftStart, shift_end: u.shift_end || cfg.shiftEnd, break_start: u.break_start || cfg.breakStart || null, break_end: u.break_end || cfg.breakEnd || null, special: false };
  };
  const shiftStartMin = (u, day) => T.hhmm(hoursOn(u, day).shift_start);
  const shiftEndMin = (u, day) => T.hhmm(hoursOn(u, day).shift_end);
  // Work days: for a shift that runs past midnight, the day starts later than midnight (see T.dayStartMin),
  // so all day maths use dayTz (the person's offset moved back by that much) and minutes in a day are
  // counted from that start. Clock times shown to people still use userTz.
  const dayStart = (u) => T.dayStartMin(u.shift_start || cfg.shiftStart, u.shift_end || cfg.shiftEnd);
  const dayTz = (u, day) => tzOn(u, day) - dayStart(u);
  const relMin = (u, m) => (((m - dayStart(u)) % 1440) + 1440) % 1440;
  // scheduled break (optional): [start, end] in minutes after local midnight, or null
  const breakOf = (u, day) => { const h = hoursOn(u, day), s = h.break_start, e = h.break_end; return s && e && s !== e ? [T.hhmm(s), T.hhmm(e)] : null; };
  const workDaySet = (u) => new Set(String(u.work_days || cfg.workDays).split(',').filter(Boolean).map(Number));
  const weeklyTargetMin = (u) => u.weekly_target_min ?? cfg.weeklyTargetMin;
  // minutes scheduled by one shift: its length less its break
  const shiftLenMin = (h) => {
    const len = ((T.hhmm(h.shift_end) - T.hhmm(h.shift_start)) + 1440) % 1440 || 1440;
    const b = h.break_start && h.break_end && h.break_start !== h.break_end ? ((T.hhmm(h.break_end) - T.hhmm(h.break_start)) + 1440) % 1440 : 0;
    return Math.max(0, len - b);
  };
  // Expected minutes on a day. Normally the weekly target split over the working days. A day with its
  // own hours expects those hours, and the rest of the weekly target is split over the other days.
  const dailyTargetMin = (u, day) => {
    const days = workDaySet(u), special = dayHours(u);
    const specialDays = [...days].filter((d) => special[d] && special[d].shift_start && special[d].shift_end);
    if (day && specialDays.includes(T.dow(day))) return shiftLenMin(hoursOn(u, day));
    if (!specialDays.length) return Math.round(weeklyTargetMin(u) / Math.max(1, days.size));
    const used = specialDays.reduce((n, d) => n + shiftLenMin({ ...special[d] }), 0);
    return Math.round(Math.max(0, weeklyTargetMin(u) - used) / Math.max(1, days.size - specialDays.length));
  };
  const todayOf = (u) => T.localDay(nowMs(), dayTz(u));

  const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');
  const round1 = (n) => Math.round(n * 10) / 10;
  const mins = (ms, ws) => Math.round(((ms - ws) / 60000) * 100) / 100;

  // ---------- tasks: completion, on time, first-time accuracy ----------
  function taskMetrics(users, from, to) {
    const per = new Map(users.map((u) => [u.id, { due: 0, due_done: 0, done: 0, on_time: 0, with_due: 0, approved: 0, first_time: 0, overdue_open: 0, open: 0, in_review: 0 }]));
    if (!users.length) return { per, total: summarize([...per.values()]) };
    const byId = new Map(users.map((u) => [u.id, u]));
    const rows = db.prepare(`SELECT * FROM tasks WHERE assignee_id IN (${placeholders(users.length)})`).all(...users.map((u) => u.id));
    for (const t of rows) {
      const u = byId.get(t.assignee_id), m = per.get(t.assignee_id), today = todayOf(u);
      const doneDay = t.completed_at ? T.localDay(Date.parse(t.completed_at), dayTz(u)) : null;
      if (t.status !== 'done') { m.open++; if (t.status === 'in_review') m.in_review++; if (t.due_day && t.due_day < today) m.overdue_open++; }
      if (t.due_day && t.due_day >= from && t.due_day <= to && t.due_day <= today) { m.due++; if (t.status === 'done') m.due_done++; }
      if (t.status === 'done' && doneDay && doneDay >= from && doneDay <= to) {
        m.done++;
        if (t.due_day) { m.with_due++; if (doneDay <= t.due_day) m.on_time++; }
        if (t.approved_by) { m.approved++; if (t.first_time) m.first_time++; }
      }
    }
    for (const [id, m] of per) per.set(id, summarize([m]));
    return { per, total: summarize([...per.values()]) };
  }
  function summarize(list) {
    const a = list.reduce((o, m) => { for (const k of Object.keys(m)) if (typeof m[k] === 'number' && !k.endsWith('_pct')) o[k] = (o[k] || 0) + m[k]; return o; }, {});
    for (const k of ['due', 'due_done', 'done', 'on_time', 'with_due', 'approved', 'first_time', 'overdue_open', 'open', 'in_review']) a[k] = a[k] || 0;
    return { ...a, completion_pct: pct(a.due_done, a.due), on_time_pct: pct(a.on_time, a.with_due), accuracy_pct: pct(a.first_time, a.approved) };
  }

  // ---------- one person, one day ----------
  function computeDay(u, day, { detail = false } = {}) {
    const tz = dayTz(u, day);
    const [ws, we] = T.dayWindow(day, tz);
    const wsI = T.iso(ws), weI = T.iso(we);
    const now = nowMs();

    const entries = db.prepare(`SELECT e.*, p.name AS project, t.title AS task
      FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.user_id = ? AND e.started_at < ? AND (e.ended_at IS NULL OR e.ended_at > ?) ORDER BY e.started_at`).all(u.id, weI, wsI);
    const ids = entries.map((e) => e.id);
    const pauses = ids.length
      ? db.prepare(`SELECT * FROM pauses WHERE entry_id IN (${placeholders(ids.length)}) ORDER BY started_at`).all(...ids)
      : [];
    const idles = ids.length
      ? db.prepare(`SELECT * FROM idle_periods WHERE entry_id IN (${placeholders(ids.length)}) ORDER BY started_at`).all(...ids)
      : [];

    const segs = [];            // [startMin, endMin, 'w'|'b'|'i'] minutes since the person's midnight
    const breaks = [];
    const byProject = new Map();
    let worked = 0, brk = 0, idle = 0, away = 0, breakCount = 0, idleCount = 0, running = false;
    let first = null, last = null;
    const entryOut = [];

    for (const e of entries) {
      const eStartAbs = Date.parse(e.started_at);
      const open = !e.ended_at;
      const s = Math.max(eStartAbs, ws);
      const eEnd = Math.min(open ? now : Date.parse(e.ended_at), we);
      if (open && now >= ws && now < we) running = true;
      if (eEnd <= s) continue;
      let cur = s, entryWorked = 0;
      for (const p of pauses.filter((x) => x.entry_id === e.id)) {
        const ps = T.clamp(Date.parse(p.started_at), s, eEnd);
        const pe = T.clamp(p.ended_at ? Date.parse(p.ended_at) : now, s, eEnd);
        if (pe <= ps) continue;
        if (ps > cur) { segs.push([mins(cur, ws), mins(ps, ws), 'w']); worked += ps - cur; entryWorked += ps - cur; }
        const isIdle = p.reason === 'idle', isAway = p.reason === 'away';   // 'away': the computer was asleep, restarting or off
        segs.push([mins(ps, ws), mins(pe, ws), isIdle ? 'i' : isAway ? 'o' : 'b']);
        if (isIdle) { idle += pe - ps; idleCount++; } else if (isAway) away += pe - ps; else { brk += pe - ps; breakCount++; }
        breaks.push({ id: p.id, started_at: T.iso(ps), ended_at: p.ended_at ? T.iso(pe) : null, secs: Math.round((pe - ps) / 1000), reason: p.reason, type: isIdle ? 'idle' : isAway ? 'away' : 'break', open: !p.ended_at });
        cur = pe;
      }
      if (eEnd > cur) { segs.push([mins(cur, ws), mins(eEnd, ws), 'w']); worked += eEnd - cur; entryWorked += eEnd - cur; }
      if (first == null) first = s;
      last = Math.max(last ?? 0, eEnd);
      const key = e.project_id ?? 0;
      const pr = byProject.get(key) || { project_id: e.project_id, name: e.project || 'No project', secs: 0 };
      pr.secs += entryWorked / 1000; byProject.set(key, pr);
      if (detail) entryOut.push({ id: e.id, started_at: T.iso(s), ended_at: open ? null : T.iso(eEnd), project: e.project, task: e.task, note: e.note, source: e.source, stop_reason: e.stop_reason, worked_secs: Math.round(entryWorked / 1000), started_before_day: eStartAbs < ws });
    }
    segs.sort((a, b) => a[0] - b[0]);

    // Idle while the timer kept running: still worked time, but shown as idle on the ribbon and in the totals.
    if (idles.length) {
      const spans = [];
      for (const ip of idles) {
        const e = entries.find((x) => x.id === ip.entry_id);
        const eEnd = e.ended_at ? Date.parse(e.ended_at) : now;
        const s0 = Math.max(Date.parse(ip.started_at), ws), e0 = Math.min(ip.ended_at ? Date.parse(ip.ended_at) : Math.min(now, eEnd), we, eEnd);
        if (e0 > s0) spans.push({ ip, s: mins(s0, ws), e: mins(e0, ws), ms: e0 - s0, s0, e0 });
      }
      const out = [];
      for (const g of segs) {
        if (g[2] !== 'w') { out.push(g); continue; }
        let cur = g[0];
        for (const sp of spans) {
          const a = Math.max(sp.s, g[0]), b = Math.min(sp.e, g[1]);
          if (b <= a) continue;
          if (a > cur) out.push([cur, a, 'w']);
          out.push([a, b, 'i']);
          cur = b;
        }
        if (g[1] > cur) out.push([cur, g[1], 'w']);
      }
      segs.length = 0; segs.push(...out.sort((a, b) => a[0] - b[0]));
      for (const sp of spans) {
        idle += sp.ms; idleCount++;
        breaks.push({ id: `i${sp.ip.id}`, started_at: T.iso(sp.s0), ended_at: sp.ip.ended_at ? T.iso(sp.e0) : null, secs: Math.round(sp.ms / 1000), reason: 'idle', type: 'idle', counted: true, open: !sp.ip.ended_at });
      }
      breaks.sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
    }

    const act = db.prepare(`SELECT COALESCE(SUM(tracked_secs),0) t, COALESCE(SUM(active_secs),0) a FROM activity_slots
      WHERE user_id = ? AND slot_start >= ? AND slot_start < ?`).get(u.id, wsI, weI);
    const shots = db.prepare('SELECT COUNT(*) n, MAX(taken_at) last FROM screenshots WHERE user_id = ? AND deleted = 0 AND taken_at >= ? AND taken_at < ?').get(u.id, wsI, weI);

    const out = {
      day, user_id: u.id, tz_offset_min: tzOn(u, day), day_start_min: dayStart(u),
      worked_secs: Math.round(worked / 1000), break_secs: Math.round(brk / 1000), idle_secs: Math.round(idle / 1000), away_secs: Math.round(away / 1000),
      break_count: breakCount, idle_count: idleCount, sessions: entries.length,
      first_start: first == null ? null : T.iso(first), last_end: last == null ? null : T.iso(last), running,
      tracked_secs: act.t, activity_pct: act.t ? Math.round((100 * act.a) / act.t) : null,
      shots: shots.n, last_shot_at: shots.last || null,
      by_project: [...byProject.values()].map((p) => ({ ...p, secs: Math.round(p.secs) })),
      segs,
    };
    if (detail) {
      out.entries = entryOut;
      out.breaks = breaks;
      out.activity = db.prepare(`SELECT slot_start, tracked_secs, active_secs FROM activity_slots
        WHERE user_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start`).all(u.id, wsI, weI)
        .map((r) => ({ slot_start: r.slot_start, tracked_secs: r.tracked_secs, active_secs: r.active_secs, pct: r.tracked_secs ? Math.round((100 * r.active_secs) / r.tracked_secs) : null }));
    }
    return out;
  }

  // ---------- calendar (leave + holidays) and attendance ----------
  function loadCalendar(userIds, from, to) {
    const holidays = new Map(db.prepare('SELECT day, name FROM holidays WHERE day >= ? AND day <= ?').all(from, to).map((h) => [h.day, h.name]));
    const leave = new Map();
    if (userIds.length) {
      const rows = db.prepare(`SELECT * FROM leave_requests WHERE status = 'approved' AND start_day <= ? AND end_day >= ?
        AND user_id IN (${placeholders(userIds.length)})`).all(to, from, ...userIds);
      for (const r of rows) { if (!leave.has(r.user_id)) leave.set(r.user_id, []); leave.get(r.user_id).push(r); }
    }
    return { holidays, leave };
  }

  function attendanceFor(u, day, m, cal) {
    const tz = dayTz(u, day);
    const now = nowMs();
    const today = todayOf(u);
    const workday = workDaySet(u).has(T.dow(day));
    const hol = cal.holidays.get(day) || null;
    const lv = (cal.leave.get(u.id) || []).find((l) => l.start_day <= day && day <= l.end_day) || null;
    const joinedDay = u.created_at ? T.localDay(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(u.created_at) ? u.created_at : `${u.created_at.replace(' ', 'T')}Z`), tz) : null;
    const before = joinedDay && day < joinedDay && !(m.worked_secs > 0 || m.running) && !lv;
    const planned = workday && !hol && !lv && !before;
    const expected = planned ? dailyTargetMin(u, day) * 60 : 0;
    const hasWork = m.worked_secs > 0 || m.running;
    let lateBy = 0;
    if (m.first_start) {
      const fsMs = Date.parse(m.first_start);
      const startedToday = T.localDay(fsMs, tz) === day;
      if (startedToday) lateBy = Math.max(0, T.localMinOfDay(fsMs, tz) - relMin(u, shiftStartMin(u, day)));
      if (lateBy <= cfg.graceMin) lateBy = 0;
    }
    let status;
    if (before) status = 'before';
    else if (day > today) status = hol ? 'holiday' : lv ? 'leave' : !workday ? 'off' : 'upcoming';
    else if (hasWork) status = planned && lateBy > 0 ? 'late' : 'present';
    else if (hol) status = 'holiday';
    else if (lv) status = 'leave';
    else if (!workday) status = 'off';
    else if (day === today) {
      const nm = T.localMinOfDay(now, tz);
      const rs = relMin(u, shiftStartMin(u, day)), re = rs + ((shiftEndMin(u, day) - shiftStartMin(u, day) + 1440) % 1440 || 1440);
      status = nm < rs + cfg.graceMin ? 'upcoming' : (nm < re ? 'not_started' : 'absent');
    } else status = 'absent';
    // how much of the expected time is due by now: all of it on past days, none on future days, and
    // today only the part of the shift that has already gone by
    let expectedDone = day < today ? expected : 0;
    if (expected && day === today) {
      const nm = T.localMinOfDay(now, tz);
      const rs = relMin(u, shiftStartMin(u, day)), len = ((shiftEndMin(u, day) - shiftStartMin(u, day) + 1440) % 1440) || 1440;
      expectedDone = Math.round(expected * Math.min(1, Math.max(0, (nm - rs) / len)));
    }
    return {
      status, expected_secs: expected, expected_done_secs: expectedDone, late_by_min: lateBy, extra: hasWork && !planned,
      holiday: hol, leave_kind: lv ? lv.kind : null, first_in: m.first_start, last_out: m.running ? null : m.last_end,
    };
  }

  // ---------- who is doing what right now ----------
  function liveStates(users) {
    const out = new Map();
    if (!users.length) return out;
    const ids = users.map((u) => u.id);
    const open = db.prepare(`SELECT e.*, p.name AS project, t.title AS task FROM time_entries e
      LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.ended_at IS NULL AND e.user_id IN (${placeholders(ids.length)})`).all(...ids);
    const entryIds = open.map((e) => e.id);
    const pauses = entryIds.length ? db.prepare(`SELECT * FROM pauses WHERE ended_at IS NULL AND entry_id IN (${placeholders(entryIds.length)})`).all(...entryIds) : [];
    const idles = entryIds.length ? db.prepare(`SELECT * FROM idle_periods WHERE ended_at IS NULL AND entry_id IN (${placeholders(entryIds.length)})`).all(...entryIds) : [];
    const now = nowMs();
    for (const u of users) {
      const e = open.find((x) => x.user_id === u.id);
      if (!e) { out.set(u.id, { state: 'offline' }); continue; }
      const p = pauses.find((x) => x.entry_id === e.id);
      const seen = u.last_seen_at ? Date.parse(u.last_seen_at) : Date.parse(e.started_at);
      const base = { entry_id: e.id, project: e.project, task: e.task, project_id: e.project_id, task_id: e.task_id, last_seen_at: u.last_seen_at || null };
      if (now - seen > cfg.noSignalMin * 60000) out.set(u.id, { ...base, state: 'no_signal', since: T.iso(seen) });
      else if (p) out.set(u.id, { ...base, state: p.reason === 'idle' ? 'idle' : p.reason === 'away' ? 'no_signal' : 'break', reason: p.reason, since: p.started_at });
      else if (idles.find((x) => x.entry_id === e.id)) out.set(u.id, { ...base, state: 'idle', counted: true, since: idles.find((x) => x.entry_id === e.id).started_at });
      else out.set(u.id, { ...base, state: 'working', since: e.started_at });
    }
    return out;
  }

  // Memoises computeDay + attendance for the duration of one request.
  function makeRange(users, from, to) {
    const cal = loadCalendar(users.map((u) => u.id), from, to);
    const memo = new Map();
    const get = (u, day) => {
      const k = `${u.id}|${day}`;
      if (!memo.has(k)) {
        const m = computeDay(u, day);
        memo.set(k, { ...m, att: attendanceFor(u, day, m, cal) });
      }
      return memo.get(k);
    };
    return { get, cal };
  }

  const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);

  // Attendance numbers for a set of members on one day (used by the team KPI band and the trend).
  function dayRollup(members, day, range) {
    let worked = 0, tracked = 0, activeSecs = 0, expected = 0, attended = 0, onTime = 0, late = 0, breaks = 0, breakers = 0, idle = 0, shots = 0, onLeave = 0;
    for (const u of members) {
      const m = range.get(u, day);
      worked += m.worked_secs; idle += m.idle_secs; shots += m.shots;
      tracked += m.tracked_secs; activeSecs += m.tracked_secs ? Math.round((m.activity_pct / 100) * m.tracked_secs) : 0;
      const s = m.att.status;
      if (s === 'leave') onLeave++;
      if (m.worked_secs > 0 || m.running) { breaks += m.break_secs; breakers++; }
      if (m.att.expected_secs > 0 && ['present', 'late', 'not_started', 'absent'].includes(s)) {
        expected++;
        if (s === 'present' || s === 'late') { attended++; if (s === 'present') onTime++; else late++; }
      }
    }
    return {
      day, worked_secs: worked, activity_pct: pct(activeSecs, tracked), expected, attended, late, on_leave: onLeave,
      attendance_rate: pct(attended, expected), punctuality_rate: pct(onTime, attended),
      avg_break_secs: breakers ? Math.round(breaks / breakers) : 0, idle_secs: idle, shots,
    };
  }

  // ---------- the manager's dashboard ----------
  function teamDashboard(members, day, viewer) {
    const mon = T.mondayOf(day);
    const from = mon < T.addDays(day, -6) ? mon : T.addDays(day, -6);
    const range = makeRange(members, from, day > T.addDays(mon, 6) ? day : T.addDays(mon, 6));
    const live = liveStates(members);
    const teams = new Map(db.prepare('SELECT id, name FROM teams').all().map((t) => [t.id, t.name]));

    const rows = members.map((u) => {
      const m = range.get(u, day);
      const lv = live.get(u.id);
      let week = 0, weekExpected = 0;
      for (let d = mon; d <= T.addDays(mon, 6); d = T.addDays(d, 1)) {
        const wm = range.get(u, d);
        week += wm.worked_secs;
        if (d <= day) weekExpected += wm.att.expected_secs;
      }
      return {
        user_id: u.id, name: u.name, title: u.title, team: u.team_id ? teams.get(u.team_id) || null : null, team_id: u.team_id,
        tz_offset_min: tzOn(u, day), tz_name: zoneOf(u), day_start_min: dayStart(u), ...lv,
        worked_secs: m.worked_secs, break_secs: m.break_secs, break_count: m.break_count, idle_secs: m.idle_secs,
        activity_pct: m.activity_pct, shots: m.shots, last_shot_at: m.last_shot_at, first_start: m.first_start,
        segs: m.segs, attendance: m.att.status, late_by_min: m.att.late_by_min, expected_secs: m.att.expected_secs,
        week_secs: week, week_target_secs: weeklyTargetMin(u) * 60, week_expected_secs: weekExpected,
        shift_start: hoursOn(u, day).shift_start, shift_end: hoursOn(u, day).shift_end,
      };
    });

    const today = dayRollup(members, day, range);
    const states = { working: 0, break: 0, idle: 0, no_signal: 0, offline: 0 };
    for (const r of rows) states[r.state] = (states[r.state] || 0) + 1;
    const weekSecs = rows.reduce((n, r) => n + r.week_secs, 0);
    const weekTarget = rows.reduce((n, r) => n + r.week_target_secs, 0);
    const weekExpected = rows.reduce((n, r) => n + r.week_expected_secs, 0);

    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = T.addDays(day, -i);
      const r = dayRollup(members, d, range);
      trend.push({ day: d, worked_secs: r.worked_secs, activity_pct: r.activity_pct, attendance_rate: r.attendance_rate });
    }

    const memberIds = members.map((u) => u.id);
    const pending = memberIds.length
      ? db.prepare(`SELECT COUNT(*) n FROM leave_requests WHERE status = 'pending' AND user_id IN (${placeholders(memberIds.length)})`).get(...memberIds).n
      : 0;

    return {
      day, generated_at: T.iso(nowMs()),
      kpis: {
        members: members.length,
        working: states.working, on_break: states.break, idle: states.idle, no_signal: states.no_signal,
        not_started: rows.filter((r) => r.attendance === 'not_started').length,
        on_leave: today.on_leave,
        worked_secs: today.worked_secs, activity_pct: today.activity_pct,
        attendance_rate: today.attendance_rate, punctuality_rate: today.punctuality_rate, late_count: today.late,
        avg_break_secs: today.avg_break_secs, idle_secs: today.idle_secs, shots: today.shots,
        week_secs: weekSecs, week_target_secs: weekTarget, week_expected_secs: weekExpected,
        week_pace_pct: pct(weekSecs, weekExpected), pending_timeoff: pending,
        pending_requests: memberIds.length ? db.prepare(`SELECT COUNT(*) n FROM time_requests WHERE status = 'pending' AND user_id IN (${placeholders(memberIds.length)})`).get(...memberIds).n : 0,
        tasks: taskKpis(members, day),
      },
      trend, members: rows,
    };
  }

  // ---------- an employee's own dashboard ----------
  function myDashboard(u, day) {
    const mon = T.mondayOf(day);
    const from30 = T.addDays(day, -29);
    const from = from30 < mon ? from30 : mon;
    const range = makeRange([u], from, T.addDays(mon, 6));
    const lv = liveStates([u]).get(u.id);
    const m = computeDay(u, day, { detail: true });
    const att = range.get(u, day).att;

    let week = 0, weekExpected = 0;
    for (let d = mon; d <= T.addDays(mon, 6); d = T.addDays(d, 1)) {
      const wm = range.get(u, d);
      week += wm.worked_secs;
      if (d <= day) weekExpected += wm.att.expected_secs;
    }
    let present = 0, late = 0, expected = 0, totalWorked = 0, workedDays = 0;
    for (let d = from30; d <= day; d = T.addDays(d, 1)) {
      const r = range.get(u, d);
      const s = r.att.status;
      if (r.att.expected_secs > 0 && ['present', 'late', 'absent'].includes(s)) { expected++; if (s !== 'absent') { present++; if (s === 'late') late++; } }
      if (r.worked_secs > 0) { totalWorked += r.worked_secs; workedDays++; }
    }
    // streak of consecutive planned days that were on time (today counts only once it has started)
    let streak = 0;
    for (let d = day; d >= from30; d = T.addDays(d, -1)) {
      const r = range.get(u, d);
      if (r.att.expected_secs === 0 && !['present', 'late'].includes(r.att.status)) continue;
      if (r.att.status === 'present') streak++;
      else if (d === day && ['upcoming', 'not_started'].includes(r.att.status)) continue;
      else break;
    }
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = T.addDays(day, -i);
      const r = range.get(u, d);
      trend.push({ day: d, worked_secs: r.worked_secs, break_secs: r.break_secs, activity_pct: r.activity_pct, status: r.att.status, expected_secs: r.att.expected_secs });
    }
    const year = day.slice(0, 4);
    const leaveTaken = approvedLeaveDays(u, year);
    const pending = db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE user_id = ? AND status = 'pending'").get(u.id).n;
    const dailyTarget = dailyTargetMin(u, day) * 60;

    return {
      day, generated_at: T.iso(nowMs()), user: (({ special, ...h }) => ({ id: u.id, name: u.name, title: u.title, tz_offset_min: tzOn(u, day), tz_name: zoneOf(u), day_start_min: dayStart(u), ...h, special_hours: special }))(hoursOn(u, day)),
      live: lv, attendance: att,
      kpis: {
        worked_secs: m.worked_secs, daily_target_secs: dailyTarget, day_pct: pct(m.worked_secs, dailyTarget),
        break_secs: m.break_secs, break_count: m.break_count, idle_secs: m.idle_secs,
        activity_pct: m.activity_pct, shots: m.shots,
        week_secs: week, week_target_secs: weeklyTargetMin(u) * 60, week_expected_secs: weekExpected, week_pace_pct: pct(week, weekExpected),
        attendance_30: pct(present, expected), punctuality_30: pct(present - late, present), on_time_streak: streak,
        avg_worked_day_secs: workedDays ? Math.round(totalWorked / workedDays) : 0,
        tasks: taskKpis([u], day),
        leave_taken: leaveTaken, leave_allowance: cfg.leaveDaysPerYear, leave_left: Math.max(0, cfg.leaveDaysPerYear - leaveTaken), pending_timeoff: pending,
      },
      trend, today: { segs: m.segs, breaks: m.breaks, first_start: m.first_start, last_end: m.last_end, tz_offset_min: tzOn(u, day), day_start_min: dayStart(u) },
    };
  }

  // Task numbers for a dashboard: today's due and overdue work, plus the last 30 days of completion and accuracy.
  function taskKpis(users, day) {
    const recent = taskMetrics(users, T.addDays(day, -29), day).total;
    return { open: recent.open, overdue: recent.overdue_open, in_review: recent.in_review, done_30: recent.done, completion_pct: recent.completion_pct, on_time_pct: recent.on_time_pct, accuracy_pct: recent.accuracy_pct };
  }

  // Working days of approved leave inside one calendar year (weekends and holidays don't count).
  function approvedLeaveDays(u, year) {
    const rows = db.prepare("SELECT start_day, end_day FROM leave_requests WHERE user_id = ? AND status = 'approved' AND kind != 'unpaid' AND end_day >= ? AND start_day <= ?")
      .all(u.id, `${year}-01-01`, `${year}-12-31`);
    const wd = workDaySet(u);
    const hol = new Set(db.prepare('SELECT day FROM holidays WHERE day LIKE ?').all(`${year}-%`).map((h) => h.day));
    let n = 0;
    const seen = new Set();
    for (const r of rows) {
      for (const d of T.eachDay(r.start_day < `${year}-01-01` ? `${year}-01-01` : r.start_day, r.end_day > `${year}-12-31` ? `${year}-12-31` : r.end_day)) {
        if (!seen.has(d) && wd.has(T.dow(d)) && !hol.has(d)) { seen.add(d); n++; }
      }
    }
    return n;
  }

  // ---------- timesheets / attendance grid / reports ----------
  function grid(users, from, to) {
    const range = makeRange(users, from, to);
    const days = T.eachDay(from, to);
    const rows = users.map((u) => {
      const cells = {};
      const t = { worked_secs: 0, break_secs: 0, idle_secs: 0, tracked: 0, activeSum: 0, expected_secs: 0, expected_done_secs: 0, present: 0, late: 0, absent: 0, leave: 0, shots: 0 };
      for (const d of days) {
        const m = range.get(u, d);
        cells[d] = { worked_secs: m.worked_secs, break_secs: m.break_secs, idle_secs: m.idle_secs, activity_pct: m.activity_pct, status: m.att.status, late_by_min: m.att.late_by_min, first_in: m.first_start, last_out: m.running ? null : m.last_end, expected_secs: m.att.expected_secs, expected_done_secs: m.att.expected_done_secs, running: m.running, extra: m.att.extra, holiday: m.att.holiday, leave_kind: m.att.leave_kind, shots: m.shots };
        t.worked_secs += m.worked_secs; t.break_secs += m.break_secs; t.idle_secs += m.idle_secs; t.shots += m.shots;
        t.tracked += m.tracked_secs; t.activeSum += m.tracked_secs ? (m.activity_pct / 100) * m.tracked_secs : 0;
        if (d <= todayOf(u)) t.expected_secs += m.att.expected_secs;
        t.expected_done_secs += m.att.expected_done_secs;
        const s = m.att.status;
        if (s === 'present') t.present++; else if (s === 'late') { t.present++; t.late++; } else if (s === 'absent') t.absent++; else if (s === 'leave') t.leave++;
      }
      return {
        user_id: u.id, name: u.name, title: u.title, tz_offset_min: userTz(u), tz_name: zoneOf(u), cells,
        totals: { worked_secs: t.worked_secs, break_secs: t.break_secs, idle_secs: t.idle_secs, expected_secs: t.expected_secs, expected_done_secs: t.expected_done_secs, activity_pct: pct(t.activeSum, t.tracked), days_present: t.present, days_late: t.late, days_absent: t.absent, days_leave: t.leave, shots: t.shots },
      };
    });
    return { from, to, days, holidays: Object.fromEntries(range.cal.holidays), rows };
  }

  function report(users, from, to, group) {
    const range = makeRange(users, from, to);
    const days = T.eachDay(from, to);
    const out = new Map();
    const bump = (key, label, f) => {
      const r = out.get(key) || { key, label, worked_secs: 0, break_secs: 0, idle_secs: 0, tracked: 0, activeSum: 0, days_worked: 0, late_days: 0, absent_days: 0, shots: 0, members: new Set() };
      f(r); out.set(key, r);
    };
    for (const u of users) {
      for (const d of days) {
        const m = range.get(u, d);
        const add = (r) => {
          r.break_secs += m.break_secs; r.idle_secs += m.idle_secs; r.shots += m.shots; r.tracked += m.tracked_secs;
          r.activeSum += m.tracked_secs ? (m.activity_pct / 100) * m.tracked_secs : 0;
          if (m.worked_secs > 0) r.days_worked++;
          if (m.att.status === 'late') r.late_days++;
          if (m.att.status === 'absent') r.absent_days++;
          r.members.add(u.id);
        };
        if (group === 'project') {
          for (const p of m.by_project) bump(`p${p.project_id ?? 0}`, p.name, (r) => { r.worked_secs += p.secs; r.members.add(u.id); if (p.secs) r.days_worked++; });
        } else if (group === 'day') {
          bump(d, d, (r) => { r.worked_secs += m.worked_secs; add(r); });
        } else {
          bump(`u${u.id}`, u.name, (r) => { r.worked_secs += m.worked_secs; add(r); });
        }
      }
    }
    return [...out.values()].map((r) => ({
      key: r.key, label: r.label, worked_secs: Math.round(r.worked_secs), break_secs: r.break_secs, idle_secs: r.idle_secs,
      activity_pct: pct(r.activeSum, r.tracked), days_worked: r.days_worked, late_days: r.late_days, absent_days: r.absent_days, shots: r.shots, members: r.members.size,
    })).sort((a, b) => (group === 'day' ? a.key.localeCompare(b.key) : b.worked_secs - a.worked_secs));
  }

  return { userTz, zoneOf, tzOn, companyTz, companyDayTz, companyToday, dayTz, dayStart, relMin, breakOf, dayHours, hoursOn, shiftLenMin, shiftStartMin, shiftEndMin, workDaySet, weeklyTargetMin, dailyTargetMin, todayOf, computeDay, attendanceFor, loadCalendar, liveStates, makeRange, teamDashboard, myDashboard, grid, report, approvedLeaveDays, taskMetrics };
}

module.exports = { createCalc };
