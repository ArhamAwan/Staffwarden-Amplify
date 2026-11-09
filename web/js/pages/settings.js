import { html, raw, icon, plural, tod, dayShort, addDays, minOfDayIn, dur, hhmmText, hm, zoneOffset, initials, avColor, nowMs } from '../util.js';

const breakLen = (a, b) => (((hm(b) - hm(a)) % 1440) + 1440) % 1440;
import { get, post, put } from '../api.js';
import { S, actions, empty, toast, errMsg, confirmBox, qAttr } from '../ui.js';
import { zoneOptions } from '../parts.js';
import { companyBlock, companyAfter, loadCompany } from './company.js';
import { billingBlock, accountBlock, loadBilling } from './billing.js';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const bytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

// The settings page: a list of sections on the left (each with what it is set to now), the sections on
// the right as plain rows (what it is, then the control), a picture of the shift that follows the times
// as they are typed, and a save bar that only appears once something has changed.
const SECTIONS = [['billing', 'Billing'], ['company', 'Your company'], ['account', 'Account'], ['hours', 'Working hours'], ['shots', 'Screenshots'], ['privacy', 'Private windows'], ['tasks', 'Tasks'], ['open', 'Transparency'], ['live', 'Live status'], ['reports', 'Report email'], ['storage', 'Storage'], ['chat', 'Chat']];
const ALWAYS = ['Messaging apps (WhatsApp, Telegram, Signal…)', 'Password managers', 'Private and incognito windows', 'Banking and payments', 'Social media', 'Notification pop-ups'];
const SHOTS = [[0, 'Off'], [1, '1'], [2, '2'], [3, '3']];
const short = (t) => (t ? hhmmText(t).replace(':00', '') : '');
const dayRun = (wd) => {
  const on = DAYS.filter(([v]) => wd.has(v)).map(([, n]) => n);
  if (on.length === 7) return 'Every day';
  const names = DAYS.map(([, n]) => n), idx = on.map((n) => names.indexOf(n));
  const run = idx.length > 2 && idx.every((x, i) => !i || x === idx[i - 1] + 1);
  return run ? `${on[0]}–${on[on.length - 1]}` : on.join(', ') || 'No days';
};

const SEC_ICON = { billing: 'wallet', account: 'users', company: 'bank', hours: 'clock', shots: 'camera', privacy: 'lock', tasks: 'tasks', open: 'eye', live: 'pulse', reports: 'file', storage: 'db', chat: 'chats' };
// one short line under each section's name in the strip: what it's set to now
function summaries(s, { storage, gifs, mail, co, bill } = {}) {
  const wd = new Set(String(s.work_days).split(',').map(Number));
  const extra = (s.blackout_apps || []).filter((a) => a.toLowerCase() !== 'whatsapp').length;
  return {
    billing: bill ? (bill.comped ? 'Free' : bill.status === 'trial' ? `Trial, ${plural(bill.trial_days_left || 0, 'day')} left` : bill.status === 'past_due' ? 'Payment due' : bill.status === 'paused' ? 'Paused' : `${(bill.plans.find((p) => p.id === bill.plan) || {}).name || ''}, ${bill.interval}ly`) : '',
    account: 'Owner, currency, export',
    company: co && co.images && co.images.logo ? 'Logo and details' : co && (co.address || co.ntn) ? 'Details, no logo yet' : 'Add your logo',
    hours: `${short(s.shift_start)}–${short(s.shift_end)}, ${dayRun(wd)}`,
    shots: s.shots_per_10 ? `${s.shots_per_10} per 10 min` : 'Off',
    privacy: extra ? `Always on, +${extra}` : 'Always on',
    tasks: s.task_review_required !== false ? 'Review first' : 'Done when ticked',
    open: { everyone: 'Everyone sees status', team: 'Own team only', off: 'Managers only' }[s.team_visibility || 'everyone'],
    live: `No signal: ${s.no_signal_min} min`,
    reports: mail ? (mail.on ? `To ${plural(mail.to.length, 'address', 'addresses')}` : 'Off') : '',
    storage: storage ? plural(storage.screenshots, 'screenshot') : '',
    chat: gifs ? (gifs.has_key ? 'GIFs on' : 'GIFs off') : '',
  };
}

