'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, str, optStr, int } = require('../lib/http');

// Task management. People see the tasks assigned to them or created by them; managers also see every task
// of the people they manage (and unassigned ones). The flow is
//   To do -> In progress -> In review -> Done
// and a task sent back from review counts against first-time accuracy. Recurring tasks create their next
// copy when they are done.
const STATUSES = ['todo', 'in_progress', 'in_review', 'done'];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const RECUR = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
const MAX_FILE = 5 * 1024 * 1024;

module.exports = (ctx) => {
  const { db, cfg, route, emit, audit, isManager, canSee, calc, nowIso, clockNow, T, projectVisible, isProjectLead, ensureProjectMember, nextTaskNumber, getProject } = ctx;
  const fileDir = path.join(cfg.dataDir, 'files');
  fs.mkdirSync(fileDir, { recursive: true });

  const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null : null);
  const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  const event = (taskId, userId, kind, detail = null) => db.prepare('INSERT INTO task_events (task_id, at, user_id, kind, detail) VALUES (?,?,?,?,?)').run(taskId, nowIso(), userId, kind, detail);
  const notify = (t, { teamOnly = false } = {}) => {
    emit('tasks', t.assignee_id || null); if (t.created_by && t.created_by !== t.assignee_id) emit('tasks', t.created_by);
    const p = t.project_id ? getProject(t.project_id) : null;
    if (!p || !p.client_id || !ctx.emitPortal) return;
    // the client's board follows along, but only for tasks they see (and a task just hidden from them)
    const cur = getTask(t.id) || t;
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
    const s = c && ctx.clientSettings(c), seen = s && (ctx.portalTaskVisible(cur, s) || ctx.portalTaskVisible(t, s));
    ctx.emitPortal(p, 'portal_task', { task_id: t.id }, teamOnly || !seen ? { staffOnly: true } : null);
  };

  // Everyone in a project sees all of its tasks (as in Jira and ClickUp); personal tasks stay with their
  // assignee, their creator and the assignee's managers.
  function canSeeTask(user, t) {
    if (!t) return false;
    if (t.assignee_id === user.id || t.created_by === user.id) return true;
    if (t.project_id != null && projectVisible(user, getProject(t.project_id))) return true;
    if (!isManager(user)) return false;
    return t.assignee_id == null || canSee(user, t.assignee_id);
  }
  const leads = (user, t) => t.project_id != null && isProjectLead(getProject(t.project_id), user);
  const manages = (user, t) => (isManager(user) && (t.assignee_id == null || t.assignee_id === user.id || canSee(user, t.assignee_id) || t.created_by === user.id || t.project_id != null)) || leads(user, t);
  // ---------- notifications ----------
  const N = ctx.notify;
  const label = (t) => { const p = t.project_id ? getProject(t.project_id) : null; return p && t.number ? `${p.key}-${t.number} ${t.title}` : t.title; };
  const link = (t) => `#/tasks?task=${t.id}`;
  // who approves this task: the project lead and the managers of the person doing it
  const reviewersOf = (t) => { const p = t.project_id ? getProject(t.project_id) : null; return [p && p.lead_id, ...ctx.managersOf(t.assignee_id || t.created_by)]; };
  const watchersOf = (t) => [t.assignee_id, t.created_by, ...db.prepare('SELECT DISTINCT user_id FROM task_comments WHERE task_id = ?').all(t.id).map((r) => r.user_id)];
  const tell = (to, kind, t, user, title, body = null) => N.notify(to, { kind, title, body, link: link(t), actor: user });
  function tellStatus(before, after, user, note) {
    const who = user.name, L = label(after);
    if (after.status === 'in_review') tell(reviewersOf(after), 'task_review', after, user, `${who} sent ${L} for review`, 'Approve it, or send it back with a note.');
    else if (after.status === 'done' && before.status === 'in_review') tell(after.assignee_id, 'task_approved', after, user, `${who} approved ${L}`, after.review_rounds ? null : 'Approved first time.');
    else if (before.status === 'in_review' && after.review_rounds > before.review_rounds) tell(after.assignee_id, 'task_sent_back', after, user, `${who} sent ${L} back`, note || 'See the comments for what to change.');
    else if (after.assignee_id !== user.id) tell(after.assignee_id, 'task_status', after, user, `${who} moved ${L} to ${({ todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' })[after.status]}`);
    else if (after.status === 'done' && after.created_by !== user.id) tell(after.created_by, 'task_status', after, user, `${who} finished ${L}`);
  }
  const tellProject = (pid, uid, user) => { const p = getProject(pid); if (p) N.notify(uid, { kind: 'project_added', title: `${user.name} added you to ${p.key} ${p.name}`, body: 'You can now see its tasks and track time on it.', link: `#/project?id=${p.id}`, actor: user }); };

  const loadVisible = (user, id) => { const t = getTask(id); need(t && canSeeTask(user, t), 404, 'Task not found'); return t; };

  // Worked seconds on each task (time entries minus their pauses).
  function trackedByTask(ids) {
    const out = new Map(ids.map((i) => [i, 0]));
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const entries = db.prepare(`SELECT id, task_id, started_at, ended_at FROM time_entries WHERE task_id IN (${ph})`).all(...ids);
    if (!entries.length) return out;
    const pauses = db.prepare(`SELECT entry_id, started_at, ended_at FROM pauses WHERE entry_id IN (${entries.map(() => '?').join(',')})`).all(...entries.map((e) => e.id));
    const now = clockNow();
    for (const e of entries) {
      const s = Date.parse(e.started_at), en = e.ended_at ? Date.parse(e.ended_at) : now;
      let ms = Math.max(0, en - s);
      for (const p of pauses) if (p.entry_id === e.id) ms -= Math.max(0, Math.min(en, p.ended_at ? Date.parse(p.ended_at) : now) - Math.max(s, Date.parse(p.started_at)));
      out.set(e.task_id, out.get(e.task_id) + Math.max(0, ms));
    }
    for (const [k, v] of out) out.set(k, Math.round(v / 1000));
    return out;
  }

  function todayFor(userId) {
    const u = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
    return T.localDay(clockNow(), u ? calc.dayTz(u) : calc.companyDayTz());
  }

  function shape(rows) {
    const ids = rows.map((r) => r.id);
    const tracked = trackedByTask(ids);
    const counts = (table) => {
      if (!ids.length) return new Map();
      return new Map(db.prepare(`SELECT task_id, COUNT(*) n FROM ${table} WHERE task_id IN (${ids.map(() => '?').join(',')}) GROUP BY task_id`).all(...ids).map((r) => [r.task_id, r.n]));
    };
    const comments = counts('task_comments'), files = counts('task_files');
    const steps = ids.length ? new Map(db.prepare(`SELECT task_id, COUNT(*) n, SUM(done_at IS NOT NULL) d FROM task_steps WHERE task_id IN (${ids.map(() => '?').join(',')}) GROUP BY task_id`).all(...ids).map((r) => [r.task_id, { total: r.n, done: r.d }])) : new Map();
    const projects = new Map(db.prepare('SELECT p.id, p.name, p.key, p.color, p.client_id, c.name AS client_name, c.settings AS client_settings FROM projects p LEFT JOIN clients c ON c.id = p.client_id').all().map((p) => [p.id, p]));
    const todays = new Map();
    // for a client's project: whether the client sees this task (their setting, or the task's own choice)
    const clientSees = (t) => { const p = t.project_id && projects.get(t.project_id); if (!p || !p.client_id) return null; return ctx.portalTaskVisible(t, ctx.clientSettings({ settings: p.client_settings })); };
    return rows.map((t) => {
      if (!todays.has(t.assignee_id)) todays.set(t.assignee_id, todayFor(t.assignee_id));
      const today = todays.get(t.assignee_id);
      return {
        id: t.id, key: t.project_id && projects.get(t.project_id) && t.number ? `${projects.get(t.project_id).key}-${t.number}` : null, number: t.number || null,
        title: t.title, description: t.description || '', project_id: t.project_id, project: t.project_id ? (projects.get(t.project_id) || {}).name || null : null,
        project_color: t.project_id ? (projects.get(t.project_id) || {}).color || null : null,
        assignee_id: t.assignee_id, assignee: nameOf(t.assignee_id), created_by: t.created_by, creator: nameOf(t.created_by),
        status: t.status, priority: t.priority, due_day: t.due_day, estimate_min: t.estimate_min, recurrence: t.recurrence, position: t.position,
        review_rounds: t.review_rounds, submitted_at: t.submitted_at, completed_at: t.completed_at, first_time: t.first_time == null ? null : !!t.first_time,
        created_at: t.created_at, updated_at: t.updated_at,
        overdue: !!t.due_day && t.status !== 'done' && t.due_day < today, due_today: !!t.due_day && t.status !== 'done' && t.due_day === today,
        tracked_secs: tracked.get(t.id) || 0, comment_count: comments.get(t.id) || 0, file_count: files.get(t.id) || 0,
        client: t.project_id && projects.get(t.project_id) && projects.get(t.project_id).client_id ? projects.get(t.project_id).client_name : null,
        client_visible: t.client_visible == null ? null : t.client_visible, client_sees: clientSees(t),
        milestone_id: t.milestone_id || null, steps: steps.get(t.id) || null,
      };
    });
  }
  ctx.shapeTasks = shape;

  function readFields(body, user, existing) {
    const set = {};
    if ('title' in body) set.title = str(body.title, 'title', 200);
    if ('description' in body) set.description = optStr(body.description, 'description', 10000);
    if ('priority' in body) { need(PRIORITIES.includes(body.priority), 400, 'priority must be urgent, high, normal or low'); set.priority = body.priority; }
    if ('due_day' in body) { need(body.due_day === null || body.due_day === '' || T.isDay(body.due_day), 400, 'due_day must be YYYY-MM-DD'); set.due_day = body.due_day || null; }
    if ('estimate_min' in body) set.estimate_min = body.estimate_min === null || body.estimate_min === '' ? null : int(body.estimate_min, 'estimate_min', 0, 100000);
    if ('recurrence' in body) { need(RECUR.includes(body.recurrence), 400, 'recurrence must be none, daily, weekdays, weekly or monthly'); set.recurrence = body.recurrence; }
    if ('position' in body) { need(typeof body.position === 'number' && Number.isFinite(body.position), 400, 'position must be a number'); set.position = body.position; }
    // on a client's project: share this task with them, keep it to the team, or follow the client's setting
    if ('client_visible' in body) { need([null, 0, 1, true, false].includes(body.client_visible), 400, 'client_visible must be null, 0 or 1'); set.client_visible = body.client_visible == null ? null : body.client_visible ? 1 : 0; }
    if ('milestone_id' in body) set.milestone_id = body.milestone_id === null || body.milestone_id === '' ? null : int(Number(body.milestone_id), 'milestone_id', 1, 1e9);
    if ('project_id' in body) {
      if (body.project_id === null || body.project_id === '') set.project_id = null;
      else {
        const pid = int(Number(body.project_id), 'project_id', 1, 1e9);
        need(projectVisible(user, getProject(pid)), 404, 'Project not found');
        set.project_id = pid;
      }
    }
    // the project the task will be in after this change
    const pid = 'project_id' in set ? set.project_id : existing ? existing.project_id : null;
    const lead = pid != null && isProjectLead(getProject(pid), user);
    if (set.milestone_id) need(pid != null && db.prepare('SELECT 1 FROM milestones WHERE id = ? AND project_id = ?').get(set.milestone_id, pid), 400, 'That milestone is not on this project');
    if ('project_id' in set && existing && set.project_id !== existing.project_id && !('milestone_id' in set)) set.milestone_id = null;
    if ('assignee_id' in body) {
      if (body.assignee_id === null || body.assignee_id === '') {
        need(isManager(user) || pid != null, 403, 'Only managers can leave a personal task unassigned');   // an open task in a project anyone in it can pick up
        set.assignee_id = null;
      } else {
        const aid = int(Number(body.assignee_id), 'assignee_id', 1, 1e9);
        const a = db.prepare('SELECT id, active FROM users WHERE id = ?').get(aid);
        need(a && a.active, 404, 'Person not found');
        need(aid === user.id || (isManager(user) && canSee(user, aid)) || (lead && ctx.isProjectMember(pid, aid)),
          403, lead ? 'Add this person to the project first' : 'You can only assign tasks to yourself, to people you manage, or (as project lead) to project members');
        set.assignee_id = aid;
      }
    }
    return set;
  }

  // Next copy of a recurring task, due one period after this one.
  function nextDue(day, rec) {
    const base = day || todayFor(null);
    if (rec === 'daily') return T.addDays(base, 1);
    if (rec === 'weekly') return T.addDays(base, 7);
    if (rec === 'weekdays') { let d = T.addDays(base, 1); while ([0, 6].includes(T.dow(d))) d = T.addDays(d, 1); return d; }
    if (rec === 'monthly') {
      const [y, m, dd] = base.split('-').map(Number);
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return new Date(Date.UTC(y, m, Math.min(dd, last))).toISOString().slice(0, 10);
    }
    return null;
  }
  function spawnNext(t, actorId) {
    if (!t.recurrence || t.recurrence === 'none') return null;
    if (db.prepare('SELECT 1 FROM tasks WHERE recurred_from = ?').get(t.id)) return null; // already made
    const due = nextDue(t.due_day, t.recurrence);
    const id = Number(db.prepare(`INSERT INTO tasks (title, description, project_id, number, assignee_id, created_by, priority, due_day, estimate_min, recurrence, recurred_from, position, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(t.title, t.description, t.project_id, t.project_id ? nextTaskNumber(t.project_id) : null, t.assignee_id, t.created_by, t.priority, due, t.estimate_min, t.recurrence, t.id, t.position, nowIso()).lastInsertRowid);
    event(id, actorId, 'created', `Repeats ${t.recurrence}; next copy of #${t.id}`);
    return id;
  }

  // The one place status changes happen, so the review rules and accuracy are always applied the same way.
  function changeStatus(t, to, user, note = null) {
    need(STATUSES.includes(to), 400, 'Unknown status');
    if (t.status === to) return t;
    const mgr = manages(user, t);
    const mine = t.assignee_id === user.id || (t.assignee_id == null && t.created_by === user.id);
    need(mgr || mine, 403, 'Not allowed');
    const now = nowIso();
    const sets = { status: to, updated_at: now };
    if (to === 'done') {
      // A person can close their own personal to-dos; assigned work goes through review (unless the owner turned review off).
      const personal = t.created_by === user.id && (t.assignee_id === user.id || t.assignee_id == null);
      if (!mgr) need(personal || cfg.taskReviewRequired === false, 403, 'Send it for review. A manager marks it done.');
      sets.completed_at = now;
      sets.first_time = t.review_rounds === 0 ? 1 : 0;
      sets.approved_by = mgr ? user.id : null;
      event(t.id, user.id, t.status === 'in_review' ? 'approved' : 'completed', t.review_rounds ? `After ${t.review_rounds} round${t.review_rounds === 1 ? '' : 's'} of changes` : 'First time');
    } else {
      if (t.status === 'done') { sets.completed_at = null; sets.first_time = null; sets.approved_by = null; event(t.id, user.id, 'reopened'); }
      if (t.status === 'in_review' && t.assignee_id !== user.id) {          // a reviewer sends it back for changes
        sets.review_rounds = t.review_rounds + 1;
        event(t.id, user.id, 'sent_back', note);
        if (note) db.prepare('INSERT INTO task_comments (task_id, user_id, body, team_only, created_at) VALUES (?,?,?,1,?)').run(t.id, user.id, `Sent back: ${note}`, now);   // review notes stay with the team
      } else if (t.status === 'in_review') event(t.id, user.id, 'withdrawn', note);
      else if (to === 'in_review') { sets.submitted_at = now; event(t.id, user.id, 'submitted', note); }
      else event(t.id, user.id, 'status', `${t.status} -> ${to}`);
    }
    const keys = Object.keys(sets);
    db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => sets[k]), t.id);
    const after = getTask(t.id);
    if (to === 'done') spawnNext(after, user.id);
    tellStatus(t, after, user, note);
    return after;
  }
  ctx.changeTaskStatus = changeStatus;

  // ---------- list ----------
  route('GET', '/api/tasks', ({ user, query }) => {
    const who = query.get('assignee') || (isManager(user) ? 'all' : 'me');
    const where = [], args = [];
    if (who === 'me') { where.push('(t.assignee_id = ? OR (t.assignee_id IS NULL AND t.created_by = ?))'); args.push(user.id, user.id); }
    else if (who === 'unassigned') where.push('t.assignee_id IS NULL');
    else if (who !== 'all') { const id = Number(who); need(id === user.id || (isManager(user) && canSee(user, id)), 403, 'Not allowed'); where.push('t.assignee_id = ?'); args.push(id); }
    const status = query.get('status');
    if (status) { const list = status.split(',').filter((s) => STATUSES.includes(s)); if (list.length) { where.push(`t.status IN (${list.map(() => '?').join(',')})`); args.push(...list); } }
    const project = query.get('project');
    if (project === 'none') where.push('t.project_id IS NULL'); else if (project) { where.push('t.project_id = ?'); args.push(Number(project)); }
    const q = (query.get('q') || '').trim();
    if (q) {
      where.push("(t.title LIKE ? OR t.description LIKE ? OR ((SELECT key FROM projects WHERE id = t.project_id) || '-' || t.number) = ?)");
      args.push(`%${q}%`, `%${q}%`, q.toUpperCase());
    }
    // finished tasks are only listed for a while, so boards stay readable
    const doneDays = Math.max(1, Math.min(365, Number(query.get('done_days')) || 14));
    where.push("(t.status != 'done' OR t.completed_at >= ?)"); args.push(T.iso(clockNow() - doneDays * 86400000));
    const rows = db.prepare(`SELECT t.* FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.position, t.id`).all(...args)
      .filter((t) => canSeeTask(user, t));
    let out = shape(rows).map((t, i) => ({ ...t, can_manage: manages(user, rows[i]) }));
    const due = query.get('due');
    if (due === 'overdue') out = out.filter((t) => t.overdue);
    else if (due === 'today') out = out.filter((t) => t.due_today || t.overdue);
    else if (due === 'week') { const end = T.addDays(todayFor(user.id), 7); out = out.filter((t) => t.status !== 'done' && t.due_day && t.due_day <= end); }
    else if (due === 'none') out = out.filter((t) => !t.due_day);
    return out;
  });

  // Counts for badges, the desktop app and dashboards.
  route('GET', '/api/tasks/summary', ({ user }) => {
    const mine = shape(db.prepare("SELECT * FROM tasks WHERE status != 'done' AND (assignee_id = ? OR (assignee_id IS NULL AND created_by = ?))").all(user.id, user.id));
    const out = {
      open: mine.length, overdue: mine.filter((t) => t.overdue).length, due_today: mine.filter((t) => t.due_today).length,
      in_review: mine.filter((t) => t.status === 'in_review').length,
      next: mine.filter((t) => t.status !== 'in_review').sort((a, b) => (a.due_day || '9999').localeCompare(b.due_day || '9999') || PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)).slice(0, 8),
    };
    const rev = db.prepare("SELECT * FROM tasks WHERE status = 'in_review'").all().filter((t) => manages(user, t) && t.assignee_id !== user.id);
    if (isManager(user) || rev.length) out.to_review = rev.length;
    if (isManager(user)) {
      const team = db.prepare("SELECT * FROM tasks WHERE status != 'done' AND due_day IS NOT NULL").all().filter((t) => manages(user, t));
      out.team_overdue = shape(team).filter((t) => t.overdue).length;
    }
    return out;
  });

  // ---------- one task ----------
  route('GET', '/api/tasks/:id', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    const [one] = shape([t]);
    return {
      ...one,
      can_manage: manages(user, t), is_mine: t.assignee_id === user.id,
      comments: db.prepare('SELECT c.id, c.user_id, COALESCE(u.name, cu.name) AS user, c.client_user_id, c.team_only, c.body, c.created_at, c.file, c.file_name, c.file_type, c.file_size FROM task_comments c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN client_users cu ON cu.id = c.client_user_id WHERE c.task_id = ? ORDER BY c.created_at, c.id').all(t.id)
        .map(({ file, file_name, file_type, file_size, ...c }) => ({ ...c, team_only: !!c.team_only, from_client: !!c.client_user_id, file: file ? { name: file_name, type: file_type, size: file_size, url: `/api/portal/comment-files/${c.id}` } : null })),
      steps_list: db.prepare('SELECT id, title, done_at FROM task_steps WHERE task_id = ? ORDER BY position, id').all(t.id).map((x) => ({ id: x.id, title: x.title, done: !!x.done_at })),
      milestones: t.project_id ? db.prepare('SELECT id, title, done_at FROM milestones WHERE project_id = ? ORDER BY position, id').all(t.project_id) : [],
      files: db.prepare('SELECT f.id, f.name, f.mime, f.size, f.created_at, f.user_id, u.name AS user FROM task_files f LEFT JOIN users u ON u.id = f.user_id WHERE f.task_id = ? ORDER BY f.id').all(t.id),
      events: db.prepare('SELECT e.kind, e.at, e.detail, u.name AS user FROM task_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ? ORDER BY e.at, e.id').all(t.id),
      sessions: db.prepare('SELECT COUNT(*) n FROM time_entries WHERE task_id = ?').get(t.id).n,
    };
  });

  route('POST', '/api/tasks', ({ user, body }) => createTask(user, body));
  // also used to make a task from a chat message
  ctx.createTask = createTask;
  function createTask(user, body, extra = {}) {
    const set = readFields(body, user);
    need(set.title, 400, 'title is required');
    if (!('assignee_id' in set)) set.assignee_id = user.id;
    const now = nowIso();
    const maxPos = db.prepare("SELECT COALESCE(MAX(position), 0) p FROM tasks WHERE status = 'todo'").get().p;
    const cols = { title: set.title, description: set.description ?? null, project_id: set.project_id ?? null, number: set.project_id ? nextTaskNumber(set.project_id) : null, assignee_id: set.assignee_id, created_by: user.id,
      priority: set.priority || 'normal', due_day: set.due_day ?? null, estimate_min: set.estimate_min ?? null, recurrence: set.recurrence || 'none', position: set.position ?? maxPos + 1, created_at: now, updated_at: now, ...extra };
    const keys = Object.keys(cols);
    const id = Number(db.prepare(`INSERT INTO tasks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k])).lastInsertRowid);
    event(id, user.id, 'created', cols.assignee_id && cols.assignee_id !== user.id ? `Assigned to ${nameOf(cols.assignee_id)}` : null);
    // whoever gets a project task becomes a member of the project
    if (cols.project_id && cols.assignee_id && ensureProjectMember(cols.project_id, cols.assignee_id)) { event(id, user.id, 'member', `${nameOf(cols.assignee_id)} added to the project`); tellProject(cols.project_id, cols.assignee_id, user); }
    const t = getTask(id);
    if (t.assignee_id !== user.id) tell(t.assignee_id, 'task_assigned', t, user, `${user.name} assigned you ${label(t)}`, t.due_day ? `Due ${T.human(t.due_day)}` : null);
    notify(t);
    return shape([t])[0];
  }

  route('PATCH', '/api/tasks/:id', ({ user, params, body }) => {
    let t = loadVisible(user, params.id);
    const mgr = manages(user, t);
    const own = t.created_by === user.id && (t.assignee_id === user.id || t.assignee_id == null);
    // compatibility with the old project task list
    if ('name' in body && !('title' in body)) body.title = body.name;
    if ('done' in body && !('status' in body)) body.status = body.done ? 'done' : 'todo';
    const fields = Object.keys(body).filter((k) => !['status', 'note', 'name', 'done'].includes(k));
    if (fields.length) {
      const onlyPosition = fields.every((k) => k === 'position');
      // anyone in the project can pick up an open task by assigning it to themselves
      const pickUp = fields.length === 1 && fields[0] === 'assignee_id' && t.assignee_id == null && Number(body.assignee_id) === user.id && t.project_id != null;
      need(mgr || own || pickUp || onlyPosition && (t.assignee_id === user.id), 403, 'Only a manager, the project lead or the person who created this task can change it');
      const set = readFields(body, user, t);
      if ('project_id' in set && set.project_id !== t.project_id) set.number = set.project_id ? nextTaskNumber(set.project_id) : null;
      if (Object.keys(set).length) {
        set.updated_at = nowIso();
        const keys = Object.keys(set);
        db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), t.id);
        if ('assignee_id' in set && set.assignee_id !== t.assignee_id) event(t.id, user.id, 'assigned', set.assignee_id ? `To ${nameOf(set.assignee_id)}` : 'Unassigned');
        if ('due_day' in set && set.due_day !== t.due_day) event(t.id, user.id, 'due', set.due_day || 'No deadline');
        const after = getTask(t.id);
        if (after.project_id && after.assignee_id && ensureProjectMember(after.project_id, after.assignee_id)) { event(t.id, user.id, 'member', `${nameOf(after.assignee_id)} added to the project`); tellProject(after.project_id, after.assignee_id, user); }
        if ('assignee_id' in set && set.assignee_id && set.assignee_id !== t.assignee_id) tell(set.assignee_id, 'task_assigned', after, user, `${user.name} assigned you ${label(after)}`, after.due_day ? `Due ${T.human(after.due_day)}` : null);
        else if ('due_day' in set && set.due_day !== t.due_day) tell(after.assignee_id, 'task_due_changed', after, user, `${user.name} ${set.due_day ? `moved the deadline of ${label(after)} to ${T.human(set.due_day)}` : `removed the deadline of ${label(after)}`}`);
        const changed = keys.filter((k) => !['updated_at', 'position', 'assignee_id', 'due_day', 'number'].includes(k));
        if (changed.length) event(t.id, user.id, 'edited', changed.join(', '));
        t = getTask(t.id);
      }
    }
    if ('status' in body) t = changeStatus(t, body.status, user, body.note ? optStr(body.note, 'note', 2000) : null);
    notify(t);
    return shape([t])[0];
  });

  route('POST', '/api/tasks/:id/approve', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    need(manages(user, t) && t.assignee_id !== user.id, 403, 'Only a manager can approve');
    need(t.status === 'in_review', 409, 'This task is not waiting for review');
    const after = changeStatus(t, 'done', user);
    notify(after);
    return shape([after])[0];
  });
  route('POST', '/api/tasks/:id/send-back', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    need(manages(user, t) && t.assignee_id !== user.id, 403, 'Only a manager can send work back');
    need(t.status === 'in_review', 409, 'This task is not waiting for review');
    const note = str(body.note, 'note', 2000);
    const after = changeStatus(t, 'in_progress', user, note);
    notify(after);
    return shape([after])[0];
  });

  route('DELETE', '/api/tasks/:id', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    need(manages(user, t) || (t.created_by === user.id && t.assignee_id === user.id), 403, 'Only a manager or the person who created this task can delete it');
    for (const f of db.prepare('SELECT file FROM task_files WHERE task_id = ?').all(t.id)) { try { fs.unlinkSync(path.join(fileDir, f.file)); } catch { /* gone */ } }
    db.prepare('UPDATE time_entries SET task_id = NULL WHERE task_id = ?').run(t.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    audit(user, 'task.deleted', t.assignee_id, t.title);
    notify(t);
    return { ok: true };
  });

  // ---------- comments ----------
  route('POST', '/api/tasks/:id/comments', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const text = str(body.body, 'body', 4000);
    const teamOnly = body.team_only ? 1 : 0;
    const id = Number(db.prepare('INSERT INTO task_comments (task_id, user_id, body, team_only, created_at) VALUES (?,?,?,?,?)').run(t.id, user.id, text, teamOnly, nowIso()).lastInsertRowid);
    const p = t.project_id ? getProject(t.project_id) : null;
    void p;
    tell(watchersOf(t), 'task_comment', t, user, `${user.name} commented on ${label(t)}`, text.length > 140 ? text.slice(0, 137) + '…' : text);
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(nowIso(), t.id);
    // on a task the client sees, they hear about the team's comment (at most once an hour per task)
    const p2 = t.project_id ? getProject(t.project_id) : null;
    if (!teamOnly && p2 && p2.client_id && ctx.pnotify) {
      const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p2.client_id);
      if (c && ctx.portalTaskVisible(t, ctx.clientSettings(c))) ctx.pnotify.toProject(p2, { kind: 'task_comment', link: `#/tasks?p=${p2.id}&task=${t.id}`, title: `${user.name} commented on ${t.title}`, body: text.slice(0, 200), dedupe: `tc:${t.id}:${new Date(clockNow()).toISOString().slice(0, 13)}` });
    }
    notify(t, { teamOnly: !!teamOnly });
    return { id };
  });
  route('DELETE', '/api/tasks/:id/comments/:cid', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    const c = db.prepare('SELECT * FROM task_comments WHERE id = ? AND task_id = ?').get(Number(params.cid), t.id);
    need(c, 404, 'Comment not found');
    need(c.user_id === user.id || manages(user, t), 403, 'You can only delete your own comments');
    db.prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
    notify(t);
    return { ok: true };
  });

  // ---------- files ----------
  route('POST', '/api/tasks/:id/files', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const name = str(body.name, 'name', 200).replace(/[\\/\0]/g, '_');
    const buf = Buffer.from(str(body.data_base64, 'data_base64', ctx.MAX_BODY), 'base64');
    need(buf.length > 0, 400, 'The file is empty');
    need(buf.length <= MAX_FILE, 413, 'Files can be at most 5 MB');
    const mime = typeof body.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.mime) ? body.mime : 'application/octet-stream';
    const file = `${t.id}-${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(path.join(fileDir, file), buf);
    const id = Number(db.prepare('INSERT INTO task_files (task_id, user_id, name, mime, size, file, created_at) VALUES (?,?,?,?,?,?,?)').run(t.id, user.id, name, mime, buf.length, file, nowIso()).lastInsertRowid);
    event(t.id, user.id, 'file', name);
    tell(watchersOf(t), 'task_file', t, user, `${user.name} attached a file to ${label(t)}`, name);
    notify(t);
    return { id, name, size: buf.length };
  });
  route('GET', '/api/tasks/:id/files/:fid', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    const f = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(params.fid), t.id);
    need(f, 404, 'File not found');
    const p = path.join(fileDir, f.file);
    need(fs.existsSync(p), 404, 'File missing');
    return { raw: fs.readFileSync(p), type: f.mime || 'application/octet-stream', headers: { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'X-Content-Type-Options': 'nosniff' } };
  });
  route('DELETE', '/api/tasks/:id/files/:fid', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    const f = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(params.fid), t.id);
    need(f, 404, 'File not found');
    need(f.user_id === user.id || manages(user, t), 403, 'You can only delete files you added');
    try { fs.unlinkSync(path.join(fileDir, f.file)); } catch { /* gone */ }
    db.prepare('DELETE FROM task_files WHERE id = ?').run(f.id);
    notify(t);
    return { ok: true };
  });

  ctx.taskVisible = canSeeTask;
};
