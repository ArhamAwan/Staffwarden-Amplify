'use strict';
// Electron shell: wires OS services (tray, screen capture, idle timer) into the tested core in ./src.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, desktopCapturer, powerMonitor, powerSaveBlocker, nativeTheme, systemPreferences, Notification, nativeImage, safeStorage, shell, dialog, net } = require('electron');

// Anything that goes wrong is written to <user data>/error.log, so a problem on someone's computer can be
// looked at afterwards (Help: the file is in ~/Library/Application Support/Workhelm on a Mac,
// %APPDATA%\Workhelm on Windows).
function logError(where, e) {
  try {
    const f = require('node:path').join(app.getPath('userData'), 'error.log');
    require('node:fs').mkdirSync(require('node:path').dirname(f), { recursive: true });
    require('node:fs').appendFileSync(f, `${new Date().toISOString()} [${app.getVersion()} ${process.platform} ${process.arch}] ${where}: ${(e && e.stack) || e}\n`);
  } catch { /* nothing more we can do */ }
}
process.on('uncaughtException', (e) => { logError('uncaught', e); });
process.on('unhandledRejection', (e) => { logError('unhandled promise', e); });
// The app talks to the server the way the browser does (Chromium's network stack): it honours the
// computer's own trusted certificates, proxies and VPNs, so antivirus HTTPS scanning or an office proxy
// does not break the connection the way Node's own fetch can.
// If that fails on a computer (some VPN, proxy or firewall apps), the direct connection is tried; see src/connect.js.
const netFetch = require('./src/connect').makeFetch({
  browserFetch: net && typeof net.fetch === 'function' ? (u, o) => net.fetch(u, o) : null,
  directFetch: globalThis.fetch,
  log: (m) => logError('connection', m),
});
const fs = require('node:fs');
const path = require('node:path');
// Staffwarden was called Workhelm: inside, it keeps that name so everyone's sign-in, settings, running timer
// and unsent work carry straight over (see src/rename.js). People only ever see Staffwarden.
const rename = require('./src/rename');
app.setName(rename.INTERNAL_NAME);
// Windows only shows an app's pop-ups when it knows which app sent them: the same id as the Start menu
// shortcut the installer made (without this, notifications can silently never appear)
if (process.platform === 'win32') app.setAppUserModelId('com.amplifymediatechnologies.workhelm');
app.setPath('userData', path.join(app.getPath('appData'), rename.INTERNAL_NAME));
if (process.platform === 'darwin' && app.isPackaged) {
  const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
  const r = rename.macBundleRename(process.execPath, { exists: (p) => fs.existsSync(p), writable });
  if (r) {
    try {
      fs.renameSync(r.from, r.to);
      app.relaunch({ execPath: r.execPath, args: process.argv.slice(1) });
      app.exit(0);
    } catch (e) { logError('rename to Staffwarden.app', e); }
  }
}
const { Client, ApiError } = require('./src/client');
const { OfflineQueue } = require('./src/queue');
const { FileStore } = require('./src/store');
const { Tracker } = require('./src/tracker');
const privacy = require('./src/privacy');
const { Notifier } = require('./src/notifier');
const { boostIdOf, placeBoost, shouldPopUp, BoostQueue } = require('./src/boost');
const { LiveFeed } = require('./src/live');
const { Updater, prepareInstall, cleanupLeftovers, cmpVersion } = require('./src/updater');

// One Workhelm at a time. A newer version that finds an older one still running (it lives on in the menu
// bar after its window closes) asks it to step aside, then starts again by itself, instead of just closing.
const gotLock = app.requestSingleInstanceLock({ version: app.getVersion() });
if (!gotLock) {
  if (!process.argv.includes('--after-handover')) {
    setTimeout(() => { app.relaunch({ args: process.argv.slice(1).concat('--after-handover') }); app.exit(0); }, 2500);
  } else app.quit();
}

// The app used to be called Amplify Tracker. Carry over its saved server, sign-in and any screenshots
// still waiting to upload, so renaming it loses nothing. (An encrypted sign-in may not carry across on
// macOS, because the keychain entry is tied to the old name; then the person simply signs in again.)
function migrateFromOldName() {
  try {
    const now = app.getPath('userData');
    if (fs.existsSync(path.join(now, 'config.json'))) return;
    for (const old of ['amplify-tracker-desktop', 'Amplify Tracker']) {
      const dir = path.join(app.getPath('appData'), old);
      if (!fs.existsSync(path.join(dir, 'config.json'))) continue;
      fs.mkdirSync(now, { recursive: true });
      for (const f of ['config.json', 'tracker-state.json', 'outbox']) {
        const from = path.join(dir, f);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(now, f), { recursive: true });
      }
      return;
    }
  } catch (e) { console.warn('[migrate]', e.message); }
}
migrateFromOldName();

// The company server: set "workhelm.server" in package.json before building installers, so staff never type it.
let BUILT_IN_SERVER = '', PREVIOUS_SERVERS = [];
try { const w = require('./package.json').workhelm || {}; BUILT_IN_SERVER = w.server || ''; PREVIOUS_SERVERS = w.previousServers || []; } catch { /* none */ }
const sameUrl = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
const DEFAULT_SERVER = process.env.WORKHELM_SERVER || process.env.AMPLIFY_SERVER || BUILT_IN_SERVER || 'http://localhost:3000';
// With a server built in (or given by WORKHELM_SERVER), that is always the server: staff never type it
// and a value saved by an older version is ignored.
const FIXED_SERVER = !!(process.env.WORKHELM_SERVER || process.env.AMPLIFY_SERVER || BUILT_IN_SERVER);
let win, tray, panel, tracker, queue, client, updater, user = null, settings = null;
// Every request says which app version this is, so the owner can see on the People page who needs to update.
// the version, and the computer's own time zone (offered to managers as a suggestion for this person's zone)
const APP_HEADERS = { 'X-Workhelm-App': `${app.getVersion()} ${process.platform} ${process.arch}`, ...(() => { try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; return z ? { 'X-Workhelm-Tz': z } : {}; } catch { return {}; } })() };
const makeClient = () => new Client({ baseUrl: config.serverUrl, getToken: () => config.token, headers: APP_HEADERS, fetchImpl: netFetch });
let config = { serverUrl: DEFAULT_SERVER, token: null, notifSeen: {}, dayTzMin: null, shift: null, outboxKey: null, openAtLogin: false };
let quitting = false;

