'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SLOT_MS, slotStart, pickShotTimes } = require('../src/schedule');
const { ActivityMeter } = require('../src/activity');
const { OfflineQueue } = require('../src/queue');
const { NetworkError, ApiError } = require('../src/client');

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amp-q-'));

test('default block is 10 minutes (screenshots and activity, as in Hubstaff)', () => {
  assert.equal(DEFAULT_SLOT_MS, 600000);
  assert.equal(slotStart(Date.parse('2026-10-23T08:03:41Z'), 120000), Date.parse('2026-10-23T08:02:00Z'));
  assert.equal(slotStart(Date.parse('2026-10-23T08:03:41Z'), 10 * 60 * 1000), Date.parse('2026-10-23T08:00:00Z'));
});

test('pickShotTimes: exactly one random moment per slot, never on the edges', () => {
  const s0 = Date.parse('2026-10-23T08:02:00Z'), SLOT = 120000;
  const offsets = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const times = pickShotTimes(s0, mulberry32(seed), { slotMs: SLOT });
    assert.equal(times.length, 1);
    assert.ok(times[0] >= s0 + 5000 && times[0] <= s0 + SLOT - 5000, 'inside the slot');
    offsets.add(times[0] - s0);
  }
  assert.ok(offsets.size > 150, 'spread across the slot, not a fixed schedule: ' + offsets.size);
  const early = [...offsets].filter((o) => o < 60000).length, late = offsets.size - early;
  assert.ok(early > 60 && late > 60, 'both halves of the slot are used');
});

test('pickShotTimes: longer slots can take 1-3 shots, sorted, inside the slot', () => {
  const TEN = 10 * 60 * 1000, s0 = slotStart(Date.parse('2026-10-23T08:07:00Z'), TEN);
  const counts = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const times = pickShotTimes(s0, mulberry32(seed), { slotMs: TEN, min: 1, max: 3 });
    counts.add(times.length);
    assert.deepEqual([...times].sort((a, b) => a - b), times);
    for (const t of times) assert.ok(t >= s0 + 5000 && t <= s0 + TEN - 5000);
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3]);
});

test('ActivityMeter: counts active seconds, rolls over every slot, ignores sleep gaps', () => {
  const m = new ActivityMeter({ slotMs: 120000 });
  const t0 = Date.parse('2026-10-23T08:00:00Z');
  m.begin(t0);
  const finished = [];
  for (let s = 1; s <= 250; s++) {
    const r = m.tick(t0 + s * 1000, s % 4 === 0 ? 0 : 30); // active 1 second in 4
    if (r) finished.push(r);
  }
  assert.equal(finished.length, 2, 'two full 2-minute slots finished in 250s');
  assert.equal(finished[0].slot_start, '2026-10-23T08:00:00.000Z');
  assert.equal(finished[1].slot_start, '2026-10-23T08:02:00.000Z');
  for (const f of finished) {
    assert.ok(f.tracked_secs >= 118 && f.tracked_secs <= 120, 'tracked ' + f.tracked_secs);
    assert.ok(Math.abs(f.active_secs / f.tracked_secs - 0.25) < 0.03);
  }

  // a custom slot length is respected
  const m10 = new ActivityMeter({ slotMs: 600000 });
  m10.begin(t0);
  let n = 0;
  for (let s = 1; s <= 650; s++) if (m10.tick(t0 + s * 1000, 0)) n++;
  assert.equal(n, 1);

  // laptop sleeps for an hour: that gap is capped, not billed as tracked time
  const m2 = new ActivityMeter();
  m2.begin(t0);
  m2.tick(t0 + 1000, 0);
  m2.tick(t0 + 3600 * 1000, 0);
  assert.ok(m2.snapshot().tracked_secs <= 6);
});

