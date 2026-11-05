'use strict';
// Someone who joins mid-month: with the rule set to "next", their first part month is not paid on its own,
// it is added to their first full month, and taxed as its own month.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

let env, sara, zara;
before(async () => {
  env = await makeEnv();
  sara = await env.person('sara', 'Sara Khan');
  zara = await env.person('zara', 'Zara Malik');
  const { ok, tokens } = env;
  for (const [p, joined] of [[sara, '2025-03-03'], [zara, '2026-10-19']]) {
    await ok('PUT', `/api/hr/people/${p.id}/record`, { token: tokens.owner, body: { contract: 'full_time', joined_on: joined, iban: 'PK36MEZN0000001122334821' } });
    await ok('PUT', `/api/hr/people/${p.id}/pay`, { token: tokens.owner, body: { base: 110000, currency: 'PKR', tax_mode: 'pk' } });
  }
  await ok('PUT', '/api/payroll/rules', { token: tokens.owner, body: { absent: 'off', late: { mode: 'off', every: 3, days: 0.5 }, unpaid_leave: 'show' } });
});
after(() => env.close());

test('paid that month (the default): a part October slip', async () => {
  const { ok, tokens } = env;
  env.set(Date.UTC(2026, 10, 2, 5));
  const oct = await ok('POST', '/api/payroll/runs', { token: tokens.owner, body: { period: '2026-10' } });
  const z = oct.slips.find((s) => s.user_id === zara.id);
  assert.ok(z, 'Zara is on October');
  assert.ok(z.lines.find((l) => l.key === 'base').amount < 110000);
  await ok('DELETE', `/api/payroll/runs/${oct.run.id}`, { token: tokens.owner });
});

test('paid with their next month: off October, and November carries her October days', async () => {
  const { ok, api, tokens } = env;
  assert.equal((await api('PUT', '/api/payroll/rules', { token: tokens.owner, body: { first_month: 'sometimes' } })).status, 400);
  await ok('PUT', '/api/payroll/rules', { token: tokens.owner, body: { first_month: 'next' } });
  const oct = await ok('POST', '/api/payroll/runs', { token: tokens.owner, body: { period: '2026-10' } });
  assert.ok(!oct.slips.some((s) => s.user_id === zara.id), 'Zara is not on October');
  assert.ok(oct.slips.some((s) => s.user_id === sara.id), 'Sara still is');
  await ok('POST', `/api/payroll/runs/${oct.run.id}/submit`, { token: tokens.owner });
  await ok('POST', `/api/payroll/runs/${oct.run.id}/approve`, { token: tokens.owner });
  env.set(Date.UTC(2026, 11, 2, 5));
  const nov = await ok('POST', '/api/payroll/runs', { token: tokens.owner, body: { period: '2026-11' } });
  const z = nov.slips.find((s) => s.user_id === zara.id), s = nov.slips.find((x) => x.user_id === sara.id);
  const first = z.lines.find((l) => l.key === 'prev:base');
  assert.ok(first, 'her October days are on November');
  assert.equal(first.label, 'October: first days');
  assert.ok(first.amount > 0 && first.amount < 110000);
  assert.equal(z.lines.find((l) => l.key === 'base').amount, 110000);
  // taxed as two months, not as one bigger salary: never more than twice a full month's tax
  assert.ok(z.tax <= s.tax * 2 && z.tax >= s.tax, `tax ${z.tax} vs full month ${s.tax}`);
  assert.match(z.facts.tax_note, /each on the brackets/);
  assert.ok(!s.lines.some((l) => /^prev:/.test(l.key)), 'only for someone who joined in October');
});

