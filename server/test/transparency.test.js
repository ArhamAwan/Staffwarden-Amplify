'use strict';
// Transparency for employees: they are told about every change made to their tracking, schedule or time;
// they see what changed since they agreed (and agree again when more would be captured); they can explain
// their day and ask for missing time; they see their colleagues' status; and old apps cannot start a timer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv, T0, MIN } = require('./helpers');

let env, nia, ray, mo;
before(async () => {
  env = await makeEnv();
  const t = await env.ok('POST', '/api/teams', { token: env.tokens.owner, body: { name: 'Night desk' } });
  nia = await env.person('nia', 'Nia', { team_id: t.id });
  ray = await env.person('ray', 'Ray');
  mo = await env.person('mo', 'Mo', { role: 'manager' });
});
after(() => env.close());
const notifs = async (key) => (await env.ok('GET', '/api/notifications', { token: env.tokens[key] })).items;

test('a manager changing someone\'s schedule tells them what changed and who changed it', async () => {
  const { ok, tokens } = env;
  await ok('PATCH', `/api/users/${nia.id}`, { token: tokens.mo, body: { shift_start: '18:00', shift_end: '03:30' } });
  const ch = await ok('GET', '/api/me/changes', { token: tokens.nia });
  assert.equal(ch[0].title, 'Your schedule has changed');
  assert.equal(ch[0].by, 'Mo');
  assert.ok(ch[0].lines.some((l) => /^Shift: 9:00 AM to 6:00 PM → 6:00 PM to 3:30 AM$/.test(l)), JSON.stringify(ch[0].lines));
  const n = (await notifs('nia')).find((x) => x.kind === 'changed');
  assert.ok(n && /By Mo/.test(n.body));
  // nothing for Ray, whose schedule did not change; and saving with no real change says nothing
  assert.equal((await ok('GET', '/api/me/changes', { token: tokens.ray })).length, 0);
  await ok('PATCH', `/api/users/${nia.id}`, { token: tokens.mo, body: { shift_start: '18:00' } });
  assert.equal((await ok('GET', '/api/me/changes', { token: tokens.nia })).length, 1);
  // managers can read a person's history too; employees cannot read someone else's
  assert.equal((await ok('GET', `/api/users/${nia.id}/changes`, { token: tokens.mo })).length, 1);
  assert.equal((await env.api('GET', `/api/users/${nia.id}/changes`, { token: tokens.ray })).status, 403);
});

test('company changes reach everyone they apply to; less capture is shown, more capture needs agreeing again', async () => {
  const { ok, api, tokens, set } = env;
  set(T0 + 30 * MIN);
  // blur on: less is captured. Shown, but nobody has to agree again.
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { blur_shots: true } });
  let me = await ok('GET', '/api/me', { token: tokens.ray });
  assert.equal(me.consented, true);
  assert.deepEqual(me.policy_changes.settings.map((l) => [l.key, l.more]), [['blur', false]]);
  assert.equal((await ok('GET', '/api/me/changes', { token: tokens.ray }))[0].title, 'What Staffwarden captures for you has changed');
  // a person with their own screenshot rate does not hear about a company rate change that does not reach them
  await ok('PATCH', `/api/users/${ray.id}`, { token: tokens.owner, body: { shots_per_10: 1 } });
  const before = (await ok('GET', '/api/me/changes', { token: tokens.ray })).length;
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { shots_per_10: 3 } });
  assert.equal((await ok('GET', '/api/me/changes', { token: tokens.ray })).length, before);
  // Nia inherits the company rate: 2 -> 3 is more, so she agrees again before starting
  me = await ok('GET', '/api/me', { token: tokens.nia });
  assert.equal(me.consented, false);
  assert.equal(me.policy_changes.reaccept, true);
  assert.ok(me.policy_changes.settings.some((l) => l.key === 'shots' && l.more && l.from === '2 every 10 minutes' && l.to === '3 every 10 minutes'));
  assert.equal((await api('POST', '/api/timer/start', { token: tokens.nia, body: {} })).status, 403);
  await ok('POST', '/api/me/consent', { token: tokens.nia });
  me = await ok('GET', '/api/me', { token: tokens.nia });
  assert.equal(me.consented, true);
  assert.equal(me.policy_changes.settings.length, 0);
  await ok('POST', '/api/timer/start', { token: tokens.nia, body: {} });
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { shots_per_10: 2, blur_shots: false } });
});

