'use strict';
// Projects run by their manager: the manager approves, the stand-in approves the manager's own work and
// covers their leave, the owner is never asked; the manager plans each person's day and sends it; anyone
// on the project can be @mentioned anywhere on a task.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

let env, ids = {}, proj, today;
const T = (k) => env.tokens[k];
const one = (k, id) => env.ok('GET', `/api/tasks/${id}`, { token: T(k) });
const st = async (k, method, url, body) => (await env.api(method, url, { token: T(k), body })).status;
const notes = async (k) => (await env.ok('GET', '/api/notifications?limit=100', { token: T(k) })).items || [];
const mentionsOf = async (k) => (await notes(k)).filter((n) => n.kind === 'task_mention');

before(async () => {
  env = await makeEnv();
  ids.hira = (await env.person('hira', 'Hira Qureshi')).id;
  ids.ali = (await env.person('ali', 'Ali Subhan')).id;
  ids.alix = (await env.person('alix', 'Ali')).id;          // a shorter name inside a longer one
  ids.sara = (await env.person('sara', 'Sara Khan')).id;
  ids.mw = (await env.person('mw', 'Muhammad Waseem')).id;
  ids.out = (await env.person('out', 'Outsider Person')).id;
  proj = await env.ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Waystar', key: 'WE', lead_id: ids.hira, member_ids: [ids.ali, ids.sara, ids.mw, ids.alix] } });
  today = (await env.ok('GET', `/api/projects/${proj.id}/plan`, { token: T('hira') })).today;
});
after(() => env.close());

test('the owner picks the manager; the manager picks a stand-in from anyone; the stand-in is never the manager', async () => {
  assert.equal(await st('hira', 'PATCH', `/api/projects/${proj.id}`, { lead_id: ids.sara }), 403, 'a manager can’t hand the project on');
  assert.equal(await st('sara', 'PATCH', `/api/projects/${proj.id}`, { deputy_id: ids.sara }), 403, 'a member can’t pick the stand-in');
  assert.equal(await st('hira', 'PATCH', `/api/projects/${proj.id}`, { deputy_id: ids.hira }), 400);
  const p = await env.ok('PATCH', `/api/projects/${proj.id}`, { token: T('hira'), body: { deputy_id: ids.ali } });
  assert.equal(p.deputy.name, 'Ali Subhan');
  assert.equal(p.members.find((m) => m.id === ids.ali).role, 'deputy');
  assert.equal(p.owner.name, 'Owner');
  const asAli = await env.ok('GET', `/api/projects/${proj.id}`, { token: T('ali') });
  assert.equal(asAli.my_role, 'deputy');
  assert.equal(asAli.can_plan, true);
  assert.equal(asAli.can_manage, false, 'the stand-in plans and approves, but doesn’t change the project');
  assert.equal(await st('ali', 'PATCH', `/api/projects/${proj.id}`, { name: 'Renamed' }), 403);
  // saving the settings form unchanged (lead_id included) works for the manager
  await env.ok('PATCH', `/api/projects/${proj.id}`, { token: T('hira'), body: { lead_id: ids.hira, description: 'Video creatives' } });
  assert.equal(notesHas(await notes('ali'), /stand in on WE Waystar/), true);
});
const notesHas = (list, re) => list.some((n) => re.test(n.title));

