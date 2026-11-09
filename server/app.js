'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { hashPassword, verifyPassword, newToken, tokenHash, verifyNobody, passwordProblem } = require('./auth');
const { HttpError, need } = require('./lib/http');
const T = require('./lib/time');
const { createCalc } = require('./services/calc');
const { createChanges } = require('./services/changes');
const { createNotify } = require('./services/notify');
const { createPortalNotify } = require('./services/portalnotify');
const { createPayroll } = require('./services/payroll');

const MAX_BODY = 8 * 1024 * 1024; // 8MB (screenshots arrive as base64 JSON)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.webm': 'video/webm', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
// Bumped when what is tracked or shared changes; everyone accepts the new policy once before tracking again.
// POLICY_CHANGES says, in plain words, what each version changed, so people see exactly what is new.
const POLICY_VERSION = 3;
const POLICY_CHANGES = {
  3: [
    'Your teammates can see whether you are working, on a break, idle or not started yet, and how long you have worked today. They never see your screenshots, your activity level or why you are on a break. The owner can turn this off.',
    'You are told every time your tracking, schedule or time is changed, and by whom. Each change is kept on your profile.',
    'You can add a note to a late start, an idle stretch, a screenshot or a whole day, and ask a manager to add time you forgot to track.',
    'From now on the timer can only be started from the newest version of the desktop app.',
  ],
};
const PAUSE_REASONS = [
  { id: 'break', label: 'Short break' }, { id: 'dinner', label: 'Dinner' }, { id: 'lunch', label: 'Lunch' }, { id: 'prayer', label: 'Prayer' },
  { id: 'personal', label: 'Personal' }, { id: 'other', label: 'Other' },
];

