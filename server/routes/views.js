'use strict';
const { need } = require('../lib/http');

module.exports = (ctx) => {
  const { db, cfg, route, calc, nowIso, clockNow, T, needManager, visibleUsers, targetUser, isManager } = ctx;
  // (ctx.notesFor / ctx.requestsFor come from routes/explain.js, loaded after this file; used at request time)

  // the company's work day (a night shift counts as the day it started)
  const companyToday = () => ctx.calc.companyToday();
  const dayParam = (query, fallback) => { const d = query.get('day'); if (d == null) return fallback; need(T.isDay(d), 400, 'day must look like 2026-10-24'); return d; };
  const rangeParams = (query) => {
    const from = query.get('from'), to = query.get('to');
    need(T.isDay(from) && T.isDay(to), 400, 'from and to must look like 2026-10-24');
    need(from <= to, 400, 'from must not be after to');
    need(T.daysBetween(from, to) <= 92, 400, 'Choose a range of 93 days or less');
    return { from, to };
  };
  // Who a manager's page covers: everyone they can see, one team, or one person.
  function members(user, query) {
    const who = query.get('user_id');
    if (who && who !== 'all') return [targetUser(user, who)];
    needManager(user);
    let list = visibleUsers(user, { tracking: true });
    const team = query.get('team_id');
    if (team) list = list.filter((u) => u.team_id === Number(team));
    return list;
  }

  // One person, one day: ribbon, every pause, activity, screenshots.
  route('GET', '/api/users/:id/day', ({ user, params, query }) => {
    const u = targetUser(user, params.id);
    const day = dayParam(query, calc.todayOf(u));
    const m = calc.computeDay(u, day, { detail: true });
    const att = calc.attendanceFor(u, day, m, calc.loadCalendar([u.id], day, day));
    const tz = calc.tzOn(u, day);
    const [ws, we] = T.dayWindow(day, calc.dayTz(u, day));
    const shots = ctx.shotRows([u.id], T.iso(ws), T.iso(we), 1500).map((r) => ({ ...r, has_thumb: !!r.has_thumb, tz_offset_min: tz }));
    const { segs, ...rest } = m;
    return {
      user: (({ special, ...h }) => ({ id: u.id, name: u.name, title: u.title || null, tz_offset_min: tz, tz_name: calc.zoneOf(u), day_start_min: calc.dayStart(u), ...h, special_hours: special }))(calc.hoursOn(u, day)),
      ...rest, segs, attendance: att, live: calc.liveStates([u]).get(u.id), shots_list: shots, generated_at: nowIso(),
      // what the person can explain (idle stretches) and what they already explained or asked for
      idles: db.prepare('SELECT id, started_at, ended_at FROM idle_periods WHERE user_id = ? AND started_at < ? AND COALESCE(ended_at, ?) > ? ORDER BY started_at').all(u.id, T.iso(we), nowIso(), T.iso(ws)),
      notes: ctx.notesFor(u.id, day), requests: ctx.requestsFor(u.id, day), mine: u.id === user.id,
    };
  });

  route('GET', '/api/dashboard/team', ({ user, query }) => {
    needManager(user);
    let list = visibleUsers(user, { tracking: true });
    const team = query.get('team_id');
    if (team) list = list.filter((u) => u.team_id === Number(team));
    const day = dayParam(query, companyToday());
    const d = calc.teamDashboard(list, day, user);
    // the latest few screenshots of the day, for the little preview on the dashboard
    const latest = db.prepare('SELECT id, user_id, taken_at, privacy FROM screenshots WHERE user_id = ? AND deleted = 0 AND taken_at >= ? AND taken_at < ? ORDER BY taken_at DESC LIMIT 4');
    const names = new Map(list.map((u) => [u.id, u.name]));
    const shots = [];
    for (const u of list) { const [ws, we] = T.dayWindow(day, calc.dayTz(u, day)); shots.push(...latest.all(u.id, T.iso(ws), T.iso(we))); }
    // the newest one from each person first, so the preview shows more than one face
    shots.sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
    const seen = new Set(), first = shots.filter((s) => !seen.has(s.user_id) && seen.add(s.user_id));
    // the owner's dashboard shows who needs attention right now (in place of the boost card)
    if (user.role === 'owner' && ctx.attentionNow) { try { const ids = new Set(list.map((u) => u.id)); d.attention = ctx.attentionNow(user, day).filter((a) => ids.has(a.id)); } catch (e) { console.error('attention', e); d.attention = null; } }
    d.recent_shots = [...first, ...shots.filter((s) => !first.includes(s))].slice(0, 4).sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1)).map((s) => ({ id: s.id, user_id: s.user_id, user_name: names.get(s.user_id), taken_at: s.taken_at, privacy: s.privacy || null }));
    return d;
  });

  route('GET', '/api/dashboard/me', ({ user, query }) => calc.myDashboard(user, dayParam(query, calc.todayOf(user))));

  const grid = ({ user, query }) => {
    const { from, to } = rangeParams(query);
    return calc.grid(members(user, query), from, to);
  };
  route('GET', '/api/timesheets', grid);
  route('GET', '/api/attendance', grid);

  route('GET', '/api/reports', ({ user, query }) => {
    const { from, to } = rangeParams(query);
    const group = ['member', 'project', 'day'].includes(query.get('group')) ? query.get('group') : 'member';
    const list = members(user, query);
    need(isManager(user) || list.every((u) => u.id === user.id), 403, 'Not allowed');
    return { from, to, group, rows: calc.report(list, from, to, group) };
  });

  const csvCell = require('../lib/csv').cell;
  const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const hours = (s) => (s / 3600).toFixed(2);
  const hm = (iso, tz) => { if (!iso) return ''; const m = T.localMinOfDay(Date.parse(iso), tz); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

  route('GET', '/api/reports/export.csv', ({ user, query }) => {
    const { from, to } = rangeParams(query);
    const g = calc.grid(members(user, query), from, to);
    const rows = [['Date', 'Member', 'Status', 'First start', 'Last stop', 'Worked (h)', 'Breaks (min)', 'Idle (min)', 'Activity %', 'Screenshots', 'Late by (min)']];
    for (const r of g.rows) {
      for (const d of g.days) {
        const c = r.cells[d];
        if (!c.worked_secs && !c.break_secs && ['off', 'upcoming'].includes(c.status)) continue;
        rows.push([d, r.name, c.status, hm(c.first_in, r.tz_offset_min), hm(c.last_out, r.tz_offset_min), hours(c.worked_secs), Math.round(c.break_secs / 60), Math.round(c.idle_secs / 60), c.activity_pct ?? '', c.shots, c.late_by_min || '']);
      }
    }
    return { raw: Buffer.from(csv(rows)), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="timesheets-${from}-to-${to}.csv"`, 'Cache-Control': 'no-store' } };
  });

  route('GET', '/api/audit', ({ user, query }) => {
    needManager(user);
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
    // Paged newest first: ?before=<id> returns the entries older than that one. A manager only sees
    // entries about themselves or their people, so keep reading batches until the page is full.
    const visible = (r) => user.role === 'owner' || r.actor_id === user.id || (r.target_user_id != null && ctx.canSee(user, r.target_user_id));
    const step = db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?');
    const out = [];
    let cursor = Math.max(0, Number(query.get('before')) || 0) || Number.MAX_SAFE_INTEGER;
    while (out.length < limit) {
      const batch = step.all(cursor, 500);
      for (const r of batch) { if (visible(r)) { out.push(r); if (out.length >= limit) break; } }
      if (batch.length < 500) break;
      cursor = batch[batch.length - 1].id;
    }
    return out;
  });
};
