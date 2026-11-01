'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, T0, MIN } = require('./helpers');

let env, dev, ops, proj, task;
const DAY = '2026-10-23';
before(async () => {
  env = await makeEnv();
  const { ok, tokens } = env;
  dev = await ok('POST', '/api/teams', { token: tokens.owner, body: { name: 'Dev' } });
  ops = await ok('POST', '/api/teams', { token: tokens.owner, body: { name: 'Ops' } });
  await env.person('alice', 'Alice', { team_id: dev.id });
  await env.person('bob', 'Bob', { team_id: dev.id });
  await env.person('carol', 'Carol', { team_id: ops.id });
  const mia = await env.person('mia', 'Mia', { role: 'manager', team_id: dev.id });
  await ok('PATCH', `/api/users/${mia.id}`, { token: tokens.owner, body: { manages: [dev.id] } });
  await env.person('max', 'Max', { role: 'manager', team_id: ops.id });
  proj = await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'Website', access: 'everyone' } });
  task = await ok('POST', `/api/projects/${proj.id}/tasks`, { token: tokens.owner, body: { name: 'Homepage' } });

  // Friday: alice on time 08:55, bob late 09:25 then lunch from 10:00, carol never starts. Look at 11:00.
  env.set(T0 - 5 * MIN);
  const p = (await ok('GET', '/api/projects', { token: tokens.alice }))[0];
  await ok('POST', '/api/timer/start', { token: tokens.alice, body: { project_id: p.id, task_id: p.tasks[0].id } });
  env.set(T0 + 25 * MIN);
  await ok('POST', '/api/timer/start', { token: tokens.bob, body: {} });
  env.set(T0 + 60 * MIN);
  await ok('POST', '/api/timer/pause', { token: tokens.bob, body: { reason: 'lunch' } });
  env.set(T0 + 120 * MIN);
  await env.activity('alice', T0 + 120 * MIN, 120, 90);
  await env.activity('bob', T0 + 50 * MIN, 120, 30);
  await env.shot('alice');
  await env.ping('alice');
});
after(() => env.close());

test('manager dashboard: live states and KPIs add up', async () => {
  const d = await env.ok('GET', `/api/dashboard/team?day=${DAY}`, { token: env.tokens.owner });
  const by = Object.fromEntries(d.members.map((m) => [m.name, m]));
  assert.equal(by.Alice.state, 'working');
  assert.equal(by.Bob.state, 'break'); assert.equal(by.Bob.reason, 'lunch');
  assert.equal(by.Carol.state, 'offline'); assert.equal(by.Carol.attendance, 'not_started');
  assert.equal(by.Alice.worked_secs, 125 * 60);
  assert.equal(by.Bob.worked_secs, 35 * 60);
  assert.equal(by.Bob.break_secs, 60 * 60);
  const k = d.kpis;
  assert.equal(k.members, 3);
  assert.equal(k.working, 1); assert.equal(k.on_break, 1); assert.equal(k.not_started, 1);
  assert.equal(k.worked_secs, 160 * 60);
  assert.equal(k.attendance_rate, 67, '2 of 3 expected people have started');
  assert.equal(k.punctuality_rate, 50);
  assert.equal(k.late_count, 1);
  assert.equal(k.avg_break_secs, 1800, 'average over the two people who worked');
  assert.equal(k.activity_pct, 50);
  assert.equal(k.shots, 1);
  assert.equal(k.week_secs, 160 * 60);
  assert.equal(d.trend.length, 7);
  assert.equal(d.trend[6].day, DAY); assert.equal(d.trend[6].worked_secs, 160 * 60);
  assert.equal(d.trend[0].worked_secs, 0);
  assert.equal(by.Bob.late_by_min, 25);
  assert.ok(by.Alice.segs.length === 1 && by.Alice.segs[0][2] === 'w');
  assert.deepEqual(by.Bob.segs.map((s) => s[2]), ['w', 'b']);
  assert.ok(by.Alice.project === 'Website' && by.Alice.task === 'Homepage');
});

