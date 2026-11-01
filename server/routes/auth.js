'use strict';
const { HttpError, need, str } = require('../lib/http');

module.exports = (ctx) => {
  const { db, cfg, route, clockNow, nowIso, emit, audit, publicUser, hashPassword, verifyPassword, newToken, tokenHash, verifyNobody, passwordProblem, clientIp, PAUSE_REASONS, T } = ctx;
  const bearer = (req) => (req.headers.authorization || '').slice(7);

  // Failed sign-ins are limited per address and email (10 in 15 minutes) and per address overall (30),
  // so guessing is slow. Someone else's wrong guesses from another address never lock a person out.
  const WINDOW = 15 * 60000;
  const fails = new Map(); // key -> { n, resetAt }
  const count = (key) => { const a = fails.get(key); return a && a.resetAt > clockNow() ? a.n : 0; };
  const bump = (key) => { let a = fails.get(key); if (!a || a.resetAt <= clockNow()) { a = { n: 0, resetAt: clockNow() + WINDOW }; fails.set(key, a); } a.n++; };
  setInterval(() => { for (const [k, a] of fails) if (a.resetAt <= clockNow()) fails.delete(k); }, 10 * 60000).unref();

  route('POST', '/api/auth/login', ({ req, body }) => {
    const email = str(body.email, 'email', 200).trim().toLowerCase();
    const ip = clientIp(req);
    need(count(`ip|${ip}`) < 30 && count(`pair|${ip}|${email}`) < 10, 429, 'Too many failed attempts. Try again in 15 minutes.');
    const password = str(body.password, 'password', 200);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // not a member of staff: maybe someone from a client, signing in to their portal
    const cu = u ? null : db.prepare('SELECT cu.*, cl.name AS client_name, cl.archived AS client_archived FROM client_users cu JOIN clients cl ON cl.id = cu.client_id WHERE cu.email = ?').get(email);
    if (cu) {
      if (!verifyPassword(password, cu.pw_salt, cu.pw_hash)) {
        bump(`ip|${ip}`); bump(`pair|${ip}|${email}`);
        audit(null, 'client.login_failed', null, `${email} from ${ip}`);
        throw new HttpError(401, 'Invalid email or password');
      }
      need(cu.active && !cu.client_archived, 403, 'This account has been turned off. Ask your contact at the agency.');
      fails.delete(`pair|${ip}|${email}`);
      const token = newToken();
      db.prepare("INSERT INTO client_sessions (token, client_user_id, last_used_at) VALUES (?, ?, datetime('now'))").run(tokenHash(token), cu.id);
      if (!cu.joined_at) db.prepare('UPDATE client_users SET joined_at = ? WHERE id = ?').run(ctx.nowIso(), cu.id);
      db.prepare('UPDATE client_users SET last_seen_at = ? WHERE id = ?').run(ctx.nowIso(), cu.id);
      audit(null, 'client.login', null, `${cu.name} (${cu.client_name}) from ${ip}`);
      return { token, user: ctx.publicClient(cu) };
    }
    const good = u ? verifyPassword(password, u.pw_salt, u.pw_hash) : verifyNobody(password);
    if (!good) {
      bump(`ip|${ip}`); bump(`pair|${ip}|${email}`);
      audit(null, 'login.failed', u ? u.id : null, `${email} from ${ip}`);
      throw new HttpError(401, 'Invalid email or password');
    }
    need(u.active, 403, 'This account has been deactivated. Ask your manager.');
    fails.delete(`pair|${ip}|${email}`);
    const token = newToken();
    db.prepare("INSERT INTO sessions (token, user_id, last_used_at) VALUES (?, ?, datetime('now'))").run(tokenHash(token), u.id);
    audit(u, 'login', u.id, `from ${ip}`);
    return { token, user: publicUser(u) };
  });

  route('POST', '/api/auth/logout', ({ req, user }) => {
    db.prepare(user && user.kind === 'client' ? 'DELETE FROM client_sessions WHERE token = ?' : 'DELETE FROM sessions WHERE token = ?').run(tokenHash(bearer(req)));
    return { ok: true };
  }, { client: true });

  // Sign out on every device (a lost laptop, a shared computer).
  route('POST', '/api/auth/logout-all', ({ user, req, body }) => {
    const keep = body && body.keep_this ? tokenHash(bearer(req)) : '';
    const n = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, keep).changes;
    audit(user, 'logout.all', user.id, `${n} session${n === 1 ? '' : 's'} ended`);
    return { ok: true, ended: n };
  });
  route('GET', '/api/me/sessions', ({ user, req }) => {
    const mine = tokenHash(bearer(req));
    return db.prepare('SELECT token, created_at, last_used_at FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC').all(user.id)
      .map((s) => ({ this_device: s.token === mine, created_at: s.created_at, last_used_at: s.last_used_at }));
  });

  route('GET', '/api/me', ({ user }) => (user.kind === 'client' ? ctx.publicClient(user) : publicUser(user)), { client: true });
  // installers for the desktop app (public, so the sign-in page can offer them)
  route('GET', '/api/downloads', () => ctx.listDownloads());
  route('GET', '/api/app/latest', ({ query }) => ctx.latestApp(query.get('platform'), query.get('arch')));

  route('GET', '/api/settings', ({ user }) => (user.kind === 'client' ? { org_name: cfg.orgName, tz_name: cfg.tzName || null, tz_offset_min: ctx.calc.companyTz() } : {
    org_name: cfg.orgName,
    idle_tell_lead: (() => { try { return !!JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'idle_rules'").get() || {}).value || '{}').tell_lead; } catch { return false; } })(),
    owner_name: (db.prepare("SELECT name FROM users WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1").get() || {}).name || null,
    shots_per_10: cfg.shotsPer10,
    capture_interval_min: 10,   // activity is counted in 10-minute blocks; kept for older desktop apps
    shots_per_interval: 1,
    idle_limit_min: cfg.idleLimitMin,
    retention_days: cfg.retentionDays,
    tz_offset_min: ctx.calc.companyTz(),
    tz_name: cfg.tzName || null,
    day_start_min: T.dayStartMin(cfg.shiftStart, cfg.shiftEnd),
    shift_start: cfg.shiftStart,
    shift_end: cfg.shiftEnd,
    break_start: cfg.breakStart || null,
    break_end: cfg.breakEnd || null,
    grace_min: cfg.graceMin,
    work_days: cfg.workDays,
    weekly_target_min: cfg.weeklyTargetMin,
    leave_days_per_year: cfg.leaveDaysPerYear,
    no_signal_min: cfg.noSignalMin,
    stale_min: cfg.staleMin,
    employees_can_delete_shots: !!cfg.employeesCanDeleteShots,
    capture_screens: cfg.captureScreens === 'all' ? 'all' : 'active',
    blur_shots: !!cfg.blurShots,
    blackout_apps: cfg.blackoutApps,
    blackout_categories: { banking: true, social: true },   // always hidden
    blackout_full_front: false,
    app_tracking: false,        // which apps and sites are used is not tracked
    task_review_required: cfg.taskReviewRequired !== false,
    team_visibility: ['everyone', 'team', 'off'].includes(cfg.teamVisibility) ? cfg.teamVisibility : 'everyone',
    require_latest_app: cfg.requireLatestApp !== false,
    pause_reasons: PAUSE_REASONS,
  }), { client: true });

  route('GET', '/api/events', () => ({ sse: true }), { client: true });

  route('POST', '/api/me/consent', ({ user }) => {
    db.prepare('UPDATE users SET consented_at = ?, consent_version = ? WHERE id = ?').run(nowIso(), ctx.POLICY_VERSION, user.id);
    ctx.changes.acceptTerms(user);
    audit(user, 'policy.accepted', user.id);
    emit('users', user.id);
    return { ok: true };
  });

  route('POST', '/api/me/password', ({ user, body, req }) => {
    need(verifyPassword(str(body.current_password, 'current_password', 200), user.pw_salt, user.pw_hash), 403, 'Your current password is not correct');
    const next = str(body.new_password, 'new_password', 200);
    const bad = passwordProblem(next, user);
    need(!bad, 400, bad);
    need(next !== body.current_password, 400, 'Choose a password different from the current one');
    const { salt, hash } = hashPassword(next);
    if (user.kind === 'client') {
      db.prepare('UPDATE client_users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, user.id);
      db.prepare('DELETE FROM client_sessions WHERE client_user_id = ? AND token != ?').run(user.id, tokenHash(bearer(req)));
      return { ok: true };
    }
    db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, user.id);
    // sign out every other device
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, tokenHash(bearer(req)));
    audit(user, 'password.changed', user.id);
    return { ok: true };
  }, { client: true });
};
