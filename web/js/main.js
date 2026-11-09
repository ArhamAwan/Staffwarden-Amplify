import { get, post, getToken, setToken, setUnauthorizedHandler, setNewBuildHandler, startLive, clearImages, setViewAs } from './api.js';
import { registerSW } from './push.js';
import { requireNotifications, resetGate } from './notifygate.js';
import { html, esc, icon, ago, initials, avColor, HELM, owl, setHomeCurrency } from './util.js';
import { S, actions, toast, errMsg, tickClocks, hydrateImages, openViewer, dial } from './ui.js';
import { morph } from './morph.js';
import { enter, snapshot, pulseChanges } from './motion.js';
import { maybeTour, maybeProjectGuide } from './tour.js';
import { initNotify, onNotify, resetNotify, bellHtml } from './notify.js';
import { openTask } from './pages/tasks.js';
import { invalidatePeople } from './parts.js';
import { watchOverlay } from './lock.js';
import { chatEvent } from './chat.js';
import { handleLink, showClosed, companyInfo } from './links.js';
import { PAGE_FEATURE, hasFeature, planGatePage, accountBar, account } from './pages/billing.js';
watchOverlay();
import { teamPage, mePage } from './pages/dashboard.js';
import timeline from './pages/timeline.js';
import tasks from './pages/tasks.js';
import taskPage from './pages/taskpage.js';
import performance from './pages/performance.js';
import screenshots from './pages/screenshots.js';
import timesheets from './pages/timesheets.js';
import attendance from './pages/attendance.js';
import timeoff from './pages/timeoff.js';
import reports from './pages/reports.js';
import shiftReport from './pages/shiftreport.js';
import people from './pages/people.js';
import { projectsPage as projects, projectPage as project } from './pages/projects.js';
import { reviewPage as review } from './pages/pm.js';
import notes from './pages/notes.js';
import { applyTheme, clearTheme } from './theme.js';
// the person's colour theme (a client always sees the company's own look)
const syncTheme = () => { if (!S.me || S.me.kind === 'client') clearTheme(); else applyTheme(S.me.theme, S.me.brand); };
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

