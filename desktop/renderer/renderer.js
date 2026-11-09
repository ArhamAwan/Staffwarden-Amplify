'use strict';
// night glass: a Mac window is see-through (vibrancy); Windows and Linux get a solid night background
document.documentElement.classList.add(/Mac/.test(navigator.platform) ? 'mac' : 'solid');
// Sandboxed UI. Only talks to the main process through window.tracker (see preload.js).
const root = document.getElementById('root');
const API = window.tracker;
let projects = [];
let myTasks = [];
let selectedProject = '', selectedTask = '';
let lastStatus = null;
let settings = null;
let me = null;
let permKey = null, bodyKey = null;
let tz = 0;
let upd = null, updLater = null;   // the update state from the main process

const REASONS = [
  { id: 'break', label: 'Short break' }, { id: 'dinner', label: 'Dinner' }, { id: 'lunch', label: 'Lunch' }, { id: 'prayer', label: 'Prayer' },
  { id: 'personal', label: 'Personal' }, { id: 'other', label: 'Other' },
];
const reasonLabel = (id) => (((settings && settings.pause_reasons) || REASONS).find((r) => r.id === id) || { label: id === 'idle' ? 'Idle' : id }).label;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const clear = (n = root) => { while (n.firstChild) n.removeChild(n.firstChild); };
const pad = (n) => String(n).padStart(2, '0');
const hms = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(pad).join(':');
const dur = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${pad(m)}m` : m ? `${m}m` : `${s}s`; };
const tod = (iso) => { const d = new Date(Date.parse(iso) + tz * 60000); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${pad(m)} ${ap}`; };
const dayLabel = (day) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
// Screenshots per 10 minutes for this person (their own setting, their team's, or the company's).
// Due dates as people say them: "Today", "Tomorrow", "Overdue (Mon, Oct 26)".
function dueText(t) {
  if (!t.due_day) return '';
  if (t.overdue) return 'Overdue';
  if (t.due_today) return 'Due today';
  const d = new Date(t.due_day + 'T12:00:00Z');
  return 'Due ' + d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const isPersonal = (t) => me && t.created_by === me.id && (t.assignee_id == null || t.assignee_id === me.id);
const reviewOn = () => !settings || settings.task_review_required !== false;
async function loadTasks() { const r = await API.myTasks(); myTasks = Array.isArray(r) ? r : []; }

const shotsN = () => (lastStatus && lastStatus.active && lastStatus.shotsPer10 != null ? lastStatus.shotsPer10 : me && me.shots_per_10 != null ? me.shots_per_10 : settings && settings.shots_per_10 != null ? settings.shots_per_10 : 2);
const everyText = () => { const n = shotsN(); return n === 1 ? 'once every 10 minutes' : `${n} times every 10 minutes`; };
const shotsLine = () => (shotsN() === 0 ? 'Screenshots are turned off for you. Only your time and activity are tracked.' : `Screenshots are on: ${everyText()}, at random moments.`);
const svg = (d, size = 18) => { const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); n.setAttribute('width', size); n.setAttribute('height', size); n.setAttribute('viewBox', '0 0 24 24'); n.setAttribute('fill', 'currentColor'); n.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); n.append(p); return n; };
const PAUSE_ICON = 'M7 4h4v16H7zM13 4h4v16h-4z';

const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
// A new screen settles in once; later 1-second updates never replay it.
let enterTimer = null;
function enterView() {
  if (reducedMotion()) return;
  root.classList.remove('enter'); void root.offsetWidth; root.classList.add('enter');
  clearTimeout(enterTimer); enterTimer = setTimeout(() => root.classList.remove('enter'), 1100);
}
function leave(node, done) {
  if (reducedMotion()) { node.remove(); if (done) done(); return; }
  node.classList.add('leaving'); setTimeout(() => { node.remove(); if (done) done(); }, 170);
}

function toast(msg) {
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
}

// ---------- sign in / policy ----------
// Staffwarden's mark (a ship's wheel), the same drawing as the web dashboard's.
// Warden Owl, the Staffwarden mark (the same drawing as the website's)
const HELM = '<svg class="helm owl" viewBox="0 0 64 64" aria-hidden="true"><path d="M13 42c0-14 8-22 19-22s19 8 19 22c0 13-8 20-19 20s-19-7-19-20z" fill="#8C78E8"/><path d="M24 50c2.5 2 5 3 8 3s5.5-1 8-3M26 55.5c2 1.3 4 2 6 2s4-.7 6-2" stroke="#C3B3FF" stroke-width="2.2" stroke-linecap="round" fill="none"/><circle cx="24.5" cy="37" r="8.5" fill="#E9E6F5"/><circle cx="39.5" cy="37" r="8.5" fill="#E9E6F5"/><circle cx="24.5" cy="37" r="4.2" fill="#1A1238"/><circle cx="39.5" cy="37" r="4.2" fill="#1A1238"/><circle cx="26" cy="35.5" r="1.3" fill="#fff"/><circle cx="41" cy="35.5" r="1.3" fill="#fff"/><path d="M29.5 43h5L32 47.5z" fill="#F7B544"/><path d="M13 30c0-12 8-20 19-20s19 8 19 20z" fill="#4A37A8"/><rect x="14" y="27" width="36" height="4" rx="1.5" fill="#35267F"/><path d="M13 30.5h38c-2 3-8.5 4-19 4s-17-1-19-4z" fill="#241A5C"/><circle cx="32" cy="18.5" r="4.4" fill="#C3B3FF"/><circle cx="32" cy="17.6" r="1.3" fill="#4A37A8"/><path d="M31.2 18.4h1.6l.5 2.8h-2.6z" fill="#4A37A8"/></svg>';
function brand() { const m = el('div', { class: 'mark' }); m.innerHTML = HELM; return el('div', { class: 'brand' }, m, el('h1', { class: 'wordmark' }, 'Staffwarden')); }
const credit = () => el('div', { class: 'credit' },
  el('p', { class: 'verline' }, el('span', { class: 'ver' }, upd && upd.current ? `Version ${upd.current}` : ''), upd && upd.current ? ' · ' : '',
    el('button', { class: 'link small chk', onclick: (e) => checkNow(e.currentTarget) }, 'Check for updates')));
// "Check for updates": says the answer right there, and shows the update bar when there is one.
async function checkNow(btn) {
  const line = btn.closest('.verline');
  btn.disabled = true; btn.textContent = 'Checking…';
  const r = await API.checkUpdate();
  btn.disabled = false; btn.textContent = 'Check for updates';
  let msg = line.querySelector('.chkmsg');
  if (!msg) { msg = el('span', { class: 'chkmsg', role: 'status' }); line.append(msg); }
  if (!r || r.error || r.answer === 'offline') msg.textContent = ' · Could not reach the server. Try again in a moment.';
  else if (r.answer === 'unsupported') msg.textContent = ' · Updates work in the installed app.';
  else if (r.answer === 'available') { msg.textContent = ` · Version ${r.latest} is available below.`; updLater = null; renderUpdate(r); }
  else msg.textContent = ' · You have the latest version.';
}


