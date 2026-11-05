'use strict';
// HR and payroll: who can see what, a month worked out from attendance and leave, the steps from draft
// to paid, and what each person sees on their payslip.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env, sara, hamza, fatima, ayesha, bilal;
const NOV2 = Date.UTC(2026, 10, 2, 5, 0);        // Mon 2 Nov 2026, 10:00 in Pakistan
before(async () => {
  env = await makeEnv();
  ayesha = await env.person('ayesha', 'Ayesha Noor', { role: 'manager' });
  sara = await env.person('sara', 'Sara Khan');
  hamza = await env.person('hamza', 'Hamza Tariq');
  fatima = await env.person('fatima', 'Fatima Aziz');
  bilal = await env.person('bilal', 'Bilal Ahmed');
});
after(() => env.close());
// payroll is run for a month once it has begun: move the clock into the month after, as in real life
async function startRun(period) {
  const [y, m] = period.split('-').map(Number);
  const t = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 2, 5, 0, 0);
  if (env.clock.t < t) env.set(t);
  return env.ok('POST', '/api/payroll/runs', { token: env.tokens.fatima, body: { period } });
}

const slipOf = (detail, id) => detail.slips.find((s) => s.user_id === id);
const line = (slip, key) => slip.lines.find((l) => l.key === key);

test('only the owner makes someone HR, and HR sees records but never screenshots', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('PATCH', `/api/users/${fatima.id}`, { token: tokens.ayesha, body: { hr: true } })).status, 403);
  await ok('PATCH', `/api/users/${fatima.id}`, { token: tokens.owner, body: { hr: true } });
  assert.equal((await ok('GET', '/api/me', { token: tokens.fatima })).hr, true);
  assert.equal((await ok('GET', '/api/hr/people', { token: tokens.fatima })).length, 6);
  for (const who of ['sara', 'ayesha']) assert.equal((await api('GET', '/api/hr/people', { token: tokens[who] })).status, 403, who);
  // HR is not a manager: no screenshots, activity or other people's days
  assert.equal((await api('GET', `/api/screenshots?user_id=${sara.id}&day=2026-10-23`, { token: tokens.fatima })).status, 403);
  assert.equal((await api('GET', `/api/users/${sara.id}/day`, { token: tokens.fatima })).status, 403);
});

test('records and pay are kept, pay changes are told to the person and kept as history', async () => {
  const { ok, api, tokens } = env;
  for (const [p, base, cur, tax, contract] of [[sara, 120000, 'PKR', 'pk', 'full_time'], [hamza, 2500, 'USD', 'none', 'contractor'], [bilal, 90000, 'PKR', 'pk', 'probation'], [ayesha, 180000, 'PKR', 'pk', 'full_time']]) {
    await ok('PUT', `/api/hr/people/${p.id}/record`, { token: tokens.fatima, body: { contract, joined_on: '2025-03-03', bank_name: 'Meezan Bank', account_title: p.name, iban: p === bilal ? null : 'PK36MEZN0000001122334821' } });
    await ok('PUT', `/api/hr/people/${p.id}/pay`, { token: tokens.fatima, body: { base, currency: cur, tax_mode: tax, ...(p === ayesha ? { allowances: [{ label: 'Team lead allowance', amount: 15000 }] } : {}) } });
  }
  assert.equal((await api('PUT', `/api/hr/people/${sara.id}/record`, { token: tokens.fatima, body: { iban: 'not an iban' } })).status, 400);
  // HR cannot set their own pay; the owner does
  assert.equal((await api('PUT', `/api/hr/people/${fatima.id}/pay`, { token: tokens.fatima, body: { base: 999999 } })).status, 403);
  await ok('PUT', `/api/hr/people/${fatima.id}/pay`, { token: tokens.owner, body: { base: 150000 } });
  await ok('PUT', `/api/hr/people/${fatima.id}/record`, { token: tokens.fatima, body: { joined_on: '2026-09-01', iban: 'PK11HABB0000000000001111' } });
  // the person sees their record with the account number masked, and is told their pay was set
  const me = await ok('GET', '/api/me/hr', { token: tokens.sara });
  assert.equal(me.record.iban, '••• 4821');
  assert.equal(me.pay.base, 120000);
  assert.ok((await ok('GET', '/api/me/changes', { token: tokens.sara })).some((c) => c.title === 'Your pay was set'));
  await ok('PUT', `/api/hr/people/${sara.id}/pay`, { token: tokens.fatima, body: { base: 120000, note: 'unchanged' } });
  assert.equal((await ok('GET', `/api/hr/people/${sara.id}`, { token: tokens.fatima })).history.length, 1, 'same pay adds no history');
});

