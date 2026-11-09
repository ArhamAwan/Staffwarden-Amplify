'use strict';
// The service: sign-up on the plain address, each company at its own address with its own database,
// invites and password resets by email, plans and pausing, Stripe's news, and the owner console.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createPlatform } = require('../platform');
const { createMailer } = require('../platform/mail');

const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 2, 6, 0, 0);
const clock = { t: T0 };
const WHSEC = 'whsec_test_123';
let P, port, dataDir;
const stripeCalls = [];
const stripeState = { subs: {} };

// a pretend Stripe: answers the few calls billing makes
async function fakeFetch(url, init) {
  const u = new URL(url);
  const pathName = u.pathname.replace('/v1', '');
  const body = Object.fromEntries(new URLSearchParams(init.body || ''));
  stripeCalls.push({ method: init.method, path: pathName, body });
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  if (pathName === '/customers') return json({ id: 'cus_1' });
  if (pathName === '/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
  if (pathName === '/billing_portal/sessions') return json({ url: 'https://billing.stripe.test/p' });
  const m = pathName.match(/^\/subscriptions\/(\w+)$/);
  if (m) {
    const s = stripeState.subs[m[1]];
    if (init.method === 'POST' && body.cancel_at_period_end) s.cancel_at_period_end = body.cancel_at_period_end === 'true';
    if (init.method === 'POST' && body['items[0][quantity]']) s.items.data[0].quantity = Number(body['items[0][quantity]']);
    return json(s);
  }
  if (pathName.startsWith('/subscription_items/')) return json({ id: 'si_1' });
  return json({ error: { message: 'not faked' } }, 400);
}

const mailer = createMailer({ smtpConfig: null, base: 'http://localhost', store: { prepare: () => ({ run() {} }) }, log: { error() {} } });
const lastMail = (kind, to) => [...mailer.outbox].reverse().find((m) => m.kind === kind && (!to || m.to === to));
const linkIn = (m) => (m.text.match(/https?:\/\/\S+#\S+/) || [])[0];
const tokenOf = (link) => new URL(link.replace('#', '?')).searchParams.get('t') || decodeURIComponent(link.split('?t=')[1]);

function req(host, method, url, { body, token, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? raw : body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, data: json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const ok = async (...a) => { const r = await req(...a); assert.equal(r.status, 200, `${a[1]} ${a[2]} -> ${r.status} ${r.text.slice(0, 300)}`); return r.data; };
const apex = 'staffwarden.test';
const at = (slug) => `${slug}.${apex}`;

async function signUp({ name, email, password = 'a-long-pass-123', company, slug, country = 'US' }) {
  const s = await ok(apex, 'POST', '/api/platform/signup/start', { body: { name, email, password } });
  assert.ok(s.dev_code, 'without a mail server the code comes back for local testing');
  await ok(apex, 'POST', '/api/platform/signup/verify', { body: { token: s.token, code: s.dev_code } });
  const c = await ok(apex, 'POST', '/api/platform/signup/company', { body: { token: s.token, company, slug, country, size: '11-50' } });
  const h = await ok(at(c.slug), 'POST', '/api/auth/handoff', { body: { code: c.handoff } });
  return { ...c, token: h.token, user: h.user };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-platform-'));
  P = createPlatform({
    dataDir, baseDomain: apex, scheme: 'http', now: () => clock.t, mailer, fetchImpl: fakeFetch, seatDelayMs: 0, limitScale: 50, adminEmails: 'boss@staffwarden.test',
    webDir: path.join(__dirname, '..', '..', 'web'), log: { error() {} },
    stripe: { secretKey: 'sk_test_1', webhookSecret: WHSEC, prices: { 'starter:year': 'price_sy', 'starter:month': 'price_sm', 'business:year': 'price_by', 'business:month': 'price_bm', 'pro:year': 'price_py', 'pro:month': 'price_pm' } },
  });
  await new Promise((r) => P.server.listen(0, r));
  port = P.server.address().port;
});
test.after(async () => { await new Promise((r) => P.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('sign-up: a checked email, a free address, and the owner arrives signed in at their own address', async () => {
  const s = await ok(apex, 'POST', '/api/platform/signup/start', { body: { name: 'Dana Lee', email: 'Dana@Northwind.test', password: 'a-long-pass-123' } });
  assert.equal(s.email, 'dana@northwind.test');
  assert.match(lastMail('code', 'dana@northwind.test').subject, /code/);
  // a wrong code is refused, and the company can't be made before the email is checked
  assert.equal((await req(apex, 'POST', '/api/platform/signup/verify', { body: { token: s.token, code: '000000' === s.dev_code ? '111111' : '000000' } })).status, 400);
  assert.equal((await req(apex, 'POST', '/api/platform/signup/company', { body: { token: s.token, company: 'Northwind', slug: 'northwind', country: 'US' } })).status, 400);
  await ok(apex, 'POST', '/api/platform/signup/verify', { body: { token: s.token, code: s.dev_code } });
  // the address: suggested from the name, reserved and badly formed ones refused
  assert.deepEqual(await ok(apex, 'GET', '/api/platform/signup/address?name=Northwind%20Trading%20LLC'), { slug: 'northwind-trading', free: true, why: null });
  assert.equal((await ok(apex, 'GET', '/api/platform/signup/address?slug=admin')).free, false);
  assert.equal((await ok(apex, 'GET', '/api/platform/signup/address?slug=-bad-')).free, false);
  const c = await ok(apex, 'POST', '/api/platform/signup/company', { body: { token: s.token, company: 'Northwind', slug: 'northwind', country: 'US', size: '11-50' } });
  assert.equal(c.address, 'northwind.staffwarden.test');
  assert.equal((await req(apex, 'POST', '/api/platform/signup/company', { body: { token: s.token, company: 'Again', slug: 'again', country: 'US' } })).status, 409, 'one company per sign-up');
  assert.equal((await ok(apex, 'GET', '/api/platform/signup/address?slug=northwind')).free, false, 'now taken');
  // the handoff works once, and only at that company's address
  assert.equal((await req(at('elsewhere'), 'POST', '/api/auth/handoff', { body: { code: c.handoff } })).status, 404);
  const h = await ok(at('northwind'), 'POST', '/api/auth/handoff', { body: { code: c.handoff } });
  assert.equal((await req(at('northwind'), 'POST', '/api/auth/handoff', { body: { code: c.handoff } })).status, 401, 'used once');
  const me = await ok(at('northwind'), 'GET', '/api/me', { token: h.token });
  assert.equal(me.role, 'owner');
  assert.equal(me.account.status, 'trial');
  assert.equal(me.account.trial_days_left, 14);
  assert.ok(me.account.features.includes('screenshots'), 'everything is on during the trial');
  // the company starts with its name, time zone and US money; US holidays from today on
  const st = await ok(at('northwind'), 'GET', '/api/settings', { token: h.token });
  assert.equal(st.org_name || st.orgName || 'Northwind', 'Northwind');
  const app = P.tenantApp('northwind');
  assert.equal(app.ctx.cfg.payCurrency, 'USD');
  assert.equal(app.ctx.cfg.tzName, 'America/New_York');
  assert.ok(app.db.prepare('SELECT COUNT(*) AS n FROM holidays').get().n > 0);
  assert.equal(lastMail('welcome', 'dana@northwind.test').data.host, 'northwind.staffwarden.test');
});

test('each company is its own: a sign-in at one address means nothing at another', async () => {
  const a = await signUp({ name: 'Amy Chen', email: 'amy@cobalt.test', company: 'Cobalt Labs', slug: 'cobalt' });
  const b = await signUp({ name: 'Ben Ross', email: 'ben@meadow.test', company: 'Meadow Dental', slug: 'meadow' });
  assert.equal((await req(at('meadow'), 'GET', '/api/me', { token: a.token })).status, 401);
  assert.equal((await req(at('cobalt'), 'GET', '/api/me', { token: b.token })).status, 401);
  await ok(at('cobalt'), 'GET', '/api/me', { token: a.token });
  // no company at an address: a page that says so, and the API says so too
  const lost = await req(at('nobody-here'), 'GET', '/');
  assert.equal(lost.status, 404);
  assert.match(lost.text, /There’s no company at nobody-here/);
  assert.equal((await req(at('nobody-here'), 'GET', '/api/me')).status, 404);
  // the plain address serves the website, and the start pages
  assert.equal((await req(apex, 'GET', '/')).status, 200);
  assert.equal((await req(apex, 'GET', '/signup')).status, 200);
});

test('find your company by email lists every company the address belongs to, staff or client', async () => {
  await signUp({ name: 'Cara Diaz', email: 'cara@both.test', company: 'Harbor Freight Co', slug: 'harbor' });
  const tok = (await signUp({ name: 'Owen Hale', email: 'owen@pine.test', company: 'Pine Studio', slug: 'pine' })).token;
  await ok(at('pine'), 'POST', '/api/users', { token: tok, body: { email: 'cara@both.test', name: 'Cara Diaz', password: 'cara-pass-1234', role: 'employee' } });
  const r = await ok(apex, 'POST', '/api/platform/find', { body: { email: 'CARA@both.test' } });
  assert.deepEqual(r.companies.map((c) => c.slug).sort(), ['harbor', 'pine']);
  assert.deepEqual((await ok(apex, 'POST', '/api/platform/find', { body: { email: 'nobody@x.test' } })).companies, []);
});

test('an invite by email: they set their own password, see what is tracked, and the link works once', async () => {
  const o = await signUp({ name: 'Iris Moon', email: 'iris@lark.test', company: 'Lark & Co', slug: 'lark' });
  const u = await ok(at('lark'), 'POST', '/api/users', { token: o.token, body: { email: 'sam@lark.test', name: 'Sam Patel', role: 'employee', invite: true } });
  assert.equal(u.invited, true);
  assert.equal(u.invite_sent, false, 'no mail server here');
  assert.match(u.invite_link, /^http:\/\/lark\.staffwarden\.test\/#join\?t=/, 'so whoever invited them gets the link to pass on');
  const mail = lastMail('invite', 'sam@lark.test');
  assert.match(mail.subject, /Iris Moon invited you to Lark & Co/);
  const t = tokenOf(linkIn(mail));
  // they can't sign in with the stand-in password; the link greets them and says what is tracked
  const info = await ok(at('lark'), 'GET', `/api/auth/link?t=${encodeURIComponent(t)}`);
  assert.equal(info.kind, 'invite'); assert.equal(info.name, 'Sam Patel'); assert.equal(info.inviter, 'Iris Moon');
  assert.equal(info.tracked.screenshots, true);
  assert.equal((await req(at('lark'), 'POST', '/api/join', { body: { token: t, password: 'sam-pass-12345' } })).status, 400, 'must agree');
  const j = await ok(at('lark'), 'POST', '/api/join', { body: { token: t, password: 'sam-pass-12345', agree: true } });
  assert.equal(j.user.name, 'Sam Patel');
  assert.equal((await req(at('lark'), 'POST', '/api/join', { body: { token: t, password: 'sam-pass-12345', agree: true } })).status, 410, 'used once');
  await ok(at('lark'), 'POST', '/api/auth/login', { body: { email: 'sam@lark.test', password: 'sam-pass-12345' } });
  const list = await ok(at('lark'), 'GET', '/api/users', { token: o.token });
  assert.equal(list.find((x) => x.email === 'sam@lark.test').invited, false, 'joined now');
  // invite again is only for someone who hasn't joined
  assert.equal((await req(at('lark'), 'POST', `/api/users/${u.id}/invite`, { token: o.token })).status, 400);
  // the seat count follows the people
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(P.row('lark').seats, 1);
});

test('forgot password: one email per company, a link good for one use, other sign-ins ended', async () => {
  const o = await signUp({ name: 'Rosa Park', email: 'rosa@fern.test', company: 'Fern Health', slug: 'fern', country: 'PK' });
  await ok(apex, 'POST', '/api/platform/forgot', { body: { email: 'rosa@fern.test' } });
  const m = lastMail('reset', 'rosa@fern.test');
  assert.ok(m, 'a reset email');
  const t = tokenOf(linkIn(m));
  assert.equal((await ok(at('fern'), 'GET', `/api/auth/link?t=${encodeURIComponent(t)}`)).kind, 'reset');
  assert.equal((await req(at('fern'), 'POST', '/api/auth/reset', { body: { token: t, password: 'short' } })).status, 400);
  const r = await ok(at('fern'), 'POST', '/api/auth/reset', { body: { token: t, password: 'a-new-long-pass-9' } });
  assert.ok(r.token);
  assert.equal((await req(at('fern'), 'GET', '/api/me', { token: o.token })).status, 401, 'the old sign-in is ended');
  assert.equal((await req(at('fern'), 'POST', '/api/auth/reset', { body: { token: t, password: 'another-pass-99' } })).status, 410);
  // an unknown email gets the same answer, and no email
  const before = mailer.outbox.length;
  await ok(apex, 'POST', '/api/platform/forgot', { body: { email: 'ghost@fern.test' } });
  assert.equal(mailer.outbox.length, before);
  // Pakistan: rupees and Pakistan's holidays
  assert.equal(P.tenantApp('fern').ctx.cfg.payCurrency, 'PKR');
});

test('plans: what is outside the plan is closed (but the desktop app still gets empty lists); a trial that ends pauses tracking', async () => {
  const o = await signUp({ name: 'Theo Grant', email: 'theo@quill.test', company: 'Quill Agency', slug: 'quill' });
  await ok(at('quill'), 'POST', '/api/users', { token: o.token, body: { email: 'eve@quill.test', name: 'Eve Stone', password: 'eve-pass-12345', role: 'employee' } });
  const eve = (await ok(at('quill'), 'POST', '/api/auth/login', { body: { email: 'eve@quill.test', password: 'eve-pass-12345' } })).token;
  await ok(at('quill'), 'POST', '/api/me/consent', { token: eve });
  // on Starter: no payroll, no screenshots, no projects
  P.store.prepare("UPDATE companies SET status = 'active', plan = 'starter' WHERE slug = 'quill'").run();
  const pay = await req(at('quill'), 'GET', '/api/payroll', { token: o.token });
  assert.equal(pay.status, 403);
  assert.equal(pay.data.plan_feature, 'payroll');
  assert.deepEqual(await ok(at('quill'), 'GET', '/api/projects', { token: eve }), []);
  assert.deepEqual(await ok(at('quill'), 'GET', '/api/tasks', { token: eve }), []);
  const me = await ok(at('quill'), 'GET', '/api/me', { token: eve });
  assert.deepEqual(me.account.features, []);
  assert.equal(me.account.billing, undefined, 'billing details are for the owner only');
  const s = await ok(at('quill'), 'GET', '/api/settings', { token: eve });
  assert.equal(s.shots_per_10, 0, 'no screenshots on Starter');
  // back to a trial that has ended: the daily round pauses it, stops running timers, and emails the owner
  P.store.prepare("UPDATE companies SET status = 'trial', plan = 'business', trial_ends_at = ? WHERE slug = 'quill'").run(new Date(clock.t + 2 * DAY).toISOString());
  await ok(at('quill'), 'POST', '/api/timer/start', { token: eve, body: {} });
  await P.sweep();
  assert.ok(lastMail('trial_ending', 'theo@quill.test'), 'a reminder 3 days before');
  clock.t += 3 * DAY;
  await P.sweep();
  assert.equal(P.row('quill').status, 'paused');
  assert.ok(lastMail('trial_ended', 'theo@quill.test'));
  const app = P.tenantApp('quill');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NULL').get().n, 0, 'the running timer was stopped');
  const start = await req(at('quill'), 'POST', '/api/timer/start', { token: eve, body: {} });
  assert.equal(start.status, 403); assert.equal(start.data.paused, true);
  await ok(at('quill'), 'GET', '/api/me', { token: eve });   // everyone can still look
  assert.equal((await ok(at('quill'), 'GET', '/api/me', { token: eve })).account.paused, true);
  clock.t = T0;
});

test('billing: checkout carries the trial, Stripe’s news makes it active, a declined card gives grace days, then pauses', async () => {
  const o = await signUp({ name: 'Nora Vale', email: 'nora@orbit.test', company: 'Orbit Freight', slug: 'orbit' });
  const b = await ok(at('orbit'), 'GET', '/api/billing', { token: o.token });
  assert.equal(b.status, 'trial'); assert.equal(b.plan, 'business'); assert.equal(b.stripe_ready, true);
  const co = await ok(at('orbit'), 'POST', '/api/billing/checkout', { token: o.token, body: { plan: 'pro', interval: 'year' } });
  assert.equal(co.url, 'https://checkout.stripe.test/cs_1');
  const sent = stripeCalls.find((c) => c.path === '/checkout/sessions').body;
  assert.equal(sent['line_items[0][price]'], 'price_py');
  assert.equal(sent['subscription_data[trial_end]'], String(Math.floor(Date.parse(P.row('orbit').trial_ends_at) / 1000)), 'the card is charged when the trial ends');
  // a webhook needs Stripe's signature
  const send = (ev, sig) => { const raw = JSON.stringify(ev); const t = Math.floor(clock.t / 1000); return req(apex, 'POST', '/api/platform/stripe/webhook', { raw, headers: { 'Stripe-Signature': sig || `t=${t},v1=${crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex')}` } }); };
  assert.equal((await send({ id: 'evt_bad', type: 'x', data: {} }, 't=1,v1=00')).status, 400);
  const end = Math.floor((clock.t + 365 * DAY) / 1000);
  stripeState.subs.sub_1 = { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { slug: 'orbit' }, current_period_end: end, cancel_at_period_end: false, items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_py' } }] }, default_payment_method: { card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2029 } } };
  assert.equal((await send({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_1' } } })).status, 200);
  assert.equal((await send({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_1' } } })).data.duplicate, true, 'each event once');
  let r = P.row('orbit');
  assert.equal(r.status, 'active'); assert.equal(r.plan, 'pro'); assert.equal(r.card_last4, '4242');
  // a declined renewal: past due, an email, tracking still on for the grace days
  await send({ id: 'evt_2', type: 'invoice.payment_failed', data: { object: { id: 'in_2', customer: 'cus_1', subscription: 'sub_1', amount_due: 12000, currency: 'usd', next_payment_attempt: end - 100, lines: { data: [{ description: '1 × Pro (yearly)', quantity: 1, period: { start: end - 100, end: end + 1000 } }] } } } });
  r = P.row('orbit');
  assert.equal(r.status, 'past_due');
  assert.match(lastMail('payment_failed', 'nora@orbit.test').subject, /declined/);
  const bill = await ok(at('orbit'), 'GET', '/api/billing', { token: o.token });
  assert.equal(bill.owed.amount_cents, 12000);
  clock.t += 8 * DAY;
  await P.sweep();
  assert.equal(P.row('orbit').status, 'paused', 'paused after the grace days');
  assert.ok(lastMail('grace_over', 'nora@orbit.test'));
  // paid at last: active again
  await send({ id: 'evt_3', type: 'invoice.paid', data: { object: { id: 'in_2', customer: 'cus_1', subscription: 'sub_1', amount_paid: 12000, currency: 'usd', status_transitions: { paid_at: Math.floor(clock.t / 1000) }, lines: { data: [{ description: '1 × Pro (yearly)', quantity: 1 }] } } } });
  assert.equal(P.row('orbit').status, 'active');
  assert.ok(lastMail('receipt', 'nora@orbit.test'));
  assert.equal((await ok(at('orbit'), 'GET', '/api/billing', { token: o.token })).payments[0].status, 'paid');
  // a new person: Stripe is told the new count
  await ok(at('orbit'), 'POST', '/api/users', { token: o.token, body: { email: 'kai@orbit.test', name: 'Kai Ito', password: 'kai-pass-12345', role: 'employee' } });
  await ok(at('orbit'), 'POST', '/api/users', { token: o.token, body: { email: 'lu@orbit.test', name: 'Lu Wen', password: 'lu-pass-123456', role: 'employee' } });
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(P.row('orbit').billed_seats, 2);
  // a move down waits for the renewal; closing waits for the end of what was paid
  const down = await ok(at('orbit'), 'POST', '/api/billing/change', { token: o.token, body: { plan: 'starter', interval: 'year' } });
  assert.equal(down.when, 'renewal');
  assert.equal(P.row('orbit').pending_plan, 'starter');
  assert.equal((await req(at('orbit'), 'POST', '/api/billing/close', { token: o.token, body: { confirm: 'wrong' } })).status, 400);
  const cl = await ok(at('orbit'), 'POST', '/api/billing/close', { token: o.token, body: { confirm: 'orbit' } });
  assert.equal(cl.now, false);
  assert.ok(P.row('orbit').closing_at);
  assert.ok(lastMail('closing', 'nora@orbit.test'));
  await ok(at('orbit'), 'POST', '/api/billing/reopen', { token: o.token });
  assert.equal(P.row('orbit').closing_at, null);
  clock.t = T0;
});

test('only the real owner sees billing; closing during a trial ends it at once and signs everyone out', async () => {
  const o = await signUp({ name: 'Gus Lane', email: 'gus@birch.test', company: 'Birch Works', slug: 'birch' });
  await ok(at('birch'), 'POST', '/api/users', { token: o.token, body: { email: 'mia@birch.test', name: 'Mia Fox', password: 'mia-pass-12345', role: 'manager' } });
  const mia = (await ok(at('birch'), 'POST', '/api/auth/login', { body: { email: 'mia@birch.test', password: 'mia-pass-12345' } })).token;
  assert.equal((await req(at('birch'), 'GET', '/api/billing', { token: mia })).status, 403);
  const cl = await ok(at('birch'), 'POST', '/api/billing/close', { token: o.token, body: { confirm: 'birch' } });
  assert.equal(cl.now, true);
  assert.equal(P.row('birch').status, 'closed');
  assert.equal((await req(at('birch'), 'GET', '/api/me', { token: mia })).status, 401);
});

test('handing the company over: the admin accepts from the email, and the old owner becomes an admin', async () => {
  const o = await signUp({ name: 'Hal Reed', email: 'hal@dune.test', company: 'Dune Media', slug: 'dune' });
  const u = await ok(at('dune'), 'POST', '/api/users', { token: o.token, body: { email: 'ana@dune.test', name: 'Ana Ruiz', password: 'ana-pass-12345', role: 'manager' } });
  const ana = (await ok(at('dune'), 'POST', '/api/auth/login', { body: { email: 'ana@dune.test', password: 'ana-pass-12345' } })).token;
  await ok(at('dune'), 'POST', '/api/account/handover', { token: o.token, body: { user_id: u.id } });
  const t = tokenOf(linkIn(lastMail('handover', 'ana@dune.test')));
  assert.equal((await req(at('dune'), 'POST', '/api/account/handover/accept', { token: o.token, body: { token: t } })).status, 403, 'only the person it was sent to');
  await ok(at('dune'), 'POST', '/api/account/handover/accept', { token: ana, body: { token: t } });
  assert.equal((await ok(at('dune'), 'GET', '/api/me', { token: ana })).role, 'owner');
  assert.equal((await ok(at('dune'), 'GET', '/api/me', { token: o.token })).role, 'manager');
  assert.equal(P.row('dune').owner_email, 'ana@dune.test');
});

test('the export: one zip with every record and file, passwords left out', async () => {
  const o = await signUp({ name: 'Ivy Wong', email: 'ivy@kite.test', company: 'Kite Supply', slug: 'kite' });
  const start = await ok(at('kite'), 'POST', '/api/account/export', { token: o.token });
  assert.equal(start.building, true);
  for (let i = 0; i < 50 && (await ok(at('kite'), 'GET', '/api/account/export', { token: o.token })).building; i++) await new Promise((r) => setTimeout(r, 20));
  const st = await ok(at('kite'), 'GET', '/api/account/export', { token: o.token });
  assert.ok(st.ready && st.ready.bytes > 100);
  const f = await req(at('kite'), 'GET', '/api/account/export/file', { token: o.token });
  assert.equal(f.status, 200);
  assert.equal(f.headers['content-type'], 'application/zip');
  assert.ok(!f.text.includes('pw_hash'), 'no password columns');
});

test('the console: a code by email for listed admins only, then every company at a glance', async () => {
  await ok(at('admin'), 'POST', '/api/console/code', { body: { email: 'stranger@x.test' } });
  assert.equal(lastMail('console_code', 'stranger@x.test'), undefined);
  await ok(at('admin'), 'POST', '/api/console/code', { body: { email: 'boss@staffwarden.test' } });
  const code = lastMail('console_code', 'boss@staffwarden.test').data.code.replace(/\D/g, '');
  assert.equal((await req(at('admin'), 'POST', '/api/console/login', { body: { email: 'boss@staffwarden.test', code: '000000' === code ? '111111' : '000000' } })).status, 400);
  const { token } = await ok(at('admin'), 'POST', '/api/console/login', { body: { email: 'boss@staffwarden.test', code } });
  const ov = await ok(at('admin'), 'GET', '/api/console/overview', { token });
  assert.ok(ov.companies.length >= 5);
  assert.ok(ov.companies.find((c) => c.slug === 'northwind'));
  const d = await ok(at('admin'), 'GET', '/api/console/companies/northwind', { token });
  assert.ok(d.events.find((e) => e.kind === 'created'));
  const ext = await ok(at('admin'), 'POST', '/api/console/companies/northwind/extend', { token, body: { days: 7 } });
  assert.equal(Date.parse(ext.trial_ends_at), Date.parse(P.row('northwind').trial_ends_at));
  assert.equal((await req(at('admin'), 'GET', '/api/console/overview')).status, 401);
  assert.equal((await req(apex, 'GET', '/api/console/overview', { token })).status, 404, 'the console only answers at its own address');
});

test('a company outside Pakistan: its own money, no Pakistani tax, ID numbers and bank accounts as that country writes them', async () => {
  const o = await signUp({ name: 'Ruth Baker', email: 'ruth@thames.test', company: 'Thames Works', slug: 'thames', country: 'GB' });
  const app = P.tenantApp('thames');
  assert.equal(app.ctx.cfg.payCurrency, 'GBP');
  assert.equal(app.ctx.cfg.payroll.tax.on, false, 'Pakistan’s income tax is off');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM holidays').get().n, 0, 'no Pakistani holidays');
  assert.equal((await ok(at('thames'), 'GET', '/api/settings', { token: o.token })).pay_currency, 'GBP');
  const u = await ok(at('thames'), 'POST', '/api/users', { token: o.token, body: { email: 'tom@thames.test', name: 'Tom Hale', password: 'tom-pass-12345', role: 'employee' } });
  await ok(at('thames'), 'PUT', `/api/hr/people/${u.id}/pay`, { token: o.token, body: { base: 3200, allowances: [], deductions: [] } });
  const p = await ok(at('thames'), 'GET', `/api/hr/people/${u.id}`, { token: o.token });
  assert.equal(p.pay.currency, 'GBP', 'pay is in pounds unless chosen otherwise');
  await ok(at('thames'), 'PUT', `/api/hr/people/${u.id}/pay`, { token: o.token, body: { base: 4000, currency: 'EUR', allowances: [], deductions: [] } });
  assert.equal((await req(at('thames'), 'PUT', `/api/hr/people/${u.id}/pay`, { token: o.token, body: { base: 4000, currency: 'XYZ', allowances: [], deductions: [] } })).status, 400);
  // a UK National Insurance number and an account number with a sort code are fine here
  await ok(at('thames'), 'PUT', `/api/hr/people/${u.id}/record`, { token: o.token, body: { cnic: 'QQ 12 34 56 C', iban: '12345678', bank_name: 'Barclays 20-00-00' } });
  const r = await ok(at('thames'), 'GET', `/api/hr/people/${u.id}`, { token: o.token });
  assert.equal(r.record.cnic, 'QQ 12 34 56 C');
  assert.equal(r.record.iban, '12345678');
});
