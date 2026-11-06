// The client portal: what someone at a client sees when they sign in. Their own projects only, and only
// what the agency shares: progress, tasks, the people on them, approvals, requests, calls, hours and a
// live chat with the team. Never screenshots, activity, attendance or anything about other clients.
import { get, post, patch, put, del, startLive, fileUrl, fileBase64, download, setToken, liveFresh, setViewAs, getViewAs, getToken } from '../api.js';
import { html, raw, esc, icon, initials, avColor, relTime, plural, dateY, dayMD, HELM, monthLabel, addMonths, addDays, nowMs } from '../util.js';
import { toast, errMsg, openModal, confirmBox, trap } from '../ui.js';
import { morph } from '../morph.js';
import { mountChat, chatEvent, chatReloadAll } from '../chat.js';
import { registerSW, pushState, enablePush, disablePush, installMode, install, isIOS, isPhone, onInstallChange } from '../push.js';

const P = { cache: new Map(), home: null, data: null, loading: false, again: false, stop: null, wake: null, seq: 0, urls: new Map(), chats: new Map(), presence: null, gallery: false };
const B = { items: [], unread: 0, last: 0, open: false, el: null };
let root = null;

// ---------- small pieces ----------
const hrs = (secs) => { const h = (secs || 0) / 3600; const r = Math.round(h * 10) / 10; return `${String(r).replace(/\.0$/, '')}h`; };
const av = (p, size = 36, client = false) => html`<em class="pav" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;background:${avColor(client ? 1000 + p.id : p.id)}" aria-hidden="true">${initials(p.name)}</em>`;
const clientShort = () => { const n = String(P.home.client.name).replace(/\s+(Realty|Inc\.?|LLC|Ltd\.?|Limited|Group|Company|Co\.?)$/i, ''); return n.length > 18 ? n.split(' ')[0] : n; };
const orgShort = () => String(P.home.org_name || 'The team').split(' ')[0];
const first = (n) => String(n || '').split(' ')[0];
const pill = (tone, text) => html`<span class="ppill ${tone}"><i></i>${text}</span>`;
const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* fine */ } } };
const ICX = {
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  check2: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  ask: '<path d="M4 5h16v11H9l-5 4z"/><path d="M9.8 8.8a2.3 2.3 0 0 1 4.4.9c0 1.5-2.2 1.8-2.2 3.1M12 15.2h.01"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  down: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  clip: '<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/><path d="M11 13l9-9"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  share: '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 11v9h14v-9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>',
};
const ix = (n, s = 17) => raw(`<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICX[n] || ''}</svg>`);
const zone = () => (P.home && P.home.client.tz_name) || undefined;
const timeIn = (iso, o = {}) => new Date(iso).toLocaleString('en-US', { timeZone: zone(), ...o });
const zoneWord = () => 'your time';

