'use strict';
// v5, everything in one: the team's own chat (everyone, channels, groups, direct), replies, mentions,
// messages made into tasks, notifications per device with quiet hours, check-ins, announcements, the
// owner's boost, idle and low-activity nudges, and god mode (looks only).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');
const crypto = require('node:crypto');
const subKeys = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }; };

let env, hira, waseem, sara, mgr, proj, pushed;
before(async () => {
  pushed = [];
  env = await makeEnv({ app: { pushFetch: async (url, o) => { pushed.push({ url, o }); return { status: 201 }; } } });
  hira = await env.person('hira', 'Hira Qureshi');
  waseem = await env.person('waseem', 'Muhammad Waseem');
  sara = await env.person('sara', 'Sara Khan');
  mgr = await env.person('mgr', 'Maya Manager', { role: 'manager' });
  proj = await env.ok('POST', '/api/projects', { token: env.tokens.owner, body: { name: 'CRM rebuild', key: 'CRM', lead_id: hira.id, member_ids: [waseem.id] } });
});
after(() => env.close());

const threadsOf = (key) => env.ok('GET', '/api/team/threads', { token: env.tokens[key] });
const notes = (uid) => env.app.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id').all(uid);

test('everyone is in the company chat; direct messages and channels work like WhatsApp', async () => {
  const { ok, api, tokens } = env;
  const t = await threadsOf('hira');
  const co = t.threads.find((x) => x.special === 'company');
  assert.ok(co); assert.equal(co.count, 5); assert.match(co.name, /^Everyone at/);
  assert.ok(t.threads.find((x) => x.special === 'announcements'));
  // a direct message, the same thread from either side
  const dm = await ok('POST', '/api/team/dm', { token: tokens.hira, body: { user_id: waseem.id } });
  const dm2 = await ok('POST', '/api/team/dm', { token: tokens.waseem, body: { user_id: hira.id } });
  assert.equal(dm.id, dm2.id);
  await ok('POST', `/api/chat/threads/${dm.id}/messages`, { token: tokens.hira, body: { body: 'Can you check the Zillow webhook?' } });
  const msgs = await ok('GET', `/api/chat/threads/${dm.id}/messages`, { token: tokens.waseem });
  assert.equal(msgs.thread.kind, 'dm'); assert.equal(msgs.thread.name, 'Hira Qureshi'); assert.equal(msgs.messages[0].body, 'Can you check the Zillow webhook?');
  // nobody else can read it
  assert.equal((await api('GET', `/api/chat/threads/${dm.id}/messages`, { token: tokens.sara })).status, 404);
  // unread badge for Waseem, then read
  assert.equal((await ok('GET', '/api/team/unread', { token: tokens.waseem })).unread, 1);
  await ok('POST', `/api/chat/threads/${dm.id}/read`, { token: tokens.waseem, body: {} });
  assert.equal((await ok('GET', '/api/team/unread', { token: tokens.waseem })).unread, 0);
  // a public channel: anyone can see it and join; posting needs joining
  const ch = await ok('POST', '/api/team/channels', { token: tokens.hira, body: { name: 'Sales Floor', topic: 'Bookings' } });
  const st = await threadsOf('sara');
  assert.ok(st.open.find((x) => x.id === ch.id && x.name === 'sales-floor'));
  assert.equal((await api('POST', `/api/chat/threads/${ch.id}/messages`, { token: tokens.sara, body: { body: 'hi' } })).status, 403);
  await ok('POST', `/api/team/threads/${ch.id}/join`, { token: tokens.sara });
  await ok('POST', `/api/chat/threads/${ch.id}/messages`, { token: tokens.sara, body: { body: '3 bookings before 1 AM' } });
  // the same name twice is refused
  assert.equal((await api('POST', '/api/team/channels', { token: tokens.sara, body: { name: 'sales-floor' } })).status, 409);
  // a private group: invite only
  const g = await ok('POST', '/api/team/channels', { token: tokens.hira, body: { kind: 'group', name: 'Closers', members: [sara.id] } });
  assert.equal((await api('GET', `/api/chat/threads/${g.id}/messages`, { token: tokens.waseem })).status, 404);
  assert.equal((await api('POST', `/api/team/threads/${g.id}/join`, { token: tokens.waseem })).status, 404, 'a private group is not even visible to outsiders');
});

