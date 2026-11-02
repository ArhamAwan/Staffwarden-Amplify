'use strict';
// Payroll runs: one per month. HR starts a month (draft), checks it and adds commission, bonuses and
// corrections, sends it for review, and the owner approves it (or HR, if the owner allows). Approving
// locks it and sends every payslip; marking it paid records the bank transfer. A mistake found later is
// fixed with a correction on the next month, so the record always shows what was paid.
const { need, str, optStr, int } = require('../lib/http');

module.exports = (ctx) => {
  const { db, cfg, route, emit, audit, isHR, needHR, nowIso, T, saveSetting } = ctx;
  const P = () => ctx.payroll;
  const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null : null);
  const runOf = (id) => { const r = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(Number(id)); need(r, 404, 'Payroll month not found'); return r; };
  const editable = (r) => need(r.status === 'draft' || r.status === 'review', 409, 'This month is approved. Fix mistakes with a correction on the next month.');
  const slipOut = (s, { full = true } = {}) => {
    const u = db.prepare('SELECT id, name, title, active FROM users WHERE id = ?').get(s.user_id) || {};
    const qs = db.prepare('SELECT * FROM pay_questions WHERE payslip_id = ? ORDER BY id').all(s.id).map((q) => ({ ...q, answered_by_name: nameOf(q.answered_by) }));
    return { id: s.id, run_id: s.run_id, user_id: s.user_id, name: u.name, title: u.title || null, currency: s.currency, gross: s.gross, deductions: s.deductions, tax: s.tax, net: s.net,
      lines: full ? JSON.parse(s.lines) : undefined, employer: JSON.parse(s.employer), facts: JSON.parse(s.facts), questions: qs, open_questions: qs.filter((q) => !q.answer).length, by_hand: !!s.by_hand };
  };
  const runOut = (r) => ({ ...r, name: P().periodName(r.period), created_by_name: nameOf(r.created_by), submitted_by_name: nameOf(r.submitted_by), approved_by_name: nameOf(r.approved_by), paid_by_name: nameOf(r.paid_by), pay_day: payDay(r.period) });
  const payDay = (period) => { const n = P().nextPeriod(period); const d = Math.min(Number(P().rules().pay_day) || 1, 28); return `${n}-${String(d).padStart(2, '0')}`; };
  const totals = (slips) => {
    const t = {};
    for (const s of slips) { const c = (t[s.currency] = t[s.currency] || { gross: 0, deductions: 0, tax: 0, net: 0, people: 0 }); c.gross += s.gross; c.deductions += s.deductions; c.tax += s.tax; c.net += s.net; c.people++; }
    return t;
  };

  // ---- months ----
  route('GET', '/api/payroll', ({ user }) => {
    needHR(user);
    const runs = db.prepare('SELECT * FROM pay_runs ORDER BY period DESC LIMIT 36').all().map((r) => {
      const slips = db.prepare('SELECT currency, gross, deductions, tax, net FROM payslips WHERE run_id = ?').all(r.id);
      return { ...runOut(r), totals: totals(slips), people: slips.length };
    });
    const missing = db.prepare("SELECT id, name FROM users WHERE active = 1 AND role != 'owner' AND COALESCE((SELECT employed FROM hr_records WHERE user_id = users.id), CASE WHEN users.is_dev = 1 AND users.tracks_time = 0 THEN 0 ELSE 1 END) = 1 AND id NOT IN (SELECT user_id FROM pay_setup) ORDER BY name").all();
    const withPay = db.prepare('SELECT COUNT(*) n FROM pay_setup p JOIN users u ON u.id = p.user_id WHERE u.active = 1').get().n;
    const noBank = db.prepare("SELECT u.id, u.name FROM users u JOIN pay_setup p ON p.user_id = u.id LEFT JOIN hr_records h ON h.user_id = u.id WHERE u.active = 1 AND (h.iban IS NULL OR h.iban = '') ORDER BY u.name").all();
    return { runs, missing_pay: missing, with_pay: withPay, no_bank: noBank, rules: P().rules(), can_approve: canApprove(user), today: ctx.calc.companyToday() };
  });
  const canApprove = (u) => u.role === 'owner' || (isHR(u) && !P().rules().owner_approves);

  route('POST', '/api/payroll/runs', ({ user, body }) => {
    needHR(user);
    const period = str(body.period, 'period', 7);
    need(/^\d{4}-(0[1-9]|1[0-2])$/.test(period), 400, 'period must look like 2026-10');
    need(!db.prepare('SELECT id FROM pay_runs WHERE period = ?').get(period), 409, `${P().periodName(period)} has already been started`);
    const open = db.prepare("SELECT period FROM pay_runs WHERE status IN ('draft','review')").get();
    need(!open, 409, `Finish ${open ? P().periodName(open.period) : ''} first`);
    const id = Number(db.prepare('INSERT INTO pay_runs (period, status, rules, created_by, created_at) VALUES (?,?,?,?,?)').run(period, 'draft', JSON.stringify(P().rules()), user.id, nowIso()).lastInsertRowid);
    P().compute(runOf(id));
    audit(user, 'payroll.started', null, period);
    emit('payroll');
    return runDetail(id, user);
  });

  function runDetail(id, user) {
    const r = runOf(id);
    const slips = db.prepare('SELECT * FROM payslips WHERE run_id = ? ORDER BY net DESC').all(r.id).map((s) => slipOut(s));
    const checks = [];
    const qn = slips.reduce((n, s) => n + s.open_questions, 0);
    if (qn) checks.push({ kind: 'question', text: `${qn === 1 ? '1 question' : qn + ' questions'} to answer`, people: slips.filter((s) => s.open_questions).map((s) => ({ id: s.id, name: s.name })), blocks: true });
    const noBank = slips.filter((s) => !s.facts.bank && !s.by_hand);
    if (noBank.length) checks.push({ kind: 'bank', text: `${noBank.map((s) => s.name).join(', ')} ${noBank.length === 1 ? 'has' : 'have'} no bank details`, people: noBank.map((s) => ({ id: s.id, name: s.name })) });
    const att = slips.filter((s) => s.lines.some((l) => l.kind === 'attendance' && l.counted && l.amount < 0));
    if (att.length) checks.push({ kind: 'attendance', text: `${att.length === 1 ? '1 person has' : att.length + ' people have'} attendance deductions`, people: att.map((s) => ({ id: s.id, name: s.name })) });
    const shown = slips.filter((s) => s.lines.some((l) => !l.counted));
    if (shown.length) checks.push({ kind: 'shown', text: `${shown.length === 1 ? '1 person has' : shown.length + ' people have'} lines to decide by hand`, people: shown.map((s) => ({ id: s.id, name: s.name })) });
    const missing = db.prepare("SELECT id, name FROM users WHERE active = 1 AND role != 'owner' AND COALESCE((SELECT employed FROM hr_records WHERE user_id = users.id), CASE WHEN users.is_dev = 1 AND users.tracks_time = 0 THEN 0 ELSE 1 END) = 1 AND id NOT IN (SELECT user_id FROM pay_setup) ORDER BY name").all();
    if (missing.length && !P().LOCKED(r.status)) checks.push({ kind: 'missing', text: `${missing.map((m) => m.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no pay set, so ${missing.length === 1 ? 'is' : 'are'} not on this month`, people: missing });
    const prev = db.prepare("SELECT * FROM pay_runs WHERE period < ? AND status IN ('approved','paid') ORDER BY period DESC LIMIT 1").get(r.period);
    return { run: runOut(r), slips, totals: totals(slips), checks, previous: prev ? { period: prev.period, name: P().periodName(prev.period), totals: totals(db.prepare('SELECT * FROM payslips WHERE run_id = ?').all(prev.id)) } : null, can_approve: canApprove(user), rules: JSON.parse(r.rules || '{}') };
  }
  route('GET', '/api/payroll/runs/:id', ({ user, params }) => { needHR(user); return runDetail(params.id, user); });

  route('POST', '/api/payroll/runs/:id/refresh', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id); editable(r);
    P().compute(r);
    emit('payroll');
    return runDetail(r.id, user);
  });
  route('DELETE', '/api/payroll/runs/:id', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id);
    need(r.status === 'draft', 409, 'Only a month still in draft can be removed');
    db.prepare('UPDATE expenses SET run_id = NULL WHERE run_id = ?').run(r.id);
    db.prepare('DELETE FROM pay_runs WHERE id = ?').run(r.id);
    audit(user, 'payroll.removed', null, r.period);
    emit('payroll');
    return { ok: true };
  });

  // ---- lines HR adds ----
  route('POST', '/api/payroll/runs/:id/items', ({ user, params, body }) => {
    needHR(user);
    const r = runOf(params.id); editable(r);
    const uid = Number(body.user_id);
    need(db.prepare('SELECT id FROM payslips WHERE run_id = ? AND user_id = ?').get(r.id, uid), 400, 'That person is not on this month');
    need(uid !== user.id || user.role === 'owner' || P().rules().hr_own_pay, 403, 'Your own pay is changed by the owner');
    const kind = String(body.kind || '');
    need(kind in P().ITEM_KINDS && kind !== 'expense', 400, 'kind must be commission, bonus, allowance, deduction or correction');
    const amount = int(body.amount, 'amount', -100000000, 100000000);
    need(amount !== 0, 400, 'Give an amount');
    need(kind === 'correction' || amount > 0, 400, 'Give the amount as a positive number');
    const label = optStr(body.label, 'label', 80) || { commission: 'Commission', bonus: 'Bonus', allowance: 'Allowance', deduction: 'Deduction', correction: 'Correction' }[kind];
    const reason = str(body.reason, 'reason', 300);
    const id = Number(db.prepare('INSERT INTO pay_items (run_id, user_id, kind, label, amount, reason, by_id, created_at) VALUES (?,?,?,?,?,?,?,?)').run(r.id, uid, kind, label, amount, reason, user.id, nowIso()).lastInsertRowid);
    P().compute(r);
    audit(user, 'payroll.item_added', uid, `${r.period}: ${label} ${amount} (${reason})`);
    emit('payroll', uid);
    return { id, slip: slipOut(db.prepare('SELECT * FROM payslips WHERE run_id = ? AND user_id = ?').get(r.id, uid)) };
  });
  route('DELETE', '/api/payroll/items/:id', ({ user, params }) => {
    needHR(user);
    const it = db.prepare('SELECT * FROM pay_items WHERE id = ?').get(Number(params.id));
    need(it, 404, 'Line not found');
    const r = runOf(it.run_id); editable(r);
    db.prepare('DELETE FROM pay_items WHERE id = ?').run(it.id);
    P().compute(r);
    audit(user, 'payroll.item_removed', it.user_id, `${r.period}: ${it.label} ${it.amount}`);
    emit('payroll', it.user_id);
    return { ok: true };
  });
  route('POST', '/api/payroll/slips/:id/by-hand', ({ user, params, body }) => {
    needHR(user);
    const s = db.prepare('SELECT * FROM payslips WHERE id = ?').get(Number(params.id)); need(s, 404, 'Payslip not found');
    editable(runOf(s.run_id));
    db.prepare('UPDATE payslips SET by_hand = ? WHERE id = ?').run(body.by_hand ? 1 : 0, s.id);
    emit('payroll');
    return { ok: true };
  });

  // ---- steps ----
  route('POST', '/api/payroll/runs/:id/submit', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id);
    need(r.status === 'draft', 409, 'Already sent');
    P().compute(r);
    db.prepare("UPDATE pay_runs SET status = 'review', submitted_by = ?, submitted_at = ? WHERE id = ?").run(user.id, nowIso(), r.id);
    audit(user, 'payroll.submitted', null, r.period);
    // people can see their payslip while it is in review, and ask about it before it is approved
    for (const s of db.prepare('SELECT user_id FROM payslips WHERE run_id = ?').all(r.id)) ctx.notify.notify(s.user_id, { kind: 'payslip', title: `Your ${P().periodName(r.period)} payslip is ready to check`, body: 'Every line says where it came from. Ask about anything before it is approved.', link: '#/pay', actor: user });
    const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' AND active = 1").all().map((o) => o.id);
    if (P().rules().owner_approves) ctx.notify.notify(owner, { kind: 'payroll_review', title: `${P().periodName(r.period)} payroll is ready for you to approve`, body: `Prepared by ${user.name}`, link: '#/payroll', actor: user });
    emit('payroll');
    return runDetail(r.id, user);
  });
  route('POST', '/api/payroll/runs/:id/approve', ({ user, params }) => {
    need(canApprove(user), 403, P().rules().owner_approves ? 'The owner approves payroll' : 'Only HR or the owner can approve payroll');
    const r = runOf(params.id);
    need(r.status === 'review' || r.status === 'draft', 409, 'This month is already approved');
    P().compute(r);
    const open = db.prepare('SELECT COUNT(*) n FROM pay_questions q JOIN payslips p ON p.id = q.payslip_id WHERE p.run_id = ? AND q.answer IS NULL').get(r.id).n;
    need(!open, 409, `Answer ${open === 1 ? 'the question' : `the ${open} questions`} about this month first`);
    db.prepare("UPDATE pay_runs SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(user.id, nowIso(), r.id);
    db.prepare("UPDATE expenses SET status = 'paid' WHERE run_id = ? AND status = 'approved'").run(r.id);
    for (const a of db.prepare("SELECT * FROM advances WHERE status = 'approved'").all()) {
      // fully paid back once the approved and paid months cover it
      let n = 0;
      for (const s of db.prepare("SELECT p.lines FROM payslips p JOIN pay_runs x ON x.id = p.run_id WHERE x.status IN ('approved','paid') AND p.user_id = ?").all(a.user_id)) for (const l of JSON.parse(s.lines)) if (l.key === `adv:${a.id}`) n += -l.amount;
      if (n >= a.amount) db.prepare("UPDATE advances SET status = 'repaid' WHERE id = ?").run(a.id);
    }
    audit(user, 'payroll.approved', null, r.period);
    for (const s of db.prepare('SELECT user_id, net, currency FROM payslips WHERE run_id = ?').all(r.id)) ctx.notify.notify(s.user_id, { kind: 'payslip', title: `Your ${P().periodName(r.period)} payslip`, body: `${P().fmtMoney(s.net, s.currency)}, paid on ${T.human(payDay(r.period))}`, link: '#/pay', actor: user });
    emit('payroll');
    return runDetail(r.id, user);
  });
  route('POST', '/api/payroll/runs/:id/paid', ({ user, params, body }) => {
    needHR(user);
    const r = runOf(params.id);
    need(r.status === 'approved', 409, r.status === 'paid' ? 'Already marked paid' : 'Approve it first');
    db.prepare("UPDATE pay_runs SET status = 'paid', paid_by = ?, paid_at = ?, paid_ref = ? WHERE id = ?").run(user.id, nowIso(), optStr(body.ref, 'ref', 120), r.id);
    audit(user, 'payroll.paid', null, `${r.period}${body.ref ? ' ref ' + body.ref : ''}`);
    emit('payroll');
    return runDetail(r.id, user);
  });
  route('POST', '/api/payroll/runs/:id/reopen', ({ user, params, body }) => {
    need(user.role === 'owner', 403, 'Only the owner can reopen an approved month');
    const r = runOf(params.id);
    need(r.status === 'approved', 409, r.status === 'paid' ? 'A paid month stays as it was. Use a correction on the next month.' : 'It is not approved');
    const reason = str(body.reason, 'reason', 300);
    db.prepare("UPDATE pay_runs SET status = 'review', approved_by = NULL, approved_at = NULL WHERE id = ?").run(r.id);
    db.prepare("UPDATE expenses SET status = 'approved' WHERE run_id = ? AND status = 'paid'").run(r.id);
    db.prepare("UPDATE advances SET status = 'approved' WHERE status = 'repaid'").run();
    audit(user, 'payroll.reopened', null, `${r.period}: ${reason}`);
    emit('payroll');
    return runDetail(r.id, user);
  });

  // ---- downloads ----
  const csv = (rows) => rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n') + '\r\n';
  route('GET', '/api/payroll/runs/:id/bank.csv', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id);
    need(P().LOCKED(r.status), 409, 'Approve the month first');
    const rows = [['Name', 'Account title', 'Bank', 'IBAN', 'Amount', 'Currency', 'Reference']];
    for (const s of db.prepare('SELECT p.*, u.name FROM payslips p JOIN users u ON u.id = p.user_id WHERE p.run_id = ? AND p.by_hand = 0 ORDER BY u.name').all(r.id)) {
      const h = P().recordOf(s.user_id);
      if (!h || !h.iban) continue;
      rows.push([s.name, h.account_title || s.name, h.bank_name || '', h.iban, s.net, s.currency, `Salary ${P().periodName(r.period)}`]);
    }
    audit(user, 'payroll.bank_sheet', null, r.period);
    return { raw: csv(rows), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="bank-sheet-${r.period}.csv"`, 'Cache-Control': 'no-store' } };
  });
  route('GET', '/api/payroll/runs/:id/register.csv', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id);
    const rows = [['Name', 'Currency', 'Line', 'Amount', 'Where it came from']];
    for (const s of db.prepare('SELECT p.*, u.name FROM payslips p JOIN users u ON u.id = p.user_id WHERE p.run_id = ? ORDER BY u.name').all(r.id)) {
      for (const l of JSON.parse(s.lines)) rows.push([s.name, s.currency, l.label + (l.counted ? '' : ' (shown only)'), l.counted ? l.amount : 0, l.source]);
      if (s.tax) rows.push([s.name, s.currency, 'Income tax', -s.tax, '']);
      for (const e of JSON.parse(s.employer)) rows.push([s.name, s.currency, `${e.label} (company pays)`, e.amount, e.source]);
      rows.push([s.name, s.currency, 'Net pay', s.net, '']);
    }
    audit(user, 'payroll.register', null, r.period);
    return { raw: csv(rows), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="payroll-${r.period}.csv"`, 'Cache-Control': 'no-store' } };
  });

  // ---- payslips and questions ----
  const loadSlip = (user, id) => {
    const s = db.prepare('SELECT * FROM payslips WHERE id = ?').get(Number(id));
    need(s, 404, 'Payslip not found');
    const r = runOf(s.run_id);
    need(isHR(user) || (s.user_id === user.id && r.status !== 'draft'), 404, 'Payslip not found');
    return { s, r };
  };
  route('GET', '/api/payroll/slips/:id', ({ user, params }) => {
    const { s, r } = loadSlip(user, params.id);
    if (isHR(user) && s.user_id !== user.id) audit(user, 'payroll.slip_viewed', s.user_id, r.period);
    const rec = P().recordOf(s.user_id);
    const setup = P().setupOf(s.user_id);
    return { ...slipOut(s), run: runOut(r), bank: rec && rec.iban ? { name: rec.bank_name, last4: String(rec.iban).replace(/\s/g, '').slice(-4) } : null, base: setup ? { amount: setup.base, currency: setup.currency, tax_mode: setup.tax_mode } : null,
      items: isHR(user) ? db.prepare('SELECT * FROM pay_items WHERE run_id = ? AND user_id = ? ORDER BY id').all(r.id, s.user_id).map((i) => ({ ...i, by_name: nameOf(i.by_id) })) : undefined };
  });
  route('POST', '/api/payroll/slips/:id/questions', ({ user, params, body }) => {
    const { s, r } = loadSlip(user, params.id);
    need(s.user_id === user.id, 403, 'Only the person can ask about their payslip');
    need(!P().LOCKED(r.status) || r.status === 'approved', 409, 'This month is paid. Ask HR directly.');
    const text = str(body.text, 'text', 600);
    const line = optStr(body.line, 'line', 80);
    const id = Number(db.prepare('INSERT INTO pay_questions (payslip_id, user_id, line, text, created_at) VALUES (?,?,?,?,?)').run(s.id, user.id, line, text, nowIso()).lastInsertRowid);
    const hr = db.prepare("SELECT id FROM users WHERE active = 1 AND (hr = 1 OR role = 'owner')").all().map((x) => x.id).filter((x) => x !== user.id);
    ctx.notify.notify(hr, { kind: 'pay_question', title: `${user.name} asked about ${line ? `“${line}”` : 'their payslip'}`, body: text.slice(0, 160), link: `#/payroll/slip?id=${s.id}`, actor: user });
    audit(user, 'payroll.question', user.id, `${r.period}: ${text.slice(0, 120)}`);
    emit('payroll', user.id);
    return { id };
  });
  route('POST', '/api/payroll/questions/:id/answer', ({ user, params, body }) => {
    needHR(user);
    const q = db.prepare('SELECT * FROM pay_questions WHERE id = ?').get(Number(params.id));
    need(q, 404, 'Question not found');
    const answer = str(body.answer, 'answer', 800);
    db.prepare('UPDATE pay_questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?').run(answer, user.id, nowIso(), q.id);
    ctx.notify.notify(q.user_id, { kind: 'pay_answer', title: `${user.name} answered your payslip question`, body: answer.slice(0, 160), link: '#/pay', actor: user });
    audit(user, 'payroll.answered', q.user_id, answer.slice(0, 120));
    emit('payroll', q.user_id);
    return { ok: true };
  });

  // ---- my pay ----
  const taxYearOf = (period) => { const [y, m] = period.split('-').map(Number); return m >= 7 ? y + 1 : y; };   // tax year 2027 = Jul 2026 to Jun 2027
  route('GET', '/api/me/pay', ({ user }) => {
    const slips = db.prepare("SELECT p.*, r.period, r.status FROM payslips p JOIN pay_runs r ON r.id = p.run_id WHERE p.user_id = ? AND r.status != 'draft' ORDER BY r.period DESC LIMIT 24").all(user.id)
      .map((s) => ({ ...slipOut(s, { full: false }), period: s.period, name: P().periodName(s.period), status: s.status, pay_day: payDay(s.period) }));
    const ty = slips.length ? taxYearOf(slips[0].period) : taxYearOf(ctx.calc.companyToday().slice(0, 7));
    const year = { tax_year: ty, from: `${ty - 1}-07`, to: `${ty}-06`, gross: 0, tax: 0, deductions: 0, net: 0, months: 0 };
    for (const s of slips) if (taxYearOf(s.period) === ty && (s.status === 'approved' || s.status === 'paid')) { year.gross += s.gross; year.tax += s.tax; year.deductions += s.deductions; year.net += s.net; year.months++; }
    const setup = P().setupOf(user.id), rec = P().recordOf(user.id);
    const advances = db.prepare('SELECT * FROM advances WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(user.id).map((a) => ({ ...a, installment: Math.ceil(a.amount / a.months), currency: setup ? setup.currency : 'PKR', decided_name: nameOf(a.decided_by) }));
    return { slips, year, base: setup ? { amount: setup.base, currency: setup.currency } : null, bank: rec && rec.iban ? { name: rec.bank_name, last4: String(rec.iban).replace(/\s/g, '').slice(-4) } : null, advances };
  });
  route('GET', '/api/me/certificate', ({ user, query }) => {
    const ty = Number(query.get('tax_year')) || taxYearOf(ctx.calc.companyToday().slice(0, 7)) - 1;
    const slips = db.prepare("SELECT p.*, r.period FROM payslips p JOIN pay_runs r ON r.id = p.run_id WHERE p.user_id = ? AND r.status IN ('approved','paid') AND r.period >= ? AND r.period <= ? ORDER BY r.period").all(user.id, `${ty - 1}-07`, `${ty}-06`);
    const out = { tax_year: ty, from: `${ty - 1}-07-01`, to: `${ty}-06-30`, salary: 0, allowances: 0, extra: 0, deductions: 0, tax: 0, eobi: 0, net: 0, months: slips.length, currency: slips[0] ? slips[0].currency : 'PKR' };
    for (const s of slips) {
      for (const l of JSON.parse(s.lines)) {
        if (!l.counted) continue;
        if (l.kind === 'base') out.salary += l.amount; else if (l.kind === 'allowance') out.allowances += l.amount;
        else if (['commission', 'bonus', 'correction', 'leaving'].includes(l.kind) || l.key === 'overtime') out.extra += l.amount;
        else if (l.key === 'eobi') out.eobi += -l.amount;
        else if (l.kind === 'attendance') out.salary += l.amount;
      }
      out.tax += s.tax; out.net += s.net;
    }
    const rec = P().recordOf(user.id);
    return { ...out, total: out.salary + out.allowances + out.extra, person: { name: user.name, title: user.title || null, joined: P().localJoin(user, rec) }, company: cfg.orgName, issued: ctx.calc.companyToday() };
  });

  // ---- rules ----
  route('GET', '/api/payroll/rules', ({ user }) => { needHR(user); return P().rules(); });
  route('PUT', '/api/payroll/rules', ({ user, body }) => {
    needHR(user);
    const cur = P().rules(), next = JSON.parse(JSON.stringify(cur));
    const one = (k, opts) => { if (k in body) { need(opts.includes(body[k]), 400, `${k} must be one of ${opts.join(', ')}`); next[k] = body[k]; } };
    one('day_basis', ['working', '30', 'calendar']); one('unpaid_leave', ['deduct', 'show']); one('absent', ['deduct', 'show', 'off']);
    if (body.late) { need(['off', 'show', 'deduct'].includes(body.late.mode), 400, 'late.mode must be off, show or deduct'); next.late = { mode: body.late.mode, every: int(body.late.every ?? cur.late.every, 'late.every', 1, 31), days: Number(body.late.days ?? cur.late.days) }; need([0.25, 0.5, 1].includes(next.late.days), 400, 'late.days must be 0.25, 0.5 or 1'); }
    if (body.overtime) { need(['off', 'show', 'deduct'].includes(body.overtime.mode), 400, 'overtime.mode must be off, show or deduct'); const rate = Number(body.overtime.rate ?? cur.overtime.rate); need(rate >= 1 && rate <= 3, 400, 'overtime.rate must be between 1 and 3'); next.overtime = { mode: body.overtime.mode, rate }; }
    if ('pay_day' in body) next.pay_day = int(body.pay_day, 'pay_day', 1, 28);
    if ('leave_payout' in body) next.leave_payout = !!body.leave_payout;
    if (body.tax) {
      const b = body.tax.brackets;
      need(Array.isArray(b) && b.length >= 1 && b.length <= 15, 400, 'tax.brackets must be a list');
      let last = -1;
      for (const [i, x] of b.entries()) {
        need(Array.isArray(x) && x.length === 3, 400, 'Each bracket is [up to, fixed, percent]');
        const [hi, fx, pct] = x;
        need((hi === null && i === b.length - 1) || (Number.isFinite(hi) && hi > last), 400, 'Brackets must go up, and only the last can be open-ended');
        need(Number.isFinite(fx) && fx >= 0 && Number.isFinite(pct) && pct >= 0 && pct <= 60, 400, 'Fixed tax and percent must be numbers');
        last = hi === null ? last : hi;
      }
      need(b[b.length - 1][0] === null, 400, 'The last bracket must have no upper limit');
      next.tax = { label: optStr(body.tax.label, 'tax.label', 160) || cur.tax.label, brackets: b };
    }
    if (body.eobi) next.eobi = { on: !!body.eobi.on, min_wage: int(body.eobi.min_wage ?? cur.eobi.min_wage, 'eobi.min_wage', 0, 10000000), er: Number(body.eobi.er ?? cur.eobi.er), ee: Number(body.eobi.ee ?? cur.eobi.ee) };
    if (body.expense_limits) next.expense_limits = Object.fromEntries(Object.entries(body.expense_limits).filter(([k]) => /^[a-z]{2,20}$/.test(k)).map(([k, v]) => [k, int(v, 'limit', 0, 10000000)]));
    // these decide who controls HR, so only the owner changes them
    for (const k of ['owner_approves', 'hr_own_pay', 'managers_first']) if (k in body) { need(user.role === 'owner', 403, 'Only the owner can change who approves'); next[k] = !!body[k]; }
    saveSetting('payroll', next);
    audit(user, 'payroll.rules', null, Object.keys(body).join(', '));
    emit('payroll');
    return P().rules();
  });
};