test('the manager approves; the stand-in approves the manager’s own work; the owner is never asked', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Explainer', project_id: proj.id, assignee_id: ids.sara } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('sara'), body: { status: 'in_review' } });
  const v = await one('sara', t.id);
  assert.deepEqual(v.approver.names, ['Hira Qureshi']);
  assert.equal(v.approver.why, 'project manager');
  assert.equal((await one('hira', t.id)).review_mine, true);
  assert.equal((await one('owner', t.id)).review_mine, false, 'the owner is not asked');
  assert.equal((await one('owner', t.id)).can_approve, true, 'but can step in');
  assert.equal((await one('ali', t.id)).can_approve, false, 'the stand-in only approves when asked');
  const sum = await env.ok('GET', '/api/tasks/summary', { token: T('owner') });
  assert.equal(sum.to_review, 0, 'nothing waits for the owner');
  assert.equal((await env.ok('GET', '/api/tasks/summary', { token: T('hira') })).to_review, 1);
  assert.equal(notesHas(await notes('owner'), /sent .* for review/), false, 'the owner is not told');
  const mine = await env.ok('GET', '/api/tasks?review=mine&status=in_review', { token: T('hira') });
  assert.deepEqual(mine.map((x) => x.id), [t.id]);
  assert.equal((await env.ok('GET', '/api/tasks?review=mine&status=in_review', { token: T('owner') })).length, 0);
  await env.ok('POST', `/api/tasks/${t.id}/approve`, { token: T('hira') });

  // the manager's own work goes to the stand-in, never the owner
  const own = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Client call notes', project_id: proj.id } });
  const ov = await one('hira', own.id);
  assert.deepEqual(ov.approver.names, ['Ali Subhan']);
  assert.match(ov.approver.why, /stand-in/);
  assert.equal(ov.can_approve, false);
  await env.ok('PATCH', `/api/tasks/${own.id}`, { token: T('hira'), body: { status: 'in_review' } });
  assert.equal((await one('ali', own.id)).can_approve, true);
  assert.equal((await env.ok('GET', '/api/tasks/summary', { token: T('ali') })).to_review, 1);
  assert.equal((await env.ok('GET', '/api/tasks/summary', { token: T('owner') })).to_review, 0);
  await env.ok('POST', `/api/tasks/${own.id}/approve`, { token: T('ali') });
});

test('while the manager is on leave, the stand-in is asked; the manager can still approve', async () => {
  const db = env.app.db;
  db.prepare("INSERT INTO leave_requests (user_id, kind, start_day, end_day, status, created_at) VALUES (?, 'vacation', ?, ?, 'approved', ?)").run(ids.hira, today, today, new Date().toISOString());
  const t = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Cut 15s', project_id: proj.id, assignee_id: ids.mw } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('mw'), body: { status: 'in_review' } });
  const v = await one('mw', t.id);
  assert.deepEqual(v.approver.names, ['Ali Subhan']);
  assert.match(v.approver.why, /on leave/);
  assert.equal((await one('ali', t.id)).can_approve, true);
  assert.equal((await one('hira', t.id)).can_approve, true, 'the manager can still approve from leave');
  const p = await env.ok('GET', `/api/projects/${proj.id}`, { token: T('hira') });
  assert.equal(p.lead.away, true);
  db.prepare('DELETE FROM leave_requests WHERE user_id = ?').run(ids.hira);
  await env.ok('POST', `/api/tasks/${t.id}/approve`, { token: T('hira') });
});

test('a project without a stand-in: the manager’s own work goes to a manager before the owner', async () => {
  const solo = await env.ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Solo', key: 'SO', lead_id: ids.sara } });
  const t = await env.ok('POST', '/api/tasks', { token: T('sara'), body: { title: 'Mine', project_id: solo.id } });
  assert.deepEqual((await one('sara', t.id)).approver.names, ['Owner'], 'only the owner is left, so the work isn’t stuck');
});

