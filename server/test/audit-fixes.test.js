'use strict';
// Regression tests for the security audit (run 1): each test pins one fixed hole shut.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { makeEnv } = require('./helpers');
const { cleanHtml, textOf } = require('../routes/notes');
const png = require('../lib/png');
const { pushAddressOk } = require('../lib/webpush');
const csv = require('../lib/csv');
const { signedBy, releaseMessage } = require('../../desktop/src/updater');

// ---- pure functions

test('note cleaning stays linear on hostile input (no regex backtracking)', () => {
  const hostile = [
    '<!--' + '-'.repeat(100000),
    '<a ' + 'x="'.repeat(30000),
    '<' + 'a'.repeat(100000),
    '<p ' + ' style=x'.repeat(12000) + '>',
    '&#'.repeat(50000),
  ];
  for (const h of hostile) {
    const t = process.hrtime.bigint();
    cleanHtml(h); textOf(h);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 500, `took ${ms} ms`);
  }
  // still does its job
  assert.doesNotMatch(cleanHtml('<p onclick="x()">hi<script>alert(1)</script></p>'), /onclick|script/i);
  assert.doesNotThrow(() => textOf('<p>&#x1F600;&#99999999;&#xFFFFFFFFF;</p>'), 'an out-of-range character code is skipped, not a crash');
});

test('a PNG that unpacks to more than its size says is refused (decompression bomb)', () => {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  // a 1x1 grey image whose pixel data inflates to 50 MB
  const bomb = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => png.decode(bomb), /Unsupported PNG/);
  // a huge declared size is refused before inflating anything
  ihdr.writeUInt32BE(100000, 0); ihdr.writeUInt32BE(100000, 4);
  const huge = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(10))), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => png.decode(huge), /Unsupported PNG/);
});

test('push subscriptions only go to the real push services', () => {
  assert.ok(pushAddressOk('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(pushAddressOk('https://updates.push.services.mozilla.com/wpush/v2/abc'));
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.test/x', 'https://evil.test/fcm.googleapis.com', 'not a url', '']) {
    assert.equal(pushAddressOk(bad), false, bad);
  }
});

test('CSV cells that a spreadsheet would run as a formula are made plain text', () => {
  for (const v of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) assert.ok(csv.cell(v).startsWith('"\''), csv.cell(v));
  assert.equal(csv.cell('Ana'), 'Ana');
  assert.equal(csv.cell(42), '42');
  assert.equal(csv.cell('a,b'), '"a,b"');
});

test('the desktop app only installs updates signed with the release key, for that exact file', () => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const file = 'Staffwarden-1.0.0-mac-AppleSilicon.zip', sha = 'a'.repeat(64);
  const sig = crypto.sign(null, releaseMessage(file, sha), k.privateKey).toString('base64');
  assert.equal(signedBy(pub, file, sha, sig), true);
  assert.equal(signedBy(pub, 'Staffwarden-9.0.0-mac-AppleSilicon.zip', sha, sig), false, 'another file name');
  assert.equal(signedBy(pub, file, 'b'.repeat(64), sig), false, 'other bytes');
  assert.equal(signedBy(pub, file, sha, ''), false, 'unsigned');
  const other = crypto.generateKeyPairSync('ed25519');
  assert.equal(signedBy(pub, file, sha, crypto.sign(null, releaseMessage(file, sha), other.privateKey).toString('base64')), false, 'another key');
});

// ---- over HTTP

let env, dev, ana, mgr;
before(async () => {
  env = await makeEnv();
  dev = await env.person('dev', 'Dev Person');
  ana = await env.person('ana', 'Ana');
  mgr = await env.person('mgr', 'Maya', { role: 'manager' });
  await env.ok('PATCH', `/api/users/${dev.id}`, { token: env.tokens.owner, body: { is_dev: true } });
});
after(() => env.close());

