'use strict';
// Client assets: who sees them, what each kind accepts, logins never shared, a project's own assets moving
// to the client when it is linked, approved work saved for the client, and the portal side.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, PNG } = require('./helpers');

let env, ids = {}, client, rival, proj, solo, jessT, ritaT;
before(async () => {
  env = await makeEnv();
  const team = await env.ok('POST', '/api/teams', { token: env.tokens.owner, body: { name: 'Studio' } });
  ids.dan = (await env.person('dan', 'Dan', { team_id: team.id })).id;
  ids.eve = (await env.person('eve', 'Eve', { team_id: team.id })).id;
  ids.lead = (await env.person('lead', 'Leo', { team_id: team.id })).id;
  client = await env.ok('POST', '/api/clients', { token: env.tokens.owner, body: { name: 'Harbor & Pine' } });
  rival = await env.ok('POST', '/api/clients', { token: env.tokens.owner, body: { name: 'Rival Homes' } });
  proj = await env.ok('POST', '/api/projects', { token: env.tokens.owner, body: { name: 'Ads', lead_id: ids.lead, member_ids: [ids.dan] } });
  solo = await env.ok('POST', '/api/projects', { token: env.tokens.owner, body: { name: 'IFixit site', lead_id: ids.lead, member_ids: [ids.dan] } });
  await env.ok('PUT', `/api/clients/${client.id}/projects/${proj.id}`, { token: env.tokens.owner, body: { on: true } });
  const j = await env.ok('POST', `/api/clients/${client.id}/people`, { token: env.tokens.owner, body: { name: 'Jess', email: 'jess@h.com', can_approve: true } });
  jessT = await env.login('jess@h.com', j.password);
  const r = await env.ok('POST', `/api/clients/${rival.id}/people`, { token: env.tokens.owner, body: { name: 'Rita', email: 'rita@r.com' } });
  ritaT = await env.login('rita@r.com', r.password);
});
after(() => env.close());
const T = (k) => env.tokens[k];
const add = (k, body) => env.ok('POST', '/api/assets', { token: T(k), body });
const status = async (k, method, url, body) => (await env.api(method, url, { token: T(k), body })).status;

test('the team on a client’s project adds and sees the client’s assets; others don’t', async () => {
  const link = await add('dan', { project_id: proj.id, kind: 'link', url: 'harborpine.com', title: 'Website' });
  assert.equal(link.url, 'https://harborpine.com/');
  assert.equal(link.section, 'links');
  const color = await add('dan', { project_id: proj.id, kind: 'color', value: '1f4e46', title: 'Pine green' });
  assert.equal(color.value, '#1F4E46');
  assert.equal(color.section, 'brand');
  assert.equal(await status('dan', 'POST', '/api/assets', { project_id: proj.id, kind: 'color', value: 'green' }), 400);
  assert.equal(await status('dan', 'POST', '/api/assets', { project_id: proj.id, kind: 'link', url: 'javascript:alert(1)' }), 400);
  assert.equal(await status('dan', 'POST', '/api/assets', { project_id: proj.id, kind: 'link', url: 'https://harborpine.com/' }), 409, 'the same link twice');
  // the same list from the client page and from the project
  const viaClient = await env.ok('GET', `/api/assets?client=${client.id}`, { token: T('owner') });
  const viaProject = await env.ok('GET', `/api/assets?project=${proj.id}`, { token: T('dan') });
  assert.equal(viaClient.assets.length, 2);
  assert.deepEqual(viaProject.assets.map((a) => a.id), viaClient.assets.map((a) => a.id));
  assert.equal(viaProject.scope.name, 'Harbor & Pine');
  assert.equal(await status('eve', 'GET', `/api/assets?client=${client.id}`), 404, 'not on any of their projects');
  assert.equal(await status('eve', 'DELETE', `/api/assets/${link.id}`), 404);
  assert.equal(await status('dan', 'DELETE', `/api/assets/${color.id}`), 200, 'whoever added it can remove it');
});

test('logins say where a login is kept, and are never shared with the client', async () => {
  const l = await add('lead', { client_id: client.id, kind: 'login', value: 'In 1Password, Harbor & Pine › WordPress', title: 'Website admin', shared: true });
  assert.equal(l.shared, false);
  assert.equal(l.section, 'logins');
  const patched = await env.ok('PATCH', `/api/assets/${l.id}`, { token: T('lead'), body: { shared: true } }).catch(() => null);
  assert.ok(!patched || patched.shared === false);
  const p = await env.ok('GET', `/api/portal/projects/${proj.id}/assets`, { token: jessT });
  assert.ok(!p.assets.some((a) => a.kind === 'login'));
});

