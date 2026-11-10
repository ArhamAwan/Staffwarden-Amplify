'use strict';
// Staffwarden as a service: every company gets its own address (northwind.staffwarden.com) and its own
// database, and runs the same app the single-company install runs. This file is the front door: it reads
// the address each request was made to and hands the request to that company's app. The plain address
// (staffwarden.com) is the public website, sign-up and "find your company"; admin.<domain> is your console.
//
// A company's app never sees another company's data: each one is a separate app with its own database
// file, folders, sign-ins and live connections. The platform keeps only accounts and billing.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../app');
const { hashPassword, verifyPassword, newToken, tokenHash, passwordProblem } = require('../auth');
const { HttpError, need, str } = require('../lib/http');
const { openStore } = require('./store');
const { createMailer, money, shortDay } = require('./mail');
const { createStripe } = require('./stripe');
const P = require('./plans');
const { COUNTRIES, byCode } = require('./countries');
const { LISTS } = require('../lib/holidays');
const T = require('../lib/time');

const DAY = 86400000;
const RESERVED = new Set(['www', 'admin', 'api', 'app', 'apps', 'help', 'mail', 'email', 'smtp', 'status', 'support', 'docs', 'blog', 'staffwarden', 'billing', 'signup', 'signin', 'login', 'static', 'assets', 'cdn', 'dl', 'download', 'downloads', 'console', 'dashboard', 'about', 'root', 'test', 'dev', 'staging', 'ns1', 'ns2', 'ftp', 'webmail', 'portal', 'secure', 'account', 'accounts', 'my', 'team', 'teams', 'demo', 'owner', 'security', 'legal', 'privacy', 'terms']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const code6 = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.webm': 'video/webm', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function createPlatform(opts) {
  const now = opts.now || Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const webDir = opts.webDir || path.join(__dirname, '..', '..', 'web');
  const root = opts.dataDir;
  const companiesDir = path.join(root, 'companies');
  const platformDir = path.join(root, 'platform');
  fs.mkdirSync(companiesDir, { recursive: true }); fs.mkdirSync(platformDir, { recursive: true });
  const store = openStore(path.join(platformDir, 'platform.db'));
  const base = String(opts.baseDomain || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  const scheme = opts.scheme || 'https';
  const portPart = opts.publicPort ? `:${opts.publicPort}` : '';
  const apexUrl = `${scheme}://${base}${portPart}`;
  const urlOf = (slug) => `${scheme}://${slug}.${base}${portPart}`;
  const hostOf = (slug) => `${slug}.${base}`;
  const adminEmails = new Set(String(opts.adminEmails || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const mailer = opts.mailer || createMailer({ smtpConfig: opts.smtp, base: apexUrl, store, now });
  const stripe = createStripe({ secretKey: opts.stripe && opts.stripe.secretKey, webhookSecret: opts.stripe && opts.stripe.webhookSecret, fetchImpl: opts.fetchImpl || fetch, now });
  const prices = (opts.stripe && opts.stripe.prices) || {};   // { 'business:year': 'price_...' }
  const priceId = (plan, interval) => prices[`${plan}:${interval}`] || null;
  const planOfPrice = (id) => { for (const [k, v] of Object.entries(prices)) if (v === id) { const [plan, interval] = k.split(':'); return { plan, interval }; } return null; };
  const log = opts.log || console;

  const row = (slug) => store.prepare('SELECT * FROM companies WHERE slug = ?').get(slug);
  const event = (slug, kind, detail = null) => store.prepare('INSERT INTO company_events (slug, at, kind, detail) VALUES (?,?,?,?)').run(slug, iso(), kind, detail == null ? null : String(detail).slice(0, 400));
  const setRow = (slug, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    store.prepare(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE slug = ?`).run(...keys.map((k) => fields[k]), slug);
  };
  const reminders = (r) => { try { return JSON.parse(r.reminders || '{}') || {}; } catch { return {}; } };
  const remind = (slug, key) => { const r = row(slug); const m = reminders(r); m[key] = iso(); setRow(slug, { reminders: JSON.stringify(m) }); };

  // ---------------- each company's app ----------------
  const tenants = new Map(); // slug -> app
  const dlDir = opts.dlDir || path.join(root, 'downloads');
  const appOpts = opts.appOpts || {};

  // what a company's own app may do right now, given its account
  const paused = (r) => r.status === 'paused' || r.status === 'closed' || r.status === 'deleted';
  const effectivePlan = (r) => (r.status === 'trial' || r.comped ? 'pro' : r.plan);
  const allows = (r, feature) => P.planHas(effectivePlan(r), feature);
  const ALWAYS_GET = [/^\/api\/tasks\/summary$/, /^\/api\/client-inbox$/, /^\/api\/screenshots(\/|$)/];
  const SOFT_EMPTY = [/^\/api\/projects$/, /^\/api\/tasks$/];
  const TRACK_WRITE = [/^\/api\/timer\/(start|resume)$/, /^\/api\/activity$/, /^\/api\/screenshots$/];

  function hooksFor(slug) {
    let seatTimer = null;
    const hooks = {
      slug,
      host: () => hostOf(slug),
      url: () => urlOf(slug),
      apex: () => apexUrl,
      row: () => row(slug),
      allows: (feature) => allows(row(slug), feature),
      paused: () => paused(row(slug)),
      // installers are shared by every company on the server: only the operator's own company publishes them
      releases: () => !!defaultSlug && slug === defaultSlug,
      gate(pathname, method, user) {
        const r = row(slug);
        if (!r) return { status: 404, message: 'This company is no longer on Staffwarden' };
        // a closed account: only the owner can still sign in, to look and take the data away
        if (r.status === 'closed' && user && !(user.role === 'owner' && !user.dev_owner && user.kind !== 'client')) return { status: 403, message: `${r.name}’s Staffwarden account is closed.`, extra: { closed: true, company: r.name } };
        if (method === 'POST' && TRACK_WRITE.some((re) => re.test(pathname)) && paused(r)) {
          return { status: 403, message: r.status === 'closed' ? `${r.name}’s Staffwarden account is closed, so tracking is off.` : `Tracking is paused at ${r.name}. The account needs attention, and the owner already knows.`, extra: { paused: true } };
        }
        const f = P.featureOf(pathname);
        if (f && !allows(r, f) && !(method === 'GET' && ALWAYS_GET.some((re) => re.test(pathname)))) {
          // the desktop app asks for projects and tasks to offer while tracking: on a plan without them, none
          if (method === 'GET' && SOFT_EMPTY.some((re) => re.test(pathname))) return { soft: [] };
          if (user && user.kind === 'client') return { status: 403, message: 'The client portal isn’t available right now. Ask your contact at the agency.' };
          return { status: 403, message: `${P.PLANS[P.FEATURES[f]].name} plan feature: ${r.name} is on ${P.PLANS[r.plan].name}. The owner can change plans in Settings › Billing.`, extra: { plan_feature: f } };
        }
        return null;
      },
      publicInfo(u) {
        const r = row(slug);
        if (!r) return null;
        const t = now();
        const out = { slug, address: hostOf(slug), url: urlOf(slug), status: r.status, paused: paused(r), plan: effectivePlan(r), features: P.featuresOf(effectivePlan(r)) };
        if (u && u.role === 'owner' && !u.dev_owner) {
          Object.assign(out, {
            billing: true, chosen_plan: r.plan, interval: r.interval, comped: !!r.comped,
            trial_ends_at: r.trial_ends_at, trial_days_left: r.status === 'trial' && r.trial_ends_at ? Math.max(0, Math.ceil((Date.parse(r.trial_ends_at) - t) / DAY)) : null,
            has_card: !!r.stripe_subscription, grace_ends_at: r.grace_ends_at, closing_at: r.closing_at, delete_after: r.delete_after,
          });
        }
        return out;
      },
      onUsersChanged() { clearTimeout(seatTimer); seatTimer = setTimeout(() => { syncSeats(slug).catch((e) => log.error('seats', slug, e.message)); }, opts.seatDelayMs ?? 1500); if (seatTimer.unref) seatTimer.unref(); },
      takeHandoff(code) { return takeHandoff(slug, code); },
      // billing and the account, for the owner's Settings › Billing and Company
      billing: () => billingInfo(slug),
      checkout: (plan, interval) => checkout(slug, plan, interval),
      portal: () => portal(slug),
      previewChange: (plan, interval) => changePlan(slug, plan, interval, true),
      changePlan: (plan, interval) => changePlan(slug, plan, interval, false),
      retry: () => retryPayment(slug),
      close: () => closeCompany(slug),
      reopen: () => reopenCompany(slug),
      ownerChanged: (email, name) => { setRow(slug, { owner_email: email, owner_name: name }); event(slug, 'owner.changed', `${name} <${email}>`); },
      renamed: (name) => { setRow(slug, { name }); event(slug, 'renamed', name); },
    };
    return hooks;
  }
  // email a company's own app sends (invites, password resets, handing over ownership)
  const tenantMail = (slug) => (kind, to, data) => {
    const r = row(slug);
    return mailer.send(kind, to, { ...data, company: (r && r.name) || data.company, host: hostOf(slug), url: urlOf(slug) }, slug);
  };

  function loadTenant(r) {
    if (tenants.has(r.slug)) return tenants.get(r.slug);
    const dir = r.data_dir || path.join(companiesDir, r.slug);
    const app = createApp({ ...appOpts, dataDir: dir, dbFile: path.join(dir, 'tracker.db'), webDir, dlDir, now, tenant: hooksFor(r.slug), mail: tenantMail(r.slug), publicUrl: urlOf(r.slug) });
    tenants.set(r.slug, app);
    return app;
  }
  const tenantApp = (slug) => { const r = row(slug); if (!r || r.status === 'deleted') return null; return loadTenant(r); };

  // the company that ran on this server before it became a service: kept where it is, free, never paused
  let defaultSlug = null;
  if (opts.defaultTenant && opts.defaultTenant.slug) {
    const d = opts.defaultTenant;
    defaultSlug = d.slug;
    if (!row(d.slug)) {
      store.prepare(`INSERT INTO companies (slug, name, country, owner_email, owner_name, data_dir, status, plan, interval, comped, created_at) VALUES (?,?,?,?,?,?,'active','pro','year',1,?)`)
        .run(d.slug, d.name || d.slug, d.country || 'PK', d.ownerEmail || '', d.ownerName || '', d.dataDir, iso());
      event(d.slug, 'created', 'The company that was on this server first');
    }
    const app = tenantApp(d.slug);
    const owner = app && app.db.prepare("SELECT email, name FROM users WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1").get();
    if (owner && !row(d.slug).owner_email) setRow(d.slug, { owner_email: owner.email, owner_name: owner.name });
    // its name as the company itself saved it
    if (app && app.ctx.cfg.orgName && row(d.slug).name !== app.ctx.cfg.orgName) setRow(d.slug, { name: app.ctx.cfg.orgName });
  }
  for (const r of store.prepare("SELECT * FROM companies WHERE status != 'deleted'").all()) loadTenant(r);

  // ---------------- seats ----------------
  const countSeats = (slug) => { const app = tenantApp(slug); return app ? app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role != 'owner' AND NOT (invited_at IS NOT NULL AND joined_at IS NULL)").get().n : 0; };
  async function syncSeats(slug) {
    const r = row(slug);
    if (!r) return;
    const n = countSeats(slug);
    if (n !== r.seats) setRow(slug, { seats: n });
    if (stripe.ready && r.stripe_subscription && r.stripe_item && (r.status === 'active' || r.status === 'trial' || r.status === 'past_due') && n !== r.billed_seats && !r.closing_at) {
      await stripe.call('POST', `/subscription_items/${r.stripe_item}`, { quantity: Math.max(1, n), proration_behavior: 'create_prorations' });
      setRow(slug, { billed_seats: n });
      event(slug, 'seats', `${n} people`);
    }
  }

  // ---------------- signing in from another address ----------------
  // The sign-up page lives on the plain address; the new owner continues signed in on the company's own
  // address. A one-time code, good for two minutes, carries them over (never a password or a session).
  const handoffs = new Map();
  function makeHandoff(slug, userId) { const code = newToken(); handoffs.set(sha(code), { slug, userId, exp: now() + 120000 }); return code; }
  function takeHandoff(slug, code) {
    const k = sha(code || ''), h = handoffs.get(k);
    handoffs.delete(k);
    if (!h || h.slug !== slug || h.exp < now()) return null;
    return h.userId;
  }

  // ---------------- rate limits ----------------
  const hits = new Map();
  function limit(key, max, windowMs) {
    const t = now(); let a = hits.get(key);
    if (!a || a.reset < t) { a = { n: 0, reset: t + windowMs }; hits.set(key, a); }
    a.n++;
    need(a.n <= max * (opts.limitScale || 1), 429, 'Too many tries. Wait a few minutes and try again.');
  }
  setInterval(() => { const t = now(); for (const [k, a] of hits) if (a.reset < t) hits.delete(k); for (const [k, h] of handoffs) if (h.exp < t) handoffs.delete(k); }, 10 * 60000).unref();
  // the visitor's address, by the same rules as a company's app: the Worker's address only with its
  // secret, otherwise what Caddy passes on (Caddy sets X-Forwarded-For itself, see deploy/service.sh)
  const PROXY_SECRET = String(opts.proxySecret || (opts.appOpts && opts.appOpts.proxySecret) || '');
  function ipOf(req) {
    const direct = req.socket.remoteAddress || '';
    const local = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
    if (local && PROXY_SECRET.length >= 24) {
      const got = Buffer.from(String(req.headers['x-workhelm-proxy'] || '')), want = Buffer.from(PROXY_SECRET);
      if (got.length === want.length && require('node:crypto').timingSafeEqual(got, want)) { const ip = String(req.headers['x-workhelm-client-ip'] || '').trim(); if (/^[0-9a-f.:]{3,45}$/i.test(ip)) return ip; }
    }
    return (local ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || direct;
  }

  // ---------------- companies people belong to ----------------
  function companiesOf(email) {
    const e = String(email || '').trim().toLowerCase();
    const out = [];
    for (const r of store.prepare("SELECT slug, name, status FROM companies WHERE status NOT IN ('deleted') ORDER BY name").all()) {
      const app = tenantApp(r.slug);
      if (!app) continue;
      // only places the person actually joined: an invite someone else sent doesn't list (or reset) anything
      const staff = app.db.prepare('SELECT 1 FROM users WHERE email = ? AND active = 1 AND NOT (invited_at IS NOT NULL AND joined_at IS NULL)').get(e);
      const client = !staff && app.db.prepare('SELECT 1 FROM client_users cu JOIN clients c ON c.id = cu.client_id WHERE cu.email = ? AND cu.active = 1 AND c.archived = 0').get(e);
      if (!staff && !client) continue;
      const last = staff ? (app.db.prepare('SELECT MAX(s.last_used_at) AS t FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?').get(e) || {}).t : null;
      out.push({ slug: r.slug, name: r.name, address: hostOf(r.slug), url: urlOf(r.slug), kind: staff ? 'staff' : 'client', _t: last || '' });
    }
    // the one used most recently first; when someone last signed in stays private
    return out.sort((a, b) => (a._t < b._t ? 1 : a._t > b._t ? -1 : 0)).map(({ _t, ...c }) => c);
  }

  // ---------------- sign-up ----------------
  function validSlug(slug) {
    if (!SLUG_RE.test(slug) || slug.includes('--')) return 'Use 3 to 32 letters, numbers and dashes, starting and ending with a letter or number';
    if (RESERVED.has(slug)) return 'That address is reserved. Try another';
    if (row(slug) || fs.existsSync(path.join(companiesDir, slug))) return 'That address is taken. Try another';
    return null;
  }
  const slugify = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-(inc|llc|ltd|limited|pvt|private|co|company|corp)$/g, '').slice(0, 32).replace(/-+$/g, '');
  function suggestSlug(name) {
    let s = slugify(name);
    if (s.length < 3) s = `${s}team`.slice(0, 32);
    if (!validSlug(s)) return s;
    for (let i = 2; i < 50; i++) { const t = `${s.slice(0, 28)}-${i}`; if (!validSlug(t)) return t; }
    return '';
  }
  const signupOf = (token) => store.prepare('SELECT * FROM signups WHERE token = ?').get(sha(token || ''));

  async function sendCode(s, name) {
    const code = code6();
    store.prepare('UPDATE signups SET code_hash = ?, code_sent_at = ?, code_expires_at = ?, tries = 0 WHERE id = ?').run(sha(`${code}|${s.id}`), iso(), iso(now() + 15 * 60000), s.id);
    const r = await mailer.send('code', s.email, { name, code: `${code.slice(0, 3)} ${code.slice(3)}` });
    return { code, mailed: r.sent };
  }

  function createCompany({ slug, name, country, size, owner }) {
    const c = byCode(country) || byCode('OTHER');
    const t = now();
    store.prepare(`INSERT INTO companies (slug, name, country, size, owner_email, owner_name, status, plan, interval, trial_ends_at, created_at) VALUES (?,?,?,?,?,?,'trial','business','year',?,?)`)
      .run(slug, name, c.code, size || null, owner.email, owner.name, iso(t + P.TRIAL_DAYS * DAY), iso(t));
    event(slug, 'created', `${owner.name} <${owner.email}>, ${c.name}`);
    const app = loadTenant(row(slug));
    const ctx = app.ctx;
    ctx.saveSetting('orgName', name);
    if (T.validZone(c.tz)) ctx.saveSetting('tzName', c.tz);
    ctx.saveSetting('payCurrency', require('../lib/money').validCurrency(c.currency) ? c.currency : 'USD');
    if (c.code !== 'PK') ctx.saveSetting('payroll', { ...(ctx.cfg.payroll || {}), tax: { ...(ctx.defaults.payroll.tax), on: false }, eobi: { ...(ctx.defaults.payroll.eobi), on: false } });
    const ownerId = Number(app.db.prepare('INSERT INTO users (email, name, role, pw_salt, pw_hash, tracks_time, created_at, joined_at) VALUES (?,?,?,?,?,0,?,?)')
      .run(owner.email, owner.name, 'owner', owner.salt, owner.hash, iso(t), iso(t)).lastInsertRowid);
    // the country's public holidays from today on, as days off
    const list = c.holidays && LISTS[c.holidays];
    if (list) {
      const today = T.localDay(t, ctx.calc.companyTz());
      for (const [day, hname] of list.days) if (day >= today) app.db.prepare('INSERT OR IGNORE INTO holidays (day, name) VALUES (?,?)').run(day, hname);
    }
    ctx.audit({ id: ownerId, name: owner.name }, 'company.created', ownerId, `${name} at ${hostOf(slug)}`);
    return { app, ownerId };
  }

  // ---------------- billing ----------------
  const yearValue = (plan, interval) => P.seatCents(plan, interval) * (interval === 'month' ? 12 : 1);
  function billingInfo(slug) {
    const r = row(slug);
    const t = now();
    const seats = countSeats(slug);
    if (seats !== r.seats) setRow(slug, { seats });
    const each = P.seatCents(r.plan, r.interval);
    const pays = store.prepare('SELECT at, amount_cents, currency, status, description, seats, period_start, period_end, receipt_url, pdf_url, next_try_at, failure FROM payments WHERE slug = ? ORDER BY at DESC LIMIT 24').all(slug);
    const failed = pays.find((p) => p.status === 'failed');
    let next = null;
    if (r.comped) next = null;
    else if (r.status === 'trial') next = { at: r.trial_ends_at, amount_cents: Math.max(1, seats) * each, seats: Math.max(1, seats) };
    else if (r.status === 'active' && r.paid_through && !r.closing_at) next = { at: r.paid_through, amount_cents: Math.max(1, seats) * P.seatCents(r.pending_plan || r.plan, r.pending_interval || r.interval), seats: Math.max(1, seats) };
    return {
      slug, name: r.name, address: hostOf(slug), status: r.status, plan: r.plan, interval: r.interval, pending_plan: r.pending_plan, pending_interval: r.pending_interval,
      comped: !!r.comped, manual_billing: !!r.manual_billing, seats, owner_email: r.owner_email,
      free: (() => { const app = tenantApp(slug); if (!app) return {}; return { invited: app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND invited_at IS NOT NULL AND joined_at IS NULL").get().n, archived: app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 0").get().n, clients: app.db.prepare('SELECT COUNT(*) AS n FROM client_users WHERE active = 1').get().n }; })(),
      keep_days: P.KEEP_DAYS,
      trial_ends_at: r.trial_ends_at, trial_days: P.TRIAL_DAYS,
      trial_day: r.trial_ends_at ? Math.min(P.TRIAL_DAYS, Math.max(0, P.TRIAL_DAYS - Math.ceil((Date.parse(r.trial_ends_at) - t) / DAY))) : null,
      trial_days_left: r.status === 'trial' && r.trial_ends_at ? Math.max(0, Math.ceil((Date.parse(r.trial_ends_at) - t) / DAY)) : null,
      grace_ends_at: r.grace_ends_at, grace_days: P.GRACE_DAYS, paused_at: r.paused_at, closing_at: r.closing_at, closed_at: r.closed_at, delete_after: r.delete_after, paid_through: r.paid_through,
      card: r.card_last4 ? { brand: r.card_brand, last4: r.card_last4, exp: r.card_exp } : null, has_subscription: !!r.stripe_subscription,
      owed: r.status === 'past_due' && failed ? { amount_cents: failed.amount_cents, currency: failed.currency, at: failed.at, next_try_at: failed.next_try_at, failure: failed.failure } : null,
      next, payments: pays, stripe_ready: stripe.ready && !!priceId(r.plan, r.interval),
      plans: P.ORDER.map((k) => ({ id: k, name: P.PLANS[k].name, blurb: P.PLANS[k].blurb, year_cents: P.seatCents(k, 'year'), month_cents: P.seatCents(k, 'month'), features: P.featuresOf(k) })),
    };
  }

  async function ensureCustomer(r) {
    if (r.stripe_customer) return r.stripe_customer;
    const c = await stripe.call('POST', '/customers', { email: r.owner_email, name: r.name, metadata: { slug: r.slug } }, `cust-${r.slug}`);
    setRow(r.slug, { stripe_customer: c.id });
    return c.id;
  }
  async function checkout(slug, plan, interval) {
    need(P.validPlan(plan) && P.validInterval(interval), 400, 'Choose a plan');
    const r = row(slug);
    need(!r.comped, 400, 'This company is free: nothing to pay');
    need(!r.stripe_subscription || ['canceled', 'incomplete_expired'].includes(r.stripe_status), 400, 'You already pay with a card. Use Change plan or Update card.');
    need(stripe.ready && priceId(plan, interval), 503, 'Card payments aren’t switched on yet. Write to us and we’ll set you up by bank transfer.');
    setRow(slug, { plan, interval });
    const customer = await ensureCustomer(row(slug));
    const seats = Math.max(1, countSeats(slug));
    const trialEnd = r.status === 'trial' && r.trial_ends_at ? Math.floor(Date.parse(r.trial_ends_at) / 1000) : 0;
    const s = await stripe.call('POST', '/checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: slug,
      line_items: [{ price: priceId(plan, interval), quantity: seats }],
      subscription_data: { metadata: { slug }, ...(trialEnd > now() / 1000 + 2 * 86400 ? { trial_end: trialEnd } : {}) },
      metadata: { slug }, payment_method_collection: 'always', allow_promotion_codes: 'true',
      success_url: `${urlOf(slug)}/#/settings?tab=billing&done=1`, cancel_url: `${urlOf(slug)}/#/settings?tab=billing`,
    });
    event(slug, 'checkout.started', `${P.PLANS[plan].name}, ${interval}ly, ${seats} people`);
    return { url: s.url };
  }
  async function portal(slug) {
    const r = row(slug);
    need(stripe.ready, 503, 'Card payments aren’t switched on yet.');
    need(r.stripe_customer, 400, 'Add a card first');
    const s = await stripe.call('POST', '/billing_portal/sessions', { customer: r.stripe_customer, return_url: `${urlOf(slug)}/#/settings?tab=billing` });
    return { url: s.url };
  }
  async function changePlan(slug, plan, interval, preview) {
    need(P.validPlan(plan) && P.validInterval(interval), 400, 'Choose a plan');
    const r = row(slug);
    need(!r.comped, 400, 'This company is free: there’s no plan to change');
    const seats = Math.max(1, countSeats(slug));
    const up = yearValue(plan, interval) > yearValue(r.plan, r.interval) || (plan === r.plan && interval === 'year' && r.interval === 'month');
    const same = plan === r.plan && interval === r.interval;
    if (same) return { same: true };
    // no card yet (trial or paused without a subscription): the choice is simply saved for checkout
    if (!r.stripe_subscription) {
      if (!preview) { setRow(slug, { plan, interval, pending_plan: null, pending_interval: null }); event(slug, 'plan.chosen', `${P.PLANS[plan].name}, ${interval}ly`); }
      return { when: 'now', charge_cents: 0, new_cents: seats * P.seatCents(plan, interval), seats, no_card: true };
    }
    // moving down waits for the renewal, so nothing paid for is lost
    if (!up) {
      if (!preview) { setRow(slug, { pending_plan: plan, pending_interval: interval }); event(slug, 'plan.scheduled', `${P.PLANS[plan].name}, ${interval}ly from ${r.paid_through || 'renewal'}`); }
      return { when: 'renewal', at: r.paid_through, charge_cents: 0, new_cents: seats * P.seatCents(plan, interval), seats };
    }
    need(priceId(plan, interval), 503, 'That plan can’t be bought by card yet.');
    const items = { 0: { id: r.stripe_item, price: priceId(plan, interval), quantity: seats } };
    if (preview) {
      let charge = null;
      try {
        const inv = await stripe.call('POST', '/invoices/create_preview', { customer: r.stripe_customer, subscription: r.stripe_subscription, subscription_details: { items, proration_behavior: 'always_invoice' } });
        charge = inv.amount_due;
      } catch (e) {
        // an estimate when Stripe can't preview: the difference for the time left
        const left = r.paid_through ? Math.max(0, (Date.parse(r.paid_through) - now()) / ((r.interval === 'month' ? 30 : 365) * DAY)) : 1;
        charge = Math.round(seats * Math.max(0, P.seatCents(plan, r.interval) - P.seatCents(r.plan, r.interval)) * Math.min(1, left));
      }
      return { when: 'now', charge_cents: charge, new_cents: seats * P.seatCents(plan, interval), seats, renews_at: r.paid_through };
    }
    await stripe.call('POST', `/subscriptions/${r.stripe_subscription}`, { items, proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete', metadata: { slug } });
    setRow(slug, { plan, interval, pending_plan: null, pending_interval: null, billed_seats: seats });
    event(slug, 'plan.changed', `${P.PLANS[plan].name}, ${interval}ly`);
    return { when: 'now', done: true };
  }
  async function retryPayment(slug) {
    const r = row(slug);
    need(stripe.ready && r.stripe_customer, 400, 'There’s no card payment to try again');
    const list = await stripe.call('GET', '/invoices', { customer: r.stripe_customer, status: 'open', limit: 1 });
    need(list.data && list.data.length, 400, 'Nothing is owed right now');
    try { await stripe.call('POST', `/invoices/${list.data[0].id}/pay`, {}); }
    catch (e) { throw new HttpError(402, `The card was declined again${e.message ? `: ${e.message}` : ''}. Update the card and try once more.`); }
    return { ok: true };
  }
  async function closeCompany(slug) {
    const r = row(slug);
    const t = now();
    if (r.stripe_subscription && ['active', 'past_due', 'trialing'].includes(r.stripe_status) && r.status !== 'trial') {
      await stripe.call('POST', `/subscriptions/${r.stripe_subscription}`, { cancel_at_period_end: 'true' });
      const at = r.paid_through || iso(t);
      setRow(slug, { closing_at: at, delete_after: iso(Date.parse(at) + P.KEEP_DAYS * DAY) });
      event(slug, 'closing', `at ${at}`);
      await mailer.send('closing', r.owner_email, { name: r.owner_name || '', company: r.name, url: urlOf(slug), closesAt: at, deleteAfter: iso(Date.parse(at) + P.KEEP_DAYS * DAY) }, slug);
      return { closes_at: at, now: false };
    }
    // a trial (or a card subscription still in its trial), or already paused: it closes now
    if (r.stripe_subscription && stripe.ready) { try { await stripe.call('DELETE', `/subscriptions/${r.stripe_subscription}`); } catch (e) { log.error('cancel', slug, e.message); } }
    markClosed(slug, 'Closed by the owner');
    return { closes_at: iso(t), now: true };
  }
  async function reopenCompany(slug) {
    const r = row(slug);
    need(r.closing_at && !r.closed_at, 400, 'Nothing to undo');
    if (r.stripe_subscription) await stripe.call('POST', `/subscriptions/${r.stripe_subscription}`, { cancel_at_period_end: 'false' });
    setRow(slug, { closing_at: null, delete_after: null });
    event(slug, 'reopened');
    return { ok: true };
  }
  function stopTracking(slug, why) {
    const app = tenantApp(slug);
    if (!app) return;
    const at = iso();
    const running = app.db.prepare('SELECT id, user_id FROM time_entries WHERE ended_at IS NULL').all();
    for (const e of running) {
      app.db.prepare('UPDATE pauses SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(at, e.id);
      app.db.prepare('UPDATE idle_periods SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(at, e.id);
      app.db.prepare("UPDATE time_entries SET ended_at = ?, stop_reason = 'paused' WHERE id = ?").run(at, e.id);
      app.ctx.audit(null, 'timer.stopped', e.user_id, why);
      app.ctx.emit('timer', e.user_id);
    }
    app.ctx.emitAll('me');
  }
  function markPaused(slug, why) {
    const r = row(slug);
    if (paused(r) || r.comped) return;
    setRow(slug, { status: 'paused', paused_at: iso(), delete_after: iso(now() + P.KEEP_DAYS * DAY), grace_ends_at: null });
    event(slug, 'paused', why);
    stopTracking(slug, why);
  }
  function markClosed(slug, why) {
    const t = now();
    setRow(slug, { status: 'closed', closed_at: iso(t), closing_at: null, delete_after: iso(t + P.KEEP_DAYS * DAY) });
    event(slug, 'closed', why);
    stopTracking(slug, why);
    const app = tenantApp(slug);
    if (app) { app.db.prepare('DELETE FROM sessions').run(); app.db.prepare('DELETE FROM client_sessions').run(); app.ctx.emitAll('me'); }
  }
  function markActive(slug, why) {
    const r = row(slug);
    const was = r.status;
    setRow(slug, { status: 'active', grace_ends_at: null, paused_at: null, delete_after: r.closing_at ? r.delete_after : null, closed_at: null, reminders: '{}' });
    if (was !== 'active') { event(slug, 'active', why); const app = tenantApp(slug); if (app) app.ctx.emitAll('me'); }
  }

  // ---------------- Stripe's news ----------------
  async function syncSubscription(subId) {
    const s = await stripe.call('GET', `/subscriptions/${subId}`, { 'expand[0]': 'default_payment_method' });
    const slug = (s.metadata && s.metadata.slug) || (store.prepare('SELECT slug FROM companies WHERE stripe_subscription = ? OR stripe_customer = ?').get(s.id, s.customer) || {}).slug;
    if (!slug || !row(slug)) return null;
    const item = s.items && s.items.data && s.items.data[0];
    const pp = item && item.price ? planOfPrice(item.price.id) : null;
    const pm = s.default_payment_method && s.default_payment_method.card ? s.default_payment_method.card : null;
    const end = s.current_period_end || (item && item.current_period_end);
    setRow(slug, {
      stripe_subscription: s.id, stripe_customer: s.customer, stripe_status: s.status, stripe_item: item ? item.id : null,
      billed_seats: item ? item.quantity : null, paid_through: end ? iso(end * 1000) : null,
      closing_at: s.cancel_at_period_end && end ? iso(end * 1000) : null,
      ...(pp ? { plan: pp.plan, interval: pp.interval } : {}),
      ...(pm ? { card_brand: pm.brand, card_last4: pm.last4, card_exp: `${String(pm.exp_month).padStart(2, '0')}/${String(pm.exp_year).slice(-2)}` } : {}),
    });
    if (s.cancel_at_period_end && end) setRow(slug, { delete_after: iso(end * 1000 + P.KEEP_DAYS * DAY) });
    return { slug, s };
  }
  // An event counts as handled only once everything it changes is done: if anything fails, Stripe is
  // answered with an error and sends it again, and the retry does the work instead of being skipped.
  const inFlight = new Set();
  async function onStripeEvent(ev) {
    if (store.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(ev.id) || inFlight.has(ev.id)) return { duplicate: true };
    inFlight.add(ev.id);
    try {
      const out = await handleStripeEvent(ev);
      store.prepare('INSERT OR IGNORE INTO stripe_events (id, type, at) VALUES (?,?,?)').run(ev.id, ev.type, iso());
      return out;
    } finally { inFlight.delete(ev.id); }
  }
  async function handleStripeEvent(ev) {
    const o = ev.data && ev.data.object;
    if (!o) return {};
    if (ev.type === 'checkout.session.completed' && o.subscription) {
      const r = await syncSubscription(o.subscription);
      if (r) { event(r.slug, 'card.added', `${r.s.status}`); if (r.s.status === 'active') markActive(r.slug, 'Paid at checkout'); }
    } else if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.created') {
      const r = await syncSubscription(o.id);
      if (r && r.s.status === 'active' && row(r.slug).status === 'paused') markActive(r.slug, 'Subscription active');
    } else if (ev.type === 'customer.subscription.deleted') {
      const slug = (store.prepare('SELECT slug FROM companies WHERE stripe_subscription = ?').get(o.id) || {}).slug;
      if (slug) {
        const r = row(slug);
        setRow(slug, { stripe_status: 'canceled' });
        if (r.closing_at) markClosed(slug, 'Closed at the end of what was paid');
        else markPaused(slug, 'The subscription ended');
      }
    } else if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_failed') {
      const slug = (o.subscription_details && o.subscription_details.metadata && o.subscription_details.metadata.slug) || (store.prepare('SELECT slug FROM companies WHERE stripe_customer = ?').get(o.customer) || {}).slug;
      if (!slug || !row(slug)) return {};
      const r = row(slug);
      const line = o.lines && o.lines.data && o.lines.data[0];
      const desc = line ? String(line.description || '').slice(0, 200) : `${P.PLANS[r.plan].name}`;
      const paid = ev.type === 'invoice.paid';
      if (paid && !o.amount_paid && o.billing_reason === 'subscription_create') { if (o.subscription) await syncSubscription(o.subscription); return {}; } // the free part of a trial: nothing was charged
      // Stripe's events can arrive out of order: a failure for an invoice already recorded as paid is old news
      const before = store.prepare('SELECT status FROM payments WHERE stripe_invoice = ?').get(o.id);
      if (!paid && before && before.status === 'paid') return { ok: true, stale: true };
      store.prepare(`INSERT INTO payments (slug, at, amount_cents, currency, status, description, seats, period_start, period_end, stripe_invoice, receipt_url, pdf_url, next_try_at, failure)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stripe_invoice) DO UPDATE SET status = excluded.status, at = excluded.at, next_try_at = excluded.next_try_at, failure = excluded.failure, receipt_url = excluded.receipt_url, pdf_url = excluded.pdf_url`)
        .run(slug, iso((o.status_transitions && o.status_transitions.paid_at ? o.status_transitions.paid_at * 1000 : now())), paid ? o.amount_paid : o.amount_due, o.currency || 'usd', paid ? 'paid' : 'failed', desc, line ? line.quantity : null,
          line && line.period ? iso(line.period.start * 1000) : null, line && line.period ? iso(line.period.end * 1000) : null, o.id, o.hosted_invoice_url || null, o.invoice_pdf || null,
          !paid && o.next_payment_attempt ? iso(o.next_payment_attempt * 1000) : null, !paid ? String((o.last_finalization_error && o.last_finalization_error.message) || '').slice(0, 200) || null : null);
      if (o.subscription) await syncSubscription(o.subscription);
      const card = row(slug).card_last4 ? `${(row(slug).card_brand || 'card').replace(/^\w/, (c) => c.toUpperCase())} ending ${row(slug).card_last4}` : null;
      if (paid) {
        // a paid invoice turns the account back on only while there is a live subscription to keep paying
        // for it (or none at all: billed by hand), and never reopens an account the owner closed
        const now2 = row(slug);
        const live = !now2.stripe_subscription || ['active', 'trialing', 'past_due'].includes(now2.stripe_status);
        if (live && !now2.closed_at && now2.status !== 'closed') markActive(slug, 'Payment received');
        else event(slug, 'payment', 'Paid an invoice of a subscription that has ended: the account stays as it is');
        await mailer.send('receipt', r.owner_email, { company: r.name, amount: o.amount_paid, currency: o.currency || 'usd', description: desc, card, pdf: o.invoice_pdf || o.hosted_invoice_url || null, url: urlOf(slug) }, slug);
      } else {
        const fresh = row(slug);
        const graceEnds = fresh.grace_ends_at || iso(now() + P.GRACE_DAYS * DAY);
        if (fresh.status === 'active' || fresh.status === 'trial') { setRow(slug, { status: 'past_due', grace_ends_at: graceEnds }); event(slug, 'past_due', desc); }
        if (!reminders(fresh)[`fail:${o.id}`]) {
          remind(slug, `fail:${o.id}`);
          await mailer.send('payment_failed', r.owner_email, { name: r.owner_name || '', company: r.name, amount: o.amount_due, currency: o.currency || 'usd', card, graceEnds, url: urlOf(slug) }, slug);
        }
      }
    }
    return { ok: true };
  }

  // ---------------- the daily round: trials, grace, reminders, moves down a plan ----------------
  async function sweep() {
    const t = now();
    for (const r of store.prepare("SELECT * FROM companies WHERE status NOT IN ('deleted') AND comped = 0").all()) {
      const rem = reminders(r);
      const owner = { name: r.owner_name || '', company: r.name, url: urlOf(r.slug) };
      try {
        if (r.status === 'trial' && r.trial_ends_at) {
          const left = Date.parse(r.trial_ends_at) - t;
          if (left <= 3 * DAY && left > 0 && !rem.trial_ending) {
            remind(r.slug, 'trial_ending');
            const app = tenantApp(r.slug);
            const secs = app ? (app.db.prepare("SELECT COALESCE(SUM((julianday(COALESCE(ended_at, ?)) - julianday(started_at)) * 86400), 0) AS s FROM time_entries").get(iso(t)) || {}).s : 0;
            const seats = Math.max(1, countSeats(r.slug));
            await mailer.send('trial_ending', r.owner_email, { ...owner, trialEnds: r.trial_ends_at, hours: secs > 3600 ? Math.round(secs / 3600).toLocaleString('en-US') : null, planName: `${P.PLANS[r.plan].name}`, seats, price: `${money(seats * P.seatCents(r.plan, r.interval))} a ${r.interval}` }, r.slug);
          }
          if (left <= 0 && !r.stripe_subscription && !r.manual_billing) {
            markPaused(r.slug, 'The free trial ended');
            await mailer.send('trial_ended', r.owner_email, { ...owner, deleteAfter: row(r.slug).delete_after }, r.slug);
          }
        }
        if (r.status === 'past_due' && r.grace_ends_at && Date.parse(r.grace_ends_at) <= t) {
          markPaused(r.slug, 'Payment still failing after the grace days');
          await mailer.send('grace_over', r.owner_email, { ...owner, deleteAfter: row(r.slug).delete_after }, r.slug);
        }
        if ((r.status === 'paused' || r.status === 'closed') && r.delete_after) {
          const left = Date.parse(r.delete_after) - t;
          for (const days of [30, 7]) {
            if (left <= days * DAY && left > 0 && !rem[`del${days}`] && !(days === 30 && left <= 7 * DAY)) {
              remind(r.slug, `del${days}`);
              await mailer.send('deletion_warning', r.owner_email, { ...owner, closed: r.status === 'closed', since: r.closed_at || r.paused_at || r.trial_ends_at, deleteAfter: r.delete_after, days }, r.slug);
            }
          }
        }
        if (r.pending_plan && r.stripe_subscription && r.paid_through && Date.parse(r.paid_through) - t <= 2 * DAY && priceId(r.pending_plan, r.pending_interval)) {
          await stripe.call('POST', `/subscriptions/${r.stripe_subscription}`, { items: { 0: { id: r.stripe_item, price: priceId(r.pending_plan, r.pending_interval), quantity: Math.max(1, countSeats(r.slug)) } }, proration_behavior: 'none' });
          setRow(r.slug, { plan: r.pending_plan, interval: r.pending_interval, pending_plan: null, pending_interval: null });
          event(r.slug, 'plan.changed', `${P.PLANS[r.pending_plan].name} at renewal`);
        }
      } catch (e) { log.error('sweep', r.slug, e.message); }
    }
    // when each company was last used (for your console)
    for (const [slug, app] of tenants) {
      try { const t2 = (app.db.prepare('SELECT MAX(last_used_at) AS t FROM sessions').get() || {}).t; if (t2) setRow(slug, { last_used_at: `${t2.replace(' ', 'T')}Z` }); } catch { /* empty */ }
    }
  }
  const sweeper = setInterval(() => { sweep().catch((e) => log.error('sweep', e)); }, opts.sweepMs || 10 * 60000);
  sweeper.unref();

  // ---------------- your console ----------------
  function consoleUser(req) {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    const s = tok && store.prepare('SELECT * FROM console_sessions WHERE token = ?').get(sha(tok));
    need(s && Date.parse(s.created_at) > now() - 12 * 3600000 && adminEmails.has(s.email), 401, 'Sign in to the console');
    return s.email;
  }
  function companyStats(r) {
    const app = tenantApp(r.slug);
    if (!app) return { people: 0, tracked_today: 0 };
    const today = T.localDay(now(), app.ctx.calc.companyTz());
    return {
      people: countSeats(r.slug),
      tracked_today: app.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM time_entries WHERE started_at >= ?').get(iso(now() - DAY)).n,
      day: today,
    };
  }
  // when anyone at the company last used it (their own sign-ins, read live)
  const lastUsed = (r) => {
    const app = tenants.get(r.slug);
    if (!app) return r.last_used_at || null;
    try { const t = (app.db.prepare('SELECT MAX(last_used_at) AS t FROM sessions').get() || {}).t; return t ? `${String(t).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z'}` : r.last_used_at || null; } catch { return r.last_used_at || null; }
  };
  const companyOut = (r) => {
    const each = P.seatCents(r.plan, r.interval);
    const monthly = r.comped ? 0 : Math.round((r.seats || 0) * (r.interval === 'year' ? each / 12 : each));
    const late = store.prepare("SELECT at FROM payments WHERE slug = ? AND status = 'failed' ORDER BY at DESC LIMIT 1").get(r.slug);
    return { slug: r.slug, name: r.name, address: hostOf(r.slug), url: urlOf(r.slug), country: (byCode(r.country) || {}).name || r.country, owner_email: r.owner_email, owner_name: r.owner_name, status: r.status, plan: r.plan, interval: r.interval, seats: r.seats, monthly_cents: ['active', 'past_due'].includes(r.status) ? monthly : 0, after_trial_cents: r.status === 'trial' ? monthly : 0, comped: !!r.comped, manual_billing: !!r.manual_billing, trial_ends_at: r.trial_ends_at, grace_ends_at: r.grace_ends_at, paused_at: r.paused_at, closing_at: r.closing_at, delete_after: r.delete_after, created_at: r.created_at, last_used_at: lastUsed(r), trial_days: P.TRIAL_DAYS, failed_at: late ? late.at : null, due_for_deletion: !!(r.delete_after && Date.parse(r.delete_after) <= now() && paused(r)) };
  };

  // ---------------- the plain address and the console: their API ----------------
  const api = [];
  const on = (method, pattern, handler, o = {}) => { const keys = []; const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`); api.push({ method, re, keys, handler, raw: !!o.raw }); };

  on('GET', '/api/platform/config', () => ({ base_domain: base, apex: apexUrl, trial_days: P.TRIAL_DAYS, countries: COUNTRIES.map((c) => ({ code: c.code, name: c.name, tz: c.tz, money: c.money, currency: c.currency, holidays: !!c.holidays })), plans: P.ORDER.map((k) => ({ id: k, name: P.PLANS[k].name, blurb: P.PLANS[k].blurb, year_cents: P.seatCents(k, 'year'), month_cents: P.seatCents(k, 'month') })), mail: mailer.configured, payments: stripe.ready }));
  on('GET', '/api/platform/legacy', () => ({ url: defaultSlug ? urlOf(defaultSlug) : null }));

  // Without a mail server the code is shown on screen, for trying Staffwarden out on a laptop. On a live
  // server (NODE_ENV=production) sign-up waits until mail works: the code proves the email is yours.
  const showCodes = opts.showCodes ?? process.env.NODE_ENV !== 'production';
  const needMail = () => need(mailer.configured || showCodes, 503, 'Sign-up opens once this server can send email');
  const codeOut = (sent) => (mailer.configured || !showCodes ? {} : { dev_code: sent.code });
  on('POST', '/api/platform/signup/start', async ({ req, body }) => {
    limit(`su:${ipOf(req)}`, 8, 3600000);
    needMail();
    const name = str(body.name, 'name', 100).trim();
    need(name.length >= 2, 400, 'Type your name');
    const email = str(body.email, 'email', 200).trim().toLowerCase();
    need(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email), 400, 'That doesn’t look like an email address');
    limit(`sue:${email}`, 5, 3600000);
    const password = str(body.password, 'password', 200);
    const bad = passwordProblem(password, { email, name });
    need(!bad, 400, bad);
    const { salt, hash } = hashPassword(password);
    const token = newToken();
    const id = Number(store.prepare('INSERT INTO signups (token, email, name, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?)').run(sha(token), email, name, salt, hash, iso()).lastInsertRowid);
    const sent = await sendCode({ id, email }, name);
    return { token, email, ...codeOut(sent) };
  });
  on('POST', '/api/platform/signup/resend', async ({ req, body }) => {
    limit(`sur:${ipOf(req)}`, 10, 3600000);
    const s = signupOf(body.token);
    need(s && !s.slug, 404, 'Start again: that sign-up ran out');
    need(!s.code_sent_at || now() - Date.parse(s.code_sent_at) > 45000, 429, 'Wait a moment before asking for another code');
    needMail();
    const sent = await sendCode(s, s.name);
    return { ok: true, ...codeOut(sent) };
  });
  on('POST', '/api/platform/signup/verify', ({ body }) => {
    const s = signupOf(body.token);
    need(s && !s.slug, 404, 'Start again: that sign-up ran out');
    if (s.verified_at) return { ok: true };
    // a new code resets the per-code count, so the sign-up as a whole also stops after 20 wrong codes
    need((s.wrong_total || 0) < 20, 404, 'Start again: that sign-up had too many wrong codes');
    need(s.tries < 6, 429, 'Too many wrong codes. Ask for a new one.');
    const code = String(body.code || '').replace(/\D/g, '');
    need(code.length === 6, 400, 'The code has 6 digits');
    need(s.code_expires_at && Date.parse(s.code_expires_at) > now(), 400, 'That code ran out. Ask for a new one.');
    if (sha(`${code}|${s.id}`) !== s.code_hash) { store.prepare('UPDATE signups SET tries = tries + 1, wrong_total = wrong_total + 1 WHERE id = ?').run(s.id); throw new HttpError(400, 'That code isn’t right. Check the email and try again.'); }
    store.prepare('UPDATE signups SET verified_at = ? WHERE id = ?').run(iso(), s.id);
    return { ok: true };
  });
  on('GET', '/api/platform/signup/address', ({ query }) => {
    const want = String(query.get('slug') || '').trim().toLowerCase();
    if (want) { const why = validSlug(want); return { slug: want, free: !why, why }; }
    const s = suggestSlug(query.get('name') || '');
    return { slug: s, free: !!s && !validSlug(s), why: s ? validSlug(s) : 'Type a name' };
  });
  on('POST', '/api/platform/signup/company', ({ body }) => {
    const s = signupOf(body.token);
    need(s && s.verified_at, 400, 'Check your email first');
    need(!s.slug, 409, 'Your company is already set up');
    const name = str(body.company, 'company', 80).trim();
    need(name.length >= 2, 400, 'Type the company’s name');
    const slug = str(body.slug, 'slug', 40).trim().toLowerCase();
    const why = validSlug(slug);
    need(!why, 400, why);
    need(byCode(body.country), 400, 'Choose a country');
    const size = ['1-10', '11-50', '51-200', '200+'].includes(body.size) ? body.size : null;
    const { ownerId } = createCompany({ slug, name, country: body.country, size, owner: { email: s.email, name: s.name, salt: s.pw_salt, hash: s.pw_hash } });
    store.prepare('UPDATE signups SET slug = ? WHERE id = ?').run(slug, s.id);
    mailer.send('welcome', s.email, { name: s.name, company: name, host: hostOf(slug), url: urlOf(slug), trialEnds: row(slug).trial_ends_at }, slug).catch(() => {});
    return { slug, url: urlOf(slug), address: hostOf(slug), handoff: makeHandoff(slug, ownerId), trial_ends_at: row(slug).trial_ends_at };
  });

  on('POST', '/api/platform/find', ({ req, body }) => {
    limit(`find:${ipOf(req)}`, 20, 15 * 60000);
    const email = str(body.email, 'email', 200).trim().toLowerCase();
    need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'That doesn’t look like an email address');
    return { companies: companiesOf(email) };
  });
  on('POST', '/api/platform/forgot', async ({ req, body }) => {
    limit(`fg:${ipOf(req)}`, 10, 15 * 60000);
    const email = str(body.email, 'email', 200).trim().toLowerCase();
    for (const c of companiesOf(email)) { const app = tenantApp(c.slug); if (app && app.ctx.requestReset) await app.ctx.requestReset(email).catch(() => {}); }
    return { ok: true };
  });

  on('POST', '/api/platform/stripe/webhook', async ({ req, rawBody }) => {
    need(stripe.verify(rawBody, req.headers['stripe-signature']), 400, 'Bad signature');
    let ev; try { ev = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Bad JSON'); }
    return onStripeEvent(ev);
  }, { raw: true });

  // console
  on('POST', '/api/console/code', async ({ req, body }) => {
    limit(`cc:${ipOf(req)}`, 6, 15 * 60000);
    const email = String(body.email || '').trim().toLowerCase();
    if (adminEmails.has(email)) {
      const code = code6();
      store.prepare('INSERT INTO console_codes (email, code_hash, expires_at, tries) VALUES (?,?,?,0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0').run(email, sha(`${code}|${email}`), iso(now() + 10 * 60000));
      // not awaited: the answer comes back just as fast for an address that isn't an admin
      Promise.resolve().then(() => mailer.send('console_code', email, { code: `${code.slice(0, 3)} ${code.slice(3)}` })).catch(() => {});
    }
    return { ok: true };
  });
  on('POST', '/api/console/login', ({ req, body }) => {
    limit(`cl:${ipOf(req)}`, 10, 15 * 60000);
    const email = String(body.email || '').trim().toLowerCase();
    limit(`cle:${email}`, 15, 3600000);   // per address too, so guesses from many places still add up
    const c = store.prepare('SELECT * FROM console_codes WHERE email = ?').get(email);
    need(c && Date.parse(c.expires_at) > now() && c.tries < 5 && adminEmails.has(email), 400, 'That code isn’t right or ran out');
    if (sha(`${String(body.code || '').replace(/\D/g, '')}|${email}`) !== c.code_hash) { store.prepare('UPDATE console_codes SET tries = tries + 1 WHERE email = ?').run(email); throw new HttpError(400, 'That code isn’t right or ran out'); }
    store.prepare('DELETE FROM console_codes WHERE email = ?').run(email);
    const token = newToken();
    store.prepare('INSERT INTO console_sessions (token, email, created_at) VALUES (?,?,?)').run(sha(token), email, iso());
    return { token, email };
  });
  on('POST', '/api/console/logout', ({ req }) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (tok) store.prepare('DELETE FROM console_sessions WHERE token = ?').run(sha(tok));
    return { ok: true };
  });
  on('GET', '/api/console/overview', ({ req }) => {
    consoleUser(req);
    const rows = store.prepare("SELECT * FROM companies WHERE status != 'deleted' ORDER BY created_at DESC").all();
    for (const r of rows) { const n = countSeats(r.slug); if (n !== r.seats) { setRow(r.slug, { seats: n }); r.seats = n; } }
    const list = rows.map(companyOut);
    const paying = list.filter((c) => ['active', 'past_due'].includes(c.status) && !c.comped);
    const monthAgo = iso(now() - 30 * DAY);
    const before = store.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE status = 'paid' AND at < ? AND at >= ?").get(monthAgo, iso(now() - 60 * DAY)).s;
    const last = store.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE status = 'paid' AND at >= ?").get(monthAgo).s;
    return {
      mrr_cents: paying.reduce((a, c) => a + c.monthly_cents, 0), paid_30d_cents: last, paid_prev_30d_cents: before,
      paying: paying.length, trials: list.filter((c) => c.status === 'trial').length, trials_ending_week: list.filter((c) => c.status === 'trial' && c.trial_ends_at && Date.parse(c.trial_ends_at) - now() < 7 * DAY).length,
      people: paying.reduce((a, c) => a + (c.seats || 0), 0), attention: list.filter((c) => c.status === 'past_due' || c.due_for_deletion).length,
      companies: list, mail: mailer.configured, payments: stripe.ready,
      months: (() => {
        const out = [], d = new Date(now());
        for (let i = 5; i >= 0; i--) {
          const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)), n = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
          out.push({ month: m.toISOString().slice(0, 7),
            paid_cents: store.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE status = 'paid' AND at >= ? AND at < ?").get(m.toISOString(), n.toISOString()).s,
            signups: store.prepare('SELECT COUNT(*) AS n FROM companies WHERE created_at >= ? AND created_at < ?').get(m.toISOString(), n.toISOString()).n });
        }
        return out;
      })(),
    };
  });
  on('GET', '/api/console/companies/:slug', ({ req, params }) => {
    consoleUser(req);
    const r = row(params.slug);
    need(r && r.status !== 'deleted', 404, 'No such company');
    return {
      ...companyOut(r), ...companyStats(r),
      payments: store.prepare('SELECT at, amount_cents, currency, status, description, seats FROM payments WHERE slug = ? ORDER BY at DESC LIMIT 36').all(r.slug),
      events: store.prepare('SELECT at, kind, detail FROM company_events WHERE slug = ? ORDER BY id DESC LIMIT 40').all(r.slug),
      paid_total_cents: store.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE slug = ? AND status = 'paid'").get(r.slug).s,
      mail: store.prepare('SELECT at, kind, to_addr, ok, error FROM mail_log WHERE slug = ? ORDER BY id DESC LIMIT 12').all(r.slug),
    };
  });
  on('POST', '/api/console/companies/:slug/extend', ({ req, params, body }) => {
    const who = consoleUser(req);
    const r = row(params.slug);
    need(r && r.status !== 'deleted', 404, 'No such company');
    const days = Math.round(Number(body.days));
    need(days >= 1 && days <= 60, 400, 'Give 1 to 60 days');
    if (r.status === 'past_due') setRow(r.slug, { grace_ends_at: iso(Math.max(now(), Date.parse(r.grace_ends_at || iso())) + days * DAY) });
    else if (r.status === 'trial' || (r.status === 'paused' && !r.stripe_subscription)) {
      const from = r.status === 'trial' ? Math.max(now(), Date.parse(r.trial_ends_at || iso())) : now();
      setRow(r.slug, { status: 'trial', trial_ends_at: iso(from + days * DAY), paused_at: null, delete_after: null, reminders: '{}' });
      const app = tenantApp(r.slug); if (app) app.ctx.emitAll('me');
    } else throw new HttpError(400, 'Only a trial, a paused trial or a late payment can be given more days');
    event(r.slug, 'extended', `${days} days by ${who}`);
    return companyOut(row(r.slug));
  });
  on('POST', '/api/console/companies/:slug/flags', ({ req, params, body }) => {
    const who = consoleUser(req);
    const r = row(params.slug);
    need(r && r.status !== 'deleted', 404, 'No such company');
    const f = {};
    if (body.comped != null) f.comped = body.comped ? 1 : 0;
    if (body.manual_billing != null) f.manual_billing = body.manual_billing ? 1 : 0;
    setRow(r.slug, f);
    if (f.comped || f.manual_billing) { const fresh = row(r.slug); if (fresh.status === 'paused' && !fresh.closed_at) markActive(r.slug, f.comped ? 'Made free' : 'Paid by bank transfer'); }
    event(r.slug, 'flags', `${JSON.stringify(f)} by ${who}`);
    return companyOut(row(r.slug));
  });
  // a company due for deletion: its folder is moved aside (out of the service), not erased here
  on('POST', '/api/console/companies/:slug/remove', ({ req, params, body }) => {
    const who = consoleUser(req);
    const r = row(params.slug);
    need(r && r.status !== 'deleted', 404, 'No such company');
    need(r.slug !== defaultSlug && !r.comped, 400, 'This company can’t be removed here');
    need(paused(r) && r.delete_after && Date.parse(r.delete_after) <= now(), 400, 'Only a company past its keep date can be removed');
    need(String(body.confirm || '') === r.slug, 400, `Type ${r.slug} to confirm`);
    const app = tenants.get(r.slug);
    if (app) { app.stop(); try { app.db.close(); } catch { /* closed */ } tenants.delete(r.slug); }
    const dir = r.data_dir || path.join(companiesDir, r.slug);
    const removed = path.join(root, 'removed');
    fs.mkdirSync(removed, { recursive: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, path.join(removed, `${r.slug}-${iso().slice(0, 10)}`));
    setRow(r.slug, { status: 'deleted' });
    event(r.slug, 'removed', `by ${who}`);
    return { ok: true };
  });

  // ---------------- pages ----------------
  function serveFile(req, res, file, { cache = 'no-cache', csp = false } = {}) {
    let st; try { st = fs.statSync(file); } catch { st = null; }
    if (!st || st.isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC }); res.end('Not found'); return; }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const h = { 'Content-Type': type, ETag: etag, 'Cache-Control': cache, ...SEC, ...(csp || type.startsWith('text/html') ? { 'Content-Security-Policy': PAGE_CSP } : {}) };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); return; }
    res.writeHead(200, h); res.end(fs.readFileSync(file));
  }
  function serveWeb(req, res, pathname, pages) {
    let rel;
    try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { res.writeHead(400, SEC); res.end(); return; }
    if (pages[`/${rel}`] || pages[pathname]) return serveFile(req, res, path.join(webDir, pages[`/${rel}`] || pages[pathname]));
    const file = path.normalize(path.join(webDir, rel));
    if (!file.startsWith(path.normalize(webDir) + path.sep) || /\.html$/.test(file) && !Object.values(pages).includes(path.basename(file))) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC }); res.end('Not found'); return; }
    const long = file.includes(`${path.sep}fonts${path.sep}`) || file.includes(`${path.sep}vendor${path.sep}`);
    return serveFile(req, res, file, { cache: long ? 'public, max-age=604800' : 'no-cache' });
  }
  function noCompany(res, slug) {
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No company here · Staffwarden</title><link rel="stylesheet" href="/css/start.css"></head><body class="st-body"><main class="st-lost"><img src="/icons/icon-192.png" alt="" width="64" height="64"><h1>There’s no company at ${String(slug).replace(/[^a-z0-9-]/g, '')}.${base}</h1><p>Check the address in your invite, or find your company by email.</p><p><a class="st-btn" href="${apexUrl}/signin">Find your company</a> <a class="st-link" href="${apexUrl}/signup">Start a free trial</a></p></main></body></html>`;
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, ...SEC }); res.end(page);
  }

  async function readBody(req, max = 1024 * 1024) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > max) throw new HttpError(413, 'Too large'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function runApi(req, res, url) {
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC }); res.end(JSON.stringify(payload)); };
    try {
      const r = api.find((x) => x.method === req.method && x.re.test(url.pathname));
      need(r, 404, 'Route not found');
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const rawBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
      let body = {};
      if (!r.raw && rawBody) { try { body = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Invalid JSON'); } }
      send(200, await r.handler({ req, body, rawBody, params, query: url.searchParams }));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (e && e.status && e.message) return send(e.status, { error: e.message });
      log.error(e);
      send(500, { error: 'Something went wrong on our side. Try again in a minute.' });
    }
  }

  const APEX_PAGES = { '/': 'welcome.html', '/welcome': 'welcome.html', '/signup': 'start.html', '/signin': 'start.html', '/forgot': 'start.html' };
  const CONSOLE_PAGES = { '/': 'console.html' };
  const deflt = () => (defaultSlug ? tenantApp(defaultSlug) : null);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const isApex = !base || host === base || host === `www.${base}`;
    const sub = base && host.endsWith(`.${base}`) ? host.slice(0, -base.length - 1) : null;
    // installers are the same for everyone
    if (url.pathname.startsWith('/downloads/') || url.pathname === '/api/downloads' || url.pathname === '/api/app/latest') {
      const a = deflt() || tenants.values().next().value;
      if (a) return a.handle(req, res);
      if (url.pathname === '/api/downloads') { res.writeHead(200, { 'Content-Type': 'application/json', ...SEC }); res.end('[]'); return; }
      res.writeHead(404, SEC); res.end(); return;
    }
    if (sub === 'admin') {
      if (url.pathname.startsWith('/api/console/')) return runApi(req, res, url);
      if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json', ...SEC }); res.end('{"error":"Route not found"}'); return; }
      return serveWeb(req, res, url.pathname, CONSOLE_PAGES);
    }
    if (sub && sub !== 'www') {
      const app = SLUG_RE.test(sub) ? tenantApp(sub) : null;
      if (!app) {
        if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json', ...SEC }); res.end('{"error":"There’s no company at this address"}'); return; }
        if (/\.(css|png|svg|woff2|ico|js)$/.test(url.pathname)) return serveWeb(req, res, url.pathname, {});
        return noCompany(res, sub);
      }
      return app.handle(req, res);
    }
    // the plain address (or an address not under the domain, such as the server's IP)
    if (url.pathname.startsWith('/api/platform/')) return runApi(req, res, url);
    if (!isApex || !base) {
      // not set up as a service yet, or reached by IP: the first company, exactly as before
      const a = deflt();
      if (a) return a.handle(req, res);
    }
    if (url.pathname.startsWith('/api/')) {
      // desktop apps from before companies had their own addresses still talk to the plain address
      const a = deflt();
      if (a) return a.handle(req, res);
      res.writeHead(404, { 'Content-Type': 'application/json', ...SEC }); res.end('{"error":"Route not found"}'); return;
    }
    if (url.pathname === '/index.html' || url.pathname === '/app') { res.writeHead(302, { Location: '/signin', ...SEC }); res.end(); return; }
    return serveWeb(req, res, url.pathname, APEX_PAGES);
  }

  const server = http.createServer(handle);
  const closeServer = server.close.bind(server);
  server.close = (cb) => { clearInterval(sweeper); for (const a of tenants.values()) a.stop(); return closeServer(cb); };

  return { server, handle, store, tenants, tenantApp, row, sweep, onStripeEvent, createCompany, makeHandoff, mailer, urlOf, hostOf, companiesOf, syncSeats, billingInfo };
}

module.exports = { createPlatform, RESERVED };