// ---------- config (token encrypted with the OS keychain when available) ----------
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
    config.serverUrl = FIXED_SERVER ? DEFAULT_SERVER : (raw.serverUrl || DEFAULT_SERVER);
    // signed in to a different server before: that sign-in does not apply here
    // (the same server under its old address, e.g. before it moved to HTTPS, keeps the sign-in)
    if (FIXED_SERVER && raw.serverUrl && !sameUrl(raw.serverUrl, DEFAULT_SERVER) && !PREVIOUS_SERVERS.some((p) => sameUrl(p, raw.serverUrl))) raw.token = null;
    config.notifSeen = raw.notifSeen && typeof raw.notifSeen === 'object' ? raw.notifSeen : {};
    config.dayTzMin = Number.isFinite(raw.dayTzMin) ? raw.dayTzMin : null;
    config.shift = raw.shift && typeof raw.shift === 'object' ? raw.shift : null;
    config.outboxKey = typeof raw.outboxKey === 'string' ? raw.outboxKey : null;
    config.openAtLogin = raw.openAtLogin === true;
    config.otherDevice = raw.otherDevice === true;
    if (raw.token) config.token = raw.enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : (raw.enc ? null : raw.token);
  } catch { /* first run */ }
}
function saveConfig() {
  const enc = !!config.token && safeStorage.isEncryptionAvailable();
  const token = config.token ? (enc ? safeStorage.encryptString(config.token).toString('base64') : config.token) : null;
  fs.writeFileSync(cfgFile(), JSON.stringify({ serverUrl: config.serverUrl, token, enc, notifSeen: config.notifSeen || {}, dayTzMin: config.dayTzMin, shift: config.shift, outboxKey: config.outboxKey, openAtLogin: !!config.openAtLogin, otherDevice: !!config.otherDevice }));
}

// ---------- screen capture & permission ----------
// macOS: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'. Other systems need no permission.
const screenPermission = () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted');

// Asking for a capture is what makes macOS show its "allow screen recording" prompt (first time only)
// and what lists the app under System Settings > Privacy & Security > Screen Recording.
async function requestScreenAccess() {
  try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch { /* the prompt is the point */ }
  return screenPermission();
}

// Private windows (messaging apps, password managers, private browser windows, plus what the owner
// switched on or added in Settings) are painted black before a screenshot is stored or uploaded.
let matcher = privacy.buildMatcher({});
function applyPrivacySettings(st) {
  matcher = privacy.buildMatcher({ categories: (st && st.blackout_categories) || {}, extra: (st && st.blackout_apps) || [] });
}
const scanWindows = () => privacy.listWindows(process.platform, { selfNames: ['Workhelm', 'Staffwarden', app.getName()] })
  .catch((e) => { throw new Error(`Screenshot skipped: could not check for private windows (${e.message})`); });
const toPoints = (r) => (process.platform === 'win32' ? privacy.toDipRect(r, (w, rect) => screen.screenToDipRect(w, rect)) : r); // Windows reports physical pixels

// Only used when a private window is open but the screen it is on cannot be identified: a small black
// frame, marked "full" so the dashboard explains it. Normally only the private windows are painted black.
function blank() {
  const w = 320, h = 200, b = Buffer.alloc(w * h * 4);
  for (let i = 3; i < b.length; i += 4) b[i] = 255;
  return nativeImage.createFromBitmap(b, { width: w, height: h });
}

async function captureScreens() {
  if (screenPermission() !== 'granted') throw new Error('Screen recording permission is off');
  // Strict: the windows are listed before AND after the capture and both lists are used, so a private
  // window that opened or moved while the picture was being taken is still covered.
  const [before, sources] = await Promise.all([scanWindows(), desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1440, height: 900 } })]);
  const after = await scanWindows();
  const d = privacy.decide([before, after], matcher);
  const rects = d.rects.map(toPoints);
  const privateWindows = rects.length;   // the pop-up corner alone never hides a whole screen
  // Windows: notification pop-ups have no window to find, so their corner on the main screen is always hidden
  if (process.platform === 'win32') { try { const z = privacy.windowsToastZone(screen.getPrimaryDisplay().workArea); if (z) rects.push(z); } catch { /* no screen info */ } }
  const displays = screen.getAllDisplays();
  // On the person's own computer, only the screen they are working on (the one with the mouse) is captured,
  // unless the company chose all screens. If the screens cannot be told apart, all are used.
  let usable = sources.filter((s) => !s.thumbnail.isEmpty());
  if (!(settings && settings.capture_screens === 'all') && usable.length > 1) {
    let active = null;
    try { active = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); } catch { /* unknown */ }
    const only = active ? usable.filter((s) => String(s.display_id) === String(active.id)) : [];
    if (only.length) usable = only;
  }
  const blur = !!(settings && settings.blur_shots);
  let masked = 0, fullCount = 0;
  const shots = usable.map((s) => {
    const display = displays.find((x) => String(x.id) === s.display_id) || (displays.length === 1 ? displays[0] : null);
    // Only the private windows are painted black; the rest of the screen stays visible. If a private
    // window is open but we cannot tell where this screen is, we cannot paint the right spot, so hide it all.
    const hideAll = privateWindows && !display;
    if (hideAll) { fullCount++; const img = blank(); return { buf: img.toJPEG(60), thumb: img.toJPEG(55), privacy: 'full' }; }
    let img = s.thumbnail, priv = null;
    if (rects.length && display) {
      try {
        const { width, height } = img.getSize();
        const px = privacy.toImageRects(rects, display.bounds, width, height);
        if (px.length) {
          img = nativeImage.createFromBitmap(privacy.fillBlack(Buffer.from(img.toBitmap()), width, height, px), { width, height });
          masked += px.length; priv = 'partial';
        }
      } catch (e) {
        // the private windows could not be painted over: hide the whole screen rather than skip the screenshot
        logError('privacy mask', e);
        fullCount++; const b = blank(); return { buf: b.toJPEG(60), thumb: b.toJPEG(55), privacy: 'full' };
      }
    }
    if (blur) {   // blurred on the computer, so the sharp picture never leaves it
      const { width, height } = img.getSize();
      img = img.resize({ width: Math.max(16, Math.round(width / 14)), quality: 'good' }).resize({ width, height, quality: 'better' });
    }
    return { buf: img.toJPEG(60), thumb: img.resize({ width: 480 }).toJPEG(55), privacy: priv };
  });
  if (!shots.length) throw new Error('The system returned no screen image');
  shots.masked = masked; shots.full = fullCount; shots.categories = d.matched;
  return shots;
}

