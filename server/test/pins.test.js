'use strict';
// Versions of a piece of work, comments pinned to a spot on it, the change list a send-back makes from
// open pins, bigger uploads sent as the file itself, and a count for tasks measured in numbers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, PNG } = require('./helpers');

let env, ids = {}, proj;
before(async () => {
  env = await makeEnv();
  const team = await env.ok('POST', '/api/teams', { token: env.tokens.owner, body: { name: 'Design' } });
  ids.dan = (await env.person('dan', 'Dan', { team_id: team.id })).id;
  ids.eve = (await env.person('eve', 'Eve', { team_id: team.id })).id;
  ids.lead = (await env.person('lead', 'Leo', { team_id: team.id })).id;
  proj = await env.ok('POST', '/api/projects', { token: env.tokens.owner, body: { name: 'Creatives', lead_id: ids.lead, member_ids: [ids.dan, ids.eve] } });
});
after(() => env.close());
const T = (k) => env.tokens[k];
const one = (k, id) => env.ok('GET', `/api/tasks/${id}`, { token: T(k) });
const png = (name, extra = {}) => ({ name, mime: 'image/png', data_base64: PNG.toString('base64'), ...extra });

test('a new version joins the same piece of work, keeps its name, and says what changed', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Statics', project_id: proj.id, assignee_id: ids.dan } });
  const v1 = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: png('static-1.png', { label: 'Static 1' }) });
  const v2 = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: png('static-1b.png', { version_of: v1.id, note: 'New presenter' }) });
  assert.equal(v2.version, 2);
  assert.equal(v2.chain_id, v1.id);
  const f = (await one('lead', t.id)).files.find((x) => x.id === v2.id);
  assert.equal(f.label, 'Static 1', 'the name carries over');
  assert.equal(f.note, 'New presenter');
  // renaming renames every version
  await env.ok('PATCH', `/api/tasks/${t.id}/files/${v2.id}`, { token: T('dan'), body: { label: 'Hero static' } });
  assert.deepEqual((await one('lead', t.id)).files.map((x) => x.label), ['Hero static', 'Hero static']);
  assert.equal((await env.api('POST', `/api/tasks/${t.id}/files`, { token: T('eve'), body: png('x.png') })).status, 403, 'not on the task');
});

test('pins: numbered per piece of work, team only, fixed by the doer, and they go back as still to do', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Ad', project_id: proj.id, assignee_id: ids.dan } });
  const v1 = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: png('ad.png', { label: 'Static 1' }) });
  const doc = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: { name: 'notes.txt', mime: 'text/plain', data_base64: Buffer.from('hi').toString('base64') } });
  assert.equal((await env.api('POST', `/api/tasks/${t.id}/pins`, { token: T('lead'), body: { file_id: doc.id, x: 0.5, y: 0.5, body: 'x' } })).status, 400, 'only pictures and PDFs');
  assert.equal((await env.api('POST', `/api/tasks/${t.id}/pins`, { token: T('lead'), body: { file_id: v1.id, x: 1.5, y: 0.5, body: 'x' } })).status, 400);
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_progress' } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_review' } });
  const p1 = await env.ok('POST', `/api/tasks/${t.id}/pins`, { token: T('lead'), body: { file_id: v1.id, x: 0.2, y: 0.3, body: 'Change the presenter' } });
  const p2 = await env.ok('POST', `/api/tasks/${t.id}/pins`, { token: T('lead'), body: { file_id: v1.id, x: 0.7, y: 0.9, body: 'Website too small' } });
  assert.deepEqual([p1.num, p2.num], [1, 2]);
  // Dan heard about it, with a link straight to the pin
  const n = env.app.db.prepare("SELECT link FROM notifications WHERE user_id = ? AND title LIKE '%pinned%' ORDER BY id DESC").get(ids.dan);
  assert.equal(n.link, `#/task?id=${t.id}&pin=${p2.id}`);
  // a reply, and Dan fixes pin 1
  await env.ok('POST', `/api/tasks/${t.id}/pins/${p1.id}/replies`, { token: T('dan'), body: { body: 'Will do' } });
  assert.equal((await env.api('PATCH', `/api/tasks/${t.id}/pins/${p1.id}`, { token: T('eve'), body: { resolved: true } })).status, 403);
  assert.equal((await env.api('PATCH', `/api/tasks/${t.id}/pins/${p1.id}`, { token: T('dan'), body: { body: 'edited' } })).status, 403, 'only the person who pinned it edits it');
  const fixed = await env.ok('PATCH', `/api/tasks/${t.id}/pins/${p1.id}`, { token: T('dan'), body: { resolved: true } });
  assert.equal(fixed.resolved, true);
  assert.equal(fixed.replies[0].body, 'Will do');
  // sending back with no note: the open pin is the change list
  await env.ok('POST', `/api/tasks/${t.id}/send-back`, { token: T('lead'), body: {} });
  const v = await one('dan', t.id);
  const fb = v.comments.find((c) => c.kind === 'feedback');
  assert.match(fb.body, /Still to do:\n• Static 1, pin 2: Website too small/);
  assert.doesNotMatch(fb.body, /presenter/, 'fixed pins are not sent back');
  // a V2 keeps numbering going on the same piece of work
  const v2 = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: png('ad-2.png', { version_of: v1.id }) });
  const p3 = await env.ok('POST', `/api/tasks/${t.id}/pins`, { token: T('lead'), body: { file_id: v2.id, x: 0.5, y: 0.5, body: 'Better' } });
  assert.equal(p3.num, 3);
  assert.equal(p3.round, 2, 'pinned in round 2');
  // the client never sees pins: the portal's task has none of this
  assert.equal((await one('lead', t.id)).pins.length, 3);
});

