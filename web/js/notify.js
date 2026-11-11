// The bell: live notifications in the top bar, a list to read them, and browser pop-ups when the
// dashboard is in the background. The server pushes a "notify" event; we then fetch only what is new.
import { get, post } from './api.js';
import { esc, icon, relTime, initials, avColor } from './util.js';
import { S, actions, toast, trap } from './ui.js';
import { openTask } from './pages/tasks.js';
import { lock, unlock } from './lock.js';
import { pushState, enablePush } from './push.js';

let items = [], unread = 0, lastId = 0, loaded = false, panel = null, busy = false;
const shownKey = () => `wh-notif-shown-${S.me && S.me.id}`;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* fine */ } } };

const KIND_ICON = {
  task_assigned: 'tasks', task_status: 'tasks', task_review: 'check', task_approved: 'check', task_sent_back: 'repeat',
  task_comment: 'msg', task_file: 'clip', task_due: 'cal', task_due_changed: 'cal', project_added: 'folder', project_lead: 'folder',
  timeoff_request: 'sun', timeoff_decision: 'sun', no_signal: 'flag', shift_report: 'file',
};
const tone = (k) => (k === 'task_sent_back' || k === 'no_signal' ? 'bad' : k === 'task_approved' ? 'good' : k === 'task_due' ? 'warn' : '');

export const browserPopups = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

export function resetNotify() { items = []; unread = 0; lastId = 0; loaded = false; closePanel(); }

export async function initNotify() {
  try {
    const r = await get('/api/notifications?limit=30');
    items = r.items; unread = r.unread; lastId = r.last_id; loaded = true;
    // anything that arrived while the dashboard was closed is in the list, not popped up again
    if (Number(store.get(shownKey()) || 0) < lastId) store.set(shownKey(), String(lastId));
    paint();
  } catch { /* the bell is optional */ }
}

// Called on every live "notify" event (new notifications, or something marked read elsewhere).
export async function onNotify() {
  if (!loaded || busy) return;
  busy = true;
  try {
    const r = await get(`/api/notifications?after=${lastId}&limit=50`);
    unread = r.unread;
    if (r.items.length) {
      lastId = Math.max(lastId, ...r.items.map((n) => n.id));
      items = [...r.items.reverse(), ...items].slice(0, 100);
      pop(r.items);
    } else if (r.last_id === lastId) {
      // read state changed (another tab or the desktop): refresh what we show
      const all = await get('/api/notifications?limit=30');
      items = all.items; unread = all.unread;
    }
    paint();
  } catch { /* try again on the next event */ } finally { busy = false; }
}

// Every open tab hears the same live event. Claiming what to show happens one tab at a time (a browser
// lock where there is one), so two tabs never both pop the same thing up.
async function claim(fresh) {
  const take = () => {
    const shown = Number(store.get(shownKey()) || 0);
    const list = fresh.filter((n) => n.id > shown).sort((a, b) => a.id - b.id);
    if (list.length) store.set(shownKey(), String(list[list.length - 1].id));
    return list;
  };
  try { if (navigator.locks) return await navigator.locks.request(`wh-pop-${S.me && S.me.id}`, take); } catch { /* fall through */ }
  return take();
}