test('a team manager sees only their team; employees see only themselves', async () => {
  const { ok, api, tokens } = env;
  const mia = await ok('GET', `/api/dashboard/team?day=${DAY}`, { token: tokens.mia });
  assert.deepEqual(mia.members.map((m) => m.name).sort(), ['Alice', 'Bob']);
  assert.equal(mia.kpis.members, 2);
  const max = await ok('GET', `/api/dashboard/team?day=${DAY}`, { token: tokens.max });
  assert.equal(max.members.length, 3, 'a manager with no team assignment sees everyone');
  const carolId = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Carol').id;
  assert.equal((await api('GET', `/api/users/${carolId}/day?day=${DAY}`, { token: tokens.mia })).status, 403);
  assert.equal((await api('GET', `/api/users/${carolId}/day?day=${DAY}`, { token: tokens.alice })).status, 403);
  assert.equal((await api('GET', `/api/dashboard/team?day=${DAY}`, { token: tokens.alice })).status, 403);
  assert.equal((await api('GET', `/api/timesheets?from=${DAY}&to=${DAY}`, { token: tokens.alice })).status, 403);
  assert.equal((await api('GET', `/api/screenshots?user_id=all&day=${DAY}`, { token: tokens.alice })).status, 403);
  const list = await ok('GET', '/api/users', { token: tokens.mia });
  assert.deepEqual(list.map((u) => u.name).sort(), ['Alice', 'Bob', 'Mia']);
});

test('employee dashboard has its own KPIs', async () => {
  const d = await env.ok('GET', `/api/dashboard/me?day=${DAY}`, { token: env.tokens.alice });
  const k = d.kpis;
  assert.equal(d.live.state, 'working');
  assert.equal(k.worked_secs, 125 * 60);
  assert.equal(k.daily_target_secs, 8 * 3600);
  assert.equal(k.day_pct, 26);
  assert.equal(k.break_secs, 0);
  assert.equal(k.activity_pct, 75);
  assert.equal(k.week_target_secs, 40 * 3600);
  assert.equal(k.leave_allowance, 20); assert.equal(k.leave_left, 20);
  assert.equal(d.attendance.status, 'present');
  assert.equal(d.trend.length, 7);
  assert.ok(Array.isArray(d.today.segs));
  const bob = await env.ok('GET', `/api/dashboard/me?day=${DAY}`, { token: env.tokens.bob });
  assert.equal(bob.attendance.status, 'late'); assert.equal(bob.attendance.late_by_min, 25);
  assert.equal(bob.kpis.break_secs, 3600); assert.equal(bob.kpis.break_count, 1);
  assert.equal(bob.live.state, 'break');
});

test('day detail lists every break, including one still open, plus the screenshots', async () => {
  const { ok, tokens } = env;
  const bobId = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Bob').id;
  const d = await ok('GET', `/api/users/${bobId}/day?day=${DAY}`, { token: tokens.mia });
  assert.equal(d.breaks.length, 1);
  assert.deepEqual([d.breaks[0].reason, d.breaks[0].open, d.breaks[0].secs, d.breaks[0].ended_at], ['lunch', true, 3600, null]);
  assert.equal(d.live.state, 'break');
  assert.equal(d.attendance.late_by_min, 25);
  const mine = await ok('GET', `/api/users/me/day?day=${DAY}`, { token: tokens.alice });
  assert.equal(mine.shots_list.length, 1);
  assert.equal(mine.shots_list[0].activity, 75);
  assert.equal(mine.shots_list[0].project, 'Website');
  assert.equal(mine.activity.length, 1);
});