// Every pop-up goes through here: when the system refuses one (notifications switched off for the app,
// a missing Windows shortcut...), it is sent to the developer's error reports instead of failing silently.
let popupFailReported = false;
function popup(opts) {
  const n = new Notification(opts);
  n.on('failed', (_e, err) => reportDesktopError(`Notification failed: ${String(err || 'unknown').slice(0, 160)}`, `${process.platform} ${process.arch} ${app.getVersion()}`));
  return n;
}
function reportDesktopError(message, stack = '') {
  if (!config.token) return;
  client.req('POST', '/api/errors', { source: 'desktop', message, stack }).catch(() => {});
}
function checkPopups() {
  if (popupFailReported) return;
  if (!Notification.isSupported()) { popupFailReported = true; reportDesktopError('Notifications are not supported on this computer', `${process.platform} ${app.getVersion()}`); }
}
const notify = (title, body, silent = true) => { if (Notification.isSupported()) popup({ title, body, silent }).show(); };
const mins = (s) => Math.max(1, Math.round(s / 60));

// The key that encrypts screenshots while they wait to upload. It is stored encrypted by the operating
// system's keychain (macOS Keychain, Windows DPAPI), so the files in the outbox are unreadable on their own.
function outboxKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (config.outboxKey) {
      try { return Buffer.from(safeStorage.decryptString(Buffer.from(config.outboxKey, 'base64')), 'base64'); } catch { /* keychain changed: make a new key */ }
    }
    const key = require('node:crypto').randomBytes(32);
    config.outboxKey = safeStorage.encryptString(key.toString('base64')).toString('base64');
    saveConfig();
    return key;
  } catch { return null; }
}

function build() {
  queue = new OfflineQueue(path.join(app.getPath('userData'), 'outbox'), { log: (m) => console.warn('[queue]', m), key: outboxKey() });
  client = makeClient();
  updater = new Updater({ baseUrl: config.serverUrl, version: app.getVersion(), dir: updDir(), onChange: onUpdateChange, fetchImpl: netFetch });
  tracker = new Tracker({
    client, queue, capture: captureScreens, idleSecs: () => powerMonitor.getSystemIdleTime(), endOnWake: (a, b) => endOnWake(a, b),
    store: new FileStore(path.join(app.getPath('userData'), 'tracker-state.json')),
    otherDevice: !!config.otherDevice,
    // The work day, remembered from the last sign-in: for a night shift (6 PM to 3:30 AM) the day starts at
    // 10:30 AM, so midnight is not a new day even when the app restarts or starts offline after midnight.
    tzOffsetMin: config.dayTzMin != null ? config.dayTzMin : -new Date().getTimezoneOffset(),
    onEvent: (e) => {
      if (e.type === 'screenshot') notify('Staffwarden', 'Screenshot captured');
      if (e.type === 'idle-start') notify('You seem to be away', `No keyboard or mouse for ${mins(e.idleSecs)} min. Your timer is still running and this time is marked idle. No screenshots are taken until you're back.`, false);
      if (e.type === 'away-stopped') notify('Timer stopped', `Your computer went to sleep at ${ampmAt(e.atMs)}${e.why === 'long' ? ' and stayed asleep for hours' : e.why === 'off-shift' ? ', outside your shift' : ''}, so the timer was stopped then. Start it again when you're working.`, false);
      if (e.type === 'away-resumed') notify('Timer continued', `Your computer was asleep for ${mins(e.gapSecs)} min. That time wasn't counted, and your timer is running again.`, false);
      if (e.type === 'reconnected') notify('Timer reconnected', e.note, false);
      if (win && !win.isDestroyed()) win.webContents.send('event', e);
      push();
    },
  });
}

// ---------- updates ----------
// The app checks the company server for a newer version shortly after starting and every 3 hours.
// When there is one, the person sees a banner (and one pop-up); "Update" downloads it, checks it,
// installs it and restarts Workhelm. A running timer is saved first and carries on after the restart.
const updDir = () => path.join(app.getPath('userData'), 'updates');
// The pop-up comes when a version is first seen, then once a day until the person updates.
let updNotified = null, updNotifiedAt = 0;
const UPDATE_REMIND_MS = 24 * 3600000;
function onUpdateChange(st) {
  if (win && !win.isDestroyed()) win.webContents.send('update', st);
  if (tray) trayKey = '';      // rebuild the tray menu with (or without) the update item
  if (st.status === 'available' && app.isPackaged && (st.latest !== updNotified || Date.now() - updNotifiedAt >= UPDATE_REMIND_MS)) {
    const again = st.latest === updNotified;
    updNotified = st.latest; updNotifiedAt = Date.now();
    if (Notification.isSupported()) {
      const n = popup({ title: again ? `Reminder: Staffwarden ${st.latest} is ready` : `Staffwarden ${st.latest} is available`, body: 'Click to update. It takes about a minute, and your timer keeps running.', silent: again });
      n.on('click', () => { showWin(); }); n.show();
    }
  }
}
const checkForUpdate = () => (app.isPackaged ? updater.check().catch(() => {}) : Promise.resolve());
async function installUpdate() {
  if (!app.isPackaged) return { error: 'Updates work in the installed app only.' };
  if (['downloading', 'installing'].includes(updater.state.status)) return { ok: true };
  let file;
  try { file = await updater.download(); } catch (e) { return { error: updater.state.error || e.message }; }
  let plan;
  try { plan = await prepareInstall({ file, workDir: updDir(), log: (m) => updater.log(m) }); } catch (e) {
    updater.log(`install failed: ${e.message}`);
    const manual = e.code === 'not-writable';
    updater.set({ status: 'error', manual, error: manual
      ? `${e.message} Open the downloaded update, then drag Staffwarden into your Applications folder and replace the old one.`
      : `Could not install the update: ${e.message}` });
    return { error: updater.state.error };
  }
  updater.set({ status: 'installing' });
  if (tracker.status().active) tracker.persist(true);   // picked up again by the new version
  quitting = true;
  updater.log(`installing ${updater.state.latest}, restarting`);
  setTimeout(() => {
    try { plan.launch(process.pid); } catch (e) {
      updater.log(`could not start the installer: ${e.message}`);
      quitting = false;
      updater.set({ status: 'error', error: `Could not start the installer: ${e.message}` });
      return;
    }
    app.exit(0);
  }, 600);
  return { ok: true };
}

function fmt(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return [h, m, x].map((n) => String(n).padStart(2, '0')).join(':'); }
function status() {
  const sh = shiftState();
  return { ...tracker.status(), shift: shiftWindow(), screenPermission: screenPermission(), devMode: !!process.defaultApp, platform: process.platform, shiftOver: sh.over, shiftEnd: sh.endText };
}

