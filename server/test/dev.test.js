'use strict';
// Developer access: only the owner grants it; it gives the owner's view and powers plus the developer tools
// (health, notice, apps and releases, errors, features, test tools), but never the owner's own account or
// the power to give the access to others. Everyone is told.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeEnv } = require('./helpers');

let env, dev, ana, mgr, backupDir;
before(async () => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-bk-'));
  fs.writeFileSync(path.join(backupDir, 'tracker-2026-10-22.db'), 'x'.repeat(100));
  fs.writeFileSync(path.join(backupDir, 'tracker-2026-10-23.db'), 'x'.repeat(120));
  env = await makeEnv({ app: { backupDir, offsiteLog: path.join(backupDir, 'offsite.log') } });
  dev = await env.person('dev', 'Arham Dev');
  ana = await env.person('ana', 'Ana');
  mgr = await env.person('mgr', 'Maya', { role: 'manager' });
});
after(() => { env.close(); fs.rmSync(backupDir, { recursive: true, force: true }); });

test('only the owner grants developer access; it is audited, the person is told, and everyone can see who has it', async () => {
  const { api, ok, tokens } = env;
  assert.equal((await api('GET', '/api/dev/health', { token: tokens.dev })).status, 403);
  assert.equal((await api('PATCH', `/api/users/${dev.id}`, { token: tokens.mgr, body: { is_dev: true } })).status, 403);
  const u = await ok('PATCH', `/api/users/${dev.id}`, { token: tokens.owner, body: { is_dev: true } });
  assert.equal(u.is_dev, true);
  assert.equal((await ok('GET', '/api/me', { token: tokens.dev })).is_dev, true);
  assert.equal((await ok('GET', '/api/me', { token: tokens.ana })).is_dev, false);
  assert.ok(env.app.db.prepare("SELECT 1 FROM audit WHERE action = 'user.dev_granted' AND target_user_id = ?").get(dev.id));
  const n = (await ok('GET', '/api/notifications', { token: tokens.dev })).items;
  assert.ok(n.some((x) => x.title === 'You have developer access' && /screenshots/.test(x.body)));
  // everyone else is told too
  assert.ok((await ok('GET', '/api/notifications', { token: tokens.ana })).items.some((x) => x.title === 'Arham Dev now has developer access'));
  const list = await ok('GET', '/api/developers', { token: tokens.ana });
  assert.deepEqual(list.map((x) => x.name), ['Arham Dev']);
});

test('a developer sees and does what the owner does, except change the owner or hand out the access', async () => {
  const { api, ok, tokens } = env;
  const me = await ok('GET', '/api/me', { token: tokens.dev });
  assert.equal(me.role, 'owner'); assert.equal(me.dev_owner, true);
  assert.ok((await ok('GET', '/api/users', { token: tokens.dev })).length >= 4);
  assert.equal((await api('GET', `/api/users/${ana.id}/screenshots`, { token: tokens.dev })).status === 403, false);
  await ok('PATCH', `/api/users/${ana.id}`, { token: tokens.dev, body: { title: 'Agent' } });
  // not the owner's own account, and not giving the access to others
  const owner = (await ok('GET', '/api/users', { token: tokens.dev })).find((u) => u.role === 'owner');
  assert.equal((await api('PATCH', `/api/users/${owner.id}`, { token: tokens.dev, body: { name: 'X' } })).status, 403);
  assert.equal((await api('PATCH', `/api/users/${owner.id}`, { token: tokens.dev, body: { password: 'new-pass-12345' } })).status, 403);
  assert.equal((await api('PATCH', `/api/users/${ana.id}`, { token: tokens.dev, body: { is_dev: true } })).status, 403);
  // other people's direct messages stay private, as they are from the owner
  const dm = await ok('POST', '/api/team/dm', { token: tokens.ana, body: { user_id: mgr.id } });
  await ok('POST', `/api/chat/threads/${dm.id}/messages`, { token: tokens.ana, body: { body: 'private' } });
  assert.equal((await api('GET', `/api/chat/threads/${dm.id}/messages`, { token: tokens.dev })).status, 404);
  // in the database they are still who they were
  assert.equal(env.app.db.prepare('SELECT role FROM users WHERE id = ?').get(dev.id).role, 'employee');
});