test('October is worked out from leave, rules and what HR adds', async () => {
  const { ok, api, tokens, set } = env;
  // two days of unpaid leave, Wed and Thu
  set(Date.UTC(2026, 9, 24, 5, 0));
  await ok('POST', '/api/timeoff', { token: tokens.owner, body: { user_id: sara.id, kind: 'unpaid', start_day: '2026-10-14', end_day: '2026-10-15' } });
  await ok('PUT', '/api/payroll/rules', { token: tokens.fatima, body: { absent: 'off' } });
  set(NOV2);
  assert.equal((await api('POST', '/api/payroll/runs', { token: tokens.sara, body: { period: '2026-10' } })).status, 403);
  let d = await ok('POST', '/api/payroll/runs', { token: tokens.fatima, body: { period: '2026-10' } });
  assert.equal(d.run.status, 'draft');
  const s = slipOf(d, sara.id);
  assert.equal(line(s, 'base').amount, 120000);
  assert.equal(line(s, 'unpaid').amount, -Math.round((120000 / 22) * 2));
  assert.match(line(s, 'unpaid').source, /2 days/);
  assert.equal(s.tax, 1500);
  assert.equal(s.net, 120000 - 10909 - 1500);
  // the contractor in dollars: no tax
  const h = slipOf(d, hamza.id);
  assert.equal(h.currency, 'USD'); assert.equal(h.tax, 0); assert.equal(h.net, 2500);
  // allowance and its tax
  const a = slipOf(d, ayesha.id);
  assert.equal(a.gross, 195000); assert.equal(a.tax, 12000);
  // Fatima joined in September; the owner is not paid here
  assert.ok(slipOf(d, fatima.id));
  assert.equal(d.slips.length, 5);
  assert.ok(d.checks.some((c) => c.kind === 'bank' && /Bilal/.test(c.text)));
  // commission goes in and is taxed
  await ok('POST', `/api/payroll/runs/${d.run.id}/items`, { token: tokens.fatima, body: { user_id: sara.id, kind: 'commission', amount: 11250, reason: '9 closed deals' } });
  assert.equal((await api('POST', `/api/payroll/runs/${d.run.id}/items`, { token: tokens.fatima, body: { user_id: sara.id, kind: 'bonus', amount: 100 } })).status, 400, 'a reason is needed');
  assert.equal((await api('POST', `/api/payroll/runs/${d.run.id}/items`, { token: tokens.fatima, body: { user_id: fatima.id, kind: 'bonus', amount: 5000, reason: 'me' } })).status, 403, 'not their own pay');
  d = await ok('GET', `/api/payroll/runs/${d.run.id}`, { token: tokens.fatima });
  const s2 = slipOf(d, sara.id);
  assert.equal(line(s2, s2.lines.find((l) => l.kind === 'commission').key).amount, 11250);
  assert.ok(s2.tax > 1500);
  // absent days, once the rule takes them off: no time tracked since she was added on Oct 23
  await ok('PUT', '/api/payroll/rules', { token: tokens.fatima, body: { absent: 'show' } });
  d = await ok('POST', `/api/payroll/runs/${d.run.id}/refresh`, { token: tokens.fatima });
  const ab = line(slipOf(d, bilal.id), 'absent');
  assert.equal(ab.counted, false, 'shown only');
  assert.match(ab.source, /6 days/);
  assert.equal(slipOf(d, bilal.id).net, 90000 - slipOf(d, bilal.id).tax, 'a shown line does not change pay');
  await ok('PUT', '/api/payroll/rules', { token: tokens.fatima, body: { absent: 'off' } });
  await ok('POST', `/api/payroll/runs/${d.run.id}/refresh`, { token: tokens.fatima });
});