// ---------- the end of the shift ----------
// After the person's shift ends, a running timer gets a reminder (then one every 30 minutes) to stop it
// before shutting the computer down. Shutting down after the shift stops the timer; shutting down or
// restarting during the shift keeps it, so it carries on when the computer is back.
const hhmm = (v) => { const [h, m] = String(v || '18:00').split(':').map(Number); return h * 60 + m; };
const ampm = (min) => { const h = Math.floor(min / 60) % 24, m = min % 60; return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
// Is this moment inside the person's shift (with an hour's leeway either side)? Used to decide whether a
// computer that went to sleep was still at work. Unknown shift: assume yes.
const SLEEP_LEEWAY = 60, LONG_SLEEP_MS = 3 * 3600000;
function inShift(ms) {
  const u = user || config.shift;     // at start-up, the shift remembered from last time
  if (!u || !u.shift_start || !u.shift_end) return true;
  const tz = u.tz_offset_min ?? -new Date().getTimezoneOffset();
  const local = new Date(ms + tz * 60000);
  const m = local.getUTCHours() * 60 + local.getUTCMinutes(), dow = local.getUTCDay();
  const s = hhmm(u.shift_start), e = hhmm(u.shift_end);
  const days = new Set(String(u.work_days || '1,2,3,4,5').split(',').map(Number));
  if (e > s) return days.has(dow) && m >= s - SLEEP_LEEWAY && m < e + SLEEP_LEEWAY;
  if (m >= s - SLEEP_LEEWAY) return days.has(dow);                 // the evening part of a night shift
  if (m < e + SLEEP_LEEWAY) return days.has((dow + 6) % 7);       // after midnight: yesterday's shift
  return false;
}
function endOnWake(sleptAt, wokeAt) {
  if (wokeAt - sleptAt >= LONG_SLEEP_MS) return 'long';
  return inShift(sleptAt) ? false : 'off-shift';
}
const ampmAt = (ms) => { const tz = (user && user.tz_offset_min != null) ? user.tz_offset_min : -new Date().getTimezoneOffset(); const d = new Date(ms + tz * 60000); return ampm(d.getUTCHours() * 60 + d.getUTCMinutes()); };

function shiftState(nowMs = Date.now()) {
  if (!user || !user.shift_end) return { over: false };
  const tz = user.tz_offset_min ?? -new Date().getTimezoneOffset();
  const local = new Date(nowMs + tz * 60000);
  const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = hhmm(user.shift_start), end = hhmm(user.shift_end);
  const days = new Set(String(user.work_days || '1,2,3,4,5').split(',').map(Number));
  let over;
  if (end > start) over = days.has(local.getUTCDay()) && nowMin >= end;
  else { // overnight shift, e.g. 22:00 to 06:00: over in the morning after the end, until the next start
    const yesterday = (local.getUTCDay() + 6) % 7;
    over = days.has(yesterday) && nowMin >= end && nowMin < start;
  }
  return { over, endText: ampm(end), dayKey: local.toISOString().slice(0, 10) };
}
let lastShiftNudge = 0;
function shiftNudge() {
  if (!tracker || !tracker.status().active) return;
  const sh = shiftState();
  if (!sh.over || Date.now() - lastShiftNudge < 30 * 60000) return;
  lastShiftNudge = Date.now();
  if (!Notification.isSupported()) return;
  const n = popup({ title: 'Your shift has ended', body: `Your shift ended at ${sh.endText}. If you're done for the day, stop your timer before you shut down your computer.`, silent: false });
  n.on('click', () => { showWin(); if (win) win.webContents.send('confirm-stop'); });
  n.show();
}
// ---------- task reminders ----------
// Keeps the task list in the window current (the server sends the daily due-date reminder itself).
async function taskNudge() {
  if (!config.token || !user || !user.consented) return null;
  const s = await client.taskSummary();
  if (win && !win.isDestroyed()) win.webContents.send('tasks-changed', s);
  if (panel && !panel.isDestroyed()) panel.webContents.send('tasks-changed', s);
  return s;
}

// ---------- notifications ----------
// Everything in the person's Workhelm bell (assigned tasks, reviews, comments, deadlines, time off,
// team alerts) also pops up here, so it is seen even with the dashboard closed. Clicking one opens it
// in the dashboard; task ones also refresh the task list in this window.
const shownNotifs = [];   // keep references so clicks still work after a while
const notifier = new Notifier({
  client: { notifications: (o) => client.notifications(o), notifyPrefs: () => client.notifyPrefs() },
  store: {
    get: (uid) => (config.notifSeen && config.notifSeen[uid] != null ? config.notifSeen[uid] : null),
    set: (uid, id) => { config.notifSeen = { ...(config.notifSeen || {}), [uid]: id }; try { saveConfig(); } catch { /* next time */ } },
  },
  show: (n) => {
    if (n.kind === 'app_update' && app.isPackaged) return;   // this app announces updates itself, with an Update button
    if (n.link && /^#\/tasks|^#\/project/.test(n.link)) taskNudge().catch(() => {});
    // the owner's boost clip pops up in the corner instead; if it can't, it is an ordinary notification
    if (boostIdOf(n)) { showBoostClip(n).then((shown) => { if (!shown) osNotify(n); }).catch(() => osNotify(n)); return; }
    osNotify(n);
  },
});
function osNotify(n) {
    if (!Notification.isSupported()) return;
    const p = popup({ title: n.title, body: n.body || '', silent: false });
    p.on('click', () => {
      const ids = n.id ? [n.id] : n.ids || [];
      if (ids.length) client.readNotifications(ids).catch(() => {});
      shell.openExternal(`${config.serverUrl.replace(/\/+$/, '')}/${n.link || '#/'}`);
    });
    p.show();
    shownNotifs.push(p); if (shownNotifs.length > 20) shownNotifs.shift();
}

// ---------- the boost clip ----------
// The owner powering up in a corner of the screen with his message, for a few seconds. A transparent
// window on top of everything (full-screen apps too), that lets every click through except on the
// message. Only while the timer is on; the server decides who gets one (at most three a shift).
let boostWin = null, boostNow = null;
const boostQueue = new BoostQueue((b) => openBoost(b));
async function showBoostClip(n) {
  const id = boostIdOf(n);
  let b;
  try { b = await client.req('GET', `/api/boost/${id}`); } catch { return false; }
  if (!shouldPopUp(tracker.mode, b)) return false;
  boostQueue.push(b);
  return true;
}
function openBoost(b) {
  boostNow = b;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const at = placeBoost(display.workArea, b.corner);
  boostWin = new BrowserWindow({
    ...at, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', title: 'Boost',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  boostWin.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') { try { boostWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* older macOS */ } }
  boostWin.setIgnoreMouseEvents(true, { forward: true });
  boostWin.loadFile(path.join(__dirname, 'renderer', 'boost.html'));
  boostWin.once('ready-to-show', () => { if (boostWin && !boostWin.isDestroyed()) boostWin.showInactive(); });   // never takes the keyboard from what they are typing
  const w = boostWin;
  const guard = setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 30000);   // never left behind
  w.on('closed', () => { clearTimeout(guard); if (boostWin === w) { boostWin = null; boostNow = null; } setTimeout(() => boostQueue.done(), 1200); });
}
async function pollNotifications() {
  if (!config.token || !user || !user.consented) return;
  checkPopups();
  notifier.setUser(user.id);
  await notifier.poll();
}
// a live line to the server: a new notification (a boost clip, a direct message) is fetched straight away
// instead of on the next 20-second check, which stays as the backup
let liveSoon = null;
const live = new LiveFeed({
  baseUrl: config.serverUrl, getToken: () => config.token, headers: APP_HEADERS, fetchImpl: netFetch,
  onEvent: (ev) => {
    if (ev.type !== 'notify' && ev.type !== 'boost') return;
    clearTimeout(liveSoon);
    liveSoon = setTimeout(() => pollNotifications().catch(() => {}), 250);
  },
});

// ---------- the scheduled break ----------
// If the person has a break in their schedule, the app reminds them when it starts (pause if you're
// taking it) and, if they are still paused 5 minutes after it ends, that it is over.
let breakNudged = '';
function breakNudge() {
  if (!tracker || !user || !user.break_start || !user.break_end || !Notification.isSupported()) return;
  const st = tracker.status();
  if (!st.active) return;
  const tz = user.tz_offset_min ?? -new Date().getTimezoneOffset();
  const local = new Date(Date.now() + tz * 60000);
  const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const bs = hhmm(user.break_start), be = hhmm(user.break_end);
  const since = (m) => (nowMin - m + 1440) % 1440;           // minutes since m, across midnight too
  const key = local.toISOString().slice(0, 10);
  if (st.running && since(bs) < 3 && breakNudged !== key + 's') {
    breakNudged = key + 's';
    const n = popup({ title: 'Break time', body: `Your break is ${ampm(bs)} to ${ampm(be)}. Pause your timer if you're taking it.`, silent: false });
    n.on('click', showWin); n.show();
  } else if (st.paused && since(be) >= 5 && since(be) < 8 && breakNudged !== key + 'e') {
    breakNudged = key + 'e';
    const n = popup({ title: 'Break time is over', body: `Your break ended at ${ampm(be)}. Press Resume when you're back at work.`, silent: false });
    n.on('click', showWin); n.show();
  }
}

let shuttingDown = false;
async function onShutdown() {
  if (shuttingDown || !tracker) return;
  shuttingDown = true; quitting = true;
  if (!tracker.status().active) return;
  if (shiftState().over) {
    try { await Promise.race([tracker.stop({ reason: 'shutdown' }), new Promise((r) => setTimeout(r, 2500))]); } catch { /* queued for next start */ }
  } else tracker.persist(true); // keep it: the timer carries on after the restart
}
let trayKey = '';
function push() {
  if (!tracker) return;
  keepAwake();
  const st = status();
  if (win && !win.isDestroyed()) win.webContents.send('status', st);
  if (panel && !panel.isDestroyed() && panel.isVisible()) panel.webContents.send('status', st);
  if (tray) {
    tray.setToolTip(st.running ? `Tracking · ${fmt(st.todayWorkedSecs)}` : st.paused ? `Paused · screenshots off` : 'Staffwarden: not tracking');
    if (process.platform === 'darwin') tray.setTitle(st.running ? ` ● ${fmt(st.todayWorkedSecs)}` : st.paused ? ' ⏸ paused' : '');
    trayKey = st.mode;   // the menu is built when it is opened (right-click), so it is always current
  }
}

// ---------- the menu bar / tray panel ----------
// A small window that drops down from the menu bar icon on a Mac (and opens above the tray on Windows):
// today's time, the task, status, the shift and Start / Pause / Stop, without opening the main window.
const PANEL_W = 340;
function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_W, height: 460, show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: process.platform === 'darwin', hasShadow: true,
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#FFFFFF', roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.platform === 'darwin') { try { panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* older macOS */ } }
  panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panel.on('blur', () => { if (!panel.webContents.isDevToolsOpened()) panel.hide(); });
  panel.on('close', (e) => { if (!quitting) { e.preventDefault(); panel.hide(); } });
}
function placePanel() {
  const b = tray.getBounds(), [w, h] = panel.getSize();
  const area = screen.getDisplayMatching(b.width ? b : { x: 0, y: 0, width: 1, height: 1 }).workArea;
  let x = Math.round(b.x + b.width / 2 - w / 2);
  let y = process.platform === 'darwin' || b.y < area.y + area.height / 2 ? b.y + b.height + 6 : b.y - h - 6;
  if (!b.width) { x = area.x + area.width - w - 12; y = process.platform === 'darwin' ? area.y + 6 : area.y + area.height - h - 12; }
  x = Math.max(area.x + 6, Math.min(x, area.x + area.width - w - 6));
  y = Math.max(area.y + 2, Math.min(y, area.y + area.height - h - 2));
  panel.setPosition(x, y, false);
}
// test hook: lets an automated check open the panel (never set in normal use)
if (process.env.WORKHELM_PROBE) global.__workhelm = { togglePanel: () => togglePanel(), panel: () => panel, tracker: () => tracker, awake: () => awakeId, me: () => client.me().then(applyUser) };
function togglePanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  if (panel.isVisible()) { panel.hide(); return; }
  placePanel();
  panel.show(); panel.focus();
  panel.webContents.send('panel-opened');
  push();
}

