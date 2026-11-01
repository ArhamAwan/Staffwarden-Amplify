'use strict';
// Staff use their own computers: what the company can choose about screenshots, and the record of who
// looked at a person's screenshots, which that person can see.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env;
before(async () => { env = await makeEnv(); await env.person('nia', 'Nia'); await env.person('ray', 'Ray'); await env.person('mo', 'Mo', { role: 'manager' }); });
after(() => env.close());

test('by default only the screen in use is captured and nothing is blurred; the owner can change both', async () => {
  const { ok, api, tokens } = env;
  const s = await ok('GET', '/api/settings', { token: tokens.nia });
  assert.deepEqual([s.capture_screens, s.blur_shots], ['active', false]);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { capture_screens: 'all', blur_shots: true } });
  const s2 = await ok('GET', '/api/settings', { token: tokens.nia });
  assert.deepEqual([s2.capture_screens, s2.blur_shots], ['all', true]);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.owner, body: { capture_screens: 'every' } })).status, 400);
  assert.equal((await api('PUT', '/api/settings', { token: tokens.mo, body: { blur_shots: false } })).status, 403);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { capture_screens: 'active', blur_shots: false } });
});

test('people see who opened their screenshots; nobody else can, and looking at your own is not recorded', async () => {
  const { ok, api, tokens, advance } = env;
  await ok('POST', '/api/timer/start', { token: tokens.nia, body: {} });
  advance(2 * MIN);
  const r = await env.shot('nia');
  assert.equal(r.status, 200);
  const day = '2026-10-23';
  let [mine] = await ok('GET', `/api/screenshots?day=${day}`, { token: tokens.nia });
  assert.equal(mine.viewers, 0);
  const id = mine.id;
  assert.equal((await fetch(`${env.base}/api/screenshots/${id}/image`, { headers: { Authorization: 'Bearer ' + tokens.nia } })).status, 200);
  assert.deepEqual(await ok('GET', `/api/screenshots/${id}/views`, { token: tokens.nia }), [], 'her own look is not counted');
  for (let i = 0; i < 2; i++) await fetch(`${env.base}/api/screenshots/${id}/image`, { headers: { Authorization: 'Bearer ' + tokens.mo } });
  await fetch(`${env.base}/api/screenshots/${id}/thumb`, { headers: { Authorization: 'Bearer ' + tokens.owner } });   // the small preview is not "opening" it
  const views = await ok('GET', `/api/screenshots/${id}/views`, { token: tokens.nia });
  assert.deepEqual(views.map((v) => [v.name, v.times]), [['Mo', 2]]);
  [mine] = await ok('GET', `/api/screenshots?day=${day}`, { token: tokens.nia });
  assert.equal(mine.viewers, 1);
  assert.equal((await api('GET', `/api/screenshots/${id}/views`, { token: tokens.mo })).status, 403, 'the manager cannot see the viewing record');
  const forMo = await ok('GET', `/api/screenshots?day=${day}&user_id=all`, { token: tokens.mo });
  assert.ok(forMo.every((x) => !('viewers' in x)), 'others never see the counts');
  assert.equal((await api('GET', `/api/screenshots/${id}/views`, { token: tokens.ray })).status, 403);
});

test('a person can be set as working on another device; they and the desktop app see it, and only managers can set it', async () => {
  const { ok, api, tokens } = env;
  const nia = (await ok('GET', '/api/me', { token: tokens.nia }));
  assert.equal(nia.other_device, false);
  assert.equal((await api('PATCH', `/api/users/${nia.id}`, { token: tokens.ray, body: { other_device: true } })).status, 403);
  await ok('PATCH', `/api/users/${nia.id}`, { token: tokens.owner, body: { other_device: true } });
  assert.equal((await ok('GET', '/api/me', { token: tokens.nia })).other_device, true);
  assert.equal((await ok('GET', `/api/users/${nia.id}`, { token: tokens.owner })).other_device, true);
  await ok('PATCH', `/api/users/${nia.id}`, { token: tokens.owner, body: { other_device: false } });
  assert.equal((await ok('GET', '/api/me', { token: tokens.nia })).other_device, false);
});