test('a new policy version lists what is new in words', async () => {
  const { app, ok, tokens } = env;
  app.db.prepare('UPDATE users SET consent_version = 2 WHERE id = ?').run(ray.id);
  const me = await ok('GET', '/api/me', { token: tokens.ray });
  assert.equal(me.consented, false);
  assert.ok(me.policy_changes.news.some((t) => /teammates can see/.test(t)));
  await ok('POST', '/api/me/consent', { token: tokens.ray });
  assert.equal((await ok('GET', '/api/me', { token: tokens.ray })).policy_changes.news.length, 0);
});

test('people explain their own day; managers see it and are told', async () => {
  const { ok, api, tokens, advance, set } = env;
  set(T0 + 3 * 60 * MIN);
  const day = (await ok('GET', '/api/me', { token: tokens.nia })) && '2026-10-23';
  const n = await ok('PUT', '/api/notes', { token: tokens.nia, body: { kind: 'day', day, text: 'Power cut from 7 to 8 PM' } });
  assert.equal(n.text, 'Power cut from 7 to 8 PM');
  // saving again replaces it
  await ok('PUT', '/api/notes', { token: tokens.nia, body: { kind: 'day', day, text: 'Power cut from 7 to 8:30 PM' } });
  const seen = await ok('GET', `/api/users/${nia.id}/day?day=${day}`, { token: tokens.mo });
  assert.equal(seen.notes.length, 1);
  assert.equal(seen.notes[0].text, 'Power cut from 7 to 8:30 PM');
  assert.ok((await notifs('mo')).some((x) => x.kind === 'note_added' && /Nia added a note about their day/.test(x.title)));
  // someone else's idle time or screenshot cannot be explained, and a day ahead cannot be either
  assert.equal((await api('PUT', '/api/notes', { token: tokens.ray, body: { kind: 'idle', ref: 1, text: 'x' } })).status, 404);
  assert.equal((await api('PUT', '/api/notes', { token: tokens.nia, body: { kind: 'day', day: '2026-12-01', text: 'x' } })).status, 400);
  assert.equal((await api('PUT', '/api/notes', { token: tokens.nia, body: { kind: 'day', day, text: '   ' } })).status, 400);
  // only she can delete it
  assert.equal((await api('DELETE', `/api/notes/${n.id}`, { token: tokens.ray })).status, 404);
  advance(MIN);
});

test('asking for missing time: approved adds it and tells them; declined needs a reason', async () => {
  const { ok, api, tokens, set } = env;
  set(T0 + 26 * 60 * MIN);   // Saturday 11:00
  const ask = { start: new Date(T0 - 3 * 60 * MIN).toISOString(), end: new Date(T0 - 60 * MIN).toISOString(), reason: 'Worked offline on the call list' };
  assert.equal((await api('POST', '/api/time-requests', { token: tokens.ray, body: { ...ask, reason: '' } })).status, 400);
  const r = await ok('POST', '/api/time-requests', { token: tokens.ray, body: ask });
  assert.equal(r.status, 'pending');
  assert.equal((await api('POST', '/api/time-requests', { token: tokens.ray, body: ask })).status, 409, 'asked twice');
  assert.ok((await notifs('mo')).some((x) => x.kind === 'time_request'));
  assert.equal((await api('POST', `/api/time-requests/${r.id}/decide`, { token: tokens.ray, body: { approve: true } })).status, 403);
  await ok('POST', `/api/time-requests/${r.id}/decide`, { token: tokens.mo, body: { approve: true } });
  const day = await ok('GET', `/api/users/${ray.id}/day?day=2026-10-23`, { token: tokens.ray });
  assert.ok(day.worked_secs >= 2 * 3600);
  assert.equal(day.requests[0].status, 'approved');
  const ch = await ok('GET', '/api/me/changes', { token: tokens.ray });
  assert.equal(ch[0].title, 'Your time request was approved');
  assert.equal(ch[0].by, 'Mo');
  // a second request is declined: a reason is required and Ray is told
  const r2 = await ok('POST', '/api/time-requests', { token: tokens.ray, body: { start: new Date(T0 - 6 * 60 * MIN).toISOString(), end: new Date(T0 - 5 * 60 * MIN).toISOString(), reason: 'Early start' } });
  assert.equal((await api('POST', `/api/time-requests/${r2.id}/decide`, { token: tokens.mo, body: { approve: false } })).status, 400);
  await ok('POST', `/api/time-requests/${r2.id}/decide`, { token: tokens.mo, body: { approve: false, note: 'Shift starts at 9' } });
  assert.ok((await notifs('ray')).some((x) => x.kind === 'time_request_decision' && /Shift starts at 9/.test(x.body)));
  // time that already overlaps tracked time cannot be asked for
  assert.equal((await api('POST', '/api/time-requests', { token: tokens.ray, body: ask })).status, 409);
});