// ---------- signing in: email first, then the company's password ----------
// The owl in front of the moon on top; below it one step at a time. On Staffwarden as a service the email
// finds the company (and its own address); a server for one company goes straight to the password.
const TRUST = [
  ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3v5l3 2', 'Records only while your timer runs'],
  ['M3 5h18v12H3zM8 21h8M12 17v4', 'You see every screenshot before it’s sent'],
  ['M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3', 'Private windows never leave this computer'],
];
const line = (d) => { const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); n.setAttribute('viewBox', '0 0 24 24'); n.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); n.append(p); return n; };
const COLORS = ['#1D4ED8', '#0F766E', '#B45309', '#7C3AED', '#BE185D', '#15803D', '#C2410C', '#4338CA'];
const colorOf = (t) => COLORS[[...String(t)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const isCompanyUrl = (u) => /^https?:\/\/[a-z0-9-]+\.[^/]+\.[^/]+/i.test(u || '');
let signin = { email: '', company: null, list: null };
function hero(small) {
  const owlBox = el('div', { class: 'si2-moon' }); owlBox.innerHTML = HELM;
  return el('div', { class: `si2-hero${small ? ' small' : ''}`, 'aria-hidden': 'true' }, el('i', { class: 'si2-stars' }), owlBox,
    el('div', { class: 'si2-wm' }, el('b', {}, 'Staffwarden'), small ? null : el('span', {}, 'Keeping watch, so you don’t have to.')));
}
function loginView(serverUrl, message, fixedServer = false) {
  clear(); bodyKey = null;
  // signed in to a company before: straight to its password
  if (!signin.company && isCompanyUrl(serverUrl) && fixedServer) signin.company = { url: serverUrl, address: serverUrl.replace(/^https?:\/\//, ''), name: null };
  if (signin.company || signin.single) return passwordStep(serverUrl, message, fixedServer);
  if (signin.list) return pickStep(serverUrl, fixedServer);
  const err = el('div', { class: 'err', role: 'alert' }, message || '');
  const email = el('input', { id: 'em', class: 'si2-in', type: 'email', autocomplete: 'username', value: signin.email, placeholder: 'you@company.com' });
  const go = el('button', { class: 'block si2-go' }, 'Continue');
  let typeAddress = !fixedServer && !isCompanyUrl(serverUrl) && serverUrl && !/localhost:3000/.test(serverUrl);
  const server = el('input', { id: 'srv', class: 'si2-in', value: serverUrl || '', placeholder: 'yourcompany.staffwarden.com' });
  const body = el('form', { class: 'si2-body', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const v = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { err.textContent = 'That doesn’t look like an email address.'; email.focus(); return; }
    signin.email = v;
    if (typeAddress) { signin.single = true; signin.server = server.value.trim(); return loginView(serverUrl, '', fixedServer); }
    go.disabled = true; go.textContent = 'Finding your company…';
    const r = await API.findCompany(v);
    go.disabled = false; go.textContent = 'Continue';
    if (r.error) { err.textContent = r.error; return; }
    if (r.single) { signin.single = true; return loginView(serverUrl, '', fixedServer); }
    if (!r.companies.length) { err.textContent = 'We couldn’t find a company with this email. Check the email in your invite, or ask whoever runs Staffwarden at your company.'; return; }
    if (r.companies.length === 1) { signin.company = r.companies[0]; return loginView(serverUrl, '', fixedServer); }
    signin.list = r.companies; return loginView(serverUrl, '', fixedServer);
  } },
  ...(typeAddress ? [el('label', { for: 'srv' }, 'Company address'), server] : []),
  el('label', { for: 'em' }, 'Work email'), email, err, go,
  el('div', { class: 'si2-hint' }, line('M5 12.5l4.5 4.5L19 7.5'), el('span', {}, typeAddress ? 'Signing in to the address above.' : 'We find your company from your email.')),
  el('ul', { class: 'si2-trust', 'aria-label': 'What the app records' }, TRUST.map(([d, t]) => el('li', {}, el('span', { class: 'ti' }, line(d)), el('span', {}, t)))),
  el('div', { class: 'si2-foot' }, fixedServer ? null : el('p', {}, typeAddress ? 'Find it by email instead? ' : 'Have a company address instead? ', el('button', { type: 'button', class: 'link', onclick: () => { typeAddress = !typeAddress; signin.single = false; loginView(serverUrl, '', fixedServer); } }, typeAddress ? 'Use my email' : 'Type it in'))),
  credit());
  root.append(el('div', { class: 'si2' }, hero(false), body));
  email.focus();
  enterView();
}
function companyCard(c, onChange) {
  const name = c.name || c.address;
  return el('div', { class: 'si2-co' }, el('span', { class: 'lg', style: `background:${colorOf(c.slug || c.address)}` }, (name.trim()[0] || '?').toUpperCase()),
    el('div', { class: 'si2-co-t' }, el('b', {}, name), c.name ? el('span', {}, c.address) : null),
    onChange ? el('button', { type: 'button', class: 'link', onclick: onChange }, 'Change') : null);
}
function passwordStep(serverUrl, message, fixedServer) {
  const c = signin.company, err = el('div', { class: 'err', role: 'alert' }, message || '');
  const email = el('input', { id: 'em', class: 'si2-in', type: 'email', autocomplete: 'username', value: signin.email });
  const pw = el('input', { id: 'pw', class: 'si2-in', type: 'password', autocomplete: 'current-password', placeholder: 'Your password' });
  const target = c ? c.url : signin.server || serverUrl;
  const change = () => { signin = { email: email.value.trim(), company: null, list: null }; loginView(fixedServer ? '' : serverUrl, '', fixedServer); };
  const go = el('button', { class: 'block si2-go' }, c && c.name ? `Sign in to ${c.name.split(' ')[0]}` : 'Sign in');
  const body = el('form', { class: 'si2-body', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    go.disabled = true;
    const r = await API.login({ serverUrl: target, email: email.value.trim(), password: pw.value });
    go.disabled = false;
    if (r.error) { err.textContent = r.error; pw.focus(); } else { signin = { email: '', company: null, list: null }; boot(); }
  } },
  c ? companyCard(c, change) : null,
  el('label', { for: 'em' }, 'Email'), email, el('label', { for: 'pw' }, 'Password'), pw, err, go,
  el('button', { type: 'button', class: 'link si2-forgot', onclick: () => API.openForgot(target) }, 'Forgot password?'),
  c ? null : el('button', { type: 'button', class: 'link si2-forgot', onclick: change }, 'Use another email'),
  el('div', { class: 'si2-foot' }, c ? el('p', {}, `The app remembers ${c.name || 'your company'} on this computer.`) : null, credit()));
  root.append(el('div', { class: 'si2' }, hero(true), body));
  (email.value ? pw : email).focus();
  enterView();
}
function pickStep(serverUrl, fixedServer) {
  const list = signin.list;
  const body = el('div', { class: 'si2-body' },
    el('h2', { class: 'si2-h' }, 'Which company?'),
    el('p', { class: 'muted' }, `${signin.email} is in ${list.length} companies. Each has its own password.`),
    el('ul', { class: 'si2-cos' }, list.map((c) => el('li', {}, el('button', { type: 'button', onclick: () => { signin.company = c; signin.list = null; loginView(serverUrl, '', fixedServer); } },
      el('span', { class: 'lg', style: `background:${colorOf(c.slug)}` }, (c.name.trim()[0] || '?').toUpperCase()), el('span', { class: 't' }, el('b', {}, c.name), el('span', {}, c.address)), line('M9 6l6 6-6 6'))))),
    el('button', { type: 'button', class: 'link si2-forgot', onclick: () => { signin = { email: signin.email, company: null, list: null }; loginView(serverUrl, '', fixedServer); } }, 'Use another email'),
    el('div', { class: 'si2-foot' }, credit()));
  root.append(el('div', { class: 'si2' }, hero(true), body));
  enterView();
}

function hiddenApps() {
  const list = (settings && settings.blackout_apps) || ['WhatsApp'];
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
}
// Everything that is hidden, in words.
function hiddenList() {
  const parts = ['WhatsApp, Telegram, Signal and other messaging apps', 'password managers', 'private and incognito browser windows', 'banking and payment sites', 'social media', 'notification pop-ups'];
  const extra = ((settings && settings.blackout_apps) || []).filter((a) => a.toLowerCase() !== 'whatsapp');
  if (extra.length) parts.push(extra.join(', '));
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// ---------- welcome wizard ----------
// Shown before tracking can start (the last step is accepting the policy), and any time from "How it works".
function wizardSteps(review) {
  const first = me && me.name ? me.name.split(' ')[0] : '';
  const days = settings && settings.retention_days ? settings.retention_days : 60;
  const idle = settings && settings.idle_limit_min ? settings.idle_limit_min : 10;
  const canDelete = !settings || settings.employees_can_delete_shots !== false;
  const list = [
    { scene: 'timer', title: first ? `Welcome, ${first}` : 'Welcome', text: 'Staffwarden records your working time, and only while you choose to. Here is exactly what it does, step by step.', points: ['Staffwarden is built entirely in-house by Amplify Media Technologies. Your data goes to our own server, not to an outside company.'] },
    { scene: 'pauses', title: 'You are in control', text: 'Nothing is recorded until you press Start.', points: [
      'Pause any time and pick why: a short break, lunch, prayer or something personal.',
      'Every pause is saved with its start and end, so your day adds up.',
      'If your computer sleeps or restarts during your shift, the timer carries on when it is back; the time it was off is not counted. After your shift, or after hours asleep, the timer stops at the moment the computer went to sleep.',
      'Staffwarden only opens when this computer starts if you turn that on. Closing the window keeps it in the menu bar; press Stop when you finish.',
      'When your shift ends you get a reminder to stop your timer before you shut down. Stop asks "are you sure?" first.'] },
    shotsN() === 0
      ? { scene: 'shots', title: 'Screenshots are off for you', text: 'Your manager has turned screenshots off for you. Only your working time, breaks and activity level are tracked.' }
      : { scene: 'shots', title: 'Screenshots while the timer runs', text: `A screenshot is taken ${everyText()}, at random moments.`, points: [
        'You get a notification each time.',
        settings && settings.capture_screens === 'all' ? 'Every screen connected to this computer is included.' : 'Only the screen you are working on (the one with your mouse) is captured, not your other screens.',
        settings && settings.blur_shots ? 'Screenshots are blurred on this computer before they are sent, so only the outline of your work can be seen.' : null,
        'While you are paused, idle or stopped, no screenshots are taken. The app shows this clearly.'].filter(Boolean) },
    { scene: 'blackout', title: 'Private windows are blacked out', text: `Before a screenshot is saved, ${hiddenList()} are painted solid black on this computer. The original never leaves your computer.`, points: [
      'Only the private window is painted black. The rest of the screen is captured as normal.',
      'Use Test screenshot any time to see exactly what gets captured.',
      'Message pop-ups are not windows, so turn off message previews in your notifications.'] },
    { scene: 'activity', title: 'Activity, never keystrokes', text: 'The app measures how much you use your keyboard and mouse, as a percentage. It never records what you type, so passwords and messages are never captured.', points: [
      'Which apps or websites you use is not recorded.',
      `After ${idle} minutes with no keyboard or mouse, your timer keeps running but that time is marked idle, and no screenshots are taken until you are back.`] },
    { scene: 'pick', title: 'Work on your tasks', text: 'Your work comes as tasks in projects, numbered like MA-12. Pick the task before you press Start, so your time is counted against it.', points: [
      'Your own tasks are listed first; overdue ones are marked, and the project fills itself in.',
      settings && settings.task_review_required === false ? 'Starting moves the task to In progress. When you finish, mark it done.' : 'Starting moves the task to In progress. When you finish, press Send for review; a manager or the project lead approves it.',
      'You get a reminder once a day about tasks that are overdue or due today. The dashboard explains projects in more detail.'] },
    { scene: review ? 'done' : 'yours', title: review ? 'That is everything' : 'Your data, your view', text: `Your manager sees your time, breaks, attendance and screenshots. ${canDelete ? 'You can see all of your screenshots on the dashboard and delete any of them.' : 'You can see all of your screenshots on the dashboard.'} They are deleted automatically after ${days} days.`, points: [
      'On the dashboard you can see who opened each of your screenshots, and when.',
      settings && settings.team_visibility === 'off' ? null : `${settings && settings.team_visibility === 'team' ? 'People in your team' : 'Everyone in the company'} can see whether you are working, on a break, idle or not started, and your hours today. Never your screenshots, activity or why you are on a break.`,
      'You are told whenever anyone changes your schedule, what is captured, or your time, and by whom. You can explain a late start, idle time or a screenshot, and ask for missing time to be added.',
      'Only the newest version of this app can start the timer; updating takes about a minute.',
      'Screenshots waiting to upload are kept encrypted on this computer and deleted once sent.'].filter(Boolean), accept: !review },
  ].filter(Boolean);
  if (!review && me && me.policy_updated) list[0].points.unshift('Some details changed since you last agreed. Please read it and agree again.');
  return list;
}

function policyView(review = false) {
  clear(); bodyKey = null; permKey = null;
  const steps = wizardSteps(review);
  let i = 0;
  const box = el('div', { class: 'wz wz-in', role: 'dialog', 'aria-labelledby': 'wz-t' });
  root.append(box);
  const err = el('div', { class: 'err', role: 'alert' });

  const render = (dir) => {
    const st = steps[i], last = i === steps.length - 1, anim = dir ? (dir > 0 ? ' fwd' : ' back') : '';
    clear(box);
    const art = el('div', { class: 'wz-art' + anim, 'aria-hidden': 'true' });
    art.innerHTML = window.AmpScenes[st.scene](); // static markup from scenes.js
    const body = el('div', { class: 'wz-body' + anim },
      el('div', { class: 'wz-step' }, `${i + 1} of ${steps.length}`),
      el('h2', { id: 'wz-t' }, st.title),
      el('p', {}, st.text),
      st.points ? el('ul', { class: 'wz-points' }, st.points.map((p) => el('li', {}, p))) : null);
    let next;
    if (last && st.accept) {
      const cb = el('input', { type: 'checkbox', id: 'wz-ok' });
      next = el('button', { id: 'wz-accept', disabled: true, onclick: async () => {
        next.disabled = true; next.textContent = 'Saving…'; err.textContent = '';
        const r = await API.acceptPolicy();
        if (r.error) { err.textContent = r.error; next.disabled = false; next.textContent = 'Accept'; } else boot();
      } }, 'Accept');
      cb.addEventListener('change', () => { next.disabled = !cb.checked; });
      body.append(el('label', { class: 'wz-check', for: 'wz-ok' }, cb, el('span', {}, 'I have read how tracking works and I agree to it.')), err);
    } else {
      next = el('button', { id: 'wz-next', onclick: () => (last ? boot() : go(1)) }, last ? 'Back to the timer' : 'Next');
    }
    const back = i === 0
      ? (review ? el('button', { class: 'wz-skip', onclick: () => boot() }, 'Close') : el('button', { class: 'wz-skip', onclick: async () => { await API.logout(); boot(); } }, 'Sign out'))
      : el('button', { class: 'ghost', onclick: () => go(-1) }, 'Back');
    box.append(art, body,
      el('div', { class: 'wz-foot' },
        el('div', { class: 'wz-dots', 'aria-hidden': 'true' }, steps.map((_, k) => el('i', { class: k === i ? 'on' : k < i ? 'done' : '' }))),
        el('div', { class: 'wz-btns' }, back, next)));
    (next.disabled ? body.querySelector('input') : next).focus({ preventScroll: true });
  };
  const go = (d) => { const n = i + d; if (n < 0 || n >= steps.length) return; i = n; render(d); };
  box.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight' && i < steps.length - 1) go(1);
    if (e.key === 'ArrowLeft') go(-1);
  });
  render(0);
}

// ---------- ribbon (the day at a glance) ----------
function ribbon(sum) {
  const segs = sum.segments || [];
  const box = el('div', { class: 'ribbon', role: 'img', 'aria-label': 'Your day: working, breaks and idle time' });
  if (!segs.length) return { box, axis: el('div', { class: 'axis' }) };
  const a = Date.parse(segs[0].s), b = Math.max(Date.parse(segs[segs.length - 1].e), a + 60000);
  const span = b - a;
  for (const g of segs) {
    const i = el('i', { class: g.t });
    i.style.left = ((Date.parse(g.s) - a) / span) * 100 + '%';
    i.style.width = Math.max(0.6, ((Date.parse(g.e) - Date.parse(g.s)) / span) * 100) + '%';
    box.append(i);
  }
  return { box, axis: el('div', { class: 'axis' }, el('span', {}, tod(segs[0].s)), el('span', {}, tod(segs[segs.length - 1].e))) };
}

// ---------- main ----------
// The timer screen: a deep navy "helm" card with the shift dial (the one bold element), the task, and the
// controls; then today's numbers, what is captured, and the app's own settings. The card is built once per
// screen; only its dynamic part is rebuilt when the state changes, so the dial animates smoothly.
let dial = null, picking = false, pickProj = 'all', pickQuery = '', confirming = false, asking = false, leavingPicker = false;
const ICON = {
  cup: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5v2M11 3.5v2"/>',
  dinner: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 21V3c-2.2 1.2-3 3.6-3 7v3h3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  rocket: '<path d="M12 3c3.5 2 5 5.5 5 9l-2 3H9l-2-3c0-3.5 1.5-7 5-9z"/><circle cx="12" cy="10" r="1.8"/><path d="M9 15l-2.5 3.5L9 18M15 15l2.5 3.5L15 18"/>',
  power: '<path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/>'
};
const ico = (name, size = 17) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[name]; return s; };
const AV = ['#B45309', '#6B55D6', '#127A57', '#7A5AF8', '#C2410C', '#0F766E', '#9D174D'];
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const avColor = (id) => AV[Math.abs(Number(id) || 0) % AV.length];
const shiftLeft = (st) => {
  const sh = st.shift; if (!sh) return '';
  const now = Date.now();
  if (now < sh.startMs) return `starts in ${dur((sh.startMs - now) / 1000)}`;
  if (now < sh.endMs) return `${dur((sh.endMs - now) / 1000)} left`;
  return 'shift over';
};

