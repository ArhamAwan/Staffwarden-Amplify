'use strict';
// The real Tracker engine talking to the real server, on a simulated clock shared by both.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server/app');
const { Client } = require('../src/client');
const { OfflineQueue } = require('../src/queue');
const { Tracker } = require('../src/tracker');
const { MemoryStore } = require('../src/store');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const T0 = Date.parse('2026-10-23T08:00:00Z'); // 13:00 PKT
const DAY = '2026-10-23';
let clock = T0;
let online = true;
let app, base, dataDir, ownerToken, project;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-int-'));
  app = createApp({ dataDir, now: () => clock, webDir: dataDir });
  app.seedOwner('owner@t.com', 'Owner', 'ownerpass1');
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ownerToken = (await raw('POST', '/api/auth/login', null, { email: 'owner@t.com', password: 'ownerpass1' })).token;
  project = await raw('POST', '/api/projects', ownerToken, { name: 'Project A', access: 'everyone' });
});
after(async () => { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function raw(method, url, token, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

// A fresh consented employee with a tracker whose network can be switched off.
async function setup(email, { idleSecs = () => 0, seed = 7, store } = {}) {
  await raw('POST', '/api/users', ownerToken, { email, name: email.split('@')[0], password: 'test-pw-2026x' });
  const { token } = await raw('POST', '/api/auth/login', null, { email, password: 'test-pw-2026x' });
  await raw('POST', '/api/me/consent', token);
  const flaky = async (...a) => { if (!online) throw new TypeError('fetch failed'); return fetch(...a); };
  const client = new Client({ baseUrl: base, getToken: () => token, fetchImpl: flaky });
  const queue = new OfflineQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'amp-qi-')));
  const events = [];
  const tracker = new Tracker({
    client, queue, idleSecs: (...a) => idleSecs(...a), now: () => clock, rng: mulberry32(seed), idleLimitSecs: 600, tzOffsetMin: 300,
    store: store || new MemoryStore(), capture: async () => [{ buf: PNG }], onEvent: (e) => events.push(e),
  });
  return { token, tracker, queue, events };
}

// Advances the simulated clock one second at a time. Every few seconds it lets real network traffic
// (background uploads, heartbeats) make progress, like a real app whose clock is also real time.
async function run(tracker, seconds) {
  for (let i = 0; i < seconds; i++) {
    clock += 1000; await tracker.tick();
    if (i % 10 === 9) await new Promise((r) => setImmediate(r));
  }
}
const myDay = (s, day = DAY) => raw('GET', `/api/users/me/day?day=${day}`, s.token);
const halfActive = () => ((clock / 1000) % 2 === 0 ? 0 : 10);