test('health shows the server, the database and the backups', async () => {
  const h = await env.ok('GET', '/api/dev/health', { token: env.tokens.dev });
  assert.equal(h.schema, 26);
  assert.ok(h.uptime_s >= 0 && h.memory.total > 0 && h.build);
  assert.equal(h.backups.count, 2);
  assert.equal(h.backups.files[0].file, 'tracker-2026-10-23.db');
  assert.equal(h.backups.offsite, null);
  // the owner gets the developer pages only if he switches them on for himself
  assert.equal((await env.api('GET', '/api/dev/health', { token: env.tokens.owner })).status, 403);
  const me = await env.ok('GET', '/api/me', { token: env.tokens.owner });
  assert.equal(me.is_dev, false);
  await env.ok('PATCH', `/api/users/${me.id}`, { token: env.tokens.owner, body: { is_dev: true } });
  await env.ok('GET', '/api/dev/health', { token: env.tokens.owner });
  await env.ok('PATCH', `/api/users/${me.id}`, { token: env.tokens.owner, body: { is_dev: false } });
  assert.equal((await env.api('GET', '/api/dev/health', { token: env.tokens.owner })).status, 403);
});

test('a notice shows at the top for everyone during its window, and can be cleared', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('PUT', '/api/dev/banner', { token: tokens.ana, body: { text: 'x' } })).status, 403);
  const now = env.clock.t;
  await ok('PUT', '/api/dev/banner', { token: tokens.dev, body: { text: 'Update at 11 PM tonight: about 2 minutes', from: new Date(now + 3600e3).toISOString(), until: new Date(now + 7200e3).toISOString() } });
  assert.equal((await ok('GET', '/api/banner', { token: tokens.ana })).banner, null, 'not yet');
  env.clock.t = now + 3700e3;
  assert.match((await ok('GET', '/api/banner', { token: tokens.ana })).banner.text, /11 PM/);
  env.clock.t = now + 7300e3;
  assert.equal((await ok('GET', '/api/banner', { token: tokens.ana })).banner, null, 'over');
  env.clock.t = now;
  await ok('PUT', '/api/dev/banner', { token: tokens.dev, body: { text: 'Now' } });
  assert.equal((await ok('GET', '/api/banner', { token: tokens.ana })).banner.text, 'Now');
  await ok('PUT', '/api/dev/banner', { token: tokens.dev, body: { text: '' } });
  assert.equal((await ok('GET', '/api/banner', { token: tokens.ana })).banner, null);
});

test('errors are grouped, counted per person, scrubbed, and a fixed one comes back if it happens again', async () => {
  const { ok, tokens } = env;
  for (let i = 0; i < 3; i++) await ok('POST', '/api/errors', { token: tokens.ana, body: { message: `Cannot read properties of undefined (reading 'id') ${i}`, stack: `TypeError\n    at render (https://x/js/chat.js?v=${i}:12:${i})` } });
  await ok('POST', '/api/errors', { token: tokens.mgr, body: { message: 'Cannot read properties of undefined (reading \'id\') 9', stack: 'TypeError\n    at render (https://x/js/chat.js:99:1)' } });
  await ok('POST', '/api/errors', { token: tokens.ana, body: { message: 'Login failed for ana@test.com token=abc123', stack: '' } });
  const e = await ok('GET', '/api/dev/errors', { token: tokens.dev });
  const g = e.groups.find((x) => /reading/.test(x.title));
  assert.equal(g.count, 4); assert.equal(g.people_count, 2);
  const leak = e.groups.find((x) => /Login failed/.test(x.title));
  assert.ok(!/ana@test\.com|abc123/.test(leak.title), leak.title);
  await ok('PATCH', `/api/dev/errors/${g.sig}`, { token: tokens.dev, body: { status: 'fixed', fixed_in: '0.9.22' } });
  assert.equal((await ok('GET', '/api/dev/errors?status=fixed', { token: tokens.dev })).groups.length, 1);
  await ok('POST', '/api/errors', { token: tokens.ana, body: { message: "Cannot read properties of undefined (reading 'id') 5", stack: 'TypeError\n    at render (https://x/js/chat.js:1:1)' } });
  assert.equal((await ok('GET', '/api/dev/errors?status=fixed', { token: tokens.dev })).groups.length, 0, 'came back: open again');
  // one browser in a loop can't flood it
  for (let i = 0; i < 40; i++) await ok('POST', '/api/errors', { token: tokens.mgr, body: { message: 'loop', stack: '' } });
  const loop = (await ok('GET', '/api/dev/errors', { token: tokens.dev })).groups.find((x) => x.title === 'loop');
  assert.ok(loop.count <= 30);
});

