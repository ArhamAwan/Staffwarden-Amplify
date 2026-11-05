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
