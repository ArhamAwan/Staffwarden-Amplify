'use strict';
const { need, str, optStr } = require('../lib/http');

// The team's own chat, like WhatsApp for work: one chat with everyone at the company, channels anyone
// can join (or private ones), small groups and direct messages. The messages themselves go through the
// chat routes (/api/chat/threads/:id/...), the same ones the client chats use; this file lists the
// chats a person has, starts new ones, manages who is in them and mutes, and turns a message into a task.
module.exports = (ctx) => {
  const { db, route, nowIso, clockNow, isManager, audit } = ctx;
  const staffOnly = (user) => need(user.kind !== 'client', 404, 'Not found');

  // the company chat exists once, and everyone active is in it
  function companyThread() {
    let th = db.prepare("SELECT * FROM chat_threads WHERE project_id IS NULL AND kind = 'company'").get();
    if (!th) {
      const id = Number(db.prepare("INSERT INTO chat_threads (kind, name, post_policy, created_at) VALUES ('company', NULL, 'all', ?)").run(nowIso()).lastInsertRowid);
      th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
    }
    return th;
  }
  ctx.companyThread = companyThread;
  function announcementsThread() {
    let th = db.prepare("SELECT * FROM chat_threads WHERE project_id IS NULL AND kind = 'channel' AND dm_key = 'announcements'").get();
    if (!th) {
      const id = Number(db.prepare("INSERT INTO chat_threads (kind, name, topic, post_policy, dm_key, created_at) VALUES ('channel', 'announcements', 'From the owner to everyone', 'managers', 'announcements', ?)").run(nowIso()).lastInsertRowid);
      th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
    }
    // everyone is in it, always
    const ins = db.prepare("INSERT OR IGNORE INTO team_members (thread_id, user_id, joined_at) VALUES (?,?,?)");
    for (const u of db.prepare('SELECT id FROM users WHERE active = 1').all()) ins.run(th.id, u.id, nowIso());
    return th;
  }
  ctx.announcementsThread = announcementsThread;

  const person = (id) => { const u = db.prepare('SELECT id, name, title, fun_mode FROM users WHERE id = ?').get(id); return u ? { kind: 'staff', id: u.id, name: u.name, title: u.title } : { kind: 'staff', id, name: 'Someone' }; };
  function summary(th, user) {
    const r = db.prepare("SELECT last_id FROM chat_reads WHERE thread_id = ? AND author_kind = 'staff' AND author_id = ?").get(th.id, user.id);
    const lastRead = r ? r.last_id : 0;
    const last = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND parent_id IS NULL ORDER BY id DESC LIMIT 1').get(th.id);
    const unread = db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE thread_id = ? AND id > ? AND deleted_at IS NULL AND NOT (author_kind = 'staff' AND author_id = ?) AND parent_id IS NULL").get(th.id, lastRead, user.id).n;
    const mentions = db.prepare('SELECT COUNT(*) n FROM chat_mentions cm JOIN chat_messages m ON m.id = cm.message_id WHERE m.thread_id = ? AND cm.user_id = ? AND m.id > ?').get(th.id, user.id, lastRead).n;
    const mem = db.prepare('SELECT * FROM team_members WHERE thread_id = ? AND user_id = ?').get(th.id, user.id);
    const mutedNow = mem && ((mem.muted_until && Date.parse(mem.muted_until) > clockNow()) || (!mem.muted_until && mem.mute !== 'none'));
    let other = null;
    if (th.kind === 'dm') { const o = db.prepare('SELECT user_id FROM team_members WHERE thread_id = ? AND user_id != ?').get(th.id, user.id); other = o ? person(o.user_id) : null; }
    return {
      id: th.id, kind: th.kind, name: ctx.teamThreadName(th, user), topic: th.topic || null, private: !!th.private, with: other,
      special: th.kind === 'company' ? 'company' : th.dm_key === 'announcements' ? 'announcements' : null,
      member: th.kind === 'company' || !!mem, muted: !!mutedNow, mute: mem ? mem.mute : 'none', muted_until: mem && mutedNow ? mem.muted_until : null, unread, mentions,
      count: th.kind === 'company' ? db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n : db.prepare('SELECT COUNT(*) n FROM team_members WHERE thread_id = ?').get(th.id).n,
      last: last ? { author: person(last.author_id), mine: last.author_id === user.id, ticks: last.author_id === user.id && last.author_kind === 'staff' && !last.deleted_at && !last.kind && ctx.chatTicks ? ctx.chatTicks(last) : null, body: last.deleted_at ? '' : last.body.split('\n')[0].slice(0, 120), kind: last.kind || null, deleted: !!last.deleted_at, file: last.file ? (last.voice_secs != null ? 'Voice message' : last.file_name) : null, at: last.created_at } : null,
      created_at: th.created_at,
    };
  }

  route('GET', '/api/team/threads', ({ user }) => {
    staffOnly(user);
    if (ctx.chatDelivered) ctx.chatDelivered(user);
    const co = companyThread(); announcementsThread();
    const mine = db.prepare("SELECT t.* FROM chat_threads t JOIN team_members tm ON tm.thread_id = t.id WHERE t.project_id IS NULL AND t.kind != 'company' AND tm.user_id = ? AND t.archived_at IS NULL").all(user.id);
    const list = [co, ...mine].map((th) => summary(th, user));
    const order = (x) => (x.special === 'company' ? 0 : x.special === 'announcements' ? 1 : 2);
    list.sort((a, b) => order(a) - order(b) || ((b.last && b.last.at) || b.created_at).localeCompare((a.last && a.last.at) || a.created_at));
    // channels anyone can join, that this person isn't in
    const open = db.prepare("SELECT t.* FROM chat_threads t WHERE t.project_id IS NULL AND t.kind = 'channel' AND t.private = 0 AND t.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.thread_id = t.id AND tm.user_id = ?)").all(user.id)
      .map((th) => ({ id: th.id, name: th.name, topic: th.topic, count: db.prepare('SELECT COUNT(*) n FROM team_members WHERE thread_id = ?').get(th.id).n }));
    const on = ctx.onlineNow().staff;
    const people = db.prepare('SELECT id, name, title FROM users WHERE active = 1 AND id != ? ORDER BY name').all(user.id).map((p) => ({ ...p, kind: 'staff', online: on.has(p.id) }));
    const unread = list.reduce((n, x) => n + (x.muted ? 0 : x.unread), 0);
    return { threads: list.map((x) => (x.with ? { ...x, with: { ...x.with, online: on.has(x.with.id) } } : x)), open, people, unread, mentions: list.reduce((n, x) => n + x.mentions, 0), online: [...on] };
  });
  // the number on the Chat button
  route('GET', '/api/team/unread', ({ user }) => {
    staffOnly(user);
    if (ctx.chatDelivered) ctx.chatDelivered(user);
    const co = companyThread();
    const ths = [co, ...db.prepare("SELECT t.* FROM chat_threads t JOIN team_members tm ON tm.thread_id = t.id WHERE t.project_id IS NULL AND t.kind != 'company' AND tm.user_id = ? AND t.archived_at IS NULL").all(user.id)];
    let unread = 0, mentions = 0;
    for (const th of ths) { const s = summary(th, user); if (!s.muted) unread += s.unread; mentions += s.mentions; }
    return { unread, mentions };
  });

  // ---------- starting chats ----------
  const addMembers = (tid, ids, role = 'member') => { const ins = db.prepare('INSERT OR IGNORE INTO team_members (thread_id, user_id, role, joined_at) VALUES (?,?,?,?)'); for (const id of ids) ins.run(tid, id, role, nowIso()); };
  const activeIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number))].filter((id) => db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(id));

  route('POST', '/api/team/dm', ({ user, body }) => {
    staffOnly(user);
    const other = Number(body.user_id);
    need(other && other !== user.id && db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(other), 404, 'That person isn’t on the team');
    const key = [user.id, other].sort((a, b) => a - b).join(':');
    let th = db.prepare('SELECT * FROM chat_threads WHERE dm_key = ?').get(`dm:${key}`);
    if (!th) {
      const id = Number(db.prepare("INSERT INTO chat_threads (kind, dm_key, created_by, created_at) VALUES ('dm', ?, ?, ?)").run(`dm:${key}`, user.id, nowIso()).lastInsertRowid);
      addMembers(id, [user.id, other]);
      th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
    }
    return { id: th.id };
  });
  route('POST', '/api/team/channels', ({ user, body }) => {
    staffOnly(user);
    const kind = body.kind === 'group' ? 'team_group' : 'channel';
    let name = str(body.name, 'name', 60).trim();
    if (kind === 'channel') { name = name.toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); need(name.length >= 2, 400, 'Give the channel a name of at least 2 letters'); need(!db.prepare("SELECT 1 FROM chat_threads WHERE project_id IS NULL AND kind = 'channel' AND name = ? AND archived_at IS NULL").get(name), 409, `There is already a #${name}`); }
    const id = Number(db.prepare('INSERT INTO chat_threads (kind, name, topic, private, post_policy, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(kind, name, optStr(body.topic, 'topic', 200), kind === 'team_group' || body.private ? 1 : 0, body.post_policy === 'managers' && isManager(user) ? 'managers' : 'all', user.id, nowIso()).lastInsertRowid);
    addMembers(id, [user.id], 'admin');
    addMembers(id, activeIds(body.members).filter((x) => x !== user.id));
    audit(user, 'team.chat_created', null, `${kind === 'channel' ? '#' : ''}${name}`);
    const th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
    ctx.emitUsers(ctx.teamMemberIds(th), 'team_threads');
    return { id };
  });

  function teamThread(user, tid) {
    const th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(Number(tid));
    need(th && ctx.isTeamThread(th), 404, 'Chat not found');
    const mem = db.prepare('SELECT * FROM team_members WHERE thread_id = ? AND user_id = ?').get(th.id, user.id);
    // the same rule as reading it: the company chat, a chat you're in, or a public channel. Private
    // channels, groups and direct messages are invisible to everyone else, managers included.
    need(th.kind === 'company' || mem || (th.kind === 'channel' && !th.private), 404, 'Chat not found');
    return { th, mem, admin: isManager(user) || (mem && mem.role === 'admin') };
  }
  route('POST', '/api/team/threads/:id/join', ({ user, params }) => {
    staffOnly(user);
    const { th } = teamThread(user, params.id);
    need(th.kind === 'channel' && !th.private && !th.archived_at, 403, 'That chat is invite only');
    addMembers(th.id, [user.id]);
    return { ok: true };
  });
  route('POST', '/api/team/threads/:id/leave', ({ user, params }) => {
    staffOnly(user);
    const { th } = teamThread(user, params.id);
    need(th.kind !== 'company' && th.kind !== 'dm' && th.dm_key !== 'announcements', 400, 'You can’t leave this chat. Mute it instead.');
    db.prepare('DELETE FROM team_members WHERE thread_id = ? AND user_id = ?').run(th.id, user.id);
    return { ok: true };
  });
  route('POST', '/api/team/threads/:id/members', ({ user, params, body }) => {
    staffOnly(user);
    const { th, mem, admin } = teamThread(user, params.id);
    need(th.kind === 'channel' || th.kind === 'team_group', 400, 'You can’t add people to this chat');
    need(mem || admin, 403, 'Only people in the chat can add others');
    addMembers(th.id, activeIds(body.ids));
    ctx.emitUsers(ctx.teamMemberIds(th), 'team_threads');
    return { ok: true };
  });
  route('DELETE', '/api/team/threads/:id/members/:uid', ({ user, params }) => {
    staffOnly(user);
    const { th, admin } = teamThread(user, params.id);
    need(admin, 403, 'Only the chat’s admins and managers remove people');
    need(th.kind === 'channel' || th.kind === 'team_group', 400, 'Nobody can be removed from this chat');
    db.prepare('DELETE FROM team_members WHERE thread_id = ? AND user_id = ?').run(th.id, Number(params.uid));
    return { ok: true };
  });
  route('PATCH', '/api/team/threads/:id', ({ user, params, body }) => {
    staffOnly(user);
    const { th, admin } = teamThread(user, params.id);
    need(admin, 403, 'Only the chat’s admins and managers change it');
    need(th.kind !== 'dm', 400, 'Direct messages have no name');
    if ('topic' in body) db.prepare('UPDATE chat_threads SET topic = ? WHERE id = ?').run(optStr(body.topic, 'topic', 200), th.id);
    if ('name' in body && th.kind !== 'company' && th.dm_key !== 'announcements') db.prepare('UPDATE chat_threads SET name = ? WHERE id = ?').run(str(body.name, 'name', 60), th.id);
    if ('post_policy' in body && isManager(user)) db.prepare('UPDATE chat_threads SET post_policy = ? WHERE id = ?').run(body.post_policy === 'managers' ? 'managers' : 'all', th.id);
    if ('archived' in body && th.kind !== 'company' && th.dm_key !== 'announcements') db.prepare('UPDATE chat_threads SET archived_at = ? WHERE id = ?').run(body.archived ? nowIso() : null, th.id);
    ctx.emitUsers(ctx.teamMemberIds(th), 'team_threads');
    return { ok: true };
  });
  // mute: 'none' | 'mentions' | 'all'; for: minutes (until then), or forever
  route('PUT', '/api/team/threads/:id/mute', ({ user, params, body }) => {
    staffOnly(user);
    const { th, mem } = teamThread(user, params.id);
    need(th.dm_key !== 'announcements', 400, 'Announcements can’t be muted');
    // muting is a setting on your own place in a chat, never a way in
    need(mem || th.kind === 'company', 403, 'Join the chat first');
    const mode = ['none', 'mentions', 'all'].includes(body.mode) ? body.mode : 'all';
    const until = body.minutes ? new Date(clockNow() + Math.min(60 * 24 * 30, Math.max(5, Number(body.minutes))) * 60000).toISOString() : null;
    db.prepare("INSERT INTO team_members (thread_id, user_id, mute, muted_until, joined_at) VALUES (?,?,?,?,?) ON CONFLICT(thread_id, user_id) DO UPDATE SET mute = excluded.mute, muted_until = excluded.muted_until")
      .run(th.id, user.id, until ? 'all' : mode, until, nowIso());
    return { ok: true };
  });
  route('GET', '/api/team/threads/:id/people', ({ user, params }) => {
    staffOnly(user);
    const { th, admin } = teamThread(user, params.id);
    const on = ctx.onlineNow().staff;
    const rows = th.kind === 'company' ? db.prepare('SELECT id, name, title FROM users WHERE active = 1 ORDER BY name').all().map((u) => ({ ...u, role: 'member' }))
      : db.prepare('SELECT u.id, u.name, u.title, tm.role FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.thread_id = ? AND u.active = 1 ORDER BY u.name').all(th.id);
    return { people: rows.map((r) => ({ ...r, online: on.has(r.id) })), admin: !!admin };
  });

  // ---------- search every chat this person is in ----------
  route('GET', '/api/team/search', ({ user, query }) => {
    staffOnly(user);
    const q = String(query.get('q') || '').trim();
    need(q.length >= 2, 400, 'Type at least 2 letters');
    const co = companyThread();
    const ids = [co.id, ...db.prepare("SELECT thread_id FROM team_members WHERE user_id = ?").all(user.id).map((r) => r.thread_id)];
    const rows = db.prepare(`SELECT * FROM chat_messages WHERE thread_id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL AND (body LIKE ? OR file_name LIKE ?) ORDER BY id DESC LIMIT 40`).all(...ids, `%${q}%`, `%${q}%`);
    return rows.map((m) => { const th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(m.thread_id); return { id: m.id, thread_id: m.thread_id, parent_id: m.parent_id, thread: ctx.teamThreadName(th, user), kind: th.kind, author: person(m.author_id), body: m.body.slice(0, 200), file: m.file_name, at: m.created_at }; });
  });

  // ---------- a message becomes a task ----------
  // Works in team chats and client chats. The task keeps a link to the message, the message shows the
  // task, and (if asked) the chat is told who it went to.
  route('POST', '/api/chat/messages/:id/task', ({ user, params, body }) => {
    staffOnly(user);
    const m = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(params.id));
    need(m && !m.deleted_at, 404, 'Message not found');
    const { th, a } = ctx.chatThreadFor(user, m.thread_id);
    need(!m.task_id, 409, 'This message is already a task');
    const projectId = body.project_id != null && body.project_id !== '' ? Number(body.project_id) : (a.p ? a.p.id : null);
    const authorName = m.author_kind === 'client' ? (db.prepare('SELECT name FROM client_users WHERE id = ?').get(m.author_id) || {}).name : (db.prepare('SELECT name FROM users WHERE id = ?').get(m.author_id) || {}).name;
    const where = a.team ? ctx.teamThreadName(th, user) : a.p.name;
    const desc = `From ${authorName || 'a message'} in ${where}, ${new Date(m.created_at).toISOString().slice(0, 10)}:\n\n${m.body || (m.file_name ? `(${m.file_name})` : '')}`;
    const task = ctx.createTask(user, {
      title: body.title || (m.body || m.file_name || 'From a message').split('\n')[0].slice(0, 200), description: desc, project_id: projectId,
      assignee_id: body.assignee_id != null && body.assignee_id !== '' ? Number(body.assignee_id) : user.id, due_day: body.due_day || null, priority: body.priority || 'normal',
      ...(body.client_visible != null ? { client_visible: !!body.client_visible } : {}),
    }, { source_message_id: m.id, ...(body.client_visible != null ? { client_visible: body.client_visible ? 1 : 0 } : {}) });
    db.prepare('UPDATE chat_messages SET task_id = ? WHERE id = ?').run(task.id, m.id);
    // the note in the chat is a post like any other: only where this person may post
    if (body.announce !== false && a.team && a.canPost) {
      const who = task.assignee_id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(task.assignee_id) || {}).name : null;
      ctx.teamPost(th, user, { body: `Made it a task${task.key ? `, ${task.key}` : ''}: ${task.title}${who ? `, for ${who}` : ''}${task.due_day ? `, due ${task.due_day}` : ''}`, kind: 'system', meta: { task_id: task.id, from: m.id } });
    }
    if (a.team) ctx.emitUsers(ctx.teamMemberIds(th), 'chat', { thread_id: th.id }); else ctx.emitPortal(a.p, 'chat', { thread_id: th.id }, { staffOnly: true });
    return task;
  });
};
