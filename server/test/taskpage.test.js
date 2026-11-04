'use strict';
// The task page: who approves (the project lead; the person's manager when the lead is doing it or there
// is no project), approval switched off per task, "Done when" checks the approver ticks, sending back from
// unticked checks, links as work, pictures shown on the page, and who sees the live timer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, PNG } = require('./helpers');

let env, ids = {}, proj;
before(async () => {
  env = await makeEnv();
  const team = await env.ok('POST', '/api/teams', { token: env.tokens.owner, body: { name: 'Dev' } });
  ids.mona = (await env.person('mona', 'Mona', { role: 'manager', team_id: team.id })).id;
  await env.ok('PATCH', `/api/users/${ids.mona}`, { token: env.tokens.owner, body: { manages: [team.id] } });
  ids.dan = (await env.person('dan', 'Dan', { team_id: team.id })).id;
  ids.eve = (await env.person('eve', 'Eve', { team_id: team.id })).id;
  ids.lead = (await env.person('lead', 'Leo', { team_id: team.id })).id;
  proj = await env.ok('POST', '/api/projects', { token: env.tokens.owner, body: { name: 'Payroll', lead_id: ids.lead, member_ids: [ids.dan, ids.eve] } });
});
after(() => env.close());
const T = (k) => env.tokens[k];
const one = (k, id) => env.ok('GET', `/api/tasks/${id}`, { token: T(k) });
const status = async (k, method, url, body) => (await env.api(method, url, { token: T(k), body })).status;

test('the project lead approves; the lead’s own work goes to their manager; the owner always can', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('mona'), body: { title: 'Fix names', project_id: proj.id, assignee_id: ids.dan } });
  const v = await one('dan', t.id);
  assert.deepEqual(v.approver.names, ['Leo']);
  assert.equal(v.approver.why, 'project lead');
  assert.equal(v.can_approve, false, 'not the doer');
  assert.equal((await one('lead', t.id)).can_approve, true);
  assert.equal((await one('mona', t.id)).can_approve, false, 'a manager who is not the lead can comment, not approve');
  assert.equal((await one('owner', t.id)).can_approve, true);
  // the doer can't skip review
  assert.equal(await status('dan', 'PATCH', `/api/tasks/${t.id}`, { status: 'done' }), 403);
  // the lead's own task: their manager approves, never the lead themselves
  const mine = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Lead work', project_id: proj.id } });
  const lv = await one('lead', mine.id);
  assert.equal(lv.approver.why, 'manager');
  assert.ok(lv.approver.names.includes('Mona'));
  assert.equal(lv.can_approve, false);
  assert.equal((await one('mona', mine.id)).can_approve, true);
  // no project: the person's manager
  const loose = await env.ok('POST', '/api/tasks', { token: T('mona'), body: { title: 'Loose', assignee_id: ids.eve } });
  assert.ok((await one('eve', loose.id)).approver.names.includes('Mona'));
});

test('approval can be turned off for one task, but only by the lead or the owner', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Call back leads', project_id: proj.id, assignee_id: ids.eve } });
  assert.equal(await status('eve', 'PATCH', `/api/tasks/${t.id}`, { needs_review: 0 }), 403, 'the doer can’t turn it off');
  assert.equal(await status('mona', 'PATCH', `/api/tasks/${t.id}`, { needs_review: 0 }), 403, 'nor a manager who isn’t the lead');
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('lead'), body: { needs_review: 0 } });
  assert.equal((await one('eve', t.id)).needs_review, false);
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('eve'), body: { status: 'done' } });
  assert.equal((await one('eve', t.id)).status, 'done', 'with approval off the doer marks it done');
});

