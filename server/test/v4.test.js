'use strict';
// Tasks (ClickUp-style) and productivity (Hubstaff-style) in one place.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, T0, MIN } = require('./helpers');

let env, team, ids = {};
const DAY = '2026-10-23';
before(async () => {
  env = await makeEnv();
  team = await env.ok('POST', '/api/teams', { token: env.tokens.owner, body: { name: 'Web' } });
  ids.mona = (await env.person('mona', 'Mona', { role: 'manager', team_id: team.id })).id;
  await env.ok('PATCH', `/api/users/${ids.mona}`, { token: env.tokens.owner, body: { manages: [team.id] } });
  ids.ali = (await env.person('ali', 'Ali', { team_id: team.id })).id;
  ids.zed = (await env.person('zed', 'Zed')).id;   // not in Mona's team
});
after(() => env.close());

const task = (tok, body) => env.ok('POST', '/api/tasks', { token: env.tokens[tok], body });
const patch = (tok, id, body) => env.api('PATCH', `/api/tasks/${id}`, { token: env.tokens[tok], body });

test('assigning: managers assign within their team; people see only their own tasks; employees cannot assign others', async () => {
  const { api, ok, tokens } = env;
  const t = await task('mona', { title: 'Build pricing page', assignee_id: ids.ali, due_day: '2026-10-24', priority: 'high', description: 'Three tiers' });
  assert.equal(t.assignee, 'Ali'); assert.equal(t.status, 'todo'); assert.equal(t.creator, 'Mona');
  const mine = await ok('GET', '/api/tasks?assignee=me', { token: tokens.ali });
  assert.deepEqual(mine.map((x) => x.title), ['Build pricing page']);
  assert.equal((await api('GET', `/api/tasks/${t.id}`, { token: tokens.zed })).status, 404, 'others cannot see it');
  assert.equal((await api('POST', '/api/tasks', { token: tokens.mona, body: { title: 'x', assignee_id: ids.zed } })).status, 403, 'a manager cannot assign outside their team');
  assert.equal((await api('POST', '/api/tasks', { token: tokens.ali, body: { title: 'x', assignee_id: ids.zed } })).status, 403, 'an employee cannot assign others');
  assert.equal((await patch('ali', t.id, { title: 'Renamed' })).status, 403, 'only the creator or a manager edits the task');
  const own = await task('ali', { title: 'Personal to-do' });
  assert.equal(own.assignee_id, ids.ali, 'a task without an assignee is assigned to its creator');
  assert.equal((await patch('ali', own.id, { status: 'done' })).status, 200, 'personal to-dos can be closed without review');
  assert.equal((await api('GET', '/api/tasks', { token: tokens.owner })).data.length >= 2, true);
});

test('review flow: in progress, in review, sent back with a reason, resubmitted, approved; accuracy counts first-time approvals', async () => {
  const { ok, api, tokens } = env;
  const a = await task('mona', { title: 'Logo', assignee_id: ids.ali, due_day: DAY });
  const b = await task('mona', { title: 'Banner', assignee_id: ids.ali, due_day: DAY });
  assert.equal((await patch('ali', a.id, { status: 'in_progress' })).status, 200);
  assert.equal((await patch('ali', a.id, { status: 'done' })).status, 403, 'assigned work goes through review');
  await ok('PATCH', `/api/tasks/${a.id}`, { token: tokens.ali, body: { status: 'in_review' } });
  assert.equal((await api('POST', `/api/tasks/${a.id}/approve`, { token: tokens.ali })).status, 403, 'you cannot approve your own work');
  assert.equal((await api('POST', `/api/tasks/${a.id}/send-back`, { token: tokens.mona, body: {} })).status, 400, 'sending back needs a reason');
  const back = await ok('POST', `/api/tasks/${a.id}/send-back`, { token: tokens.mona, body: { note: 'Use the brand colours' } });
  assert.equal(back.status, 'in_progress'); assert.equal(back.review_rounds, 1);
  const detail = await ok('GET', `/api/tasks/${a.id}`, { token: tokens.ali });
  assert.ok(detail.comments.some((c) => /brand colours/.test(c.body)), 'the reason is posted as a comment');
  assert.deepEqual(detail.events.map((e) => e.kind), ['created', 'status', 'submitted', 'sent_back']);
  await ok('PATCH', `/api/tasks/${a.id}`, { token: tokens.ali, body: { status: 'in_review' } });
  const done = await ok('POST', `/api/tasks/${a.id}/approve`, { token: tokens.mona });
  assert.equal(done.status, 'done'); assert.equal(done.first_time, false);
  await ok('PATCH', `/api/tasks/${b.id}`, { token: tokens.ali, body: { status: 'in_review' } });
  assert.equal((await ok('POST', `/api/tasks/${b.id}/approve`, { token: tokens.mona })).first_time, true);
  const p = await ok('GET', `/api/productivity?from=${DAY}&to=${DAY}&user_id=${ids.ali}`, { token: tokens.mona });
  assert.equal(p.people[0].tasks.approved, 2);
  assert.equal(p.people[0].tasks.accuracy_pct, 50, 'one of two approved first time');
  assert.equal(p.people[0].tasks.on_time_pct, 100);
});