// The current (or next) shift as real times, for "2h 10m left" in the panel.
function shiftWindow(nowMs = Date.now()) {
  const u = user || config.shift;
  if (!u || !u.shift_start || !u.shift_end) return null;
  const tz = u.tz_offset_min ?? -new Date().getTimezoneOffset();
  const s = hhmm(u.shift_start), e = hhmm(u.shift_end);
  const local = nowMs + tz * 60000, dayStart = local - (local % 86400000), m = Math.floor((local - dayStart) / 60000);
  let startDay = dayStart;
  if (e <= s && m < e + 60) startDay -= 86400000;            // after midnight: still last evening's shift
  const startMs = startDay + s * 60000 - tz * 60000;
  const endMs = startDay + (e <= s ? 86400000 : 0) + e * 60000 - tz * 60000;
  const sw = { startMs, endMs, startText: ampm(s), endText: ampm(e) };
  // the scheduled break inside this shift, for the dial
  const bu = user && user.break_start && user.break_end ? user : null;
  if (bu) {
    const bs = hhmm(bu.break_start), be = hhmm(bu.break_end);
    const off = (x) => ((x - s) % 1440 + 1440) % 1440;
    sw.breakStartMs = startMs + off(bs) * 60000; sw.breakEndMs = startMs + off(be) * 60000;
    sw.breakText = `${ampm(bs)} – ${ampm(be)}`;
    if (sw.breakEndMs <= sw.breakStartMs || sw.breakEndMs > endMs) { delete sw.breakStartMs; delete sw.breakEndMs; }
  }
  return sw;
}
function panelInfo() {
  return {
    loggedIn: !!config.token, consented: !!(user && user.consented), name: user ? user.name : null,
    shift: shiftWindow(), now: Date.now(), dashboard: config.serverUrl,
    update: updater && ['available', 'downloading', 'ready'].includes(updater.state.status) ? updater.state.latest : null,
    reasons: (settings && settings.pause_reasons) || null, shotsPer10: user && user.shots_per_10 != null ? user.shots_per_10 : settings ? settings.shots_per_10 : null,
  };
}