test('OfflineQueue: persists across restarts and uploads in order', async () => {
  const dir = tmp();
  const q = new OfflineQueue(dir);
  q.add({ type: 'activity', payload: { n: 1 } });
  q.addScreenshot({ slot_start: 's', taken_at: 't', buf: Buffer.from('jpegdata') });
  q.add({ type: 'stop', ended_at: 'x' });
  const q2 = new OfflineQueue(dir); // simulate app restart / crash
  assert.equal(q2.size, 3);
  const order = [];
  const client = {
    postActivity: async () => order.push('activity'),
    postScreenshot: async ({ buf }) => { order.push('shot:' + buf.toString()); },
    stopTimer: async (e) => order.push('stop:' + e),
  };
  const r = await q2.flush(client);
  assert.deepEqual(order, ['activity', 'shot:jpegdata', 'stop:x']);
  assert.equal(r.remaining, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'shots')).length, 0, 'uploaded screenshot files are deleted');
});

test('OfflineQueue: keeps data when offline / 5xx / logged out, drops permanent rejections', async () => {
  const dir = tmp(); const q = new OfflineQueue(dir);
  q.add({ type: 'activity', payload: { n: 1, slot_start: 'a' } });
  q.add({ type: 'activity', payload: { n: 2, slot_start: 'b' } });

  let r = await q.flush({ postActivity: async () => { throw new NetworkError('down'); } });
  assert.equal(r.blocked, 'offline'); assert.equal(q.size, 2);
  r = await q.flush({ postActivity: async () => { throw new ApiError(503, 'busy'); } });
  assert.equal(r.blocked, 'server'); assert.equal(q.size, 2);
  r = await q.flush({ postActivity: async () => { throw new ApiError(401, 'expired'); } });
  assert.equal(r.blocked, 'auth'); assert.equal(q.size, 2);

  let calls = 0;
  r = await q.flush({ postActivity: async () => { if (calls++ === 0) throw new ApiError(400, 'bad data'); } });
  assert.equal(q.size, 0, 'poison item dropped, the next one still sent');
  assert.equal(calls, 2);
});

test('OfflineQueue: size cap sheds oldest screenshots first, keeps activity data', () => {
  const dir = tmp(); const q = new OfflineQueue(dir, { maxItems: 3 });
  q.add({ type: 'activity', payload: { n: 1 } });
  for (let i = 0; i < 4; i++) q.addScreenshot({ slot_start: 's', taken_at: String(i), buf: Buffer.from('x' + i) });
  assert.equal(q.size, 3);
  assert.equal(q.items[0].type, 'activity');
  assert.equal(fs.readdirSync(path.join(dir, 'shots')).length, 2);
});

// ---------------------------------------------------------------- v2: pause, ledger, recovery
const { Tracker } = require('../src/tracker');
const { MemoryStore } = require('../src/store');

test('ActivityMeter: pausing inside a slot adds up instead of overwriting; idle time can be taken back', () => {
  const t0 = Date.parse('2026-10-23T08:00:00Z');
  const m = new ActivityMeter();
  m.begin(t0);
  for (let s = 1; s <= 30; s++) m.tick(t0 + s * 1000, 0);
  assert.equal(m.snapshot().tracked_secs, 30);
  m.hold();                                   // paused for 40 seconds
  m.tick(t0 + 70 * 1000, 0);                  // first tick after resuming only re-arms the clock
  for (let s = 71; s <= 90; s++) m.tick(t0 + s * 1000, 30); // 20 more seconds with no input
  assert.equal(m.snapshot().tracked_secs, 50, '30s before + 20s after, the pause itself is not counted');
  m.discard(20);
  assert.equal(m.snapshot().tracked_secs, 30);
  m.discard(999);
  assert.equal(m.snapshot().tracked_secs, m.snapshot().active_secs, 'never below the active seconds');
});

