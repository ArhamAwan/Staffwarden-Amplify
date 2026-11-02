'use strict';
// Paying people one at a time, each on their own day between the 1st and the 10th, and removing a test month.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');

let env, sara, ali;
before(async () => {
  env = await makeEnv();
  sara = await env.person('sara', 'Sara Khan');
  ali = await env.person('ali', 'Ali Raza');
  for (const p of [sara, ali]) {
    await env.ok('PUT', `/api/hr/people/${p.id}/record`, { token: env.tokens.owner, body: { joined_on: '2025-01-01', iban: 'PK36MEZN0000001122334821', bank_name: 'Meezan Bank' } });
    await env.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: env.tokens.owner, body: { base: 100000, currency: 'PKR', tax_mode: 'none' } });
  }
});
after(() => env.close());

test('each person is marked paid on their own day; the month is paid once everyone is', async () => {
  const { ok, api, tokens } = env;
  const ov = await ok('GET', '/api/payroll', { token: tokens.owner });
  const period = ov.today.slice(0, 7);
  const r = await ok('POST', '/api/payroll/runs', { token: tokens.owner, body: { period } });
  const id = (r.run || r).id;
  await ok('POST', `/api/payroll/runs/${id}/submit`, { token: tokens.owner });
  let d = await ok('POST', `/api/payroll/runs/${id}/approve`, { token: tokens.owner });
  assert.equal(d.run.pay_by.slice(8), '10', 'paid by the 10th of the next month');
  const sSara = d.slips.find((s) => s.user_id === sara.id), sAli = d.slips.find((s) => s.user_id === ali.id);
  d = await ok('POST', `/api/payroll/slips/${sSara.id}/paid`, { token: tokens.owner, body: { on: ov.today, ref: 'TX1' } });
  assert.equal(d.run.status, 'approved', 'still waiting for Ali');
  assert.equal(d.run.paid_count, 1);
  assert.equal(d.slips.find((s) => s.user_id === sara.id).paid_on, ov.today);
  assert.equal((await api('POST', `/api/payroll/slips/${sSara.id}/paid`, { token: tokens.owner, body: {} })).status, 409, 'not twice');
  // undo, then pay again
  await ok('DELETE', `/api/payroll/slips/${sSara.id}/paid`, { token: tokens.owner });
  await ok('POST', `/api/payroll/slips/${sSara.id}/paid`, { token: tokens.owner, body: {} });
  d = await ok('POST', `/api/payroll/slips/${sAli.id}/paid`, { token: tokens.owner, body: {} });
  assert.equal(d.run.status, 'paid', 'everyone paid: the month is paid');
  const mine = await ok('GET', '/api/me/pay', { token: tokens.sara });
  assert.ok(mine.slips[0].paid_on, 'Sara sees the day she was paid');

  // a paid month is removed only by the owner (or a developer), with its name typed
  await ok('PATCH', `/api/users/${ali.id}`, { token: tokens.owner, body: { hr: true } });
  assert.equal((await api('DELETE', `/api/payroll/runs/${id}`, { token: tokens.ali })).status, 403, 'not HR');
  assert.equal((await api('DELETE', `/api/payroll/runs/${id}`, { token: tokens.owner })).status, 400, 'its name has to be typed');
  await ok('DELETE', `/api/payroll/runs/${id}?confirm=${encodeURIComponent(d.run.name)}`, { token: tokens.owner });
  assert.equal((await ok('GET', '/api/payroll', { token: tokens.owner })).runs.length, 0);
});