test('a day with a lunch break: the app and the server agree on every number, and nothing is captured while paused', async () => {
  online = true; clock = T0;
  const s = await setup('anna@t.com', { idleSecs: halfActive });
  await s.tracker.start(project.id);
  await run(s.tracker, 10 * 60);
  await s.tracker.pause({ reason: 'lunch' });
  const frozen = (await myDay(s)).shots;
  await run(s.tracker, 10 * 60);
  await s.tracker.sync();
  assert.equal((await myDay(s)).shots, frozen, 'no screenshot reached the server during the pause');
  assert.equal((await raw('GET', '/api/timer/current', s.token)).paused, true);
  await s.tracker.resume();
  await run(s.tracker, 10 * 60);
  await s.tracker.pause({ reason: 'prayer' });
  await run(s.tracker, 5 * 60);
  await s.tracker.resume();
  await run(s.tracker, 5 * 60);

  const local = await s.tracker.stop();               // the day-end summary the employee sees
  assert.equal(s.queue.size, 0, 'everything uploaded');
  const server = await myDay(s);

  assert.equal(local.worked_secs, 25 * 60);
  assert.equal(local.break_secs, 15 * 60);
  for (const k of ['worked_secs', 'break_secs', 'idle_secs', 'break_count', 'sessions', 'first_start', 'last_end', 'shots']) {
    assert.equal(local[k], server[k], `${k}: app ${local[k]} vs server ${server[k]}`);
  }
  assert.deepEqual(local.breaks.map((b) => [b.reason, b.started_at, b.ended_at, b.secs]), server.breaks.map((b) => [b.reason, b.started_at, b.ended_at, b.secs]));
  assert.ok(Math.abs(local.activity_pct - server.activity_pct) <= 1, `activity ${local.activity_pct} vs ${server.activity_pct}`);
  assert.ok(server.activity_pct >= 46 && server.activity_pct <= 54, 'activity ~50%: ' + server.activity_pct);

  // every screenshot falls inside working time
  const pauses = server.breaks.map((b) => [Date.parse(b.started_at), Date.parse(b.ended_at)]);
  assert.ok(server.shots_list.length >= 4, 'about 2 per 10 minutes of work: ' + server.shots_list.length);
  for (const x of server.shots_list) {
    const t = Date.parse(x.taken_at);
    assert.ok(!pauses.some(([a, b]) => t >= a && t < b), 'screenshot inside a pause at ' + x.taken_at);
    assert.equal(Math.floor(t / 600000) * 600000, Date.parse(x.slot_start), 'capture falls inside its own 10-minute block');
  }
  const bySlot = {};
  for (const x of server.shots_list) bySlot[x.slot_start] = (bySlot[x.slot_start] || 0) + 1;
  assert.ok(Object.values(bySlot).every((n) => n <= 2), 'never more than the company default (2) per 10-minute block');
  assert.equal(server.attendance.status, 'late', '13:00 PKT is after the 09:00 shift');
});

test('screenshots reach the server as they are taken, not in a batch later', async () => {
  online = true; clock = T0 + 2 * 3600000;
  const s = await setup('live@t.com');
  await s.tracker.start(project.id);
  let seen = false;
  for (let i = 0; i < 240 && !seen; i++) {
    clock += 1000; await s.tracker.tick();
    if (s.events.some((e) => e.type === 'screenshot')) {
      await new Promise((r) => setTimeout(r, 150));     // no explicit sync: the tracker uploads on its own
      seen = (await myDay(s)).shots >= 1;
      assert.ok(seen, 'the first capture is already on the server');
    }
  }
  assert.ok(seen);
  await run(s.tracker, 40);
  await new Promise((r) => setTimeout(r, 150));
  const day = await myDay(s);
  assert.ok(day.activity.length >= 1, 'partial activity is uploaded while the slot is still open');
  await s.tracker.stop();
});

test('offline: pauses, resumes and the stop are queued with their real times and replayed in order', async () => {
  online = true; clock = T0 + 3 * 3600000;
  const s = await setup('omar@t.com');
  await s.tracker.start(project.id);
  await run(s.tracker, 5 * 60);

  online = false;                                   // wifi drops
  await run(s.tracker, 5 * 60);
  await s.tracker.pause({ reason: 'break' });
  await run(s.tracker, 4 * 60);
  await s.tracker.resume();
  await run(s.tracker, 3 * 60);
  const sum = await s.tracker.stop();               // stop while offline: queued, not lost
  assert.ok(s.queue.size > 4);
  assert.equal((await raw('GET', '/api/timer/current', s.token)).active, true, 'the server has not heard about any of it yet');

  online = true;
  const r = await s.tracker.sync();
  assert.equal(r.remaining, 0);
  const server = await myDay(s);
  assert.equal(server.worked_secs, sum.worked_secs); assert.equal(server.worked_secs, 13 * 60);
  assert.equal(server.break_secs, 4 * 60, 'the break keeps its real length, not the reconnect time');
  assert.deepEqual(server.breaks.map((b) => b.reason), ['break']);
  assert.ok(server.shots >= 2, 'screenshots taken while offline were uploaded afterwards: ' + server.shots);
  assert.equal(server.shots_list.filter((x) => { const t = Date.parse(x.taken_at); const b = server.breaks[0]; return t >= Date.parse(b.started_at) && t < Date.parse(b.ended_at); }).length, 0);
});

