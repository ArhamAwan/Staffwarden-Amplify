'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, T0, MIN } = require('./helpers');

let env;
before(async () => { env = await makeEnv(); await env.person('alice', 'Alice'); });
after(() => env.close());

test('tracking is blocked until the employee accepts the policy', async () => {
  await env.api('POST', '/api/users', { token: env.tokens.owner, body: { email: 'newbie@test.com', name: 'Newbie', password: 'newbie-pass-1' } });
  const t = await env.login('newbie@test.com', 'newbie-pass-1');
  assert.equal((await env.api('POST', '/api/timer/start', { token: t, body: {} })).status, 403);
  assert.equal((await env.api('POST', '/api/activity', { token: t, body: { slot_start: new Date(T0).toISOString(), tracked_secs: 5, active_secs: 1 } })).status, 403);
});

test('start, pause (with a reason), resume and stop record every break and report them at stop', async () => {
  const { ok, set, advance, tokens } = env;
  set(T0);
  const s = await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  assert.ok(s.entry_id);
  advance(60 * MIN);
  const p1 = await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'lunch' } });
  assert.equal(p1.reason, 'lunch');
  let cur = await ok('GET', '/api/timer/current', { token: tokens.alice });
  assert.equal(cur.paused, true); assert.equal(cur.running, false); assert.equal(cur.pause.reason, 'lunch');
  advance(30 * MIN);
  await ok('POST', '/api/timer/resume', { token: tokens.alice, body: {} });
  advance(60 * MIN);
  await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'prayer' } });
  advance(10 * MIN);
  await ok('POST', '/api/timer/resume', { token: tokens.alice, body: {} });
  advance(80 * MIN); // 4h in total
  const stop = await ok('POST', '/api/timer/stop', { token: tokens.alice, body: {} });
  const sum = stop.summary;
  assert.equal(sum.worked_secs, 200 * 60, 'worked = 4h minus 40 min of breaks');
  assert.equal(sum.break_secs, 40 * 60);
  assert.equal(sum.break_count, 2);
  assert.deepEqual(sum.breaks.map((b) => [b.reason, b.secs]), [['lunch', 1800], ['prayer', 600]]);
  assert.ok(sum.breaks.every((b) => b.started_at && b.ended_at));
  assert.equal(sum.first_start, new Date(T0).toISOString());
  assert.equal(sum.last_end, new Date(T0 + 240 * MIN).toISOString());
  cur = await ok('GET', '/api/timer/current', { token: tokens.alice });
  assert.equal(cur.active, false);
});

test('screenshots are refused while paused and while stopped, accepted while running', async () => {
  const { api, ok, set, advance, shot, tokens } = env;
  set(T0 + 24 * 3600000);              // next day, 09:00 Saturday local (any day works for tracking)
  const base = env.clock.t;
  await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  advance(10 * MIN);
  assert.equal((await shot('alice')).status, 200, 'running');
  await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'break' } });
  advance(5 * MIN);
  const during = await shot('alice');
  assert.equal(during.status, 409);
  assert.match(during.data.error, /paused/);
  advance(5 * MIN);
  await ok('POST', '/api/timer/resume', { token: tokens.alice, body: {} });
  advance(MIN);
  assert.equal((await shot('alice')).status, 200, 'running again');
  // an old screenshot that was taken before the pause is still accepted when it arrives late
  assert.equal((await shot('alice', base + 12 * MIN)).status, 409, 'inside the pause');
  assert.equal((await shot('alice', base + 5 * MIN)).status, 200, 'before the pause, uploaded late');
  advance(10 * MIN);
  await ok('POST', '/api/timer/stop', { token: tokens.alice, body: {} });
  advance(MIN);
  assert.equal((await shot('alice')).status, 409, 'stopped');
  const none = await api('POST', '/api/screenshots', { token: tokens.alice, body: { slot_start: new Date(env.clock.t).toISOString(), taken_at: new Date(env.clock.t + 10 * 60000).toISOString(), image_base64: env.PNG.toString('base64') } });
  assert.equal(none.status, 400, 'future screenshots are rejected');
});

