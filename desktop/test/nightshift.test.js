'use strict';
// A night shift (6 PM to 3:30 AM, Pakistan time) is one work day in the desktop app: midnight does not
// start a new day, and the next evening's shift does. The server sends the shift; the app shifts its day
// by day_start_min (10:30 AM for this shift).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Tracker } = require('../src/tracker');
const { OfflineQueue } = require('../src/queue');

const MIN = 60000;
const PKT = 300, DAY_START = 630;                  // UTC+5, shift 18:00-03:30 -> work day starts 10:30
const pkt = (day, h, m = 0) => Date.parse(`${day}T00:00:00Z`) + ((h - 5) * 60 + m) * MIN;

function memStore() { let v = null; return { load: () => v, save: (x) => { v = JSON.parse(JSON.stringify(x)); } }; }
function rig(start, store = memStore(), endOnWake) {
  const r = { clock: start, events: [] };
  const client = new Proxy({}, { get: (_t, k) => (k === 'startTimer' ? async () => ({ entry_id: 1 }) : k === 'ping' ? async () => ({ active: true }) : async () => ({})) });
  r.make = (tz = PKT - DAY_START) => new Tracker({
    client, queue: new OfflineQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-ns-'))), store, now: () => r.clock, rng: () => 0.5, idleSecs: () => 0,
    tzOffsetMin: tz, shotsPer10: 0, ...(endOnWake ? { endOnWake } : {}), capture: async () => [], onEvent: (e) => r.events.push(e), pingEveryMs: 1e12, uploadEveryMs: 1e12,
  });
  r.t = r.make();
  r.run = async (secs, step = 1) => { for (let i = 0; i < secs; i += step) { r.clock += step * 1000; await r.t.tick(); } };
  return r;
}

test('Monday 6 PM to Tuesday 3:30 AM is all Monday; Tuesday 6 PM starts a fresh day', async () => {
  const r = rig(pkt('2026-10-26', 18));
  await r.t.start(null);
  await r.run(6 * 3600 - 60);                        // to 11:59 PM
  assert.equal(r.t.today(), '2026-10-26');
  await r.run(2 * 60);                               // past midnight
  assert.equal(r.t.today(), '2026-10-26', 'after midnight it is still Monday\'s shift');
  assert.equal(r.t.status().mode, 'running', 'midnight does not stop or reset anything');
  await r.run(3.5 * 3600 - 60);                      // to 3:30 AM Tuesday
  const sum = await r.t.stop();
  assert.equal(sum.day, '2026-10-26');
  assert.equal(sum.worked_secs, 9.5 * 3600, 'the whole 9.5-hour shift counts for Monday');

  r.clock = pkt('2026-10-27', 18);                   // back on Tuesday evening
  assert.equal(r.t.today(), '2026-10-27');
  assert.equal(r.t.status().todayWorkedSecs, 0, 'Tuesday\'s shift starts from zero');
  await r.t.start(null);
  await r.run(600);
  assert.equal(r.t.status().todayWorkedSecs, 600);
});

test('a laptop that sleeps across midnight carries on in the same shift', async () => {
  const r = rig(pkt('2026-10-26', 23, 30));
  await r.t.start(null);
  await r.run(15 * 60);                              // 11:45 PM
  r.clock = pkt('2026-10-27', 0, 20);                // lid closed until 12:20 AM
  await r.run(5);
  assert.equal(r.t.status().mode, 'running', 'not stopped at midnight');
  assert.ok(r.events.some((e) => e.type === 'away-resumed'));
  assert.ok(!r.events.some((e) => e.type === 'away-stopped'));
});

test('restarting the app after midnight keeps the running timer', async () => {
  const store = memStore();
  const r = rig(pkt('2026-10-26', 23, 50), store);
  await r.t.start(null);
  await r.run(5 * 60);
  r.t.persist(true);
  r.clock = pkt('2026-10-27', 0, 40);                // computer restarted, back 50 minutes later
  const again = r.make();                            // the remembered work day is used straight away
  assert.equal(again.status().mode, 'running');
  assert.equal(again.recovered && again.recovered.continued, true);
});

test('a computer that sleeps after the shift (or for hours) ends the session when it went to sleep, not at each brief wake-up', async () => {
  // what the app decides: after 3:30 AM + 1 hour leeway, or a 3-hour sleep, the work was over
  const offShift = (slept) => slept >= pkt('2026-10-27', 4, 30) && slept < pkt('2026-10-27', 17);
  const decide = (a, b) => (b - a >= 3 * 3600000 ? 'long' : offShift(a) ? 'off-shift' : false);
  const r = rig(pkt('2026-10-27', 4, 0), memStore(), decide);
  await r.t.start(null);
  await r.run(50 * 60);                              // 4:50 AM, shift long over
  const sleptAt = r.clock;
  r.clock += 15 * 60000;                             // Mac sleeps 15 minutes, then a brief dark wake
  await r.run(5);
  assert.equal(r.t.status().mode, 'stopped', 'stopped instead of starting again');
  const ev = r.events.find((e) => e.type === 'away-stopped');
  assert.deepEqual([ev.atMs, ev.why], [sleptAt, 'off-shift']);
  const before = r.events.length;
  r.clock += 15 * 60000; await r.run(5);            // further wake-ups do nothing
  assert.equal(r.events.length, before);

  const s = rig(pkt('2026-10-27', 19), memStore(), decide);   // during the shift: a short sleep carries on
  await s.t.start(null);
  await s.run(60);
  s.clock += 20 * 60000; await s.run(5);
  assert.equal(s.t.status().mode, 'running');
  s.clock += 4 * 3600000; await s.run(5);           // a 4-hour sleep in the middle of the shift ends it
  assert.equal(s.t.status().mode, 'stopped');
  assert.equal(s.events.find((e) => e.type === 'away-stopped').why, 'long');
});

test('a computer shut down with the timer on does not pick it up again the next morning', async () => {
  const decide = (a, b) => (b - a >= 3 * 3600000 ? 'long' : (a >= pkt('2026-10-27', 4, 30) && a < pkt('2026-10-27', 17)) ? 'off-shift' : false);
  // shut down at 3:20 AM without pressing Stop; the computer (and Workhelm) start again at 9:05 AM
  const store = memStore();
  const r = rig(pkt('2026-10-27', 2, 0), store, decide);
  await r.t.start(null);
  await r.run(80 * 60);
  r.t.persist(true);
  const offAt = r.clock;
  r.clock = pkt('2026-10-27', 9, 5);
  const next = r.make();
  assert.equal(next.status().mode, 'stopped', 'not running again in the morning');
  assert.equal(next.recovered.endedAtMs, offAt, 'the session ended when the computer went off');
  assert.ok(next.queue.items.some((x) => x.type === 'stop'), 'and the server is told so');

  // a restart in the middle of the shift still carries on
  const s2 = memStore();
  const q = rig(pkt('2026-10-26', 21, 0), s2, decide);
  await q.t.start(null);
  await q.run(60);
  q.t.persist(true);
  q.clock += 6 * 60000;                              // back after a 6-minute restart
  assert.equal(q.make().status().mode, 'running');
});