// the shift as a 24-hour strip, starting 3 hours before the shift: the shift, the break inside it, and
// where "late" begins. Drawn again as the times are typed.
function shiftStrip(f) {
  const ss = hm(f.shift_start), se = hm(f.shift_end);
  if (ss == null || se == null) return '';
  const origin = (Math.floor(ss / 60) - 3 + 24) % 24 * 60;
  const pos = (m) => ((((m - origin) % 1440) + 1440) % 1440) / 1440 * 100;
  const len = (a, b) => ((((b - a) % 1440) + 1440) % 1440 || 1440) / 1440 * 100;
  const bs = hm(f.break_start), be = hm(f.break_end), grace = Number(f.grace_min) || 0;
  const ticks = [0, 6, 12, 18].map((h) => { const m = (origin + h * 60) % 1440; return html`<span class="ss-tick" style="left:${(h / 24) * 100}%">${short(`${String(Math.floor(m / 60)).padStart(2, '0')}:00`)}</span>`; });
  const work = (se - ss + 1440) % 1440 - (bs != null && be != null ? breakLen(f.break_start, f.break_end) : 0);
  return html`<div class="ss" aria-hidden="true">
      <div class="ss-bar"><i class="ss-shift" style="left:${pos(ss)}%;width:${len(ss, se)}%"></i>${pos(ss) + len(ss, se) > 100 ? html`<i class="ss-shift" style="left:0;width:${pos(ss) + len(ss, se) - 100}%"></i>` : ''}
        ${bs != null && be != null ? html`<i class="ss-break" style="left:${pos(bs)}%;width:${len(bs, be)}%"></i>` : ''}
        ${grace ? html`<i class="ss-grace" style="left:${pos(ss)}%;width:${(grace / 1440) * 100}%"></i>` : ''}
        <b class="ss-pin" style="left:${pos(ss)}%">${short(f.shift_start)}</b><b class="ss-pin end" style="left:${(pos(ss) + len(ss, se)) % 100 || 100}%">${short(f.shift_end)}</b></div>
      <div class="ss-axis">${ticks}</div></div>
    <p class="ss-sum"><b>${dur(Math.max(0, work) * 60)}</b> of work${bs != null && be != null ? html`, with a <b>${dur(breakLen(f.break_start, f.break_end) * 60)}</b> break from ${short(f.break_start)} to ${short(f.break_end)}` : ', no fixed break'}${grace ? html`. Starting up to <b>${grace} min</b> late still counts as on time` : ''}.${(se < ss) ? html` The shift crosses midnight, so work until ${short(f.shift_end)} counts for the day it began.` : ''}</p>`;
}
// where screenshots can fall inside 10 minutes (each in the middle of its own part)
function shotRuler(n) {
  if (!n) return html`<div class="shr off"><span>No screenshots. Time, activity and attendance are still tracked.</span></div>`;
  const part = 10 / n;
  return html`<div class="shr" aria-hidden="true"><div class="shr-bar">${Array.from({ length: n }, (_, i) => html`<i style="left:${((i * part + part * 0.2) / 10) * 100}%;width:${((part * 0.6) / 10) * 100}%"></i>`)}</div>
    <div class="shr-axis"><span>0 min</span><span>5</span><span>10</span></div></div>
    <p class="hint">Each shaded part gets one screenshot at a random moment, so they can’t be predicted but are never seconds apart.</p>`;
}

