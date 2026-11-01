'use strict';
// Screenshot frequency per company / team / person, idle that keeps the timer running,
// "away" time (sleep, restart) and privacy marks on screenshots.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, T0, MIN } = require('./helpers');

let env, team;
before(async () => {
  env = await makeEnv();
  team = await env.ok('POST', '/api/teams', { token: env.tokens.owner, body: { name: 'Design' } });
  await env.person('dina', 'Dina', { team_id: team.id });
  await env.person('ed', 'Ed', { team_id: team.id });
  await env.person('fay', 'Fay');
  await env.person('gus', 'Gus');
});
after(() => env.close());

test('screenshots per 10 minutes: company default, then the team, then the person; managers see where it comes from', async () => {
  const { ok, api, tokens } = env;
  const me = async (k) => ok('GET', '/api/me', { token: tokens[k] });
  assert.deepEqual([(await me('dina')).shots_per_10, (await me('dina')).shots_source], [2, 'company']);
  await ok('PATCH', `/api/teams/${team.id}`, { token: tokens.owner, body: { shots_per_10: 3 } });
  assert.deepEqual([(await me('dina')).shots_per_10, (await me('dina')).shots_source], [3, 'team']);
  assert.equal((await me('fay')).shots_per_10, 2, 'people outside the team are unaffected');
  const ed = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Ed');
  await ok('PATCH', `/api/users/${ed.id}`, { token: tokens.owner, body: { shots_per_10: 0 } });
  assert.deepEqual([(await me('ed')).shots_per_10, (await me('ed')).shots_source], [0, 'person']);
  const listed = (await ok('GET', '/api/users', { token: tokens.owner })).find((u) => u.name === 'Ed');
  assert.deepEqual([listed.shots_per_10, listed.effective.shots_per_10, listed.effective.shots_source], [0, 0, 'person']);
  assert.equal((await ok('GET', '/api/teams', { token: tokens.owner })).find((t) => t.id === team.id).shots_per_10, 3);
  // validation and permissions
  assert.equal((await api('PATCH', `/api/users/${ed.id}`, { token: tokens.owner, body: { shots_per_10: 4 } })).status, 400);
  assert.equal((await api('PATCH', `/api/teams/${team.id}`, { token: tokens.dina, body: { shots_per_10: 1 } })).status, 403);
  // back to inheriting
  await ok('PATCH', `/api/teams/${team.id}`, { token: tokens.owner, body: { shots_per_10: null } });
  assert.equal((await me('dina')).shots_source, 'company');
  // the desktop app learns the current value from its heartbeat
  await ok('POST', '/api/timer/start', { token: tokens.ed, body: {} });
  assert.equal((await env.ping('ed')).shots_per_10, 0);
  await ok('POST', '/api/timer/stop', { token: tokens.ed, body: {} });
});

test('screenshots off: the server refuses screenshots but time and activity are still tracked', async () => {
  const { ok, api, tokens, set, advance } = env;
  set(T0 + 60 * MIN);
  await ok('POST', '/api/timer/start', { token: tokens.ed, body: {} });
  advance(5 * MIN);
  const r = await env.shot('ed');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /turned off/);
  assert.equal((await env.activity('ed', T0 + 60 * MIN, 300, 200)).status, 200);
  advance(5 * MIN);
  const stop = await ok('POST', '/api/timer/stop', { token: tokens.ed, body: {} });
  assert.equal(stop.summary.worked_secs, 10 * 60);
  assert.equal(stop.summary.shots, 0);
  assert.equal((await api('GET', '/api/screenshots?day=2026-10-23&user_id=me', { token: tokens.ed })).data.length, 0);
});

test('idle while running: still worked, shown as idle, live state idle, no screenshots inside, and backdated idle drops screenshots', async () => {
  const { ok, api, tokens, set, advance } = env;
  set(T0 + 3 * 60 * MIN);
  const t0 = env.clock.t;
  await ok('POST', '/api/timer/start', { token: tokens.dina, body: {} });
  advance(12 * MIN);
  assert.equal((await env.shot('dina')).status, 200);                      // at 12 min: before idle is noticed
  advance(8 * MIN);                                                          // noticed at 20 min, idle since 10 min
  const st = await ok('POST', '/api/timer/idle', { token: tokens.dina, body: { state: 'start', at: new Date(t0 + 10 * MIN).toISOString() } });
  assert.equal(st.trimmed_screenshots, 1, 'the screenshot from inside the idle stretch is removed');
  assert.equal((await ok('POST', '/api/timer/idle', { token: tokens.dina, body: { state: 'start' } })).already, true, 'retry-safe');
  const cur = await ok('GET', '/api/timer/current', { token: tokens.dina });
  assert.equal(cur.running, true); assert.equal(cur.idle, true);
  const dash = await ok('GET', '/api/dashboard/team?day=2026-10-23', { token: tokens.owner });
  assert.equal(dash.members.find((m) => m.name === 'Dina').state, 'idle');
  const during = await api('POST', '/api/screenshots', { token: tokens.dina, body: { slot_start: new Date(env.clock.t).toISOString(), taken_at: new Date(env.clock.t).toISOString(), image_base64: env.PNG.toString('base64') } });
  assert.equal(during.status, 409, 'no screenshot may exist inside an idle stretch');
  advance(10 * MIN);
  await ok('POST', '/api/timer/idle', { token: tokens.dina, body: { state: 'end', at: new Date(t0 + 30 * MIN).toISOString() } });
  advance(10 * MIN);
  assert.equal((await env.shot('dina')).status, 200, 'screenshots again after idle');
  const stop = await ok('POST', '/api/timer/stop', { token: tokens.dina, body: {} });
  const s = stop.summary;
  assert.equal(s.worked_secs, 40 * 60, 'idle time is still worked time');
  assert.equal(s.idle_secs, 20 * 60);
  assert.equal(s.break_secs, 0);
  assert.deepEqual(s.breaks.map((b) => [b.type, b.counted, b.secs]), [['idle', true, 1200]]);
  const day = await ok('GET', '/api/users/me/day?day=2026-10-23', { token: tokens.dina });
  assert.ok(day.segs.some((g) => g[2] === 'i' && g[1] - g[0] === 20), 'the ribbon shows a 20-minute idle stretch');
});

