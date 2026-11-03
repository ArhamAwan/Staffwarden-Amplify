'use strict';
// HR: people's records, pay, documents, joining and leaving, expense claims and advances.
// HR (and the owner) see this for everyone; each person sees their own; managers see none of it, except
// approving their team's expense claims as a first step. HR never gets screenshots or activity from here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, str, optStr, int } = require('../lib/http');
const T0 = require('../lib/time');
// a calendar day, kept as YYYY-MM-DD
const isoDate = (v, name) => { need(T0.isDay(v), 400, `${name} must be a date like 2026-10-28`); return v; };

const CONTRACTS = ['full_time', 'part_time', 'probation', 'contractor', 'intern'];
const DOC_KINDS = ['contract', 'offer', 'cnic', 'degree', 'policy', 'letter', 'other'];
const CATS = ['travel', 'meals', 'equipment', 'software', 'phone', 'other'];
const STEPS = {
  join: [
    ['offer', 'Offer letter signed', 'HR keeps the signed copy'], ['account', 'Staffwarden account made', 'They can sign in'],
    ['app', 'Desktop app installed and the policy agreed', 'Done when they agree in the app'], ['contract', 'Employment contract signed', 'Upload it to their documents'],
    ['bank', 'Bank details', 'Needed before their first payroll is approved'], ['cnic', 'CNIC copy', 'Front and back, kept with their record'],
    ['checkin', 'First week check-in', 'Their manager meets them'], ['probation', 'Probation review', 'When probation ends'],
  ],
  leave: [
    ['notice', 'Resignation or notice received', 'Kept with their record'], ['equipment', 'Laptop and other equipment returned', 'Their manager checks them in'],
    ['access', 'Access to other systems removed', 'Email, CRM, chat'], ['letter', 'Experience letter given', 'Made from their record'],
    ['settlement', 'Final settlement on payroll', 'Their last month includes unused leave'], ['deactivate', 'Staffwarden account deactivated', 'Their history is kept'],
  ],
};

