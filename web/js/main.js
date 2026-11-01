import { get, post, getToken, setToken, setUnauthorizedHandler, setNewBuildHandler, startLive, clearImages, setViewAs } from './api.js';
import { registerSW } from './push.js';
import { html, esc, icon, ago, initials, avColor, HELM, CREDIT, owl } from './util.js';
import { S, actions, toast, errMsg, tickClocks, hydrateImages, openViewer, dial } from './ui.js';
import { morph } from './morph.js';
import { enter, snapshot, pulseChanges } from './motion.js';
import { maybeTour, maybeProjectGuide } from './tour.js';
import { initNotify, onNotify, resetNotify, bellHtml } from './notify.js';
import { openTask } from './pages/tasks.js';
import { invalidatePeople } from './parts.js';
import { watchOverlay } from './lock.js';
import { chatEvent } from './chat.js';
watchOverlay();
import { teamPage, mePage } from './pages/dashboard.js';
import timeline from './pages/timeline.js';
import tasks from './pages/tasks.js';
import performance from './pages/performance.js';
import screenshots from './pages/screenshots.js';
import timesheets from './pages/timesheets.js';
import attendance from './pages/attendance.js';
import timeoff from './pages/timeoff.js';
import reports from './pages/reports.js';
import people from './pages/people.js';
import { projectsPage as projects, projectPage as project } from './pages/projects.js';
import { settingsPage, auditPage } from './pages/settings.js';
import profile from './pages/profile.js';
import { requestsPage } from './pages/explain.js';
import pay from './pages/pay.js';
import payroll from './pages/payroll.js';
import hrPage from './pages/hr.js';
import expenses from './pages/expenses.js';
import importPage from './pages/import.js';
import { clientsPage, inboxPage } from './pages/clients.js';
import { teamChatPage } from './pages/teamchat.js';
import { checkinPage, checkinsPage } from './pages/checkin.js';
import { announcementsPage } from './pages/announcements.js';
import { showBoost, checkNudge, refreshAnnBar, funWatch, godTimer } from './v4.js';
import { godHome } from './pages/godhome.js';
import { devHome, devApps, devErrors, devTools, refreshSysBanner } from './pages/dev.js';
import leaderboard from './pages/leaderboard.js';

const app = document.getElementById('app');
let view = null, navEl = null, stopLive = null, timers = [];
let seq = 0, loading = false, again = false, lastStart = 0, wake = null;
// the last data each page was shown with, so going back to a page shows it at once while it reloads
const pageCache = new Map();
let taskBadge = 0, chatBadge = 0, chatMention = 0, inboxBadge = 0, inboxLate = false, hasClients = false;
let liveState = 'connecting', lastOk = 0, lastErr = null, pendingBadge = 0, reqBadge = 0, badgeAt = 0, hiddenStale = false;
let current = { name: null, key: null };
let openedTask = null;

