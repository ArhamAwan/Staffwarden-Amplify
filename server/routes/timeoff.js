'use strict';
const { need, int, optStr } = require('../lib/http');

// paid or unpaid; the older kinds (vacation, sick, personal, other) still read as paid
const KINDS = ['paid', 'unpaid', 'vacation', 'sick', 'personal', 'other'];

module.exports = (ctx) => {
  const { db, route, calc, emit, audit, nowIso, canSee, isManager, isHR, needManager, needOwner, visibleUsers, targetUser, T, clockNow } = ctx;
  // HR sees and decides everyone's time off, like the owner
  const everyone = () => db.prepare('SELECT * FROM users ORDER BY name').all();

  function out(r) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
    const wd = calc.workDaySet(u);
    const hol = new Set(db.prepare('SELECT day FROM holidays WHERE day >= ? AND day <= ?').all(r.start_day, r.end_day).map((h) => h.day));
    const days = T.eachDay(r.start_day, r.end_day).filter((d) => wd.has(T.dow(d)) && !hol.has(d)).length;
    const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null : null);
    const decider = nameOf(r.decided_by);
    return { id: r.id, user_id: r.user_id, user_name: u.name, kind: r.kind, paid: r.kind !== 'unpaid', start_day: r.start_day, end_day: r.end_day, working_days: days, note: r.note, status: r.status, decided_by: decider, decided_at: r.decided_at, decision_note: r.decision_note, created_at: r.created_at,
      emergency: !!r.emergency, sandwich_days: r.sandwich ? r.sandwich.split(',') : [],
      cancelled_by: nameOf(r.cancelled_by), cancelled_by_id: r.cancelled_by || null, cancelled_at: r.cancelled_at || null, cancel_note: r.cancel_note || null };
  }

  route('GET', '/api/timeoff', ({ user, query }) => {
    const status = query.get('status');
    const from = query.get('from'), to = query.get('to');
    let users = isHR(user) && !isManager(user) ? everyone() : isManager(user) ? visibleUsers(user, { includeInactive: true }) : [user];
    if (query.get('user_id') && query.get('user_id') !== 'all') users = isHR(user) ? users.filter((u) => u.id === Number(query.get('user_id'))) : [targetUser(user, query.get('user_id'))];
    if (!users.length) return [];
    const where = [`user_id IN (${users.map(() => '?').join(',')})`], args = users.map((u) => u.id);
    if (status) { where.push('status = ?'); args.push(status); }
    if (T.isDay(from)) { where.push('end_day >= ?'); args.push(from); }
    if (T.isDay(to)) { where.push('start_day <= ?'); args.push(to); }
    return db.prepare(`SELECT * FROM leave_requests WHERE ${where.join(' AND ')} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, start_day DESC LIMIT 500`).all(...args).map(out);
  });

  // ---- the company's rules: paid days a month (no carrying over), unpaid as needed, and no leave next to
  // a weekend or holiday unless it is an emergency. Only the owner (the CEO) approves. ----
  const perMonth = () => Math.max(0, Number(ctx.cfg.paidLeavePerMonth ?? 1));
  const owners = () => db.prepare("SELECT id, name FROM users WHERE active = 1 AND role = 'owner'").all();
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = (m) => MON[Number(m.slice(5, 7)) - 1];
  function whoFor(user, id) {
    if (id == null || Number(id) === user.id) return user;
    if (isHR(user) && !isManager(user)) return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || need(false, 404, 'User not found');
    return targetUser(user, id);
  }
  // what a request would mean, before it is sent: the days, the paid days left each month, the days next to a weekend
  function weigh(target, body, exceptId = null) {
    need(T.isDay(body.start_day) && T.isDay(body.end_day), 400, 'Choose a start and an end date');
    need(body.start_day <= body.end_day, 400, 'The end date cannot be before the start date');
    need(T.daysBetween(body.start_day, body.end_day) < 60, 400, 'Time off can be at most 60 days at once');
    const kind = KINDS.includes(body.kind) ? body.kind : 'paid';
    const paid = kind !== 'unpaid';
    const days = calc.leaveWorkDays(target, body.start_day, body.end_day);
    const months = [...new Set(days.map((d) => d.slice(0, 7)))].map((m) => {
      const used = calc.paidLeaveUsed(target, m, { pending: true, except: exceptId });
      return { month: m, name: monthName(m), allowance: perMonth(), used, left: Math.max(0, perMonth() - used), asked: days.filter((d) => d.startsWith(m)).length };
    });
    const over = paid ? months.filter((m) => m.asked > m.left) : [];
    const sandwich = ctx.cfg.noSandwichLeave === false ? [] : calc.sandwichDays(target, body.start_day, body.end_day);
    return { kind, paid, days, working_days: days.length, months, over, sandwich_days: sandwich, needs_emergency: sandwich.length > 0, allowance: perMonth() };
  }
  const paidTooMany = (w) => {
    const m = w.over[0];
    if (!m.left) return `${plural(m.allowance, 'paid day')} a month, and ${m.name}’s ${m.allowance === 1 ? 'is' : 'are'} already used or asked for. Ask for these days as unpaid.`;
    return `Only ${plural(m.left, 'paid day')} left in ${m.name}. Ask for ${m.left === 1 ? 'one day' : `${m.left} days`} as paid and the rest as unpaid.`;
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  route('POST', '/api/timeoff/check', ({ user, body }) => {
    const target = whoFor(user, body.user_id);
    const w = weigh(target, body);
    return { ...w, problem: !w.working_days ? 'Those dates are all weekends or holidays.' : w.over.length ? paidTooMany(w) : null };
  });

  route('POST', '/api/timeoff', ({ user, body }) => {
    const target = whoFor(user, body.user_id);
    const w = weigh(target, body);
    need(w.working_days > 0, 400, 'Those dates are all weekends or holidays, so there is nothing to take off');
    const clash = db.prepare("SELECT 1 FROM leave_requests WHERE user_id = ? AND status IN ('pending','approved') AND start_day <= ? AND end_day >= ?").get(target.id, body.end_day, body.start_day);
    need(!clash, 409, 'There is already a time-off request for some of those days');
    need(!w.over.length, 409, w.over.length ? paidTooMany(w) : '');
    const note = optStr(body.note, 'note', 500);
    need(note && note.trim().length >= 3, 400, 'Give a reason for the time off');
    const emergency = !!body.emergency && w.needs_emergency;
    if (w.needs_emergency) {
      need(!!body.emergency, 409, `Time off next to a weekend or a holiday (${w.sandwich_days.map((d) => T.human(d)).join(', ')}) isn’t allowed unless it’s an emergency. If it is, say so and tell us what happened.`);
      need(note && note.trim().length >= 8, 400, 'Tell us what the emergency is, in a few words');
    }
    // Only the owner approves. The owner's own time off, or time off the owner records, needs no approval.
    const auto = user.role === 'owner';
    const id = Number(db.prepare(`INSERT INTO leave_requests (user_id, kind, start_day, end_day, note, status, decided_by, decided_at, created_at, emergency, sandwich)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(target.id, w.kind, body.start_day, body.end_day, note, auto ? 'approved' : 'pending', auto ? user.id : null, auto ? nowIso() : null, nowIso(), emergency ? 1 : 0, w.sandwich_days.length ? w.sandwich_days.join(',') : null).lastInsertRowid);
    audit(user, auto ? 'timeoff.recorded' : 'timeoff.requested', target.id, `${w.kind} ${body.start_day} to ${body.end_day}${emergency ? ' (emergency)' : ''}`);
    const span = body.start_day === body.end_day ? T.human(body.start_day) : `${T.human(body.start_day)} to ${T.human(body.end_day)}`;
    const what = `${w.paid ? 'Paid' : 'Unpaid'}, ${span}${emergency ? '. Emergency' : ''}${note ? `: ${String(note).slice(0, 120)}` : ''}`;
    if (!auto) ctx.notify.notify(owners().map((o) => o.id).filter((id2) => id2 !== target.id), { kind: 'timeoff_request', title: target.id === user.id ? `${target.name} asked for time off` : `${user.name} asked for time off for ${target.name}`, body: what, link: '#/timeoff', actor: user });
    else if (target.id !== user.id) ctx.notify.notify(target.id, { kind: 'timeoff_decision', title: `${user.name} recorded time off for you`, body: what, link: '#/timeoff', actor: user });
    emit('timeoff', target.id);
    return out(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id));
  });

  route('POST', '/api/timeoff/:id/decision', ({ user, params, body }) => {
    need(user.role === 'owner', 403, `Only ${(owners()[0] || {}).name || 'the CEO'} approves time off`);
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(params.id));
    need(r, 404, 'Request not found');
    need(r.status === 'pending', 409, 'That request has already been decided');
    const approve = !!body.approve;
    if (approve && r.kind !== 'unpaid') {
      const w = weigh(db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id), { start_day: r.start_day, end_day: r.end_day, kind: r.kind }, r.id);
      need(!w.over.length, 409, w.over.length ? `${w.over[0].name}’s paid ${w.allowance === 1 ? 'day is' : 'days are'} already used. Decline this one, or ask for it as unpaid.` : '');
    }
    db.prepare('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
      .run(approve ? 'approved' : 'denied', user.id, nowIso(), optStr(body.note, 'note', 500), r.id);
    audit(user, approve ? 'timeoff.approved' : 'timeoff.denied', r.user_id, `${r.kind} ${r.start_day} to ${r.end_day}`);
    ctx.notify.notify(r.user_id, { kind: 'timeoff_decision', title: `${user.name} ${approve ? 'approved' : 'declined'} your time off`, body: `${r.start_day === r.end_day ? T.human(r.start_day) : `${T.human(r.start_day)} to ${T.human(r.end_day)}`}${body.note ? `: ${String(body.note).slice(0, 160)}` : ''}`, link: '#/timeoff', actor: user });
    emit('timeoff', r.user_id);
    return out(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id));
  });

  // Cancelling: the person can take back their own request while it waits, or approved time off before it
  // starts. The CEO can cancel anyone's, with a reason the person sees. Nobody else can.
  route('DELETE', '/api/timeoff/:id', ({ user, params, query }) => {
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(params.id));
    need(r && (r.user_id === user.id || canSee(user, r.user_id) || isHR(user)), 404, 'Request not found');
    need(['pending', 'approved'].includes(r.status), 409, 'That request is already closed');
    const own = r.user_id === user.id, ceo = user.role === 'owner';
    need(own || ceo, 403, `Only ${(owners()[0] || {}).name || 'the CEO'} can cancel someone else’s time off`);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
    if (own && !ceo) need(r.status === 'pending' || r.start_day > T.localDay(clockNow(), calc.dayTz(target)), 403, `This time off has already started. Ask ${(owners()[0] || {}).name || 'the CEO'} to change it`);
    const reason = optStr(query.get('reason'), 'reason', 500);
    if (!own) need(reason && reason.trim().length >= 3, 400, 'Give a reason; they see it');
    db.prepare("UPDATE leave_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_note = ? WHERE id = ?").run(user.id, nowIso(), reason, r.id);
    audit(user, 'timeoff.cancelled', r.user_id, `${r.kind} ${r.start_day} to ${r.end_day}${reason ? `: ${reason}` : ''}`);
    const span = r.start_day === r.end_day ? T.human(r.start_day) : `${T.human(r.start_day)} to ${T.human(r.end_day)}`;
    if (!own) ctx.notify.notify(r.user_id, { kind: 'timeoff_decision', title: `${user.name} cancelled your time off`, body: `${span}: ${String(reason).slice(0, 160)}`, link: '#/timeoff', actor: user });
    else if (r.status === 'approved') ctx.notify.notify(owners().map((o) => o.id).filter((x) => x !== user.id), { kind: 'timeoff_request', title: `${user.name} cancelled approved time off`, body: `${span}. They’ll be working those days`, link: '#/timeoff', actor: user });
    emit('timeoff', r.user_id);
    return { ok: true };
  });

  // this month's paid days for each person (they don't carry over), and the unpaid days taken
  route('GET', '/api/timeoff/balances', ({ user, query }) => {
    const month = /^\d{4}-\d\d$/.test(query.get('month') || '') ? query.get('month') : T.localDay(clockNow(), ctx.calc.companyTz()).slice(0, 7);
    const users = isHR(user) && !isManager(user) ? everyone().filter((u) => u.active && u.tracks_time) : isManager(user) ? visibleUsers(user, { tracking: true }) : [user];
    const first = `${month}-01`, last = `${month}-${String(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
    return users.map((u) => {
      const used = calc.paidLeaveUsed(u, month), asked = calc.paidLeaveUsed(u, month, { pending: true }) - used;
      const unpaid = db.prepare("SELECT start_day, end_day FROM leave_requests WHERE user_id = ? AND kind = 'unpaid' AND status = 'approved' AND end_day >= ? AND start_day <= ?").all(u.id, first, last)
        .reduce((n, r) => n + calc.leaveWorkDays(u, r.start_day < first ? first : r.start_day, r.end_day > last ? last : r.end_day).length, 0);
      return { user_id: u.id, name: u.name, month, allowance: perMonth(), taken: used, asked, left: Math.max(0, perMonth() - used - asked), unpaid,
        pending: db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE user_id = ? AND status = 'pending'").get(u.id).n };
    });
  });

  // ---- company holidays ----
  route('GET', '/api/holidays', ({ query }) => {
    const year = query.get('year');
    return db.prepare(`SELECT day, name FROM holidays ${year ? 'WHERE day LIKE ?' : ''} ORDER BY day`).all(...(year ? [`${year}-%`] : []));
  });
  route('POST', '/api/holidays', ({ user, body }) => {
    needOwner(user);
    need(T.isDay(body.day), 400, 'Choose a date');
    const name = optStr(body.name, 'name', 100);
    need(name, 400, 'Give the holiday a name');
    db.prepare('INSERT INTO holidays (day, name) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET name = excluded.name').run(body.day, name);
    audit(user, 'holiday.saved', null, `${body.day} ${name}`);
    emit('timeoff');
    return { ok: true };
  });
  route('DELETE', '/api/holidays/:day', ({ user, params }) => {
    needOwner(user);
    db.prepare('DELETE FROM holidays WHERE day = ?').run(params.day);
    audit(user, 'holiday.removed', null, params.day);
    emit('timeoff');
    return { ok: true };
  });
};