test('pause and resume are safe to retry; stopping while paused closes the pause', async () => {
  const { ok, api, set, advance, tokens } = env;
  set(T0 + 2 * 24 * 3600000);
  await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  advance(20 * MIN);
  const a = await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'break' } });
  const b = await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'lunch' } });
  assert.equal(b.already, true); assert.equal(b.pause_id, a.pause_id, 'no second pause is created');
  advance(15 * MIN);
  const stop = await ok('POST', '/api/timer/stop', { token: tokens.alice, body: {} });
  assert.equal(stop.summary.break_secs, 15 * 60);
  assert.equal(stop.summary.worked_secs, 20 * 60);
  assert.equal(stop.summary.breaks[0].open, false);
  assert.equal((await api('POST', '/api/timer/stop', { token: tokens.alice, body: {} })).status, 409, 'nothing running');
  assert.equal((await api('POST', '/api/timer/pause', { token: tokens.alice, body: {} })).status, 409);
  const r = await ok('POST', '/api/timer/resume', { token: tokens.alice, body: {} }).catch(() => null);
  assert.equal(r, null, 'resume with no timer is refused');
});

test('unknown pause reasons are refused', async () => {
  const { ok, api, set, tokens } = env;
  set(T0 + 3 * 24 * 3600000);
  await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  assert.equal((await api('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'nap' } })).status, 400);
  await ok('POST', '/api/timer/stop', { token: tokens.alice, body: {} });
});

test('a backdated idle pause removes the screenshots and activity from the idle minutes', async () => {
  const { ok, set, advance, shot, activity, tokens, app } = env;
  const t0 = T0 + 4 * 24 * 3600000;
  set(t0);
  const s = await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  advance(5 * MIN); assert.equal((await shot('alice')).status, 200);       // 5 min: kept
  advance(3 * MIN); assert.equal((await shot('alice')).status, 200);       // 8 min: inside the idle stretch
  await activity('alice', t0 + 6 * MIN, 120, 0, s.entry_id);               // slot [6,8): straddles the idle start at 7
  await activity('alice', t0 + 8 * MIN, 120, 0, s.entry_id);               // slot [8,10): fully idle
  advance(4 * MIN);                                                        // now 12 min
  const p = await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'idle', at: new Date(t0 + 7 * MIN).toISOString() } });
  assert.equal(p.trimmed_screenshots, 1);
  assert.equal(p.started_at, new Date(t0 + 7 * MIN).toISOString());
  const day = await ok('GET', '/api/users/me/day?day=2026-10-27', { token: tokens.alice });
  assert.equal(day.shots, 1, 'only the 5-minute screenshot is left');
  const slots = app.db.prepare('SELECT slot_start, tracked_secs FROM activity_slots WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY slot_start').all('alice@test.com');
  const mine = slots.filter((x) => x.slot_start >= new Date(t0).toISOString());
  assert.deepEqual(mine.map((x) => x.tracked_secs), [60], 'the straddling slot keeps only the time before the idle start; the idle slot is gone');
  advance(MIN);
  const stop = await ok('POST', '/api/timer/stop', { token: tokens.alice, body: {} });
  assert.equal(stop.summary.idle_secs, 6 * 60, 'idle is reported separately from breaks');
  assert.equal(stop.summary.break_secs, 0);
  assert.equal(stop.summary.worked_secs, 7 * 60);
});

test('reported times are clamped, never trusted blindly', async () => {
  const { ok, set, advance, tokens } = env;
  const t0 = T0 + 5 * 24 * 3600000;
  set(t0);
  await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  advance(10 * MIN);
  const future = await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'break', at: new Date(t0 + 99 * MIN).toISOString() } });
  assert.equal(future.started_at, new Date(t0 + 10 * MIN).toISOString(), 'a clock that runs ahead is clamped to now');
  const early = await ok('POST', '/api/timer/resume', { token: tokens.alice, body: { at: new Date(t0 - 99 * MIN).toISOString() } });
  assert.equal(early.break_secs, 0, 'a resume cannot be earlier than the pause');
  const stop = await ok('POST', '/api/timer/stop', { token: tokens.alice, body: { ended_at: new Date(t0 - 5 * MIN).toISOString() } });
  assert.equal(stop.ended_at, new Date(t0 + 10 * MIN).toISOString(), 'a stop cannot precede the last event');
});

