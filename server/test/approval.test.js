'use strict';
// The approval sign-up: a company asks, confirms its email, an admin approves it in the console, the setup
// link creates the company, and the owner creates logins for people without a work email.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPlatform } = require('../platform');
const { createMailer } = require('../platform/mail');

const DAY = 86400000;
const clock = { t: Date.UTC(2026, 10, 10, 9, 0, 0) };
let P, port, dataDir;
const mailer = createMailer({ smtpConfig: null, base: 'http://localhost', store: { prepare: () => ({ run() {} }) }, log: { error() {} } });
const lastMail = (kind, to) => [...mailer.outbox].reverse().find((m) => m.kind === kind && (!to || m.to === to));
const apex = 'sw.test';
const at = (s) => `${s}.${apex}`;
function req(host, method, url, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const text = Buffer.concat(c).toString(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, data: json, text }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const ok = async (...a) => { const r = await req(...a); assert.equal(r.status, 200, `${a[1]} ${a[2]} -> ${r.status} ${r.text.slice(0, 300)}`); return r.data; };
async function consoleToken() {
  await ok(at('admin'), 'POST', '/api/console/code', { body: { email: 'boss@sw.test' } });
  await new Promise((r) => setTimeout(r, 10));
  const code = lastMail('console_code', 'boss@sw.test').data.code.replace(/\D/g, '');
  return (await ok(at('admin'), 'POST', '/api/console/login', { body: { email: 'boss@sw.test', code } })).token;
}
async function ask(email, company, extra = {}) {
  const r = await ok(apex, 'POST', '/api/platform/request/start', { body: { name: 'Laura Bennett', email, company, size: '11-50', country: 'US', note: 'Dispatch team across two time zones', ...extra } });
  return r;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-appr-'));
  P = createPlatform({ dataDir, baseDomain: apex, scheme: 'http', now: () => clock.t, mailer, seatDelayMs: 0, limitScale: 50, adminEmails: 'boss@sw.test', webDir: path.join(__dirname, '..', '..', 'web'), log: { error() {} } });
  await new Promise((r) => P.server.listen(0, r));
  port = P.server.address().port;
});
test.after(async () => { await new Promise((r) => P.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('by default a company asks for access: open sign-up is closed', async () => {
  assert.equal((await ok(apex, 'GET', '/api/platform/config')).signup, 'approval');
  assert.equal((await req(apex, 'POST', '/api/platform/signup/start', { body: { name: 'X Y', email: 'x@y.test', password: 'a-long-pass-123' } })).status, 403);
});

test('ask, confirm the email, get approved, set up: nothing exists until the setup link is used', async () => {
  const r = await ask('laura@northwind.co', 'Northwind Logistics');
  assert.ok(r.dev_code);
  // not confirmed yet: the console doesn't see it
  const ct = await consoleToken();
  assert.equal((await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests.length, 0);
  const wrong = r.dev_code === '000000' ? '111111' : '000000';
  assert.equal((await req(apex, 'POST', '/api/platform/request/verify', { body: { token: r.token, code: wrong } })).status, 400);
  const v = await ok(apex, 'POST', '/api/platform/request/verify', { body: { token: r.token, code: r.dev_code } });
  assert.equal(v.status, 'waiting');
  assert.ok(lastMail('access_request', 'boss@sw.test'), 'the admins are told');
  // the same email can't ask twice while waiting
  assert.equal((await req(apex, 'POST', '/api/platform/request/start', { body: { name: 'Laura B', email: 'laura@northwind.co', company: 'Again', country: 'US' } })).status, 409);
  const list = (await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests;
  assert.equal(list.length, 1);
  const q = list[0];
  assert.equal(q.status, 'waiting'); assert.equal(q.company, 'Northwind Logistics'); assert.equal(q.personal_email, false);
  assert.equal((await ok(at('admin'), 'GET', '/api/console/overview', { token: ct })).requests_waiting, 1);
  assert.equal(P.row('northwind'), undefined, 'no company yet');
  // the console needs a console sign-in
  assert.equal((await req(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { body: {} })).status, 401);
  const a = await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { token: ct, body: { trial_days: 30, plan: 'pro', message: 'Welcome aboard.' } });
  assert.equal(a.status, 'approved');
  const mail = lastMail('access_approved', 'laura@northwind.co');
  assert.match(mail.text, /Welcome aboard/);
  const link = (mail.text.match(/http\S+\/setup#t=\S+/) || [])[0];
  assert.ok(link, 'the email carries the setup link');
  const t = decodeURIComponent(link.split('#t=')[1]);
  assert.equal((await ok(apex, 'POST', '/api/platform/request/status', { body: { token: r.token } })).status, 'approved');
  const info = await ok(apex, 'POST', '/api/platform/setup/check', { body: { t } });
  assert.equal(info.company, 'Northwind Logistics'); assert.equal(info.trial_days, 30); assert.equal(info.slug, 'northwind-logistics');
  assert.equal((await req(apex, 'POST', '/api/platform/setup', { body: { t, slug: 'admin', password: 'a-long-pass-123' } })).status, 400, 'reserved address');
  const s = await ok(apex, 'POST', '/api/platform/setup', { body: { t, slug: 'northwind', password: 'a-long-pass-123', tz: 'America/Chicago' } });
  assert.equal(s.address, 'northwind.sw.test');
  const row = P.row('northwind');
  assert.equal(row.plan, 'pro');
  assert.equal(Math.round((Date.parse(row.trial_ends_at) - clock.t) / DAY), 30);
  assert.equal(P.tenantApp('northwind').ctx.cfg.tzName, 'America/Chicago');
  // the link works once
  assert.equal((await req(apex, 'POST', '/api/platform/setup', { body: { t, slug: 'northwind2', password: 'a-long-pass-123' } })).status, 404);
  const h = await ok(at('northwind'), 'POST', '/api/auth/handoff', { body: { code: s.handoff } });
  assert.equal((await ok(at('northwind'), 'GET', '/api/me', { token: h.token })).role, 'owner');
  assert.equal((await ok(apex, 'POST', '/api/platform/request/status', { body: { token: r.token } })).status, 'done');
});

test('decline, undo, and a setup link that runs out or is cancelled', async () => {
  const ct = await consoleToken();
  const r = await ask('sam@quickstaff.test', 'Quickstaff', { note: 'test' });
  await ok(apex, 'POST', '/api/platform/request/verify', { body: { token: r.token, code: r.dev_code } });
  const q = (await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests.find((x) => x.email === 'sam@quickstaff.test');
  assert.equal(q.thin_note, true, 'a one-word reason is flagged');
  await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/decline`, { token: ct, body: { message: 'We only open to registered companies for now.' } });
  assert.match(lastMail('access_declined', 'sam@quickstaff.test').text, /registered companies/);
  assert.equal((await req(apex, 'POST', '/api/platform/request/start', { body: { name: 'Sam Lee', email: 'sam@quickstaff.test', company: 'Quickstaff', country: 'US' } })).status, 409, 'not again for 30 days');
  // undo the decline, then approve, then cancel the link
  assert.equal((await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/reopen`, { token: ct })).status, 'waiting');
  await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { token: ct, body: {} });
  const t = decodeURIComponent(lastMail('access_approved', 'sam@quickstaff.test').text.match(/#t=(\S+)/)[1]);
  await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/reopen`, { token: ct });
  assert.equal((await req(apex, 'POST', '/api/platform/setup/check', { body: { t } })).status, 404, 'a cancelled link stops working');
  // approve again: a new link; after 7 days it runs out, and the console can send a fresh one
  await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { token: ct, body: {} });
  const t2 = decodeURIComponent(lastMail('access_approved', 'sam@quickstaff.test').text.match(/#t=(\S+)/)[1]);
  clock.t += 8 * DAY;
  assert.equal((await req(apex, 'POST', '/api/platform/setup/check', { body: { t: t2 } })).status, 410);
  await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/resend`, { token: await consoleToken() });
  const t3 = decodeURIComponent(lastMail('access_approved', 'sam@quickstaff.test').text.match(/#t=(\S+)/)[1]);
  assert.equal((await ok(apex, 'POST', '/api/platform/setup/check', { body: { t: t3 } })).company, 'Quickstaff');
});

test('a request can be withdrawn; personal email addresses are flagged', async () => {
  const ct = await consoleToken();
  const r = await ask('someone1234@gmail.com', 'Solo Co');
  await ok(apex, 'POST', '/api/platform/request/verify', { body: { token: r.token, code: r.dev_code } });
  assert.equal((await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests.find((x) => x.email === 'someone1234@gmail.com').personal_email, true);
  await ok(apex, 'POST', '/api/platform/request/withdraw', { body: { token: r.token } });
  const q = (await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests.find((x) => x.email === 'someone1234@gmail.com');
  assert.equal(q.status, 'withdrawn');
  assert.equal((await req(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { token: ct, body: {} })).status, 400);
});

test('logins for people without email: a username, a one-time password, and their own password at first sign-in', async () => {
  const o = await (async () => {
    const r = await ask('olivia@brightline.test', 'Brightline Clinics');
    await ok(apex, 'POST', '/api/platform/request/verify', { body: { token: r.token, code: r.dev_code } });
    const ct = await consoleToken();
    const q = (await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests.find((x) => x.email === 'olivia@brightline.test');
    await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { token: ct, body: {} });
    const t = decodeURIComponent(lastMail('access_approved', 'olivia@brightline.test').text.match(/#t=(\S+)/)[1]);
    const s = await ok(apex, 'POST', '/api/platform/setup', { body: { t, slug: 'brightline', password: 'a-long-pass-123' } });
    return (await ok(at('brightline'), 'POST', '/api/auth/handoff', { body: { code: s.handoff } })).token;
  })();
  const team = await ok(at('brightline'), 'POST', '/api/teams', { token: o, body: { name: 'Front desk' } });
  const made = await ok(at('brightline'), 'POST', '/api/users/logins', { token: o, body: { people: [
    { name: 'Jack Morris', team_id: team.id }, { name: 'Jack Morris', team_id: team.id }, { name: 'José Núñez', team_id: team.id, role: 'manager' },
  ] } });
  assert.deepEqual(made.people.map((p) => p.username), ['jack.morris', 'jack.morris2', 'jose.nunez']);
  assert.match(made.people[0].password, /^[A-Z2-9]{3}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  const jack = made.people[0];
  // nobody has used their login yet: the day's views don't count them as missing
  const dashIds = async () => (await ok(at('brightline'), 'GET', '/api/dashboard/team', { token: o })).members.map((m) => m.user_id);
  assert.equal((await dashIds()).includes(jack.id), false, 'a login never used is not "not started"');
  // the desktop app (or anything that can't set a password) is told to use a browser first
  const blocked = await req(at('brightline'), 'POST', '/api/auth/login', { body: { email: 'jack.morris', password: jack.password } });
  assert.equal(blocked.status, 403); assert.equal(blocked.data.must_change, true);
  const li = await ok(at('brightline'), 'POST', '/api/auth/login', { body: { email: 'Jack.Morris', password: jack.password, can_set_password: true } });
  assert.equal(li.user.must_change_pw, true); assert.equal(li.user.username, true);
  // nothing else works until the password is chosen
  const no = await req(at('brightline'), 'GET', '/api/timer/current', { token: li.token });
  assert.equal(no.status, 403); assert.equal(no.data.must_change, true);
  assert.equal((await ok(at('brightline'), 'GET', '/api/me', { token: li.token })).must_change_pw, true);
  await ok(at('brightline'), 'POST', '/api/me/password', { token: li.token, body: { current_password: jack.password, new_password: 'jacks-own-pass-42' } });
  assert.equal((await ok(at('brightline'), 'GET', '/api/me', { token: li.token })).must_change_pw, false);
  assert.ok((await dashIds()).includes(jack.id), 'once Jack chose a password, the dashboard expects him');
  assert.equal((await req(at('brightline'), 'POST', '/api/auth/login', { body: { email: 'jack.morris', password: 'jacks-own-pass-42' } })).status, 200, 'now the desktop app can sign in too');
  const ppl = await ok(at('brightline'), 'GET', '/api/users?all=1', { token: o });
  const j = ppl.find((u) => u.id === jack.id);
  assert.equal(j.username, true); assert.equal(j.login_waiting, false);
  assert.equal(ppl.find((u) => u.id === made.people[1].id).login_waiting, true);
  // a one-time password runs out after 7 days; a manager makes a new one
  clock.t += 8 * DAY;
  const two = made.people[1];
  assert.equal((await req(at('brightline'), 'POST', '/api/auth/login', { body: { email: two.username, password: two.password, can_set_password: true } })).status, 401);
  const again = await ok(at('brightline'), 'POST', `/api/users/${two.id}/one-time-password`, { token: o });
  assert.notEqual(again.password, two.password);
  await ok(at('brightline'), 'POST', '/api/auth/login', { body: { email: two.username, password: again.password, can_set_password: true } });
  // a new one-time password signs the person out everywhere
  const jt = (await ok(at('brightline'), 'POST', '/api/auth/login', { body: { email: 'jack.morris', password: 'jacks-own-pass-42' } })).token;
  await ok(at('brightline'), 'POST', `/api/users/${jack.id}/one-time-password`, { token: o });
  assert.equal((await req(at('brightline'), 'GET', '/api/me', { token: jt })).status, 401);
  // an employee can't make logins
  assert.equal((await req(at('brightline'), 'POST', '/api/auth/login', { body: { email: 'jose.nunez', password: made.people[2].password, can_set_password: true } })).status, 401, 'José’s one-time password ran out too');
  const empLogin = await ok(at('brightline'), 'POST', '/api/users/logins', { token: o, body: { people: [{ name: 'Plain Person', team_id: team.id }] } });
  const pt = (await ok(at('brightline'), 'POST', '/api/auth/login', { body: { email: empLogin.people[0].username, password: empLogin.people[0].password, can_set_password: true } })).token;
  await ok(at('brightline'), 'POST', '/api/me/password', { token: pt, body: { current_password: empLogin.people[0].password, new_password: 'plain-own-pass-42' } });
  assert.equal((await req(at('brightline'), 'POST', '/api/users/logins', { token: pt, body: { people: [{ name: 'Sneaky', team_id: team.id }] } })).status, 403);
});

test('without card payments set up, a trial that ends is not paused: the console admins are told once', async () => {
  const r = await ask('nina@harbor.test', 'Harbor Pilot');
  await ok(apex, 'POST', '/api/platform/request/verify', { body: { token: r.token, code: r.dev_code } });
  const ct = await consoleToken();
  const q = (await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests.find((x) => x.email === 'nina@harbor.test');
  await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { token: ct, body: { trial_days: 7 } });
  const t = decodeURIComponent(lastMail('access_approved', 'nina@harbor.test').text.match(/#t=(\S+)/)[1]);
  const s = await ok(apex, 'POST', '/api/platform/setup', { body: { t, slug: 'harborpilot', password: 'a-long-pass-123' } });
  const owner = (await ok(at('harborpilot'), 'POST', '/api/auth/handoff', { body: { code: s.handoff } })).token;
  assert.equal((await ok(at('harborpilot'), 'GET', '/api/me', { token: owner })).account.cards, false, 'the owner’s app knows cards are off');
  clock.t += 5 * DAY; await P.sweep();
  assert.ok(lastMail('trial_ending', 'nina@harbor.test').text.includes('invoice'), 'the reminder talks about an invoice, not a card');
  clock.t += 3 * DAY; await P.sweep();
  assert.equal(P.row('harborpilot').status, 'trial', 'not paused');
  const mine = (m) => m.kind === 'trial_over_admin' && m.data.company === 'Harbor Pilot';
  const told = mailer.outbox.filter((m) => mine(m) && m.to === 'boss@sw.test');
  assert.equal(told.length, 1);
  await P.sweep();
  assert.equal(mailer.outbox.filter(mine).length, 1, 'only once');
});

test('the console removes a company that never paid; one billed by bank transfer stays until its keep date', async () => {
  const ct = await consoleToken();
  const make = async (email, company, slug) => {
    const r = await ask(email, company);
    await ok(apex, 'POST', '/api/platform/request/verify', { body: { token: r.token, code: r.dev_code } });
    const q = (await ok(at('admin'), 'GET', '/api/console/requests', { token: ct })).requests.find((x) => x.email === email);
    await ok(at('admin'), 'POST', `/api/console/requests/${q.id}/approve`, { token: ct, body: {} });
    const t = decodeURIComponent(lastMail('access_approved', email).text.match(/#t=(\S+)/)[1]);
    return ok(apex, 'POST', '/api/platform/setup', { body: { t, slug, password: 'a-long-pass-123' } });
  };
  await make('tess@trialco.test', 'Trial Co', 'trialco');
  const c = await ok(at('admin'), 'GET', '/api/console/companies/trialco', { token: ct });
  assert.equal(c.removable, true); assert.equal(c.never_paid, true);
  assert.equal((await req(at('admin'), 'POST', '/api/console/companies/trialco/remove', { token: ct, body: { confirm: 'nope' } })).status, 400, 'the address has to be typed');
  assert.equal((await req(at('admin'), 'POST', '/api/console/companies/trialco/remove', { body: { confirm: 'trialco' } })).status, 401, 'console sign-in needed');
  await ok(at('admin'), 'POST', '/api/console/companies/trialco/remove', { token: ct, body: { confirm: 'trialco' } });
  assert.equal(P.row('trialco').status, 'deleted');
  assert.equal((await req(at('trialco'), 'GET', '/api/settings')).status, 404, 'the address stops working');
  assert.ok(!(await ok(at('admin'), 'GET', '/api/console/overview', { token: ct })).companies.some((x) => x.slug === 'trialco'), 'gone from the list');
  assert.equal((await req(at('admin'), 'GET', '/api/console/companies/trialco', { token: ct })).status, 404);
  assert.ok(fs.readdirSync(path.join(dataDir, 'removed')).some((d) => d.startsWith('trialco-')), 'moved aside, not erased');
  // a bank-transfer customer has paid outside Stripe: not removable on a whim
  await make('bo@bankco.test', 'Bank Co', 'bankco');
  await ok(at('admin'), 'POST', '/api/console/companies/bankco/flags', { token: ct, body: { manual_billing: true } });
  assert.equal((await ok(at('admin'), 'GET', '/api/console/companies/bankco', { token: ct })).removable, false);
  assert.equal((await req(at('admin'), 'POST', '/api/console/companies/bankco/remove', { token: ct, body: { confirm: 'bankco' } })).status, 400);
});