// ---------- window & tray ----------
function showWin() { if (win) { win.show(); win.focus(); } }
function createWindow() {
  win = new BrowserWindow({
    width: 440, height: 860, minWidth: 400, minHeight: 640, show: true, title: 'Staffwarden', backgroundColor: nativeTheme.shouldUseDarkColors ? '#140E2C' : '#F6F5FB',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // coming back to the window: new projects and tasks made on the website show up straight away
  let lastFocusNudge = 0;
  win.on('focus', () => { if (Date.now() - lastFocusNudge > 15000) { lastFocusNudge = Date.now(); taskNudge().catch(() => {}); } });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();                       // keep tracking in the menu bar / tray
    // Closing the window is not quitting. With the timer on, say so plainly, so nobody thinks work stopped.
    if (tracker && tracker.status().active) {
      const where = process.platform === 'darwin' ? 'menu bar' : 'system tray';
      if (Notification.isSupported()) {
        const n = popup({ title: 'Your timer is still running', body: `Staffwarden is still tracking from the ${where}. Finished for the day? Open Staffwarden and press Stop.`, silent: false });
        n.on('click', showWin); n.show();
      }
    }
  });
}

function applyOpenAtLogin() {
  if (!app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin, args: ['--hidden'] }); } catch { /* not supported here */ }
}
function setOpenAtLogin(on) {
  config.openAtLogin = !!on; saveConfig(); applyOpenAtLogin();
  if (win && !win.isDestroyed()) win.webContents.send('prefs', { openAtLogin: config.openAtLogin });
}

function trayMenu(st) {
  const today = st.todayWorkedSecs != null ? fmt(st.todayWorkedSecs) : null;
  const items = [];
  if (config.token && today) items.push({ label: st.running ? `Tracking · ${today} today` : st.paused ? `Paused · ${today} today` : `Not tracking · ${today} today`, enabled: false }, { type: 'separator' });
  items.push({ label: 'Show today…', click: () => togglePanel() }, { label: 'Open Staffwarden', click: showWin }, { type: 'separator' });
  if (st.mode === 'running') items.push({ label: 'Pause (break)', click: () => tracker.pause({ reason: 'break' }).then(push) });
  if (st.mode === 'paused') items.push({ label: 'Resume', click: () => tracker.resume().then(push) });
  // Stopping always asks first: the window shows the "Stop the timer?" prompt.
  if (st.mode !== 'stopped') items.push({ label: 'Stop…', click: () => { showWin(); win.webContents.send('confirm-stop'); } });
  if (updater && updater.state.status === 'available') items.push({ type: 'separator' }, { label: `Update to ${updater.state.latest}…`, click: () => { showWin(); installUpdate(); } });
  items.push({ type: 'separator' }, { label: `Check for updates… (version ${app.getVersion()})`, click: () => manualCheck(true) });
  items.push({ type: 'separator' }, { label: 'Open Staffwarden when this computer starts', type: 'checkbox', checked: !!config.openAtLogin, click: (m) => setOpenAtLogin(m.checked) });
  items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function createTray() {
  // macOS: a black "template" helm that the menu bar tints for light and dark mode. Elsewhere: the brass helm on navy.
  const mac = process.platform === 'darwin';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', mac ? 'trayTemplate.png' : 'tray.png'));
  if (mac) icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : mac ? icon : icon.resize({ width: 18, height: 18 }));
  // Click: the panel with today's details and the timer controls. Right-click: the short menu.
  tray.on('click', () => togglePanel());
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu(status())));
}

// ---------- IPC (renderer is sandboxed; it can only call these) ----------
// The server answers 426 when a newer app is needed to start the timer, and 403 (with this wording) when
// what is captured changed since the person agreed; the screens offer Update or show what changed.
const err = (e) => ({
  error: e instanceof ApiError || e instanceof Error ? e.message : String(e),
  ...(e && e.status === 426 ? { code: 'update-required' } : {}),
  ...(e && e.status === 403 && /changed since you agreed/.test(e.message) ? { code: 'policy-changed' } : {}),
});
const handle = (name, fn) => ipcMain.handle(name, async (_e, ...a) => { try { return await fn(...a); } catch (e) { if (!(e instanceof ApiError)) logError(name, e); return err(e); } });