test('deadlines: overdue and due today are flagged; completion ratio counts tasks that were due', async () => {
  const { ok, tokens, set } = env;
  set(T0 + 8 * 3600000);                                   // 17:00 PKT on the 23rd
  const late = await task('mona', { title: 'Overdue report', assignee_id: ids.ali, due_day: '2026-10-22' });
  const today = await task('mona', { title: 'Due today', assignee_id: ids.ali, due_day: DAY });
  assert.equal(late.overdue, true); assert.equal(today.due_today, true);
  const sum = await ok('GET', '/api/tasks/summary', { token: tokens.ali });
  assert.ok(sum.overdue >= 1 && sum.due_today >= 1);
  const mgr = await ok('GET', '/api/tasks/summary', { token: tokens.mona });
  assert.ok(mgr.team_overdue >= 1);
  const over = await ok('GET', '/api/tasks?assignee=me&due=overdue', { token: tokens.ali });
  assert.deepEqual(over.map((t) => t.title), ['Overdue report']);
  const p = await ok('GET', `/api/productivity?from=2026-10-22&to=${DAY}&user_id=${ids.ali}`, { token: tokens.mona });
  const m = p.people[0].tasks;
  assert.equal(m.due, 4, 'logo, banner, overdue report, due today');
  assert.equal(m.due_done, 2);
  assert.equal(m.completion_pct, 50);
});

test('recurring tasks make their next copy when done', async () => {
  const { ok, tokens } = env;
  const r = await task('mona', { title: 'Weekly client update', assignee_id: ids.ali, due_day: '2026-10-23', recurrence: 'weekly' });
  await ok('PATCH', `/api/tasks/${r.id}`, { token: tokens.ali, body: { status: 'in_review' } });
  await ok('POST', `/api/tasks/${r.id}/approve`, { token: tokens.mona });
  const next = (await ok('GET', '/api/tasks?assignee=me', { token: tokens.ali })).filter((t) => t.title === 'Weekly client update' && t.status === 'todo');
  assert.equal(next.length, 1);
  assert.equal(next[0].due_day, '2026-10-30');
  assert.equal(next[0].recurrence, 'weekly');
  // weekdays skip the weekend
  const wd = await task('ali', { title: 'Daily standup notes', due_day: '2026-10-23', recurrence: 'weekdays' });   // a Friday
  await ok('PATCH', `/api/tasks/${wd.id}`, { token: tokens.ali, body: { status: 'done' } });
  const n2 = (await ok('GET', '/api/tasks?assignee=me', { token: tokens.ali })).find((t) => t.title === 'Daily standup notes' && t.status === 'todo');
  assert.equal(n2.due_day, '2026-10-26', 'Friday -> Monday');
});