test('people see their payslip in review, a question holds approval, the owner approves', async () => {
  const { ok, api, tokens } = env;
  const run = (await ok('GET', '/api/payroll', { token: tokens.fatima })).runs[0];
  assert.equal((await ok('GET', '/api/me/pay', { token: tokens.sara })).slips.length, 0, 'nothing while it is a draft');
  await ok('POST', `/api/payroll/runs/${run.id}/submit`, { token: tokens.fatima });
  const mine = await ok('GET', '/api/me/pay', { token: tokens.sara });
  assert.equal(mine.slips.length, 1);
  assert.equal(mine.bank.last4, '4821');
  const slip = await ok('GET', `/api/payroll/slips/${mine.slips[0].id}`, { token: tokens.sara });
  assert.equal(slip.items, undefined, 'the person does not get HR’s working');
  assert.equal((await api('GET', `/api/payroll/slips/${mine.slips[0].id}`, { token: tokens.hamza })).status, 404);
  await ok('POST', `/api/payroll/slips/${slip.id}/questions`, { token: tokens.sara, body: { line: 'Unpaid leave', text: 'The 15th was sick leave' } });
  // HR cannot approve while the owner approves; the owner cannot approve with a question open
  assert.equal((await api('POST', `/api/payroll/runs/${run.id}/approve`, { token: tokens.fatima })).status, 403);
  assert.equal((await api('POST', `/api/payroll/runs/${run.id}/approve`, { token: tokens.owner })).status, 409);
  const q = (await ok('GET', `/api/payroll/slips/${slip.id}`, { token: tokens.fatima })).questions[0];
  await ok('POST', `/api/payroll/questions/${q.id}/answer`, { token: tokens.fatima, body: { answer: 'Both days were approved as unpaid.' } });
  const d = await ok('POST', `/api/payroll/runs/${run.id}/approve`, { token: tokens.owner });
  assert.equal(d.run.status, 'approved');
  // locked
  assert.equal((await api('POST', `/api/payroll/runs/${run.id}/items`, { token: tokens.fatima, body: { user_id: sara.id, kind: 'bonus', amount: 1, reason: 'late' } })).status, 409);
  // the bank sheet: people with bank details, in their currency
  const bank = await api('GET', `/api/payroll/runs/${run.id}/bank.csv`, { token: tokens.fatima, raw: true });
  assert.equal(bank.status, 200);
  const text = String(bank.data);
  assert.match(text, /Sara Khan,Sara Khan,Meezan Bank,PK36 MEZN/);
  assert.ok(!/Bilal/.test(text), 'no bank details, so not on the sheet');
  assert.match(String((await api('GET', `/api/payroll/runs/${run.id}/register.csv`, { token: tokens.fatima, raw: true })).data), /Net pay/);
  await ok('POST', `/api/payroll/runs/${run.id}/paid`, { token: tokens.fatima, body: { ref: 'MZ-1101' } });
  assert.equal((await api('POST', `/api/payroll/runs/${run.id}/reopen`, { token: tokens.owner, body: { reason: 'x' } })).status, 409, 'paid stays paid');
  const year = (await ok('GET', '/api/me/pay', { token: tokens.sara })).year;
  assert.equal(year.tax_year, 2027);
  assert.equal(year.net, d.slips.find((s) => s.user_id === sara.id).net);
});