const MGR = { '': teamPage, me: mePage, chat: teamChatPage, checkin: checkinPage, checkins: checkinsPage, announcements: announcementsPage, tasks, project, clients: clientsPage, inbox: inboxPage, performance, productivity: performance, timeline, screenshots, timesheets, attendance, timeoff, requests: requestsPage, reports, people, projects, audit: auditPage, profile };
const MGR_NAV = [
  ['', 'Dashboard', 'dash'], ['projects', 'Projects', 'folder'], ['tasks', 'Tasks', 'tasks'], ['performance', 'Performance', 'bolt'], ['timeline', 'Activity', 'pulse'], ['screenshots', 'Screenshots', 'camera'],
  ['timesheets', 'Timesheets', 'clock'], ['attendance', 'Attendance', 'cal'], ['timeoff', 'Time off', 'sun'], ['requests', 'Missing time', 'plus'], ['reports', 'Reports', 'chart'],
];
const MGR_NAV2 = [['people', 'People', 'users'], ['settings', 'Settings', 'gear'], ['audit', 'Audit log', 'log']];
const EMP = { '': mePage, me: mePage, chat: teamChatPage, checkin: checkinPage, checkins: checkinsPage, announcements: announcementsPage, projects, project, tasks, inbox: inboxPage, performance, productivity: performance, timeline, screenshots, timesheets, attendance, timeoff, profile };
const EMP_NAV = [
  ['', 'Dashboard', 'dash'], ['projects', 'Projects', 'folder'], ['tasks', 'My tasks', 'tasks'], ['timeline', 'My day', 'pulse'], ['performance', 'Performance', 'bolt'], ['screenshots', 'Screenshots', 'camera'], ['timesheets', 'Timesheet', 'clock'],
  ['attendance', 'Attendance', 'cal'], ['timeoff', 'Time off', 'sun'], ['profile', 'Profile', 'user'],
];
const isMgr = () => S.me && (S.me.role === 'owner' || S.me.role === 'manager');
// HR (and the owner) also get payroll and people's records; everyone who is paid gets their own Pay page
const isHR = () => S.me && (S.me.role === 'owner' || !!S.me.hr);
const HR_PAGES = { payroll, hr: hrPage, expenses, 'hr-import': importPage };
// god mode (the owner turns it on for someone): their home becomes the game; the normal views stay a
// click away (Your day, and for a manager the team dashboard under Team)
const god = () => !!(S.me && S.me.fun_mode && S.me.kind !== 'client');
const routes = () => {
  const base = isMgr()
    ? { ...MGR, team: teamPage, expenses, ...(S.me.role === 'owner' ? { settings: settingsPage } : { pay }), ...(isHR() ? HR_PAGES : {}) }
    : { ...EMP, pay, ...(isHR() ? HR_PAGES : {}) };
  const lb = S.me.leaderboard ? { leaderboard } : {};
  const dev = S.me.is_dev ? { dev: devHome, 'dev-apps': devApps, 'dev-errors': devErrors, 'dev-tools': devTools } : {};
  return god() ? { ...base, ...lb, ...dev, '': godHome } : { ...base, ...lb, ...dev };
};
const CHAT_NAV = ['chat', 'Chat', 'chats'];
const LB_NAV = () => (S.me && S.me.leaderboard ? [['leaderboard', 'Leaderboard', 'trophy']] : []);
const DEV_NAV = () => (S.me && S.me.is_dev ? [['dev', 'Developer', 'code']] : []);
const HR_NAV = [['hr', 'People and pay', 'file'], ['payroll', 'Payroll', 'wallet'], ['expenses', 'Expenses', 'receipt']];

// ---------------- routing
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  return { name: (path || '').split('/')[0], q: new URLSearchParams(query || '') };
}
function setQuery(k, v) {
  const { name, q } = parseHash();
  if (v === '' || v == null) q.delete(k); else q.set(k, v);
  const s = q.toString();
  location.hash = `#/${name}${s ? '?' + s : ''}`;
}
S.navigate = (h) => { location.hash = h; };

// ---------------- login
// Links to the desktop app installers the owner put on the server (if any).
export async function showDownloads(box, { dark = true } = {}) {
  if (!box) return;
  let list = [];
  try { const r = await fetch('/api/downloads', { cache: 'no-store' }); if (r.ok) list = await r.json(); } catch { return; }
  const pick = (k) => list.find((d) => d.kind === k);
  const opts = [['windows', 'Windows'], ['mac-arm', 'Mac with Apple chip (M1 and later)'], ['mac-intel', 'Mac with Intel chip']].map(([k, n]) => [pick(k), n]).filter(([d]) => d);
  if (!opts.length) return;
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  box.innerHTML = `<b>Get the desktop app</b><ul>${opts.map(([d, n]) => `<li><a href="/downloads/${encodeURIComponent(d.file)}" download>${esc(n)}</a> <span>${mb(d.size)}</span></li>`).join('')}</ul>`;
  box.classList.toggle('light', !dark);
}

// on the sign-in page the owl's eyes follow the cursor, and he covers them while the password is typed
function watchLogin() {
  const page = app.querySelector('.login-split'), o = app.querySelector('.login-owl .owl'), look = o && o.querySelector('.ow-look');
  if (!page || !look) return;
  page.addEventListener('pointermove', (e) => {
    const r = o.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.58;
    const dx = Math.max(-2.4, Math.min(2.4, (e.clientX - cx) / 140)), dy = Math.max(-1.8, Math.min(1.8, (e.clientY - cy) / 160));
    look.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
  });
  const pw = document.getElementById('pw');
  pw.addEventListener('focus', () => o.classList.add('shut'));
  pw.addEventListener('blur', () => o.classList.remove('shut'));
}

