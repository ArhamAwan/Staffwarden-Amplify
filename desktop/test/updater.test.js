'use strict';
// In-app updates: telling the person a newer version is out, downloading it safely, and the Mac swap script.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Updater, cmpVersion, macBundleOf, macSwapScript, prepareInstall } = require('../src/updater');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wh-upd-'));

// A pretend server: /api/app/latest answers with `latest`, and the file downloads in small chunks.
function fakeServer(latest, body) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/api/app/latest')) return { ok: true, status: 200, json: async () => latest };
    const chunks = [];
    for (let i = 0; i < body.length; i += 1000) chunks.push(body.subarray(i, i + 1000));
    return { ok: true, status: 200, headers: new Map([['content-length', String(body.length)]]), body: (async function* () { yield* chunks; })() };
  };
  return { fetchImpl, calls };
}

test('versions compare the way people expect', () => {
  assert.ok(cmpVersion('0.10.0', '0.9.9') > 0);
  assert.ok(cmpVersion('1.0.0', '1.0.0') === 0);
  assert.ok(cmpVersion('0.9.3', '0.9.4') < 0);
});

test('a newer version on the server is announced; the same or an older one is not', async () => {
  const body = Buffer.alloc(4500, 9);
  const changes = [];
  const s = fakeServer({ version: '0.9.4', url: '/downloads/Workhelm-Setup-0.9.4.exe', file: 'Workhelm-Setup-0.9.4.exe', size: body.length, sha256: sha(body), notes: 'Fixes' }, body);
  const u = new Updater({ baseUrl: 'http://srv/', version: '0.9.3', platform: 'win32', arch: 'x64', dir: tmp(), fetchImpl: s.fetchImpl, onChange: (x) => changes.push(x.status) });
  const st = await u.check();
  assert.equal(s.calls[0], 'http://srv/api/app/latest?platform=win32&arch=x64');
  assert.deepEqual([st.status, st.latest, st.notes], ['available', '0.9.4', 'Fixes']);
  const same = new Updater({ baseUrl: 'http://srv', version: '0.9.4', platform: 'win32', arch: 'x64', dir: tmp(), fetchImpl: s.fetchImpl });
  assert.equal((await same.check()).status, 'current');
  const linux = new Updater({ baseUrl: 'http://srv', version: '0.1.0', platform: 'linux', dir: tmp(), fetchImpl: s.fetchImpl });
  assert.equal((await linux.check()).status, 'idle', 'no in-app updates on Linux');
});

test('being offline is not an error; the next check tries again', async () => {
  const u = new Updater({ baseUrl: 'http://srv', version: '0.9.3', platform: 'darwin', arch: 'arm64', dir: tmp(), fetchImpl: async () => { throw new Error('offline'); } });
  const st = await u.check();
  assert.equal(st.status, 'idle');
  assert.equal(st.error, null);
});

test('the download is checked against the server\'s checksum before it can be installed', async () => {
  const body = Buffer.alloc(4500, 9);
  const dir = tmp();
  const good = fakeServer({ version: '0.9.4', url: '/downloads/W.exe', file: 'W.exe', size: body.length, sha256: sha(body) }, body);
  const progress = [];
  const u = new Updater({ baseUrl: 'http://srv', version: '0.9.3', platform: 'win32', arch: 'x64', dir, fetchImpl: good.fetchImpl, onChange: (x) => progress.push(x.progress) });
  await u.check();
  const file = await u.download();
  assert.equal(file, path.join(dir, 'W.exe'));
  assert.deepEqual(fs.readFileSync(file), body);
  assert.equal(u.state.status, 'ready');
  assert.ok(progress.some((p) => p > 0 && p < 100), 'progress is shown while downloading');
  assert.equal(await u.download(), file, 'asking again does not download again');

  const tampered = fakeServer({ version: '0.9.4', url: '/downloads/W.exe', file: 'W.exe', size: body.length, sha256: sha(Buffer.from('something else')) }, body);
  const dir2 = tmp();
  const v = new Updater({ baseUrl: 'http://srv', version: '0.9.3', platform: 'win32', arch: 'x64', dir: dir2, fetchImpl: tampered.fetchImpl });
  await v.check();
  await assert.rejects(v.download(), /checksum/);
  assert.equal(v.state.status, 'error');
  assert.match(v.state.error, /did not match/);
  assert.deepEqual(fs.readdirSync(dir2), [], 'a bad download is thrown away');
});

test('a server that sends no checksum is never offered as an update', async () => {
  const s = fakeServer({ version: '9.9.9', url: '/downloads/W.exe', size: 10 }, Buffer.alloc(10));
  const u = new Updater({ baseUrl: 'http://srv', version: '0.9.3', platform: 'win32', arch: 'x64', dir: tmp(), fetchImpl: s.fetchImpl });
  assert.equal((await u.check()).status, 'current');
});