test('the manager and stand-in give tasks to the team; members give tasks only to themselves', async () => {
  const a = await env.ok('POST', '/api/tasks', { token: T('ali'), body: { title: 'By stand-in', project_id: proj.id, assignee_id: ids.sara } });
  assert.equal(a.assignee_id, ids.sara);
  assert.equal(await st('sara', 'POST', '/api/tasks', { title: 'For Muhammad', project_id: proj.id, assignee_id: ids.mw }), 403);
  const own = await env.ok('POST', '/api/tasks', { token: T('sara'), body: { title: 'For me', project_id: proj.id } });
  assert.equal(own.assignee_id, ids.sara);
  const open = await env.ok('POST', '/api/tasks', { token: T('sara'), body: { title: 'Idea for later', project_id: proj.id, assignee_id: null } });
  assert.equal(open.assignee_id, null, 'an open task lands in the manager’s Not planned yet');
  assert.equal(await st('sara', 'PATCH', `/api/tasks/${a.id}`, { assignee_id: ids.mw }), 403, 'a member can’t pass work on');
  await env.ok('PATCH', `/api/tasks/${a.id}`, { token: T('ali'), body: { assignee_id: ids.mw } });
});

test('plan today: only the manager or stand-in plans; people see their day once it is sent; changes tell them', async () => {
  assert.equal(await st('sara', 'GET', `/api/projects/${proj.id}/plan`), 403, 'a member doesn’t see the plan board');
  const t1 = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Logo sting', project_id: proj.id, estimate_min: 240 } });
  const t2 = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Lower thirds', project_id: proj.id, estimate_min: 120, priority: 'urgent' } });
  const t3 = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Colour pass', project_id: proj.id } });
  let b = await env.ok('GET', `/api/projects/${proj.id}/plan`, { token: T('hira') });
  assert.equal(b.backlog[0].id, t2.id, 'urgent first');
  assert.ok([t1.id, t2.id, t3.id].every((id) => b.backlog.some((x) => x.id === id)));
  assert.equal(b.people[b.people.length - 1].role, 'manager', 'the manager comes last');
  // planning gives the task to the person
  b = await env.ok('POST', `/api/projects/${proj.id}/plan`, { token: T('hira'), body: { day: today, task_id: t1.id, user_id: ids.mw } });
  b = await env.ok('POST', `/api/projects/${proj.id}/plan`, { token: T('hira'), body: { day: today, task_id: t2.id, user_id: ids.mw, before_task_id: t1.id } });
  const mw = b.people.find((p) => p.user_id === ids.mw);
  assert.deepEqual(mw.tasks.map((x) => x.id), [t2.id, t1.id]);
  assert.equal(mw.planned_min, 360);
  assert.equal((await one('mw', t1.id)).assignee_id, ids.mw);
  assert.ok(!b.backlog.some((x) => x.id === t1.id));
  // a draft: Muhammad sees nothing yet, and wasn't pinged for each task
  assert.equal((await env.ok('GET', '/api/plan/me', { token: T('mw') })).tasks.length, 0);
  assert.equal(notesHas(await notes('mw'), /assigned you WE-\d+ (Logo|Lower)/), false);
  // send it
  b = await env.ok('POST', `/api/projects/${proj.id}/plan/send`, { token: T('hira'), body: { day: today } });
  assert.equal(b.told, 1);
  assert.ok(b.sent);
  const me = await env.ok('GET', '/api/plan/me', { token: T('mw') });
  assert.deepEqual(me.tasks.map((x) => x.id), [t2.id, t1.id]);
  assert.equal(me.planned_min, 360);
  assert.ok(notesHas(await notes('mw'), /planned your day on WE: 2 tasks, about 6h/));
  const sum = await env.ok('GET', '/api/tasks/summary', { token: T('mw') });
  assert.deepEqual(sum.next.slice(0, 2).map((x) => x.id), [t2.id, t1.id], 'the desktop app shows the planned order first');
  // reorder
  b = await env.ok('PUT', `/api/projects/${proj.id}/plan/order`, { token: T('hira'), body: { day: today, user_id: ids.mw, task_ids: [t1.id, t2.id] } });
  assert.deepEqual(b.people.find((p) => p.user_id === ids.mw).tasks.map((x) => x.id), [t1.id, t2.id]);
  assert.equal(await st('hira', 'PUT', `/api/projects/${proj.id}/plan/order`, { day: today, user_id: ids.mw, task_ids: [t1.id] }), 400);
  // after sending, a change tells them
  await env.ok('POST', `/api/projects/${proj.id}/plan`, { token: T('ali'), body: { day: today, task_id: t3.id, user_id: ids.mw } });
  assert.ok(notesHas(await notes('mw'), /Ali Subhan added a task to your day/));
  await env.ok('DELETE', `/api/projects/${proj.id}/plan/${t3.id}?day=${today}`, { token: T('hira') });
  assert.ok(notesHas(await notes('mw'), /moved a task off your day/));
  assert.equal((await one('mw', t3.id)).assignee_id, ids.mw, 'unplanning keeps it with the person');
  // moving it to someone else on the board takes it off the first person's day
  await env.ok('POST', `/api/projects/${proj.id}/plan`, { token: T('hira'), body: { day: today, task_id: t1.id, user_id: ids.sara } });
  assert.deepEqual((await env.ok('GET', '/api/plan/me', { token: T('mw') })).tasks.map((x) => x.id), [t2.id]);
  assert.equal((await one('sara', t1.id)).assignee_id, ids.sara);
  // reassigning on the task page takes it off the day too
  await env.ok('PATCH', `/api/tasks/${t2.id}`, { token: T('hira'), body: { assignee_id: ids.sara } });
  assert.deepEqual((await env.ok('GET', '/api/plan/me', { token: T('mw') })).tasks.map((x) => x.id), []);
});

