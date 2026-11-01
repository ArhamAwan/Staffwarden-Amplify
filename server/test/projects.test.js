'use strict';
// Projects that work like Jira / ClickUp spaces: keys and task numbers, a lead, members, who sees what.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env, ids = {}, mob;
before(async () => {
  env = await makeEnv();
  ids.lena = (await env.person('lena', 'Lena')).id;     // will lead the project (an employee)
  ids.ali = (await env.person('ali', 'Ali')).id;        // member
  ids.sam = (await env.person('sam', 'Sam')).id;        // not a member
  ids.kim = (await env.person('kim', 'Kim')).id;        // added later
});
after(() => env.close());
const T = (k) => env.tokens[k];

test('a project gets a key, a lead and members; only members (and managers) see it', async () => {
  const { ok, api } = env;
  mob = await ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Mobile app', client: 'Acme', lead_id: ids.lena, member_ids: [ids.ali], due_day: '2026-11-30', description: 'iOS and Android' } });
  assert.equal(mob.key, 'MA');
  assert.equal(mob.access, 'members');
  assert.deepEqual(mob.members.map((m) => [m.name, m.role]), [['Ali', 'member'], ['Lena', 'lead']]);
  assert.equal(mob.lead.name, 'Lena');

  assert.deepEqual((await ok('GET', '/api/projects', { token: T('ali') })).map((p) => p.key), ['MA']);
  assert.deepEqual(await ok('GET', '/api/projects', { token: T('sam') }), [], 'a non-member does not see it');
  assert.equal((await api('GET', `/api/projects/${mob.id}`, { token: T('sam') })).status, 404);
  assert.equal((await api('POST', '/api/timer/start', { token: T('sam'), body: { project_id: mob.id } })).status, 404, 'and cannot track time on it');

  const custom = await ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Website', key: 'web', access: 'everyone' } });
  assert.equal(custom.key, 'WEB');
  assert.ok((await ok('GET', '/api/projects', { token: T('sam') })).some((p) => p.key === 'WEB'), 'a project open to everyone is seen by all');
  assert.equal((await api('POST', '/api/projects', { token: T('owner'), body: { name: 'Other', key: 'WEB' } })).status, 409, 'keys are unique');
  assert.equal((await api('POST', '/api/projects', { token: T('ali'), body: { name: 'Mine' } })).status, 403, 'employees cannot create projects');
});

test('tasks are numbered per project (MA-1, MA-2) and searchable by key; moving a task renumbers it', async () => {
  const { ok } = env;
  const a = await ok('POST', '/api/tasks', { token: T('owner'), body: { title: 'Login screen', project_id: mob.id, assignee_id: ids.ali } });
  const b = await ok('POST', '/api/tasks', { token: T('owner'), body: { title: 'Push notifications', project_id: mob.id, assignee_id: null } });
  assert.equal(a.key, 'MA-1'); assert.equal(b.key, 'MA-2');
  assert.equal(b.assignee_id, null, 'a project task can be left unassigned in the backlog');
  const found = await ok('GET', '/api/tasks?assignee=all&q=ma-2', { token: T('owner') });
  assert.deepEqual(found.map((t) => t.title), ['Push notifications']);
  const web = (await ok('GET', '/api/projects', { token: T('owner') })).find((p) => p.key === 'WEB');
  const moved = await ok('PATCH', `/api/tasks/${b.id}`, { token: T('owner'), body: { project_id: web.id } });
  assert.equal(moved.key, 'WEB-1');
  await ok('PATCH', `/api/tasks/${b.id}`, { token: T('owner'), body: { project_id: mob.id } });
  assert.equal((await ok('GET', `/api/tasks/${b.id}`, { token: T('owner') })).key, 'MA-3', 'numbers are never reused');
});

test('everyone in the project sees all its tasks; others do not', async () => {
  const { ok, api } = env;
  const all = await ok('GET', `/api/tasks?assignee=all&project=${mob.id}`, { token: T('lena') });
  assert.deepEqual(all.map((t) => t.key).sort(), ['MA-1', 'MA-3']);
  assert.equal((await ok('GET', `/api/tasks?assignee=all&project=${mob.id}`, { token: T('ali') })).length, 2);
  assert.equal((await ok('GET', `/api/tasks?assignee=all&project=${mob.id}`, { token: T('sam') })).length, 0);
  assert.equal((await api('GET', `/api/tasks/${all[0].id}`, { token: T('sam') })).status, 404);
});

