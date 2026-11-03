import { html, raw, esc, icon, hhmmText, hoursText, tzLabel, plural, tzPlace, browserZone, zoneOffset, zoneName, owl } from '../util.js';
import { get, post, put, del } from '../api.js';
import { pushState, enablePush, isPhone as onPhone } from '../push.js';
import { browserPopups, askBrowser } from '../notify.js';
import { S, actions, toast, errMsg, kpis, openModal } from '../ui.js';
import { UPD, updList } from './hr.js';
import { changesPanel, agreedPanel } from './explain.js';

const DL = [['windows', 'Windows'], ['mac-arm', 'Mac with Apple chip (M1 and later)'], ['mac-intel', 'Mac with Intel chip']];
function dlLinks(list) {
  const opts = DL.map(([k, n]) => [list.find((d) => d.kind === k), n]).filter(([d]) => d);
  if (!opts.length) return html`<div class="dl-none"><b>No installers on the server yet</b><span>Ask your manager for the Staffwarden desktop app. You need it to track time.</span></div>`;
  return html`<ul style="margin:0">${opts.map(([d, n]) => html`<li><a href="/downloads/${encodeURIComponent(d.file)}" download>${n}</a> <span>${Math.round(d.size / 1048576)} MB</span></li>`)}</ul>`;
}

// your HR details: what HR holds about you. You can change them only when HR asks, and only what they ask for.
function detailsPanel(hr) {
  if (!hr) return '';
  const r = hr.record, q = hr.update_request;
  const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const v = (x) => x || html`<span class="muted">Not given</span>`;
  return html`<section class="panel det${q ? ' asked' : ''}" id="details"><header><h2>Your details</h2><span class="muted small">What HR has on record</span></header><div class="body">
    ${q ? html`<div class="det-ask"><div><b>${q.by || 'HR'} asked you to update your ${updList(q.fields)}</b>${q.note ? html`<span>“${q.note}”</span>` : ''}</div><button type="button" class="btn primary" data-act="det-upd">Update your details</button></div>` : ''}
    <dl class="kv two"><dt>Name</dt><dd>${hr.name}</dd><dt>Date of birth</dt><dd>${v(r.dob && fmtDay(r.dob))}</dd><dt>Phone</dt><dd>${v(r.phone)}</dd><dt>CNIC</dt><dd>${v(r.cnic)}</dd>
      <dt>Address</dt><dd>${v(r.address)}</dd><dt>Emergency contact</dt><dd>${v(r.emergency_name && `${r.emergency_name}${r.emergency_phone ? ' · ' + r.emergency_phone : ''}`)}</dd>
      <dt>Bank</dt><dd>${v(r.bank_name && `${r.bank_name}${r.iban ? ' · ' + r.iban : ''}`)}</dd></dl>
    ${q ? '' : html`<p class="hint mt">Something wrong or out of date? Tell HR. They can send you a request to update it here.</p>`}</div></section>`;
}
let detHr = null;
actions['det-upd'] = () => {
  const hr = detHr; if (!hr || !hr.update_request) return;
  const r = hr.record, f = new Set(hr.update_request.fields);
  const fld = (id, label, name, val, attrs = '') => html`<div class="field"><label class="f" for="${id}">${label}</label><input id="${id}" name="${name}" value="${val || ''}" ${raw(attrs)}></div>`;
  openModal({
    title: 'Update your details', submit: 'Send to HR', sub: `Only what HR asked for. HR is told when you send it.${hr.update_request.note ? ` They said: “${hr.update_request.note}”` : ''}`,
    body: html`${f.has('name') ? fld('dn', 'Full name', 'name', hr.name, 'maxlength="100" required autocomplete="name"') : ''}
      ${f.has('dob') ? fld('dd', 'Date of birth', 'dob', r.dob, 'type="date" required') : ''}
      ${f.has('phone') ? fld('dp', 'Phone', 'phone', r.phone, 'maxlength="40" inputmode="tel" placeholder="0301 2345678"') : ''}
      ${f.has('cnic') ? fld('dc', 'CNIC', 'cnic', '', 'maxlength="15" inputmode="numeric" placeholder="61101-1234567-1" autocomplete="off"') : ''}
      ${f.has('address') ? fld('da', 'Address', 'address', r.address, 'maxlength="300"') : ''}
      ${f.has('emergency') ? html`<div class="grid2">${fld('den', 'Emergency contact name', 'emergency_name', r.emergency_name, 'maxlength="100"')}${fld('dep', 'Their phone', 'emergency_phone', r.emergency_phone, 'maxlength="40" inputmode="tel"')}</div>` : ''}
      ${f.has('bank') ? html`<div class="grid2">${fld('db', 'Bank', 'bank_name', r.bank_name, 'maxlength="80" placeholder="Meezan Bank"')}${fld('dt', 'Account title', 'account_title', r.account_title, 'maxlength="100"')}</div>
        ${fld('di', 'IBAN', 'iban', '', 'maxlength="40" placeholder="PK36 MEZN 0000 0011 2233 4455" autocomplete="off"')}<p class="hint">Your full IBAN, starting with PK. Only HR and the owner see it in full.</p>` : ''}`,
    onSubmit: async (fd) => {
      const b = {};
      for (const [k, val] of fd.entries()) b[k] = String(val).trim() === '' ? null : String(val).trim();
      if (f.has('bank') && !b.iban) throw new Error('Type your IBAN');
      if (f.has('cnic') && !b.cnic) throw new Error('Type your CNIC');
      await put('/api/me/details', b); toast('Sent. HR has been told.'); S.refresh();
    },
  });
};

