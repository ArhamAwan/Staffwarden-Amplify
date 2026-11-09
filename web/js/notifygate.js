// Notifications are required: until this browser shows Staffwarden's pop-ups, a screen asks for them and
// the app waits behind it. Browsers only let a site ask once, so when someone has blocked them the screen
// shows exactly where to switch them back on, and notices the moment they do. Where a browser can't show
// them at all (an iPhone outside the home-screen app, a plain http address) it says so and lets them in.
import { S, toast } from './ui.js';
import { esc, owl } from './util.js';
import { pushState, enablePush } from './push.js';

let gate = null, watching = false;

const isDesktopApp = () => /Electron|Staffwarden/i.test(navigator.userAgent);
const browserName = () => { const u = navigator.userAgent; return /edg\//i.test(u) ? 'edge' : /firefox|fxios/i.test(u) ? 'firefox' : /chrome|crios|chromium/i.test(u) ? 'chrome' : /safari/i.test(u) ? 'safari' : 'other'; };

// what this browser needs: 'ok', 'ask', 'blocked', 'subscribe' (allowed, but this browser isn't signed up), 'ios', 'cant'
async function need() {
  const st = await pushState().catch(() => 'unsupported');
  if (st === 'on') return 'ok';
  if (st === 'ios-install') return 'ios';
  if (st === 'unsupported') return 'cant';
  if (st === 'denied') return 'blocked';
  return typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'subscribe' : 'ask';
}

const WHY = () => {
  const role = S.me && S.me.role;
  if (role === 'owner') return ['Late starts and timers that go silent', 'Time-off and missing-time requests', 'Client messages waiting on the team', 'Payroll, expenses and advances'];
  if (role === 'manager') return ['Late starts and timers that go silent', 'Tasks waiting for your review', 'Requests from your team', 'Messages and announcements'];
  return ['Messages and @mentions', 'Announcements from the owner', '“Still there?” when you’ve gone idle', 'Tasks, reviews and time off'];
};

const STEPS = {
  chrome: ['Click the <b>site settings icon</b> at the left of the address bar, next to <b>' + location.hostname + '</b>.', 'Turn <b>Notifications</b> on (or choose <b>Allow</b>).', 'Come back here. This screen closes by itself.'],
  edge: ['Click the <b>lock icon</b> at the left of the address bar.', 'Under <b>Permissions for this site</b>, set <b>Notifications</b> to <b>Allow</b>.', 'Come back here. This screen closes by itself.'],
  firefox: ['Click the <b>crossed-out bell</b> at the left of the address bar.', 'Next to <b>Send notifications</b>, click the <b>×</b> so it’s no longer blocked, then press <b>Check again</b>.', 'Choose <b>Allow</b> when Firefox asks.'],
  safari: ['In the menu bar choose <b>Safari › Settings › Websites › Notifications</b>.', 'Find <b>' + location.hostname + '</b> and set it to <b>Allow</b>.', 'Come back here and press <b>Check again</b>.'],
  other: ['Open this site’s settings from the icon at the left of the address bar.', 'Set <b>Notifications</b> to <b>Allow</b>.', 'Come back here and press <b>Check again</b>.'],
};

function body(state) {
  const first = esc(String((S.me && S.me.name) || '').split(' ')[0]);
  const list = `<ul class="ng-why">${WHY().map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
  if (state === 'blocked') {
    const steps = STEPS[browserName()];
    return `<h2>Notifications are blocked</h2><p>This browser was told not to show Staffwarden’s notifications. Switch them back on to carry on:</p>
      <ol class="ng-steps">${steps.map((s) => `<li><span>${s}</span></li>`).join('')}</ol>
      <div class="ng-a"><button type="button" class="ng-go" data-ng="check">Check again</button></div>`;
  }
  if (state === 'ios') {
    return `<h2>Add Staffwarden to your home screen</h2><p>On an iPhone, notifications only work from the home-screen app. Tap <b>Share</b>, then <b>Add to Home Screen</b>, open it from there and turn them on.</p>
      <div class="ng-a"><button type="button" class="ng-go" data-ng="later">Continue in the browser</button></div>`;
  }
  if (state === 'cant') {
    return `<h2>This browser can’t show notifications</h2><p>Open Staffwarden in Chrome, Edge, Firefox or Safari on your computer to get them. You can carry on here meanwhile.</p>
      <div class="ng-a"><button type="button" class="ng-go" data-ng="later">Continue</button></div>`;
  }
  return `<h2>${first ? `${first}, turn` : 'Turn'} on notifications</h2><p>Staffwarden needs to reach you when something needs you, even when this tab is in the background:</p>${list}
    <div class="ng-a"><button type="button" class="ng-go" data-ng="on">Turn on notifications</button></div>
    <p class="ng-small">Your browser will ask. Choose <b>Allow</b>. You choose which things notify you in your Profile.</p>`;
}

function paint(state) {
  if (!gate) {
    gate = document.createElement('div');
    gate.className = 'ngate';
    gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true'); gate.setAttribute('aria-labelledby', 'ng-h');
    gate.addEventListener('click', onClick);
    document.body.appendChild(gate);
    document.documentElement.classList.add('ng-on');
  }
  gate.dataset.state = state;
  gate.innerHTML = `<div class="ng-card"><div class="ng-owl" aria-hidden="true">${owl('watch')}<span class="ng-bell"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg></span></div>${body(state).replace('<h2>', '<h2 id="ng-h">')}</div>`;
  const b = gate.querySelector('.ng-go'); if (b) b.focus();
}
function close() {
  if (!gate) return;
  gate.classList.add('out');
  const g = gate; gate = null;
  setTimeout(() => g.remove(), 220);
  document.documentElement.classList.remove('ng-on');
}

async function onClick(e) {
  const b = e.target.closest('[data-ng]'); if (!b) return;
  const what = b.dataset.ng;
  if (what === 'later') { try { sessionStorage.setItem('sw-ng-later', '1'); } catch { /* private */ } close(); return; }
  b.disabled = true; const label = b.textContent; b.textContent = what === 'on' ? 'Waiting for your browser…' : 'Checking…';
  try {
    if (what === 'on') { await enablePush(); toast('Notifications are on for this browser'); close(); return; }
    await checkNow(true);
  } catch (err) {
    await checkNow(false);
    if (gate && gate.dataset.state !== 'blocked') toast(err.message || 'Couldn’t turn notifications on', true);
  } finally { if (b.isConnected) { b.disabled = false; b.textContent = label; } }
}

// look again; when the browser now allows them, sign this browser up quietly and let them in
async function checkNow(saySo) {
  const st = await need();
  if (st === 'ok') { close(); return; }
  if (st === 'subscribe') {
    // the browser allows them; signing up for pushes can still fail (a browser without a push service, a
    // blocked network). Pop-ups then still come while the tab is open, so they're let in either way.
    try { await enablePush(); if (saySo) toast('Notifications are on for this browser'); } catch (e) { console.warn('push sign-up failed', e && e.message); }
    close(); return;
  }
  if ((st === 'ios' || st === 'cant') && sessionStorage.getItem('sw-ng-later')) { close(); return; }
  paint(st);
}

export async function requireNotifications() {
  if (!S.me || S.me.kind === 'client' || S.me.preview || isDesktopApp()) return;
  await checkNow(false);
  if (watching) return;
  watching = true;
  // they switch notifications on in the browser's settings: notice straight away
  try {
    const p = await navigator.permissions.query({ name: 'notifications' });
    p.onchange = () => { if (S.me) checkNow(true); };
  } catch { /* older browsers: the visibility check below covers it */ }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me) checkNow(false); });
}

export function resetGate() { close(); }
