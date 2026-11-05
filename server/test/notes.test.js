'use strict';
// Notes: private to the writer (managers and the owner can't open them), shared with people or a project
// team, saved without losing anyone's words, cleaned so nothing in a note can run, and @mentions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, PNG } = require('./helpers');
const { cleanHtml, textOf } = require('../routes/notes');

let env, ids = {}, proj;
const T = (k) => env.tokens[k];
const st = async (k, m, u, b) => (await env.api(m, u, { token: T(k), body: b })).status;
before(async () => {
  env = await makeEnv();
  ids.hira = (await env.person('hira', 'Hira Qureshi', { role: 'manager' })).id;
  ids.sara = (await env.person('sara', 'Sara Khan')).id;
  ids.mw = (await env.person('mw', 'Muhammad Waseem')).id;
  ids.out = (await env.person('out', 'Outsider Person')).id;
  proj = await env.ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Waystar', key: 'WE', lead_id: ids.hira, member_ids: [ids.sara, ids.mw] } });
});
after(() => env.close());

test('the cleaner keeps the editor’s formatting and drops anything that could run', () => {
  const keep = '<h2>Decisions</h2><p>Hi <b>there</b> <span class="mention" data-uid="4">@Sara</span></p><ul class="ck"><li data-done="1">Done</li><li>Not yet</li></ul><table><tr><th>A</th><td colspan="2">B</td></tr></table><a href="https://example.com/x">link</a><img data-file="12" alt="frame"><span class="nt-task" data-task="9">WE-1</span>';
  const c = cleanHtml(keep);
  for (const s of ['<h2>', '<ul class="ck">', '<li data-done="1">', 'data-uid="4"', 'colspan="2"', 'href="https://example.com/x"', 'rel="noopener noreferrer nofollow"', '<img data-file="12" alt="frame">', 'data-task="9"']) assert.ok(c.includes(s), s);
  const bad = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<p onclick="alert(1)" style="color:red">x</p>',
    '<iframe src="https://evil"></iframe>', '<svg><script>alert(1)</script></svg>', '<img src="https://tracker.example/p.gif">', '<a href=" javascript:alert(1)">x</a>',
    '<span class="mention" data-uid="1 onmouseover=alert(1)">x</span>', '<p title="x" onmouseover="a">y</p>', '<style>body{display:none}</style>', '<<script>script>alert(1)<</script>/script>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<math><mtext></mtext></math>', '<img data-file="1" onerror="alert(1)">',
  ];
  for (const b of bad) {
    const o = cleanHtml(b);
    assert.ok(!/<script|onerror|onclick|onmouseover|javascript:|<iframe|<style|<svg|src=|style=|data:text/i.test(o), `${b} -> ${o}`);
  }
  assert.equal(textOf('<h2>A</h2><p>B &amp; C</p><ul><li>D</li></ul>'), 'A\nB & C\nD');
});

test('a note is private: managers and the owner can’t open it', async () => {
  const { id } = await env.ok('POST', '/api/notebook', { token: T('sara'), body: { title: 'My thoughts', body: '<p>Private</p>' } });
  for (const k of ['owner', 'hira', 'mw']) {
    assert.equal(await st(k, 'GET', `/api/notebook/${id}`), 404, k);
    assert.ok(!(await env.ok('GET', '/api/notebook', { token: T(k) })).notes.some((n) => n.id === id), k);
    assert.equal(await st(k, 'PUT', `/api/notebook/${id}`, { version: 1, body: 'x' }), 404, k);
  }
  const n = await env.ok('GET', `/api/notebook/${id}`, { token: T('sara') });
  assert.equal(n.title, 'My thoughts'); assert.equal(n.access, 'owner'); assert.equal(n.shared, false);
});