test('feature switches: off for everyone, or a beta group first', async () => {
  const { ok, tokens } = env;
  await ok('PUT', '/api/dev/features/voice_notes', { token: tokens.dev, body: { mode: 'beta', beta: [ana.id] } });
  assert.ok((await ok('GET', '/api/me', { token: tokens.ana })).features.includes('voice_notes'));
  assert.ok(!(await ok('GET', '/api/me', { token: tokens.mgr })).features.includes('voice_notes'));
  const f = (await ok('GET', '/api/dev/features', { token: tokens.dev })).find((x) => x.key === 'voice_notes');
  assert.equal(f.mode, 'beta'); assert.deepEqual(f.beta.map((x) => x.name), ['Ana']);
  await ok('PUT', '/api/dev/features/gifs', { token: tokens.dev, body: { mode: 'off' } });
  assert.equal((await ok('GET', '/api/chat/gifs', { token: tokens.ana })).enabled, false);
  await ok('PUT', '/api/dev/features/gifs', { token: tokens.dev, body: { mode: 'everyone' } });
  await ok('PUT', '/api/dev/features/voice_notes', { token: tokens.dev, body: { mode: 'everyone' } });
});

test('a new desktop version uploads in pieces, is checked, replaces the current one, and can be rolled back', async () => {
  const { ok, api, tokens } = env;
  const dl = path.join(env.dataDir, 'downloads');
  fs.mkdirSync(dl, { recursive: true });
  fs.writeFileSync(path.join(dl, 'Staffwarden-0.9.21-mac-AppleSilicon.zip'), 'old');
  fs.writeFileSync(path.join(dl, 'Staffwarden-Setup-0.9.21.exe'), 'oldwin');
  fs.writeFileSync(path.join(dl, 'release-notes.txt'), 'old notes');
  const data = crypto.randomBytes(9 * 1024 * 1024 + 7);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const name = 'Staffwarden-0.9.22-mac-AppleSilicon.zip';
  // wrong names and older versions are refused
  assert.equal((await api('POST', '/api/dev/releases/start', { token: tokens.dev, body: { files: [{ name: 'evil.sh', size: 3, sha256: sha }] } })).status, 400);
  assert.equal((await api('POST', '/api/dev/releases/start', { token: tokens.ana, body: { files: [{ name, size: data.length, sha256: sha }] } })).status, 403);
  const up = await ok('POST', '/api/dev/releases/start', { token: tokens.dev, body: { files: [{ name, size: data.length, sha256: sha }] } });
  for (let off = 0; off < data.length; off += up.chunk) {
    await ok('POST', `/api/dev/releases/${up.id}/chunk`, { token: tokens.dev, body: { name, offset: off, data: data.subarray(off, off + up.chunk).toString('base64') } });
  }
  const pub = await ok('POST', `/api/dev/releases/${up.id}/publish`, { token: tokens.dev, body: { notes: 'Faster boost clip' } });
  assert.equal(pub.version, '0.9.22'); assert.equal(pub.previous, '0.9.21');
  assert.ok(fs.existsSync(path.join(dl, name)));
  assert.ok(!fs.existsSync(path.join(dl, 'Staffwarden-0.9.21-mac-AppleSilicon.zip')));
  assert.ok(fs.existsSync(path.join(dl, 'Staffwarden-Setup-0.9.21.exe')), 'Windows was not part of it: kept');
  assert.equal((await ok('GET', '/api/app/latest?platform=win32&arch=x64')).version, '0.9.21');
  assert.equal((await ok('GET', '/api/app/latest?platform=darwin&arch=arm64')).version, '0.9.22');
  const r = await ok('GET', '/api/dev/releases', { token: tokens.dev });
  assert.equal(r.notes, 'Faster boost clip'); assert.equal(r.archive[0].version, '0.9.21');
  // going back
  await ok('POST', '/api/dev/releases/rollback', { token: tokens.dev, body: { version: '0.9.21' } });
  assert.equal(fs.readFileSync(path.join(dl, 'release-notes.txt'), 'utf8'), 'old notes');
  assert.ok(fs.existsSync(path.join(dl, 'Staffwarden-0.9.21-mac-AppleSilicon.zip')));
  assert.ok(fs.existsSync(path.join(dl, 'archive', '0.9.22', name)));
  assert.ok(fs.existsSync(path.join(dl, 'Staffwarden-Setup-0.9.21.exe')));
  assert.equal(fs.readdirSync(dl).filter((f) => /\.(zip|exe)$/.test(f)).length, 2);
  assert.ok(env.app.db.prepare("SELECT 1 FROM audit WHERE action = 'dev.release_rollback'").get());
  // a damaged upload is refused
  const up2 = await ok('POST', '/api/dev/releases/start', { token: tokens.dev, body: { files: [{ name: 'Staffwarden-0.9.23-mac-AppleSilicon.zip', size: 4, sha256: sha }] } });
  await ok('POST', `/api/dev/releases/${up2.id}/chunk`, { token: tokens.dev, body: { name: 'Staffwarden-0.9.23-mac-AppleSilicon.zip', offset: 0, data: Buffer.from('abcd').toString('base64') } });
  assert.equal((await api('POST', `/api/dev/releases/${up2.id}/publish`, { token: tokens.dev, body: {} })).status, 400);
});

