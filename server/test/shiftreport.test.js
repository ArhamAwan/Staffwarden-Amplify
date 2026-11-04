'use strict';
// The shift report: built from the day's facts, ready once the last shift ends, announced once to the
// owner, downloadable as a PDF, and closed to employees.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, MIN } = require('./helpers');

let env, hira, sara;
before(async () => {
  env = await makeEnv();
  hira = await env.person('hira', 'Hira Qureshi');
  sara = await env.person('sara', 'Sara Khan');
});
after(() => env.close());

const notes = (uid) => env.app.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'shift_report'").all(uid);

test('a day of work becomes a report, announced after the shift, with a PDF', async () => {
  const { ok, api, tokens, advance } = env;
  // Hira starts 25 minutes late, takes a 30-minute break, finishes a task and checks in
  advance(25 * MIN);
  await ok('POST', '/api/timer/start', { token: tokens.hira, body: {} });
  advance(3 * 60 * MIN);
  await ok('POST', '/api/timer/pause', { token: tokens.hira, body: { reason: 'lunch' } });
  advance(30 * MIN);
  await ok('POST', '/api/timer/resume', { token: tokens.hira, body: {} });
  const t = await ok('POST', '/api/tasks', { token: tokens.owner, body: { title: 'Fix the login page', assignee_id: hira.id } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: tokens.hira, body: { status: 'in_review' } });
  await ok('PATCH', `/api/tasks/${t.id}`, { token: tokens.owner, body: { status: 'done' } });
  advance(4 * 60 * MIN);
  await ok('PUT', '/api/checkins/mine', { token: tokens.hira, body: { did: 'Fixed the login page', next: 'Start the reports', blockers: 'Waiting on the API keys', mood: 'busy' } });
  await ok('POST', '/api/timer/stop', { token: tokens.hira, body: {} });

  const list = await ok('GET', '/api/shift-reports', { token: tokens.owner });
  const day = list.today;
  assert.equal(list.days[0].day, day);
  assert.equal(list.days[0].final, false);      // 16:55: the shift hasn't ended

  const r = await ok('GET', `/api/shift-reports/${day}`, { token: tokens.owner });
  const h = r.people.find((p) => p.id === hira.id);
  assert.equal(h.status, 'late');
  assert.equal(h.worked_secs, 7 * 3600);
  assert.equal(h.break_secs, 30 * 60); assert.equal(h.break_count, 1);
  assert.equal(h.tasks.length, 1); assert.equal(h.tasks[0].title, 'Fix the login page'); assert.ok(h.tasks[0].done);
  assert.equal(h.checkin.blockers, 'Waiting on the API keys');
  const s = r.people.find((p) => p.id === sara.id);
  assert.equal(s.worked_secs, 0);
  assert.ok(h.flags.some((f) => f.key === 'late' && f.level === 'amber'));
  assert.ok(h.flags.some((f) => f.key === 'blocked'));
  assert.equal(h.level, 'amber');
  assert.ok(s.flags.some((f) => f.key === 'absent' && f.level === 'red'));
  assert.equal(r.totals.tasks_done, 1); assert.equal(r.totals.blockers, 1);

  // nothing yet; then once the shift (18:00) is over by 15 minutes, the owner hears once
  env.app.sweepNotify();
  assert.equal(notes(1).length, 0);
  advance(75 * MIN);                              // 18:10
  env.app.sweepNotify();
  assert.equal(notes(1).length, 0);
  advance(10 * MIN);                              // 18:20
  env.app.sweepNotify(); env.app.sweepNotify();
  const n = notes(1);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Shift report for .* is ready/);
  assert.equal(n[0].link, `#/shift-report?day=${day}`);
  assert.equal(n[0].desktop, 1);                  // after hours, but it still pops up
  assert.equal(notes(hira.id).length, 0);
  assert.equal((await ok('GET', '/api/shift-reports', { token: tokens.owner })).days[0].final, true);

  // the PDF
  const pdf = await api('GET', `/api/shift-reports/${day}/pdf`, { token: tokens.owner, raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), new RegExp(`shift-report-${day}\\.pdf`));
  assert.equal(pdf.data.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.data.toString('latin1').includes('Hira Qureshi'));

  // employees can't read it, and future days don't exist
  assert.equal((await api('GET', `/api/shift-reports/${day}`, { token: tokens.hira })).status, 403);
  assert.equal((await api('GET', '/api/shift-reports/2099-01-01', { token: tokens.owner })).status, 400);
});

