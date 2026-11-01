'use strict';
// Thumbnails come many to a request (one round trip for a page of screenshots), only for people the
// viewer may see; every answer says which version of the website the server has.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env;
before(async () => { env = await makeEnv(); await env.person('nia', 'Nia'); await env.person('ray', 'Ray'); });
after(() => env.close());

function parse(buf) {
  const n = buf.readUInt32BE(0);
  const index = JSON.parse(buf.subarray(4, 4 + n).toString());
  return index.map((it) => ({ ...it, bytes: buf.subarray(4 + n + it.offset, 4 + n + it.offset + it.length) }));
}

test('a batch of thumbnails in one answer, leaving out what the viewer may not see', async () => {
  const { ok, api, tokens, shot, advance, PNG } = env;
  await ok('POST', '/api/timer/start', { token: tokens.nia, body: {} });
  await ok('POST', '/api/timer/start', { token: tokens.ray, body: {} });
  const ids = [];
  for (const k of ['nia', 'nia', 'ray']) { advance(MIN); const r = await shot(k); assert.equal(r.status, 200, JSON.stringify(r.data)); ids.push(r.data.id); }
  const all = await api('GET', `/api/screenshots/thumbs?ids=${ids.join(',')},999`, { token: tokens.owner, raw: true });
  assert.equal(all.status, 200);
  const items = parse(all.data);
  assert.deepEqual(items.map((i) => i.id), ids, 'every one the owner may see, in order; the missing one is left out');
  assert.ok(items.every((i) => i.bytes.equals(PNG)));
  // Nia gets only her own
  assert.deepEqual(parse((await api('GET', `/api/screenshots/thumbs?ids=${ids.join(',')}`, { token: tokens.nia, raw: true })).data).map((i) => i.id), ids.slice(0, 2));
  assert.equal((await api('GET', '/api/screenshots/thumbs?ids=', { token: tokens.nia })).status, 400);
  assert.equal((await api('GET', `/api/screenshots/thumbs?ids=${ids[0]}`)).status, 401);
});

test('every answer carries the website version', async () => {
  const r = await env.api('GET', '/api/settings', { token: env.tokens.nia });
  assert.match(r.headers.get('x-workhelm-build') || '', /^[0-9a-f]{12}$/);
});
