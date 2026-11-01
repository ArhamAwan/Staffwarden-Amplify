'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFetch } = require('../src/connect');

test('if the browser-style connection fails, the direct one is used, and from then on first', async () => {
  const calls = [], logs = [];
  const fail = (name, code) => async (u) => { calls.push(name); throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };
  const ok = (name) => async (u) => { calls.push(name); return { ok: true, name }; };
  const f = makeFetch({ browserFetch: fail('browser', 'net::ERR_FAILED'), directFetch: ok('direct'), log: (m) => logs.push(m) });
  assert.equal((await f('https://x/api/me')).name, 'direct');
  assert.equal(f.mode(), 'direct');
  assert.equal((await f('https://x/api/me')).name, 'direct');
  assert.deepEqual(calls, ['browser', 'direct', 'direct'], 'the failing way is not retried on every request');
  assert.match(logs[0], /browser-style connection failed \(net::ERR_FAILED\)/);
});

test('when both fail, the message has both reasons; a timeout is not retried', async () => {
  const f = makeFetch({
    browserFetch: async () => { throw new Error('net::ERR_FAILED'); },
    directFetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }); },
  });
  await assert.rejects(f('https://x/'), /net::ERR_FAILED; UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  let direct = 0;
  const g = makeFetch({ browserFetch: async () => { throw new Error('aborted'); }, directFetch: async () => { direct++; return {}; } });
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(g('https://x/', { signal: ctl.signal }));
  assert.equal(direct, 0);
});