test('OfflineQueue: newer activity for the same slot replaces the unsent one; purge drops later screenshots', async () => {
  const q = new OfflineQueue(tmp());
  q.add({ type: 'activity', payload: { slot_start: 'S1', entry_id: 1, tracked_secs: 10, active_secs: 5 } });
  q.add({ type: 'activity', payload: { slot_start: 'S1', entry_id: 1, tracked_secs: 40, active_secs: 20 } });
  q.add({ type: 'activity', payload: { slot_start: 'S2', entry_id: 1, tracked_secs: 5, active_secs: 5 } });
  assert.equal(q.size, 2);
  assert.equal(q.items[0].payload.tracked_secs, 40);
  q.addScreenshot({ slot_start: 'a', taken_at: '2026-10-23T08:00:00.000Z', buf: Buffer.from('1'), thumb: Buffer.from('t') });
  q.addScreenshot({ slot_start: 'b', taken_at: '2026-10-23T08:05:00.000Z', buf: Buffer.from('2') });
  assert.equal(fs.readdirSync(path.join(q.dir, 'shots')).length, 3);
  assert.equal(q.purgeShotsSince('2026-10-23T08:03:00.000Z'), 1);
  assert.equal(q.items.filter((x) => x.type === 'screenshot').length, 1);
  // two overlapping flushes share one run and never double-send
  let sends = 0;
  const client = { postActivity: async () => { sends++; await new Promise((r) => setTimeout(r, 20)); }, postScreenshot: async () => { sends++; } };
  const [a, b] = await Promise.all([q.flush(client), q.flush(client)]);
  assert.equal(sends, 3); assert.equal(a, b);
});

function mulberry(a) { return mulberry32(a); }
function rig({ idle = () => 0, seed = 3, start = Date.parse('2026-10-23T08:00:00Z'), store = new MemoryStore(), dir = tmp(), shotsPer10 = 2 } = {}) {
  const r = { clock: start, calls: [], events: [], shotsTaken: 0, idle };
  r.client = {
    startTimer: async (p, t) => { r.calls.push(['start', p, t]); return { entry_id: 7 }; },
    pauseTimer: async (reason, at) => { r.calls.push(['pause', reason, at]); return {}; },
    resumeTimer: async (at) => { r.calls.push(['resume', at]); return {}; },
    stopTimer: async (at, reason) => { r.calls.push(['stop', at, reason]); return {}; },
    idle: async (state, at) => { r.calls.push(['idle', state, at]); return {}; },
    postActivity: async (p) => { r.calls.push(['activity', p.slot_start, p.tracked_secs, p.active_secs]); return {}; },
    postScreenshot: async ({ taken_at }) => { r.calls.push(['shot', taken_at]); return {}; },
    ping: async () => ({ active: true }),
  };
  r.queue = new OfflineQueue(dir);
  r.store = store;
  r.make = () => new Tracker({
    client: r.client, queue: r.queue, store, now: () => r.clock, rng: mulberry(seed), idleSecs: () => r.idle(r.clock), tzOffsetMin: 300, shotsPer10,
    capture: async () => { r.shotsTaken++; return [{ buf: Buffer.from('jpg') }]; }, onEvent: (e) => r.events.push(e), pingEveryMs: 1e12, uploadEveryMs: 1e12,
  });
  r.tracker = r.make();
  r.run = async (secs) => { for (let i = 0; i < secs; i++) { r.clock += 1000; await r.tracker.tick(); } };
  return r;
}

test('Tracker: while paused no screenshots are taken and no activity is counted; breaks are recorded', async () => {
  const r = rig();
  await r.tracker.start(null);
  await r.run(10 * 60);
  const shotsBefore = r.shotsTaken;
  assert.equal(shotsBefore, 2, 'working: two screenshots in the 10-minute block');

  await r.tracker.pause({ reason: 'lunch' });
  assert.equal(r.tracker.status().paused, true);
  assert.equal(r.tracker.status().pause.reason, 'lunch');
  await r.run(30 * 60);
  assert.equal(r.shotsTaken, shotsBefore, 'not one capture during a 30 minute pause');
  assert.equal(r.tracker.status().pause.secs, 1800);
  assert.equal(r.tracker.status().todayBreakSecs, 1800);
  const activityWhilePaused = r.queue.items.filter((x) => x.type === 'activity' && x.payload.slot_start > '2026-10-23T08:10:00');
  assert.equal(activityWhilePaused.length, 0, 'no activity slots exist for the paused half hour');

  await r.tracker.resume();
  await r.run(10 * 60);
  assert.ok(r.shotsTaken > shotsBefore, 'capturing again after resume');

  await r.tracker.pause({ reason: 'prayer' });
  await r.run(10 * 60);
  const sum = await r.tracker.stop();      // stopping while paused is allowed
  assert.equal(sum.worked_secs, 20 * 60);
  assert.equal(sum.break_secs, 40 * 60);
  assert.equal(sum.break_count, 2);
  assert.deepEqual(sum.breaks.map((b) => [b.reason, b.secs, b.open]), [['lunch', 1800, false], ['prayer', 600, false]]);
  assert.equal(sum.sessions, 1);
  assert.equal(sum.first_start, '2026-10-23T08:00:00.000Z');
  assert.equal(sum.last_end, '2026-10-23T09:00:00.000Z');
  const order = r.calls.map((c) => c[0]).filter((c) => ['start', 'pause', 'resume', 'stop'].includes(c));
  assert.deepEqual(order, ['start', 'pause', 'resume', 'pause', 'stop']);
  const pauseCall = r.calls.find((c) => c[0] === 'pause');
  assert.equal(pauseCall[2], '2026-10-23T08:10:00.000Z', 'the pause is sent with the moment it really began');
});