let secShown = null;
export const settingsPage = {
  title: 'Settings',
  async load() {
    const [s, storage, gifs, mail, co, acct] = await Promise.all([get('/api/settings'), get('/api/admin/storage'), get('/api/chat/gifs/setup').catch(() => null), get('/api/shift-reports/email').catch(() => null), loadCompany(), loadBilling()]);
    S.settings = s;
    return { s, storage, gifs, mail, co, acct };
  },
  render({ s, storage, gifs, mail, co, acct }) {
    const wd = new Set(String(s.work_days).split(',').map(Number));
    const sum = summaries(s, { storage, gifs, mail, co, bill: acct && acct.bill });
    const row = (label, hint, control, { id, wide, tog } = {}) => html`<div class="srow ${wide ? 'wide' : ''} ${tog ? 'tog' : ''}"><div class="srow-t">${id ? html`<label for="${id}">${label}</label>` : html`<span class="srow-l">${label}</span>`}${hint ? html`<p>${hint}</p>` : ''}</div><div class="srow-c">${control}</div></div>`;
    const sw = (name, on, id) => html`<label class="switch"><input type="checkbox" id="${id}" name="${name}" ${on ? raw('checked') : ''}><span></span></label>`;
    const num = (id, name, v, min, max, unit, step = 1) => html`<span class="unit-in"><input id="${id}" name="${name}" type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${v}" required><em>${unit}</em></span>`;
    const radios = (name, cur, list, label) => html`<div class="seg-r" role="radiogroup" aria-label="${label}">${list.map(([v, t]) => html`<label><input type="radio" name="${name}" value="${v}" ${String(cur) === String(v) ? raw('checked') : ''}><span>${t}</span></label>`)}</div>`;
    const sec = (key, title, lead, body) => html`<section class="panel sset" id="set-${key}" data-k="set-${key}"><header><div><h2>${title}</h2>${lead ? html`<p>${lead}</p>` : ''}</div></header><div class="body">${body}</div></section>`;
    const extra = (s.blackout_apps || []).filter((a) => a.toLowerCase() !== 'whatsapp');
    return html`
      <div class="page-h"><div><h1>Settings</h1><p class="sub">Rules for the whole company. Teams and people can have their own schedule and screenshots on the People page.</p></div></div>
      <div class="set-wrap">
        <nav class="set-nav" aria-label="Settings sections">${SECTIONS.filter(([k]) => (k !== 'chat' || gifs) && (k !== 'reports' || mail) && (k !== 'billing' || (acct && acct.bill)) && (k !== 'account' || (acct && acct.acc))).map(([k, t]) => html`<button type="button" data-act="set-jump" data-to="${k}" data-k="nav-${k}" title="${sum[k] ? `${t}: ${sum[k]}` : t}"><i class="sn-ic" aria-hidden="true">${icon(SEC_ICON[k] || 'gear')}</i><span class="sn-t"><b>${t}</b>${sum[k] ? html`<span data-sum="${k}">${sum[k]}</span>` : ''}</span></button>`)}</nav>
        <div class="set-main">
        ${acct ? billingBlock(acct) : ''}
        ${companyBlock(co)}
        ${acct ? accountBlock(acct) : ''}
        <form data-submit="save-settings" data-setform novalidate>
          <div class="set-cols"><div class="set-col">

          ${sec('hours', 'Working hours', 'Attendance, lateness and weekly targets are worked out from these.', html`
            <div data-strip>${shiftStrip(s)}</div>
            <div class="set-times">
              <div class="field"><label class="f" for="s-ss">Shift starts</label><input id="s-ss" type="time" name="shift_start" value="${s.shift_start}" required></div>
              <div class="field"><label class="f" for="s-se">Shift ends</label><input id="s-se" type="time" name="shift_end" value="${s.shift_end}" required></div>
              <div class="field"><label class="f" for="s-bs">Break starts</label><input id="s-bs" type="time" name="break_start" value="${s.break_start || ''}"></div>
              <div class="field"><label class="f" for="s-be">Break ends</label><input id="s-be" type="time" name="break_end" value="${s.break_end || ''}"></div>
            </div>
            <p class="hint set-brk">The desktop app reminds people when the break starts and ends. <button type="button" class="linkbtn" data-act="set-nobreak">No fixed break</button></p>
            ${row('Working days', '', html`<div class="days" role="group" aria-label="Working days">${DAYS.map(([v, n]) => html`<label><input type="checkbox" name="wd" value="${v}" ${wd.has(v) ? raw('checked') : ''}><span>${n}</span></label>`)}</div>`, { wide: true })}
            ${row('Grace period', 'Starting this late still counts as on time.', num('s-gr', 'grace_min', s.grace_min, 0, 120, 'min'), { id: 's-gr' })}
            ${row('Weekly target', 'Hours each person aims for in a week.', num('s-wt', 'weekly_h', s.weekly_target_min / 60, 0, 100, 'hours', 0.5), { id: 's-wt' })}
            ${row('Paid time off', 'Paid days each person gets every month. Unused days don’t carry over; unpaid days are always allowed.', num('s-lv', 'paid_leave_per_month', s.paid_leave_per_month ?? 1, 0, 31, 'a month'), { id: 's-lv' })}
            ${row('Not next to weekends', 'Time off on a day next to a weekend or a holiday (a Friday or a Monday) is only allowed in an emergency.', sw('no_sandwich_leave', s.no_sandwich_leave !== false, 's-sw'), { id: 's-sw', tog: true })}
            ${row('Time zone', 'The default for everyone. Set each remote person’s own zone on the People page.', html`<select id="s-tz" name="tz">${zoneOptions(s.tz_name || null, { fixed: s.tz_name ? null : s.tz_offset_min })}</select>`, { id: 's-tz' })}`)}
          ${sec('tasks', 'Tasks', '', row('Review before done', 'Assigned tasks go to a manager or the project manager before they count as done. Task accuracy on Performance is the share approved first time.', sw('task_review_required', s.task_review_required !== false, 's-rv'), { id: 's-rv', tog: true }))}
          </div><div class="set-col">

          ${sec('shots', 'Screenshots and activity', 'Everyone sees this same policy in the desktop app.', html`
            ${row('Screenshots per 10 minutes', 'The company default. Teams and people can have their own.', radios('shots_per_10', s.shots_per_10, SHOTS, 'Screenshots per 10 minutes'), { wide: true })}
            <div data-ruler>${shotRuler(s.shots_per_10)}</div>
            ${row('Screens to capture', 'People work on their own computers, so other monitors are left out by default.', radios('capture_screens', s.capture_screens === 'all' ? 'all' : 'active', [['active', 'The one in use'], ['all', 'All screens']], 'Screens to capture'))}
            ${row('Idle after', 'With no keyboard or mouse for this long, the time shows as idle and no screenshots are taken.', num('s-il', 'idle_limit_min', s.idle_limit_min, 1, 120, 'min'), { id: 's-il' })}
            ${row('Keep screenshots for', 'Older ones are deleted on their own.', num('s-rd', 'retention_days', s.retention_days, 1, 3650, 'days'), { id: 's-rd' })}
            ${row('Blur screenshots', 'Blurred on the employee’s computer before sending: you see that work is happening, not what is on screen.', sw('blur_shots', s.blur_shots, 's-blur'), { id: 's-blur', tog: true })}
            ${row('People can delete their own screenshots', 'They can always see their screenshots and who opened each one.', sw('employees_can_delete_shots', s.employees_can_delete_shots, 's-del'), { id: 's-del', tog: true })}`)}

          ${sec('privacy', 'Private windows', 'Painted black on the employee’s computer before a screenshot leaves it, so nobody ever sees them.', html`
            <div class="srow wide"><div class="srow-t"><span class="srow-l">Always hidden</span><p>These can’t be turned off.</p></div><div class="srow-c"><ul class="always">${ALWAYS.map((t) => html`<li>${icon('lock')}${t}</li>`)}</ul></div></div>
            <div class="srow wide"><div class="srow-t"><label for="s-bo-add">Also hide</label><p>Matches the app name or window title, so a site open in any browser is covered too.</p></div>
              <div class="srow-c"><input type="hidden" name="blackout_apps" value="${extra.join(', ')}" data-initial="${extra.join(', ')}" data-tags-value>
                <div class="tags" data-tags>${extra.map((t) => html`<span class="tag-x">${t}<button type="button" data-act="set-tag-rm" data-tag="${t}" aria-label="Stop hiding ${t}">${icon('x')}</button></span>`)}
                  <input id="s-bo-add" data-tag-add placeholder="${extra.length ? 'Add another' : 'Add an app or site, like Gmail'}" maxlength="40" autocomplete="off"></div>
                <p class="hint">Press Enter to add.</p></div></div>`)}
          </div></div>
          <div class="set-tiles two">


          ${sec('open', 'Transparency', 'Changes here are shown to everyone they affect.', html`
            ${row('Who sees colleagues’ status', 'Working, on a break, idle or not started, and hours today. Never screenshots or activity. Widening it asks everyone to agree again.', html`<select id="s-tv" name="team_visibility">${[['everyone', 'Everyone in the company'], ['team', 'Only their own team'], ['off', 'Nobody, only managers']].map(([v, t]) => html`<option value="${v}" ${(s.team_visibility || 'everyone') === v ? raw('selected') : ''}>${t}</option>`)}</select>`, { id: 's-tv' })}
            ${row('Only the newest desktop app starts the timer', 'Older apps show “Update to start your timer”. A timer already running keeps going.', sw('require_latest_app', s.require_latest_app !== false, 's-rl'), { id: 's-rl', tog: true })}`)}

          ${sec('live', 'Live status', '', html`
            ${row('“No signal” after', 'A running timer that has gone quiet.', num('s-ns', 'no_signal_min', s.no_signal_min, 1, 60, 'min'), { id: 's-ns' })}
            ${row('Close a silent session after', 'It ends at the last time the app was heard from.', num('s-st', 'stale_min', s.stale_min, 5, 240, 'min'), { id: 's-st' })}`)}
          </div>

          <div class="set-bar" data-setbar hidden><span><b data-setcount>Unsaved changes</b><span class="err" data-err></span></span><span class="set-bar-a"><button type="button" class="btn" data-act="set-discard">Discard</button><button type="submit" class="btn primary">Save changes</button></span></div>
        </form>

        ${mail ? sec('reports', 'Shift report email', 'After the last shift of each work day, the report is emailed with the PDF attached. Staffwarden sends it from a mailbox you choose.', mailForm(mail, row, sw)) : ''}
        <div class="set-tiles${gifs ? ' two' : ' one'}">
        ${sec('storage', 'Storage', '', row(`${plural(storage.screenshots, 'screenshot')} stored`, html`Using <b>${bytes(storage.bytes)}</b>. Anything older than ${s.retention_days} days is removed on its own.`, html`<button class="btn danger" data-act="purge">Delete expired now</button>`))}
        ${gifs ? sec('chat', 'Chat', 'GIFs in every chat, for everyone.', html`
          <form class="gif-set" data-submit="gif-key" novalidate>
            ${row('GIF search', gifs.has_key ? html`On, from <b>${gifs.provider === 'tenor' ? 'Tenor' : 'GIPHY'}</b>. Paste a new key to change it.` : 'Free from developers.giphy.com, or a Tenor key from Google Cloud. GIFs come through Staffwarden, so nobody’s browser talks to them directly.',
              html`<div class="gif-in"><input id="s-gif" name="key" autocomplete="off" spellcheck="false" aria-label="GIF search key" placeholder="${gifs.has_key ? `Key ending ${gifs.hint}` : 'Paste a GIPHY or Tenor key'}"><button type="submit" class="btn">Save key</button>${gifs.has_key ? html`<button type="button" class="btn" data-act="gif-off">Turn off</button>` : ''}</div><span class="err" data-err></span>`, { wide: true })}
          </form>`) : ''}
        </div>
        </div>
      </div>`;
  },
  after(view, d, q) {
    setupForm(view); spy(view); if (d) companyAfter(view, d.co);
    // a link to one section (the billing note at the top of the page): straight there, once
    const sec = q && q.get && q.get('sec');
    if (sec && secShown !== location.hash) { secShown = location.hash; const t = document.getElementById(`set-${sec}`), nav = view.querySelector('.set-nav'); if (t) setTimeout(() => window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - (nav ? nav.offsetHeight : 0) - 24 }), 60); }
  },
};