test('attendance grid: present, late, absent, off, upcoming', async () => {
  const g = await env.ok('GET', '/api/attendance?from=2026-10-19&to=2026-10-25', { token: env.tokens.owner });
  const row = (n) => g.rows.find((r) => r.name === n).cells;
  assert.equal(row('Alice')[DAY].status, 'present');
  assert.equal(row('Bob')[DAY].status, 'late');
  assert.equal(row('Carol')[DAY].status, 'not_started');
  // Alice only joined on the 23rd, so the days before that are not absences
  assert.equal(row('Alice')['2026-10-20'].status, 'before');
  assert.equal(row('Alice')['2026-10-24'].status, 'off');
  assert.equal(row('Alice')['2026-10-25'].status, 'off');
  const a = g.rows.find((r) => r.name === 'Alice').totals;
  assert.equal(a.worked_secs, 125 * 60); assert.equal(a.days_present, 1); assert.equal(a.days_absent, 0);
  // had she joined earlier, the four empty working days would count as absent
  const was = env.app.db.prepare("SELECT created_at FROM users WHERE name = 'Alice'").get().created_at;
  env.app.db.prepare("UPDATE users SET created_at = '2026-10-01T00:00:00.000Z' WHERE name = 'Alice'").run();
  const g2 = await env.ok('GET', '/api/attendance?from=2026-10-19&to=2026-10-25', { token: env.tokens.owner });
  const a2 = g2.rows.find((r) => r.name === 'Alice');
  assert.equal(a2.cells['2026-10-20'].status, 'absent'); assert.equal(a2.totals.days_absent, 4);
  env.app.db.prepare("UPDATE users SET created_at = ? WHERE name = 'Alice'").run(was);
});

test('the day rolls over per person: a different time zone gets a different day', async () => {
  const { ok, tokens, app } = env;
  const carolId = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Carol').id;
  await ok('PATCH', `/api/users/${carolId}`, { token: tokens.owner, body: { tz_offset_min: -300, shift_start: '09:00', shift_end: '17:00' } });
  const d = await ok('GET', `/api/users/${carolId}/day?day=${DAY}`, { token: tokens.owner });
  assert.equal(d.user.tz_offset_min, -300);
  // 11:00 Pakistan = 01:00 in New York: before her shift, so she is simply "upcoming"
  assert.equal(d.attendance.status, 'upcoming');
  await ok('PATCH', `/api/users/${carolId}`, { token: tokens.owner, body: { tz_offset_min: null, shift_start: null, shift_end: null } });
  assert.ok(app);
});

test('time off: request, scope, approval rules, balance, grid and holiday', async () => {
  const { ok, api, tokens } = env;
  const carolId = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Carol').id;
  const req = await ok('POST', '/api/timeoff', { token: tokens.carol, body: { kind: 'vacation', start_day: '2026-10-26', end_day: '2026-10-27', note: 'Family' } });
  assert.equal(req.status, 'pending'); assert.equal(req.working_days, 2);
  assert.equal((await api('POST', '/api/timeoff', { token: tokens.carol, body: { kind: 'sick', start_day: '2026-10-27', end_day: '2026-10-28' } })).status, 409, 'overlap');
  assert.equal((await api('POST', `/api/timeoff/${req.id}/decision`, { token: tokens.mia, body: { approve: true } })).status, 404, 'Mia does not manage Ops');
  assert.equal((await api('POST', `/api/timeoff/${req.id}/decision`, { token: tokens.carol, body: { approve: true } })).status, 403);
  assert.equal((await ok('GET', `/api/dashboard/team?day=${DAY}`, { token: tokens.max })).kpis.pending_timeoff, 1);
  await ok('POST', `/api/timeoff/${req.id}/decision`, { token: tokens.max, body: { approve: true, note: 'Enjoy' } });
  assert.equal((await api('POST', `/api/timeoff/${req.id}/decision`, { token: tokens.max, body: { approve: false } })).status, 409, 'already decided');
  // managers cannot approve their own request; the owner can approve anyone's
  const mine = await ok('POST', '/api/timeoff', { token: tokens.mia, body: { kind: 'personal', start_day: '2026-11-02', end_day: '2026-11-02' } });
  assert.equal(mine.status, 'pending');
  assert.equal((await api('POST', `/api/timeoff/${mine.id}/decision`, { token: tokens.mia, body: { approve: true } })).status, 403);
  await ok('POST', `/api/timeoff/${mine.id}/decision`, { token: tokens.owner, body: { approve: true } });

  await ok('POST', '/api/holidays', { token: tokens.owner, body: { day: '2026-10-28', name: 'Test holiday' } });
  assert.equal((await api('POST', '/api/holidays', { token: tokens.carol, body: { day: '2026-10-29', name: 'x' } })).status, 403);
  const g = await ok('GET', '/api/timesheets?from=2026-10-26&to=2026-10-30&user_id=' + carolId, { token: tokens.owner });
  const c = g.rows[0].cells;
  assert.deepEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((d) => c[d].status), ['leave', 'leave', 'holiday', 'upcoming']);
  assert.equal(g.holidays['2026-10-28'], 'Test holiday');
  const bal = await ok('GET', '/api/timeoff/balances?year=2026', { token: tokens.carol });
  assert.deepEqual([bal[0].taken, bal[0].left], [2, 18]);
  // the holiday falls on a working day, so a request spanning it doesn't use up allowance for that day
  const long = await ok('POST', '/api/timeoff', { token: tokens.alice, body: { kind: 'vacation', start_day: '2026-11-09', end_day: '2026-11-13' } });
  assert.equal(long.working_days, 5);
  await ok('DELETE', `/api/timeoff/${long.id}`, { token: tokens.alice });
  const cancelled = await ok('GET', '/api/timeoff?status=cancelled', { token: tokens.alice });
  assert.equal(cancelled.length, 1);
  // an employee only ever sees their own requests
  assert.ok((await ok('GET', '/api/timeoff', { token: tokens.alice })).every((r) => r.user_name === 'Alice'));
});

