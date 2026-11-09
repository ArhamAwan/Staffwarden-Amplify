'use strict';
// The company's account, seen from inside the company: invites by email, password resets, handing over
// ownership, billing (the owner only) and taking all the data out. Links sent by email are used once and
// kept only as a fingerprint. On a server that runs a single company (no platform), billing isn't used and
// emails go out only if a mail server is set up for the platform.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, need, str } = require('../lib/http');
const { workbook, XLSX_TYPE } = require('../lib/xlsx');
const { createZip } = require('../lib/zipfile');

const MIN = 60000, DAY = 86400000;
const SECRET_TABLES = new Set(['sessions', 'client_sessions', 'email_links', 'push_subscriptions', 'settings_secret']);
const SECRET_COLS = /^(pw_salt|pw_hash|token|secret|smtp_pass|pass|password|endpoint|p256dh|auth)$/i;
// settings rows that hold a password or a private key (the report mailbox, push keys, the GIF key)
const SECRET_SETTINGS = new Set(['report_mail', 'vapid', 'gif_key', 'smtp']);

module.exports = (ctx) => {
  const { db, cfg, route, nowIso, audit, emit, tokenHash, newToken, hashPassword, passwordProblem, publicUser, publicClient, clientIp } = ctx;
  const T = ctx.tenant;
  const base = () => (T ? T.url() : String(ctx.publicUrl || '').replace(/\/+$/, ''));
  const orgName = () => cfg.orgName || 'your company';

  // ---------- one-time links ----------
  function makeLink(kind, userId, by, ttlMs) {
    db.prepare('UPDATE email_links SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').run(nowIso(), userId, kind);
    const token = newToken();
    db.prepare('INSERT INTO email_links (token, kind, user_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(tokenHash(token), kind, userId, by || null, nowIso(), new Date(ctx.now() + ttlMs).toISOString());
    return token;
  }
  function findLink(token, kinds) {
    const l = db.prepare('SELECT * FROM email_links WHERE token = ?').get(tokenHash(String(token || '')));
    need(l && kinds.includes(l.kind), 404, 'This link isn’t valid. Ask for a new one.');
    need(!l.used_at, 410, 'This link was already used. Ask for a new one.');
    need(Date.parse(l.expires_at) > ctx.now(), 410, 'This link ran out. Ask for a new one.');
    return l;
  }
  const useLink = (l) => db.prepare('UPDATE email_links SET used_at = ? WHERE token = ?').run(nowIso(), l.token);
  function newSession(userId, client = false) {
    const token = newToken();
    db.prepare(`INSERT INTO ${client ? 'client_sessions (token, client_user_id' : 'sessions (token, user_id'}, last_used_at) VALUES (?, ?, datetime('now'))`).run(tokenHash(token), userId);
    return token;
  }
  const shotsOn = () => (!T || T.allows('screenshots')) && cfg.shotsPer10 > 0;

  // ---------- invites ----------
  ctx.sendInvite = async (userId, by) => {
    need(ctx.mail, 400, 'Email isn’t set up on this server');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    need(u && u.active, 404, 'Person not found');
    need(!u.joined_at || !u.invited_at, 400, `${u.name} has already joined`);
    const token = makeLink('invite', u.id, by && by.id, 7 * DAY);
    db.prepare('UPDATE users SET invited_at = ? WHERE id = ?').run(nowIso(), u.id);
    const link = `${base()}/#join?t=${token}`;
    const r = await ctx.mail('invite', u.email, { name: u.name.split(' ')[0], inviter: (by && by.name) || orgName(), link, screenshots: shotsOn() });
    audit(by, 'user.invited', u.id, r && r.sent ? `emailed to ${u.email}` : `link made for ${u.email} (${r && r.error ? r.error : 'not sent'})`);
    return { ...r, link };
  };
  route('POST', '/api/users/:id/invite', async ({ user, params }) => {
    ctx.needManager(user);
    const u = ctx.targetUser(user, params.id);
    // an invite link signs its holder in as that person: for HR and developer accounts, only the owner sends it
    need((!u.hr && !u.is_dev) || (user.role === 'owner' && !user.dev_owner), 403, 'Only the owner can invite an HR or developer account');
    need(u.invited_at && !u.joined_at, 400, `${u.name} has already joined`);
    const r = await ctx.sendInvite(u.id, user);
    return { ok: true, sent: !!(r && r.sent), ...(r && r.sent ? {} : { link: r.link }) };
  });

  // ---------- password resets ----------
  ctx.requestReset = async (email) => {
    if (!ctx.mail) return false;
    const e = String(email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(e);
    const c = !u && db.prepare('SELECT cu.* FROM client_users cu JOIN clients cl ON cl.id = cu.client_id WHERE cu.email = ? AND cu.active = 1 AND cl.archived = 0').get(e);
    if (!u && !c) return false;
    // not someone who never joined: their invite is the way in
    if (u && u.invited_at && !u.joined_at) { await ctx.sendInvite(u.id, null); return true; }
    const token = makeLink(u ? 'reset' : 'client_reset', u ? u.id : c.id, null, 30 * MIN);
    await ctx.mail('reset', e, { name: (u || c).name.split(' ')[0], link: `${base()}/#reset?t=${token}` });
    audit(u || null, 'password.reset_sent', u ? u.id : null, e);
    return true;
  };
  const resetHits = new Map();
  route('POST', '/api/auth/forgot', async ({ req, body }) => {
    const ip = clientIp(req), t = ctx.now();
    const a = resetHits.get(ip) || { n: 0, at: t };
    if (t - a.at > 15 * MIN) { a.n = 0; a.at = t; }
    a.n++; resetHits.set(ip, a);
    need(a.n <= 8, 429, 'Too many tries. Wait a few minutes.');
    need(ctx.mail, 400, 'Email isn’t set up on this server. Ask the owner to reset your password from People.');
    const email = str(body.email, 'email', 200).trim().toLowerCase();
    await ctx.requestReset(email);
    return { ok: true };   // the same answer either way, so nobody learns who works here
  }, { open: true });

  // the sign-in page names the company (and shows its icon) before anyone signs in
  route('GET', '/api/auth/company', () => {
    const c = ctx.companyPublic ? ctx.companyPublic() : {};
    const acc = T ? T.row() : null;
    return {
      name: orgName(), address: T ? T.host() : null, apex: T ? T.apex() : null, icon: (c.icon && c.icon.url) || null, brand: c.brand_now || null,
      forgot: !!ctx.mail, closed: !!(acc && acc.status === 'closed'),
    };
  }, { open: true });

  // what a link is for, so its page can greet the person
  route('GET', '/api/auth/link', ({ query }) => {
    const l = findLink(query.get('t'), ['invite', 'reset', 'client_reset', 'handover']);
    if (l.kind === 'client_reset') {
      const c = db.prepare('SELECT name, email FROM client_users WHERE id = ?').get(l.user_id);
      return { kind: 'reset', name: c.name, email: c.email, company: orgName() };
    }
    const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(l.user_id);
    const by = l.created_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(l.created_by) : null;
    return {
      kind: l.kind, name: u.name, email: u.email, company: orgName(), inviter: by ? by.name : null, address: T ? T.host() : null,
      tracked: { screenshots: shotsOn(), shots_per_10: shotsOn() ? cfg.shotsPer10 : 0, activity: true },
    };
  }, { open: true });

  route('POST', '/api/auth/reset', ({ body }) => {
    const l = findLink(body.token, ['reset', 'client_reset']);
    const password = str(body.password, 'password', 200);
    const client = l.kind === 'client_reset';
    const who = db.prepare(client ? 'SELECT * FROM client_users WHERE id = ?' : 'SELECT * FROM users WHERE id = ?').get(l.user_id);
    need(who && who.active, 403, 'This account is turned off');
    const bad = passwordProblem(password, who);
    need(!bad, 400, bad);
    const { salt, hash } = hashPassword(password);
    useLink(l);
    if (client) {
      db.prepare('UPDATE client_users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, who.id);
      db.prepare('DELETE FROM client_sessions WHERE client_user_id = ?').run(who.id);
      const full = db.prepare('SELECT cu.*, cl.name AS client_name FROM client_users cu JOIN clients cl ON cl.id = cu.client_id WHERE cu.id = ?').get(who.id);
      return { token: newSession(who.id, true), user: publicClient(full) };
    }
    db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, who.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(who.id);   // signed out everywhere else, the desktop app too
    audit(who, 'password.reset', who.id);
    return { token: newSession(who.id), user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(who.id)) };
  }, { open: true });

  route('POST', '/api/join', ({ body }) => {
    const l = findLink(body.token, ['invite']);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(l.user_id);
    need(u && u.active, 403, 'This account was turned off. Ask whoever invited you.');
    need(body.agree === true, 400, 'Tick the box to say you’ve read what the company can see');
    const name = body.name != null ? str(body.name, 'name', 100).trim() : u.name;
    need(name.length >= 2, 400, 'Type your name');
    const password = str(body.password, 'password', 200);
    const bad = passwordProblem(password, { ...u, name });
    need(!bad, 400, bad);
    const { salt, hash } = hashPassword(password);
    useLink(l);
    db.prepare('UPDATE users SET name = ?, pw_salt = ?, pw_hash = ?, joined_at = ? WHERE id = ?').run(name, salt, hash, nowIso(), u.id);
    audit({ id: u.id, name }, 'user.joined', u.id, 'Accepted the invite and read what is tracked');
    emit('users', u.id);
    return { token: newSession(u.id), user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) };
  }, { open: true });

  // the owner arriving from sign-up on the plain address
  route('POST', '/api/auth/handoff', ({ body }) => {
    need(T, 404, 'Not used on this server');
    const userId = T.takeHandoff(String(body.code || ''));
    need(userId, 401, 'That sign-in link ran out. Sign in with your email and password.');
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    need(u, 401, 'Sign in with your email and password');
    audit(u, 'login', u.id, 'from sign-up');
    return { token: newSession(u.id), user: publicUser(u) };
  }, { open: true });

  // ---------- who runs the company; handing it over ----------
  const realOwner = (user) => { need(user.role === 'owner' && !user.dev_owner, 403, 'Only the owner can do this'); };
  route('GET', '/api/account', ({ user }) => {
    ctx.needManager(user);
    const owner = db.prepare("SELECT id, name, email FROM users WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1").get();
    const admins = db.prepare("SELECT u.id, u.name, u.email, u.hr FROM users u WHERE u.role = 'manager' AND u.active = 1 AND NOT EXISTS (SELECT 1 FROM manager_teams m WHERE m.user_id = u.id) ORDER BY u.name").all();
    const managers = db.prepare("SELECT COUNT(*) AS n FROM users u WHERE u.role = 'manager' AND u.active = 1 AND EXISTS (SELECT 1 FROM manager_teams m WHERE m.user_id = u.id)").get().n;
    const pending = db.prepare("SELECT l.user_id, l.expires_at, u.name FROM email_links l JOIN users u ON u.id = l.user_id WHERE l.kind = 'handover' AND l.used_at IS NULL AND l.expires_at > ?").get(nowIso());
    return {
      name: orgName(), address: T ? T.host() : null, url: base() || null, service: !!T,
      owner, admins: admins.map((a) => ({ ...a, hr: !!a.hr })), team_managers: managers, handover: pending || null,
      pay_currency: ctx.homeCurrency(), currencies: require('../lib/money').CURRENCIES, tz_name: cfg.tzName || null, mail: !!ctx.mail,
      can_handover: user.role === 'owner' && !user.dev_owner, export: exportState(),
    };
  });
  route('POST', '/api/account/handover', async ({ user, body }) => {
    realOwner(user);
    need(ctx.mail, 400, 'Email isn’t set up on this server');
    const to = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1 AND role = 'manager'").get(Number(body.user_id));
    need(to, 400, 'Choose an admin to hand over to');
    need(to.joined_at || !to.invited_at, 400, `${to.name} hasn’t joined yet`);
    // one handover at a time: asking someone new takes back any earlier offer
    db.prepare("UPDATE email_links SET used_at = ? WHERE kind = 'handover' AND used_at IS NULL").run(nowIso());
    const token = makeLink('handover', to.id, user.id, 7 * DAY);
    await ctx.mail('handover', to.email, { name: to.name.split(' ')[0], from: user.name, link: `${base()}/#handover?t=${token}` });
    audit(user, 'owner.handover_asked', to.id, to.name);
    return { ok: true };
  });
  route('POST', '/api/account/handover/cancel', ({ user }) => {
    realOwner(user);
    db.prepare("UPDATE email_links SET used_at = ? WHERE kind = 'handover' AND used_at IS NULL").run(nowIso());
    return { ok: true };
  });
  route('POST', '/api/account/handover/accept', ({ user, body }) => {
    const l = findLink(body.token, ['handover']);
    need(user && user.id === l.user_id && user.role === 'manager', 403, 'Sign in as the person this was sent to');
    const old = db.prepare("SELECT * FROM users WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1").get();
    // only an offer from whoever owns the company now counts
    need(old && l.created_by === old.id, 410, 'This handover is no longer open');
    useLink(l);
    db.prepare("UPDATE email_links SET used_at = ? WHERE kind = 'handover' AND used_at IS NULL").run(nowIso());
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE users SET role = 'owner', tracks_time = 0 WHERE id = ?").run(user.id);
      db.prepare('DELETE FROM manager_teams WHERE user_id = ?').run(user.id);
      if (old) db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run(old.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (T) T.ownerChanged(user.email, user.name);
    audit(user, 'owner.changed', user.id, old ? `from ${old.name}` : '');
    emit('users', user.id); if (old) emit('users', old.id);
    return { ok: true };
  });
  route('PUT', '/api/account', ({ user, body }) => {
    ctx.needOwner(user);
    if (body.name != null) {
      const name = str(body.name, 'name', 80).trim();
      need(name.length >= 2, 400, 'Type the company’s name');
      ctx.saveSetting('orgName', name);
      if (T) T.renamed(name);
    }
    if (body.pay_currency != null) { need(require('../lib/money').validCurrency(body.pay_currency), 400, 'Choose a currency from the list'); ctx.saveSetting('payCurrency', body.pay_currency); }
    audit(user, 'company.updated', null, JSON.stringify(body).slice(0, 200));
    emit('settings');
    return { ok: true };
  });

  // ---------- billing (the owner, on the service) ----------
  const billingOwner = (user) => { realOwner(user); need(T, 404, 'Billing isn’t used on this server'); };
  const planArgs = (b) => [String(b.plan || ''), String(b.interval || '')];
  route('GET', '/api/billing', ({ user }) => { billingOwner(user); return T.billing(); });
  route('POST', '/api/billing/checkout', async ({ user, body }) => { billingOwner(user); const r = await T.checkout(...planArgs(body)); audit(user, 'billing.checkout', null, `${body.plan} ${body.interval}`); return r; });
  route('POST', '/api/billing/portal', async ({ user }) => { billingOwner(user); return T.portal(); });
  route('POST', '/api/billing/preview', async ({ user, body }) => { billingOwner(user); return T.previewChange(...planArgs(body)); });
  route('POST', '/api/billing/change', async ({ user, body }) => { billingOwner(user); const r = await T.changePlan(...planArgs(body)); audit(user, 'billing.plan', null, `${body.plan} ${body.interval}`); emit('settings'); return r; });
  route('POST', '/api/billing/retry', async ({ user }) => { billingOwner(user); return T.retry(); });
  route('POST', '/api/billing/close', async ({ user, body }) => {
    billingOwner(user);
    need(String(body.confirm || '').trim().toLowerCase() === T.slug, 400, `Type ${T.slug} to confirm`);
    audit(user, 'account.close', null, 'Asked to close the account');
    return T.close();
  });
  route('POST', '/api/billing/reopen', async ({ user }) => { billingOwner(user); audit(user, 'account.reopen'); return T.reopen(); });

  // ---------- everything, to take away ----------
  const exportDir = path.join(cfg.dataDir, 'exports');
  let building = null;
  function exportState() {
    let files = [];
    try { files = fs.readdirSync(exportDir).filter((f) => f.endsWith('.zip')).map((f) => ({ f, st: fs.statSync(path.join(exportDir, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs); } catch { /* none */ }
    const last = files[0];
    return { building: !!building, error: building === false ? null : undefined, ready: last ? { file: last.f, bytes: last.st.size, at: last.st.mtime.toISOString() } : null };
  }
  function buildExport() {
    fs.mkdirSync(exportDir, { recursive: true });
    const name = `staffwarden-${(T ? T.slug : 'export')}-${new Date(ctx.now()).toISOString().slice(0, 10)}.zip`;
    const tmp = path.join(exportDir, `${name}.part`);
    const zip = createZip(tmp);
    // every table as a sheet (passwords, sign-ins and links left out)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name).filter((t) => !SECRET_TABLES.has(t));
    const sheets = [];
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name).filter((c) => !SECRET_COLS.test(c));
      if (!cols.length) continue;
      let rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}" LIMIT 1000000`).all();
      if (t === 'settings' && cols.includes('key')) rows = rows.filter((r) => !SECRET_SETTINGS.has(String(r.key)));
      sheets.push({ name: t.slice(0, 31), cols: cols.map(() => 18), rows: [cols.map((c) => ({ v: c, s: 'head' })), ...rows.map((r) => cols.map((c) => (r[c] == null ? '' : typeof r[c] === 'number' ? r[c] : String(r[c]).slice(0, 32000))))], freeze: 1 });
    }
    zip.add(`${T ? T.slug : 'company'}-data.xlsx`, workbook(sheets, { title: `${orgName()}: everything in Staffwarden` }));
    zip.add('READ ME.txt', `Everything ${orgName()} kept in Staffwarden, taken on ${new Date(ctx.now()).toUTCString()}.\n\nThe spreadsheet has one sheet per kind of record (people, time, attendance, time off, pay and more).\nThe folders hold the files: screenshots, HR documents, task and note attachments, company pictures.\nPasswords and sign-ins are not included.\n`, { deflate: true });
    const skip = new Set(['exports', 'downloads', 'companies', 'platform', 'removed', 'backups']);
    const walk = (dir, rel) => {
      let names = []; try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        const full = path.join(dir, n), r = rel ? `${rel}/${n}` : n;
        const st = fs.statSync(full);
        if (st.isDirectory()) { if (!rel && skip.has(n)) continue; walk(full, r); } else if (rel) zip.add(`files/${r}`, fs.readFileSync(full));
      }
    };
    walk(cfg.dataDir, '');
    zip.close();
    for (const f of fs.readdirSync(exportDir)) if (f !== `${name}.part` && f.endsWith('.zip')) fs.unlinkSync(path.join(exportDir, f));
    fs.renameSync(tmp, path.join(exportDir, name));
  }
  route('POST', '/api/account/export', ({ user }) => {
    ctx.needOwner(user);
    if (building) return exportState();
    building = true;
    setImmediate(() => {
      try { buildExport(); audit(user, 'account.export', null, 'Everything downloaded as a zip'); } catch (e) { console.error('export', e); }
      building = null;
      emit('settings');
    });
    return { ...exportState(), building: true };
  });
  route('GET', '/api/account/export', ({ user }) => { ctx.needOwner(user); return exportState(); });
  route('GET', '/api/account/export/file', ({ user }) => {
    ctx.needOwner(user);
    const s = exportState();
    need(s.ready, 404, 'Make the download first');
    return { streamFile: path.join(exportDir, s.ready.file), name: s.ready.file, type: 'application/zip' };
  });
};
