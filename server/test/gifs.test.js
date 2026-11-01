'use strict';
// GIFs in chat: off until the owner adds a GIPHY or Tenor key; results only ever point at those
// services' own picture hosts, and come through Workhelm so the page can show them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

const GIF = Buffer.from('474946383961010001000000002c00000000010001000002', 'hex');
let env, calls;
before(async () => {
  calls = [];
  env = await makeEnv({ app: { gifFetch: async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.giphy.com/')) return { data: [
      { id: 'abc', title: 'Lets go', images: { fixed_width_downsampled: { url: 'https://media1.giphy.com/media/abc/200w_d.gif', width: '200', height: '150' }, downsized: { url: 'https://media1.giphy.com/media/abc/giphy-downsized.gif' } } },
      { id: 'bad', title: 'Elsewhere', images: { fixed_width_downsampled: { url: 'https://evil.example/x.gif' }, downsized: { url: 'https://evil.example/y.gif' } } },
    ] };
    if (url.startsWith('https://tenor.googleapis.com/')) return { results: [{ id: '99', content_description: 'Party', media_formats: { tinygif: { url: 'https://media.tenor.com/a/tiny.gif', dims: [220, 124] }, mediumgif: { url: 'https://media.tenor.com/a/medium.gif' } } }] };
    if (url.startsWith('https://media1.giphy.com/') || url.startsWith('https://media.tenor.com/')) return { buf: GIF, type: 'image/gif' };
    throw new Error('unexpected ' + url);
  } } });
  await env.person('sara', 'Sara Khan');
});
after(() => env.close());

test('GIF search is off until the owner adds a key, and only the owner can', async () => {
  const { ok, api, tokens } = env;
  assert.deepEqual(await ok('GET', '/api/chat/gifs?q=go', { token: tokens.sara }), { enabled: false, items: [] });
  assert.equal(calls.length, 0);
  assert.equal((await api('PUT', '/api/chat/gifs/setup', { token: tokens.sara, body: { key: 'x'.repeat(32) } })).status, 403);
  assert.equal((await api('PUT', '/api/chat/gifs/setup', { token: tokens.owner, body: { key: 'no spaces allowed here at all' } })).status, 400);
  const s = await ok('PUT', '/api/chat/gifs/setup', { token: tokens.owner, body: { key: 'giphyKey1234567890abcdefXYZ0' } });
  assert.deepEqual(s, { provider: 'giphy', has_key: true, hint: '…XYZ0' });
  const g = await ok('GET', '/api/chat/gifs/setup', { token: tokens.owner });
  assert.equal(g.key, undefined, 'the key itself is never sent back');
});

test('results come through Workhelm, and only from GIPHY or Tenor picture hosts', async () => {
  const { ok, api, tokens } = env;
  const r = await ok('GET', '/api/chat/gifs?q=lets%20go', { token: tokens.sara });
  assert.equal(r.provider, 'giphy');
  assert.equal(r.items.length, 1, 'the one from another host is dropped');
  assert.match(calls.at(-1), /api\.giphy\.com\/v1\/gifs\/search\?.*q=lets%20go/);
  assert.match(r.items[0].preview, /^\/api\/chat\/gifs\/img\?u=https%3A%2F%2Fmedia1\.giphy\.com/);
  const img = await api('GET', r.items[0].preview, { token: tokens.sara });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/gif');
  assert.equal((await api('GET', '/api/chat/gifs/img?u=' + encodeURIComponent('https://evil.example/x.gif'), { token: tokens.sara })).status, 400);
  assert.equal((await api('GET', '/api/chat/gifs/img?u=' + encodeURIComponent('http://media1.giphy.com/x.gif'), { token: tokens.sara })).status, 400, 'https only');
  // nothing typed: what is popular
  await ok('GET', '/api/chat/gifs', { token: tokens.sara });
  assert.match(calls.at(-1), /\/v1\/gifs\/trending\?/);
});

test('a Tenor key searches Tenor', async () => {
  const { ok, tokens } = env;
  await ok('PUT', '/api/chat/gifs/setup', { token: tokens.owner, body: { key: 'AIzaSyTenorKey_1234567890abc' } });
  const r = await ok('GET', '/api/chat/gifs?q=party', { token: tokens.sara });
  assert.equal(r.provider, 'tenor');
  assert.equal(r.items[0].title, 'Party');
  assert.deepEqual([r.items[0].w, r.items[0].h], [220, 124]);
  await ok('PUT', '/api/chat/gifs/setup', { token: tokens.owner, body: { key: '' } });
  assert.equal((await ok('GET', '/api/chat/gifs', { token: tokens.sara })).enabled, false);
});
