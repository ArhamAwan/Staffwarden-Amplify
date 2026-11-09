'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const appOpts = {
  shiftStart: process.env.SHIFT_START || '09:00',
  shiftEnd: process.env.SHIFT_END || '18:00',
  graceMin: num(process.env.GRACE_MIN, 10),
  tzOffsetMin: num(process.env.TZ_OFFSET_MIN, 300),
  weeklyTargetMin: num(process.env.WEEKLY_TARGET_MIN, 2400),
  retentionDays: num(process.env.RETENTION_DAYS, 60),
  shotsPer10: num(process.env.SHOTS_PER_10, 2),
  idleLimitMin: num(process.env.IDLE_LIMIT_MIN, 10),
  proxySecret: process.env.WORKHELM_PROXY_SECRET || '',
};
const BASE_DOMAIN = (process.env.BASE_DOMAIN || '').trim().toLowerCase();
let app, platform = null;
if (BASE_DOMAIN) {
  // the service: every company at its own address, each with its own database (server/platform)
  const { createPlatform } = require('./platform');
  const env = (k) => (process.env[k] || '').trim();
  const prices = {};
  for (const plan of ['starter', 'business', 'pro']) for (const iv of ['month', 'year']) { const v = env(`STRIPE_PRICE_${plan.toUpperCase()}_${iv.toUpperCase()}`); if (v) prices[`${plan}:${iv}`] = v; }
  platform = createPlatform({
    dataDir, baseDomain: BASE_DOMAIN, publicPort: env('PUBLIC_PORT') || null, scheme: env('PUBLIC_SCHEME') || 'https',
    dlDir: path.join(dataDir, 'downloads'), appOpts,
    defaultTenant: env('DEFAULT_TENANT') ? { slug: env('DEFAULT_TENANT'), name: env('ORG_NAME') || env('DEFAULT_TENANT'), dataDir, country: env('DEFAULT_COUNTRY') || 'PK' } : null,
    adminEmails: env('PLATFORM_ADMINS'),
    smtp: env('SMTP_HOST') ? { host: env('SMTP_HOST'), port: Number(env('SMTP_PORT') || 465), user: env('SMTP_USER'), pass: process.env.SMTP_PASS || '', from: env('SMTP_FROM') || env('SMTP_USER') } : null,
    stripe: { secretKey: env('STRIPE_SECRET_KEY'), webhookSecret: env('STRIPE_WEBHOOK_SECRET'), prices },
  });
  app = env('DEFAULT_TENANT') ? platform.tenantApp(env('DEFAULT_TENANT')) : null;
} else {
  app = createApp({
    dbFile: process.env.DB_FILE || path.join(dataDir, 'tracker.db'),
    dataDir,
    orgName: process.env.ORG_NAME || undefined,
    ...appOpts,
    publicUrl: process.env.WORKHELM_PUBLIC_URL || '',
  });
}

const email = process.env.OWNER_EMAIL || 'owner@example.com';
const password = process.env.OWNER_PASSWORD || 'change-me-now';
if (app && password === 'change-me-now') {
  if (process.env.NODE_ENV === 'production') { console.error('Refusing to start in production with the default owner password. Set OWNER_PASSWORD.'); process.exit(1); }
  console.warn('! Using default owner password. Set OWNER_PASSWORD before real use.');
}
if (app) app.seedOwner(email, process.env.OWNER_NAME || 'Owner', password);

// Daily retention sweep for old screenshots (every company's).
const each = (fn) => { if (platform) { for (const a of platform.tenants.values()) fn(a); } else fn(app); };
setInterval(() => each((a) => { const n = a.purgeOld(); if (n) console.log(`Purged ${n} old screenshots`); }), 24 * 3600 * 1000).unref();
each((a) => a.sweepStale());

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || undefined; // 127.0.0.1 behind a reverse proxy; all interfaces otherwise
(platform ? platform.server : app.server).listen(port, host, () => {
  console.log(`Staffwarden running on http://localhost:${port}${platform ? ` as a service for *.${BASE_DOMAIN}` : ''}`);
  // Addresses other computers on the same network can use (for the desktop app's Server field)
  const lan = Object.values(require('node:os').networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}`);
  if (lan.length && !host) console.log(`On your network: ${lan.join('  ')}`);
});