test('pins on a PDF page; files up to 50 MB sent as the file itself', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Brochure', project_id: proj.id, assignee_id: ids.dan } });
  const pdf = Buffer.from('%PDF-1.4\n% a test file\n');
  const res = await fetch(`${env.base}/api/tasks/${t.id}/upload?name=brochure.pdf&mime=application%2Fpdf&label=Brochure`, { method: 'POST', headers: { Authorization: `Bearer ${T('dan')}` }, body: pdf });
  assert.equal(res.status, 200);
  const f = await res.json();
  const p = await env.ok('POST', `/api/tasks/${t.id}/pins`, { token: T('lead'), body: { file_id: f.id, page: 3, x: 0.1, y: 0.1, body: 'Typo on page 3' } });
  assert.equal(p.page, 3);
  const big = await fetch(`${env.base}/api/tasks/${t.id}/upload?name=big.bin`, { method: 'POST', headers: { Authorization: `Bearer ${T('dan')}` }, body: Buffer.alloc(50 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  const got = await env.api('GET', `/api/tasks/${t.id}/files/${f.id}`, { token: T('lead'), raw: true });
  assert.equal(String(got.data), String(pdf));
});

test('a count: set by the people on the task, nudged up and down, and carried to the next repeat from zero', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'Call back missed leads', project_id: proj.id, assignee_id: ids.eve, recurrence: 'daily', due_day: '2026-10-23' } });
  assert.equal((await env.api('POST', `/api/tasks/${t.id}/progress`, { token: T('eve'), body: { count_done: 3 } })).status, 400, 'add a count first');
  await env.ok('POST', `/api/tasks/${t.id}/progress`, { token: T('lead'), body: { count_target: 20, count_unit: 'called' } });
  const r = await env.ok('POST', `/api/tasks/${t.id}/progress`, { token: T('eve'), body: { count_done: 12, outcome: '3 tours booked' } });
  assert.deepEqual(r.count, { target: 20, done: 12, unit: 'called' });
  assert.equal((await env.api('POST', `/api/tasks/${t.id}/progress`, { token: T('dan'), body: { count_done: 13 } })).status, 403);
  const v = await one('eve', t.id);
  assert.equal(v.outcome, '3 tours booked');
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('lead'), body: { needs_review: 0 } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('eve'), body: { status: 'done' } });
  const next = env.app.db.prepare('SELECT * FROM tasks WHERE recurred_from = ?').get(t.id);
  assert.deepEqual([next.count_target, next.count_done, next.count_unit], [20, 0, 'called']);
});