test('a developer is not the owner: no time added to their own day, no approving their own time off', async () => {
  const { api, ok, tokens } = env;
  const r = await api('POST', '/api/time/manual', { token: tokens.dev, body: { user_id: dev.id, start: '2026-10-22T04:00:00Z', end: '2026-10-22T06:00:00Z', note: 'forgot the timer' } });
  assert.equal(r.status, 403);
  // the real owner still can
  await ok('POST', '/api/time/manual', { token: tokens.owner, body: { user_id: ana.id, start: '2026-10-22T04:00:00Z', end: '2026-10-22T06:00:00Z', note: 'forgot the timer' } });
  const req = await ok('POST', '/api/timeoff', { token: tokens.dev, body: { user_id: dev.id, start_day: '2026-10-28', end_day: '2026-10-28', note: 'family visit' } });
  const id = (req.request || req).id;
  assert.notEqual((req.request || req).status, 'approved', 'a developer\'s own time off is not auto-approved');
  assert.equal((await api('POST', `/api/timeoff/${id}/decision`, { token: tokens.dev, body: { approve: true } })).status, 403);
});

test('a developer can’t reset the password of, or switch off, an HR account', async () => {
  const { api, ok, tokens } = env;
  const hr = await env.person('hrp', 'Hana HR');
  assert.equal((await api('PATCH', `/api/users/${dev.id}`, { token: tokens.dev, body: { hr: true } })).status, 403, 'nor make themselves HR');
  await ok('PATCH', `/api/users/${hr.id}`, { token: tokens.owner, body: { hr: true } });
  assert.equal((await api('PATCH', `/api/users/${hr.id}`, { token: tokens.dev, body: { password: 'taken-over-1' } })).status, 403);
  assert.equal((await api('PATCH', `/api/users/${hr.id}`, { token: tokens.dev, body: { active: false } })).status, 403);
  await ok('GET', '/api/me', { token: tokens.hrp });
});

test('muting a private group is no way into it', async () => {
  const { api, ok, tokens } = env;
  const g = await ok('POST', '/api/team/channels', { token: tokens.mgr, body: { kind: 'group', name: 'Leads only', members: [] } });
  assert.equal((await api('PUT', `/api/team/threads/${g.id}/mute`, { token: tokens.ana, body: { mode: 'none' } })).status, 404);
  assert.equal((await api('GET', `/api/chat/threads/${g.id}/messages`, { token: tokens.ana })).status, 404);
  assert.ok(!env.app.db.prepare('SELECT 1 FROM team_members WHERE thread_id = ? AND user_id = ?').get(g.id, ana.id));
});

test('switching someone off signs out every device at once', async () => {
  const { api, ok, tokens, login } = env;
  const second = await login('ana@test.com', 'ana-pass-123');
  await ok('PATCH', `/api/users/${ana.id}`, { token: tokens.owner, body: { active: false } });
  assert.equal((await api('GET', '/api/me', { token: tokens.ana })).status, 401);
  assert.equal((await api('GET', '/api/me', { token: second })).status, 401);
  await ok('PATCH', `/api/users/${ana.id}`, { token: tokens.owner, body: { active: true } });
  tokens.ana = await login('ana@test.com', 'ana-pass-123');
});

test('the company export leaves out mail passwords and other secrets', async () => {
  const { ok, tokens } = env;
  env.app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('report_mail', ?)").run(JSON.stringify({ host: 'mail.example.com', user: 'r@example.com', pass: 'super-secret-pass' }));
  await ok('POST', '/api/account/export', { token: tokens.owner });
  let st;
  for (let i = 0; i < 100; i++) { st = await ok('GET', '/api/account/export', { token: tokens.owner }); if (!st.building) break; await new Promise((r) => setTimeout(r, 20)); }
  const file = await env.api('GET', '/api/account/export/file', { token: tokens.owner, raw: true });
  assert.equal(file.status, 200);
  const bytes = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data));
  // the zip may be compressed: look in every stored member
  const found = [];
  for (let o = 0; (o = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), o)) >= 0; o += 4) {
    const method = bytes.readUInt16LE(o + 8), size = bytes.readUInt32LE(o + 18), nl = bytes.readUInt16LE(o + 26), xl = bytes.readUInt16LE(o + 28);
    const data = bytes.subarray(o + 30 + nl + xl, o + 30 + nl + xl + size);
    try { found.push(method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8')); } catch { /* not a member we can read */ }
  }
  assert.ok(found.length, 'the export has files');
  assert.ok(!found.some((t) => t.includes('super-secret-pass')), 'the mail password is not in the export');
});