test('manual time needs a reason, cannot overlap, and is audited', async () => {
  const { ok, api, tokens } = env;
  const carolId = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Carol').id;
  const body = { user_id: carolId, start: '2026-10-22T04:00:00Z', end: '2026-10-22T08:00:00Z', project_id: proj.id };
  assert.equal((await api('POST', '/api/time/manual', { token: tokens.max, body })).status, 400, 'no note');
  const add = await ok('POST', '/api/time/manual', { token: tokens.max, body: { ...body, note: 'Offline workshop' } });
  assert.equal((await api('POST', '/api/time/manual', { token: tokens.max, body: { ...body, note: 'again' } })).status, 409);
  assert.equal((await api('POST', '/api/time/manual', { token: tokens.carol, body: { ...body, note: 'self' } })).status, 403);
  const g = await ok('GET', `/api/timesheets?from=2026-10-22&to=2026-10-22&user_id=${carolId}`, { token: tokens.max });
  assert.equal(g.rows[0].cells['2026-10-22'].worked_secs, 4 * 3600);
  assert.equal(g.rows[0].cells['2026-10-22'].status, 'present');
  const audit = await ok('GET', '/api/audit', { token: tokens.owner });
  assert.ok(audit.some((a) => a.action === 'time.manual_added' && /Offline workshop/.test(a.detail)));
  // Carol is told about the time added, with the reason
  const ch = await ok('GET', '/api/me/changes', { token: tokens.carol });
  assert.equal(ch[0].title, 'Time was added to your day');
  assert.equal(ch[0].reason, 'Offline workshop');
  assert.equal(ch[0].by, 'Max');
  assert.equal((await api('DELETE', `/api/time/entries/${add.entry_id}`, { token: tokens.max })).status, 400, 'removing time needs a reason');
  await ok('DELETE', `/api/time/entries/${add.entry_id}?reason=${encodeURIComponent('Workshop was cancelled')}`, { token: tokens.max });
  assert.ok((await ok('GET', '/api/audit', { token: tokens.owner })).some((a) => a.action === 'time.deleted'));
  // the audit log pages newest first: ?before=<id> gives the next older page with no overlap
  const all = await ok('GET', '/api/audit?limit=500', { token: tokens.owner });
  assert.ok(all.length >= 3);
  const p1 = await ok('GET', '/api/audit?limit=2', { token: tokens.owner });
  const p2 = await ok('GET', `/api/audit?limit=2&before=${p1[1].id}`, { token: tokens.owner });
  assert.deepEqual(p1.map((a) => a.id), all.slice(0, 2).map((a) => a.id));
  assert.equal(p2[0].id, all[2].id);
  assert.ok(p2.every((a) => a.id < p1[1].id));
  assert.equal((await ok('GET', `/api/audit?before=${all[all.length - 1].id}`, { token: tokens.owner })).length, 0);
  assert.equal((await ok('GET', '/api/me/changes', { token: tokens.carol }))[0].title, 'Time was removed from your day');
});

