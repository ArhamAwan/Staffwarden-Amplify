'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, str, optStr } = require('../lib/http');

// The client portal: what a client sees of their own projects, and the team's side of the same things
// (requests, approvals, milestones, the weekly update). Every route here works for a client (only their
// own client's projects) and for staff who can see the project. Nothing about people's time beyond what
// the client's settings allow ever leaves through these routes.
const STATUS = { todo: 'todo', in_progress: 'in_progress', in_review: 'in_progress', done: 'done' };
const URGENCY = ['whenever', 'month', 'week'];
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'text/csv': 'csv', 'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4' };
const MAX_FILE = 5 * 1024 * 1024;

module.exports = (ctx) => {
  const { db, route, nowIso, clockNow, audit, emit, emitPortal, cfg, T } = ctx;
  const dir = path.join(cfg.dataDir, 'portal');
  fs.mkdirSync(dir, { recursive: true });
  const C = { client: true };

  // ---------- who may see what ----------
  // { p, c, s, client, manage }: the project, its client and the client's settings. A client only ever
  // reaches their own client's projects; for anyone else a project of another client "does not exist".
  function access(user, pid) {
    const p = ctx.getProject(pid);
    need(p && p.client_id, 404, 'Project not found');
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
    need(c, 404, 'Project not found');
    const s = ctx.clientSettings(c);
    if (user.kind === 'client') { need(user.client_id === p.client_id, 404, 'Project not found'); return { p, c, s, client: true, manage: false }; }
    need(ctx.projectVisible(user, p), 403, 'Not allowed');
    return { p, c, s, client: false, manage: ctx.canManageProject(user, p) };
  }
  const needManage = (a) => need(a.manage, 403, 'Only the project lead or a manager can do this');
  const visibleSql = (s) => (s.tasks === 'shared' ? 't.client_visible = 1' : '(t.client_visible IS NULL OR t.client_visible = 1)');
  const taskVisible = (t, s) => (s.tasks === 'shared' ? t.client_visible === 1 : t.client_visible !== 0);
  Object.assign(ctx, { portalAccess: access, portalTaskVisible: taskVisible });

  // ---------- files ----------
  function saveFile(b64, type, name) {
    need(FILE_TYPES[type], 400, 'That kind of file can’t be shared here. Use a PDF, image, document, spreadsheet, CSV or audio.');
    const buf = Buffer.from(String(b64 || ''), 'base64');
    need(buf.length > 0 && buf.length <= MAX_FILE, 400, 'Files can be up to 5 MB');
    const file = `${crypto.randomBytes(12).toString('hex')}.${FILE_TYPES[type]}`;
    fs.writeFileSync(path.join(dir, file), buf);
    return { file, file_name: str(name || `file.${FILE_TYPES[type]}`, 'file_name', 160).replace(/[\\/]/g, '_'), file_type: type, file_size: buf.length };
  }
  const sendFile = (file, type, name) => ({ raw: fs.readFileSync(path.join(dir, file)), type, headers: { 'Content-Disposition': `inline; filename="${String(name).replace(/[^\w. -]/g, '_')}"`, 'Cache-Control': 'private, no-store' } });
  Object.assign(ctx, { portalSaveFile: saveFile, portalSendFile: sendFile, portalDir: dir });

  // ---------- time on the project ----------
  // worked seconds per entry inside [from, to), pauses taken out
  function worked(pid, fromMs, toMs) {
    const entries = db.prepare(`SELECT e.id, e.user_id, e.task_id, e.started_at, e.ended_at FROM time_entries e WHERE e.project_id = ? AND e.started_at < ? AND (e.ended_at IS NULL OR e.ended_at > ?)`)
      .all(pid, new Date(toMs).toISOString(), new Date(fromMs).toISOString());
    if (!entries.length) return [];
    const pauses = db.prepare(`SELECT entry_id, started_at, ended_at FROM pauses WHERE entry_id IN (${entries.map(() => '?').join(',')})`).all(...entries.map((e) => e.id));
    const now = clockNow();
    return entries.map((e) => {
      const s = Math.max(fromMs, Date.parse(e.started_at)), en = Math.min(toMs, e.ended_at ? Date.parse(e.ended_at) : now);
      let ms = Math.max(0, en - s);
      for (const p of pauses) if (p.entry_id === e.id) ms -= Math.max(0, Math.min(en, p.ended_at ? Date.parse(p.ended_at) : now) - Math.max(s, Date.parse(p.started_at)));
      return { user_id: e.user_id, task_id: e.task_id, start: s, secs: Math.max(0, Math.round(ms / 1000)) };
    }).filter((x) => x.secs > 0);
  }
  const tz = () => ctx.calc.companyTz();
  const monthWindow = (month) => { const [y, m] = month.split('-').map(Number); const from = T.dayStartMs(`${month}-01`, tz()); const nx = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; return [from, T.dayStartMs(nx, tz()), nx]; };
  const thisMonth = () => T.localDay(clockNow(), tz()).slice(0, 7);
  Object.assign(ctx, { portalWorked: (...a) => worked(...a), portalMonthWindow: monthWindow, portalThisMonth: thisMonth, portalStaffName: (id) => staffName(id) });

  // ---------- people ----------
  const staffName = (id) => (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || 'Someone';
  function teamOf(a) {
    const rows = db.prepare(`SELECT u.id, u.name, u.title, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.active = 1
      ORDER BY (u.id = ?) DESC, u.name`).all(a.p.id, a.p.lead_id || 0);
    const running = new Map();
    if (a.s.on_it_now || !a.client) {
      // the task's name only if the client may see that task
      for (const r of db.prepare(`SELECT e.user_id, t.title, t.client_visible, t.id AS tid FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.project_id = ? AND e.ended_at IS NULL`).all(a.p.id)) running.set(r.user_id, r.tid && (!a.client || taskVisible(r, a.s)) ? r.title : null);
    }
    return rows.map((r) => ({ id: r.id, name: r.name, title: r.title, lead: r.id === a.p.lead_id, on_now: (a.s.on_it_now || !a.client) && running.has(r.id), now_task: (a.s.on_it_now || !a.client) && running.has(r.id) ? running.get(r.id) : null }));
  }

  // ---------- what is waiting on the client ----------
  function waitingOf(a) {
    if (a.client && !a.s.approvals) return [];
    return db.prepare("SELECT id, kind, title, description, due_day, created_at, created_by FROM approvals WHERE project_id = ? AND status = 'waiting' ORDER BY created_at").all(a.p.id)
      .map((x) => { const v = db.prepare('SELECT n, created_at FROM approval_versions WHERE approval_id = ? ORDER BY n DESC LIMIT 1').get(x.id); return { ...x, by: staffName(x.created_by), version: v ? v.n : 0, asked_at: v ? v.created_at : x.created_at }; });
  }

  // ---------- unread chat ----------
  function unreadFor(user, pid) {
    const kind = user.kind === 'client' ? 'client' : 'staff';
    const threads = db.prepare('SELECT * FROM chat_threads WHERE project_id = ?').all(pid).filter((t) => (t.kind === 'group') || (kind === 'client' ? t.client_user_id === user.id : t.staff_id === user.id));
    let n = 0;
    for (const t of threads) {
      const r = db.prepare('SELECT last_id FROM chat_reads WHERE thread_id = ? AND author_kind = ? AND author_id = ?').get(t.id, kind, user.id);
      n += db.prepare(`SELECT COUNT(*) n FROM chat_messages WHERE thread_id = ? AND id > ? AND deleted_at IS NULL AND NOT (author_kind = ? AND author_id = ?)${kind === 'client' ? ' AND team_only = 0' : ''}`).get(t.id, r ? r.last_id : 0, kind, user.id).n;
    }
    return n;
  }
  ctx.chatUnreadFor = unreadFor;

  // ---------- the client's own start page ----------
  route('GET', '/api/portal', ({ user }) => {
    need(user.kind === 'client', 403, 'For clients');
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(user.client_id);
    const projects = db.prepare("SELECT * FROM projects WHERE client_id = ? AND status != 'archived' ORDER BY (status = 'active') DESC, name").all(user.client_id)
      .map((p) => { const a = { p, c, s: ctx.clientSettings(c), client: true }; return { id: p.id, name: p.name, key: p.key, color: p.color, status: p.status, unread: unreadFor(user, p.id), waiting: waitingOf(a).length }; });
    return { me: ctx.publicClient(user), client: { id: c.id, name: c.name, city: c.city, tz_name: c.tz_name }, org_name: cfg.orgName, settings: ctx.clientSettings(c), projects };
  }, C);

  // ---------- overview ----------
  route('GET', '/api/portal/projects/:id', ({ user, params }) => {
    const a = access(user, params.id);
    const vis = visibleSql(a.s);
    const tasks = db.prepare(`SELECT t.id, t.status, t.due_day, t.completed_at, t.title, t.milestone_id FROM tasks t WHERE t.project_id = ? AND ${vis}`).all(a.p.id);
    const today = ctx.calc.companyToday(), weekAgo = new Date(clockNow() - 7 * 86400000).toISOString(), weekEnd = T.addDays(today, 7);
    const doneWeek = tasks.filter((t) => t.status === 'done' && t.completed_at && t.completed_at >= weekAgo);
    const inProg = tasks.filter((t) => STATUS[t.status] === 'in_progress');
    const lead = a.p.lead_id ? db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(a.p.lead_id) : null;
    const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY position, id').all(a.p.id);
    const upd = db.prepare('SELECT * FROM project_updates WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(a.p.id);
    let hours = null;
    if (a.s.hours !== 'off' || !a.client) {
      const [from, to] = monthWindow(thisMonth());
      hours = { month: thisMonth(), secs: worked(a.p.id, from, to).reduce((n, x) => n + x.secs, 0), retainer_hours: a.c.retainer_hours };
    }
    // what happened, latest first
    const feed = [];
    for (const t of tasks.filter((x) => x.status === 'done' && x.completed_at).sort((x, y) => (x.completed_at < y.completed_at ? 1 : -1)).slice(0, 6)) {
      const ev = db.prepare("SELECT user_id FROM task_events WHERE task_id = ? AND kind IN ('status','approved') ORDER BY at DESC LIMIT 1").get(t.id);
      const by = db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(t.id);
      feed.push({ kind: 'done', at: t.completed_at, who: a.s.people || !a.client ? staffName((by && by.assignee_id) || (ev && ev.user_id)) : null, title: t.title, task_id: t.id });
    }
    if (!a.client || a.s.approvals) for (const x of db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC LIMIT 4').all(a.p.id)) feed.push({ kind: x.kind === 'file' ? 'file_ask' : 'approval', at: x.created_at, who: staffName(x.created_by), title: x.title, approval_id: x.id });
    for (const m of milestones.filter((x) => x.done_at)) feed.push({ kind: 'milestone', at: m.done_at, title: m.title });
    const g = db.prepare("SELECT id FROM chat_threads WHERE project_id = ? AND kind = 'group'").get(a.p.id);
    if (g && (a.s.messages || !a.client)) for (const m of db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND file IS NOT NULL AND voice_secs IS NULL AND team_only = 0 AND deleted_at IS NULL ORDER BY id DESC LIMIT 4').all(g.id)) {
      feed.push({ kind: 'file', at: m.created_at, who: m.author_kind === 'staff' ? staffName(m.author_id) : (db.prepare('SELECT name FROM client_users WHERE id = ?').get(m.author_id) || {}).name, title: m.file_name });
    }
    feed.sort((x, y) => (x.at < y.at ? 1 : -1));
    const waiting = waitingOf(a);
    return {
      project: { id: a.p.id, name: a.p.name, key: a.p.key, color: a.p.color, status: a.p.status, start_day: a.p.start_day, due_day: a.p.due_day, description: a.p.description, created_at: a.p.created_at },
      client: { id: a.c.id, name: a.c.name, tz_name: a.c.tz_name, retainer_hours: a.c.retainer_hours },
      settings: a.s, manage: a.manage, staff: !a.client,
      lead: lead ? { id: lead.id, name: lead.name, title: lead.title } : null,
      progress: { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length, pct: tasks.length ? Math.round(tasks.filter((t) => t.status === 'done').length / tasks.length * 100) : 0,
        done_week: doneWeek.map((t) => t.title), in_progress: inProg.length, due_week: inProg.filter((t) => t.due_day && t.due_day <= weekEnd).length },
      milestones: milestones.map((m) => { const mt = tasks.filter((t) => t.milestone_id === m.id); return { id: m.id, title: m.title, start_day: m.start_day, due_day: m.due_day, done_at: m.done_at, tasks_total: mt.length, tasks_done: mt.filter((t) => t.status === 'done').length }; }),
      update: upd ? updateOut(upd) : null,
      team: a.s.people || !a.client ? teamOf(a) : [],
      waiting, hours, feed: feed.slice(0, 8),
      unread: unreadFor(user, a.p.id),
      requests_new: !a.client ? db.prepare("SELECT COUNT(*) n FROM client_requests WHERE project_id = ? AND status = 'new'").get(a.p.id).n : undefined,
      my_requests: a.s.requests ? db.prepare("SELECT * FROM client_requests WHERE project_id = ? AND status != 'cancelled' ORDER BY (status IN ('new','planned')) DESC, created_at DESC LIMIT 3").all(a.p.id).map(reqOut) : [],
      ...(ctx.portalOverviewExtra ? ctx.portalOverviewExtra(user, a, { tasks, milestones, waiting }) : {}),
    };
  }, C);
  function updateOut(u) {
    const j = (v) => { try { return JSON.parse(v); } catch { return []; } };
    return { id: u.id, intro: u.intro, done: j(u.done), next: j(u.next), needed: j(u.needed), created_at: u.created_at, author: u.author_id ? { id: u.author_id, name: staffName(u.author_id) } : null };
  }

  // ---------- tasks ----------
  route('GET', '/api/portal/projects/:id/tasks', ({ user, params }) => {
    const a = access(user, params.id);
    const rows = db.prepare(`SELECT t.*, u.name AS assignee_name, u.title AS assignee_title FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = ? AND ${a.client ? visibleSql(a.s) : '1'} ORDER BY t.position, t.id`).all(a.p.id);
    const cc = new Map(db.prepare(`SELECT task_id, COUNT(*) n FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?) ${a.client ? 'AND team_only = 0' : ''} GROUP BY task_id`).all(a.p.id).map((r) => [r.task_id, r.n]));
    const fc = new Map(db.prepare('SELECT task_id, COUNT(*) n FROM task_files WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?) GROUP BY task_id').all(a.p.id).map((r) => [r.task_id, r.n]));
    const steps = new Map(db.prepare('SELECT task_id, COUNT(*) n, SUM(done_at IS NOT NULL) d FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?) GROUP BY task_id').all(a.p.id).map((r) => [r.task_id, { total: r.n, done: r.d }]));
    return rows.map((t) => ({ id: t.id, ref: `${a.p.key}-${t.number}`, title: t.title, status: STATUS[t.status], due_day: t.due_day, completed_at: t.completed_at,
      assignee: (a.s.people || !a.client) && t.assignee_id ? { id: t.assignee_id, name: t.assignee_name, title: t.assignee_title } : null,
      comments: cc.get(t.id) || 0, files: a.s.files || !a.client ? fc.get(t.id) || 0 : 0, client_visible: a.client ? undefined : t.client_visible, shared: taskVisible(t, a.s),
      milestone_id: t.milestone_id || null, steps: steps.get(t.id) || null }));
  }, C);
  function taskFor(user, id) {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
    need(t && t.project_id, 404, 'Task not found');
    const a = access(user, t.project_id);
    if (a.client) need(taskVisible(t, a.s), 404, 'Task not found');
    return { t, a };
  }
  const commentsOf = (t, client) => db.prepare(`SELECT c.id, c.user_id, c.client_user_id, c.body, c.team_only, c.created_at, c.file, c.file_name, c.file_type, c.file_size, u.name AS staff_name, cu.name AS client_name
      FROM task_comments c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN client_users cu ON cu.id = c.client_user_id WHERE c.task_id = ? ${client ? 'AND c.team_only = 0' : ''} ORDER BY c.created_at, c.id`).all(t.id)
    .map((c) => ({ id: c.id, body: c.body, team_only: !!c.team_only, created_at: c.created_at, author: c.client_user_id ? { kind: 'client', id: c.client_user_id, name: c.client_name || 'Client' } : { kind: 'staff', id: c.user_id, name: c.staff_name || 'Someone' },
      file: c.file ? { name: c.file_name, type: c.file_type, size: c.file_size, url: `/api/portal/comment-files/${c.id}` } : null }));
  ctx.portalComments = commentsOf;
  route('GET', '/api/portal/tasks/:id', ({ user, params }) => {
    const { t, a } = taskFor(user, params.id);
    const as = t.assignee_id ? db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(t.assignee_id) : null;
    let secs = null;
    if (a.s.hours === 'task' || !a.client) secs = worked(a.p.id, 0, clockNow() + 1).filter((x) => x.task_id === t.id).reduce((n, x) => n + x.secs, 0);
    return { id: t.id, ref: `${a.p.key}-${t.number}`, title: t.title, description: t.description, status: STATUS[t.status], due_day: t.due_day, completed_at: t.completed_at, project_id: a.p.id,
      assignee: (a.s.people || !a.client) && as ? as : null, secs,
      files: a.s.files || !a.client ? db.prepare('SELECT id, name, mime, size, created_at FROM task_files WHERE task_id = ? ORDER BY id').all(t.id) : [],
      comments: commentsOf(t, a.client), can_comment: true, milestone_id: t.milestone_id || null, start_day: t.created_at ? t.created_at.slice(0, 10) : null,
      steps: db.prepare('SELECT id, title, done_at FROM task_steps WHERE task_id = ? ORDER BY position, id').all(t.id).map((x) => ({ id: x.id, title: x.title, done: !!x.done_at, done_at: x.done_at })),
      milestone: t.milestone_id ? (db.prepare('SELECT id, title FROM milestones WHERE id = ? AND project_id = ?').get(t.milestone_id, a.p.id) || null) : null };
  }, C);
  route('GET', '/api/portal/tasks/:id/files/:fid', ({ user, params }) => {
    const { t, a } = taskFor(user, params.id);
    need(a.s.files || !a.client, 403, 'Files are not shared');
    const f = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(params.fid), t.id);
    need(f, 404, 'File not found');
    // only pictures, PDFs and audio open in the browser; anything else downloads, so an uploaded page can't run here
    const safe = /^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/[\w.+-]+)$/.test(f.mime || '');
    return { raw: fs.readFileSync(path.join(cfg.dataDir, 'files', f.file)), type: safe ? f.mime : 'application/octet-stream', headers: { 'Content-Disposition': `${safe ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\w. -]/g, '_')}"`, 'Cache-Control': 'private, no-store' } };
  }, C);
  route('GET', '/api/portal/comment-files/:id', ({ user, params }) => {
    const c = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(Number(params.id));
    need(c && c.file, 404, 'File not found');
    const { a } = taskFor(user, c.task_id);
    if (a.client) need(!c.team_only, 404, 'File not found');
    return sendFile(c.file, c.file_type, c.file_name);
  }, C);
  route('POST', '/api/portal/tasks/:id/comments', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'Staff comment on the task itself');
    const { t, a } = taskFor(user, params.id);
    const f = body.file_base64 ? saveFile(body.file_base64, body.file_type, body.file_name) : null;
    const text = f ? (optStr(body.body, 'body', 4000) || '') : str(body.body, 'body', 4000);
    const id = Number(db.prepare('INSERT INTO task_comments (task_id, user_id, client_user_id, body, file, file_name, file_type, file_size, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(t.id, null, user.id, text, f && f.file, f && f.file_name, f && f.file_type, f && f.file_size, nowIso()).lastInsertRowid);
    if (ctx.notify) ctx.notify.notify([t.assignee_id, a.p.lead_id], { kind: 'client_message', title: `${user.name} (${a.c.name}) commented on ${a.p.key}-${t.number}`, body: (text || (f ? `Sent ${f.file_name}` : '')).slice(0, 200), link: `#/tasks?task=${t.id}` });
    emit('tasks', t.assignee_id);
    emitPortal(a.p, 'portal_task', { task_id: t.id });
    return { id };
  }, C);

  // ---------- requests ----------
  const REQ_KINDS = ['change', 'new', 'problem'];
  const reqOut = (r) => {
    const t = r.task_id ? db.prepare('SELECT id, number, status, title, project_id FROM tasks WHERE id = ?').get(r.task_id) : null;
    const key = t ? (ctx.getProject(t.project_id) || {}).key : null;
    return { id: r.id, project_id: r.project_id, task_id: r.task_id, title: r.title, detail: r.detail, kind: r.kind || 'new', urgency: r.urgency, status: r.status, reply: r.reply, created_at: r.created_at, decided_at: r.decided_at,
      by: r.client_user_id ? (db.prepare('SELECT name FROM client_users WHERE id = ?').get(r.client_user_id) || {}).name : null,
      decided_by_name: r.decided_by ? staffName(r.decided_by) : null,
      seen_at: r.seen_at, seen_by_name: r.seen_by ? staffName(r.seen_by) : null,
      file: r.file ? { name: r.file_name, type: r.file_type, size: r.file_size, url: `/api/portal/request-files/${r.id}` } : null,
      task: t ? { id: t.id, ref: `${key}-${t.number}`, status: STATUS[t.status], title: t.title } : null,
      estimate: r.estimate_at ? { hours: r.estimate_hours, note: r.estimate_note, by: r.estimate_by ? staffName(r.estimate_by) : null, at: r.estimate_at, answer: r.estimate_answer, answered_at: r.answered_at } : null,
      edited_at: r.edited_at, cancelled_at: r.cancelled_at,
      messages: db.prepare('SELECT COUNT(*) n FROM request_messages WHERE request_id = ?').get(r.id).n };
  };
  ctx.portalReqOut = (r) => reqOut(r);
  route('GET', '/api/portal/projects/:id/requests', ({ user, params }) => {
    const a = access(user, params.id);
    // the first time someone who can answer opens the list, the client sees their request was seen
    if (a.manage) {
      const n = db.prepare("UPDATE client_requests SET seen_at = ?, seen_by = ? WHERE project_id = ? AND seen_at IS NULL").run(nowIso(), user.id, a.p.id).changes;
      if (n) emitPortal(a.p, 'portal');
    }
    return db.prepare("SELECT * FROM client_requests WHERE project_id = ? ORDER BY (status = 'new') DESC, created_at DESC").all(a.p.id).map(reqOut);
  }, C);
  route('GET', '/api/portal/request-files/:id', ({ user, params }) => {
    const r = db.prepare('SELECT * FROM client_requests WHERE id = ?').get(Number(params.id));
    need(r && r.file, 404, 'File not found');
    access(user, r.project_id);
    return sendFile(r.file, r.file_type, r.file_name);
  }, C);
  route('POST', '/api/portal/projects/:id/requests', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'Requests come from the client');
    const a = access(user, params.id);
    need(a.s.requests, 403, 'Requests are switched off for this project');
    const urgency = URGENCY.includes(body.urgency) ? body.urgency : 'month';
    const kind = REQ_KINDS.includes(body.kind) ? body.kind : 'new';
    const f = body.file_base64 ? saveFile(body.file_base64, body.file_type, body.file_name) : null;
    const id = Number(db.prepare('INSERT INTO client_requests (project_id, client_user_id, title, detail, urgency, kind, file, file_name, file_type, file_size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(a.p.id, user.id, str(body.title, 'title', 200), optStr(body.detail, 'detail', 2000), urgency, kind, f && f.file, f && f.file_name, f && f.file_type, f && f.file_size, nowIso()).lastInsertRowid);
    if (ctx.notify) ctx.notify.notify([a.p.lead_id, ...ctx.managersOf(-1)], { kind: 'client_request', title: `New request from ${user.name} (${a.c.name})`, body: body.title, link: `#/project?id=${a.p.id}&tab=client` });
    emitPortal(a.p, 'portal');
    return reqOut(db.prepare('SELECT * FROM client_requests WHERE id = ?').get(id));
  }, C);
  route('POST', '/api/portal/requests/:id/decide', ({ user, params, body }) => {
    const r = db.prepare('SELECT * FROM client_requests WHERE id = ?').get(Number(params.id));
    need(r, 404, 'Request not found');
    const a = access(user, r.project_id);
    needManage(a);
    need(['planned', 'done', 'declined'].includes(body.status), 400, 'status must be planned, done or declined');
    const reply = optStr(body.reply, 'reply', 1000);
    need(body.status !== 'declined' || reply, 400, 'Say why, so they understand');
    need(!body.assignee_id || ctx.isProjectMember(a.p.id, Number(body.assignee_id)), 400, 'That person is not on this project');
    let taskId = r.task_id;
    if (body.status === 'planned' && !taskId && body.make_task !== false) {
      const number = ctx.nextTaskNumber(a.p.id);
      taskId = Number(db.prepare("INSERT INTO tasks (title, description, project_id, assignee_id, created_by, status, due_day, client_visible, number, position, created_at) VALUES (?,?,?,?,?, 'todo', ?, 1, ?, ?, ?)")
        .run(r.title, r.detail, a.p.id, body.assignee_id ? Number(body.assignee_id) : null, user.id, body.due_day || null, number, clockNow(), nowIso()).lastInsertRowid);
      emit('tasks');
    }
    db.prepare('UPDATE client_requests SET status = ?, reply = ?, task_id = ?, decided_by = ?, decided_at = ?, seen_at = COALESCE(seen_at, ?), seen_by = COALESCE(seen_by, ?) WHERE id = ?').run(body.status, reply, taskId, user.id, nowIso(), nowIso(), user.id, r.id);
    audit(user, 'client.request', null, `${r.title}: ${body.status}`);
    if (ctx.pnotify) ctx.pnotify.notifyClient(r.client_user_id ? [r.client_user_id] : ctx.pnotify.clientsOf(a.p), { kind: 'request_reply', project_id: a.p.id, link: `#/requests?p=${a.p.id}&r=${r.id}`, actor: user,
      title: body.status === 'planned' ? `${user.name.split(' ')[0]} took on “${r.title}”` : body.status === 'done' ? `“${r.title}” is done` : `${user.name.split(' ')[0]} replied to “${r.title}”`, body: reply });
    emitPortal(a.p, 'portal');
    return reqOut(db.prepare('SELECT * FROM client_requests WHERE id = ?').get(r.id));
  }, C);

  // ---------- approvals and files asked for ----------
  const verOut = (v) => ({ id: v.id, n: v.n, body: v.body, changes: v.changes, file: v.file ? { name: v.file_name, type: v.file_type, size: v.file_size } : null, created_at: v.created_at,
    by: v.by_kind === 'client' ? (db.prepare('SELECT name FROM client_users WHERE id = ?').get(v.by_id) || {}).name : staffName(v.by_id), by_kind: v.by_kind,
    decision: v.decision, decision_note: v.decision_note, decided_at: v.decided_at, decided_by: v.decided_by ? (db.prepare('SELECT name FROM client_users WHERE id = ?').get(v.decided_by) || {}).name : null,
    pins: db.prepare('SELECT * FROM approval_pins WHERE version_id = ? ORDER BY id').all(v.id).map((p, i) => ({ id: p.id, n: i + 1, x: p.x, y: p.y, body: p.body, created_at: p.created_at, resolved: !!p.resolved_at,
      author: { kind: p.author_kind, id: p.author_id, name: p.author_kind === 'client' ? (db.prepare('SELECT name FROM client_users WHERE id = ?').get(p.author_id) || {}).name || 'Client' : staffName(p.author_id) } })) });
  const apOut = (x) => ({ ...x, by: staffName(x.created_by), reminded_at: x.reminded_at || null, versions: db.prepare('SELECT * FROM approval_versions WHERE approval_id = ? ORDER BY n').all(x.id).map(verOut) });
  route('GET', '/api/portal/projects/:id/approvals', ({ user, params }) => {
    const a = access(user, params.id);
    if (a.client) need(a.s.approvals, 403, 'Approvals are switched off for this project');
    return db.prepare("SELECT * FROM approvals WHERE project_id = ? ORDER BY (status IN ('waiting','changes')) DESC, created_at DESC").all(a.p.id).map(apOut);
  }, C);
  route('POST', '/api/portal/projects/:id/approvals', ({ user, params, body }) => {
    need(user.kind !== 'client', 403, 'The team asks for approvals');
    const a = access(user, params.id);
    const kind = body.kind === 'file' ? 'file' : 'approval';
    const f = body.file_base64 ? saveFile(body.file_base64, body.file_type, body.file_name) : null;
    need(kind === 'file' || body.body || f, 400, 'Add what they are approving: some text, a file, or both');
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO approvals (project_id, kind, title, description, due_day, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(a.p.id, kind, str(body.title, 'title', 200), optStr(body.description, 'description', 2000), body.due_day && T.isDay(body.due_day) ? body.due_day : null, user.id, now).lastInsertRowid);
    if (kind === 'approval') db.prepare('INSERT INTO approval_versions (approval_id, n, body, changes, file, file_name, file_type, file_size, by_kind, by_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 1, optStr(body.body, 'body', 8000), null, f && f.file, f && f.file_name, f && f.file_type, f && f.file_size, 'staff', user.id, now);
    audit(user, 'client.approval_asked', null, `${body.title} (${a.c.name})`);
    if (ctx.pnotify) ctx.pnotify.toProject(a.p, { kind: kind === 'file' ? 'file_asked' : 'approval_asked', link: `#/approvals?p=${a.p.id}&a=${id}`, actor: user,
      title: kind === 'file' ? `${user.name.split(' ')[0]} asked you for ${body.title}` : `${user.name.split(' ')[0]} asked you to approve ${body.title}`, body: optStr(body.description, 'description', 2000) }, { approvers: kind === 'approval' && db.prepare('SELECT 1 FROM client_users WHERE client_id = ? AND can_approve = 1 AND active = 1').get(a.c.id) != null });
    emitPortal(a.p, 'portal');
    return apOut(db.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
  }, C);
  route('POST', '/api/portal/approvals/:id/versions', ({ user, params, body }) => {
    need(user.kind !== 'client', 403, 'The team sends new versions');
    const x = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(params.id));
    need(x && x.kind === 'approval', 404, 'Approval not found');
    const a = access(user, x.project_id);
    need(x.status !== 'approved', 409, 'This was approved already');
    const f = body.file_base64 ? saveFile(body.file_base64, body.file_type, body.file_name) : null;
    need(body.body || f, 400, 'Add the new version: some text, a file, or both');
    const n = db.prepare('SELECT MAX(n) n FROM approval_versions WHERE approval_id = ?').get(x.id).n + 1;
    db.prepare('INSERT INTO approval_versions (approval_id, n, body, changes, file, file_name, file_type, file_size, by_kind, by_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(x.id, n, optStr(body.body, 'body', 8000), optStr(body.changes, 'changes', 2000), f && f.file, f && f.file_name, f && f.file_type, f && f.file_size, 'staff', user.id, nowIso());
    db.prepare("UPDATE approvals SET status = 'waiting', reminded_at = NULL WHERE id = ?").run(x.id);
    if (ctx.pnotify) ctx.pnotify.toProject(a.p, { kind: 'approval_version', link: `#/approvals?p=${a.p.id}&a=${x.id}`, actor: user, title: `Version ${n} of ${x.title} is ready for you`, body: optStr(body.changes, 'changes', 2000) });
    emitPortal(a.p, 'portal');
    return apOut(db.prepare('SELECT * FROM approvals WHERE id = ?').get(x.id));
  }, C);
  route('POST', '/api/portal/approvals/:id/decide', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'Only the client approves');
    const x = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(params.id));
    need(x && x.kind === 'approval', 404, 'Approval not found');
    const a = access(user, x.project_id);
    need(a.s.approvals, 403, 'Approvals are switched off for this project');
    need(user.can_approve, 403, 'Someone else at your company approves these');
    need(['approved', 'changes'].includes(body.decision), 400, 'decision must be approved or changes');
    const note = optStr(body.note, 'note', 2000);
    need(body.decision === 'approved' || note, 400, 'Tell the team what to change');
    const v = db.prepare('SELECT * FROM approval_versions WHERE approval_id = ? ORDER BY n DESC LIMIT 1').get(x.id);
    need(v && !v.decision, 409, 'This version was answered already');
    db.prepare('UPDATE approval_versions SET decision = ?, decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(body.decision, note, user.id, nowIso(), v.id);
    db.prepare('UPDATE approvals SET status = ?, closed_at = ? WHERE id = ?').run(body.decision === 'approved' ? 'approved' : 'changes', body.decision === 'approved' ? nowIso() : null, x.id);
    if (ctx.notify) ctx.notify.notify([x.created_by, a.p.lead_id], { kind: 'client_approval', title: body.decision === 'approved' ? `${user.name} approved ${x.title}` : `${user.name} asked for changes to ${x.title}`, body: note, link: `#/project?id=${a.p.id}&tab=client` });
    audit(null, 'client.approval_decided', null, `${user.name} (${a.c.name}): ${x.title} v${v.n} ${body.decision}`);
    emitPortal(a.p, 'portal');
    return apOut(db.prepare('SELECT * FROM approvals WHERE id = ?').get(x.id));
  }, C);
  // a file the team asked for: the client sends it
  route('POST', '/api/portal/approvals/:id/upload', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'The client sends this');
    const x = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(params.id));
    need(x && x.kind === 'file', 404, 'Not found');
    const a = access(user, x.project_id);
    need(a.s.approvals, 403, 'Approvals are switched off for this project');
    const f = saveFile(body.file_base64, body.file_type, body.file_name);
    const n = (db.prepare('SELECT MAX(n) n FROM approval_versions WHERE approval_id = ?').get(x.id).n || 0) + 1;
    db.prepare('INSERT INTO approval_versions (approval_id, n, body, file, file_name, file_type, file_size, by_kind, by_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(x.id, n, optStr(body.note, 'note', 2000), f.file, f.file_name, f.file_type, f.file_size, 'client', user.id, nowIso());
    db.prepare("UPDATE approvals SET status = 'received', closed_at = ? WHERE id = ?").run(nowIso(), x.id);
    if (ctx.notify) ctx.notify.notify([x.created_by, a.p.lead_id], { kind: 'client_approval', title: `${user.name} sent ${f.file_name}`, body: x.title, link: `#/project?id=${a.p.id}&tab=client` });
    emitPortal(a.p, 'portal');
    return apOut(db.prepare('SELECT * FROM approvals WHERE id = ?').get(x.id));
  }, C);
  route('DELETE', '/api/portal/approvals/:id', ({ user, params }) => {
    need(user.kind !== 'client', 403, 'Not allowed');
    const x = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(params.id));
    need(x, 404, 'Not found');
    const a = access(user, x.project_id);
    need(a.manage || x.created_by === user.id, 403, 'Only the person who asked, the lead or a manager can remove this');
    db.prepare('DELETE FROM approvals WHERE id = ?').run(x.id);
    emitPortal(a.p, 'portal');
    return { ok: true };
  }, C);
  route('GET', '/api/portal/approval-files/:vid', ({ user, params }) => {
    const v = db.prepare('SELECT * FROM approval_versions WHERE id = ?').get(Number(params.vid));
    need(v && v.file, 404, 'File not found');
    const x = db.prepare('SELECT * FROM approvals WHERE id = ?').get(v.approval_id);
    const a = access(user, x.project_id);
    if (a.client) need(a.s.approvals, 403, 'Approvals are switched off for this project');
    return sendFile(v.file, v.file_type, v.file_name);
  }, C);

  // ---------- milestones ----------
  route('PUT', '/api/portal/projects/:id/milestones', ({ user, params, body }) => {
    const a = access(user, params.id);
    needManage(a);
    need(Array.isArray(body.milestones) && body.milestones.length <= 20, 400, 'milestones must be a list');
    const keep = new Set(), newlyDone = [];
    body.milestones.forEach((m, i) => {
      const title = str(m.title, 'title', 120);
      const start = m.start_day && T.isDay(m.start_day) ? m.start_day : null, due = m.due_day && T.isDay(m.due_day) ? m.due_day : null;
      const ex = m.id ? db.prepare('SELECT * FROM milestones WHERE id = ? AND project_id = ?').get(Number(m.id), a.p.id) : null;
      const doneAt = m.done ? (ex && ex.done_at) || nowIso() : null;
      if (doneAt && !(ex && ex.done_at) && ctx.pnotify) newlyDone.push(title);
      if (ex) { db.prepare('UPDATE milestones SET title = ?, start_day = ?, due_day = ?, done_at = ?, position = ? WHERE id = ?').run(title, start, due, doneAt, i, ex.id); keep.add(ex.id); }
      else keep.add(Number(db.prepare('INSERT INTO milestones (project_id, title, start_day, due_day, done_at, position) VALUES (?,?,?,?,?,?)').run(a.p.id, title, start, due, doneAt, i).lastInsertRowid));
    });
    for (const m of db.prepare('SELECT id FROM milestones WHERE project_id = ?').all(a.p.id)) if (!keep.has(m.id)) { db.prepare('UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?').run(m.id); db.prepare('DELETE FROM milestones WHERE id = ?').run(m.id); }
    for (const t of newlyDone) ctx.pnotify.toProject(a.p, { kind: 'milestone_done', link: `#/overview?p=${a.p.id}`, actor: user, title: `${t} is done`, body: 'How did it go? Tell the team in a tap on your overview.' });
    emitPortal(a.p, 'portal');
    return db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY position, id').all(a.p.id);
  }, C);

  // ---------- the weekly update ----------
  route('GET', '/api/portal/projects/:id/updates', ({ user, params }) => {
    const a = access(user, params.id);
    return db.prepare('SELECT * FROM project_updates WHERE project_id = ? ORDER BY id DESC LIMIT 20').all(a.p.id).map(updateOut);
  }, C);
  // a draft from what Staffwarden already knows: finished this week, due next week, waiting on the client
  route('GET', '/api/portal/projects/:id/update-draft', ({ user, params }) => {
    need(user.kind !== 'client', 403, 'Not allowed');
    const a = access(user, params.id);
    const vis = visibleSql(a.s), weekAgo = new Date(clockNow() - 7 * 86400000).toISOString(), weekEnd = T.addDays(ctx.calc.companyToday(), 7);
    const done = db.prepare(`SELECT t.title FROM tasks t WHERE t.project_id = ? AND ${vis} AND t.status = 'done' AND t.completed_at >= ? ORDER BY t.completed_at`).all(a.p.id, weekAgo).map((r) => r.title);
    const next = db.prepare(`SELECT t.title FROM tasks t WHERE t.project_id = ? AND ${vis} AND t.status != 'done' AND (t.status IN ('in_progress','in_review') OR (t.due_day IS NOT NULL AND t.due_day <= ?)) ORDER BY t.due_day IS NULL, t.due_day LIMIT 8`).all(a.p.id, weekEnd).map((r) => r.title);
    const needed = waitingOf(a).map((w) => w.title);
    return { done, next, needed };
  }, C);
  ctx.portalDraft = (a) => {
    const vis = visibleSql(a.s), weekAgo = new Date(clockNow() - 7 * 86400000).toISOString(), weekEnd = T.addDays(ctx.calc.companyToday(), 7);
    return { done: db.prepare(`SELECT t.title FROM tasks t WHERE t.project_id = ? AND ${vis} AND t.status = 'done' AND t.completed_at >= ? ORDER BY t.completed_at`).all(a.p.id, weekAgo).map((r) => r.title),
      next: db.prepare(`SELECT t.title FROM tasks t WHERE t.project_id = ? AND ${vis} AND t.status != 'done' AND (t.status IN ('in_progress','in_review') OR (t.due_day IS NOT NULL AND t.due_day <= ?)) ORDER BY t.due_day IS NULL, t.due_day LIMIT 8`).all(a.p.id, weekEnd).map((r) => r.title),
      needed: waitingOf(a).map((w) => w.title) };
  };
  route('POST', '/api/portal/projects/:id/updates', ({ user, params, body }) => {
    need(user.kind !== 'client', 403, 'Not allowed');
    const a = access(user, params.id);
    needManage(a);
    const list = (v, k) => { need(v == null || (Array.isArray(v) && v.length <= 20), 400, `${k} must be a list`); return (v || []).map((x) => str(String(x), k, 200)); };
    const intro = str(body.intro, 'intro', 3000);
    return postUpdate(a, user, { intro, done: list(body.done, 'done'), next: list(body.next, 'next'), needed: list(body.needed, 'needed') });
  }, C);
  // posting the update: kept, pinned in the group chat (so it is the first thing in Messages too) and sent to the client
  function postUpdate(a, user, { intro, done, next, needed }) {
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO project_updates (project_id, author_id, intro, done, next, needed, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(a.p.id, user.id, intro, JSON.stringify(done), JSON.stringify(next), JSON.stringify(needed), now).lastInsertRowid);
    const g = ctx.groupThread(a.p.id);
    db.prepare('UPDATE chat_messages SET pinned = 0 WHERE thread_id = ?').run(g.id);
    db.prepare("INSERT INTO chat_messages (thread_id, author_kind, author_id, body, pinned, created_at) VALUES (?, 'staff', ?, ?, 1, ?)").run(g.id, user.id, `Weekly update: ${intro}`.slice(0, 4000), now);
    audit(user, 'client.update_posted', null, `${a.p.name} (${a.c.name})`);
    if (ctx.pnotify) ctx.pnotify.toProject(a.p, { kind: 'update_posted', link: `#/overview?p=${a.p.id}`, actor: user, title: `${user.name.split(' ')[0]} posted this week’s update`, body: intro.slice(0, 200) });
    emitPortal(a.p, 'portal');
    emitPortal(a.p, 'chat', { thread_id: g.id });
    return updateOut(db.prepare('SELECT * FROM project_updates WHERE id = ?').get(id));
  }
  ctx.portalPostUpdate = postUpdate;
  ctx.portalWaitingOf = (a) => waitingOf(a);

  // ---------- hours ----------
  route('GET', '/api/portal/projects/:id/hours', ({ user, params, query }) => {
    const a = access(user, params.id);
    const mode = a.client ? a.s.hours : 'task';
    need(mode !== 'off', 403, 'Hours are not shared for this project');
    const named = !a.client || a.s.people;   // who logged the hours, only if the client sees who is on what
    const month = /^\d{4}-\d{2}$/.test(query.get('month') || '') ? query.get('month') : thisMonth();
    const [from, to, nx] = monthWindow(month);
    const rows = worked(a.p.id, from, to);
    const total = rows.reduce((n, x) => n + x.secs, 0);
    // weeks Monday to Sunday, cut at the month's edges
    const weeks = [];
    let d = `${month}-01`;
    while (d < nx) {
      const end = T.addDays(T.mondayOf(d), 6) < nx ? T.addDays(T.mondayOf(d), 6) : T.addDays(nx, -1);
      const s0 = T.dayStartMs(d, tz()), s1 = T.dayStartMs(T.addDays(end, 1), tz());
      weeks.push({ from: d, to: end, secs: rows.filter((x) => x.start >= s0 && x.start < s1).reduce((n, x) => n + x.secs, 0) });
      d = T.addDays(end, 1);
    }
    const out = { month, mode, total_secs: total, retainer_hours: a.c.retainer_hours, weeks, today: T.localDay(clockNow(), tz()) };
    const months = db.prepare('SELECT MIN(started_at) s FROM time_entries WHERE project_id = ?').get(a.p.id).s;
    out.first_month = months ? T.localDay(Date.parse(months), tz()).slice(0, 7) : month;
    if ((mode === 'person' || mode === 'task') && named) {
      const per = new Map();
      for (const x of rows) per.set(x.user_id, (per.get(x.user_id) || 0) + x.secs);
      out.people = [...per].map(([id, secs]) => { const u = db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(id) || { id, name: 'Someone' }; return { id, name: u.name, title: u.title, secs }; }).sort((p, q) => q.secs - p.secs);
    }
    if (mode === 'task') {
      const per = new Map();
      for (const x of rows) { const k = x.task_id || 0; if (!per.has(k)) per.set(k, { secs: 0, by: new Map() }); const e = per.get(k); e.secs += x.secs; e.by.set(x.user_id, (e.by.get(x.user_id) || 0) + x.secs); }
      const tasks = [];
      let other = 0, otherN = 0;
      for (const [tid, e] of per) {
        const t = tid ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(tid) : null;
        if (!t || (a.client && !taskVisible(t, a.s))) { other += e.secs; otherN += t ? 1 : 0; continue; }
        const main = [...e.by].sort((p, q) => q[1] - p[1])[0][0];
        tasks.push({ id: t.id, title: t.title, secs: e.secs, mainly: named ? staffName(main).split(' ')[0] : null });
      }
      tasks.sort((p, q) => q.secs - p.secs);
      out.tasks = tasks.slice(0, 8);
      const rest = tasks.slice(8).reduce((n, t) => n + t.secs, 0) + other;
      out.other = rest ? { secs: rest, tasks: Math.max(0, tasks.length - 8) + otherN } : null;
    }
    return out;
  }, C);

  // a CSV of the month, the same numbers the page shows
  route('GET', '/api/portal/projects/:id/hours.csv', ({ user, params, query }) => {
    const a = access(user, params.id);
    const mode = a.client ? a.s.hours : 'task';
    need(mode !== 'off', 403, 'Hours are not shared for this project');
    const named = !a.client || a.s.people;
    const month = /^\d{4}-\d{2}$/.test(query.get('month') || '') ? query.get('month') : thisMonth();
    const [from, to] = monthWindow(month);
    const rows = worked(a.p.id, from, to);
    // a cell that starts like a formula is shown as text, so a task named "=HYPERLINK(…)" can't run in a spreadsheet
    const q = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return `"${x.replace(/"/g, '""')}"`; };
    const who = (id) => (named ? staffName(id) : 'The team');
    const lines = [['Day', ...(mode === 'total' ? [] : ['Person']), ...(mode === 'task' ? ['Task'] : []), 'Hours'].map(q).join(',')];
    const agg = new Map();
    for (const x of rows) {
      const day = T.localDay(x.start, tz());
      const t = x.task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(x.task_id) : null;
      const tname = t && (!a.client || taskVisible(t, a.s)) ? t.title : 'Other work on the project';
      const key = [day, mode === 'total' ? '' : who(x.user_id), mode === 'task' ? tname : ''].join('\u0001');
      agg.set(key, (agg.get(key) || 0) + x.secs);
    }
    for (const [k, secs] of [...agg].sort()) { const [day, person, task] = k.split('\u0001'); lines.push([day, ...(mode === 'total' ? [] : [person]), ...(mode === 'task' ? [task] : []), (secs / 3600).toFixed(2)].map(q).join(',')); }
    return { raw: lines.join('\n') + '\n', type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${a.p.key}-hours-${month}.csv"`, 'Cache-Control': 'private, no-store' } };
  }, C);

  // ---------- files in one place ----------
  route('GET', '/api/portal/projects/:id/files', ({ user, params }) => {
    const a = access(user, params.id);
    const out = [];
    const g = db.prepare("SELECT id FROM chat_threads WHERE project_id = ? AND kind = 'group'").get(a.p.id);
    if (g && (a.s.messages || !a.client)) for (const m of db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? AND file IS NOT NULL AND deleted_at IS NULL ${a.client ? 'AND team_only = 0' : ''} ORDER BY id DESC LIMIT 100`).all(g.id)) {
      out.push({ where: 'chat', name: m.file_name, type: m.file_type, size: m.file_size, at: m.created_at, voice: m.voice_secs != null, url: `/api/chat/files/${m.id}`, by: m.author_kind === 'staff' ? staffName(m.author_id) : (db.prepare('SELECT name FROM client_users WHERE id = ?').get(m.author_id) || {}).name });
    }
    if (!a.client || a.s.approvals) for (const v of db.prepare('SELECT v.*, x.title FROM approval_versions v JOIN approvals x ON x.id = v.approval_id WHERE x.project_id = ? AND v.file IS NOT NULL ORDER BY v.id DESC').all(a.p.id)) {
      out.push({ where: 'approval', name: v.file_name, type: v.file_type, size: v.file_size, at: v.created_at, about: v.title, url: `/api/portal/approval-files/${v.id}`, by: verOut(v).by });
    }
    if (a.s.files || !a.client) for (const f of db.prepare(`SELECT f.*, t.title, t.client_visible, u.name AS by_name FROM task_files f JOIN tasks t ON t.id = f.task_id LEFT JOIN users u ON u.id = f.user_id WHERE t.project_id = ? ORDER BY f.id DESC`).all(a.p.id)) {
      if (a.client && !taskVisible(f, a.s)) continue;
      out.push({ where: 'task', name: f.name, type: f.mime, size: f.size, at: f.created_at, about: f.title, url: `/api/portal/tasks/${f.task_id}/files/${f.id}`, by: f.by_name });
    }
    return out.filter((f) => !f.voice).sort((p, q) => (p.at < q.at ? 1 : -1));
  }, C);
};