test('walking away: the timer keeps running, the stretch shows as idle with no screenshots, and both sides agree', async () => {
  online = true; clock = T0 + 5 * 3600000;
  const leftAt = clock + 20 * 60 * 1000, backAt = clock + 50 * 60 * 1000;
  const s = await setup('iris@t.com', { idleSecs: () => (clock < leftAt || clock >= backAt ? 0 : Math.floor((clock - leftAt) / 1000)) });
  await s.tracker.start(project.id);
  await run(s.tracker, 35 * 60);                   // left at minute 20; noticed at idle = 10 min
  assert.equal(s.tracker.status().mode, 'running', 'idle does not pause the timer');
  assert.ok(s.events.some((e) => e.type === 'idle-start'));
  await s.tracker.sync();
  const mid = await myDay(s);
  assert.equal(mid.live.state, 'idle', 'the dashboard shows the person as idle');
  assert.equal((await raw('GET', '/api/timer/current', s.token)).running, true);
  assert.ok(mid.shots_list.every((x) => Date.parse(x.taken_at) < leftAt), 'no screenshot from the idle stretch');
  await run(s.tracker, 25 * 60);                   // back at minute 50, works 10 more minutes
  const sum = await s.tracker.stop();
  const server = await myDay(s);
  assert.equal(sum.worked_secs, 60 * 60); assert.equal(server.worked_secs, 60 * 60, 'idle time still counts as worked');
  assert.equal(sum.idle_secs, 30 * 60); assert.equal(server.idle_secs, 30 * 60);
  assert.equal(server.break_secs, 0, 'idle is not a break');
  assert.deepEqual(server.breaks.map((b) => [b.type, !!b.counted, b.started_at, b.ended_at]), [['idle', true, new Date(leftAt).toISOString(), new Date(backAt).toISOString()]]);
  assert.ok(server.segs.some((g) => g[2] === 'i'), 'the ribbon shows the idle stretch');
});

test('a sleeping computer: away is not counted, the timer carries on, the server agrees', async () => {
  online = true; clock = T0 + 6 * 3600000;
  const s = await setup('sam@t.com');
  await s.tracker.start(project.id);
  await run(s.tracker, 10 * 60);
  clock += 15 * 60000;                             // lid closed for 15 minutes
  await run(s.tracker, 10 * 60);
  const sum = await s.tracker.stop();
  const server = await myDay(s);
  assert.ok(Math.abs(sum.worked_secs - 20 * 60) <= 1, 'worked ' + sum.worked_secs); assert.equal(server.worked_secs, sum.worked_secs);
  assert.equal(server.break_secs, 0); assert.ok(Math.abs(server.away_secs - 15 * 60) <= 1, 'away ' + server.away_secs);
  assert.deepEqual(server.breaks.map((b) => b.type), ['away']);
});

test('the dashboard never shows a long pause as a dead timer, and the server does not close it', async () => {
  online = true; clock = T0 + 7 * 3600000;
  const s = await setup('pat@t.com');
  await s.tracker.start(project.id);
  await run(s.tracker, 2 * 60);
  await s.tracker.pause({ reason: 'lunch' });
  await run(s.tracker, 45 * 60);                   // longer than the 20 minute auto-close
  assert.equal(app.sweepStale(), 0, 'heartbeats from the paused app keep the session alive');
  const team = await raw('GET', `/api/dashboard/team?day=${DAY}`, ownerToken);
  assert.equal(team.members.find((m) => m.name === 'pat').state, 'break');
  await s.tracker.resume();
  await run(s.tracker, 60);
  await s.tracker.stop();
});