function showLogin(msg) {
  teardown();
  app.innerHTML = `<div class="login-split">
    <section class="login-art" aria-hidden="true">
      <div class="brand login-brand" style="padding:0"><span class="mark">${HELM}</span><div><b class="wordmark">staffwarden</b><span>Amplify Media Technologies</span></div></div>
      <div class="login-owl"><div class="login-owl-halo">${owl('live')}</div><p class="login-tag">Keeping watch through the night shift.</p></div>
      <p>${CREDIT}. Time is tracked only while you choose to, and private windows never leave your computer.</p>
    </section>
    <section class="login-side"><div class="login">
      <div class="brand login-brand login-brand-sm" style="padding:0"><span class="mark">${HELM}</span><div><b class="wordmark">staffwarden</b><span>Amplify Media Technologies</span></div></div>
      <h1>Sign in</h1><p class="muted">Use the email and password you were given.</p>
      <form id="login" class="mt" novalidate>
        <div class="field"><label class="f" for="em">Email</label><input id="em" name="email" type="email" autocomplete="username" required autofocus></div>
        <div class="field"><label class="f" for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
        <p class="err" role="alert" id="login-err">${esc(msg || '')}</p>
        <button class="btn primary" type="submit">Sign in</button></form>
      <p class="small muted">To track your time, sign in to the Staffwarden desktop app. This website is for your day, your team, chat, tasks and time off.</p>
      <div id="dl" class="dl light"></div></div></section></div>`;
  showDownloads(document.getElementById('dl'), { dark: false });
  watchLogin();
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button'), err = document.getElementById('login-err');
    err.textContent = ''; btn.disabled = true;
    try {
      const r = await post('/api/auth/login', { email: f.email.value.trim(), password: f.password.value });
      setToken(r.token);
      await boot();
    } catch (ex) { err.textContent = errMsg(ex); btn.disabled = false; }
  });
}
actions.logout = async () => { try { await post('/api/auth/logout'); } catch { /* already gone */ } setToken(null); S.me = null; showLogin(); };
// A new version of the website went live while this page was open: say so, and refresh on request.
// "Later" hides it for ten minutes; it comes back until the page is refreshed.
function showUpdateNote() {
  if (document.getElementById('updnote')) return;
  const box = document.createElement('div');
  box.id = 'updnote'; box.className = 'updnote'; box.setAttribute('role', 'status');
  box.innerHTML = `<span class="updnote-ic" aria-hidden="true">${icon('refresh').toString()}</span>
    <div class="updnote-t"><b>Staffwarden has been updated</b><span>Refresh to get the newest version. It takes a second.</span></div>
    <div class="updnote-a"><button class="btn sm" data-upd="later">Later</button><button class="btn sm primary" data-upd="now">Refresh</button></div>`;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-upd]');
    if (!b) return;
    if (b.dataset.upd === 'now') { location.reload(); return; }
    box.classList.add('out');
    setTimeout(() => { box.remove(); setTimeout(showUpdateNote, 10 * 60000); }, 220);
  });
  document.body.appendChild(box);
}
setNewBuildHandler(showUpdateNote);
setUnauthorizedHandler(() => { setToken(null); S.me = null; showLogin('Your session ended. Please sign in again.'); });

