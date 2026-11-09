'use strict';
// Notifications: who is told what, never about their own actions, settings per person, read state,
// the daily deadline reminder and the "no signal" team alert.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN, T0 } = require('./helpers');

let env, ids = {}, proj;
before(async () => {
  env = await makeEnv();
  const team = await env.ok('POST', '/api/teams', { token: env.tokens.owner, body: { name: 'Design' } });
  ids.mona = (await env.person('mona', 'Mona', { role: 'manager', team_id: team.id })).id;
  await env.ok('PATCH', `/api/users/${ids.mona}`, { token: env.tokens.owner, body: { manages: [team.id] } });
  ids.dan = (await env.person('dan', 'Dan', { team_id: team.id })).id;
  ids.eve = (await env.person('eve', 'Eve', { team_id: team.id })).id;
  ids.lead = (await env.person('lead', 'Leo', { team_id: team.id })).id;
  proj = await env.ok('POST', '/api/projects', { token: env.tokens.owner, body: { name: 'Mobile app', lead_id: ids.lead, member_ids: [ids.dan] } });
});
after(() => env.close());
const T = (k) => env.tokens[k];
const inbox = async (k, q = '') => env.ok('GET', `/api/notifications${q}`, { token: T(k) });
const kinds = async (k) => (await inbox(k)).items.map((n) => n.kind);

test('project members and the lead are told when they are added', async () => {
  const d = await inbox('dan');
  assert.equal(d.items[0].kind, 'project_added');
  assert.match(d.items[0].title, /Owner added you to MA Mobile app/);
  assert.equal(d.items[0].link, `#/project?id=${proj.id}`);
  assert.deepEqual(await kinds('lead'), ['project_lead']);
  assert.deepEqual(await kinds('owner'), [], 'nobody is told about their own action');
  await env.ok('PUT', `/api/projects/${proj.id}/members`, { token: T('lead'), body: { user_ids: [ids.eve] } });
  assert.equal((await inbox('eve')).items[0].title, 'Leo added you to MA Mobile app');
});

test('a task goes round: assigned, sent for review, sent back, approved, with comments along the way', async () => {
  const { ok } = env;
  const t = await ok('POST', '/api/tasks', { token: T('mona'), body: { title: 'Icon set', project_id: proj.id, assignee_id: ids.dan, due_day: '2026-10-30' } });
  let n = (await inbox('dan')).items[0];
  assert.equal(n.kind, 'task_assigned');
  assert.equal(n.title, 'Mona assigned you MA-1 Icon set');
  assert.equal(n.link, `#/tasks?task=${t.id}`);
  assert.equal(n.actor.name, 'Mona');

  await ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_progress' } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_review' } });
  assert.equal((await inbox('lead')).items[0].kind, 'task_review', 'the project lead approves project tasks, so the lead is asked');
  for (const k of ['mona', 'eve']) assert.equal((await inbox(k)).items.filter((x) => x.kind === 'task_review').length, 0, `${k} is not asked`);

  await ok('POST', `/api/tasks/${t.id}/send-back`, { token: T('lead'), body: { note: 'Use the new brand colours' } });
  n = (await inbox('dan')).items[0];
  assert.equal(n.kind, 'task_sent_back');
  assert.equal(n.body, 'Use the new brand colours');

  await ok('POST', `/api/tasks/${t.id}/comments`, { token: T('dan'), body: { body: 'Done, colours updated' } });
  assert.equal((await inbox('mona')).items[0].kind, 'task_comment', 'the creator hears about comments');
  assert.equal((await inbox('lead')).items[0].kind, 'task_comment', 'and so does anyone who commented before');
  assert.notEqual((await inbox('dan')).items[0].kind, 'task_comment', 'but not the person who wrote it');

  await ok('PATCH', `/api/tasks/${t.id}`, { token: T('mona'), body: { due_day: '2026-11-02' } });
  assert.equal((await inbox('dan')).items[0].kind, 'task_due_changed');

  await ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_review' } });
  assert.equal((await env.api('POST', `/api/tasks/${t.id}/approve`, { token: T('mona') })).status, 403, 'a manager who is not the project lead can comment but not approve');
  await ok('POST', `/api/tasks/${t.id}/approve`, { token: T('lead') });
  n = (await inbox('dan')).items[0];
  assert.equal(n.kind, 'task_approved');
  assert.equal(n.body, null, 'not "first time": it was sent back once');
});