// ---------- routing: #/overview?p=3 ----------
const TABS = [['overview', 'Overview', 'home'], ['tasks', 'Tasks', 'tasks'], ['messages', 'Messages', 'chat'], ['requests', 'Requests', 'inbox'], ['approvals', 'Approvals', 'check2'], ['meetings', 'Meetings', 'video'], ['hours', 'Hours', 'clock'], ['files', 'Files', 'file']];
function parse() {
  const h = location.hash.replace(/^#\/?/, ''), [path, query] = h.split('?');
  return { page: TABS.some((t) => t[0] === path) ? path : 'overview', q: new URLSearchParams(query || '') };
}
function go(page, params = {}) {
  const { q } = parse();
  const n = new URLSearchParams();
  const pid = params.p ?? q.get('p');
  if (pid) n.set('p', pid);
  for (const [k, v] of Object.entries(params)) if (k !== 'p' && v != null && v !== '') n.set(k, v);
  location.hash = `#/${page}${n.toString() ? '?' + n : ''}`;
}
function setQ(k, v) { const { page, q } = parse(); if (v == null || v === '') q.delete(k); else q.set(k, v); location.hash = `#/${page}?${q}`; }
const pidNow = () => { const { q } = parse(); const ps = (P.home && P.home.projects) || []; const want = Number(q.get('p')); return (ps.find((p) => p.id === want) || ps[0] || {}).id || null; };
const settings = () => (P.home && P.home.settings) || {};
const tabOn = (k) => { const s = settings(); return k === 'messages' ? s.messages || s.direct : k === 'approvals' ? s.approvals : k === 'requests' ? s.requests : k === 'hours' ? s.hours !== 'off' : true; };
const preview = () => !!(P.home && P.home.me.preview);
// "seeing the portal as": a strip above the page, outside what each tab redraws, so it stays put while a tab
// loads, when you switch tabs, and whatever the page is doing
function paintPreview() {
  let el = document.getElementById('pview');
  if (!getViewAs()) { if (el) el.remove(); return; }
  if (!P.home || !P.home.me) return;
  if (!el) { el = document.createElement('div'); el.id = 'pview'; el.className = 'pview'; el.setAttribute('role', 'status'); el.addEventListener('click', onClick); document.body.prepend(el); }
  const h = html`${ix('eye', 17)}<span>You’re seeing the portal as <b>${P.home.me.name}</b> sees it right now. Nothing you click here is sent.</span>${(P.home.people || []).length > 1 ? html`<span class="pview-who">${P.home.people.map((p) => html`<button type="button" data-pa="viewas" data-id="${p.id}" aria-pressed="${String(p.id === P.home.me.id)}">${first(p.name)}</button>`)}</span>` : ''}<button type="button" class="pview-x" data-pa="endview">Back to the project</button>`.toString();
  if (el.innerHTML !== h) el.innerHTML = h;
}

// ---------- the frame: the dark bridge with the tabs, then the page ----------
function bar(page) {
  const h = P.home, proj = h.projects.find((p) => p.id === pidNow());
  const badge = (k) => { if (!proj) return ''; const n = k === 'messages' ? proj.unread : k === 'approvals' ? proj.waiting : 0; return n ? html`<span class="pbadge" aria-label="${n} new">${n}</span>` : ''; };
  const tabs = TABS.filter(([k]) => tabOn(k)).map(([k, l, i]) => html`<a href="#/${k}?p=${pidNow() || ''}" ${k === page ? raw('aria-current="page"') : ''} data-k="t${k}"><span class="pti">${ICX[i] ? ix(i, 16) : icon(i)}</span><span class="ptl">${l}</span>${badge(k)}</a>`);
  const switcher = h.projects.length > 1 ? html`<label class="pswitch"><span class="sr">Project</span><select data-pproj aria-label="Project">${h.projects.map((p) => html`<option value="${p.id}" ${p.id === pidNow() ? raw('selected') : ''}>${p.name}</option>`)}</select></label>` : '';
  return html`<div class="ptop">
    <a class="pbrand" href="#/overview?p=${pidNow() || ''}">${h.company && h.company.icon ? html`<span class="mark pmark-co"><img src="${h.company.icon.url}" alt=""></span>` : h.company && h.company.logo_light ? '' : html`<span class="mark">${raw(HELM)}</span>`}<span class="pbt">${h.company && h.company.logo_light && !h.company.icon ? html`<img class="pbt-logo" src="${h.company.logo_light.url}" alt="${h.org_name}">` : html`<b>${h.org_name}</b>`}<span>Client portal for ${h.client.name}</span></span></a>
    <nav class="ptabs" aria-label="Project">${tabs}</nav>
    <div class="pme">${switcher}${preview() ? '' : html`<button type="button" class="pbell" data-pa="bell" aria-haspopup="dialog" aria-expanded="${String(B.open)}" aria-label="${B.unread ? `Notifications, ${B.unread} new` : 'Notifications'}">${ix('bell', 18)}<span class="pbadge" ${B.unread ? '' : raw('hidden')}>${B.unread > 99 ? '99+' : B.unread}</span></button>`}<button type="button" class="pacct" data-pa="account" aria-label="Your account: ${h.me.name}">${av(h.me, 30, true)}<span class="pacct-n">${first(h.me.name)}</span></button></div>
  </div>`;
}
function frame(page, { title, sub, right = '', hero = '', tone = '' }, body) {
  return html`<div class="pt ${tone}">
    <header class="pbr"><div class="pglow" aria-hidden="true"></div><div class="pglow2" aria-hidden="true"></div>
      <div class="pin">${bar(page)}
        <div class="phd"><div class="phd-t"><h1 tabindex="-1">${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${right ? html`<div class="phd-r">${right}</div>` : ''}</div>
        ${hero}</div></header>
    <main class="pbody" id="pmain"><div class="pin">${body}
      <footer class="pfoot"><span>${icon('lock')} You see what ${orgShort()} shares with ${P.home.client.name}.${P.home.client.tz_name ? ` Times are in ${String(P.home.client.tz_name).split('/').pop().replace(/_/g, ' ')} time.` : ''}</span><span>Runs on Staffwarden</span></footer></div></main></div>`;
}
const card = (cls, inner) => html`<section class="pcd ${cls}">${inner}</section>`;
const cardH = (t, extra = '', right = '') => html`<div class="pch"><h2>${t}</h2>${extra ? html`<span class="pch-x">${extra}</span>` : ''}${right ? html`<span class="pch-r">${right}</span>` : ''}</div>`;
const emptyBox = (t, s, act = '') => html`<div class="pempty"><b>${t}</b><span>${s}</span>${act}</div>`;
const reqBtn = () => (settings().requests || settings().messages ? html`<button type="button" class="pbtn brass" data-pa="request">${ix('ask', 17)}Ask the team</button>` : '');
// loading shapes, shown the first time a page opens (before anything is cached)
function skeleton(page) {
  const sk = (w, h = 12, r = 7) => `<span class="skel" style="width:${w};height:${h}px;border-radius:${r}px"></span>`;
  const cardS = (rows) => `<section class="pcd skc">${sk('40%', 18)}${Array.from({ length: rows }, (_, i) => sk(`${90 - i * 9}%`)).join('')}</section>`;
  return `<div class="pt"><header class="pbr"><div class="pin">${bar(page)}<div class="phd"><div class="phd-t">${sk('320px', 38, 10).replace('skel', 'skel dark')}${sk('420px', 14).replace('skel', 'skel dark')}</div></div></div></header>
    <main class="pbody"><div class="pin"><div class="pgr"><div class="pcol">${cardS(4)}${cardS(3)}</div><div class="pcol side">${cardS(3)}${cardS(2)}</div></div></div></main></div>`;
}

// ---------- ring ----------
function ring(pct, { size = 172, stroke = 14, color = 'var(--work)', center = '' } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
  return html`<div class="pring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><div class="pring-c">${center}</div></div>`;
}

// ================= the bell =================
const BK = { approval_asked: ['check2', 'brass'], file_asked: ['upload', 'brass'], approval_reminder: ['check2', 'brass'], approval_version: ['check2', 'brass'], request_estimate: ['inbox', 'leave'], request_reply: ['inbox', 'leave'], request_update: ['inbox', 'leave'],
  chat: ['chat', 'blue'], task_comment: ['chat', 'blue'], update_posted: ['flag', 'work'], milestone_done: ['flag', 'work'], meeting: ['video', 'blue'], meeting_notes: ['video', 'blue'], hours_80: ['clock', 'late'], hours_week: ['clock', 'leave'] };
const NEEDS = new Set(['approval_asked', 'file_asked', 'approval_reminder', 'approval_version', 'request_estimate']);
async function loadBell() {
  if (preview()) return;
  try { const r = await get('/api/portal/notifications?limit=40'); B.items = r.items; B.unread = r.unread; B.last = r.last_id; paintBell(); } catch { /* the bell is optional */ }
}
function paintBell() {
  const b = root && root.querySelector('.pbell');
  if (b) { const s = b.querySelector('.pbadge'); s.hidden = !B.unread; s.textContent = B.unread > 99 ? '99+' : String(B.unread); b.setAttribute('aria-label', B.unread ? `Notifications, ${B.unread} new` : 'Notifications'); b.classList.toggle('has', !!B.unread); }
  if (B.el) B.el.querySelector('.pnb-list').innerHTML = bellList();
}
function bellRow(n) {
  const [i, tone] = BK[n.kind] || ['bell', 'blue'];
  return `<li><a class="pnb-i${n.read ? '' : ' new'}" href="${esc(n.link || '#/overview')}" data-nid="${n.id}"><span class="pnb-ic ${tone}">${ix(i, 17)}</span><span class="pnb-t"><b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body)}</span>` : ''}<i>${esc(relTime(n.created_at))}</i></span>${n.read ? '' : '<em class="pnb-dot" aria-label="New"></em>'}</a></li>`;
}
function bellList() {
  if (!B.items.length) return `<li class="pnb-empty">${ix('bell', 22)}<b>Nothing yet</b><span>Approvals, replies, messages and calls from the team show up here.</span></li>`;
  const needs = B.items.filter((n) => !n.read && NEEDS.has(n.kind)), rest = B.items.filter((n) => !needs.includes(n));
  return `${needs.length ? `<li class="pnb-h">Needs you · ${needs.length}</li>${needs.map(bellRow).join('')}` : ''}${rest.length ? `${needs.length ? '<li class="pnb-h">Earlier</li>' : ''}${rest.map(bellRow).join('')}` : ''}`;
}
function openBell() {
  if (B.el) return closeBell();
  const btn = root.querySelector('.pbell'); if (!btn) return;
  B.el = document.createElement('div');
  B.el.className = 'pnb'; B.el.setAttribute('role', 'dialog'); B.el.setAttribute('aria-label', 'Notifications');
  B.el.innerHTML = `<header><h2>Notifications</h2><span class="pnb-n">${B.unread ? `${B.unread} new` : ''}</span><button type="button" class="plink" data-nb="all" ${B.unread ? '' : 'disabled'}>Mark all as read</button></header><ul class="pnb-list"></ul>
    <footer><button type="button" class="pbtn sm" data-nb="prefs">${ix('phone', 15)}Phone notifications</button></footer>`;
  document.body.appendChild(B.el);
  const r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth;
  B.el.style.top = `${r.bottom + 10}px`;
  B.el.style.left = `${Math.max(12, Math.min(vw - B.el.offsetWidth - 12, r.right - B.el.offsetWidth))}px`;
  B.open = true; btn.setAttribute('aria-expanded', 'true');
  paintBell();
  B.el.addEventListener('click', onBellClick);
  setTimeout(() => { document.addEventListener('mousedown', bellOutside, true); document.addEventListener('keydown', bellKey, true); });
  const f = B.el.querySelector('.pnb-i, button'); if (f) f.focus({ preventScroll: true });
}
function closeBell() {
  if (!B.el) return;
  B.el.remove(); B.el = null; B.open = false;
  document.removeEventListener('mousedown', bellOutside, true); document.removeEventListener('keydown', bellKey, true);
  const b = root && root.querySelector('.pbell'); if (b) b.setAttribute('aria-expanded', 'false');
}
const bellOutside = (e) => { if (B.el && !B.el.contains(e.target) && !e.target.closest('.pbell')) closeBell(); };
function bellKey(e) { if (!B.el) return; if (e.key === 'Escape') { e.preventDefault(); closeBell(); const b = root.querySelector('.pbell'); if (b) b.focus(); } else trap(B.el, e); }
async function bellRead(ids) {
  try { const r = await post('/api/portal/notifications/read', ids === 'all' ? { all: true } : { ids }); B.unread = r.unread; } catch { return; }
  for (const n of B.items) if (ids === 'all' || ids.includes(n.id)) n.read = true;
  paintBell();
}
async function onBellClick(e) {
  const a = e.target.closest('[data-nb]');
  if (a) { e.preventDefault(); if (a.dataset.nb === 'all') await bellRead('all'); else { closeBell(); notifyDialog(); } return; }
  const it = e.target.closest('[data-nid]');
  if (it) { const n = B.items.find((x) => x.id === Number(it.dataset.nid)); if (n && !n.read) bellRead([n.id]); closeBell(); }
}
async function onBellEvent() {
  if (preview()) return;
  try {
    const r = await get(`/api/portal/notifications?after=${B.last}&limit=50`);
    B.unread = r.unread;
    if (r.items.length) {
      B.last = Math.max(B.last, ...r.items.map((n) => n.id));
      B.items = [...r.items.reverse(), ...B.items].slice(0, 80);
      if (!document.hidden) for (const n of r.items.slice(0, 2)) toast(n.title);
    } else { const all = await get('/api/portal/notifications?limit=40'); B.items = all.items; B.unread = all.unread; }
    paintBell();
  } catch { /* next time */ }
}

// ================= Overview =================
async function loadOverview(pid) { return { pj: await get(`/api/portal/projects/${pid}`) }; }
function mileCards(list) {
  if (!list.length) return '';
  const nowIdx = list.findIndex((m) => !m.done_at);
  return html`<ol class="pmc" aria-label="Milestones">${list.map((m, i) => {
    const st = m.done_at ? 'done' : i === nowIdx ? 'now' : 'todo';
    const when = m.done_at ? `Done ${dayMD(m.done_at.slice(0, 10))}` : m.start_day && m.due_day ? `${dayMD(m.start_day)} to ${dayMD(m.due_day)}` : m.due_day ? `Due ${dayMD(m.due_day)}` : 'Date to come';
    const pct = m.tasks_total ? Math.round((m.tasks_done / m.tasks_total) * 100) : st === 'done' ? 100 : 0;
    return html`<li class="${st}" data-k="mc${m.id}"><div class="pmc-top"><span class="pmc-dot">${st === 'done' ? icon('check') : st === 'now' ? raw('<i></i>') : ''}</span>${m.tasks_total ? html`<span class="pmc-n">${m.tasks_done} of ${m.tasks_total} tasks</span>` : ''}</div>
      <b>${m.title}</b><span class="pmc-w">${when}</span><span class="pmc-bar" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="sr">${st === 'done' ? 'Done' : st === 'now' ? 'Happening now' : 'Coming up'}</span></li>`;
  })}</ol>`;
}
function waitingList(w) {
  if (!w.length) return emptyBox('Nothing waiting on you', 'When the team needs an approval or a file from you, it shows up here.');
  return html`<ul class="pwait">${w.map((x, i) => html`<li data-k="w${x.id}"><span class="pw-ic ${x.kind}">${ix(x.kind === 'file' ? 'upload' : 'check2', 18)}</span><div><span class="pw-r"><b>${x.title}</b>${x.due_day ? html`<span class="pdue">Due ${dayMD(x.due_day)}</span>` : ''}</span><span>${x.kind === 'file' ? (x.description || 'The team asked you for this file.') : `${x.version > 1 ? `Version ${x.version}. ` : ''}${x.by ? `${first(x.by)} ${x.version > 1 ? 'sent it' : 'asked'} ${relTime(x.asked_at || x.created_at)}.` : ''}`}</span>
    <a class="pbtn sm ${i === 0 ? 'ink' : ''}" href="#/approvals?p=${pidNow()}&a=${x.id}">${x.kind === 'file' ? html`${ix('upload', 14)}Upload it` : 'Review it'}</a></div></li>`)}</ul>`;
}
const FEED = { done: ['check', 'work'], approval: ['check2', 'brass'], file_ask: ['upload', 'brass'], milestone: ['flag', 'work'], file: ['file', 'leave'] };
function feedRow(f) {
  const [i, tone] = FEED[f.kind] || ['check', 'work'];
  const who = f.who ? html`<b>${first(f.who)}</b> ` : '';
  const text = f.kind === 'done' ? html`${f.who ? html`${who}finished ` : 'Finished '}<b>${f.title}</b>`
    : f.kind === 'approval' ? html`${who}asked you to approve <b>${f.title}</b>`
      : f.kind === 'file_ask' ? html`${who}asked you for <b>${f.title}</b>`
        : f.kind === 'milestone' ? html`Milestone reached: <b>${f.title}</b>`
          : html`${who}shared <b>${f.title}</b>`;
  return html`<li data-k="f${f.kind}${f.task_id || f.approval_id || ''}${f.at}"><span class="pf-ic ${tone}">${ICX[i] ? ix(i, 15) : icon(i)}</span><span class="pf-t">${text}</span><span class="pf-w">${relTime(f.at)}</span></li>`;
}
function callCard(m, { big = false } = {}) {
  const d = new Date(m.starts_at), mins = Math.round((d - nowMs()) / 60000);
  const soon = mins <= 15 && mins > -m.minutes;
  const dayWord = mins < 0 ? 'Now' : mins < 60 ? `In ${Math.max(1, mins)} min` : mins < 1440 && timeIn(m.starts_at, { day: 'numeric' }) === timeIn(new Date(nowMs()).toISOString(), { day: 'numeric' }) ? 'Today' : mins < 2880 ? 'Tomorrow' : `In ${Math.round(mins / 1440)} days`;
  const when = `${timeIn(m.starts_at, { weekday: 'long' })} ${timeIn(m.starts_at, { hour: 'numeric', minute: '2-digit' })} to ${timeIn(new Date(d.getTime() + m.minutes * 60000).toISOString(), { hour: 'numeric', minute: '2-digit' })} ${zoneWord()}`;
  const tile = html`<span class="pcal"><span>${timeIn(m.starts_at, { weekday: 'short' }).toUpperCase()}</span><b>${timeIn(m.starts_at, { day: 'numeric' })}</b><i>${timeIn(m.starts_at, { month: 'short' })}</i></span>`;
  const acts = html`<span class="pcall-a">${m.link ? html`<a class="pbtn ${soon ? 'work' : 'ink'}" href="${m.link}" target="_blank" rel="noopener noreferrer">${ix('video', 16)}Join the call</a>` : ''}<button type="button" class="pbtn sm" data-pa="ics" data-id="${m.id}">${ix('cal', 15)}Add to calendar</button></span>`;
  const agenda = m.agenda.length ? html`<div class="pagenda"><b>On the agenda</b><ol>${m.agenda.map((x) => html`<li data-k="ag${m.id}-${x.i}"><span>${x.text}</span><span class="pmuted">${x.mine ? 'Added by you' : `Added by ${first(x.by.name)}`}</span>${big && x.mine && !preview() ? html`<button type="button" class="pbtn icon sm" data-pa="agenda-del" data-id="${m.id}" data-i="${x.i}" aria-label="Take it off the agenda">${ix('x', 14)}</button>` : ''}</li>`)}</ol></div>` : '';
  const add = !preview() ? html`<form class="pagenda-add" data-pform="agenda" data-id="${m.id}"><input name="text" maxlength="300" placeholder="Add something to talk about" aria-label="Add something to talk about" required><button class="pbtn sm" type="submit">${ix('send', 14)}Add</button></form>` : '';
  return html`<section class="pcd pcall${big ? ' big' : ''}" data-k="call${m.id}"><div class="pcall-h">${tile}<div class="pcall-t"><span class="ppill ${soon ? 'work' : 'blue'}"><i></i>Next call · ${dayWord}</span><h2>${m.title}</h2><p>${when}</p></div>${acts}</div>${agenda}${add}</section>`;
}
function rateCard(m) {
  return html`<section class="pcd prate" data-k="rate${m.id}"><div class="prate-h"><span class="prate-ic">${ix('flag', 18)}</span><div><h2>${m.title} is done</h2><p>How did this step go? Only ${orgShort()} sees your answer.</p></div></div>
    <form data-pform="rate" data-id="${m.id}"><div class="pstars" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map((n) => html`<label class="pstar"><input type="radio" name="stars" value="${n}" ${n === 4 ? '' : ''}><span aria-hidden="true">${ix('star', 20)}</span><span class="sr">${n} ${n === 1 ? 'star' : 'stars'}</span></label>`)}</div>
      <textarea name="note" rows="2" maxlength="1000" placeholder="Anything we should do differently next time? (optional)" aria-label="A note for the team"></textarea>
      <div class="prate-a"><button type="button" class="pbtn sm" data-pa="rate-later" data-id="${m.id}">Not now</button><button type="submit" class="pbtn sm ink">${ix('send', 14)}Send</button></div></form></section>`;
}
function overview({ pj }) {
  const pr = pj.progress, s = pj.settings, next = pj.milestones.find((m) => !m.done_at);
  const sub = [pj.project.start_day ? `Started ${dayMD(pj.project.start_day)}` : '', pj.lead ? `Led by ${pj.lead.name}` : ''].filter(Boolean).join('. ') + (next ? '' : '');
  const kinds = pj.waiting.reduce((o, w) => { o[w.kind] = (o[w.kind] || 0) + 1; return o; }, {});
  const wText = [kinds.approval ? plural(kinds.approval, 'approval') : '', kinds.file ? plural(kinds.file, 'file') : ''].filter(Boolean).join(' and ');
  const stat = (l, v, f, tone = '') => html`<div class="pstat ${tone}"><span class="l">${l}</span><b>${v}</b><span class="f">${f}</span></div>`;
  const stats = [
    stat('Done this week', plural(pr.done_week.length, 'task'), pr.done_week.length ? pr.done_week.slice(0, 2).join(', ') + (pr.done_week.length > 2 ? ` and ${pr.done_week.length - 2} more` : '') : 'Nothing finished yet this week', 'work'),
    stat('In progress', plural(pr.in_progress, 'task'), pr.due_week ? `${pr.due_week} due this week` : 'None due this week'),
    ...(s.approvals ? [stat('Waiting on you', String(pj.waiting.length), pj.waiting.length ? wText : 'You are all caught up', pj.waiting.length ? 'brass' : '')] : []),
    ...(pj.hours ? [stat('Hours this month', hrs(pj.hours.secs), pj.hours.retainer_hours ? `of your ${pj.hours.retainer_hours}h retainer` : monthLabel(pj.hours.month), 'leave')] : []),
  ];
  const st = pj.status;
  const STL = { on: ['On track', 'on'], risk: ['At risk', 'risk'], late: ['Running late', 'late'], done: ['All done', 'on'] };
  const line = st ? html`<div class="pstatus ${STL[st.state][1]}" role="status"><span class="pst-b"><i></i>${STL[st.state][0]}</span><span class="pst-t">${st.text}</span>${pj.waiting.length && s.approvals && st.state !== 'done' ? html`<a class="pst-a" href="#/approvals?p=${pj.project.id}">See what’s waiting</a>` : ''}</div>` : '';
  const cm = pj.current_milestone;
  const strip = cm && cm.tasks.length ? html`<div class="pmstrip"><b>In ${cm.title}</b><a class="pst-a" href="#/tasks?p=${pj.project.id}&m=${cm.id}">See these tasks</a><ul>${cm.tasks.slice(0, 8).map((t) => html`<li class="${t.status}"><span class="pms-c">${t.status === 'done' ? icon('check') : ''}</span><a href="#/tasks?p=${pj.project.id}&task=${t.id}">${t.title}</a></li>`)}</ul></div>` : '';
  const hero = html`${line}<div class="phero"><div class="phero-ring">${ring(pr.pct / 100, { center: html`<b>${pr.pct}%</b><span>done</span>` })}</div>
    <div class="phero-r"><div class="pstats" style="--n:${stats.length}">${stats}</div>${mileCards(pj.milestones)}${strip}</div></div>`;
  const u = pj.update;
  const updCard = card('pupdate', u ? html`${cardH(`Latest update from ${first(u.author && u.author.name) || 'the team'}`, relTime(u.created_at))}
      <div class="pu-intro">${u.author ? av(u.author, 40) : ''}<p>${u.intro}</p></div>
      <div class="pu-cols">${[['Done', u.done, 'work'], ['Next week', u.next, 'blue'], ['Needed from you', u.needed, 'brass']].filter(([, l]) => l && l.length).map(([t, l, c]) => html`<div><h3 class="${c}">${t}</h3><ul>${l.map((x) => html`<li>${x}</li>`)}</ul></div>`)}</div>`
    : html`${cardH('Latest update')}${emptyBox('No update yet', `${pj.lead ? first(pj.lead.name) : 'The team'} posts a short update every week: what got done, what is next and anything needed from you.`)}`);
  const feed = card('pfeed', html`${cardH('What happened', 'Latest first')}${pj.feed.length ? html`<ul class="pfeedl">${pj.feed.map(feedRow)}</ul>` : emptyBox('Nothing yet', 'Finished tasks, shared files and approvals show up here as they happen.')}`);
  const wait = s.approvals ? card('pwaitc', html`${cardH('Waiting on you', '', pj.waiting.length ? html`<span class="pcount brass">${pj.waiting.length}</span>` : '')}${waitingList(pj.waiting)}`) : '';
  const team = s.people && pj.team.length ? card('pteam', html`${cardH('Your team', plural(pj.team.length, 'person', 'people'))}<ul class="pteaml">${pj.team.map((m) => html`<li data-k="m${m.id}">${av(m, 38)}<div><b>${m.name}</b><span>${m.lead ? 'Project lead' : m.title || ''}</span>${m.on_now && m.now_task ? html`<span class="pnow">Now: ${m.now_task}</span>` : ''}</div>${m.on_now ? html`<span class="ponit"><i></i>On it now</span>` : ''}</li>`)}</ul>`) : '';
  const asks = s.requests ? card('preqc', html`${cardH('Your requests', '', html`<a class="plink" href="#/requests?p=${pj.project.id}">All requests</a>`)}${pj.my_requests && pj.my_requests.length ? html`<ul class="preqmini">${pj.my_requests.slice(0, 3).map((r) => html`<li data-k="r${r.id}"><a href="#/requests?p=${pj.project.id}&r=${r.id}"><b>${r.title}</b>${reqStage(r)}</a></li>`)}</ul>` : html`<p class="pmuted">Need a change or something new? Ask the team; you can follow it here.</p><button type="button" class="pbtn sm" data-pa="request">${ix('ask', 15)}Ask the team</button>`}`) : '';
  const rate = pj.rate_milestone && store.get(`wh-rate-later-${pj.rate_milestone.id}`) !== '1' ? rateCard(pj.rate_milestone) : '';
  const call = pj.next_meeting ? callCard(pj.next_meeting) : '';
  return frame('overview', { title: pj.project.name, sub, hero, right: html`${reqBtn()}` },
    html`<div class="pgr"><div class="pcol">${call}${rate}${updCard}${feed}</div><div class="pcol side">${wait}${asks}${team}</div></div>`);
}

// ================= Tasks =================
async function loadTasks(pid, q) {
  const tid = Number(q.get('task'));
  const [pj, tasks, task] = await Promise.all([get(`/api/portal/projects/${pid}`), get(`/api/portal/projects/${pid}/tasks`), tid ? get(`/api/portal/tasks/${tid}`).catch(() => null) : null]);
  return { pj, tasks, task };
}
function taskCard(t, sel) {
  const pid = pidNow();
  const steps = t.steps && t.steps.total ? html`<span class="ptk-steps"><span class="pmc-bar" aria-hidden="true"><i style="width:${Math.round((t.steps.done / t.steps.total) * 100)}%"></i></span><span>${t.steps.done} of ${t.steps.total} steps</span></span>` : '';
  return html`<a class="ptask${sel ? ' sel' : ''}${t.status === 'done' ? ' done' : ''}" href="#/tasks?p=${pid}&task=${t.id}" data-k="k${t.id}" ${sel ? raw('aria-current="true"') : ''}>
    <b>${t.title}</b>${steps}
    <span class="ptm">${t.assignee ? av(t.assignee, 22) : ''}<span>${t.status === 'done' && t.completed_at ? relTime(t.completed_at) : t.due_day ? dayMD(t.due_day) : 'No date yet'}</span>
      <span class="ptm-r">${t.comments ? html`<span title="${plural(t.comments, 'comment')}">${icon('chat')}${t.comments}</span>` : ''}${t.files ? html`<span title="${plural(t.files, 'file')}">${icon('clip')}${t.files}</span>` : ''}</span></span></a>`;
}
function tasksPage({ pj, tasks, task }, q) {
  const view = q.get('view') || 'all';
  const mid = Number(q.get('m')) || null;
  const inMile = (t) => !mid || t.milestone_id === mid;
  const col = (k) => tasks.filter((t) => t.status === k && inMile(t));
  const done = col('done').sort((a, b) => ((b.completed_at || '') > (a.completed_at || '') ? 1 : -1));
  const showAll = q.get('done') === 'all';
  const sel = task && task.id;
  const column = (k, label, list, tone, extra = '') => html`<section class="pcolk ${tone}" aria-label="${label}"><h2><i></i>${label}<span>${list.length}</span></h2>${list.length ? list : html`<p class="pk-empty">${k === 'wait' ? 'Nothing waiting on you' : 'Nothing here'}</p>`}${extra}</section>`;
  const waitCards = pj.waiting.map((w) => html`<a class="ptask wait" href="#/approvals?p=${pj.project.id}&a=${w.id}"><b>${w.kind === 'file' ? `Send: ${w.title}` : `Approve: ${w.title}`}</b><span class="ptm"><span>${w.due_day ? `By ${dayMD(w.due_day)}` : `Asked ${relTime(w.created_at)}`}</span></span></a>`);
  const board = view === 'wait'
    ? html`<div class="pboard one">${column('wait', 'Waiting on you', waitCards, 'brass')}</div>`
    : html`<div class="pboard">
      ${column('todo', 'To do', col('todo').map((t) => taskCard(t, t.id === sel)), 'idle')}
      ${column('in_progress', 'In progress', col('in_progress').map((t) => taskCard(t, t.id === sel)), 'blue')}
      ${pj.settings.approvals && !mid ? column('wait', 'Waiting on you', waitCards, 'brass') : ''}
      ${column('done', 'Done', (showAll ? done : done.slice(0, 4)).map((t) => taskCard(t, t.id === sel)), 'work', done.length > 4 && !showAll ? html`<button type="button" class="plink" data-pa="q" data-k="done" data-v="all">See ${done.length - 4} more</button>` : '')}</div>`;
  const miles = pj.milestones.filter((m) => tasks.some((t) => t.milestone_id === m.id));
  const chips = miles.length ? html`<div class="pmchips" role="group" aria-label="Milestone"><button type="button" aria-pressed="${String(!mid)}" data-pa="q" data-k="m" data-v="">Every milestone</button>${miles.map((m) => html`<button type="button" aria-pressed="${String(mid === m.id)}" data-pa="q" data-k="m" data-v="${m.id}">${m.done_at ? html`${icon('check')}` : ''}${m.title}</button>`)}</div>` : '';
  const seg = html`<div class="pseg" role="group" aria-label="Show">${[['all', 'Every task'], ...(pj.settings.approvals ? [['wait', `Waiting on you${pj.waiting.length ? ` · ${pj.waiting.length}` : ''}`]] : [])].map(([k, l]) => html`<button type="button" aria-pressed="${String(view === k)}" data-pa="q" data-k="view" data-v="${k === 'all' ? '' : k}">${l}</button>`)}</div>`;
  return frame('tasks', { title: 'Tasks', sub: `${plural(tasks.length, 'task')} shared with you. Open one to see where it stands and to comment; the team moves them along.`, right: html`${seg}${reqBtn()}` },
    html`${chips}<div class="ptasks${task ? ' open' : ''}">${board}${task ? taskPanel(task, pj) : ''}</div>`);
}
const ST_LABEL = { todo: ['idle', 'To do'], in_progress: ['blue', 'In progress'], done: ['work', 'Done'] };
function commentFile(c) {
  if (!c.file) return '';
  if (/^image\//.test(c.file.type)) return html`<button type="button" class="pc-img" data-pa="open" data-url="${c.file.url}" data-name="${c.file.name}"><img alt="${c.file.name}" data-pimg="${c.file.url}"></button>`;
  return html`<button type="button" class="pfile" data-pa="open" data-url="${c.file.url}" data-name="${c.file.name}"><span class="pf-i">${icon('file')}</span><span><b>${c.file.name}</b><span>${kb(c.file.size || 0)}</span></span></button>`;
}
function taskPanel(t, pj) {
  const [tone, label] = ST_LABEL[t.status] || ST_LABEL.todo;
  const rows = [t.assignee ? ['Who', html`<span class="pwho">${av(t.assignee, 26)}<b>${t.assignee.name}</b></span>`] : null, t.milestone ? ['Milestone', t.milestone.title] : null, ['Due', t.due_day ? dateY(t.due_day) : 'No date yet'], t.completed_at ? ['Done', relTime(t.completed_at)] : null, t.secs != null && pj.settings.hours !== 'off' ? ['Hours so far', hrs(t.secs)] : null].filter(Boolean);
  const steps = t.steps && t.steps.length ? html`<div class="pp-steps"><h3>Steps <span class="pmuted">${t.steps.filter((x) => x.done).length} of ${t.steps.length}</span></h3><ol>${t.steps.map((x) => html`<li class="${x.done ? 'done' : ''}"><span class="pms-c">${x.done ? icon('check') : ''}</span><span>${x.title}</span>${x.done && x.done_at ? html`<span class="pmuted">${dayMD(x.done_at.slice(0, 10))}</span>` : ''}</li>`)}</ol></div>` : '';
  return html`<aside class="ppanel" aria-label="Task ${t.title}" data-k="panel${t.id}">
    <div class="pp-top">${pill(tone, label)}<span class="pp-ref">${t.ref}</span><a class="pbtn icon" href="#/tasks?p=${pidNow()}" aria-label="Close the task">${ix('x', 16)}</a></div>
    <h2>${t.title}</h2>${t.description ? html`<p class="pp-desc">${t.description}</p>` : ''}
    <dl class="pp-kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    ${steps}
    ${t.files.length ? html`<div class="pp-files">${t.files.map((f) => html`<button type="button" class="pfile" data-pa="open" data-url="/api/portal/tasks/${t.id}/files/${f.id}" data-name="${f.name}"><span class="pf-i">${icon('file')}</span><span><b>${f.name}</b><span>${relTime(f.created_at)} · ${kb(f.size)}</span></span></button>`)}</div>` : ''}
    <div class="pp-thread" aria-label="Comments">${t.comments.length ? t.comments.map((c) => html`<div class="pcm ${c.author.kind === 'client' ? 'me' : 'them'}" data-k="cm${c.id}">${c.author.kind === 'client' ? '' : av(c.author, 28)}<div class="pc-b">${c.author.kind === 'client' && c.author.id === P.home.me.id ? '' : html`<b>${c.author.name}${c.author.kind === 'staff' ? html` <span class="ch-tag team">${orgShort()}</span>` : ''}</b>`}${c.body ? html`<p>${c.body}</p>` : ''}${commentFile(c)}<span class="pc-t">${relTime(c.created_at)}</span></div></div>`) : html`<p class="pp-none">No comments yet. Ask a question or add a detail; ${t.assignee ? first(t.assignee.name) : 'the team'} gets a note.</p>`}</div>
    ${preview() ? '' : html`<form class="pp-comp" data-pform="comment" data-id="${t.id}"><div class="pp-att" data-att hidden></div><div class="pp-row"><label class="pbtn icon pp-clip" aria-label="Attach a screenshot or file" title="Attach a screenshot or file">${ix('clip', 17)}<input type="file" name="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,.docx,.xlsx,.zip"></label><textarea name="body" rows="1" placeholder="Comment on this task" aria-label="Comment on this task" maxlength="4000"></textarea><button class="ch-send" type="submit" aria-label="Send the comment">${ix('send', 18)}</button></div></form>
    <p class="pp-note">Everyone on the project sees it</p>`}</aside>`;
}

// ================= Messages =================
async function loadMessages(pid, q) {
  const [threads, presence] = await Promise.all([get(`/api/chat/projects/${pid}/threads`), get(`/api/chat/projects/${pid}/presence`).catch(() => null)]);
  P.presence = presence;
  const t = Number(q.get('t')) || null;
  const active = t || (threads[0] && threads[0].id);
  const media = active && P.gallery ? await get(`/api/chat/threads/${active}/media`).catch(() => null) : null;
  return { threads, presence, media, t, w: Number(q.get('with')) || null, m: Number(q.get('m')) || null, s: q.get('s') || '' };
}
const onlineStaff = (id) => !!(P.presence && P.presence.shown && P.presence.staff.some((x) => x.id === id && x.online));
function messagesPage(d, q) {
  const groups = d.threads;
  const cur = d.t ? groups.find((x) => x.id === d.t) : null;
  const active = cur || (d.w ? groups.find((x) => x.with && x.with.id === d.w) : null) || (window.matchMedia('(max-width: 900px)').matches ? null : groups[0]);
  const dot = (p) => (p && onlineStaff(p.id) ? raw('<i class="ch-on" aria-label="Online"></i>') : '');
  const list = html`<section class="pcd pchats${active && (d.t || d.w) ? ' has-open' : ''}" aria-label="Chats">${cardH('Chats')}
    <div class="psearch"><label class="psearch-in">${ix('search', 15)}<input type="search" data-psearch value="${d.s}" placeholder="Search every chat" aria-label="Search every chat" autocomplete="off"></label><div class="psearch-r" data-psr hidden role="listbox" aria-label="Search results"></div></div>
    <ul class="pchl">${groups.map((g) => {
      const on = active && (g.id ? g.id === active.id : g.with && active.with && g.with.id === active.with.id && !active.id);
      const last = g.last ? (g.last.deleted ? 'This message was deleted' : g.last.body || g.last.file || '') : g.kind === 'direct' ? 'Start a chat' : 'No messages yet';
      const live = g.kind === 'direct' && onlineStaff(g.with && g.with.id);
      return html`<li><button type="button" class="pch-i${on ? ' on' : ''}" data-pa="thread" data-id="${g.id || ''}" data-with="${g.with ? g.with.id : ''}" ${on ? raw('aria-current="true"') : ''}>
        ${g.kind === 'group' ? html`<span class="pgav">${icon('users')}</span>` : html`<span class="pav-w">${av(g.with, 44)}${dot(g.with)}</span>`}
        <span class="pch-t"><span class="pch-r1"><b>${g.name}</b><span class="pch-w">${g.last ? relTime(g.last.at) : ''}</span></span><span class="pch-r2"><span class="pch-last${live && !g.last ? ' on' : ''}">${live && !g.last ? 'Online now' : html`${g.last && g.last.mine ? 'You: ' : g.last && g.kind === 'group' && !g.last.mine ? `${first(g.last.author.name)}: ` : ''}${last}`}</span>${g.unread ? html`<span class="pbadge g">${g.unread}</span>` : ''}</span></span></button></li>`;
    })}</ul>${P.presence && P.presence.shown ? html`<p class="pmuted pch-note">A green dot means someone has Staffwarden open right now.</p>` : ''}</section>`;
  let chat;
  if (!active) chat = html`<section class="pcd pchat pchat-empty">${emptyBox('Pick a chat', 'Message everyone on the project, or one person directly.')}</section>`;
  else if (!active.id) chat = html`<section class="pcd pchat pchat-empty">${av(active.with, 64)}${emptyBox(`Message ${first(active.name)} directly`, `Only you and ${first(active.name)} see this chat. For anything the whole team should know, use the Everyone chat.`, preview() ? '' : html`<button type="button" class="pbtn ink" data-pa="start" data-with="${active.with.id}">${icon('chat')}Start the chat</button>`)}</section>`;
  else chat = html`<section class="pcd pchat"><button type="button" class="pback" data-pa="back" aria-label="Back to the chats">${icon('left')}Chats</button><div class="chat-box" data-own="t${active.id}" data-thread="${active.id}"></div></section>`;
  const side = P.gallery && active && active.id ? gallery(d.media, q) : html`<div class="pmside">
    ${settings().requests ? card('pask', html`<p><b>Need work done?</b> A change, something new or a problem goes in as a request, so it doesn't get lost in the chat.</p><button type="button" class="pbtn sm" data-pa="request">${ix('ask', 15)}Ask the team</button>`) : ''}
    ${active && active.id ? card('pgal-open', html`<button type="button" class="pgal-btn" data-pa="gallery">${ix('grid', 18)}<span><b>Photos and files</b><span>Everything shared in this chat</span></span>${icon('right')}</button>`) : ''}</div>`;
  return frame('messages', { title: 'Messages', sub: 'Chat with everyone on your project. Replies and typing show up as they happen.', right: reqBtn() },
    html`<div class="pmsgs${active && (d.t || d.w) ? ' open' : ''}${P.gallery ? ' gal' : ''}">${list}${chat}${side}</div>`);
}
function gallery(media, q) {
  const tab = q.get('g') || 'photos';
  const m = media || { photos: [], files: [], links: [], voice: [] };
  const tabs = [['photos', 'Photos', m.photos.length], ['files', 'Files', m.files.length], ['links', 'Links', m.links.length], ['voice', 'Voice', m.voice.length]];
  let body;
  if (!media) body = html`<p class="pmuted">Loading…</p>`;
  else if (tab === 'photos') body = m.photos.length ? html`<div class="pgal-grid">${m.photos.map((f) => html`<button type="button" class="pgal-ph" data-pa="open" data-url="${f.url}" data-name="${f.name}" aria-label="${f.name}, from ${f.by}"><img alt="" data-pimg="${f.url}"></button>`)}</div>` : html`<p class="pmuted">Photos sent in this chat show up here.</p>`;
  else if (tab === 'files') body = m.files.length ? html`<div class="pfl">${m.files.map((f) => html`<button type="button" class="pfile" data-pa="open" data-url="${f.url}" data-name="${f.name}"><span class="pf-i">${icon('file')}</span><span><b>${f.name}</b><span>${first(f.by)} · ${relTime(f.at)}${f.pages ? ` · ${plural(f.pages, 'page')}` : ''}</span></span></button>`)}</div>` : html`<p class="pmuted">Files sent in this chat show up here.</p>`;
  else if (tab === 'links') body = m.links.length ? html`<ul class="pgal-links">${m.links.map((l) => html`<li><a href="${l.url}" target="_blank" rel="noopener noreferrer">${ix('link', 15)}<span><b>${l.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}</b><span>${first(l.by)} · ${relTime(l.at)}</span></span></a></li>`)}</ul>` : html`<p class="pmuted">Links shared in this chat show up here.</p>`;
  else body = m.voice.length ? html`<div class="pfl">${m.voice.map((f) => html`<button type="button" class="pfile" data-pa="open" data-url="${f.url}" data-name="${f.name}"><span class="pf-i">${ix('mic', 16)}</span><span><b>Voice message · ${Math.floor(f.secs / 60)}:${String(f.secs % 60).padStart(2, '0')}</b><span>${first(f.by)} · ${relTime(f.at)}</span></span></button>`)}</div>` : html`<p class="pmuted">Voice messages in this chat show up here.</p>`;
  return html`<section class="pcd pgal" aria-label="Photos and files">${cardH('Photos and files', 'In this chat', html`<button type="button" class="pbtn icon sm" data-pa="gallery" aria-label="Close photos and files">${ix('x', 15)}</button>`)}
    <div class="pgal-tabs" role="tablist">${tabs.map(([k, l, n]) => html`<button type="button" role="tab" aria-selected="${String(tab === k)}" data-pa="q" data-k="g" data-v="${k === 'photos' ? '' : k}">${l}${n ? html` <span>${n}</span>` : ''}</button>`)}</div>${body}</section>`;
}
// search across every chat, as you type
let searchT = null;
async function runSearch(input) {
  const box = root.querySelector('[data-psr]'); if (!box) return;
  const q = input.value.trim();
  if (q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  try {
    const r = await get(`/api/chat/projects/${pidNow()}/search?q=${encodeURIComponent(q)}`);
    if (input.value.trim() !== q) return;
    const mark = (s) => esc(s).replace(new RegExp(`(${esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    box.hidden = false;
    box.innerHTML = r.results.length ? `<div class="psr-h">${r.results.length === 1 ? '1 message' : `${r.results.length} messages`} in ${r.threads === 1 ? '1 chat' : `${r.threads} chats`}</div>${r.results.map((x) => `<button type="button" role="option" class="psr-i" data-pa="hit" data-t="${x.thread_id}" data-m="${x.id}"><span class="psr-1"><span><b>${esc(x.thread)}</b> · ${esc(x.mine ? 'You' : first(x.author.name))}</span><span>${esc(relTime(x.created_at))}</span></span><span class="psr-2">${mark(x.body || x.file || '')}</span></button>`).join('')}`
      : `<div class="psr-h">Nothing found for “${esc(q)}”</div>`;
  } catch { box.hidden = true; }
}