test('the carried first days can be removed like any other line', async () => {
  const { ok, tokens } = env;
  const nov = (await ok('GET', '/api/payroll', { token: tokens.owner })).runs.find((r) => r.period === '2026-11');
  const d = await ok('GET', `/api/payroll/runs/${nov.id}`, { token: tokens.owner });
  const z = d.slips.find((s) => s.user_id === zara.id);
  const r = await ok('POST', `/api/payroll/slips/${z.id}/remove-line`, { token: tokens.owner, body: { key: 'prev:base', reason: 'Paid in cash in October' } });
  assert.equal(r.slip.lines.find((l) => l.key === 'prev:base').counted, false);
  await ok('POST', `/api/payroll/slips/${z.id}/remove-line`, { token: tokens.owner, body: { key: 'prev:base', undo: true } });
});

test('someone can be left off a month from its list, and put back', async () => {
  const { ok, api, tokens } = env;
  const nov = (await ok('GET', '/api/payroll', { token: tokens.owner })).runs.find((r) => r.period === '2026-11');
  assert.equal((await api('POST', `/api/payroll/runs/${nov.id}/leave-off`, { token: tokens.sara, body: { user_id: zara.id, reason: 'x' } })).status, 403);
  assert.equal((await api('POST', `/api/payroll/runs/${nov.id}/leave-off`, { token: tokens.owner, body: { user_id: zara.id } })).status, 400, 'a reason is needed');
  let d = await ok('POST', `/api/payroll/runs/${nov.id}/leave-off`, { token: tokens.owner, body: { user_id: zara.id, reason: 'Paid by the client directly' } });
  assert.ok(!d.slips.some((s) => s.user_id === zara.id));
  assert.equal(d.left_off[0].name, 'Zara Malik');
  // still off after working it out again; her HR record is untouched
  d = await ok('POST', `/api/payroll/runs/${nov.id}/refresh`, { token: tokens.owner });
  assert.ok(!d.slips.some((s) => s.user_id === zara.id));
  d = await ok('POST', `/api/payroll/runs/${nov.id}/leave-off`, { token: tokens.owner, body: { user_id: zara.id, undo: true } });
  assert.ok(d.slips.some((s) => s.user_id === zara.id));
  assert.equal(d.left_off.length, 0);
});

test('first days already paid in their own month are not carried again', async () => {
  const { ok, tokens } = env;
  // the rule was "paid that month" when October ran with Zara on it, then switched
  const zed = await env.person('zed', 'Zed Khan');
  await ok('PUT', `/api/hr/people/${zed.id}/record`, { token: tokens.owner, body: { contract: 'full_time', joined_on: '2026-12-14', iban: 'PK36MEZN0000001122334821' } });
  await ok('PUT', `/api/hr/people/${zed.id}/pay`, { token: tokens.owner, body: { base: 90000, currency: 'PKR', tax_mode: 'pk' } });
  await ok('PUT', '/api/payroll/rules', { token: tokens.owner, body: { first_month: 'same' } });
  const nov = (await ok('GET', '/api/payroll', { token: tokens.owner })).runs.find((r) => r.period === '2026-11');
  await ok('POST', `/api/payroll/runs/${nov.id}/submit`, { token: tokens.owner });
  await ok('POST', `/api/payroll/runs/${nov.id}/approve`, { token: tokens.owner });
  env.set(Date.UTC(2027, 0, 2, 5));
  const dec = await ok('POST', '/api/payroll/runs', { token: tokens.owner, body: { period: '2026-12' } });
  assert.ok(dec.slips.some((s) => s.user_id === zed.id), 'paid December on its own');
  await ok('POST', `/api/payroll/runs/${dec.run.id}/submit`, { token: tokens.owner });
  await ok('POST', `/api/payroll/runs/${dec.run.id}/approve`, { token: tokens.owner });
  await ok('PUT', '/api/payroll/rules', { token: tokens.owner, body: { first_month: 'next' } });
  env.set(Date.UTC(2027, 1, 2, 5));
  const jan = await ok('POST', '/api/payroll/runs', { token: tokens.owner, body: { period: '2027-01' } });
  assert.ok(!jan.slips.find((s) => s.user_id === zed.id).lines.some((l) => /^prev:/.test(l.key)), 'December is not paid twice');
});