test('reports group by member, project and day; CSV export', async () => {
  const { ok, api, tokens } = env;
  const q = 'from=2026-10-19&to=2026-10-25';
  const byMember = await ok('GET', `/api/reports?${q}&group=member`, { token: tokens.owner });
  assert.equal(byMember.rows.find((r) => r.label === 'Alice').worked_secs, 125 * 60);
  const byProject = await ok('GET', `/api/reports?${q}&group=project`, { token: tokens.owner });
  assert.equal(byProject.rows.find((r) => r.label === 'Website').worked_secs, 125 * 60);
  assert.equal(byProject.rows.find((r) => r.label === 'No project').worked_secs, 35 * 60);
  const byDay = await ok('GET', `/api/reports?${q}&group=day`, { token: tokens.owner });
  assert.equal(byDay.rows.find((r) => r.key === DAY).worked_secs, 160 * 60);
  const csv = await api('GET', `/api/reports/export.csv?${q}`, { token: tokens.owner });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /timesheets-2026-10-19-to-2026-10-25\.csv/);
  assert.match(csv.data, /Date,Member,Status/);
  assert.match(csv.data, /2026-10-23,Alice,present,08:55,,2\.08,0,0,75,1,/);
  assert.equal((await api('GET', `/api/reports/export.csv?${q}`, { token: tokens.alice })).status, 403);
  assert.equal((await api('GET', '/api/reports?from=2026-01-01&to=2026-12-31', { token: tokens.owner })).status, 400, 'range cap');
});

test('people management: scoped creation, deactivate, password reset and change', async () => {
  const { ok, api, tokens, login } = env;
  const noTeam = await api('POST', '/api/users', { token: tokens.mia, body: { email: 'n1@test.com', name: 'N1', password: 'longenough1' } });
  assert.equal(noTeam.status, 400, 'a scoped manager must choose a team');
  assert.equal((await api('POST', '/api/users', { token: tokens.mia, body: { email: 'n2@test.com', name: 'N2', password: 'longenough1', team_id: ops.id } })).status, 403);
  const n3 = await ok('POST', '/api/users', { token: tokens.mia, body: { email: 'n3@test.com', name: 'N3', password: 'longenough1', team_id: dev.id, title: 'Designer' } });
  assert.equal(n3.title, 'Designer');
  assert.equal((await api('POST', '/api/users', { token: tokens.mia, body: { email: 'n4@test.com', name: 'N4', password: 'longenough1', team_id: dev.id, role: 'manager' } })).status, 403);
  assert.equal((await api('PATCH', `/api/users/${n3.id}`, { token: tokens.alice, body: { name: 'Hacked' } })).status, 403);
  const carolId = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Carol').id;
  assert.equal((await api('PATCH', `/api/users/${carolId}`, { token: tokens.mia, body: { title: 'x' } })).status, 403, 'outside Mia\'s teams');

  await ok('PATCH', `/api/users/${n3.id}`, { token: tokens.mia, body: { shift_start: '10:00', weekly_target_min: 1200, work_days: '1,2,3' } });
  const u = await ok('GET', `/api/users/${n3.id}`, { token: tokens.mia });
  assert.deepEqual([u.effective.shift_start, u.effective.weekly_target_min, u.effective.work_days], ['10:00', 1200, '1,2,3']);
  assert.equal((await api('PATCH', `/api/users/${n3.id}`, { token: tokens.mia, body: { shift_start: '25:00' } })).status, 400);

  const t3 = await login('n3@test.com', 'longenough1');
  assert.equal((await api('POST', '/api/me/password', { token: t3, body: { current_password: 'nope', new_password: 'brandnew-pass' } })).status, 403);
  await ok('POST', '/api/me/password', { token: t3, body: { current_password: 'longenough1', new_password: 'brandnew-pass' } });
  await login('n3@test.com', 'brandnew-pass');

  await ok('PATCH', `/api/users/${n3.id}`, { token: tokens.mia, body: { active: false } });
  assert.equal((await api('GET', '/api/me', { token: t3 })).status, 403, 'existing sessions stop working');
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'n3@test.com', password: 'brandnew-pass' } })).status, 403);
  assert.ok(!(await ok('GET', '/api/users', { token: tokens.mia })).some((x) => x.name === 'N3'), 'hidden from the default list');
  assert.ok((await ok('GET', '/api/users?all=1', { token: tokens.mia })).some((x) => x.name === 'N3'));
  await ok('PATCH', `/api/users/${n3.id}`, { token: tokens.mia, body: { active: true, password: 'reset-by-boss-1' } });
  await login('n3@test.com', 'reset-by-boss-1');
});

