'use strict';
const { need, int, optStr } = require('../lib/http');

const KINDS = ['vacation', 'sick', 'personal', 'unpaid', 'other'];

module.exports = (ctx) => {
  const { db, route, calc, emit, audit, nowIso, canSee, isManager, isHR, needManager, needOwner, visibleUsers, targetUser, T, clockNow } = ctx;
  // HR sees and decides everyone's time off, like the owner
  const everyone = () => db.prepare('SELECT * FROM users ORDER BY name').all();

  function out(r) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
    const wd = calc.workDaySet(u);
    const hol = new Set(db.prepare('SELECT day FROM holidays WHERE day >= ? AND day <= ?').all(r.start_day, r.end_day).map((h) => h.day));
    const days = T.eachDay(r.start_day, r.end_day).filter((d) => wd.has(T.dow(d)) && !hol.has(d)).length;
    const decider = r.decided_by ? (db.prepare('SELECT name FROM users WHERE id = ?').get(r.decided_by) || {}).name : null;
    return { id: r.id, user_id: r.user_id, user_name: u.name, kind: r.kind, start_day: r.start_day, end_day: r.end_day, working_days: days, note: r.note, status: r.status, decided_by: decider, decided_at: r.decided_at, decision_note: r.decision_note, created_at: r.created_at };
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

  route('POST', '/api/timeoff', ({ user, body }) => {
    const target = body.user_id != null && Number(body.user_id) !== user.id ? (isHR(user) && !isManager(user) ? (db.prepare('SELECT * FROM users WHERE id = ?').get(Number(body.user_id)) || need(false, 404, 'User not found')) : targetUser(user, body.user_id)) : user;
    const kind = KINDS.includes(body.kind) ? body.kind : 'vacation';
    need(T.isDay(body.start_day) && T.isDay(body.end_day), 400, 'Choose a start and an end date');
    need(body.start_day <= body.end_day, 400, 'The end date cannot be before the start date');
    need(T.daysBetween(body.start_day, body.end_day) < 60, 400, 'Time off can be at most 60 days at once');
    const clash = db.prepare("SELECT 1 FROM leave_requests WHERE user_id = ? AND status IN ('pending','approved') AND start_day <= ? AND end_day >= ?").get(target.id, body.end_day, body.start_day);
    need(!clash, 409, 'There is already a time-off request for some of those days');
    // A manager recording time off for someone else, or the owner for themselves, needs no approval.
    const auto = (target.id !== user.id && (isManager(user) || isHR(user))) || user.role === 'owner';
    const id = Number(db.prepare(`INSERT INTO leave_requests (user_id, kind, start_day, end_day, note, status, decided_by, decided_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(target.id, kind, body.start_day, body.end_day, optStr(body.note, 'note', 500), auto ? 'approved' : 'pending', auto ? user.id : null, auto ? nowIso() : null, nowIso()).lastInsertRowid);
    audit(user, auto ? 'timeoff.recorded' : 'timeoff.requested', target.id, `${kind} ${body.start_day} to ${body.end_day}`);
    const span = body.start_day === body.end_day ? T.human(body.start_day) : `${T.human(body.start_day)} to ${T.human(body.end_day)}`;
    if (!auto) ctx.notify.notify(ctx.managersOf(target.id), { kind: 'timeoff_request', title: `${target.name} asked for time off`, body: `${kind[0].toUpperCase() + kind.slice(1)}, ${span}${body.note ? `: ${String(body.note).slice(0, 120)}` : ''}`, link: '#/timeoff', actor: user });
    else if (target.id !== user.id) ctx.notify.notify(target.id, { kind: 'timeoff_decision', title: `${user.name} recorded time off for you`, body: `${kind[0].toUpperCase() + kind.slice(1)}, ${span}`, link: '#/timeoff', actor: user });
    emit('timeoff', target.id);
    return out(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id));
  });

  route('POST', '/api/timeoff/:id/decision', ({ user, params, body }) => {
    need(isManager(user) || isHR(user), 403, 'Not allowed');
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(params.id));
    need(r && (canSee(user, r.user_id) || isHR(user)), 404, 'Request not found');
    need(r.status === 'pending', 409, 'That request has already been decided');
    need(r.user_id !== user.id || user.role === 'owner', 403, 'You cannot approve your own request');
    const approve = !!body.approve;
    db.prepare('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
      .run(approve ? 'approved' : 'denied', user.id, nowIso(), optStr(body.note, 'note', 500), r.id);
    audit(user, approve ? 'timeoff.approved' : 'timeoff.denied', r.user_id, `${r.kind} ${r.start_day} to ${r.end_day}`);
    ctx.notify.notify(r.user_id, { kind: 'timeoff_decision', title: `${user.name} ${approve ? 'approved' : 'declined'} your time off`, body: `${r.start_day === r.end_day ? T.human(r.start_day) : `${T.human(r.start_day)} to ${T.human(r.end_day)}`}${body.note ? `: ${String(body.note).slice(0, 160)}` : ''}`, link: '#/timeoff', actor: user });
    emit('timeoff', r.user_id);
    return out(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id));
  });

  route('DELETE', '/api/timeoff/:id', ({ user, params }) => {
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(params.id));
    need(r && (r.user_id === user.id || canSee(user, r.user_id)), 404, 'Request not found');
    need(['pending', 'approved'].includes(r.status), 409, 'That request is already closed');
    if (r.user_id === user.id && !isManager(user)) need(r.status === 'pending' || r.start_day > T.localDay(clockNow(), calc.dayTz(user)), 403, 'Ask your manager to cancel time off that has already started');
    db.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
    audit(user, 'timeoff.cancelled', r.user_id, `${r.kind} ${r.start_day} to ${r.end_day}`);
    emit('timeoff', r.user_id);
    return { ok: true };
  });

  route('GET', '/api/timeoff/balances', ({ user, query }) => {
    const year = (query.get('year') || T.localDay(clockNow(), ctx.calc.companyTz()).slice(0, 4));
    const users = isHR(user) && !isManager(user) ? everyone().filter((u) => u.active && u.tracks_time) : isManager(user) ? visibleUsers(user, { tracking: true }) : [user];
    return users.map((u) => {
      const taken = calc.approvedLeaveDays(u, year);
      return { user_id: u.id, name: u.name, allowance: ctx.cfg.leaveDaysPerYear, taken, left: Math.max(0, ctx.cfg.leaveDaysPerYear - taken), pending: db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE user_id = ? AND status = 'pending'").get(u.id).n };
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