test('read state: unread count, mark some, mark all, and only your own', async () => {
  const { ok, api } = env;
  const d = await inbox('dan');
  assert.ok(d.unread >= 4);
  const first = d.items[0].id;
  assert.equal((await ok('POST', '/api/notifications/read', { token: T('dan'), body: { ids: [first] } })).unread, d.unread - 1);
  assert.equal((await inbox('dan')).items[0].read, true);
  await ok('POST', '/api/notifications/read', { token: T('eve'), body: { ids: [d.items[1].id] } });
  assert.equal((await inbox('dan')).items[1].read, false, "someone else cannot mark yours");
  assert.equal((await ok('POST', '/api/notifications/read', { token: T('dan'), body: { all: true } })).unread, 0);
  // the desktop app asks only for what is new
  const after = await inbox('dan', `?after=${d.last_id}`);
  assert.deepEqual(after.items, []);
  assert.equal((await api('POST', '/api/notifications/read', { token: T('dan'), body: { ids: 'x' } })).status, 400);
});

test('people can switch categories off; managers see team alerts in their settings, employees do not', async () => {
  const { ok } = env;
  const p = await ok('GET', '/api/me/notify-prefs', { token: T('eve') });
  assert.ok(p.categories.find((c) => c.key === 'comments').on);
  assert.ok(!p.categories.some((c) => c.key === 'team'), 'employees have no team alerts to switch');
  assert.ok((await ok('GET', '/api/me/notify-prefs', { token: T('mona') })).categories.some((c) => c.key === 'team'));
  await ok('PUT', '/api/me/notify-prefs', { token: T('eve'), body: { categories: { tasks: false }, desktop: false } });
  const before = (await inbox('eve')).items.length;
  await ok('POST', '/api/tasks', { token: T('mona'), body: { title: 'Quiet one', assignee_id: ids.eve } });
  assert.equal((await inbox('eve')).items.length, before, 'switched off: nothing created');
  const p2 = await ok('GET', '/api/me/notify-prefs', { token: T('eve') });
  assert.equal(p2.categories.find((c) => c.key === 'tasks').on, false);
  assert.equal(p2.desktop, false);
  assert.equal((await env.api('PUT', '/api/me/notify-prefs', { token: T('eve'), body: { categories: { nope: true } } })).status, 400);
});

test('time off: the owner hears about requests (not managers), the person hears the decision', async () => {
  const { ok } = env;
  const r = await ok('POST', '/api/timeoff', { token: T('dan'), body: { kind: 'paid', start_day: '2026-11-11', end_day: '2026-11-11', note: 'Family wedding' } });
  const m = (await inbox('owner')).items[0];
  assert.equal(m.kind, 'timeoff_request');
  assert.match(m.body, /Paid, Wed, Nov 11: Family wedding/);
  assert.ok(!(await kinds('mona')).includes('timeoff_request'), 'managers are not asked: only the owner decides');
  await ok('POST', `/api/timeoff/${r.id}/decision`, { token: T('owner'), body: { approve: false, note: 'Release week, can we move it?' } });
  const d = (await inbox('dan')).items[0];
  assert.equal(d.title, 'Owner declined your time off');
  assert.match(d.body, /Release week/);
});

test('once a working day, from the start of the shift: what is due today or overdue', async () => {
  const { ok, app, set } = env;
  await ok('POST', '/api/tasks', { token: T('mona'), body: { title: 'Late one', assignee_id: ids.lead, due_day: '2026-10-22' } });
  await ok('POST', '/api/tasks', { token: T('mona'), body: { title: 'Today one', assignee_id: ids.lead, due_day: '2026-10-23' } });
  set(T0 - 30 * MIN);                       // 08:30 Friday in Pakistan: before the shift
  app.sweepNotify();
  assert.ok(!(await kinds('lead')).includes('task_due'));
  set(T0 + 15 * MIN);                       // 09:15
  app.sweepNotify(); app.sweepNotify();
  const due = (await inbox('lead')).items.filter((n) => n.kind === 'task_due');
  assert.equal(due.length, 1, 'only once that day');
  assert.equal(due[0].title, 'You have 1 overdue and 1 due today');
  set(T0 + 24 * 60 * MIN + 15 * MIN);       // Saturday: not a working day
  app.sweepNotify();
  assert.equal((await inbox('lead')).items.filter((n) => n.kind === 'task_due').length, 1);
  set(T0);
});

test('a running timer that goes silent alerts the people who manage that person, once', async () => {
  const { ok, app, set, advance } = env;
  set(T0 + 60 * MIN);
  await ok('POST', '/api/timer/start', { token: T('eve') });
  advance(5 * MIN); app.sweepNotify();
  assert.ok(!(await kinds('mona')).includes('no_signal'), 'not after 5 minutes');
  advance(10 * MIN); app.sweepNotify(); app.sweepNotify();
  const a = (await inbox('mona')).items.filter((n) => n.kind === 'no_signal');
  assert.equal(a.length, 1);
  assert.match(a[0].title, /Eve: no signal/);
  assert.ok((await kinds('owner')).includes('no_signal'));
  assert.ok(!(await kinds('dan')).includes('no_signal'), 'colleagues are not told');
  await ok('POST', '/api/timer/stop', { token: T('eve') });
});
