'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const app = createApp({
  dbFile: process.env.DB_FILE || path.join(dataDir, 'tracker.db'),
  dataDir,
  orgName: process.env.ORG_NAME || 'Amplify Media',
  shiftStart: process.env.SHIFT_START || '09:00',
  shiftEnd: process.env.SHIFT_END || '18:00',
  graceMin: num(process.env.GRACE_MIN, 10),
  tzOffsetMin: num(process.env.TZ_OFFSET_MIN, 300),
  weeklyTargetMin: num(process.env.WEEKLY_TARGET_MIN, 2400),
  retentionDays: num(process.env.RETENTION_DAYS, 60),
  shotsPer10: num(process.env.SHOTS_PER_10, 2),
  idleLimitMin: num(process.env.IDLE_LIMIT_MIN, 10),
  proxySecret: process.env.WORKHELM_PROXY_SECRET || '',
  publicUrl: process.env.WORKHELM_PUBLIC_URL || '',
});

const email = process.env.OWNER_EMAIL || 'owner@example.com';
const password = process.env.OWNER_PASSWORD || 'change-me-now';
if (password === 'change-me-now') {
  if (process.env.NODE_ENV === 'production') { console.error('Refusing to start in production with the default owner password. Set OWNER_PASSWORD.'); process.exit(1); }
  console.warn('! Using default owner password. Set OWNER_PASSWORD before real use.');
}
app.seedOwner(email, process.env.OWNER_NAME || 'Owner', password);


// Daily retention sweep for old screenshots.
setInterval(() => { const n = app.purgeOld(); if (n) console.log(`Purged ${n} old screenshots`); }, 24 * 3600 * 1000).unref();
app.sweepStale();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || undefined; // 127.0.0.1 behind a reverse proxy; all interfaces otherwise
app.server.listen(port, host, () => {
  console.log(`Staffwarden running on http://localhost:${port} (built in-house by Amplify Media Technologies)`);
  // Addresses other computers on the same network can use (for the desktop app's Server field)
  const lan = Object.values(require('node:os').networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}`);
  if (lan.length && !host) console.log(`On your network: ${lan.join('  ')}`);
});
