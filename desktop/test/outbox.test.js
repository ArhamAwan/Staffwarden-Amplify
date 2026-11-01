'use strict';
// Screenshots waiting to upload are encrypted on the employee's disk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { OfflineQueue } = require('../src/queue');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('private screen contents')]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wh-ob-'));

test('waiting screenshots are unreadable on disk, and upload as the original picture', async () => {
  const dir = tmp(), key = crypto.randomBytes(32);
  const q = new OfflineQueue(dir, { key });
  q.addScreenshot({ slot_start: '2026-10-27T13:00:00.000Z', taken_at: '2026-10-27T13:02:00.000Z', buf: JPEG, thumb: JPEG.subarray(0, 10) });
  const files = fs.readdirSync(path.join(dir, 'shots'));
  assert.equal(files.length, 2);
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, 'shots', f));
    assert.ok(f.endsWith('.bin'));
    assert.ok(!raw.includes(Buffer.from('private screen contents')), 'not readable from the folder');
    assert.notDeepEqual(raw.subarray(0, 3), JPEG.subarray(0, 3), 'not even recognisable as a picture');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'shots', f)).mode & 0o077, 0, 'only this user can read it');
  }
  const sent = [];
  const client = { postScreenshot: async (p) => { sent.push(p); return {}; } };
  await q.send(client, q.items[0]);
  assert.deepEqual(sent[0].buf, JPEG);
  assert.deepEqual(sent[0].thumb, JPEG.subarray(0, 10));
});

test('a screenshot saved by an older version (not encrypted) still uploads; one that was tampered with is dropped', async () => {
  const dir = tmp(), key = crypto.randomBytes(32);
  const q = new OfflineQueue(dir, { key });
  const old = path.join(dir, 'shots', 'old.jpg');
  fs.writeFileSync(old, JPEG);
  q.add({ type: 'screenshot', slot_start: 'a', taken_at: 'b', file: old, thumbFile: null });
  q.addScreenshot({ slot_start: 'c', taken_at: 'd', buf: JPEG });
  const bin = q.items[1].file;
  const b = fs.readFileSync(bin); b[b.length - 1] ^= 1; fs.writeFileSync(bin, b);
  const sent = [];
  const client = { postScreenshot: async (p) => { sent.push(p); return {}; } };
  await q.send(client, q.items[0]);
  await q.send(client, q.items[1]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].buf, JPEG);
});
