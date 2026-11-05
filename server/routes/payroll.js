'use strict';
// Payroll runs: one per month. HR starts a month (draft), checks it and adds commission, bonuses and
// corrections, sends it for review, and the owner approves it (or HR, if the owner allows). Approving
// locks it and sends every payslip; marking it paid records the bank transfer. A mistake found later is
// fixed with a correction on the next month, so the record always shows what was paid.
const { need, str, optStr, int, isoDate } = require('../lib/http');
const X = require('../lib/xlsx');
const { Pdf } = require('../lib/pdf');

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
      lines: full ? JSON.parse(s.lines) : undefined, employer: JSON.parse(s.employer), facts: JSON.parse(s.facts), questions: qs, open_questions: qs.filter((q) => !q.answer).length, by_hand: !!s.by_hand,
      paid_on: s.paid_on || null, paid_ref: full ? s.paid_ref || null : undefined, paid_by_name: full && s.paid_by ? nameOf(s.paid_by) : undefined };
  };
  const runOut = (r) => ({ ...r, company: undefined, name: P().periodName(r.period), created_by_name: nameOf(r.created_by), submitted_by_name: nameOf(r.submitted_by), approved_by_name: nameOf(r.approved_by), paid_by_name: nameOf(r.paid_by), pay_day: payDay(r.period), pay_by: payBy(r.period),
    paid_count: db.prepare('SELECT COUNT(*) n FROM payslips WHERE run_id = ? AND paid_on IS NOT NULL').get(r.id).n });
  // people are paid on their own day in a window after the month: from pay_day to pay_by of the next month
  const dayOf = (period, d) => `${P().nextPeriod(period)}-${String(Math.min(Math.max(Number(d) || 1, 1), 28)).padStart(2, '0')}`;
  const payDay = (period) => dayOf(period, P().rules().pay_day || 1);
  const payBy = (period) => { const R = P().rules(); return dayOf(period, Math.max(Number(R.pay_by) || 10, Number(R.pay_day) || 1)); };
  ctx.payWindow = (period) => ({ from: payDay(period), by: payBy(period) });
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
    // a month is paid for the work in it, so a month that hasn't begun can't be started
    need(period <= ctx.calc.companyToday().slice(0, 7), 400, `${P().periodName(period)} hasn’t started yet. Pick the month people worked.`);
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
    const leftOff = db.prepare("SELECT w.user_id, w.reason, w.created_at, u.name, u.title, b.name by_name FROM pay_waivers w JOIN users u ON u.id = w.user_id LEFT JOIN users b ON b.id = w.by_id WHERE w.run_id = ? AND w.line_key = '*' ORDER BY u.name").all(r.id);
    return { run: runOut(r), slips, totals: totals(slips), checks, left_off: leftOff, previous: prev ? { period: prev.period, name: P().periodName(prev.period), totals: totals(db.prepare('SELECT * FROM payslips WHERE run_id = ?').all(prev.id)) } : null, can_approve: canApprove(user), rules: JSON.parse(r.rules || '{}') };
  }
  route('GET', '/api/payroll/runs/:id', ({ user, params }) => { needHR(user); return runDetail(params.id, user); });

  route('POST', '/api/payroll/runs/:id/refresh', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id); editable(r);
    P().compute(r);
    emit('payroll');
    return runDetail(r.id, user);
  });
  route('DELETE', '/api/payroll/runs/:id', ({ user, params, query }) => {
    needHR(user);
    const r = runOf(params.id);
    // a month in draft goes freely; one already sent, approved or paid only by the owner or a developer,
    // who types its name (a test month, or one started by mistake). Its payslips go with it, everyone is told.
    if (r.status !== 'draft') {
      need(user.role === 'owner' || !!user.is_dev, 403, 'Only the owner can remove a month that was sent for review, approved or paid');
      need(String((query && query.get('confirm')) || '').trim().toLowerCase() === P().periodName(r.period).toLowerCase(), 400, `Type ${P().periodName(r.period)} to remove it`);
    }
    const people = db.prepare('SELECT user_id FROM payslips WHERE run_id = ?').all(r.id).map((x) => x.user_id);
    db.prepare("UPDATE expenses SET status = 'approved' WHERE run_id = ? AND status = 'paid'").run(r.id);
    db.prepare('UPDATE expenses SET run_id = NULL WHERE run_id = ?').run(r.id);
    // advances this month counted towards are owed again
    const advIds = new Set();
    for (const s of db.prepare('SELECT lines FROM payslips WHERE run_id = ?').all(r.id)) for (const l of JSON.parse(s.lines)) if (/^adv:\d+$/.test(l.key)) advIds.add(Number(l.key.slice(4)));
    for (const id of advIds) db.prepare("UPDATE advances SET status = 'approved' WHERE id = ? AND status = 'repaid'").run(id);
    db.prepare('DELETE FROM pay_runs WHERE id = ?').run(r.id);
    audit(user, 'payroll.removed', null, `${r.period} (was ${r.status})`);
    if (r.status !== 'draft' && people.length) ctx.notify.notify(people, { kind: 'changed', title: `${P().periodName(r.period)} payroll was removed`, body: `Your ${P().periodName(r.period)} payslip was removed by ${user.name}. It is worked out again when the month is started again.`, link: '#/pay', actor: user });
    emit('payroll');
    return { ok: true };
  });

  // ---- lines HR adds ----
  route('POST', '/api/payroll/runs/:id/items', ({ user, params, body }) => {
    needHR(user);
    const r = runOf(params.id); editable(r);
    const uid = Number(body.user_id);
    need(db.prepare('SELECT id FROM payslips WHERE run_id = ? AND user_id = ?').get(r.id, uid), 400, 'That person is not on this month');
    need(uid !== user.id || (user.role === 'owner' && !user.dev_owner) || P().rules().hr_own_pay, 403, 'Your own pay is changed by the owner');
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
  // take a worked-out line (absent, late, unpaid leave, a fixed deduction...) off one person's month, or put it back
  const WAIVABLE = (l) => !l.item && !l.expense && (l.kind !== 'base' || /^prev:/.test(l.key)) && !/^adv:/.test(l.key);
  route('POST', '/api/payroll/slips/:id/remove-line', ({ user, params, body }) => {
    needHR(user);
    const s = db.prepare('SELECT * FROM payslips WHERE id = ?').get(Number(params.id));
    need(s, 404, 'Payslip not found');
    const r = runOf(s.run_id); editable(r);
    need(s.user_id !== user.id || (user.role === 'owner' && !user.dev_owner) || P().rules().hr_own_pay, 403, 'Your own pay is changed by the owner');
    const key = str(body.key, 'key', 80);
    const l = JSON.parse(s.lines).find((x) => x.key === key);
    need(l, 404, 'That line is not on this payslip');
    need(WAIVABLE(l), 400, l.item ? 'Delete a line you added instead' : l.expense ? 'Expenses are changed from Expenses' : 'This line can’t be removed');
    const undo = body.undo === true;
    if (undo) db.prepare('DELETE FROM pay_waivers WHERE run_id = ? AND user_id = ? AND line_key = ?').run(r.id, s.user_id, key);
    else db.prepare('INSERT OR REPLACE INTO pay_waivers (run_id, user_id, line_key, reason, by_id, created_at) VALUES (?,?,?,?,?,?)').run(r.id, s.user_id, key, str(body.reason, 'reason', 300), user.id, nowIso());
    P().compute(r);
    audit(user, undo ? 'payroll.line_restored' : 'payroll.line_removed', s.user_id, `${r.period}: ${l.label}${undo ? '' : ` (${body.reason})`}`);
    emit('payroll', s.user_id);
    return { slip: slipOut(db.prepare('SELECT * FROM payslips WHERE id = ?').get(s.id)) };
  });
  // leave one person off this month (paid another way, joined late, a test account...), or put them back
  route('POST', '/api/payroll/runs/:id/leave-off', ({ user, params, body }) => {
    needHR(user);
    const r = runOf(params.id); editable(r);
    const uid = Number(body.user_id);
    need(db.prepare('SELECT id FROM users WHERE id = ?').get(uid), 404, 'Person not found');
    const undo = body.undo === true;
    if (undo) db.prepare("DELETE FROM pay_waivers WHERE run_id = ? AND user_id = ? AND line_key = '*'").run(r.id, uid);
    else db.prepare("INSERT OR REPLACE INTO pay_waivers (run_id, user_id, line_key, reason, by_id, created_at) VALUES (?,?,'*',?,?,?)").run(r.id, uid, str(body.reason, 'reason', 300), user.id, nowIso());
    P().compute(r);
    audit(user, undo ? 'payroll.person_back' : 'payroll.person_left_off', uid, `${r.period}${undo ? '' : `: ${body.reason}`}`);
    emit('payroll', uid);
    return runDetail(r.id, user);
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
    // the company details at this moment go with the month: its payslips keep this logo and address
    db.prepare("UPDATE pay_runs SET status = 'approved', approved_by = ?, approved_at = ?, company = ? WHERE id = ?").run(user.id, nowIso(), JSON.stringify(ctx.companySnapshot()), r.id);
    db.prepare("UPDATE expenses SET status = 'paid' WHERE run_id = ? AND status = 'approved'").run(r.id);
    for (const a of db.prepare("SELECT * FROM advances WHERE status = 'approved'").all()) {
      // fully paid back once the approved and paid months cover it
      let n = 0;
      for (const s of db.prepare("SELECT p.lines FROM payslips p JOIN pay_runs x ON x.id = p.run_id WHERE x.status IN ('approved','paid') AND p.user_id = ?").all(a.user_id)) for (const l of JSON.parse(s.lines)) if (l.key === `adv:${a.id}`) n += -l.amount;
      if (n >= a.amount) db.prepare("UPDATE advances SET status = 'repaid' WHERE id = ?").run(a.id);
    }
    audit(user, 'payroll.approved', null, r.period);
    for (const s of db.prepare('SELECT user_id, net, currency FROM payslips WHERE run_id = ?').all(r.id)) ctx.notify.notify(s.user_id, { kind: 'payslip', title: `Your ${P().periodName(r.period)} payslip`, body: `${P().fmtMoney(s.net, s.currency)}, paid between ${T.human(payDay(r.period))} and ${T.human(payBy(r.period))}`, link: '#/pay', actor: user });
    emit('payroll');
    return runDetail(r.id, user);
  });
  // paid one person at a time, each on their own day; the month is paid once everyone is
  function markPaid(user, r, slips, on, ref) {
    const day = on ? isoDate(on, 'on').slice(0, 10) : ctx.calc.companyToday();
    need(day >= `${r.period}-01`, 400, 'They cannot be paid before the month starts');
    need(day <= ctx.calc.companyToday(), 400, 'That day has not come yet');
    for (const s of slips) {
      db.prepare('UPDATE payslips SET paid_on = ?, paid_ref = ?, paid_by = ? WHERE id = ?').run(day, ref || null, user.id, s.id);
      ctx.notify.notify(s.user_id, { kind: 'payslip', title: `Your ${P().periodName(r.period)} pay was sent`, body: `${P().fmtMoney(s.net, s.currency)}, paid on ${T.human(day)}${ref ? `, reference ${ref}` : ''}`, link: '#/pay', actor: user });
    }
    const left = db.prepare('SELECT COUNT(*) n FROM payslips WHERE run_id = ? AND paid_on IS NULL').get(r.id).n;
    if (!left) db.prepare("UPDATE pay_runs SET status = 'paid', paid_by = ?, paid_at = ?, paid_ref = ? WHERE id = ?").run(user.id, nowIso(), ref || null, r.id);
    audit(user, 'payroll.paid', slips.length === 1 ? slips[0].user_id : null, `${r.period}: ${slips.length === 1 ? 'one person' : plural(slips.length, 'person', 'people')} on ${day}${ref ? ' ref ' + ref : ''}`);
    emit('payroll');
  }
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
  route('POST', '/api/payroll/slips/:id/paid', ({ user, params, body }) => {
    needHR(user);
    const s = db.prepare('SELECT * FROM payslips WHERE id = ?').get(Number(params.id)); need(s, 404, 'Payslip not found');
    const r = runOf(s.run_id);
    need(r.status === 'approved', 409, r.status === 'paid' ? 'This month is already paid' : 'Approve the month first');
    need(!s.paid_on, 409, 'Already marked paid');
    markPaid(user, r, [s], body.on, optStr(body.ref, 'ref', 120));
    return runDetail(r.id, user);
  });
  route('DELETE', '/api/payroll/slips/:id/paid', ({ user, params }) => {
    needHR(user);
    const s = db.prepare('SELECT * FROM payslips WHERE id = ?').get(Number(params.id)); need(s, 404, 'Payslip not found');
    const r = runOf(s.run_id);
    need(r.status === 'approved', 409, 'Once everyone is paid the month is locked');
    db.prepare('UPDATE payslips SET paid_on = NULL, paid_ref = NULL, paid_by = NULL WHERE id = ?').run(s.id);
    audit(user, 'payroll.unpaid', s.user_id, `${r.period}: marked not paid`);
    emit('payroll');
    return runDetail(r.id, user);
  });
  // everyone not yet marked, on one day (one bank batch)
  route('POST', '/api/payroll/runs/:id/paid', ({ user, params, body }) => {
    needHR(user);
    const r = runOf(params.id);
    need(r.status === 'approved', 409, r.status === 'paid' ? 'Already marked paid' : 'Approve it first');
    const slips = db.prepare('SELECT * FROM payslips WHERE run_id = ? AND paid_on IS NULL').all(r.id);
    if (slips.length) markPaid(user, r, slips, body.on, optStr(body.ref, 'ref', 120));
    else db.prepare("UPDATE pay_runs SET status = 'paid', paid_by = ?, paid_at = ? WHERE id = ?").run(user.id, nowIso(), r.id);
    return runDetail(r.id, user);
  });
  route('POST', '/api/payroll/runs/:id/reopen', ({ user, params, body }) => {
    need(user.role === 'owner', 403, 'Only the owner can reopen an approved month');
    const r = runOf(params.id);
    need(r.status === 'approved', 409, r.status === 'paid' ? 'A paid month stays as it was. Use a correction on the next month.' : 'It is not approved');
    const reason = str(body.reason, 'reason', 300);
    // anyone already marked paid is unmarked: their payslip can change, and is marked again once it is approved
    const wasPaid = db.prepare('SELECT COUNT(*) n FROM payslips WHERE run_id = ? AND paid_on IS NOT NULL').get(r.id).n;
    db.prepare('UPDATE payslips SET paid_on = NULL, paid_ref = NULL, paid_by = NULL WHERE run_id = ?').run(r.id);
    db.prepare("UPDATE pay_runs SET status = 'review', approved_by = NULL, approved_at = NULL, company = NULL WHERE id = ?").run(r.id);
    P().compute(r);
    void wasPaid;
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

  // ---- the same two, as Excel files laid out for people to read (the CSV stays for bank uploads) ----
  const human = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  const curSign = (c) => (c === 'USD' ? '$' : 'Rs');
  const xlsxOut = (buf, name) => ({ raw: buf, type: X.XLSX_TYPE, headers: { 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
  const approvedBy = (r) => `Approved by ${nameOf(r.approved_by) || 'the owner'}${r.approved_at ? ` on ${human(r.approved_at)}` : ''}`;
  const statusLine = (r) => (r.status === 'paid' ? `Paid. ${approvedBy(r)}` : P().LOCKED(r.status) ? approvedBy(r) : 'Draft, not approved yet. Numbers can still change');
  // an IBAN in groups of four, the way banks print it
  const ibanText = (v) => String(v || '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
  const slipsOf = (r) => db.prepare('SELECT p.*, u.name, u.title FROM payslips p JOIN users u ON u.id = p.user_id WHERE p.run_id = ? ORDER BY u.name').all(r.id);

  route('GET', '/api/payroll/runs/:id/bank.xlsx', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id);
    need(P().LOCKED(r.status), 409, 'Approve the month first');
    const name = P().periodName(r.period), win = ctx.payWindow(r.period);
    const on = [], off = [];
    for (const s of slipsOf(r)) {
      const h = P().recordOf(s.user_id);
      if (s.by_hand) off.push([s, 'Paid by hand']);
      else if (!h || !h.iban) off.push([s, 'No bank details']);
      else on.push([s, h]);
    }
    const rows = [
      [{ v: `Salary transfers, ${name}`, s: 'title' }],
      [{ v: `${ctx.companyFor(r.company).legal || 'Staffwarden'} · to be paid ${human(win.from)} to ${human(win.by)}`, s: 'sub' }],
      [{ v: statusLine(r), s: 'sub' }],
      [],
    ];
    const head = rows.length;
    rows.push([{ v: '#', s: 'headC' }, { v: 'Name', s: 'head' }, { v: 'Account title', s: 'head' }, { v: 'Bank', s: 'head' }, { v: 'IBAN', s: 'head' }, { v: 'Amount', s: 'headR' }, { v: 'Currency', s: 'headC' }, { v: 'Reference', s: 'head' }, { v: 'Paid on', s: 'head' }]);
    on.forEach(([s, h], i) => rows.push([{ v: i + 1, s: 'center' }, s.name, h.account_title || s.name, h.bank_name || '', { v: ibanText(h.iban), s: 'mono' }, { v: s.net, s: 'money' }, { v: s.currency, s: 'center' }, `Salary ${name}`, s.paid_on ? human(s.paid_on) : '']));
    const last = rows.length - 1;
    // a total for each currency
    const curs = [...new Set(on.map(([s]) => s.currency))];
    for (const c of curs.length ? curs : ['PKR']) {
      const list = on.filter(([s]) => s.currency === c);
      rows.push([{ v: '', s: 'total' }, { v: `Total, ${list.length} ${list.length === 1 ? 'transfer' : 'transfers'}`, s: 'total' }, { v: '', s: 'total' }, { v: '', s: 'total' }, { v: '', s: 'total' }, { v: list.reduce((n, [s]) => n + s.net, 0), s: 'totalMoney' }, { v: c, s: 'totalC' }, { v: '', s: 'total' }, { v: '', s: 'total' }]);
    }
    if (off.length) {
      rows.push([], [{ v: 'Not on this sheet', s: 'bold' }]);
      for (const [s, why] of off) rows.push(['', s.name, { v: why, s: 'muted' }, '', '', { v: s.net, s: 'mutedMoney' }, { v: s.currency, s: 'mutedC' }]);
    }
    rows.push([], [{ v: `Downloaded from Staffwarden by ${user.name} on ${human(ctx.calc.companyToday())}. Check each IBAN against the bank before sending.`, s: 'sub' }]);
    audit(user, 'payroll.bank_sheet', null, `${r.period} (Excel)`);
    return xlsxOut(X.workbook([{ name: `Bank sheet ${r.period}`, cols: [6, 26, 26, 18, 34, 15, 11, 24, 13], rows, freeze: head + 1, filter: { row: head, last, from: 0, to: 8 }, heights: { 0: 26, [head]: 24 }, landscape: true }], { title: `Salary transfers, ${name}` }), `bank-sheet-${r.period}.xlsx`);
  });

  route('GET', '/api/payroll/runs/:id/register.xlsx', ({ user, params }) => {
    needHR(user);
    const r = runOf(params.id);
    const name = P().periodName(r.period), win = ctx.payWindow(r.period);
    const slips = slipsOf(r);
    const intro = (title) => [[{ v: title, s: 'title' }], [{ v: `${ctx.companyFor(r.company).legal || 'Staffwarden'}${ctx.companyFor(r.company).ntn ? ` (NTN ${ctx.companyFor(r.company).ntn})` : ''} · ${name}, paid ${human(win.from)} to ${human(win.by)}`, s: 'sub' }], [{ v: statusLine(r), s: 'sub' }], []];

    // 1. one row a person
    const H = ['Name', 'Role', 'Days worked', 'Base salary', 'Additions', 'Expenses repaid', 'Gross pay', 'Deductions', 'Income tax', 'Net pay', 'Company contributions', 'Currency', 'Bank', 'Paid on'];
    const MONEY = new Set([3, 4, 5, 6, 7, 8, 9, 10]);
    const sum = [];
    for (const s of slips) {
      const lines = JSON.parse(s.lines).filter((l) => l.counted), f = JSON.parse(s.facts || '{}'), h = P().recordOf(s.user_id);
      const base = lines.filter((l) => l.key === 'base').reduce((n, l) => n + l.amount, 0);
      const exp = lines.filter((l) => String(l.key).startsWith('exp:')).reduce((n, l) => n + l.amount, 0);
      const add = lines.filter((l) => l.amount > 0 && l.key !== 'base' && !String(l.key).startsWith('exp:')).reduce((n, l) => n + l.amount, 0);
      const ded = -lines.filter((l) => l.amount < 0).reduce((n, l) => n + l.amount, 0);
      const er = JSON.parse(s.employer || '[]').reduce((n, e) => n + e.amount, 0);
      const bank = s.by_hand ? 'Paid by hand' : h && h.iban ? `${h.bank_name || 'Bank'} ···${String(h.iban).replace(/\s/g, '').slice(-4)}` : 'No bank details';
      sum.push({ cur: s.currency, row: [s.name, s.title || '', f.workdays ? `${f.present ?? f.employed_days} of ${f.workdays}` : '', base, add, exp, s.gross, ded, s.tax, s.net, er, s.currency, bank, s.paid_on ? human(s.paid_on) : ''] });
    }
    const rows1 = intro(`Payroll register, ${name}`);
    const head1 = rows1.length;
    rows1.push(H.map((v, i) => ({ v, s: MONEY.has(i) ? 'headR' : i === 11 || i === 2 ? 'headC' : 'head' })));
    for (const x of sum) rows1.push(x.row.map((v, i) => (MONEY.has(i) ? { v, s: 'money' } : i === 11 || i === 2 ? { v, s: 'center' } : v)));
    const last1 = rows1.length - 1;
    for (const c of [...new Set(sum.map((x) => x.cur))]) {
      const list = sum.filter((x) => x.cur === c);
      rows1.push(H.map((_, i) => (i === 0 ? { v: `Total (${curSign(c)}), ${list.length} ${list.length === 1 ? 'person' : 'people'}`, s: 'total' } : MONEY.has(i) ? { v: list.reduce((n, x) => n + x.row[i], 0), s: 'totalMoney' } : i === 11 ? { v: c, s: 'totalC' } : { v: '', s: 'total' })));
    }
    rows1.push([], [{ v: 'Gross pay = base + additions + expenses. Net pay = gross − deductions − income tax. Company contributions (like EOBI) are paid by the company on top and are not in net pay.', s: 'sub' }]);
    rows1.push([{ v: `Downloaded from Staffwarden by ${user.name} on ${human(ctx.calc.companyToday())}.`, s: 'sub' }]);

    // 2. every line, as it appears on the payslips
    const rows2 = intro(`Payroll lines, ${name}`);
    const head2 = rows2.length;
    rows2.push([{ v: 'Name', s: 'head' }, { v: 'Line', s: 'head' }, { v: 'Type', s: 'head' }, { v: 'Amount', s: 'headR' }, { v: 'Currency', s: 'headC' }, { v: 'Where it came from', s: 'head' }]);
    const TYPE = { base: 'Salary', allowance: 'Allowance', overtime: 'Overtime', bonus: 'Bonus', commission: 'Commission', correction: 'Correction', deduction: 'Deduction', advance: 'Advance repayment', expense: 'Expense', leaving: 'Leaving', attendance: 'Attendance', contribution: 'Contribution', item: 'Payroll line' };
    for (const s of slips) {
      for (const l of JSON.parse(s.lines)) rows2.push([s.name, l.label + (l.counted ? '' : ' (shown only, not counted)'), TYPE[l.kind] || (l.amount < 0 ? 'Deduction' : 'Addition'), { v: l.counted ? l.amount : 0, s: l.counted ? 'money' : 'mutedMoney' }, { v: s.currency, s: 'center' }, { v: l.source || '', s: 'muted' }]);
      if (s.tax) rows2.push([s.name, 'Income tax', 'Tax', { v: -s.tax, s: 'money' }, { v: s.currency, s: 'center' }, { v: JSON.parse(s.facts || '{}').tax_note || '', s: 'muted' }]);
      for (const e of JSON.parse(s.employer || '[]')) rows2.push([s.name, `${e.label} (company pays)`, 'Company contribution', { v: e.amount, s: 'mutedMoney' }, { v: s.currency, s: 'center' }, { v: e.source || '', s: 'muted' }]);
      rows2.push([{ v: s.name, s: 'net' }, { v: 'Net pay', s: 'net' }, { v: '', s: 'net' }, { v: s.net, s: 'netMoney' }, { v: s.currency, s: 'netC' }, { v: '', s: 'net' }]);
    }
    const last2 = rows2.length - 1;
    audit(user, 'payroll.register', null, `${r.period} (Excel)`);
    return xlsxOut(X.workbook([
      { name: 'Summary', cols: [26, 28, 11, 13, 13, 13, 13, 13, 13, 14, 15, 10, 22, 13], rows: rows1, freeze: head1 + 1, filter: { row: head1, last: last1, from: 0, to: 13 }, heights: { 0: 26, [head1]: 34 }, landscape: true },
      { name: 'Every line', cols: [26, 36, 20, 14, 10, 62], rows: rows2, freeze: head2 + 1, filter: { row: head2, last: last2, from: 0, to: 5 }, heights: { 0: 26, [head2]: 24 }, landscape: true },
    ], { title: `Payroll register, ${name}` }), `payroll-register-${r.period}.xlsx`);
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
      .map((s) => ({ ...slipOut(s, { full: false }), period: s.period, name: P().periodName(s.period), status: s.status, pay_day: payDay(s.period), pay_by: payBy(s.period) }));
    const ty = slips.length ? taxYearOf(slips[0].period) : taxYearOf(ctx.calc.companyToday().slice(0, 7));
    const year = { tax_year: ty, from: `${ty - 1}-07`, to: `${ty}-06`, gross: 0, tax: 0, deductions: 0, net: 0, months: 0 };
    for (const s of slips) if (taxYearOf(s.period) === ty && (s.status === 'approved' || s.status === 'paid')) { year.gross += s.gross; year.tax += s.tax; year.deductions += s.deductions; year.net += s.net; year.months++; }
    const setup = P().setupOf(user.id), rec = P().recordOf(user.id);
    const advances = db.prepare('SELECT * FROM advances WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(user.id).map((a) => ({ ...a, installment: Math.ceil(a.amount / a.months), currency: setup ? setup.currency : 'PKR', decided_name: nameOf(a.decided_by) }));
    return { slips, year, base: setup ? { amount: setup.base, currency: setup.currency } : null, bank: rec && rec.iban ? { name: rec.bank_name, last4: String(rec.iban).replace(/\s/g, '').slice(-4) } : null, advances };
  });
  route('GET', '/api/me/certificate', ({ user, query }) => certOf(user, query));
  function certOf(user, query) {
    const ty = Number(query.get('tax_year')) || taxYearOf(ctx.calc.companyToday().slice(0, 7)) - 1;
    const slips = db.prepare("SELECT p.*, r.period FROM payslips p JOIN pay_runs r ON r.id = p.run_id WHERE p.user_id = ? AND r.status IN ('approved','paid') AND r.period >= ? AND r.period <= ? ORDER BY r.period").all(user.id, `${ty - 1}-07`, `${ty}-06`);
    const out = { tax_year: ty, from: `${ty - 1}-07-01`, to: `${ty}-06-30`, salary: 0, allowances: 0, extra: 0, deductions: 0, tax: 0, eobi: 0, other: 0, expenses: 0, net: 0, months: slips.length, currency: slips[0] ? slips[0].currency : 'PKR' };
    for (const s of slips) {
      for (const l of JSON.parse(s.lines)) {
        if (!l.counted) continue;
        if (l.kind === 'base') out.salary += l.amount; else if (l.kind === 'allowance') out.allowances += l.amount;
        else if (['commission', 'bonus', 'correction', 'leaving'].includes(l.kind) || l.key === 'overtime') out.extra += l.amount;
        else if (l.key === 'eobi') out.eobi += -l.amount;
        else if (l.kind === 'attendance') out.salary += l.amount;
        // so the certificate adds up: expenses paid back, and advances and other deductions taken off
        else if (l.kind === 'expense') out.expenses += l.amount;
        else if (l.amount < 0) out.other += -l.amount;
      }
      out.tax += s.tax; out.net += s.net;
    }
    const rec = P().recordOf(user.id);
    return { ...out, total: out.salary + out.allowances + out.extra, person: { name: user.name, title: user.title || null, joined: P().localJoin(user, rec) }, company: cfg.orgName, issued: ctx.calc.companyToday() };
  }

  // ---- PDFs: a real file, so saving works in every browser (Safari and phones included), not print() ----
  // Each carries the company's branding: its logo, address, tax number and brand colour (Settings, Company).
  // A month that was approved uses the details it was approved with.
  const pdfOut = (doc, title, filename, co) => ({ raw: doc.toBuffer({ title, author: co.legal || 'Staffwarden' }), type: 'application/pdf', headers: { 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store' } });
  const safeName = (n) => String(n || 'payslip').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const longDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  route('GET', '/api/payroll/slips/:id/pdf', ({ user, params }) => {
    const { s, r } = loadSlip(user, params.id);
    const o = slipOut(s), cur = o.currency, m = (n) => P().fmtMoney(n, cur);
    const co = ctx.companyFor(r.company), D = ctx.docParts, { L, R, INK, MUTED, SOFT } = D, brand = D.brandOf(co);
    const rec = P().recordOf(s.user_id);
    const doc = new Pdf();
    let y = D.head(doc, co, { title: 'Payslip', sub: P().periodName(r.period), sub2: o.paid_on ? `Paid ${shortDay(o.paid_on)}` : `Paid ${shortDay(payDay(r.period))} to ${shortDay(payBy(r.period))}` });
    // who, paid where, and the days
    doc.line(L, y, R, y, { color: '#E6E4F0' }); y += 22;
    const col = (R - L) / 3;
    doc.text(L, y, 'Employee', { size: 9, color: MUTED }); doc.text(L, y + 16, o.name || '', { size: 13, bold: true, color: INK, maxW: col - 12 }); if (o.title) doc.text(L, y + 30, o.title, { size: 9.5, color: MUTED, maxW: col - 12 });
    doc.text(L + col, y, 'Paid to', { size: 9, color: MUTED }); doc.text(L + col, y + 16, rec && rec.iban ? `${rec.bank_name || 'Bank'} ... ${String(rec.iban).replace(/\s/g, '').slice(-4)}` : o.by_hand ? 'Paid by hand' : 'No bank details', { size: 11.5, bold: true, color: INK, maxW: col - 12 });
    if (o.facts && o.facts.employed_days != null) { doc.text(L + col * 2, y, 'Days worked', { size: 9, color: MUTED }); doc.text(L + col * 2, y + 16, `${o.facts.present || 0} of ${o.facts.employed_days}`, { size: 11.5, bold: true, color: INK }); if (o.facts.unpaid) doc.text(L + col * 2, y + 30, `${o.facts.unpaid} day${o.facts.unpaid === 1 ? '' : 's'} unpaid leave`, { size: 9.5, color: MUTED }); }
    y += 46; doc.line(L, y, R, y, { color: '#E6E4F0' }); y += 20;
    // the four numbers
    doc.rect(L, y, R - L, 54, { fill: SOFT });
    [['Gross pay', o.gross], ['Income tax', o.tax], ['Deductions', o.deductions], ['Net pay', o.net]].forEach(([k, v], i) => { const x = L + 16 + (i * (R - L)) / 4; doc.text(x, y + 20, k, { size: 9, color: MUTED }); doc.text(x, y + 39, m(v), { size: 13, bold: true, color: i === 3 ? brand : INK }); });
    y += 80;
    doc.text(L, y, 'What makes up your pay', { size: 9, bold: true, color: MUTED }); doc.text(R, y, 'Amount', { size: 9, bold: true, color: MUTED, align: 'right' }); y += 8;
    doc.line(L, y, R, y, { color: '#CFCBE3', w: 1.2 }); y += 20;
    const row = (label, amount, note, { off = false } = {}) => {
      if (y > 740) { D.foot(doc, co); doc.page(); y = 60; }
      doc.text(L, y, label, { size: 11, bold: true, color: off ? MUTED : INK, maxW: R - L - 150 });
      doc.text(R, y, off ? `(${amount < 0 ? '- ' : ''}${m(amount)}) not counted` : `${amount < 0 ? '- ' : ''}${m(amount)}`, { size: 11, bold: true, color: off ? MUTED : amount < 0 ? '#B4442E' : INK, align: 'right' });
      if (note) { y += 14; doc.text(L, y, note, { size: 9, color: MUTED, maxW: R - L - 20 }); }
      y += 12; doc.line(L, y, R, y, { color: '#ECEAF4' }); y += 19;
    };
    for (const l of o.lines) row(l.label, l.amount, l.removed ? `Removed by ${l.removed.by}: ${l.removed.reason}` : l.source, { off: !l.counted });
    row('Income tax', -o.tax, o.facts.tax_note);
    y += 2; doc.rect(L, y, R - L, 2, { fill: INK }); y += 26;
    doc.text(L, y, 'Net pay', { size: 14, bold: true, color: INK }); doc.text(R, y, m(o.net), { size: 20, bold: true, color: brand, align: 'right' }); y += 30;
    if (o.employer && o.employer.length) y = doc.para(L, y, `Paid by ${co.name} for you, not from your pay: ${o.employer.map((e) => `${e.label} ${m(e.amount)}`).join(', ')}.`, { size: 9, maxW: R - L, color: MUTED });
    D.signOff(doc, co, y);
    D.foot(doc, co, 'Questions? Ask in Staffwarden, under Your pay.');
    if (isHR(user) && s.user_id !== user.id) audit(user, 'payroll.slip_viewed', s.user_id, `${r.period} (PDF)`);
    return pdfOut(doc, `${o.name} payslip ${P().periodName(r.period)}`, `payslip-${safeName(o.name)}-${r.period}.pdf`, co);
  });

  route('GET', '/api/me/certificate.pdf', ({ user, query }) => {
    const c = certOf(user, query), m = (n) => P().fmtMoney(n, c.currency);
    need(c.months, 404, 'No approved payslips in that tax year yet');
    const co = ctx.companyFor(null), D = ctx.docParts, { L, R, INK, MUTED, SOFT } = D, brand = D.brandOf(co);
    const doc = new Pdf();
    let y = D.head(doc, co, { addressRight: true });
    doc.text(L, y, `Issued ${longDay(c.issued)}`, { size: 9.5, color: MUTED }); y += 34;
    doc.text(L, y, 'Salary and tax certificate', { size: 24, bold: true, color: INK }); y += 22;
    doc.text(L, y, `Tax year ${c.tax_year} · July 1, ${c.tax_year - 1} to June 30, ${c.tax_year}`, { size: 11.5, bold: true, color: brand }); y += 28;
    y = doc.para(L, y, `This is to certify that ${c.person.name}${c.person.title ? `, ${c.person.title},` : ''} has been employed by ${co.legal}${c.person.joined ? ` since ${longDay(c.person.joined)}` : ''}, and was paid the amounts below in this tax year, with income tax taken from salary each month.`, { size: 11, color: '#2E2A50', maxW: R - L - 40, lead: 1.55 }) + 14;
    const row = (k, v, strong) => { if (strong) doc.rect(L, y - 15, R - L, 26, { fill: SOFT }); doc.text(L + 12, y, k, { size: 11, bold: !!strong, color: INK }); doc.text(R - 12, y, m(v), { size: strong ? 12 : 11, bold: true, color: strong ? brand : INK, align: 'right' }); y += 12; if (!strong) doc.line(L, y, R, y, { color: '#ECEAF4' }); y += 20; };
    row('Salary', c.salary); row('Allowances', c.allowances); row('Commission, bonuses and other pay', c.extra); row('Total pay', c.total, true);
    row('Income tax taken from pay', c.tax); if (c.eobi) row('EOBI, employee share', c.eobi); if (c.other) row('Advances and other deductions', c.other); if (c.expenses) row('Expenses paid back, not taxed', c.expenses); row('Net pay', c.net, true);
    y += 6;
    doc.para(L, y, `${c.months} month${c.months === 1 ? '' : 's'} paid in this tax year. Made from the payroll records of ${co.name} in Staffwarden.`, { size: 9, maxW: R - L, color: MUTED });
    D.signature(doc, co, 660);
    D.foot(doc, co);
    return pdfOut(doc, `Salary and tax certificate ${c.tax_year}`, `tax-certificate-${safeName(user.name)}-${c.tax_year}.pdf`, co);
  });

  // ---- rules ----
  route('GET', '/api/payroll/rules', ({ user }) => { needHR(user); return P().rules(); });
  route('PUT', '/api/payroll/rules', ({ user, body }) => {
    needHR(user);
    const cur = P().rules(), next = JSON.parse(JSON.stringify(cur));
    const one = (k, opts) => { if (k in body) { need(opts.includes(body[k]), 400, `${k} must be one of ${opts.join(', ')}`); next[k] = body[k]; } };
    one('day_basis', ['working', '30', 'calendar']); one('unpaid_leave', ['deduct', 'show']); one('absent', ['deduct', 'show', 'off']); one('first_month', ['same', 'next']);
    if (body.late) { need(['off', 'show', 'deduct'].includes(body.late.mode), 400, 'late.mode must be off, show or deduct'); next.late = { mode: body.late.mode, every: int(body.late.every ?? cur.late.every, 'late.every', 1, 31), days: Number(body.late.days ?? cur.late.days) }; need([0.25, 0.5, 1].includes(next.late.days), 400, 'late.days must be 0.25, 0.5 or 1'); }
    if (body.overtime) { need(['off', 'show', 'deduct'].includes(body.overtime.mode), 400, 'overtime.mode must be off, show or deduct'); const rate = Number(body.overtime.rate ?? cur.overtime.rate); need(rate >= 1 && rate <= 3, 400, 'overtime.rate must be between 1 and 3'); next.overtime = { mode: body.overtime.mode, rate }; }
    if ('pay_day' in body) next.pay_day = int(body.pay_day, 'pay_day', 1, 28);
    if ('pay_by' in body) next.pay_by = int(body.pay_by, 'pay_by', 1, 28);
    if (next.pay_by != null && next.pay_day != null) need(next.pay_by >= next.pay_day, 400, 'The last pay day has to be on or after the first');
    if ('leave_payout' in body) next.leave_payout = !!body.leave_payout;
    if (body.tax && 'on' in body.tax) next.tax = { ...next.tax, on: !!body.tax.on };
    if (body.tax && body.tax.brackets) {
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
      next.tax = { ...next.tax, label: optStr(body.tax.label, 'tax.label', 160) || cur.tax.label, brackets: b };
    }
    if (body.eobi) next.eobi = { on: !!body.eobi.on, min_wage: int(body.eobi.min_wage ?? cur.eobi.min_wage, 'eobi.min_wage', 0, 10000000), er: Number(body.eobi.er ?? cur.eobi.er), ee: Number(body.eobi.ee ?? cur.eobi.ee) };
    if (body.expense_limits) next.expense_limits = Object.fromEntries(Object.entries(body.expense_limits).filter(([k]) => /^[a-z]{2,20}$/.test(k)).map(([k, v]) => [k, int(v, 'limit', 0, 10000000)]));
    // these decide who controls HR, so only the owner changes them
    for (const k of ['owner_approves', 'hr_own_pay', 'managers_first']) if (k in body) { need(user.role === 'owner', 403, 'Only the owner can change who approves'); next[k] = !!body[k]; }
    saveSetting('payroll', next);
    audit(user, 'payroll.rules', null, `${Object.keys(body).join(', ')}${cur.tax.on !== next.tax.on ? `; income tax ${next.tax.on === false ? 'off' : 'on'}` : ''}`);
    // a month not approved yet follows the new rules straight away
    for (const r of db.prepare("SELECT * FROM pay_runs WHERE status IN ('draft','review')").all()) P().compute(r);
    emit('payroll');
    return P().rules();
  });
};