// ---- emailing the shift report ----
const PROVIDERS = [['Hostinger', 'smtp.hostinger.com', 465], ['Gmail', 'smtp.gmail.com', 465], ['Outlook', 'smtp.office365.com', 587]];
function mailForm(m, row, sw) {
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const status = m.last_error && (!m.last_sent_at || m.last_error_at > m.last_sent_at)
    ? html`<p class="rm-st bad">${icon('alert')}<span><b>Last try failed</b> ${when(m.last_error_at)}: ${m.last_error}</span></p>`
    : m.last_sent_at ? html`<p class="rm-st ok">${icon('check')}<span>Last sent ${when(m.last_sent_at)}</span></p>` : '';
  return html`<form class="rm" data-submit="report-mail" novalidate>
    ${row('Email the report after each shift', m.on ? `On. Goes to ${m.to.join(', ')}.` : 'Off. Reports are still on the Shift reports page and in the bell.', sw('on', m.on, 'rm-on'), { id: 'rm-on', tog: true })}
    ${row('Send it to', 'Up to 10 addresses, separated by commas. Yours for now; add the owner’s when you’re happy with it.', html`<input id="rm-to" name="to" type="text" inputmode="email" autocomplete="off" value="${m.to.join(', ')}" placeholder="${m.owner_email || 'you@company.com'}">`, { id: 'rm-to', wide: true })}
    <div class="srow wide"><div class="srow-t"><span class="srow-l">Send from this mailbox</span><p>Its mail server login. A Gmail account needs an app password (Google Account › Security › App passwords), not the normal one.</p></div>
      <div class="srow-c rm-box">
        <div class="rm-pre" role="group" aria-label="Fill in for">${PROVIDERS.map(([n, h, pt]) => html`<button type="button" class="chip" data-act="rm-pre" data-host="${h}" data-port="${pt}">${n}</button>`)}</div>
        <div class="rm-grid">
          <div class="field"><label class="f" for="rm-host">Mail server</label><input id="rm-host" name="host" value="${m.host}" placeholder="smtp.hostinger.com" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label class="f" for="rm-port">Port</label><select id="rm-port" name="port">${[[465, '465 (SSL)'], [587, '587 (STARTTLS)'], [2525, '2525']].map(([v, t]) => html`<option value="${v}" ${Number(m.port) === v ? raw('selected') : ''}>${t}</option>`)}</select></div>
          <div class="field"><label class="f" for="rm-user">Username</label><input id="rm-user" name="user" value="${m.user}" placeholder="reports@yourcompany.com" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label class="f" for="rm-pass">Password</label><input id="rm-pass" name="pass" type="password" autocomplete="new-password" placeholder="${m.has_pass ? 'Saved. Type a new one to change it' : 'The mailbox password'}"></div>
          <div class="field rm-from"><label class="f" for="rm-from">Send as <span class="muted">(optional)</span></label><input id="rm-from" name="from" value="${m.from}" placeholder="Same as the username" autocomplete="off" spellcheck="false"></div>
        </div></div></div>
    ${status}
    <div class="rm-a"><span class="err" data-err></span><button type="button" class="btn" data-act="rm-test">Send a test now</button><button type="submit" class="btn primary">Save</button></div>
  </form>`;
}
const rmBody = (f) => ({ on: f.querySelector('[name=on]').checked, to: f.querySelector('[name=to]').value, host: f.querySelector('[name=host]').value, port: Number(f.querySelector('[name=port]').value),
  user: f.querySelector('[name=user]').value, pass: f.querySelector('[name=pass]').value, from: f.querySelector('[name=from]').value });
