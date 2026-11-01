'use strict';
// The leaderboard: who worked the most hours this week (or month, or year), with their activity alongside.
// The owner and developers choose what it ranks by and shows (hours, activity, points from tasks and
// check-ins) and who can see it (everyone, or managers only). Everyone is told when it starts showing more.
const { need } = require('../lib/http');

const RANK = { hours: 'Hours worked', activity: 'Activity', points: 'Points' };
const COLUMNS = { hours: 'Hours', activity: 'Activity', tasks: 'Tasks done', points: 'Points' };
const DEFAULTS = { rank_by: 'hours', columns: ['hours', 'activity'], audience: 'everyone' };
// activity is only ranked once someone has worked this long in the period (a short session can read 100%)
const MIN_ACTIVITY_SECS = 2 * 3600;
const POINTS = { approved: 10, on_time: 5, checkin: 4, boost: 2 };

module.exports = (ctx) => {
  const { db, route, calc, audit, T, isManager } = ctx;
  const settings = () => {
    const s = ctx.cfg.leaderboard || {};
    const cols = Array.isArray(s.columns) ? s.columns.filter((c) => COLUMNS[c]) : DEFAULTS.columns;
    return { rank_by: RANK[s.rank_by] ? s.rank_by : DEFAULTS.rank_by, columns: cols.length ? cols : DEFAULTS.columns, audience: s.audience === 'managers' ? 'managers' : 'everyone' };
  };
  const canChange = (u) => u.kind !== 'client' && (u.role === 'owner' || !!u.is_dev);
  const canSee = (u) => u.kind !== 'client' && (settings().audience === 'everyone' || isManager(u) || !!u.is_dev);

  // the period's first and last day (in the company's days), and the one before it, for "moved up 2"
  function periodOf(period, today) {
    if (period === 'month') {
      const from = today.slice(0, 8) + '01';
      const prevTo = T.addDays(from, -1);
      return { from, to: today, prev: { from: prevTo.slice(0, 8) + '01', to: prevTo }, label: 'This month' };
    }
    if (period === 'year') return { from: today.slice(0, 5) + '01-01', to: today, prev: null, label: 'This year' };
    const from = T.mondayOf(today);
    return { from, to: today, prev: { from: T.addDays(from, -7), to: T.addDays(from, -1) }, label: 'This week', ends: T.addDays(from, 6) };
  }

  function scores(users, from, to) {
    const g = calc.grid(users, from, to);
    const tm = calc.taskMetrics(users, from, to);
    const ids = users.map((u) => u.id);
    const ph = ids.map(() => '?').join(',');
    const checkins = new Map(ids.length ? db.prepare(`SELECT user_id, COUNT(*) n FROM checkins WHERE user_id IN (${ph}) AND day >= ? AND day <= ? GROUP BY user_id`).all(...ids, from, to).map((r) => [r.user_id, r.n]) : []);
    const fromIso = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString(), toIso = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86400000).toISOString();
    const boosts = new Map(ids.length ? db.prepare(`SELECT user_id, COUNT(*) n FROM boost_answers WHERE user_id IN (${ph}) AND answer = 'boosted' AND at >= ? AND at < ? GROUP BY user_id`).all(...ids, fromIso, toIso).map((r) => [r.user_id, r.n]) : []);
    const out = new Map();
    for (const r of g.rows) {
      const t = tm.per.get(r.user_id) || {};
      const ci = checkins.get(r.user_id) || 0, bo = boosts.get(r.user_id) || 0;
      const parts = { approved: (t.approved || 0) * POINTS.approved, on_time: (t.on_time || 0) * POINTS.on_time, checkin: ci * POINTS.checkin, boost: bo * POINTS.boost };
      out.set(r.user_id, {
        hours_secs: r.totals.worked_secs, activity_pct: r.totals.worked_secs >= 60 ? r.totals.activity_pct : null,
        days_worked: Object.values(r.cells).filter((c) => c.worked_secs > 0).length,
        tasks_done: t.done || 0, on_time: t.on_time || 0, checkins: ci, boosts: bo,
        points: parts.approved + parts.on_time + parts.checkin + parts.boost, parts,
      });
    }
    return out;
  }
  // ranked by the chosen measure; for activity, people with too little time are listed after, unranked
  function rank(users, sc, by) {
    const val = (u) => { const s = sc.get(u.id); return by === 'hours' ? s.hours_secs : by === 'points' ? s.points : s.activity_pct; };
    // nobody is ranked for nothing: no time worked (or, for activity, under two hours) means not on the podium yet
    const ranked = users.filter((u) => (by === 'activity' ? sc.get(u.id).hours_secs >= MIN_ACTIVITY_SECS && sc.get(u.id).activity_pct != null : (val(u) || 0) > 0));
    ranked.sort((a, b) => (val(b) - val(a)) || (sc.get(b.id).hours_secs - sc.get(a.id).hours_secs) || a.name.localeCompare(b.name));
    const places = new Map(); let place = 0, last = null;
    ranked.forEach((u, i) => { const v = val(u); if (v !== last) { place = i + 1; last = v; } places.set(u.id, place); });
    return { ranked, places };
  }

  const cache = new Map();
  route('GET', '/api/leaderboard', ({ user, query }) => {
    need(canSee(user), 403, 'The leaderboard is for managers only');
    const s = settings();
    const period = ['week', 'month', 'year'].includes(query.get('period')) ? query.get('period') : 'week';
    const today = calc.companyToday();
    const p = periodOf(period, today);
    const users = db.prepare('SELECT * FROM users WHERE active = 1 AND tracks_time = 1 ORDER BY name').all();
    const key = `${period}|${today}|${s.rank_by}|${users.length}`;
    let hit = cache.get(key);
    if (!hit || ctx.now() - hit.at > 60000) {
      const sc = scores(users, p.from, p.to);
      const { ranked, places } = rank(users, sc, s.rank_by);
      let before = null;
      if (p.prev) { const ps = scores(users, p.prev.from, p.prev.to); before = rank(users, ps, s.rank_by).places; }
      const teams = new Map(db.prepare('SELECT id, name FROM teams').all().map((t) => [t.id, t.name]));
      const row = (u) => {
        const x = sc.get(u.id), place = places.get(u.id) || null, was = before && before.get(u.id);
        return { id: u.id, name: u.name, title: u.title || null, team: u.team_id ? teams.get(u.team_id) || null : null, team_id: u.team_id || null, place, move: place && was ? was - place : null, new_entry: !!(place && before && !was), ...x };
      };
      const rows = [...ranked.map(row), ...users.filter((u) => !places.has(u.id)).map(row)];
      // teams: the average of the ranked measure per person
      const byTeam = new Map();
      for (const r of rows) {
        if (!r.team_id) continue;
        const v = s.rank_by === 'hours' ? r.hours_secs : s.rank_by === 'points' ? r.points : r.activity_pct;
        if (v == null) continue;
        const t = byTeam.get(r.team_id) || { id: r.team_id, name: r.team, sum: 0, n: 0 };
        t.sum += v; t.n++; byTeam.set(r.team_id, t);
      }
      const teamRows = [...byTeam.values()].map((t) => ({ id: t.id, name: t.name, people: t.n, value: Math.round(t.sum / t.n) })).sort((a, b) => b.value - a.value);
      hit = { at: ctx.now(), rows, teams: teamRows };
      cache.set(key, hit);
      if (cache.size > 30) cache.delete(cache.keys().next().value);
    }
    const notTracked = canChange(user) ? db.prepare("SELECT name FROM users WHERE active = 1 AND tracks_time = 0 AND role != 'owner' ORDER BY name").all().map((r) => r.name) : [];
    return { not_tracked: notTracked, settings: s, can_change: canChange(user), period, label: p.label, from: p.from, to: p.to, ends: p.ends || null, today, rows: hit.rows, teams: hit.teams, me: user.id, min_activity_secs: MIN_ACTIVITY_SECS, points: POINTS };
  });

  route('PUT', '/api/leaderboard/settings', ({ user, body }) => {
    need(canChange(user), 403, 'Only the owner and developers change the leaderboard');
    const old = settings();
    const next = { ...old };
    if ('rank_by' in body) { need(RANK[body.rank_by], 400, 'rank_by must be hours, activity or points'); next.rank_by = body.rank_by; }
    if ('columns' in body) {
      need(Array.isArray(body.columns) && body.columns.length && body.columns.every((c) => COLUMNS[c]), 400, 'Choose at least one thing to show');
      next.columns = Object.keys(COLUMNS).filter((c) => body.columns.includes(c));
    }
    if ('audience' in body) { need(['everyone', 'managers'].includes(body.audience), 400, 'audience must be everyone or managers'); next.audience = body.audience; }
    // what it ranks by is always shown
    if (!next.columns.includes(next.rank_by)) next.columns = Object.keys(COLUMNS).filter((c) => c === next.rank_by || next.columns.includes(c));
    ctx.saveSetting('leaderboard', next);
    cache.clear();
    audit(user, 'leaderboard.settings', null, `Ranks by ${RANK[next.rank_by].toLowerCase()}; shows ${next.columns.map((c) => COLUMNS[c].toLowerCase()).join(', ')}; ${next.audience === 'everyone' ? 'everyone sees it' : 'managers only'}`);
    // everyone who can see it is told when it starts showing something about them it didn't before
    const shownTo = (st) => (st.audience === 'everyone' ? new Set(st.columns) : new Set());
    const before = shownTo(old), after = shownTo(next);
    const added = [...after].filter((c) => !before.has(c));
    if (added.length) {
      const ids = db.prepare('SELECT id FROM users WHERE active = 1 AND tracks_time = 1').all().map((r) => r.id);
      ctx.notify.notify(ids, { kind: 'changed', title: 'The leaderboard shows more now', body: `Everyone can now see each person’s ${added.map((c) => COLUMNS[c].toLowerCase()).join(' and ')} on the leaderboard. By ${user.name}.`, link: '#/leaderboard', actor: user, dedupe: `lb:${ctx.nowIso()}` });
    }
    ctx.emitAll && ctx.emitAll('leaderboard');
    return settings();
  });
  ctx.leaderboardSettings = settings;
};