test('an advance is paid back from the month after it is approved; expenses are paid with salary', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('POST', '/api/advances', { token: tokens.sara, body: { amount: 500000, months: 5 } })).status, 400, 'at most one month of salary');
  const adv = await ok('POST', '/api/advances', { token: tokens.sara, body: { amount: 50000, months: 5, reason: 'Family wedding' } });
  assert.equal((await api('POST', `/api/advances/${adv.id}/decide`, { token: tokens.sara, body: { approve: true } })).status, 403);
  await ok('POST', `/api/advances/${adv.id}/decide`, { token: tokens.fatima, body: { approve: true } });
  const exp = await ok('POST', '/api/expenses', { token: tokens.sara, body: { amount: 6500, category: 'equipment', spent_on: '2026-11-01', note: 'Headset for calls' } });
  assert.equal((await api('POST', `/api/expenses/${exp.id}/decide`, { token: tokens.hamza, body: { approve: true } })).status, 403);
  await ok('POST', `/api/expenses/${exp.id}/decide`, { token: tokens.fatima, body: { approve: true } });
  // November: the advance is not repaid yet (approved in November, repaid from December), the expense is paid
  const nov = await startRun('2026-11');
  const s = slipOf(nov, sara.id);
  assert.ok(!s.lines.some((l) => l.kind === 'advance'));
  const e = s.lines.find((l) => l.kind === 'expense');
  assert.equal(e.amount, 6500); assert.equal(e.taxable, false);
  await ok('POST', `/api/payroll/runs/${nov.run.id}/approve`, { token: tokens.owner });
  assert.equal((await ok('GET', '/api/expenses?scope=mine', { token: tokens.sara }))[0].status, 'paid');
  await ok('POST', `/api/payroll/runs/${nov.run.id}/paid`, { token: tokens.fatima, body: {} });
  const dec = await startRun('2026-12');
  const r = slipOf(dec, sara.id).lines.find((l) => l.kind === 'advance');
  assert.equal(r.amount, -10000);
  assert.match(r.source, /^1 of 5/);
  await ok('DELETE', `/api/payroll/runs/${dec.run.id}`, { token: tokens.fatima });
});

test('someone leaving: their last month is cut at the last day, with unused leave paid', async () => {
  const { ok, tokens } = env;
  await ok('PUT', `/api/hr/people/${bilal.id}/record`, { token: tokens.fatima, body: { leaving_on: '2026-12-11', leaving_reason: 'Resigned' } });
  const p = await ok('GET', `/api/hr/people/${bilal.id}`, { token: tokens.fatima });
  assert.ok(p.leave_steps && p.leave_steps.length >= 5);
  const d = await startRun('2026-12');
  const s = slipOf(d, bilal.id);
  // December 2026 has 23 working days; up to Fri 11 Dec there are 9
  assert.equal(line(s, 'base').amount, Math.round((90000 / 23) * 9));
  assert.match(line(s, 'base').source, /9 of 23/);
  assert.ok(line(s, 'leave_payout').amount > 0);
});

test('EOBI and the HR overview', async () => {
  const { ok, tokens } = env;
  await ok('PUT', '/api/payroll/rules', { token: tokens.fatima, body: { eobi: { on: true, min_wage: 40700, er: 5, ee: 1 } } });
  const run = (await ok('GET', '/api/payroll', { token: tokens.fatima })).runs[0];
  const d = await ok('POST', `/api/payroll/runs/${run.id}/refresh`, { token: tokens.fatima });
  const s = slipOf(d, sara.id);
  assert.equal(line(s, 'eobi').amount, -407);
  assert.deepEqual(s.employer.map((e) => e.amount), [2035]);
  assert.ok(!line(slipOf(d, hamza.id), 'eobi'), 'not for a contractor in dollars');
  const o = await ok('GET', '/api/hr/overview', { token: tokens.fatima });
  assert.ok(o.items.some((i) => i.kind === 'payroll'));
  // Bilal left on Dec 11: the reminder shows before that day and not after
  assert.ok(!o.items.some((i) => i.kind === 'leaving'));
  const now = env.clock.t; env.set(Date.UTC(2026, 11, 1, 5));
  assert.ok((await ok('GET', '/api/hr/overview', { token: tokens.fatima })).items.some((i) => i.kind === 'leaving'));
  env.set(now);
  assert.ok(o.items.some((i) => i.kind === 'no_bank' && /Bilal/.test(i.title)));
  assert.equal(o.stats.people, 5);
});

