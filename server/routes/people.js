'use strict';
const { need, str, optStr, int } = require('../lib/http');

module.exports = (ctx) => {
  const { db, cfg, route, calc, emit, audit, isManager, needManager, needOwner, canSee, visibleUsers, targetUser, managedTeamIds, hashPassword, T } = ctx;

  const teamName = (id) => (id ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(id) || {}).name || null : null);

  function userOut(u, viewer) {
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, title: u.title || null, team_id: u.team_id || null, team: teamName(u.team_id),
      active: !!u.active, hr: !!u.hr, is_dev: !!u.is_dev, tracks_time: !!u.tracks_time, consented: !!u.consented_at && (u.consent_version || 1) >= ctx.POLICY_VERSION,
      tz_offset_min: u.tz_offset_min, tz_name: u.tz_name || null, seen_tz: u.seen_tz || null, shift_start: u.shift_start, shift_end: u.shift_end, break_start: u.break_start || null, break_end: u.break_end || null, work_days: u.work_days, weekly_target_min: u.weekly_target_min,
      shots_per_10: u.shots_per_10 ?? null, other_device: !!u.other_device, day_hours: calc.dayHours(u),
      fun_mode: viewer && viewer.role === 'owner' && u.fun_mode && (!u.fun_until || Date.parse(u.fun_until) > ctx.now()) ? u.fun_mode : null,
      effective: { tz_offset_min: calc.userTz(u), tz_name: calc.zoneOf(u), shift_start: u.shift_start || cfg.shiftStart, shift_end: u.shift_end || cfg.shiftEnd, break_start: u.break_start || cfg.breakStart || null, break_end: u.break_end || cfg.breakEnd || null, day_start_min: calc.dayStart(u), work_days: u.work_days || cfg.workDays, weekly_target_min: calc.weeklyTargetMin(u), shots_per_10: ctx.shotPolicy(u).per_10, shots_source: ctx.shotPolicy(u).source },
      invited: !!u.invited_at && !u.joined_at, invited_at: u.invited_at || null,
      last_seen_at: u.last_seen_at || null, created_at: u.created_at, app_version: u.app_version || null, app_platform: u.app_platform || null,
      manages: u.role === 'manager' ? db.prepare('SELECT team_id FROM manager_teams WHERE user_id = ?').all(u.id).map((r) => r.team_id) : [],
    };
  }

  route('GET', '/api/users', ({ user, query }) => {
    needManager(user);
    const includeInactive = query.get('all') === '1';
    const live = calc.liveStates(visibleUsers(user, { includeInactive }));
    return visibleUsers(user, { includeInactive }).map((u) => ({ ...userOut(u, user), state: (live.get(u.id) || {}).state || 'offline' }));
  });

  route('GET', '/api/users/:id', ({ user, params }) => userOut(targetUser(user, params.id), user));

  function readSchedule(body, out = {}) {
    if ('tz_offset_min' in body) out.tz_offset_min = body.tz_offset_min === null ? null : int(body.tz_offset_min, 'tz_offset_min', -720, 840);
    // a zone by place replaces any fixed offset; null goes back to the company's zone
    if ('tz_name' in body) {
      const v = body.tz_name === '' ? null : body.tz_name;
      need(v === null || T.validZone(v), 400, 'tz_name must be a time zone like America/New_York');
      out.tz_name = v;
      if (!('tz_offset_min' in body)) out.tz_offset_min = null;
    }
    for (const k of ['shift_start', 'shift_end', 'break_start', 'break_end']) {
      if (k in body) { const v = body[k] === '' ? null : body[k]; need(v === null || T.validHhmm(v), 400, `${k} must look like 09:00`); out[k] = v; }
    }
    if ('work_days' in body) {
      need(body.work_days === null || /^[0-6](,[0-6])*$/.test(body.work_days), 400, 'work_days must be a list like 1,2,3,4,5');
      out.work_days = body.work_days;
    }
    if ('day_hours' in body) {
      const v = body.day_hours;
      need(v === null || (typeof v === 'object' && !Array.isArray(v)), 400, 'day_hours must be an object keyed by weekday');
      const clean = {};
      for (const [k, h] of Object.entries(v || {})) {
        need(/^[0-6]$/.test(k), 400, 'day_hours keys are weekdays 0 to 6');
        need(h && T.validHhmm(h.shift_start) && T.validHhmm(h.shift_end) && h.shift_start !== h.shift_end, 400, 'Each day needs a start and an end time');
        const bs = h.break_start || null, be = h.break_end || null;
        need(!bs === !be, 400, 'Give the break both a start and an end, or leave both blank');
        need(bs === null || (T.validHhmm(bs) && T.validHhmm(be)), 400, 'Break times must look like 09:00');
        clean[k] = { shift_start: h.shift_start, shift_end: h.shift_end, break_start: bs, break_end: be };
      }
      out.day_hours = Object.keys(clean).length ? JSON.stringify(clean) : null;
    }
    if ('weekly_target_min' in body) out.weekly_target_min = body.weekly_target_min === null ? null : int(body.weekly_target_min, 'weekly_target_min', 0, 6000);
    return out;
  }

  route('POST', '/api/users', async ({ user, body }) => {
    needManager(user);
    const email = str(body.email, 'email', 200).toLowerCase();
    need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'Enter a valid email address');
    const name = str(body.name, 'name', 100);
    // invited by email: they choose their own password from the link (a random one stands in until then)
    const invite = !!body.invite;
    need(!invite || ctx.mail, 400, 'Email isn’t set up on this server. Give them a password instead.');
    const password = invite ? ctx.newToken() : str(body.password, 'password', 200);
    const bad = invite ? null : ctx.passwordProblem(password, { email, name });
    need(!bad, 400, bad);
    const role = body.role || 'employee';
    need(['employee', 'manager'].includes(role), 400, 'role must be employee or manager');
    need(role === 'employee' || user.role === 'owner', 403, 'Only the owner can create managers');
    need(!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email), 409, 'That email is already in use');
    let teamId = null;
    if (body.team_id != null) {
      teamId = int(body.team_id, 'team_id', 1, 1e9);
      need(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId), 404, 'Team not found');
      const scope = managedTeamIds(user);
      need(scope === null || scope.includes(teamId), 403, 'You can only add people to your own teams');
    } else {
      const scope = managedTeamIds(user);
      need(scope === null, 400, 'Choose a team for the new person');
    }
    const sched = readSchedule(body);
    const { salt, hash } = hashPassword(password);
    const id = Number(db.prepare(`INSERT INTO users (email,name,role,pw_salt,pw_hash,team_id,title,tracks_time,tz_offset_min,tz_name,shift_start,shift_end,break_start,break_end,work_days,weekly_target_min,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(email, name, role, salt, hash, teamId, optStr(body.title, 'title', 100), role === 'employee' ? 1 : (body.tracks_time && user.role === 'owner' ? 1 : 0),
      sched.tz_offset_min ?? null, sched.tz_name ?? null, sched.shift_start ?? null, sched.shift_end ?? null, sched.break_start ?? null, sched.break_end ?? null, sched.work_days ?? null, sched.weekly_target_min ?? null, ctx.nowIso()).lastInsertRowid);
    audit(user, 'user.created', id, `${name} (${role})`);
    const sent = invite ? await ctx.sendInvite(id, user) : null;
    emit('users', id);
    // when the email couldn't go out, the person who invited them gets the link to pass on themselves
    return { ...userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(id), user), ...(sent ? { invite_sent: !!sent.sent, ...(sent.sent ? {} : { invite_link: sent.link }) } : {}) };
  });

  route('PATCH', '/api/users/:id', ({ user, params, body }) => {
    needManager(user);
    const t = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    need(t, 404, 'User not found');
    need(canSee(user, t.id), 403, 'Not allowed');
    need(t.role !== 'owner' || (user.role === 'owner' && !user.dev_owner), 403, 'Only the owner can change the owner');
    need(user.role === 'owner' || t.role === 'employee' || t.id === user.id, 403, 'Only the owner can change managers');
    // a developer account sees what the owner sees: only the owner changes or removes it
    need(!t.is_dev || t.id === user.id || (user.role === 'owner' && !user.dev_owner), 403, 'Only the owner can change or remove a developer account');
    const set = {};
    if ('name' in body) set.name = str(body.name, 'name', 100);
    if ('title' in body) set.title = optStr(body.title, 'title', 100);
    if ('team_id' in body) {
      if (body.team_id === null) set.team_id = null;
      else {
        const tid = int(body.team_id, 'team_id', 1, 1e9);
        need(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(tid), 404, 'Team not found');
        const scope = managedTeamIds(user);
        need(scope === null || scope.includes(tid), 403, 'You can only move people into your own teams');
        set.team_id = tid;
      }
    }
    // how someone is monitored (screenshots, whether they track time, the other-device mode) is the
    // owner's decision alone; a manager sending the same value back (from the edit form) is fine
    const ownerOnly = (k, v) => { if (v !== t[k]) need(user.role === 'owner', 403, 'Only the owner changes screenshots and tracking'); set[k] = v; };
    if ('tracks_time' in body) ownerOnly('tracks_time', body.tracks_time ? 1 : 0);
    if ('other_device' in body) ownerOnly('other_device', body.other_device ? 1 : 0);
    if ('shots_per_10' in body) ownerOnly('shots_per_10', body.shots_per_10 === null ? null : int(body.shots_per_10, 'shots_per_10', 0, 3));
    if ('role' in body) {
      need(user.role === 'owner', 403, 'Only the owner can change roles');
      need(t.role !== 'owner' && ['employee', 'manager'].includes(body.role), 400, 'role must be employee or manager');
      set.role = body.role;
    }
    if ('hr' in body) {
      need(user.role === 'owner', 403, 'Only the owner decides who is in HR');
      need(t.role !== 'owner', 400, 'The owner already sees everything HR does');
      set.hr = body.hr ? 1 : 0;
    }
    if ('is_dev' in body && !!body.is_dev !== !!t.is_dev) {
      need(user.role === 'owner' && !user.dev_owner, 403, 'Only the owner decides who has developer access');
      set.is_dev = body.is_dev ? 1 : 0;
    }
    if ('active' in body) {
      need(t.id !== user.id, 400, 'You cannot deactivate yourself');
      need(t.role !== 'owner', 400, 'The owner cannot be deactivated');
      set.active = body.active ? 1 : 0;
    }
    Object.assign(set, readSchedule(body));
    if ('password' in body) {
      const pw = str(body.password, 'password', 200);
      const bad = ctx.passwordProblem(pw, t);
      need(!bad, 400, bad);
      const { salt, hash } = hashPassword(pw);
      set.pw_salt = salt; set.pw_hash = hash;
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.id);
    }
    const keys = Object.keys(set);
    need(keys.length > 0 || 'manages' in body, 400, 'Nothing to change');
    // the person is told about anything this changes in their tracking or schedule
    if (keys.length) ctx.changes.track([t], user, () => db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), t.id));
    if ('manages' in body) {
      need(user.role === 'owner', 403, 'Only the owner can assign teams to managers');
      need(Array.isArray(body.manages), 400, 'manages must be a list of team ids');
      db.prepare('DELETE FROM manager_teams WHERE user_id = ?').run(t.id);
      for (const tid of body.manages) {
        need(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(tid), 404, 'Team not found');
        db.prepare('INSERT OR IGNORE INTO manager_teams (user_id, team_id) VALUES (?,?)').run(t.id, tid);
      }
    }
    const shown = keys.filter((k) => !k.startsWith('pw_')).concat(keys.some((k) => k.startsWith('pw_')) ? ['password'] : []).concat('manages' in body ? ['manages'] : []);
    audit(user, 'user.updated', t.id, shown.join(', '));
    if ('is_dev' in set) {
      audit(user, set.is_dev ? 'user.dev_granted' : 'user.dev_removed', t.id, t.name);
      if (t.id !== user.id) ctx.notify.notify([t.id], set.is_dev
        ? { kind: 'changed', title: 'You have developer access', body: `${user.name} gave you developer access: everything the owner sees and can do, including people's screenshots, activity, pay and HR records, plus the developer tools. Everyone is told who has it.`, link: '#/dev' }
        : { kind: 'changed', title: 'Your developer access has ended', body: `By ${user.name}.`, link: '#/' });
      // everyone is told, since a developer sees what the owner sees
      const all = t.role === 'owner' ? [] : db.prepare('SELECT id FROM users WHERE active = 1 AND id NOT IN (?, ?)').all(t.id, user.id).map((r) => r.id);
      if (all.length) ctx.notify.notify(all, set.is_dev
        ? { kind: 'changed', title: `${t.name} now has developer access`, body: `They see what the owner sees, including screenshots, activity, pay and HR records, to look after Staffwarden. Your profile lists everyone with this access.`, link: '#/profile' }
        : { kind: 'changed', title: `${t.name} no longer has developer access`, body: `Your profile lists everyone with this access.`, link: '#/profile' });
    }
    emit('users', t.id);
    return userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(t.id), user);
  });

  // ---- teams ----
  route('GET', '/api/teams', ({ user }) => {
    const rows = db.prepare('SELECT * FROM teams ORDER BY name').all();
    const scope = isManager(user) ? managedTeamIds(user) : null;
    return rows.filter((t) => !isManager(user) ? t.id === user.team_id : scope === null || scope.includes(t.id)).map((t) => ({
      id: t.id, name: t.name, shots_per_10: t.shots_per_10 ?? null,
      members: db.prepare('SELECT COUNT(*) n FROM users WHERE team_id = ? AND active = 1').get(t.id).n,
      managers: db.prepare('SELECT u.id, u.name FROM manager_teams m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?').all(t.id),
    }));
  });
  route('POST', '/api/teams', ({ user, body }) => {
    needOwner(user);
    const name = str(body.name, 'name', 80);
    need(!db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name), 409, 'A team with that name already exists');
    const id = Number(db.prepare('INSERT INTO teams (name) VALUES (?)').run(name).lastInsertRowid);
    audit(user, 'team.created', null, name);
    emit('users');
    return { id, name };
  });
  route('PATCH', '/api/teams/:id', ({ user, params, body }) => {
    needOwner(user);
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(params.id));
    need(t, 404, 'Team not found');
    need('name' in body || 'shots_per_10' in body, 400, 'Nothing to change');
    let name = t.name;
    if ('name' in body) {
      name = str(body.name, 'name', 80);
      need(!db.prepare('SELECT 1 FROM teams WHERE name = ? AND id != ?').get(name, t.id), 409, 'A team with that name already exists');
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, t.id);
      if (name !== t.name) audit(user, 'team.renamed', null, `${t.name} -> ${name}`);
    }
    if ('shots_per_10' in body) {
      const v = body.shots_per_10 === null ? null : int(body.shots_per_10, 'shots_per_10', 0, 3);
      ctx.changes.track(db.prepare('SELECT * FROM users WHERE team_id = ? AND active = 1').all(t.id), user, () => db.prepare('UPDATE teams SET shots_per_10 = ? WHERE id = ?').run(v, t.id));
      audit(user, 'team.screenshots', null, `${name}: ${v === null ? 'company default' : v === 0 ? 'off' : `${v} per 10 min`}`);
    }
    emit('users');
    return { id: t.id, name };
  });
  route('DELETE', '/api/teams/:id', ({ user, params }) => {
    needOwner(user);
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(params.id));
    need(t, 404, 'Team not found');
    db.prepare('UPDATE users SET team_id = NULL WHERE team_id = ?').run(t.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(t.id);
    audit(user, 'team.deleted', null, t.name);
    emit('users');
    return { ok: true };
  });
};