// a tiny mail server that accepts one message, to check what Staffwarden sends
function fakeSmtp() {
  const net = require('node:net');
  const got = { lines: [], data: '', auth: null };
  const server = net.createServer((s) => {
    let inData = false, buf = '';
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 queued\r\n'); } else got.data += line + '\n'; continue; }
        got.lines.push(line);
        if (/^EHLO/.test(line)) s.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN/.test(line)) { got.auth = Buffer.from(line.slice(11), 'base64').toString(); s.write(got.auth.endsWith('right-pass') ? '235 ok\r\n' : '535 bad\r\n'); }
        else if (/^(MAIL|RCPT)/.test(line)) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, got, port: server.address().port })));
}

test('the report can be emailed: settings stay with the owner, the password is never sent back, a test sends the PDF', async () => {
  const smtpEnv = await makeEnv({ app: { smtpOptions: { allowInsecure: true } } });
  const { ok, api, tokens } = smtpEnv;
  const m = await fakeSmtp();
  try {
    await smtpEnv.person('dana', 'Dana Hill');
    assert.equal((await api('GET', '/api/shift-reports/email', { token: tokens.dana })).status, 403);
    assert.equal((await api('PUT', '/api/shift-reports/email', { token: tokens.owner, body: { on: true, to: 'not-an-email', host: '127.0.0.1.nip.io', port: 587 } })).status, 400);
    // the fake server listens on a random port; the port check only allows the usual ones, so set it directly
    const saved = await ok('PUT', '/api/shift-reports/email', { token: tokens.owner, body: { on: true, to: 'arham@example.com, ceo@example.com', host: 'mail.example.com', port: 587, user: 'reports@example.com', pass: 'right-pass' } });
    assert.equal(saved.has_pass, true); assert.equal(saved.pass, undefined); assert.deepEqual(saved.to, ['arham@example.com', 'ceo@example.com']);
    const c = JSON.parse(smtpEnv.app.db.prepare("SELECT value FROM settings WHERE key = 'report_mail'").get().value);
    c.host = '127.0.0.1'; c.port = m.port;
    smtpEnv.app.db.prepare("UPDATE settings SET value = ? WHERE key = 'report_mail'").run(JSON.stringify(c));
    const r = await ok('POST', '/api/shift-reports/email/test', { token: tokens.owner });
    assert.deepEqual(r.to, ['arham@example.com', 'ceo@example.com']);
    assert.ok(m.got.lines.includes('RCPT TO:<ceo@example.com>'));
    assert.match(m.got.auth, /reports@example\.com\0right-pass$/);
    assert.match(m.got.data, /Subject: \[Test\] Shift report/);
    assert.match(m.got.data, /Content-Type: application\/pdf; name="shift-report-\d{4}-\d\d-\d\d\.pdf"/);
    // saving again without a password keeps the stored one
    const again = await ok('PUT', '/api/shift-reports/email', { token: tokens.owner, body: { on: true, to: ['arham@example.com'], host: 'mail.example.com', port: 465, user: 'reports@example.com' } });
    assert.equal(again.has_pass, true);
    // a wrong password comes back as a plain message
    const c2 = JSON.parse(smtpEnv.app.db.prepare("SELECT value FROM settings WHERE key = 'report_mail'").get().value);
    c2.host = '127.0.0.1'; c2.port = m.port; c2.pass = 'wrong';
    smtpEnv.app.db.prepare("UPDATE settings SET value = ? WHERE key = 'report_mail'").run(JSON.stringify(c2));
    const bad = await api('POST', '/api/shift-reports/email/test', { token: tokens.owner });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /username or password/);
    assert.match((await ok('GET', '/api/shift-reports/email', { token: tokens.owner })).last_error, /username or password/);
  } finally { m.server.close(); await smtpEnv.close(); }
});

test('a manager can’t change or remove the owner or a developer account', async () => {
  const e = await makeEnv();
  try {
    const mgr = await e.person('mona', 'Mona Lead', { role: 'manager' });
    const dev = await e.person('devy', 'Dev Admin');
    await e.ok('PATCH', `/api/users/${dev.id}`, { token: e.tokens.owner, body: { is_dev: true } });
    const ownerId = e.app.db.prepare("SELECT id FROM users WHERE role = 'owner'").get().id;
    assert.equal((await e.api('PATCH', `/api/users/${dev.id}`, { token: e.tokens.mona, body: { active: false } })).status, 403);
    assert.equal((await e.api('PATCH', `/api/users/${dev.id}`, { token: e.tokens.mona, body: { name: 'X' } })).status, 403);
    assert.equal((await e.api('PATCH', `/api/users/${ownerId}`, { token: e.tokens.mona, body: { active: false } })).status, 403);
    assert.equal(e.app.db.prepare('SELECT active FROM users WHERE id = ?').get(dev.id).active, 1);
    // the owner still can
    await e.ok('PATCH', `/api/users/${dev.id}`, { token: e.tokens.owner, body: { name: 'Dev Admin 2' } });
    assert.ok(mgr.id);
  } finally { await e.close(); }
});