test('property: across hundreds of random actions no screenshot ever exists inside a pause or outside the timer', async () => {
  const e = await makeEnv({ start: T0 + 10 * 24 * 3600000 });
  try {
    await e.person('zed', 'Zed');
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    let state = 'stopped';
    let accepted = 0, refused = 0;
    for (let i = 0; i < 600; i++) {
      e.advance(Math.floor(5 + rnd() * 240) * 1000);
      const r = rnd();
      if (r < 0.12) { if (state === 'stopped') { await e.ok('POST', '/api/timer/start', { token: e.tokens.zed, body: {} }); state = 'running'; } }
      else if (r < 0.28) { if (state === 'running') { await e.ok('POST', '/api/timer/pause', { token: e.tokens.zed, body: { reason: rnd() < 0.5 ? 'break' : 'lunch' } }); state = 'paused'; } }
      else if (r < 0.46) { if (state === 'paused') { await e.ok('POST', '/api/timer/resume', { token: e.tokens.zed, body: {} }); state = 'running'; } }
      else if (r < 0.52) { if (state !== 'stopped') { await e.ok('POST', '/api/timer/stop', { token: e.tokens.zed, body: {} }); state = 'stopped'; } }
      else {
        const res = await e.shot('zed');
        if (state === 'running') { assert.equal(res.status, 200, `step ${i}`); accepted++; } else { assert.equal(res.status, 409, `step ${i} (${state})`); refused++; }
      }
      if (state !== 'stopped') await e.ping('zed');
    }
    assert.ok(accepted > 20 && refused > 20, `exercised both paths (${accepted}/${refused})`);
    const bad = e.app.db.prepare(`SELECT s.id FROM screenshots s WHERE s.deleted = 0 AND (
        NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.user_id = s.user_id AND t.started_at <= s.taken_at AND (t.ended_at IS NULL OR t.ended_at >= s.taken_at))
        OR EXISTS (SELECT 1 FROM pauses p WHERE p.user_id = s.user_id AND p.started_at <= s.taken_at AND (p.ended_at IS NULL OR p.ended_at > s.taken_at)))`).all();
    assert.deepEqual(bad, []);
  } finally { await e.close(); }
});

test('a silent running timer shows "no signal", then is closed at its last sign of life', async () => {
  const e = await makeEnv({ start: T0 + 20 * 24 * 3600000 });
  try {
    await e.person('yan', 'Yan');
    await e.person('boss', 'Boss', { role: 'manager', team_id: undefined }).catch(() => {});
    const start = e.clock.t;
    await e.ok('POST', '/api/timer/start', { token: e.tokens.yan, body: {} });
    e.advance(2 * MIN); await e.ping('yan');
    const lastSeen = e.clock.t;
    e.advance(5 * MIN);   // > 3 min of silence
    let team = await e.ok('GET', '/api/dashboard/team?day=2026-11-12', { token: e.tokens.owner });
    assert.equal(team.members.find((m) => m.name === 'Yan').state, 'no_signal');
    e.advance(30 * MIN);
    assert.equal(e.app.sweepStale(), 1);
    const day = await e.ok('GET', `/api/users/${(await e.ok('GET', '/api/users', { token: e.tokens.owner })).find((u) => u.name === 'Yan').id}/day?day=2026-11-12`, { token: e.tokens.owner });
    assert.equal(day.worked_secs, 120, 'only the time with a heartbeat counts');
    assert.equal(day.entries[0].stop_reason, 'lost');
    assert.equal(new Date(day.entries[0].ended_at).getTime(), lastSeen);
    assert.ok(start < lastSeen);
  } finally { await e.close(); }
});

test('ping reports the timer state so the desktop app can notice a session closed elsewhere', async () => {
  const { ok, set, tokens } = env;
  set(T0 + 30 * 24 * 3600000);
  assert.equal((await ok('POST', '/api/timer/ping', { token: tokens.alice })).active, false);
  await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  assert.equal((await ok('POST', '/api/timer/ping', { token: tokens.alice })).running, true);
  await ok('POST', '/api/timer/stop', { token: tokens.alice, body: {} });
});