// the menu bar panel
// the boost clip window and how boosts arrive
handle('boost-data', () => boostNow);
handle('boost-mouse', (over) => { if (boostWin && !boostWin.isDestroyed()) boostWin.setIgnoreMouseEvents(!over, { forward: true }); return { ok: true }; });
handle('boost-answer', (id, answer) => client.req('POST', `/api/boost/${Number(id)}/answer`, { answer: answer === 'chai' ? 'chai' : 'boosted' }));
handle('boost-close', () => { if (boostWin && !boostWin.isDestroyed()) boostWin.close(); return { ok: true }; });
handle('boost-prefs', () => client.req('GET', '/api/me/boost-prefs'));
handle('set-boost-prefs', (p) => client.req('PUT', '/api/me/boost-prefs', { ...(p && 'popup' in p ? { popup: p.popup } : {}), ...(p && 'corner' in p ? { corner: p.corner } : {}) }));
handle('panel-info', () => panelInfo());
handle('panel-size', (h) => {
  if (!panel || panel.isDestroyed()) return { ok: false };
  const height = Math.max(200, Math.min(640, Math.round(Number(h) || 460)));
  if (panel.getSize()[1] !== height) {
    panel.setResizable(true); panel.setSize(PANEL_W, height, false); panel.setResizable(false);   // some systems ignore size changes on fixed windows
    if (panel.isVisible()) placePanel();
  }
  return { ok: true };
});
handle('open-main', () => { if (panel && !panel.isDestroyed()) panel.hide(); showWin(); return { ok: true }; });
handle('open-dashboard', () => { if (panel && !panel.isDestroyed()) panel.hide(); shell.openExternal(config.serverUrl); return { ok: true }; });
handle('quit-app', () => { if (panel && !panel.isDestroyed()) panel.hide(); app.quit(); return { ok: true }; });

async function loadSettings() {
  try { settings = await client.settings(); } catch { /* older server or offline: built-in defaults apply */ }
  applyPrivacySettings(settings);
  return settings;
}
function applyUser(u) {
  user = u;
  // the work day: for a shift past midnight it starts later than midnight, so the whole shift is one day
  if (u && u.tz_offset_min != null) {
    const dayTz = u.tz_offset_min - (u.day_start_min || 0);
    tracker.configure({ tzOffsetMin: dayTz });
    // remembered for the next start, before the server has answered (or when offline)
    const shift = { tz_offset_min: u.tz_offset_min, shift_start: u.shift_start, shift_end: u.shift_end, work_days: u.work_days };
    if (config.dayTzMin !== dayTz || JSON.stringify(config.shift) !== JSON.stringify(shift)) { config.dayTzMin = dayTz; config.shift = shift; try { saveConfig(); } catch { /* next time */ } }
  }
  if (u && u.shots_per_10 != null) tracker.configure({ shotsPer10: u.shots_per_10 });
  if (u && 'other_device' in u) {
    tracker.configure({ otherDevice: !!u.other_device });
    if (config.otherDevice !== !!u.other_device) { config.otherDevice = !!u.other_device; try { saveConfig(); } catch { /* next time */ } }
  }
  keepAwake();
}

// Someone who works on another device (an iPad, say) leaves this computer alone, and it would go to sleep
// and stop the timer. For them (an option the owner or a manager turns on), the computer is kept awake while
// the timer is on. The screen may still turn off. Closing a laptop's lid still puts it to sleep.
let awakeId = null;
function keepAwake() {
  const want = !!(tracker && tracker.otherDevice && tracker.mode !== 'stopped');
  if (want && awakeId == null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  else if (!want && awakeId != null) { try { powerSaveBlocker.stop(awakeId); } catch { /* already gone */ } awakeId = null; }
}

handle('state', async () => {
  if (!config.token) return { loggedIn: false, serverUrl: config.serverUrl, fixedServer: FIXED_SERVER };
  try { applyUser(await client.me()); } catch (e) {
    if (e instanceof ApiError && e.status === 401) { config.token = null; saveConfig(); return { loggedIn: false, serverUrl: config.serverUrl, fixedServer: FIXED_SERVER }; }
    return { loggedIn: true, offline: true, user, serverUrl: config.serverUrl, fixedServer: FIXED_SERVER, settings, status: status() };
  }
  await loadSettings();
  pollNotifications().catch(() => {});   // sets the starting point straight away, so nothing new is missed
  return { loggedIn: true, user, serverUrl: config.serverUrl, settings, status: status() };
});

handle('login', async ({ serverUrl, email, password }) => {
  // Accept "192.168.1.5:3000" as well as "http://192.168.1.5:3000"
  let url = (FIXED_SERVER ? DEFAULT_SERVER : (serverUrl || DEFAULT_SERVER)).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  config.serverUrl = url;
  client = makeClient();
  tracker.client = client;
  updater.baseUrl = config.serverUrl;
  const r = await client.login(email, password);
  config.token = r.token; applyUser(r.user); saveConfig();
  live.baseUrl = config.serverUrl.replace(/\/+$/, ''); live.reconnect();
  return { user };
});

handle('logout', async () => {
  if (tracker.status().active) return { error: 'Stop the timer before signing out.' };
  try { await client.req('POST', '/api/auth/logout'); } catch { /* offline: token is discarded locally anyway */ }
  config.token = null; user = null; saveConfig(); live.reconnect();
  return { ok: true };
});

handle('accept-policy', async () => { await client.acceptPolicy(); applyUser(await client.me()); taskNudge().catch(() => {}); return { user }; });
handle('projects', () => client.projects());
handle('my-tasks', () => client.myTasks());
handle('task-status', async (id, status) => { const r = await client.setTaskStatus(id, status); taskNudge().catch(() => {}); return r; });
handle('request-permission', async () => { const p = await requestScreenAccess(); push(); return { permission: p }; });

// Takes one capture and returns a small preview so the person can see exactly what gets recorded.
handle('test-capture', async () => {
  const shots = await captureScreens();
  const small = nativeImage.createFromBuffer(shots[0].buf).resize({ width: 640 }).toJPEG(70);
  return { image: 'data:image/jpeg;base64,' + small.toString('base64'), screens: shots.length, masked: shots.masked || 0, full: shots.full || 0, categories: shots.categories || [] };
});

handle('relaunch', async () => {
  quitting = true;
  try { if (tracker.status().active) await Promise.race([tracker.stop({ reason: 'quit' }), new Promise((r) => setTimeout(r, 3000))]); } catch { /* queued */ }
  app.relaunch();
  app.exit(0);
});

handle('start', async (projectId, taskId) => {
  if (screenPermission() !== 'granted') {
    await requestScreenAccess();
    push();
    return { error: 'Screen recording is not allowed yet, so screenshots cannot be captured. Follow the steps above.', code: 'screen-permission' };
  }
  const s = await loadSettings();
  try { applyUser(await client.me()); } catch { /* use what we had */ }
  tracker.configure(s ? { idleLimitSecs: s.idle_limit_min * 60 } : {});
  await tracker.start(projectId || null, taskId || null);
  push();
  return { ok: true };
});

handle('pause', async (reason) => { await tracker.pause({ reason: reason || 'break' }); push(); return { ok: true }; });
handle('resume', async () => { await tracker.resume(); push(); return { ok: true }; });
// The renderer asks "are you sure?" before calling this.
handle('stop', async () => { const summary = await tracker.stop(); push(); return { ok: true, summary }; });
handle('summary', (day) => tracker.summary(day || undefined));
handle('ack-recovered', () => { tracker.ackRecovered(); return { ok: true }; });
handle('prefs', () => ({ openAtLogin: !!config.openAtLogin }));
handle('set-open-at-login', (on) => { setOpenAtLogin(on); return { openAtLogin: !!config.openAtLogin }; });
handle('update-state', () => ({ ...updater.state, supported: updater.supported() && app.isPackaged }));
handle('update-check', async () => manualCheck(false));
// "Check for updates": always gives an answer (up to date, a new version, or cannot reach the server).
async function manualCheck(popUp) {
  const supported = updater.supported() && app.isPackaged;
  if (!supported) return { ...updater.state, supported, answer: 'unsupported' };
  await updater.check().catch(() => {});
  const s = updater.state;
  const answer = ['available', 'downloading', 'ready'].includes(s.status) ? 'available' : s.reached === false ? 'offline' : 'current';
  if (popUp && Notification.isSupported()) {
    const text = answer === 'available' ? [`Staffwarden ${s.latest} is available`, 'Click to update. It takes about a minute, and your timer keeps running.']
      : answer === 'offline' ? ['Could not check for updates', 'The Staffwarden server cannot be reached right now. Check your internet connection and try again.']
        : ['Staffwarden is up to date', `You have the latest version, ${app.getVersion()}.`];
    const n = popup({ title: text[0], body: text[1], silent: true });
    n.on('click', showWin); n.show();
  }
  if (answer === 'available' && win && !win.isDestroyed()) win.webContents.send('update', { ...s, supported, forceShow: true });
  return { ...s, supported, answer };
}
handle('update-install', () => installUpdate());
handle('update-reveal', () => {
  const f = updater.file;
  if (f && fs.existsSync(f)) { shell.showItemInFolder(f); return { ok: true }; }
  return { error: 'The update is not downloaded yet.' };
});
handle('open-permission-settings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return { ok: true };
});

