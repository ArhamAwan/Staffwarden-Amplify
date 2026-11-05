'use strict';
// Company branding: details and pictures set by the owner or HR, the logo open to anyone, the signature
// only to them, and payslips, certificates and statements made with them; an approved month keeps its copy.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { makeEnv } = require('./helpers');
const PNG = require('../lib/png');

// a small RGBA PNG, as a browser's canvas would make it
function png(w, h, [r, g, b, a]) {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of buf) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = []; for (let y = 0; y < h; y++) { rows.push(Buffer.from([y % 2 ? 2 : 0])); const row = Buffer.alloc(w * 4); for (let x = 0; x < w; x++) row.set(y % 2 ? [0, 0, 0, 0] : [r, g, b, x % 3 ? a : 0], x * 4); rows.push(row); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
async function upload(env, token, slot, buf) {
  const r = await fetch(`${env.base}/api/company/images/${slot}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: buf });
  return { status: r.status, data: await r.json() };
}

let env, sara;
before(async () => { env = await makeEnv(); sara = await env.person('sara', 'Sara Khan'); });
after(() => env.close());

test('the PNG reader undoes row filters and keeps transparency', () => {
  const d = PNG.decode(png(5, 4, [10, 20, 30, 255]));
  assert.equal(d.w, 5); assert.equal(d.h, 4);
  assert.deepEqual([...d.rgb.subarray(3, 6)], [10, 20, 30]);
  assert.ok(d.alpha, 'has transparency');
  assert.equal(d.alpha[0], 0); assert.equal(d.alpha[1], 255);
  assert.throws(() => PNG.decode(Buffer.from('not a png')));
});

test('the owner sets the details; people can read them but not change them', async () => {
  const { ok, api, tokens } = env;
  const r = await ok('PUT', '/api/company', { token: tokens.owner, body: { name: 'Amplify Media Technologies', legal_name: 'Amplify Media Technologies (Private) Limited', address: 'Office 4, Blue Area\nIslamabad', ntn: '1234567-8', email: 'hr@amplify.test', brand: '#0E6E78', signer_name: 'Basit Gillani', signer_title: 'Chief Executive Officer' } });
  assert.equal(r.legal_name, 'Amplify Media Technologies (Private) Limited');
  assert.equal(r.can_edit, true);
  assert.equal((await ok('GET', '/api/settings', { token: tokens.owner })).org_name, 'Amplify Media Technologies');
  assert.equal((await api('PUT', '/api/company', { token: tokens.sara, body: { ntn: 'x' } })).status, 403);
  assert.equal((await api('PUT', '/api/company', { token: tokens.owner, body: { brand: 'teal' } })).status, 400);
  assert.equal((await api('PUT', '/api/company', { token: tokens.owner, body: { email: 'nope' } })).status, 400);
  assert.equal((await ok('GET', '/api/company', { token: tokens.sara })).can_edit, false);
});

test('pictures: PNG only; the logo opens signed out, the signature only for the owner and HR', async () => {
  const { tokens, api } = env;
  assert.equal((await upload(env, tokens.owner, 'logo', Buffer.from('<svg/>'))).status, 400);
  assert.equal((await upload(env, tokens.sara, 'logo', png(40, 12, [14, 110, 120, 255]))).status, 403);
  const up = await upload(env, tokens.owner, 'logo', png(40, 12, [14, 110, 120, 255]));
  assert.equal(up.status, 200);
  assert.match(up.data.images.logo.url, /^\/api\/company\/images\/logo\?v=/);
  await upload(env, tokens.owner, 'signature', png(30, 10, [20, 20, 40, 255]));
  const open = await fetch(`${env.base}/api/company/images/logo`);
  assert.equal(open.status, 200); assert.equal(open.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${env.base}/api/company/images/signature`)).status, 404, 'not signed out');
  assert.equal((await api('GET', '/api/company/images/signature', { token: tokens.sara, raw: true })).status, 404, 'not for everyone');
  assert.equal((await api('GET', '/api/company/images/signature', { token: tokens.owner, raw: true })).status, 200);
  assert.deepEqual((await env.ok('GET', '/api/company', { token: tokens.sara })).images.signature, { set: true });
  assert.equal((await env.ok('GET', '/api/settings', { token: tokens.sara })).company.logo.w, 40);
});