test('everyone sees their colleagues\' status and hours, but nothing else; the owner decides how far', async () => {
  const { ok, tokens } = env;
  await env.ping('nia');
  let t = await ok('GET', '/api/team/now', { token: tokens.ray });
  assert.equal(t.visible, 'everyone');
  const n = t.members.find((m) => m.name === 'Nia');
  assert.equal(n.state, 'working');
  for (const k of ['activity_pct', 'shots', 'project', 'task', 'reason', 'segs', 'email']) assert.ok(!(k in n), `${k} is not shared`);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { team_visibility: 'team' } });
  t = await ok('GET', '/api/team/now', { token: tokens.nia });
  assert.deepEqual(t.members.map((m) => m.name), ['Nia']);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { team_visibility: 'off' } });
  assert.equal((await ok('GET', '/api/team/now', { token: tokens.ray })).members.length, 0);
  assert.ok((await ok('GET', '/api/team/now', { token: tokens.mo })).members.length >= 2, 'managers always see their people');
  // widening it again is "more shared" for someone who agreed while it was off: they agree again
  await ok('POST', '/api/me/consent', { token: tokens.ray });
  assert.equal((await ok('GET', '/api/me', { token: tokens.ray })).policy_changes.reaccept, false);
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { team_visibility: 'everyone' } });
  const me = await ok('GET', '/api/me', { token: tokens.ray });
  assert.equal(me.policy_changes.reaccept, true);
  await ok('POST', '/api/me/consent', { token: tokens.ray });
  await ok('POST', '/api/me/consent', { token: tokens.nia });
});

test('an app older than the newest installer cannot start the timer, unless the owner turns that off', async () => {
  const { ok, tokens, base, dataDir } = env;
  const dir = path.join(dataDir, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Workhelm-Setup-0.9.16.exe'), 'x');
  await ok('POST', '/api/timer/stop', { token: tokens.nia, body: {} }).catch(() => {});
  const start = (v) => fetch(base + '/api/timer/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.ray}`, 'X-Workhelm-App': `${v} win32 x64` }, body: '{}' });
  let r = await start('0.9.15');
  assert.equal(r.status, 426);
  assert.match((await r.json()).error, /Update Staffwarden to 0\.9\.16/);
  // a Mac app is not held back by a Windows installer
  r = await fetch(base + '/api/timer/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.ray}`, 'X-Workhelm-App': '0.9.15 darwin arm64' }, body: '{}' });
  assert.equal(r.status, 200);
  await ok('POST', '/api/timer/stop', { token: tokens.ray, body: {} });
  assert.equal((await start('0.9.16')).status, 200);
  await ok('POST', '/api/timer/stop', { token: tokens.ray, body: {} });
  await ok('PUT', '/api/settings', { token: tokens.owner, body: { require_latest_app: false } });
  assert.equal((await start('0.9.15')).status, 200);
  await ok('POST', '/api/timer/stop', { token: tokens.ray, body: {} });
});