export default {
  title: 'Profile',
  async load(q) {
    if (q && q.get('tab') === 'notifications') {
      const [prefs, chats, push] = await Promise.all([get('/api/me/notify-prefs'), get('/api/team/threads').catch(() => ({ threads: [] })), pushState().catch(() => 'unsupported')]);
      return { tab: 'notifications', prefs, chats, push };
    }
    const [u, prefs, sessions, downloads, changes, me, devs] = await Promise.all([get(`/api/users/${S.me.id}`), get('/api/me/notify-prefs'), get('/api/me/sessions'), get('/api/downloads').catch(() => []), get('/api/me/changes').catch(() => []), get('/api/me'), get('/api/developers').catch(() => [])]); S.me = me; const hr = await get('/api/me/hr').catch(() => null); return { ...u, prefs, sessions, downloads, changes, devs, hr, openUpd: q && q.get('details') === '1' };
  },
  // opened from the "please update your details" notification: straight to the form, once
  after(view, u) {
    if (!u || !u.openUpd || !u.hr || !u.hr.update_request || view.dataset.updOpened) return;
    view.dataset.updOpened = '1';
    const el = document.getElementById('details'); if (el) el.scrollIntoView({ block: 'start' });
    actions['det-upd']();
  },
  render(u) {
    if (u.tab === 'notifications') return notifyTab(u);
    detHr = u.hr;
    const pop = browserPopups();
    const sw = (name, on, label, sub) => html`<li><label for="np-${name}"><b>${label}</b>${sub ? html`<span class="sub2">${sub}</span>` : ''}</label><span class="switch"><input type="checkbox" id="np-${name}" data-pref="${name}" ${on ? raw('checked') : ''}><span></span></span></li>`;
    void pop; void sw;
    const notifPanel = html`<section class="panel" id="notifications"><header><h2>Notifications</h2></header><div class="body np-link"><span>Choose what reaches your phone, the desktop app and this browser, and when Staffwarden stays quiet.</span><a class="btn" href="#/profile?tab=notifications">Notification settings</a></div></section>`;
    const e = u.effective, s = S.settings;
    const wd = String(e.work_days).split(',').map(Number);
    const names = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
    return html`
      <div class="page-h"><div><h1>Profile</h1><p class="sub">${u.email}</p></div><div class="tools"><button class="btn" data-act="logout">Sign out</button></div>${ptabs('')}</div>
      ${agreedPanel(S.me)}
      <div class="cols even prof-top">
        <section class="panel"><header><h2>Your schedule</h2></header><div class="body"><dl class="kv">
          <dt>Name</dt><dd>${u.name}</dd><dt>Role</dt><dd>${u.title ? u.title + ' · ' : ''}${u.role[0].toUpperCase() + u.role.slice(1)}</dd>
          <dt>Team</dt><dd>${u.team || 'None'}</dd><dt>Shift</dt><dd>${hhmmText(e.shift_start)} to ${hhmmText(e.shift_end)}</dd>
          <dt>Time zone</dt><dd>${tzPlace(e.tz_name, e.tz_offset_min)}</dd><dt>Working days</dt><dd>${wd.map((d) => names[d]).join(', ')}</dd>
          <dt>Weekly target</dt><dd>${hoursText(e.weekly_target_min * 60)}</dd>
          ${Object.entries(u.day_hours || {}).map(([d, h]) => html`<dt>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]}</dt><dd>${hhmmText(h.shift_start)} to ${hhmmText(h.shift_end)}${h.break_start ? `, break ${hhmmText(h.break_start)} to ${hhmmText(h.break_end)}` : ''}</dd>`)}</dl>
          ${(() => { const z = browserZone(), o = z ? zoneOffset(z) : null; return o != null && o !== e.tz_offset_min ? html`<p class="note-tz">This computer is on ${zoneName(z)} time (${tzLabel(o)}), but Staffwarden counts your shift in ${tzPlace(e.tz_name, e.tz_offset_min)}. If you work from somewhere else now, ask your manager to change your time zone.</p>` : ''; })()}
          <p class="hint mt">Ask your manager if your schedule needs changing.</p></div></section>
        <section class="panel"><header><h2>Change your password</h2></header><div class="body"><form data-submit="change-password" novalidate>
          <div class="field"><label class="f" for="cp">Current password</label><input id="cp" name="current_password" type="password" autocomplete="current-password" required></div>
          <div class="field"><label class="f" for="np">New password</label><input id="np" name="new_password" type="password" autocomplete="new-password" minlength="10" required><p class="hint">At least 10 characters, and not a common password. You will be signed out on your other devices.</p></div>
          <p class="err" data-err></p><button class="btn primary" type="submit">Change password</button></form>
          <div class="signedin"><div><b>Signed in on ${u.sessions.length === 1 ? 'this device only' : `${u.sessions.length} devices and browsers`}</b><span class="sub2">Including the desktop app. Sign-ins end after 14 days without use.</span></div>
            ${u.sessions.length > 1 ? html`<button class="btn" data-act="logout-others">Sign out everywhere else</button>` : ''}</div></div></section>
      </div>
      ${detailsPanel(u.hr)}
      ${notifPanel}
      <section class="panel"><header><h2>Desktop app</h2><span class="muted small">Install it on each computer you work on</span></header><div class="body"><div class="dl light">${dlLinks(u.downloads)}</div></div></section>
      <section class="panel"><header><h2>What is tracked</h2></header><div class="body"><ul class="policy" style="margin:0;padding-left:18px">
        <li>Time is only tracked while you have pressed <b>Start</b> in the desktop app. Pausing or stopping ends tracking straight away.</li>
        <li>${(S.me.shots_per_10 ?? s.shots_per_10) === 0 ? html`<b>Screenshots are turned off for you.</b> Only your time and activity are tracked.` : html`A screenshot is taken ${(S.me.shots_per_10 ?? s.shots_per_10) === 1 ? 'once' : `${S.me.shots_per_10 ?? s.shots_per_10} times`} every 10 minutes, at random moments. <b>None are taken while you are paused or idle.</b>`}</li>
        <li>Messaging apps like WhatsApp, password managers, private browser windows and notification pop-ups (which can show a message) are painted black on your computer before a screenshot is saved.</li>
        <li>Activity is a count of seconds with keyboard or mouse input. What you type is never recorded.</li>
        <li>Which apps or websites you use is not recorded.</li>
        <li>If you are idle for ${s.idle_limit_min} minutes your timer keeps running, but that time is shown as idle.</li>
        <li>If your computer sleeps or restarts, the timer carries on when it is back. The time it was off is not counted.</li>
        <li>${s.team_visibility === 'off' ? 'Only your managers see whether you are working.' : html`${s.team_visibility === 'team' ? 'People in your team' : 'Everyone in the company'} can see whether you are working, on a break, idle or not started, and your hours today. Never your screenshots${(S.me.leaderboard_public || []).includes('activity') ? '' : ', activity'} or why you are on a break.`}</li>
        ${(S.me.leaderboard_public || []).length ? html`<li>Everyone can see the leaderboard, which shows each person’s ${S.me.leaderboard_public.map((c) => ({ hours: 'hours', activity: 'activity', tasks: 'tasks done', points: 'points' })[c]).join(', ').replace(/, ([^,]*)$/, ' and $1')} for this week, month and year.</li>` : ''}
        <li>You are told whenever anyone changes your schedule, what is captured, or your time. Each change is listed below.</li>
        <li>${u.devs && u.devs.length ? html`<b>Developer access:</b> ${u.devs.map((d) => d.name).join(', ')}. They see what the owner sees, including your screenshots, activity, pay and HR records, to look after Staffwarden. You are told whenever someone gets this access.` : 'Nobody has developer access. If someone is given it, they see what the owner sees, and you are told.'}</li>
        <li>You and your managers can see your screenshots. You can delete any of yours${s.employees_can_delete_shots ? '' : ' (ask your manager if this is turned off)'}. They are removed automatically after ${s.retention_days} days.</li></ul></div></section>
      ${changesPanel(u.changes)}`;
  },
};