test('documents, joining steps and time off for HR', async () => {
  const { ok, api, tokens, PNG } = env;
  const doc = await ok('POST', `/api/hr/people/${sara.id}/docs`, { token: tokens.fatima, body: { name: 'Employment contract', kind: 'contract', status: 'signed', type: 'image/png', data_base64: PNG.toString('base64') } });
  assert.equal((await api('POST', `/api/hr/people/${sara.id}/docs`, { token: tokens.fatima, body: { name: 'x', type: 'text/html', data_base64: 'PGgxPg==' } })).status, 400);
  // the person can open their own document, nobody else can
  assert.equal((await api('GET', `/api/hr/docs/${doc.id}`, { token: tokens.sara, raw: true })).status, 200);
  assert.equal((await api('GET', `/api/hr/docs/${doc.id}`, { token: tokens.hamza, raw: true })).status, 403);
  assert.equal((await api('GET', `/api/hr/docs/${doc.id}`, { token: tokens.ayesha, raw: true })).status, 403, 'not even a manager');
  const p = await ok('GET', `/api/hr/people/${sara.id}`, { token: tokens.fatima });
  assert.ok(p.join_steps.find((s) => s.key === 'contract').done, 'a signed contract ticks its step');
  assert.ok(p.join_steps.find((s) => s.key === 'bank').done);
  const st = await ok('PUT', `/api/hr/people/${sara.id}/steps`, { token: tokens.fatima, body: { flow: 'join', step: 'checkin', done: true } });
  assert.ok(st.find((s) => s.key === 'checkin').done);
  // HR decides anyone's time off
  const tr = await ok('POST', '/api/timeoff', { token: tokens.hamza, body: { kind: 'vacation', start_day: '2026-11-24', end_day: '2026-11-26' } });
  assert.ok((await ok('GET', '/api/timeoff?status=pending', { token: tokens.fatima })).some((r) => r.id === tr.id));
  await ok('POST', `/api/timeoff/${tr.id}/decision`, { token: tokens.fatima, body: { approve: true } });
  // viewing someone's record is in the audit log
  assert.ok((await ok('GET', '/api/audit?limit=50', { token: tokens.owner })).some((a) => a.action === 'hr.viewed' && a.actor_name === 'Fatima Aziz'));
});