test('test tools: a test notification goes only to the developer; a stuck timer can be closed at its last sign of life', async () => {
  const { ok, tokens } = env;
  const before = env.app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'test'").get().n;
  await ok('POST', '/api/dev/test-notify', { token: tokens.dev, body: { kind: 'urgent' } });
  const rows = env.app.db.prepare("SELECT user_id FROM notifications WHERE kind = 'test'").all();
  assert.equal(rows.length, before + 1); assert.ok(rows.every((r) => r.user_id === dev.id));
  const p = await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'P', access: 'everyone' } });
  await ok('POST', '/api/timer/start', { token: tokens.ana, body: { project_id: p.id } });
  const t = await ok('GET', '/api/dev/timers', { token: tokens.dev });
  const mine = t.find((x) => x.user_id === ana.id);
  assert.ok(mine && !('activity' in mine));
  await ok('POST', `/api/dev/timers/${mine.entry_id}/close`, { token: tokens.dev });
  assert.equal((await ok('GET', '/api/dev/timers', { token: tokens.dev })).length, 0);
  const n = (await ok('GET', '/api/notifications', { token: tokens.ana })).items;
  assert.ok(n.some((x) => x.title === 'Your timer was stopped' && /Arham Dev/.test(x.body)));
});

test('the fleet shows who runs which app version, and a reminder reaches only those on an old one', async () => {
  const { ok, tokens } = env;
  env.app.db.prepare("UPDATE users SET app_version = '0.9.19', app_platform = 'darwin arm64' WHERE id = ?").run(ana.id);
  env.app.db.prepare("UPDATE users SET app_version = '0.9.21', app_platform = 'darwin arm64' WHERE id = ?").run(mgr.id);
  const f = await ok('GET', '/api/dev/fleet', { token: tokens.dev });
  assert.equal(f.people.find((x) => x.id === ana.id).state, 'old');
  assert.equal(f.people.find((x) => x.id === mgr.id).state, 'current');
  assert.equal((await ok('POST', '/api/dev/fleet/remind', { token: tokens.dev })).reminded, 1);
});

