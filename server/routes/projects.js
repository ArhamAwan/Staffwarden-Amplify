'use strict';
const { need, str, optStr, int } = require('../lib/http');
const { projectKey } = require('../db');

// Projects work like Jira or ClickUp spaces. Each has a key (MOB) that numbers its tasks (MOB-12),
// a lead, members, a colour, a description, dates and a status.
//   Who sees a project: owners and managers see all of them; everyone else sees the projects they are
//   members of, plus any project set to "everyone".
//   Who runs a project: owners, managers and the project's lead (settings, members, assigning, review).
const STATUSES = ['active', 'on_hold', 'done'];
const ACCESS = ['members', 'everyone'];
const COLORS = ['#0E5F88', '#B45309', '#7C3AED', '#0F766E', '#BE185D', '#4F46E5', '#15803D', '#C2410C'];
const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;

module.exports = (ctx) => {
  const { db, route, emit, audit, isManager, needManager, nowIso, clockNow, cfg, T } = ctx;

  const getProject = (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
  const memberRow = (pid, uid) => db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, uid);
  const isMember = (pid, uid) => !!memberRow(pid, uid);
  const isLead = (p, user) => !!p && p.lead_id === user.id;
  const projectVisible = (user, p) => !!p && (isManager(user) || p.access === 'everyone' || isMember(p.id, user.id));
  const canManageProject = (user, p) => !!p && (isManager(user) || isLead(p, user));
  function addMember(pid, uid, role = 'member') {
    db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role').run(pid, uid, role);
  }
  function ensureMember(pid, uid) { if (pid && uid && !isMember(pid, uid)) { addMember(pid, uid); emit('projects', uid); return true; } return false; }
  // The next task number in a project: MOB-1, MOB-2, ...
  function nextNumber(pid) {
    db.prepare('UPDATE projects SET task_seq = task_seq + 1 WHERE id = ?').run(pid);
    return db.prepare('SELECT task_seq FROM projects WHERE id = ?').get(pid).task_seq;
  }
  Object.assign(ctx, { projectVisible, canManageProject, isProjectMember: isMember, isProjectLead: isLead, ensureProjectMember: ensureMember, nextTaskNumber: nextNumber, getProject });

  const today = () => ctx.calc.companyToday();

  // Worked seconds per project (time entries minus their pauses).
  function trackedByProject(ids, sinceIso = null) {
    const out = new Map(ids.map((i) => [i, 0]));
    if (!ids.length) return out;
    const entries = db.prepare(`SELECT id, project_id, user_id, started_at, ended_at FROM time_entries WHERE project_id IN (${ids.map(() => '?').join(',')})${sinceIso ? ' AND (ended_at IS NULL OR ended_at >= ?)' : ''}`)
      .all(...ids, ...(sinceIso ? [sinceIso] : []));
    const perUser = new Map();
    if (!entries.length) return Object.assign(out, { perUser });
    const pauses = db.prepare(`SELECT entry_id, started_at, ended_at FROM pauses WHERE entry_id IN (${entries.map(() => '?').join(',')})`).all(...entries.map((e) => e.id));
    const byEntry = new Map();
    for (const p of pauses) { if (!byEntry.has(p.entry_id)) byEntry.set(p.entry_id, []); byEntry.get(p.entry_id).push(p); }
    const now = clockNow(), since = sinceIso ? Date.parse(sinceIso) : 0;
    for (const e of entries) {
      const s = Math.max(since, Date.parse(e.started_at)), en = e.ended_at ? Date.parse(e.ended_at) : now;
      let ms = Math.max(0, en - s);
      for (const p of byEntry.get(e.id) || []) ms -= Math.max(0, Math.min(en, p.ended_at ? Date.parse(p.ended_at) : now) - Math.max(s, Date.parse(p.started_at)));
      ms = Math.max(0, ms);
      out.set(e.project_id, out.get(e.project_id) + ms);
      const k = `${e.project_id}:${e.user_id}`;
      perUser.set(k, (perUser.get(k) || 0) + ms);
    }
    for (const [k, v] of out) out.set(k, Math.round(v / 1000));
    for (const [k, v] of perUser) perUser.set(k, Math.round(v / 1000));
    out.perUser = perUser;
    return out;
  }

  function counts(rows, day) {
    const c = { total: rows.length, todo: 0, in_progress: 0, in_review: 0, done: 0, open: 0, overdue: 0, unassigned: 0 };
    for (const t of rows) {
      c[t.status]++;
      if (t.status !== 'done') { c.open++; if (t.due_day && t.due_day < day) c.overdue++; if (!t.assignee_id) c.unassigned++; }
    }
    c.progress_pct = c.total ? Math.round((100 * c.done) / c.total) : null;
    return c;
  }

  function out(projects, user, { detail = false } = {}) {
    if (!projects.length) return [];
    const ids = projects.map((p) => p.id);
    const ph = ids.map(() => '?').join(',');
    const tasks = db.prepare(`SELECT id, project_id, number, title, status, assignee_id, due_day FROM tasks WHERE project_id IN (${ph}) ORDER BY status = 'done', number`).all(...ids);
    const members = db.prepare(`SELECT m.project_id, m.role, u.id, u.name, u.title, u.active FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id IN (${ph}) ORDER BY u.name`).all(...ids);
    const tracked = trackedByProject(ids);
    const day = today();
    const names = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    return projects.map((p) => {
      const mine = tasks.filter((t) => t.project_id === p.id);
      const mem = members.filter((m) => m.project_id === p.id && m.active).map((m) => ({ id: m.id, name: m.name, title: m.title || null, role: p.lead_id === m.id ? 'lead' : 'member' }));
      const o = {
        id: p.id, key: p.key, name: p.name, client: p.client_id ? ((db.prepare('SELECT name FROM clients WHERE id = ?').get(p.client_id) || {}).name || p.client || null) : p.client || null, client_id: p.client_id || null, description: p.description || '', color: p.color || COLORS[p.id % COLORS.length],
        status: p.status || 'active', access: p.access || 'members', archived: !!p.archived, start_day: p.start_day || null, due_day: p.due_day || null,
        overdue: !!p.due_day && p.status !== 'done' && p.due_day < day,
        lead: p.lead_id ? { id: p.lead_id, name: names.get(p.lead_id) || null } : null,
        members: mem, member_count: mem.length,
        my_role: p.lead_id === user.id ? 'lead' : mem.some((m) => m.id === user.id) ? 'member' : null,
        can_manage: canManageProject(user, p),
        counts: counts(mine, day), tracked_secs: tracked.get(p.id) || 0,
        // kept for the desktop app and older pages: the project's tasks
        tasks: mine.map((t) => ({ id: t.id, key: `${p.key}-${t.number}`, name: t.title, done: t.status === 'done', status: t.status, assignee_id: t.assignee_id })),
      };
      if (detail) {
        o.workload = mem.map((m) => {
          const ts = mine.filter((t) => t.assignee_id === m.id);
          return { user_id: m.id, name: m.name, title: m.title, role: m.role, ...counts(ts, day), tracked_secs: tracked.perUser ? tracked.perUser.get(`${p.id}:${m.id}`) || 0 : 0 };
        });
        o.upcoming = mine.filter((t) => t.status !== 'done' && t.due_day).sort((a, b) => a.due_day.localeCompare(b.due_day)).slice(0, 8)
          .map((t) => ({ id: t.id, key: `${p.key}-${t.number}`, title: t.title, due_day: t.due_day, overdue: t.due_day < day, status: t.status, assignee: names.get(t.assignee_id) || null }));
        o.activity = db.prepare(`SELECT e.kind, e.at, e.detail, u.name AS user, t.id AS task_id, t.number, t.title FROM task_events e JOIN tasks t ON t.id = e.task_id LEFT JOIN users u ON u.id = e.user_id
          WHERE t.project_id = ? ORDER BY e.at DESC, e.id DESC LIMIT 25`).all(p.id).map((e) => ({ ...e, key: `${p.key}-${e.number}` }));
      }
      return o;
    });
  }

  const visibleProjects = (user, all) => db.prepare(`SELECT * FROM projects ${all ? '' : 'WHERE archived = 0'} ORDER BY archived, status = 'done', name`).all().filter((p) => projectVisible(user, p));

  // Names of everyone in the company, so a project lead can add people (no other details).
  route('GET', '/api/directory', () => db.prepare('SELECT id, name, title FROM users WHERE active = 1 ORDER BY name').all());

  route('GET', '/api/projects', ({ user, query }) => out(visibleProjects(user, query.get('all') === '1'), user));

  route('GET', '/api/projects/:id', ({ user, params }) => {
    const p = getProject(params.id);
    need(p && projectVisible(user, p), 404, 'Project not found');
    return out([p], user, { detail: true })[0];
  });

  function readFields(body, user, existing) {
    const set = {};
    if ('name' in body) {
      set.name = str(body.name, 'name', 100).trim();
      need(!db.prepare('SELECT 1 FROM projects WHERE name = ? AND id != ?').get(set.name, existing ? existing.id : 0), 409, 'A project with that name already exists');
    }
    if ('key' in body && body.key != null && body.key !== '') {
      const k = String(body.key).trim().toUpperCase();
      need(KEY_RE.test(k), 400, 'The key is 2 to 6 letters or digits and starts with a letter, like MOB');
      need(!db.prepare('SELECT 1 FROM projects WHERE key = ? AND id != ?').get(k, existing ? existing.id : 0), 409, `The key ${k} is already used by another project`);
      set.key = k;
    }
    if ('client' in body) set.client = optStr(body.client, 'client', 100);
    if ('description' in body) set.description = optStr(body.description, 'description', 5000);
    if ('color' in body) { need(body.color == null || /^#[0-9a-fA-F]{6}$/.test(body.color), 400, 'color must look like #0E5F88'); set.color = body.color || null; }
    for (const f of ['due_day', 'start_day']) if (f in body) { need(body[f] == null || body[f] === '' || T.isDay(body[f]), 400, `${f} must be YYYY-MM-DD`); set[f] = body[f] || null; }
    if ('status' in body) { need(STATUSES.includes(body.status), 400, 'status must be active, on_hold or done'); set.status = body.status; }
    if ('access' in body) { need(ACCESS.includes(body.access), 400, 'access must be members or everyone'); set.access = body.access; }
    if ('archived' in body) set.archived = body.archived ? 1 : 0;
    if ('lead_id' in body) {
      if (body.lead_id == null || body.lead_id === '') set.lead_id = null;
      else {
        const id = int(Number(body.lead_id), 'lead_id', 1, 1e9);
        const u = db.prepare('SELECT id, active FROM users WHERE id = ?').get(id);
        need(u && u.active, 404, 'Lead not found');
        need(isManager(user), 403, 'Only a manager or the owner can choose the project lead');
        set.lead_id = id;
      }
    }
    return set;
  }

  route('POST', '/api/projects', ({ user, body }) => {
    needManager(user);
    const set = readFields(body, user);
    need(set.name, 400, 'name is required');
    if (!set.key) set.key = projectKey(set.name, new Set(db.prepare('SELECT key FROM projects WHERE key IS NOT NULL').all().map((r) => r.key)));
    if (!set.color) set.color = COLORS[db.prepare('SELECT COUNT(*) n FROM projects').get().n % COLORS.length];
    set.created_at = nowIso();
    if (!('access' in set)) set.access = 'members';
    const keys = Object.keys(set);
    const id = Number(db.prepare(`INSERT INTO projects (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => set[k])).lastInsertRowid);
    const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    for (const uid of new Set([...memberIds, ...(set.lead_id ? [set.lead_id] : [])])) {
      if (db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(uid)) addMember(id, uid, uid === set.lead_id ? 'lead' : 'member');
    }
    audit(user, 'project.created', null, `${set.key} ${set.name}`);
    const link = `#/project?id=${id}`;
    if (ctx.notify) {
      ctx.notify.notify(memberIds.filter((m) => m !== set.lead_id), { kind: 'project_added', title: `${user.name} added you to ${set.key} ${set.name}`, body: 'You can now see its tasks and track time on it.', link, actor: user });
      if (set.lead_id) ctx.notify.notify(set.lead_id, { kind: 'project_lead', title: `You lead ${set.key} ${set.name}`, body: `${user.name} made you the project lead: you manage its members and review its tasks.`, link, actor: user });
    }
    emit('projects');
    return out([getProject(id)], user, { detail: true })[0];
  });

  route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
    const p = getProject(params.id);
    need(p && projectVisible(user, p), 404, 'Project not found');
    need(canManageProject(user, p), 403, 'Only a manager or the project lead can change this project');
    const set = readFields(body, user, p);
    if (Object.keys(set).length) {
      const keys = Object.keys(set);
      db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), p.id);
      if (set.lead_id) addMember(p.id, set.lead_id, 'lead');
      if ('lead_id' in set && p.lead_id && p.lead_id !== set.lead_id && isMember(p.id, p.lead_id)) addMember(p.id, p.lead_id, 'member');
      if (set.lead_id && set.lead_id !== p.lead_id && ctx.notify) ctx.notify.notify(set.lead_id, { kind: 'project_lead', title: `You lead ${p.key} ${set.name || p.name}`, body: `${user.name} made you the project lead: you manage its members and review its tasks.`, link: `#/project?id=${p.id}`, actor: user });
      audit(user, 'project.updated', null, `${p.key} ${keys.join(', ')}`);
      emit('projects');
    }
    return out([getProject(p.id)], user, { detail: true })[0];
  });

  // Members: add or remove people. The lead cannot be removed (choose another lead first).
  route('PUT', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProject(params.id);
    need(p && projectVisible(user, p), 404, 'Project not found');
    need(canManageProject(user, p), 403, 'Only a manager or the project lead can add members');
    const ids = (Array.isArray(body.user_ids) ? body.user_ids : [body.user_id]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    need(ids.length, 400, 'user_id is required');
    for (const uid of ids) {
      const u = db.prepare('SELECT id, name, active FROM users WHERE id = ?').get(uid);
      need(u && u.active, 404, 'Person not found');
      if (!isMember(p.id, uid)) {
        addMember(p.id, uid, uid === p.lead_id ? 'lead' : 'member'); audit(user, 'project.member_added', uid, p.key);
        if (ctx.notify) ctx.notify.notify(uid, { kind: 'project_added', title: `${user.name} added you to ${p.key} ${p.name}`, body: 'You can now see its tasks and track time on it.', link: `#/project?id=${p.id}`, actor: user });
      }
      emit('projects', uid);
    }
    emit('projects');
    return out([getProject(p.id)], user, { detail: true })[0];
  });
  route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProject(params.id);
    need(p && projectVisible(user, p), 404, 'Project not found');
    need(canManageProject(user, p), 403, 'Only a manager or the project lead can remove members');
    const uid = Number(params.uid);
    need(uid !== p.lead_id, 409, 'This person leads the project. Choose another lead first.');
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(p.id, uid);
    audit(user, 'project.member_removed', uid, p.key);
    emit('projects', uid); emit('projects');
    return out([getProject(p.id)], user, { detail: true })[0];
  });

  // Older quick-add of a task to a project (the Tasks API is the full one).
  route('POST', '/api/projects/:id/tasks', ({ user, params, body }) => {
    const p = getProject(params.id);
    need(p, 404, 'Project not found');
    need(canManageProject(user, p), 403, 'Not allowed');
    const id = Number(db.prepare('INSERT INTO tasks (project_id, number, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, nextNumber(p.id), str(body.name, 'name', 120), user.id, nowIso(), nowIso()).lastInsertRowid);
    emit('projects'); emit('tasks');
    return { id };
  });
};
