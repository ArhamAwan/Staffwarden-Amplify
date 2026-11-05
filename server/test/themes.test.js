'use strict';
// Colour themes: each person picks their own; the owner picks everyone's default; clients have none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

test('each person picks their own theme; the owner sets the default; nonsense is refused', async () => {
  const env = await makeEnv();
  try {
    await env.person('sara', 'Sara Khan');
    await env.person('ali', 'Ali Subhan');
    const me = (k) => env.ok('GET', '/api/me', { token: env.tokens[k] });
    assert.equal((await me('sara')).theme, 'night');
    const r = await env.ok('PUT', '/api/me/theme', { token: env.tokens.sara, body: { theme: 'sapphire' } });
    assert.equal(r.theme, 'sapphire');
    assert.equal((await me('sara')).theme, 'sapphire');
    assert.equal((await me('ali')).theme, 'night', 'only for her');
    assert.equal((await env.api('PUT', '/api/me/theme', { token: env.tokens.sara, body: { theme: 'neon' } })).status, 400);
    assert.equal((await env.api('PUT', '/api/theme-default', { token: env.tokens.sara, body: { theme: 'gold' } })).status, 403);
    await env.ok('PUT', '/api/theme-default', { token: env.tokens.owner, body: { theme: 'gold' } });
    assert.equal((await me('ali')).theme, 'gold', 'people who never picked follow the default');
    assert.equal((await me('sara')).theme, 'sapphire', 'a person’s own pick stays');
    await env.ok('PUT', '/api/me/theme', { token: env.tokens.sara, body: { theme: null } });
    const s = await me('sara');
    assert.equal(s.theme, 'gold'); assert.equal(s.theme_own, null); assert.equal(s.theme_default, 'gold');
  } finally { await env.close(); }
});