test('plan today: the rules', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Subtitles', project_id: proj.id } });
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  assert.equal(await st('hira', 'POST', `/api/projects/${proj.id}/plan`, { day: yesterday, task_id: t.id, user_id: ids.sara }), 400, 'not a day gone by');
  assert.equal(await st('hira', 'POST', `/api/projects/${proj.id}/plan`, { day: today, task_id: t.id, user_id: ids.out }), 403, 'only people on the team');
  assert.equal(await st('sara', 'POST', `/api/projects/${proj.id}/plan`, { day: today, task_id: t.id, user_id: ids.sara }), 403, 'members don’t plan');
  env.app.db.prepare("INSERT INTO leave_requests (user_id, kind, start_day, end_day, status, created_at) VALUES (?, 'vacation', ?, ?, 'approved', ?)").run(ids.alix, today, today, new Date().toISOString());
  assert.equal(await st('hira', 'POST', `/api/projects/${proj.id}/plan`, { day: today, task_id: t.id, user_id: ids.alix }), 409, 'not on leave');
  const b = await env.ok('GET', `/api/projects/${proj.id}/plan`, { token: T('hira') });
  assert.equal(b.people.find((p) => p.user_id === ids.alix).status, 'leave');
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('hira'), body: { assignee_id: ids.sara } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('sara'), body: { status: 'in_review' } });
  assert.equal(await st('hira', 'POST', `/api/projects/${proj.id}/plan`, { day: today, task_id: t.id, user_id: ids.sara }), 409, 'not work waiting for review');
  const other = await env.ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Other', key: 'OT', lead_id: ids.ali } });
  const ot = await env.ok('POST', '/api/tasks', { token: T('ali'), body: { title: 'Elsewhere', project_id: other.id } });
  assert.equal(await st('hira', 'POST', `/api/projects/${proj.id}/plan`, { day: today, task_id: ot.id, user_id: ids.sara }), 404, 'only this project’s tasks');
  assert.equal(await st('hira', 'POST', `/api/projects/${proj.id}/plan/send`, { day: '2026-12-31' }), 400, 'too far ahead');
});

test('same as last time copies the still-open tasks to the next day', async () => {
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const b = await env.ok('POST', `/api/projects/${proj.id}/plan/copy`, { token: T('hira'), body: { day: tomorrow } });
  assert.equal(b.from, today);
  assert.ok(b.copied >= 1);
  const sara = b.people.find((p) => p.user_id === ids.sara);
  assert.ok(sara.tasks.length >= 1);
  assert.ok(sara.tasks.every((x) => ['todo', 'in_progress'].includes(x.status)));
});

