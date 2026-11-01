'use strict';
// Night shifts (past midnight) and the scheduled break.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

const pkt = (day, h, m = 0) => Date.parse(`${day}T00:00:00Z`) + ((h - 5) * 60 + m) * MIN;   // Pakistan time
let env, nia, day;
before(async () => {
  env = await makeEnv({ start: pkt('2026-10-26', 12) });
  await env.ok('PUT', '/api/settings', { token: env.tokens.owner, body: { shift_start: '18:00', shift_end: '03:30', break_start: '22:00', break_end: '22:30' } });
  nia = await env.person('nia', 'Nia');
});
after(() => env.close());
const T = (k) => env.tokens[k];

test('the company schedule carries the break; each person can have their own', async () => {
  const { ok, api } = env;
  const s = await ok('GET', '/api/settings', { token: T('nia') });
  assert.deepEqual([s.shift_start, s.shift_end, s.break_start, s.break_end], ['18:00', '03:30', '22:00', '22:30']);
  const me = await ok('GET', '/api/me', { token: T('nia') });
  assert.deepEqual([me.break_start, me.break_end, me.day_start_min], ['22:00', '22:30', 630], 'a night shift day starts at 10:30 in the morning');
  const other = await env.person('omar', 'Omar', { shift_start: '09:00', shift_end: '18:00', break_start: '13:00', break_end: '14:00' });
  const u = await ok('GET', `/api/users/${other.id}`, { token: T('owner') });
  assert.deepEqual([u.effective.break_start, u.effective.break_end, u.effective.day_start_min], ['13:00', '14:00', 0]);
  assert.equal((await api('PATCH', `/api/users/${other.id}`, { token: T('owner'), body: { break_start: '25:00' } })).status, 400);
  await ok('PATCH', `/api/users/${other.id}`, { token: T('owner'), body: { break_start: '', break_end: '' } });
  assert.equal((await ok('GET', `/api/users/${other.id}`, { token: T('owner') })).effective.break_start, '22:00', 'cleared: back to the company break');
  await ok('PUT', '/api/settings', { token: T('owner'), body: { break_start: '', break_end: '' } });
  assert.equal((await ok('GET', '/api/settings', { token: T('nia') })).break_start, null, 'the company can have no break');
  await ok('PUT', '/api/settings', { token: T('owner'), body: { break_start: '22:00', break_end: '22:30' } });
});

test('a night shift is one work day: 6 PM Monday to 3:20 AM Tuesday all counts for Monday', async () => {
  const { ok, set } = env;
  day = '2026-10-26';
  set(pkt(day, 19));
  let d = await ok('GET', `/api/users/${nia.id}/day`, { token: T('owner') });
  assert.equal(d.day, day);
  assert.equal(d.attendance.status, 'not_started', 'at 7 PM, not started yet (not "absent")');
  set(pkt(day, 18, 8));
  await ok('POST', '/api/timer/start', { token: T('nia') });
  set(pkt(day, 22, 0)); await ok('POST', '/api/timer/pause', { token: T('nia'), body: { reason: 'break' } });
  set(pkt(day, 22, 30)); await ok('POST', '/api/timer/resume', { token: T('nia'), body: {} });
  set(pkt('2026-10-27', 1, 0));                       // after midnight: still Monday's work day
  d = await ok('GET', `/api/users/${nia.id}/day`, { token: T('owner') });
  assert.equal(d.day, day, 'at 1 AM Tuesday, "today" is still Monday\'s shift');
  assert.equal(d.running, true);
  set(pkt('2026-10-27', 3, 20));
  await ok('POST', '/api/timer/stop', { token: T('nia'), body: {} });
  d = await ok('GET', `/api/users/${nia.id}/day?day=${day}`, { token: T('owner') });
  assert.equal(d.worked_secs, (9 * 60 + 12 - 30) * 60, '18:08 to 03:20 minus the 30-minute break');
  assert.equal(d.attendance.status, 'present', '8 minutes after 6 PM is within the grace period');
  assert.equal(d.attendance.late_by_min, 0);
  assert.equal(d.day_start_min, 630);
  assert.deepEqual([d.segs[0][0], d.segs[d.segs.length - 1][1]], [7 * 60 + 38, 16 * 60 + 50], 'minutes are counted from 10:30 AM');
  const tue = await ok('GET', `/api/users/${nia.id}/day?day=2026-10-27`, { token: T('owner') });
  assert.equal(tue.worked_secs, 0, 'nothing spills into Tuesday');
});

test('Tuesday: starting at 6:40 PM is late; the week adds up per shift', async () => {
  const { ok, set } = env;
  set(pkt('2026-10-27', 18, 40));
  await ok('POST', '/api/timer/start', { token: T('nia') });
  set(pkt('2026-10-28', 2, 0));
  await ok('POST', '/api/timer/stop', { token: T('nia'), body: {} });
  const d = await ok('GET', `/api/users/${nia.id}/day?day=2026-10-27`, { token: T('owner') });
  assert.equal(d.attendance.status, 'late');
  assert.equal(d.attendance.late_by_min, 40);
  const sheet = await ok('GET', '/api/timesheets?from=2026-10-26&to=2026-10-28', { token: T('owner') });
  const row = sheet.rows.find((r) => r.user_id === nia.id);
  assert.ok(row.cells['2026-10-26'].worked_secs > 8 * 3600);
  assert.ok(row.cells['2026-10-27'].worked_secs > 7 * 3600);
  assert.equal(row.cells['2026-10-28'].worked_secs, 0);
  // at 2 AM, 8 of the 9.5 shift hours have gone by: only that share of Tuesday is due so far
  const tueCell = row.cells['2026-10-27'];
  assert.equal(row.cells['2026-10-26'].expected_done_secs, row.cells['2026-10-26'].expected_secs);
  assert.equal(tueCell.expected_done_secs, Math.round(tueCell.expected_secs * 480 / 570));
  assert.equal(row.cells['2026-10-28'].expected_done_secs, 0);
  assert.equal(row.totals.expected_done_secs, row.cells['2026-10-26'].expected_secs + tueCell.expected_done_secs);
});

test('a Friday night shift that ends on Saturday morning is Friday, not work on a day off', async () => {
  const { ok, set } = env;
  set(pkt('2026-10-30', 18, 0));
  await ok('POST', '/api/timer/start', { token: T('nia') });
  set(pkt('2026-10-31', 3, 0));
  await ok('POST', '/api/timer/stop', { token: T('nia'), body: {} });
  const fri = await ok('GET', `/api/users/${nia.id}/day?day=2026-10-30`, { token: T('owner') });
  const sat = await ok('GET', `/api/users/${nia.id}/day?day=2026-10-31`, { token: T('owner') });
  assert.equal(fri.worked_secs, 9 * 3600);
  assert.equal(sat.worked_secs, 0);
  assert.equal(sat.attendance.extra, false);
});