test('Tracker: a block that already has its screenshots does not get more after pause/resume', async () => {
  const r = rig({ start: Date.parse('2026-10-23T08:00:00Z'), shotsPer10: 1 });
  await r.tracker.start(null);
  await r.run(595);                                    // nearly all of the first 10-minute block
  assert.equal(r.shotsTaken, 1);
  await r.tracker.pause({ reason: 'break' });
  await r.tracker.resume();
  await r.run(4);                                      // still the first block
  assert.equal(r.shotsTaken, 1, 'still one capture for that block');
});

test('Tracker: 1, 2 or 3 screenshots per 10 minutes, or none, and a change applies from the next block', async () => {
  for (const n of [0, 1, 2, 3]) {
    const r = rig({ shotsPer10: n, seed: 11 + n });
    await r.tracker.start(null);
    await r.run(30 * 60);
    assert.equal(r.shotsTaken, 3 * n, `${n} per 10 minutes over half an hour`);
    const blocks = new Map();
    for (const x of r.queue.items.filter((i) => i.type === 'screenshot')) blocks.set(x.slot_start, (blocks.get(x.slot_start) || 0) + 1);
    assert.ok([...blocks.values()].every((c) => c === n), 'each block has exactly its share');
  }
  const r = rig({ shotsPer10: 1 });
  await r.tracker.start(null);
  await r.run(10 * 60);
  r.tracker.configure({ shotsPer10: 0 });             // manager turned screenshots off mid-session
  await r.run(20 * 60);
  assert.equal(r.shotsTaken, 1, 'off means off, even while the timer runs');
  assert.ok(r.tracker.summary().worked_secs >= 30 * 60 - 1, 'and the time is still tracked');
});

test('Tracker: stopping needs no confirmation in the engine, but a stop always ends the session and uploads', async () => {
  const r = rig();
  await r.tracker.start(5, 9);
  assert.deepEqual(r.calls[0], ['start', 5, 9]);
  await r.run(30);
  await r.tracker.stop();
  assert.equal(r.tracker.status().mode, 'stopped');
  assert.equal(r.queue.size, 0);
  assert.equal(await r.tracker.pause({ reason: 'break' }), false, 'cannot pause a stopped timer');
  assert.equal(await r.tracker.resume(), false);
});