const MGR = { '': teamPage, me: mePage, chat: teamChatPage, checkin: checkinPage, checkins: checkinsPage, announcements: announcementsPage, tasks, task: taskPage, review, notes, project, clients: clientsPage, inbox: inboxPage, performance, productivity: performance, timeline, screenshots, timesheets, attendance, timeoff, requests: requestsPage, reports, 'shift-report': shiftReport, people, projects, audit: auditPage, profile };
const MGR_NAV = [
  ['', 'Dashboard', 'dash'], ['projects', 'Projects', 'folder'], ['tasks', 'Tasks', 'tasks'], ['performance', 'Performance', 'bolt'], ['timeline', 'Activity', 'pulse'], ['screenshots', 'Screenshots', 'camera'],
  ['timesheets', 'Timesheets', 'clock'], ['attendance', 'Attendance', 'cal'], ['timeoff', 'Time off', 'sun'], ['requests', 'Missing time', 'plus'], ['reports', 'Reports', 'chart'], ['shift-report', 'Shift reports', 'file'],
];
const MGR_NAV2 = [['people', 'People', 'users'], ['settings', 'Settings', 'gear'], ['audit', 'Audit log', 'log']];
const EMP = { '': mePage, me: mePage, chat: teamChatPage, checkin: checkinPage, checkins: checkinsPage, announcements: announcementsPage, projects, project, tasks, task: taskPage, review, notes, inbox: inboxPage, performance, productivity: performance, timeline, screenshots, timesheets, attendance, timeoff, profile };
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
    ? { ...MGR, team: teamPage, expenses, ...(S.me.role === 'owner' ? { settings: settingsPage } : {}), ...(S.me.role !== 'owner' || S.me.dev_owner ? { pay } : {}), ...(isHR() ? HR_PAGES : {}) }
    : { ...EMP, pay, ...(isHR() ? HR_PAGES : {}) };
  const lb = S.me.leaderboard ? { leaderboard } : {};
  const dev = S.me.is_dev ? { dev: devHome, 'dev-apps': devApps, 'dev-errors': devErrors, 'dev-tools': devTools } : {};
  const all = god() ? { ...base, ...lb, ...dev, '': godHome } : { ...base, ...lb, ...dev };
  // a page the company's plan doesn't include says so, and which plan has it
  for (const [k, f] of Object.entries(PAGE_FEATURE)) if (all[k] && !hasFeature(f)) all[k] = planGatePage(f);
  return all;
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
  // one button per computer, with its logo; the one matching this computer comes first
  const OS = {
    windows: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5.5l7.5-1v7H3zM11.5 4.4L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z"/></svg>',
    mac: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.2zM14 5.3c.7-.9 1.2-2 1-3.3-1 0-2.2.7-3 1.5-.6.7-1.2 1.9-1 3.1 1.1.1 2.3-.6 3-1.3z"/></svg>',
  };
  const here = /Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'windows' : '';
  const sorted = [...opts].sort((a, b) => (b[0].kind.startsWith(here || 'x') ? 1 : 0) - (a[0].kind.startsWith(here || 'x') ? 1 : 0));
  if (box.classList.contains('lk-dl')) {
    box.innerHTML = sorted.map(([d, n]) => { const os = d.kind === 'windows' ? 'windows' : 'mac'; const short = d.kind === 'windows' ? 'Windows' : d.kind === 'mac-arm' ? 'Mac, Apple chip' : 'Mac, Intel'; return `<a class="${here && d.kind.startsWith(here) ? 'lk-mine' : ''}" href="/downloads/${encodeURIComponent(d.file)}" download title="${esc(n)}, ${mb(d.size)}">${OS[os]}<span>${esc(short)}</span></a>`; }).join('');
    return;
  }
  if (box.classList.contains('si-dl')) {
    box.innerHTML = `<span class="si-dl-h">Track your time with the desktop app</span><div class="si-dl-row">${sorted.map(([d, n]) => { const os = d.kind === 'windows' ? 'windows' : 'mac'; const short = d.kind === 'windows' ? 'Windows' : d.kind === 'mac-arm' ? 'Apple chip' : 'Intel Mac'; return `<a class="si-dl-b${here && d.kind.startsWith(here) ? ' mine' : ''}" href="/downloads/${encodeURIComponent(d.file)}" download title="${esc(n)}, ${mb(d.size)}">${OS[os]}<span>${esc(short)}</span></a>`; }).join('')}</div>`;
    return;
  }
  box.innerHTML = `<b>Get the desktop app</b><span class="dl-sub">Start and stop your timer from it. It runs quietly in the menu bar or the tray.</span><div class="dl-grid">${sorted.map(([d, n]) => { const os = d.kind === 'windows' ? 'windows' : 'mac'; const short = d.kind === 'windows' ? 'Windows' : d.kind === 'mac-arm' ? 'Mac, Apple chip' : 'Mac, Intel chip'; return `<a class="dl-btn${here && d.kind.startsWith(here) ? ' mine' : ''}" href="/downloads/${encodeURIComponent(d.file)}" download title="${esc(n)}">${OS[os]}<span><b>${esc(short)}</b><small>${mb(d.size)}${d.kind === 'mac-arm' ? ' · for M1 and later' : d.kind === 'mac-intel' ? ' · for older Macs' : ' · Windows 10 and 11'}</small></span><svg class="dl-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`; }).join('')}</div>`;
  box.classList.toggle('light', !dark);
}