// ================= Requests =================
// A request goes Sent -> Seen -> Taken on (a task they can follow) or Not doing -> Done.
const RKIND = { change: ['wrench', 'A change'], new: ['spark', 'Something new'], problem: ['alert', 'A problem'] };
const SOON = { whenever: 'Whenever there’s time', month: 'This month', week: 'This week' };
function reqSteps(r) {
  const declined = r.status === 'declined' || r.status === 'cancelled';
  const taken = r.status === 'planned' || r.status === 'done';
  const est = r.estimate;
  const steps = [
    ['Sent', relTime(r.created_at), true],
    ['Seen', r.seen_at ? `${first(r.seen_by_name) || 'The team'}, ${relTime(r.seen_at)}` : 'Not yet', !!r.seen_at],
    ...(est || r.status === 'new' ? [['Estimate', est ? `About ${est.hours}h${est.answer === 'yes' ? ', agreed' : est.answer === 'no' ? ', not now' : ''}` : 'If it needs one', !!est]] : []),
    declined ? [r.status === 'cancelled' ? 'Cancelled' : 'Not doing', relTime(r.cancelled_at || r.decided_at || r.created_at), true] : ['Taken on', taken && r.decided_at ? relTime(r.decided_at) : 'Waiting for a reply', taken],
    ...(declined ? [] : [['Done', r.status === 'done' || (r.task && r.task.status === 'done') ? 'Finished' : '', r.status === 'done' || (r.task && r.task.status === 'done')]]),
  ];
  const cur = steps.findIndex((x) => !x[2]);
  return html`<ol class="prsteps${declined ? ' no' : ''}" aria-label="Where it stands" style="--n:${steps.length}">${steps.map(([t, d, on], i) => html`<li class="${on ? 'on' : ''}${i === cur ? ' cur' : ''}"><i>${on ? icon('check') : ''}</i><b>${t}</b><span>${d}</span></li>`)}</ol>`;
}
function reqStage(r) {
  if (r.status === 'cancelled') return pill('idle', r.estimate && r.estimate.answer === 'no' ? 'Not now' : 'Cancelled');
  if (r.status === 'declined') return pill('idle', 'Not doing');
  if (r.status === 'done' || (r.task && r.task.status === 'done')) return pill('work', 'Done');
  if (r.status === 'planned') return pill('blue', 'Taken on');
  if (r.estimate && !r.estimate.answer) return pill('leave', 'Estimate ready');
  return r.seen_at ? pill('brass', 'Seen') : pill('brk', 'Sent');
}
async function loadRequests(pid) {
  const list = await get(`/api/portal/projects/${pid}/requests`);
  const want = list.filter((r) => r.messages || ['new', 'planned'].includes(r.status));
  const [ret, ...threads] = await Promise.all([settings().hours !== 'off' ? get(`/api/portal/projects/${pid}/retainer`).catch(() => null) : null, ...want.map((r) => get(`/api/portal/requests/${r.id}/messages`).catch(() => []))]);
  const msgs = new Map(want.map((r, i) => [r.id, threads[i]]));
  return { list, ret, msgs };
}
function estimateBox(r, ret) {
  const e = r.estimate;
  const bar = ret && ret.retainer_hours ? (() => {
    const tot = ret.retainer_hours, used = Math.min(tot, ret.used_hours), agreed = Math.min(tot - used, ret.agreed_hours), add = Math.min(Math.max(0, tot - used - agreed), e.hours);
    const pct = (v) => `${(v / tot) * 100}%`;
    const over = ret.used_hours + ret.agreed_hours + e.hours > tot;
    return html`<div class="pret"><span class="pret-bar" aria-hidden="true"><i class="u" style="width:${pct(used)}"></i><i class="a" style="width:${pct(agreed)}"></i><i class="n" style="width:${pct(add)}"></i></span>
      <span class="pret-k"><span><i class="u"></i>Used ${hrs(ret.used_hours * 3600)}</span>${ret.agreed_hours ? html`<span><i class="a"></i>Agreed ${hrs(ret.agreed_hours * 3600)}</span>` : ''}<span><i class="n"></i>This one ${hrs(e.hours * 3600)}</span><span class="pmuted">of ${tot}h this month</span></span>
      ${over ? html`<p class="pret-over">${ix('alert', 14)}This would go over your retainer. ${first(e.by) || 'The team'} will talk it through with you before starting.</p>` : ''}</div>`;
  })() : '';
  return html`<div class="pest"><div class="pest-h"><span class="pest-ic">${ix('clock', 18)}</span><div><b>${first(e.by) || 'The team'} estimates about ${e.hours} ${e.hours === 1 ? 'hour' : 'hours'}</b>${e.note ? html`<p>${e.note}</p>` : ''}</div></div>${bar}
    ${preview() ? '' : html`<div class="pest-a"><button type="button" class="pbtn work" data-pa="answer" data-id="${r.id}" data-v="yes">${icon('check')}Go ahead</button><button type="button" class="pbtn" data-pa="answer" data-id="${r.id}" data-v="no">Not now</button><button type="button" class="pbtn" data-pa="ask-about" data-id="${r.id}">${ix('ask', 15)}Ask about it</button></div>`}</div>`;
}
function reqThread(r, msgs) {
  const list = msgs || [];
  const open = ['new', 'planned'].includes(r.status);
  if (!list.length && !open) return '';
  return html`<div class="prt" data-k="rt${r.id}">${list.length ? html`<ol class="prt-l">${list.map((m) => html`<li class="${m.mine ? 'me' : ''}" data-k="rm${m.id}">${m.mine ? '' : av(m.author, 26, m.author.kind === 'client')}<div><b>${m.mine ? 'You' : m.author.name}</b><p>${m.body}</p><span>${relTime(m.created_at)}</span></div></li>`)}</ol>` : ''}
    ${open && !preview() ? html`<form class="prt-f" data-pform="rmsg" data-id="${r.id}"><input name="body" maxlength="2000" placeholder="Reply to the team about this" aria-label="Reply to the team about this" required><button class="pbtn sm" type="submit">${ix('send', 14)}Send</button></form>` : ''}</div>`;
}
function requestsPage({ list, ret, msgs }) {
  const open = list.filter((r) => r.status === 'new' || r.status === 'planned'), closed = list.filter((r) => !open.includes(r));
  const item = (r) => { const [ic, kl] = RKIND[r.kind] || RKIND.new; const canEdit = r.status === 'new' && !(r.estimate && r.estimate.answer) && !preview(); return html`<li class="preq" id="r${r.id}" data-k="r${r.id}">
    <div class="preq-h"><span class="preq-k ${r.kind}">${ix(ic, 15)}${kl}</span><span class="pmuted">${r.by ? `${first(r.by)} asked` : 'Asked'} ${relTime(r.created_at)} · ${SOON[r.urgency] || ''}${r.edited_at ? ' · edited' : ''}</span>${reqStage(r)}</div>
    <h3>${r.title}</h3>${r.detail ? html`<p class="preq-d">${r.detail}</p>` : ''}${r.file ? html`<button type="button" class="pfile" data-pa="open" data-url="${r.file.url}" data-name="${r.file.name}"><span class="pf-i">${icon('file')}</span><span><b>${r.file.name}</b><span>${kb(r.file.size)}</span></span></button>` : ''}
    ${reqSteps(r)}
    ${r.estimate && !r.estimate.answer && r.status === 'new' ? estimateBox(r, ret) : ''}
    ${r.reply ? html`<div class="preq-reply ${r.status === 'declined' ? 'no' : ''}"><b>${first(r.decided_by_name) || 'The team'} replied</b><p>${r.reply}</p></div>` : ''}
    ${r.task ? html`<a class="preq-task" href="#/tasks?p=${pidNow()}&task=${r.task.id}">${icon('tasks')}<span><b>${r.task.ref}</b> ${r.task.title}</span><span class="pmuted">${ST_LABEL[r.task.status] ? ST_LABEL[r.task.status][1] : ''}</span>${icon('right')}</a>` : ''}
    ${reqThread(r, msgs.get(r.id))}
    ${canEdit ? html`<div class="preq-a"><button type="button" class="plink" data-pa="req-edit" data-id="${r.id}">${ix('edit', 14)}Edit</button><button type="button" class="plink danger" data-pa="req-cancel" data-id="${r.id}" data-title="${r.title}">Cancel it</button></div>` : ''}</li>`; };
  const how = card('phow', html`${cardH('How requests work')}<ol class="phowl"><li><b>You ask</b><span>A change, something new, or a problem. Add a file if it helps.</span></li><li><b>The team sees it</b><span>You see who looked at it and when.</span></li><li><b>An estimate, if it needs one</b><span>You see the hours against your retainer and say go ahead or not now.</span></li><li><b>It becomes a task</b><span>You can follow it and comment, or the team explains why not.</span></li></ol>
    <p class="pmuted">Just a question? <a class="plink" href="#/messages?p=${pidNow()}">Ask in Messages</a> instead.</p>`);
  const retC = ret && ret.retainer_hours ? card('pretc', html`${cardH('Your retainer this month')}<div class="pret"><span class="pret-bar" aria-hidden="true"><i class="u" style="width:${Math.min(100, (ret.used_hours / ret.retainer_hours) * 100)}%"></i><i class="a" style="width:${Math.min(100 - Math.min(100, (ret.used_hours / ret.retainer_hours) * 100), (ret.agreed_hours / ret.retainer_hours) * 100)}%"></i></span><span class="pret-k"><span><i class="u"></i>Used ${hrs(ret.used_hours * 3600)}</span>${ret.agreed_hours ? html`<span><i class="a"></i>Agreed requests ${hrs(ret.agreed_hours * 3600)}</span>` : ''}<span class="pmuted">of ${ret.retainer_hours}h</span></span></div>`) : '';
  return frame('requests', { title: 'Requests', sub: 'Changes and new work you’ve asked for, and where each one stands.', right: reqBtn() },
    html`<div class="pgr"><div class="pcol">${list.length ? html`${open.length ? html`<section class="pcd"><div class="pch"><h2>Open</h2><span class="pch-x">${open.length}</span></div><ul class="preql">${open.map(item)}</ul></section>` : ''}${closed.length ? html`<section class="pcd"><div class="pch"><h2>Closed</h2><span class="pch-x">${closed.length}</span></div><ul class="preql">${closed.map(item)}</ul></section>` : ''}`
      : card('', emptyBox('No requests yet', 'When you need a change or something new, ask the team here. You can follow every step.', html`<button type="button" class="pbtn ink" data-pa="request">${ix('ask', 16)}Ask the team</button>`))}</div><div class="pcol side">${retC}${how}</div></div>`);
}