actions['report-mail'] = async (form) => {
  const err = form.querySelector('[data-err]'), btn = form.querySelector('button[type=submit]');
  err.textContent = ''; btn.disabled = true;
  try { const r = await put('/api/shift-reports/email', rmBody(form)); rmClean(form); toast(r.on ? `Shift reports will be emailed to ${r.to.join(', ')}` : 'Saved. The email is off'); S.refresh(); }
  catch (e) { err.textContent = errMsg(e); } finally { btn.disabled = false; }
};
// filled in by a button, so marked as edited: a live refresh of the page must not put the old values back
actions['rm-pre'] = (el) => {
  const f = el.closest('form'), host = f.querySelector('[name=host]'), port = f.querySelector('[name=port]');
  host.value = el.dataset.host; port.value = el.dataset.port; host.dataset.dirty = '1'; port.dataset.dirty = '1';
  f.querySelector('[name=user]').focus();
};
// once saved, the page shows what the server has (the password field empties)
const rmClean = (f) => { f.querySelectorAll('[data-dirty]').forEach((x) => delete x.dataset.dirty); const p = f.querySelector('[name=pass]'); if (p) p.value = ''; };
actions['rm-test'] = async (el) => {
  const f = el.closest('form'), err = f.querySelector('[data-err]');
  err.textContent = ''; el.disabled = true; const label = el.textContent; el.textContent = 'Sending…';
  try {
    try { await put('/api/shift-reports/email', rmBody(f)); rmClean(f); }   // what's on screen is what gets tested
    catch (e) { err.textContent = errMsg(e); return; }
    try { const r = await post('/api/shift-reports/email/test', {}); toast(`Test sent to ${r.to.join(', ')}. Check the inbox (and spam).`); }
    catch (e) { toast('The test didn’t go through. The reason is shown above the buttons.', true); }
    S.refresh();                                                            // the result shows in the status line
  } finally { el.disabled = false; el.textContent = label; }
};

