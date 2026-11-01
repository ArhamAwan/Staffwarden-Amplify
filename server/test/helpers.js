'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../app');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// Friday 2026-10-23, 09:00 in Pakistan (UTC+5)
const T0 = Date.UTC(2026, 9, 23, 4, 0, 0);
const MIN = 60000;

async function makeEnv(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-test-'));
  const clock = { t: opts.start ?? T0 };
  const app = createApp({ dataDir, webDir: path.join(__dirname, '..', '..', 'web'), now: () => clock.t, ...opts.app });
  app.seedOwner('owner@test.com', 'Owner', 'ownerpass1');
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function api(method, url, { token, body, raw } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : (raw ? Buffer.from(await res.arrayBuffer()) : await res.text());
    return { status: res.status, data, headers: res.headers };
  }
  const ok = async (method, url, o) => { const r = await api(method, url, o); assert.equal(r.status, 200, `${method} ${url} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

  async function login(email, password) {
    const r = await api('POST', '/api/auth/login', { body: { email, password } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.token;
  }
  const tokens = { owner: await login('owner@test.com', 'ownerpass1') };

  // create + sign in + accept the policy
  async function person(key, name, { role = 'employee', team_id, ...extra } = {}) {
    const email = `${key}@test.com`;
    const r = await api('POST', '/api/users', { token: tokens.owner, body: { email, name, password: `${key}-pass-123`, role, team_id, ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    tokens[key] = await login(email, `${key}-pass-123`);
    await ok('POST', '/api/me/consent', { token: tokens[key] });
    return r.data;
  }
  const set = (t) => { clock.t = t; };
  const advance = (ms) => { clock.t += ms; };
  const slotOf = (ms, slotMs = 120000) => new Date(Math.floor(ms / slotMs) * slotMs).toISOString();
  const shot = (key, atMs = clock.t) => api('POST', '/api/screenshots', { token: tokens[key], body: { slot_start: slotOf(atMs), taken_at: new Date(atMs).toISOString(), image_base64: PNG.toString('base64') } });
  const activity = (key, slotMs, tracked, active, entryId) => api('POST', '/api/activity', { token: tokens[key], body: { slot_start: new Date(slotMs).toISOString(), tracked_secs: tracked, active_secs: active, entry_id: entryId } });
  const ping = (key) => ok('POST', '/api/timer/ping', { token: tokens[key] });

  async function close() {
    await new Promise((r) => app.server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return { app, api, ok, login, tokens, person, clock, set, advance, shot, activity, ping, slotOf, base, dataDir, close, PNG };
}

module.exports = { makeEnv, T0, MIN, PNG };