// on the sign-in page the owl's eyes follow the cursor, and he covers them while the password is typed
function watchLogin() {
  const page = app.querySelector('.si'), o = app.querySelector('.si-owl .owl'), look = o && o.querySelector('.ow-look');
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

async function showLogin(msg, email) {
  teardown();
  const co = await companyInfo();
  const pre = email || (/^#signin\?email=([^&]+)/.exec(location.hash) || [])[1];
  const preEmail = pre ? decodeURIComponent(pre) : '';
  const home = co.apex ? `${co.apex}/welcome` : '/welcome';
  // one screen, never scrolls: the owl in front of the moon on the left, one glass card on the right
  app.innerHTML = `<div class="si">
    <div class="si-sky" aria-hidden="true"><i class="si-stars"></i><i class="si-stars s2"></i><i class="si-glow"></i></div>
    <header class="si-top"><span class="si-brand"><span class="mark">${HELM}</span><b class="wordmark">Staffwarden</b></span><a class="si-home" href="${esc(home)}">What is Staffwarden?</a></header>
    <section class="si-art" aria-hidden="true">
      <div class="si-stage"><div class="si-moon"></div><div class="si-owl">${owl('live')}</div></div>
      <p class="si-tag">Keeping watch, so you don’t have&nbsp;to.</p>
    </section>
    <section class="si-card" aria-labelledby="si-h" id="si-card"></section>
    <footer class="si-foot">Time is tracked only while you choose to, and private windows never leave your computer.</footer>
  </div>`;
  const card = document.getElementById('si-card');
  const coRow = co.address ? `<div class="si-co"><span class="si-co-lg" style="background:${co.brand ? esc(co.brand) : '#6B55D6'}">${co.icon ? `<img src="${esc(co.icon)}" alt="">` : esc((co.name || '?').trim()[0].toUpperCase())}</span><span class="si-co-t"><b>${esc(co.name || '')}</b><span>${esc(co.address)}</span></span></div>` : '';
  function signInCard(m = msg, em = preEmail) {
    card.innerHTML = `<h1 id="si-h">Welcome back</h1><p class="si-sub">${co.address ? `Sign in to ${esc(co.name || 'your company')}.` : 'Sign in with the email and password you were given.'}</p>
      ${coRow}
      <form id="login" novalidate>
        <label class="si-f"><span>Email</span><input id="em" name="email" type="email" autocomplete="username" required placeholder="you@company.com" value="${esc(em)}"></label>
        <label class="si-f"><span>Password</span><input id="pw" name="password" type="password" autocomplete="current-password" required placeholder="Your password"></label>
        <p class="err" role="alert" id="login-err">${esc(m || '')}</p>
        <button class="si-go" type="submit">Sign in</button></form>
      <div class="si-links"><button type="button" class="si-forgot" id="forgot">Forgot password?</button>${co.apex ? `<a href="${esc(co.apex)}/signin">Not ${esc(co.name || 'your company')}?</a>` : ''}</div>
      <div id="dl" class="si-dl"></div>`;
    showDownloads(document.getElementById('dl'), { dark: false });
    watchLogin();
    const f = document.getElementById('login');
    (em ? f.password : f.email).focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button'), err = document.getElementById('login-err');
      err.textContent = ''; btn.disabled = true;
      try {
        const r = await post('/api/auth/login', { email: f.email.value.trim(), password: f.password.value });
        setToken(r.token);
        let after = null; try { after = sessionStorage.getItem('sw-after'); sessionStorage.removeItem('sw-after'); } catch { /* private window */ }
        if (after) history.replaceState(null, '', after); else if (/^#signin/.test(location.hash)) history.replaceState(null, '', '#/');
        await boot();
      } catch (ex) { err.textContent = errMsg(ex); btn.disabled = false; }
    });
    document.getElementById('forgot').addEventListener('click', () => forgotCard(f.email.value.trim()));
  }
  function forgotCard(em) {
    card.innerHTML = co.forgot ? `<h1 id="si-h">New password</h1><p class="si-sub">Type your email. If it’s one of ${esc(co.name || 'the company')}’s, we’ll send a link to set a new password.</p>
      <form id="fg" novalidate><label class="si-f"><span>Email</span><input name="email" type="email" autocomplete="username" required placeholder="you@company.com" value="${esc(em)}"></label>
        <p class="err" role="alert" id="fg-err"></p><button class="si-go" type="submit">Email me a link</button></form>
      <div class="si-links"><button type="button" class="si-forgot" id="back">Back to sign in</button></div>`
      : `<h1 id="si-h">Forgot your password?</h1><p class="si-sub">Ask whoever runs Staffwarden at your company. They can set a new one for you from People, in a minute.</p>
      <div class="si-links"><button type="button" class="si-forgot" id="back">Back to sign in</button></div>`;
    document.getElementById('back').addEventListener('click', () => signInCard('', em));
    const fg = document.getElementById('fg');
    if (!fg) return;
    fg.email.focus();
    fg.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = fg.querySelector('button'), err = document.getElementById('fg-err'), v = fg.email.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { err.textContent = 'That doesn’t look like an email address.'; fg.email.focus(); return; }
      err.textContent = ''; btn.disabled = true;
      try {
        await post('/api/auth/forgot', { email: v });
        card.innerHTML = `<h1 id="si-h">Check your email</h1><p class="si-sub">If <b>${esc(v)}</b> belongs to ${esc(co.name || 'the company')}, a link is on its way. It works for 30 minutes, once.</p>
          <div class="si-links"><button type="button" class="si-forgot" id="back">Back to sign in</button></div>`;
        document.getElementById('back').addEventListener('click', () => signInCard('', v));
      } catch (ex) { err.textContent = errMsg(ex); btn.disabled = false; }
    });
  }
  signInCard();
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
let navOpen = {}, navGroup = null, navGroupNow = null;
try { localStorage.removeItem('sw-rail'); } catch { /* private window */ }
try { navOpen = JSON.parse(localStorage.getItem('sw-nav-open') || '{}') || {}; } catch { navOpen = {}; }
actions['nav-g'] = (el) => {
  const g = el.dataset.g, box = el.closest('.nav-g'), open = box.classList.contains('shut');
  navOpen[g] = open;
  try { localStorage.setItem('sw-nav-open', JSON.stringify(navOpen)); } catch { /* private window */ }
  if (navEl) morph(navEl, navHtml());
};
function navHtml() {
  const { name: raw } = parseHash();
  const name = raw === 'project' ? 'projects' : raw === 'task' || raw === 'review' ? 'tasks' : /^dev-/.test(raw) ? 'dev' : raw;   // one project highlights Projects; every developer page highlights Developer
  const link = ([r, label, ic]) => `<a class="nav" data-ic="${ic}" href="#/${r}" ${(name === 'hr-import' ? 'hr' : name || '') === r ? 'aria-current="page"' : ''} data-k="n${r}">${icon(ic)}<span>${esc(label)}</span>${r === 'timeoff' && isMgr() && pendingBadge ? `<span class="badge" aria-label="${pendingBadge} waiting">${pendingBadge}</span>` : ''}${r === 'tasks' && taskBadge ? `<span class="badge" aria-label="${taskBadge} need attention">${taskBadge}</span>` : ''}${r === 'requests' && reqBadge ? `<span class="badge" aria-label="${reqBadge} waiting">${reqBadge}</span>` : ''}${r === 'chat' && chatBadge ? `<span class="badge${chatMention ? '' : ' soft'}" aria-label="${chatBadge} unread">${chatBadge > 99 ? '99+' : chatBadge}</span>` : ''}${r === 'inbox' && inboxBadge ? `<span class="badge${inboxLate ? '' : ' soft'}" aria-label="${inboxBadge} waiting">${inboxBadge}</span>` : ''}</a>`;
  // grouped like the work: what is happening today, the work itself, time, and running the company
  // groups fold away so the menu fits on one screen: Today and the group you are in stay open, the rest
  // show as one row with their count and any badges; you can open or close any of them
  const GI = { Today: 'dash', Work: 'client', Time: 'clock', HR: 'wallet', Money: 'wallet', Manage: 'gear', You: 'user', Build: 'code' };
  const routeOf = (n) => (n[0] === '' ? '' : n[0]);
  const here = name === 'hr-import' ? 'hr' : name || '';
  const grp = (t, list) => {
    // pages outside the plan: hidden, except for the owner (who can change the plan)
    list = list.filter(([r]) => !PAGE_FEATURE[r] || hasFeature(PAGE_FEATURE[r]) || (account() && account().billing));
    if (!list.length) return '';
    const mine = list.some((n) => routeOf(n) === here);
    // going to a page in another group opens that group; after that it stays as you leave it, open or closed
    if (mine) navGroupNow = t;
    if (mine && t !== navGroup && navOpen[t] === false) delete navOpen[t];
    const pref = navOpen[t];
    const open = t === 'Today' || (pref === undefined ? mine : pref);
    const items = list.map(link).join('');
    const bad = (items.match(/class="badge[^"]*"[^>]*>(\d+)/g) || []).reduce((a, m) => a + Number(m.replace(/.*>/, '')), 0);
    // a section is a small label, never an icon row like a page; closed, it shows only what waits inside it
    // (on the slim rail, a closed section is a labelled tile with a dashed edge, so it never reads as a page)
    const say = `${t}${open ? '' : `, ${list.length} pages`}${!open && bad ? `, ${bad} waiting` : ''}`;
    return `<div class="nav-g${open ? '' : ' shut'}" data-g="${t}">${t === 'Today' ? `<div class="nav-h">${t}</div>`
      : `<button type="button" class="nav-h nav-ht" data-act="nav-g" data-g="${t}" aria-expanded="${open}" aria-label="${esc(say)}" title="${esc(say)}"><span class="nav-tile" aria-hidden="true">${icon(GI[t] || 'folder')}<span>${t}</span>${!open && bad ? `<span class="nav-tc">${bad}</span>` : ''}</span><span class="nav-ht-t">${t}</span><span class="nav-ht-end">${!open && bad ? `<span class="nav-dot">${bad}</span>` : ''}<svg class="ic nav-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span></button>`}${t === 'Today' ? items : `<div class="nav-gi"><div>${items}</div></div>`}</div>`;
  };
  const pick = (nav, keys) => keys.map((k) => nav.find((n) => n[0] === k)).filter(Boolean);
  const payNav = ['pay', 'Pay', 'wallet'];
  queueMicrotask(() => { navGroup = navGroupNow; });
  if (isMgr()) {
    const money = isHR() ? HR_NAV : [HR_NAV[2]];
    return grp('Today', [...(god() ? [['', 'Home', 'dash'], ['team', 'Team', 'users']] : pick(MGR_NAV, [''])), ...(S.me.tracks_time || S.me.fun_mode ? [['me', 'Your day', 'user']] : []), CHAT_NAV, ['checkins', 'Check-ins', 'checkin'], ...LB_NAV(), ...pick(MGR_NAV, ['timeline', 'screenshots'])]) + grp('Work', [...pick(MGR_NAV, ['projects']), ['clients', 'Clients', 'building'], ['inbox', 'Client inbox', 'inbox'], ...pick(MGR_NAV, ['tasks']), ['notes', 'Notes', 'note'], ...pick(MGR_NAV, ['performance'])])
      + grp('Time', pick(MGR_NAV, ['timesheets', 'attendance', 'timeoff', 'requests', 'reports', 'shift-report'])) + grp(isHR() ? 'HR' : 'Money', [...money, ...(S.me.role === 'owner' && !S.me.dev_owner ? [] : [payNav])])
      + grp('Manage', [['announcements', 'Announcements', 'mega'], ...MGR_NAV2.filter((n) => n[0] !== 'settings' || S.me.role === 'owner'), ...DEV_NAV()]);
  }
  return grp('Today', [...(god() ? [['', 'Home', 'dash'], ['me', 'Your day', 'user']] : pick(EMP_NAV, [''])), CHAT_NAV, ...(S.me.tracks_time ? [['checkin', 'Check-in', 'checkin']] : []), ...LB_NAV(), ...pick(EMP_NAV, ['timeline', 'screenshots'])]) + grp('Work', [...pick(EMP_NAV, ['projects']), ...(hasClients ? [['inbox', 'Client inbox', 'inbox']] : []), ...pick(EMP_NAV, ['tasks']), ['notes', 'Notes', 'note'], ...pick(EMP_NAV, ['performance'])])
    + grp('Time', pick(EMP_NAV, ['timesheets', 'attendance', 'timeoff'])) + (isHR() ? grp('HR', HR_NAV) : '') + grp('You', [['announcements', 'Announcements', 'mega'], payNav, ...pick(EMP_NAV, ['profile'])]) + (S.me.is_dev ? grp('Build', DEV_NAV()) : '');
}
function buildShell() {
  const u = S.me;
  app.innerHTML = `<a class="skip" href="#view">Skip to content</a><div class="shell">
    <nav class="rail" aria-label="Main"><div class="brand"><span class="mark">${owl('watch', 'Staffwarden')}</span><div><b class="wordmark">Staffwarden</b><span>${esc(S.settings.org_name)}</span></div></div>
      <button type="button" class="rail-search" data-act="jump" aria-label="Search or jump to a page (Ctrl+K)">${icon('search')}<span>Search or jump to</span><kbd>${/Mac|iP/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd></button>
      <div id="nav" style="display:flex;flex-direction:column;gap:2px"></div>
      <a class="rail-clock" id="clock" href="#/me" hidden><i></i><span class="rc-t"></span><b class="rc-v num"></b></a>
      <div class="who"><a href="#/profile" class="me-link" id="melink" aria-label="Your profile: settings, sign-ins and the desktop app"><span class="avatar" style="background:${avColor(u.id)}">${esc(initials(u.name))}</span><span class="me-txt"><span class="nm">${esc(u.name)}</span><span class="rl me-cta">Open profile</span></span><svg class="me-chev" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
      <button class="btn icon" data-act="logout" aria-label="Sign out" title="Sign out">${icon('out').toString()}</button></div></nav>
    <main class="main" id="main"><div class="topstrip"><div class="annbar" id="annbar" role="status" hidden></div><span class="livepill" id="pill" role="status"><i></i><span id="pilltxt">Connecting…</span></span>
      ${bellHtml()}<button class="btn sm" data-act="tour" aria-label="How Staffwarden works">${icon('help').toString()} Tour</button><button class="btn sm" id="refbtn" data-act="refresh" aria-label="Refresh now">${icon('refresh').toString()} Refresh</button></div><div class="acct-note" id="acctbar" role="status" hidden></div><div id="view" tabindex="-1"></div></main></div>`;
  view = document.getElementById('view');
  navEl = document.getElementById('nav');
  morph(navEl, navHtml());
  clockAt = 0; refreshClock();
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
      try { morph(view, page.render(cached, q).toString()); if (page.after) page.after(view, cached, q); if (!soft) { enter(view); window.scrollTo(0, 0); } hydrateImages(view); tickClocks(view); current = { name, key, base }; shownCached = true; } catch { view.innerHTML = skeleton(); }
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
    if (page.after) page.after(view, data, q);
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
// right away, for a change the person just made (the normal refresh waits up to 1.5 s to group updates)
S.refreshNow = () => { if (wake) { clearTimeout(wake); wake = null; } run(); };

let chatAt = 0, chatWait = null;
async function chatCount() {
  if (Date.now() - chatAt < 1500) { if (!chatWait) chatWait = setTimeout(() => { chatWait = null; chatCount(); }, 1600); return; }
  chatAt = Date.now();
  try { const r = await get('/api/team/unread'); if (r.unread !== chatBadge || r.mentions !== chatMention) { chatBadge = r.unread; chatMention = r.mentions; updateNav(); } } catch { /* badge is optional */ }
}
S.chatBadge = chatCount;

// "On the clock" in the menu: your own timer, from the desktop app
let clockData = null, clockAt = 0;
async function refreshClock() {
  if (!S.me || S.me.kind === 'client' || Date.now() - clockAt < 5000) return;
  clockAt = Date.now();
  try { clockData = await get('/api/me/clock'); clockData.at = Date.now(); } catch { return; }
  paintClock();
}
function paintClock() {
  const el = document.getElementById('clock');
  if (!el || !clockData) return;
  const c = clockData, on = c.tracks && (c.state === 'working' || c.state === 'idle' || c.state === 'break');
  el.hidden = !on;
  if (!on) return;
  const secs = c.worked_secs + (c.state === 'break' ? 0 : Math.round((Date.now() - c.at) / 1000));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  const start = c.first_start ? new Date(c.first_start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '') : '';
  el.className = 'rail-clock' + (c.state === 'break' ? ' brk' : '');
  el.querySelector('.rc-t').innerHTML = c.state === 'break' ? `<b>On a break</b>${start ? `<small>since ${esc(start)}</small>` : ''}` : `<b>On the clock</b>${start ? `<small>since ${esc(start)}</small>` : ''}`;
  el.querySelector('.rc-v').textContent = `${h}h ${String(m).padStart(2, '0')}m`;
}
setInterval(paintClock, 30000);

// Search or jump to: every page in your menu, filtered as you type
actions.jump = () => {
  if (document.querySelector('.jump')) return;
  const pages = [...document.querySelectorAll('#nav a.nav')].map((a) => ({ href: a.getAttribute('href'), label: a.textContent.trim().replace(/\d+$/, ''), ic: a.dataset.ic }));
  const box = document.createElement('div');
  box.className = 'scrim top jump';
  box.innerHTML = `<div class="jump-p" role="dialog" aria-label="Jump to a page"><label class="jump-f">${icon('search')}<input type="text" placeholder="Jump to a page" aria-label="Jump to a page" autocomplete="off"></label><ul class="jump-l"></ul></div>`;
  document.body.appendChild(box);
  const input = box.querySelector('input'), list = box.querySelector('.jump-l');
  let sel = 0, shown = pages;
  const paint = () => { list.innerHTML = shown.map((p, i) => `<li><a href="${esc(p.href)}" class="${i === sel ? 'on' : ''}">${icon(p.ic)}<span>${esc(p.label)}</span></a></li>`).join('') || '<li class="jump-none">No page with that name</li>'; };
  const close = () => box.remove();
  input.addEventListener('input', () => { const q = input.value.trim().toLowerCase(); shown = pages.filter((p) => p.label.toLowerCase().includes(q)); sel = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
    else if (e.key === 'Enter' && shown[sel]) { location.hash = shown[sel].href.slice(1); close(); }
    else if (e.key === 'Escape') close();
  });
  box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('a')) close(); });
  paint(); input.focus();
};
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && S.me && S.me.kind !== 'client') { e.preventDefault(); actions.jump(); } });
async function refreshBadge() {
  if (Date.now() - badgeAt < 10000) return;
  badgeAt = Date.now();
  chatCount(); clockAt = 0; refreshClock();
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
  if (ev.type === 'notify') { onNotify(); refreshAnnBar(); return; }
  // the live chat updates itself; typing and reads never need the page reloaded
  if (ev.type === 'chat' || ev.type === 'chat_read' || ev.type === 'typing') { chatEvent(ev); if (ev.type === 'chat' || ev.type === 'chat_read') chatCount(); if (ev.type === 'typing' || (ev.type === 'chat_read' && current.name !== 'chat')) return; }
  if (ev.type === 'team_threads') { chatCount(); if (current.name !== 'chat') return; }
  if (ev.type === 'boost') { showBoost(ev.boost_id); return; }
  if (ev.type === 'idle') { checkNudge(); if (S.me.role !== 'owner' && !(isMgr() && current.name === '')) return; }
  if (ev.type === 'banner') { refreshSysBanner(); if (!/^dev/.test(current.name || '')) return; }
  if (ev.type === 'me' || ev.type === 'leaderboard') { try { S.me = await get('/api/me'); } catch { /* keep old */ } updateNav(); showAcctBar(); }
  if (ev.type === 'announcement') { refreshAnnBar(); if (current.name !== 'announcements') return; }
  if (ev.type === 'boost_answer' && current.name !== 'chat') return;
  if (ev.type === 'fun') { try { S.me = await get('/api/me'); } catch { /* keep old */ } }
  // god mode: my own timer started or paused (from the desktop app): the countdown or the pause card
  if ((ev.type === 'timer' || ev.type === 'pause') && S.me && ev.user_id === S.me.id && S.me.fun_mode) godTimer();
  if (ev.type === 'tasks' && S.me.fun_mode) funWatch();
  if (ev.type === 'settings') { try { S.settings = await get('/api/settings'); setHomeCurrency(S.settings.pay_currency); S.me = await get('/api/me'); } catch { /* keep old */ } }
  if (ev.type === 'users') invalidatePeople();
  if (ev.type === 'users' && ev.user_id === S.me.id) { try { S.me = await get('/api/me'); } catch { /* keep old */ } }
  if (['me', 'settings', 'users', 'fun', 'leaderboard'].includes(ev.type)) syncTheme();
  if (ev.type === 'timeoff' || ev.type === 'tasks' || ev.type === 'requests') badgeAt = 0;
  if ((ev.type === 'timer' || ev.type === 'pause') && S.me && ev.user_id === S.me.id) { clockAt = 0; refreshClock(); }
  schedule();
}