test('the lead runs the project: members, assigning to members, review; plain members cannot', async () => {
  const { ok, api } = env;
  // assigning someone outside the project
  assert.equal((await api('POST', '/api/tasks', { token: T('lena'), body: { title: 'x', project_id: mob.id, assignee_id: ids.kim } })).status, 403, 'the lead adds people first');
  await ok('PUT', `/api/projects/${mob.id}/members`, { token: T('lena'), body: { user_id: ids.kim } });
  const t = await ok('POST', '/api/tasks', { token: T('lena'), body: { title: 'App icon', project_id: mob.id, assignee_id: ids.kim } });
  assert.equal(t.assignee, 'Kim');
  // members
  assert.equal((await api('POST', '/api/tasks', { token: T('ali'), body: { title: 'x', project_id: mob.id, assignee_id: ids.kim } })).status, 403, 'a member assigns only to themselves');
  const own = await ok('POST', '/api/tasks', { token: T('ali'), body: { title: 'Fix crash on launch', project_id: mob.id } });
  assert.equal(own.assignee_id, ids.ali);
  assert.equal((await api('PUT', `/api/projects/${mob.id}/members`, { token: T('ali'), body: { user_id: ids.sam } })).status, 403);
  assert.equal((await api('PATCH', `/api/projects/${mob.id}`, { token: T('ali'), body: { name: 'Hacked' } })).status, 403);
  // picking up the open backlog task
  const backlog = (await ok('GET', `/api/tasks?assignee=all&project=${mob.id}`, { token: T('ali') })).find((x) => x.key === 'MA-3');
  const picked = await ok('PATCH', `/api/tasks/${backlog.id}`, { token: T('ali'), body: { assignee_id: ids.ali } });
  assert.equal(picked.assignee, 'Ali', 'a member can pick up an open task');
  // review by the lead
  await ok('PATCH', `/api/tasks/${t.id}`, { token: T('kim'), body: { status: 'in_review' } });
  const sum = await ok('GET', '/api/tasks/summary', { token: T('lena') });
  assert.equal(sum.to_review, 1, 'the lead sees what waits for review');
  const done = await ok('POST', `/api/tasks/${t.id}/approve`, { token: T('lena') });
  assert.equal(done.status, 'done');
  // settings
  const p = await ok('PATCH', `/api/projects/${mob.id}`, { token: T('lena'), body: { status: 'on_hold', color: '#7C3AED' } });
  assert.equal(p.status, 'on_hold');
  assert.equal((await api('PATCH', `/api/projects/${mob.id}`, { token: T('lena'), body: { lead_id: ids.ali } })).status, 403, 'only managers choose the lead');
  await ok('PATCH', `/api/projects/${mob.id}`, { token: T('owner'), body: { status: 'active' } });
});

test('a manager assigning someone outside the project adds them to it; the lead cannot be removed', async () => {
  const { ok, api } = env;
  const t = await ok('POST', '/api/tasks', { token: T('owner'), body: { title: 'QA pass', project_id: mob.id, assignee_id: ids.sam } });
  assert.equal(t.key.startsWith('MA-'), true);
  assert.ok((await ok('GET', '/api/projects', { token: T('sam') })).some((p) => p.id === mob.id), 'Sam is now a member and sees the project');
  assert.equal((await api('DELETE', `/api/projects/${mob.id}/members/${ids.lena}`, { token: T('owner') })).status, 409);
  const after = await ok('DELETE', `/api/projects/${mob.id}/members/${ids.sam}`, { token: T('owner') });
  assert.ok(!after.members.some((m) => m.id === ids.sam));
});

test('the project page: progress, workload per member, deadlines, activity and time tracked', async () => {
  const { ok, advance } = env;
  const login = (await ok('GET', `/api/tasks?assignee=all&project=${mob.id}`, { token: T('ali') })).find((x) => x.key === 'MA-1');
  await ok('PATCH', `/api/tasks/${login.id}`, { token: T('owner'), body: { due_day: '2026-10-20' } });   // overdue
  await ok('POST', '/api/timer/start', { token: T('ali'), body: { task_id: login.id } });
  advance(30 * MIN);
  await ok('POST', '/api/timer/stop', { token: T('ali') });
  const p = await ok('GET', `/api/projects/${mob.id}`, { token: T('lena') });
  assert.equal(p.counts.total, 5);
  assert.equal(p.counts.done, 1);
  assert.equal(p.counts.progress_pct, 20);
  assert.equal(p.counts.overdue, 1);
  assert.ok(Math.abs(p.tracked_secs - 1800) <= 2, 'time on the project: ' + p.tracked_secs);
  const ali = p.workload.find((w) => w.name === 'Ali');
  assert.equal(ali.open, 3); assert.ok(Math.abs(ali.tracked_secs - 1800) <= 2);
  assert.equal(p.upcoming[0].key, 'MA-1'); assert.equal(p.upcoming[0].overdue, true);
  assert.ok(p.activity.length >= 5 && p.activity[0].key.startsWith('MA-'));
  assert.equal(p.can_manage, true); assert.equal(p.my_role, 'lead');
});
