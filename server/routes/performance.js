'use strict';
const { need } = require('../lib/http');

// Performance for a period: hours worked, keyboard/mouse activity and task results (done, completion,
// on time, accuracy), per person and in total. Which apps or sites someone uses is not tracked.
module.exports = (ctx) => {
  const { db, route, isManager, visibleUsers, targetUser, calc, T } = ctx;

  function report({ user, query }) {
    const to = T.isDay(query.get('to')) ? query.get('to') : calc.todayOf(user);
    const from = T.isDay(query.get('from')) ? query.get('from') : T.addDays(to, -6);
    need(from <= to && T.daysBetween(from, to) <= 92, 400, 'Choose a period of up to three months');
    let users;
    const who = query.get('user_id');
    if (who && who !== 'all') users = [targetUser(user, who)];
    else if (isManager(user)) {
      users = visibleUsers(user, { tracking: true });
      const team = query.get('team_id');
      if (team) users = users.filter((u) => String(u.team_id) === team);
    } else users = [user];

    const range = calc.makeRange(users, from, to);
    const tasks = calc.taskMetrics(users, from, to);
    const act = db.prepare('SELECT COALESCE(SUM(tracked_secs),0) t, COALESCE(SUM(active_secs),0) a FROM activity_slots WHERE user_id = ? AND slot_start >= ? AND slot_start < ?');
    let tTotal = 0, aTotal = 0;
    const people = users.map((u) => {
      const [ws] = T.dayWindow(from, calc.dayTz(u, from)), [, we] = T.dayWindow(to, calc.dayTz(u, to));
      const a = act.get(u.id, T.iso(ws), T.iso(we));
      tTotal += a.t; aTotal += a.a;
      let worked = 0, days = 0;
      for (const d of T.eachDay(from, to)) { const w = range.get(u, d).worked_secs; worked += w; if (w > 0) days++; }
      return { user_id: u.id, name: u.name, title: u.title, worked_secs: worked, days_worked: days, activity_pct: a.t ? Math.round((100 * a.a) / a.t) : null, tasks: tasks.per.get(u.id) };
    });
    return {
      from, to,
      kpis: { worked_secs: people.reduce((n, p) => n + p.worked_secs, 0), activity_pct: tTotal ? Math.round((100 * aTotal) / tTotal) : null, tasks: tasks.total },
      people,
    };
  }
  route('GET', '/api/performance', report);
  route('GET', '/api/productivity', report);   // older name
};
