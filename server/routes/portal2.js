'use strict';
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { need, str, optStr, int } = require('../lib/http');
const { Pdf } = require('../lib/pdf');

// Portal v2: the client's bell and phone notifications, calls with the team, ratings at finished
// milestones, a thread and an estimate on each request, task steps, comments pinned on an approval,
// chat search, previews, photos and files, who is online, the monthly statement, and on the team's
// side one inbox across clients, client health and the scheduled weekly update.
// Everything goes through the same access rules as the rest of the portal (ctx.portalAccess).
module.exports = (ctx) => {
  const { db, route, nowIso, clockNow, audit, emitPortal, T } = ctx;
  const C = { client: true };
  const P = () => ctx.pnotify;
  const access = (u, pid) => ctx.portalAccess(u, pid);
  const needManage = (a) => need(a.manage, 403, 'Only the project manager can do this');
  const staffName = (id) => ctx.portalStaffName(id);
  const clientName = (id) => (db.prepare('SELECT name FROM client_users WHERE id = ?').get(id) || {}).name || 'Client';
  const who = (kind, id) => ({ kind, id, name: kind === 'client' ? clientName(id) : staffName(id) });
  const first = (n) => String(n || '').split(' ')[0];
  const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  const clientTz = (c, ms = clockNow()) => (c && c.tz_name ? T.zoneOffset(c.tz_name, ms) : ctx.calc.companyTz(ms));
  const HOUR = 3600000;

  // =================================================================================================
  // the overview, more of it: where the project stands in a line, the current milestone's tasks, the
  // next call, and (for the client) a rating to give for a milestone that just finished
  // =================================================================================================
  ctx.portalOverviewExtra = (user, a, { tasks, milestones, waiting }) => {
    const today = ctx.calc.companyToday();
    const cur = milestones.find((m) => !m.done_at) || null;
    const mt = cur ? tasks.filter((t) => t.milestone_id === cur.id) : [];
    // on track, at risk or late: the current milestone's date against what is left of it
    let status = null;
    if (milestones.length && !cur) status = { state: 'done', text: 'Every milestone is done.' };
    else if (cur) {
      const left = mt.filter((t) => t.status !== 'done').length, done = mt.length - left;
      const days = cur.due_day ? T.daysBetween(today, cur.due_day) : null;
      const ap = waiting.filter((w) => w.kind === 'approval').length;
      const parts = [`${cur.title} is ${cur.due_day ? `due ${T.human(cur.due_day).replace(/^\w+, /, '')}` : 'next'}`, mt.length ? `${done} of ${mt.length} tasks are done` : null].filter(Boolean);
      let state = 'on';
      if (days != null && days < 0) state = 'late';
      else if (days != null && mt.length && left / mt.length > 0.5 && days <= 3) state = 'risk';
      else if (days != null && ap && days <= 2) state = 'risk';
      const tail = ap ? ` ${ap === 1 ? 'An approval' : `${ap} approvals`} from you would keep it on time.` : '';
      status = { state, text: `${parts.join(' and ')}.${state === 'late' ? ' It is past its date; the team is on it.' : tail}` };
    }
    const nextMeet = db.prepare('SELECT * FROM meetings WHERE project_id = ? AND cancelled_at IS NULL AND starts_at > ? ORDER BY starts_at LIMIT 1').get(a.p.id, new Date(clockNow() - HOUR).toISOString());
    const out = {
      status, current_milestone: cur ? { id: cur.id, title: cur.title, tasks: mt.map((t) => ({ id: t.id, title: t.title, status: t.status === 'done' ? 'done' : ['in_progress', 'in_review'].includes(t.status) ? 'in_progress' : 'todo' })) } : null,
      next_meeting: nextMeet ? meetOut(nextMeet, a) : null,
    };
    if (a.client) {
      // the latest milestone finished in the last 45 days that this person hasn't rated
      const since = new Date(clockNow() - 45 * 86400000).toISOString();
      const m = db.prepare('SELECT * FROM milestones WHERE project_id = ? AND done_at IS NOT NULL AND done_at > ? ORDER BY done_at DESC LIMIT 1').get(a.p.id, since);
      out.rate_milestone = m && !db.prepare('SELECT 1 FROM milestone_ratings WHERE milestone_id = ? AND client_user_id = ?').get(m.id, user.id) && !user.preview ? { id: m.id, title: m.title, done_at: m.done_at } : null;
    } else {
      out.ratings = ratingsOf(a.p.id);
    }
    return out;
  };
  function ratingsOf(pid) {
    return db.prepare('SELECT r.*, m.title FROM milestone_ratings r JOIN milestones m ON m.id = r.milestone_id WHERE m.project_id = ? ORDER BY r.created_at DESC').all(pid)
      .map((r) => ({ milestone_id: r.milestone_id, milestone: r.title, stars: r.stars, note: r.note, by: clientName(r.client_user_id), at: r.created_at }));
  }

  // =================================================================================================
  // ratings: "How did this go?" at each finished milestone. Only the team sees the answers.
  // =================================================================================================
  route('POST', '/api/portal/milestones/:id/rating', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'The client rates milestones');
    const m = db.prepare('SELECT * FROM milestones WHERE id = ?').get(Number(params.id));
    need(m, 404, 'Milestone not found');
    const a = access(user, m.project_id);
    need(m.done_at, 400, 'This milestone isn’t done yet');
    const stars = int(Number(body.stars), 'stars', 1, 5);
    const note = optStr(body.note, 'note', 1000);
    db.prepare(`INSERT INTO milestone_ratings (milestone_id, client_user_id, stars, note, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(milestone_id, client_user_id) DO UPDATE SET stars = excluded.stars, note = excluded.note, created_at = excluded.created_at`).run(m.id, user.id, stars, note, nowIso());
    if (ctx.notify) ctx.notify.notify([a.p.lead_id], { kind: 'client_request', title: `${user.name} rated ${m.title} ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`, body: note, link: `#/project?id=${a.p.id}&tab=client` });
    emitPortal(a.p, 'portal');
    return { ok: true, stars };
  }, C);

  // the people at the client (for switching who the team previews the portal as)
  route('GET', '/api/portal/people', ({ user }) => {
    need(user.kind === 'client', 403, 'For clients');
    return db.prepare('SELECT id, name FROM client_users WHERE client_id = ? AND active = 1 ORDER BY name').all(user.client_id);
  }, C);

  // =================================================================================================
  // the client's bell
  // =================================================================================================
  const cnOut = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, project_id: r.project_id, created_at: r.created_at, read: !!r.read_at });
  const cUnread = (id) => db.prepare('SELECT COUNT(*) n FROM client_notifications WHERE client_user_id = ? AND read_at IS NULL').get(id).n;
  route('GET', '/api/portal/notifications', ({ user, query }) => {
    need(user.kind === 'client', 403, 'For clients');
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 30));
    const after = query.has('after') ? Number(query.get('after')) || 0 : null;
    const rows = after != null ? db.prepare('SELECT * FROM client_notifications WHERE client_user_id = ? AND id > ? ORDER BY id LIMIT ?').all(user.id, after, limit)
      : db.prepare('SELECT * FROM client_notifications WHERE client_user_id = ? ORDER BY id DESC LIMIT ?').all(user.id, limit);
    return { items: rows.map(cnOut), unread: cUnread(user.id), last_id: db.prepare('SELECT MAX(id) m FROM client_notifications WHERE client_user_id = ?').get(user.id).m || 0 };
  }, C);
  route('POST', '/api/portal/notifications/read', ({ user, body }) => {
    need(user.kind === 'client', 403, 'For clients');
    const at = nowIso();
    if (body.all) db.prepare('UPDATE client_notifications SET read_at = ? WHERE client_user_id = ? AND read_at IS NULL').run(at, user.id);
    else {
      need(Array.isArray(body.ids) && body.ids.length <= 200, 400, 'ids must be a list');
      for (const id of body.ids) db.prepare('UPDATE client_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND client_user_id = ?').run(at, Number(id), user.id);
    }
    ctx.emitClientUser(user.id, 'notify');
    return { unread: cUnread(user.id) };
  }, C);
  route('GET', '/api/portal/notify-prefs', ({ user }) => {
    need(user.kind === 'client', 403, 'For clients');
    const cu = db.prepare('SELECT * FROM client_users WHERE id = ?').get(user.id);
    const p = P().prefsOf(cu);
    return { push: Object.entries(P().CLIENT_CATEGORIES).map(([k, label]) => ({ key: k, label, on: p.push[k] })), hours80: p.hours80, hours_week: p.hours_week,
      devices: db.prepare("SELECT COUNT(*) n FROM push_subs WHERE owner_kind = 'client' AND owner_id = ?").get(user.id).n };
  }, C);
  route('PUT', '/api/portal/notify-prefs', ({ user, body }) => {
    need(user.kind === 'client', 403, 'For clients');
    const cu = db.prepare('SELECT * FROM client_users WHERE id = ?').get(user.id);
    const cur = json(cu.notify_prefs, {});
    if (body.push && typeof body.push === 'object') { cur.push = cur.push || {}; for (const [k, v] of Object.entries(body.push)) { need(k in P().CLIENT_CATEGORIES, 400, `Unknown kind ${k}`); cur.push[k] = !!v; } }
    if ('hours80' in body) cur.hours80 = !!body.hours80;
    if ('hours_week' in body) cur.hours_week = !!body.hours_week;
    db.prepare('UPDATE client_users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify(cur), user.id);
    return { ok: true };
  }, C);

  // =================================================================================================
  // phone and browser notifications (staff and clients)
  // =================================================================================================
  const PUSH_DEVICES = 20;
  const ownerOf = (user) => (user.kind === 'client' ? ['client', user.id] : ['staff', user.id]);
  route('GET', '/api/push/key', () => ({ key: P().vapid().publicKey }), C);
  route('POST', '/api/push/subscribe', ({ user, body }) => {
    const ep = str(body.endpoint, 'endpoint', 1000);
    need(/^https:\/\/[^\s/]+\//.test(ep) && require('../lib/webpush').pushAddressOk(ep), 400, 'That is not a push address');
    const k = body.keys || {};
    need(typeof k.p256dh === 'string' && /^[\w-]{80,100}$/.test(k.p256dh) && typeof k.auth === 'string' && /^[\w-]{16,32}$/.test(k.auth), 400, 'Missing push keys');
    const [kind, id] = ownerOf(user);
    // A browser that signs in as someone else re-subscribes with the same secret auth key, so the
    // device moves with it. Knowing only someone's push address is not enough to take their device.
    const had = db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').get(ep);
    need(!had || had.auth === k.auth || (had.owner_kind === kind && had.owner_id === id), 409, 'That device is already set up');
    db.prepare(`INSERT INTO push_subs (owner_kind, owner_id, endpoint, p256dh, auth, device, created_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET owner_kind = excluded.owner_kind, owner_id = excluded.owner_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, fails = 0`)
      .run(kind, id, ep, k.p256dh, k.auth, optStr(body.device, 'device', 120), nowIso());
    // a person has a handful of devices: keep the newest 20, so no one can make every notification fan out without end
    db.prepare(`DELETE FROM push_subs WHERE owner_kind = ? AND owner_id = ? AND id NOT IN
      (SELECT id FROM push_subs WHERE owner_kind = ? AND owner_id = ? ORDER BY id DESC LIMIT ${PUSH_DEVICES})`).run(kind, id, kind, id);
    return { ok: true };
  }, C);
  route('POST', '/api/push/unsubscribe', ({ user, body }) => {
    const [kind, id] = ownerOf(user);
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND owner_kind = ? AND owner_id = ?').run(String(body.endpoint || ''), kind, id);
    return { ok: true };
  }, C);
  route('POST', '/api/push/test', ({ user }) => {
    const [kind, id] = ownerOf(user);
    const n = db.prepare('SELECT COUNT(*) n FROM push_subs WHERE owner_kind = ? AND owner_id = ?').get(kind, id).n;
    need(n, 400, 'Turn on phone notifications first');
    P().pushTo(kind, id, { title: 'Notifications are on', body: 'This is how things from the team will look on this device.', link: kind === 'client' ? '#/overview' : '#/', tag: 'test' });
    return { ok: true, devices: n };
  }, C);

  // =================================================================================================
  // calls with the client
  // =================================================================================================
  function meetOut(m, a) {
    const notes = json(m.notes, null);
    const steps = notes && Array.isArray(notes.next) ? notes.next.map((n) => {
      const t = n.task_id ? db.prepare('SELECT id, number, title, status, client_visible, project_id FROM tasks WHERE id = ? AND project_id = ?').get(n.task_id, a.p.id) : null;
      if (t && a.client && !ctx.portalTaskVisible(t, a.s)) return { text: n.text || 'A task for the team', task: null };
      return { text: n.text || (t ? t.title : ''), task: t ? { id: t.id, ref: `${a.p.key}-${t.number}`, title: t.title, status: t.status === 'done' ? 'done' : ['in_progress', 'in_review'].includes(t.status) ? 'in_progress' : 'todo' } : null };
    }) : [];
    return { id: m.id, title: m.title, starts_at: m.starts_at, minutes: m.minutes, link: m.link, cancelled: !!m.cancelled_at,
      agenda: json(m.agenda, []).map((x, i) => ({ i, text: x.text, by: who(x.k, x.id), mine: a.client ? x.k === 'client' : x.k === 'staff' })),
      notes: notes ? { decided: notes.decided || [], next: steps, from_client: notes.from_client || [], text: notes.text || '', by: m.notes_by ? staffName(m.notes_by) : null, at: m.notes_at } : null,
      tz_name: a.c.tz_name || null };
  }
  const meetFor = (user, id) => { const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(Number(id)); need(m, 404, 'Call not found'); return { m, a: access(user, m.project_id) }; };
  route('GET', '/api/portal/projects/:id/meetings', ({ user, params }) => {
    const a = access(user, params.id);
    const now = new Date(clockNow() - HOUR).toISOString();
    const rows = db.prepare('SELECT * FROM meetings WHERE project_id = ? AND cancelled_at IS NULL ORDER BY starts_at').all(a.p.id);
    const upcoming = rows.filter((m) => m.starts_at > now), past = rows.filter((m) => m.starts_at <= now).reverse();
    const members = db.prepare('SELECT u.id, u.name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND u.active = 1').all(a.p.id);
    return { upcoming: upcoming.map((m) => meetOut(m, a)), past: past.map((m) => meetOut(m, a)), manage: a.manage, staff: !a.client, tz_name: a.c.tz_name || null,
      tasks: a.client ? [] : db.prepare("SELECT id, number, title FROM tasks WHERE project_id = ? AND status != 'done' ORDER BY id DESC LIMIT 60").all(a.p.id).map((t) => ({ id: t.id, ref: `${a.p.key}-${t.number}`, title: t.title })),
      team: a.client && !a.s.people ? [] : members.map((u) => ({ id: u.id, name: u.name })) };
  }, C);
  // when: a day and a time in the client's own zone ({ day: '2026-10-30', time: '15:00' }) or an ISO time
  function whenOf(a, body) {
    if (body.day && body.time) {
      need(T.isDay(body.day) && T.validHhmm(body.time), 400, 'Pick a day and a time');
      const guess = Date.parse(`${body.day}T12:00:00Z`);
      return new Date(T.dayStartMs(body.day, clientTz(a.c, guess)) + T.hhmm(body.time) * 60000).toISOString();
    }
    need(typeof body.starts_at === 'string' && !Number.isNaN(Date.parse(body.starts_at)), 400, 'Pick a day and a time');
    return new Date(body.starts_at).toISOString();
  }
  const linkOk = (v) => { const l = optStr(v, 'link', 500); need(!l || /^https:\/\/\S+$/.test(l), 400, 'The call link should start with https://'); return l; };
  route('POST', '/api/portal/projects/:id/meetings', ({ user, params, body }) => {
    need(user.kind !== 'client', 403, 'The team schedules calls');
    const a = access(user, params.id);
    needManage(a);
    const at = whenOf(a, body);
    const id = Number(db.prepare('INSERT INTO meetings (project_id, title, starts_at, minutes, link, agenda, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(a.p.id, str(body.title || 'Weekly check-in', 'title', 120), at, int(Number(body.minutes || 30), 'minutes', 5, 480), linkOk(body.link), JSON.stringify((Array.isArray(body.agenda) ? body.agenda : []).slice(0, 20).map((x) => ({ text: str(String(x), 'agenda', 300), k: 'staff', id: user.id }))), user.id, nowIso()).lastInsertRowid);
    P().toProject(a.p, { kind: 'meeting', link: `#/meetings?p=${a.p.id}`, actor: user, title: `${first(user.name)} booked a call: ${str(body.title || 'Weekly check-in', 'title', 120)}`, body: 'See the time and add anything you want to talk about.' });
    audit(user, 'client.meeting', null, `${a.p.name}: ${at}`);
    emitPortal(a.p, 'portal');
    return meetOut(db.prepare('SELECT * FROM meetings WHERE id = ?').get(id), a);
  }, C);
  route('PATCH', '/api/portal/meetings/:id', ({ user, params, body }) => {
    need(user.kind !== 'client', 403, 'The team changes calls');
    const { m, a } = meetFor(user, params.id);
    needManage(a);
    if ('title' in body) db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(str(body.title, 'title', 120), m.id);
    if ('minutes' in body) db.prepare('UPDATE meetings SET minutes = ? WHERE id = ?').run(int(Number(body.minutes), 'minutes', 5, 480), m.id);
    if ('link' in body) db.prepare('UPDATE meetings SET link = ? WHERE id = ?').run(linkOk(body.link), m.id);
    if (body.day || body.starts_at) {
      const at = whenOf(a, body);
      if (at !== m.starts_at) { db.prepare('UPDATE meetings SET starts_at = ? WHERE id = ?').run(at, m.id); P().toProject(a.p, { kind: 'meeting', link: `#/meetings?p=${a.p.id}`, actor: user, title: `The call “${m.title}” moved`, body: 'Open Meetings for the new time.' }); }
    }
    if (body.cancelled === true) { db.prepare('UPDATE meetings SET cancelled_at = ? WHERE id = ?').run(nowIso(), m.id); P().toProject(a.p, { kind: 'meeting', link: `#/meetings?p=${a.p.id}`, actor: user, title: `The call “${m.title}” is cancelled` }); }
    emitPortal(a.p, 'portal');
    return meetOut(db.prepare('SELECT * FROM meetings WHERE id = ?').get(m.id), a);
  }, C);
  route('POST', '/api/portal/meetings/:id/agenda', ({ user, params, body }) => {
    const { m, a } = meetFor(user, params.id);
    need(!m.cancelled_at, 400, 'This call is cancelled');
    const list = json(m.agenda, []);
    need(list.length < 20, 400, 'The agenda is full');
    list.push({ text: str(body.text, 'text', 300), k: user.kind === 'client' ? 'client' : 'staff', id: user.id });
    db.prepare('UPDATE meetings SET agenda = ? WHERE id = ?').run(JSON.stringify(list), m.id);
    if (user.kind === 'client' && ctx.notify) ctx.notify.notify([a.p.lead_id, m.created_by], { kind: 'client_request', title: `${user.name} added to the agenda of ${m.title}`, body: body.text, link: `#/project?id=${a.p.id}&tab=client` });
    emitPortal(a.p, 'portal');
    return meetOut(db.prepare('SELECT * FROM meetings WHERE id = ?').get(m.id), a);
  }, C);
  route('DELETE', '/api/portal/meetings/:id/agenda/:i', ({ user, params }) => {
    const { m, a } = meetFor(user, params.id);
    const list = json(m.agenda, []), i = Number(params.i), x = list[i];
    need(x, 404, 'Not on the agenda');
    need(a.manage || (x.k === (user.kind === 'client' ? 'client' : 'staff') && x.id === user.id), 403, 'You can take off only what you added');
    list.splice(i, 1);
    db.prepare('UPDATE meetings SET agenda = ? WHERE id = ?').run(JSON.stringify(list), m.id);
    emitPortal(a.p, 'portal');
    return meetOut(db.prepare('SELECT * FROM meetings WHERE id = ?').get(m.id), a);
  }, C);
  route('PUT', '/api/portal/meetings/:id/notes', ({ user, params, body }) => {
    need(user.kind !== 'client', 403, 'The team writes the notes');
    const { m, a } = meetFor(user, params.id);
    needManage(a);
    const lines = (v, k) => { need(v == null || (Array.isArray(v) && v.length <= 20), 400, `${k} must be a list`); return (v || []).map((x) => String(x || '').trim()).filter(Boolean).map((x) => str(x, k, 300)); };
    const next = (Array.isArray(body.next) ? body.next : []).slice(0, 20).map((n) => ({ text: optStr(n && n.text, 'next', 300), task_id: n && n.task_id ? Number(n.task_id) : null })).filter((n) => n.text || n.task_id);
    for (const n of next) if (n.task_id) need(db.prepare('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?').get(n.task_id, a.p.id), 400, 'That task is not on this project');
    const had = !!m.notes;
    db.prepare('UPDATE meetings SET notes = ?, notes_by = ?, notes_at = ? WHERE id = ?').run(JSON.stringify({ decided: lines(body.decided, 'decided'), next, from_client: lines(body.from_client, 'from_client'), text: optStr(body.text, 'text', 3000) || '' }), user.id, nowIso(), m.id);
    if (!had) P().toProject(a.p, { kind: 'meeting_notes', link: `#/meetings?p=${a.p.id}`, actor: user, title: `Notes from ${m.title}`, body: 'What was agreed, and what happens next.' });
    emitPortal(a.p, 'portal');
    return meetOut(db.prepare('SELECT * FROM meetings WHERE id = ?').get(m.id), a);
  }, C);
  // "Add to calendar": the call as an .ics file
  route('GET', '/api/portal/meetings/:id/ics', ({ user, params }) => {
    const { m, a } = meetFor(user, params.id);
    const f = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
    const end = new Date(Date.parse(m.starts_at) + m.minutes * 60000).toISOString();
    const agenda = json(m.agenda, []).map((x, i) => `${i + 1}. ${x.text}`).join('\n');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Staffwarden//Client portal//EN', 'BEGIN:VEVENT', `UID:workhelm-meeting-${m.id}@workhelm`, `DTSTAMP:${f(nowIso())}`,
      `DTSTART:${f(m.starts_at)}`, `DTEND:${f(end)}`, `SUMMARY:${esc(`${m.title} · ${a.p.name}`)}`, ...(m.link ? [`URL:${m.link}`, `LOCATION:${esc(m.link)}`] : []), `DESCRIPTION:${esc(agenda ? `Agenda:\n${agenda}` : a.p.name)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return { raw: `${ics}\r\n`, type: 'text/calendar; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="call-${m.starts_at.slice(0, 10)}.ics"`, 'Cache-Control': 'private, no-store' } };
  }, C);
  // "Ask for a call": goes to the whole team in the chat, and to the lead's bell
  route('POST', '/api/portal/projects/:id/call-request', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'The client asks for calls');
    const a = access(user, params.id);
    const text = str(body.text, 'text', 500);
    const g = ctx.groupThread(a.p.id);
    if (a.s.messages) {
      db.prepare("INSERT INTO chat_messages (thread_id, author_kind, author_id, body, created_at) VALUES (?, 'client', ?, ?, ?)").run(g.id, user.id, `Asked for a call: ${text}`, nowIso());
      emitPortal(a.p, 'chat', { thread_id: g.id });
    }
    if (ctx.notify) ctx.notify.notify([a.p.lead_id], { kind: 'client_request', title: `${user.name} (${a.c.name}) asked for a call`, body: text, link: `#/project?id=${a.p.id}&tab=client` });
    return { ok: true };
  }, C);

  // =================================================================================================
  // requests: a thread on each, edit or cancel while new, and an estimate the client answers
  // =================================================================================================
  // with requests switched off for the client, none of their request routes answer the client
  const reqFor = (user, id) => {
    const r = db.prepare('SELECT * FROM client_requests WHERE id = ?').get(Number(id));
    need(r, 404, 'Request not found');
    const a = access(user, r.project_id);
    if (a.client) need(a.s.requests, 403, 'Requests are switched off for this project');
    return { r, a };
  };
  const reqMsgOut = (m, user) => ({ id: m.id, body: m.body, created_at: m.created_at, author: who(m.author_kind, m.author_id), mine: m.author_kind === (user.kind === 'client' ? 'client' : 'staff') && m.author_id === user.id });
  route('GET', '/api/portal/requests/:id/messages', ({ user, params }) => {
    const { r } = reqFor(user, params.id);
    return db.prepare('SELECT * FROM request_messages WHERE request_id = ? ORDER BY id').all(r.id).map((m) => reqMsgOut(m, user));
  }, C);
  route('POST', '/api/portal/requests/:id/messages', ({ user, params, body }) => {
    const { r, a } = reqFor(user, params.id);
    const text = str(body.body, 'body', 2000);
    const kind = user.kind === 'client' ? 'client' : 'staff';
    db.prepare('INSERT INTO request_messages (request_id, author_kind, author_id, body, created_at) VALUES (?,?,?,?,?)').run(r.id, kind, user.id, text, nowIso());
    if (kind === 'client' && ctx.notify) ctx.notify.notify([a.p.lead_id, r.estimate_by, r.decided_by], { kind: 'client_request', title: `${user.name} replied on “${r.title}”`, body: text.slice(0, 200), link: `#/project?id=${a.p.id}&tab=client` });
    if (kind === 'staff') P().notifyClient(r.client_user_id ? [r.client_user_id] : P().clientsOf(a.p), { kind: 'request_update', project_id: a.p.id, link: `#/requests?p=${a.p.id}&r=${r.id}`, title: `${first(user.name)} replied on “${r.title}”`, body: text.slice(0, 200) });
    if (kind === 'staff' && !r.seen_at) db.prepare('UPDATE client_requests SET seen_at = ?, seen_by = ? WHERE id = ?').run(nowIso(), user.id, r.id);
    emitPortal(a.p, 'portal');
    return { ok: true };
  }, C);
  route('PATCH', '/api/portal/requests/:id', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'The client edits their own request');
    const { r, a } = reqFor(user, params.id);
    need(r.status === 'new' && !r.estimate_answer, 409, 'The team has already answered this. Reply in its thread instead.');
    if ('title' in body) db.prepare('UPDATE client_requests SET title = ? WHERE id = ?').run(str(body.title, 'title', 200), r.id);
    if ('detail' in body) db.prepare('UPDATE client_requests SET detail = ? WHERE id = ?').run(optStr(body.detail, 'detail', 2000), r.id);
    if ('urgency' in body) { need(['whenever', 'month', 'week'].includes(body.urgency), 400, 'Choose how soon'); db.prepare('UPDATE client_requests SET urgency = ? WHERE id = ?').run(body.urgency, r.id); }
    db.prepare('UPDATE client_requests SET edited_at = ? WHERE id = ?').run(nowIso(), r.id);
    emitPortal(a.p, 'portal');
    return ctx.portalReqOut(db.prepare('SELECT * FROM client_requests WHERE id = ?').get(r.id));
  }, C);
  route('POST', '/api/portal/requests/:id/cancel', ({ user, params }) => {
    need(user.kind === 'client', 403, 'The client cancels their own request');
    const { r, a } = reqFor(user, params.id);
    need(r.status === 'new', 409, 'This request is already taken on. Ask the team in its thread.');
    db.prepare("UPDATE client_requests SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(nowIso(), r.id);
    if (ctx.notify) ctx.notify.notify([a.p.lead_id], { kind: 'client_request', title: `${user.name} cancelled “${r.title}”`, link: `#/project?id=${a.p.id}&tab=client` });
    emitPortal(a.p, 'portal');
    return ctx.portalReqOut(db.prepare('SELECT * FROM client_requests WHERE id = ?').get(r.id));
  }, C);
  route('POST', '/api/portal/requests/:id/estimate', ({ user, params, body }) => {
    need(user.kind !== 'client', 403, 'The team estimates');
    const { r, a } = reqFor(user, params.id);
    needManage(a);
    need(r.status === 'new', 409, 'This request was answered already');
    const hours = Number(body.hours);
    need(Number.isFinite(hours) && hours > 0 && hours <= 500, 400, 'Give the hours, between 0.5 and 500');
    db.prepare('UPDATE client_requests SET estimate_hours = ?, estimate_note = ?, estimate_by = ?, estimate_at = ?, estimate_answer = NULL, answered_at = NULL, seen_at = COALESCE(seen_at, ?), seen_by = COALESCE(seen_by, ?) WHERE id = ?')
      .run(Math.round(hours * 2) / 2, optStr(body.note, 'note', 1000), user.id, nowIso(), nowIso(), user.id, r.id);
    P().notifyClient(r.client_user_id ? [r.client_user_id] : P().clientsOf(a.p), { kind: 'request_estimate', project_id: a.p.id, link: `#/requests?p=${a.p.id}&r=${r.id}`, actor: user, title: `Estimate ready: ${r.title}`, body: `About ${Math.round(hours * 2) / 2} hours. Go ahead, or not now?` });
    emitPortal(a.p, 'portal');
    return ctx.portalReqOut(db.prepare('SELECT * FROM client_requests WHERE id = ?').get(r.id));
  }, C);
  route('POST', '/api/portal/requests/:id/answer', ({ user, params, body }) => {
    need(user.kind === 'client', 403, 'The client answers the estimate');
    const { r, a } = reqFor(user, params.id);
    need(r.estimate_at && r.status === 'new', 409, 'There is no estimate waiting on this request');
    need(['yes', 'no'].includes(body.answer), 400, 'answer must be yes or no');
    const now = nowIso();
    if (body.answer === 'yes') {
      // agreed: it becomes a task the client can follow, with the person who estimated it
      const number = ctx.nextTaskNumber(a.p.id);
      const est = r.estimate_by && ctx.isProjectMember(a.p.id, r.estimate_by) ? r.estimate_by : null;
      const taskId = r.task_id || Number(db.prepare("INSERT INTO tasks (title, description, project_id, assignee_id, created_by, status, client_visible, estimate_min, number, position, created_at) VALUES (?,?,?,?,?, 'todo', 1, ?, ?, ?, ?)")
        .run(r.title, r.detail, a.p.id, est, r.estimate_by || a.p.lead_id, Math.round(r.estimate_hours * 60), number, clockNow(), now).lastInsertRowid);
      db.prepare("UPDATE client_requests SET estimate_answer = 'yes', answered_at = ?, status = 'planned', task_id = ?, decided_by = COALESCE(decided_by, estimate_by), decided_at = ? WHERE id = ?").run(now, taskId, now, r.id);
      ctx.emit('tasks');
    } else db.prepare("UPDATE client_requests SET estimate_answer = 'no', answered_at = ?, status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now, now, r.id);
    if (ctx.notify) ctx.notify.notify([a.p.lead_id, r.estimate_by], { kind: 'client_request', title: body.answer === 'yes' ? `${user.name} said go ahead: ${r.title}` : `${user.name} said not now: ${r.title}`, body: body.answer === 'yes' ? `About ${r.estimate_hours} hours. It is a task now.` : null, link: `#/project?id=${a.p.id}&tab=client` });
    audit(null, 'client.estimate_answered', null, `${user.name} (${a.c.name}): ${r.title} ${body.answer}`);
    emitPortal(a.p, 'portal');
    return ctx.portalReqOut(db.prepare('SELECT * FROM client_requests WHERE id = ?').get(r.id));
  }, C);
  // the retainer, for the estimate box: used this month, and what was already agreed on top
  route('GET', '/api/portal/projects/:id/retainer', ({ user, params }) => {
    const a = access(user, params.id);
    if (a.client) need(a.s.hours !== 'off', 403, 'Hours are not shared for this project');
    const month = ctx.portalThisMonth(), [from, to] = ctx.portalMonthWindow(month);
    const used = ctx.portalWorked(a.p.id, from, to).reduce((n, x) => n + x.secs, 0) / 3600;
    const agreed = db.prepare("SELECT COALESCE(SUM(estimate_hours), 0) h FROM client_requests WHERE project_id = ? AND estimate_answer = 'yes' AND answered_at >= ?").get(a.p.id, new Date(from).toISOString()).h;
    return { month, retainer_hours: a.c.retainer_hours, used_hours: Math.round(used * 10) / 10, agreed_hours: agreed };
  }, C);

  // =================================================================================================
  // task steps (the team keeps them; the client sees how far along a task is)
  // =================================================================================================
  route('PUT', '/api/tasks/:id/steps', ({ user, params, body }) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(params.id));
    need(t && ctx.taskVisible(user, t), 404, 'Task not found');
    const p = t.project_id ? ctx.getProject(t.project_id) : null;
    need(t.assignee_id === user.id || t.created_by === user.id || (p && ctx.canRunProject(user, p)) || ctx.isManager(user), 403, 'Only the person on the task or the project manager can change its steps');
    need(Array.isArray(body.steps) && body.steps.length <= 30, 400, 'steps must be a list');
    const keep = new Set();
    body.steps.forEach((x, i) => {
      const title = str(String((x && x.title) || ''), 'title', 200);
      const ex = x.id ? db.prepare('SELECT * FROM task_steps WHERE id = ? AND task_id = ?').get(Number(x.id), t.id) : null;
      const done = x.done ? (ex && ex.done_at) || nowIso() : null;
      if (ex) { db.prepare('UPDATE task_steps SET title = ?, done_at = ?, position = ? WHERE id = ?').run(title, done, i, ex.id); keep.add(ex.id); }
      else keep.add(Number(db.prepare('INSERT INTO task_steps (task_id, title, done_at, position) VALUES (?,?,?,?)').run(t.id, title, done, i).lastInsertRowid));
    });
    // @mentions in the steps (each step tells a person once)
    if (ctx.taskMention) for (const st of db.prepare('SELECT id, title FROM task_steps WHERE task_id = ?').all(t.id)) if (keep.has(st.id) && st.title.includes('@')) ctx.taskMention(t, user, 'step', st.id, st.title);
    for (const s of db.prepare('SELECT id FROM task_steps WHERE task_id = ?').all(t.id)) if (!keep.has(s.id)) db.prepare('DELETE FROM task_steps WHERE id = ?').run(s.id);
    ctx.emit('tasks', t.assignee_id);
    if (p && p.client_id) emitPortal(p, 'portal_task', { task_id: t.id });
    return db.prepare('SELECT id, title, done_at FROM task_steps WHERE task_id = ? ORDER BY position, id').all(t.id).map((x) => ({ id: x.id, title: x.title, done: !!x.done_at }));
  });

  // =================================================================================================
  // approvals: comments pinned to a spot on a version, and reminders
  // =================================================================================================
  function versionFor(user, vid) {
    const v = db.prepare('SELECT * FROM approval_versions WHERE id = ?').get(Number(vid));
    need(v, 404, 'Version not found');
    const x = db.prepare('SELECT * FROM approvals WHERE id = ?').get(v.approval_id);
    const a = access(user, x.project_id);
    if (a.client) need(a.s.approvals, 403, 'Approvals are switched off for this project');
    return { v, x, a };
  }
  route('POST', '/api/portal/versions/:vid/pins', ({ user, params, body }) => {
    const { v, x, a } = versionFor(user, params.vid);
    const x0 = Number(body.x), y0 = Number(body.y);
    need(Number.isFinite(x0) && Number.isFinite(y0) && x0 >= 0 && x0 <= 100 && y0 >= 0 && y0 <= 100, 400, 'Tap a spot on the version');
    need(db.prepare('SELECT COUNT(*) n FROM approval_pins WHERE version_id = ?').get(v.id).n < 40, 400, 'That version has enough comments');
    const text = str(body.body, 'body', 1000);
    db.prepare('INSERT INTO approval_pins (version_id, x, y, body, author_kind, author_id, created_at) VALUES (?,?,?,?,?,?,?)').run(v.id, x0, y0, text, user.kind === 'client' ? 'client' : 'staff', user.id, nowIso());
    if (user.kind === 'client' && ctx.notify) ctx.notify.notify([x.created_by, a.p.lead_id], { kind: 'client_approval', title: `${user.name} commented on ${x.title}`, body: text.slice(0, 200), link: `#/project?id=${a.p.id}&tab=client` });
    if (user.kind !== 'client') P().toProject(a.p, { kind: 'approval_version', link: `#/approvals?p=${a.p.id}&a=${x.id}`, actor: user, title: `${first(user.name)} commented on ${x.title}`, body: text.slice(0, 200), dedupe: `pin:${v.id}:${new Date(clockNow()).toISOString().slice(0, 13)}` });
    emitPortal(a.p, 'portal');
    return { ok: true };
  }, C);
  route('POST', '/api/portal/pins/:id/resolve', ({ user, params, body }) => {
    const p = db.prepare('SELECT * FROM approval_pins WHERE id = ?').get(Number(params.id));
    need(p, 404, 'Comment not found');
    const { a } = versionFor(user, p.version_id);
    need(!a.client || (p.author_kind === 'client' && p.author_id === user.id), 403, 'Only the team or whoever wrote it can tick this off');
    db.prepare('UPDATE approval_pins SET resolved_at = ? WHERE id = ?').run(body.on === false ? null : nowIso(), p.id);
    emitPortal(a.p, 'portal');
    return { ok: true };
  }, C);
  function remind(x, a, by = null) {
    const ask = x.kind === 'file' ? `a file: ${x.title}` : x.title;
    const n = P().toProject(a.p, { kind: 'approval_reminder', link: `#/approvals?p=${a.p.id}&a=${x.id}`, actor: by, title: x.kind === 'file' ? `Reminder: the team is waiting on ${ask}` : `Reminder: ${x.title} is waiting for your approval`,
      body: x.due_day ? `Needed by ${T.human(x.due_day)}.` : null, dedupe: `rem:${x.id}:${T.localDay(clockNow(), 0)}` }, { approvers: x.kind === 'approval' && db.prepare('SELECT 1 FROM client_users WHERE client_id = ? AND can_approve = 1 AND active = 1').get(a.c.id) != null });
    db.prepare('UPDATE approvals SET reminded_at = ? WHERE id = ?').run(nowIso(), x.id);
    emitPortal(a.p, 'portal');
    return n;
  }
  route('POST', '/api/portal/approvals/:id/remind', ({ user, params }) => {
    need(user.kind !== 'client', 403, 'The team sends reminders');
    const x = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(params.id));
    need(x, 404, 'Not found');
    const a = access(user, x.project_id);
    need(x.status === 'waiting', 409, 'This isn’t waiting on them');
    need(!x.reminded_at || clockNow() - Date.parse(x.reminded_at) > 12 * HOUR, 429, 'They were reminded less than 12 hours ago');
    remind(x, a, user);
    return { ok: true };
  }, C);

  // =================================================================================================
  // chat: search across chats, who is online, photos and files, link previews
  // =================================================================================================
  function threadsFor(user, a) {
    const all = db.prepare('SELECT * FROM chat_threads WHERE project_id = ?').all(a.p.id);
    return all.filter((th) => {
      if (th.kind === 'direct') return !user.preview && (a.client ? th.client_user_id === user.id && a.s.direct : th.staff_id === user.id);
      return !a.client || a.s.messages;
    });
  }
  route('GET', '/api/chat/projects/:pid/search', ({ user, params, query }) => {
    const a = access(user, params.pid);
    const q = String(query.get('q') || '').trim();
    need(q.length >= 2 && q.length <= 100, 400, 'Search for at least 2 letters');
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const me = { kind: a.client ? 'client' : 'staff', id: user.id };
    const out = [];
    for (const th of threadsFor(user, a)) {
      const rows = db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? AND deleted_at IS NULL ${a.client ? 'AND team_only = 0' : ''} AND (body LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT 30`).all(th.id, like, like);
      const name = th.kind === 'group' ? 'Everyone' : a.client ? staffName(th.staff_id) : clientName(th.client_user_id);
      for (const m of rows) out.push({ thread_id: th.id, thread: name, id: m.id, author: who(m.author_kind, m.author_id), mine: m.author_kind === me.kind && m.author_id === me.id, body: m.body.slice(0, 240), file: m.file ? m.file_name : null, created_at: m.created_at });
    }
    out.sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
    return { q, results: out.slice(0, 40), threads: new Set(out.map((r) => r.thread_id)).size };
  }, C);
  // a green dot while someone has Staffwarden or the portal open. The client sees the team's dots only if
  // their settings allow it; the team always sees when the client was last in the portal.
  route('GET', '/api/chat/projects/:pid/presence', ({ user, params }) => {
    const a = access(user, params.pid);
    const on = ctx.onlineNow();
    const staff = db.prepare('SELECT u.id FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND u.active = 1').all(a.p.id).map((r) => r.id);
    const clients = db.prepare('SELECT id, last_seen_at FROM client_users WHERE client_id = ? AND active = 1').all(a.c.id);
    return {
      shown: !a.client || !!a.s.presence,
      staff: !a.client || a.s.presence ? staff.map((id) => ({ id, online: on.staff.has(id) })) : [],
      clients: a.client ? [] : clients.map((c) => ({ id: c.id, online: on.clients.has(c.id), last_seen_at: c.last_seen_at })),
    };
  }, C);
  route('GET', '/api/chat/threads/:tid/media', ({ user, params }) => {
    const { th, a } = ctx.chatThreadFor(user, params.tid);
    const rows = db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? AND deleted_at IS NULL ${a.client ? 'AND team_only = 0' : ''} AND (file IS NOT NULL OR body LIKE '%http%') ORDER BY id DESC LIMIT 400`).all(th.id);
    const photos = [], files = [], voice = [], links = [];
    for (const m of rows) {
      const base = { id: m.id, by: who(m.author_kind, m.author_id).name, at: m.created_at };
      if (m.file) {
        const f = { ...base, name: m.file_name, type: m.file_type, size: m.file_size, pages: m.file_pages, url: `/api/chat/files/${m.id}` };
        if (m.voice_secs != null) voice.push({ ...f, secs: m.voice_secs }); else if (/^image\//.test(m.file_type)) photos.push(f); else files.push(f);
      }
      for (const u of (m.body.match(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']/g) || []).slice(0, 5)) links.push({ ...base, url: u });
    }
    return { photos: photos.slice(0, 60), files: files.slice(0, 60), voice: voice.slice(0, 60), links: links.slice(0, 60) };
  }, C);

  // ---------- link previews: fetched by the server, carefully ----------
  // only http(s) on the usual ports, never to this machine or a private network (checked on every
  // redirect, and the connection goes to the address that was checked), small pages, a few seconds
  const privateIp = (ip) => {
    if (net.isIPv4(ip)) {
      const [a, b, c] = ip.split('.').map(Number);
      return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
        || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0) || a >= 224;
    }
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
    const v4 = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(x);          // the old ::a.b.c.d form
    if (v4) return true;
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('ff')
      || x.startsWith('64:ff9b:') || x.startsWith('2002:');              // NAT64 and 6to4 reach IPv4 behind them
  };
  ctx.privateIp = privateIp;
  function fetchPage(url, hops = 0) {
    return new Promise((resolve0, reject0) => {
      // one deadline for the whole fetch, however slowly a server drips its page
      let done = false;
      const deadline = setTimeout(() => { if (!done) { done = true; reject0(new Error('timeout')); } }, 8000);
      const resolve = (v) => { if (!done) { done = true; clearTimeout(deadline); resolve0(v); } };
      const reject = (e) => { if (!done) { done = true; clearTimeout(deadline); reject0(e); } };
      let u;
      try { u = new URL(url); } catch { reject(new Error('bad url')); return; }
      if (!['http:', 'https:'].includes(u.protocol) || (u.port && !['80', '443'].includes(u.port)) || u.username || u.password) { reject(new Error('not allowed')); return; }
      dns.lookup(u.hostname, { all: true }, (err, addrs) => {
        if (err || !addrs.length || addrs.some((x) => privateIp(x.address))) { reject(new Error('not allowed')); return; }
        const pick = addrs[0];
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u, { method: 'GET', timeout: 5000, headers: { 'User-Agent': 'WorkhelmLinkPreview/1.0', Accept: 'text/html' }, lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: pick.address, family: pick.family }]) : cb(null, pick.address, pick.family)) }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) { res.resume(); fetchPage(new URL(res.headers.location, u).toString(), hops + 1).then(resolve, reject); return; }
          if (res.statusCode !== 200 || !/text\/html|application\/xhtml/i.test(String(res.headers['content-type'] || ''))) { res.resume(); reject(new Error('not a page')); return; }
          let size = 0; const chunks = [];
          res.on('data', (c) => { size += c.length; if (size > 512 * 1024) { req.destroy(); resolve({ html: Buffer.concat(chunks).toString('utf8'), url: u }); return; } chunks.push(c); });
          res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: u }));
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      });
    });
  }
  const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32)).replace(/\s+/g, ' ').trim();
  // The <meta> tags of a page, read in one pass (a regex over a hostile page could hold the server for minutes).
  function metaTags(html) {
    const out = new Map();
    let p = 0;
    while ((p = html.indexOf('<meta', p)) !== -1 && out.size < 200) {
      const e = html.indexOf('>', p);
      if (e === -1) break;
      const tag = html.slice(p, Math.min(e, p + 2000));
      p = e + 1;
      const n = /\b(?:property|name)\s*=\s*["']([^"']{1,80})["']/i.exec(tag);
      const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (n && c && !out.has(n[1].toLowerCase())) out.set(n[1].toLowerCase(), decode(c[1]));
    }
    return out;
  }
  function titleOf(html) {
    const a = html.search(/<title[\s>]/i);
    if (a === -1) return null;
    const b = html.indexOf('>', a), c = html.indexOf('</', b);
    return b === -1 || c === -1 || c - b > 2000 ? null : decode(html.slice(b + 1, c).slice(0, 300));
  }
  ctx.linkPreviewFetch = fetchPage;
  route('GET', '/api/chat/preview', async ({ query }) => {
    const url = String(query.get('url') || '');
    need(/^https?:\/\/\S{3,500}$/.test(url), 400, 'Not a link');
    const cached = db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url);
    if (cached && clockNow() - Date.parse(cached.fetched_at) < 7 * 86400000) return cached.ok ? { ok: true, title: cached.title, description: cached.description, site: cached.site } : { ok: false };
    let out = { ok: false };
    try {
      const { html, url: u } = await fetchPage(url);
      const head = html.slice(0, 100000);
      const m = metaTags(head);
      const title = m.get('og:title') || m.get('twitter:title') || titleOf(head);
      const description = m.get('og:description') || m.get('description') || m.get('twitter:description');
      const site = m.get('og:site_name') || u.hostname.replace(/^www\./, '');
      if (title) out = { ok: true, title: title.slice(0, 200), description: description ? description.slice(0, 300) : null, site: site.slice(0, 80) };
    } catch { out = { ok: false }; }
    db.prepare('INSERT OR REPLACE INTO link_previews (url, ok, title, description, site, fetched_at) VALUES (?,?,?,?,?,?)').run(url, out.ok ? 1 : 0, out.title || null, out.description || null, out.site || null, nowIso());
    return out;
  }, C);

  // =================================================================================================
  // the monthly statement: hours by milestone, as on the invoice
  // =================================================================================================
  function statementOf(a, month) {
    const [from, to] = ctx.portalMonthWindow(month);
    const rows = ctx.portalWorked(a.p.id, from, to);
    const miles = db.prepare('SELECT id, title FROM milestones WHERE project_id = ? ORDER BY position, id').all(a.p.id);
    const reqTasks = new Set(db.prepare('SELECT task_id FROM client_requests WHERE project_id = ? AND task_id IS NOT NULL').all(a.p.id).map((r) => r.task_id));
    const byMile = new Map(miles.map((m) => [m.id, 0]));
    let req = 0, other = 0;
    const taskCache = new Map();
    for (const x of rows) {
      let t = null;
      if (x.task_id) { if (!taskCache.has(x.task_id)) taskCache.set(x.task_id, db.prepare('SELECT id, milestone_id, client_visible FROM tasks WHERE id = ?').get(x.task_id)); t = taskCache.get(x.task_id); }
      if (t && t.milestone_id && byMile.has(t.milestone_id)) byMile.set(t.milestone_id, byMile.get(t.milestone_id) + x.secs);
      else if (t && reqTasks.has(t.id)) req += x.secs;
      else other += x.secs;
    }
    const lines = [...miles.filter((m) => byMile.get(m.id) > 0).map((m) => ({ label: m.title, secs: byMile.get(m.id) })), ...(req ? [{ label: 'Requests you agreed to', secs: req }] : []), ...(other ? [{ label: 'Other work on the project', secs: other }] : [])];
    const total = rows.reduce((n, x) => n + x.secs, 0);
    const today = T.localDay(clockNow(), ctx.calc.companyTz());
    return { month, lines, total_secs: total, retainer_hours: a.c.retainer_hours, ready: today.slice(0, 7) > month, project: a.p.name, client: a.c.name, org: ctx.cfg.orgName };
  }
  const monthQ = (query) => (/^\d{4}-\d{2}$/.test(query.get('month') || '') ? query.get('month') : ctx.portalThisMonth());
  route('GET', '/api/portal/projects/:id/statement', ({ user, params, query }) => {
    const a = access(user, params.id);
    if (a.client) need(a.s.hours !== 'off', 403, 'Hours are not shared for this project');
    return statementOf(a, monthQ(query));
  }, C);
  route('GET', '/api/portal/projects/:id/statement.pdf', ({ user, params, query }) => {
    const a = access(user, params.id);
    if (a.client) need(a.s.hours !== 'off', 403, 'Hours are not shared for this project');
    const s = statementOf(a, monthQ(query));
    const [y, m] = s.month.split('-').map(Number);
    const mName = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const h = (secs) => `${(secs / 3600).toFixed(1)}h`;
    const doc = new Pdf();
    // the company's branding (Settings, Company): its logo, address and colour on the client's statement
    const co = ctx.companyFor(null), D = ctx.docParts, { L, R } = D;
    let yy = D.head(doc, co, { title: 'Statement', sub: mName, sub2: s.ready ? `For ${s.client}, final` : `For ${s.client}, so far, as of ${T.human(T.localDay(clockNow(), ctx.calc.companyTz())).replace(/^\w+, /, '')}` }) + 10;
    doc.text(L, yy, s.project, { size: 13, bold: true }); yy += 30;
    doc.text(L, yy, 'Milestone', { size: 10, bold: true, color: '#5B6B78' });
    doc.text(R, yy, 'Hours', { size: 10, bold: true, color: '#5B6B78', align: 'right' }); yy += 10;
    doc.line(L, yy, R, yy, { color: '#C9D2DA' }); yy += 20;
    for (const l of s.lines) {
      if (yy > 760) { doc.page(); yy = 60; }
      doc.text(L, yy, l.label, { size: 11, maxW: R - L - 90 });
      doc.text(R, yy, h(l.secs), { size: 11, align: 'right' }); yy += 10;
      doc.line(L, yy, R, yy); yy += 20;
    }
    if (!s.lines.length) { doc.text(L, yy, 'No hours logged this month.', { size: 11, color: '#5B6B78' }); yy += 30; }
    doc.text(L, yy, 'Total', { size: 12, bold: true });
    doc.text(R, yy, `${h(s.total_secs)}${s.retainer_hours ? ` of ${s.retainer_hours}h` : ''}`, { size: 12, bold: true, align: 'right' }); yy += 34;
    if (s.retainer_hours) {
      const pct = Math.min(1, s.total_secs / 3600 / s.retainer_hours);
      doc.rect(L, yy, R - L, 8, { fill: '#E7ECF0' }); doc.rect(L, yy, (R - L) * pct, 8, { fill: D.brandOf(co) }); yy += 28;
      doc.text(L, yy, `${Math.round((s.total_secs / 3600 / s.retainer_hours) * 100)}% of the ${s.retainer_hours}-hour monthly retainer`, { size: 10, color: '#5B6B78' }); yy += 30;
    }
    doc.para(L, yy, `Hours come from the team's Staffwarden timers, only while they work on this project. This statement matches the invoice from ${s.org}.`, { size: 9.5, maxW: R - L });
    D.foot(doc, co);
    return { raw: doc.toBuffer({ title: `${s.client} statement ${s.month}`, author: s.org }), type: 'application/pdf', headers: { 'Content-Disposition': `attachment; filename="${a.p.key}-statement-${s.month}.pdf"`, 'Cache-Control': 'private, no-store' } };
  }, C);

  // =================================================================================================
  // the team's side: one inbox across clients, with how long each thing has waited
  // =================================================================================================
  function inboxFor(user, { projectId = null } = {}) {
    const projects = db.prepare(`SELECT p.* FROM projects p JOIN clients c ON c.id = p.client_id WHERE c.archived = 0 AND p.status != 'archived' ${projectId ? 'AND p.id = ?' : ''}`).all(...(projectId ? [projectId] : []))
      .filter((p) => ctx.projectVisible(user, p));
    const items = [];
    const now = clockNow();
    for (const p of projects) {
      const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
      const s = ctx.clientSettings(c);
      const base = { project_id: p.id, project: p.name, project_key: p.key, client_id: c.id, client: c.name };
      // chats: the client wrote last, and nobody from the team answered (team-only notes don't count)
      const threads = db.prepare('SELECT * FROM chat_threads WHERE project_id = ?').all(p.id).filter((th) => th.kind === 'group' || th.staff_id === user.id || ctx.isManager(user));
      for (const th of threads) {
        const lastStaff = db.prepare("SELECT MAX(id) m FROM chat_messages WHERE thread_id = ? AND author_kind = 'staff' AND team_only = 0 AND deleted_at IS NULL").get(th.id).m || 0;
        const waiting = db.prepare("SELECT * FROM chat_messages WHERE thread_id = ? AND author_kind = 'client' AND deleted_at IS NULL AND id > ? ORDER BY id").all(th.id, lastStaff);
        if (!waiting.length) continue;
        const last = waiting[waiting.length - 1];
        // a direct chat belongs to its two people: others see that it waits, never what it says
        const shut = th.kind === 'direct' && th.staff_id !== user.id;
        items.push({ ...base, kind: 'msg', key: `m${th.id}`, thread_id: th.id, direct: th.kind === 'direct', private: shut, since: waiting[0].created_at, from: who('client', last.author_id),
          text: shut ? `Direct message to ${staffName(th.staff_id).split(' ')[0]}` : last.body || (last.voice_secs != null ? `Voice message · ${Math.floor(last.voice_secs / 60)}:${String(last.voice_secs % 60).padStart(2, '0')}` : last.file_name || ''), count: waiting.length,
          owner_id: th.kind === 'direct' ? th.staff_id : p.lead_id });
      }
      // requests nobody has answered (no reply, no estimate), or where the client wrote last in the thread
      if (s.requests) for (const r of db.prepare("SELECT * FROM client_requests WHERE project_id = ? AND status IN ('new','planned')").all(p.id)) {
        const lastStaffMsg = db.prepare("SELECT MAX(id) m FROM request_messages WHERE request_id = ? AND author_kind = 'staff'").get(r.id).m;
        const lastClientMsg = db.prepare("SELECT * FROM request_messages WHERE request_id = ? AND author_kind = 'client' ORDER BY id DESC LIMIT 1").get(r.id);
        const answered = r.estimate_at || r.decided_at || lastStaffMsg;
        if (r.status === 'new' && !answered) items.push({ ...base, kind: 'req', key: `r${r.id}`, request_id: r.id, since: r.created_at, from: r.client_user_id ? who('client', r.client_user_id) : null, text: r.title, detail: r.detail, owner_id: p.lead_id });
        else if (lastClientMsg && (!lastStaffMsg || lastClientMsg.id > lastStaffMsg)) items.push({ ...base, kind: 'req', key: `r${r.id}`, request_id: r.id, since: lastClientMsg.created_at, from: who('client', lastClientMsg.author_id), text: `On “${r.title}”: ${lastClientMsg.body}`, owner_id: r.estimate_by || p.lead_id });
      }
      // approvals the client sent back with changes: the team owes a new version
      if (s.approvals) for (const x of db.prepare("SELECT * FROM approvals WHERE project_id = ? AND status = 'changes'").all(p.id)) {
        const v = db.prepare('SELECT * FROM approval_versions WHERE approval_id = ? ORDER BY n DESC LIMIT 1').get(x.id);
        items.push({ ...base, kind: 'ok', key: `a${x.id}`, approval_id: x.id, since: (v && v.decided_at) || x.created_at, from: v && v.decided_by ? who('client', v.decided_by) : null, text: `Asked for changes on “${x.title}”${v && v.n ? `, version ${v.n}` : ''}`, detail: v ? v.decision_note : null, owner_id: x.created_by });
      }
      // task comments where the client wrote last
      for (const t of db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(p.id)) {
        if (!ctx.portalTaskVisible(t, s)) continue;
        const last = db.prepare('SELECT * FROM task_comments WHERE task_id = ? AND team_only = 0 ORDER BY created_at DESC, id DESC LIMIT 1').get(t.id);
        if (!last || !last.client_user_id) continue;
        items.push({ ...base, kind: 'cmt', key: `c${t.id}`, task_id: t.id, task: t.title, since: last.created_at, from: who('client', last.client_user_id), text: `On “${t.title}”: ${last.body || last.file_name || ''}`, owner_id: t.assignee_id || p.lead_id });
      }
    }
    for (const it of items) {
      const mins = Math.max(0, Math.round((now - Date.parse(it.since)) / 60000));
      it.waited_min = mins;
      it.level = mins >= 240 ? 'late' : mins >= 120 ? 'warn' : 'ok';
      it.owner = it.owner_id ? { id: it.owner_id, name: staffName(it.owner_id) } : null;
      it.mine = it.owner_id === user.id;
    }
    return items.sort((x, y) => (x.since < y.since ? -1 : 1));
  }
  ctx.clientInbox = inboxFor;
  route('GET', '/api/client-inbox', ({ user, query }) => {
    const items = inboxFor(user, { projectId: Number(query.get('project')) || null });
    const today = new Date(clockNow() - 24 * HOUR).toISOString();
    const answered = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT m.author_id) w FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id JOIN projects p ON p.id = t.project_id WHERE m.author_kind = 'staff' AND m.team_only = 0 AND m.created_at > ? AND p.client_id IS NOT NULL").get(today);
    // how quickly the team answered client messages this week (first reply after a client message)
    const weekAgo = new Date(clockNow() - 7 * 24 * HOUR).toISOString();
    const waits = [];
    for (const th of db.prepare('SELECT t.id FROM chat_threads t JOIN projects p ON p.id = t.project_id WHERE p.client_id IS NOT NULL').all()) {
      const msgs = db.prepare('SELECT author_kind, created_at, team_only FROM chat_messages WHERE thread_id = ? AND created_at > ? AND deleted_at IS NULL ORDER BY id').all(th.id, weekAgo);
      let open = null;
      for (const m of msgs) { if (m.author_kind === 'client' && !open) open = m.created_at; else if (m.author_kind === 'staff' && !m.team_only && open) { waits.push(Date.parse(m.created_at) - Date.parse(open)); open = null; } }
    }
    waits.sort((x, y) => x - y);
    const median = waits.length ? Math.round(waits[Math.floor(waits.length / 2)] / 60000) : null;
    return { items, summary: { waiting: items.length, clients: new Set(items.map((i) => i.client_id)).size, late: items.filter((i) => i.level === 'late').length, late_clients: [...new Set(items.filter((i) => i.level === 'late').map((i) => i.client))], typical_reply_min: median, answered_today: answered.n, answered_by: answered.w } };
  });

  // a nudge to whoever should answer something a client is waiting on (managers, for someone else's item)
  route('POST', '/api/client-inbox/remind', ({ user, body }) => {
    need(user.kind !== 'client', 403, 'Not allowed');
    const it = inboxFor(user).find((x) => x.key === String(body.key || ''));
    need(it, 404, 'That was answered already');
    need(it.owner_id && it.owner_id !== user.id, 400, 'Nobody else is down to answer this');
    need(ctx.isManager(user), 403, 'Only managers can send reminders');
    const first = it.from ? it.from.name.split(' ')[0] : it.client;
    ctx.notify.notify(it.owner_id, { kind: 'client_message', title: `${first} from ${it.client} is waiting on you`, body: `${it.private ? 'Your direct chat' : it.text}. Waiting ${Math.round(it.waited_min / 60)}h.`, link: it.kind === 'msg' ? `#/project?id=${it.project_id}&tab=client&ct=${it.thread_id}` : `#/inbox?i=${it.key}`, actor: user, dedupe: `ibxremind:${it.key}:${clockNow() - (clockNow() % 3600000)}` });
    return { ok: true, to: staffName(it.owner_id) };
  });

  // =================================================================================================
  // client health, for the Clients page (owners and managers)
  // =================================================================================================
  route('GET', '/api/client-health', ({ user }) => {
    ctx.needManager(user);
    const items = inboxFor(user);
    const month = ctx.portalThisMonth(), [from, to] = ctx.portalMonthWindow(month);
    const today = ctx.calc.companyToday();
    const [y, m] = month.split('-').map(Number), daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate(), daysLeft = daysIn - Number(today.slice(8, 10));
    const out = {};
    for (const c of db.prepare('SELECT * FROM clients WHERE archived = 0').all()) {
      const people = db.prepare('SELECT id, last_seen_at, name FROM client_users WHERE client_id = ? AND active = 1').all(c.id);
      const last = people.map((p) => p.last_seen_at).filter(Boolean).sort().pop() || null;
      const lastBy = last ? (people.find((p) => p.last_seen_at === last) || {}).name : null;
      const pids = db.prepare('SELECT id FROM projects WHERE client_id = ?').all(c.id).map((r) => r.id);
      const secs = pids.reduce((n, pid) => n + ctx.portalWorked(pid, from, to).reduce((k, x) => k + x.secs, 0), 0);
      const pct = c.retainer_hours ? Math.round(secs / 36 / c.retainer_hours) : null;
      const ratings = pids.length ? db.prepare(`SELECT r.stars, r.created_at FROM milestone_ratings r JOIN milestones m ON m.id = r.milestone_id WHERE m.project_id IN (${pids.map(() => '?').join(',')}) ORDER BY r.created_at DESC`).all(...pids) : [];
      const avg = ratings.length ? Math.round((ratings.reduce((n, r) => n + r.stars, 0) / ratings.length) * 10) / 10 : null;
      const mine = items.filter((i) => i.client_id === c.id);
      const lateN = mine.filter((i) => i.level === 'late').length;
      const idleDays = last ? Math.floor((clockNow() - Date.parse(last)) / 86400000) : null;
      const why = [], bad = [];
      if (people.length && (idleDays == null || idleDays >= 10)) bad.push(idleDays == null ? 'Nobody there has signed in yet' : `No sign-in for ${idleDays} days`);
      if (lateN >= 2 || mine.some((i) => i.waited_min >= 24 * 60)) bad.push(`${plural(lateN, 'thing')} waiting over 4 hours`);
      else if (lateN === 1) why.push('A reply is past 4 hours');
      if (ratings[0] && ratings[0].stars <= 3) why.push(`Last rating ${ratings[0].stars} stars`);
      if (pct != null && pct >= 95 && daysLeft > 2) why.push(`Retainer at ${pct}% with ${daysLeft} days left`);
      const health = bad.length ? 'risk' : why.length ? 'watch' : 'good';
      out[c.id] = { health, reasons: [...bad, ...why], last_seen_at: last, last_seen_by: lastBy, waiting: mine.length, oldest_min: mine.length ? Math.max(...mine.map((i) => i.waited_min)) : 0,
        level: lateN ? 'late' : mine.some((i) => i.level === 'warn') ? 'warn' : 'ok', retainer_pct: pct, rating: avg, ratings: ratings.length,
        retainer_hours: c.retainer_hours || null, month_secs: secs, days_left: daysLeft,
        seen_week: people.filter((p) => p.last_seen_at && clockNow() - Date.parse(p.last_seen_at) < 7 * 86400000).map((p) => ({ id: p.id, name: p.name })) };
    }
    return out;
  });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // =================================================================================================
  // the weekly update, on a schedule
  // =================================================================================================
  const schedOut = (r, a) => ({ on: r ? !!r.on_ : false, dow: r ? r.dow : 5, time: r ? r.time : '16:00', author_id: r ? r.author_id || a.p.lead_id : a.p.lead_id, author: staffName(r ? r.author_id || a.p.lead_id : a.p.lead_id), intro: r ? r.intro || '' : '', last_sent_day: r ? r.last_sent_day : null, tz_name: a.c.tz_name || null, next_at: r && r.on_ ? nextRun(r, a) : null });
  function nextRun(r, a) {
    let day = T.localDay(clockNow(), clientTz(a.c));
    for (let i = 0; i < 8; i++, day = T.addDays(day, 1)) {
      if (T.dow(day) !== r.dow) continue;
      const at = T.dayStartMs(day, clientTz(a.c, Date.parse(`${day}T12:00:00Z`))) + T.hhmm(r.time) * 60000;
      if (at > clockNow() && r.last_sent_day !== day) return new Date(at).toISOString();
    }
    return null;
  }
  route('GET', '/api/portal/projects/:id/update-schedule', ({ user, params }) => {
    need(user.kind !== 'client', 403, 'Not allowed');
    const a = access(user, params.id);
    return { ...schedOut(db.prepare('SELECT * FROM update_schedules WHERE project_id = ?').get(a.p.id), a), draft: ctx.portalDraft(a) };
  });
  route('PUT', '/api/portal/projects/:id/update-schedule', ({ user, params, body }) => {
    const a = access(user, params.id);
    needManage(a);
    const dow = body.dow == null ? 5 : int(Number(body.dow), 'dow', 0, 6);
    const time = body.time || '16:00';
    need(T.validHhmm(time), 400, 'Pick a time');
    const author = body.author_id ? Number(body.author_id) : a.p.lead_id || user.id;
    need(ctx.isProjectMember(a.p.id, author) || author === a.p.lead_id, 400, 'That person is not on this project');
    db.prepare(`INSERT INTO update_schedules (project_id, on_, dow, time, author_id, intro, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET on_ = excluded.on_, dow = excluded.dow, time = excluded.time, author_id = excluded.author_id, intro = excluded.intro, updated_at = excluded.updated_at`)
      .run(a.p.id, body.on === false ? 0 : 1, dow, time, author, optStr(body.intro, 'intro', 3000), nowIso());
    return schedOut(db.prepare('SELECT * FROM update_schedules WHERE project_id = ?').get(a.p.id), a);
  });

  // =================================================================================================
  // every minute: scheduled updates, call reminders, hour alerts and approval reminders
  // =================================================================================================
  function sweep() {
    let n = 0;
    const now = clockNow();
    // the weekly update: a reminder to its writer the day before, then it goes out on time
    for (const r of db.prepare('SELECT * FROM update_schedules WHERE on_ = 1').all()) {
      const p = ctx.getProject(r.project_id);
      if (!p || !p.client_id) continue;
      const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
      if (!c || c.archived) continue;
      const tz = clientTz(c), day = T.localDay(now, tz), min = T.localMinOfDay(now, tz);
      const author = r.author_id || p.lead_id;
      if (T.dow(T.addDays(day, 1)) === r.dow && min >= T.hhmm(r.time) && r.reminded_day !== day && author) {
        db.prepare('UPDATE update_schedules SET reminded_day = ? WHERE project_id = ?').run(day, p.id);
        n += ctx.notify.notify(author, { kind: 'client_request', title: `${p.name}: the weekly update goes to ${c.name} tomorrow`, body: `At ${r.time} their time. Staffwarden has filled in what got done and what is next; add a line of your own if you like.`, link: `#/project?id=${p.id}&tab=client`, dedupe: `updrem:${p.id}:${day}` });
      }
      if (T.dow(day) === r.dow && min >= T.hhmm(r.time) && r.last_sent_day !== day) {
        db.prepare('UPDATE update_schedules SET last_sent_day = ? WHERE project_id = ?').run(day, p.id);
        const recent = db.prepare('SELECT 1 FROM project_updates WHERE project_id = ? AND created_at > ?').get(p.id, new Date(now - 2 * 86400000).toISOString());
        const u = author ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(author) : null;
        if (recent || !u) continue;   // someone already posted one this week, or nobody to send it as
        const a = { p, c, s: ctx.clientSettings(c), client: false, manage: true };
        const d = ctx.portalDraft(a);
        const intro = r.intro || (d.done.length ? `Here is the week on ${p.name}: ${d.done.length === 1 ? 'one thing' : `${d.done.length} things`} got done, and here is what comes next.` : `Here is where ${p.name} stands this week, and what comes next.`);
        ctx.portalPostUpdate(a, u, { intro, done: d.done, next: d.next, needed: d.needed });
        db.prepare('UPDATE update_schedules SET intro = NULL WHERE project_id = ?').run(p.id);   // a line written for this week is used once
        n++;
      }
    }
    // an hour before a call
    for (const m of db.prepare('SELECT * FROM meetings WHERE cancelled_at IS NULL AND starts_at > ? AND starts_at <= ?').all(new Date(now).toISOString(), new Date(now + HOUR).toISOString())) {
      const p = ctx.getProject(m.project_id);
      if (p && p.client_id) n += P().toProject(p, { kind: 'meeting', link: `#/meetings?p=${p.id}`, title: `${m.title} starts in ${Math.max(1, Math.round((Date.parse(m.starts_at) - now) / 60000))} minutes`, body: m.link ? 'Join from Meetings.' : null, dedupe: `m1h:${m.id}` });
    }
    // hour alerts: the client at 80% (if they want it), the lead at 80% and before going over
    for (const p of db.prepare("SELECT p.*, c.retainer_hours, c.tz_name, c.id AS cid FROM projects p JOIN clients c ON c.id = p.client_id WHERE c.archived = 0 AND c.retainer_hours IS NOT NULL AND p.status != 'archived'").all()) {
      const month = ctx.portalThisMonth(), [from, to] = ctx.portalMonthWindow(month);
      const used = ctx.portalWorked(p.id, from, to).reduce((k, x) => k + x.secs, 0) / 3600;
      const pct = used / p.retainer_hours;
      const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.cid);
      const s = ctx.clientSettings(c);
      if (pct >= 0.8) {
        if (s.hours !== 'off') {
          const want = db.prepare('SELECT * FROM client_users WHERE client_id = ? AND active = 1').all(p.cid).filter((cu) => P().prefsOf(cu).hours80).map((cu) => cu.id);
          n += P().notifyClient(want, { kind: 'hours_80', project_id: p.id, link: `#/hours?p=${p.id}`, title: `You’ve used ${Math.floor(pct * 100)}% of this month’s retainer`, body: `${Math.round(used)} of ${p.retainer_hours} hours on ${p.name}. The team checks with you before going over.`, dedupe: `h80:${p.id}:${month}` });
        }
        n += ctx.notify.notify([p.lead_id], { kind: 'client_request', title: `${c.name} is at ${Math.floor(pct * 100)}% of their retainer`, body: `${Math.round(used)} of ${p.retainer_hours} hours on ${p.name} this month.`, link: `#/project?id=${p.id}&tab=client`, dedupe: `h80:${p.id}:${month}` });
      }
      if (pct >= 0.95) n += ctx.notify.notify([p.lead_id], { kind: 'client_request', title: `${c.name} is about to go over their retainer`, body: `Ask ${c.name} before going over: ${Math.round(used)} of ${p.retainer_hours} hours used on ${p.name}.`, link: `#/project?id=${p.id}&tab=client`, dedupe: `h95:${p.id}:${month}` });
      // the week's hours, on Friday afternoon their time, for those who asked
      const tz = clientTz(c), day = T.localDay(now, tz);
      if (s.hours !== 'off' && T.dow(day) === 5 && T.localMinOfDay(now, tz) >= 16 * 60) {
        const wk = ctx.portalWorked(p.id, T.dayStartMs(T.mondayOf(day), tz), now).reduce((k, x) => k + x.secs, 0) / 3600;
        const want = db.prepare('SELECT * FROM client_users WHERE client_id = ? AND active = 1').all(p.cid).filter((cu) => P().prefsOf(cu).hours_week).map((cu) => cu.id);
        n += P().notifyClient(want, { kind: 'hours_week', project_id: p.id, link: `#/hours?p=${p.id}`, title: `This week on ${p.name}: ${Math.round(wk * 10) / 10} hours`, body: `${Math.round(used)} of ${p.retainer_hours} hours used this month.`, dedupe: `hw:${p.id}:${day}` });
      }
    }
    // approvals waiting two days or more get a reminder, then again every three days
    for (const x of db.prepare("SELECT * FROM approvals WHERE status = 'waiting'").all()) {
      const v = db.prepare('SELECT created_at FROM approval_versions WHERE approval_id = ? ORDER BY n DESC LIMIT 1').get(x.id);
      const asked = Date.parse((v && v.created_at) || x.created_at);
      if (now - asked < 48 * HOUR) continue;
      if (x.reminded_at && now - Date.parse(x.reminded_at) < 72 * HOUR) continue;
      const p = ctx.getProject(x.project_id);
      if (!p || !p.client_id) continue;
      const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
      if (!c || c.archived || !ctx.clientSettings(c).approvals) continue;
      n += remind(x, { p, c, s: ctx.clientSettings(c) });
    }
    return n;
  }
  ctx.portalSweep = sweep;
};
