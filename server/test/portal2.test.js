'use strict';
// Portal v2: the client's bell and phone notifications, calls, ratings, request threads and estimates,
// steps, pinned comments, reminders, chat search and presence, the statement, the team's inbox,
// client health, the scheduled update and "see it as the client" (read only).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { makeEnv, MIN } = require('./helpers');
const webpush = require('../lib/webpush');

let env, ayesha, sara, proj, client, jess, dan, jessT, danT;
before(async () => {
  env = await makeEnv();
  ayesha = await env.person('ayesha', 'Ayesha Noor');
  sara = await env.person('sara', 'Sara Khan');
  const { ok, tokens } = env;
  proj = await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'CRM rebuild', key: 'CRM', lead_id: ayesha.id, member_ids: [sara.id] } });
  client = await ok('POST', '/api/clients', { token: tokens.owner, body: { name: 'Harbor & Pine', tz_name: 'America/New_York', retainer_hours: 10 } });
  await ok('PUT', `/api/clients/${client.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: true } });
  const j = await ok('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'Jessica Moore', email: 'jess@harbor.com', can_approve: true } });
  const d = await ok('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'Daniel Ruiz', email: 'dan@harbor.com' } });
  jess = j.person; dan = d.person;
  jessT = await env.login('jess@harbor.com', j.password);
  danT = await env.login('dan@harbor.com', d.password);
});
after(() => env.close());

test('the client has their own bell: approvals, replies and the team\'s messages land there', async () => {
  const { ok, api, tokens } = env;
  const ap = await ok('POST', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha, body: { title: 'New-lead text', body: 'Hi {name}, thanks for asking about the house.' } });
  let bell = await ok('GET', '/api/portal/notifications', { token: jessT });
  assert.equal(bell.unread, 1);
  assert.match(bell.items[0].title, /asked you to approve New-lead text/);
  assert.equal(bell.items[0].link, `#/approvals?p=${proj.id}&a=${ap.id}`);
  // only people who can approve hear about an approval; a file request goes to everyone
  assert.equal((await ok('GET', '/api/portal/notifications', { token: danT })).unread, 0);
  await ok('POST', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha, body: { kind: 'file', title: 'Your export' } });
  assert.equal((await ok('GET', '/api/portal/notifications', { token: danT })).unread, 1);
  // a message from the team, at most once an hour per chat
  const threads = await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: tokens.ayesha });
  await ok('POST', `/api/chat/threads/${threads[0].id}/messages`, { token: tokens.ayesha, body: { body: 'Morning!' } });
  await ok('POST', `/api/chat/threads/${threads[0].id}/messages`, { token: tokens.ayesha, body: { body: 'And another' } });
  await ok('POST', `/api/chat/threads/${threads[0].id}/messages`, { token: tokens.ayesha, body: { body: 'Just for us', team_only: true } });
  bell = await ok('GET', '/api/portal/notifications', { token: danT });
  assert.equal(bell.items.filter((n) => n.kind === 'chat').length, 1);
  assert.ok(!bell.items.some((n) => /Just for us/.test(n.body || '')));
  // marking read; staff can't read a client's bell, and a client can't read the team's
  const r = await ok('POST', '/api/portal/notifications/read', { token: danT, body: { all: true } });
  assert.equal(r.unread, 0);
  assert.equal((await api('GET', '/api/portal/notifications', { token: tokens.ayesha })).status, 403);
  assert.equal((await api('GET', '/api/notifications', { token: danT })).status, 403);
});