test('shared with a person (view or edit) and with a project team; only the writer shares, moves and deletes', async () => {
  const { id } = await env.ok('POST', '/api/notebook', { token: T('hira'), body: { title: 'Waystar kickoff', body: '<p>Script locked</p>' } });
  await env.ok('PUT', `/api/notebook/${id}/shares`, { token: T('hira'), body: { user_id: ids.sara, perm: 'edit' } });
  assert.ok((await env.ok('GET', '/api/notifications', { token: T('sara') })).items.some((x) => x.kind === 'note_shared'));
  assert.equal((await env.ok('GET', `/api/notebook/${id}`, { token: T('sara') })).access, 'edit');
  assert.equal(await st('mw', 'GET', `/api/notebook/${id}`), 404);
  await env.ok('PUT', `/api/notebook/${id}/shares`, { token: T('hira'), body: { project_id: proj.id, perm: 'view' } });
  const asMw = await env.ok('GET', `/api/notebook/${id}`, { token: T('mw') });
  assert.equal(asMw.access, 'view');
  assert.equal(await st('mw', 'PUT', `/api/notebook/${id}`, { version: asMw.version, body: '<p>mine</p>' }), 403, 'view only');
  assert.equal(await st('out', 'GET', `/api/notebook/${id}`), 404, 'not on the team');
  assert.equal(await st('owner', 'GET', `/api/notebook/${id}`), 404, 'the owner isn’t on the team either');
  assert.equal(await st('sara', 'PUT', `/api/notebook/${id}/shares`, { user_id: ids.out }), 403, 'only the writer shares');
  assert.equal(await st('sara', 'DELETE', `/api/notebook/${id}`), 403, 'only the writer deletes');
  assert.equal(await st('sara', 'PATCH', `/api/notebook/${id}`, { folder_id: null }), 403);
  await env.ok('PATCH', `/api/notebook/${id}`, { token: T('sara'), body: { pinned: true } });
  assert.ok((await env.ok('GET', '/api/notebook', { token: T('sara') })).notes.find((n) => n.id === id).pinned, 'pins are each person’s own');
  assert.ok(!(await env.ok('GET', '/api/notebook', { token: T('hira') })).notes.find((n) => n.id === id).pinned);
  assert.equal(await st('hira', 'PUT', `/api/notebook/${id}/shares`, { project_id: (await env.ok('POST', '/api/projects', { token: T('owner'), body: { name: 'Not hers', key: 'NH' } })).id }), 403, 'only a team you are on');
  // taking a share back
  const shares = (await env.ok('GET', `/api/notebook/${id}`, { token: T('hira') })).shares;
  await env.ok('DELETE', `/api/notebook/${id}/shares/${shares.find((s) => s.project_id).id}`, { token: T('hira') });
  assert.equal(await st('mw', 'GET', `/api/notebook/${id}`), 404);
});