test('macOS: the app bundle is found, and the swap script waits, swaps, keeps the old app on failure, and reopens', async () => {
  assert.equal(macBundleOf('/Applications/Workhelm.app/Contents/MacOS/Workhelm'), '/Applications/Workhelm.app');
  assert.equal(macBundleOf('/usr/local/bin/electron'), null);
  const s = macSwapScript({ pid: 4242, oldApp: "/Applications/Work'helm.app", newApp: '/Applications/.Workhelm-update.app', log: '/tmp/u.log' });
  assert.match(s, /kill -0 4242/);
  assert.match(s, /mv '\/Applications\/Work'\\''helm\.app' '\/Applications\/Work'\\''helm\.previous\.app'/, 'paths are quoted safely');
  assert.match(s, /\[ -d '\/Applications\/Work'\\''helm\.app' \] \|\| mv/, 'puts the old app back if the swap fails');
  assert.match(s, /open '\/Applications\/Work'\\''helm\.app'\s*$/);
  await assert.rejects(prepareInstall({ platform: 'darwin', file: '/x.zip', execPath: '/usr/bin/node', workDir: tmp() }), /installed app/);
});

test('macOS: an app folder this account cannot write to asks the person to install it themselves', async () => {
  const root = tmp();
  const appDir = path.join(root, 'Workhelm.app', 'Contents', 'MacOS');
  fs.mkdirSync(appDir, { recursive: true });
  fs.chmodSync(root, 0o555);
  try {
    if (process.getuid && process.getuid() === 0) return;   // root can write anywhere; nothing to check here
    await assert.rejects(prepareInstall({ platform: 'darwin', file: '/x.zip', execPath: path.join(appDir, 'Workhelm'), workDir: tmp() }), (e) => e.code === 'not-writable');
  } finally { fs.chmodSync(root, 0o755); }
});

test('a check says whether the server was reached, so "Check for updates" can answer up to date, available or offline', async () => {
  const body = Buffer.alloc(10, 1);
  const up = fakeServer({ version: '0.9.5', url: '/downloads/W.exe', size: 10, sha256: sha(body) }, body);
  const cur = new Updater({ baseUrl: 'http://srv', version: '0.9.5', platform: 'win32', arch: 'x64', dir: tmp(), fetchImpl: up.fetchImpl });
  assert.deepEqual([(await cur.check()).status, cur.state.reached], ['current', true]);
  const newer = new Updater({ baseUrl: 'http://srv', version: '0.9.4', platform: 'win32', arch: 'x64', dir: tmp(), fetchImpl: up.fetchImpl });
  assert.deepEqual([(await newer.check()).status, newer.state.reached], ['available', true]);
  const off = new Updater({ baseUrl: 'http://srv', version: '0.9.4', platform: 'win32', arch: 'x64', dir: tmp(), fetchImpl: async () => { throw new Error('offline'); } });
  await off.check();
  assert.equal(off.state.reached, false);
});

test('a download that stops is noticed, retried once, and the reason is shown', async () => {
  const body = Buffer.alloc(3000, 4);
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/api/app/latest')) return { ok: true, status: 200, json: async () => ({ version: '0.9.9', url: '/downloads/W.exe', size: body.length, sha256: sha(body) }) };
    calls++;
    if (calls === 1) {               // first try: sends a little, then nothing more
      return { ok: true, status: 200, headers: new Map(), body: (async function* () {
        yield body.subarray(0, 1000);
        await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      })() };
    }
    return { ok: true, status: 200, headers: new Map(), body: (async function* () { yield body; })() };
  };
  const dir = tmp();
  const u = new Updater({ baseUrl: 'http://srv', version: '0.9.5', platform: 'darwin', arch: 'arm64', dir, fetchImpl });
  u.stallMs = 150;
  await u.check();
  const file = await u.download();
  assert.equal(calls, 2, 'retried after the stall');
  assert.deepEqual(fs.readFileSync(file), body);
  const log = fs.readFileSync(path.join(path.dirname(dir), 'update.log'), 'utf8');
  assert.match(log, /download failed: the download stopped \(nothing arrived/);
  assert.match(log, /downloaded and checked/);
});

test('macOS: when the running app cannot be replaced, the update goes to Applications instead', () => {
  const { macTarget } = require('../src/updater');
  const root = tmp(), home = path.join(root, 'home');
  fs.mkdirSync(path.join(root, 'here', 'Workhelm.app'), { recursive: true });
  const normal = path.join(root, 'here', 'Workhelm.app');
  assert.equal(macTarget(normal, { home }), normal, 'a normal install is replaced in place');
  const trans = '/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/Workhelm.app';
  const t = macTarget(trans, { home });
  assert.ok(t === '/Applications/Workhelm.app' || t === path.join(home, 'Applications', 'Workhelm.app'), 'never into the protected temporary copy: ' + t);
});

test('leftovers from an update that stopped half way are removed', () => {
  const { cleanupLeftovers } = require('../src/updater');
  const root = tmp();
  const apps = path.join(root, 'Apps'), work = path.join(root, 'work');
  fs.mkdirSync(path.join(apps, 'Workhelm.app', 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(apps, '.Workhelm-update.app', 'Contents'), { recursive: true });
  fs.mkdirSync(path.join(work, 'unpacked', 'Workhelm.app'), { recursive: true });
  const gone = cleanupLeftovers({ platform: 'darwin', execPath: path.join(apps, 'Workhelm.app', 'Contents', 'MacOS', 'Workhelm'), workDir: work });
  assert.equal(gone.length, 2);
  assert.ok(!fs.existsSync(path.join(apps, '.Workhelm-update.app')));
  assert.ok(!fs.existsSync(path.join(work, 'unpacked')));
  assert.ok(fs.existsSync(path.join(apps, 'Workhelm.app')), 'the app itself is untouched');
});