test('Tracker: walking away does NOT pause the timer; the stretch is marked idle and has no screenshots', async () => {
  const leftAt = Date.parse('2026-10-23T08:20:00Z'), backAt = Date.parse('2026-10-23T08:50:00Z');
  const r = rig({ idle: (clock) => (clock < leftAt || clock >= backAt ? 0 : Math.floor((clock - leftAt) / 1000)), shotsPer10: 3 });
  r.tracker.configure({ idleLimitSecs: 600 });
  await r.tracker.start(null);
  await r.run(35 * 60);
  const st = r.tracker.status();
  assert.equal(st.running, true, 'still running');
  assert.equal(st.paused, false);
  assert.equal(st.idle, true);
  assert.ok(r.events.some((e) => e.type === 'idle-start'));
  // nothing in the outbox was captured during the idle stretch (including the minutes before it was noticed)
  const inIdle = r.queue.items.filter((x) => x.type === 'screenshot' && x.taken_at >= '2026-10-23T08:20:00.000Z');
  assert.equal(inIdle.length, 0);
  await r.run(25 * 60);                               // back at 08:50, works until 09:00
  assert.equal(r.tracker.status().idle, false);
  assert.ok(r.events.some((e) => e.type === 'idle-end' && e.idleSecs === 30 * 60));
  const sum = await r.tracker.stop();
  assert.equal(sum.worked_secs, 60 * 60, 'the idle half hour still counts as worked time');
  assert.equal(sum.idle_secs, 30 * 60, 'and is reported as idle');
  assert.equal(sum.break_secs, 0);
  assert.deepEqual(sum.breaks.map((b) => [b.type, b.counted, b.secs]), [['idle', true, 1800]]);
  assert.ok(r.queue.size === 0);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'idle').map((c) => c.slice(1)), [['start', '2026-10-23T08:20:00.000Z'], ['end', '2026-10-23T08:50:00.000Z']]);
  assert.ok(!r.calls.some((c) => c[0] === 'pause'), 'no pause was sent');
  assert.ok(r.calls.filter((c) => c[0] === 'shot').some((c) => c[1] >= '2026-10-23T08:50:00.000Z'), 'screenshots resume after input returns');
});

test('Tracker: a sleeping computer is recorded as away (not counted) and the timer carries on by itself', async () => {
  const r = rig();
  await r.tracker.start(null);
  await r.run(60);
  const sleptAt = r.clock;
  r.clock += 2 * 3600 * 1000;                        // lid closed for two hours
  await r.tracker.tick();
  assert.equal(r.tracker.status().running, true, 'running again after wake');
  assert.ok(r.events.some((e) => e.type === 'away-resumed'));
  await r.run(60);
  await r.tracker.sync();
  const sum = r.tracker.summary();
  assert.equal(sum.worked_secs, 120, 'the two hours asleep are not work');
  assert.equal(sum.break_secs, 0, 'and not a break either');
  assert.equal(sum.away_secs, 7200);
  const p = r.calls.find((c) => c[0] === 'pause');
  assert.deepEqual([p[1], p[2]], ['away', new Date(sleptAt).toISOString()]);
  assert.ok(r.calls.some((c) => c[0] === 'resume'));
});

test('Tracker: relaunch within a minute carries on; a long-closed app ends the session at its last sign of life', async () => {
  const store = new MemoryStore();
  const r = rig({ store });
  await r.tracker.start(null);
  await r.run(10 * 60);
  r.tracker.persist(true);
  r.clock += 20000;                                  // quick relaunch (e.g. after granting a permission)
  const again = r.make();
  assert.equal(again.status().mode, 'running');
  assert.equal(again.status().recovered, null);
  assert.ok(again.summary().worked_secs >= 10 * 60);

  const store2 = new MemoryStore();
  const r2 = rig({ store: store2 });
  await r2.tracker.start(null);
  await r2.run(15 * 60);
  r2.tracker.persist(true);
  const lastAlive = r2.clock;
  r2.clock += 40 * 60 * 1000;                        // restarted the computer; back 40 minutes later, same day
  const back = r2.make();
  assert.equal(back.status().mode, 'running', 'the timer continues after a restart on the same day');
  assert.equal(back.status().recovered.continued, true);
  assert.equal(back.status().recovered.endedAtMs, lastAlive);
  assert.equal(back.summary().worked_secs, 15 * 60, 'the 40 minutes it was off are not counted');
  assert.equal(back.summary().away_secs, 40 * 60);
  const items = r2.queue.items.filter((x) => x.type === 'pause' || x.type === 'resume');
  assert.deepEqual(items.map((x) => [x.type, x.reason || null, x.at]), [['pause', 'away', new Date(lastAlive).toISOString()], ['resume', null, new Date(r2.clock).toISOString()]]);
  back.ackRecovered();
  assert.equal(back.status().recovered, null);

  // left running overnight (computer shut down in the evening, turned on next morning): ends at the last sign of life
  const store3 = new MemoryStore();
  const r3 = rig({ store: store3, start: Date.parse('2026-10-23T12:00:00Z') });   // 5 PM in Pakistan
  await r3.tracker.start(null);
  await r3.run(15 * 60);
  r3.tracker.persist(true);
  const off = r3.clock;
  r3.clock = Date.parse('2026-10-24T04:00:00Z');      // 9 AM next day
  const morning = r3.make();
  assert.equal(morning.status().mode, 'stopped');
  assert.deepEqual(morning.status().recovered, { endedAtMs: off });
  const stop = r3.queue.items.find((x) => x.type === 'stop');
  assert.equal(stop.ended_at, new Date(off).toISOString()); assert.equal(stop.reason, 'quit');
});

