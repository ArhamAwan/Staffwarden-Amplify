'use strict';
const { need, int } = require('../lib/http');

// Plan today: the project's manager (or their stand-in) puts the project's open tasks onto each person's
// day, in order. Nobody sees a draft: a person sees their day once it is sent, and any change after that
// tells them. A person's day can hold tasks from several projects; each manager plans only their own
// project's tasks, and sees how full the person already is from the others.
//   task_plans: one row per task per day (the person it is planned for, and its place in their day)
//   plan_sends: when a project's day was sent
const OPEN = ['todo', 'in_progress'];
const AHEAD = 14;   // days ahead a day can be planned

module.exports = (ctx) => {
  const { db, route, emit, audit, nowIso, clockNow, T, calc, getProject, projectVisible, canRunProject, isProjectMember, onLeave } = ctx;
  const N = () => ctx.notify;

  const companyDay = () => calc.companyToday();
  const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null : null);
  const keyOf = (p, t) => (p && t.number ? `${p.key}-${t.number}` : null);
  const sentOf = (pid, day) => db.prepare('SELECT s.sent_at, u.name AS by FROM plan_sends s LEFT JOIN users u ON u.id = s.sent_by WHERE s.project_id = ? AND s.day = ?').get(pid, day) || null;
  const hoursText = (min) => { if (min == null) return null; const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`; };

  function loadRunnable(user, id) {
    const p = getProject(id);
    need(p && projectVisible(user, p), 404, 'Project not found');
    need(canRunProject(user, p), 403, 'Only the project manager or their stand-in plans the day');
    return p;
  }
  function readDay(v, { edit = false } = {}) {
    const today = companyDay();
    const day = v == null || v === '' ? today : String(v);
    need(T.isDay(day), 400, 'day must be YYYY-MM-DD');
    if (edit) {
      need(day >= today, 400, 'That day has gone by. Plan today or a day ahead.');
      need(day <= T.addDays(today, AHEAD), 400, `Days can be planned up to ${AHEAD} days ahead`);
    } else need(day >= T.addDays(today, -60) && day <= T.addDays(today, AHEAD), 400, 'Pick a day within the last two months or the next two weeks');
    return day;
  }

  // what a person's day looks like: working, on leave, a holiday or a day off; their hours; how much time
  // the day has; and, today, how long until their shift starts
  function dayOf(u, day) {
    const holiday = db.prepare('SELECT name FROM holidays WHERE day = ?').get(day);
    const work = calc.workDaySet(u).has(T.dow(day));
    const status = onLeave(u.id, day) ? 'leave' : holiday ? 'holiday' : !work ? 'off' : 'work';
    const h = calc.hoursOn(u, day);
    const out = { status, holiday: holiday ? holiday.name : null, shift_start: h.shift_start, shift_end: h.shift_end, capacity_min: status === 'work' ? calc.dailyTargetMin(u, day) : 0, starts_in_min: null, shift_over: false };
    if (day === calc.todayOf(u) && status === 'work') {
      const now = clockNow(), tz = calc.dayTz(u, day);
      const nm = T.localMinOfDay(now, tz), rs = calc.relMin(u, calc.shiftStartMin(u, day));
      const len = ((calc.shiftEndMin(u, day) - calc.shiftStartMin(u, day) + 1440) % 1440) || 1440;
      if (nm < rs) out.starts_in_min = rs - nm;
      else if (nm >= rs + len) out.shift_over = true;
    }
    return out;
  }

  function taskOut(t, projects) {
    const p = projects.get(t.project_id);
    return { id: t.id, key: keyOf(p, t), title: t.title, status: t.status, priority: t.priority, due_day: t.due_day, estimate_min: t.estimate_min, assignee_id: t.assignee_id, assignee: nameOf(t.assignee_id),
      project_id: t.project_id, project_key: p ? p.key : null, project_color: p ? p.color : null, review_rounds: t.review_rounds };
  }
  const projectMap = () => new Map(db.prepare('SELECT id, key, name, color FROM projects').all().map((p) => [p.id, p]));

  // the whole board for one project and day
  function board(user, p, day) {
    const projects = projectMap();
    const members = db.prepare(`SELECT u.* FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.active = 1 ORDER BY u.name`).all(p.id);
    // the team first, the stand-in after them, the manager last (they plan rather than get planned)
    const rank = (u) => (u.id === p.lead_id ? 2 : u.id === p.deputy_id ? 1 : 0);
    members.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const ids = members.map((u) => u.id);
    const rows = ids.length ? db.prepare(`SELECT pl.position, pl.user_id AS plan_user, pl.project_id AS plan_project, t.* FROM task_plans pl JOIN tasks t ON t.id = pl.task_id
      WHERE pl.day = ? AND pl.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY pl.position, t.id`).all(day, ...ids) : [];
    const sentDays = new Set(db.prepare('SELECT project_id FROM plan_sends WHERE day = ?').all(day).map((r) => r.project_id));
    const people = members.map((u) => {
      const mine = rows.filter((r) => r.plan_user === u.id);
      const d = dayOf(u, day);
      const tasks = mine.map((r) => {
        const o = { ...taskOut(r, projects), here: r.project_id === p.id, sent: sentDays.has(r.project_id) };
        // another project this planner can't open: only that it takes time, never what it is
        if (!o.here && !projectVisible(user, getProject(r.project_id))) Object.assign(o, { title: null, key: null, project_key: null, project_color: null, due_day: null, hidden: true });
        return o;
      });
      // others' drafts are not this manager's business: only another project's sent plan shows
      const visible = tasks.filter((t) => t.here || t.sent);
      // what is still to do: work done or waiting for review no longer fills the day
      const planned = visible.filter((t) => OPEN.includes(t.status)).reduce((n, t) => n + (t.estimate_min || 0), 0);
      return { user_id: u.id, name: u.name, title: u.title || null, role: u.id === p.lead_id ? 'manager' : u.id === p.deputy_id ? 'stand-in' : 'member', ...d,
        planned_min: planned, no_estimate: visible.filter((t) => t.here && t.estimate_min == null && !['done', 'in_review'].includes(t.status)).length,
        tasks: visible.map(({ sent, ...t }) => t) };
    });
    const plannedIds = new Set(rows.map((r) => r.id));
    const PR = { urgent: 0, high: 1, normal: 2, low: 3 };
    const backlog = db.prepare(`SELECT * FROM tasks WHERE project_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`).all(p.id, ...OPEN)
      .filter((t) => !plannedIds.has(t.id))
      .sort((a, b) => (PR[a.priority] ?? 2) - (PR[b.priority] ?? 2) || (a.due_day || '9999').localeCompare(b.due_day || '9999') || (a.number || 0) - (b.number || 0))
      .map((t) => taskOut(t, projects));
    // the latest earlier day this project planned, for "Same as last time"
    const prev = db.prepare('SELECT MAX(day) d FROM task_plans WHERE project_id = ? AND day < ?').get(p.id, day).d;
    const today = companyDay();
    return {
      project: { id: p.id, key: p.key, name: p.name, color: p.color, lead_id: p.lead_id, deputy_id: p.deputy_id },
      day, today, editable: day >= today && day <= T.addDays(today, AHEAD), sent: sentOf(p.id, day), prev_day: prev || null,
      people, backlog,
    };
  }

  // tell someone their sent day changed
  function tellChange(uid, p, day, user, text, t) {
    if (!sentOf(p.id, day) || day < companyDay()) return;
    const when = day === companyDay() ? 'your day' : `your day on ${T.human(day)}`;
    N().notify(uid, { kind: 'task_plan', title: `${user.name} ${text.replace('{day}', when)}`, body: t ? `${keyOf(p, t) || ''} ${t.title}`.trim() : null, link: '#/tasks?view=day', actor: user });
    emit('tasks', uid);
  }

  // a task leaves the days of the person it was planned for (reassigned, or they left the project)
  ctx.planReassigned = (t, oldUid, user) => {
    if (!oldUid) return;
    const p = t.project_id ? getProject(t.project_id) : null;
    const days = db.prepare('SELECT day FROM task_plans WHERE task_id = ? AND user_id = ? AND day >= ?').all(t.id, oldUid, companyDay()).map((r) => r.day);
    db.prepare('DELETE FROM task_plans WHERE task_id = ? AND user_id = ? AND day >= ?').run(t.id, oldUid, companyDay());
    if (p) for (const d of days) tellChange(oldUid, p, d, user, 'moved a task off {day}', t);
  };

  route('GET', '/api/projects/:id/plan', ({ user, params, query }) => {
    const p = loadRunnable(user, params.id);
    return board(user, p, readDay(query.get('day')));
  });

  // put a task on someone's day (and give it to them), or move it to another place in their day
  route('POST', '/api/projects/:id/plan', ({ user, params, body }) => {
    const p = loadRunnable(user, params.id);
    const day = readDay(body.day, { edit: true });
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(body.task_id));
    need(t && t.project_id === p.id, 404, 'That task is not in this project');
    need(OPEN.includes(t.status), 409, t.status === 'done' ? 'That task is done' : 'That task is waiting for review');
    const uid = int(Number(body.user_id), 'user_id', 1, 1e9);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    need(u && u.active, 404, 'Person not found');
    need(isProjectMember(p.id, uid), 403, `Add ${u.name} to the project team first`);
    need(!onLeave(uid, day), 409, `${u.name} is on leave ${day === companyDay() ? 'today' : 'that day'}`);
    const before = db.prepare('SELECT * FROM task_plans WHERE task_id = ? AND day = ?').get(t.id, day);
    // its place: before another task in that person's day, or last
    let pos;
    const list = db.prepare('SELECT task_id, position FROM task_plans WHERE user_id = ? AND day = ? AND task_id != ? ORDER BY position, task_id').all(uid, day, t.id);
    const at = body.before_task_id != null ? list.findIndex((r) => r.task_id === Number(body.before_task_id)) : -1;
    if (at === -1) pos = list.length ? list[list.length - 1].position + 1 : 1;
    else pos = at === 0 ? list[0].position - 1 : (list[at - 1].position + list[at].position) / 2;
    const now = nowIso();
    db.prepare('INSERT INTO task_plans (task_id, day, user_id, project_id, position, planned_by, planned_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id, day) DO UPDATE SET user_id = excluded.user_id, position = excluded.position, planned_by = excluded.planned_by, planned_at = excluded.planned_at')
      .run(t.id, day, uid, p.id, pos, user.id, now);
    // planning it for someone gives it to them
    if (t.assignee_id !== uid) {
      const old = t.assignee_id;
      db.prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?').run(uid, now, t.id);
      db.prepare('INSERT INTO task_events (task_id, at, user_id, kind, detail) VALUES (?,?,?,?,?)').run(t.id, now, user.id, 'assigned', `To ${u.name}`);
      if (old) {   // their other planned days go with the task
        const days = db.prepare('SELECT day FROM task_plans WHERE task_id = ? AND user_id = ? AND day >= ? AND day != ?').all(t.id, old, companyDay(), day).map((r) => r.day);
        db.prepare('DELETE FROM task_plans WHERE task_id = ? AND user_id = ? AND day >= ?').run(t.id, old, companyDay());
        for (const d of days) tellChange(old, p, d, user, 'moved a task off {day}', t);
        emit('tasks', old);
      }
      // the person hears it with their day; once the day is sent, straight away
      if (!sentOf(p.id, day)) {
        if (day !== companyDay()) N().notify(uid, { kind: 'task_assigned', title: `${user.name} assigned you ${keyOf(p, t) || ''} ${t.title}`.replace(/\s+/g, ' '), body: t.due_day ? `Due ${T.human(t.due_day)}` : null, link: `#/tasks?task=${t.id}`, actor: user });
      }
    }
    if (before && before.user_id !== uid) tellChange(before.user_id, p, day, user, 'moved a task off {day}', t);
    if (!before || before.user_id !== uid) tellChange(uid, p, day, user, 'added a task to {day}', t);
    emit('tasks', uid); emit('tasks');
    return board(user, p, day);
  });

  // back to "Not planned yet" (it stays with the person it is assigned to)
  route('DELETE', '/api/projects/:id/plan/:taskId', ({ user, params, query }) => {
    const p = loadRunnable(user, params.id);
    const day = readDay(query.get('day'), { edit: true });
    const row = db.prepare('SELECT pl.*, t.title, t.number FROM task_plans pl JOIN tasks t ON t.id = pl.task_id WHERE pl.task_id = ? AND pl.day = ?').get(Number(params.taskId), day);
    need(row && row.project_id === p.id, 404, 'That task is not planned for that day');
    db.prepare('DELETE FROM task_plans WHERE task_id = ? AND day = ?').run(row.task_id, day);
    tellChange(row.user_id, p, day, user, 'moved a task off {day}', { title: row.title, number: row.number });
    emit('tasks', row.user_id); emit('tasks');
    return board(user, p, day);
  });

  // the order of this project's tasks in one person's day
  route('PUT', '/api/projects/:id/plan/order', ({ user, params, body }) => {
    const p = loadRunnable(user, params.id);
    const day = readDay(body.day, { edit: true });
    const uid = int(Number(body.user_id), 'user_id', 1, 1e9);
    need(Array.isArray(body.task_ids) && body.task_ids.length <= 200, 400, 'task_ids must be a list');
    const rows = db.prepare('SELECT task_id, project_id, position FROM task_plans WHERE user_id = ? AND day = ? ORDER BY position, task_id').all(uid, day);
    const mine = new Set(rows.filter((r) => r.project_id === p.id).map((r) => r.task_id));
    const ids = body.task_ids.map(Number);
    need(ids.length === mine.size && ids.every((id) => mine.has(id)), 400, 'The list has to hold this project’s tasks in that day, each once');
    // this project's tasks take the places they had between them, in the new order; others stay put
    const slots = rows.filter((r) => mine.has(r.task_id)).map((r) => r.position);
    const up = db.prepare('UPDATE task_plans SET position = ? WHERE task_id = ? AND day = ?');
    ids.forEach((id, i) => up.run(slots[i], id, day));
    if (sentOf(p.id, day)) emit('tasks', uid);
    return board(user, p, day);
  });

  // send everyone their day
  route('POST', '/api/projects/:id/plan/send', ({ user, params, body }) => {
    const p = loadRunnable(user, params.id);
    const day = readDay(body.day, { edit: true });
    const rows = db.prepare(`SELECT pl.user_id, t.id, t.number, t.title, t.estimate_min FROM task_plans pl JOIN tasks t ON t.id = pl.task_id
      WHERE pl.project_id = ? AND pl.day = ? AND t.status IN ('todo','in_progress') AND t.assignee_id = pl.user_id ORDER BY pl.user_id, pl.position, t.id`).all(p.id, day);
    need(rows.length, 400, 'Plan at least one open task before sending');
    const again = !!sentOf(p.id, day);
    db.prepare('INSERT INTO plan_sends (project_id, day, sent_at, sent_by) VALUES (?,?,?,?) ON CONFLICT(project_id, day) DO UPDATE SET sent_at = excluded.sent_at, sent_by = excluded.sent_by').run(p.id, day, nowIso(), user.id);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.user_id)) by.set(r.user_id, []); by.get(r.user_id).push(r); }
    const when = day === companyDay() ? 'your day' : `your day on ${T.human(day)}`;
    for (const [uid, list] of by) {
      const total = list.reduce((n, t) => n + (t.estimate_min || 0), 0);
      N().notify(uid, {
        kind: 'task_plan', title: `${user.name} ${again ? 'updated' : 'planned'} ${when} on ${p.key}: ${list.length} task${list.length === 1 ? '' : 's'}${total ? `, about ${hoursText(total)}` : ''}`,
        body: list.slice(0, 5).map((t, i) => `${i + 1}. ${keyOf(p, t)} ${t.title}`).join('\n') + (list.length > 5 ? `\n…and ${list.length - 5} more` : ''),
        link: '#/tasks?view=day', actor: user, dedupe: `plan:${p.id}:${day}:${Date.now()}`,
      });
      emit('tasks', uid);
    }
    audit(user, 'plan.sent', null, `${p.key} ${day}: ${rows.length} tasks to ${by.size} people`);
    return { ...board(user, p, day), told: by.size };
  });

  // plan the day like the last one: the tasks still open go back to the same people
  route('POST', '/api/projects/:id/plan/copy', ({ user, params, body }) => {
    const p = loadRunnable(user, params.id);
    const day = readDay(body.day, { edit: true });
    const prev = db.prepare('SELECT MAX(day) d FROM task_plans WHERE project_id = ? AND day < ?').get(p.id, day).d;
    need(prev, 404, 'There is no earlier day to copy');
    const rows = db.prepare(`SELECT pl.*, t.status, t.assignee_id FROM task_plans pl JOIN tasks t ON t.id = pl.task_id WHERE pl.project_id = ? AND pl.day = ? ORDER BY pl.user_id, pl.position`).all(p.id, prev);
    let n = 0, skipped = 0;
    const added = new Map();
    const ins = db.prepare('INSERT OR IGNORE INTO task_plans (task_id, day, user_id, project_id, position, planned_by, planned_at) VALUES (?,?,?,?,?,?,?)');
    for (const r of rows) {
      if (!OPEN.includes(r.status) || r.assignee_id !== r.user_id || !isProjectMember(p.id, r.user_id) || onLeave(r.user_id, day)) { skipped++; continue; }
      const last = db.prepare('SELECT MAX(position) m FROM task_plans WHERE user_id = ? AND day = ?').get(r.user_id, day).m;
      const res = ins.run(r.task_id, day, r.user_id, p.id, (last ?? 0) + 1, user.id, nowIso());
      if (res.changes) { n++; added.set(r.user_id, (added.get(r.user_id) || 0) + 1); }
    }
    for (const [uid, k] of added) tellChange(uid, p, day, user, `added ${k} task${k === 1 ? '' : 's'} to {day}`, null);
    emit('tasks');
    return { ...board(user, p, day), copied: n, skipped, from: prev };
  });

  // my day: what my project managers sent me, across projects, in order
  route('GET', '/api/plan/me', ({ user, query }) => {
    const day = query.get('day') && T.isDay(query.get('day')) ? query.get('day') : calc.todayOf(user);
    const projects = projectMap();
    const rows = db.prepare(`SELECT pl.position, pl.planned_by, t.* FROM task_plans pl JOIN tasks t ON t.id = pl.task_id JOIN plan_sends s ON s.project_id = pl.project_id AND s.day = pl.day
      WHERE pl.user_id = ? AND pl.day = ? ORDER BY pl.position, t.id`).all(user.id, day);
    const tasks = rows.filter((t) => t.assignee_id === user.id).map((t) => ({ ...taskOut(t, projects), planned_by: nameOf(t.planned_by) }));
    return { day, ...dayOf(user, day), tasks, planned_min: tasks.reduce((n, t) => n + (t.estimate_min || 0), 0), done: tasks.filter((t) => t.status === 'done').length };
  });

  // at the start of someone's shift: their day, if it was sent and they have not had it while on shift
  ctx.planSweep = () => {
    let n = 0;
    const now = clockNow();
    for (const u of db.prepare('SELECT * FROM users WHERE active = 1').all()) {
      const day = calc.todayOf(u);
      const d = dayOf(u, day);
      if (d.status !== 'work' || d.starts_in_min != null || d.shift_over) continue;
      if (db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND dedupe = ?').get(u.id, `myday:${day}`)) continue;
      const rows = db.prepare(`SELECT t.id, t.number, t.title, t.project_id, t.status FROM task_plans pl JOIN tasks t ON t.id = pl.task_id JOIN plan_sends s ON s.project_id = pl.project_id AND s.day = pl.day
        WHERE pl.user_id = ? AND pl.day = ? AND t.assignee_id = ? AND t.status IN ('todo','in_progress') ORDER BY pl.position`).all(u.id, day, u.id);
      if (!rows.length) continue;
      // already told since the shift started (the day was sent while they were working)
      const tz = calc.dayTz(u, day), sinceStart = T.localMinOfDay(now, tz) - calc.relMin(u, calc.shiftStartMin(u, day));
      const told = db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'task_plan' AND dedupe LIKE ? AND created_at >= ?").get(u.id, `plan:%:${day}:%`, new Date(now - Math.max(0, sinceStart) * 60000).toISOString());
      if (told) continue;
      const projects = projectMap(), first = rows[0], fp = projects.get(first.project_id);
      n += N().notify(u.id, { kind: 'task_plan', title: `Your day: ${rows.length} task${rows.length === 1 ? '' : 's'}`, body: `First up: ${keyOf(fp, first) || ''} ${first.title}`.replace(/\s+/g, ' '), link: '#/tasks?view=day', dedupe: `myday:${day}` });
    }
    return n;
  };
};
