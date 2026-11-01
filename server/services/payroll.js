'use strict';
// Payroll: what one person is paid for one month, worked out from what Staffwarden already knows (their
// days, attendance, approved leave and tracked hours) and the rules HR chose. Every line says where it
// came from, so the person can check it and ask about it.
//
// Amounts are whole units of the person's currency. A line is { key, label, amount, source, kind,
// taxable, counted }: `counted: false` lines are shown for HR to decide by hand and do not change pay.
const T = require('../lib/time');

const STATUSES = ['draft', 'review', 'approved', 'paid'];
const ITEM_KINDS = { commission: 1, bonus: 1, allowance: 1, deduction: -1, correction: 0, expense: 1 };
const LOCKED = (s) => s === 'approved' || s === 'paid';

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  return out;
}
// yearly tax on the brackets: [up to, fixed, % on the part above the previous bracket]
function yearlyTax(income, brackets) {
  let lo = 0;
  for (const [hi, fixed, pct] of brackets) {
    if (hi == null || income <= hi) return fixed + (pct / 100) * Math.max(0, income - lo);
    lo = hi;
  }
  return 0;
}
const monthDays = (period) => { const [y, m] = period.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return T.eachDay(`${period}-01`, `${period}-${String(n).padStart(2, '0')}`); };
const nextPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const periodName = (p) => new Date(p + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dayList = (days) => days.length <= 4 ? days.map((d) => T.human(d).replace(/^\w+, /, '')).join(', ') : `${T.human(days[0]).replace(/^\w+, /, '')} to ${T.human(days[days.length - 1]).replace(/^\w+, /, '')}`;
const fmtMoney = (n, cur) => `${cur === 'USD' ? '$' : 'Rs'} ${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

function createPayroll(ctx) {
  const { db, cfg } = ctx;
  const calc = () => ctx.calc;
  const rules = () => merge(ctx.defaults.payroll, cfg.payroll || {});
  const setupOf = (id) => {
    const r = db.prepare('SELECT * FROM pay_setup WHERE user_id = ?').get(id);
    if (!r) return null;
    const j = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };
    return { ...r, allowances: j(r.allowances), deductions: j(r.deductions) };
  };
  const recordOf = (id) => db.prepare('SELECT * FROM hr_records WHERE user_id = ?').get(id) || null;
  const localJoin = (u, rec) => (rec && rec.joined_on) || (u.created_at ? T.localDay(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(u.created_at) ? u.created_at : `${u.created_at.replace(' ', 'T')}Z`), calc().dayTz(u)) : null);

  // what has already been repaid on an advance, from approved and paid payslips (not this run)
  function repaid(advId, exceptRun) {
    let n = 0;
    for (const s of db.prepare(`SELECT p.lines FROM payslips p JOIN pay_runs r ON r.id = p.run_id WHERE r.status IN ('approved','paid') AND r.id != ?`).all(exceptRun || 0)) {
      for (const l of JSON.parse(s.lines)) if (l.key === `adv:${advId}`) n += -l.amount;
    }
    return n;
  }

  // ---------- one person, one month ----------
  function slipFor(u, period, run) {
    const R = rules(), c = calc();
    const setup = setupOf(u.id);
    if (!setup) return null;
    const rec = recordOf(u.id);
    const cur = setup.currency;
    const days = monthDays(period);
    const from = days[0], to = days[days.length - 1];
    const joined = localJoin(u, rec), leaving = rec && rec.leaving_on;
    const inJob = (d) => (!joined || d >= joined) && (!leaving || d <= leaving);
    const wd = c.workDaySet(u);
    const workdays = days.filter((d) => wd.has(T.dow(d)));
    const range = c.makeRange([u], from, to);
    const lines = [];
    const add = (l) => lines.push({ counted: true, taxable: true, ...l });

    // base, for the part of the month they worked here
    const basisDays = R.day_basis === '30' ? 30 : R.day_basis === 'calendar' ? days.length : workdays.length;
    const dayRate = setup.base / Math.max(1, basisDays);
    const employedWork = workdays.filter(inJob), employedAll = days.filter(inJob);
    let base = setup.base, baseNote = `${periodName(period)}, full month`;
    if (employedAll.length < days.length) {
      const part = R.day_basis === 'working' ? employedWork.length : Math.min(basisDays, employedAll.length);
      base = Math.round(dayRate * part);
      const why = joined && joined > from ? `Joined ${T.human(joined).replace(/^\w+, /, '')}` : `Last day ${T.human(leaving).replace(/^\w+, /, '')}`;
      baseNote = R.day_basis === 'working' ? `${why}: ${part} of ${workdays.length} working days` : `${why}: ${part} of ${basisDays} days`;
    }
    add({ key: 'base', label: 'Base salary', amount: base, source: baseNote, kind: 'base' });
    for (const a of setup.allowances) if (a && a.amount) add({ key: `alw:${a.label}`, label: a.label, amount: Math.round(a.amount), source: 'Every month', kind: 'allowance', taxable: a.taxable !== false });

    // attendance
    const absent = [], unpaid = [], late = [];
    let worked = 0, expected = 0, planned = 0, present = 0;
    for (const d of days) {
      if (!inJob(d)) continue;
      const m = range.get(u, d), a = m.att;
      worked += m.worked_secs || 0;
      if (a.status !== 'upcoming') expected += a.expected_secs || 0;
      if (wd.has(T.dow(d)) && !a.holiday) planned += c.dailyTargetMin(u, d) * 60;
      if (a.status === 'present' || a.status === 'late') present++;
      if (a.status === 'absent') absent.push(d);
      else if (a.status === 'late') late.push(d);
      if (a.leave_kind === 'unpaid' && wd.has(T.dow(d)) && !a.holiday) unpaid.push(d);
    }
    const rule = (mode, l) => { if (mode === 'off') return; add({ ...l, counted: mode !== 'show', source: l.source + (mode === 'show' ? '. Shown only: decide by hand' : '') }); };
    if (unpaid.length) rule(R.unpaid_leave === 'show' ? 'show' : 'deduct', { key: 'unpaid', label: 'Unpaid leave', amount: -Math.round(dayRate * unpaid.length), source: `${plural(unpaid.length, 'day')}: ${dayList(unpaid)}`, kind: 'attendance', link: `#/timeoff` });
    if (absent.length) rule(R.absent, { key: 'absent', label: 'Absent', amount: -Math.round(dayRate * absent.length), source: `${plural(absent.length, 'day')}: ${dayList(absent)}. No time tracked, no leave`, kind: 'attendance', link: '#/attendance' });
    if (late.length && R.late.mode !== 'off' && R.late.every > 0) {
      const units = Math.floor(late.length / R.late.every);
      if (units > 0) rule(R.late.mode === 'show' ? 'show' : 'deduct', { key: 'late', label: 'Late arrivals', amount: -Math.round(dayRate * units * R.late.days), source: `${plural(late.length, 'late start')}: ${dayList(late)}. Every ${R.late.every} = ${R.late.days === 1 ? 'a day' : R.late.days === 0.5 ? 'half a day' : R.late.days + ' days'}`, kind: 'attendance', link: '#/attendance' });
    }
    const otSecs = Math.max(0, worked - expected);
    if (R.overtime.mode !== 'off' && otSecs >= 1800 && planned > 0) {
      const hourly = setup.base / (planned / 3600), hours = Math.floor(otSecs / 1800) / 2;
      rule(R.overtime.mode === 'show' ? 'show' : 'deduct', { key: 'overtime', label: 'Overtime', amount: Math.round(hours * hourly * R.overtime.rate), source: `${hours} hours past the target, at ${R.overtime.rate}×`, kind: 'attendance' });
    }
    // unused leave, when someone leaves this month
    if (leaving && leaving >= from && leaving <= to && R.leave_payout) {
      const year = leaving.slice(0, 4), start = joined && joined > `${year}-01-01` ? joined : `${year}-01-01`;
      const months = Math.max(0, (Number(leaving.slice(5, 7)) - Number(start.slice(5, 7))) + 1);
      const accrued = Math.floor((cfg.leaveDaysPerYear * months) / 12), taken = c.approvedLeaveDays(u, year);
      const left = Math.max(0, accrued - taken);
      if (left) add({ key: 'leave_payout', label: 'Unused leave paid out', amount: Math.round(dayRate * left), source: `${plural(left, 'day')} earned this year and not taken`, kind: 'leaving' });
    }
    // added by HR for this month
    for (const it of run ? db.prepare('SELECT * FROM pay_items WHERE run_id = ? AND user_id = ? ORDER BY id').all(run.id, u.id) : []) {
      const sign = ITEM_KINDS[it.kind];
      const amount = sign === 0 ? it.amount : sign * Math.abs(it.amount);
      add({ key: `item:${it.id}`, label: it.label, amount, source: it.reason, kind: it.kind, taxable: it.kind !== 'deduction', item: it.id });
    }
    // approved expenses
    for (const e of run ? db.prepare("SELECT * FROM expenses WHERE user_id = ? AND currency = ? AND status IN ('approved','paid') AND (run_id = ? OR run_id IS NULL) ORDER BY spent_on").all(u.id, cur, run.id) : []) {
      add({ key: `exp:${e.id}`, label: `Expense: ${e.note.slice(0, 60)}`, amount: e.amount, source: `${e.category[0].toUpperCase() + e.category.slice(1)}, ${T.human(e.spent_on).replace(/^\w+, /, '')}. Paid back, not taxed`, kind: 'expense', taxable: false, expense: e.id });
    }
    // advances being paid back
    for (const a of db.prepare("SELECT * FROM advances WHERE user_id = ? AND status = 'approved' ORDER BY id").all(u.id)) {
      const start = a.decided_at ? nextPeriod(T.localDay(Date.parse(a.decided_at), c.dayTz(u)).slice(0, 7)) : period;
      if (period < start) continue;
      const left = a.amount - repaid(a.id, run && run.id);
      if (left <= 0) continue;
      const inst = Math.min(left, Math.ceil(a.amount / a.months));
      const n = Math.round((a.amount - left) / Math.ceil(a.amount / a.months)) + 1;
      add({ key: `adv:${a.id}`, label: 'Advance repayment', amount: -inst, source: `${n} of ${a.months}. ${fmtMoney(left - inst, cur)} left after this`, kind: 'advance', taxable: false });
    }
    for (const d of setup.deductions) if (d && d.amount) add({ key: `ded:${d.label}`, label: d.label, amount: -Math.round(Math.abs(d.amount)), source: 'Every month', kind: 'deduction', taxable: false });
    // contributions
    const employer = [];
    const contractor = rec && rec.contract === 'contractor';
    if (R.eobi.on && cur === 'PKR' && !contractor) {
      add({ key: 'eobi', label: 'EOBI, your share', amount: -Math.round((R.eobi.min_wage * R.eobi.ee) / 100), source: `${R.eobi.ee}% of the Rs ${Number(R.eobi.min_wage).toLocaleString('en-US')} minimum wage`, kind: 'contribution', taxable: false });
      employer.push({ label: 'EOBI', amount: Math.round((R.eobi.min_wage * R.eobi.er) / 100), source: `${R.eobi.er}% of the minimum wage, paid by the company` });
    }
    // income tax
    const counted = lines.filter((l) => l.counted);
    const taxable = counted.filter((l) => l.taxable).reduce((n, l) => n + l.amount, 0);
    let tax = 0;
    if (setup.tax_mode === 'pk' && cur === 'PKR' && taxable > 0) tax = Math.round(yearlyTax(taxable * 12, R.tax.brackets) / 12);
    const gross = counted.filter((l) => l.amount > 0).reduce((n, l) => n + l.amount, 0);
    const deductions = -counted.filter((l) => l.amount < 0).reduce((n, l) => n + l.amount, 0);
    const facts = {
      workdays: workdays.length, employed_days: employedWork.length, present, absent: absent.length, late: late.length, unpaid: unpaid.length,
      worked_secs: worked, expected_secs: expected, taxable, tax_note: setup.tax_mode === 'pk' && cur === 'PKR' ? `${fmtMoney(taxable, cur)} × 12 = ${fmtMoney(taxable * 12, cur)} a year, on the brackets` : 'No tax taken: ' + (cur !== 'PKR' ? 'paid in dollars' : 'set to none'),
      joined, leaving, bank: !!(rec && rec.iban), contract: rec ? rec.contract : null,
    };
    return { currency: cur, lines, gross, deductions, tax, net: gross - deductions - tax, employer, facts };
  }

  // works out every slip of a run again (not once it is approved)
  function compute(run) {
    const people = db.prepare('SELECT * FROM users WHERE active = 1 OR id IN (SELECT user_id FROM hr_records WHERE leaving_on >= ?)').all(`${run.period}-01`);
    const now = ctx.nowIso();
    const keep = new Set();
    for (const u of people) {
      const rec = recordOf(u.id), joined = localJoin(u, rec);
      if (joined && joined > monthDays(run.period).slice(-1)[0]) continue;
      if (rec && rec.leaving_on && rec.leaving_on < `${run.period}-01`) continue;
      const s = slipFor(u, run.period, run);
      if (!s) continue;
      keep.add(u.id);
      db.prepare(`INSERT INTO payslips (run_id, user_id, currency, lines, gross, deductions, tax, net, employer, facts, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_id, user_id) DO UPDATE SET currency = excluded.currency, lines = excluded.lines, gross = excluded.gross, deductions = excluded.deductions, tax = excluded.tax, net = excluded.net, employer = excluded.employer, facts = excluded.facts, updated_at = excluded.updated_at`)
        .run(run.id, u.id, s.currency, JSON.stringify(s.lines), s.gross, s.deductions, s.tax, s.net, JSON.stringify(s.employer), JSON.stringify(s.facts), now);
      // approved expenses go with this run
      for (const l of s.lines) if (l.expense) db.prepare('UPDATE expenses SET run_id = ? WHERE id = ?').run(run.id, l.expense);
    }
    for (const r of db.prepare('SELECT id, user_id FROM payslips WHERE run_id = ?').all(run.id)) if (!keep.has(r.user_id)) db.prepare('DELETE FROM payslips WHERE id = ?').run(r.id);
  }

  return { rules, slipFor, compute, setupOf, recordOf, yearlyTax, monthDays, periodName, fmtMoney, merge, LOCKED, STATUSES, ITEM_KINDS, nextPeriod, localJoin };
}

module.exports = { createPayroll, yearlyTax, merge };