async function pop(fresh) {
  const list = await claim(fresh);
  if (!list.length) return;
  const away = document.hidden || !document.hasFocus();
  // a browser signed up for push gets these from the service worker (with the person's choices applied), so
  // the page doesn't show them a second time
  if (away && browserPopups() === 'granted' && (await pushState().catch(() => 'off')) === 'on') return;
  if (away && browserPopups() === 'granted') {
    const show = list.length > 3 ? [{ title: `${list.length} new notifications`, body: list.slice(-3).map((n) => n.title).join('\n'), link: '#/' }] : list;
    for (const n of show) {
      try {
        const b = new Notification(n.title, { body: n.body || '', tag: `wh-${n.id || 'many'}`, icon: (document.querySelector('link[rel="icon"]') || {}).href });
        b.onclick = () => { window.focus(); if (n.id) markRead([n.id]); if (n.link) location.hash = n.link.replace(/^#/, ''); b.close(); };
      } catch { /* some browsers only allow this from a service worker */ }
    }
  } else if (!away) {
    for (const n of list.slice(-2)) toast(n.title);
  }
}

async function markRead(ids) {
  try { const r = await post('/api/notifications/read', ids === 'all' ? { all: true } : { ids }); unread = r.unread; } catch { return; }
  for (const n of items) if (ids === 'all' || ids.includes(n.id)) n.read = true;
  paint();
}

// ---------- drawing ----------
function paint() {
  const b = document.getElementById('bell');
  if (b) {
    const badge = b.querySelector('.bdg');
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = !unread;
    b.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    b.classList.toggle('has', !!unread);
  }
  if (panel) panel.querySelector('.np-list').innerHTML = listHtml();
  if (panel) panel.querySelector('[data-np="all"]').disabled = !unread;
  if (panel) panel.querySelector('.np-ask').innerHTML = askHtml();
}

function itemHtml(n) {
  const ic = KIND_ICON[n.kind] || 'bell';
  const who = n.actor ? `<span class="avatar sm" style="background:${avColor(n.actor.id)}">${esc(initials(n.actor.name))}</span>` : `<span class="np-ic ${tone(n.kind)}">${icon(ic)}</span>`;
  return `<li><a class="np-it${n.read ? '' : ' new'}" href="${esc(n.link || '#/')}" data-nid="${n.id}">
    ${who}<span class="np-tx"><b>${esc(n.title)}</b>${n.body ? `<span class="np-b">${esc(n.body)}</span>` : ''}<span class="np-t">${n.actor ? `<span class="np-k ${tone(n.kind)}">${icon(ic)}</span>` : ''}${esc(relTime(n.created_at))}</span></span>
    ${n.read ? '' : '<i class="np-dot" aria-label="Unread"></i>'}</a></li>`;
}
function listHtml() {
  if (!items.length) return `<li class="np-empty">${icon('bell')}<b>Nothing yet</b><span>Tasks, reviews, comments, deadlines and time off show up here.</span></li>`;
  return items.map(itemHtml).join('');
}
function askHtml() {
  const p = browserPopups();
  if (p === 'default') return `<div class="np-tip"><span>Get a pop-up when something comes in while this tab is in the background.</span><button class="btn sm" data-np="allow">Turn on</button></div>`;
  return '';
}

function openPanel() {
  if (panel) return closePanel();
  const b = document.getElementById('bell');
  panel = document.createElement('div');
  panel.className = 'npanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Notifications');
  panel.innerHTML = `<header><h2>Notifications</h2><button class="linkbtn" data-np="all">Mark all as read</button></header>
    <div class="np-ask"></div><ul class="np-list"></ul>
    <footer><a href="#/profile" data-np="prefs">Notification settings</a><button class="linkbtn" data-np="phone" hidden>Get these on your phone</button></footer>`;
  document.body.appendChild(panel);
  const r = b.getBoundingClientRect();
  panel.style.top = `${r.bottom + 8}px`;
  const vw = document.documentElement.clientWidth, w = panel.offsetWidth;
  panel.style.left = `${Math.max(12, Math.min(vw - w - 12, r.right + 4 - w))}px`;
  b.setAttribute('aria-expanded', 'true');
  lock('notify');
  paint();
  panel.addEventListener('click', onPanelClick);
  pushState().then((st) => { const b = panel && panel.querySelector('[data-np="phone"]'); if (b && st === 'off') b.hidden = false; }).catch(() => {});
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  const first = panel.querySelector('.np-it, button'); if (first) first.focus({ preventScroll: true });
}
function closePanel() {
  if (!panel) return;
  panel.remove(); panel = null;
  unlock('notify');
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', onKey, true);
  const b = document.getElementById('bell'); if (b) b.setAttribute('aria-expanded', 'false');
}
const outside = (e) => { if (panel && !panel.contains(e.target) && !e.target.closest('#bell')) closePanel(); };
function onKey(e) {
  if (!panel) return;
  if (e.key === 'Escape') { e.preventDefault(); closePanel(); const b = document.getElementById('bell'); if (b) b.focus(); }
  else trap(panel, e);
}
async function onPanelClick(e) {
  const a = e.target.closest('[data-np]');
  if (a) {
    if (a.dataset.np === 'all') { e.preventDefault(); await markRead('all'); }
    if (a.dataset.np === 'allow') { e.preventDefault(); await askBrowser(); paint(); }
    if (a.dataset.np === 'prefs') closePanel();
    if (a.dataset.np === 'phone') { e.preventDefault(); try { await enablePush(); toast('Notifications are on for this device'); a.hidden = true; } catch (err) { toast(err.message, true); } }
    return;
  }
  const it = e.target.closest('[data-nid]');
  if (it) {
    const id = Number(it.dataset.nid);
    const n = items.find((x) => x.id === id);
    if (n && !n.read) markRead([id]);
    closePanel();
    // the same link as the page already open: hashchange will not fire, so open the task here
    const m = /[?&]task=(\d+)/.exec(it.getAttribute('href') || '');
    if (m && location.hash === it.getAttribute('href')) { e.preventDefault(); openTask(Number(m[1])).catch(() => {}); }
  }
}

export async function askBrowser() {
  if (browserPopups() !== 'default') return browserPopups();
  try { const p = await Notification.requestPermission(); if (p === 'granted') toast('Pop-ups are on for this browser'); return p; } catch { return browserPopups(); }
}

export const bellHtml = () => `<button class="btn sm bell" id="bell" data-act="bell" aria-haspopup="dialog" aria-expanded="false" aria-label="Notifications">${icon('bell')}<span class="bdg" hidden>0</span></button>`;
actions.bell = () => openPanel();
