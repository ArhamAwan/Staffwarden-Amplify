'use strict';
// The shift report: built from the day's facts, ready once the last shift ends, announced once to the
// owner, downloadable as a PDF, and closed to employees.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env, hira, sara;
before(async () => {
  env = await makeEnv();
  hira = await env.person('hira', 'Hira Qureshi');
  sara = await env.person('sara', 'Sara Khan');
});
after(() => env.close());

const notes = (uid) => env.app.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'shift_report'").all(uid);

test('a day of work becomes a report, announced after the shift, with a PDF', async () => {
  const { ok, api, tokens, advance } = env;
  // Hira starts 25 minutes late, takes a 30-minute break, finishes a task and checks in
  advance(25 * MIN);
  await ok('POST', '/api/timer/start', { token: tokens.hira, body: {} });
  advance(3 * 60 * MIN);
  await ok('POST', '/api/timer/pause', { token: tokens.hira, body: { reason: 'lunch' } });
  advance(30 * MIN);
  await ok('POST', '/api/timer/resume', { token: tokens.hira, body: {} });
  const t = await ok('POST', '/api/tasks', { token: tokens.owner, body: { title: 'Fix the login page', assignee_id: hira.id } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: tokens.hira, body: { status: 'in_review' } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: tokens.owner, body: { status: 'done' } });
  advance(4 * 60 * MIN);
  await ok('PUT', '/api/checkins/mine', { token: tokens.hira, body: { did: 'Fixed the login page', next: 'Start the reports', blockers: 'Waiting on the API keys', mood: 'busy' } });
  await ok('POST', '/api/timer/stop', { token: tokens.hira, body: {} });

  const list = await ok('GET', '/api/shift-reports', { token: tokens.owner });
  const day = list.today;
  assert.equal(list.days[0].day, day);
  assert.equal(list.days[0].final, false);      // 16:55: the shift hasn't ended

  const r = await ok('GET', `/api/shift-reports/${day}`, { token: tokens.owner });
  const h = r.people.find((p) => p.id === hira.id);
  assert.equal(h.status, 'late');
  assert.equal(h.worked_secs, 7 * 3600);
  assert.equal(h.break_secs, 30 * 60); assert.equal(h.break_count, 1);
  assert.equal(h.tasks.length, 1); assert.equal(h.tasks[0].title, 'Fix the login page'); assert.ok(h.tasks[0].done);
  assert.equal(h.checkin.blockers, 'Waiting on the API keys');
  const s = r.people.find((p) => p.id === sara.id);
  assert.equal(s.worked_secs, 0);
  assert.ok(h.flags.some((f) => f.key === 'late' && f.level === 'amber'));
  assert.ok(h.flags.some((f) => f.key === 'blocked'));
  assert.equal(h.level, 'amber');
  assert.ok(s.flags.some((f) => f.key === 'absent' && f.level === 'red'));
  assert.equal(r.totals.tasks_done, 1); assert.equal(r.totals.blockers, 1);

  // nothing yet; then once the shift (18:00) is over by 15 minutes, the owner hears once
  env.app.sweepNotify();
  assert.equal(notes(1).length, 0);
  advance(75 * MIN);                              // 18:10
  env.app.sweepNotify();
  assert.equal(notes(1).length, 0);
  advance(10 * MIN);                              // 18:20
  env.app.sweepNotify(); env.app.sweepNotify();
  const n = notes(1);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Shift report for .* is ready/);
  assert.equal(n[0].link, `#/shift-report?day=${day}`);
  assert.equal(n[0].desktop, 1);                  // after hours, but it still pops up
  assert.equal(notes(hira.id).length, 0);
  assert.equal((await ok('GET', '/api/shift-reports', { token: tokens.owner })).days[0].final, true);

  // the PDF
  const pdf = await api('GET', `/api/shift-reports/${day}/pdf`, { token: tokens.owner, raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), new RegExp(`shift-report-${day}\\.pdf`));
  assert.equal(pdf.data.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.data.toString('latin1').includes('Hira Qureshi'));

  // employees can't read it, and future days don't exist
  assert.equal((await api('GET', `/api/shift-reports/${day}`, { token: tokens.hira })).status, 403);
  assert.equal((await api('GET', '/api/shift-reports/2099-01-01', { token: tokens.owner })).status, 400);
});