test('saving: a save based on an older version is refused with the latest, so nobody’s words are lost', async () => {
  const { id } = await env.ok('POST', '/api/notebook', { token: T('hira'), body: { title: 'Plan', body: '<p>one</p>' } });
  await env.ok('PUT', `/api/notebook/${id}/shares`, { token: T('hira'), body: { user_id: ids.sara, perm: 'edit' } });
  const a = await env.ok('PUT', `/api/notebook/${id}`, { token: T('sara'), body: { version: 1, body: '<p>one</p><p>two</p>' } });
  assert.equal(a.version, 2);
  const r = await env.api('PUT', `/api/notebook/${id}`, { token: T('hira'), body: { version: 1, body: '<p>one</p><p>three</p>' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.latest.version, 2); assert.match(r.data.latest.body, /two/); assert.equal(r.data.latest.updated_by, 'Sara Khan');
  const saved = await env.ok('PUT', `/api/notebook/${id}`, { token: T('hira'), body: { version: 2, body: '<p>one</p><p>two</p><p>three</p>', title: 'Plan v2' } });
  assert.equal(saved.version, 3);
  const n = await env.ok('GET', `/api/notebook/${id}`, { token: T('sara') });
  assert.equal(n.title, 'Plan v2'); assert.equal(n.updated_by, 'Hira Qureshi');
  // what was saved is the cleaned version
  const x = await env.ok('PUT', `/api/notebook/${id}`, { token: T('hira'), body: { version: 3, body: '<p onclick="x()">hi<script>bad()</script></p>' } });
  assert.equal(x.body, '<p>hi</p>');
});

test('@mentions tell people who can open the note, once; never anyone else', async () => {
  const { id } = await env.ok('POST', '/api/notebook', { token: T('hira'), body: { title: 'Kickoff', body: `<p><span class="mention" data-uid="${ids.mw}">@Muhammad Waseem</span></p>` } });
  const mm = async (k) => (await env.ok('GET', '/api/notifications', { token: T(k) })).items.filter((x) => x.kind === 'note_mention');
  assert.equal((await mm('mw')).length, 0, 'not shared with him yet');
  await env.ok('PUT', `/api/notebook/${id}/shares`, { token: T('hira'), body: { project_id: proj.id, perm: 'view' } });
  const v = (await env.ok('GET', `/api/notebook/${id}`, { token: T('hira') })).version;
  await env.ok('PUT', `/api/notebook/${id}`, { token: T('hira'), body: { version: v, body: `<p><span class="mention" data-uid="${ids.mw}">@Muhammad Waseem</span> <span class="mention" data-uid="${ids.out}">@Outsider</span></p>` } });
  assert.equal((await mm('mw')).length, 1);
  assert.equal((await mm('out')).length, 0);
  await env.ok('PUT', `/api/notebook/${id}`, { token: T('hira'), body: { version: v + 1, body: `<p><span class="mention" data-uid="${ids.mw}">@Muhammad Waseem</span> again</p>` } });
  assert.equal((await mm('mw')).length, 1, 'once');
  const pool = (await env.ok('GET', `/api/notebook/${id}`, { token: T('hira') })).pool.map((p) => p.name);
  assert.ok(pool.includes('Sara Khan') && pool.includes('Muhammad Waseem') && !pool.includes('Outsider Person'));
});

test('Recently deleted, restore and delete for good; folders; search; pictures only for people who can open the note', async () => {
  const f = await env.ok('POST', '/api/notebook/folders', { token: T('sara'), body: { name: 'Ideas' } });
  assert.equal(await st('sara', 'POST', '/api/notebook/folders', { name: 'ideas' }), 409);
  const { id } = await env.ok('POST', '/api/notebook', { token: T('sara'), body: { folder_id: f.id, title: 'Rainy wall', body: '<p>before and after</p>' } });
  let l = await env.ok('GET', '/api/notebook', { token: T('sara') });
  assert.equal(l.folders.find((x) => x.id === f.id).count, 1);
  assert.deepEqual((await env.ok('GET', '/api/notebook?q=after', { token: T('sara') })).notes.map((n) => n.id), [id]);
  const up = await env.api('POST', `/api/notebook/${id}/files?name=frame.png&mime=image/png`, { token: T('sara') });
  void up;
  const res = await fetch(`${env.base}/api/notebook/${id}/files?name=frame.png&mime=image/png`, { method: 'POST', headers: { Authorization: `Bearer ${T('sara')}` }, body: PNG });
  const file = await res.json();
  assert.equal(file.image, true);
  assert.equal(await st('sara', 'GET', `/api/notebook/${id}/files/${file.id}`), 200);
  assert.equal(await st('hira', 'GET', `/api/notebook/${id}/files/${file.id}`), 404, 'private note, private picture');
  await env.ok('DELETE', `/api/notebook/${id}`, { token: T('sara') });
  l = await env.ok('GET', '/api/notebook', { token: T('sara') });
  assert.ok(!l.notes.some((n) => n.id === id)); assert.equal(l.counts.deleted, 1);
  assert.equal((await env.ok('GET', '/api/notebook?folder=deleted', { token: T('sara') })).notes[0].id, id);
  assert.equal(await st('sara', 'PUT', `/api/notebook/${id}`, { version: 1, body: 'x' }), 409, 'restore it first');
  await env.ok('POST', `/api/notebook/${id}/restore`, { token: T('sara') });
  await env.ok('DELETE', `/api/notebook/${id}`, { token: T('sara') });
  await env.ok('DELETE', `/api/notebook/${id}?forever=1`, { token: T('sara') });
  assert.equal(await st('sara', 'GET', `/api/notebook/${id}`), 404);
  await env.ok('DELETE', `/api/notebook/folders/${f.id}`, { token: T('sara') });
});

test('clients have no notes', async () => {
  // a client account can never reach staff routes; notes are staff only too
  const r = await env.api('GET', '/api/notebook', {});
  assert.equal(r.status, 401);
});