test('a manager changes one person\'s screenshots: 3 per 10 minutes, then off; time keeps being tracked', async () => {
  online = true; clock = T0 + 9 * 3600000;
  const s = await setup('kim@t.com');
  const me = await raw('GET', '/api/me', s.token);
  await raw('PATCH', `/api/users/${me.id}`, ownerToken, { shots_per_10: 3 });
  // more screenshots than Kim agreed to: she sees what changed and agrees again before the timer starts
  const after = await raw('GET', '/api/me', s.token);
  assert.equal(after.consented, false);
  assert.ok(after.policy_changes.settings.some((l) => l.key === 'shots' && l.more));
  await assert.rejects(s.tracker.start(project.id), /changed since you agreed/);
  await raw('POST', '/api/me/consent', s.token);
  s.tracker.configure({ shotsPer10: (await raw('GET', '/api/me', s.token)).shots_per_10 });
  await s.tracker.start(project.id);
  await run(s.tracker, 20 * 60);
  await s.tracker.sync();
  assert.equal((await myDay(s)).shots, 6, '3 per 10 minutes');
  await raw('PATCH', `/api/users/${me.id}`, ownerToken, { shots_per_10: 0 });
  await s.tracker.heartbeat();                      // the app learns about the change from its heartbeat
  await run(s.tracker, 20 * 60);
  await s.tracker.stop();
  const d = await myDay(s);
  assert.equal(d.shots, 6, 'no screenshots once turned off');
  assert.equal(d.worked_secs, 40 * 60, 'but the time is still tracked');
  // and the server refuses screenshots for someone with screenshots off
  const r = await fetch(base + '/api/screenshots', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token }, body: JSON.stringify({ slot_start: new Date(clock).toISOString(), taken_at: new Date(clock).toISOString(), image_base64: PNG.toString('base64') }) });
  assert.ok(r.status === 403 || r.status === 409);
});

test('capture failure (e.g. screen permission revoked) never breaks tracking or pausing', async () => {
  online = true; clock = T0 + 10 * 3600000;
  const s = await setup('ravi@t.com');
  s.tracker.capture = async () => { throw new Error('screen recording permission denied'); };
  await s.tracker.start(project.id);
  await run(s.tracker, 6 * 60);
  await s.tracker.pause({ reason: 'break' });
  await run(s.tracker, 60);
  await s.tracker.resume();
  await run(s.tracker, 6 * 60);
  await s.tracker.stop();
  assert.ok(s.events.some((e) => e.type === 'capture-error'));
  const d = await myDay(s);
  assert.equal(d.worked_secs, 12 * 60);
  assert.equal(d.break_secs, 60);
});

test('a session closed by the server during a long outage is reopened, and the app says so', async () => {
  online = true; clock = T0 + 11 * 3600000;
  const s = await setup('nina@t.com');
  s.tracker.pingEveryMs = 1e12;                    // no heartbeats: the machine is cut off
  await s.tracker.start(project.id);
  await run(s.tracker, 3 * 60);
  online = false;
  await run(s.tracker, 2 * 60);
  clock += 30 * 60000; app.sweepStale();           // the server gave up on the silent session
  online = true;
  s.tracker.lastTickAt = clock;
  s.tracker.pingEveryMs = 20000; s.tracker.lastPingAt = 0;
  await s.tracker.tick();
  await s.tracker.sync();
  await s.tracker.heartbeat();
  assert.ok(s.events.some((e) => e.type === 'reconnected'));
  assert.equal((await raw('GET', '/api/timer/current', s.token)).running, true, 'a fresh session is open');
  await s.tracker.stop();
});

test('an employee who has not accepted the policy cannot start tracking', async () => {
  online = true;
  await raw('POST', '/api/users', ownerToken, { email: 'new@t.com', name: 'new', password: 'test-pw-2026x' });
  const { token } = await raw('POST', '/api/auth/login', null, { email: 'new@t.com', password: 'test-pw-2026x' });
  const client = new Client({ baseUrl: base, getToken: () => token });
  const queue = new OfflineQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'amp-qn-')));
  const tracker = new Tracker({ client, queue, idleSecs: () => 0, now: () => clock, capture: async () => [] });
  await assert.rejects(() => tracker.start(project.id), /policy/i);
  assert.equal(tracker.status().mode, 'stopped');
});