function mainView(st) {
  clear();
  permKey = null; bodyKey = null; picking = false; confirming = false; asking = false;
  const hero = el('section', { class: 'hero', id: 'hero' },
    el('div', { class: 'glow', 'aria-hidden': 'true' }),
    el('div', { class: 'who' },
      el('span', { class: 'av', style: `background:${avColor(me && me.id)}` }, initials(me && me.name)),
      el('div', { class: 'who-t' }, el('b', {}, me ? me.name : ''), el('span', { id: 'shiftline' })),
      el('span', { class: 'chip', id: 'chip' }, el('i'), el('span', { id: 'chiptext' }))),
    el('div', { class: 'dialwrap', id: 'dialwrap' },
      el('div', { class: 'center' },
        el('span', { class: 'cap' }, 'Worked today'),
        el('span', { class: 'digits num', id: 'digits', 'aria-live': 'off' }),
        el('span', { class: 'cap num', id: 'session' }))),
    el('div', { class: 'legend' },
      el('span', {}, el('i', { class: 'w' }), 'Working'), el('span', {}, el('i', { class: 'b' }), 'Break'),
      el('span', { id: 'schedleg' }, el('i', { class: 's' }), el('span', { id: 'schedtext' }, 'Scheduled break'))),
    el('div', { id: 'dyn', class: 'dyn' }));
  root.append(
    el('div', { class: 'topbar' }, brand(),
      el('div', { class: 'toplinks' },
        el('button', { class: 'link', id: 'howto', onclick: () => policyView(true) }, 'How it works'),
        el('button', { class: 'link', id: 'signout', onclick: async () => { const r = await API.logout(); if (r.error) toast(r.error); else boot(); } }, 'Sign out'))),
    // the company's account is paused (trial over, not paid, closed): said plainly, before Start
    me && me.account && me.account.paused ? el('div', { class: 'notice paused-note', role: 'status' }, el('b', {}, me.account.status === 'closed' ? 'This company’s account is closed.' : 'Tracking is paused.'),
      el('span', {}, me.account.billing ? ' Choose a plan on the website to start tracking again. Nothing is lost.' : ' The company’s Staffwarden account needs attention, and the owner already knows. Your hours, payslips and time off are all still on the website.')) : null,
    el('div', { id: 'notice' }),
    el('div', { id: 'perm' }),
    el('div', { id: 'body', class: 'stack' },
      hero,
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', {}, 'Breaks'), el('b', { class: 'num', id: 't-break' }), el('small', { id: 't-break-l' })),
        el('div', { class: 'stat' }, el('span', {}, 'Screenshots'), el('b', { class: 'num', id: 't-shots' }), el('small', {}, 'You can delete yours')),
        el('div', { class: 'stat' }, el('span', {}, 'Activity'), el('b', { class: 'num', id: 't-act' }), el('small', { id: 't-act-l' }, 'Keyboard, mouse'))),
      el('div', { class: 'privacy' }, el('span', { class: 'ok' }, ico('shield', 18)), el('span', { id: 'privtext' })),
      el('div', { class: 'tools2' },
        el('button', { class: 'tool', id: 'test', onclick: testCapture }, ico('camera', 16), 'Test screenshot'),
        el('button', { class: 'tool', onclick: () => showSummary() }, ico('chart', 16), 'Full breakdown')),
      el('span', { class: 'muted queued', id: 'queued' }),
      el('div', { id: 'preview', class: 'preview' }),
      el('div', { class: 'prefs' }, startupToggle(), boostPrefsBox())),
    credit());
  dial = window.WhDial.create(document.getElementById('dialwrap'), { size: 264, stroke: 13 });
  document.getElementById('dialwrap').prepend(dial.svg);
  update(st);
  enterView();
}