// ---- the live parts: the shift picture, the screenshot ruler, the tags, and the save bar ----
const formOf = () => document.querySelector('[data-setform]');
const snapshot = (f) => JSON.stringify([...new FormData(f).entries()]);
let initial = null;
function setupForm() {
  const f = formOf(); if (!f) return;
  if (!f.dataset.ready) {
    f.dataset.ready = '1';
    f.addEventListener('input', () => refreshForm(f));
    f.addEventListener('change', () => refreshForm(f));
  }
  // what the page was loaded with (fields being edited keep their value through live refreshes)
  if (!f.querySelector('[data-dirty]')) initial = snapshot(f);
  refreshForm(f);
}
function values(f) { const fd = new FormData(f); return Object.fromEntries(['shift_start', 'shift_end', 'break_start', 'break_end', 'grace_min'].map((k) => [k, fd.get(k)])); }
function refreshForm(f) {
  const strip = f.querySelector('[data-strip]'); if (strip) strip.innerHTML = shiftStrip(values(f)).toString();
  const ruler = f.querySelector('[data-ruler]'); if (ruler) ruler.innerHTML = shotRuler(Number(new FormData(f).get('shots_per_10')) || 0).toString();
  const changed = initial != null && snapshot(f) !== initial;
  const bar = f.querySelector('[data-setbar]');
  if (bar) { bar.hidden = !changed; document.body.classList.toggle('set-dirty', changed); }
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { const f = formOf(); if (f && !f.querySelector('[data-setbar]').hidden) { e.preventDefault(); f.requestSubmit(); } }
  if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-tag-add]')) { e.preventDefault(); addTag(e.target); }
});
document.addEventListener('focusout', (e) => { if (e.target.matches && e.target.matches('[data-tag-add]') && e.target.value.trim()) addTag(e.target); });
function tagValues(f) { return String(f.querySelector('[data-tags-value]').value || '').split(',').map((x) => x.trim()).filter(Boolean); }
function setTags(f, list) {
  const hidden = f.querySelector('[data-tags-value]'); hidden.value = list.join(', ');
  const box = f.querySelector('[data-tags]'), input = box.querySelector('[data-tag-add]');
  box.querySelectorAll('.tag-x').forEach((x) => x.remove());
  for (const t of list) input.insertAdjacentHTML('beforebegin', html`<span class="tag-x">${t}<button type="button" data-act="set-tag-rm" data-tag="${t}" aria-label="Stop hiding ${t}">${icon('x')}</button></span>`.toString());
  input.placeholder = list.length ? 'Add another' : 'Add an app or site, like Gmail';
  hidden.dataset.dirty = '1';
  refreshForm(f);
}
function addTag(input) {
  const f = formOf(), v = input.value.replace(/,/g, ' ').trim(); if (!v) return;
  const list = tagValues(f);
  if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
  input.value = '';
  setTags(f, list);
}
actions['set-tag-rm'] = (el) => { const f = formOf(); setTags(f, tagValues(f).filter((x) => x !== el.dataset.tag)); };
// the strip follows the page: the section in view is the one lit up
let spyObs = null;
function spy(view) {
  if (spyObs) spyObs.disconnect();
  const nav = view.querySelector('.set-nav'); if (!nav || !('IntersectionObserver' in window)) return;
  const seen = new Map();
  spyObs = new IntersectionObserver((list) => {
    for (const e of list) seen.set(e.target.id, e.isIntersecting ? e.intersectionRect.top : null);
    let best = null, top = Infinity;
    for (const [id, t] of seen) if (t != null && t < top) { top = t; best = id; }
    if (!best || nav.dataset.jumping) return;
    for (const b of nav.querySelectorAll('button')) { const on = `set-${b.dataset.to}` === best; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
    const cur = nav.querySelector('button.on'); if (cur && nav.scrollWidth > nav.clientWidth) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, { rootMargin: `-${Math.round(nav.offsetHeight + 30)}px 0px -50% 0px` });   // below the strip, which stays at the top
  for (const sec of view.querySelectorAll('.sset[id^="set-"]')) spyObs.observe(sec);
}
actions['set-jump'] = (el) => {
  el.parentElement.dataset.jumping = '1'; setTimeout(() => { delete el.parentElement.dataset.jumping; }, 700); el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el)); const t = document.getElementById(`set-${el.dataset.to}`); if (t) t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };
actions['set-nobreak'] = () => { const f = formOf(); for (const n of ['break_start', 'break_end']) { const i = f.querySelector(`[name=${n}]`); i.value = ''; i.dataset.dirty = '1'; } refreshForm(f); };
actions['set-discard'] = () => {
  const f = formOf(); f.reset();
  f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
  const hidden = f.querySelector('[data-tags-value]'); setTags(f, String(hidden.dataset.initial || '').split(',').map((x) => x.trim()).filter(Boolean)); delete hidden.dataset.dirty;
  f.querySelector('[data-err]').textContent = '';
  refreshForm(f);
};

