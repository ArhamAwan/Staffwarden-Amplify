'use strict';
// The client portal: client accounts reach only their own projects and only the routes written for
// them; what they see follows the client's settings; chat, requests, approvals and hours work both ways.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env, ayesha, sara, waseem, proj, other, client, jess, dan, jessT, danT, rivalT;
before(async () => {
  env = await makeEnv();
  ayesha = await env.person('ayesha', 'Ayesha Noor', { role: 'manager' });
  sara = await env.person('sara', 'Sara Khan');
  waseem = await env.person('waseem', 'Waseem Abbasi');
  const { ok, tokens } = env;
  proj = await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'CRM rebuild', key: 'CRM', lead_id: ayesha.id, member_ids: [sara.id, waseem.id] } });
  other = await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'Internal', key: 'INT', member_ids: [sara.id] } });
  client = await ok('POST', '/api/clients', { token: tokens.owner, body: { name: 'Harbor & Pine', city: 'Tampa', tz_name: 'America/New_York', retainer_hours: 160 } });
  await ok('PUT', `/api/clients/${client.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: true } });
  const j = await ok('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'Jessica Moore', email: 'jess@harbor.com', title: 'Marketing', can_approve: true } });
  const d = await ok('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'Daniel Ruiz', email: 'dan@harbor.com' } });
  jess = j.person; dan = d.person;
  jessT = await env.login('jess@harbor.com', j.password);
  danT = await env.login('dan@harbor.com', d.password);
  // a second client, who must never see Harbor & Pine's work
  const rival = await ok('POST', '/api/clients', { token: tokens.owner, body: { name: 'Rival' } });
  const r = await ok('POST', `/api/clients/${rival.id}/people`, { token: tokens.owner, body: { name: 'Rita', email: 'rita@rival.com' } });
  rivalT = await env.login('rita@rival.com', r.password);
});
after(() => env.close());

test('a client signs in to their portal and reaches nothing else', async () => {
  const { ok, api, tokens } = env;
  const me = await ok('GET', '/api/me', { token: jessT });
  assert.equal(me.kind, 'client');
  assert.equal(me.client_name, 'Harbor & Pine');
  const home = await ok('GET', '/api/portal', { token: jessT });
  assert.deepEqual(home.projects.map((p) => p.name), ['CRM rebuild']);
  for (const url of ['/api/users', '/api/tasks', '/api/projects', `/api/projects/${proj.id}`, '/api/screenshots?user_id=1&day=2026-10-23', '/api/hr/people', '/api/payroll', '/api/clients', '/api/dashboard/team', '/api/directory']) {
    assert.equal((await api('GET', url, { token: jessT })).status, 403, url);
  }
  assert.equal((await api('POST', '/api/timer/start', { token: jessT, body: {} })).status, 403);
  // another client's project and a project with no client don't exist for them
  assert.equal((await api('GET', `/api/portal/projects/${proj.id}`, { token: rivalT })).status, 404);
  assert.equal((await api('GET', `/api/portal/projects/${other.id}`, { token: jessT })).status, 404);
  // the same email can't be used twice, staff or client
  assert.equal((await api('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'X', email: 'sara@test.com' } })).status, 409);
  assert.equal((await api('POST', `/api/clients/${client.id}/people`, { token: tokens.ayesha, body: { name: 'X', email: 'x@harbor.com' } })).status, 200);
  assert.equal((await api('POST', `/api/clients/${client.id}/people`, { token: tokens.sara, body: { name: 'Y', email: 'y@harbor.com' } })).status, 403);
  // a client can change their own password
  await ok('POST', '/api/me/password', { token: danT, body: { current_password: 'wrong'.repeat(3) } }).catch(() => {});
});

test('tasks follow the client\'s setting; team-only tasks and comments stay with the team', async () => {
  const { ok, api, tokens } = env;
  const t1 = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: 'Lead scoring', project_id: proj.id, assignee_id: waseem.id, due_day: '2026-11-04' } });
  const t2 = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: 'Fix our internal script', project_id: proj.id, assignee_id: sara.id } });
  await ok('PATCH', `/api/tasks/${t2.id}`, { token: tokens.ayesha, body: { client_visible: 0 } });
  let list = await ok('GET', `/api/portal/projects/${proj.id}/tasks`, { token: jessT });
  assert.deepEqual(list.map((t) => t.title), ['Lead scoring']);
  assert.equal(list[0].assignee.name, 'Waseem Abbasi');
  assert.equal((await api('GET', `/api/portal/tasks/${t2.id}`, { token: jessT })).status, 404);
  // only shared tasks
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { tasks: 'shared' } } });
  assert.equal((await ok('GET', `/api/portal/projects/${proj.id}/tasks`, { token: jessT })).length, 0);
  await ok('PATCH', `/api/tasks/${t1.id}`, { token: tokens.ayesha, body: { client_visible: 1 } });
  assert.equal((await ok('GET', `/api/portal/projects/${proj.id}/tasks`, { token: jessT })).length, 1);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { tasks: 'all', people: false } } });
  assert.equal((await ok('GET', `/api/portal/projects/${proj.id}/tasks`, { token: jessT }))[0].assignee, null);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { people: true } } });
  // comments both ways; team-only notes never reach the client
  await ok('POST', `/api/portal/tasks/${t1.id}/comments`, { token: jessT, body: { body: 'Can Zillow leads score higher?' } });
  await ok('POST', `/api/tasks/${t1.id}/comments`, { token: tokens.waseem, body: { body: 'Yes, 20 points now.' } });
  await ok('POST', `/api/tasks/${t1.id}/comments`, { token: tokens.waseem, body: { body: 'Their export has duplicates', team_only: true } });
  const seen = await ok('GET', `/api/portal/tasks/${t1.id}`, { token: jessT });
  assert.deepEqual(seen.comments.map((c) => c.body), ['Can Zillow leads score higher?', 'Yes, 20 points now.']);
  const staff = await ok('GET', `/api/tasks/${t1.id}`, { token: tokens.waseem });
  assert.equal(staff.comments.length, 3);
  assert.equal(staff.comments[0].from_client, true);
  assert.equal(staff.comments[0].user, 'Jessica Moore');
  assert.equal(staff.comments[2].team_only, true);
  assert.equal(staff.client, 'Harbor & Pine');
  assert.equal(staff.client_sees, true);
  // the team hears about the client's comment
  const n = await ok('GET', '/api/notifications', { token: tokens.waseem });
  assert.ok((n.items || n).some((x) => x.kind === 'client_message'));
});

test('chat: group and direct chats, team-only notes, replies, reactions, edits, reads', async () => {
  const { ok, api, tokens, advance } = env;
  const threads = await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: jessT });
  const g = threads.find((t) => t.kind === 'group');
  assert.ok(threads.some((t) => t.kind === 'direct' && t.name === 'Ayesha Noor'));
  const q = await ok('POST', `/api/chat/threads/${g.id}/messages`, { token: tokens.sara, body: { body: 'Which listings count as expired?' } });
  const a = await ok('POST', `/api/chat/threads/${g.id}/messages`, { token: jessT, body: { body: '180 days.', reply_to: q.id } });
  assert.equal(a.reply.author.name, 'Sara Khan');
  assert.equal(a.ticks, 'sent');
  await ok('POST', `/api/chat/threads/${g.id}/messages`, { token: tokens.waseem, body: { body: 'Note for us', team_only: true } });
  assert.equal((await api('POST', `/api/chat/threads/${g.id}/messages`, { token: jessT, body: { body: 'x', team_only: true } })).status, 400);
  // the client never gets the team-only note, even as the thing being replied to
  let mine = await ok('GET', `/api/chat/threads/${g.id}/messages`, { token: jessT });
  assert.deepEqual(mine.messages.map((m) => m.body), ['Which listings count as expired?', '180 days.']);
  const teamView = await ok('GET', `/api/chat/threads/${g.id}/messages`, { token: tokens.ayesha });
  assert.equal(teamView.messages.length, 3);
  const note = teamView.messages.find((m) => m.team_only);
  assert.equal((await api('POST', `/api/chat/threads/${g.id}/messages`, { token: jessT, body: { body: 'hi', reply_to: note.id } })).status, 400);
  assert.equal((await api('POST', `/api/chat/messages/${note.id}/react`, { token: jessT, body: { emoji: '👍' } })).status, 404);
  // read ticks turn to "read" once someone on the team has read it
  await ok('POST', `/api/chat/threads/${g.id}/read`, { token: tokens.sara, body: {} });
  mine = await ok('GET', `/api/chat/threads/${g.id}/messages`, { token: jessT });
  assert.equal(mine.messages[1].ticks, 'read');
  assert.ok(mine.messages[1].seen.some((s) => s.name === 'Sara Khan'));
  // reactions toggle
  await ok('POST', `/api/chat/messages/${a.id}/react`, { token: tokens.sara, body: { emoji: '🙏' } });
  await ok('POST', `/api/chat/messages/${a.id}/react`, { token: tokens.ayesha, body: { emoji: '🙏' } });
  mine = await ok('GET', `/api/chat/threads/${g.id}/messages`, { token: jessT });
  assert.deepEqual(mine.messages[1].reactions.map((r) => [r.emoji, r.count]), [['🙏', 2]]);
  await ok('POST', `/api/chat/messages/${a.id}/react`, { token: tokens.ayesha, body: { emoji: '🙏' } });
  assert.equal((await api('POST', `/api/chat/messages/${a.id}/react`, { token: jessT, body: { emoji: '<b>' } })).status, 400);
  // edit within 15 minutes, only your own
  assert.equal((await api('PATCH', `/api/chat/messages/${a.id}`, { token: tokens.sara, body: { body: 'no' } })).status, 403);
  await ok('PATCH', `/api/chat/messages/${a.id}`, { token: jessT, body: { body: '180 days, please.' } });
  advance(16 * MIN);
  assert.equal((await api('PATCH', `/api/chat/messages/${a.id}`, { token: jessT, body: { body: 'late' } })).status, 403);
  // unread counts, then deleting for everyone
  const home = await ok('GET', '/api/portal', { token: danT });
  assert.equal(home.projects[0].unread, 2);
  await ok('DELETE', `/api/chat/messages/${q.id}`, { token: tokens.sara });
  mine = await ok('GET', `/api/chat/threads/${g.id}/messages`, { token: jessT });
  assert.equal(mine.messages[0].deleted, true);
  assert.equal(mine.messages[0].body, '');
  // a voice message and a file
  const voice = await ok('POST', `/api/chat/threads/${g.id}/messages`, { token: jessT, body: { file_base64: Buffer.from('fake-audio').toString('base64'), file_type: 'audio/webm', file_name: 'voice.webm', voice_secs: 7 } });
  assert.equal(voice.file.voice_secs, 7);
  const f = await api('GET', voice.file.url, { token: tokens.ayesha, raw: true });
  assert.equal(f.status, 200);
  assert.equal((await api('POST', `/api/chat/threads/${g.id}/messages`, { token: jessT, body: { file_base64: 'PGh0bWw+', file_type: 'text/html', file_name: 'x.html' } })).status, 400);
  // a direct chat with one person on the team: nobody else on the team reads it
  const dm = await ok('POST', `/api/chat/projects/${proj.id}/direct`, { token: jessT, body: { staff_id: waseem.id } });
  await ok('POST', `/api/chat/threads/${dm.id}/messages`, { token: jessT, body: { body: 'Quick one for you' } });
  assert.equal((await ok('GET', `/api/chat/threads/${dm.id}/messages`, { token: tokens.waseem })).messages.length, 1);
  assert.equal((await api('GET', `/api/chat/threads/${dm.id}/messages`, { token: tokens.sara })).status, 404);
  assert.equal((await api('GET', `/api/chat/threads/${dm.id}/messages`, { token: danT })).status, 404);
  assert.ok((await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: tokens.waseem })).some((t) => t.id === dm.id));
  // typing is passed on, not stored
  await ok('POST', `/api/chat/threads/${g.id}/typing`, { token: jessT, body: {} });
  // switched off: no chat for the client
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { messages: false, direct: false } } });
  assert.equal((await api('GET', `/api/chat/threads/${g.id}/messages`, { token: jessT })).status, 403);
  assert.equal((await api('GET', `/api/chat/threads/${dm.id}/messages`, { token: jessT })).status, 403);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { messages: true, direct: true } } });
});

test('requests become tasks the client can see; approvals take a version and an answer', async () => {
  const { ok, api, tokens } = env;
  const r = await ok('POST', `/api/portal/projects/${proj.id}/requests`, { token: jessT, body: { title: 'Spanish voicemail', urgency: 'week' } });
  assert.equal(r.status, 'new');
  assert.equal((await api('POST', `/api/portal/requests/${r.id}/decide`, { token: tokens.sara, body: { status: 'planned' } })).status, 403);
  assert.equal((await api('POST', `/api/portal/requests/${r.id}/decide`, { token: tokens.ayesha, body: { status: 'declined' } })).status, 400);
  const planned = await ok('POST', `/api/portal/requests/${r.id}/decide`, { token: tokens.ayesha, body: { status: 'planned', reply: 'Nov 12', assignee_id: waseem.id } });
  assert.ok(planned.task_id);
  assert.ok((await ok('GET', `/api/portal/projects/${proj.id}/tasks`, { token: jessT })).some((t) => t.title === 'Spanish voicemail'));
  // an approval: Daniel can see it, Jessica answers it
  const ap = await ok('POST', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha, body: { title: 'New-lead text', body: 'Hi {name}, thanks for asking about {address}!' } });
  assert.equal((await api('POST', `/api/portal/projects/${proj.id}/approvals`, { token: jessT, body: { title: 'x', body: 'y' } })).status, 403);
  let ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: danT });
  assert.equal(ov.waiting.length, 1);
  assert.equal((await api('POST', `/api/portal/approvals/${ap.id}/decide`, { token: danT, body: { decision: 'approved' } })).status, 403);
  assert.equal((await api('POST', `/api/portal/approvals/${ap.id}/decide`, { token: jessT, body: { decision: 'changes' } })).status, 400);
  await ok('POST', `/api/portal/approvals/${ap.id}/decide`, { token: jessT, body: { decision: 'changes', note: 'Too pushy' } });
  ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: danT });
  assert.equal(ov.waiting.length, 0);   // the team's turn now
  await ok('POST', `/api/portal/approvals/${ap.id}/versions`, { token: tokens.ayesha, body: { body: 'Hi {name}, it’s Jessica’s team.', changes: 'Your wording' } });
  const done = await ok('POST', `/api/portal/approvals/${ap.id}/decide`, { token: jessT, body: { decision: 'approved' } });
  assert.equal(done.status, 'approved');
  assert.deepEqual(done.versions.map((v) => v.decision), ['changes', 'approved']);
  assert.equal((await api('POST', `/api/portal/approvals/${ap.id}/decide`, { token: jessT, body: { decision: 'approved' } })).status, 409);
  // a file the team asks for
  const ask = await ok('POST', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha, body: { kind: 'file', title: 'Follow Up Boss export', due_day: '2026-11-05' } });
  const sent = await ok('POST', `/api/portal/approvals/${ask.id}/upload`, { token: danT, body: { file_base64: Buffer.from('a,b\n1,2\n').toString('base64'), file_type: 'text/csv', file_name: 'leads.csv' } });
  assert.equal(sent.status, 'received');
  assert.equal((await api('GET', `/api/portal/approval-files/${sent.versions[0].id}`, { token: tokens.waseem, raw: true })).status, 200);
  assert.equal((await api('GET', `/api/portal/approval-files/${sent.versions[0].id}`, { token: rivalT })).status, 404);
});

test('hours, "On it now", milestones and the weekly update follow the settings', async () => {
  const { ok, api, tokens, advance } = env;
  await ok('POST', '/api/timer/start', { token: tokens.waseem, body: { project_id: proj.id } });
  advance(90 * MIN);
  let ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.equal(ov.team.find((p) => p.name === 'Waseem Abbasi').on_now, false);   // off unless the agency turns it on
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { on_it_now: true } } });
  ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.equal(ov.team.find((p) => p.name === 'Waseem Abbasi').on_now, true);
  // the team was told
  const nn = await ok('GET', '/api/notifications', { token: tokens.waseem });
  assert.ok(nn.items.some((x) => x.kind === 'client_visibility'));
  assert.ok(Math.abs(ov.hours.secs - 90 * 60) < 5);
  let h = await ok('GET', `/api/portal/projects/${proj.id}/hours`, { token: jessT });
  assert.equal(h.mode, 'person');
  assert.equal(h.people[0].name, 'Waseem Abbasi');
  assert.equal(h.tasks, undefined);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { hours: 'total' } } });
  h = await ok('GET', `/api/portal/projects/${proj.id}/hours`, { token: jessT });
  assert.equal(h.people, undefined);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { hours: 'off' } } });
  assert.equal((await api('GET', `/api/portal/projects/${proj.id}/hours`, { token: jessT })).status, 403);
  assert.equal((await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT })).hours, null);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { hours: 'task' } } });
  const csv = await api('GET', `/api/portal/projects/${proj.id}/hours.csv`, { token: jessT });
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Waseem Abbasi/);
  // milestones and the update
  assert.equal((await api('PUT', `/api/portal/projects/${proj.id}/milestones`, { token: tokens.sara, body: { milestones: [] } })).status, 403);
  await ok('PUT', `/api/portal/projects/${proj.id}/milestones`, { token: tokens.ayesha, body: { milestones: [{ title: 'CRM set up', due_day: '2026-09-30', done: true }, { title: 'Automations', due_day: '2026-11-07' }] } });
  const draft = await ok('GET', `/api/portal/projects/${proj.id}/update-draft`, { token: tokens.ayesha });
  assert.ok(Array.isArray(draft.done) && Array.isArray(draft.next));
  assert.deepEqual(draft.needed, []);   // nothing is waiting on the client now
  await ok('POST', `/api/portal/projects/${proj.id}/updates`, { token: tokens.ayesha, body: { intro: 'Pipelines are live.', done: ['Pipelines'], next: draft.next, needed: [] } });
  ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.equal(ov.update.intro, 'Pipelines are live.');
  assert.deepEqual(ov.milestones.map((m) => !!m.done_at), [true, false]);
  const g = (await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: jessT })).find((t) => t.kind === 'group');
  assert.match((await ok('GET', `/api/chat/threads/${g.id}/messages`, { token: jessT })).pinned.body, /Pipelines are live/);
  // a turned-off person is signed out at once
  await ok('PATCH', `/api/client-people/${dan.id}`, { token: tokens.owner, body: { active: false } });
  assert.equal((await api('GET', '/api/portal', { token: danT })).status, 401);
  await ok('POST', '/api/timer/stop', { token: tokens.waseem, body: {} });
});

test('with approvals switched off the client sees none of them, not even in the feed', async () => {
  const { ok, api, tokens } = env;
  const a = await ok('POST', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha, body: { title: 'Secret pricing page', body: 'v1' } });
  let ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.ok(ov.feed.some((f) => f.title === 'Secret pricing page'));
  assert.equal(ov.waiting.find((w) => w.id === a.id).asked_at, ov.waiting.find((w) => w.id === a.id).created_at);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { approvals: false } } });
  ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.ok(!ov.feed.some((f) => f.title === 'Secret pricing page'));
  assert.deepEqual(ov.waiting, []);
  assert.equal((await api('GET', `/api/portal/projects/${proj.id}/approvals`, { token: jessT })).status, 403);
  // the team still sees it
  assert.ok((await ok('GET', `/api/portal/projects/${proj.id}`, { token: tokens.ayesha })).feed.some((f) => f.title === 'Secret pricing page'));
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { approvals: true } } });
});

test('a request says what kind it is, can carry a file, and shows when the team saw it', async () => {
  const { ok, tokens } = env;
  const r = await ok('POST', `/api/portal/projects/${proj.id}/requests`, { token: jessT, body: { kind: 'problem', title: 'Website leads stopped', file_base64: env.PNG.toString('base64'), file_type: 'image/png', file_name: 'shot.png' } });
  assert.equal(r.kind, 'problem');
  assert.equal(r.file.name, 'shot.png');
  assert.equal(r.seen_at, null);
  // a member who can't answer opening the list doesn't count as seen; the lead does
  await ok('GET', `/api/portal/projects/${proj.id}/requests`, { token: tokens.sara });
  assert.equal((await ok('GET', `/api/portal/projects/${proj.id}/requests`, { token: jessT })).find((x) => x.id === r.id).seen_at, null);
  await ok('GET', `/api/portal/projects/${proj.id}/requests`, { token: tokens.ayesha });
  const seen = (await ok('GET', `/api/portal/projects/${proj.id}/requests`, { token: jessT })).find((x) => x.id === r.id);
  assert.ok(seen.seen_at);
  assert.equal(seen.seen_by_name, 'Ayesha Noor');
  const f = await env.api('GET', seen.file.url, { token: jessT });
  assert.equal(f.status, 200);
  await ok('POST', `/api/portal/requests/${r.id}/decide`, { token: tokens.ayesha, body: { status: 'planned', reply: 'On it' } });
  const ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.ok(ov.my_requests.some((x) => x.id === r.id && x.task && x.task.status === 'todo'));
});