// ---------- lifecycle ----------
const startedHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
app.whenReady().then(() => {
  if (!gotLock) return;
  if (process.platform === 'darwin') {
    const N = rename.NAME;
    try { app.setAboutPanelOptions({ applicationName: N, applicationVersion: app.getVersion(), copyright: 'Built in-house by Amplify Media Technologies' }); } catch { /* older macOS */ }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: N, submenu: [{ role: 'about', label: `About ${N}` }, { type: 'separator' }, { role: 'hide', label: `Hide ${N}` }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: `Quit ${N}` }] },
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
  }           // another Staffwarden is running; this one hands over or closes (above)
  loadConfig();
  build();
  // Start with the computer, so a timer that was running before a restart carries on by itself.
  // Starting with the computer is the person's choice (it is their computer): off unless they turn it on.
  applyOpenAtLogin();
  createWindow();
  if (startedHidden) win.hide();
  createTray();
  if (tracker.recovered && tracker.recovered.continued) {
    notify('Timer continued', `Welcome back. Your timer is running again. The time your computer was off wasn't counted.`, false);
  }
  // Fetch who we are (shift, screenshot settings) in the background, so reminders and privacy rules are current.
  if (config.token) { client.me().then(applyUser).catch(() => {}); loadSettings().catch(() => {}); }
  powerMonitor.on('shutdown', (e) => { if (tracker && tracker.status().active) { e.preventDefault(); onShutdown().finally(() => app.quit()); } });
  win.on('session-end', () => { onShutdown(); });   // Windows
  setInterval(shiftNudge, 60000);
  setInterval(breakNudge, 60000);
  setTimeout(() => { taskNudge().catch(() => {}); pollNotifications().catch(() => {}); }, 8000);
  setInterval(() => pollNotifications().catch(() => {}), 20000);
  live.baseUrl = config.serverUrl.replace(/\/+$/, ''); live.start();
  setInterval(() => taskNudge().catch(() => {}), 2 * 60000);   // projects and tasks made on the website appear within 2 minutes
  if (app.isPackaged) setTimeout(() => { const gone = cleanupLeftovers({ workDir: updDir() }); if (gone.length) updater.log(`removed leftovers: ${gone.join(', ')}`); }, 5000);
  setTimeout(checkForUpdate, 20000);
  setInterval(checkForUpdate, 3600000);   // every hour
  // First launch on macOS: ask for screen recording straight away, so the system prompt appears now
  // and not in the middle of someone's first work session.
  if (screenPermission() === 'not-determined') setTimeout(() => { requestScreenAccess().then(push); }, 800);
  setInterval(() => { tracker.tick().catch((e) => console.error('tick', e)); push(); }, 1000);
  setInterval(() => { if (config.token) tracker.sync().catch(() => {}); }, 30000);
  // settings a manager changed (screenshots, works on another device) reach the app within a few minutes
  setInterval(() => { if (config.token) client.me().then(applyUser).catch(() => {}); }, 3 * 60000);
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    const theirs = data && data.version;
    if (theirs && cmpVersion(theirs, app.getVersion()) > 0) {
      // a newer Workhelm was just opened: save the timer (it carries on in the new one) and step aside
      logError('handover', `version ${theirs} started; ${app.getVersion()} is closing`);
      if (tracker && tracker.status().active) tracker.persist(true);
      quitting = true;
      app.exit(0);
      return;
    }
    showWin();
  });
  app.on('activate', showWin);
});

// Quitting while the timer is on asks first, then stops and uploads (without ever hanging the quit).
app.on('before-quit', async (e) => {
  if (quitting || shuttingDown) return;
  if (tracker && tracker.status().active) {
    e.preventDefault();
    showWin();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Keep tracking', 'Stop timer and quit'], defaultId: 0, cancelId: 0,
      message: 'Your timer is still on.', detail: 'Quitting stops the timer. Your time so far is saved.',
    });
    if (choice === 0) return;
    quitting = true;
    try { await Promise.race([tracker.stop({ reason: 'quit' }), new Promise((r) => setTimeout(r, 4000))]); } catch { /* queued for next launch */ }
    app.quit();
    return;
  }
  quitting = true;
});
app.on('window-all-closed', () => { /* stay alive in the tray */ });
