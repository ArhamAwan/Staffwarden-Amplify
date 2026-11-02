'use strict';
// night glass: a Mac window is see-through (vibrancy); Windows and Linux get a solid night background
document.documentElement.classList.add(/Mac/.test(navigator.platform) ? 'mac' : 'solid');
// The menu bar / tray panel: the shift dial, today at a glance and the timer controls. Uses the same safe
// bridge as the main window (window.tracker), so it can do nothing the main window cannot.
const API = window.tracker;
const $ = (id) => document.getElementById(id);
const REASONS = [{ id: 'break', label: 'Short break' }, { id: 'dinner', label: 'Dinner' }, { id: 'lunch', label: 'Lunch' }, { id: 'prayer', label: 'Prayer' }, { id: 'personal', label: 'Personal' }, { id: 'other', label: 'Other' }];
let st = null, info = null, tasks = [], projects = [], view = 'main', err = '', key = '', chosen = '';
try { chosen = localStorage.getItem('wh_panel_task') || ''; } catch { /* fine */ }
const dial = window.WhDial.create($('phdial'), { size: 92, stroke: 22, ticks: false, label: 'Your shift so far' });

const pad = (n) => String(n).padStart(2, '0');
const hms = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(pad).join(':');
const dur = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${pad(m)}m` : `${m}m`; };
const reasons = () => (info && info.reasons) || REASONS;
const reasonLabel = (id) => (reasons().find((r) => r.id === id) || { label: id === 'away' ? 'Computer asleep' : 'Break' }).label;
const ICON = {
  cup: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5v2M11 3.5v2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>', play: '<path d="M8 5.5v13l10.5-6.5z"/>',
};
const ico = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('width', 16); s.setAttribute('height', 16); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[name]; return s; };
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}

function taskName(id) {
  const t = tasks.find((x) => String(x.id) === String(id));
  if (t) return { key: t.key, title: t.title || t.name, project: (projects.find((p) => p.id === t.project_id) || {}).name || t.project || '' };
  for (const p of projects) { const pt = (p.tasks || []).find((x) => String(x.id) === String(id)); if (pt) return { key: pt.key, title: pt.name, project: p.name }; }
  return id ? { key: null, title: 'Current task', project: '' } : null;
}

async function loadAll() {
  info = await API.panelInfo();
  if (info && info.loggedIn && info.consented) {
    const [t, p] = await Promise.all([API.myTasks(), API.projects()]);
    tasks = Array.isArray(t) ? t : []; projects = Array.isArray(p) ? p : [];
  }
  key = ''; render();
}

function shiftLeft() {
  const s = st && st.shift; if (!s) return info && info.name ? info.name : '';
  const now = Date.now();
  if (now < s.startMs) return `Shift starts in ${dur((s.startMs - now) / 1000)}`;
  if (now < s.endMs) return `${dur((s.endMs - now) / 1000)} left in shift`;
  return `Shift ended ${s.endText}`;
}

function header() {
  const mode = !st ? 'off' : st.running ? (st.idle ? 'idle' : 'run') : st.paused ? 'brk' : 'off';
  $('ph').dataset.mode = mode;
  $('pill').className = 'pill ' + (mode === 'run' ? 'working' : mode === 'brk' ? 'paused' : '');
  $('pilltxt').textContent = mode === 'run' ? 'Tracking' : mode === 'idle' ? 'Idle' : mode === 'brk' ? 'On a break' : 'Not tracking';
  $('today').textContent = hms((st && st.todayWorkedSecs) || 0);
  $('who').textContent = info && !info.loggedIn ? 'Not signed in' : shiftLeft();
  dial.update(st || {});
}

function btn(label, cls, icon, onclick) { return el('button', { class: 'hb ' + cls, onclick }, icon ? ico(icon) : null, label); }

function controls() {
  const box = el('div', { class: 'ctl' });
  if (err) box.append(el('div', { class: 'note err in' }, err));
  if (view === 'reasons') {
    box.append(el('div', { class: 'sheet in' }, el('b', {}, 'What is the break for?'),
      el('div', { class: 'reasons' }, reasons().map((r, i) => el('button', { class: 'rchip', style: `animation-delay:${i * 40}ms`, onclick: async () => { view = 'main'; const x = await API.pause(r.id); err = x && x.error ? x.error : ''; key = ''; render(); } }, r.label))),
      el('button', { class: 'lnk brass', onclick: () => { view = 'main'; key = ''; render(); } }, 'Keep working')));
    return box;
  }
  if (view === 'stop') {
    box.append(el('div', { class: 'sheet in' }, el('b', {}, 'Stop for today?'), el('span', {}, 'Your time so far is saved. Screenshots and activity stop.'),
      el('div', { class: 'acts' },
        btn('Keep working', 'ghost', null, () => { view = 'main'; key = ''; render(); }),
        btn('Stop', 'solid-danger', null, async () => { view = 'main'; const x = await API.stop(); err = x && x.error ? x.error : ''; key = ''; render(); }))));
    return box;
  }
  if (st && st.active) {
    box.append(el('div', { class: 'acts in' },
      st.paused ? btn('Back to work', 'go', 'play', async () => { const x = await API.resume(); err = x && x.error ? x.error : ''; key = ''; render(); })
        : btn('Break', 'ghost', 'cup', () => { view = 'reasons'; key = ''; render(); }),
      btn('Stop', 'danger', 'stop', () => { view = 'stop'; key = ''; render(); })));
    return box;
  }
  const open = tasks.filter((t) => t.status !== 'in_review' && t.status !== 'done');
  if (chosen && !open.some((t) => String(t.id) === chosen)) chosen = '';
  if (open.length) {
    box.append(el('select', { 'aria-label': 'Task', class: 'tsel', onchange: (e) => { chosen = e.target.value; try { localStorage.setItem('wh_panel_task', chosen); } catch { /* fine */ } } },
      el('option', { value: '' }, 'No task'), open.map((t) => el('option', { value: t.id, selected: String(t.id) === chosen }, (t.key ? t.key + '  ' : '') + (t.title || t.name)))));
  }
  box.append(el('div', { class: 'acts in' }, btn('Start working', 'go', 'play', start)));
  return box;
}

async function start() {
  err = '';
  const t = tasks.find((x) => String(x.id) === chosen);
  const r = await API.start(t ? t.project_id || null : null, t ? Number(t.id) : null);
  if (r && r.error) {
    if (r.code === 'screen-permission') { API.openMain(); return; }
    err = r.error;
  }
  key = ''; render();
}

function render() {
  if (!info) return;
  header();
  const body = $('body');
  if (!info.loggedIn || !info.consented) {
    body.replaceChildren(el('div', { class: 'empty' }, el('p', {}, info.loggedIn ? 'Read and accept how Staffwarden works to start tracking.' : 'Sign in to Staffwarden to start tracking your time.'),
      el('button', { class: 'hb go', style: 'width:100%', onclick: () => API.openMain() }, info.loggedIn ? 'Open Staffwarden' : 'Sign in')));
    return size();
  }
  if (!st) return;
  const k = `${st.mode}|${st.idle ? 1 : 0}|${st.pause ? st.pause.reason : ''}|${st.taskId || ''}|${view}|${err}|${st.shiftOver ? 1 : 0}|${info.update || ''}|${tasks.length}|${st.otherDevice ? 1 : 0}`;
  if (k !== key) {
    key = k;
    const task = st.active ? taskName(st.taskId) : null;
    let note = null;
    if (st.paused && st.pause) note = el('div', { class: 'note brk in' }, el('span', {}, `${st.pause.auto ? 'Paused itself · ' : ''}${reasonLabel(st.pause.reason)} · not counted`), el('b', { class: 'num breathe', id: 'pausefor' }, hms(st.pause.secs)));
    else if (st.running && st.idle) note = el('div', { class: 'note idle in' }, 'No keyboard or mouse for a while: the timer runs, this time is marked idle and no screenshots are taken.');
    else if (st.running && st.shiftOver) note = el('div', { class: 'note late in' }, `Your shift ended at ${st.shiftEnd}. Finished for the day? Stop your timer.`);
    else if (st.running && st.otherDevice) note = el('div', { class: 'note soft in' }, 'Working on another device: this computer stays awake while the timer is on.');
    else if (!st.active) note = el('div', { class: 'note soft in' }, info.shotsPer10 === 0 ? 'Nothing is tracked until you press Start. Screenshots are off for you.' : 'Nothing is tracked until you press Start.');
    body.replaceChildren(
      el('div', { class: 'hx' },
        task ? el('button', { class: 'taskchip', title: 'Change the task in the Staffwarden window', onclick: () => API.openMain() }, task.key ? el('span', { class: 'tkey' }, task.key) : null, el('b', {}, task.title)) : null,
        note, controls()),
      el('div', { class: 'stats' },
        el('div', {}, el('b', { class: 'num', id: 'brk' }, dur(st.todayBreakSecs || 0)), el('span', {}, st.todayBreakCount ? `Breaks (${st.todayBreakCount})` : 'Breaks')),
        el('div', {}, el('b', { class: 'num', id: 'shots' }, String(st.todayShots || 0)), el('span', {}, 'Screenshots')),
        el('div', {}, el('b', { class: 'num', id: 'act' }, st.running && st.activityPct != null ? `${st.activityPct}%` : '–'), el('span', {}, 'Activity'))),
      info.update ? el('div', { class: 'upd' }, el('span', {}, `Staffwarden ${info.update} is ready`), el('button', { class: 'lnk', onclick: () => API.openMain() }, 'Update')) : '');
    return size();
  }
  // every second: only the numbers change
  if ($('pausefor') && st.pause) $('pausefor').textContent = hms(st.pause.secs);
  $('brk').textContent = dur(st.todayBreakSecs || 0);
  $('shots').textContent = String(st.todayShots || 0);
  $('act').textContent = st.running && st.activityPct != null ? `${st.activityPct}%` : '–';
}

// the window fits its content
function size() { requestAnimationFrame(() => API.panelSize(Math.ceil($('card').getBoundingClientRect().height) + 2)); }

$('open').addEventListener('click', () => API.openMain());
$('dash').addEventListener('click', () => API.openDashboard());
$('quit').addEventListener('click', () => API.quitApp());
$('chk').addEventListener('click', async () => {
  const b = $('chk'); b.disabled = true; b.textContent = 'Checking…';
  const r = await API.checkUpdate();
  b.disabled = false;
  b.textContent = !r || r.answer === 'offline' ? 'Could not check' : r.answer === 'available' ? `${r.latest} available` : r.answer === 'unsupported' ? 'Installed app only' : 'Up to date';
  if (r && r.answer === 'available') { info = await API.panelInfo(); key = ''; render(); }
  setTimeout(() => { b.textContent = 'Check for updates'; }, 4000);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (view !== 'main') { view = 'main'; key = ''; render(); } else window.close(); } });
API.onStatus((s) => { st = s; render(); });
API.onPanelOpened(() => { view = 'main'; err = ''; loadAll(); });
API.onTasksChanged(() => loadAll());
API.state().then((s) => { if (s && s.status) st = s.status; loadAll(); });
