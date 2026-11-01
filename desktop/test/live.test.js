'use strict';
// The desktop app's live line to the real server: a boost clip is heard straight away, not on the next
// 20-second check, and the line comes back by itself after it drops.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server/app');
const { Client } = require('../src/client');
const { LiveFeed } = require('../src/live');

test('a boost clip reaches the app within a second, and the live line reconnects after a drop', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-live-'));
  const app = createApp({ dataDir, webDir: dataDir });
  app.seedOwner('owner@t.com', 'Owner Basit', 'ownerpass1');
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const HEAD = { 'X-Workhelm-App': '0.9.19 darwin arm64' };
  let ownerT = null;
  const owner = new Client({ baseUrl: base, getToken: () => ownerT });
  ownerT = (await owner.login('owner@t.com', 'ownerpass1')).token;
  await owner.req('POST', '/api/users', { email: 'ali@t.com', name: 'Ali Raza', password: 'ali-pass-1234', role: 'employee' });
  let aliT = null;
  const ali = new Client({ baseUrl: base, getToken: () => aliT, headers: HEAD });
  aliT = (await ali.login('ali@t.com', 'ali-pass-1234')).token;
  await ali.acceptPolicy();
  const proj = await owner.req('POST', '/api/projects', { name: 'P', access: 'everyone' });
  await ali.req('POST', '/api/timer/start', { project_id: proj.id });

  const events = [];
  let waiter = null;
  const feed = new LiveFeed({ baseUrl: base, getToken: () => aliT, headers: HEAD, onEvent: (e) => { events.push(e); if (waiter) waiter(e); }, wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
  const next = (type) => new Promise((ok, no) => { const t = setTimeout(() => no(new Error(`no ${type} event`)), 3000); waiter = (e) => { if (e.type === type) { clearTimeout(t); waiter = null; ok(e); } }; });
  try {
    feed.start();
    for (let i = 0; i < 50 && !feed.connected; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(feed.connected, 'connected');
    const t0 = Date.now();
    const heard = next('notify');
    const b = await owner.req('POST', '/api/boost', { vibe: 'win', clip: true });
    assert.equal(b.popped_up, 1);
    await heard;
    assert.ok(Date.now() - t0 < 1000, `heard in ${Date.now() - t0} ms`);
    const n = await ali.notifications({ after: 0 });
    assert.ok((n.items || n).some((x) => x.kind === 'boost_clip'), 'the app fetches the clip notification');

    // the line drops (the server restarts its connections): it comes back on its own
    feed.reconnect();
    for (let i = 0; i < 100 && !feed.connected; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(feed.connected, 'reconnected');
    // a direct message comes down the reconnected line too
    const again = next('notify');
    const me = await ali.me();
    const dm = await owner.req('POST', '/api/team/dm', { user_id: (me.user || me).id });
    await owner.req('POST', `/api/chat/threads/${dm.id}/messages`, { body: 'Got a minute?' });
    await again;

    // signed out: it stops using the old sign-in
    aliT = null; feed.reconnect();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(feed.connected, false);
  } finally {
    feed.stop();
    await new Promise((r) => app.server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