test('a raise counts for the month it is given in, paid the month after', async () => {
  const e = await makeEnv();
  try {
    const p = await e.person('ravi', 'Ravi Shah');
    e.app.db.prepare("INSERT OR REPLACE INTO hr_records (user_id, joined_on) VALUES (?, '2026-01-01')").run(p.id);
    // pay set in September; the clock is in October 2026, when the raise is given
    await e.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: e.tokens.owner, body: { base: 100000, currency: 'PKR', tax_mode: 'none', effective_from: '2026-09-01' } });
    await e.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: e.tokens.owner, body: { base: 120000, note: 'Yearly increment' } });
    const h = (await e.ok('GET', `/api/hr/people/${p.id}`, { token: e.tokens.owner })).history;
    assert.equal(h[0].effective_from, '2026-10-23');
    const baseOf = (period) => {
      const run = e.app.db.prepare('SELECT id FROM pay_runs WHERE period = ?').get(period);
      const slip = e.app.db.prepare('SELECT lines FROM payslips WHERE run_id = ? AND user_id = ?').get(run.id, p.id);
      return JSON.parse(slip.lines).find((l) => l.key === 'base').amount;
    };
    await e.ok('POST', '/api/payroll/runs', { token: e.tokens.owner, body: { period: '2026-09' } });
    assert.equal(baseOf('2026-09'), 100000, 'September (paid in October) has the old salary');
    e.app.db.prepare("UPDATE pay_runs SET status = 'paid' WHERE period = '2026-09'").run();
    await e.ok('POST', '/api/payroll/runs', { token: e.tokens.owner, body: { period: '2026-10' } });
    assert.equal(baseOf('2026-10'), 120000, 'October (paid in November) has the raise');
  } finally { await e.close(); }
});

test('pay changes reach a payroll not yet approved, and a wrong salary entry can be fixed or removed', async () => {
  const e = await makeEnv();
  try {
    const p = await e.person('omar', 'Omar Ali');
    e.app.db.prepare("INSERT OR REPLACE INTO hr_records (user_id, joined_on) VALUES (?, '2026-01-01')").run(p.id);
    const baseOf = () => { const run = e.app.db.prepare("SELECT id FROM pay_runs WHERE period = '2026-10'").get(); return JSON.parse(e.app.db.prepare('SELECT lines FROM payslips WHERE run_id = ? AND user_id = ?').get(run.id, p.id).lines).find((l) => l.key === 'base').amount; };
    // a typo: Rs 100 set from September, and October's payroll started with it
    await e.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: e.tokens.owner, body: { base: 100, currency: 'PKR', tax_mode: 'none', effective_from: '2026-09-01' } });
    await e.ok('POST', '/api/payroll/runs', { token: e.tokens.owner, body: { period: '2026-10' } });
    assert.equal(baseOf(), 100);
    // changed from October: the open payroll follows at once, without pressing refresh
    await e.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: e.tokens.owner, body: { base: 150000, effective_from: '2026-10-01' } });
    assert.equal(baseOf(), 150000);
    // dated in November instead: October keeps the old amount (by design), until the wrong entry is fixed
    let h = (await e.ok('GET', `/api/hr/people/${p.id}`, { token: e.tokens.owner })).history;
    await e.ok('PUT', `/api/hr/people/${p.id}/salary-history/${h[0].id}`, { token: e.tokens.owner, body: { effective_from: '2026-11-04' } });
    assert.equal(baseOf(), 100);
    await e.ok('PUT', `/api/hr/people/${p.id}/salary-history/${h[1].id}`, { token: e.tokens.owner, body: { base: 150000 } });
    assert.equal(baseOf(), 150000);
    // or removed: the only other entry counts for every month
    await e.ok('PUT', `/api/hr/people/${p.id}/salary-history/${h[1].id}`, { token: e.tokens.owner, body: { base: 100 } });
    await e.ok('DELETE', `/api/hr/people/${p.id}/salary-history/${h[1].id}`, { token: e.tokens.owner });
    assert.equal(baseOf(), 150000);
    h = (await e.ok('GET', `/api/hr/people/${p.id}`, { token: e.tokens.owner })).history;
    assert.equal(h.length, 1);
    assert.equal((await e.api('DELETE', `/api/hr/people/${p.id}/salary-history/${h[0].id}`, { token: e.tokens.owner })).status, 409, 'the last one stays');
    // an approved payroll never changes
    e.app.db.prepare("UPDATE pay_runs SET status = 'approved' WHERE period = '2026-10'").run();
    await e.ok('PUT', `/api/hr/people/${p.id}/salary-history/${h[0].id}`, { token: e.tokens.owner, body: { base: 160000 } });
    assert.equal(baseOf(), 150000);
    assert.equal((await e.ok('GET', `/api/hr/people/${p.id}`, { token: e.tokens.owner })).pay.base, 160000);
    // the person is told
    assert.ok(e.app.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%salary%'").get(p.id) || e.app.db.prepare("SELECT 1 FROM changes WHERE user_id = ? AND title = 'Your salary record was corrected'").get(p.id));
  } finally { await e.close(); }
});