const ptabs = (cur) => html`<nav class="tabs" aria-label="Profile">${[['', 'Profile'], ['notifications', 'Notifications']].map(([v, n]) => html`<button type="button" class="tab" data-act="q" data-q="tab" data-v="${v}" aria-current="${cur === v ? 'page' : 'false'}">${n}</button>`)}</nav>`;

// ---------- notifications: what reaches which device, quiet hours, devices, muted chats ----------
const DEVS = [['phone', 'Phone', 'phone'], ['desktop', 'Desktop app', 'laptop'], ['browser', 'Browser', 'globe']];
const DEV_IC = {
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 18.5h19"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9s1.3-6.3 3.8-9z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  hash: '<path d="M9 4L7 20M17 4l-2 16M4.5 9h16M3.5 15h16"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .7 3.5 2.7 3.5 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>',
  helm: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const di = (n, s = 18) => raw(`<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DEV_IC[n]}</svg>`);
const hhmm = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
function notifyTab({ prefs: p, chats, push }) {
  const row = (c) => html`<div class="npt-r" data-k="c${c.key}"><div class="npt-w"><b>${c.label}</b>${c.sub ? html`<span>${c.sub}</span>` : ''}</div>
    ${DEVS.map(([d, label]) => html`<div class="npt-c">${c.locked ? html`<span class="npt-lock" title="Always on">${di('lock', 12)}<span>Always</span></span>`
      : html`<span class="switch"><input type="checkbox" data-np="${c.key}:${d}" aria-label="${c.label}: ${label}" ${c.channels[d] ? raw('checked') : ''}><span></span></span>`}</div>`)}</div>`;
  const table = html`<section class="panel"><header><h2>What reaches you, and where</h2></header><div class="npt" role="table" aria-label="What reaches each device">
    <div class="npt-r npt-hd" role="row"><div class="npt-w">What</div>${DEVS.map(([, label, ic]) => html`<div class="npt-c" title="${label}">${di(ic, 16)}<span>${label}</span></div>`)}</div>
    ${p.categories.map(row)}</div></section>`;
  // the day as 24 hours from noon: the shift dark, the rest quiet
  const s0 = hhmm(p.shift.start) - 30, e0 = hhmm(p.shift.end) + 30;
  const inS = (m) => { const a = ((s0 % 1440) + 1440) % 1440, b = ((e0 % 1440) + 1440) % 1440; return a <= b ? m >= a && m < b : m >= a || m < b; };
  const hours = Array.from({ length: 24 }, (_, i) => (12 + i) % 24);
  const quiet = html`<section class="panel"><header><h2>Quiet hours</h2></header><div class="body">
    <label class="npq"><span class="switch"><input type="checkbox" data-np="quiet" ${p.quiet ? raw('checked') : ''}><span></span></span><span><b>Quiet outside my shift</b><span>Your shift is ${hhmmText(p.shift.start)} to ${hhmmText(p.shift.end)}. Half an hour either side counts as your shift. Outside it nothing buzzes, except announcements, “still there?” nudges and direct messages marked urgent. Everything still waits in the bell.</span></span></label>
    <div class="npq-bar${p.quiet ? '' : ' off'}" aria-hidden="true">${hours.map((h) => html`<i class="${inS(h * 60 + 30) ? 'on' : ''}" title="${hhmmText(`${h}:00`)}"></i>`)}</div>
    <div class="npq-ax" aria-hidden="true"><span>12 PM</span><span>6 PM</span><span>12 AM</span><span>6 AM</span><span>12 PM</span></div>
    <div class="npq-key"><span><i class="on"></i>Your shift: everything you turned on above</span><span><i></i>Quiet</span></div>
    ${p.in_shift ? html`<p class="hint">You’re in your shift now.</p>` : html`<p class="hint">You’re outside your shift now${p.quiet ? ', so only the loud ones come through' : ''}.</p>`}</div></section>`;
  const st = (dv) => (dv.kind === 'desktop' ? (dv.running ? ['ok', 'Working'] : ['off', 'Not running']) : dv.ok ? ['ok', 'Working'] : ['bad', 'Not reaching']);
  const devs = html`<section class="panel"><header><h2>Your devices</h2></header><div class="body">
    ${p.devices.length ? html`<ul class="npd">${p.devices.map((dv) => { const [cls, lab] = st(dv); return html`<li data-k="d${dv.id}"><span class="npd-ic">${di(dv.kind === 'phone' ? 'phone' : dv.kind === 'desktop' ? 'laptop' : 'globe')}</span>
      <span class="npd-t"><b>${dv.name}</b><span>${dv.kind === 'desktop' ? `${dv.sub ? `${dv.sub} · ` : ''}Pop-ups even with the browser closed` : dv.last_ok_at ? `Last reached ${relTimeShort(dv.last_ok_at)}` : dv.kind === 'phone' ? 'Pop-ups on the lock screen' : 'Pop-ups while the browser is open'}</span></span>
      <span class="npd-s ${cls}">${lab}</span>${dv.kind !== 'desktop' ? html`<button type="button" class="ch-ib" data-act="np-rm" data-id="${dv.id}" aria-label="Stop sending to ${dv.name}">${di('x', 16)}</button>` : ''}</li>`; })}</ul>`
      : html`<p class="muted">Nothing set up yet. Turn on pop-ups for this ${onPhone() ? 'phone' : 'browser'}, and install the desktop app on your computer.</p>`}
    ${push === 'ios-install' ? html`<p class="hint">On an iPhone: open Staffwarden in Safari, tap Share, then Add to Home Screen. Open it from there and turn notifications on.</p>` : push === 'denied' ? html`<p class="hint">Notifications are blocked for this site in this browser. Allow them in the browser settings (the lock icon next to the address), then come back.</p>` : ''}
    <div class="npd-a"><button type="button" class="btn primary" data-act="np-test">${di('bell', 16)} Send me a test</button>${push === 'off' ? html`<button type="button" class="btn" data-act="np-add">${di('plus', 16)} Add this ${onPhone() ? 'phone' : 'browser'}</button>` : ''}</div></div></section>`;
  const muted = (chats.threads || []).filter((t) => t.muted || t.mute === 'mentions');
  const mlab = (t) => (t.muted_until ? `Muted until ${new Date(t.muted_until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : t.mute === 'mentions' ? 'Mentions only' : 'Muted');
  const mutes = html`<section class="panel"><header><h2>Muted chats</h2></header><div class="body">${muted.length ? html`<ul class="npm">${muted.map((t) => html`<li data-k="m${t.id}"><span class="npm-ic">${(t.special === 'company' ? raw(owl('still')) : di( t.kind === 'channel' ? 'hash' : t.kind === 'dm' ? 'user' : 'users', 15))}</span><a href="#/chat?t=${t.id}">${t.name}</a><span class="muted">${mlab(t)}</span><button type="button" class="linkbtn" data-act="np-unmute" data-id="${t.id}">Unmute</button></li>`)}</ul>` : html`<p class="muted">No muted chats. Mute one from its bell in Chat.</p>`}</div></section>`;
  return html`<div class="page-h"><div><h1>Notifications</h1><p class="sub">Every device you use, what reaches each one, and when Staffwarden stays quiet.</p></div>${ptabs('notifications')}</div>
    <div class="cols np">${html`<div>${table}${quiet}</div><div>${devs}${mutes}</div>`}</div>`;
}
const relTimeShort = (iso) => { const d = new Date(iso); const same = d.toDateString() === new Date().toDateString(); return same ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
document.addEventListener('change', async (e) => {
  const el = e.target.closest && e.target.closest('input[data-np]');
  if (!el) return;
  const [k, d] = el.dataset.np.split(':');
  const body = k === 'quiet' ? { quiet: el.checked } : { channels: { [k]: { [d]: el.checked } }, ...(d === 'desktop' && el.checked ? { desktop: true } : {}) };
  try { await put('/api/me/notify-prefs', body); S.refresh(); }
  catch (err) { el.checked = !el.checked; toast(errMsg(err), true); }
});
actions['np-test'] = async (el) => { el.disabled = true; try { const r = await post('/api/me/notify-test'); toast(r.phones_and_browsers ? `Sent to the bell, the desktop app and ${plural(r.phones_and_browsers, 'phone or browser', 'phones and browsers')}` : 'Sent to the bell and the desktop app'); } catch (err) { toast(errMsg(err), true); } finally { el.disabled = false; } };
actions['np-add'] = async (el) => { el.disabled = true; try { await enablePush(); toast(`Pop-ups are on for this ${onPhone() ? 'phone' : 'browser'}`); S.refresh(); } catch (err) { el.disabled = false; toast(errMsg(err), true); } };
actions['np-rm'] = async (el) => { try { await del(`/api/me/devices/${el.dataset.id}`); toast('Stopped. Turn it on again from that device.'); S.refresh(); } catch (err) { toast(errMsg(err), true); } };
actions['np-unmute'] = async (el) => { try { await put(`/api/team/threads/${el.dataset.id}/mute`, { mode: 'none' }); toast('Unmuted'); S.refresh(); } catch (err) { toast(errMsg(err), true); } };

actions['change-password'] = async (form) => {
  const fd = new FormData(form), err = form.querySelector('[data-err]');
  err.textContent = '';
  try { await post('/api/me/password', { current_password: fd.get('current_password'), new_password: fd.get('new_password') }); form.reset(); form.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty); toast('Password changed'); }
  catch (e) { err.textContent = errMsg(e); }
};

actions['allow-popups'] = async () => { await askBrowser(); S.refresh(); };
document.addEventListener('change', async (e) => {
  const el = e.target.closest && e.target.closest('input[data-pref]');
  if (!el) return;
  const k = el.dataset.pref;
  const body = k === 'desktop' ? { desktop: el.checked } : { categories: { [k]: el.checked } };
  try { await put('/api/me/notify-prefs', body); toast(el.checked ? 'Turned on' : 'Turned off'); }
  catch (err) { el.checked = !el.checked; toast(errMsg(err), true); }
});

actions['logout-others'] = async () => {
  try { const r = await post('/api/auth/logout-all', { keep_this: true }); toast(`Signed out on ${r.ended} other ${r.ended === 1 ? 'device' : 'devices'}`); S.refresh(); }
  catch (err) { toast(errMsg(err), true); }
};