// ================= Approvals =================
async function loadApprovals(pid, q) {
  const list = await get(`/api/portal/projects/${pid}/approvals`);
  return { list, a: Number(q.get('a')) || null, v: q.get('v') || 'compare' };
}
const AP = { waiting: ['brass', 'Waiting on you'], changes: ['late', 'Changes asked'], approved: ['work', 'Approved'], received: ['work', 'Sent'] };
function approvalsPage({ list, a, v }) {
  const open = list.filter((x) => x.status === 'waiting' || x.status === 'changes'), closed = list.filter((x) => !open.includes(x));
  const sel = list.find((x) => x.id === a) || (window.matchMedia('(max-width: 900px)').matches ? null : open[0] || list[0]);
  const item = (x) => { const last = x.versions[x.versions.length - 1]; return html`<li><a class="pap-i${sel && sel.id === x.id ? ' on' : ''}" href="#/approvals?p=${pidNow()}&a=${x.id}" ${sel && sel.id === x.id ? raw('aria-current="true"') : ''}><b>${x.title}</b><span>${x.status === 'approved' ? html`${icon('check')}Approved ${relTime(x.closed_at)}` : x.status === 'received' ? html`${icon('check')}Sent ${relTime(x.closed_at)}` : x.status === 'changes' ? 'You asked for changes. The team is on it.' : `${x.kind === 'approval' && last ? `Version ${last.n} · sent ${relTime(last.created_at)}` : `Asked ${relTime(x.created_at)}`}`}</span></a></li>`; };
  const left = html`<section class="pcd paplist${sel && a ? ' has-open' : ''}" aria-label="Approvals">${open.length ? html`<h2 class="pap-h">Waiting on you</h2><ul>${open.map(item)}</ul>` : ''}${closed.length ? html`<h2 class="pap-h">Done</h2><ul>${closed.map(item)}</ul>` : ''}${!list.length ? emptyBox('Nothing to approve', 'When the team needs your OK on wording, a design or a plan, it comes here with every version kept.') : ''}</section>`;
  return frame('approvals', { title: 'Approvals', sub: 'Things the team needs your OK on. Each version, your comments and your answer are kept here.' },
    html`<div class="paps${sel && a ? ' open' : ''}">${left}${sel ? approvalDetail(sel, v) : ''}</div>`);
}
// words added and taken out between two versions, for the side-by-side view
function diffWords(a, b) {
  const A = String(a || '').split(/(\s+)/), Bw = String(b || '').split(/(\s+)/);
  if (A.length * Bw.length > 250000) return { left: esc(a || ''), right: esc(b || '') };
  const n = A.length, m = Bw.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === Bw[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, left = '', right = '';
  while (i < n && j < m) {
    if (A[i] === Bw[j]) { left += esc(A[i]); right += esc(Bw[j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { left += /\S/.test(A[i]) ? `<del>${esc(A[i])}</del>` : esc(A[i]); i++; }
    else { right += /\S/.test(Bw[j]) ? `<ins>${esc(Bw[j])}</ins>` : esc(Bw[j]); j++; }
  }
  while (i < n) { left += /\S/.test(A[i]) ? `<del>${esc(A[i])}</del>` : esc(A[i]); i++; }
  while (j < m) { right += /\S/.test(Bw[j]) ? `<ins>${esc(Bw[j])}</ins>` : esc(Bw[j]); j++; }
  return { left, right };
}
const isImg = (v) => v && v.file && /^image\//.test(v.file.type);
function pinBox(v, { canPin }) {
  const pins = v.pins || [];
  return html`<div class="pv-pinbox${canPin ? ' can' : ''}" data-vid="${v.id}" ${canPin ? raw('data-pa="pin-at" title="Tap a spot to comment on it"') : ''}><img alt="${v.file.name}" data-pimg="/api/portal/approval-files/${v.id}">${pins.map((p) => html`<span class="pv-pin${p.resolved ? ' ok' : ''}" style="left:${p.x}%;top:${p.y}%" aria-label="Comment ${p.n}: ${p.body}">${p.n}</span>`)}</div>`;
}
function versionBody(v, { canPin = false } = {}) {
  return html`${v.body ? html`<div class="pv-body">${v.body}</div>` : ''}${v.file ? (isImg(v) ? pinBox(v, { canPin }) : html`<button type="button" class="pfile" data-pa="open" data-url="/api/portal/approval-files/${v.id}" data-name="${v.file.name}"><span class="pf-i">${icon('file')}</span><span><b>${v.file.name}</b><span>${kb(v.file.size)}</span></span></button>`) : ''}`;
}
function approvalDetail(x, view) {
  const [tone, label] = AP[x.status] || AP.waiting;
  const last = x.versions[x.versions.length - 1], prev = x.versions.length > 1 ? x.versions[x.versions.length - 2] : null;
  const me = P.home.me;
  const open = x.status === 'waiting' && !preview();
  let answer = '';
  if (x.kind === 'file') {
    answer = x.status === 'received' ? html`<div class="pans done">${icon('check')}<span>You sent <b>${last && last.file ? last.file.name : 'the file'}</b> ${last ? relTime(last.created_at) : ''}. ${first(x.by)} has it.</span></div>`
      : preview() ? '' : html`<form class="pans" data-pform="upload" data-id="${x.id}"><h3>Send the file</h3><p>${x.description || `${first(x.by)} asked you for this.`} Up to 5 MB: PDF, image, Word, Excel, CSV or a zip.</p>
        <label class="pdrop"><input type="file" name="file" required accept="image/png,image/jpeg,image/webp,application/pdf,text/csv,text/plain,.docx,.xlsx,.zip"><span>${ix('upload', 20)}<b>Choose a file</b><span data-fname>or drop it here</span></span></label>
        <textarea name="note" rows="2" placeholder="A note for the team (optional)"></textarea><div class="pans-a"><button class="pbtn work" type="submit">${ix('upload', 16)}Send it</button></div></form>`;
  } else if (x.status === 'approved') answer = html`<div class="pans done">${icon('check')}<span>${last && last.decided_by ? `${last.decided_by} approved` : 'Approved'} version ${last ? last.n : 1} ${relTime(x.closed_at)}.</span></div>`;
  else if (x.status === 'changes') answer = html`<div class="pans wait">${icon('clock')}<span>You asked for changes. ${first(x.by)} sends version ${(last ? last.n : 1) + 1} here when it’s ready.</span></div>`;
  else if (preview()) answer = '';
  else if (!me.can_approve) answer = html`<div class="pans wait">${icon('lock')}<span>Someone else at ${P.home.client.name} approves these. You can still comment on it, here or in Messages.</span></div>`;
  else answer = html`<form class="pans" data-pform="decide" data-id="${x.id}"><h3>Your answer</h3><p>When you approve, the team goes ahead with version ${last ? last.n : 1}. To ask for changes, say what to change.</p>
    <textarea name="note" rows="3" placeholder="A note for the team (needed if you ask for changes)" aria-label="A note for the team"></textarea>
    <div class="pans-a"><button class="pbtn" type="submit" name="d" value="changes">${ix('edit', 16)}Ask for changes</button><button class="pbtn work" type="submit" name="d" value="approved">${icon('check')}Approve version ${last ? last.n : 1}</button></div></form>`;
  const notes = [];
  if (x.reminded_at && x.status === 'waiting') notes.push(html`<p class="pnote2 brass">${ix('bell', 15)}<span>The team sent you a reminder ${relTime(x.reminded_at)}${x.due_day ? `. It’s needed by ${dayMD(x.due_day)}` : ''}.</span></p>`);
  else if (x.due_day && x.status === 'waiting') notes.push(html`<p class="pnote2">${ix('cal', 15)}<span>Needed by ${dateY(x.due_day)}.</span></p>`);
  const compare = x.kind === 'approval' && prev && view !== 'one';
  let body = '';
  if (x.kind === 'approval' && last) {
    if (compare) {
      const d = prev.body || last.body ? diffWords(prev.body, last.body) : null;
      body = html`<div class="pcmp"><div class="pcmp-c"><span class="pcmp-h">Version ${prev.n}${prev.decision === 'changes' ? html` · <span class="pmuted">you asked for changes</span>` : ''}</span>${d ? html`<div class="pv-body">${raw(d.left)}</div>` : ''}${isImg(prev) ? pinBox(prev, { canPin: false }) : prev.file ? versionBody({ ...prev, body: null }) : ''}</div>
        <div class="pcmp-c now"><span class="pcmp-h">Version ${last.n} · new</span>${d ? html`<div class="pv-body">${raw(d.right)}</div>` : ''}${isImg(last) ? pinBox(last, { canPin: open }) : last.file ? versionBody({ ...last, body: null }) : ''}</div></div>
        ${last.changes ? html`<div class="pv-ch"><b>What changed</b><p>${last.changes}</p></div>` : ''}`;
    } else body = html`<div class="pv-prev">${versionBody(last, { canPin: open })}</div>${last.changes ? html`<div class="pv-ch"><b>What changed from version ${last.n - 1}</b><p>${last.changes}</p></div>` : ''}`;
  }
  const pins = last && last.pins && last.pins.length ? html`<div class="ppins"><h3>Comments on version ${last.n}</h3><ol>${last.pins.map((p) => html`<li class="${p.resolved ? 'ok' : ''}" data-k="pin${p.id}"><span class="pv-pin static${p.resolved ? ' ok' : ''}">${p.n}</span><div><b>${p.author.kind === 'client' && p.author.id === me.id ? 'You' : p.author.name}</b><p>${p.body}</p><span class="pmuted">${p.resolved ? 'Sorted' : relTime(p.created_at)}</span></div>${!p.resolved && p.author.kind === 'client' && p.author.id === me.id && !preview() ? html`<button type="button" class="plink" data-pa="pin-ok" data-id="${p.id}">Mark sorted</button>` : ''}</li>`)}</ol></div>` : '';
  const pinHint = open && isImg(last) ? html`<p class="pmuted ppin-hint">${ix('pin', 14)}Tap a spot on the picture to leave a comment right there.</p>` : '';
  const hist = x.kind === 'approval' && x.versions.length ? html`<details class="pvers-d"${x.versions.length > 1 ? '' : raw(' open')}><summary>Every version (${x.versions.length})</summary><ol class="pvers">${x.versions.map((v) => html`<li class="${v.decision || (v === last ? 'cur' : '')}"><span class="pv-dot">${v.decision === 'approved' ? icon('check') : v.decision === 'changes' ? ix('edit', 13) : raw('<i></i>')}</span><div><b>Version ${v.n}</b> sent by ${first(v.by)}, ${relTime(v.created_at)}${v.decision === 'changes' && v.decision_note ? html`<p class="pv-note">${v.decided_by ? first(v.decided_by) : 'You'} asked for changes: “${v.decision_note}”</p>` : ''}${v.decision === 'approved' ? html`<p class="pv-ok">Approved by ${v.decided_by || 'you'}</p>` : ''}</div></li>`)}</ol></details>` : '';
  const toggle = x.kind === 'approval' && prev ? html`<div class="pseg light" role="group" aria-label="Show"><button type="button" aria-pressed="${String(view !== 'one')}" data-pa="q" data-k="v" data-v="">Side by side</button><button type="button" aria-pressed="${String(view === 'one')}" data-pa="q" data-k="v" data-v="one">Version ${last.n} only</button></div>` : '';
  return html`<section class="pcd papd" aria-label="${x.title}"><a class="pback" href="#/approvals?p=${pidNow()}">${icon('left')}Approvals</a>
    <div class="papd-top"><div>${pill(tone, label)}${x.kind === 'approval' && last ? html`<span class="pmuted">Version ${last.n} of ${x.versions.length}</span>` : ''}</div>${toggle}<span class="pwho">${av({ id: x.created_by, name: x.by }, 36)}<span><b>${x.by}</b><span>Asked ${relTime(x.created_at)}</span></span></span></div>
    <h2 class="papd-t">${x.title}</h2>${x.description && x.kind === 'approval' ? html`<p class="pp-desc">${x.description}</p>` : ''}${notes}
    ${body}${pinHint}${pins}
    ${x.kind === 'file' && x.versions.length ? html`<div class="pfl">${x.versions.map((v) => versionBody(v))}</div>` : ''}
    ${answer}${hist}</section>`;
}

// ================= Meetings =================
async function loadMeetings(pid) { return { m: await get(`/api/portal/projects/${pid}/meetings`) }; }
function notesCard(m, { head = true } = {}) {
  const n = m.notes;
  const col = (t, tone, inner) => html`<div class="pmn-c"><h3 class="${tone}">${t}</h3>${inner}</div>`;
  return html`<section class="pcd pmn" data-k="notes${m.id}">${head ? cardH(`${timeIn(m.starts_at, { weekday: 'long', month: 'short', day: 'numeric' })}: ${m.title}`, n && n.by ? `Notes by ${first(n.by)}` : '', html`<span class="pmuted">${m.minutes} min</span>`) : ''}
    ${n ? html`${n.text ? html`<p class="pmn-t">${n.text}</p>` : ''}<div class="pmn-g">
      ${n.decided.length ? col('Decided', 'work', html`<ul class="pdots work">${n.decided.map((d) => html`<li>${d}</li>`)}</ul>`) : ''}
      ${n.next.length ? col('Next steps', 'blue', html`<div class="pmn-steps">${n.next.map((s) => (s.task ? html`<a class="pmn-s" href="#/tasks?p=${pidNow()}&task=${s.task.id}">${icon('tasks')}<span>${s.task.title}</span>${pill(ST_LABEL[s.task.status][0], ST_LABEL[s.task.status][1])}</a>` : html`<span class="pmn-s">${icon('tasks')}<span>${s.text}</span></span>`))}</div>`) : ''}
      ${n.from_client.length ? col('From you', 'brass', html`<ul class="pdots brass">${n.from_client.map((d) => html`<li>${d}</li>`)}</ul>`) : ''}</div>`
    : html`<p class="pmuted">Notes from this call aren’t up yet. ${orgShort()} adds them after the call.</p>`}</section>`;
}
function meetingsPage({ m }) {
  const next = m.upcoming[0], later = m.upcoming.slice(1), lastWithNotes = m.past.find((x) => x.notes) || m.past[0];
  const right = preview() ? '' : html`<button type="button" class="pbtn brass" data-pa="call">${icon('plus')}Ask for a call</button>`;
  const earlier = m.past.filter((x) => x !== lastWithNotes);
  const hist = card('pmh', html`${cardH('Earlier calls')}${earlier.length ? html`<ul class="pmh-l">${earlier.map((x) => html`<li><details><summary><span class="pmh-ic">${ix('video', 16)}</span><span><b>${timeIn(x.starts_at, { weekday: 'long', month: 'short', day: 'numeric' })}: ${x.title}</b><span class="pmuted">${x.notes ? [x.notes.decided.length ? plural(x.notes.decided.length, 'decision') : '', x.notes.next.length ? plural(x.notes.next.length, 'next step') : ''].filter(Boolean).join(' · ') || 'Notes' : 'No notes'}</span></span>${icon('right')}</summary>${notesCard(x, { head: false })}</details></li>`)}</ul>` : html`<p class="pmuted">Past calls and their notes stay here.</p>`}`);
  const up = later.length ? card('', html`${cardH('Coming up')}<ul class="pmh-l">${later.map((x) => html`<li class="pmh-up"><span class="pmh-ic">${ix('cal', 16)}</span><span><b>${x.title}</b><span class="pmuted">${timeIn(x.starts_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ${zoneWord()}</span></span><button type="button" class="pbtn sm" data-pa="ics" data-id="${x.id}">${ix('cal', 14)}Add</button></li>`)}</ul>`) : '';
  return frame('meetings', { title: 'Meetings', sub: 'Your calls with the team, what was agreed, and what happens next.', right },
    html`<div class="pgr"><div class="pcol">${next ? callCard(next, { big: true }) : card('', emptyBox('No call booked', `${orgShort()} books calls here, with an agenda you can add to. Want one sooner?`, preview() ? '' : html`<button type="button" class="pbtn ink" data-pa="call">${icon('plus')}Ask for a call</button>`))}${lastWithNotes ? notesCard(lastWithNotes) : ''}</div><div class="pcol side">${up}${hist}</div></div>`);
}

// ================= Hours =================
async function loadHours(pid, q) {
  const qs = q.get('month') ? `?month=${q.get('month')}` : '';
  const [h, stmt, prefs] = await Promise.all([get(`/api/portal/projects/${pid}/hours${qs}`), get(`/api/portal/projects/${pid}/statement${qs}`).catch(() => null), preview() ? null : get('/api/portal/notify-prefs').catch(() => null)]);
  return { h, stmt, prefs };
}
function hoursPage({ h, stmt, prefs }) {
  const cur = h.today.slice(0, 7), isCur = h.month === cur, ret = h.retainer_hours;
  const months = []; for (let m = cur; m >= h.first_month && months.length < 4; m = addMonths(m, -1)) months.unshift(m);
  if (!months.includes(h.month)) months.unshift(h.month);
  const mName = (m) => monthLabel(m).split(' ')[0];
  const right = html`${months.length > 1 ? html`<div class="pseg dark" role="group" aria-label="Month">${months.map((m) => html`<button type="button" aria-pressed="${String(m === h.month)}" data-pa="q" data-k="month" data-v="${m === cur ? '' : m}">${mName(m)}</button>`)}</div>` : ''}<button type="button" class="pbtn ghost" data-pa="pdf" data-month="${h.month}">${ix('down', 16)}Monthly statement</button>`;
  const total = h.total_secs / 3600;
  const thisWeek = h.weeks.find((w) => w.from <= h.today && w.to >= h.today);
  const [y, mo] = h.month.split('-').map(Number), daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate(), dayNow = Number(h.today.slice(8, 10));
  const pace = isCur && dayNow > 2 ? (h.total_secs / dayNow) * daysIn : null;
  const st = (l, v, f, tone = '') => html`<div class="pstat box ${tone}"><span class="l">${l}</span><b>${v}</b><span class="f">${f}</span></div>`;
  const stats = [
    ...(ret ? [st(isCur ? 'Left this month' : 'Left over', hrs(Math.max(0, ret * 3600 - h.total_secs)), total > ret ? `${hrs(h.total_secs - ret * 3600)} over the retainer` : isCur ? `Until ${dayMD(addDays(`${h.month}-01`, daysIn - 1))}` : `of ${ret}h`, 'leave')] : []),
    ...(isCur && thisWeek ? [st('This week so far', hrs(thisWeek.secs), `${dayMD(thisWeek.from)} to today`)] : []),
    ...(pace != null ? [st('On pace for', hrs(pace), ret ? `By ${dayMD(addDays(`${h.month}-01`, daysIn - 1))}, of your ${ret}h` : 'By the end of the month', pace > (ret || Infinity) * 3600 ? 'late' : 'work')] : []),
    ...(!isCur ? [st('Weeks', String(h.weeks.length), monthLabel(h.month))] : []),
  ];
  const pct = ret ? total / ret : 0;
  const lead = P.cache.get(`lead:${pidNow()}`);
  const alert = ret && isCur && pct >= 0.8 ? html`<div class="phalert${pct >= 1 ? ' over' : ''}" role="status"><span class="pha-ic">${ix('alert', 18)}</span><div><b>${pct >= 1 ? `You’ve gone past ${mName(h.month)}’s retainer` : `You’ve used ${Math.floor(pct * 100)}% of ${mName(h.month)}’s retainer`}</b><span>${hrs(h.total_secs)} of ${ret} hours, with ${daysIn - dayNow} ${daysIn - dayNow === 1 ? 'day' : 'days'} to go.${pace != null ? ` At this pace the month ends near ${hrs(pace)}.` : ''} The team checks with you before going over.</span></div>${settings().messages ? html`<a class="pbtn ghost" href="#/messages?p=${pidNow()}">${icon('chat')}Talk to ${lead ? first(lead) : 'the team'}</a>` : ''}</div>` : '';
  const hero = html`${alert}<div class="phero phrs">${ring(ret ? total / ret : 1, { size: 164, stroke: 13, color: '#9C8CFF', center: html`<b>${hrs(h.total_secs)}</b><span>${ret ? `of ${ret}h` : monthLabel(h.month)}</span>` })}<div class="pstats boxes" style="--n:${stats.length}">${stats}</div></div>`;
  const max = Math.max(1, ...h.weeks.map((w) => w.secs));
  const weeks = card('', html`${cardH('Week by week', isCur ? 'This week is still going' : monthLabel(h.month))}<div class="pweeks" role="list">${h.weeks.map((w) => { const going = isCur && w.from <= h.today && w.to >= h.today; return html`<div class="pwk${going ? ' going' : ''}" role="listitem" aria-label="${dayMD(w.from)} to ${dayMD(w.to)}: ${hrs(w.secs)}"><span class="b"><span class="v">${hrs(w.secs)}</span><i style="height:calc((100% - 24px) * ${Math.max(0.01, w.secs / max).toFixed(4)})"></i></span><span class="d">${dayMD(w.from)}<br>to ${w.to.slice(8, 10).replace(/^0/, '')}</span></div>`; })}</div>`);
  const people = h.people ? card('', html`${cardH('By person', hrs(h.total_secs))}${h.people.length ? html`<ul class="pbars">${h.people.map((p) => html`<li><div class="pb-r">${av(p, 34)}<span><b>${p.name}</b><span>${p.title || ''}</span></span><b class="pb-v">${hrs(p.secs)}</b></div><span class="pb-b"><i style="width:${(p.secs / Math.max(1, h.people[0].secs)) * 100}%"></i></span></li>`)}</ul>` : html`<p class="pmuted">No hours logged this month yet.</p>`}`) : '';
  const tasks = h.tasks ? card('', html`${cardH('Where the hours went', 'Top tasks this month')}${h.tasks.length || h.other ? html`<ul class="ptbars">${h.tasks.map((t) => html`<li><span><b>${t.title}</b>${t.mainly ? html`<span>Mainly ${t.mainly}</span>` : ''}</span><span class="pb-b"><i style="width:${(t.secs / Math.max(1, h.tasks[0] ? h.tasks[0].secs : 1)) * 100}%"></i></span><b class="pb-v">${hrs(t.secs)}</b></li>`)}${h.other ? html`<li class="other"><span>${h.other.tasks ? plural(h.other.tasks, 'other task') : 'Other work on the project'}</span><span class="pb-b"><i style="width:${Math.min(100, (h.other.secs / Math.max(1, h.tasks[0] ? h.tasks[0].secs : h.other.secs)) * 100)}%"></i></span><b class="pb-v">${hrs(h.other.secs)}</b></li>` : ''}</ul>` : html`<p class="pmuted">No hours logged this month yet.</p>`}`) : '';
  const statement = stmt ? card('pstmt', html`${cardH(`${mName(h.month)} statement`, stmt.ready ? 'Final' : `So far, as of ${dayMD(h.today)}`, html`<button type="button" class="pbtn sm ink" data-pa="pdf" data-month="${h.month}">${ix('down', 14)}Download PDF</button>`)}
    <div class="pst-doc"><div class="pst-dh"><div><b>${stmt.org}</b><span>Statement for ${stmt.client} · ${monthLabel(h.month)}</span></div><span class="mark">${raw(HELM)}</span></div>
      <table><thead><tr><th>Milestone</th><th>Hours</th></tr></thead><tbody>${stmt.lines.length ? stmt.lines.map((l) => html`<tr><td>${l.label}</td><td>${(l.secs / 3600).toFixed(1)}h</td></tr>`) : html`<tr><td colspan="2" class="pmuted">No hours logged this month.</td></tr>`}</tbody>
      <tfoot><tr><td>Total</td><td>${(stmt.total_secs / 3600).toFixed(1)}h${stmt.retainer_hours ? ` of ${stmt.retainer_hours}h` : ''}</td></tr></tfoot></table>
      <p class="pmuted">From the team’s Staffwarden timers, only while they work on your project. Matches the invoice.</p></div>
    <p class="pmuted pst-csv">Need it in a spreadsheet? <button type="button" class="plink" data-pa="csv" data-month="${h.month}">Download the day-by-day CSV</button></p>`) : '';
  const sw = (k, t, s, on) => html`<label class="pswr"><span><b>${t}</b><span>${s}</span></span><span class="switch"><input type="checkbox" data-hpref="${k}" ${on ? raw('checked') : ''} aria-label="${t}"><span></span></span></label>`;
  const alerts = prefs ? card('phal', html`${cardH('Hour alerts', 'For you')}${sw('hours80', 'At 80% of the retainer', 'You and the team both get told', prefs.hours80)}<div class="pswr static"><span><b>Before going over</b><span>The team always asks you first</span></span>${pill('work', 'Always')}</div>${sw('hours_week', 'Every Friday', 'The week’s hours in your notifications', prefs.hours_week)}`) : '';
  const note = card('pnote', html`<p>${ix('shield', 18)}<span>Hours come from the team’s Staffwarden timer, only while they work on your project. The statement is the same report ${orgShort()} invoices from.</span></p>`);
  return frame('hours', { title: 'Hours', sub: `Time the team logged on your project in ${monthLabel(h.month).split(' ')[0]}${ret ? `, against your ${ret}-hour monthly retainer` : ''}.`, right, hero, tone: 'violet' },
    html`<div class="pgr"><div class="pcol">${weeks}${statement}${tasks}</div><div class="pcol side">${alerts}${people}${note}</div></div>`);
}

// ================= Files =================
async function loadFiles(pid) { const [files, assets] = await Promise.all([get(`/api/portal/projects/${pid}/files`), get(`/api/portal/projects/${pid}/assets`).catch(() => ({ assets: [], sent: [] }))]); return { files, assets }; }
// the client's brand and files, shared by the team, and sending files in
function brandCard(assets) {
  const list = assets.assets || [];
  const colors = list.filter((a) => a.kind === 'color'), fonts = list.filter((a) => a.kind === 'font'), links = list.filter((a) => a.kind === 'link');
  const files = list.filter((a) => a.kind === 'file' && !a.from_client), notes = list.filter((a) => a.kind === 'note');
  if (!list.length) return '';
  const fileBtn = (a) => html`<li data-k="as${a.id}"><button type="button" class="pfile wide" data-pa="open" data-url="${a.url_file}" data-name="${a.file_name}"><span class="pf-i">${icon('file')}</span><span><b>${a.title}</b><span>${[a.section === 'brand' ? 'Brand' : '', a.task ? 'Approved work' : a.from_client ? 'Sent by you' : '', relTime(a.created_at)].filter(Boolean).join(' · ')}</span></span><span class="pf-s">${kb(a.size || 0)}</span></button></li>`;
  return card('pabrand', html`${cardH('Your brand and files', `What ${orgShort()} uses for your work`)}
    ${colors.length ? html`<div class="pswatches">${colors.map((a) => html`<button type="button" class="pswatch" data-pa="copy" data-v="${a.value}" title="Copy ${a.value}"><i style="background:${a.value}"></i><span><b>${a.title !== a.value ? a.title : a.value}</b>${a.title !== a.value ? html`<span>${a.value}</span>` : ''}</span></button>`)}</div>` : ''}
    ${fonts.length ? html`<p class="pmuted">Fonts: ${fonts.map((a) => a.value).join(', ')}</p>` : ''}
    ${files.length ? html`<ul class="pfiles-l">${files.map(fileBtn)}</ul>` : ''}
    ${links.length ? html`<ul class="pfiles-l">${links.map((a) => html`<li data-k="as${a.id}"><a class="pfile wide" href="${a.url}" target="_blank" rel="noopener noreferrer"><span class="pf-i">${ix('link', 16)}</span><span><b>${a.title}</b><span>${a.host || a.url}</span></span></a></li>`)}</ul>` : ''}
    ${notes.map((a) => html`<div class="pnote" data-k="as${a.id}"><b>${a.title}</b><p>${a.value}</p></div>`)}`);
}
function sendCard(assets) {
  if (preview()) return '';
  const sent = assets.sent || [];
  return card('psend', html`${cardH(`Send ${orgShort()} files`)}
    <button type="button" class="psenddrop" data-pa="as-send">${icon('file')}<b>Pick files to send</b><span class="pmuted">Logos, photos, documents, up to 50 MB each. They go straight to the team.</span></button>
    ${sent.length ? html`<ul class="pfiles-l">${sent.map((a) => html`<li data-k="ms${a.id}"><button type="button" class="pfile wide" data-pa="open" data-url="${a.url_file}" data-name="${a.file_name}"><span class="pf-i">${icon('file')}</span><span><b>${a.file_name}</b><span>Sent ${relTime(a.created_at)}${a.note ? ` · ${a.note}` : ''}</span></span><span class="pf-s">${kb(a.size || 0)}</span></button></li>`)}</ul>` : ''}`);
}
function filesPage({ files, assets }) {
  const where = { chat: 'In the chat', approval: 'Approvals', task: 'On a task' };
  return frame('files', { title: 'Files', sub: 'Your brand, approved work, and everything shared on the project.' },
    html`${brandCard(assets || {})}${sendCard(assets || {})}
    ${card('pfiles', html`${(assets && (assets.assets || []).length) ? cardH('Shared on the project') : ''}${files.length ? html`<ul class="pfiles-l">${files.map((f) => html`<li><button type="button" class="pfile wide" data-pa="open" data-url="${f.url}" data-name="${f.name}"><span class="pf-i">${icon('file')}</span><span><b>${f.name}</b><span>${[f.by ? `${f.by}` : '', f.about ? `on ${f.about}` : '', relTime(f.at)].filter(Boolean).join(' · ')}</span></span><span class="pf-w">${where[f.where]}</span><span class="pf-s">${kb(f.size || 0)}</span></button></li>`)}</ul>` : emptyBox('No files yet', 'Files shared in the chat, sent for approval or added to tasks all show up here.')}`)}`);
}
function sendDialog() {
  let picked = [];
  const m = openModal({
    title: `Send ${orgShort()} files`, submit: 'Send',
    body: html`<div class="field"><label class="f" for="ps-f">Files</label><input id="ps-f" type="file" multiple data-ps-files></div>
      <div class="field"><label class="f" for="ps-n">Anything we should know? (optional)</label><textarea id="ps-n" name="note" rows="3" maxlength="2000" placeholder="New listing photos. Use the garden one first."></textarea></div>
      <p class="hint">Up to 50 MB each. The team is told when they arrive.</p>`,
    onSubmit: async (fd) => {
      if (!picked.length) { m.setError('Pick at least one file'); return false; }
      const note = String(fd.get('note') || '').trim();
      for (const f of picked) {
        if (f.size > 50 * 1024 * 1024) throw new Error(`${f.name} is over 50 MB`);
        const q = new URLSearchParams({ name: f.name, mime: f.type || '', ...(note ? { note } : {}) });
        const res = await fetch(`/api/portal/projects/${pidNow()}/assets/upload?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: f });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `${f.name} didn’t go through. Try again.`); }
      }
      toast(picked.length === 1 ? 'Sent. The team has it.' : `${picked.length} files sent. The team has them.`);
      run();
    },
  });
  m.form.addEventListener('change', (e) => { if (e.target.matches('[data-ps-files]')) picked = [...e.target.files]; });
}

// ================= running the pages =================
const PAGES = { overview: [loadOverview, overview], tasks: [loadTasks, tasksPage], messages: [loadMessages, messagesPage], requests: [loadRequests, requestsPage], approvals: [loadApprovals, approvalsPage], meetings: [loadMeetings, meetingsPage], hours: [loadHours, hoursPage], files: [loadFiles, filesPage] };
function noProject() {
  return html`<div class="pt"><header class="pbr"><div class="pin">${bar('overview')}<div class="phd"><div class="phd-t"><h1 tabindex="-1">Welcome, ${first(P.home.me.name)}</h1><p>There is nothing to show yet.</p></div></div></div></header>
    <main class="pbody"><div class="pin">${card('', emptyBox('No projects shared with you yet', `When ${orgShort()} adds your project, it shows up here.`))}</div></main></div>`;
}
async function run({ navigated = false } = {}) {
  if (P.loading && !navigated) { P.again = true; return; }
  P.loading = true;
  const my = ++P.seq;
  const { page, q } = parse();
  try {
    if (!P.home) { P.home = await get('/api/portal'); if (P.pplKeep) { P.home.people = P.pplKeep; P.pplKeep = null; } }
    else if (navigated) get('/api/portal').then((h) => { P.home = { ...h, people: P.home.people }; paintPreview(); }).catch(() => {});
    paintPreview();
    const pid = pidNow();
    let out, newPage = false;
    if (!pid) out = noProject();
    else {
      const name = tabOn(page) ? page : 'overview';
      const [load, render] = PAGES[name];
      const key = `${pid}:${name}?${q}`, base = `${pid}:${name}?${[...q].filter(([k]) => !['task', 'a', 't', 'with', 'r', 'm', 's'].includes(k)).map(([k, v]) => `${k}=${v}`).join('&')}`;
      // a filter, a chat or an opened task on the same tab is not a new page: no entrance, no jump to the top
      newPage = navigated && P.lastTab !== `${pid}:${name}`;
      P.lastTab = `${pid}:${name}`;
      if (newPage) window.scrollTo(0, 0);
      P.lastBase = base;
      if (navigated) {
        const cached = P.cache.get(key) || P.cache.get(base);
        if (cached) { try { morph(root, render(cached, q).toString()); afterRender(); if (newPage) enterAnim(); navigated = 'shown'; } catch { /* draw fresh below */ } }
        else if (!root.querySelector('.pt') || P.lastPage !== name) { root.innerHTML = skeleton(name); }
      }
      P.lastPage = name;
      const data = await load(pid, q);
      if (my !== P.seq) return;
      if (data.pj && data.pj.lead) P.cache.set(`lead:${pid}`, data.pj.lead.name);
      P.data = data;
      P.cache.set(key, data); P.cache.set(base, data);
      if (P.cache.size > 40) P.cache.delete(P.cache.keys().next().value);
      out = render(data, q);
    }
    const had = navigated ? null : new Set([...root.querySelectorAll('[data-k]')].map((x) => x.dataset.k));
    // a comment being written, or a file chosen for it, survives a live refresh
    const keep = [...root.querySelectorAll('form[data-pform] textarea, form[data-pform] input[name="body"], form[data-pform] input[name="text"]')].map((x) => [x.closest('form').dataset.pform + (x.closest('form').dataset.id || ''), x.name, x.value]).filter((x) => x[2]);
    morph(root, out.toString());
    for (const [f, n, v] of keep) { const fe = [...root.querySelectorAll('form[data-pform]')].find((x) => x.dataset.pform + (x.dataset.id || '') === f); if (fe && fe[n] && !fe[n].value) fe[n].value = v; }
    afterRender();
    if (navigated === true && newPage) enterAnim();
    else if (had) for (const el of root.querySelectorAll('[data-k]')) if (!had.has(el.dataset.k) && !el.closest('.chat') && !/^t/.test(el.dataset.k)) { el.classList.add('arrive'); setTimeout(() => el.classList.remove('arrive'), 1600); }
    if (navigated && q.get('r')) { const el = document.getElementById(`r${q.get('r')}`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('arrive'); } }
    document.title = `${TABS.find((t) => t[0] === page)[1]} · ${P.home.client.name}`;
    if (navigated === true && newPage) { const h = root.querySelector('h1'); if (h && !root.querySelector('.ppanel, .papd.focus')) h.focus({ preventScroll: true }); }
    paintBell();
    maybeInstall();
  } catch (e) {
    if (e.status === 401 || my !== P.seq) return;
    if (!root.querySelector('.pt') || navigated || root.querySelector('.skc')) root.innerHTML = `<div class="center"><div class="login"><div class="card"><h1>Couldn't load this page</h1><p class="muted mt">${esc(errMsg(e))}</p><button class="btn primary mt" data-pa="retry">Try again</button></div></div></div>`;
  } finally {
    if (my === P.seq) { P.loading = false; if (P.again) { P.again = false; schedule(); } }
  }
}
function enterAnim() { const t = root.querySelector('.pt'); if (t) { t.classList.remove('enter'); void t.offsetWidth; t.classList.add('enter'); setTimeout(() => t.classList.remove('enter'), 1100); } }
function schedule() { clearTimeout(P.wake); P.wake = setTimeout(() => run(), 250); }
function presenceFor() {
  const pr = P.presence;
  if (!pr) return null;
  return { staff: new Set(pr.shown ? pr.staff.filter((x) => x.online).map((x) => x.id) : []), clients: new Map() };
}
function afterRender() {
  // on a phone the tabs scroll sideways: keep the one you're on in sight
  const strip = root.querySelector('.ptabs'), on = strip && strip.querySelector('[aria-current="page"]');
  if (on && strip.scrollWidth > strip.clientWidth + 2) { const sr = strip.getBoundingClientRect(), ir = on.getBoundingClientRect(); if (ir.left < sr.left + 8 || ir.right > sr.right - 8) strip.scrollLeft += ir.left - sr.left - (sr.width - ir.width) / 2; }
  const { q } = parse();
  for (const box of root.querySelectorAll('.chat-box[data-thread]')) {
    if (box.classList.contains('chat')) continue;
    const c = mountChat(box, { threadId: Number(box.dataset.thread), clientName: clientShort(), orgShort: orgShort(), onRead: refreshCounts, focusMsg: Number(q.get('m')) || null,
      onGallery: (on) => { P.gallery = on; schedule(); }, galleryOpen: P.gallery, readOnly: preview() });
    P.chats.set(Number(box.dataset.thread), c);
    c.setPresence(presenceFor());
  }
  for (const img of root.querySelectorAll('img[data-pimg]')) {
    const u = img.dataset.pimg;
    if (P.urls.has(u)) { if (img.src !== P.urls.get(u)) img.src = P.urls.get(u); continue; }
    fileUrl(u).then((b) => { P.urls.set(u, b); img.src = b; }).catch(() => {});
  }
  if (preview()) for (const el of root.querySelectorAll('.chat .ch-comp')) el.hidden = true;
}
let countT = null;
function refreshCounts() {
  clearTimeout(countT);
  countT = setTimeout(async () => {
    try {
      const h = await get('/api/portal');
      P.home = { ...h, people: P.home.people };
      paintPreview();
      const nav = root.querySelector('.ptop');
      if (nav) morph(nav, bar(parse().page).toString().replace(/^<div class="ptop">|<\/div>$/g, ''));
      paintBell();
      if (parse().page === 'messages' && P.data && P.data.threads) { P.data.threads = await get(`/api/chat/projects/${pidNow()}/threads`); const l = root.querySelector('.pchl'); if (l) { const tmp = document.createElement('div'); tmp.innerHTML = messagesPage(P.data, parse().q).toString(); const n = tmp.querySelector('.pchl'); if (n) morph(l, n.innerHTML); } }
    } catch { /* badges are optional */ }
  }, 300);
}
// the notice at the top (an update or planned downtime), the same as on the team's screens
async function portalBanner() {
  if (getViewAs()) return;
  let b = null;
  try { b = (await get('/api/banner')).banner; } catch { return; }
  let el = document.getElementById('sysban'), gone = null;
  try { gone = localStorage.getItem('wh-ban-ok'); } catch { /* private window */ }
  if (!b || gone === b.id) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'sysban'; el.setAttribute('role', 'status'); document.body.prepend(el); }
  el.className = `sysban portal ${b.tone}`;
  el.innerHTML = `${icon(b.tone === 'warn' ? 'clock' : 'mega')}<b>${esc(b.text)}</b><button type="button" class="sysban-ok">Got it</button>`;
  el.querySelector('.sysban-ok').addEventListener('click', () => { try { localStorage.setItem('wh-ban-ok', b.id); } catch { /* ok */ } el.remove(); });
}
function onEvent(ev) {
  if (ev.type === 'banner') { portalBanner(); return; }
  if (ev.type === 'notify') { onBellEvent(); return; }
  if (ev.type === 'chat' || ev.type === 'chat_read' || ev.type === 'typing') {
    chatEvent(ev);
    if (ev.type === 'chat') refreshCounts();
    return;
  }
  if (ev.type === 'portal' || ev.type === 'portal_task' || ev.type === 'projects') schedule();
}

// ---------- actions ----------
function requestDialog(kind = null, edit = null) {
  const s0 = settings();
  const opts = [['change', 'wrench', 'Change something', 'Something already done should work or look different'], ['new', 'spark', 'Something new', 'A feature, a page, a campaign: work that isn’t planned yet'], ['problem', 'alert', 'Report a problem', 'Something is broken or not working as it should']];
  const PH = { change: 'For example: wait 2 days before the second text', new: 'For example: a Spanish voicemail for missed calls', problem: 'For example: website leads stopped arriving on Monday' };
  const k0 = (edit && edit.kind) || kind || 'change';
  const m = openModal({
    title: edit ? 'Edit your request' : 'Ask the team', wide: true, submit: edit ? 'Save changes' : 'Send to the team',
    body: html`${!edit && s0.messages ? html`<a class="pask-q" href="#/messages?p=${pidNow()}" data-close>${ix('ask', 18)}<span><b>Just a question?</b> Ask in Messages, where the whole team sees it.</span>${icon('right')}</a>` : ''}
      ${s0.requests ? html`${edit ? '' : html`<fieldset class="pkinds"><legend class="f">What is it?</legend>${opts.map(([v, ic, t, d]) => html`<label class="pkind"><input type="radio" name="kind" value="${v}" ${k0 === v ? raw('checked') : ''}><span class="pk-ic">${ix(ic, 20)}</span><b>${t}</b><span>${d}</span></label>`)}</fieldset>`}
      <div class="field"><label class="f" for="rq-t">In a line, what do you need?</label><input id="rq-t" name="title" required maxlength="200" placeholder="${PH[k0]}" value="${edit ? edit.title : ''}"></div>
      <div class="field"><label class="f" for="rq-d">More detail <span class="muted">(optional)</span></label><textarea id="rq-d" name="detail" rows="3" maxlength="2000" placeholder="Where, who it’s for, an example. Anything that helps.">${edit ? edit.detail || '' : ''}</textarea></div>
      <div class="grid2">${edit ? '' : html`<div class="field"><label class="f" for="rq-f">A file or screenshot <span class="muted">(optional)</span></label><input id="rq-f" name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,.docx,.xlsx,.zip"></div>`}
        <div class="field"><label class="f" for="rq-u">How soon?</label><select id="rq-u" name="urgency">${Object.entries(SOON).map(([v, l]) => html`<option value="${v}" ${v === ((edit && edit.urgency) || 'month') ? raw('selected') : ''}>${l}</option>`)}</select></div></div>
      ${edit ? '' : html`<ol class="pnext"><li><b>The team sees it</b> and you see when they did</li><li><b>They reply</b>: an estimate if it needs one, then a task you can follow</li><li><b>Follow it</b> on the Requests tab</li></ol>`}` : ''}`,
    onSubmit: async (fd) => {
      const title = String(fd.get('title') || '').trim();
      if (!title) throw new Error('Say in a line what you need');
      if (edit) { await patch(`/api/portal/requests/${edit.id}`, { title, detail: fd.get('detail'), urgency: fd.get('urgency') }); toast('Saved'); schedule(); return; }
      const f = fd.get('file'), file = f && f.size ? f : null;
      if (file && file.size > 5 * 1024 * 1024) throw new Error('Files can be up to 5 MB');
      await post(`/api/portal/projects/${pidNow()}/requests`, { kind: fd.get('kind'), title, detail: fd.get('detail'), urgency: fd.get('urgency'), ...(file ? { file_base64: await fileBase64(file), file_type: typeOf(file), file_name: file.name } : {}) });
      toast('Sent. You can follow it on Requests.');
      if (parse().page === 'requests') schedule(); else go('requests');
    },
  });
  m.form.addEventListener('change', (e) => { if (e.target.name === 'kind') { const i = m.form.querySelector('#rq-t'); if (i) i.placeholder = PH[e.target.value]; } });
  if (!s0.requests) { const sb = m.form.querySelector('button[type=submit]'); if (sb) sb.remove(); }
}
const typeOf = (file) => file.type || (/\.docx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.xlsx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.csv$/i.test(file.name) ? 'text/csv' : '');
function callDialog() {
  openModal({
    title: 'Ask for a call', submit: 'Send', sub: `${P.cache.get(`lead:${pidNow()}`) ? first(P.cache.get(`lead:${pidNow()}`)) : 'The team'} books it and it shows up on Meetings.`,
    body: html`<div class="field"><label class="f" for="cl-t">What about, and when suits you?</label><textarea id="cl-t" name="text" rows="3" maxlength="500" required placeholder="The new pipeline stages. Any afternoon this week works."></textarea></div>`,
    onSubmit: async (fd) => { await post(`/api/portal/projects/${pidNow()}/call-request`, { text: fd.get('text') }); toast('Sent. The team will book a time.'); },
  });
}
async function notifyDialog() {
  let p = null, ps = 'unsupported';
  try { [p, ps] = await Promise.all([get('/api/portal/notify-prefs'), pushState()]); } catch (e) { toast(errMsg(e), true); return; }
  const state = { on: html`<span class="ppill work"><i></i>On for this device</span>`, off: html`<span class="ppill idle"><i></i>Off on this device</span>`, denied: html`<span class="ppill late"><i></i>Blocked in this browser</span>`, unsupported: html`<span class="ppill idle"><i></i>Not available in this browser</span>`, 'ios-install': html`<span class="ppill brass"><i></i>Add to home screen first</span>` }[ps];
  const m = openModal({
    title: 'Phone notifications', footer: false, sub: 'The same things as the bell, on your phone’s lock screen.',
    body: html`<div class="pnd-top">${state}${ps === 'on' ? html`<button type="button" class="pbtn sm" data-nd="test">Send a test</button><button type="button" class="pbtn sm" data-nd="off">Turn off here</button>` : ps === 'off' ? html`<button type="button" class="pbtn sm ink" data-nd="on">${ix('bell', 15)}Turn on for this device</button>` : ''}</div>
      ${ps === 'ios-install' ? html`<p class="pmuted">On an iPhone, add the portal to your home screen first: tap ${ix('share', 14)} Share, then <b>Add to Home Screen</b>. Open it from there and turn notifications on.</p>` : ps === 'denied' ? html`<p class="pmuted">Notifications are blocked for this site. Allow them in your browser’s settings, then come back here.</p>` : ''}
      <h3 class="pnd-h">Send me</h3><div class="pnd-l">${p.push.map((c) => html`<label class="pswr"><span><b>${c.label}</b></span><span class="switch"><input type="checkbox" data-npref="${c.key}" ${c.on ? raw('checked') : ''} aria-label="${c.label}"><span></span></span></label>`)}</div>
      <p class="pmuted">${p.devices ? `On ${plural(p.devices, 'device')}. ` : ''}Your bell in the portal always shows everything.</p>`,
  });
  m.form.addEventListener('change', async (e) => { const t = e.target.closest('[data-npref]'); if (!t) return; try { await put('/api/portal/notify-prefs', { push: { [t.dataset.npref]: t.checked } }); toast('Saved'); } catch (err) { toast(errMsg(err), true); } });
  m.form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-nd]'); if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.nd === 'on') { await enablePush(); toast('Phone notifications are on'); m.close(); notifyDialog(); }
      else if (b.dataset.nd === 'off') { await disablePush(); toast('Turned off on this device'); m.close(); notifyDialog(); }
      else { await post('/api/push/test'); toast('Sent. It should pop up in a moment.'); }
    } catch (err) { toast(errMsg(err), true); } finally { b.disabled = false; }
  });
}
function accountDialog() {
  const me = P.home.me;
  const m = openModal({
    title: me.name, sub: `${me.email} · ${P.home.client.name}`, footer: false,
    body: html`<div class="pacc">${me.title ? html`<p class="pmuted">${me.title}</p>` : ''}<p class="pmuted">${me.can_approve ? 'You can approve things for your company.' : 'Someone else at your company approves things; you can see and comment on them.'}</p>
      <div class="pacc-a">${preview() ? '' : html`<button type="button" class="btn" data-acc="notify">${ix('phone', 16)}Phone notifications</button>${installMode() !== 'installed' && installMode() !== 'no' ? html`<button type="button" class="btn" data-acc="install">${ix('down', 16)}Add to home screen</button>` : ''}<button type="button" class="btn" data-acc="pw">${ix('key', 16)}Change your password</button><button type="button" class="btn danger" data-acc="out">${icon('out')}Sign out</button>`}</div></div>`,
  });
  m.form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-acc]'); if (!b) return;
    m.close();
    if (b.dataset.acc === 'out') { try { await post('/api/auth/logout'); } catch { /* gone */ } stopPortal(); setToken(null); location.hash = ''; location.reload(); }
    else if (b.dataset.acc === 'notify') notifyDialog();
    else if (b.dataset.acc === 'install') installSheet(true);
    else passwordDialog();
  });
}
function passwordDialog() {
  openModal({
    title: 'Change your password', submit: 'Change password',
    body: html`<div class="field"><label class="f" for="pw0">Current password</label><input id="pw0" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label class="f" for="pw1">New password</label><input id="pw1" name="next" type="password" autocomplete="new-password" minlength="10" required><p class="hint">At least 10 characters.</p></div>`,
    onSubmit: async (fd) => { await post('/api/me/password', { current_password: fd.get('current'), new_password: fd.get('next') }); toast('Password changed. Other sign-ins were signed out.'); },
  });
}
// first visit on a phone: offer to add the portal to the home screen (once every two weeks at most)
function maybeInstall() {
  if (preview() || !isPhone() || P.installAsked) return;
  const mode = installMode();
  if (mode === 'installed' || mode === 'no') return;
  const last = Number(store.get('wh-install-asked') || 0);
  if (Date.now() - last < 14 * 86400000) return;
  P.installAsked = true;
  setTimeout(() => installSheet(false), 1800);
}
function installSheet(asked) {
  const mode = installMode();
  store.set('wh-install-asked', String(Date.now()));
  const old = document.querySelector('.pinst'); if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'pinst'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Add to your home screen');
  const why = [['bell', 'Get told when the team needs you'], ['chat', 'Reply to messages in a tap'], ['check2', 'Approve from your phone']];
  el.innerHTML = `<div class="pinst-s"><span class="pinst-grab" aria-hidden="true"></span><div class="pinst-h"><span class="pinst-ic">${HELM}</span><div><b>Add ${esc(clientShort())}’s portal to your home screen</b><span>Opens like an app. No app store.</span></div></div>
    <ul>${why.map(([i, t]) => `<li><span>${ICX[i] ? ix(i, 15) : icon(i)}</span>${t}</li>`).join('')}</ul>
    ${mode === 'ios' ? `<ol class="pinst-ios"><li>Tap ${ix('share', 15)} <b>Share</b> at the bottom of Safari</li><li>Choose <b>Add to Home Screen</b></li><li>Open it from your home screen, then turn on notifications in your account</li></ol><button type="button" class="pbtn" data-in="no">Got it</button>`
      : mode === 'prompt' ? `<div class="pinst-a"><button type="button" class="pbtn ink" data-in="yes">${icon('plus')}Add to home screen</button><button type="button" class="pbtn" data-in="no">Not now</button></div>`
        : `<p class="pmuted">${asked ? 'Your browser doesn’t offer this. In Chrome, open the menu and choose “Add to Home screen”.' : ''}</p><button type="button" class="pbtn" data-in="no">Close</button>`}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 260); };
  el.addEventListener('click', async (e) => {
    if (e.target === el) return close();
    const b = e.target.closest('[data-in]'); if (!b) return;
    if (b.dataset.in === 'yes') { const ok = await install(); close(); if (ok) toast('Added. Open it from your home screen.'); }
    else close();
  });
}
async function openFile(url, name) {
  const w = window.open('', '_blank');
  try {
    const u = P.urls.get(url) || await fileUrl(url);
    P.urls.set(url, u);
    if (w) w.location = u; else { const a = document.createElement('a'); a.href = u; a.download = name; a.click(); }
  } catch (e) { if (w) w.close(); toast(errMsg(e), true); }
}
// a comment pinned to the spot tapped on a picture
function pinAt(box, e) {
  const img = box.querySelector('img'); if (!img) return;
  const r = img.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10, y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
  if (x < 0 || x > 100 || y < 0 || y > 100) return;
  const old = box.querySelector('.pv-new'); if (old) old.remove();
  const f = document.createElement('form');
  f.className = 'pv-new'; f.style.left = `${x}%`; f.style.top = `${y}%`;
  f.innerHTML = `<span class="pv-pin">+</span><div class="pv-new-b"><textarea name="body" rows="2" maxlength="1000" placeholder="What should change here?" aria-label="Your comment" required></textarea><div><button type="button" class="pbtn sm" data-x>Cancel</button><button type="submit" class="pbtn sm ink">Comment</button></div></div>`;
  box.appendChild(f);
  f.querySelector('textarea').focus();
  f.addEventListener('click', (ev) => { ev.stopPropagation(); if (ev.target.closest('[data-x]')) f.remove(); });
  f.addEventListener('submit', async (ev) => { ev.preventDefault(); const b = f.querySelector('[type=submit]'); b.disabled = true; try { await post(`/api/portal/versions/${box.dataset.vid}/pins`, { x, y, body: f.body.value }); f.remove(); toast('Comment added. The team sees it on the picture.'); schedule(); } catch (err) { toast(errMsg(err), true); b.disabled = false; } });
}

function onClick(e) {
  const b = e.target.closest('[data-pa]');
  if (!b || !root.contains(b) && !document.getElementById('overlay').contains(b) && !b.closest('#pview')) return;
  const a = b.dataset.pa;
  if (a === 'q') return setQ(b.dataset.k, b.dataset.v);
  if (a === 'bell') return openBell();
  if (a === 'request') return requestDialog();
  if (a === 'call') return callDialog();
  if (a === 'account') return accountDialog();
  if (a === 'retry') return run({ navigated: true });
  if (a === 'open') return openFile(b.dataset.url, b.dataset.name);
  if (a === 'as-send') return sendDialog();
  if (a === 'copy') { navigator.clipboard.writeText(b.dataset.v).then(() => toast(`Copied ${b.dataset.v}`), () => toast('Your browser blocked copying', true)); return; }
  if (a === 'csv') return download(`/api/portal/projects/${pidNow()}/hours.csv?month=${b.dataset.month}`, `hours-${b.dataset.month}.csv`).catch((err) => toast(errMsg(err), true));
  if (a === 'pdf') return download(`/api/portal/projects/${pidNow()}/statement.pdf?month=${b.dataset.month}`, `statement-${b.dataset.month}.pdf`).catch((err) => toast(errMsg(err), true));
  if (a === 'ics') return download(`/api/portal/meetings/${b.dataset.id}/ics`, 'call.ics').catch((err) => toast(errMsg(err), true));
  if (a === 'thread') { P.gallery = false; return go('messages', b.dataset.id ? { t: b.dataset.id } : { with: b.dataset.with }); }
  if (a === 'hit') { const box = root.querySelector('[data-psr]'); if (box) box.hidden = true; const cur = P.chats.get(Number(b.dataset.t)); if (cur && Number(parse().q.get('t') || (P.data.threads[0] || {}).id) === Number(b.dataset.t)) { cur.goTo(Number(b.dataset.m)); return; } return go('messages', { t: b.dataset.t, m: b.dataset.m }); }
  if (a === 'back') return go('messages');
  if (a === 'gallery') { P.gallery = !P.gallery; return schedule(); }
  if (a === 'pin-at') { if (e.target.closest('.pv-new, .pv-pin')) return; return pinAt(b, e); }
  if (a === 'pin-ok') return post(`/api/portal/pins/${b.dataset.id}/resolve`).then(() => schedule()).catch((err) => toast(errMsg(err), true));
  if (a === 'rate-later') { store.set(`wh-rate-later-${b.dataset.id}`, '1'); return schedule(); }
  if (a === 'answer') {
    const yes = b.dataset.v === 'yes';
    return (async () => {
      if (!(await confirmBox({ title: yes ? 'Go ahead with this?' : 'Not now?', message: yes ? 'It becomes a task the team starts on. You can follow it on Tasks.' : 'The team won’t start it. You can ask again any time.', confirm: yes ? 'Go ahead' : 'Not now' }))) return;
      try { await post(`/api/portal/requests/${b.dataset.id}/answer`, { answer: b.dataset.v }); toast(yes ? 'Agreed. It’s a task now.' : 'Okay. The team has been told.'); schedule(); } catch (err) { toast(errMsg(err), true); }
    })();
  }
  if (a === 'ask-about') { const f = root.querySelector(`form[data-pform="rmsg"][data-id="${b.dataset.id}"] input`); if (f) { f.focus(); f.scrollIntoView({ block: 'center' }); } return; }
  if (a === 'req-edit') { const r = P.data && P.data.list && P.data.list.find((x) => x.id === Number(b.dataset.id)); if (r) requestDialog(null, r); return; }
  if (a === 'req-cancel') return (async () => { if (!(await confirmBox({ title: `Cancel “${b.dataset.title}”?`, message: 'The team won’t start it. It stays under Closed.', confirm: 'Cancel the request', cancel: 'Keep it', danger: true }))) return; try { await post(`/api/portal/requests/${b.dataset.id}/cancel`); toast('Cancelled'); schedule(); } catch (err) { toast(errMsg(err), true); } })();
  if (a === 'agenda-del') return del(`/api/portal/meetings/${b.dataset.id}/agenda/${b.dataset.i}`).then(() => schedule()).catch((err) => toast(errMsg(err), true));
  if (a === 'viewas') { setViewAs(b.dataset.id); try { sessionStorage.setItem('wh-viewas', b.dataset.id); } catch { /* fine */ } const ppl = P.home.people; P.home = null; P.pplKeep = ppl; P.cache.clear(); return run({ navigated: true }); }
  if (a === 'endview') { try { sessionStorage.removeItem('wh-viewas'); } catch { /* fine */ } setViewAs(null); window.close(); setTimeout(() => { location.href = '/'; }, 150); return; }
  if (a === 'start') {
    b.disabled = true;
    return post(`/api/chat/projects/${pidNow()}/direct`, { staff_id: Number(b.dataset.with) }).then((r) => go('messages', { t: r.id })).catch((err) => { b.disabled = false; toast(errMsg(err), true); });
  }
}
async function onSubmit(e) {
  const f = e.target.closest('form[data-pform]');
  if (!f || !root.contains(f)) return;
  e.preventDefault();
  const kind = f.dataset.pform, id = f.dataset.id, btns = f.querySelectorAll('button');
  btns.forEach((x) => { x.disabled = true; });
  try {
    if (kind === 'comment') {
      const body = f.body.value.trim(), file = f.file && f.file.files[0];
      if (!body && !file) return;
      if (file && file.size > 5 * 1024 * 1024) { toast('Files can be up to 5 MB', true); return; }
      await post(`/api/portal/tasks/${id}/comments`, { body, ...(file ? { file_base64: await fileBase64(file), file_type: typeOf(file), file_name: file.name } : {}) });
      f.body.value = ''; if (f.file) f.file.value = ''; const att = f.querySelector('[data-att]'); if (att) { att.hidden = true; att.innerHTML = ''; }
      await run();
      const th = root.querySelector('.pp-thread'); if (th) th.scrollTop = th.scrollHeight;
    } else if (kind === 'decide') {
      const d = e.submitter ? e.submitter.value : 'approved', note = f.note.value.trim();
      if (d === 'changes' && !note) { toast('Say what to change, so the team knows', true); f.note.focus(); return; }
      if (d === 'approved' && !(await confirmBox({ title: 'Approve this version?', message: 'The team goes ahead with it. This is kept in the approval’s history.', confirm: 'Approve' }))) return;
      await post(`/api/portal/approvals/${id}/decide`, { decision: d, note });
      toast(d === 'approved' ? 'Approved. The team has been told.' : 'Sent. The team will make the changes.');
      await run();
    } else if (kind === 'upload') {
      const file = f.file.files[0];
      if (!file) { toast('Choose a file first', true); return; }
      if (file.size > 5 * 1024 * 1024) { toast('Files can be up to 5 MB', true); return; }
      await post(`/api/portal/approvals/${id}/upload`, { file_base64: await fileBase64(file), file_type: typeOf(file), file_name: file.name, note: f.note.value });
      toast('Sent. The team has it.');
      await run();
    } else if (kind === 'rate') {
      const stars = Number((f.querySelector('input[name="stars"]:checked') || {}).value);
      if (!stars) { toast('Tap the stars to rate it', true); return; }
      await post(`/api/portal/milestones/${id}/rating`, { stars, note: f.note.value });
      toast('Thanks. The team has your answer.');
      await run();
    } else if (kind === 'agenda') {
      await post(`/api/portal/meetings/${id}/agenda`, { text: f.text.value });
      f.text.value = '';
      await run();
    } else if (kind === 'rmsg') {
      await post(`/api/portal/requests/${id}/messages`, { body: f.body.value });
      f.body.value = '';
      await run();
    }
  } catch (err) { toast(errMsg(err), true); }
  finally { btns.forEach((x) => { x.disabled = false; }); }
}
function onChange(e) {
  if (e.target.matches('[data-pproj]')) { go(parse().page, { p: e.target.value }); return; }
  if (e.target.matches('.pdrop input')) { const n = e.target.closest('.pdrop').querySelector('[data-fname]'); if (n) n.textContent = e.target.files[0] ? e.target.files[0].name : 'or drop it here'; }
  if (e.target.matches('.pp-clip input')) {
    const f = e.target.files[0], att = e.target.closest('form').querySelector('[data-att]');
    if (!att) return;
    att.hidden = !f;
    att.innerHTML = f ? `<span class="pp-chip">${icon('clip')}<b>${esc(f.name)}</b><span>${esc(kb(f.size))}</span><button type="button" class="pbtn icon sm" data-att-x aria-label="Remove the file">${ix('x', 13)}</button></span>` : '';
    if (f && /^image\//.test(f.type)) { const u = URL.createObjectURL(f); att.insertAdjacentHTML('afterbegin', `<img alt="" src="${u}" class="pp-thumb">`); }
  }
  if (e.target.matches('[data-hpref]')) put('/api/portal/notify-prefs', { [e.target.dataset.hpref]: e.target.checked }).then(() => toast('Saved')).catch((err) => toast(errMsg(err), true));
}
function onInput(e) {
  if (e.target.matches('[data-psearch]')) { clearTimeout(searchT); searchT = setTimeout(() => runSearch(e.target), 220); }
}
function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.matches('.pp-comp textarea')) { e.preventDefault(); e.target.form.requestSubmit(); }
  if (e.key === 'Escape' && e.target.matches('[data-psearch]')) { e.target.value = ''; const box = root.querySelector('[data-psr]'); if (box) box.hidden = true; }
}
function onRootClick(e) {
  const x = e.target.closest('[data-att-x]');
  if (x) { const f = x.closest('form'); f.file.value = ''; const att = f.querySelector('[data-att]'); att.hidden = true; att.innerHTML = ''; return; }
  if (!e.target.closest('.psearch')) { const box = root.querySelector('[data-psr]'); if (box) box.hidden = true; }
}
const onHash = () => {
  const k = `t${parse().page}`;
  for (const t of root.querySelectorAll('.ptabs a')) { if (t.dataset.k === k) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); }
  closeBell();
  run({ navigated: true });
};
const onVis = () => { if (!document.hidden) { schedule(); onBellEvent(); } };
// a tapped phone notification opens its page here
const onSWMessage = (e) => { if (e.data && e.data.type === 'open' && e.data.link) location.hash = e.data.link.replace(/^#/, ''); };

export function startPortal(app, { previewAs = null } = {}) {
  stopPortal();
  root = app;
  if (previewAs) setViewAs(previewAs);
  root.classList.add('portal-root');
  document.body.classList.add('portal');
  root.addEventListener('click', onClick);
  root.addEventListener('click', onRootClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onHash);
  document.addEventListener('visibilitychange', onVis);
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', onSWMessage);
  P.stop = startLive({ onEvent, onState: (s) => { if (s === 'live') { schedule(); chatReloadAll(); } } });
  P.poll = setInterval(() => { if (!document.hidden && !liveFresh()) schedule(); }, 6000);
  P.banPoll = setInterval(() => { if (!document.hidden) portalBanner(); }, 60000);
  portalBanner();
  P.unInstall = onInstallChange(() => { if (isPhone()) maybeInstall(); });
  if (!location.hash || location.hash === '#' || location.hash === '#/') history.replaceState(null, '', '#/overview');
  if (!getViewAs()) registerSW();
  run({ navigated: true }).then(() => {
    loadBell();
    // previewing: the people at this client, to switch between
    if (preview()) get('/api/portal/people').then((list) => { P.home.people = list; paintPreview(); schedule(); }).catch(() => {});
  });
  void isIOS;
}
export function stopPortal() {
  { const pv = document.getElementById('pview'); if (pv) pv.remove(); }
  if (P.stop) P.stop(); P.stop = null; clearInterval(P.poll); clearInterval(P.banPoll); { const sb = document.getElementById('sysban'); if (sb) sb.remove(); } if (P.unInstall) P.unInstall();
  closeBell();
  if (!root) return;
  root.removeEventListener('click', onClick);
  root.removeEventListener('click', onRootClick);
  root.removeEventListener('submit', onSubmit);
  root.removeEventListener('change', onChange);
  root.removeEventListener('input', onInput);
  root.removeEventListener('keydown', onKey);
  window.removeEventListener('hashchange', onHash);
  document.removeEventListener('visibilitychange', onVis);
  if (navigator.serviceWorker) navigator.serviceWorker.removeEventListener('message', onSWMessage);
  for (const u of P.urls.values()) URL.revokeObjectURL(u);
  P.urls.clear(); P.home = null; P.cache.clear(); P.chats.clear();
  document.body.classList.remove('portal');
}