test('@mentions: anyone on the project, anywhere on the task; once per text; never outsiders', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Thorocoat creative', project_id: proj.id, assignee_id: ids.sara, description: 'Brief from @Muhammad Waseem' } });
  assert.equal((await mentionsOf('mw')).length, 1, 'mentioned in the details');
  const v = await one('sara', t.id);
  assert.ok(v.mention_pool.some((p) => p.name === 'Muhammad Waseem'));
  assert.ok(!v.mention_pool.some((p) => p.id === ids.sara), 'not yourself');
  assert.ok(!v.mention_pool.some((p) => p.id === ids.out));
  assert.equal(v.mention_pool.find((p) => p.id === ids.hira).role, 'manager');
  // a comment: the person mentioned gets a mention, not also a plain "commented"
  const before = (await notes('mw')).length;
  await env.ok('POST', `/api/tasks/${t.id}/comments`, { token: T('sara'), body: { body: '@Muhammad Waseem can you match the sting? cc @Outsider Person' } });
  const after1 = await notes('mw');
  assert.equal(after1.length, before + 1);
  assert.match(after1[0].title, /Sara Khan mentioned you in WE-\d+ Thorocoat creative/);
  assert.equal((await mentionsOf('out')).length, 0, 'someone outside the project is never mentioned');
  // "@Ali Subhan" is Ali Subhan, not Ali
  await env.ok('POST', `/api/tasks/${t.id}/comments`, { token: T('sara'), body: { body: 'Thanks @Ali Subhan!' } });
  assert.equal((await mentionsOf('ali')).length, 1);
  assert.equal((await mentionsOf('alix')).length, 0);
  await env.ok('POST', `/api/tasks/${t.id}/comments`, { token: T('sara'), body: { body: '@Ali, and @Alison' } });
  assert.equal((await mentionsOf('alix')).length, 1, '@Ali followed by a comma');
  // the checklist and the steps
  await env.ok('POST', `/api/tasks/${t.id}/checks`, { token: T('hira'), body: { title: 'Export both sizes for @Sara Khan' } });
  assert.match((await mentionsOf('sara'))[0].title, /in the checklist/);
  await env.ok('PUT', `/api/tasks/${t.id}/steps`, { token: T('sara'), body: { steps: [{ title: 'Render from @Hira Qureshi' }] } });
  const steps = (await one('sara', t.id)).steps_list;
  await env.ok('PUT', `/api/tasks/${t.id}/steps`, { token: T('sara'), body: { steps: [{ id: steps[0].id, title: steps[0].title, done: true }] } });
  const hm = (await mentionsOf('hira')).filter((n) => /in the steps/.test(n.title));
  assert.equal(hm.length, 1, 'ticking the step doesn’t mention again');
  // editing the details mentions only people newly added
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('hira'), body: { description: 'Brief from @Muhammad Waseem and @Ali Subhan' } });
  assert.equal((await mentionsOf('mw')).filter((n) => /in the details/.test(n.title)).length, 1);
  assert.equal((await mentionsOf('ali')).filter((n) => /in the details/.test(n.title)).length, 1);
});

test('@mentions on a pin and its replies open the pin', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Frame', project_id: proj.id, assignee_id: ids.sara } });
  const f = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('sara'), body: { name: 'frame.png', mime: 'image/png', data_base64: env.PNG.toString('base64') } });
  const fid = (f.id || (f.files ? f.files[f.files.length - 1].id : null) || (await one('sara', t.id)).files[0].id);
  const pin = await env.ok('POST', `/api/tasks/${t.id}/pins`, { token: T('hira'), body: { file_id: fid, x: 0.5, y: 0.5, body: 'Too dark. @Muhammad Waseem a brighter render?' } });
  const m = (await mentionsOf('mw'))[0];
  assert.match(m.title, /mentioned you on pin 1 in WE-/);
  assert.equal(m.link, `#/task?id=${t.id}&pin=${pin.id}`);
  await env.ok('POST', `/api/tasks/${t.id}/pins/${pin.id}/replies`, { token: T('mw'), body: { body: 'Sure, and @Sara Khan will re-export' } });
  assert.match((await mentionsOf('sara'))[0].title, /on pin 1/);
});

