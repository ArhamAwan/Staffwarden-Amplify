'use strict';
// The leaderboard ranks by hours (activity alongside) by default; the owner and developers change what it
// ranks by, what it shows and who sees it, and people are told when it shows more about them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env, a, b, c, mgr, dev, proj;
before(async () => {
  env = await makeEnv();
  a = await env.person('a', 'Ayesha'); b = await env.person('b', 'Bilal'); c = await env.person('c', 'Chand');
  mgr = await env.person('mgr', 'Maya', { role: 'manager' }); dev = await env.person('dev', 'Devo');
  await env.ok('PATCH', `/api/users/${dev.id}`, { token: env.tokens.owner, body: { is_dev: true, tracks_time: false } });
  proj = await env.ok('POST', '/api/projects', { token: env.tokens.owner, body: { name: 'P', access: 'everyone' } });
  // Ayesha works 3 hours, Bilal 1 hour, Chand nothing
  for (const [k, mins] of [['a', 180], ['b', 60]]) {
    await env.ok('POST', '/api/timer/start', { token: env.tokens[k], body: { project_id: proj.id } });
    for (let m = 0; m < mins; m += 10) { await env.activity(k, env.clock.t, 600, k === 'a' ? 480 : 300); env.advance(10 * MIN); }
    await env.ok('POST', '/api/timer/stop', { token: env.tokens[k], body: {} });
  }
});
after(() => env.close());

test('everyone sees the board ranked by hours, with activity alongside', async () => {
  const r = await env.ok('GET', '/api/leaderboard', { token: env.tokens.b });
  assert.equal(r.settings.rank_by, 'hours');
  assert.deepEqual(r.settings.columns, ['hours', 'activity']);
  assert.equal(r.rows[0].name, 'Ayesha'); assert.equal(r.rows[0].place, 1);
  assert.ok(r.rows[0].hours_secs >= 170 * 60);
  assert.equal(r.rows[1].name, 'Bilal');
  assert.ok(!r.rows.some((x) => x.name === 'Devo'), 'an account that isn’t tracked isn’t on it');
  assert.equal(r.can_change, false);
  assert.equal((await env.ok('GET', '/api/me', { token: env.tokens.b })).leaderboard, true);
});

test('only the owner and developers change it; people are told when it shows more', async () => {
  assert.equal((await env.api('PUT', '/api/leaderboard/settings', { token: env.tokens.mgr, body: { rank_by: 'activity' } })).status, 403);
  assert.equal((await env.ok('GET', '/api/leaderboard', { token: env.tokens.dev })).can_change, true);
  await env.ok('PUT', '/api/leaderboard/settings', { token: env.tokens.dev, body: { audience: 'managers' } });
  assert.equal((await env.api('GET', '/api/leaderboard', { token: env.tokens.b })).status, 403);
  assert.equal((await env.ok('GET', '/api/me', { token: env.tokens.b })).leaderboard, false);
  await env.ok('GET', '/api/leaderboard', { token: env.tokens.mgr });
  await env.ok('PUT', '/api/leaderboard/settings', { token: env.tokens.owner, body: { audience: 'everyone', columns: ['hours', 'activity', 'tasks'] } });
  const n = (await env.ok('GET', '/api/notifications', { token: env.tokens.b })).items;
  assert.ok(n.some((x) => x.title === 'The leaderboard shows more now'));
  // ranking by activity leaves out people with under two hours
  const s = await env.ok('PUT', '/api/leaderboard/settings', { token: env.tokens.owner, body: { rank_by: 'points', columns: ['hours'] } });
  assert.deepEqual(s.columns, ['hours', 'points'], 'what it ranks by is always shown');
  await env.ok('PUT', '/api/leaderboard/settings', { token: env.tokens.owner, body: { rank_by: 'activity', columns: ['hours', 'activity'] } });
  const r = await env.ok('GET', '/api/leaderboard?period=month', { token: env.tokens.a });
  assert.equal(r.rows.find((x) => x.name === 'Ayesha').place, 1);
  assert.equal(r.rows.find((x) => x.name === 'Bilal').place, null);
  assert.ok(env.app.db.prepare("SELECT 1 FROM audit WHERE action = 'leaderboard.settings'").get());
});