test('Tracker: if the server closed our session during a long outage, a new one is opened', async () => {
  const r = rig();
  await r.tracker.start(null);
  await r.run(60);
  let opened = 0;
  r.client.ping = async () => ({ active: false });
  r.client.startTimer = async () => { opened++; return { entry_id: 99 }; };
  await r.tracker.sync();
  await r.tracker.heartbeat();
  assert.equal(opened, 1);
  assert.equal(r.tracker.entryId, 99);
  assert.ok(r.events.some((e) => e.type === 'reconnected'));
});

test('Tracker: a laptop that sleeps through the night stops the timer at the moment it went to sleep', async () => {
  const r = rig({ start: Date.parse('2026-10-23T12:00:00Z') });  // 5 PM in Pakistan
  await r.tracker.start(null);
  await r.run(30 * 60);
  const slept = r.clock;
  r.clock = Date.parse('2026-10-24T04:00:00Z');                    // 9 AM next day
  await r.tracker.tick();
  assert.equal(r.tracker.status().mode, 'stopped');
  assert.ok(r.events.some((e) => e.type === 'away-stopped'));
  const stop = r.calls.find((c) => c[0] === 'stop');
  assert.equal(stop[1], new Date(slept).toISOString());
  assert.equal(r.tracker.summary('2026-10-23').worked_secs, 30 * 60);
});

test('queue: a newer activity total that arrives while the older one is uploading is still sent', async () => {
  const q = new OfflineQueue(tmp());
  const sent = [];
  let release;
  const client = { postActivity: (p) => { sent.push(p.tracked_secs); return sent.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(); } };
  q.add({ type: 'activity', payload: { slot_start: 's', entry_id: 1, tracked_secs: 10 } });
  const run = q.flush(client);
  await new Promise((r) => setImmediate(r));
  q.add({ type: 'activity', payload: { slot_start: 's', entry_id: 1, tracked_secs: 20 } });   // arrives mid-upload
  q.add({ type: 'activity', payload: { slot_start: 's', entry_id: 1, tracked_secs: 30 } });   // replaces the 20, not the 10 in flight
  release();
  await run;
  assert.deepEqual(sent, [10, 30]);
  assert.equal(q.size, 0);
});

test('pickShotTimes: two per 10 minutes are spread out, never seconds apart, also across slots', () => {
  const TEN = 10 * 60 * 1000;
  let minGap = Infinity, maxGap = 0, prev = null;
  for (let seed = 1; seed <= 400; seed++) {
    const s0 = seed * TEN;
    const times = pickShotTimes(s0, mulberry32(seed), { slotMs: TEN, min: 2, max: 2 });
    assert.equal(times.length, 2);
    for (const t of times) { assert.ok(t > s0 && t < s0 + TEN); if (prev != null) { minGap = Math.min(minGap, t - prev); maxGap = Math.max(maxGap, t - prev); } prev = t; }
  }
  assert.ok(minGap >= 2 * 60 * 1000, `at least 2 minutes apart (was ${minGap / 1000}s)`);
  assert.ok(maxGap <= 8 * 60 * 1000, `at most 8 minutes apart (was ${maxGap / 1000}s)`);
});