// Whether Staffwarden opens when the computer starts: the person's choice, on their own computer.
function startupToggle() {
  const box = el('input', { type: 'checkbox', id: 'atlogin' });
  API.prefs().then((p) => { if (p && !p.error) box.checked = !!p.openAtLogin; });
  box.addEventListener('change', async () => { const r = await API.setOpenAtLogin(box.checked); if (r && !r.error) box.checked = !!r.openAtLogin; });
  box.setAttribute('role', 'switch');
  return el('label', { class: 'startup pref', for: 'atlogin' }, el('span', { class: 'pi' }, ico('power', 16)), el('span', { class: 'pt' }, el('b', {}, 'Open when this computer starts'), el('small', {}, 'So the timer is ready when your shift begins')), box);
}
API.onPrefs((p) => { const b = document.getElementById('atlogin'); if (b && p) b.checked = !!p.openAtLogin; });

// How the owner's boosts arrive on this person's screen: his clip popping up in a corner, or a plain
// notification (for anyone who shares their screen a lot). Saved on the server, so it follows them.
function boostPrefsBox() {
  const pop = el('select', { id: 'bp-pop', 'aria-label': 'How boosts arrive' },
    el('option', { value: 'clip' }, 'Pop up in the corner'), el('option', { value: 'note' }, 'Notification only'));
  const corner = el('select', { id: 'bp-corner', 'aria-label': 'Which corner' },
    el('option', { value: 'right' }, 'Bottom right'), el('option', { value: 'left' }, 'Bottom left'));
  const set = (p) => { if (p && !p.error) { pop.value = p.popup; corner.value = p.corner; corner.disabled = p.popup === 'note'; } };
  API.boostPrefs().then(set);
  pop.addEventListener('change', async () => set(await API.setBoostPrefs({ popup: pop.value })));
  corner.addEventListener('change', async () => set(await API.setBoostPrefs({ corner: corner.value })));
  return el('div', { class: 'boostprefs pref' }, el('span', { class: 'pi' }, ico('rocket', 16)), el('span', { class: 'pt' }, el('b', {}, 'Boosts'), el('small', {}, 'How the owner’s cheer reaches you')), el('span', { class: 'sel' }, pop, corner));
}