actions['gif-key'] = async (form) => {
  const key = form.querySelector('[name=key]').value.trim(), err = form.querySelector('[data-err]');
  err.textContent = '';
  if (!key) { err.textContent = 'Paste a key first'; return; }
  try { const r = await put('/api/chat/gifs/setup', { key }); toast(`GIF search is on, from ${r.provider === 'tenor' ? 'Tenor' : 'GIPHY'}`); S.refresh(); } catch (e) { err.textContent = errMsg(e); }
};
actions['gif-off'] = async () => { try { await put('/api/chat/gifs/setup', { key: '' }); toast('GIFs are off'); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['save-settings'] = async (form) => {
  const fd = new FormData(form), err = form.querySelector('[data-err]'), btn = form.querySelector('button[type=submit]');
  err.textContent = '';
  const wd = fd.getAll('wd').map(Number).sort();
  if (!wd.length) { err.textContent = 'Pick at least one working day'; return; }
  const n = (k) => Number(fd.get(k));
  if (!fd.get('break_start') !== !fd.get('break_end')) { err.textContent = 'Give the break a start and an end, or neither.'; return; }
  const body = {
    shift_start: fd.get('shift_start'), shift_end: fd.get('shift_end'), break_start: fd.get('break_start') || null, break_end: fd.get('break_end') || null, grace_min: n('grace_min'),
    ...(() => { const v = String(fd.get('tz') || ''); if (v.startsWith('z:')) return { tz_name: v.slice(2), tz_offset_min: zoneOffset(v.slice(2)) }; return {}; })(), weekly_target_min: Math.round(n('weekly_h') * 60), paid_leave_per_month: n('paid_leave_per_month'), no_sandwich_leave: !!fd.get('no_sandwich_leave'),
    work_days: wd.join(','), shots_per_10: n('shots_per_10'), idle_limit_min: n('idle_limit_min'), retention_days: n('retention_days'),
    blackout_apps: String(fd.get('blackout_apps') || '').split(',').map((x) => x.trim()).filter(Boolean),
    employees_can_delete_shots: !!fd.get('employees_can_delete_shots'), team_visibility: ['everyone', 'team', 'off'].includes(fd.get('team_visibility')) ? fd.get('team_visibility') : 'everyone', require_latest_app: !!fd.get('require_latest_app'), capture_screens: fd.get('capture_screens') === 'all' ? 'all' : 'active', blur_shots: !!fd.get('blur_shots'), task_review_required: !!fd.get('task_review_required'), no_signal_min: n('no_signal_min'), stale_min: n('stale_min'),
  };
  btn.disabled = true;
  try {
    await put('/api/settings', body);
    form.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
    initial = null;
    toast('Settings saved. Desktop apps pick them up when they next start a session.');
    S.refresh();
  } catch (e) { err.textContent = errMsg(e); } finally { btn.disabled = false; }
};
actions.purge = async () => {
  if (!(await confirmBox({ title: 'Delete expired screenshots?', message: 'Screenshots older than the retention period are removed for good.', confirm: 'Delete', danger: true }))) return;
  try { const r = await post('/api/admin/purge'); toast(`${plural(r.purged, 'screenshot')} deleted`); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};

// ---------------- audit log ----------------
const LABEL = {
  'user.created': 'Added a person', 'user.updated': 'Changed a person', 'user.tracking_on': 'Turned on time tracking for', 'team.created': 'Created a team', 'team.renamed': 'Renamed a team', 'team.deleted': 'Deleted a team',
  'project.created': 'Created a project', 'project.updated': 'Changed a project', 'settings.changed': 'Changed settings', 'screenshot.deleted': 'Deleted a screenshot', 'screenshots.purged': 'Deleted expired screenshots', 'screenshots.trimmed': 'Removed screenshots after a backdated pause',
  'timeoff.requested': 'Requested time off', 'timeoff.recorded': 'Recorded time off', 'timeoff.approved': 'Approved time off', 'timeoff.denied': 'Denied time off', 'timeoff.cancelled': 'Cancelled time off',
  'holiday.saved': 'Saved a holiday', 'holiday.removed': 'Removed a holiday', 'password.changed': 'Changed their password', 'policy.accepted': 'Accepted the monitoring policy',
  'time.manual_added': 'Added time by hand', 'time.deleted': 'Deleted a time entry', 'timer.lost': 'Timer closed after losing contact',
  'time.requested': 'Asked to add missing time', 'time.request_approved': 'Approved missing time', 'time.request_declined': 'Declined missing time',
  'login': 'Signed in', 'login.failed': 'Failed sign-in', 'logout.all': 'Signed out everywhere else', 'task.deleted': 'Deleted a task',
  'project.member_added': 'Added someone to a project', 'project.member_removed': 'Removed someone from a project', 'team.screenshots': 'Changed a team’s screenshots',
  'client.created': 'Added a client', 'client.changed': 'Changed a client', 'client.login': 'Client signed in', 'client.login_failed': 'Client sign-in failed',
  'client.person_added': 'Gave someone at a client a sign-in', 'client.person_changed': 'Changed a client’s sign-in', 'client.project_added': 'Shared a project with a client',
  'client.project_removed': 'Stopped sharing a project', 'client.project_fresh': 'Started a client project afresh', 'client.request': 'Answered a client request',
  'client.approval_asked': 'Asked a client to approve', 'client.approval_decided': 'Client decided on an approval', 'client.estimate_answered': 'Client answered an estimate',
  'client.meeting': 'Changed a client call', 'client.update_posted': 'Posted a client update',
  'hr.record': 'Changed an HR record', 'hr.pay': 'Changed someone’s pay', 'hr.step': 'Moved an HR step', 'hr.viewed': 'Opened an HR record',
  'hr.doc_added': 'Added an HR document', 'hr.doc_changed': 'Changed an HR document', 'hr.doc_opened': 'Opened an HR document', 'hr.doc_removed': 'Removed an HR document',
  'payroll.started': 'Started a payroll month', 'payroll.submitted': 'Sent payroll for approval', 'payroll.approved': 'Approved payroll', 'payroll.paid': 'Marked payroll paid',
  'payroll.reopened': 'Reopened payroll', 'payroll.removed': 'Removed a payroll draft', 'payroll.item_added': 'Added a payroll line', 'payroll.item_removed': 'Removed a payroll line', 'payroll.line_removed': 'Took a line off a payslip', 'payroll.line_restored': 'Put a payslip line back', 'payroll.person_left_off': 'Left someone off a month', 'payroll.person_back': 'Put someone back on a month', 'company.changed': 'Changed the company details', 'company.image': 'Uploaded a company picture', 'company.image_removed': 'Removed a company picture',
  'payroll.question': 'Asked about a payslip', 'payroll.answered': 'Answered a payslip question', 'payroll.slip_viewed': 'Opened a payslip', 'payroll.bank_sheet': 'Downloaded the bank sheet',
  'payroll.register': 'Downloaded the payroll register', 'payroll.rules': 'Changed payroll rules',
  'expense.sent': 'Sent an expense claim', 'expense.approved': 'Approved an expense', 'expense.declined': 'Declined an expense',
  'advance.asked': 'Asked for an advance', 'advance.approved': 'Approved an advance', 'advance.declined': 'Declined an advance',
  'team.announcement': 'Posted an announcement', 'team.boost': 'Boosted the team', 'team.boost_quiet': 'Changed who gets the boost show', 'team.chat_created': 'Started a chat', 'settings.idle_rules': 'Changed the idle rules',
  'user.fun_on': 'Turned on god mode for', 'user.fun_off': 'Turned off god mode for',
};
// anything not named above still reads as words, never as a code
const words = (a) => { const t = String(a).replace(/[._]/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const AUDIT_PAGE = 100;
// what kind of thing an entry is about, for the filters and the chip on each row
const AU_KINDS = [['money', 'Money'], ['privacy', 'Privacy'], ['settings', 'Settings'], ['time', 'Time'], ['people', 'People'], ['clients', 'Clients'], ['signin', 'Sign-ins']];
const kindOf = (a) => (/^screenshot|hr\.(viewed|doc_opened)|payroll\.slip_viewed/.test(a) ? 'privacy' : /^(payroll|expense|advance)|hr\.pay/.test(a) ? 'money' : /^(settings|company|holiday|team\.screenshots|policy)/.test(a) ? 'settings'
  : /^(time|timer|timeoff)/.test(a) ? 'time' : /^client/.test(a) ? 'clients' : /^(login|logout|password)/.test(a) ? 'signin' : /^(user|team|hr|project|task)/.test(a) ? 'people' : 'other');
// times stored in an entry's details read as "Sat, Oct 24, 3:00 PM", not as raw ISO stamps
const tidyDetail = (d, tz) => String(d || '').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g, (iso) => { const day = new Date(Date.parse(iso) + tz * 60000).toISOString().slice(0, 10); return `${dayShort(day)}, ${tod(iso, tz)}`; });
const kindChip = (a) => { const k = kindOf(a), n = (AU_KINDS.find((x) => x[0] === k) || [k, 'Other'])[1]; return html`<span class="au-k k-${k}">${n}</span>`; };

export const auditPage = {
  title: 'Audit log',
  // 100 entries a page; "Show older" raises ?n= and the next pages are read with ?before=<id>
  async load(q) {
    const want = Math.min(5000, Math.max(AUDIT_PAGE, Number(q.get('n')) || AUDIT_PAGE));
    const usersP = get('/api/users?all=1');
    const rows = [];
    let more = false;
    while (rows.length < want) {
      const take = Math.min(499, want - rows.length);
      const page = await get(`/api/audit?limit=${take + 1}${rows.length ? `&before=${rows[rows.length - 1].id}` : ''}`);
      more = page.length > take;
      rows.push(...page.slice(0, take));
      if (!more) break;
    }
    return { rows, users: await usersP, more, want };
  },
  render({ rows: all, users, more, want }, q) {
    const name = (id) => (id == null ? '' : (users.find((u) => u.id === id) || {}).name || `#${id}`);
    const tz = S.settings.tz_offset_min;
    const dayOf = (iso) => new Date(Date.parse(iso) + tz * 60000).toISOString().slice(0, 10);
    const kind = q.get('kind') || '';
    const rows = kind ? all.filter((r) => kindOf(r.action) === kind) : all;
    const count = (k) => all.filter((r) => kindOf(r.action) === k).length;
    const today = dayOf(new Date(nowMs()).toISOString());
    let lastDay = null;
    const dayRow = (r) => { const d = dayOf(r.at); if (d === lastDay) return ''; lastDay = d; return html`<tr class="au-day"><th colspan="6">${d === today ? 'Today, ' : ''}${dayShort(d)}</th></tr>`; };
    const who = (r) => (r.actor_id ? html`<span class="au-who"><span class="avatar sm" style="background:${avColor(r.actor_id)}" aria-hidden="true">${initials(r.actor_name || '?')}</span>${r.actor_name}</span>` : html`<span class="au-who"><span class="avatar sm au-sys" aria-hidden="true">${icon('gear')}</span>${r.actor_name || 'System'}</span>`);
    return html`
      <div class="page-h"><div><h1>Audit log</h1><p class="sub">Who changed what, newest first. Deleted and opened screenshots are recorded here too.</p></div>
        <div class="seg au-kinds" role="group" aria-label="Show">${[['', 'Everything', all.length], ...AU_KINDS.map(([k, n]) => [k, n, count(k)])].filter(([k, , n]) => !k || n).map(([k, n, c]) => html`<button type="button" data-act="q" ${raw(qAttr('kind', k))} aria-pressed="${String(kind === k)}">${n}<span class="au-n">${c}</span></button>`)}</div></div>
      <section class="panel flush"><div class="body">${rows.length ? html`<div class="tbl-wrap"><table class="t stack au-t"><thead><tr><th>When</th><th>Who</th><th>What</th><th>About</th><th>Details</th><th>Kind</th></tr></thead><tbody>
        ${rows.map((r) => html`${dayRow(r)}<tr data-k="a${r.id}"><td class="num small nowrap">${tod(r.at, tz)}</td><td class="nowrap">${who(r)}</td><td><b>${LABEL[r.action] || words(r.action)}</b></td><td>${name(r.target_user_id)}</td><td class="au-d">${tidyDetail(r.detail, tz)}</td><td>${kindChip(r.action)}</td></tr>`)}</tbody></table></div>
        <div class="au-more"><span class="muted small">${more ? `Showing the latest ${rows.length}` : `${plural(rows.length, 'entry', 'entries')}, all of them`}</span>${more ? html`<button type="button" class="btn sm" data-act="q" ${raw(qAttr('n', String(want + AUDIT_PAGE)))}>Show ${AUDIT_PAGE} older</button>` : ''}</div>` : empty('Nothing recorded yet', '')}</div></section>`;
  },
};
