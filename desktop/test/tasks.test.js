'use strict';
// Tasks from the desktop app, against the real server. (Which apps or sites people use is not tracked.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server/app');
const { Client } = require('../src/client');
const { OfflineQueue } = require('../src/queue');
const { Tracker } = require('../src/tracker');

// ---------- end to end ----------
const T0 = Date.parse('2026-10-23T08:00:00Z'); // 13:00 PKT
const DAY = '2026-10-23';
let clock = T0, app, base, dataDir, ownerToken;
async function raw(method, url, token, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-apps-'));
  app = createApp({ dataDir, now: () => clock, webDir: dataDir, shotsPer10: 0 });
  app.seedOwner('owner@t.com', 'Owner', 'ownerpass1');
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ownerToken = (await raw('POST', '/api/auth/login', null, { email: 'owner@t.com', password: 'ownerpass1' })).token;
});
after(async () => { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function employee(email, idleSecs = () => 0) {
  const u = await raw('POST', '/api/users', ownerToken, { email, name: email.split('@')[0], password: 'test-pw-2026x' });
  const { token } = await raw('POST', '/api/auth/login', null, { email, password: 'test-pw-2026x' });
  await raw('POST', '/api/me/consent', token);
  const client = new Client({ baseUrl: base, getToken: () => token });
  const queue = new OfflineQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-aq-')));
  const tracker = new Tracker({ client, queue, idleSecs, now: () => clock, idleLimitSecs: 600, tzOffsetMin: 300, capture: async () => [] });
  return { id: u.id, token, client, tracker };
}
async function run(tracker, seconds) {
  for (let i = 0; i < seconds; i++) { clock += 1000; await tracker.tick(); if (i % 10 === 9) await new Promise((r) => setImmediate(r)); }
}

test('tasks from the desktop app: my tasks, start on one, send it for review', async () => {
  clock = T0 + 6 * 3600000;
  const e = await employee('tasker@t.com');
  const t = await raw('POST', '/api/tasks', ownerToken, { title: 'Write the release notes', assignee_id: e.id, due_day: DAY });
  const mine = await e.client.myTasks();
  assert.deepEqual(mine.map((x) => x.title), ['Write the release notes']);
  assert.equal(mine[0].due_today, true);
  const sum = await e.client.taskSummary();
  assert.equal(sum.due_today, 1);

  await e.tracker.start(null, t.id);
  assert.equal(e.tracker.status().taskId, t.id);
  await run(e.tracker, 60);
  assert.equal((await e.client.myTasks())[0].status, 'in_progress', 'starting the timer on a task moves it to In progress');
  await assert.rejects(e.client.setTaskStatus(t.id, 'done'), /review/i, 'assigned work cannot be closed by the assignee');
  const r = await e.client.setTaskStatus(t.id, 'in_review');
  assert.equal(r.status, 'in_review');
  await e.tracker.stop();
  const full = await raw('GET', `/api/tasks/${t.id}`, ownerToken);
  assert.ok(full.sessions.length >= 1 || full.tracked_secs >= 55, 'the time is recorded against the task');
});