test('a task moved to another project, or deleted, leaves the day; a removed stand-in stops standing in', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Moves away', project_id: proj.id, estimate_min: 30 } });
  const gone = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Deleted', project_id: proj.id } });
  await env.ok('POST', `/api/projects/${proj.id}/plan`, { token: T('hira'), body: { day: today, task_id: t.id, user_id: ids.mw } });
  await env.ok('POST', `/api/projects/${proj.id}/plan`, { token: T('hira'), body: { day: today, task_id: gone.id, user_id: ids.mw } });
  const other = await env.ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Elsewhere', key: 'EL', lead_id: ids.hira, member_ids: [ids.mw] } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('hira'), body: { project_id: other.id } });
  await env.ok('DELETE', `/api/tasks/${gone.id}`, { token: T('hira') });
  const b = await env.ok('GET', `/api/projects/${proj.id}/plan`, { token: T('hira') });
  const mw = b.people.find((p) => p.user_id === ids.mw);
  assert.ok(!mw.tasks.some((x) => x.id === t.id || x.id === gone.id));
  // removing the stand-in from the team: the manager's own work no longer goes to them
  await env.ok('DELETE', `/api/projects/${proj.id}/members/${ids.ali}`, { token: T('hira') });
  const p = await env.ok('GET', `/api/projects/${proj.id}`, { token: T('hira') });
  assert.equal(p.deputy, null);
  const own = await env.ok('POST', '/api/tasks', { token: T('hira'), body: { title: 'Mine again', project_id: proj.id } });
  assert.ok(!(await one('hira', own.id)).approver.names.includes('Ali Subhan'));
});

test('a planner never sees what another project they can’t open planned; send and copy tell each person once', async () => {
  const secret = await env.ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Secret', key: 'SC', lead_id: ids.ali, member_ids: [ids.sara] } });
  const st1 = await env.ok('POST', '/api/tasks', { token: T('ali'), body: { title: 'Confidential pitch', project_id: secret.id, assignee_id: ids.sara, estimate_min: 90 } });
  await env.ok('POST', `/api/projects/${secret.id}/plan`, { token: T('ali'), body: { day: today, task_id: st1.id, user_id: ids.sara } });
  await env.ok('POST', `/api/projects/${secret.id}/plan/send`, { token: T('ali'), body: { day: today } });
  const b = await env.ok('GET', `/api/projects/${proj.id}/plan`, { token: T('hira') });
  const x = b.people.find((p) => p.user_id === ids.sara).tasks.find((t) => t.id === st1.id);
  assert.ok(x, 'the time it takes still shows');
  assert.equal(x.title, null); assert.equal(x.key, null); assert.equal(x.hidden, true);
  assert.ok(!JSON.stringify(b).includes('Confidential'));
  // send: only open work counts
  const before = (await notes('sara')).length;
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  await env.ok('POST', `/api/projects/${proj.id}/plan/send`, { token: T('hira'), body: { day: tomorrow } });
  await env.ok('POST', `/api/projects/${proj.id}/plan/copy`, { token: T('hira'), body: { day: new Date(Date.parse(today) + 2 * 86400000).toISOString().slice(0, 10) } });
  const got = (await notes('sara')).slice(0, (await notes('sara')).length - before);
  assert.ok(got.filter((n) => n.kind === 'task_plan').length <= 1, 'one notice for the sent day, none for an unsent copy');
});