test('documents carry the logo and details; an approved month keeps the ones it was approved with', async () => {
  const { ok, api, tokens } = env;
  await ok('PUT', `/api/hr/people/${sara.id}/record`, { token: tokens.owner, body: { contract: 'full_time', joined_on: '2025-03-03', iban: 'PK36MEZN0000001122334821' } });
  await ok('PUT', `/api/hr/people/${sara.id}/pay`, { token: tokens.owner, body: { base: 120000, currency: 'PKR', tax_mode: 'pk' } });
  env.set(Date.UTC(2026, 10, 2, 5));
  const oct = await ok('POST', '/api/payroll/runs', { token: tokens.owner, body: { period: '2026-10' } });
  assert.equal(oct.run.company, undefined, 'the copy is never sent to the page');
  await ok('POST', `/api/payroll/runs/${oct.run.id}/submit`, { token: tokens.owner });
  await ok('POST', `/api/payroll/runs/${oct.run.id}/approve`, { token: tokens.owner });
  const slip = oct.slips.find((s) => s.user_id === sara.id);
  const pdf = async () => (await api('GET', `/api/payroll/slips/${slip.id}/pdf`, { token: tokens.sara, raw: true })).data.toString('latin1');
  let t = await pdf();
  assert.match(t, /\/Subtype \/Image/, 'the logo is in it');
  assert.match(t, /\/SMask/, 'with its transparency');
  assert.match(t, /Office 4, Blue Area/);
  assert.match(t, /NTN 1234567-8/);
  // the address changes after approval: October's payslip still shows the old one
  await ok('PUT', '/api/company', { token: tokens.owner, body: { address: 'Floor 9, New Tower\nIslamabad' } });
  t = await pdf();
  assert.match(t, /Office 4, Blue Area/);
  assert.doesNotMatch(t, /New Tower/);
  // the certificate uses today's details, with the signature
  const cert = (await api('GET', '/api/me/certificate.pdf?tax_year=2027', { token: tokens.sara, raw: true })).data.toString('latin1');
  assert.match(cert, /New Tower/);
  assert.match(cert, /Basit Gillani/);
  assert.equal((cert.match(/\/Subtype \/Image/g) || []).length >= 2, true, 'logo and signature');
  // a sample to check the look, for the owner and HR only
  assert.equal((await api('GET', '/api/company/sample.pdf', { token: tokens.owner, raw: true })).status, 200);
  assert.equal((await api('GET', '/api/company/sample.pdf', { token: tokens.sara, raw: true })).status, 403);
  // removing the logo takes it off new documents, never the stored file
  const rm = await ok('DELETE', '/api/company/images/logo', { token: tokens.owner });
  assert.equal(rm.images.logo, null);
  assert.match(await pdf(), /\/Subtype \/Image/, 'October kept its logo');
});

test('the paper comes out of a photographed signature, even grey paper in uneven light', () => {
  const w = 120, h = 60, rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = y * w + x, p = Math.round(205 - 50 * (x / w) - 35 * (y / h)); rgb.set([p, p - 4, p - 12], k * 3); }
  for (let x = 10; x < 110; x++) for (let y = 28; y < 33; y++) rgb.set([35, 38, 70], (y * w + x) * 3);   // a stroke of ink
  const out = PNG.removePaper({ w, h, rgb, alpha: null });
  assert.equal(out.alpha[5 * w + 5], 0, 'light paper');
  assert.equal(out.alpha[55 * w + 115], 0, 'paper in shadow');
  assert.equal(out.alpha[30 * w + 60], 255, 'the ink');
});

test('a small, faint signature is enlarged with smooth edges and full-strength ink', () => {
  const w = 40, h = 20, rgb = Buffer.alloc(w * h * 3, 0), alpha = Buffer.alloc(w * h, 0);
  for (let x = 5; x < 35; x++) { const k = 10 * w + x; rgb.set([90, 180, 220], k * 3); alpha[k] = 90; }
  const out = PNG.cleanInk({ w, h, rgb, alpha });
  assert.equal(out.w, w * 8, 'enlarged (up to 8 times)');
  const k = 83 * out.w + Math.floor(out.w / 2);
  assert.equal(out.alpha[k], 255, 'the faint stroke is solid');
  assert.equal(out.alpha[20 * out.w + Math.floor(out.w / 2)], 0, 'nothing around it');
  assert.ok(0.299 * out.rgb[k * 3] + 0.587 * out.rgb[k * 3 + 1] + 0.114 * out.rgb[k * 3 + 2] <= 86, 'the ink is deep enough to read');
});
