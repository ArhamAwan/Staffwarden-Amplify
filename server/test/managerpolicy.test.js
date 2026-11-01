'use strict';
// Only the owner decides how people are monitored: screenshots, whether someone tracks time, the
// other-device mode, and deleting someone else's screenshots. Managers keep the rest of their tools.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

let env, mgr, emp;
before(async () => {
  env = await makeEnv();
  mgr = await env.person('mona', 'Mona Manager', { role: 'manager' });
  emp = await env.person('eli', 'Eli Employee');
});
after(() => env.close());

test('a manager cannot delete someone else\'s screenshot; the owner can', async () => {
  const { api, ok, tokens } = env;
  await ok('POST', '/api/me/consent', { token: tokens.eli }).catch(() => {});
  await ok('POST', '/api/timer/start', { token: tokens.eli, body: {} });
  const r = await env.shot('eli');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.id;
  assert.equal((await api('DELETE', `/api/screenshots/${id}`, { token: tokens.mona })).status, 403);
  await ok('DELETE', `/api/screenshots/${id}`, { token: tokens.owner });
});

test('a manager cannot change screenshots or tracking; the owner can', async () => {
  const { api, ok, tokens } = env;
  assert.equal((await api('PATCH', `/api/users/${emp.id}`, { token: tokens.mona, body: { shots_per_10: 0 } })).status, 403);
  assert.equal((await api('PATCH', `/api/users/${emp.id}`, { token: tokens.mona, body: { other_device: true } })).status, 403);
  assert.equal((await api('PATCH', `/api/users/${mgr.id}`, { token: tokens.mona, body: { tracks_time: !mgr.tracks_time } })).status, 403);
  // the same values sent back with other edits are fine
  const cur = (await ok('GET', '/api/users', { token: tokens.mona })).find((u) => u.id === emp.id);
  await ok('PATCH', `/api/users/${emp.id}`, { token: tokens.mona, body: { title: 'Agent', shots_per_10: cur.shots_per_10, other_device: cur.other_device } });
  await ok('PATCH', `/api/users/${emp.id}`, { token: tokens.owner, body: { shots_per_10: 0 } });

  assert.equal((await api('PUT', '/api/settings', { token: tokens.mona, body: { shots_per_10: 0 } })).status, 403);
});