// ---------- the task ----------
function taskInfo(st) {
  const id = st.active ? (st.taskId ? String(st.taskId) : '') : selectedTask;
  if (!id) return null;
  const t = myTasks.find((x) => String(x.id) === id);
  if (t) return { id, key: t.key, title: t.title, project: t.project || '', due: t.status === 'in_review' ? 'In review' : dueText(t), late: !!t.overdue, mine: t };
  for (const p of projects) { const pt = (p.tasks || []).find((x) => String(x.id) === id); if (pt) return { id, key: pt.key, title: pt.name, project: p.name, due: '' }; }
  return { id, key: null, title: 'Current task', project: '', due: '' };
}
function pickList() {
  const rows = [], seen = new Set();
  for (const t of myTasks) {
    if (t.status === 'in_review' || t.status === 'done') continue;
    seen.add(t.id);
    rows.push({ id: String(t.id), key: t.key, title: t.title, project: t.project || 'No project', pid: t.project_id ? String(t.project_id) : '', due: dueText(t), late: !!t.overdue || !!t.due_today, mine: true });
  }
  for (const p of projects) for (const t of p.tasks || []) {
    if (t.done || t.status === 'in_review' || seen.has(t.id)) continue;
    rows.push({ id: String(t.id), key: t.key, title: t.name, project: p.name, pid: String(p.id), due: '', mine: false });
  }
  const q = pickQuery.trim().toLowerCase();
  return rows.filter((r) => (pickProj === 'all' || r.pid === pickProj) && (!q || `${r.key || ''} ${r.title} ${r.project}`.toLowerCase().includes(q)));
}
function closePicker(after) {
  if (leavingPicker) return;
  const box = document.getElementById('picker');
  const done = () => { leavingPicker = false; picking = false; pickQuery = ''; bodyKey = null; if (after) after(); if (lastStatus) update(lastStatus); };
  if (!box || reducedMotion()) return done();
  leavingPicker = true; box.classList.add('out'); setTimeout(done, 220);
}
async function choose(row) {
  const st = lastStatus || {};
  if (st.running && String(st.taskId || '') !== (row ? row.id : '')) {
    // switching while the timer runs: this session ends and a new one starts on the new task
    closePicker(async () => {
      const a = await API.stop(); if (a && a.error) { toast(a.error); return; }
      const b = await API.start(row && row.pid ? Number(row.pid) : null, row ? Number(row.id) : null);
      if (b && b.error) { if (b.code) startFailed(b, null); else toast(b.error); } else toast(row ? `Now working on ${row.title}.` : 'Now working without a task.');
      loadTasks().then(() => { bodyKey = null; if (lastStatus) update(lastStatus); });
    });
    return;
  }
  selectedTask = row ? row.id : ''; selectedProject = row ? row.pid : '';
  closePicker();
}
function picker(st) {
  const list = el('div', { class: 'plist', role: 'listbox', 'aria-label': 'Tasks' });
  const fill = () => {
    clear(list);
    const rows = pickList();
    if (!rows.length) { list.append(el('div', { class: 'pempty' }, pickQuery ? 'No task matches that.' : 'No open tasks here. Managers add tasks on the Staffwarden website; new ones show up here by themselves.')); return; }
    const cur = st.active ? String(st.taskId || '') : selectedTask;
    for (const r of rows) {
      list.append(el('button', { class: 'prow' + (r.id === cur ? ' sel' : ''), role: 'option', 'aria-selected': r.id === cur ? 'true' : 'false', onclick: () => choose(r) },
        el('span', { class: 'pdot', style: `background:${avColor(r.pid || 0)}` }),
        el('span', { class: 'pt' }, el('b', {}, r.title), el('span', {}, [r.key, r.project].filter(Boolean).join(' · '))),
        r.due ? el('span', { class: 'pdue' + (r.late ? ' late' : '') }, r.due) : null));
    }
  };
  const search = el('input', { type: 'search', placeholder: 'Find a task or project', 'aria-label': 'Find a task', value: pickQuery, oninput: (e) => { pickQuery = e.target.value; fill(); } });
  const chips = el('div', { class: 'pchips' });
  const chipsFill = () => {
    clear(chips);
    const used = projects.filter((p) => (p.tasks || []).some((t) => !t.done) || myTasks.some((t) => t.project_id === p.id));
    for (const p of [{ id: 'all', name: 'All projects' }, ...used]) {
      const id = String(p.id);
      chips.append(el('button', { class: 'pchip' + (pickProj === id ? ' on' : ''), onclick: () => { pickProj = id; chipsFill(); fill(); } },
        id === 'all' ? null : el('i', { style: `background:${avColor(p.id)}` }), p.name));
    }
  };
  chipsFill(); fill();
  setTimeout(() => search.focus({ preventScroll: true }), 50);
  return el('div', { class: 'picker in', id: 'picker' },
    el('div', { class: 'phead' }, el('b', {}, 'What are you working on?'), el('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: () => closePicker() }, ico('x', 14))),
    el('label', { class: 'psearch' }, ico('search', 15), search),
    chips, list,
    el('div', { class: 'pfoot' },
      el('button', { class: 'link brass', onclick: () => choose(null) }, 'Work without a task'),
      el('span', {}, el('i', { class: 'live' }), 'New tasks appear here by themselves')),
    st.running ? el('span', { class: 'pnote' }, 'Switching task starts a new session; your time so far stays on the old one.') : null);
}

// ---------- the dynamic part of the card ----------
function buildBody(st) {
  const dyn = document.getElementById('dyn');
  if (!dyn) return;
  clear(dyn);
  const err = el('div', { class: 'err', role: 'alert', id: 'err' });
  const allowed = st.screenPermission === 'granted';
  if (st.active) { selectedTask = st.taskId ? String(st.taskId) : ''; selectedProject = st.projectId ? String(st.projectId) : ''; }

  // the task: a card that opens the picker (not while on a break)
  if (picking) dyn.append(picker(st));
  else {
    const t = taskInfo(st);
    const canPick = !st.paused;
    const finish = t && t.mine && st.active && t.mine.status !== 'in_review'
      ? el('button', { class: 'mini', onclick: async (e) => {
        e.stopPropagation(); const done = isPersonal(t.mine) || !reviewOn();
        const r = await API.setTaskStatus(t.mine.id, done ? 'done' : 'in_review');
        if (r.error) { toast(r.error); return; }
        await loadTasks(); bodyKey = null; update(lastStatus || st);
        toast(done ? 'Task marked done.' : 'Sent for review. Your manager will approve it or send it back.');
      } }, isPersonal(t.mine) || !reviewOn() ? 'Mark done' : 'Send for review') : null;
    dyn.append(el('div', { class: 'taskcard in' },
      el('button', { class: 'taskbtn', disabled: !canPick, title: canPick ? '' : 'Resume first to change the task', onclick: () => { picking = true; asking = false; confirming = false; bodyKey = null; update(lastStatus || st); } },
        el('span', { class: 'tkey' }, t && t.key ? t.key : 'No task'),
        el('span', { class: 'tt' }, el('b', {}, t ? t.title : 'Pick what you are working on'),
          el('span', { class: t && t.late ? 'late' : '' }, t ? [t.project, t.due].filter(Boolean).join(' · ') || 'No project' : 'So your time counts towards it')),
        canPick ? el('span', { class: 'chg' }, ico('swap', 15), 'Change') : null),
      finish));
  }

  // what is happening now
  if (st.paused) {
    const r = st.pause ? st.pause.reason : '';
    dyn.append(el('div', { class: 'note brk in', role: 'status' }, ico(r === 'dinner' || r === 'lunch' ? 'dinner' : 'cup', 18),
      el('span', { id: 'pausewhy' }), el('b', { class: 'num breathe', id: 'pausefor' })));
  } else if (st.running && st.idle) {
    dyn.append(el('div', { class: 'note idle in', role: 'status' }, el('span', {}, 'You seem to be away. Your timer is still running; this time is marked idle and no screenshots are taken until you are back.')));
  } else if (!st.active) {
    dyn.append(el('div', { class: 'note soft in' }, el('span', {}, 'Nothing is tracked until you press Start.')));
  }
  if (st.active && st.shiftOver) dyn.append(el('div', { class: 'note late in', role: 'status' }, el('span', {}, `Your shift ended at ${st.shiftEnd}. If you're done for the day, stop your timer before you shut down.`)));
  if (st.otherDevice) dyn.append(el('div', { class: 'note soft in' }, ico('tablet', 18), el('span', {}, 'Set up for working on another device, like an iPad: while your timer is on this computer stays awake and keyboard and mouse activity is not measured. Keep the lid open.')));

  // the buttons
  const btn = (label, cls, icon, onclick, id) => el('button', { class: 'hb ' + cls, id, onclick }, icon ? ico(icon, 17) : null, label);
  if (confirming && st.active) {
    dyn.append(el('div', { class: 'sheet in', role: 'alertdialog', 'aria-labelledby': 'cf-t' },
      el('div', {}, el('b', { id: 'cf-t' }, 'Stop for today?'), el('span', {}, st.paused ? 'You are on a break. Stopping ends your session; you can start again any time.' : 'Your time so far is saved. Screenshots and activity stop.')),
      el('div', { class: 'acts' },
        btn('Keep working', 'ghost', null, () => { confirming = false; bodyKey = null; update(lastStatus || st); }, 'keep'),
        btn('Stop', 'solid-danger', null, async (e) => {
          e.currentTarget.disabled = true; e.currentTarget.textContent = 'Stopping…';
          const r = await API.stop(); confirming = false;
          if (r.error) { toast(r.error); bodyKey = null; update(lastStatus || st); return; }
          showSummary(r.summary, true);
        }, 'confirm-stop'))));
  } else if (asking && st.running) {
    const reasons = (settings && settings.pause_reasons) || REASONS;
    dyn.append(el('div', { class: 'sheet in' },
      el('b', {}, 'What is the break for?'),
      el('div', { class: 'reasons' }, reasons.map((r, i) => el('button', { class: 'rchip', style: `animation-delay:${i * 40}ms`, onclick: async () => {
        asking = false; err.textContent = '';
        const x = await API.pause(r.id); if (x.error) err.textContent = x.error;
      } }, r.label))),
      el('button', { class: 'link brass', onclick: () => { asking = false; bodyKey = null; update(lastStatus || st); } }, 'Keep working')));
  } else if (!picking) {
    const acts = el('div', { class: 'acts in' });
    if (!st.active) {
      acts.append(btn('Start working', 'go', 'play', async () => {
        err.textContent = '';
        const r = await API.start(selectedProject ? Number(selectedProject) : null, selectedTask ? Number(selectedTask) : null);
        if (r.error) startFailed(r, err); else if (selectedTask) loadTasks().then(() => { bodyKey = null; if (lastStatus) update(lastStatus); });
      }, 'start'));
      if (!allowed) acts.querySelector('#start').title = 'Allow screen recording first';
    } else if (st.running) {
      acts.append(btn('Take a break', 'ghost', 'cup', () => { asking = true; bodyKey = null; update(lastStatus || st); }, 'pause'),
        btn('Stop', 'danger', 'stop', () => confirmStop(), 'stop'));
    } else {
      acts.append(btn('Back to work', 'go', 'play', async () => { err.textContent = ''; const x = await API.resume(); if (x.error) err.textContent = x.error; }, 'resume'),
        btn('Stop', 'danger', 'stop', () => confirmStop(), 'stop'));
    }
    dyn.append(acts);
  }
  dyn.append(err);
}

// "Are you sure?" before the timer stops, right in the card.
function confirmStop() {
  if (!lastStatus || !lastStatus.active) return;
  picking = false; asking = false; confirming = true; bodyKey = null; update(lastStatus);
}

// The day's record: shown right after stopping, or any time from "See the full breakdown".
async function showSummary(sum, justStopped = false) {
  if (!sum) { sum = await API.summary(); if (sum.error) { toast(sum.error); return; } }
  clear(); bodyKey = null; permKey = null;
  const r = ribbon(sum);
  const breaks = (sum.breaks || []);
  root.append(
    el('div', { class: 'row' }, el('div', {}, el('h1', {}, justStopped ? 'Timer stopped' : 'Today\'s summary'), el('div', { class: 'muted' }, dayLabel(sum.day)))),
    justStopped ? el('div', { class: 'notice' }, el('span', {}, 'Your time for today has been saved. Here is how the day went.')) : null,
    el('div', { class: 'tiles' },
      el('div', { class: 'tile w' }, el('b', { class: 'num' }, dur(sum.worked_secs)), el('span', {}, 'Worked')),
      el('div', { class: 'tile b' }, el('b', { class: 'num' }, dur(sum.break_secs)), el('span', {}, `On breaks${sum.break_count ? ` (${sum.break_count})` : ''}`)),
      el('div', { class: 'tile' }, el('b', { class: 'num' }, dur(sum.idle_secs)), el('span', {}, 'Idle (still counted)')),
      el('div', { class: 'tile' }, el('b', { class: 'num' }, sum.activity_pct == null ? '—' : sum.activity_pct + '%'), el('span', {}, 'Activity'))),
    el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', {}, 'Your day'), el('span', { class: 'muted num' }, sum.first_start ? `${tod(sum.first_start)} to ${sum.last_end ? tod(sum.last_end) : 'now'}` : 'No time yet')),
      r.box, r.axis,
      el('div', { class: 'legend' }, el('span', { class: 'w' }, el('i'), 'Working'), el('span', { class: 'b' }, el('i'), 'Break'), el('span', { class: 'i' }, el('i'), 'Idle')),
      el('div', { class: 'muted' }, `${sum.shots} screenshot${sum.shots === 1 ? '' : 's'} · ${sum.sessions} session${sum.sessions === 1 ? '' : 's'}`)),
    el('div', { class: 'card' },
      el('h2', {}, breaks.length ? `Breaks and pauses (${breaks.length})` : 'Breaks and pauses'),
      breaks.length
        ? el('ul', { class: 'blist' }, breaks.map((b) => el('li', {},
          el('span', { class: 'what' }, b.type === 'away' ? 'Computer asleep or off' : reasonLabel(b.reason),
            b.type === 'idle' ? el('span', { class: 'pill i' }, b.counted ? 'Timer kept running' : 'Paused itself') : b.type === 'away' ? el('span', { class: 'pill i' }, 'Not counted') : null),
          el('span', { class: 'when' }, `${tod(b.started_at)} to ${b.ended_at ? tod(b.ended_at) : 'now'}`),
          el('span', { class: 'len' }, dur(b.secs)))))
        : el('div', { class: 'empty' }, 'You did not pause today.')),
    el('button', { class: 'block', id: 'done', onclick: () => boot() }, justStopped ? 'Done' : 'Back to the timer'));
  document.getElementById('done').focus();
  enterView();
}

async function testCapture() {
  const box = document.getElementById('preview');
  const b = document.getElementById('test');
  clear(box);
  b.disabled = true; b.textContent = 'Capturing…';
  const r = await API.testCapture();
  b.disabled = false; b.textContent = 'Test screenshot';
  if (r.error) { box.append(el('div', { class: 'err' }, r.error)); return; }
  box.append(
    el('img', { src: r.image, alt: 'Preview of what a screenshot looks like' }),
    el('div', { class: 'muted' }, `This is exactly what gets captured (${r.screens} screen${r.screens === 1 ? '' : 's'}). Nothing was saved or uploaded.${r.full ? ' A private window is open on a screen the app could not place, so that screen is hidden.' : r.masked ? ' Black areas are private windows that are hidden.' : ''}`),
    el('button', { class: 'link', onclick: () => clear(box) }, 'Hide preview'));
}

// The permission card is rebuilt only when the status changes, never on the 1-second refresh,
// otherwise a button could be replaced between mouse-down and mouse-up and the click would be lost.
function renderPerm(st) {
  const box = document.getElementById('perm');
  if (!box) return;
  const key = `${st.screenPermission}|${st.devMode}`;
  if (key === permKey) return;
  permKey = key;
  clear(box);
  if (st.screenPermission === 'granted') return;
  const appName = st.devMode ? 'Electron — and, if you started this from a terminal, that terminal app (Terminal, iTerm, VS Code)' : 'Staffwarden';
  const settingsBtn = el('button', { class: 'ghost small', onclick: () => API.openPermissionSettings() }, 'Open System Settings');
  const relaunchBtn = el('button', { class: 'small', onclick: () => API.relaunch() }, 'I turned it on: relaunch');
  if (st.screenPermission === 'not-determined') {
    box.append(el('div', { class: 'perm' },
      el('strong', {}, 'Screen recording permission needed'),
      el('span', {}, 'macOS has not been asked yet. Press the button, then choose Allow in the system dialog.'),
      el('div', { class: 'btns' }, el('button', { class: 'small', onclick: () => API.requestPermission() }, 'Allow screen recording'), settingsBtn)));
  } else {
    box.append(el('div', { class: 'perm' },
      el('strong', {}, 'Screen recording is turned off'),
      el('ol', {},
        el('li', {}, 'Open System Settings → Privacy & Security → Screen & System Audio Recording.'),
        el('li', {}, `Switch on: ${appName}.`),
        el('li', {}, 'Come back here and press relaunch (macOS only applies the change after a restart).')),
      el('div', { class: 'btns' }, settingsBtn, relaunchBtn)));
  }
}

function update(st) {
  lastStatus = st;
  const q = (id) => document.getElementById(id);
  if (!q('body') || !q('dyn')) return;
  if (!st.active) confirming = false;
  if (!st.running) asking = false;
  const key = `${st.mode}|${st.screenPermission}|${st.idle ? 1 : 0}|${st.shiftOver && st.active ? 1 : 0}|${st.taskId || ''}|${st.otherDevice ? 1 : 0}|${picking ? 1 : 0}|${confirming ? 1 : 0}|${asking ? 1 : 0}|${selectedTask}|${st.pause ? st.pause.reason : ''}`;
  if (key !== bodyKey) { bodyKey = key; buildBody(st); }

  const hero = q('hero');
  hero.dataset.mode = st.running ? (st.idle ? 'idle' : 'run') : st.paused ? 'brk' : 'off';
  if (dial) dial.update(st);
  q('digits').textContent = hms(st.todayWorkedSecs);
  q('session').textContent = st.active ? `This session ${hms(st.sessionSecs)}` : 'Not tracking';
  const sh = st.shift;
  q('shiftline').textContent = sh ? `Shift ${sh.startText} – ${sh.endText} · ${shiftLeft(st)}` : (me && me.title) || '';
  q('schedleg').hidden = !(sh && sh.breakText);
  if (sh && sh.breakText) q('schedtext').textContent = `Break ${sh.breakText}`;
  q('chip').className = 'chip' + (st.running ? (st.idle ? ' idle' : ' on') : st.paused ? ' paused' : '');
  q('chiptext').textContent = st.running ? (st.idle ? 'Idle' : 'Tracking') : st.paused ? 'On a break' : 'Not tracking';
  if (st.paused && st.pause && q('pausewhy')) {
    q('pausewhy').textContent = `${st.pause.auto ? 'Paused itself · ' : ''}${reasonLabel(st.pause.reason)} · not counted, no screenshots`;
    q('pausefor').textContent = hms(st.pause.secs);
  }
  const startBtn = q('start');
  if (startBtn) startBtn.disabled = st.screenPermission !== 'granted';
  const tb = q('test'); if (tb && tb.textContent === 'Test screenshot') tb.disabled = st.screenPermission !== 'granted';
  q('t-break').textContent = dur(st.todayBreakSecs);
  q('t-break-l').textContent = st.todayBreakCount ? `${st.todayBreakCount} break${st.todayBreakCount === 1 ? '' : 's'}` : 'None yet';
  q('t-shots').textContent = String(st.todayShots);
  q('t-act').textContent = st.running && st.activityPct != null ? st.activityPct + '%' : '–';
  q('t-act-l').textContent = st.otherDevice ? 'Not measured' : 'Keyboard, mouse';
  q('privtext').textContent = shotsN() === 0
    ? 'Screenshots are off for you. Only your time and activity are tracked, and only while you work.'
    : `Screenshots ${everyText()} at random, only while you work. Private windows are blacked out on your computer before anything is sent.`;
  q('queued').textContent = st.lastError && st.running ? `Last capture failed: ${st.lastError}` : (st.queued ? `${st.queued} waiting to upload` : '');
  q('signout').disabled = st.active;

  const notice = q('notice');
  if (st.recovered && !notice.firstChild) {
    notice.append(el('div', { class: 'notice warn' },
      el('span', {}, st.recovered.continued
        ? `Your timer carried on after your computer was off from ${tod(new Date(st.recovered.endedAtMs).toISOString())} to ${tod(new Date(st.recovered.resumedAtMs).toISOString())}. That time was not counted.`
        : `Your last session ended at ${tod(new Date(st.recovered.endedAtMs).toISOString())} because the app was closed. The time after that was not counted.`),
      el('button', { class: 'link small', onclick: async () => { await API.ackRecovered(); clear(notice); } }, 'Dismiss')));
  }
  renderPerm(st);
}

// The timer would not start: a newer app is needed (offer Update right here), or what is captured changed
// since the person agreed (show what changed). Anything else is shown as it came.
function startFailed(r, errEl) {
  if (r.code === 'policy-changed') { boot(); return; }
  if (errEl) errEl.textContent = r.error; else toast(r.error);
  if (r.code !== 'update-required') return;
  API.checkUpdate().then((st) => renderUpdate({ ...st, forceShow: true })).catch(() => {});
  if (errEl && !errEl.querySelector('button')) {
    errEl.append(' ', el('button', { class: 'link brass', onclick: async () => {
      errEl.textContent = 'Downloading the update…';
      const x = await API.installUpdate();
      if (x && x.error) errEl.textContent = x.error;
    } }, 'Update now'));
  }
}

// ---------- what changed since you agreed ----------
// When the policy or what is captured changed, the person sees exactly what changed (in words, and each
// setting as it was and as it is now) before agreeing again. "Read everything" opens the full walkthrough.
function changesView(pc) {
  clear(); bodyKey = null; permKey = null;
  const box = el('div', { class: 'wz wz-in chg', role: 'dialog', 'aria-labelledby': 'chg-t' });
  const err = el('div', { class: 'err', role: 'alert' });
  const cb = el('input', { type: 'checkbox', id: 'chg-ok' });
  const agree = el('button', { id: 'chg-accept', disabled: true, onclick: async () => {
    agree.disabled = true; agree.textContent = 'Saving…'; err.textContent = '';
    const r = await API.acceptPolicy();
    if (r.error) { err.textContent = r.error; agree.disabled = false; agree.textContent = 'Agree'; } else boot();
  } }, 'Agree');
  cb.addEventListener('change', () => { agree.disabled = !cb.checked; });
  const settingsList = (pc.settings || []).map((l) => el('li', { class: l.more ? 'more' : '' },
    el('b', {}, l.label), el('span', { class: 'chg-ft' }, el('s', {}, l.from), el('span', { 'aria-hidden': 'true' }, ' → '), el('span', {}, l.to)),
    l.more ? el('span', { class: 'chg-more' }, 'Captures or shares more') : null));
  box.append(
    el('div', { class: 'wz-body' },
      el('div', { class: 'wz-step' }, 'Before your next start'),
      el('h2', { id: 'chg-t' }, 'What changed since you agreed'),
      el('p', {}, 'Read what is different. Your timer can start again once you agree.'),
      (pc.news || []).length ? el('ul', { class: 'wz-points' }, pc.news.map((t) => el('li', {}, t))) : null,
      settingsList.length ? el('ul', { class: 'chg-list' }, settingsList) : null,
      el('label', { class: 'wz-check', for: 'chg-ok' }, cb, el('span', {}, 'I have read what changed and I agree.')), err),
    el('div', { class: 'wz-foot' },
      el('button', { class: 'wz-skip', onclick: () => policyView() }, 'Read everything'),
      el('div', { class: 'wz-btns' }, agree)));
  root.append(box);
  cb.focus({ preventScroll: true });
}

async function boot() {
  document.querySelectorAll('.scrim').forEach((n) => n.remove());
  const s = await API.state();
  if (!s.loggedIn) return loginView(s.serverUrl, '', s.fixedServer);
  if (!s.user) return loginView(s.serverUrl, 'Cannot reach the server. Check your internet connection.', s.fixedServer);
  me = s.user; settings = s.settings || settings; tz = s.user.tz_offset_min ?? tz;
  if (!s.user.consented) { const pc = s.user.policy_changes; return pc && pc.reaccept && ((pc.news || []).length || (pc.settings || []).length) ? changesView(pc) : policyView(); }
  const [p] = await Promise.all([API.projects(), loadTasks()]);
  projects = Array.isArray(p) ? p : [];
  mainView(s.status);
}

// ---------- updates ----------
// A bar along the bottom of every screen when a newer version is out. "Update" downloads it, checks it,
// installs it and restarts the app; the timer keeps running.
const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
function renderUpdate(st) {
  if (st) upd = st;
  if (st && st.forceShow) updLater = null;
  if (upd && upd.current) document.querySelectorAll('.credit .ver').forEach((n) => { n.textContent = `Version ${upd.current}`; });
  let bar = document.getElementById('updbar');
  const show = upd && upd.supported !== false && ['available', 'downloading', 'ready', 'installing', 'error'].includes(upd.status) && !(upd.status === 'available' && updLater === upd.latest);
  if (!show) { if (bar) bar.remove(); document.body.classList.remove('has-upd'); return; }
  if (!bar) { bar = el('div', { id: 'updbar', class: 'updbar', role: 'status', 'aria-live': 'polite' }); document.body.append(bar); }
  document.body.classList.add('has-upd');
  clear(bar);
  const install = async () => { const r = await API.installUpdate(); if (r && r.error) renderUpdate(); };
  if (upd.status === 'available' || (upd.status === 'error' && !upd.manual)) {
    const text = upd.status === 'error'
      ? el('div', { class: 'upd-text' }, el('strong', {}, 'The update did not finish'), el('span', {}, upd.error))
      : el('div', { class: 'upd-text' }, el('strong', {}, `Staffwarden ${upd.latest} is available`),
        el('span', {}, `You have ${upd.current}. Updating takes about a minute and restarts the app. Your timer keeps running.`),
        upd.notes ? el('details', {}, el('summary', {}, 'What\'s new'), el('p', {}, upd.notes)) : '');
    bar.append(text, el('div', { class: 'upd-btns' },
      el('button', { class: 'small', id: 'upd-go', onclick: install }, upd.status === 'error' ? 'Try again' : 'Update now'),
      upd.status === 'available' ? el('button', { class: 'link small', onclick: () => { updLater = upd.latest; renderUpdate(); } }, 'Later') : ''));
  } else if (upd.status === 'error' && upd.manual) {
    bar.append(el('div', { class: 'upd-text' }, el('strong', {}, `Install Staffwarden ${upd.latest} yourself`), el('span', {}, upd.error)),
      el('div', { class: 'upd-btns' }, el('button', { class: 'small', onclick: () => API.revealUpdate() }, 'Show the update')));
  } else if (upd.status === 'downloading' || upd.status === 'ready') {
    const pct = upd.status === 'ready' ? 100 : upd.progress || 0;
    bar.append(el('div', { class: 'upd-text' }, el('strong', {}, `Downloading Staffwarden ${upd.latest}…`),
      el('div', { class: 'upd-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, el('i', { style: `width:${pct}%` })),
      el('span', {}, `${upd.total ? `${mb(upd.got || 0)} of ${mb(upd.total)} MB (${pct}%)` : `${pct}%`}. Keep working; the app restarts when it's ready.`)));
  } else if (upd.status === 'installing') {
    bar.append(el('div', { class: 'upd-text' }, el('strong', {}, 'Installing the update'), el('span', {}, 'Staffwarden will close and open again in a moment. Your timer keeps running.')));
  }
}
API.onUpdate((st) => renderUpdate(st));
API.updateState().then((st) => { if (st && !st.error) renderUpdate(st); });

API.onStatus((st) => { if (lastStatus && document.getElementById('body')) update(st); else lastStatus = st; });
API.onEvent((e) => {
  if (e.type === 'idle-pause' || e.type === 'sleep-pause') toast('The timer paused itself. That time is not counted. Press Resume when you are back.');
  if (e.type === 'reconnected') toast(e.note);
});
API.onConfirmStop(() => { if (document.getElementById('hero')) confirmStop(); });
// a task was assigned, approved or sent back: refresh the task picker and My tasks
// New or changed projects and tasks (made on the website): reload both, and redraw only if something changed,
// so an open dropdown is not closed for nothing.
API.onTasksChanged(async () => {
  if (!document.getElementById('body')) return;
  const before = JSON.stringify([projects, myTasks]);
  try { const p = await API.projects(); if (Array.isArray(p)) projects = p; } catch { /* keep the list we have */ }
  await loadTasks().catch(() => {});
  if (JSON.stringify([projects, myTasks]) === before) return;
  if (picking) { const box = document.getElementById('picker'); if (box) { const list = box.querySelector('.psearch input'); if (list) list.dispatchEvent(new Event('input')); } return; }
  bodyKey = null; if (lastStatus) update(lastStatus);
});
boot();