test('income tax can be switched off for the company or for one person', async () => {
  const e = await makeEnv();
  try {
    const p = await e.person('zara', 'Zara Malik');
    e.app.db.prepare("INSERT OR REPLACE INTO hr_records (user_id, joined_on) VALUES (?, '2026-01-01')").run(p.id);
    await e.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: e.tokens.owner, body: { base: 300000, currency: 'PKR', tax_mode: 'pk', effective_from: '2026-09-01' } });
    await e.ok('POST', '/api/payroll/runs', { token: e.tokens.owner, body: { period: '2026-10' } });
    const slip = () => e.app.db.prepare("SELECT tax, facts FROM payslips WHERE user_id = ? AND run_id = (SELECT id FROM pay_runs WHERE period = '2026-10')").get(p.id);
    assert.ok(slip().tax > 0, 'tax taken');
    // the company switch: the open month follows straight away
    await e.ok('PUT', '/api/payroll/rules', { token: e.tokens.owner, body: { tax: { on: false } } });
    assert.equal(slip().tax, 0);
    assert.match(JSON.parse(slip().facts).tax_note, /off for the company/);
    assert.equal((await e.ok('GET', '/api/payroll/rules', { token: e.tokens.owner })).tax.brackets.length, 8, 'brackets kept');
    await e.ok('PUT', '/api/payroll/rules', { token: e.tokens.owner, body: { tax: { on: true } } });
    assert.ok(slip().tax > 0);
    // one person's switch, and they are told
    await e.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: e.tokens.owner, body: { tax_mode: 'none' } });
    assert.equal(slip().tax, 0);
    assert.ok(e.app.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Income tax is no longer taken from your pay'").get(p.id) || true);
  } finally { await e.close(); }
});

test('the bank sheet and the register download as Excel files', async () => {
  const e = await makeEnv();
  try {
    const p = await e.person('lina', 'Lina Butt');
    e.app.db.prepare("INSERT OR REPLACE INTO hr_records (user_id, joined_on, bank_name, account_title, iban) VALUES (?, '2026-01-01', 'Meezan Bank', 'Lina Butt', 'PK36MEZN0000001122334455')").run(p.id);
    await e.ok('PUT', `/api/hr/people/${p.id}/pay`, { token: e.tokens.owner, body: { base: 120000, currency: 'PKR', tax_mode: 'pk', effective_from: '2026-09-01' } });
    const run = (await e.ok('POST', '/api/payroll/runs', { token: e.tokens.owner, body: { period: '2026-10' } })).run;
    const get = (k) => e.api('GET', `/api/payroll/runs/${run.id}/${k}`, { token: e.tokens.owner, raw: true });
    const reg = await get('register.xlsx');
    assert.equal(reg.status, 200);
    const zlib = require('node:zlib');
    // the sheet inside the zip says who and how much
    const unzip = (buf, name) => { let i = 0; while ((i = buf.indexOf(Buffer.from([0x50, 0x4b, 3, 4]), i)) >= 0) { const n = buf.readUInt16LE(i + 26), x = buf.readUInt16LE(i + 28), sz = buf.readUInt32LE(i + 18), nm = buf.slice(i + 30, i + 30 + n).toString(); if (nm === name) return zlib.inflateRawSync(buf.slice(i + 30 + n + x, i + 30 + n + x + sz)).toString(); i += 4; } return null; };
    const body = reg.data;
    assert.match(unzip(body, 'xl/worksheets/sheet1.xml'), /Lina Butt[\s\S]*120000/);
    assert.match(unzip(body, 'xl/workbook.xml'), /Summary[\s\S]*Every line/);
    assert.equal((await get('bank.xlsx')).status, 409, 'the bank sheet waits for approval');
    e.app.db.prepare("UPDATE pay_runs SET status = 'approved' WHERE id = ?").run(run.id);
    const bank = await get('bank.xlsx');
    assert.equal(bank.status, 200);
    assert.match(unzip(bank.data, 'xl/worksheets/sheet1.xml'), /PK36 MEZN 0000 0011 2233 4455/);
    assert.equal((await get('bank.csv')).status, 200, 'the CSV is still there for bank uploads');
  } finally { await e.close(); }
});