test('people imported from contracts get an account, record and pay; a bad field saves nothing', async () => {
  const { ok, api, tokens, login } = env;
  const body = { name: 'Zara Malik', email: 'Zara.Malik@example.com', title: 'Call Agent', record: { contract: 'probation', joined_on: '2026-09-01', probation_end: '2026-12-01', notice_days: 30, phone: '0301 2345678', cnic: '6110112345678', iban: 'PK36MEZN0000001122334821', bank_name: 'Meezan Bank' }, pay: { base: 95000, currency: 'PKR', tax_mode: 'pk', effective_from: '2026-09-01' } };
  // only HR and the owner import
  assert.equal((await api('POST', '/api/hr/import', { token: tokens.ayesha, body })).status, 403);
  // a bad IBAN: nothing is created, so no account is left behind without its password
  assert.equal((await api('POST', '/api/hr/import', { token: tokens.fatima, body: { ...body, record: { ...body.record, iban: 'nope' } } })).status, 400);
  assert.equal((await ok('GET', '/api/hr/people', { token: tokens.fatima })).some((p) => p.email === 'zara.malik@example.com'), false);
  const r = await ok('POST', '/api/hr/import', { token: tokens.fatima, body });
  assert.equal(r.created, true);
  assert.equal(r.email, 'zara.malik@example.com');
  assert.ok(r.password && r.password.length >= 12);
  assert.ok(await login('zara.malik@example.com', r.password));
  const p = await ok('GET', `/api/hr/people/${r.id}`, { token: tokens.fatima });
  assert.equal(p.title, 'Call Agent');
  assert.equal(p.record.cnic, '61101-1234567-8');
  assert.equal(p.record.contract, 'probation');
  assert.equal(p.pay.base, 95000);
  assert.equal(p.history[0].effective_from, '2026-09-01');
  // the same email again is refused; matching an existing person updates them instead
  assert.equal((await api('POST', '/api/hr/import', { token: tokens.fatima, body })).status, 409);
  const u = await ok('POST', '/api/hr/import', { token: tokens.fatima, body: { existing_id: r.id, title: 'Senior Call Agent', record: { notice_days: 15 } } });
  assert.equal(u.created, false);
  assert.equal(u.password, null);
  const p2 = await ok('GET', `/api/hr/people/${r.id}`, { token: tokens.fatima });
  assert.equal(p2.title, 'Senior Call Agent');
  assert.equal(p2.record.notice_days, 15);
  assert.equal(p2.record.iban, 'PK36 MEZN 0000 0011 2233 4821');
});

test('developer and test accounts are not employees: off payroll and HR reminders, and HR can move them back', async () => {
  const { ok, tokens } = env;
  const dev = await env.person('devacct', 'Arham Dev');
  const tester = await env.person('tester', 'HR Testing');
  await ok('PATCH', `/api/users/${dev.id}`, { token: tokens.owner, body: { is_dev: true, tracks_time: false } });
  let list = await ok('GET', '/api/hr/people', { token: tokens.fatima });
  assert.equal(list.find((p) => p.id === dev.id).employed, false, 'an untracked developer account is not an employee');
  assert.equal(list.find((p) => p.id === dev.id).flags.no_pay, false, 'and needs no pay');
  assert.equal(list.find((p) => p.id === tester.id).employed, true, 'everyone else is, until HR says otherwise');
  await ok('PUT', `/api/hr/people/${tester.id}/record`, { token: tokens.fatima, body: { employed: false } });
  const pr = await ok('GET', '/api/payroll', { token: tokens.fatima });
  assert.ok(!pr.missing_pay.some((m) => m.id === dev.id || m.id === tester.id), 'payroll does not ask for their pay');
  const o = await ok('GET', '/api/hr/overview', { token: tokens.fatima });
  assert.ok(!o.items.some((i) => i.user_id === dev.id || i.user_id === tester.id), 'no HR reminders about them');
  // given pay by mistake, they are still left off the month
  await ok('PUT', `/api/hr/people/${tester.id}/pay`, { token: tokens.fatima, body: { base: 50000, currency: 'PKR', tax_mode: 'pk' } });
  const run = pr.runs[0];
  const d = await ok('POST', `/api/payroll/runs/${run.id}/refresh`, { token: tokens.fatima });
  assert.ok(!slipOf(d, tester.id), 'not on payroll');
  // moved back
  await ok('PUT', `/api/hr/people/${tester.id}/record`, { token: tokens.fatima, body: { employed: true } });
  list = await ok('GET', '/api/hr/people', { token: tokens.fatima });
  assert.equal(list.find((p) => p.id === tester.id).employed, true);
});

test('a month that has not begun cannot be started', async () => {
  const { api, tokens } = env;
  const r = await api('POST', '/api/payroll/runs', { token: tokens.fatima, body: { period: '2031-01' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /hasn’t started yet/);
});
