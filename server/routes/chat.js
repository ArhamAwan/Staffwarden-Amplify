'use strict';
const { need, str } = require('../lib/http');

// Chat between a client and the team, like WhatsApp: one group chat per project, plus a direct chat
// between one person at the client and one member of the team. Messages can quote another, carry a
// file or a voice message, be edited for 15 minutes, be deleted for everyone, and get reactions.
// Team-only notes in the group chat are never sent to the client. Typing is passed on live and kept
// nowhere. Reads are kept per person, for ticks and "Seen by".
const EDIT_MIN = 15;
const EMOJI_MAX = 16;

module.exports = (ctx) => {
  const { db, route, nowIso, clockNow, audit, emitPortal } = ctx;
  const C = { client: true };
  const kindOf = (user) => (user.kind === 'client' ? 'client' : 'staff');

  function groupThread(pid) {
    let g = db.prepare("SELECT * FROM chat_threads WHERE project_id = ? AND kind = 'group'").get(pid);
    if (!g) { db.prepare("INSERT OR IGNORE INTO chat_threads (project_id, kind, created_at) VALUES (?, 'group', ?)").run(pid, nowIso()); g = db.prepare("SELECT * FROM chat_threads WHERE project_id = ? AND kind = 'group'").get(pid); }
    return g;
  }
  function directThread(pid, staffId, clientUserId) {
    db.prepare("INSERT OR IGNORE INTO chat_threads (project_id, kind, staff_id, client_user_id, created_at) VALUES (?, 'direct', ?, ?, ?)").run(pid, staffId, clientUserId, nowIso());
    return db.prepare("SELECT * FROM chat_threads WHERE project_id = ? AND kind = 'direct' AND staff_id = ? AND client_user_id = ?").get(pid, staffId, clientUserId);
  }
  ctx.groupThread = groupThread;
  Object.assign(ctx, { chatThreadFor: (u, t) => threadFor(u, t), chatPerson: (k, i) => person(k, i), chatReaders: (th, a) => readers(th, a), chatMsgOut: (m, v, r) => msgOut(m, v, r) });

  // ---------- the team's own threads (no project): everyone, channels, groups, direct ----------
  const TEAM_KINDS = new Set(['company', 'channel', 'team_group', 'dm']);
  const isTeam = (th) => th.project_id == null && TEAM_KINDS.has(th.kind);
  function teamMemberIds(th) {
    if (th.kind === 'company') return db.prepare('SELECT id FROM users WHERE active = 1').all().map((r) => r.id);
    return db.prepare('SELECT tm.user_id id FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.thread_id = ? AND u.active = 1').all(th.id).map((r) => r.id);
  }
  function teamAccess(user, th) {
    need(user.kind !== 'client', 404, 'Chat not found');
    const mem = db.prepare('SELECT * FROM team_members WHERE thread_id = ? AND user_id = ?').get(th.id, user.id);
    const member = th.kind === 'company' || !!mem;
    need(member || (th.kind === 'channel' && !th.private), 404, 'Chat not found');
    const manage = ctx.isManager(user) || (mem && mem.role === 'admin');
    const canPost = member && !th.archived_at && (th.post_policy !== 'managers' || ctx.isManager(user));
    return { team: true, client: false, manage, member, canPost, mem, p: null };
  }
  ctx.teamMemberIds = teamMemberIds;
  ctx.isTeamThread = isTeam;
  // tells everyone who can see a thread that something changed in it
  function tellThread(a, th, type, extra = {}, to = undefined) {
    if (a.team) ctx.emitUsers(teamMemberIds(th), type, { thread_id: th.id, ...extra });
    else emitPortal(a.p, type, { thread_id: th.id, ...extra }, to === undefined ? recipients(th) : to);
  }
  const teamName = (th, me) => {
    if (th.kind === 'company') return th.name || `Everyone at ${String(ctx.cfg.orgName || 'the company').split(' ')[0]}`;
    if (th.dm_key === 'announcements') return 'Announcements';
    if (th.dm_key === 'checkins') return 'check-ins';
    if (th.kind === 'dm') { const other = db.prepare('SELECT u.id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.thread_id = ? AND tm.user_id != ? LIMIT 1').get(th.id, me.id); return other ? other.name : 'Just you'; }
    return th.name || 'Group';
  };
  ctx.teamThreadName = teamName;

  // { th, a }: a thread the person may read. Direct chats are only for the two people in them.
  function threadFor(user, tid) {
    const th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(Number(tid));
    need(th, 404, 'Chat not found');
    if (isTeam(th)) return { th, a: teamAccess(user, th) };
    need(th.project_id != null, 404, 'Chat not found');
    const a = ctx.portalAccess(user, th.project_id);
    if (th.kind === 'direct') need(a.client ? th.client_user_id === user.id : th.staff_id === user.id, 404, 'Chat not found');
    else if (a.client) need(a.s.messages, 403, 'Messages are switched off for this project');
    if (a.client && th.kind === 'direct') need(a.s.direct, 403, 'Direct messages are switched off for this project');
    return { th, a };
  }
  const recipients = (th) => (th.kind === 'direct' ? { direct: true, staff: [th.staff_id], clientUser: th.client_user_id } : null);

  // ---------- names ----------
  const person = (kind, id) => {
    const r = kind === 'client' ? db.prepare('SELECT id, name, title FROM client_users WHERE id = ?').get(id) : db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(id);
    return { kind, id, name: r ? r.name : 'Someone', title: r ? r.title : null };
  };

  // who can read a thread, besides the author: for ticks and "Seen by"
  function readers(th, a) {
    if (a && a.team) return teamMemberIds(th).map((id) => ({ kind: 'staff', id }));
    if (th.kind === 'direct') return [{ kind: 'staff', id: th.staff_id }, { kind: 'client', id: th.client_user_id }];
    const staff = db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(a.p.id).map((r) => ({ kind: 'staff', id: r.user_id }));
    const clients = db.prepare('SELECT id FROM client_users WHERE client_id = ? AND active = 1').all(a.c.id).map((r) => ({ kind: 'client', id: r.id }));
    return [...staff, ...clients];
  }

  const threadRow = (id) => db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
  const deliveredOf = (tid) => db.prepare('SELECT * FROM chat_delivered WHERE thread_id = ?').all(tid);
  // a person's devices picked up everything new in these threads: their senders' ticks go double
  function markDelivered(me, threads) {
    const up = db.prepare(`INSERT INTO chat_delivered (thread_id, author_kind, author_id, last_id, at) VALUES (?,?,?,?,?)
      ON CONFLICT(thread_id, author_kind, author_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id), at = excluded.at`);
    for (const th of threads) {
      const max = db.prepare('SELECT MAX(id) n FROM chat_messages WHERE thread_id = ?').get(th.id).n || 0;
      if (!max) continue;
      const had = db.prepare('SELECT last_id FROM chat_delivered WHERE thread_id = ? AND author_kind = ? AND author_id = ?').get(th.id, me.kind, me.id);
      const from = had ? had.last_id : 0;
      if (from >= max) continue;
      up.run(th.id, me.kind, me.id, max, nowIso());
      // tell the staff who wrote what just arrived, so their ticks update without a reload
      const authors = db.prepare("SELECT DISTINCT author_id FROM chat_messages WHERE thread_id = ? AND id > ? AND author_kind = 'staff' AND NOT (author_kind = ? AND author_id = ?)").all(th.id, from, me.kind, me.id).map((r) => r.author_id);
      if (authors.length) ctx.emitUsers(authors, 'chat_read', { thread_id: th.id });
    }
  }
  // everything a staff member's devices can see in the team chat
  ctx.chatDelivered = (user) => {
    if (!user || user.kind === 'client') return;
    const ths = db.prepare("SELECT t.* FROM chat_threads t WHERE t.archived_at IS NULL AND (t.kind = 'company' OR t.id IN (SELECT thread_id FROM team_members WHERE user_id = ?))").all(user.id);
    markDelivered({ kind: 'staff', id: user.id }, ths);
  };

  function msgOut(m, viewer, reads) {
    const deleted = !!m.deleted_at;
    const rx = deleted ? [] : db.prepare('SELECT emoji, author_kind, author_id FROM chat_reactions WHERE message_id = ? ORDER BY created_at').all(m.id);
    const groups = new Map();
    for (const r of rx) { if (!groups.has(r.emoji)) groups.set(r.emoji, []); groups.get(r.emoji).push(r); }
    let reply = null;
    if (m.reply_to && !deleted) {
      const q = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND thread_id = ?').get(m.reply_to, m.thread_id);
      if (q && !(viewer.kind === 'client' && q.team_only)) reply = { id: q.id, author: person(q.author_kind, q.author_id), body: q.deleted_at ? '' : q.body.slice(0, 160), deleted: !!q.deleted_at, file: q.file ? (q.voice_secs != null ? 'Voice message' : q.file_name) : null };
    }
    const mine = m.author_kind === viewer.kind && m.author_id === viewer.id;
    // ticks on your own messages: sent, delivered, seen
    let ticks = null, seen = null;
    if (mine) ({ ticks, seen } = tickState(m, reads));
    return msgBody(m, viewer, { deleted, groups, reply, mine, ticks, seen });
  }
  function tickState(m, reads) {
    let ticks = null, seen = null;
    {
      const other = m.author_kind === 'client' ? 'staff' : 'client';
      const notMe = (r) => !(r.author_kind === m.author_kind && r.author_id === m.author_id);
      const seenBy = reads.filter((r) => r.last_id >= m.id && notMe(r) && !(m.team_only && r.author_kind === 'client'));
      const dels = deliveredOf(m.thread_id).filter((r) => r.last_id >= m.id && notMe(r));
      const th = threadRow(m.thread_id);
      if (th && isTeam(th)) {
        // like WhatsApp: two ticks once it reached everyone's device, blue once everyone has read it
        const want = teamMemberIds(th).filter((id) => !(m.author_kind === 'staff' && id === m.author_id));
        const has = (list, id) => list.some((r) => r.author_kind === 'staff' && r.author_id === id);
        ticks = !want.length ? 'sent' : want.every((id) => has(seenBy, id)) ? 'read' : want.every((id) => has(seenBy, id) || has(dels, id)) ? 'delivered' : 'sent';
      } else {
        const side = (r) => (m.team_only ? r.author_kind === 'staff' : r.author_kind === other);
        ticks = seenBy.some(side) ? 'read' : dels.some(side) ? 'delivered' : 'sent';
      }
      seen = seenBy.map((r) => ({ ...person(r.author_kind, r.author_id), at: r.at }));
    }
    return { ticks, seen };
  }
  ctx.chatTicks = (m) => tickState(m, db.prepare('SELECT * FROM chat_reads WHERE thread_id = ?').all(m.thread_id)).ticks;
  function msgBody(m, viewer, { deleted, groups, reply, mine, ticks, seen }) {
    let meta = null;
    try { meta = m.meta ? JSON.parse(m.meta) : null; } catch { meta = null; }
    const task = m.task_id ? db.prepare('SELECT t.id, t.title, t.status, t.number, p.key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(m.task_id) : null;
    const reps = m.parent_id ? null : db.prepare('SELECT COUNT(*) n, MAX(created_at) last_at FROM chat_messages WHERE parent_id = ? AND deleted_at IS NULL').get(m.id);
    const repPeople = reps && reps.n ? db.prepare('SELECT DISTINCT author_kind, author_id FROM chat_messages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 3').all(m.id).map((r) => person(r.author_kind, r.author_id)) : [];
    if (m.kind === 'boost' && meta && meta.boost_id) {
      const b = db.prepare('SELECT COUNT(*) n, SUM(answer = \'chai\') chai FROM boost_answers WHERE boost_id = ?').get(meta.boost_id);
      const mineA = db.prepare('SELECT answer FROM boost_answers WHERE boost_id = ? AND user_id = ?').get(meta.boost_id, viewer.id);
      meta = { ...meta, boosted: b.n - (b.chai || 0), chai: b.chai || 0, my_answer: mineA ? mineA.answer : null };
    }
    if (m.kind === 'announcement' && meta && meta.announcement_id) {
      const r = db.prepare('SELECT confirmed_at FROM announcement_reads WHERE announcement_id = ? AND user_id = ?').get(meta.announcement_id, viewer.id);
      meta = { ...meta, confirmed: !!(r && r.confirmed_at) };
    }
    return {
      kind: m.kind || null, meta, parent_id: m.parent_id || null,
      task: task ? { id: task.id, ref: task.key && task.number ? `${task.key}-${task.number}` : null, title: task.title, status: task.status } : null,
      replies: reps && reps.n ? { count: reps.n, last_at: reps.last_at, people: repPeople } : null,
      id: m.id, author: person(m.author_kind, m.author_id), mine, body: deleted ? '' : m.body, deleted, team_only: !!m.team_only, pinned: !!m.pinned,
      reply, created_at: m.created_at, edited_at: m.edited_at,
      can_edit: mine && !deleted && !m.file && clockNow() - Date.parse(m.created_at) < EDIT_MIN * 60000,
      file: m.file && !deleted ? { name: m.file_name, type: m.file_type, size: m.file_size, voice_secs: m.voice_secs, pages: m.file_pages || null, url: `/api/chat/files/${m.id}` } : null,
      reactions: [...groups].map(([emoji, list]) => ({ emoji, count: list.length, mine: list.some((r) => r.author_kind === viewer.kind && r.author_id === viewer.id), who: list.map((r) => person(r.author_kind, r.author_id).name) })),
      ticks, seen,
    };
  }

  // ---------- the chats a person has on a project ----------
  route('GET', '/api/chat/projects/:pid/threads', ({ user, params }) => {
    const a = ctx.portalAccess(user, params.pid);
    const me = { kind: kindOf(user), id: user.id };
    const list = [];
    const summary = (th, extra) => {
      const r = db.prepare('SELECT last_id FROM chat_reads WHERE thread_id = ? AND author_kind = ? AND author_id = ?').get(th.id, me.kind, me.id);
      const hide = me.kind === 'client' ? 'AND team_only = 0' : '';
      const last = db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? ${hide} ORDER BY id DESC LIMIT 1`).get(th.id);
      const unread = db.prepare(`SELECT COUNT(*) n FROM chat_messages WHERE thread_id = ? AND id > ? AND deleted_at IS NULL AND NOT (author_kind = ? AND author_id = ?) ${hide}`).get(th.id, r ? r.last_id : 0, me.kind, me.id).n;
      return { id: th.id, kind: th.kind, ...extra, unread,
        last: last ? { author: person(last.author_kind, last.author_id), mine: last.author_kind === me.kind && last.author_id === me.id, body: last.deleted_at ? '' : last.body.slice(0, 120), deleted: !!last.deleted_at,
          file: last.file ? (last.voice_secs != null ? 'Voice message' : last.file_name) : null, at: last.created_at } : null };
    };
    if (!a.client || a.s.messages) list.push(summary(groupThread(a.p.id), { name: 'Everyone', members: readers(groupThread(a.p.id), a).map((r) => person(r.kind, r.id)) }));
    if (a.client && a.s.direct) {
      for (const m of db.prepare('SELECT u.id FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND u.active = 1 ORDER BY (u.id = ?) DESC, u.name').all(a.p.id, a.p.lead_id || 0)) {
        const th = db.prepare("SELECT * FROM chat_threads WHERE project_id = ? AND kind = 'direct' AND staff_id = ? AND client_user_id = ?").get(a.p.id, m.id, user.id);
        const p = person('staff', m.id);
        list.push(th ? summary(th, { name: p.name, with: p }) : { id: null, kind: 'direct', name: p.name, with: p, unread: 0, last: null });
      }
    }
    if (!a.client) {
      for (const th of db.prepare("SELECT * FROM chat_threads WHERE project_id = ? AND kind = 'direct' AND staff_id = ?").all(a.p.id, user.id)) {
        const p = person('client', th.client_user_id);
        list.push(summary(th, { name: p.name, with: p }));
      }
    }
    return list.sort((x, y) => (x.kind === 'group' ? -1 : y.kind === 'group' ? 1 : ((y.last && y.last.at) || '') > ((x.last && x.last.at) || '') ? 1 : -1));
  }, C);
  // starting a direct chat (the client picks someone on the team)
  route('POST', '/api/chat/projects/:pid/direct', ({ user, params, body }) => {
    const a = ctx.portalAccess(user, params.pid);
    let staffId, clientId;
    if (a.client) {
      need(a.s.direct, 403, 'Direct messages are switched off for this project');
      staffId = Number(body.staff_id); clientId = user.id;
      need(ctx.isProjectMember(a.p.id, staffId), 404, 'That person is not on this project');
    } else {
      staffId = user.id; clientId = Number(body.client_user_id);
      need(db.prepare('SELECT 1 FROM client_users WHERE id = ? AND client_id = ? AND active = 1').get(clientId, a.c.id), 404, 'That person is not at this client');
    }
    return { id: directThread(a.p.id, staffId, clientId).id };
  }, C);

  // ---------- messages ----------
  route('GET', '/api/chat/threads/:tid/messages', ({ user, params, query }) => {
    const { th, a } = threadFor(user, params.tid);
    const me = { kind: kindOf(user), id: user.id };
    const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
    const parent = Number(query.get('parent')) || null;
    let rows;
    if (parent) {
      const root = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND thread_id = ? AND parent_id IS NULL').get(parent, th.id);
      need(root && !(a.client && root.team_only), 404, 'Message not found');
      rows = [root, ...db.prepare(`SELECT * FROM chat_messages WHERE parent_id = ? ${a.client ? 'AND team_only = 0' : ''} ORDER BY id LIMIT 300`).all(root.id)];
    } else rows = db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? AND id < ? AND parent_id IS NULL ${a.client ? 'AND team_only = 0' : ''} ORDER BY id DESC LIMIT 80`).all(th.id, before).reverse();
    markDelivered(me, [th]);
    const reads = db.prepare('SELECT * FROM chat_reads WHERE thread_id = ?').all(th.id);
    if (a.team) {
      const members = teamMemberIds(th).map((id) => person('staff', id));
      const other = th.kind === 'dm' ? members.find((x) => x.id !== user.id) || null : null;
      const pinnedT = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND pinned = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').get(th.id);
      return {
        thread: { id: th.id, kind: th.kind, team: true, name: teamName(th, user), topic: th.topic || null, with: other, members: th.kind === 'company' && members.length > 60 ? members.slice(0, 60) : members, member_count: members.length,
          can_post: a.canPost, member: a.member, private: !!th.private, post_policy: th.post_policy, manage: !!a.manage, mute: a.mem ? a.mem.mute : 'none', muted_until: a.mem ? a.mem.muted_until : null },
        me, can_team_only: false, more: !parent && rows.length === 80, parent,
        last_read: (db.prepare('SELECT last_id FROM chat_reads WHERE thread_id = ? AND author_kind = ? AND author_id = ?').get(th.id, me.kind, me.id) || {}).last_id || 0,
        messages: rows.map((m) => msgOut(m, me, reads)),
        pinned: !parent && pinnedT ? { id: pinnedT.id, body: pinnedT.body.slice(0, 200), author: person(pinnedT.author_kind, pinnedT.author_id), at: pinnedT.created_at, kind: pinnedT.kind || null } : null,
      };
    }
    const pinned = db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? AND pinned = 1 AND deleted_at IS NULL ${a.client ? 'AND team_only = 0' : ''} ORDER BY id DESC LIMIT 1`).get(th.id);
    const other = th.kind === 'direct' ? person(a.client ? 'staff' : 'client', a.client ? th.staff_id : th.client_user_id) : null;
    return {
      thread: { id: th.id, kind: th.kind, project_id: th.project_id, name: th.kind === 'group' ? 'Everyone' : other.name, with: other, members: th.kind === 'group' ? readers(th, a).map((r) => person(r.kind, r.id)) : null },
      me, can_team_only: !a.client && th.kind === 'group' && !parent, more: !parent && rows.length === 80, parent,
      last_read: (db.prepare('SELECT last_id FROM chat_reads WHERE thread_id = ? AND author_kind = ? AND author_id = ?').get(th.id, me.kind, me.id) || {}).last_id || 0,
      messages: rows.map((m) => msgOut(m, me, reads)),
      pinned: pinned ? { id: pinned.id, body: pinned.body.slice(0, 200), author: person(pinned.author_kind, pinned.author_id), at: pinned.created_at } : null,
    };
  }, C);

  const lastSent = new Map();   // a little flood control: at most 20 messages in 10 seconds from one person
  route('POST', '/api/chat/threads/:tid/messages', ({ user, params, body }) => {
    const { th, a } = threadFor(user, params.tid);
    if (a.team) need(a.canPost, 403, a.member ? (th.archived_at ? 'This chat is archived' : 'Only managers post here') : 'Join the channel to post');
    const me = { kind: kindOf(user), id: user.id };
    const key = `${me.kind}:${me.id}`, now = clockNow();
    const recent = (lastSent.get(key) || []).filter((t) => now - t < 10000);
    need(recent.length < 20, 429, 'Slow down a little');
    lastSent.set(key, [...recent, now]);
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    need(text.length <= 4000, 400, 'Messages can be up to 4,000 characters');
    // the sender's own key for this message: sent again after being offline, it is kept once
    const ckey = typeof body.client_key === 'string' && /^[\w-]{8,64}$/.test(body.client_key) ? body.client_key : null;
    if (ckey) {
      const had = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND author_kind = ? AND author_id = ? AND client_key = ?').get(th.id, me.kind, me.id, ckey);
      if (had) return msgOut(had, me, db.prepare('SELECT * FROM chat_reads WHERE thread_id = ?').all(th.id));
    }
    const f = body.file_base64 ? ctx.portalSaveFile(body.file_base64, body.file_type, body.file_name) : null;
    need(text || f, 400, 'Write something or attach a file');
    // how many pages a PDF has, for its preview card
    let pages = null;
    if (f && f.file_type === 'application/pdf') { try { const raw = require('node:fs').readFileSync(require('node:path').join(ctx.portalDir, f.file)).toString('latin1'); pages = (raw.match(/\/Type\s*\/Page(?!s)/g) || []).length || null; } catch { pages = null; } }
    const teamOnly = !!body.team_only;
    need(!teamOnly || (!a.client && th.kind === 'group'), 400, 'Team-only notes are for the team, in the group chat');
    let reply = null;
    if (body.reply_to) {
      const q = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND thread_id = ?').get(Number(body.reply_to), th.id);
      need(q && !(a.client && q.team_only), 400, 'That message is not in this chat');
      reply = q.id;
    }
    if (body.voice_secs != null && user.kind !== 'client') need(!ctx.featureOn || ctx.featureOn('voice_notes', user.id), 403, 'Voice messages are switched off for now');
    const voice = f && /^audio\//.test(f.file_type) && body.voice_secs != null ? Math.max(1, Math.min(600, Math.round(Number(body.voice_secs) || 1))) : null;
    // a reply in a thread hangs under a message at the top level of this chat
    let parentId = null;
    if (body.parent_id) {
      const root = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND thread_id = ? AND parent_id IS NULL').get(Number(body.parent_id), th.id);
      need(root && !(a.client && root.team_only), 400, 'That message is not in this chat');
      parentId = root.id;
    }
    const id = Number(db.prepare('INSERT INTO chat_messages (thread_id, author_kind, author_id, body, reply_to, team_only, file, file_name, file_type, file_size, voice_secs, file_pages, client_key, parent_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(th.id, me.kind, me.id, text, reply, teamOnly ? 1 : 0, f && f.file, f && f.file_name, f && f.file_type, f && f.file_size, voice, pages, ckey, parentId, nowIso()).lastInsertRowid);
    // "also send to the chat": the reply shows at the top level too, quoting the message it answers
    if (parentId && body.also_channel && text) db.prepare('INSERT INTO chat_messages (thread_id, author_kind, author_id, body, reply_to, created_at) VALUES (?,?,?,?,?,?)').run(th.id, me.kind, me.id, text, parentId, nowIso());
    markRead(th, me, id);
    // @mentions of people in the chat
    const mentioned = [];
    if (text && me.kind === 'staff') {
      const pool = a.team ? teamMemberIds(th) : readers(th, a).filter((r) => r.kind === 'staff').map((r) => r.id);
      for (const uid of pool) { if (uid === me.id) continue; const n = (db.prepare('SELECT name FROM users WHERE id = ?').get(uid) || {}).name; if (n && text.includes(`@${n}`)) { mentioned.push(uid); db.prepare('INSERT OR IGNORE INTO chat_mentions (message_id, user_id) VALUES (?,?)').run(id, uid); } }
    }
    if (a.team) {
      teamNotify(th, user, { id, text, voice, f, parentId, mentioned, urgent: !!body.urgent });
      tellThread(a, th, 'chat');
      return msgOut(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id), me, db.prepare('SELECT * FROM chat_reads WHERE thread_id = ?').all(th.id));
    }
    if (mentioned.length && ctx.notify) ctx.notify.notify(mentioned, { kind: 'chat_mention', title: `${user.name} mentioned you in ${a.p.name}`, body: text.slice(0, 200), link: `#/project?id=${a.p.id}&tab=client&ct=${th.id}`, actor: user, tag: `t${th.id}` });
    // the team hears about client messages; nobody is told about their own
    if (me.kind === 'client' && ctx.notify) {
      const to = th.kind === 'direct' ? [th.staff_id] : [a.p.lead_id, ...db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(a.p.id).map((r) => r.user_id)];
      const hour = new Date(clockNow()).toISOString().slice(0, 13);
      ctx.notify.notify(to, { kind: 'client_message', title: th.kind === 'direct' ? `${user.name} (${a.c.name}) messaged you` : `${user.name} wrote in ${a.p.name}`, body: text ? text.slice(0, 200) : (voice ? 'Voice message' : f.file_name), link: `#/project?id=${a.p.id}&tab=client`, dedupe: `chat:${th.id}:${hour}` });
    }
    // the client hears about the team's messages: in their bell and on their phone, at most once an hour per chat
    if (me.kind === 'staff' && !teamOnly && ctx.pnotify) {
      const to = th.kind === 'direct' ? [th.client_user_id] : ctx.pnotify.clientsOf(a.p);
      const hour = new Date(clockNow()).toISOString().slice(0, 13);
      ctx.pnotify.notifyClient(to, { kind: 'chat', project_id: a.p.id, link: `#/messages?p=${a.p.id}&t=${th.id}`, title: th.kind === 'direct' ? `${user.name} messaged you` : `${user.name} wrote in the group chat`, body: text ? text.slice(0, 200) : (voice ? 'Voice message' : f.file_name), dedupe: `chat:${th.id}:${hour}` });
    }
    emitPortal(a.p, 'chat', { thread_id: th.id }, teamOnly ? { staffOnly: true } : recipients(th));
    return msgOut(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id), me, db.prepare('SELECT * FROM chat_reads WHERE thread_id = ?').all(th.id));
  }, C);

  // who hears about a team message, and how: direct and group chats tell everyone in them; channels
  // tell those who haven't muted them; a mention always gets through unless the chat is fully muted
  function teamNotify(th, user, { id, text, voice, f, parentId, mentioned, urgent }) {
    if (!ctx.notify) return;
    const name = teamName(th, user);
    const what = text ? text.slice(0, 200) : voice ? 'Voice message' : f ? f.file_name : '';
    const link = `#/chat?t=${th.id}${parentId ? `&r=${parentId}` : ''}`;
    const nowMs = clockNow();
    const people = teamMemberIds(th).filter((uid) => uid !== user.id);
    const muteOf = (uid) => { const m = db.prepare('SELECT mute, muted_until FROM team_members WHERE thread_id = ? AND user_id = ?').get(th.id, uid); if (!m) return 'none'; if (m.muted_until && Date.parse(m.muted_until) > nowMs) return 'all'; return m.muted_until ? 'none' : m.mute; };
    // in a thread of replies, only the people in it (and whoever wrote the first message) hear about it
    const inReplies = parentId ? new Set(db.prepare('SELECT DISTINCT author_id FROM chat_messages WHERE (id = ? OR parent_id = ?) AND author_kind = \'staff\'').all(parentId, parentId).map((r) => r.author_id)) : null;
    const direct = th.kind === 'dm' || th.kind === 'team_group';
    for (const uid of people) {
      const mute = muteOf(uid);
      if (mute === 'all') continue;
      const isMention = mentioned.includes(uid);
      if (isMention) { ctx.notify.notify(uid, { kind: 'chat_mention', title: `${user.name} mentioned you${th.kind === 'dm' ? '' : ` in ${name}`}`, body: what, link, actor: user, tag: `t${th.id}`, urgent }); continue; }
      if (mute === 'mentions') continue;
      if (inReplies && !inReplies.has(uid)) continue;
      if (direct) ctx.notify.notify(uid, { kind: 'chat_direct', title: th.kind === 'dm' ? user.name : `${user.name} in ${name}`, body: what, link, actor: user, tag: `t${th.id}`, urgent });
      else ctx.notify.notify(uid, { kind: 'chat_channel', title: `${user.name} in ${th.kind === 'company' ? name : `#${name}`}`, body: what, link, actor: user, tag: `t${th.id}` });
    }
  }
  // posts into a team thread from Staffwarden itself (an announcement, a boost, a task made from a message)
  ctx.teamPost = (th, author, { body = '', kind = null, meta = null, pinned = false }) => {
    if (pinned) db.prepare('UPDATE chat_messages SET pinned = 0 WHERE thread_id = ?').run(th.id);
    const id = Number(db.prepare('INSERT INTO chat_messages (thread_id, author_kind, author_id, body, kind, meta, pinned, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(th.id, 'staff', author.id, body, kind, meta ? JSON.stringify(meta) : null, pinned ? 1 : 0, nowIso()).lastInsertRowid);
    markRead(th, { kind: 'staff', id: author.id }, id);
    ctx.emitUsers(teamMemberIds(th), 'chat', { thread_id: th.id });
    return id;
  };

  function ownMessage(user, mid) {
    const m = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(mid));
    need(m, 404, 'Message not found');
    const { th, a } = threadFor(user, m.thread_id);
    if (a.client) need(!m.team_only, 404, 'Message not found');
    return { m, th, a, mine: m.author_kind === kindOf(user) && m.author_id === user.id };
  }
  const tell = (a, th, m) => tellThread(a, th, 'chat', {}, m.team_only ? { staffOnly: true } : recipients(th));
  route('PATCH', '/api/chat/messages/:id', ({ user, params, body }) => {
    const { m, th, a, mine } = ownMessage(user, params.id);
    need(mine, 403, 'You can only edit your own messages');
    need(!m.deleted_at && !m.file, 400, 'This message can’t be edited');
    need(clockNow() - Date.parse(m.created_at) < EDIT_MIN * 60000, 403, `Messages can be edited for ${EDIT_MIN} minutes`);
    db.prepare('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?').run(str(body.body, 'body', 4000), nowIso(), m.id);
    tell(a, th, m);
    return { ok: true };
  }, C);
  route('DELETE', '/api/chat/messages/:id', ({ user, params }) => {
    const { m, th, a, mine } = ownMessage(user, params.id);
    need(mine || (!a.client && a.manage), 403, 'You can only delete your own messages');
    db.prepare("UPDATE chat_messages SET body = '', deleted_at = ?, pinned = 0 WHERE id = ?").run(nowIso(), m.id);
    db.prepare('DELETE FROM chat_reactions WHERE message_id = ?').run(m.id);
    if (!mine) audit(user, a.team ? 'team.chat_deleted' : 'client.chat_deleted', null, `message ${m.id} in ${a.team ? teamName(th, user) : a.p.name}`);
    tell(a, th, m);
    return { ok: true };
  }, C);
  route('POST', '/api/chat/messages/:id/pin', ({ user, params, body }) => {
    const { m, th, a } = ownMessage(user, params.id);
    need(!a.client || th.kind === 'direct', 403, 'The team pins messages in the group chat');
    if (a.team) need(a.member, 403, 'Join the chat first');
    need(!m.deleted_at, 400, 'This message was deleted');
    db.prepare('UPDATE chat_messages SET pinned = 0 WHERE thread_id = ?').run(th.id);
    if (body.on !== false) db.prepare('UPDATE chat_messages SET pinned = 1 WHERE id = ?').run(m.id);
    tell(a, th, m);
    return { ok: true };
  }, C);
  route('POST', '/api/chat/messages/:id/react', ({ user, params, body }) => {
    const { m, th, a } = ownMessage(user, params.id);
    need(!m.deleted_at, 400, 'This message was deleted');
    const emoji = str(body.emoji, 'emoji', EMOJI_MAX);
    need(!/[<>&"'\s]/.test(emoji) && /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(emoji), 400, 'Choose an emoji');
    const k = kindOf(user);
    const had = db.prepare('SELECT 1 FROM chat_reactions WHERE message_id = ? AND author_kind = ? AND author_id = ? AND emoji = ?').get(m.id, k, user.id, emoji);
    if (had) db.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND author_kind = ? AND author_id = ? AND emoji = ?').run(m.id, k, user.id, emoji);
    else {
      need(db.prepare('SELECT COUNT(DISTINCT emoji) n FROM chat_reactions WHERE message_id = ?').get(m.id).n < 12, 400, 'That message has enough reactions');
      db.prepare('INSERT INTO chat_reactions (message_id, author_kind, author_id, emoji, created_at) VALUES (?,?,?,?,?)').run(m.id, k, user.id, emoji, nowIso());
    }
    tell(a, th, m);
    return { ok: true, on: !had };
  }, C);

  function markRead(th, me, lastId) {
    db.prepare(`INSERT INTO chat_reads (thread_id, author_kind, author_id, last_id, at) VALUES (?,?,?,?,?)
      ON CONFLICT(thread_id, author_kind, author_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id), at = CASE WHEN excluded.last_id > last_id THEN excluded.at ELSE at END`).run(th.id, me.kind, me.id, lastId, nowIso());
  }
  route('POST', '/api/chat/threads/:tid/read', ({ user, params, body }) => {
    const { th, a } = threadFor(user, params.tid);
    const me = { kind: kindOf(user), id: user.id };
    const max = db.prepare('SELECT MAX(id) n FROM chat_messages WHERE thread_id = ?').get(th.id).n || 0;
    const want = Math.min(max, Number(body.last_id) || max);
    const before = db.prepare('SELECT last_id FROM chat_reads WHERE thread_id = ? AND author_kind = ? AND author_id = ?').get(th.id, me.kind, me.id);
    markRead(th, me, want);
    // only worth telling the others when something new was read (their ticks turn blue)
    if (!before || before.last_id < want) tellThread(a, th, 'chat_read');
    return { ok: true };
  }, C);
  // "typing…": passed on to the others in the chat, never stored
  route('POST', '/api/chat/threads/:tid/typing', ({ user, params, body }) => {
    const { th, a } = threadFor(user, params.tid);
    const who = person(kindOf(user), user.id);
    const teamOnly = !!body.team_only && !a.client;
    tellThread(a, th, 'typing', { who: { kind: who.kind, id: who.id, name: who.name } }, teamOnly ? { staffOnly: true } : recipients(th));
    return { ok: true };
  }, C);
  route('GET', '/api/chat/files/:id', ({ user, params }) => {
    const { m } = ownMessage(user, params.id);
    need(m.file && !m.deleted_at, 404, 'File not found');
    return ctx.portalSendFile(m.file, m.file_type, m.file_name);
  }, C);
};