test('removing developer access closes the tools again', async () => {
  const { ok, api, tokens } = env;
  await ok('PATCH', `/api/users/${dev.id}`, { token: tokens.owner, body: { is_dev: false } });
  assert.equal((await api('GET', '/api/dev/health', { token: tokens.dev })).status, 403);
  assert.equal((await ok('GET', '/api/developers', { token: tokens.ana })).length, 0);
});

test('the boost panel says why someone won\'t get the clip; a developer can send a test clip to themselves only', async () => {
  const { ok, tokens } = env;
  await ok('PATCH', `/api/users/${dev.id}`, { token: tokens.owner, body: { is_dev: true } });
  const p = await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'Clip', access: 'everyone' } });
  await ok('POST', '/api/timer/start', { token: tokens.ana, body: { project_id: p.id } });
  env.app.db.prepare("UPDATE users SET app_version = '0.9.12', app_platform = 'darwin arm64' WHERE id = ?").run(ana.id);
  const b = await ok('GET', '/api/boost', { token: tokens.owner });
  const a = b.people.find((x) => x.id === ana.id);
  assert.equal(a.clip.why, 'old_app'); assert.match(a.clip.text, /0\.9\.12/);
  assert.equal(b.people.find((x) => x.id === mgr.id).clip.why, 'not_working');
  // the developer's own test: refused while their timer is off, then sent only to them
  assert.equal((await ok('POST', '/api/dev/test-clip', { token: tokens.dev })).sent, false);
  await ok('POST', '/api/timer/start', { token: tokens.dev, body: { project_id: p.id } });
  env.app.db.prepare("UPDATE users SET app_version = '0.9.21', app_platform = 'darwin arm64' WHERE id = ?").run(dev.id);
  const r = await ok('POST', '/api/dev/test-clip', { token: tokens.dev });
  assert.equal(r.sent, true);
  const clip = await ok('GET', `/api/boost/${r.id}`, { token: tokens.dev });
  assert.equal(clip.popup, true);
  assert.equal(env.app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'boost_clip' AND link = ?").get(`#/?boost=${r.id}`).n, 1);
  // not the last boost, not in anyone's count
  const after = await ok('GET', '/api/boost', { token: tokens.owner });
  assert.ok(!after.last || after.last.id !== r.id);
  await ok('POST', '/api/timer/stop', { token: tokens.dev, body: {} }).catch(() => {});
});

test('a test or developer account can be taken off tracking, and drops out of the dashboard', async () => {
  const { ok, tokens } = env;
  const t = await env.person('tester', 'Tess Tester', { title: 'Test Dev' });
  const has = async () => JSON.stringify(await ok('GET', '/api/dashboard/team', { token: tokens.owner })).includes('Tess Tester');
  assert.equal(await has(), true);
  await ok('PATCH', `/api/users/${t.id}`, { token: tokens.owner, body: { tracks_time: false } });
  assert.equal(await has(), false);
});

test('test pushes can target one person and one kind of device, and say what they reached', async () => {
  const { ok, tokens } = env;
  const list = await ok('GET', '/api/dev/test-targets', { token: tokens.dev });
  assert.ok(list.some((x) => x.me));
  const r = await ok('POST', '/api/dev/test-notify', { token: tokens.dev, body: { kind: 'message', user_id: ana.id, device: 'desktop' } });
  assert.equal(r.to, 'Ana');
  const n = env.app.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'test' ORDER BY id DESC").get(ana.id);
  assert.match(n.title, /sent by Arham Dev/); assert.equal(n.desktop, 1);
  await ok('POST', '/api/dev/test-notify', { token: tokens.dev, body: { kind: 'message', user_id: ana.id, device: 'phone' } });
  assert.equal(env.app.db.prepare("SELECT desktop FROM notifications WHERE user_id = ? AND kind = 'test' ORDER BY id DESC").get(ana.id).desktop, 0);
  assert.ok(env.app.db.prepare("SELECT 1 FROM audit WHERE action = 'dev.test_notify' AND target_user_id = ?").get(ana.id));
  assert.equal((await env.api('POST', '/api/dev/test-notify', { token: tokens.ana, body: { kind: 'message', user_id: dev.id } })).status, 403);
});
