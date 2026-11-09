'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeEnv, T0, MIN } = require('./helpers');
const { createApp } = require('../app');
const { hashPassword } = require('../auth');

let env, dev, ops;
before(async () => {
  env = await makeEnv();
  const { ok, tokens } = env;
  dev = await ok('POST', '/api/teams', { token: tokens.owner, body: { name: 'Dev' } });
  ops = await ok('POST', '/api/teams', { token: tokens.owner, body: { name: 'Ops' } });
  await env.person('alice', 'Alice', { team_id: dev.id });
  await env.person('carol', 'Carol', { team_id: ops.id });
  const mia = await env.person('mia', 'Mia', { role: 'manager', team_id: dev.id });
  await ok('PATCH', `/api/users/${mia.id}`, { token: tokens.owner, body: { manages: [dev.id] } });
  await env.person('max', 'Max', { role: 'manager', team_id: ops.id });
});
after(() => env.close());

// Minimal SSE client
async function listen(token) {
  const ctl = new AbortController();
  const res = await fetch(env.base + '/api/events', { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const dec = new TextDecoder();
  (async () => {
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) { const ev = JSON.parse(line.slice(6)); if (ev.type !== 'ping') events.push(ev); }   // pings only keep the line warm
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, close: () => ctl.abort() };
}
const settle = () => new Promise((r) => setTimeout(r, 150));

test('live events reach exactly the people allowed to see them', async () => {
  const { ok, tokens } = env;
  const [a, c, mia, max, owner] = await Promise.all(['alice', 'carol', 'mia', 'max', 'owner'].map((k) => listen(tokens[k])));
  await settle();
  env.set(T0);
  await ok('POST', '/api/timer/start', { token: tokens.alice, body: {} });
  await settle();
  const types = (l) => l.events.map((e) => e.type);
  assert.deepEqual(types(a), ['timer'], 'Alice hears about herself');
  assert.deepEqual(types(mia), ['timer'], 'Mia manages Dev');
  assert.deepEqual(types(max), ['timer'], 'Max has no team limits');
  assert.deepEqual(types(owner), ['timer']);
  assert.deepEqual(types(c), [], 'Carol (Ops) must not hear about Alice');
  assert.ok(a.events[0].user_id && !('name' in a.events[0]), 'events carry ids, never data');

  env.advance(5 * MIN);
  await ok('POST', '/api/timer/pause', { token: tokens.alice, body: { reason: 'break' } });
  await env.shot('alice').catch(() => {});
  await settle();
  assert.ok(types(mia).includes('pause'));
  assert.deepEqual(types(c), []);

  await ok('POST', '/api/projects', { token: tokens.owner, body: { name: 'Everyone hears this' } });
  await settle();
  assert.ok(types(c).includes('projects'), 'company-wide changes go to everybody');
  [a, c, mia, max, owner].forEach((l) => l.close());
});

test('the dashboard files are never served from a stale browser cache', async () => {
  const r1 = await fetch(env.base + '/');
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('cache-control'), 'no-cache');
  assert.match(r1.headers.get('content-security-policy'), /default-src 'self'/);
  const etag = r1.headers.get('etag');
  assert.ok(etag);
  const r2 = await fetch(env.base + '/', { headers: { 'If-None-Match': etag } });
  assert.equal(r2.status, 304);
  for (const f of ['/css/app.css', '/js/main.js']) {
    const r = await fetch(env.base + f);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('cache-control'), 'no-cache', f);
  }
  assert.equal((await fetch(env.base + '/..%2f..%2fpackage.json')).status, 404, 'no path traversal');
  assert.equal((await fetch(env.base + '/nope.js')).status, 404);
  const spa = await fetch(env.base + '/timesheets');
  assert.equal(spa.status, 200, 'deep links load the app shell');
  const api = await fetch(env.base + '/api/settings');
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
});

test('login throttling and session expiry', async () => {
  const e = await makeEnv();
  try {
    await e.person('t1', 'T1');
    for (let i = 0; i < 10; i++) assert.equal((await e.api('POST', '/api/auth/login', { body: { email: 't1@test.com', password: 'wrong-wrong' } })).status, 401);
    assert.equal((await e.api('POST', '/api/auth/login', { body: { email: 't1@test.com', password: 't1-pass-123' } })).status, 429);
    e.app.db.prepare("UPDATE sessions SET created_at = datetime('now', '-31 days') WHERE user_id = (SELECT id FROM users WHERE email = 't1@test.com')").run();
    assert.equal((await e.api('GET', '/api/me', { token: e.tokens.t1 })).status, 401);
  } finally { await e.close(); }
});

test('a v1 database is upgraded in place without losing anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-v1-'));
  const file = path.join(dir, 'tracker.db');
  const v1 = new DatabaseSync(file);
  v1.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','manager','employee')), pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, consented_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE time_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id INTEGER REFERENCES projects(id), started_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE activity_slots (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL, slot_start TEXT NOT NULL, tracked_secs INTEGER NOT NULL, active_secs INTEGER NOT NULL, top_app TEXT, UNIQUE (user_id, slot_start));
    CREATE TABLE screenshots (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, slot_start TEXT NOT NULL, taken_at TEXT NOT NULL, file TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, clock_in TEXT, clock_out TEXT, status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','late','leave','absent')), UNIQUE (user_id, day));
  `);
  const pw = hashPassword('ownerpass1'), pe = hashPassword('empass-1234');
  v1.prepare("INSERT INTO users (email,name,role,pw_salt,pw_hash) VALUES ('owner@old.com','Old Owner','owner',?,?)").run(pw.salt, pw.hash);
  v1.prepare("INSERT INTO users (email,name,role,pw_salt,pw_hash,consented_at) VALUES ('emp@old.com','Old Emp','employee',?,?,'2026-01-01T00:00:00Z')").run(pe.salt, pe.hash);
  v1.prepare("INSERT INTO projects (name) VALUES ('Client site')").run();
  v1.prepare("INSERT INTO time_entries (user_id, project_id, started_at, ended_at) VALUES (2, 1, '2026-10-22T04:00:00.000Z', '2026-10-22T12:00:00.000Z')").run();
  v1.prepare("INSERT INTO attendance (user_id, day, status) VALUES (2, '2026-10-21', 'leave')").run();
  v1.close();

  const app = createApp({ dbFile: file, dataDir: dir, now: () => T0 });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal(app.db.prepare('PRAGMA user_version').get().user_version, 36);
    const login = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'emp@old.com', password: 'empass-1234' }) })).json();
    assert.ok(login.token);
    const get = async (u) => (await fetch(base + u, { headers: { Authorization: `Bearer ${login.token}` } })).json();
    const day = await get('/api/users/me/day?day=2026-10-22');
    assert.equal(day.worked_secs, 8 * 3600, 'old time entries still count');
    const g = await get('/api/timesheets?from=2026-10-21&to=2026-10-22&user_id=me');
    assert.equal(g.rows[0].cells['2026-10-21'].status, 'leave', 'old leave marks became approved time off');
    assert.equal(app.db.prepare("SELECT tracks_time FROM users WHERE email = 'owner@old.com'").get().tracks_time, 0);
    assert.equal(app.db.prepare("SELECT tracks_time FROM users WHERE email = 'emp@old.com'").get().tracks_time, 1);
    // old projects get a key, stay open to everyone, and people who worked on them become members
    const [p] = await get('/api/projects');
    assert.equal(p.key, 'CS');
    assert.equal(p.access, 'everyone');
    assert.deepEqual(p.members.map((m) => m.name), ['Old Emp']);
  } finally { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
