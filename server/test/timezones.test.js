'use strict';
// Time zones by place: someone in New York keeps a 9 to 5 in New York time, and it stays 9 to 5 when the
// US clocks go back on Sunday 1 November 2026 (UTC-4 before, UTC-5 after).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env, nia;
before(async () => {
  env = await makeEnv();
  nia = await env.person('nia', 'Nia', { shift_start: '09:00', shift_end: '17:00' });
  await env.person('ali', 'Ali');
});
after(() => env.close());

test('a zone is checked, saved, replaces a fixed offset and the person is told', async () => {
  const { ok, api, tokens } = env;
  await ok('PATCH', `/api/users/${nia.id}`, { token: tokens.owner, body: { tz_offset_min: -300 } });
  assert.equal((await api('PATCH', `/api/users/${nia.id}`, { token: tokens.owner, body: { tz_name: 'Mars/Olympus' } })).status, 400);
  await ok('PATCH', `/api/users/${nia.id}`, { token: tokens.owner, body: { tz_name: 'America/New_York' } });
  const back = await ok('GET', `/api/users/${nia.id}`, { token: tokens.owner });
  assert.equal(back.tz_name, 'America/New_York');
  assert.equal(back.tz_offset_min, null);
  assert.equal(back.effective.tz_name, 'America/New_York');
  const changes = await ok('GET', '/api/me/changes', { token: tokens.nia });
  assert.ok(changes.some((c) => c.lines.some((l) => /Time zone: .*New York/.test(l))), JSON.stringify(changes));
});

test('the offset follows daylight saving', async () => {
  const { ok, set, tokens } = env;
  set(Date.UTC(2026, 9, 30, 14, 0));            // Fri 30 Oct, 10:00 in New York (UTC-4)
  assert.equal((await ok('GET', '/api/me', { token: tokens.nia })).tz_offset_min, -240);
  set(Date.UTC(2026, 10, 2, 15, 0));            // Mon 2 Nov, 10:00 in New York (UTC-5)
  assert.equal((await ok('GET', '/api/me', { token: tokens.nia })).tz_offset_min, -300);
  // someone on the company default is unaffected
  assert.equal((await ok('GET', '/api/me', { token: tokens.ali })).tz_offset_min, 300);
});

test('9:00 in New York is on time on both sides of the change', async () => {
  const { ok, set, tokens } = env;
  set(Date.UTC(2026, 9, 30, 13, 2));            // Fri 9:02 EDT
  await ok('POST', '/api/timer/start', { token: tokens.nia, body: {} });
  set(Date.UTC(2026, 9, 30, 17, 0));
  await ok('POST', '/api/timer/stop', { token: tokens.nia, body: {} });
  const fri = await ok('GET', '/api/dashboard/me', { token: tokens.nia });
  assert.equal(fri.day, '2026-10-30');
  assert.equal(fri.attendance.status, 'present');
  assert.equal(fri.attendance.late_by_min, 0);
  assert.equal(fri.user.tz_offset_min, -240);

  set(Date.UTC(2026, 10, 2, 13, 30));           // Mon 8:30 EST: before the shift
  assert.equal((await ok('GET', '/api/dashboard/me', { token: tokens.nia })).attendance.status, 'upcoming');
  set(Date.UTC(2026, 10, 2, 14, 2));            // Mon 9:02 EST
  await ok('POST', '/api/timer/start', { token: tokens.nia, body: {} });
  set(Date.UTC(2026, 10, 2, 16, 0));
  const mon = await ok('GET', '/api/dashboard/me', { token: tokens.nia });
  assert.equal(mon.day, '2026-11-02');
  assert.equal(mon.attendance.late_by_min, 0);
  assert.equal(mon.user.tz_offset_min, -300);
  // looking back at Friday still uses Friday's offset
  assert.equal((await ok('GET', '/api/dashboard/me?day=2026-10-30', { token: tokens.nia })).user.tz_offset_min, -240);
  await ok('POST', '/api/timer/stop', { token: tokens.nia, body: {} });
});

test("the zone of the person's own computer is remembered as a suggestion", async () => {
  const { ok, base, tokens } = env;
  const hit = (tz) => fetch(base + '/api/me', { headers: { Authorization: `Bearer ${tokens.ali}`, 'X-Workhelm-Tz': tz } });
  await hit('Not/AZone');
  assert.equal((await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Ali').seen_tz, null);
  await hit('America/Chicago');
  const ali = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Ali');
  assert.equal(ali.seen_tz, 'America/Chicago');
  assert.equal(ali.tz_name, null);              // only a suggestion: nothing changes until a manager picks it
});

test('the company zone can be a place too', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('PUT', '/api/settings', { token: tokens.owner, body: { tz_name: 'Nowhere' } })).status, 400);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { tz_name: 'Europe/London' } });
  const s = await ok('GET', '/api/settings', { token: tokens.ali });
  assert.equal(s.tz_name, 'Europe/London');
  assert.equal(s.tz_offset_min, 0);             // 2 Nov: London is on GMT
  assert.equal((await ok('GET', '/api/me', { token: tokens.ali })).tz_offset_min, 0);
  // Nia keeps her own zone
  assert.equal((await ok('GET', '/api/me', { token: tokens.nia })).tz_offset_min, -300);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { tz_name: null } });
  assert.equal((await ok('GET', '/api/me', { token: tokens.ali })).tz_offset_min, 300);
});
