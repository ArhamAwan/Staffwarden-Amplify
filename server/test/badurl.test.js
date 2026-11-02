'use strict';
// Broken addresses (bots trying "/%E0%A4%A") are answered "bad address", not counted as server errors.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

let env;
before(async () => { env = await makeEnv(); });
after(() => env.close());

test('a malformed address is a 400, and is not an error report', async () => {
  const { api, tokens } = env;
  assert.equal((await api('GET', '/%E0%A4%A')).status, 400);
  assert.equal((await api('GET', '/downloads/%E0%A4%A')).status, 404);
  assert.equal((await api('GET', '/api/users/%E0%A4%A', { token: tokens.owner })).status, 400);
  const errs = env.app.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'error_groups'").get().n
    ? env.app.db.prepare("SELECT COUNT(*) n FROM error_groups WHERE title LIKE '%URI malformed%'").get().n : 0;
  assert.equal(errs, 0);
});