test('files: shared ones reach the portal, team-only ones don’t; versions join one chain', async () => {
  const res = await fetch(`${env.base}/api/assets/upload?project=${proj.id}&name=logo.png&mime=image%2Fpng&section=brand&shared=1&title=Full%20logo`, { method: 'POST', headers: { Authorization: `Bearer ${T('dan')}` }, body: PNG });
  assert.equal(res.status, 200);
  const logo = await res.json();
  assert.equal(logo.section, 'brand');
  const v2 = await env.ok('POST', '/api/assets', { token: T('dan'), body: { project_id: proj.id, kind: 'file', name: 'logo-2.png', mime: 'image/png', data_base64: PNG.toString('base64'), version_of: logo.id } });
  assert.equal(v2.version, 2);
  assert.equal(v2.chain_id, logo.chain_id);
  assert.equal(v2.title, 'Full logo', 'the name carries over');
  assert.equal(v2.shared, true);
  const secret = await env.ok('POST', '/api/assets', { token: T('dan'), body: { project_id: proj.id, kind: 'file', name: 'internal.png', mime: 'image/png', data_base64: PNG.toString('base64') } });
  const p = await env.ok('GET', `/api/portal/projects/${proj.id}/assets`, { token: jessT });
  assert.ok(p.assets.some((a) => a.id === v2.id));
  assert.ok(!p.assets.some((a) => a.id === secret.id));
  const f = await env.api('GET', `/api/portal/assets/${v2.id}/file`, { token: jessT, raw: true });
  assert.equal(f.status, 200);
  assert.equal((await env.api('GET', `/api/portal/assets/${secret.id}/file`, { token: jessT, raw: true })).status, 404);
  assert.equal((await env.api('GET', `/api/portal/assets/${v2.id}/file`, { token: ritaT, raw: true })).status, 404, 'another client never');
  const inline = await env.api('GET', `/api/assets/${v2.id}/file?inline=1`, { token: T('dan'), raw: true });
  assert.match(inline.headers.get('content-disposition'), /^inline/);
});

test('the client sends a file in: it lands in their assets and the lead hears about it', async () => {
  const res = await fetch(`${env.base}/api/portal/projects/${proj.id}/assets/upload?name=photo.png&mime=image%2Fpng&note=Use%20this%20one`, { method: 'POST', headers: { Authorization: `Bearer ${jessT}` }, body: PNG });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.from_client, true);
  const list = await env.ok('GET', `/api/assets?client=${client.id}`, { token: T('lead') });
  assert.ok(list.assets.some((x) => x.id === a.id && x.by === 'Jess'));
  const n = env.app.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND title LIKE '%sent photo.png%'").get(ids.lead);
  assert.ok(n, 'the lead is told');
  assert.equal((await fetch(`${env.base}/api/portal/projects/${proj.id}/assets/upload?name=x.png`, { method: 'POST', headers: { Authorization: `Bearer ${ritaT}` }, body: PNG })).status, 404);
});

test('a project with no client keeps its own assets, and they move when it is linked to a client', async () => {
  const a = await add('dan', { project_id: solo.id, kind: 'note', value: 'Owner prefers calls after 5 PM', title: 'Calls' });
  let l = await env.ok('GET', `/api/assets?project=${solo.id}`, { token: T('dan') });
  assert.equal(l.scope.has_client, false);
  assert.equal(l.assets.length, 1);
  await env.ok('PUT', `/api/clients/${rival.id}/projects/${solo.id}`, { token: T('owner'), body: { on: true } });
  l = await env.ok('GET', `/api/assets?client=${rival.id}`, { token: T('owner') });
  assert.ok(l.assets.some((x) => x.id === a.id), 'moved to the client');
});

test('approving work saves the approved version of each picture to the client; any file can be saved by hand', async () => {
  const t = await env.ok('POST', '/api/tasks', { token: T('lead'), body: { title: 'November ads', project_id: proj.id, assignee_id: ids.dan } });
  const v1 = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: { name: 'static.png', mime: 'image/png', label: 'Static 1', data_base64: PNG.toString('base64') } });
  const v2 = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: { name: 'static-2.png', mime: 'image/png', version_of: v1.id, data_base64: PNG.toString('base64') } });
  const doc = await env.ok('POST', `/api/tasks/${t.id}/files`, { token: T('dan'), body: { name: 'copy.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data_base64: Buffer.from('x').toString('base64') } });
  await env.ok('PATCH', `/api/tasks/${t.id}`, { token: T('dan'), body: { status: 'in_review' } });
  await env.ok('POST', `/api/tasks/${t.id}/approve`, { token: T('lead') });
  const v = await env.ok('GET', `/api/tasks/${t.id}`, { token: T('dan') });
  assert.equal(v.assets.name, 'Harbor & Pine');
  assert.equal(v.assets.saved.length, 1, 'only the latest version of the picture');
  assert.equal(v.assets.saved[0].title, 'Static 1');
  assert.ok(v.assets.files.includes(v2.id));
  assert.ok(!v.assets.files.includes(doc.id), 'documents are saved by hand');
  const s = await env.ok('POST', `/api/tasks/${t.id}/save-asset`, { token: T('dan'), body: { file_id: doc.id } });
  assert.equal(s.file_name, 'copy.docx');
  const again = await env.ok('POST', `/api/tasks/${t.id}/save-asset`, { token: T('dan'), body: { file_id: doc.id } });
  assert.equal(again.id, s.id, 'saving twice keeps one');
});