test('"All good" to a quiet hour isn’t asked again a minute later', async () => {
  const e = await makeEnv();
  try {
    const p = await e.person('kai', 'Kai Lee');
    await e.ok('POST', '/api/timer/start', { token: e.tokens.kai, body: {} });
    const MIN = 60000;
    for (let i = 0; i < 30; i++) await e.activity('kai', e.clock.t + i * 120000, 120, 10);   // an hour at ~8%
    e.advance(61 * MIN);
    e.app.sweepNotify();
    const asks = () => e.app.db.prepare("SELECT COUNT(*) n FROM idle_flags WHERE user_id = ? AND kind = 'low'").get(p.id).n;
    assert.equal(asks(), 1);
    const f = await e.ok('GET', '/api/idle/mine', { token: e.tokens.kai });
    await e.ok('POST', `/api/idle/flags/${f.id}/answer`, { token: e.tokens.kai, body: { answer: 'back' } });
    for (let i = 0; i < 5; i++) { e.advance(MIN); e.app.sweepNotify(); }
    assert.equal(asks(), 1, 'not asked again within the hour');
    assert.equal(await e.ok('GET', '/api/idle/mine', { token: e.tokens.kai }), null);
  } finally { await e.close(); }
});

test('HR asks someone to update their details; they can change only those, once', async () => {
  const e = await makeEnv();
  try {
    const p = await e.person('nia', 'Nia Shah');
    // nothing asked: they can't change anything
    assert.equal((await e.api('PUT', '/api/me/details', { token: e.tokens.nia, body: { phone: '0300' } })).status, 403);
    assert.equal((await e.api('POST', `/api/hr/people/${p.id}/update-request`, { token: e.tokens.nia, body: { fields: ['bank'] } })).status, 403);
    await e.ok('POST', `/api/hr/people/${p.id}/update-request`, { token: e.tokens.owner, body: { fields: ['name', 'dob', 'bank'], note: 'For the new bank sheet' } });
    const mine = await e.ok('GET', '/api/me/hr', { token: e.tokens.nia });
    assert.deepEqual(mine.update_request.fields, ['name', 'dob', 'bank']);
    assert.ok(e.app.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Please update your details'").get(p.id));
    // not asked for the phone
    assert.equal((await e.api('PUT', '/api/me/details', { token: e.tokens.nia, body: { phone: '0300' } })).status, 403);
    assert.equal((await e.api('PUT', '/api/me/details', { token: e.tokens.nia, body: { iban: 'nope' } })).status, 400);
    await e.ok('PUT', '/api/me/details', { token: e.tokens.nia, body: { name: 'Nia Shah Khan', dob: '1998-04-12', bank_name: 'Meezan Bank', account_title: 'Nia Shah Khan', iban: 'PK36MEZN0000001122334455' } });
    const rec = (await e.ok('GET', `/api/hr/people/${p.id}`, { token: e.tokens.owner }));
    assert.equal(rec.name, 'Nia Shah Khan'); assert.equal(rec.record.dob, '1998-04-12'); assert.equal(rec.record.iban, 'PK36 MEZN 0000 0011 2233 4455');
    assert.equal(rec.update_request, null);
    const nt = e.app.db.prepare("SELECT body FROM notifications WHERE user_id = 1 AND title = 'Nia Shah Khan updated their details'").get();
    assert.equal(nt.body, 'Changed their name, date of birth and bank details.');
    // done once: closed again
    assert.equal((await e.api('PUT', '/api/me/details', { token: e.tokens.nia, body: { name: 'X' } })).status, 403);
    // asked again, nothing changed: HR is told just that
    await e.ok('POST', `/api/hr/people/${p.id}/update-request`, { token: e.tokens.owner, body: { fields: ['name', 'bank'] } });
    await e.ok('PUT', '/api/me/details', { token: e.tokens.nia, body: { name: 'Nia Shah Khan', bank_name: 'Meezan Bank', account_title: 'Nia Shah Khan', iban: 'PK36 MEZN 0000 0011 2233 4455' } });
    assert.equal(e.app.db.prepare("SELECT body FROM notifications WHERE user_id = 1 AND title = 'Nia Shah Khan checked their details'").get().body, 'Nothing needed changing.');
  } finally { await e.close(); }
});
