'use strict';
// Someone who works on an iPad while this computer keeps their timer: nobody touches the keyboard or mouse,
// and that must not turn their work into idle time or a 0% activity score.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Tracker } = require('../src/tracker');
const { OfflineQueue } = require('../src/queue');

function rig(otherDevice) {
  const r = { clock: Date.parse('2026-10-27T13:00:00Z'), lastInput: Date.parse('2026-10-27T13:00:00Z'), events: [] };
  const client = new Proxy({}, { get: (_t, k) => (k === 'startTimer' ? async () => ({ entry_id: 1 }) : k === 'ping' ? async () => ({ active: true }) : async () => ({})) });
  r.queue = new OfflineQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-od-')));
  r.t = new Tracker({
    client, queue: r.queue, now: () => r.clock, rng: () => 0.5, idleSecs: () => Math.round((r.clock - r.lastInput) / 1000),
    shotsPer10: 2, idleLimitSecs: 600, otherDevice, tzOffsetMin: 300,
    capture: async () => [{ buf: Buffer.from('img'), thumb: Buffer.from('t') }],
    onEvent: (e) => r.events.push(e), pingEveryMs: 1e12, uploadEveryMs: 60000,
  });
  r.run = async (secs) => { for (let i = 0; i < secs; i++) { r.clock += 1000; await r.t.tick(); } };
  r.kinds = () => r.queue.items.map((x) => x.type);
  return r;
}

test('normally, an hour with no keyboard or mouse is marked idle and no screenshots are taken in it', async () => {
  const r = rig(false);
  await r.t.start(null);
  await r.run(3600);
  assert.ok(r.events.some((e) => e.type === 'idle-start'));
  assert.ok(r.t.status().idle);
  assert.ok(r.kinds().includes('activity'));
});

test('working on another device: the hour counts as plain work, screenshots carry on, activity is not measured', async () => {
  const r = rig(true);
  await r.t.start(null);
  await r.run(3600);
  const st = r.t.status();
  assert.equal(r.events.filter((e) => e.type === 'idle-start').length, 0, 'never marked idle');
  assert.ok(!st.idle);
  assert.equal(st.todayWorkedSecs, 3600);
  assert.equal(st.todayIdleSecs, 0);
  assert.equal(st.activityPct, null, 'shown as not measured, not as 0%');
  assert.equal(st.otherDevice, true);
  assert.ok(r.events.filter((e) => e.type === 'screenshot').length >= 10, 'screenshots follow the person\'s setting');
  assert.ok(!r.kinds().includes('activity'), 'no keyboard and mouse figures are sent');
  assert.ok(!r.kinds().includes('idle'));
});

test('turning it on while someone is already marked idle ends the idle stretch', async () => {
  const r = rig(false);
  await r.t.start(null);
  await r.run(900);
  assert.ok(r.t.status().idle);
  r.t.configure({ otherDevice: true });
  assert.ok(!r.t.status().idle);
  await r.run(900);
  assert.ok(!r.t.status().idle, 'and it stays that way');
  r.t.configure({ otherDevice: false });
  await r.run(5);
  assert.ok(r.t.status().idle, 'turning it off brings idle marking back');
});
