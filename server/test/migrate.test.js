'use strict';
// Every database version the server has ever had must open with the current code and end up current.
// (0.9.13 forgot to add the newest step to the list, so a v10 database was sent down the v3 path.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../db');

test('a database at each earlier current-schema version is upgraded by the right step, without touching data', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-mig-')), 't.db');
  let db = openDb(file);
  const latest = db.prepare('PRAGMA user_version').get().user_version;
  db.prepare("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('a@b.c','A','owner','s','h','2026-01-01')").run();
  db.close();
  for (const v of [latest - 1]) {
    const raw = new (require('node:sqlite').DatabaseSync)(file);
    raw.exec(`PRAGMA user_version = ${v}`); raw.close();
    db = openDb(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, latest, `from v${v}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    db.close();
  }
});

// web22 shipped double ticks and the boost clip inside the v16 and v19 steps, so a server already on v19
// skipped them and the chat page failed with "no such table: chat_delivered". Build exactly that database
// (v19 without the new pieces) and use the chat and boost routes on it.
test('a v19 database from before double ticks and the boost clip gets them, and chat works', async () => {
  const { makeEnv } = require('./helpers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-v19-'));
  const file = path.join(dir, 'w.db');
  let db = openDb(file);
  db.exec('DROP TABLE chat_delivered; DROP TABLE boost_popups');
  db.exec('ALTER TABLE boosts DROP COLUMN clip; ALTER TABLE users DROP COLUMN boost_popup; ALTER TABLE users DROP COLUMN boost_corner');
  db.exec('PRAGMA user_version = 19');
  db.close();
  const env = await makeEnv({ app: { dbFile: file } });
  try {
    const { ok, person, tokens } = env;
    assert.equal(env.app.db.prepare('PRAGMA user_version').get().user_version, 29);
    await person('ali', 'Ali Raza');
    const threads = await ok('GET', '/api/team/threads', { token: tokens.ali });
    const company = (threads.threads || threads).find((t) => t.kind === 'company') || (threads.threads || threads)[0];
    await ok('POST', `/api/chat/threads/${company.id}/messages`, { token: tokens.owner, body: { body: 'hello' } });
    await ok('GET', '/api/team/threads', { token: tokens.owner });
    await ok('GET', '/api/team/unread', { token: tokens.ali });
    await ok('GET', `/api/chat/threads/${company.id}/messages`, { token: tokens.ali });
    await ok('GET', '/api/notifications', { token: tokens.ali });
    await ok('GET', '/api/me/boost-prefs', { token: tokens.ali });
  } finally {
    await env.close();
  }
});

test('a server already on v22 (web34/web35) gets the test-boost column too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-v22-'));
  const file = path.join(dir, 't.db');
  let db = openDb(file);
  db.exec('ALTER TABLE boosts DROP COLUMN test'); db.exec('PRAGMA user_version = 22'); db.close();
  db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 29);
  assert.ok(db.prepare('PRAGMA table_info(boosts)').all().some((c) => c.name === 'test'));
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