module.exports = (ctx) => {
  const { db, cfg, route, emit, audit, isHR, needHR, isManager, canSee, nowIso, hrDir, T, calc } = ctx;
  const P = () => ctx.payroll;
  const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null : null);
  const userOf = (id) => { const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)); need(u, 404, 'Person not found'); return u; };
  const mask = (iban) => (iban ? `••• ${String(iban).replace(/\s/g, '').slice(-4)}` : null);
  const ownOrHR = (user, uid) => need(isHR(user) || user.id === uid, 403, 'Not allowed');

  // ---- steps: some are done by themselves, from what Staffwarden already knows ----
  function steps(u, flow) {
    const rec = P().recordOf(u.id) || {};
    const done = new Map(db.prepare('SELECT * FROM hr_steps WHERE user_id = ? AND flow = ?').all(u.id, flow).map((r) => [r.step, r]));
    const docs = db.prepare('SELECT kind, status FROM hr_docs WHERE user_id = ?').all(u.id);
    const auto = {
      account: () => true, app: () => !!u.consented_at, bank: () => !!rec.iban, cnic: () => docs.some((d) => d.kind === 'cnic'),
      contract: () => docs.some((d) => d.kind === 'contract' && d.status !== 'waiting'), deactivate: () => !u.active,
    };
    return STEPS[flow].map(([key, title, sub]) => {
      const r = done.get(key);
      const isAuto = !!auto[key] && (flow === 'join' || key === 'deactivate');
      const autoDone = isAuto && auto[key]();
      const ok = (r && r.done_at) || autoDone;
      return { key, title, sub, done: !!ok, auto: isAuto, auto_done: !!autoDone, done_at: r ? r.done_at : null, done_by: r ? nameOf(r.done_by) : null };
    });
  }

  function personOut(u, viewer, { full = false } = {}) {
    const rec = P().recordOf(u.id) || {};
    const setup = P().setupOf(u.id);
    const me = viewer.id === u.id && !isHR(viewer);
    const out = {
      id: u.id, name: u.name, title: u.title || null, email: u.email, role: u.role, hr: !!u.hr, active: !!u.active, team: u.team_id ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(u.team_id) || {}).name || null : null,
      record: {
        dob: rec.dob || null, contract: rec.contract || 'full_time', joined_on: P().localJoin(u, rec), probation_end: rec.probation_end || null, notice_days: rec.notice_days ?? null,
        bank_name: rec.bank_name || null, account_title: rec.account_title || null, iban: me ? mask(rec.iban) : rec.iban || null, iban_masked: mask(rec.iban),
        emergency_name: rec.emergency_name || null, emergency_phone: rec.emergency_phone || null, phone: rec.phone || null, cnic: me ? (rec.cnic ? `•••••-•••••••-${String(rec.cnic).slice(-1)}` : null) : rec.cnic || null, address: rec.address || null, leaving_on: rec.leaving_on || null, leaving_reason: rec.leaving_reason || null,
        notes: me ? undefined : rec.notes || null,
      },
      update_request: rec.upd_fields ? { fields: JSON.parse(rec.upd_fields), note: rec.upd_note || null, by: nameOf(rec.upd_by), at: rec.upd_at } : null,
      pay: setup ? { base: setup.base, currency: setup.currency, tax_mode: setup.tax_mode, allowances: setup.allowances, deductions: setup.deductions } : null,
    };
    if (full) {
      out.history = db.prepare('SELECT * FROM salary_history WHERE user_id = ? ORDER BY effective_from DESC, id DESC').all(u.id).map((h) => ({ ...h, by_name: nameOf(h.by_id) }));
      out.docs = db.prepare('SELECT id, name, kind, type, size, status, expires_on, uploaded_by, created_at FROM hr_docs WHERE user_id = ? ORDER BY created_at DESC').all(u.id).map((d) => ({ ...d, uploaded_by_name: nameOf(d.uploaded_by) }));
      out.join_steps = steps(u, 'join');
      out.leave_steps = rec.leaving_on ? steps(u, 'leave') : null;
      const year = calc.companyToday().slice(0, 4);
      out.leave = { allowance: cfg.leaveDaysPerYear, taken: calc.approvedLeaveDays(u, year), unpaid: db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE user_id = ? AND kind = 'unpaid' AND status = 'approved' AND start_day LIKE ?").get(u.id, `${year}-%`).n };
      out.slips = db.prepare("SELECT p.id, p.net, p.currency, r.period, r.status FROM payslips p JOIN pay_runs r ON r.id = p.run_id WHERE p.user_id = ? AND r.status != 'draft' ORDER BY r.period DESC LIMIT 6").all(u.id).map((s) => ({ ...s, name: P().periodName(s.period) }));
      out.advances = db.prepare('SELECT * FROM advances WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(u.id);
      out.can_edit_pay = !me && ((viewer.role === 'owner' && !viewer.dev_owner) || viewer.id !== u.id || P().rules().hr_own_pay);
      out.employed = employedOf(u);
    }
    return out;
  }

  // ---- people ----
  route('GET', '/api/hr/people', ({ user, query }) => {
    needHR(user);
    const all = query.get('all') === '1';
    return db.prepare(`SELECT * FROM users ${all ? '' : 'WHERE active = 1'} ORDER BY name`).all().map((u) => {
      const p = personOut(u, user);
      const docs = db.prepare('SELECT kind, status FROM hr_docs WHERE user_id = ?').all(u.id);
      p.employed = employedOf(u); p.is_dev = !!u.is_dev; p.tracks_time = !!u.tracks_time;
      p.flags = { no_pay: !p.pay && u.role !== 'owner' && p.employed, no_bank: !!p.pay && !p.record.iban, unsigned: !docs.some((d) => d.kind === 'contract' && d.status !== 'waiting'), leaving: p.record.leaving_on };
      p.advance_left = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM advances WHERE user_id = ? AND status = 'approved'").get(u.id).n;
      return p;
    });
  });
  route('GET', '/api/hr/people/:id', ({ user, params }) => {
    const u = userOf(params.id);
    ownOrHR(user, u.id);
    if (isHR(user) && user.id !== u.id) audit(user, 'hr.viewed', u.id, 'Opened their HR record');
    return personOut(u, user, { full: true });
  });
  route('GET', '/api/me/hr', ({ user }) => personOut(user, { ...user, hr: 0, role: 'employee' }, { full: true }));

  // ---- HR asks someone to update their own details ----
  // Nobody edits their HR record themselves until HR asks. HR picks what to update (and says why); the
  // person is told, fills in just those, and HR hears it's done. One request at a time.
  const UPDATABLE = { name: ['name'], dob: ['dob'], phone: ['phone'], address: ['address'], cnic: ['cnic'], emergency: ['emergency_name', 'emergency_phone'], bank: ['bank_name', 'account_title', 'iban'] };
  const UPD_LABEL = { name: 'name', dob: 'date of birth', phone: 'phone', address: 'address', cnic: 'CNIC', emergency: 'emergency contact', bank: 'bank details' };
  const listOf = (keys) => { const l = keys.map((k) => UPD_LABEL[k]); return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]; };
  const hrPeople = () => db.prepare("SELECT id FROM users WHERE active = 1 AND (role = 'owner' OR hr = 1)").all().map((r) => r.id);
  const setReq = (uid, v) => {
    if (!P().recordOf(uid)) db.prepare('INSERT INTO hr_records (user_id, updated_at) VALUES (?, ?)').run(uid, nowIso());
    db.prepare('UPDATE hr_records SET upd_fields = ?, upd_note = ?, upd_by = ?, upd_at = ? WHERE user_id = ?').run(v ? JSON.stringify(v.fields) : null, v ? v.note : null, v ? v.by : null, v ? nowIso() : null, uid);
  };
  route('POST', '/api/hr/people/:id/update-request', ({ user, params, body }) => {
    needHR(user);
    const u = userOf(params.id);
    need(u.active, 400, 'Their account is deactivated');
    need(u.id !== user.id, 400, 'You can change your own record from Edit');
    const fields = [...new Set(Array.isArray(body.fields) ? body.fields : [])];
    need(fields.length && fields.every((f) => f in UPDATABLE), 400, `Choose what to update: ${Object.keys(UPDATABLE).join(', ')}`);
    const note = optStr(body.note, 'note', 300);
    setReq(u.id, { fields, note, by: user.id });
    audit(user, 'hr.update_requested', u.id, listOf(fields));
    ctx.notify.notify(u.id, { kind: 'changed', title: 'Please update your details', body: `${String(user.name).split(" ")[0]} asked you to update your ${listOf(fields)}.${note ? ` “${note}”` : ''}`, link: '#/profile?details=1', actor: user, dedupe: `updreq:${u.id}:${nowIso().slice(0, 16)}` });
    emit('hr', u.id); ctx.emitTo(u.id, 'hr');
    return personOut(u, user, { full: true });
  });
  route('DELETE', '/api/hr/people/:id/update-request', ({ user, params }) => {
    needHR(user);
    const u = userOf(params.id);
    setReq(u.id, null);
    audit(user, 'hr.update_cancelled', u.id, '');
    emit('hr', u.id); ctx.emitTo(u.id, 'hr');
    return personOut(u, user, { full: true });
  });
  // just the open request, if any: the reminder at the top of every page until it's done
  route('GET', '/api/me/details-request', ({ user }) => {
    const rec = db.prepare('SELECT upd_fields, upd_note, upd_by, upd_at FROM hr_records WHERE user_id = ?').get(user.id);
    if (!rec || !rec.upd_fields) return { request: null };
    const fields = JSON.parse(rec.upd_fields);
    return { request: { fields, label: listOf(fields), note: rec.upd_note || null, by: nameOf(rec.upd_by), at: rec.upd_at } };
  });
  route('PUT', '/api/me/details', ({ user, body }) => {
    const rec = P().recordOf(user.id);
    need(rec && rec.upd_fields, 403, 'HR hasn’t asked you to update your details. Ask HR if something is wrong.');
    const fields = JSON.parse(rec.upd_fields);
    const allowed = new Set(fields.flatMap((f) => UPDATABLE[f]));
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    need(!extra.length, 403, `HR didn’t ask you to change ${extra.join(', ')}`);
    const recBody = { ...body }; delete recBody.name;
    if ('name' in body) {
      const name = str(body.name, 'name', 100);
      if (name !== user.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    }
    if (Object.keys(recBody).length) saveRecord(user, user, recBody);
    else audit(user, 'hr.record', user.id, 'name');
    // what actually changed, so HR knows what to look at (not just what was asked for)
    const after = P().recordOf(user.id) || {};
    const norm = (v) => (v == null ? '' : String(v).replace(/\s+/g, '').toLowerCase());
    const changed = fields.filter((f) => (f === 'name' ? 'name' in body && str(body.name, 'name', 100) !== user.name : UPDATABLE[f].some((k) => norm(rec[k]) !== norm(after[k]))));
    const asker = rec.upd_by;
    setReq(user.id, null);
    audit(user, 'hr.update_done', user.id, changed.length ? `changed ${listOf(changed)}` : 'no changes');
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const title = changed.length ? `${fresh.name} updated their details` : `${fresh.name} checked their details`;
    const msg = !changed.length ? 'Nothing needed changing.' : `Changed their ${listOf(changed)}.`;
    ctx.notify.notify([...new Set([asker, ...hrPeople()])].filter((id) => id && id !== user.id), { kind: 'hr_step', title, body: msg, link: `#/hr?id=${user.id}`, actor: fresh, dedupe: `upddone:${user.id}:${changed.length ? "c" : "n"}:${nowIso().slice(0, 16)}` });
    emit('hr', user.id);
    return personOut(fresh, { ...fresh, hr: 0, role: 'employee' }, { full: true });
  });

  // a developer or test account is not an employee: HR says so, or a developer account whose time is not
  // tracked is one (managers' time may not be tracked either, and they are paid)
  const employedOf = (u) => { const r = P().recordOf(u.id); return r && r.employed != null ? !!r.employed : !(u.is_dev && !u.tracks_time); };
  route('PUT', '/api/hr/people/:id/record', ({ user, params, body }) => { needHR(user); return saveRecord(user, userOf(params.id), body); });
  function saveRecord(user, u, body) {
    const cur = P().recordOf(u.id) || {};
    const next = { ...cur };
    const text = (k, max) => { if (k in body) next[k] = optStr(body[k], k, max); };
    const day = (k) => { if (k in body) next[k] = body[k] ? isoDate(body[k], k) : null; };
    if ('contract' in body) { need(CONTRACTS.includes(body.contract), 400, `contract must be one of ${CONTRACTS.join(', ')}`); next.contract = body.contract; }
    day('joined_on'); day('probation_end'); day('leaving_on'); day('dob');
    if ('notice_days' in body) next.notice_days = body.notice_days === null || body.notice_days === '' ? null : int(body.notice_days, 'notice_days', 0, 365);
    for (const [k, m] of [['bank_name', 80], ['account_title', 100], ['emergency_name', 100], ['emergency_phone', 40], ['phone', 40], ['address', 300], ['leaving_reason', 200], ['notes', 2000]]) text(k, m);
    if ('employed' in body) next.employed = body.employed === null ? null : body.employed ? 1 : 0;
    if ('cnic' in body) { const v = body.cnic ? String(body.cnic).replace(/\D/g, '') : null; need(v === null || v.length === 13, 400, 'A CNIC has 13 digits, like 61101-1234567-1'); next.cnic = v ? `${v.slice(0, 5)}-${v.slice(5, 12)}-${v.slice(12)}` : null; }
    if ('iban' in body) {
      const v = body.iban ? String(body.iban).replace(/\s+/g, '').toUpperCase() : null;
      need(v === null || /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(v), 400, 'That IBAN does not look right. It starts with two letters, like PK36MEZN…');
      next.iban = v ? v.replace(/(.{4})/g, '$1 ').trim() : null;
    }
    db.prepare(`INSERT INTO hr_records (user_id, dob, contract, joined_on, probation_end, notice_days, bank_name, account_title, iban, emergency_name, emergency_phone, phone, cnic, address, leaving_on, leaving_reason, notes, employed, updated_at)
      VALUES (@user_id, @dob, @contract, @joined_on, @probation_end, @notice_days, @bank_name, @account_title, @iban, @emergency_name, @emergency_phone, @phone, @cnic, @address, @leaving_on, @leaving_reason, @notes, @employed, @updated_at)
      ON CONFLICT(user_id) DO UPDATE SET dob = excluded.dob, contract = excluded.contract, joined_on = excluded.joined_on, probation_end = excluded.probation_end, notice_days = excluded.notice_days, bank_name = excluded.bank_name,
        account_title = excluded.account_title, iban = excluded.iban, emergency_name = excluded.emergency_name, emergency_phone = excluded.emergency_phone, phone = excluded.phone, cnic = excluded.cnic, address = excluded.address, leaving_on = excluded.leaving_on, leaving_reason = excluded.leaving_reason, notes = excluded.notes, employed = excluded.employed, updated_at = excluded.updated_at`)
      .run({ user_id: u.id, dob: next.dob || null, contract: next.contract || 'full_time', joined_on: next.joined_on || null, probation_end: next.probation_end || null, notice_days: next.notice_days ?? null, bank_name: next.bank_name || null, account_title: next.account_title || null, iban: next.iban || null, emergency_name: next.emergency_name || null, emergency_phone: next.emergency_phone || null, phone: next.phone || null, cnic: next.cnic || null, address: next.address || null, leaving_on: next.leaving_on || null, leaving_reason: next.leaving_reason || null, notes: next.notes || null, employed: next.employed ?? null, updated_at: nowIso() });
    const changed = Object.keys(body).filter((k) => k !== 'notes');
    audit(user, 'hr.record', u.id, changed.join(', '));
    if ('leaving_on' in body && body.leaving_on && body.leaving_on !== cur.leaving_on) ctx.changes.log(u.id, user, { area: 'hr', title: 'Your last working day was recorded', lines: [`Last working day: ${T.human(next.leaving_on)}`], link: '#/pay' });
    if ('iban' in body && body.iban !== cur.iban) ctx.changes.log(u.id, user, { area: 'hr', title: 'Your bank details were changed', lines: [`Account ${mask(next.iban) || 'removed'}`], link: '#/pay' });
    emit('hr', u.id);
    return personOut(u, user, { full: true });
  }

  route('PUT', '/api/hr/people/:id/pay', ({ user, params, body }) => { needHR(user); return savePay(user, userOf(params.id), body); });
  const nextMonthStart = (day) => { const [y, m] = day.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };
  // "November 2026's pay (paid in December)": the month it's dated in, paid the month after
  const startLabel = (d) => { const m = (x) => new Date(`${x}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); return `${m(d.slice(0, 7) + '-01')}’s pay (paid in ${m(nextMonthStart(d)).split(' ')[0]})`; };
  function savePay(user, u, body) {
    need(u.id !== user.id || (user.role === 'owner' && !user.dev_owner) || P().rules().hr_own_pay, 403, 'Your own pay is changed by the owner');
    const cur = P().setupOf(u.id);
    const base = int(body.base ?? (cur && cur.base), 'base', 0, 100000000);
    const currency = body.currency || (cur && cur.currency) || 'PKR';
    need(['PKR', 'USD'].includes(currency), 400, 'currency must be PKR or USD');
    const tax = body.tax_mode || (cur && cur.tax_mode) || 'pk';
    need(['pk', 'none'].includes(tax), 400, 'tax_mode must be pk or none');
    const list = (v, k) => {
      if (v === undefined) return cur ? cur[k] : [];
      need(Array.isArray(v) && v.length <= 10, 400, `${k} must be a list`);
      return v.map((x) => ({ label: str(x.label, `${k}.label`, 60), amount: int(x.amount, `${k}.amount`, 0, 100000000), ...(k === 'allowances' ? { taxable: x.taxable !== false } : {}) }));
    };
    const allowances = list(body.allowances, 'allowances'), deductions = list(body.deductions, 'deductions');
    db.prepare(`INSERT INTO pay_setup (user_id, base, currency, tax_mode, allowances, deductions, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET base = excluded.base, currency = excluded.currency, tax_mode = excluded.tax_mode, allowances = excluded.allowances, deductions = excluded.deductions, updated_at = excluded.updated_at`)
      .run(u.id, base, currency, tax, JSON.stringify(allowances), JSON.stringify(deductions), nowIso());
    const fmt = (n, c) => P().fmtMoney(n, c);
    if (!cur || cur.base !== base || cur.currency !== currency) {
      db.prepare('INSERT INTO salary_history (user_id, base, currency, effective_from, note, by_id, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(u.id, base, currency, body.effective_from ? isoDate(body.effective_from, 'effective_from') : calc.companyToday(), optStr(body.note, 'note', 200) || (cur ? 'Changed' : 'Pay set'), user.id, nowIso());
      ctx.changes.log(u.id, user, { area: 'pay', title: cur ? 'Your pay was changed' : 'Your pay was set', lines: [cur ? `Base salary: ${fmt(cur.base, cur.currency)} → ${fmt(base, currency)} a month, from ${startLabel(body.effective_from ? isoDate(body.effective_from, 'effective_from') : calc.companyToday())}` : `Base salary: ${fmt(base, currency)} a month`], reason: optStr(body.note, 'note', 200), link: '#/pay' });
    }
    audit(user, 'hr.pay', u.id, `${fmt(base, currency)}${cur ? ` (was ${fmt(cur.base, cur.currency)})` : ''}, tax ${tax}`);
    emit('hr', u.id);
    return personOut(u, user, { full: true });
  }

  // ---- adding people from their contracts ----
  // The page reads each contract (text, or OCR for a scan) and HR checks what it found. This makes the
  // person (or updates the one it matched), with a first password to share, and their record and pay.
  const readable = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(14), (b) => A[b % A.length]).join(''); };
  // one person from a contract HR has checked. All of it is saved, or none of it: a bad IBAN does not
  // leave behind an account whose first password nobody saw.
  route('POST', '/api/hr/import', ({ user, body }) => {
    needHR(user);
    db.exec('BEGIN');
    try { const out = importOne(user, body); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
  });
  function importOne(user, body) {
    let u, password = null;
    if (body.existing_id) {
      u = userOf(body.existing_id);
      need(u.role !== 'owner', 400, 'The owner is not imported');
    } else {
      const email = str(body.email, 'email', 200).toLowerCase();
      need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'Enter a valid email address');
      need(!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email), 409, `${email} is already in use`);
      const name = str(body.name, 'name', 100);
      password = readable();
      const { salt, hash } = ctx.hashPassword(password);
      const id = Number(db.prepare('INSERT INTO users (email, name, role, pw_salt, pw_hash, title, tracks_time, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(email, name, 'employee', salt, hash, optStr(body.title, 'title', 100), 1, nowIso()).lastInsertRowid);
      u = userOf(id);
      audit(user, 'user.created', id, `${name} (from their contract)`);
      emit('users', id);
    }
    if (body.existing_id && body.title) db.prepare('UPDATE users SET title = ? WHERE id = ?').run(optStr(body.title, 'title', 100), u.id);
    const rec = body.record && typeof body.record === 'object' ? body.record : {};
    if (Object.keys(rec).length) saveRecord(user, u, rec);
    if (body.pay && body.pay.base) savePay(user, u, { ...body.pay, note: body.pay.note || 'From their contract' });
    return { id: u.id, name: u.name, email: u.email, created: !body.existing_id, password };
  }

  route('PUT', '/api/hr/people/:id/steps', ({ user, params, body }) => {
    needHR(user);
    const u = userOf(params.id);
    const flow = body.flow === 'leave' ? 'leave' : 'join';
    need(STEPS[flow].some(([k]) => k === body.step), 400, 'Unknown step');
    if (body.done) db.prepare('INSERT INTO hr_steps (user_id, flow, step, done_at, done_by) VALUES (?,?,?,?,?) ON CONFLICT(user_id, flow, step) DO UPDATE SET done_at = excluded.done_at, done_by = excluded.done_by').run(u.id, flow, body.step, nowIso(), user.id);
    else db.prepare('DELETE FROM hr_steps WHERE user_id = ? AND flow = ? AND step = ?').run(u.id, flow, body.step);
    audit(user, 'hr.step', u.id, `${flow}: ${body.step} ${body.done ? 'done' : 'not done'}`);
    emit('hr', u.id);
    return steps(u, flow);
  });

  // ---- documents ----
  const TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  function saveFile(dataB64, type) {
    need(TYPES[type], 400, 'Upload a PDF, PNG, JPG or WebP');
    const buf = Buffer.from(String(dataB64 || ''), 'base64');
    need(buf.length > 0 && buf.length <= 5 * 1024 * 1024, 400, 'Files can be up to 5 MB');
    const name = `${crypto.randomBytes(12).toString('hex')}.${TYPES[type]}`;
    fs.writeFileSync(path.join(hrDir, name), buf);
    return { file: name, size: buf.length };
  }
  const sendFile = (file, type, filename) => ({ raw: fs.readFileSync(path.join(hrDir, file)), type, headers: { 'Content-Disposition': `inline; filename="${filename.replace(/[^\w. -]/g, '_')}"`, 'Cache-Control': 'private, no-store' } });
  route('POST', '/api/hr/people/:id/docs', ({ user, params, body }) => {
    const u = userOf(params.id);
    ownOrHR(user, u.id);
    const kind = DOC_KINDS.includes(body.kind) ? body.kind : 'other';
    const status = isHR(user) && ['kept', 'signed', 'waiting'].includes(body.status) ? body.status : 'kept';
    const f = saveFile(body.data_base64, body.type);
    const id = Number(db.prepare('INSERT INTO hr_docs (user_id, name, kind, file, type, size, status, expires_on, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(u.id, str(body.name, 'name', 120), kind, f.file, body.type, f.size, status, body.expires_on ? isoDate(body.expires_on, 'expires_on') : null, user.id, nowIso()).lastInsertRowid);
    audit(user, 'hr.doc_added', u.id, `${body.name} (${kind})`);
    emit('hr', u.id);
    return { id };
  });
  route('PATCH', '/api/hr/docs/:id', ({ user, params, body }) => {
    needHR(user);
    const d = db.prepare('SELECT * FROM hr_docs WHERE id = ?').get(Number(params.id)); need(d, 404, 'Document not found');
    if ('status' in body) { need(['kept', 'signed', 'waiting'].includes(body.status), 400, 'status must be kept, signed or waiting'); db.prepare('UPDATE hr_docs SET status = ? WHERE id = ?').run(body.status, d.id); }
    if ('expires_on' in body) db.prepare('UPDATE hr_docs SET expires_on = ? WHERE id = ?').run(body.expires_on ? isoDate(body.expires_on, 'expires_on') : null, d.id);
    audit(user, 'hr.doc_changed', d.user_id, d.name);
    emit('hr', d.user_id);
    return { ok: true };
  });
  route('GET', '/api/hr/docs/:id', ({ user, params }) => {
    const d = db.prepare('SELECT * FROM hr_docs WHERE id = ?').get(Number(params.id)); need(d, 404, 'Document not found');
    ownOrHR(user, d.user_id);
    if (user.id !== d.user_id) audit(user, 'hr.doc_opened', d.user_id, d.name);
    return sendFile(d.file, d.type, `${d.name}.${TYPES[d.type]}`);
  });
  route('DELETE', '/api/hr/docs/:id', ({ user, params }) => {
    needHR(user);
    const d = db.prepare('SELECT * FROM hr_docs WHERE id = ?').get(Number(params.id)); need(d, 404, 'Document not found');
    db.prepare('DELETE FROM hr_docs WHERE id = ?').run(d.id);
    try { fs.unlinkSync(path.join(hrDir, d.file)); } catch { /* already gone */ }
    audit(user, 'hr.doc_removed', d.user_id, d.name);
    emit('hr', d.user_id);
    return { ok: true };
  });

  // ---- expense claims ----
  const expOut = (e) => ({ ...e, receipt: undefined, has_receipt: !!e.receipt, user_name: nameOf(e.user_id), manager_name: nameOf(e.manager_by), decided_name: nameOf(e.decided_by), limit: (P().rules().expense_limits || {})[e.category] ?? null });
  route('POST', '/api/expenses', ({ user, body }) => {
    const amount = int(body.amount, 'amount', 1, 10000000);
    need(CATS.includes(body.category), 400, `category must be one of ${CATS.join(', ')}`);
    const setup = P().setupOf(user.id);
    const f = body.receipt_base64 ? saveFile(body.receipt_base64, body.receipt_type) : null;
    const id = Number(db.prepare('INSERT INTO expenses (user_id, amount, currency, category, spent_on, note, receipt, receipt_type, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(user.id, amount, setup ? setup.currency : 'PKR', body.category, isoDate(body.spent_on, 'spent_on'), str(body.note, 'note', 300), f ? f.file : null, f ? body.receipt_type : null, 'pending', nowIso()).lastInsertRowid);
    const first = P().rules().managers_first ? ctx.managersOf(user.id).filter((m) => (db.prepare('SELECT role FROM users WHERE id = ?').get(m) || {}).role === 'manager') : [];
    const hr = db.prepare("SELECT id FROM users WHERE active = 1 AND (hr = 1 OR role = 'owner')").all().map((x) => x.id).filter((x) => x !== user.id);
    ctx.notify.notify(first.length ? first : hr, { kind: 'expense_request', title: `${user.name} sent an expense claim`, body: `${P().fmtMoney(amount, setup ? setup.currency : 'PKR')}: ${String(body.note).slice(0, 100)}`, link: '#/expenses', actor: user });
    audit(user, 'expense.sent', user.id, `${amount} ${body.category}`);
    emit('expenses', user.id);
    return { id };
  });
  route('GET', '/api/expenses', ({ user, query }) => {
    if (query.get('scope') === 'mine' || (!isHR(user) && !isManager(user))) return db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id).map(expOut);
    const rows = db.prepare('SELECT * FROM expenses ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'manager_ok\' THEN 1 ELSE 2 END, created_at DESC LIMIT 300').all();
    return rows.filter((e) => isHR(user) || (e.user_id !== user.id && canSee(user, e.user_id))).map(expOut);
  });
  route('GET', '/api/expenses/:id/receipt', ({ user, params }) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(params.id)); need(e && e.receipt, 404, 'No receipt');
    need(e.user_id === user.id || isHR(user) || (isManager(user) && canSee(user, e.user_id)), 403, 'Not allowed');
    return sendFile(e.receipt, e.receipt_type, `receipt-${e.id}.${TYPES[e.receipt_type]}`);
  });
  route('POST', '/api/expenses/:id/decide', ({ user, params, body }) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(params.id)); need(e, 404, 'Claim not found');
    need(e.user_id !== user.id || user.role === 'owner', 403, 'Someone else approves your own claims');
    const approve = !!body.approve;
    const reason = approve ? null : str(body.reason, 'reason', 300);
    if (isHR(user)) {
      need(['pending', 'manager_ok'].includes(e.status), 409, 'This claim has already been decided');
      db.prepare('UPDATE expenses SET status = ?, decided_by = ?, decided_at = ?, decline_reason = ? WHERE id = ?').run(approve ? 'approved' : 'declined', user.id, nowIso(), reason, e.id);
    } else {
      need(isManager(user) && canSee(user, e.user_id), 403, 'Not allowed');
      need(e.status === 'pending', 409, 'This claim has already been decided');
      db.prepare('UPDATE expenses SET status = ?, manager_by = ?, manager_at = ?, decline_reason = ? WHERE id = ?').run(approve ? 'manager_ok' : 'declined', user.id, nowIso(), reason, e.id);
      if (approve) {
        const hr = db.prepare("SELECT id FROM users WHERE active = 1 AND (hr = 1 OR role = 'owner')").all().map((x) => x.id).filter((x) => x !== user.id);
        ctx.notify.notify(hr, { kind: 'expense_request', title: `${user.name} approved ${nameOf(e.user_id)}'s expense`, body: `${P().fmtMoney(e.amount, e.currency)}: ${e.note.slice(0, 100)}. Waiting for HR`, link: '#/expenses', actor: user });
      }
    }
    const final = isHR(user) || !approve;
    ctx.notify.notify(e.user_id, { kind: 'expense_decision', title: approve ? (final ? 'Your expense claim was approved' : `${user.name} approved your expense claim`) : 'Your expense claim was declined', body: `${P().fmtMoney(e.amount, e.currency)}: ${e.note.slice(0, 80)}${approve ? (final ? '. It is paid with your next salary' : '. HR approves it next') : `. ${reason}`}`, link: '#/pay?tab=expenses', actor: user });
    audit(user, approve ? 'expense.approved' : 'expense.declined', e.user_id, `${e.amount} ${e.note.slice(0, 60)}`);
    emit('expenses', e.user_id);
    return expOut(db.prepare('SELECT * FROM expenses WHERE id = ?').get(e.id));
  });
  route('DELETE', '/api/expenses/:id', ({ user, params }) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(params.id)); need(e, 404, 'Claim not found');
    need(e.user_id === user.id && e.status === 'pending', 403, 'Only a claim still waiting can be taken back');
    db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
    if (e.receipt) { try { fs.unlinkSync(path.join(hrDir, e.receipt)); } catch { /* gone */ } }
    emit('expenses', user.id);
    return { ok: true };
  });

  // ---- advances ----
  const advOut = (a) => ({ ...a, user_name: nameOf(a.user_id), decided_name: nameOf(a.decided_by), installment: Math.ceil(a.amount / a.months), currency: (P().setupOf(a.user_id) || {}).currency || 'PKR' });
  route('POST', '/api/advances', ({ user, body }) => {
    const setup = P().setupOf(user.id);
    need(setup, 409, 'Your pay is not set up yet. Ask HR.');
    const amount = int(body.amount, 'amount', 1000, setup.base);
    const months = int(body.months, 'months', 1, 12);
    need(!db.prepare("SELECT id FROM advances WHERE user_id = ? AND status IN ('pending','approved')").get(user.id), 409, 'You already have an advance being paid back or waiting');
    const id = Number(db.prepare('INSERT INTO advances (user_id, amount, months, reason, status, created_at) VALUES (?,?,?,?,?,?)').run(user.id, amount, months, optStr(body.reason, 'reason', 300), 'pending', nowIso()).lastInsertRowid);
    const hr = db.prepare("SELECT id FROM users WHERE active = 1 AND (hr = 1 OR role = 'owner')").all().map((x) => x.id).filter((x) => x !== user.id);
    ctx.notify.notify(hr, { kind: 'advance_request', title: `${user.name} asked for an advance`, body: `${P().fmtMoney(amount, setup.currency)}, paid back over ${months} month${months === 1 ? '' : 's'}`, link: '#/expenses?tab=advances', actor: user });
    audit(user, 'advance.asked', user.id, `${amount} over ${months}`);
    emit('expenses', user.id);
    return advOut(db.prepare('SELECT * FROM advances WHERE id = ?').get(id));
  });
  route('GET', '/api/advances', ({ user, query }) => {
    if (query.get('scope') === 'mine' || !isHR(user)) return db.prepare('SELECT * FROM advances WHERE user_id = ? ORDER BY id DESC').all(user.id).map(advOut);
    return db.prepare("SELECT * FROM advances ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC LIMIT 200").all().map(advOut);
  });
  route('POST', '/api/advances/:id/decide', ({ user, params, body }) => {
    needHR(user);
    const a = db.prepare('SELECT * FROM advances WHERE id = ?').get(Number(params.id)); need(a, 404, 'Advance not found');
    need(a.status === 'pending', 409, 'Already decided');
    need(a.user_id !== user.id || user.role === 'owner', 403, 'Someone else decides your own advance');
    const approve = !!body.approve;
    const note = approve ? optStr(body.note, 'note', 300) : str(body.note, 'note', 300);
    db.prepare('UPDATE advances SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(approve ? 'approved' : 'declined', user.id, nowIso(), note, a.id);
    const cur = (P().setupOf(a.user_id) || {}).currency || 'PKR';
    ctx.notify.notify(a.user_id, { kind: 'advance_decision', title: approve ? 'Your advance was approved' : 'Your advance was declined', body: approve ? `${P().fmtMoney(a.amount, cur)}. ${P().fmtMoney(Math.ceil(a.amount / a.months), cur)} comes off each payslip from next month` : note, link: '#/pay', actor: user });
    audit(user, approve ? 'advance.approved' : 'advance.declined', a.user_id, `${a.amount} over ${a.months}`);
    emit('expenses', a.user_id);
    return advOut(db.prepare('SELECT * FROM advances WHERE id = ?').get(a.id));
  });

  // ---- what is waiting on HR ----
  route('GET', '/api/hr/overview', ({ user }) => {
    needHR(user);
    const today = calc.companyToday();
    const items = [];
    const run = db.prepare("SELECT * FROM pay_runs WHERE status IN ('draft','review','approved') ORDER BY period DESC LIMIT 1").get();
    const lastPaid = db.prepare("SELECT period FROM pay_runs WHERE status = 'paid' ORDER BY period DESC LIMIT 1").get();
    const prevMonth = (() => { const [y, m] = today.slice(0, 7).split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
    if (run) {
      const open = db.prepare('SELECT COUNT(*) n FROM pay_questions q JOIN payslips p ON p.id = q.payslip_id WHERE p.run_id = ? AND q.answer IS NULL').get(run.id).n;
      const payDay = ctx.payWindow ? ctx.payWindow(run.period).by : `${P().nextPeriod(run.period)}-10`;
      items.push({ kind: 'payroll', title: `${P().periodName(run.period)} payroll`, sub: run.status === 'draft' ? 'In draft: check it and send it for approval' : run.status === 'review' ? (open ? `${open === 1 ? '1 question' : open + ' questions'} to answer, then it can be approved` : 'Waiting for approval') : `Approved: pay everyone by ${T.human(payDay)} and mark each one paid`, due: payDay, link: '#/payroll', urgent: T.daysBetween(today, payDay) <= 3 });
    } else if (!lastPaid || lastPaid.period < prevMonth || today.slice(8) >= '20') {
      const period = today.slice(8) >= '20' ? today.slice(0, 7) : prevMonth;
      if (!db.prepare('SELECT id FROM pay_runs WHERE period = ?').get(period)) items.push({ kind: 'payroll', title: `Start ${P().periodName(period)} payroll`, sub: 'Staffwarden fills it in from hours, attendance and time off', link: '#/payroll', start: period });
    }
    const exp = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s, MIN(created_at) first FROM expenses WHERE status IN ('pending','manager_ok') AND user_id != ?").get(user.id);
    if (exp.n) items.push({ kind: 'expenses', title: `${exp.n === 1 ? '1 expense claim' : exp.n + ' expense claims'}`, sub: `${P().fmtMoney(exp.s, 'PKR')} waiting`, since: exp.first, link: '#/expenses' });
    for (const a of db.prepare("SELECT * FROM advances WHERE status = 'pending' AND user_id != ? ORDER BY id").all(user.id)) items.push({ kind: 'advance', title: `${nameOf(a.user_id)} asked for an advance`, sub: `${P().fmtMoney(a.amount, 'PKR')}, paid back over ${a.months} months`, since: a.created_at, link: '#/expenses?tab=advances', user_id: a.user_id });
    const people = db.prepare("SELECT * FROM users WHERE active = 1 AND role != 'owner' AND COALESCE((SELECT employed FROM hr_records WHERE user_id = users.id), CASE WHEN users.is_dev = 1 AND users.tracks_time = 0 THEN 0 ELSE 1 END) = 1 ORDER BY name").all();
    for (const u of people) {
      const rec = P().recordOf(u.id) || {};
      if (!P().setupOf(u.id)) items.push({ kind: 'no_pay', title: `${u.name} has no pay set`, sub: 'They are left off payroll until it is', link: `#/hr/person?id=${u.id}`, user_id: u.id });
      else if (!rec.iban) items.push({ kind: 'no_bank', title: `${u.name} has no bank details`, sub: 'Needed for the bank sheet', link: `#/hr/person?id=${u.id}`, user_id: u.id });
      const joinOpen = steps(u, 'join').filter((s) => !s.done && !['checkin', 'probation'].includes(s.key));
      const joined = P().localJoin(u, rec);
      if (joined && T.daysBetween(joined, today) <= 60 && joinOpen.length) items.push({ kind: 'joining', title: `${u.name} is still joining`, sub: `${joinOpen.length} step${joinOpen.length === 1 ? '' : 's'} left: ${joinOpen.slice(0, 2).map((s) => s.title.toLowerCase()).join(', ')}`, link: `#/hr/person?id=${u.id}&tab=joining`, user_id: u.id });
      if (rec.leaving_on && rec.leaving_on >= today) { const left = steps(u, 'leave').filter((s) => !s.done).length; items.push({ kind: 'leaving', title: `${u.name} leaves on ${T.human(rec.leaving_on)}`, sub: `${left} leaving step${left === 1 ? '' : 's'} left`, due: rec.leaving_on, link: `#/hr/person?id=${u.id}&tab=leaving`, user_id: u.id }); }
    }
    const lv = db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE status = 'pending'").get().n;
    if (lv) items.push({ kind: 'timeoff', title: `${lv === 1 ? '1 time off request' : lv + ' time off requests'} waiting`, sub: 'You can decide them, or nudge the manager', link: '#/timeoff' });

    // coming up in the next 90 days
    const soon = [];
    const within = (d) => d && d >= today && T.daysBetween(today, d) <= 90;
    if (run && ctx.payWindow) soon.push({ day: ctx.payWindow(run.period).by, title: 'Last pay day', sub: `${P().periodName(run.period)} pay is sent by then` });
    for (const u of people) {
      const rec = P().recordOf(u.id) || {};
      if (within(rec.leaving_on)) soon.push({ day: rec.leaving_on, title: `${u.name}’s last day`, sub: 'Their settlement goes on that month’s payroll', user_id: u.id });
      if (within(rec.probation_end)) soon.push({ day: rec.probation_end, title: `${u.name}’s probation review`, sub: 'Probation ends', user_id: u.id });
      const j = P().localJoin(u, rec);
      if (j) { const years = Number(today.slice(0, 4)) - Number(j.slice(0, 4)); for (const y of [years, years + 1]) { const d = `${Number(j.slice(0, 4)) + y}${j.slice(4)}`; if (y > 0 && within(d)) soon.push({ day: d, title: `${u.name}, ${y} year${y === 1 ? '' : 's'}`, sub: 'Work anniversary', user_id: u.id }); } }
    }
    for (const d of db.prepare('SELECT d.name AS doc, d.expires_on, d.user_id, u.name AS person FROM hr_docs d JOIN users u ON u.id = d.user_id WHERE d.expires_on IS NOT NULL AND u.active = 1').all()) if (within(d.expires_on)) soon.push({ day: d.expires_on, title: `${d.person}’s ${d.doc} expires`, sub: 'Ask for the new one', user_id: d.user_id });
    soon.sort((a, b) => a.day.localeCompare(b.day));
    const stats = {
      people: people.length, monthly: db.prepare("SELECT COUNT(*) n FROM pay_setup p JOIN users u ON u.id = p.user_id WHERE u.active = 1").get().n,
      probation: people.filter((u) => { const r = P().recordOf(u.id); return r && (r.contract === 'probation' || (r.probation_end && r.probation_end >= today)); }).map((u) => u.name),
      joined_year: people.filter((u) => (P().localJoin(u, P().recordOf(u.id)) || '').startsWith(today.slice(0, 4))).length,
      joined_month: people.filter((u) => (P().localJoin(u, P().recordOf(u.id)) || '').startsWith(today.slice(0, 7))).length,
      leaving: people.filter((u) => { const r = P().recordOf(u.id); return r && r.leaving_on && r.leaving_on >= today; }).map((u) => u.name),
    };
    return { items, soon: soon.slice(0, 8), stats, today };
  });

  ctx.hrSteps = steps;
  ctx.HR = { CONTRACTS, DOC_KINDS, CATS, STEPS };
};