test('a pause ends idle; idle that began after a backdated pause is dropped', async () => {
  const { ok, tokens, set, advance } = env;
  set(T0 + 5 * 60 * MIN);
  const t0 = env.clock.t;
  await ok('POST', '/api/timer/start', { token: tokens.fay, body: {} });
  advance(30 * MIN);
  await ok('POST', '/api/timer/idle', { token: tokens.fay, body: { state: 'start', at: new Date(t0 + 20 * MIN).toISOString() } });
  await ok('POST', '/api/timer/pause', { token: tokens.fay, body: { reason: 'lunch', at: new Date(t0 + 15 * MIN).toISOString() } });
  advance(10 * MIN);
  await ok('POST', '/api/timer/resume', { token: tokens.fay, body: {} });
  advance(5 * MIN);
  const s = (await ok('POST', '/api/timer/stop', { token: tokens.fay, body: {} })).summary;
  assert.equal(s.idle_secs, 0, 'the idle stretch was inside the lunch break');
  assert.equal(s.worked_secs, 20 * 60);
  assert.equal(s.break_secs, 25 * 60);
});

test('away (computer asleep or restarting) is not counted as work or as a break, and screenshots inside it are refused', async () => {
  const { ok, api, tokens, set, advance } = env;
  set(T0 + 7 * 60 * MIN);
  const t0 = env.clock.t;
  await ok('POST', '/api/timer/start', { token: tokens.gus, body: {} });
  advance(20 * MIN);
  await ok('POST', '/api/timer/pause', { token: tokens.gus, body: { reason: 'away', at: new Date(t0 + 10 * MIN).toISOString() } });
  await ok('POST', '/api/timer/resume', { token: tokens.gus, body: {} });
  const inside = await api('POST', '/api/screenshots', { token: tokens.gus, body: { slot_start: new Date(t0 + 15 * MIN).toISOString(), taken_at: new Date(t0 + 15 * MIN).toISOString(), image_base64: env.PNG.toString('base64') } });
  assert.equal(inside.status, 409);
  advance(10 * MIN);
  const s = (await ok('POST', '/api/timer/stop', { token: tokens.gus, body: {} })).summary;
  assert.equal(s.worked_secs, 20 * 60);
  assert.equal(s.break_secs, 0);
  assert.equal(s.break_count, 0);
  assert.deepEqual(s.breaks.map((b) => [b.type, b.secs]), [['away', 600]]);
});

test('screenshots carry their privacy mark to the dashboard', async () => {
  const { ok, api, tokens, set, advance } = env;
  set(T0 + 9 * 60 * MIN);
  await ok('POST', '/api/timer/start', { token: tokens.dina, body: {} });
  advance(2 * MIN);
  const post = (privacy) => api('POST', '/api/screenshots', { token: tokens.dina, body: { slot_start: new Date(env.clock.t).toISOString(), taken_at: new Date(env.clock.t).toISOString(), image_base64: env.PNG.toString('base64'), privacy } });
  assert.equal((await post('partial')).status, 200);
  advance(MIN);
  assert.equal((await post('full')).status, 200);
  advance(MIN);
  assert.equal((await post('everything')).status, 400);
  const list = await ok('GET', '/api/screenshots?day=2026-10-23&user_id=all', { token: tokens.owner });
  const mine = list.filter((x) => x.user_name === 'Dina' && x.taken_at >= new Date(T0 + 9 * 60 * MIN).toISOString());
  assert.deepEqual(mine.map((x) => x.privacy), ['partial', 'full']);
  await ok('POST', '/api/timer/stop', { token: tokens.dina, body: {} });
});

test('privacy settings: categories are owner settings the desktop app reads', async () => {
  const { ok, api, tokens } = env;
  const s0 = await ok('GET', '/api/settings', { token: tokens.dina });
  assert.deepEqual(s0.blackout_categories, { banking: true, social: true }, 'banking and social media are always hidden');
  assert.equal(s0.blackout_full_front, false, 'only private windows are painted black, never the whole screenshot');
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { blackout_categories: { social: false, banking: false }, blackout_full_front: false, shots_per_10: 1 } });
  const s1 = await ok('GET', '/api/settings', { token: tokens.dina });
  assert.deepEqual(s1.blackout_categories, { banking: true, social: true });
  assert.equal(s1.blackout_full_front, false);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { blackout_full_front: true } });
  assert.equal((await ok('GET', '/api/settings', { token: tokens.dina })).blackout_full_front, false, 'the old setting is accepted but has no effect');
  assert.equal(s1.shots_per_10, 1);
  assert.deepEqual((await ok('GET', '/api/settings', { token: tokens.dina })).blackout_categories, { banking: true, social: true }, 'trying to switch them off changes nothing');
  assert.equal((await api('PUT', '/api/settings', { token: tokens.dina, body: { blackout_full_front: false } })).status, 403);
});