// the account's news for this person (a trial ending, a declined card, tracking paused), above every page
function showAcctBar() {
  const el = document.getElementById('acctbar');
  if (!el) return;
  const b = accountBar();
  if (!b) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false; el.className = `acct-note ${b.tone}`;
  el.innerHTML = `<span class="an-ic" aria-hidden="true">${icon(b.tone === 'bad' ? 'flag' : 'clock')}</span><div class="an-t">${b.html}</div>${b.act ? `<a class="btn sm ${b.tone === 'bad' ? 'primary' : 'amber'}" href="${b.act[1]}">${esc(b.act[0])}</a>` : ''}`;
}
function start() {
  buildShell();
  showAcctBar();
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
  requireNotifications();
  setTimeout(() => { checkNudge(); refreshAnnBar(); }, 1200);
}
function onHash() { updateNav(); run({ navigated: true }); }
function onVisible() { if (document.hidden) return; if (hiddenStale || Date.now() - lastOk > 20000) { hiddenStale = false; schedule(); } }
function teardown() {
  pageCache.clear(); invalidatePeople(); resetGate();
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
  // someone new (from an ad or a link) arriving at the plain address sees what Staffwarden is first;
  // the desktop app, links into the app and "Sign in" (#signin) go straight to signing in
  // a link from an email (an invite, a new password, taking over) or a new owner arriving from sign-up
  if (await handleLink(app, { boot, showLogin, showDownloads })) return;
  if (!getToken() && !location.hash && location.pathname === '/' && !/Electron|Staffwarden/i.test(navigator.userAgent) && !(await companyInfo()).address) { location.replace('/welcome'); return; }
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
    setHomeCurrency(S.settings.pay_currency);
    godTimer();   // god mode: where the timer is now, so its next start or pause plays a moment
  } catch (e) {
    if (e.status === 401) return showLogin();
    if (e.status === 403 && e.data && e.data.closed) return showClosed(app, e.data);
    app.innerHTML = `<div class="center"><div class="login"><div class="card"><h1>Can't reach the server</h1><p class="muted mt">${esc(errMsg(e))}</p><button class="btn primary mt" onclick="location.reload()">Try again</button></div></div></div>`;
    return;
  }
  teardown();
  syncTheme();
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