test('ticks: one when sent, two when it reaches their app, blue when read; in a group only when everyone has', async () => {
  const { ok, tokens } = env;
  const { id } = await ok('POST', '/api/team/dm', { token: tokens.sara, body: { user_id: hira.id } });
  const m = await ok('POST', `/api/chat/threads/${id}/messages`, { token: tokens.sara, body: { body: 'tick?' } });
  const tickOf = async () => (await ok('GET', `/api/chat/threads/${id}/messages`, { token: tokens.sara })).messages.find((x) => x.id === m.id).ticks;
  assert.equal(m.ticks, 'sent');
  assert.equal(await tickOf(), 'sent', 'Sara opening her own chat changes nothing');
  await ok('GET', '/api/notifications?limit=5', { token: tokens.hira });       // Hira's desktop app checks in
  assert.equal(await tickOf(), 'delivered');
  assert.equal((await threadsOf('sara')).threads.find((x) => x.id === id).last.ticks, 'delivered', 'the chat list shows them too');
  await ok('POST', `/api/chat/threads/${id}/read`, { token: tokens.hira, body: {} });
  assert.equal(await tickOf(), 'read');
  // a group of three: Hira reading is not enough
  const g = await ok('POST', '/api/team/channels', { token: tokens.sara, body: { kind: 'group', name: 'Tick group', members: [hira.id, waseem.id] } });
  const gm = await ok('POST', `/api/chat/threads/${g.id}/messages`, { token: tokens.sara, body: { body: 'all of you?' } });
  const gTick = async () => (await ok('GET', `/api/chat/threads/${g.id}/messages`, { token: tokens.sara })).messages.find((x) => x.id === gm.id).ticks;
  await ok('POST', `/api/chat/threads/${g.id}/read`, { token: tokens.hira, body: {} });
  assert.equal(await gTick(), 'sent');
  await ok('GET', '/api/team/unread', { token: tokens.waseem });
  assert.equal(await gTick(), 'delivered');
  await ok('POST', `/api/chat/threads/${g.id}/read`, { token: tokens.waseem, body: {} });
  assert.equal(await gTick(), 'read');
});

