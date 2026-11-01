'use strict';
// Sign-in security before going live: hashed sessions, fair limits on guessing, password rules,
// signing out everywhere, idle expiry, HTTPS-only headers and a record of sign-ins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

let env;
before(async () => { env = await makeEnv(); await env.person('sara', 'Sara'); await env.person('bo', 'Bo'); });
after(() => env.close());

async function login(email, password, ip, extra = {}) {
  const r = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}), ...extra }, body: JSON.stringify({ email, password }) });
  return { status: r.status, data: await r.json(), headers: r.headers };
}

test('sessions are stored only as hashes: a copied database cannot be used to sign in', async () => {
  const r = await login('sara@test.com', 'sara-pass-123');
  assert.equal(r.status, 200);
  const rows = env.app.db.prepare("SELECT token FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'sara@test.com')").all();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => x.token.startsWith('h:') && x.token !== r.data.token && !x.token.includes(r.data.token)));
  const stolen = rows[0].token;
  assert.equal((await env.api('GET', '/api/me', { token: stolen })).status, 401, 'the stored value does not work as a token');
  assert.equal((await env.api('GET', '/api/me', { token: r.data.token })).status, 200);
});

test('guessing is limited per address, and someone else guessing cannot lock a person out', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login('bo@test.com', 'wrong-guess-' + i, '203.0.113.9')).status, 401);
  assert.equal((await login('bo@test.com', 'bo-pass-123', '203.0.113.9')).status, 429, 'the guessing address is blocked, even with the right password');
  assert.equal((await login('bo@test.com', 'bo-pass-123', '198.51.100.4')).status, 200, 'Bo, from his own address, still gets in');
  // one address trying many accounts is limited too
  for (let i = 0; i < 30; i++) await login(`nobody${i}@test.com`, 'whatever-pass', '203.0.113.50');
  assert.equal((await login('sara@test.com', 'sara-pass-123', '203.0.113.50')).status, 429);
  // the forwarded address is only believed from the machine itself (Caddy); here the test talks over loopback
  const failed = env.app.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'login.failed' AND detail LIKE '%203.0.113.9%'").get().n;
  assert.equal(failed, 10, 'every failed sign-in is in the audit log with its address');
  assert.ok(env.app.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'login' AND detail LIKE '%198.51.100.4%'").get().n >= 1);
});

test('unknown emails and wrong passwords get the same answer', async () => {
  const a = await login('ghost@test.com', 'some-password-1', '192.0.2.1');
  const b = await login('sara@test.com', 'some-password-1', '192.0.2.1');
  assert.deepEqual([a.status, a.data], [b.status, b.data]);
});

test('password rules for new passwords: 10+ characters and not a common one', async () => {
  const { api, tokens } = env;
  const mk = (password) => api('POST', '/api/users', { token: tokens.owner, body: { email: `p${Math.random().toString(36).slice(2, 7)}@test.com`, name: 'P', password } });
  assert.equal((await mk('short-1')).status, 400);
  const common = await mk('password123');
  assert.equal(common.status, 400);
  assert.match(common.data.error, /too common/);
  assert.equal((await mk('aaaaaaaaaaaa')).status, 400);
  assert.equal((await mk('lantern-river-42')).status, 200);
  assert.equal((await api('POST', '/api/me/password', { token: tokens.sara, body: { current_password: 'sara-pass-123', new_password: 'qwerty123' } })).status, 400);
  assert.equal((await api('POST', '/api/me/password', { token: tokens.sara, body: { current_password: 'sara-pass-123', new_password: 'sara-pass-123' } })).status, 400, 'must actually change');
});

test('sign out everywhere, and see where you are signed in', async () => {
  const { ok, api } = env;
  const a = (await login('sara@test.com', 'sara-pass-123')).data.token;
  const b = (await login('sara@test.com', 'sara-pass-123')).data.token;
  const list = await ok('GET', '/api/me/sessions', { token: a });
  assert.ok(list.length >= 3 && list.filter((s) => s.this_device).length === 1);
  assert.ok(!JSON.stringify(list).includes('h:'), 'tokens are never shown');
  const r = await ok('POST', '/api/auth/logout-all', { token: a, body: { keep_this: true } });
  assert.ok(r.ended >= 2);
  assert.equal((await api('GET', '/api/me', { token: b })).status, 401);
  assert.equal((await api('GET', '/api/me', { token: a })).status, 200, 'this device stays signed in');
  await ok('POST', '/api/auth/logout-all', { token: a, body: {} });
  assert.equal((await api('GET', '/api/me', { token: a })).status, 401);
  env.tokens.sara = (await login('sara@test.com', 'sara-pass-123')).data.token;
});

test('a session not used for 14 days ends', async () => {
  const t = (await login('bo@test.com', 'bo-pass-123')).data.token;
  assert.equal((await env.api('GET', '/api/me', { token: t })).status, 200);
  env.app.db.prepare("UPDATE sessions SET last_used_at = datetime('now', '-15 days') WHERE user_id = (SELECT id FROM users WHERE email = 'bo@test.com')").run();
  assert.equal((await env.api('GET', '/api/me', { token: t })).status, 401);
});

test('HTTPS-only header (HSTS) is sent when the site is reached over HTTPS through Caddy, never over plain HTTP', async () => {
  const plain = await fetch(env.base + '/');
  assert.equal(plain.headers.get('strict-transport-security'), null);
  const viaCaddy = await fetch(env.base + '/', { headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' } });
  assert.equal(viaCaddy.headers.get('strict-transport-security'), 'max-age=31536000');
  const api = await fetch(env.base + '/api/me', { headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' } });
  assert.equal(api.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('through the Cloudflare Worker, the real address is used only when the secret matches', async () => {
  const { makeEnv } = require('./helpers');
  const e = await makeEnv({ app: { proxySecret: 'a-long-proxy-secret-for-tests-123' } });
  try {
    const login = (headers) => fetch(e.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ email: 'owner@test.com', password: 'wrong-password-x' }) });
    await login({ 'X-Workhelm-Proxy': 'a-long-proxy-secret-for-tests-123', 'X-Workhelm-Client-IP': '203.0.113.77', 'X-Forwarded-For': '10.0.0.1' });
    await login({ 'X-Workhelm-Proxy': 'wrong-secret-wrong-secret-wrong', 'X-Workhelm-Client-IP': '198.51.100.99', 'X-Forwarded-For': '10.0.0.2' });
    const rows = e.app.db.prepare("SELECT detail FROM audit WHERE action = 'login.failed'").all().map((r) => r.detail).join(' ');
    assert.match(rows, /203\.0\.113\.77/, 'the person behind Cloudflare is recorded');
    assert.ok(!rows.includes('198.51.100.99'), 'a made-up address without the secret is ignored');
    assert.match(rows, /10\.0\.0\.2/);
  } finally { e.close(); }
});