test('"Done when" checks: anyone on the task writes them, only the approver ticks them, and unticked ones go back', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'PDF names', project_id: proj.id, assignee_id: ids.dan } });
  await env.ok('POST', `/api/tasks/${t.id}/checks`, { token: T('lead'), body: { title: 'Hyphens print correctly' } });
  const list = await env.ok('POST', `/api/tasks/${t.id}/checks`, { token: T('dan'), body: { title: 'A test so it doesn’t come back' } });
  assert.equal(list.length, 2);
  assert.equal(await status('dan', 'PATCH', `/api/tasks/${t.id}/checks/${list[0].id}`, { checked: true }), 403, 'the doer can’t tick their own checks');
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_review' } });
  const after = await env.ok('PATCH', `/api/tasks/${t.id}/checks/${list[0].id}`, { token: T('lead'), body: { checked: true } });
  assert.equal(after[0].checked, true);
  assert.equal(after[0].checked_by, 'Leo');
  // sending back with no note: the unticked check says what's missing
  assert.equal(await status('mona', 'POST', `/api/tasks/${t.id}/send-back`, {}), 403, 'only the approver sends it back');
  await env.ok('POST', `/api/tasks/${t.id}/send-back`, { token: T('lead'), body: {} });
  const v = await one('dan', t.id);
  assert.equal(v.status, 'in_progress');
  assert.equal(v.review_rounds, 1);
  const fb = v.comments.find((c) => c.kind === 'feedback');
  assert.match(fb.body, /Still to do:\n• A test so it doesn’t come back/);
  assert.equal(fb.team_only, true, 'review feedback never reaches a client');
  // nothing unticked and no note: say what needs to change
  await env.ok('PATCH', `/api/tasks/${t.id}/checks/${list[1].id}`, { token: T('lead'), body: { checked: true } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_review' } });
  assert.equal(await status('lead', 'POST', `/api/tasks/${t.id}/send-back`, {}), 400);
  await env.ok('POST', `/api/tasks/${t.id}/approve`, { token: T('lead') });
});

test('links are http or https only; pictures show on the page, other files only download', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Ship it', project_id: proj.id, assignee_id: ids.dan } });
  assert.equal(await status('dan', 'POST', `/api/tasks/${t.id}/links`, { url: 'javascript:alert(1)' }), 400);
  assert.equal(await status('dan', 'POST', `/api/tasks/${t.id}/links`, { url: 'not a link' }), 400);
  const links = await env.ok('POST', `/api/tasks/${t.id}/links`, { token: T('dan'), body: { url: 'https://github.com/amplify/staffwarden/pull/318', title: 'Fix payslip names' } });
  assert.equal(links[0].host, 'github.com');
  assert.equal(await status('eve', 'DELETE', `/api/tasks/${t.id}/links/${links[0].id}`), 403, 'not someone else’s link');
  const png = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: { name: 'fixed.png', mime: 'image/png', data_base64: PNG.toString('base64') } });
  const svg = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: { name: 'x.svg', mime: 'image/svg+xml', data_base64: Buffer.from('<svg onload="alert(1)"/>').toString('base64') } });
  const a = await env.api('GET', `/api/tasks/${t.id}/files/${png.id}?inline=1`, { token: T('lead'), raw: true });
  assert.equal(a.headers.get('content-type'), 'image/png');
  assert.match(a.headers.get('content-disposition'), /^inline/);
  const b = await env.api('GET', `/api/tasks/${t.id}/files/${svg.id}?inline=1`, { token: T('lead'), raw: true });
  assert.match(b.headers.get('content-disposition'), /^attachment/, 'an SVG never opens in the page');
});

test('a progress update is its own kind of comment; repeating tasks carry their checks over', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Daily callbacks', project_id: proj.id, assignee_id: ids.eve, recurrence: 'daily', due_day: '2026-10-23' } });
  await env.ok('POST', `/api/tasks/${t.id}/comments`, { token: T('eve'), body: { body: '12 of 20 called', kind: 'update' } });
  assert.equal((await one('eve', t.id)).comments[0].kind, 'update');
  await env.ok('POST', `/api/tasks/${t.id}/checks`, { token: T('lead'), body: { title: 'Notes in the CRM' } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('lead'), body: { needs_review: 0 } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('eve'), body: { status: 'done' } });
  const next = env.app.db.prepare('SELECT * FROM tasks WHERE recurred_from = ?').get(t.id);
  assert.ok(next, 'the next copy was made');
  assert.equal(next.needs_review, 0, 'the approval choice carries over');
  const checks = env.app.db.prepare('SELECT title, checked_at FROM task_checks WHERE task_id = ?').all(next.id);
  assert.deepEqual(checks.map((c) => [c.title, c.checked_at]), [['Notes in the CRM', null]], 'unticked, ready for the next day');
});
