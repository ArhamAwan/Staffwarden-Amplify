'use strict';
// Privacy edges of the client portal, found in review: each one is a way a client could have seen
// something the team keeps to itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');
let env, ayesha, sara, waseem, proj, client, jess, jessT, rival, rivalT;
async function listen(token) {
  const ctl = new AbortController();
  const res = await fetch(env.base + '/api/events', { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
  const events = []; const dec = new TextDecoder();
  (async () => { let buf = ''; try { for await (const c of res.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const l = b.split('\n').find((x) => x.startsWith('data: ')); if (l) events.push(JSON.parse(l.slice(6))); } } } catch {} })();
  return { events, close: () => ctl.abort() };
}
const settle = () => new Promise((r) => setTimeout(r, 150));
before(async () => {
  env = await makeEnv();
  ayesha = await env.person('ayesha', 'Ayesha Noor', { role: 'manager' });
  sara = await env.person('sara', 'Sara Khan');
  waseem = await env.person('waseem', 'Waseem Abbasi');
  const { ok, tokens } = env;
  proj = await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'CRM', key: 'CRM', lead_id: ayesha.id, member_ids: [sara.id, waseem.id] } });
  client = await ok('POST', '/api/clients', { token: tokens.owner, body: { name: 'Harbor' } });
  await ok('PUT', `/api/clients/${client.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: true } });
  const j = await ok('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'Jess', email: 'jess@h.com', can_approve: true } });
  jess = j.person; jessT = await env.login('jess@h.com', j.password);
  rival = await ok('POST', '/api/clients', { token: tokens.owner, body: { name: 'Rival' } });
  const r = await ok('POST', `/api/clients/${rival.id}/people`, { token: tokens.owner, body: { name: 'Rita', email: 'rita@r.com' } });
  rivalT = await env.login('rita@r.com', r.password);
});
after(() => env.close());

test('hidden task title via On it now', async () => {
  const { ok, tokens } = env;
  const t = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: 'SECRET internal fix', project_id: proj.id, assignee_id: waseem.id } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: tokens.ayesha, body: { client_visible: 0 } });
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { on_it_now: true } } });
  await ok('POST', '/api/timer/start', { token: tokens.waseem, body: { project_id: proj.id, task_id: t.id } });
  env.advance(5 * MIN);
  const ov = await ok('GET', `/api/portal/projects/${proj.id}`, { token: jessT });
  assert.deepEqual(ov.team.map((m) => m.now_task), [null, null, null]);   // a hidden task's name never shows
  assert.ok(ov.team.find((m) => m.name === 'Waseem Abbasi').on_now);
  // hidden task events to client SSE
  const s = await listen(jessT); await settle();
  await ok('POST', `/api/tasks/${t.id}/comments`, { token: tokens.waseem, body: { body: 'internal', team_only: true } });
  await settle();
  assert.deepEqual(s.events.filter((e) => e.task_id === t.id), []);
  s.close();
  await ok('POST', '/api/timer/stop', { token: tokens.waseem, body: {} }).catch(() => {});
});

test('send-back note reaches client', async () => {
  const { ok, tokens } = env;
  const t = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: 'Visible', project_id: proj.id, assignee_id: waseem.id } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: tokens.waseem, body: { status: 'in_review' } });
  await ok('POST', `/api/tasks/${t.id}/send-back`, { token: tokens.ayesha, body: { note: 'Sloppy work, redo; client is being difficult' } });
  const d = await ok('GET', `/api/portal/tasks/${t.id}`, { token: jessT });
  assert.deepEqual(d.comments, []);   // review notes stay with the team
});

test('SSE after deactivation', async () => {
  const { ok, tokens, api } = env;
  const j2 = await ok('POST', `/api/clients/${client.id}/people`, { token: tokens.owner, body: { name: 'Gone', email: 'gone@h.com' } });
  const gT = await env.login('gone@h.com', j2.password);
  const s = await listen(gT); await settle();
  await ok('PATCH', `/api/client-people/${j2.person.id}`, { token: tokens.owner, body: { active: false } });
  assert.equal((await api('GET', '/api/me', { token: gT })).status, 401);
  const th = await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: jessT });
  await ok('POST', `/api/chat/threads/${th[0].id}/typing`, { token: tokens.sara, body: {} });
  await settle();
  assert.deepEqual(s.events.filter((e) => e.type !== 'ping'), []);   // the open stream ended with the sign-in
  s.close();
});

test('project moved to another client exposes history', async () => {
  const { ok, tokens, api } = env;
  const th = await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: jessT });
  await ok('POST', `/api/chat/threads/${th[0].id}/messages`, { token: jessT, body: { body: 'Harbor private budget: $50k' } });
  await ok('POST', `/api/portal/projects/${proj.id}/requests`, { token: jessT, body: { title: 'Harbor request' } });
  await ok('PUT', `/api/clients/${client.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: false } });
  const refused = await api('PUT', `/api/clients/${rival.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: true } });
  assert.equal(refused.status, 409);
  await ok('PUT', `/api/clients/${rival.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: true, fresh: true } });
  const th2 = await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: rivalT });
  const msgs = await ok('GET', `/api/chat/threads/${th2[0].id}/messages`, { token: rivalT });
  assert.deepEqual(msgs.messages, []);
  assert.deepEqual(await ok('GET', `/api/portal/projects/${proj.id}/requests`, { token: rivalT }), []);
  // and back again: starts fresh for Harbor too
  await ok('PUT', `/api/clients/${rival.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: false } });
  await ok('PUT', `/api/clients/${client.id}/projects/${proj.id}`, { token: tokens.owner, body: { on: true, fresh: true } });
});

test('approvals off still decidable / files listed', async () => {
  const { ok, tokens, api } = env;
  const ap = await ok('POST', `/api/portal/projects/${proj.id}/approvals`, { token: tokens.ayesha, body: { title: 'Logo', body: 'v1', file_base64: env.PNG.toString('base64'), file_type: 'image/png', file_name: 'logo.png' } });
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { approvals: false } } });
  assert.equal((await api('GET', `/api/portal/projects/${proj.id}/approvals`, { token: jessT })).status, 403);
  assert.equal((await api('POST', `/api/portal/approvals/${ap.id}/decide`, { token: jessT, body: { decision: 'approved' } })).status, 403);
  assert.equal((await api('GET', `/api/portal/approval-files/${ap.versions[0].id}`, { token: jessT })).status, 403);
  assert.deepEqual((await ok('GET', `/api/portal/projects/${proj.id}/files`, { token: jessT })).filter((f) => f.where === 'approval'), []);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { approvals: true } } });
});

test('hours mode exposes names when people=false; team-only seen ticks', async () => {
  const { ok, tokens } = env;
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { people: false, hours: 'task' } } });
  const h = await ok('GET', `/api/portal/projects/${proj.id}/hours`, { token: jessT });
  assert.equal(h.people, undefined);
  assert.ok((h.tasks || []).every((t) => t.mainly === null));
  const csv = await env.api('GET', `/api/portal/projects/${proj.id}/hours.csv`, { token: jessT });
  assert.doesNotMatch(csv.data, /Waseem|Sara|Ayesha/);
  await ok('PATCH', `/api/clients/${client.id}`, { token: tokens.owner, body: { settings: { people: true, hours: 'person' } } });
  const th = await ok('GET', `/api/chat/projects/${proj.id}/threads`, { token: tokens.sara });
  const note = await ok('POST', `/api/chat/threads/${th[0].id}/messages`, { token: tokens.sara, body: { body: 'team note', team_only: true } });
  await ok('POST', `/api/chat/threads/${th[0].id}/read`, { token: jessT, body: {} });
  const m = await ok('GET', `/api/chat/threads/${th[0].id}/messages`, { token: tokens.sara });
  const n = m.messages.find((x) => x.id === note.id);
  assert.deepEqual(n.seen.map((x) => x.name), []);   // the client never read a note they can't see
});

test('a spreadsheet never runs a formula from a task name', async () => {
  const { ok, tokens } = env;
  const t = await ok('POST', '/api/tasks', { token: tokens.ayesha, body: { title: '=HYPERLINK("http://x","y")', project_id: proj.id, assignee_id: waseem.id } });
  await ok('POST', '/api/timer/start', { token: tokens.waseem, body: { project_id: proj.id, task_id: t.id } });
  env.advance(10 * MIN);
  await ok('POST', '/api/timer/stop', { token: tokens.waseem, body: {} });
  const csv = await env.api('GET', `/api/portal/projects/${proj.id}/hours.csv`, { token: tokens.ayesha });
  assert.match(csv.data, /"'=HYPERLINK/);
});