test('a client can never reach the team chat', async () => {
  const { ok, api, tokens } = env;
  const client = await ok('POST', '/api/clients', { token: tokens.owner, body: { name: 'Harbor & Pine' } });
  await ok('PUT', `/api/clients/${client.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: true } });
  const j = await ok('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'Jess', email: 'jess@hp.com' } });
  const jt = await env.login('jess@hp.com', j.password);
  const co = (await threadsOf('hira')).threads.find((x) => x.special === 'company');
  assert.equal((await api('GET', `/api/chat/threads/${co.id}/messages`, { token: jt })).status, 404);
  assert.equal((await api('POST', `/api/chat/threads/${co.id}/messages`, { token: jt, body: { body: 'hello' } })).status, 404);
  assert.notEqual((await api('GET', '/api/team/threads', { token: jt })).status, 200);
});

test('mentions, replies in a thread, and mutes decide who hears about what', async () => {
  const { ok, tokens } = env;
  const co = (await threadsOf('hira')).threads.find((x) => x.special === 'company');
  const before = notes(waseem.id).length;
  const m = await ok('POST', `/api/chat/threads/${co.id}/messages`, { token: tokens.hira, body: { body: '@Muhammad Waseem can you check the retries first?' } });
  const mine = notes(waseem.id).slice(before);
  assert.ok(mine.find((n) => n.kind === 'chat_mention' && /mentioned you/.test(n.title)));
  // chat notifications never crowd the bell, but the desktop app gets them
  const bell = await ok('GET', '/api/notifications', { token: tokens.waseem });
  assert.ok(!bell.items.some((n) => n.kind.startsWith('chat_')));
  const app = await fetch(`${env.base}/api/notifications?after=0`, { headers: { Authorization: `Bearer ${tokens.waseem}`, 'X-Workhelm-App': '1.0.0 darwin arm64' } }).then((r) => r.json());
  assert.equal(app.items.some((n) => n.kind === 'chat_mention'), true, 'inside the shift, the desktop app pops it up');
  // outside the shift it stays quiet on every device (still listed in the chat)
  env.app.db.prepare("UPDATE users SET shift_start = '18:00', shift_end = '03:30' WHERE id = ?").run(waseem.id);
  await ok('POST', `/api/chat/threads/${co.id}/messages`, { token: tokens.hira, body: { body: '@Muhammad Waseem when you’re in' } });
  const last = notes(waseem.id).at(-1);
  assert.equal(last.kind, 'chat_mention'); assert.equal(last.desktop, 0);
  env.app.db.prepare('UPDATE users SET shift_start = NULL, shift_end = NULL WHERE id = ?').run(waseem.id);
  // a reply hangs under the message; the top level shows a count
  await ok('POST', `/api/chat/threads/${co.id}/messages`, { token: tokens.waseem, body: { body: 'Retries are 3', parent_id: m.id } });
  await ok('POST', `/api/chat/threads/${co.id}/messages`, { token: tokens.sara, body: { body: 'I can help', parent_id: m.id, also_channel: true } });
  const top = await ok('GET', `/api/chat/threads/${co.id}/messages`, { token: tokens.hira });
  const root = top.messages.find((x) => x.id === m.id);
  assert.equal(root.replies.count, 2);
  assert.ok(!top.messages.some((x) => x.body === 'Retries are 3'));
  assert.ok(top.messages.some((x) => x.body === 'I can help' && x.reply && x.reply.id === m.id), 'also sent to the chat');
  const rep = await ok('GET', `/api/chat/threads/${co.id}/messages?parent=${m.id}`, { token: tokens.hira });
  assert.deepEqual(rep.messages.map((x) => x.body), [m.body, 'Retries are 3', 'I can help']);
  // muting the company chat: no more notifications from it, mentions only still lets mentions through
  await ok('PUT', `/api/team/threads/${co.id}/mute`, { token: tokens.sara, body: { mode: 'mentions' } });
  const n0 = notes(sara.id).length;
  await ok('POST', `/api/chat/threads/${co.id}/messages`, { token: tokens.hira, body: { body: 'general chatter' } });
  assert.equal(notes(sara.id).length, n0);
  await ok('POST', `/api/chat/threads/${co.id}/messages`, { token: tokens.hira, body: { body: '@Sara Khan look' } });
  assert.equal(notes(sara.id).length, n0 + 1);
  const th = (await threadsOf('sara')).threads.find((x) => x.special === 'company');
  assert.equal(th.muted, true);
  // muting the company chat never lists it twice
  assert.equal((await threadsOf('sara')).threads.filter((x) => x.special === 'company').length, 1);
});

test('a message becomes a task, linked both ways, and the chat is told', async () => {
  const { ok, api, tokens } = env;
  const co = (await threadsOf('hira')).threads.find((x) => x.special === 'company');
  const m = await ok('POST', `/api/chat/threads/${co.id}/messages`, { token: tokens.hira, body: { body: 'Harbor & Pine wants the second text after 2 business days' } });
  const t = await ok('POST', `/api/chat/messages/${m.id}/task`, { token: tokens.hira, body: { project_id: proj.id, assignee_id: waseem.id, due_day: '2026-10-30', priority: 'high' } });
  assert.equal(t.assignee_id, waseem.id); assert.equal(t.priority, 'high'); assert.match(t.description, /From Hira Qureshi in Everyone at/);
  assert.equal(env.app.db.prepare('SELECT source_message_id s FROM tasks WHERE id = ?').get(t.id).s, m.id);
  const list = await ok('GET', `/api/chat/threads/${co.id}/messages`, { token: tokens.waseem });
  assert.equal(list.messages.find((x) => x.id === m.id).task.id, t.id);
  assert.ok(list.messages.some((x) => x.kind === 'system' && /Made it a task, CRM-\d+/.test(x.body)));
  assert.ok(notes(waseem.id).some((n) => n.kind === 'task_assigned'));
  assert.equal((await api('POST', `/api/chat/messages/${m.id}/task`, { token: tokens.hira, body: {} })).status, 409);
});

test('notifications: each person picks devices per kind; quiet outside the shift; tests reach every device', async () => {
  const { ok, tokens } = env;
  const p = await ok('GET', '/api/me/notify-prefs', { token: tokens.sara });
  const ann = p.categories.find((c) => c.key === 'announce');
  assert.equal(ann.locked, true);
  assert.deepEqual(p.categories.find((c) => c.key === 'chat_channel').channels, { phone: false, desktop: true, browser: false });
  const q = await ok('PUT', '/api/me/notify-prefs', { token: tokens.sara, body: { channels: { chat_channel: { phone: true }, announce: { phone: false } }, quiet: false } });
  assert.equal(q.categories.find((c) => c.key === 'chat_channel').channels.phone, true);
  assert.equal(q.categories.find((c) => c.key === 'announce').channels.phone, true, 'announcements stay on');
  assert.equal(q.quiet, false);
  // a phone and a browser
  await ok('POST', '/api/push/subscribe', { token: tokens.sara, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/p1', keys: subKeys(), device: 'iPhone · Safari' } });
  await ok('POST', '/api/push/subscribe', { token: tokens.sara, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/b1', keys: subKeys(), device: 'Mac · Chrome' } });
  const dev = await ok('GET', '/api/me/notify-prefs', { token: tokens.sara });
  assert.deepEqual(dev.devices.map((d) => d.kind).sort(), ['browser', 'phone']);
  // tasks go to the phone, not the browser (the defaults)
  pushed.length = 0;
  env.app.db.prepare("UPDATE users SET notify_prefs = json_set(notify_prefs, '$.quiet', json('false')) WHERE id = ?").run(sara.id);
  await ok('POST', '/api/tasks', { token: tokens.owner, body: { title: 'Call back the voicemails', assignee_id: sara.id } });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pushed.map((x) => x.url), ['https://fcm.googleapis.com/fcm/send/p1']);
  pushed.length = 0;
  await ok('POST', '/api/me/notify-test', { token: tokens.sara });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pushed.length, 2);
  // with the desktop app open, the browser on that computer doesn't pop it up a second time; the phone still does
  env.app.ctx.desktopLive = (id) => id === sara.id;
  pushed.length = 0;
  env.app.ctx.notify.notify(sara.id, { kind: 'timeoff_decision', title: 'Your Friday off was approved' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pushed.map((x) => x.url), ['https://fcm.googleapis.com/fcm/send/p1']);
  delete env.app.ctx.desktopLive;
});

test('check-ins: hours come from the timer, blockers reach the owner, the team page lists who is missing', async () => {
  const { ok, tokens, advance } = env;
  await ok('POST', '/api/timer/start', { token: tokens.waseem, body: { project_id: proj.id } });
  advance(90 * MIN);
  const mine = await ok('GET', '/api/checkins/mine', { token: tokens.waseem });
  assert.ok(mine.worked_secs >= 89 * 60);
  assert.equal(mine.breakdown[0].project, 'CRM rebuild');
  const ownerId = env.app.db.prepare("SELECT id FROM users WHERE role = 'owner'").get().id;
  const n0 = notes(ownerId).length;
  const c = await ok('PUT', '/api/checkins/mine', { token: tokens.waseem, body: { did: 'Fixed the double texts', next: 'Broker report', blockers: 'Need the export', mood: 'smooth' } });
  assert.ok(c.tracked_secs >= 89 * 60);
  assert.ok(notes(ownerId).slice(n0).some((n) => n.kind === 'checkin_blocked'));
  const all = await ok('GET', `/api/checkins?day=${c.day}`, { token: tokens.owner });
  assert.ok(all.items.find((x) => x.user.id === waseem.id));
  assert.equal(all.counts.blocked, 1);
  // employees see only their own
  const own = await ok('GET', `/api/checkins?day=${c.day}`, { token: tokens.sara });
  assert.ok(!own.items.find((x) => x.user.id === waseem.id));
  // it was posted in #check-ins
  const ci = (await threadsOf('owner')).threads.find((x) => x.name === 'check-ins');
  const msgs = await ok('GET', `/api/chat/threads/${ci.id}/messages`, { token: tokens.owner });
  assert.equal(msgs.messages.at(-1).kind, 'checkin');
});

test('announcements: everyone is told, who has confirmed is counted, reminders go to the rest', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('POST', '/api/announcements', { token: tokens.sara, body: { title: 'x', body: 'y' } })).status, 403);
  const a = await ok('POST', '/api/announcements', { token: tokens.owner, body: { title: 'New shift timings', body: 'From Monday 6:30 PM to 4:00 AM' } });
  assert.equal(a.read, 1);
  assert.ok(notes(sara.id).some((n) => n.kind === 'announcement'));
  const pend = await ok('GET', '/api/announcements/pending', { token: tokens.sara });
  assert.equal(pend[0].id, a.id);
  await ok('POST', `/api/announcements/${a.id}/confirm`, { token: tokens.sara });
  assert.equal((await ok('GET', '/api/announcements/pending', { token: tokens.sara })).length, 0);
  const d = await ok('GET', `/api/announcements/${a.id}`, { token: tokens.owner });
  assert.equal(d.read, 2);
  assert.ok(d.not_yet.find((p) => p.id === hira.id));
  const r = await ok('POST', `/api/announcements/${a.id}/remind`, { token: tokens.owner });
  assert.ok(r.reminded >= 3);
  // pinned in the company chat as an announcement card
  const co = (await threadsOf('hira')).threads.find((x) => x.special === 'company');
  const m = await ok('GET', `/api/chat/threads/${co.id}/messages`, { token: tokens.hira });
  assert.equal(m.pinned.kind, 'announcement');
});

test('only the owner can boost; it goes to people working, and they can boost back', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('POST', '/api/boost', { token: tokens.mgr, body: { vibe: 'chai' } })).status, 403);
  const b = await ok('POST', '/api/boost', { token: tokens.owner, body: { vibe: 'chai' } });
  assert.equal(b.sent_to, 1, 'Waseem is the one with a timer running');
  assert.ok(notes(waseem.id).some((n) => n.kind === 'boost'));
  assert.equal((await api('POST', '/api/boost', { token: tokens.owner, body: { vibe: 'win' } })).status, 429);
  await ok('POST', `/api/boost/${b.id}/answer`, { token: tokens.waseem, body: { answer: 'chai' } });
  const g = await ok('GET', '/api/boost', { token: tokens.owner });
  assert.equal(g.last.chai.length, 1); assert.equal(g.can_boost, true);
  assert.equal((await ok('GET', '/api/boost', { token: tokens.sara })).can_boost, false);
});

test('the boost clip pops up on their laptop: only while working, not for notification-only people, three a shift at most', async () => {
  const { ok, api, tokens, advance } = env;
  assert.deepEqual(await ok('GET', '/api/me/boost-prefs', { token: tokens.waseem }), { popup: 'clip', corner: 'right' });
  assert.deepEqual(await ok('PUT', '/api/me/boost-prefs', { token: tokens.waseem, body: { corner: 'left' } }), { popup: 'clip', corner: 'left' });
  // an app older than 0.9.18 can't show the clip, so he gets a notification and the owner is told why
  const appSays = (v) => fetch(`${env.base}/api/me`, { headers: { Authorization: `Bearer ${tokens.waseem}`, 'X-Workhelm-App': `${v} darwin arm64` } });
  await appSays('0.9.17');
  let g = await ok('GET', '/api/boost', { token: tokens.owner });
  assert.equal(g.clip_ready, 0); assert.equal(g.clip_update, 1);
  advance(6 * MIN);
  const old = await ok('POST', '/api/boost', { token: tokens.owner, body: { vibe: 'win', clip: true } });
  assert.equal(old.popped_up, 0, 'old app: a notification instead');
  await appSays('0.9.19');
  g = await ok('GET', '/api/boost', { token: tokens.owner });
  assert.equal(g.clip_ready, 1); assert.equal(g.clip_update, 0);
  // his shift hours say he is off, but his timer is on: the clip still reaches the desktop app
  const was = env.app.db.prepare('SELECT shift_start, shift_end FROM users WHERE id = ?').get(waseem.id);
  const hm = (ms) => new Date(ms + 5 * 3600000).toISOString().slice(11, 16);   // his clock (Pakistan)
  env.app.db.prepare('UPDATE users SET shift_start = ?, shift_end = ? WHERE id = ?').run(hm(env.clock.t + 3 * 3600000), hm(env.clock.t + 6 * 3600000), waseem.id);
  const shown = () => notes(waseem.id).filter((n) => n.kind === 'boost_clip').length;
  const desktopClips = () => env.app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'boost_clip' AND desktop = 1").get(waseem.id).n;
  for (let i = 1; i <= 4; i++) {
    advance(6 * MIN);
    const b = await ok('POST', '/api/boost', { token: tokens.owner, body: { vibe: 'win', clip: true } });
    assert.equal(b.popped_up, i <= 3 ? 1 : 0, `boost ${i}`);
    const one = await ok('GET', `/api/boost/${b.id}`, { token: tokens.waseem });
    assert.equal(one.clip, true); assert.equal(one.popup, i <= 3); assert.equal(one.corner, 'left'); assert.ok(one.author.first);
  }
  assert.equal(shown(), 3, 'the fourth one arrived as a plain notification');
  assert.equal(desktopClips(), 3, 'all three reach the desktop app');
  env.app.db.prepare('UPDATE users SET shift_start = ?, shift_end = ? WHERE id = ?').run(was.shift_start, was.shift_end, waseem.id);
  assert.equal((await ok('GET', '/api/boost', { token: tokens.owner })).clip_ready, 0);
  advance(13 * 60 * MIN);   // a new shift
  await ok('PUT', '/api/me/boost-prefs', { token: tokens.waseem, body: { popup: 'note' } });
  const b = await ok('POST', '/api/boost', { token: tokens.owner, body: { vibe: 'win', clip: true } });
  assert.equal(b.popped_up, 0, 'notification only, by his choice');
  await ok('PUT', '/api/me/boost-prefs', { token: tokens.waseem, body: { popup: 'clip', corner: 'right' } });
  assert.equal((await api('PUT', '/api/me/boost-prefs', { token: tokens.waseem, body: { corner: 'top' } })).data.corner, 'right');
});

test('idle: the person is asked first, the owner hears only if it goes on; what they say is kept', async () => {
  const { ok, api, tokens, advance, clock } = env;
  const ownerId = env.app.db.prepare("SELECT id FROM users WHERE role = 'owner'").get().id;
  await ok('POST', '/api/timer/idle', { token: tokens.waseem, body: { state: 'start', at: new Date(clock.t).toISOString() } });
  advance(16 * MIN);
  env.app.sweepNotify();
  const flag = await ok('GET', '/api/idle/mine', { token: tokens.waseem });
  assert.ok(flag && flag.kind === 'idle');
  assert.ok(notes(waseem.id).some((n) => n.kind === 'idle_nudge'));
  assert.ok(!notes(ownerId).some((n) => n.kind === 'idle_alert'), 'not yet');
  advance(15 * MIN);
  env.app.sweepNotify();
  assert.ok(notes(ownerId).some((n) => n.kind === 'idle_alert' && /Muhammad Waseem: idle 31 min/.test(n.title)));
  const board = await ok('GET', '/api/idle/board', { token: tokens.owner });
  assert.equal(board.flags[0].user.id, waseem.id);
  assert.equal((await api('GET', '/api/idle/board', { token: tokens.mgr })).status, 403, 'only the owner, unless leads are told');
  await ok('POST', `/api/idle/flags/${flag.id}/answer`, { token: tokens.waseem, body: { answer: 'meeting' } });
  assert.match(env.app.db.prepare("SELECT text FROM notes WHERE user_id = ? AND kind = 'idle'").get(waseem.id).text, /call or a meeting/);
  await ok('POST', '/api/timer/idle', { token: tokens.waseem, body: { state: 'end' } });
  env.app.sweepNotify();
  assert.equal((await ok('GET', '/api/idle/board', { token: tokens.owner })).flags.length, 0);
  const r = await ok('PUT', '/api/idle/rules', { token: tokens.owner, body: { ask_min: 20, tell_lead: true } });
  assert.equal(r.ask_min, 20); assert.equal(r.tell_lead, true);
  assert.equal((await api('PUT', '/api/idle/rules', { token: tokens.mgr, body: { ask_min: 5 } })).status, 403);
});

test('god mode: the owner turns it on, it only changes the look, and screenshots stay the owner’s', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('PUT', `/api/people/${waseem.id}/fun`, { token: tokens.mgr, body: { mode: 'god' } })).status, 403);
  await ok('PUT', `/api/people/${waseem.id}/fun`, { token: tokens.owner, body: { mode: 'god', xp2_hours: 8 } });
  const f = await ok('GET', '/api/me/fun', { token: tokens.waseem });
  assert.equal(f.mode, 'god'); assert.equal(f.intro, true); assert.equal(f.double_xp, true);
  assert.ok(f.level >= 1 && f.xp >= 0 && f.level_next > f.level_floor);
  assert.equal(f.achievements.length, 6);
  assert.ok(f.best_secs >= 0 && typeof f.combo === 'number');
  // the boss: his most pressing task, its health the share of steps still to do
  const t = await ok('POST', '/api/tasks', { token: tokens.owner, body: { title: 'Import the old leads', assignee_id: waseem.id, priority: 'urgent', due_day: '2026-01-05' } });
  await ok('PUT', `/api/tasks/${t.id}/steps`, { token: tokens.owner, body: { steps: [{ title: 'Export', done: true }, { title: 'Map columns' }, { title: 'Import' }, { title: 'Spot check' }] } });
  const g = await ok('GET', '/api/me/fun', { token: tokens.waseem });
  assert.equal(g.boss.id, t.id); assert.equal(g.boss.hp, 75); assert.equal(g.boss.steps, 4); assert.equal(g.boss.next_step, 'Map columns');
  assert.equal(await ok('GET', '/api/me/fun', { token: tokens.sara }), null);
  // still no access to his own screenshot settings
  assert.equal((await api('PATCH', `/api/users/${waseem.id}`, { token: tokens.waseem, body: { shots_per_10: 0 } })).status, 403);
  const calm = await ok('PUT', '/api/me/fun', { token: tokens.waseem, body: { calm: true, intro_seen: true } });
  assert.equal(calm.calm, true); assert.equal(calm.intro, false);
  await ok('PUT', `/api/people/${waseem.id}/fun`, { token: tokens.owner, body: { mode: null } });
  assert.equal(await ok('GET', '/api/me/fun', { token: tokens.waseem }), null);
});

test('the owner can turn the boost pop-up off for one person: no clip, no full-screen show, still a notification', async () => {
  const { ok, api, tokens, advance } = env;
  advance(13 * 60 * MIN);
  const before = await ok('GET', '/api/boost', { token: tokens.owner });
  const w = before.people.find((p) => p.id === waseem.id);
  assert.equal(w.quiet, false); assert.equal(w.working, true);
  assert.equal((await ok('GET', '/api/boost', { token: tokens.waseem })).people, undefined, 'only the owner sees the list');
  assert.equal((await api('PUT', '/api/boost/quiet', { token: tokens.mgr, body: { user_id: waseem.id, quiet: true } })).status, 403);
  await ok('PUT', '/api/boost/quiet', { token: tokens.owner, body: { user_id: waseem.id, quiet: true } });
  const g = await ok('GET', '/api/boost', { token: tokens.owner });
  assert.equal(g.people.find((p) => p.id === waseem.id).quiet, true);
  assert.equal(g.quiet_working, 1); assert.equal(g.clip_ready, 0);
  assert.equal(g.working_now, before.working_now, 'he still counts: he still gets the notification');
  const b = await ok('POST', '/api/boost', { token: tokens.owner, body: { vibe: 'win', clip: true } });
  assert.equal(b.popped_up, 0, 'no clip for him');
  assert.ok(notes(waseem.id).some((n) => n.kind === 'boost' && n.link === `#/?boost=${b.id}`), 'he still gets it as a notification');
  assert.ok(!notes(waseem.id).some((n) => n.kind === 'boost_clip' && n.link === `#/?boost=${b.id}`), 'not as a clip');
  assert.equal((await ok('GET', `/api/boost/${b.id}`, { token: tokens.waseem })).quiet, true);
  await ok('PUT', '/api/boost/quiet', { token: tokens.owner, body: { user_id: waseem.id, quiet: false } });
  assert.equal((await ok('GET', '/api/boost', { token: tokens.owner })).people.find((p) => p.id === waseem.id).quiet, false);
});
