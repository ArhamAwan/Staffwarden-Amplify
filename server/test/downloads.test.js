'use strict';
// Desktop installers on the server: listed for anyone (the sign-in page shows them), downloadable, safe names only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv } = require('./helpers');

let env;
before(async () => {
  env = await makeEnv();
  const dir = path.join(env.dataDir, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Workhelm-Setup-0.9.0.exe'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(dir, 'Workhelm-0.9.0-mac-AppleSilicon.zip'), Buffer.alloc(1024, 2));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'private');
});
after(() => env.close());

test('installers are listed without signing in, and only installers', async () => {
  const r = await fetch(env.base + '/api/downloads');
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.deepEqual(list.map((d) => d.kind).sort(), ['mac-arm', 'windows']);
  assert.ok(!list.some((d) => d.file === 'notes.txt'));
});

test('an installer downloads as a file; anything else is not found', async () => {
  const r = await fetch(env.base + '/downloads/Workhelm-Setup-0.9.0.exe');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="Workhelm-Setup-0.9.0.exe"/);
  assert.equal((await r.arrayBuffer()).byteLength, 2048);
  assert.equal((await fetch(env.base + '/downloads/notes.txt')).status, 404);
  assert.equal((await fetch(env.base + '/downloads/..%2Fsessions')).status, 404);
  assert.equal((await fetch(env.base + '/downloads/nope.exe')).status, 404);
});

test('the desktop app can ask for the newest version for its computer, with a checksum', async () => {
  const crypto = require('node:crypto');
  const dir = path.join(env.dataDir, 'downloads');
  const newer = Buffer.alloc(3000, 7);
  fs.writeFileSync(path.join(dir, 'Workhelm-Setup-0.10.1.exe'), newer);
  fs.writeFileSync(path.join(dir, 'Workhelm-Setup-0.9.9.exe'), Buffer.alloc(10, 1));   // newer file time, older version
  fs.writeFileSync(path.join(dir, 'release-notes.txt'), 'Only private windows are blacked out now.');
  const get = async (q) => (await fetch(env.base + '/api/app/latest' + q)).json();
  const win = await get('?platform=win32&arch=x64');
  assert.equal(win.version, '0.10.1', '0.10.1 is newer than 0.9.9, whatever the file dates');
  assert.equal(win.url, '/downloads/Workhelm-Setup-0.10.1.exe');
  assert.equal(win.size, 3000);
  assert.equal(win.sha256, crypto.createHash('sha256').update(newer).digest('hex'));
  assert.equal(win.notes, 'Only private windows are blacked out now.');
  assert.equal((await get('?platform=darwin&arch=arm64')).version, '0.9.0');
  assert.equal((await get('?platform=darwin&arch=x64')).version, null, 'no Intel build uploaded');
  assert.equal((await get('?platform=linux&arch=x64')).version, null);
});

test('each person\'s app version is remembered from what the app reports, and shown to managers', async () => {
  const { ok, tokens } = env;
  const me = await fetch(env.base + '/api/me', { headers: { Authorization: 'Bearer ' + tokens.owner, 'X-Workhelm-App': '0.9.4 darwin arm64' } });
  assert.equal(me.status, 200);
  await fetch(env.base + '/api/me', { headers: { Authorization: 'Bearer ' + tokens.owner, 'X-Workhelm-App': 'nonsense; drop table' } });
  const list = await ok('GET', '/api/users', { token: tokens.owner });
  const owner = list.find((u) => u.role === 'owner');
  assert.deepEqual([owner.app_version, owner.app_platform], ['0.9.4', 'darwin arm64']);
});

test('when a newer desktop app is uploaded, everyone on an older one is told once (bell, browser and desktop pop-ups)', async () => {
  const { ok, tokens } = env;
  await env.person('kim', 'Kim'); await env.person('lee', 'Lee');
  const say = (t, v) => fetch(env.base + '/api/me', { headers: { Authorization: 'Bearer ' + t, 'X-Workhelm-App': v } });
  await say(tokens.kim, '0.9.3 win32 x64');          // older than the 0.10.1 installer uploaded above
  await say(tokens.lee, '0.10.1 win32 x64');         // already up to date
  env.app.sweepNotify(); env.app.sweepNotify();
  const kim = (await ok('GET', '/api/notifications', { token: tokens.kim })).items.filter((n) => n.kind === 'app_update');
  assert.equal(kim.length, 1, 'once, not on every sweep');
  assert.equal(kim[0].title, 'Staffwarden 0.10.1 is available');
  assert.match(kim[0].body, /Download it from your Profile/, 'an app too old to update itself is told how');
  assert.equal(kim[0].link, '#/profile');
  const lee = (await ok('GET', '/api/notifications', { token: tokens.lee })).items.filter((n) => n.kind === 'app_update');
  assert.equal(lee.length, 0);
});

test('with a public address set, update downloads point at it (the fast route), whatever address the app used', async () => {
  const { makeEnv } = require('./helpers');
  const e = await makeEnv({ app: { publicUrl: 'https://workhelm.example.workers.dev/' } });
  try {
    const dir = path.join(e.dataDir, 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Workhelm-0.9.9-mac-AppleSilicon.zip'), Buffer.alloc(100, 1));
    const r = await (await fetch(e.base + '/api/app/latest?platform=darwin&arch=arm64')).json();
    assert.equal(r.url, 'https://workhelm.example.workers.dev/downloads/Workhelm-0.9.9-mac-AppleSilicon.zip');
  } finally { e.close(); }
});