test('settings: owner only, validated, and visible to the desktop app', async () => {
  const { ok, api, tokens } = env;
  const s0 = await ok('GET', '/api/settings', { token: tokens.alice });
  assert.equal(s0.shots_per_10, 2); assert.equal(s0.pause_reasons.length, 6);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.max, body: { shots_per_10: 1 } })).status, 403);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.owner, body: { shots_per_10: 4 } })).status, 400);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.owner, body: { bogus: 1 } })).status, 400);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.owner, body: { no_signal_min: 30, stale_min: 20 } })).status, 400);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { shots_per_10: 3, grace_min: 15, org_name: 'Amplify' } });
  const s1 = await ok('GET', '/api/settings', { token: tokens.alice });
  assert.deepEqual([s1.shots_per_10, s1.grace_min, s1.org_name], [3, 15, 'Amplify']);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { shots_per_10: 2, grace_min: 10 } });
});

test('settings: apps hidden in screenshots always include WhatsApp, owner-only, validated', async () => {
  const { ok, api, tokens } = env;
  assert.deepEqual((await ok('GET', '/api/settings', { token: tokens.alice })).blackout_apps, ['WhatsApp']);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.max, body: { blackout_apps: ['Telegram'] } })).status, 403);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.owner, body: { blackout_apps: 'Telegram' } })).status, 400);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.owner, body: { blackout_apps: ['x'.repeat(41)] } })).status, 400);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { blackout_apps: [' Telegram ', 'telegram', 'whatsapp', ''] } });
  assert.deepEqual((await ok('GET', '/api/settings', { token: tokens.alice })).blackout_apps, ['WhatsApp', 'Telegram']);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { blackout_apps: [] } });
  assert.deepEqual((await ok('GET', '/api/settings', { token: tokens.alice })).blackout_apps, ['WhatsApp'], 'WhatsApp cannot be removed');
});

test('screenshots: viewing is scoped, employees can delete their own, deletes are audited', async () => {
  const { ok, api, tokens } = env;
  const list = await ok('GET', `/api/screenshots?user_id=all&day=${DAY}`, { token: tokens.mia });
  assert.equal(list.length, 1);
  const id = list[0].id;
  assert.equal((await api('GET', `/api/screenshots/${id}/image`, { token: tokens.bob })).status, 403, 'colleagues cannot see each other');
  const img = await api('GET', `/api/screenshots/${id}/image`, { token: tokens.mia, raw: true });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await api('GET', `/api/screenshots/${id}/thumb`, { token: tokens.alice })).status, 200, 'falls back to the full image');
  assert.equal((await api('GET', `/api/screenshots/${id}/image`, { token: tokens.max })).status, 200);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { employees_can_delete_shots: false } });
  assert.equal((await api('DELETE', `/api/screenshots/${id}`, { token: tokens.alice })).status, 403);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { employees_can_delete_shots: true } });
  await ok('DELETE', `/api/screenshots/${id}`, { token: tokens.alice });
  assert.equal((await ok('GET', `/api/screenshots?user_id=all&day=${DAY}`, { token: tokens.owner })).length, 0);
  assert.ok((await ok('GET', '/api/audit', { token: tokens.owner })).some((a) => a.action === 'screenshot.deleted'));
  assert.equal((await api('GET', `/api/screenshots/${id}/image`, { token: tokens.alice })).status, 404);
});
