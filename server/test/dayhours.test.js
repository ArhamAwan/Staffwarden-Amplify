'use strict';
// Different hours on some days for one person: a half day on Saturday changes what is expected that day,
// when they count as late or absent, and what the desktop app is told, without moving the other days.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, T0, MIN } = require('./helpers');

let env;
const DAY = 24 * 60 * MIN;
const SAT = T0 + DAY;                  // Saturday 2026-10-24, 09:00 in Pakistan
before(async () => {
  env = await makeEnv();
  // Mon to Sat, 40 hours a week, Saturday 09:00 to 13:00
  await env.person('sam', 'Sam', { work_days: '1,2,3,4,5,6', weekly_target_min: 2400 });
  await env.person('kim', 'Kim', { work_days: '1,2,3,4,5,6', weekly_target_min: 2400 });
});
after(() => env.close());

test('day hours are saved, checked and shown back', async () => {
  const { ok, api, tokens } = env;
  const sam = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Sam');
  for (const bad of [{ 7: { shift_start: '09:00', shift_end: '13:00' } }, { 6: { shift_start: '09:00' } }, { 6: { shift_start: '09:00', shift_end: '13:00', break_start: '11:00' } }, [1]]) {
    assert.equal((await api('PATCH', `/api/users/${sam.id}`, { token: tokens.owner, body: { day_hours: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api('PATCH', `/api/users/${sam.id}`, { token: tokens.sam, body: { day_hours: {} } })).status, 403);
  await ok('PATCH', `/api/users/${sam.id}`, { token: tokens.owner, body: { day_hours: { 6: { shift_start: '09:00', shift_end: '13:00', break_start: '', break_end: '' } } } });
  const back = await ok('GET', `/api/users/${sam.id}`, { token: tokens.owner });
  assert.deepEqual(back.day_hours, { 6: { shift_start: '09:00', shift_end: '13:00', break_start: null, break_end: null } });
});

test('Saturday expects its own hours and the rest of the week shares what is left', async () => {
  const { ok, set, tokens } = env;
  set(SAT);
  const sat = await ok('GET', '/api/dashboard/me', { token: tokens.sam });
  assert.equal(sat.day, '2026-10-24');
  assert.equal(sat.kpis.daily_target_secs, 4 * 3600);
  assert.equal(sat.user.shift_end, '13:00');
  assert.equal(sat.user.special_hours, true);
  // (40h - 4h) over the five other days = 7h12m
  const fri = await ok('GET', '/api/dashboard/me?day=2026-10-23', { token: tokens.sam });
  assert.equal(fri.kpis.daily_target_secs, 432 * 60);
  assert.equal(fri.user.shift_end, '18:00');
  // someone without day hours keeps 40h over six days
  assert.equal((await ok('GET', '/api/dashboard/me', { token: tokens.kim })).kpis.daily_target_secs, 400 * 60);
});

test('the desktop app is told the hours for the day it is in', async () => {
  const { ok, set, tokens } = env;
  set(SAT + 60 * MIN);
  const me = await ok('GET', '/api/me', { token: tokens.sam });
  assert.equal(me.shift_start, '09:00');
  assert.equal(me.shift_end, '13:00');
  assert.ok(me.day_hours['6']);
  set(SAT - DAY + 60 * MIN);   // Friday
  assert.equal((await ok('GET', '/api/me', { token: tokens.sam })).shift_end, '18:00');
});

test('after a short Saturday ends, someone who never started is absent, not "not started"', async () => {
  const { ok, set, tokens } = env;
  set(SAT + 5 * 60 * MIN);   // 14:00 on Saturday: Sam's day ended at 13:00, Kim's runs to 18:00
  const team = await ok('GET', '/api/dashboard/team', { token: tokens.owner });
  const by = (n) => team.members.find((m) => m.name === n);
  assert.equal(by('Sam').attendance, 'absent');
  assert.equal(by('Kim').attendance, 'not_started');
});

test('lateness on Saturday is measured from the Saturday start', async () => {
  const { ok, set, tokens, app } = env;
  const sam = app.db.prepare("SELECT id FROM users WHERE name = 'Sam'").get();
  app.db.prepare('UPDATE users SET day_hours = ? WHERE id = ?').run(JSON.stringify({ 6: { shift_start: '11:00', shift_end: '15:00' } }), sam.id);
  set(SAT + 2 * 60 * MIN + 5 * MIN);  // 11:05, inside the grace period
  await ok('POST', '/api/timer/start', { token: tokens.sam, body: {} });
  set(SAT + 3 * 60 * MIN);
  const d = await ok('GET', '/api/dashboard/me', { token: tokens.sam });
  assert.equal(d.attendance.status, 'present');
  assert.equal(d.attendance.late_by_min, 0);
});
