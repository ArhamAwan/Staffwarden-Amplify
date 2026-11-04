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
const MAX_FILE = 5 * 1024 * 1024;        // sent as JSON (base64)
const MAX_UPLOAD = 50 * 1024 * 1024;     // sent as the file itself (bigger designs, videos, PDFs)

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
  const label_ = label;
  const link = (t) => `#/tasks?task=${t.id}`;
  const pinLink = (t, pin) => `#/task?id=${t.id}&pin=${pin}`;
  // ---------- who approves ----------
  // The manager assigned to the project (its lead). When the lead is the one doing the task, or there is no
  // project or lead, the person's own managers. The owner can always approve. Nobody approves their own
  // work, except the owner on a task they gave themselves when nobody else could.
  function approversOf(t) {
    const doer = t.assignee_id || t.created_by;
    const p = t.project_id ? getProject(t.project_id) : null;
    if (p && p.lead_id && p.lead_id !== doer) {
      const l = db.prepare('SELECT id, active FROM users WHERE id = ?').get(p.lead_id);
      if (l && l.active) return { ids: [p.lead_id], why: 'project lead' };
    }
    return { ids: ctx.managersOf(doer), why: 'manager' };
  }
  function canApprove(user, t) {
    if (user.kind === 'client') return false;
    const doer = t.assignee_id || t.created_by;
    const a = approversOf(t).ids;
    if (user.id === doer) return user.role === 'owner' && !user.dev_owner && !a.some((id) => id !== user.id);
    return user.role === 'owner' || a.includes(user.id);
  }
  // does this task need approval: its own choice, else the company setting
  const needsReview = (t) => (t.needs_review == null ? cfg.taskReviewRequired !== false : !!t.needs_review);
  const reviewersOf = (t) => approversOf(t).ids;
  const approverLabel = (t) => { const a = approversOf(t); const n = a.ids.map(nameOf).filter(Boolean); return n.length ? n.join(' or ') : 'A manager'; };
  ctx.taskApprovers = approversOf; ctx.canApproveTask = canApprove;
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
  ctx.loadTaskVisible = loadVisible;

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
    if ('needs_review' in body) {
      const pid0 = 'project_id' in body ? body.project_id : existing ? existing.project_id : null;
      need(user.role === 'owner' || (pid0 != null && isProjectLead(getProject(Number(pid0)), user)), 403, 'Only the project lead or the owner can change whether this needs approval');
      need([null, 0, 1, true, false].includes(body.needs_review), 400, 'needs_review must be null, 0 or 1');
      set.needs_review = body.needs_review == null ? null : body.needs_review ? 1 : 0;
    }
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
    db.prepare('UPDATE tasks SET needs_review = ?, count_target = ?, count_done = ?, count_unit = ? WHERE id = ?').run(t.needs_review ?? null, t.count_target ?? null, t.count_target != null ? 0 : null, t.count_unit ?? null, id);
    for (const c of db.prepare('SELECT title, position FROM task_checks WHERE task_id = ? ORDER BY position, id').all(t.id)) db.prepare('INSERT INTO task_checks (task_id, title, position, created_by, created_at) VALUES (?,?,?,?,?)').run(id, c.title, c.position, actorId, nowIso());
    event(id, actorId, 'created', `Repeats ${t.recurrence}; next copy of #${t.id}`);
    return id;
  }

  // The one place status changes happen, so the review rules and accuracy are always applied the same way.
  function changeStatus(t, to, user, note = null) {
    need(STATUSES.includes(to), 400, 'Unknown status');
    if (t.status === to) return t;
    const mgr = manages(user, t);
    const mine = t.assignee_id === user.id || (t.assignee_id == null && t.created_by === user.id);
    const approver = canApprove(user, t);
    need(mgr || mine || approver, 403, 'Not allowed');
    const now = nowIso();
    const sets = { status: to, updated_at: now };
    if (to === 'done') {
      // A person can close their own personal to-dos; assigned work goes through review (unless the owner turned review off).
      const personal = t.created_by === user.id && (t.assignee_id === user.id || t.assignee_id == null) && t.project_id == null;
      if (!approver) need(personal || !needsReview(t), 403, `Send it for review. ${approverLabel(t)} approves it.`);
      sets.completed_at = now;
      sets.first_time = t.review_rounds === 0 ? 1 : 0;
      sets.approved_by = approver && !mine ? user.id : null;
      event(t.id, user.id, t.status === 'in_review' ? 'approved' : 'completed', t.review_rounds ? `After ${t.review_rounds} round${t.review_rounds === 1 ? '' : 's'} of changes` : 'First time');
    } else {
      if (t.status === 'done') { sets.completed_at = null; sets.first_time = null; sets.approved_by = null; event(t.id, user.id, 'reopened'); }
      if (t.status === 'in_review' && t.assignee_id !== user.id) {          // the approver sends it back for changes
        need(approver, 403, `Only ${approverLabel(t)} can send this back`);
        sets.review_rounds = t.review_rounds + 1;
        event(t.id, user.id, 'sent_back', note);
        if (note) db.prepare("INSERT INTO task_comments (task_id, user_id, body, team_only, kind, created_at) VALUES (?,?,?,1,'feedback',?)").run(t.id, user.id, note, now);   // review notes stay with the team
      } else if (t.status === 'in_review') event(t.id, user.id, 'withdrawn', note);
      else if (to === 'in_review') { sets.submitted_at = now; event(t.id, user.id, 'submitted', note); }
      else event(t.id, user.id, 'status', `${t.status} -> ${to}`);
    }
    const keys = Object.keys(sets);
    db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => sets[k]), t.id);
    const after = getTask(t.id);
    if (to === 'done') spawnNext(after, user.id);
    tellStatus(t, after, user, note);
    // approved work: the approved version of each picture and PDF is saved to the client's assets
    if (to === 'done' && t.status === 'in_review' && ctx.assetsOnApproved) ctx.assetsOnApproved(after, user);
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
    let out = shape(rows).map((t, i) => ({ ...t, can_manage: manages(user, rows[i]), can_approve: rows[i].status === 'in_review' && canApprove(user, rows[i]) }));
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
    const rev = db.prepare("SELECT * FROM tasks WHERE status = 'in_review'").all().filter((t) => canApprove(user, t) && t.assignee_id !== user.id);
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
      comments: db.prepare('SELECT c.id, c.user_id, COALESCE(u.name, cu.name) AS user, c.client_user_id, c.team_only, c.kind, c.body, c.created_at, c.file, c.file_name, c.file_type, c.file_size FROM task_comments c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN client_users cu ON cu.id = c.client_user_id WHERE c.task_id = ? ORDER BY c.created_at, c.id').all(t.id)
        .map(({ file, file_name, file_type, file_size, ...c }) => ({ ...c, team_only: !!c.team_only, from_client: !!c.client_user_id, file: file ? { name: file_name, type: file_type, size: file_size, url: `/api/portal/comment-files/${c.id}` } : null })),
      steps_list: db.prepare('SELECT id, title, done_at FROM task_steps WHERE task_id = ? ORDER BY position, id').all(t.id).map((x) => ({ id: x.id, title: x.title, done: !!x.done_at })),
      milestones: t.project_id ? db.prepare('SELECT id, title, done_at FROM milestones WHERE project_id = ? ORDER BY position, id').all(t.project_id) : [],
      files: db.prepare('SELECT f.id, f.name, f.mime, f.size, f.created_at, f.user_id, u.name AS user, COALESCE(f.chain_id, f.id) AS chain_id, f.version, f.label, f.note, f.round FROM task_files f LEFT JOIN users u ON u.id = f.user_id WHERE f.task_id = ? ORDER BY f.id').all(t.id),
      pins: pinsOf(t.id), count: countOf(t), outcome: t.outcome || null,
      events: db.prepare('SELECT e.kind, e.at, e.detail, u.name AS user FROM task_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ? ORDER BY e.at, e.id').all(t.id),
      sessions: db.prepare('SELECT COUNT(*) n FROM time_entries WHERE task_id = ?').get(t.id).n,
      approver: (() => { const a = approversOf(t); return { ids: a.ids, names: a.ids.map(nameOf).filter(Boolean), why: a.why }; })(),
      can_approve: canApprove(user, t), needs_review: needsReview(t), needs_review_set: t.needs_review == null ? null : !!t.needs_review,
      can_set_review: user.role === 'owner' || leads(user, t), can_edit: canEditTask(user, t),
      can_change: manages(user, t) || (t.created_by === user.id && (t.assignee_id === user.id || t.assignee_id == null)),
      checks: checksOf(t.id), links: linksOf(t.id), live: liveOf(t, user),
      assets: ctx.assetsForTask ? ctx.assetsForTask(t) : null,
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
    need(canApprove(user, t), 403, `Only ${approverLabel(t)} can approve this`);
    need(t.status === 'in_review', 409, 'This task is not waiting for review');
    const after = changeStatus(t, 'done', user);
    notify(after);
    return shape([after])[0];
  });
  route('POST', '/api/tasks/:id/send-back', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    need(canApprove(user, t), 403, `Only ${approverLabel(t)} can send this back`);
    need(t.status === 'in_review', 409, 'This task is not waiting for review');
    // the note can be left out when unticked "Done when" checks say what's missing
    const open = db.prepare('SELECT title FROM task_checks WHERE task_id = ? AND checked_at IS NULL ORDER BY position, id').all(t.id).map((c) => c.title);
    const pins = db.prepare('SELECT p.num, p.body, COALESCE(f.label, f.name) AS what FROM task_pins p JOIN task_files f ON f.id = p.file_id WHERE p.task_id = ? AND p.resolved_at IS NULL ORDER BY p.chain_id, p.num').all(t.id)
      .map((p) => `${p.what}, pin ${p.num}: ${p.body.length > 120 ? `${p.body.slice(0, 117)}…` : p.body}`);
    let note = optStr(body.note, 'note', 2000);
    need(note || open.length || pins.length, 400, 'Say what needs to change');
    if (open.length || pins.length) note = `${note ? `${note}\n\n` : ''}Still to do:\n${[...open, ...pins].map((x) => `• ${x}`).join('\n')}`;
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
    const kind = body.kind === 'update' ? 'update' : 'comment';
    const id = Number(db.prepare('INSERT INTO task_comments (task_id, user_id, body, team_only, kind, created_at) VALUES (?,?,?,?,?,?)').run(t.id, user.id, text, teamOnly, kind, nowIso()).lastInsertRowid);
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

  // ---------- files, and new versions of the same piece of work ----------
  const ROUND = (t) => t.review_rounds + 1;
  function saveFile(user, t, { name, mime, buf, versionOf, label, note }) {
    need(canEditTask(user, t) || canApprove(user, t), 403, 'Only the people on this task can add files');
    need(buf.length > 0, 400, 'The file is empty');
    name = String(name).replace(/[\\/\0]/g, '_').slice(0, 200) || 'file';
    mime = typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
    let chain = null, version = 1;
    if (versionOf != null && versionOf !== '') {
      const prev = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(versionOf), t.id);
      need(prev, 404, 'The earlier version is not on this task');
      chain = prev.chain_id || prev.id;
      version = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 v FROM task_files WHERE task_id = ? AND chain_id = ?').get(t.id, chain).v;
      label = label || db.prepare('SELECT label FROM task_files WHERE chain_id = ? AND label IS NOT NULL ORDER BY version DESC LIMIT 1').get(chain)?.label || null;
    }
    const file = `${t.id}-${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(path.join(fileDir, file), buf);
    const id = Number(db.prepare('INSERT INTO task_files (task_id, user_id, name, mime, size, file, created_at, version, label, note, round) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, user.id, name, mime, buf.length, file, nowIso(), version, label ? String(label).slice(0, 80) : null, note ? String(note).slice(0, 1000) : null, ROUND(t)).lastInsertRowid);
    db.prepare('UPDATE task_files SET chain_id = ? WHERE id = ?').run(chain || id, id);
    const what = label || name;
    if (version > 1) {
      event(t.id, user.id, 'version', `V${version} of ${what}`);
      tell(watchersOf(t).concat(t.status === 'in_review' ? reviewersOf(t) : []), 'task_file', t, user, `${user.name} added V${version} of ${what} on ${label_(t)}`, note || null);
    } else {
      event(t.id, user.id, 'file', name);
      tell(watchersOf(t), 'task_file', t, user, `${user.name} attached a file to ${label_(t)}`, name);
    }
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(nowIso(), t.id);
    notify(t);
    return { id, name, size: buf.length, version, chain_id: chain || id };
  }
  route('POST', '/api/tasks/:id/files', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const buf = Buffer.from(str(body.data_base64, 'data_base64', ctx.MAX_BODY), 'base64');
    need(buf.length <= MAX_FILE, 413, 'Files over 5 MB are sent another way. Update the page and try again.');
    return saveFile(user, t, { name: str(body.name, 'name', 200), mime: body.mime, buf, versionOf: body.version_of, label: optStr(body.label, 'label', 80), note: optStr(body.note, 'note', 1000) });
  });
  // the file itself as the body, with its name and the rest in the address: up to 50 MB
  route('POST', '/api/tasks/:id/upload', ({ user, params, body, query }) => {
    const t = loadVisible(user, params.id);
    const q = (k, max) => { const v = query.get(k); return v == null || v === '' ? null : String(v).slice(0, max); };
    need(q('name', 200), 400, 'name is required');
    return saveFile(user, t, { name: q('name', 200), mime: q('mime', 100), buf: body, versionOf: q('version_of', 20), label: q('label', 80), note: q('note', 1000) });
  }, { raw: MAX_UPLOAD });
  // rename a piece of work ("Static 1"); every version takes the name
  route('PATCH', '/api/tasks/:id/files/:fid', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const f = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(params.fid), t.id);
    need(f, 404, 'File not found');
    need(canEditTask(user, t), 403, 'Only the people on this task can rename work');
    if ('label' in body) db.prepare('UPDATE task_files SET label = ? WHERE task_id = ? AND chain_id = ?').run(optStr(body.label, 'label', 80) || null, t.id, f.chain_id || f.id);
    if ('note' in body) { need(f.user_id === user.id || manages(user, t), 403, 'Only the person who added it can change its note'); db.prepare('UPDATE task_files SET note = ? WHERE id = ?').run(optStr(body.note, 'note', 1000) || null, f.id); }
    notify(t);
    return { ok: true };
  });
  route('GET', '/api/tasks/:id/files/:fid', ({ user, params, query }) => {
    const t = loadVisible(user, params.id);
    const f = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(params.fid), t.id);
    need(f, 404, 'File not found');
    const p = path.join(fileDir, f.file);
    need(fs.existsSync(p), 404, 'File missing');
    // pictures can be shown on the page; anything else (SVG and HTML included) only downloads, so nothing uploaded can run here
    const inline = query && query.get('inline') === '1' && /^image\/(png|jpeg|webp|gif)$/.test(f.mime || '');
    return { raw: fs.readFileSync(p), type: inline ? f.mime : f.mime || 'application/octet-stream', headers: { 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'X-Content-Type-Options': 'nosniff', ...(inline ? { 'Content-Security-Policy': "default-src 'none'" } : {}) } };
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

  // ---------- "Done when" checks: written with the task, ticked by the approver ----------
  function canEditTask(user, t) { return manages(user, t) || t.created_by === user.id || t.assignee_id === user.id; }
  const checksOf = (id) => db.prepare('SELECT c.id, c.title, c.checked_at, c.checked_by, u.name AS checked_by_name FROM task_checks c LEFT JOIN users u ON u.id = c.checked_by WHERE c.task_id = ? ORDER BY c.position, c.id').all(id)
    .map((c) => ({ id: c.id, title: c.title, checked: !!c.checked_at, checked_at: c.checked_at, checked_by: c.checked_by_name || null }));
  const checkOf = (t, cid) => { const c = db.prepare('SELECT * FROM task_checks WHERE id = ? AND task_id = ?').get(Number(cid), t.id); need(c, 404, 'That check is not on this task'); return c; };
  route('POST', '/api/tasks/:id/checks', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    need(canEditTask(user, t), 403, 'Only the people on this task can add checks');
    need(db.prepare('SELECT COUNT(*) n FROM task_checks WHERE task_id = ?').get(t.id).n < 30, 400, 'A task can have at most 30 checks');
    const title = str(body.title, 'title', 200);
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM task_checks WHERE task_id = ?').get(t.id).p;
    db.prepare('INSERT INTO task_checks (task_id, title, position, created_by, created_at) VALUES (?,?,?,?,?)').run(t.id, title, pos, user.id, nowIso());
    event(t.id, user.id, 'check_added', title);
    notify(t);
    return checksOf(t.id);
  });
  route('PATCH', '/api/tasks/:id/checks/:cid', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const c = checkOf(t, params.cid);
    if ('title' in body) { need(canEditTask(user, t), 403, 'Only the people on this task can change checks'); db.prepare('UPDATE task_checks SET title = ? WHERE id = ?').run(str(body.title, 'title', 200), c.id); }
    if ('checked' in body) {
      need(canApprove(user, t), 403, `Only ${approverLabel(t)} ticks these`);
      db.prepare('UPDATE task_checks SET checked_at = ?, checked_by = ? WHERE id = ?').run(body.checked ? nowIso() : null, body.checked ? user.id : null, c.id);
      event(t.id, user.id, body.checked ? 'check_ticked' : 'check_unticked', c.title);
    }
    notify(t);
    return checksOf(t.id);
  });
  route('DELETE', '/api/tasks/:id/checks/:cid', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    const c = checkOf(t, params.cid);
    need(canEditTask(user, t), 403, 'Only the people on this task can remove checks');
    db.prepare('DELETE FROM task_checks WHERE id = ?').run(c.id);
    notify(t);
    return checksOf(t.id);
  });

  // ---------- links handed in as work (a pull request, a staging page, a doc) ----------
  const linksOf = (id) => db.prepare('SELECT l.id, l.url, l.title, l.created_at, l.user_id, u.name AS user FROM task_links l LEFT JOIN users u ON u.id = l.user_id WHERE l.task_id = ? ORDER BY l.id').all(id)
    .map((l) => { let host = ''; try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch { /* kept as typed */ } return { ...l, host }; });
  route('POST', '/api/tasks/:id/links', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    need(canEditTask(user, t), 403, 'Only the people on this task can add links');
    const raw = str(body.url, 'url', 2000).trim();
    let u = null; try { u = new URL(raw); } catch { /* checked below */ }
    need(u && (u.protocol === 'https:' || u.protocol === 'http:'), 400, 'Paste a link that starts with https://');
    need(db.prepare('SELECT COUNT(*) n FROM task_links WHERE task_id = ?').get(t.id).n < 30, 400, 'A task can have at most 30 links');
    const title = optStr(body.title, 'title', 200) || null;
    db.prepare('INSERT INTO task_links (task_id, user_id, url, title, created_at) VALUES (?,?,?,?,?)').run(t.id, user.id, u.href, title, nowIso());
    event(t.id, user.id, 'link', title || u.hostname);
    notify(t);
    return linksOf(t.id);
  });
  route('DELETE', '/api/tasks/:id/links/:lid', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    const l = db.prepare('SELECT * FROM task_links WHERE id = ? AND task_id = ?').get(Number(params.lid), t.id);
    need(l, 404, 'Link not found');
    need(l.user_id === user.id || manages(user, t), 403, 'You can only remove links you added');
    db.prepare('DELETE FROM task_links WHERE id = ?').run(l.id);
    notify(t);
    return linksOf(t.id);
  });

  // ---------- comments pinned to a spot on a picture or a PDF page ----------
  // Pins are for the team: a client never sees them (the portal reads none of this).
  const pinsOf = (id) => {
    const reps = new Map();
    for (const r of db.prepare('SELECT r.id, r.pin_id, r.user_id, u.name AS user, r.body, r.created_at FROM task_pin_replies r JOIN task_pins p ON p.id = r.pin_id LEFT JOIN users u ON u.id = r.user_id WHERE p.task_id = ? ORDER BY r.id').all(id)) {
      if (!reps.has(r.pin_id)) reps.set(r.pin_id, []);
      reps.get(r.pin_id).push({ id: r.id, user_id: r.user_id, user: r.user, body: r.body, created_at: r.created_at });
    }
    return db.prepare('SELECT p.*, u.name AS user, rb.name AS resolved_by_name FROM task_pins p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN users rb ON rb.id = p.resolved_by WHERE p.task_id = ? ORDER BY p.chain_id, p.num').all(id)
      .map((p) => ({ id: p.id, file_id: p.file_id, chain_id: p.chain_id, page: p.page, x: p.x, y: p.y, num: p.num, user_id: p.user_id, user: p.user, body: p.body, round: p.round, created_at: p.created_at,
        resolved: !!p.resolved_at, resolved_at: p.resolved_at, resolved_by: p.resolved_by_name || null, replies: reps.get(p.id) || [] }));
  };
  const pinOf = (t, pid) => { const p = db.prepare('SELECT * FROM task_pins WHERE id = ? AND task_id = ?').get(Number(pid), t.id); need(p, 404, 'That pin is not on this task'); return p; };
  const workName = (f) => f.label || f.name;
  route('POST', '/api/tasks/:id/pins', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const f = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(body.file_id), t.id);
    need(f, 404, 'Pick a picture or a PDF on this task');
    need(/^image\/(png|jpeg|webp|gif)$/.test(f.mime || '') || f.mime === 'application/pdf', 400, 'Pins go on pictures and PDFs');
    const num01 = (v, k) => { need(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1, 400, `${k} must be between 0 and 1`); return Math.round(v * 10000) / 10000; };
    const x = num01(body.x, 'x'), y = num01(body.y, 'y');
    const page = body.page == null ? 1 : int(Number(body.page), 'page', 1, 5000);
    const text = str(body.body, 'body', 2000);
    const chain = f.chain_id || f.id;
    need(db.prepare('SELECT COUNT(*) n FROM task_pins WHERE task_id = ?').get(t.id).n < 300, 400, 'A task can have at most 300 pins');
    const num = db.prepare('SELECT COALESCE(MAX(num), 0) + 1 n FROM task_pins WHERE task_id = ? AND chain_id = ?').get(t.id, chain).n;
    const id = Number(db.prepare('INSERT INTO task_pins (task_id, file_id, chain_id, page, x, y, num, user_id, body, round, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, f.id, chain, page, x, y, num, user.id, text, ROUND(t), nowIso()).lastInsertRowid);
    event(t.id, user.id, 'pin', `${workName(f)}, pin ${num}`);
    N.notify(watchersOf(t), { kind: 'task_comment', title: `${user.name} pinned a comment on ${workName(f)} in ${label_(t)}`, body: text.slice(0, 200), link: pinLink(t, id), actor: user });
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(nowIso(), t.id);
    notify(t, { teamOnly: true });
    return pinsOf(t.id).find((p) => p.id === id);
  });
  route('POST', '/api/tasks/:id/pins/:pid/replies', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const p = pinOf(t, params.pid);
    const text = str(body.body, 'body', 2000);
    db.prepare('INSERT INTO task_pin_replies (pin_id, user_id, body, created_at) VALUES (?,?,?,?)').run(p.id, user.id, text, nowIso());
    const others = db.prepare('SELECT DISTINCT user_id FROM task_pin_replies WHERE pin_id = ?').all(p.id).map((r) => r.user_id);
    N.notify([p.user_id, t.assignee_id, ...others], { kind: 'task_comment', title: `${user.name} replied on pin ${p.num} in ${label_(t)}`, body: text.slice(0, 200), link: pinLink(t, p.id), actor: user });
    notify(t, { teamOnly: true });
    return pinsOf(t.id).find((x) => x.id === p.id);
  });
  // fixed or reopened: by whoever pinned it, the person doing the task, the approver or their manager
  route('PATCH', '/api/tasks/:id/pins/:pid', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    const p = pinOf(t, params.pid);
    if ('body' in body) { need(p.user_id === user.id, 403, 'Only the person who pinned it can change what it says'); db.prepare('UPDATE task_pins SET body = ? WHERE id = ?').run(str(body.body, 'body', 2000), p.id); }
    if ('resolved' in body) {
      need(p.user_id === user.id || t.assignee_id === user.id || canApprove(user, t) || manages(user, t), 403, 'Only the person who pinned it, the person doing the task or the approver can mark it fixed');
      db.prepare('UPDATE task_pins SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(body.resolved ? nowIso() : null, body.resolved ? user.id : null, p.id);
      const f = db.prepare('SELECT * FROM task_files WHERE id = ?').get(p.file_id);
      event(t.id, user.id, body.resolved ? 'pin_resolved' : 'pin_reopened', `${f ? workName(f) : 'Work'}, pin ${p.num}`);
      if (p.user_id !== user.id) N.notify(p.user_id, { kind: 'task_comment', title: `${user.name} ${body.resolved ? 'marked pin' : 'reopened pin'} ${p.num} ${body.resolved ? 'as fixed' : ''} in ${label_(t)}`.replace(/\s+/g, ' '), body: p.body.slice(0, 200), link: pinLink(t, p.id), actor: user });
    }
    notify(t, { teamOnly: true });
    return pinsOf(t.id).find((x) => x.id === p.id);
  });
  route('DELETE', '/api/tasks/:id/pins/:pid', ({ user, params }) => {
    const t = loadVisible(user, params.id);
    const p = pinOf(t, params.pid);
    need(p.user_id === user.id || manages(user, t), 403, 'Only the person who pinned it can remove it');
    db.prepare('DELETE FROM task_pins WHERE id = ?').run(p.id);
    notify(t, { teamOnly: true });
    return { ok: true };
  });

  // ---------- a count ("12 of 20 called") and how it went ----------
  route('POST', '/api/tasks/:id/progress', ({ user, params, body }) => {
    const t = loadVisible(user, params.id);
    need(canEditTask(user, t), 403, 'Only the people on this task can update it');
    const set = {};
    if ('count_target' in body) {
      if (body.count_target === null || body.count_target === '') Object.assign(set, { count_target: null, count_done: null, count_unit: null });
      else { set.count_target = int(Number(body.count_target), 'count_target', 1, 1000000); if (t.count_done == null) set.count_done = 0; }
    }
    if ('count_unit' in body && set.count_target !== null) set.count_unit = optStr(body.count_unit, 'count_unit', 40) || null;
    if ('count_done' in body) {
      need(t.count_target != null || set.count_target != null, 400, 'Add a count first');
      set.count_done = int(Number(body.count_done), 'count_done', 0, 1000000);
    }
    if ('outcome' in body) set.outcome = optStr(body.outcome, 'outcome', 2000) || null;
    need(Object.keys(set).length, 400, 'Nothing to change');
    set.updated_at = nowIso();
    const keys = Object.keys(set);
    db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), t.id);
    const after = getTask(t.id);
    if ('count_target' in set) event(t.id, user.id, 'count', set.count_target == null ? 'Removed the count' : `Counting to ${set.count_target}${after.count_unit ? ` ${after.count_unit}` : ''}`);
    if ('outcome' in set && set.outcome) event(t.id, user.id, 'outcome', set.outcome.slice(0, 140));
    notify(after);
    return { count: countOf(after), outcome: after.outcome || null };
  });
  const countOf = (t) => (t.count_target == null ? null : { target: t.count_target, done: t.count_done || 0, unit: t.count_unit || null });

  // ---------- who is working on it right now: for that person, their managers and the approver ----------
  function liveOf(t, user) {
    const e = db.prepare('SELECT * FROM time_entries WHERE task_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(t.id);
    if (!e) return null;
    if (!(e.user_id === user.id || canSee(user, e.user_id) || canApprove(user, t))) return null;
    const now = clockNow(), s = Date.parse(e.started_at);
    let ms = now - s;
    for (const p of db.prepare('SELECT started_at, ended_at FROM pauses WHERE entry_id = ?').all(e.id)) ms -= Math.max(0, Math.min(now, p.ended_at ? Date.parse(p.ended_at) : now) - Math.max(s, Date.parse(p.started_at)));
    const paused = !!db.prepare('SELECT 1 FROM pauses WHERE entry_id = ? AND ended_at IS NULL').get(e.id);
    return { user_id: e.user_id, name: nameOf(e.user_id), since: e.started_at, session_secs: Math.max(0, Math.round(ms / 1000)), paused };
  }

  ctx.taskVisible = canSeeTask;
};