test('comments and files on a task', async () => {
  const { ok, api, tokens, base } = env;
  const t = await task('mona', { title: 'Brochure', assignee_id: ids.ali });
  await ok('POST', `/api/tasks/${t.id}/comments`, { token: tokens.ali, body: { body: 'Draft attached' } });
  const f = await ok('POST', `/api/tasks/${t.id}/files`, { token: tokens.ali, body: { name: 'draft v1.pdf', mime: 'application/pdf', data_base64: Buffer.from('%PDF-1.4 hello').toString('base64') } });
  const d = await ok('GET', `/api/tasks/${t.id}`, { token: tokens.mona });
  assert.equal(d.comments.length, 1); assert.equal(d.files[0].name, 'draft v1.pdf'); assert.equal(d.comment_count, 1); assert.equal(d.file_count, 1);
  const dl = await fetch(`${base}/api/tasks/${t.id}/files/${f.id}`, { headers: { Authorization: `Bearer ${tokens.mona}` } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename\*=UTF-8''draft%20v1\.pdf/);
  assert.equal(await dl.text(), '%PDF-1.4 hello');
  assert.equal((await api('GET', `/api/tasks/${t.id}/files/${f.id}`, { token: tokens.zed })).status, 404);
  const big = Buffer.alloc(5 * 1024 * 1024 + 10).toString('base64');
  assert.equal((await api('POST', `/api/tasks/${t.id}/files`, { token: tokens.ali, body: { name: 'big.bin', data_base64: big } })).status, 413);
  const c = d.comments[0];
  assert.equal((await api('DELETE', `/api/tasks/${t.id}/comments/${c.id}`, { token: tokens.zed })).status, 404);
});

test('starting the timer on a task moves it to In progress and counts the time on it', async () => {
  const { ok, tokens, set, advance } = env;
  set(T0 + 26 * 3600000);
  const t = await task('mona', { title: 'Fix checkout bug', assignee_id: ids.ali });
  await ok('POST', '/api/timer/start', { token: tokens.ali, body: { task_id: t.id } });
  assert.equal((await ok('GET', `/api/tasks/${t.id}`, { token: tokens.ali })).status, 'in_progress');
  advance(30 * MIN);
  await ok('POST', '/api/timer/pause', { token: tokens.ali, body: { reason: 'break' } });
  advance(10 * MIN);
  await ok('POST', '/api/timer/resume', { token: tokens.ali, body: {} });
  advance(20 * MIN);
  await ok('POST', '/api/timer/stop', { token: tokens.ali, body: {} });
  assert.equal((await ok('GET', `/api/tasks/${t.id}`, { token: tokens.ali })).tracked_secs, 50 * 60);
});

test('which apps and sites people use is not tracked: anything an older desktop app sends is ignored', async () => {
  const { ok, api, tokens, set, advance } = env;
  set(T0 + 50 * 3600000);
  const s = await ok('POST', '/api/timer/start', { token: tokens.zed, body: {} });
  const slot = new Date(Math.floor(env.clock.t / 600000) * 600000).toISOString();
  advance(10 * MIN);
  await ok('POST', '/api/activity', { token: tokens.zed, body: { slot_start: slot, tracked_secs: 600, active_secs: 500, entry_id: s.entry_id,
    apps: [{ app: 'Google Chrome', site: 'Instagram', secs: 120 }] } });
  await ok('POST', '/api/timer/stop', { token: tokens.zed, body: {} });
  const tables = env.app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('app_usage','app_rules')").all();
  assert.deepEqual(tables, [], 'nothing is stored anywhere');
  const d = await ok('GET', '/api/users/me/day?day=2026-10-25', { token: tokens.zed });
  assert.ok(!('apps' in d) && !('productivity_pct' in d));
  assert.equal(d.activity_pct, 83, 'keyboard and mouse activity is still measured');
  assert.equal((await api('GET', '/api/app-rules', { token: tokens.owner })).status, 404);
  assert.equal((await ok('GET', '/api/settings', { token: tokens.zed })).app_tracking, false);
  // the performance report: hours, activity and task results only
  const rep = await ok('GET', '/api/performance?from=2026-10-25&to=2026-10-25', { token: tokens.owner });
  assert.ok(!('apps' in rep));
  const z = rep.people.find((p) => p.name === 'Zed');
  assert.deepEqual([z.worked_secs, z.activity_pct, z.days_worked], [600, 83, 1]);
});

test('dashboards carry task numbers, and nothing about apps or sites', async () => {
  const { ok, tokens } = env;
  const team = await ok('GET', '/api/dashboard/team?day=2026-10-23', { token: tokens.mona });
  assert.ok(!('productivity_pct' in team.kpis) && !('unproductive_secs' in team.kpis));
  assert.ok(team.kpis.tasks.done_30 >= 2 && team.kpis.tasks.accuracy_pct === 67, 'tasks: ' + JSON.stringify(team.kpis.tasks));
  const me = await ok('GET', '/api/dashboard/me?day=2026-10-23', { token: tokens.ali });
  assert.ok(me.kpis.tasks.open >= 1 && !('productivity_pct' in me.kpis) && !('apps' in me.today));
});

test('a changed monitoring policy has to be accepted again before tracking', async () => {
  const { ok, api, tokens } = env;
  env.app.db.prepare('UPDATE users SET consent_version = 1 WHERE id = ?').run(ids.zed);
  assert.equal((await ok('GET', '/api/me', { token: tokens.zed })).consented, false);
  assert.equal((await api('POST', '/api/timer/start', { token: tokens.zed, body: {} })).status, 403);
  await ok('POST', '/api/me/consent', { token: tokens.zed });
  assert.equal((await ok('GET', '/api/me', { token: tokens.zed })).consented, true);
});