// Compares "1.2.10" with "1.2.9" the way people expect. Missing versions sort last.
function cmpVersion(a, b) {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

function createApp(opts = {}) {
  // ---- configuration: constructor/env defaults, overridden by whatever the owner saved in Settings ----
  const defaults = {
    orgName: opts.orgName || 'Your company',
    shiftStart: opts.shiftStart || '09:00',
    shiftEnd: opts.shiftEnd || '18:00',
    breakStart: opts.breakStart || null,     // scheduled break, e.g. 13:00 to 14:00 (none by default)
    breakEnd: opts.breakEnd || null,
    graceMin: opts.graceMin ?? 10,
    tzOffsetMin: opts.tzOffsetMin ?? 300, // PKT (UTC+5); used when no zone is picked
    tzName: opts.tzName || null,          // the company's zone by place (Asia/Karachi), which follows daylight saving
    // payroll rules HR chooses; amounts in whole rupees. Tax brackets: [up to, fixed tax, % on the part above the last bracket]
    payroll: {
      day_basis: 'working', unpaid_leave: 'deduct', absent: 'deduct', late: { mode: 'off', every: 3, days: 0.5 }, overtime: { mode: 'off', rate: 1.5 },
      pay_day: 1, pay_by: 10, leave_payout: true, owner_approves: true, hr_own_pay: false, managers_first: true,
      tax: { on: true, label: 'Tax year 2027 (July 2026 to June 2027), from the Finance Act 2026', brackets: [[600000, 0, 0], [1200000, 0, 1], [2200000, 6000, 11], [3200000, 116000, 20], [4100000, 316000, 25], [5600000, 541000, 29], [7000000, 976000, 32], [null, 1424000, 35]] },
      eobi: { on: false, min_wage: 40700, er: 5, ee: 1 },
      expense_limits: { travel: 3000, meals: 5000 },
    },
    workDays: opts.workDays || '1,2,3,4,5',
    weeklyTargetMin: opts.weeklyTargetMin ?? 2400,
    leaveDaysPerYear: opts.leaveDaysPerYear ?? 20,
    // time off: paid days each month (they don't carry over), and leave next to a weekend or holiday only in an emergency
    paidLeavePerMonth: opts.paidLeavePerMonth ?? 1,
    noSandwichLeave: opts.noSandwichLeave ?? true,
    retentionDays: opts.retentionDays ?? 60,
    captureIntervalMin: Math.min(60, Math.max(1, Number(opts.captureIntervalMin) || 2)),
    idleLimitMin: Math.min(120, Math.max(1, Number(opts.idleLimitMin) || 10)),
    noSignalMin: opts.noSignalMin ?? 3,       // a running timer silent this long is shown as "no signal"
    staleMin: opts.staleMin ?? 20,            // ...and closed at its last sign of life after this long
    employeesCanDeleteShots: opts.employeesCanDeleteShots ?? true,
    taskReviewRequired: true,                 // assigned tasks go to 'In review' and a manager marks them done
    blackoutApps: ['WhatsApp'],               // extra apps hidden (painted black) in screenshots; WhatsApp is always on the list
    // Screenshots per 10-minute block (Hubstaff style): 0 = off, 1-3. Teams and people can override it.
    shotsPer10: opts.shotsPer10 ?? (opts.captureIntervalMin ? Math.min(3, Math.max(1, Math.round(10 / Number(opts.captureIntervalMin)))) : 2),
    // Built-in private categories that are always hidden: messaging apps, password managers, private browser windows.
    // These two are the owner's choice.
    blackoutCategories: { banking: true, social: false },
    blackoutFullFront: false,                 // retired: only private windows are painted black
    // Staff use their own computers: by default only the screen they are working on is captured (the one
    // with the mouse), not a second monitor; blurring makes screenshots show that work happens, not detail.
    captureScreens: 'active',
    blurShots: false,
    // Employees see their colleagues' status (working, break, idle, not started) and hours today:
    // 'everyone', 'team' (only their own team) or 'off'.
    teamVisibility: 'everyone',
    // A desktop app older than the newest installer on this server cannot start the timer.
    requireLatestApp: true,
  };
  const cfg = {
    dbFile: opts.dbFile || ':memory:',
    dataDir: opts.dataDir || path.join(__dirname, '..', 'data'),
    webDir: opts.webDir || path.join(__dirname, '..', 'web'),
    ...defaults,
  };
  // Create folders first: on a fresh install neither the data dir nor the db's folder exists yet.
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (cfg.dbFile !== ':memory:') fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
  const db = openDb(cfg.dbFile);
  const shotDir = path.join(cfg.dataDir, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const hrDir = path.join(cfg.dataDir, 'hr');
  fs.mkdirSync(hrDir, { recursive: true });

  const clockNow = opts.now || Date.now; // injectable so tests can simulate time
  const nowIso = () => new Date(clockNow()).toISOString();

  function loadSettings() {
    for (const r of db.prepare('SELECT key, value FROM settings').all()) {
      try { cfg[r.key] = JSON.parse(r.value); } catch { /* ignore a corrupt row */ }
    }
  }
  function saveSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    cfg[key] = value;
  }
  loadSettings();
  // an install from before the company's name was saved kept it only as the built-in default: save it, so
  // changing that default (the app is for any company now) never renames a company already running
  if (!opts.orgName && !opts.tenant && !db.prepare("SELECT 1 FROM settings WHERE key = 'orgName'").get() && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    saveSetting('orgName', 'Amplify Media'); cfg.orgName = 'Amplify Media';
  }

  // ---- live updates (Server-Sent Events) ----
  // Events carry only a type and a user id, never data: clients re-fetch through the normal,
  // permission-checked API. Each person hears only about people they are allowed to see.
  const sseClients = new Set();
  const isManager = (u) => u.role === 'owner' || u.role === 'manager';
  // HR sees people's records, pay and leave for everyone, never screenshots or activity
  const isHR = (u) => !!u && (u.role === 'owner' || !!u.hr);

  function managedTeamIds(user) { // null = sees everyone
    if (user.role === 'owner') return null;
    if (user.role !== 'manager') return [];
    const rows = db.prepare('SELECT team_id FROM manager_teams WHERE user_id = ?').all(user.id);
    return rows.length ? rows.map((r) => r.team_id) : null;
  }
  function canSee(viewer, targetId) {
    if (viewer.id === targetId) return true;
    if (!isManager(viewer)) return false;
    const teams = managedTeamIds(viewer);
    if (teams === null) return true;
    const t = db.prepare('SELECT team_id FROM users WHERE id = ?').get(targetId);
    return !!t && t.team_id != null && teams.includes(t.team_id);
  }
  function visibleUsers(viewer, { tracking = false, includeInactive = false } = {}) {
    let rows;
    if (!isManager(viewer)) rows = db.prepare('SELECT * FROM users WHERE id = ?').all(viewer.id);
    else {
      const teams = managedTeamIds(viewer);
      if (teams === null) rows = db.prepare('SELECT * FROM users ORDER BY name').all();
      else rows = db.prepare(`SELECT * FROM users WHERE id = ? OR team_id IN (${teams.map(() => '?').join(',') || 'NULL'}) ORDER BY name`).all(viewer.id, ...teams);
    }
    if (!includeInactive) rows = rows.filter((r) => r.active);
    if (tracking) rows = rows.filter((r) => r.tracks_time);
    return rows;
  }

  const HR_EVENTS = new Set(['payroll', 'hr', 'expenses', 'timeoff', 'users']);
  function emit(type, userId = null) {
    if (type === 'users' && opts.tenant && opts.tenant.onUsersChanged) { try { opts.tenant.onUsersChanged(); } catch (e) { console.error('seats', e); } }
    const msg = `data: ${JSON.stringify({ type, user_id: userId, at: nowIso() })}\n\n`;
    for (const c of sseClients) {
      if (c.kind === 'client') continue;
      if (userId == null || canSee({ id: c.userId, role: c.role }, userId) || (c.hr && HR_EVENTS.has(type))) {
        try { c.res.write(msg); } catch { sseClients.delete(c); }
      }
    }
  }
  // Only to one person's open dashboards (their own notifications).
  function emitTo(userId, type) {
    const msg = `data: ${JSON.stringify({ type, user_id: userId, at: nowIso() })}\n\n`;
    for (const c of sseClients) if (c.kind !== 'client' && c.userId === userId) { try { c.res.write(msg); } catch { sseClients.delete(c); } }
  }
  // To a set of people's open dashboards: the team chat (each thread has its own members)
  function emitUsers(ids, type, extra = {}) {
    const set = new Set((ids || []).map(Number));
    const msg = `data: ${JSON.stringify({ type, ...extra, at: nowIso() })}\n\n`;
    for (const c of sseClients) if (c.kind !== 'client' && set.has(c.userId)) { try { c.res.write(msg); } catch { sseClients.delete(c); } }
  }
  // Only to one client person's open portals (their own bell).
  function emitClientUser(clientUserId, type) {
    const msg = `data: ${JSON.stringify({ type, at: nowIso() })}\n\n`;
    for (const c of sseClients) if (c.kind === 'client' && c.clientUserId === clientUserId && streamAlive(c)) { try { c.res.write(msg); } catch { sseClients.delete(c); } }
  }
  // who is online right now: anyone with the website or the portal open (a live connection)
  function onlineNow() {
    const staff = new Set(), clients = new Set();
    for (const c of sseClients) { if (c.kind === 'client') clients.add(c.clientUserId); else staff.add(c.userId); }
    return { staff, clients };
  }
  // Portal events go to the staff who can see the project and to that project's client. `to` narrows
  // it: { staff: [ids] } and/or { clientUser: id } for a direct chat, { staffOnly: true } for team-only.
  function emitPortal(project, type, extra = {}, to = null) {
    const msg = `data: ${JSON.stringify({ type, project_id: project.id, ...extra, at: nowIso() })}\n\n`;
    for (const c of sseClients) {
      let ok;
      if (c.kind === 'client') ok = c.clientId === project.client_id && !(to && to.staffOnly) && (!to || !to.direct || to.clientUser === c.clientUserId) && streamAlive(c);
      else ok = to && to.direct ? (to.staff || []).includes(c.userId) : !!ctx.projectVisible && ctx.projectVisible({ id: c.userId, role: c.role }, project);
      if (ok) { try { c.res.write(msg); } catch { sseClients.delete(c); } }
    }
  }
  // a live stream lasts only as long as its sign-in: signing out, being turned off, a new password or an
  // archived client ends it (checked before every client event, and for everyone on each ping)
  function streamAlive(c) {
    const ok = c.kind === 'client'
      ? !!db.prepare('SELECT 1 FROM client_sessions s JOIN client_users cu ON cu.id = s.client_user_id JOIN clients cl ON cl.id = cu.client_id WHERE s.token = ? AND cu.active = 1 AND cl.archived = 0').get(c.th)
      : !!db.prepare('SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1').get(c.th);
    if (!ok) { sseClients.delete(c); try { c.res.end(); } catch { /* gone */ } }
    return ok;
  }
  const pinger = setInterval(() => {
    // a real event, so the page can tell its live connection is really getting through
    for (const c of sseClients) { if (!streamAlive(c)) continue; try { c.res.write('data: {"type":"ping"}\n\n'); } catch { sseClients.delete(c); } }
  }, 15000);
  pinger.unref();

  function audit(actor, action, targetUserId = null, detail = null) {
    db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, target_user_id, detail) VALUES (?,?,?,?,?,?)')
      .run(nowIso(), actor ? actor.id : null, actor ? actor.name : 'system', action, targetUserId, detail == null ? null : String(detail).slice(0, 500));
  }

  // How many screenshots per 10 minutes apply to this person, and where that comes from.
  function shotPolicy(u) {
    if (u.shots_per_10 != null) return { per_10: u.shots_per_10, source: 'person' };
    const t = u.team_id ? db.prepare('SELECT shots_per_10 FROM teams WHERE id = ?').get(u.team_id) : null;
    if (t && t.shots_per_10 != null) return { per_10: t.shots_per_10, source: 'team' };
    return { per_10: cfg.shotsPer10, source: 'company' };
  }

  // Whether the person's agreement still covers what is captured now, and what changed since they agreed:
  // new policy versions (in words) and changed settings. They agree again for a new version, or when
  // more would be captured or shared than before; smaller changes are only shown.
  function consentState(u) {
    const versionOk = !!u.consented_at && (u.consent_version || 1) >= POLICY_VERSION;
    const ts = u.consented_at ? ctx.changes.termsState(u) : { lines: [], more: false };
    const news = [];
    if (u.consented_at) for (let v = (u.consent_version || 1) + 1; v <= POLICY_VERSION; v++) for (const t of POLICY_CHANGES[v] || []) news.push(t);
    return {
      consented: versionOk && !ts.more, policy_version: POLICY_VERSION,
      policy_updated: !!u.consented_at && (!versionOk || ts.more),
      policy_changes: { news, settings: ts.lines, reaccept: !!u.consented_at && (!versionOk || ts.more) },
    };
  }
  const publicUser = (u) => {
    const sp = shotPolicy(u);
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, hr: !!u.hr, ...consentState(u), title: u.title || null,
      tracks_time: !!u.tracks_time, tz_offset_min: ctx.calc.userTz(u), tz_name: ctx.calc.zoneOf(u),
      // the hours for the person's current work day, so the desktop app follows a different Saturday on its own
      ...(({ special, ...h }) => h)(ctx.calc.hoursOn(u, ctx.calc.todayOf(u))), work_days: u.work_days || cfg.workDays,
      day_hours: ctx.calc.dayHours(u),
      day_start_min: T.dayStartMin(u.shift_start || cfg.shiftStart, u.shift_end || cfg.shiftEnd),
      // screenshots are a Pro feature on the service: off for everyone when the plan doesn't have them
      shots_per_10: opts.tenant && !opts.tenant.allows('screenshots') ? 0 : sp.per_10, shots_source: opts.tenant && !opts.tenant.allows('screenshots') ? 'plan' : sp.source, other_device: !!u.other_device,
      // a fun look the owner switched on (god mode): cosmetic only, never a permission
      fun_mode: u.fun_mode && (!u.fun_until || Date.parse(u.fun_until) > clockNow()) ? u.fun_mode : null,
      // the developer tools (server health, apps, errors); never a way into screenshots, pay or messages
      is_dev: !!u.is_dev, dev_granted: !!u.is_dev, dev_owner: !!u.dev_owner,
      features: ctx.featuresFor ? ctx.featuresFor(u.id) : [],
      leaderboard: ctx.leaderboardSettings ? (ctx.leaderboardSettings().audience === 'everyone' || isManager(u) || !!u.is_dev) : false,
      // what everyone can see about each other on the leaderboard (for the "What is tracked" list)
      leaderboard_public: ctx.leaderboardSettings && ctx.leaderboardSettings().audience === 'everyone' ? ctx.leaderboardSettings().columns : [],
      // the colour theme: theirs, else the company's default; and the logo colour for "Your company"
      theme: ctx.themeOf ? ctx.themeOf(u) : 'night', theme_own: u.theme || null, theme_default: ctx.themeDefault ? ctx.themeDefault() : 'night',
      brand: ctx.companyPublic ? ctx.companyPublic().brand_now : null,
      // the company's Staffwarden account: trial, paused, payment trouble (the owner sees billing; others only a pause)
      account: opts.tenant && opts.tenant.publicInfo ? opts.tenant.publicInfo(u) : null,
    };
  };

  function seedOwner(email, name, password) {
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return exists.id;
    const { salt, hash } = hashPassword(password);
    return Number(db.prepare('INSERT INTO users (email,name,role,pw_salt,pw_hash,tracks_time,created_at) VALUES (?,?,?,?,?,0,?)')
      .run(email, name, 'owner', salt, hash, nowIso()).lastInsertRowid);
  }

  function authUser(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    need(token, 401, 'Not signed in');
    // a session lasts 30 days at most, and ends after 14 days without being used
    const th = tokenHash(token);
    const u = db.prepare(`SELECT u.*, s.last_used_at AS s_used FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.created_at > datetime('now', '-30 days') AND (s.last_used_at IS NULL OR s.last_used_at > datetime('now', '-14 days'))`).get(th);
    if (!u) return clientUser(th);
    need(u, 401, 'Session expired');
    if (!u.s_used || Date.now() - Date.parse(u.s_used.replace(' ', 'T') + 'Z') > 5 * 60000) db.prepare("UPDATE sessions SET last_used_at = datetime('now') WHERE token = ?").run(th);
    delete u.s_used;
    need(u.active, 403, 'This account has been deactivated');
    // the desktop app says which version it is ("0.9.4 darwin arm64"); remembered so the owner sees who needs to update
    const m = /^(\d{1,4}\.\d{1,4}\.\d{1,4}) (darwin|win32|linux) (x64|arm64|ia32)$/.exec(String(req.headers['x-workhelm-app'] || ''));
    if (m && (u.app_version !== m[1] || u.app_platform !== `${m[2]} ${m[3]}`)) {
      db.prepare('UPDATE users SET app_version = ?, app_platform = ? WHERE id = ?').run(m[1], `${m[2]} ${m[3]}`, u.id);
      u.app_version = m[1]; u.app_platform = `${m[2]} ${m[3]}`;
    }
    // the zone the person's own computer is set to, offered to managers as a suggestion
    const z = String(req.headers['x-workhelm-tz'] || '');
    if (z && z !== u.seen_tz && T.validZone(z)) { db.prepare('UPDATE users SET seen_tz = ? WHERE id = ?').run(z, u.id); u.seen_tz = z; }
    // "See it as the client": someone who runs one of that client's projects reads the portal as one of
    // their people would. Read only: nothing can be sent, marked read or changed while previewing.
    // Developer access: the owner's view and powers (people, screenshots, pay, payroll, settings), so they
    // can check and fix everything. Never the owner's own account, and never giving access to others.
    if (u.is_dev && u.role !== 'owner') { u.base_role = u.role; u.role = 'owner'; u.dev_owner = true; }
    const va = String(req.headers['x-workhelm-view-as'] || '');
    if (va) return viewAs(u, Number(va));
    return u;
  }
  function viewAs(u, cid) {
    need(Number.isInteger(cid) && cid > 0, 400, 'Choose who to see it as');
    const c = db.prepare('SELECT cu.*, cl.name AS client_name, cl.archived AS client_archived FROM client_users cu JOIN clients cl ON cl.id = cu.client_id WHERE cu.id = ?').get(cid);
    need(c && !c.client_archived, 404, 'Person not found');
    const mine = isManager(u) || db.prepare('SELECT id FROM projects WHERE client_id = ?').all(c.client_id).some((p) => ctx.canManageProject && ctx.canManageProject(u, ctx.getProject(p.id)));
    need(mine, 403, 'Only the project lead or a manager can see the portal as the client');
    return { kind: 'client', role: 'client', preview: true, viewer_id: u.id, viewer_name: u.name, viewer_role: u.role, id: c.id, client_id: c.client_id, client_name: c.client_name, email: c.email, name: c.name, title: c.title, can_approve: !!c.can_approve, pw_salt: '', pw_hash: '' };
  }

  // A client's session. Clients are never in `users`: they come back as { kind: 'client' } and can only
  // reach the routes marked for clients (see route()).
  function clientUser(th) {
    const c = db.prepare(`SELECT cu.*, s.last_used_at AS s_used, cl.name AS client_name, cl.archived AS client_archived FROM client_sessions s
      JOIN client_users cu ON cu.id = s.client_user_id JOIN clients cl ON cl.id = cu.client_id
      WHERE s.token = ? AND s.created_at > datetime('now', '-30 days') AND (s.last_used_at IS NULL OR s.last_used_at > datetime('now', '-14 days'))`).get(th);
    need(c, 401, 'Session expired');
    if (!c.s_used || Date.now() - Date.parse(c.s_used.replace(' ', 'T') + 'Z') > 5 * 60000) {
      db.prepare("UPDATE client_sessions SET last_used_at = datetime('now') WHERE token = ?").run(th);
      db.prepare('UPDATE client_users SET last_seen_at = ? WHERE id = ?').run(nowIso(), c.id);
    }
    need(c.active && !c.client_archived, 403, 'This account has been turned off. Ask your contact at the agency.');
    return { kind: 'client', role: 'client', id: c.id, client_id: c.client_id, client_name: c.client_name, email: c.email, name: c.name, title: c.title,
      can_approve: !!c.can_approve, pw_salt: c.pw_salt, pw_hash: c.pw_hash };
  }
  const publicClient = (c) => ({ id: c.id, kind: 'client', role: 'client', email: c.email, name: c.name, title: c.title || null, can_approve: !!c.can_approve, client_id: c.client_id, client_name: c.client_name, ...(c.preview ? { preview: true, viewer_name: c.viewer_name } : {}) });

  // Starting the timer needs an agreement that covers what is captured now (uploads from a timer that is
  // already running are still accepted, so a change made mid-shift loses nothing).
  function needConsentNow(u) {
    needConsent(u);
    need(!ctx.changes.termsState(u).more, 403, 'What Staffwarden captures has changed since you agreed. Open the desktop app to see what changed and agree before starting.');
  }
  function needConsent(u) { need(u.consented_at && (u.consent_version || 1) >= POLICY_VERSION, 403, 'Monitoring policy must be accepted before tracking'); }
  function needManager(u) { need(isManager(u), 403, 'Not allowed'); }
  function needOwner(u) { need(u.role === 'owner', 403, 'Only the owner can do this'); }
  function needHR(u) { need(isHR(u), 403, 'Only HR can do this'); }

  // 'me' or an id. A manager may read anyone in their scope; an employee only themselves.
  function targetUser(viewer, requested) {
    if (requested == null || requested === '' || requested === 'me' || Number(requested) === viewer.id) return viewer;
    need(isManager(viewer), 403, 'Not allowed');
    const t = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(requested));
    need(t, 404, 'User not found');
    need(canSee(viewer, t.id), 403, 'Not allowed');
    return t;
  }

  const touch = (userId) => db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowIso(), userId);

  // Removes screenshot files (full + thumbnail) and marks the rows deleted.
  function removeShots(rows) {
    for (const r of rows) {
      for (const f of [r.file, r.thumb]) { if (f) { try { fs.unlinkSync(path.join(shotDir, f)); } catch { /* already gone */ } } }
      db.prepare('UPDATE screenshots SET deleted = 1 WHERE id = ?').run(r.id);
    }
  }
  function purgeOld(days = cfg.retentionDays) {
    const cutoff = new Date(clockNow() - days * 86400000).toISOString();
    const rows = db.prepare('SELECT id, file, thumb FROM screenshots WHERE taken_at < ? AND deleted = 0').all(cutoff);
    removeShots(rows);
    return rows.length;
  }

  // A running timer that has gone silent (computer died, network cut for good) is closed at its last
  // sign of life, so attendance and hours never include time nobody can vouch for.
  function sweepStale() {
    const cutoff = new Date(clockNow() - cfg.staleMin * 60000).toISOString();
    const rows = db.prepare(`SELECT e.id, e.user_id, e.started_at, u.last_seen_at FROM time_entries e JOIN users u ON u.id = e.user_id
      WHERE e.ended_at IS NULL AND COALESCE(u.last_seen_at, e.started_at) < ?`).all(cutoff);
    for (const r of rows) {
      const end = r.last_seen_at && r.last_seen_at > r.started_at ? r.last_seen_at : r.started_at;
      db.prepare('UPDATE pauses SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(end, r.id);
      db.prepare('UPDATE idle_periods SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(end, r.id);
      db.prepare("UPDATE time_entries SET ended_at = ?, stop_reason = 'lost' WHERE id = ?").run(end, r.id);
      audit(null, 'timer.lost', r.user_id, `Closed at ${end}: no sign of life for ${cfg.staleMin} minutes`);
      emit('timer', r.user_id);
    }
    return rows.length;
  }
  // Scheduled notifications, checked every minute: a running timer that has gone silent (to the people
  // who manage that person), and each person's tasks that are due today or overdue (once a working day,
  // from the start of their shift).
  const managersOf = (userId) => db.prepare("SELECT id, role FROM users WHERE active = 1 AND role IN ('owner','manager')").all()
    .filter((m) => m.id !== userId && canSee(m, userId)).map((m) => m.id);
  function sweepNotify() {
    if (!ctx.notify) return 0;
    let n = 0;
    const now = clockNow();
    const silentMin = Math.max(10, cfg.noSignalMin * 3);
    const cutoff = new Date(now - silentMin * 60000).toISOString();
    const silent = db.prepare(`SELECT e.id, e.user_id, u.name, COALESCE(u.last_seen_at, e.started_at) AS seen FROM time_entries e JOIN users u ON u.id = e.user_id
      WHERE e.ended_at IS NULL AND COALESCE(u.last_seen_at, e.started_at) < ?`).all(cutoff);
    for (const r of silent) {
      n += ctx.notify.notify(managersOf(r.user_id), { kind: 'no_signal', title: `${r.name}: no signal from the desktop app`, body: `The timer is on, but nothing has been heard from the app for over ${silentMin} minutes. The computer may be off or offline.`, link: `#/timeline?user=${r.user_id}`, dedupe: `nosig:${r.id}` });
    }
    const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
    for (const u of users) {
      const dtz = ctx.calc.dayTz(u);
      const day = T.localDay(now, dtz);
      if (!String(u.work_days || cfg.workDays).split(',').map(Number).includes(T.dow(day))) continue;
      if (T.localMinOfDay(now, dtz) < ctx.calc.relMin(u, ctx.calc.shiftStartMin(u, day))) continue;
      if (db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND dedupe = ?').get(u.id, `due:${day}`)) continue;
      const rows = db.prepare("SELECT due_day FROM tasks WHERE assignee_id = ? AND status NOT IN ('done','in_review') AND due_day IS NOT NULL AND due_day <= ?").all(u.id, day);
      if (!rows.length) continue;
      const over = rows.filter((r) => r.due_day < day).length, today = rows.length - over;
      const parts = [over ? `${over} overdue` : null, today ? `${today} due today` : null].filter(Boolean);
      n += ctx.notify.notify(u.id, { kind: 'task_due', title: `You have ${parts.join(' and ')}`, body: 'Open My tasks to see what comes first.', link: '#/tasks?due=today', dedupe: `due:${day}` });
    }
    // A newer desktop app on the server: everyone whose app is older hears about it once per version
    // (bell, browser and desktop pop-ups; older apps without the in-app updater included).
    for (const u of db.prepare("SELECT id, app_version, app_platform FROM users WHERE active = 1 AND app_version IS NOT NULL AND app_platform IS NOT NULL").all()) {
      const [platform, arch] = u.app_platform.split(' ');
      const latest = latestApp(platform, arch);
      if (!latest.version || cmpVersion(latest.version, u.app_version) <= 0) continue;
      const canSelfUpdate = cmpVersion(u.app_version, '0.9.4') >= 0;
      n += ctx.notify.notify(u.id, {
        kind: 'app_update', title: `Staffwarden ${latest.version} is available`,
        body: canSelfUpdate ? 'Open the Staffwarden app and press Update now. It takes about a minute, and your timer keeps running.'
          : 'Download it from your Profile and install it over the old one. After this version, updates install from inside the app.',
        link: '#/profile', dedupe: `app:${latest.version}`,
      });
    }
    // the client portal's own schedule: weekly updates, call reminders, hour alerts, approval reminders
    if (ctx.portalSweep) { try { n += ctx.portalSweep(); } catch (e) { console.error('portal sweep', e); } }
    // the shift: idle nudges, check-in reminders, announcement reminders, fun modes that ran out
    if (ctx.planSweep) { try { n += ctx.planSweep(); } catch (e) { console.error('plan sweep', e); } }
    if (ctx.shiftSweep) { try { n += ctx.shiftSweep(); } catch (e) { console.error('shift sweep', e); } }
    // after the last shift of the day: the shift report is ready
    if (ctx.shiftReportSweep) { try { n += ctx.shiftReportSweep(); } catch (e) { console.error('shift report sweep', e); } }
    return n;
  }
  const sweeper = setInterval(() => {
    try { sweepStale(); } catch (e) { console.error('sweep', e); }
    try { sweepNotify(); } catch (e) { console.error('notify sweep', e); }
  }, 60000);
  sweeper.unref();

  // ---------- routes ----------
  const routes = [];
  // Every route is for staff only unless it says { client: true }: a client account can never reach
  // people, time, screenshots, payroll or anything else that was not written for it.
  const route = (method, pattern, handler, o = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, client: !!o.client, raw: o.raw || 0, open: !!o.open });
  };

  // The visitor's address. Behind Caddy every request arrives from this machine, so the address Caddy
  // passes on is used; it is only trusted from the machine itself, so nobody else can fake it.
  // Requests through the Cloudflare Worker carry a shared secret and the person's real address; only
  // with the right secret is that address believed (nobody else can pretend to be someone else).
  const PROXY_SECRET = String(opts.proxySecret || '');
  const viaProxy = (req) => {
    if (!PROXY_SECRET || PROXY_SECRET.length < 24) return false;
    const got = Buffer.from(String(req.headers['x-workhelm-proxy'] || '')), want = Buffer.from(PROXY_SECRET);
    return got.length === want.length && require('node:crypto').timingSafeEqual(got, want);
  };
  function clientIp(req) {
    const direct = req.socket.remoteAddress || '';
    const local = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
    if (local && viaProxy(req)) { const ip = String(req.headers['x-workhelm-client-ip'] || '').trim(); if (/^[0-9a-f.:]{3,45}$/i.test(ip)) return ip; }
    const fwd = local ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return fwd || direct;
  }
  const viaHttps = (req) => !!req && (req.socket.encrypted || (clientIp(req) !== req.socket.remoteAddress && (req.headers['x-forwarded-proto'] === 'https' || viaProxy(req))));

  const ctx = {
    backupDir: opts.backupDir || null, offsiteLog: opts.offsiteLog || null,
    POLICY_VERSION, db, cfg, route, clientIp, tokenHash, verifyNobody, passwordProblem, now: clockNow, nowIso, emit, emitTo, emitUsers, emitPortal, emitClientUser, onlineNow, publicUrl: opts.publicUrl || null, pushFetch: opts.pushFetch || null, gifFetch: opts.gifFetch || null, smtpOptions: opts.smtpOptions || null, publicClient, managersOf, sweepNotify, audit, publicUser, shotPolicy, shotDir, hashPassword, verifyPassword, newToken, PAUSE_REASONS,
    isManager, isHR, needHR, hrDir, needConsent, needConsentNow, needManager, cmpVersion, POLICY_CHANGES, needOwner, canSee, visibleUsers, targetUser, managedTeamIds, touch, removeShots, purgeOld, sweepStale,
    saveSetting, defaults, T, MAX_BODY, clockNow, listDownloads: () => listDownloads(), latestApp: (p, a) => latestApp(p, a),
    // set when this company runs on the shared Staffwarden service (one app per company): its account and
    // email. Without it (one company on its own server) everything works as before and nothing is billed.
    tenant: opts.tenant || null, mail: opts.mail || null,
  };
  ctx.calc = createCalc(ctx);
  ctx.notify = createNotify(ctx);
  ctx.pnotify = createPortalNotify(ctx);
  ctx.changes = createChanges(ctx);
  ctx.payroll = createPayroll(ctx);
  for (const f of ['auth', 'people', 'projects', 'tasks', 'performance', 'timer', 'capture', 'views', 'timeoff', 'admin', 'notifications', 'explain', 'hr', 'payroll', 'clients', 'portal', 'chat', 'portal2', 'team', 'shift', 'gifs', 'dev', 'leaderboard', 'shiftreport', 'assets', 'company', 'plans', 'themes', 'notes', 'account']) require(`./routes/${f}`)(ctx);

  // ---------- server ----------
  // a file sent as it is (not as JSON), for uploads bigger than a JSON body allows
  async function readRaw(req, limit) {
    const tooBig = new HttpError(413, `Files can be at most ${Math.round(limit / 1048576)} MB`);
    if (Number(req.headers['content-length']) > limit) { req.resume(); throw tooBig; }
    const chunks = []; let size = 0;
    // past the limit the rest is read and dropped, so the browser gets the answer instead of a cut connection
    for await (const c of req) { size += c.length; if (size <= limit) chunks.push(c); }
    if (size > limit) throw tooBig;
    return Buffer.concat(chunks);
  }
  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  // A fingerprint of the website's files. Every answer carries it, so an open dashboard notices when the
  // server was updated and offers a refresh (it would otherwise keep running the old pages).
  const BUILD = (() => {
    const h = require('node:crypto').createHash('sha1');
    const walk = (dir) => { let names = []; try { names = fs.readdirSync(dir).sort(); } catch { return; }
      for (const n of names) { const f = path.join(dir, n); const st = fs.statSync(f); if (st.isDirectory()) { if (n !== 'vendor') walk(f); } else if (!/\.(woff2|png|jpg|ico)$/.test(n)) { h.update(path.relative(cfg.webDir, f)); h.update(fs.readFileSync(f)); } } };
    walk(cfg.webDir);
    return h.digest('hex').slice(0, 12);
  })();
  const HSTS = { 'Strict-Transport-Security': 'max-age=31536000' };   // only sent over HTTPS: browsers then never use plain HTTP for this site
  const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
  const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

  // Static files are revalidated on every load (ETag), so a browser can never keep running an old copy of the app.
  function serveStatic(req, res, pathname) {
    // a broken address (a bot trying "/%E0%A4%A" and the like) is a plain "not found", not a server error
    let rel;
    try { rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname === '/welcome' ? 'welcome.html' : pathname.replace(/^\/+/, '')); } catch { res.writeHead(400, { 'Content-Type': 'text/plain', ...SEC_HEADERS }); res.end('Bad address'); return; }
    let file = path.normalize(path.join(cfg.webDir, rel));
    const inside = file.startsWith(path.normalize(cfg.webDir));
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel) === '' && inside) { file = path.join(cfg.webDir, 'index.html'); } // app routes fall back to the shell
      else { res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC_HEADERS }); res.end('Not found'); return; }
    }
    const st = fs.statSync(file);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': (file.includes(`${path.sep}fonts${path.sep}`) || file.includes(`${path.sep}vendor${path.sep}`)) ? 'public, max-age=604800' : 'no-cache', ...SEC_HEADERS, ...(viaHttps(req) ? HSTS : {}) };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  }

  // Desktop app installers, put in <data>/downloads on the server (they survive updates). Anyone can
  // download them: the sign-in page links to them so new staff can install the app.
  const dlDir = opts.dlDir || path.join(cfg.dataDir, 'downloads');
  ctx.dlDir = dlDir; ctx.BUILD = BUILD;
  // the money the company pays people in unless set per person (a single-company install from before was in rupees)
  ctx.homeCurrency = () => cfg.payCurrency || (opts.tenant ? 'USD' : 'PKR');
  // how many screens are open right now (for the developer's health page)
  ctx.liveCounts = () => { let staff = 0, clients = 0; for (const c of sseClients) { if (c.kind === 'client') clients++; else staff++; } return { staff, clients }; };
  // to every open staff screen and portal (the notice at the top, feature switches)
  ctx.emitAll = (type) => { const msg = `data: ${JSON.stringify({ type, at: nowIso() })}\n\n`; for (const c of sseClients) { try { c.res.write(msg); } catch { sseClients.delete(c); } } };
  const KIND = (f) => (/\.exe$/i.test(f) ? 'windows' : /mac.*(arm|apple)/i.test(f) ? 'mac-arm' : /mac.*(intel|x64)/i.test(f) || /\.(dmg|zip)$/i.test(f) ? 'mac-intel' : null);
  const VERSION = (f) => { const m = /(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(f); return m ? `${+m[1]}.${+m[2]}.${+m[3]}` : null; };
  function listDownloads() {
    let files = [];
    try { files = fs.readdirSync(dlDir).filter((f) => !f.startsWith('.') && KIND(f)); } catch { return []; }
    return files.map((f) => { const st = fs.statSync(path.join(dlDir, f)); return { file: f, kind: KIND(f), version: VERSION(f), size: st.size, updated_at: st.mtime.toISOString() }; })
      .sort((a, b) => cmpVersion(b.version, a.version) || (a.updated_at < b.updated_at ? 1 : -1));
  }
  // The newest installer for one kind of computer, with its SHA-256 so the app can check the download
  // before installing it. In-app updates on a Mac use the .zip (the app is swapped in place).
  const shaCache = new Map();
  function sha256Of(file) {
    const st = fs.statSync(file), key = `${file}|${st.size}|${st.mtimeMs}`;
    if (!shaCache.has(key)) shaCache.set(key, require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    return shaCache.get(key);
  }
  function latestApp(platform, arch) {
    const kind = platform === 'win32' ? 'windows' : platform === 'darwin' ? (arch === 'arm64' ? 'mac-arm' : 'mac-intel') : null;
    if (!kind) return { version: null };
    const f = listDownloads().find((d) => d.kind === kind && d.version && (kind === 'windows' ? /\.exe$/i.test(d.file) : /\.zip$/i.test(d.file)));
    if (!f) return { version: null };
    let notes = '';
    try { notes = fs.readFileSync(path.join(dlDir, 'release-notes.txt'), 'utf8').trim().slice(0, 1500); } catch { /* optional */ }
    // With a public address set (the Cloudflare Worker), downloads always go through it, so even apps that
    // still talk to the old address fetch the big installer over the fast route.
    const base = /^https:\/\//.test(String(opts.publicUrl || '')) ? String(opts.publicUrl).replace(/\/+$/, '') : '';
    return { version: f.version, file: f.file, url: base + '/downloads/' + encodeURIComponent(f.file), size: f.size, sha256: sha256Of(path.join(dlDir, f.file)), notes };
  }
  function serveDownload(req, res, pathname) {
    let name; try { name = path.basename(decodeURIComponent(pathname.slice('/downloads/'.length))); } catch { name = ''; }
    const file = path.join(dlDir, name);
    if (!name || name.startsWith('.') || !KIND(name) || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC_HEADERS }); res.end('Not found'); return; }
    const st = fs.statSync(file);
    // installers have the version in their name: Cloudflare keeps a copy near each person for an hour
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'Cache-Control': 'public, max-age=3600', ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, ...SEC_HEADERS });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, payload, extra = {}) => {
      res.writeHead(status, { 'Content-Type': extra['Content-Type'] || 'application/json', 'Cache-Control': 'no-store', 'X-Server-Time': nowIso(), 'X-Workhelm-Build': BUILD, ...SEC_HEADERS, ...(viaHttps(req) ? HSTS : {}), ...extra });
      res.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    };
    try {
      if (url.pathname.startsWith('/downloads/')) return serveDownload(req, res, url.pathname);
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      need(r, 404, 'Route not found');
      const m = url.pathname.match(r.re);
      let params; try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { throw new HttpError(400, 'That address is not valid'); }
      const isLogin = url.pathname === '/api/auth/login' || url.pathname === '/api/downloads' || url.pathname === '/api/app/latest';
      // an open route (the company logo) works signed out, and still knows who is asking when they are signed in
      const user = isLogin ? null : r.open ? (() => { try { return authUser(req); } catch { return null; } })() : authUser(req);
      if (user && user.kind === 'client') need(r.client, 403, 'Not available in the client portal');
      if (user && user.preview) need(req.method === 'GET', 403, 'This is a preview. Nothing you do here is sent.');
      // the company's account: tracking paused (trial over, not paid, closed) and what its plan includes
      if (opts.tenant && opts.tenant.gate) { const why = opts.tenant.gate(url.pathname, req.method, user); if (why && why.soft !== undefined) return send(200, why.soft); if (why) throw new HttpError(why.status || 403, why.message, why.extra); }
      const body = r.raw ? await readRaw(req, r.raw) : ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ req, user, body, params, query: url.searchParams });
      if (out && out.sse) {
        // marked as already encoded, so a proxy in front (Caddy's "encode gzip") passes every event through
        // at once instead of holding small events back until it has enough to compress
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'identity', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC_HEADERS });
        res.write(`retry: 3000\n\n:${' '.repeat(2048)}\n\ndata: {"type":"ping"}\n\n`);
        const th = tokenHash((req.headers.authorization || '').slice(7));
        const client = user.preview ? { res, th, userId: user.viewer_id, role: user.viewer_role, preview: true } : user.kind === 'client' ? { res, th, kind: 'client', clientUserId: user.id, clientId: user.client_id } : { res, th, userId: user.id, role: user.role, hr: !!user.hr };
        sseClients.add(client);
        req.on('close', () => sseClients.delete(client));
        return;
      }
      // a big file (the company's export): streamed from disk, never read into memory
      if (out && typeof out.streamFile === 'string') {
        const st = fs.statSync(out.streamFile);
        res.writeHead(200, { 'Content-Type': out.type || 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${String(out.name || path.basename(out.streamFile)).replace(/"/g, '')}"`, 'Cache-Control': 'no-store', ...SEC_HEADERS });
        fs.createReadStream(out.streamFile).pipe(res);
        return;
      }
      if (out && out.raw) return send(200, out.raw, { 'Content-Type': out.type, 'Cache-Control': 'private, max-age=300', ...(out.headers || {}) });
      send(200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) });
      console.error(e);
      if (ctx.recordError) ctx.recordError(e, null);
      send(500, { error: 'Internal error' });
    }
  }
  const server = http.createServer(handle);

  // stops this company's timers and live connections (the server closing, or the company being unloaded)
  function stop() {
    clearInterval(pinger); clearInterval(sweeper);
    for (const c of sseClients) { try { c.res.end(); } catch { /* already closed */ } }
    sseClients.clear();
  }
  const closeServer = server.close.bind(server);
  server.close = (cb) => { stop(); return closeServer(cb); };

  return { server, handle, stop, db, ctx, seedOwner, purgeOld, sweepStale, sweepNotify, cfg };
}

module.exports = { createApp, cmpVersion };
