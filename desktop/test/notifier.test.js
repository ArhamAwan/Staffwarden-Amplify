'use strict';
// Desktop pop-ups for notifications: only new ones, never twice (not even after a restart), no burst
// of old ones on first start, a summary when many arrive at once, and off when the person turned it off.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server/app');
const { Client, NetworkError } = require('../src/client');
const { Notifier } = require('../src/notifier');

let app, base, dataDir, owner, emp, empId, clock = Date.parse('2026-10-23T05:00:00Z');
const raw = async (method, url, token, body) => (await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-notif-'));
  app = createApp({ dataDir, now: () => clock, webDir: dataDir });
  app.seedOwner('owner@t.com', 'Owner', 'ownerpass1');
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  owner = (await raw('POST', '/api/auth/login', null, { email: 'owner@t.com', password: 'ownerpass1' })).token;
  empId = (await raw('POST', '/api/users', owner, { email: 'e@t.com', name: 'Ema', password: 'test-pw-2026x' })).id;
  emp = (await raw('POST', '/api/auth/login', null, { email: 'e@t.com', password: 'test-pw-2026x' })).token;
  await raw('POST', '/api/me/consent', emp);
});
after(async () => { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });

function make(seen = {}) {
  const shown = [];
  const client = new Client({ baseUrl: base, getToken: () => emp });
  const n = new Notifier({ client, store: { get: (u) => seen[u] ?? null, set: (u, v) => { seen[u] = v; } }, show: (x) => shown.push(x), now: () => clock });
  n.setUser(empId);
  return { n, shown, seen, client };
}
const assign = (title) => raw('POST', '/api/tasks', owner, { title, assignee_id: empId });

test('first start does not replay old notifications; new ones pop up once', async () => {
  await assign('Old one');
  const { n, shown, seen } = make();
  assert.deepEqual(await n.poll(), [], 'nothing on first start');
  assert.ok(seen[empId] >= 1);
  await assign('Write the release notes');
  await n.poll();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Owner assigned you Write the release notes');
  assert.match(shown[0].link, /^#\/tasks\?task=\d+$/);
  await n.poll();
  assert.equal(shown.length, 1, 'not twice');
  // a restart with the saved position: still not twice
  const again = make({ ...seen });
  await again.n.poll();
  assert.equal(again.shown.length, 0);
});

test('many at once become one summary; read ones elsewhere are skipped', async () => {
  const { n, shown, seen } = make();
  await n.poll();
  for (const t of ['A', 'B', 'C', 'D', 'E']) await assign(t);
  await n.poll();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, '5 new notifications');
  assert.equal(shown[0].ids.length, 5);
  const t = await assign('Already seen in the browser');
  const list = await raw('GET', '/api/notifications?limit=1', emp);
  await raw('POST', '/api/notifications/read', emp, { ids: [list.items[0].id] });
  await n.poll();
  assert.equal(shown.length, 1, 'read in the dashboard first: no pop-up');
  assert.ok(seen[empId] >= list.items[0].id);
  assert.ok(t.id);
});

test('switched off in the profile: nothing pops up, and turning it back on does not replay', async () => {
  const { n, shown } = make();
  await n.poll();
  await raw('PUT', '/api/me/notify-prefs', emp, { desktop: false });
  n.prefsAt = 0;
  await assign('Quiet');
  await n.poll();
  assert.equal(shown.length, 0);
  await raw('PUT', '/api/me/notify-prefs', emp, { desktop: true });
  n.prefsAt = 0;
  await n.poll();
  assert.equal(shown.length, 0, 'what came while off is not replayed');
  await assign('Loud');
  await n.poll();
  assert.equal(shown.length, 1);
});

test('offline: polling quietly does nothing', async () => {
  const shown = [];
  const n = new Notifier({ client: { notifications: async () => { throw new NetworkError('down'); }, notifyPrefs: async () => { throw new NetworkError('down'); } }, store: { get: () => 5, set: () => {} }, show: (x) => shown.push(x) });
  n.setUser(1);
  assert.deepEqual(await n.poll(), []);
  assert.equal(shown.length, 0);
});

test('a boost clip is never folded into a burst of notifications', async () => {
  const { Notifier } = require('../src/notifier');
  const items = [1, 2, 3, 4, 5].map((id) => ({ id, kind: 'chat_direct', title: `m${id}`, read: false })).concat([{ id: 6, kind: 'boost_clip', title: 'Boost', link: '#/?boost=9', read: false }]);
  let last = 0; const shown = [];
  const n = new Notifier({ client: { notifyPrefs: async () => ({ desktop: true }), notifications: async () => ({ items, last_id: 6 }) }, store: { get: () => last, set: (u, v) => { last = v; } }, show: (x) => shown.push(x) });
  n.setUser(1);
  await n.poll();
  assert.ok(shown.some((x) => x.kind === 'boost_clip'));
  assert.equal(shown.length, 2);
});