// ---------------- shell
function navHtml() {
  const { name: raw } = parseHash();
  const name = raw === 'project' ? 'projects' : /^dev-/.test(raw) ? 'dev' : raw;   // one project highlights Projects; every developer page highlights Developer
  const link = ([r, label, ic]) => `<a class="nav" data-ic="${ic}" href="#/${r}" ${(name === 'hr-import' ? 'hr' : name || '') === r ? 'aria-current="page"' : ''} data-k="n${r}">${icon(ic)}<span>${esc(label)}</span>${r === 'timeoff' && isMgr() && pendingBadge ? `<span class="badge" aria-label="${pendingBadge} waiting">${pendingBadge}</span>` : ''}${r === 'tasks' && taskBadge ? `<span class="badge" aria-label="${taskBadge} need attention">${taskBadge}</span>` : ''}${r === 'requests' && reqBadge ? `<span class="badge" aria-label="${reqBadge} waiting">${reqBadge}</span>` : ''}${r === 'chat' && chatBadge ? `<span class="badge${chatMention ? '' : ' soft'}" aria-label="${chatBadge} unread">${chatBadge > 99 ? '99+' : chatBadge}</span>` : ''}${r === 'inbox' && inboxBadge ? `<span class="badge${inboxLate ? '' : ' soft'}" aria-label="${inboxBadge} waiting">${inboxBadge}</span>` : ''}</a>`;
  // grouped like the work: what is happening today, the work itself, time, and running the company
  const grp = (t, list) => `<div class="nav-g"><div class="nav-h">${t}</div>${list.map(link).join('')}</div>`;
  const pick = (nav, keys) => keys.map((k) => nav.find((n) => n[0] === k)).filter(Boolean);
  const payNav = ['pay', 'Pay', 'wallet'];
  if (isMgr()) {
    const money = isHR() ? HR_NAV : [HR_NAV[2]];
    return grp('Today', [...(god() ? [['', 'Home', 'dash'], ['team', 'Team', 'users']] : pick(MGR_NAV, [''])), ...(S.me.tracks_time || S.me.fun_mode ? [['me', 'Your day', 'user']] : []), CHAT_NAV, ['checkins', 'Check-ins', 'checkin'], ...LB_NAV(), ...pick(MGR_NAV, ['timeline', 'screenshots'])]) + grp('Work', [...pick(MGR_NAV, ['projects']), ['clients', 'Clients', 'client'], ['inbox', 'Client inbox', 'chat'], ...pick(MGR_NAV, ['tasks', 'performance'])])
      + grp('Time', pick(MGR_NAV, ['timesheets', 'attendance', 'timeoff', 'requests', 'reports'])) + grp(isHR() ? 'HR' : 'Money', [...money, ...(S.me.role === 'owner' ? [] : [payNav])])
      + grp('Manage', [['announcements', 'Announcements', 'mega'], ...MGR_NAV2.filter((n) => n[0] !== 'settings' || S.me.role === 'owner'), ...DEV_NAV()]);
  }
  return grp('Today', [...(god() ? [['', 'Home', 'dash'], ['me', 'Your day', 'user']] : pick(EMP_NAV, [''])), CHAT_NAV, ...(S.me.tracks_time ? [['checkin', 'Check-in', 'checkin']] : []), ...LB_NAV(), ...pick(EMP_NAV, ['timeline', 'screenshots'])]) + grp('Work', [...pick(EMP_NAV, ['projects']), ...(hasClients ? [['inbox', 'Client inbox', 'chat']] : []), ...pick(EMP_NAV, ['tasks', 'performance'])])
    + grp('Time', pick(EMP_NAV, ['timesheets', 'attendance', 'timeoff'])) + (isHR() ? grp('HR', HR_NAV) : '') + grp('You', [['announcements', 'Announcements', 'mega'], payNav, ...pick(EMP_NAV, ['profile'])]) + (S.me.is_dev ? grp('Build', DEV_NAV()) : '');
}
function buildShell() {
  const u = S.me;
  app.innerHTML = `<a class="skip" href="#view">Skip to content</a><div class="shell">
    <nav class="rail" aria-label="Main"><div class="brand"><span class="mark">${owl('watch', 'Staffwarden')}</span><div><b class="wordmark">staffwarden</b><span>${esc(S.settings.org_name)}</span></div></div>
      <div id="nav" style="display:flex;flex-direction:column;gap:2px"></div>
      <p class="credit rail-credit">${CREDIT}</p>
      <div class="who"><a href="#/profile" class="me-link" id="melink" aria-label="Your profile: settings, sign-ins and the desktop app"><span class="avatar" style="background:${avColor(u.id)}">${esc(initials(u.name))}</span><span class="me-txt"><span class="nm">${esc(u.name)}</span><span class="rl me-cta">Open profile</span></span><svg class="me-chev" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
      <button class="btn icon" data-act="logout" aria-label="Sign out" title="Sign out">${icon('out').toString()}</button></div></nav>
    <main class="main" id="main"><div class="topstrip"><div class="annbar" id="annbar" role="status" hidden></div><span class="livepill" id="pill" role="status"><i></i><span id="pilltxt">Connecting…</span></span>
      ${bellHtml()}<button class="btn sm" data-act="tour" aria-label="How Staffwarden works">${icon('help').toString()} Tour</button><button class="btn sm" id="refbtn" data-act="refresh" aria-label="Refresh now">${icon('refresh').toString()} Refresh</button></div><div id="view" tabindex="-1"></div></main></div>`;
  view = document.getElementById('view');
  navEl = document.getElementById('nav');
  morph(navEl, navHtml());
}
// on a phone the menu is a strip that scrolls sideways: the page you're on is always in it
function navInView(strip, item) {
  if (!strip || !item || strip.scrollWidth <= strip.clientWidth + 2) return;
  const sr = strip.getBoundingClientRect(), ir = item.getBoundingClientRect();
  if (ir.left < sr.left + 8 || ir.right > sr.right - 8) strip.scrollLeft += ir.left - sr.left - (sr.width - ir.width) / 2;
}
function updateNav() {
  if (navEl) { morph(navEl, navHtml()); navInView(navEl, navEl.querySelector('[aria-current="page"]')); }
  const me = document.getElementById('melink');
  if (me) { if (/^#\/profile/.test(location.hash)) me.setAttribute('aria-current', 'page'); else me.removeAttribute('aria-current'); }
}
function updatePill() {
  const pill = document.getElementById('pill'), txt = document.getElementById('pilltxt');
  if (!pill) return;
  let cls = 'livepill', t;
  if (lastErr && !lastOk) { cls += ' slow'; t = 'Cannot load'; }
  else if (lastErr) { cls += ' slow'; t = `Offline · last updated ${ago(Date.now() - lastOk)}`; }
  else if (liveState === 'live') { cls += ' live'; t = lastOk ? `Live · updated ${ago(Date.now() - lastOk)}` : 'Live'; }
  else { cls += ' slow'; t = lastOk ? `Reconnecting · updated ${ago(Date.now() - lastOk)}` : 'Connecting…'; }
  // a phone has room for the state only; the full line is the tooltip
  if (matchMedia('(max-width: 760px)').matches) { pill.title = t; t = t.split(' · ')[0]; } else pill.removeAttribute('title');
  if (pill.className !== cls) pill.className = cls;
  if (txt.textContent !== t) txt.textContent = t;
}
actions.refresh = () => { const b = document.getElementById('refbtn'); if (b) b.classList.add('spin'); run({ manual: true }).finally(() => b && b.classList.remove('spin')); };

// tables that turn into cards on a phone: each cell carries its column's name
function labelTables(root) {
  for (const t of root.querySelectorAll('table.stack')) {
    const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => {
      if (heads[i] && td.dataset.l !== heads[i]) td.dataset.l = heads[i];
      const blank = /^[–-]?$/.test(td.textContent.trim());   // nothing to say: a phone card leaves it out
      if (blank !== (td.dataset.blank === '1')) { if (blank) td.dataset.blank = '1'; else delete td.dataset.blank; }
    });
  }
}
// ---------------- loading and rendering the current page
// loading shapes in the page's own layout: the band, then cards, so nothing jumps when it fills in
function skeleton() {
  const sk = (w, h = 12, cls = 'skel') => `<span class="${cls}" style="width:${w};height:${h}px;border-radius:8px"></span>`;
  const card = (n) => `<div class="sk-card">${sk('35%', 18)}${Array.from({ length: n }, (_, i) => sk(`${92 - i * 11}%`)).join('')}</div>`;
  return `<div class="page-h sk-page"><div>${sk('300px', 38, 'skel dark')}${sk('440px', 14, 'skel dark')}</div></div><div class="sk-grid"><div>${card(5)}${card(3)}</div><div>${card(3)}${card(2)}</div></div>`;
}

async function run({ navigated = false, manual = false } = {}) {
  if (!S.me) return;
  // a click on a link never waits for a background refresh: it goes ahead, and the older load is ignored
  // (a load that has been waiting a long time no longer holds the page back: it is overtaken and ignored)
  if (loading && !navigated && Date.now() - lastStart < 6000) {
    again = true;
    if (!wake) wake = setTimeout(() => { wake = null; run(); }, Math.max(200, 6000 - (Date.now() - lastStart)));
    return;
  }
  loading = true; lastStart = Date.now();
  const my = ++seq;
  const { name, q } = parseHash();
  const table = routes();
  const page = table[name] || table[''];
  const key = `${name}?${q}`;
  // the same page with a different chat, filter, tab or selection is not a new page: nothing replays,
  // the scroll stays where it is, and only the part that changed is redrawn
  const base = `${name}#${q.get('id') || ''}`;
  const soft = navigated && current.base === base;
  let shownCached = false;
  if (navigated && current.key !== key) {
    const cached = pageCache.get(key);
    if (cached) {
      try { morph(view, page.render(cached, q).toString()); if (page.after) page.after(view, cached); if (!soft) { enter(view); window.scrollTo(0, 0); } hydrateImages(view); tickClocks(view); current = { name, key, base }; shownCached = true; } catch { view.innerHTML = skeleton(); }
    } else if (current.name !== name) view.innerHTML = skeleton();
    else if (soft) view.setAttribute('aria-busy', 'true');
  }
  try {
    const data = await page.load(q);
    if (my !== seq || !S.me) return;
    pageCache.delete(key); pageCache.set(key, data);
    if (pageCache.size > 30) pageCache.delete(pageCache.keys().next().value);
    view.removeAttribute('aria-busy');
    const fresh = navigated && current.key !== key && !shownCached && !soft;
    const before = fresh || shownCached || soft ? null : snapshot(view);
    morph(view, page.render(data, q).toString());
    if (page.after) page.after(view, data);
    if (fresh) enter(view); else if (before) pulseChanges(view, before);
    hydrateImages(view);
    tickClocks(view);
    labelTables(view);
    document.title = `${page.title} · Staffwarden`;
    document.documentElement.classList.toggle('god', god());
    lastOk = Date.now(); lastErr = null;
    if (navigated && !soft) {
      if (!shownCached) window.scrollTo(0, 0);
      const h = view.querySelector('h1'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    }
    current = { name, key, base };
    refreshBadge();
    if (navigated) maybeProjectGuide(name);
    // a boost, a "Still there?" or an announcement opened from a notification
    if (navigated && q.get('boost')) showBoost(Number(q.get('boost')));
    if (navigated && q.get('nudge')) checkNudge(Number(q.get('nudge')));
    if (navigated) { refreshAnnBar(); refreshSysBanner(); }
    // deep links from notifications: #/tasks?task=12 opens that task
    const tid = Number(q.get('task'));
    if (tid && (navigated || openedTask !== key)) { openedTask = key; openTask(tid).catch(() => {}); }
  } catch (e) {
    if (e.status === 401 || my !== seq) return;
    lastErr = e;
    if (!view.querySelector('.page-h') || navigated) {
      const gone = e.status === 404 || e.status === 403;
      view.innerHTML = `<div class="page-h"><div><h1>${gone ? 'This isn’t here for you' : 'Couldn’t load this page'}</h1><p class="sub">${esc(errMsg(e))}</p></div></div>
        <section class="panel"><div class="empty"><b>${gone ? 'It may have been removed, or you were never added to it' : 'Check your connection, then try again'}</b>${gone ? 'Ask your manager if you think you should see it.' : 'Staffwarden keeps trying in the background too.'}<div class="mt">${gone ? '' : '<button class="btn primary" data-act="refresh">Try again</button> '}<a class="btn" href="#/">Go to your dashboard</a></div></div></section>`;
    }
    else if (manual) toast(errMsg(e), true);
  } finally {
    if (my === seq) {
      loading = false;
      updateNav(); updatePill();
      if (again) { again = false; schedule(); }
    }
  }
}
function schedule() {
  if (wake) return;
  if (document.hidden) { hiddenStale = true; return; }
  const wait = Math.max(150, 1500 - (Date.now() - lastStart));
  wake = setTimeout(() => { wake = null; run(); }, wait);
}
S.refresh = schedule;

let chatAt = 0, chatWait = null;
async function chatCount() {
  if (Date.now() - chatAt < 1500) { if (!chatWait) chatWait = setTimeout(() => { chatWait = null; chatCount(); }, 1600); return; }
  chatAt = Date.now();
  try { const r = await get('/api/team/unread'); if (r.unread !== chatBadge || r.mentions !== chatMention) { chatBadge = r.unread; chatMention = r.mentions; updateNav(); } } catch { /* badge is optional */ }
}
S.chatBadge = chatCount;
async function refreshBadge() {
  if (Date.now() - badgeAt < 10000) return;
  badgeAt = Date.now();
  chatCount();
  try {
    const t = await get('/api/tasks/summary');
    const n = (t.overdue || 0) + (t.to_review || 0);   // my overdue work, plus work waiting for my review
    if (n !== taskBadge) { taskBadge = n; updateNav(); }
  } catch { /* badge is optional */ }
  try {
    const ib = await get('/api/client-inbox');
    const mine = isMgr() ? ib.items : ib.items.filter((x) => x.mine);
    const late = mine.some((x) => x.level === 'late');
    const had = hasClients; hasClients = hasClients || ib.items.length > 0 || isMgr();
    if (mine.length !== inboxBadge || late !== inboxLate || had !== hasClients) { inboxBadge = mine.length; inboxLate = late; updateNav(); }
  } catch { /* badge is optional */ }
  if (!isMgr()) return;
  try {
    const list = await get('/api/timeoff?status=pending');
    const n = list.filter((r) => r.user_id !== S.me.id || S.me.role === 'owner').length;
    if (n !== pendingBadge) { pendingBadge = n; updateNav(); }
  } catch { /* badge is optional */ }
  try {
    const list = await get('/api/time-requests?status=pending');
    const n = list.filter((r) => r.user_id !== S.me.id || S.me.role === 'owner').length;
    if (n !== reqBadge) { reqBadge = n; updateNav(); }
  } catch { /* badge is optional */ }
}

// ---------------- live connection
async function onEvent(ev) {
  if (ev.type === 'notify') { onNotify(); return; }
  // the live chat updates itself; typing and reads never need the page reloaded
  if (ev.type === 'chat' || ev.type === 'chat_read' || ev.type === 'typing') { chatEvent(ev); if (ev.type === 'chat' || ev.type === 'chat_read') chatCount(); if (ev.type === 'typing' || (ev.type === 'chat_read' && current.name !== 'chat')) return; }
  if (ev.type === 'team_threads') { chatCount(); if (current.name !== 'chat') return; }
  if (ev.type === 'boost') { showBoost(ev.boost_id); return; }
  if (ev.type === 'idle') { checkNudge(); if (S.me.role !== 'owner' && !(isMgr() && current.name === '')) return; }
  if (ev.type === 'banner') { refreshSysBanner(); if (!/^dev/.test(current.name || '')) return; }
  if (ev.type === 'me' || ev.type === 'leaderboard') { try { S.me = await get('/api/me'); } catch { /* keep old */ } }
  if (ev.type === 'announcement') { refreshAnnBar(); if (current.name !== 'announcements') return; }
  if (ev.type === 'boost_answer' && current.name !== 'chat') return;
  if (ev.type === 'fun') { try { S.me = await get('/api/me'); } catch { /* keep old */ } }
  // god mode: my own timer started or paused (from the desktop app): the countdown or the pause card
  if ((ev.type === 'timer' || ev.type === 'pause') && S.me && ev.user_id === S.me.id && S.me.fun_mode) godTimer();
  if (ev.type === 'tasks' && S.me.fun_mode) funWatch();
  if (ev.type === 'settings') { try { S.settings = await get('/api/settings'); S.me = await get('/api/me'); } catch { /* keep old */ } }
  if (ev.type === 'users') invalidatePeople();
  if (ev.type === 'users' && ev.user_id === S.me.id) { try { S.me = await get('/api/me'); } catch { /* keep old */ } }
  if (ev.type === 'timeoff' || ev.type === 'tasks' || ev.type === 'requests') badgeAt = 0;
  schedule();
}

function start() {
  buildShell();
  window.addEventListener('hashchange', onHash);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('online', onVisible);
  stopLive = startLive({ onEvent, onState: (s) => { liveState = s; if (s === 'live') schedule(); updatePill(); } });
  timers.push(setInterval(() => { tickClocks(view); updatePill(); }, 1000));
  timers.push(setInterval(() => { if (!document.hidden) { schedule(); refreshSysBanner(); } }, 60000));      // safety net if the stream is blocked
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/');
  run({ navigated: true }).then(maybeTour);
  initNotify();
  setTimeout(() => { checkNudge(); refreshAnnBar(); }, 1200);
}
function onHash() { updateNav(); run({ navigated: true }); }
function onVisible() { if (document.hidden) return; if (hiddenStale || Date.now() - lastOk > 20000) { hiddenStale = false; schedule(); } }
function teardown() {
  pageCache.clear(); invalidatePeople();
  if (stopLive) stopLive(); stopLive = null;
  timers.forEach(clearInterval); timers = [];
  window.removeEventListener('hashchange', onHash);
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
  window.removeEventListener('online', onVisible);
  clearImages(); document.getElementById('overlay').innerHTML = '';
  resetNotify(); openedTask = null;
  current = { name: null, key: null }; lastOk = 0; lastErr = null; liveState = 'connecting'; pendingBadge = 0; taskBadge = 0; chatBadge = 0; chatMention = 0; badgeAt = 0;
}

async function boot() {
  if (!getToken()) return showLogin();
  // "See it as the client" opens here in its own tab, and stays a preview in that tab
  const pv = /^#\/client-view\?cu=(\d+)/.exec(location.hash);
  try {
    if (pv) { sessionStorage.setItem('wh-viewas', pv[1]); history.replaceState(null, '', '#/overview'); }
    const keep = sessionStorage.getItem('wh-viewas');
    if (keep) setViewAs(keep);
  } catch { if (pv) setViewAs(pv[1]); }
  try {
    S.me = await get('/api/me');
    S.settings = await get('/api/settings');
    godTimer();   // god mode: where the timer is now, so its next start or pause plays a moment
  } catch (e) {
    if (e.status === 401) return showLogin();
    app.innerHTML = `<div class="center"><div class="login"><div class="card"><h1>Can't reach the server</h1><p class="muted mt">${esc(errMsg(e))}</p><button class="btn primary mt" onclick="location.reload()">Try again</button></div></div></div>`;
    return;
  }
  teardown();
  // someone from a client: the portal, a separate little app with only their own projects
  if (S.me.kind === 'client') { const m = await import('./portal/app.js'); m.startPortal(app); return; }
  registerSW();
  start();
}

// ---------------- what goes wrong in this browser reaches the developer's Error reports (the message and
// where in the code; never what is on the screen or typed). Each problem once per page load, at most 20.
const reported = new Set();
function reportError(message, stack) {
  if (!getToken() || reported.size >= 20) return;
  const key = String(message).slice(0, 200);
  if (!key || reported.has(key) || /ResizeObserver loop|Script error\.?$/.test(key)) return;
  reported.add(key);
  fetch('/api/errors', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ message: key, stack: String(stack || '').slice(0, 3000) }) }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.message, e.error && e.error.stack ? e.error.stack : `${e.filename || ''}:${e.lineno || ''}`));
window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (r && r.status) return; reportError(r && r.message ? r.message : String(r), r && r.stack); });

// ---------------- global event delegation
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = el.dataset.act;
  if (a === 'q') { setQuery(el.dataset.q, el.dataset.v); return; }
  if (a === 'openshot') { openViewer(Number(el.dataset.i), { onDeleted: () => schedule() }); return; }
  const fn = actions[a];
  if (fn) fn(el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-q]');
  if (!el || el.matches('button')) return;
  const v = el.type === 'checkbox' ? (el.checked ? el.dataset.on || '1' : '') : el.value;
  setQuery(el.dataset.q, v);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-submit]');
  if (!f) return;
  e.preventDefault();
  const fn = actions[f.dataset.submit];
  if (fn) fn(f, e);
});

boot();