test('see it as the client: the portal reads as that person, and nothing can be sent', async () => {
  const { ok, api, tokens } = env;
  const hdr = { 'X-Workhelm-View-As': String(jess.id) };
  const get = (url, token) => fetch(env.base + url, { headers: { Authorization: `Bearer ${token}`, ...hdr } });
  const me = await (await get('/api/me', tokens.ayesha)).json();
  assert.equal(me.kind, 'client'); assert.equal(me.name, 'Jessica Moore'); assert.equal(me.preview, true);
  const home = await (await get('/api/portal', tokens.ayesha)).json();
  assert.deepEqual(home.projects.map((p) => p.name), ['CRM rebuild']);
  // nothing is written while previewing
  const res = await fetch(`${env.base}/api/portal/projects/${proj.id}/requests`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.ayesha}`, 'Content-Type': 'application/json', ...hdr }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(res.status, 403);
  // someone who doesn't run one of the client's projects can't use it
  assert.equal((await get('/api/me', tokens.sara)).status, 403);
  void ok; void api;
});

test('calls: booked by the team in the client\'s time, an agenda both add to, notes afterwards, an .ics file', async () => {
  const { ok, api, tokens, clock } = env;
  const day = new Date(clock.t + 3 * 86400000).toISOString().slice(0, 10);
  const m = await ok('POST', `/api/portal/projects/${proj.id}/meetings`, { token: tokens.ayesha, body: { title: 'Weekly check-in', day, time: '15:00', minutes: 30, link: 'https://meet.google.com/abc-defg-hij', agenda: ['The new-lead text'] } });
  // 3 PM in Tampa
  assert.equal(new Date(m.starts_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }), '3:00 PM');
  assert.equal((await api('POST', `/api/portal/projects/${proj.id}/meetings`, { token: jessT, body: { day, time: '15:00' } })).status, 403);
  assert.equal((await api('POST', `/api/portal/projects/${proj.id}/meetings`, { token: tokens.ayesha, body: { day, time: '15:00', link: 'javascript:alert(1)' } })).status, 400);
  await ok('POST', `/api/portal/meetings/${m.id}/agenda`, { token: jessT, body: { text: 'Can we text leads on weekends?' } });
  const ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.equal(ov.next_meeting.id, m.id);
  assert.deepEqual(ov.next_meeting.agenda.map((x) => [x.text, x.by.name, x.mine]), [['The new-lead text', 'Ayesha Noor', false], ['Can we text leads on weekends?', 'Jessica Moore', true]]);
  // the client can take off only what they added
  assert.equal((await api('DELETE', `/api/portal/meetings/${m.id}/agenda/0`, { token: jessT })).status, 403);
  const ics = await api('GET', `/api/portal/meetings/${m.id}/ics`, { token: jessT });
  assert.match(ics.data, /BEGIN:VEVENT[\s\S]*SUMMARY:Weekly check-in[\s\S]*URL:https:\/\/meet.google.com/);
  // notes link to tasks; a team-only task never shows its name to the client
  const t1 = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: 'Lead scoring', project_id: proj.id } });
  const t2 = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: 'Internal QA', project_id: proj.id } });
  await ok('PATCH', `/api/tasks/${t2.id}`, { token: tokens.ayesha, body: { client_visible: 0 } });
  await ok('PUT', `/api/portal/meetings/${m.id}/notes`, { token: tokens.ayesha, body: { decided: ['No calls on Sundays'], next: [{ task_id: t1.id }, { task_id: t2.id }], from_client: ['Send the export'] } });
  const list = await ok('GET', `/api/portal/projects/${proj.id}/meetings`, { token: jessT });
  const notes = list.upcoming[0].notes;
  assert.deepEqual(notes.decided, ['No calls on Sundays']);
  assert.equal(notes.next[0].task.title, 'Lead scoring');
  assert.equal(notes.next[1].task, null);
  assert.ok(!JSON.stringify(notes).includes('Internal QA'));
  assert.ok((await ok('GET', '/api/portal/notifications', { token: danT })).items.some((n) => n.kind === 'meeting_notes'));
});

test('a finished milestone asks the client how it went; only the team sees the answer', async () => {
  const { ok, api, tokens } = env;
  await ok('PUT', `/api/portal/projects/${proj.id}/milestones`, { token: tokens.ayesha, body: { milestones: [{ title: 'CRM set up', done: true }, { title: 'Pipelines', due_day: '2026-11-07' }] } });
  let ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.equal(ov.rate_milestone.title, 'CRM set up');
  assert.equal(ov.status.state, 'on');
  assert.match(ov.status.text, /Pipelines is due Nov 7/);
  assert.equal((await api('POST', `/api/portal/milestones/${ov.milestones[1].id}/rating`, { token: jessT, body: { stars: 5 } })).status, 400);
  await ok('POST', `/api/portal/milestones/${ov.rate_milestone.id}/rating`, { token: jessT, body: { stars: 4, note: 'Fast work' } });
  ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.equal(ov.rate_milestone, null);
  assert.equal(ov.ratings, undefined);
  const team = await ok('GET', `/api/portal/projects/${proj.id}`, { token: tokens.ayesha });
  assert.deepEqual(team.ratings.map((r) => [r.stars, r.note, r.by]), [[4, 'Fast work', 'Jessica Moore']]);
});

test('requests: a thread, edit and cancel while new, an estimate the client answers', async () => {
  const { ok, api, tokens } = env;
  const r = await ok('POST', `/api/portal/projects/${proj.id}/requests`, { token: jessT, body: { title: 'Wait 2 days before the second text', kind: 'change' } });
  await ok('PATCH', `/api/portal/requests/${r.id}`, { token: jessT, body: { title: 'Wait 2 days before the 2nd text' } });
  await ok('POST', `/api/portal/requests/${r.id}/messages`, { token: tokens.ayesha, body: { body: 'For every lead, or only website ones?' } });
  await ok('POST', `/api/portal/requests/${r.id}/messages`, { token: jessT, body: { body: 'Every lead' } });
  const msgs = await ok('GET', `/api/portal/requests/${r.id}/messages`, { token: jessT });
  assert.deepEqual(msgs.map((m) => [m.author.name, m.mine]), [['Ayesha Noor', false], ['Jessica Moore', true]]);
  // the inbox shows the client's reply waiting on the team
  let inbox = await ok('GET', '/api/client-inbox', { token: tokens.ayesha });
  assert.ok(inbox.items.some((i) => i.kind === 'req' && i.request_id === r.id && /Every lead/.test(i.text)));
  // only the lead or a manager estimates
  assert.equal((await api('POST', `/api/portal/requests/${r.id}/estimate`, { token: tokens.sara, body: { hours: 3 } })).status, 403);
  const est = await ok('POST', `/api/portal/requests/${r.id}/estimate`, { token: tokens.ayesha, body: { hours: 3, note: 'Two new steps in the follow-up' } });
  assert.equal(est.estimate.hours, 3);
  assert.ok((await ok('GET', '/api/portal/notifications', { token: jessT })).items.some((n) => n.kind === 'request_estimate'));
  const ret = await ok('GET', `/api/portal/projects/${proj.id}/retainer`, { token: jessT });
  assert.equal(ret.retainer_hours, 10);
  // once answered it can't be edited
  const yes = await ok('POST', `/api/portal/requests/${r.id}/answer`, { token: jessT, body: { answer: 'yes' } });
  assert.equal(yes.status, 'planned');
  assert.ok(yes.task && yes.task.title === 'Wait 2 days before the 2nd text');
  assert.equal((await api('PATCH', `/api/portal/requests/${r.id}`, { token: jessT, body: { title: 'x' } })).status, 409);
  assert.equal((await ok('GET', `/api/portal/projects/${proj.id}/retainer`, { token: jessT })).agreed_hours, 3);
  // a new one can be cancelled
  const r2 = await ok('POST', `/api/portal/projects/${proj.id}/requests`, { token: jessT, body: { title: 'Call leads on Sundays' } });
  assert.equal((await ok('POST', `/api/portal/requests/${r2.id}/cancel`, { token: jessT })).status, 'cancelled');
  inbox = await ok('GET', '/api/client-inbox', { token: tokens.ayesha });
  assert.ok(!inbox.items.some((i) => i.request_id === r2.id));
});

test('task steps and the milestone a task is under show in the portal; comments can carry a file', async () => {
  const { ok, api, tokens, PNG } = env;
  const ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: tokens.ayesha });
  const pip = ov.milestones.find((m) => m.title === 'Pipelines');
  const t = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: 'Agent calendar sync', project_id: proj.id, assignee_id: sara.id } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: tokens.ayesha, body: { milestone_id: pip.id } });
  await ok('PUT', `/api/tasks/${t.id}/steps`, { token: tokens.sara, body: { steps: [{ title: 'Connect Google', done: true }, { title: 'Map agents' }, { title: 'Test' }] } });
  const list = await ok('GET', `/api/portal/projects/${proj.id}/tasks`, { token: jessT });
  const mine = list.find((x) => x.id === t.id);
  assert.deepEqual(mine.steps, { total: 3, done: 1 });
  assert.equal(mine.milestone_id, pip.id);
  const one = await ok('GET', `/api/portal/tasks/${t.id}`, { token: jessT });
  assert.deepEqual(one.steps.map((s) => [s.title, s.done]), [['Connect Google', true], ['Map agents', false], ['Test', false]]);
  assert.equal(one.milestone.title, 'Pipelines');
  const ov2 = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.equal(ov2.current_milestone.title, 'Pipelines');
  assert.ok(ov2.current_milestone.tasks.some((x) => x.title === 'Agent calendar sync'));
  // a milestone from another project is refused
  assert.equal((await api('PATCH', `/api/tasks/${t.id}`, { token: tokens.ayesha, body: { milestone_id: 99999 } })).status, 400);
  // a screenshot on a comment
  await ok('POST', `/api/portal/tasks/${t.id}/comments`, { token: jessT, body: { body: 'Like this?', file_base64: PNG.toString('base64'), file_type: 'image/png', file_name: 'shot.png' } });
  const c = (await ok('GET', `/api/portal/tasks/${t.id}`, { token: jessT })).comments.pop();
  assert.equal(c.file.name, 'shot.png');
  const f = await api('GET', c.file.url, { token: jessT, raw: true });
  assert.equal(f.status, 200);
  assert.ok((await ok('GET', `/api/tasks/${t.id}`, { token: tokens.sara })).comments.some((x) => x.file && x.file.name === 'shot.png'));
});

test('approvals: comments pinned to a spot, ticked off, and reminders after two days', async () => {
  const { ok, api, tokens, advance } = env;
  const ap = await ok('POST', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha, body: { title: 'Landing page', body: 'v1' } });
  const vid = ap.versions[0].id;
  await ok('POST', `/api/portal/versions/${vid}/pins`, { token: jessT, body: { x: 40.5, y: 22, body: 'Make the photo brighter' } });
  assert.equal((await api('POST', `/api/portal/versions/${vid}/pins`, { token: jessT, body: { x: 140, y: 22, body: 'x' } })).status, 400);
  let list = await ok('GET', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha });
  const pin = list.find((x) => x.id === ap.id).versions[0].pins[0];
  assert.deepEqual([pin.n, pin.x, pin.body, pin.author.name], [1, 40.5, 'Make the photo brighter', 'Jessica Moore']);
  assert.equal((await api('POST', `/api/portal/pins/${pin.id}/resolve`, { token: danT })).status, 403);
  await ok('POST', `/api/portal/pins/${pin.id}/resolve`, { token: tokens.ayesha });
  list = await ok('GET', `/api/portal/projects/${proj.id}/approvals`, { token: jessT });
  assert.equal(list.find((x) => x.id === ap.id).versions[0].pins[0].resolved, true);
  // by hand, not twice in 12 hours
  await ok('POST', `/api/portal/approvals/${ap.id}/remind`, { token: tokens.ayesha });
  assert.equal((await api('POST', `/api/portal/approvals/${ap.id}/remind`, { token: tokens.ayesha })).status, 429);
  // automatically after two days, then not again for three
  const before = (await ok('GET', '/api/portal/notifications?limit=100', { token: jessT })).items.filter((n) => n.kind === 'approval_reminder').length;
  advance(4 * 24 * 60 * MIN);
  env.app.sweepNotify();
  env.app.sweepNotify();
  const after1 = (await ok('GET', '/api/portal/notifications?limit=100', { token: jessT })).items.filter((n) => n.kind === 'approval_reminder').length;
  assert.ok(after1 > before);
});

test('chat: search across chats, a message sent twice after being offline is kept once, presence follows the setting', async () => {
  const { ok, api, tokens } = env;
  const th = (await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: jessT }))[0];
  await ok('POST', `/api/chat/threads/${th.id}/messages`, { token: jessT, body: { body: 'Which listings count as expired?', client_key: 'k-1234567890' } });
  await ok('POST', `/api/chat/threads/${th.id}/messages`, { token: jessT, body: { body: 'Which listings count as expired?', client_key: 'k-1234567890' } });
  const msgs = await ok('GET', `/api/chat/threads/${th.id}/messages`, { token: jessT });
  assert.equal(msgs.messages.filter((m) => m.body === 'Which listings count as expired?').length, 1);
  await ok('POST', `/api/chat/threads/${th.id}/messages`, { token: tokens.ayesha, body: { body: 'expired means team-secret', team_only: true } });
  const s = await ok('GET', `/api/chat/projects/${proj.id}/search?q=expired`, { token: jessT });
  assert.equal(s.results.length, 1);
  assert.equal((await ok('GET', `/api/chat/projects/${proj.id}/search?q=expired`, { token: tokens.ayesha })).results.length, 2);
  // the team's dots only when the client's settings allow it
  let pr = await ok('GET', `/api/chat/projects/${proj.id}/presence`, { token: jessT });
  assert.equal(pr.shown, false); assert.deepEqual(pr.staff, []);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { presence: true } } });
  pr = await ok('GET', `/api/chat/projects/${proj.id}/presence`, { token: jessT });
  assert.equal(pr.shown, true); assert.ok(pr.staff.length >= 1);
  assert.deepEqual(pr.clients, []);
  const team = await ok('GET', `/api/chat/projects/${proj.id}/presence`, { token: tokens.ayesha });
  assert.ok(team.clients.some((c) => c.id === jess.id && c.last_seen_at));
  // previews never reach this machine or a private network
  assert.equal((await ok('GET', `/api/chat/preview?url=${encodeURIComponent('http://127.0.0.1:1/')}`, { token: jessT })).ok, false);
  assert.equal((await ok('GET', `/api/chat/preview?url=${encodeURIComponent('http://10.0.0.5/x')}`, { token: jessT })).ok, false);
  void api;
});

test('the monthly statement: hours by milestone, as JSON and as a PDF', async () => {
  const { ok, api, tokens } = env;
  const s = await ok('GET', `/api/portal/projects/${proj.id}/statement`, { token: jessT });
  assert.equal(s.client, 'Harbor & Pine');
  assert.ok(Array.isArray(s.lines));
  const pdf = await api('GET', `/api/portal/projects/${proj.id}/statement.pdf`, { token: jessT, raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  // off when hours aren't shared
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { hours: 'off' } } });
  assert.equal((await api('GET', `/api/portal/projects/${proj.id}/statement.pdf`, { token: jessT })).status, 403);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { hours: 'person' } } });
});

test('the team\'s inbox and client health', async () => {
  const { ok, api, tokens, advance } = env;
  const th = (await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: danT }))[0];
  await ok('POST', `/api/chat/threads/${th.id}/messages`, { token: danT, body: { body: 'Who is calling the Zillow leads?' } });
  advance(5 * 60 * MIN);
  const inbox = await ok('GET', '/api/client-inbox', { token: tokens.ayesha });
  const it = inbox.items.find((i) => i.kind === 'msg');
  assert.equal(it.level, 'late');
  assert.equal(it.owner.name, 'Ayesha Noor');
  assert.equal(it.text, 'Who is calling the Zillow leads?');
  // someone not on the project sees nothing of it
  const outsider = await env.person('zed', 'Zed Out');
  assert.deepEqual((await ok('GET', '/api/client-inbox', { token: env.tokens.zed })).items, []);
  void outsider;
  const health = await ok('GET', '/api/client-health', { token: tokens.owner });
  assert.ok(['watch', 'risk'].includes(health[client.id].health));
  assert.equal((await api('GET', '/api/client-health', { token: tokens.sara })).status, 403);
  // answering clears it
  await ok('POST', `/api/chat/threads/${th.id}/messages`, { token: tokens.ayesha, body: { body: 'Sara is' } });
  assert.ok(!(await ok('GET', '/api/client-inbox', { token: tokens.ayesha })).items.some((i) => i.kind === 'msg'));
});

test('the weekly update goes out on schedule, unless one was already posted', async () => {
  const { ok, tokens, clock } = env;
  // the next Friday, in Tampa
  const d = new Date(clock.t);
  const toFri = (5 - d.getUTCDay() + 7) % 7 || 7;
  const fri = new Date(clock.t + toFri * 86400000).toISOString().slice(0, 10);
  await ok('PUT', `/api/portal/projects/${proj.id}/update-schedule`, { token: tokens.ayesha, body: { on: true, dow: 5, time: '16:00', intro: 'A good week.' } });
  const sch = await ok('GET', `/api/portal/projects/${proj.id}/update-schedule`, { token: tokens.ayesha });
  assert.equal(sch.on, true); assert.ok(sch.next_at);
  env.set(Date.parse(`${fri}T21:05:00Z`));   // 5:05 PM in Tampa
  env.app.sweepNotify();
  const ups = await ok('GET', `/api/portal/projects/${proj.id}/updates`, { token: jessT });
  assert.equal(ups[0].intro, 'A good week.');
  assert.equal(ups[0].author.name, 'Ayesha Noor');
  env.app.sweepNotify();
  assert.equal((await ok('GET', `/api/portal/projects/${proj.id}/updates`, { token: jessT })).length, ups.length);
});

test('push: a phone subscribes, and the message it gets opens only with its own keys', async () => {
  // a stand-in push service: the app sends there instead of the real one
  const got = [];
  const srv = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { got.push({ headers: req.headers, body: Buffer.concat(ch) }); res.writeHead(201); res.end(); }); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const e2 = await makeEnv({ app: { pushFetch: (url, o) => fetch(`http://127.0.0.1:${port}/`, o) } });
  try {
    await e2.person('lee', 'Lee Lead');
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const p256dh = webpush.b64u(ecdh.getPublicKey()), auth = webpush.b64u(crypto.randomBytes(16));
    const key = await e2.ok('GET', '/api/push/key', { token: e2.tokens.lee });
    assert.ok(key.key.length > 80);
    assert.equal((await e2.api('POST', '/api/push/subscribe', { token: e2.tokens.lee, body: { endpoint: 'http://insecure/x', keys: { p256dh, auth } } })).status, 400);
    assert.equal((await e2.api('POST', '/api/push/test', { token: e2.tokens.lee })).status, 400);
    await e2.ok('POST', '/api/push/subscribe', { token: e2.tokens.lee, body: { endpoint: 'https://push.example.com/send/abc', keys: { p256dh, auth }, device: 'iPhone' } });
    await e2.ok('POST', '/api/push/test', { token: e2.tokens.lee });
    for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 1);
    assert.equal(got[0].headers['content-encoding'], 'aes128gcm');
    assert.match(got[0].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const plain = JSON.parse(webpush.decrypt(got[0].body, ecdh.getPrivateKey(), p256dh, auth));
    assert.equal(plain.title, 'Notifications are on');
  } finally { await e2.close(); srv.close(); }
});
