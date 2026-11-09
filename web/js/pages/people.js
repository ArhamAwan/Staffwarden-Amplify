import { html, raw, esc, icon, copyText, tzLabel, hhmmText, hoursText, relTime, plural, dur, tzPlace, zoneName, zoneShort, zoneOffset, fmtMin, tod, nowMs } from '../util.js';
import { get, post, patch, del, qs } from '../api.js';
import { S, actions, tag, person, empty, openModal, confirmBox, toast, errMsg, liveTag } from '../ui.js';
import { isMgr, zoneOptions, readZone } from '../parts.js';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
let cache = { users: [], teams: [] };

export default {
  title: 'People',
  async load() {
    const [users, teams, downloads] = await Promise.all([get('/api/users?all=1'), get('/api/teams'), get('/api/downloads').catch(() => [])]);
    S.teams = teams; cache = { users, teams };
    return { users, teams, downloads };
  },
  render({ users, teams, downloads = [] }, q) {
    const owner = S.me.role === 'owner';
    const teamF = q.get('team') || '', show = q.get('show') || 'all';
    const st = S.settings;
    const active = users.filter((u) => u.active);
    const working = (u) => ['working', 'break', 'idle'].includes(u.state);
    const needs = (u) => problems(u, downloads).length > 0;
    const inTeam = active.filter((u) => !teamF || String(u.team_id) === teamF);
    const counts = { all: inTeam.length, working: inTeam.filter(working).length, offline: inTeam.filter((u) => u.tracks_time && !working(u)).length, attention: inTeam.filter(needs).length };
    const list = inTeam.filter((u) => show === 'working' ? working(u) : show === 'offline' ? u.tracks_time && !working(u) : show === 'attention' ? needs(u) : true)
      .sort((a, b) => (working(b) - working(a)) || a.name.localeCompare(b.name));
    const gone = users.filter((u) => !u.active);
    const link = (v, label, n) => html`<a class="pfilter" href="#/people${qs({ team: teamF || null, show: v === 'all' ? null : v })}" ${show === v ? raw('aria-current="true"') : ''} data-k="f${v}">${label}<b class="num">${n}</b></a>`;
    return html`
      <div class="page-h"><div><h1>People</h1><p class="sub">${plural(active.length, 'person', 'people')}${counts.working ? ` · ${counts.working} working now` : ''}</p></div>
        <div class="tools">${owner ? html`<button class="btn" data-act="new-team">New team</button>` : ''}<button class="btn" data-act="edit-user" data-id="">${raw('+')} Add person</button><button class="btn primary" data-act="invite-many">${icon('mail')} Invite people</button></div></div>

      <section class="panel pdefaults"><div class="body">
        <div class="pd-h"><b>Company schedule</b><span class="muted small">Everyone follows this unless their row says otherwise</span>${owner ? html`<a class="small" href="#/settings">Change</a>` : ''}</div>
        <dl class="pd-list">
          <div><dt>Shift</dt><dd class="num">${shiftWords(st.shift_start, st.shift_end)}</dd></div>
          <div><dt>Break</dt><dd class="num">${st.break_start ? `${hhmmText(st.break_start)} – ${hhmmText(st.break_end)}` : 'None set'}</dd></div>
          <div><dt>Days</dt><dd>${daysText(st.work_days)}</dd></div>
          <div><dt>Weekly target</dt><dd class="num">${hoursText(st.weekly_target_min * 60)}</dd></div>
          <div><dt>Screenshots</dt><dd>${st.shots_per_10 === 0 ? 'Off' : shotsText(st.shots_per_10)}</dd></div>
          <div><dt>Time zone</dt><dd>${tzPlace(st.tz_name, st.tz_offset_min)}</dd></div>
        </dl></div></section>

      <div class="pbar">
        <nav class="pfilters" aria-label="Show">${link('all', 'Everyone', counts.all)}${link('working', 'Working now', counts.working)}${link('offline', 'Not working', counts.offline)}${link('attention', 'Needs attention', counts.attention)}</nav>
        <div class="pbar-r">
          <label class="psearch"><span class="sr">Find a person</span>${icon('search')}<input type="search" id="pfind" placeholder="Find by name or email" autocomplete="off" data-find></label>
          ${teams.length ? html`<label class="sr" for="tf">Team</label><select id="tf" data-q="team"><option value="">All teams</option>${teams.map((t) => html`<option value="${t.id}" ${String(t.id) === teamF ? raw('selected') : ''}>${t.name}</option>`)}</select>` : ''}
        </div>
      </div>

      <section class="panel flush plist-panel">${list.length ? html`<ul class="plist"><li class="prow phead" aria-hidden="true"><span>Person</span><span>Right now</span><span>Differs from the company schedule</span><span>Desktop app</span><span></span></li>${list.map((u) => personRow(u, teams, downloads, st))}</ul>`
        : empty(show === 'all' ? 'No one here yet' : 'No one matches', show === 'all' ? 'Add your first team member with the button above.' : 'Try another filter.')}</section>

      ${gone.length ? html`<details class="panel pgone" data-k="gone"><summary>Deactivated <span class="muted">${gone.length}</span></summary><ul class="plist">${gone.map((u) => personRow(u, teams, downloads, st))}</ul></details>` : ''}

      <section class="panel"><header><h2>Teams</h2><span class="muted small">Managers only see the teams they are assigned to</span></header><div class="body">
        ${teams.length ? html`<div class="tcards">${teams.map((t) => html`<div class="tcard" data-k="t${t.id}">
          <div class="tc-h"><b>${t.name}</b><span class="muted small">${plural(t.members, 'member')}</span></div>
          <p class="small muted">${t.managers.length ? 'Managed by ' + t.managers.map((m) => m.name).join(', ') : 'No manager assigned'}<br>Screenshots: ${t.shots_per_10 == null ? 'company default' : shotsText(t.shots_per_10)}</p>
          ${owner ? html`<div class="tc-a"><button class="linkbtn" data-act="team-shots" data-id="${t.id}" data-name="${t.name}" data-v="${t.shots_per_10 ?? ''}">Screenshots</button><button class="linkbtn" data-act="rename-team" data-id="${t.id}" data-name="${t.name}">Rename</button><button class="linkbtn danger" data-act="del-team" data-id="${t.id}" data-name="${t.name}">Delete</button></div>` : ''}
        </div>`)}</div>` : empty('No teams yet', owner ? 'Teams let you give each manager their own group of people. Create one with New team.' : 'No teams yet.')}</div></section>`;
  },
};

// Finding a person filters the list as you type, without reloading (and survives live refreshes).
let findStyle = null;
document.addEventListener('input', (e) => {
  if (!e.target || !e.target.matches || !e.target.matches('input[data-find]')) return;
  if (!findStyle) { findStyle = document.createElement('style'); document.head.appendChild(findStyle); }
  const v = e.target.value.trim().toLowerCase().replace(/["\\]/g, '');
  findStyle.textContent = v ? `.prow[data-find]:not([data-find*="${v}"]) { display: none; }` : '';
});

// ---------- one person ----------
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function daysText(wd) {
  const d = String(wd || '').split(',').filter(Boolean).map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (!d.length) return 'None';
  const idx = d.map((x) => (x + 6) % 7);           // Monday = 0
  const run = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return run && d.length > 2 ? `${DAY_SHORT[d[0]]} – ${DAY_SHORT[d[d.length - 1]]}` : d.map((x) => DAY_SHORT[x]).join(', ');
}
function shiftWords(a, b) {
  if (!a || !b) return '–';
  return `${hhmmText(a)} – ${hhmmText(b)}`;
}
// ---------- different hours on some days (a half day on Saturday) ----------
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hm = (v) => { if (!v) return null; const [h, m] = v.split(':').map(Number); return h * 60 + m; };
// minutes of work in a shift: its length less its break
const lenOf = (s, e, bs, be) => {
  if (hm(s) == null || hm(e) == null || s === e) return null;
  const len = ((hm(e) - hm(s)) + 1440) % 1440 || 1440;
  const b = hm(bs) != null && hm(be) != null && bs !== be ? ((hm(be) - hm(bs)) + 1440) % 1440 : 0;
  return Math.max(0, len - b);
};
function dhRow(day, h = {}) {
  return html`<div class="dh-row">
    <label class="dh-f"><span>Day</span><select name="dh_day">${DAYS.map(([v, n]) => html`<option value="${v}" ${v === day ? raw('selected') : ''}>${DAY_LONG[v]}</option>`)}</select></label>
    <label class="dh-f"><span>Starts</span><input type="time" name="dh_s" value="${h.shift_start || ''}"></label>
    <label class="dh-f"><span>Ends</span><input type="time" name="dh_e" value="${h.shift_end || ''}"></label>
    <button type="button" class="btn icon dh-del" data-act="dh-del" aria-label="Remove this day" title="Remove this day">${icon('trash')}</button>
    <div class="dh-brk"><span>Break (optional)</span><input type="time" name="dh_bs" aria-label="Break starts" value="${h.break_start || ''}"><span aria-hidden="true">to</span><input type="time" name="dh_be" aria-label="Break ends" value="${h.break_end || ''}"></div>
  </div>`;
}
function dhSection(u) {
  const rows = Object.entries((u && u.day_hours) || {}).sort(([a], [b]) => ((Number(a) + 6) % 7) - ((Number(b) + 6) % 7));
  return html`<div class="dh">
    <div class="dh-head"><div><h3>Different hours on some days</h3><p class="hint">For a half day on Saturday, say. That day expects its own hours, the other working days share the rest of the weekly target, and the desktop app follows these hours on that day.</p></div>
      <button type="button" class="btn sm" data-act="dh-add">${icon('plus')} Add a day</button></div>
    <div class="dh-list${rows.length ? '' : ' empty'}">${rows.map(([d, h]) => dhRow(Number(d), h))}</div>
    <p class="dh-sum small" aria-live="polite"></p></div>`;
}
// The line under the list: what each day now expects.
function dhUpdate(form) {
  const list = form.querySelector('.dh-list'), sum = form.querySelector('.dh-sum');
  if (!list || !sum) return;
  const rows = [...list.querySelectorAll('.dh-row')];
  list.classList.toggle('empty', !rows.length);
  if (!rows.length) { sum.textContent = ''; return; }
  const weekly = form.weekly_h.value === '' ? S.settings.weekly_target_min : Math.round(Number(form.weekly_h.value) * 60);
  const days = new Set([...form.querySelectorAll('input[name="wd"]:checked')].map((i) => Number(i.value)));
  const special = new Map();
  for (const r of rows) {
    const d = Number(r.querySelector('[name="dh_day"]').value);
    special.set(d, lenOf(r.querySelector('[name="dh_s"]').value, r.querySelector('[name="dh_e"]').value, r.querySelector('[name="dh_bs"]').value, r.querySelector('[name="dh_be"]').value));
    days.add(d);
  }
  const parts = [...special].map(([d, m]) => `${DAY_LONG[d]}: ${m == null ? 'add a start and an end' : dur(m * 60)}`);
  const known = [...special.values()].filter((m) => m != null).reduce((a, b) => a + b, 0);
  const others = [...days].filter((d) => !special.has(d)).length;
  if (others) parts.push(`other working days: ${dur(Math.round(Math.max(0, weekly - known) / others) * 60)} each`);
  sum.textContent = `Expected ${parts.join(' · ')} (${hoursText(weekly * 60)} a week)`;
}
const tickDay = (form, d) => { const box = form.querySelector(`input[name="wd"][value="${d}"]`); if (box) box.checked = true; };
actions['dh-add'] = (el) => {
  const form = el.closest('form'), list = form.querySelector('.dh-list');
  const used = new Set([...list.querySelectorAll('[name="dh_day"]')].map((s) => Number(s.value)));
  const day = [6, 0, 5, 1, 2, 3, 4].find((d) => !used.has(d));
  if (day == null) return;
  list.insertAdjacentHTML('beforeend', dhRow(day, { shift_start: form.shift_start.value || S.settings.shift_start }).toString());
  const row = list.lastElementChild;
  row.classList.add('dh-new');
  tickDay(form, day);
  row.querySelector('[name="dh_e"]').focus();
  dhUpdate(form);
};
actions['dh-del'] = (el) => {
  const form = el.closest('form'), row = el.closest('.dh-row');
  row.classList.add('dh-out');
  setTimeout(() => { row.remove(); dhUpdate(form); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
};
document.addEventListener('input', (e) => { const f = e.target.closest && e.target.closest('form.modal'); if (!f || !f.querySelector('.dh-list')) return; if (e.target.closest('.dh-row')) { const er = f.querySelector('.err'); if (er) er.textContent = ''; } dhUpdate(f); });
document.addEventListener('change', (e) => { const f = e.target.closest && e.target.closest('form.modal'); if (!f || !f.querySelector('.dh-list')) return; if (e.target.name === 'dh_day') tickDay(f, Number(e.target.value)); dhUpdate(f); });
// Read the rows back; throws a message the dialog shows when something is missing.
function readDayHours(form) {
  const out = {};
  for (const r of form.querySelectorAll('.dh-row')) {
    const v = (n) => r.querySelector(`[name="${n}"]`).value || null;
    const d = Number(v('dh_day'));
    if (out[d]) throw new Error(`${DAY_LONG[d]} is listed twice`);
    if (!v('dh_s') || !v('dh_e')) throw new Error(`Give ${DAY_LONG[d]} a start and an end time`);
    if (v('dh_s') === v('dh_e')) throw new Error(`${DAY_LONG[d]} starts and ends at the same time`);
    if (!v('dh_bs') !== !v('dh_be')) throw new Error(`Give the ${DAY_LONG[d]} break both a start and an end, or leave both blank`);
    out[d] = { shift_start: v('dh_s'), shift_end: v('dh_e'), break_start: v('dh_bs'), break_end: v('dh_be') };
  }
  return out;
}

const ROLE = { owner: 'Owner', manager: 'Manager', employee: 'Employee' };

// The newest version on the server for this person's computer, if theirs is older.
function latestFor(u, downloads) {
  const kind = KIND_OF(u.app_platform);
  const latest = downloads.filter((d) => d.kind === kind && d.version).map((d) => d.version).sort((x, y) => cmpV(y, x))[0];
  return latest && u.app_version && cmpV(latest, u.app_version) > 0 ? latest : null;
}

// Things the owner may want to act on for this person.
function problems(u, downloads) {
  if (!u.active || !u.tracks_time) return [];
  const out = [];
  if (!u.consented) out.push({ kind: 'policy', text: 'Has not accepted the policy' });
  if (!u.app_version) out.push({ kind: 'app', text: 'No desktop app yet' });
  else if (latestFor(u, downloads)) out.push({ kind: 'app', text: `Update to ${latestFor(u, downloads)}` });
  return out;
}

// What is different for this person from the company schedule.
function differences(u, teams, st) {
  const e = u.effective, out = [];
  if (u.team) out.push(`Team: ${u.team}`);
  if (u.role === 'manager') out.push(u.manages.length ? 'Manages ' + u.manages.map((id) => (teams.find((t) => t.id === id) || {}).name).filter(Boolean).join(', ') : 'Sees everyone');
  if (!u.tracks_time) return out;
  if (e.shift_start !== st.shift_start || e.shift_end !== st.shift_end) out.push(`Shift ${shiftWords(e.shift_start, e.shift_end)}`);
  if ((e.break_start || null) !== (st.break_start || null) || (e.break_end || null) !== (st.break_end || null)) out.push(e.break_start ? `Break ${hhmmText(e.break_start)} – ${hhmmText(e.break_end)}` : 'No break');
  if (u.work_days && u.work_days !== st.work_days) out.push(daysText(u.work_days));
  for (const [d, h] of Object.entries(u.day_hours || {}).sort(([a], [b]) => ((Number(a) + 6) % 7) - ((Number(b) + 6) % 7))) out.push(`${DAY_SHORT[d]} ${shiftWords(h.shift_start, h.shift_end)}`);
  if (e.weekly_target_min !== st.weekly_target_min) out.push(`${hoursText(e.weekly_target_min * 60)} a week`);
  if (e.shots_source !== 'company') out.push(`Screenshots ${e.shots_per_10 === 0 ? 'off' : shotsText(e.shots_per_10)}${e.shots_source === 'team' ? ' (team)' : ''}`);
  if ((e.tz_name || null) !== (st.tz_name || null) || e.tz_offset_min !== st.tz_offset_min) out.push(`${e.tz_name ? zoneShort(e.tz_name) + ' time' : tzLabel(e.tz_offset_min)}, ${tod(new Date(nowMs()).toISOString(), e.tz_offset_min)} there now`);
  if (u.other_device) out.push('Works on another device');
  return out;
}

function statusOf(u) {
  if (!u.active) return html`${tag('off', 'Deactivated')}`;
  if (u.invited) return html`${tag('late', 'Invited')}<span class="ps-seen small muted">Sent ${relTime(u.invited_at)}, not joined yet</span>`;
  if (!u.tracks_time) return html`<span class="faint small">Does not track time</span>`;
  const label = { working: ['working', 'Working'], break: ['break', 'On a break'], idle: ['idle', 'Idle'], no_signal: ['no_signal', 'No signal'] }[u.state];
  const seen = u.last_seen_at ? (Date.now() - Date.parse(u.last_seen_at) < 90000 ? 'Active just now' : `Last active ${relTime(u.last_seen_at)}`) : 'No work tracked yet';
  return html`${label ? tag(label[0], label[1]) : tag('offline', 'Not working')}<span class="ps-seen small muted">${seen}</span>`;
}

function personRow(u, teams, downloads, st) {
  const diffs = differences(u, teams, st), probs = problems(u, downloads);
  const kind = KIND_OF(u.app_platform);
  return html`<li class="prow${u.active ? '' : ' off'}" data-k="u${u.id}" data-find="${(u.name + ' ' + u.email + ' ' + (u.title || '')).toLowerCase()}">
    <div class="pr-who">${person({ id: u.id, name: u.name }, u.title || u.email)}${u.role !== 'employee' || u.hr || u.is_dev ? html`<span class="pr-tags">${u.role !== 'employee' ? html`<span class="prole ${u.role}">${ROLE[u.role]}</span>` : ''}${u.hr ? html`<span class="prole hr">HR</span>` : ''}${u.is_dev ? html`<span class="prole dev">Developer</span>` : ''}</span>` : ''}</div>
    <div class="pr-state">${statusOf(u)}</div>
    <div class="pr-info">${diffs.length ? html`<ul class="pchips">${diffs.map((d) => html`<li>${d}</li>`)}</ul>` : (u.tracks_time ? html`<span class="faint small">Company schedule</span>` : '')}
      ${probs.some((p) => p.kind === 'policy') ? html`<ul class="pflags"><li class="warn">Has not accepted the policy</li></ul>` : ''}</div>
    <div class="pr-app small">${u.app_version ? html`<span class="num">${u.app_version}${kind ? ' · ' + OS_NAME[kind] : ''}</span>${latestFor(u, downloads) ? html`<span class="pupd">Update to ${latestFor(u, downloads)}</span>` : html`<span class="faint">Up to date</span>`}` : u.tracks_time ? html`<span class="faint">Not installed</span>` : ''}</div>
    <div class="pr-act">${u.invited && u.active ? html`<button type="button" class="btn sm" data-act="invite-again" data-id="${u.id}" data-name="${u.name}">Invite again</button>` : ''}${u.tracks_time && u.active && !u.invited ? html`<a class="btn sm" href="#/timeline?user=${u.id}">View day</a>` : ''}${(u.role === 'owner' && (S.me.dev_owner || S.me.role !== 'owner')) || (u.is_dev && S.me.role !== 'owner' && u.id !== S.me.id) ? '' : html`<button class="btn sm" data-act="edit-user" data-id="${u.id}">Edit</button>`}${S.me.role === 'owner' && u.active && u.role !== 'owner' ? html`<button class="btn sm${u.fun_mode ? ' gm-on-btn' : ''}" data-act="fun-edit" data-id="${u.id}" data-name="${u.name}" aria-label="Fun modes for ${u.name}" title="Fun modes">${u.fun_mode ? 'God mode' : 'Fun'}</button>` : ''}</div>
  </li>`;
}


// Which desktop app version the person last used, and whether a newer one is on the server.
const cmpV = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const KIND_OF = (p) => (/^win32/.test(p || '') ? 'windows' : /^darwin arm64/.test(p || '') ? 'mac-arm' : /^darwin/.test(p || '') ? 'mac-intel' : null);
const OS_NAME = { windows: 'Windows', 'mac-arm': 'Mac', 'mac-intel': 'Mac' };

// Screenshots per 10 minutes, as words.
export const shotsText = (n) => (n === 0 ? 'Off' : n === 1 ? '1 per 10 min' : `${n} per 10 min`);
const SOURCE = { person: 'set for this person', team: 'from their team', company: 'company default' };
function shotsOptions(cur, inherited, inheritLabel) {
  return html`<option value="" ${cur == null ? raw('selected') : ''}>${inheritLabel}: ${shotsText(inherited)}</option>
    ${[[0, 'Off (time is still tracked)'], [1, '1 per 10 minutes'], [2, '2 per 10 minutes'], [3, '3 per 10 minutes']].map(([v, t]) => html`<option value="${v}" ${cur === v ? raw('selected') : ''}>${t}</option>`)}`;
}

// The zone their own computer reported, when it differs from the one Staffwarden uses for them.
function seenHint(u) {
  if (!u || !u.seen_tz || zoneOffset(u.seen_tz) == null || zoneOffset(u.seen_tz) === u.effective.tz_offset_min) return '';
  return html`<p class="hint tz-seen">Their computer is set to ${zoneName(u.seen_tz)} time. <button type="button" class="linkbtn" data-act="tz-use" data-z="${u.seen_tz}">Use it</button></p>`;
}
actions['tz-use'] = (el) => {
  const sel = el.closest('form').querySelector('[data-tz]'), v = `z:${el.dataset.z}`;
  if (![...sel.options].some((o) => o.value === v)) sel.add(new Option(`${el.dataset.z.replace(/_/g, ' ')} · ${tzLabel(zoneOffset(el.dataset.z))}`, v));
  sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true }));
  el.closest('.tz-seen').remove();
};
// Shift times are in the person's own zone; this says what that is in company time.
function tzHint(form) {
  const out = form.querySelector('[data-tzhint]'); if (!out) return;
  const sel = form.querySelector('[data-tz]'), v = sel.value, st = S.settings;
  const theirs = v.startsWith('z:') ? zoneOffset(v.slice(2)) : v.startsWith('o:') ? Number(v.slice(2)) : (st.tz_name ? zoneOffset(st.tz_name) : st.tz_offset_min);
  const ours = st.tz_name ? zoneOffset(st.tz_name) : st.tz_offset_min;
  const where = v.startsWith('z:') ? zoneShort(v.slice(2)) : v.startsWith('o:') ? tzLabel(theirs) : null;
  const toMin = (x) => { const [h, m] = String(x).split(':').map(Number); return h * 60 + m; };
  const s = form.querySelector('[name=shift_start]').value || st.shift_start, e = form.querySelector('[name=shift_end]').value || st.shift_end;
  if (!where || theirs === ours) { out.textContent = 'Shift and break times are in the company time zone.'; return; }
  const d = ours - theirs, sh = (x) => fmtMin((((toMin(x) + d) % 1440) + 1440) % 1440);
  const company = st.tz_name ? `${zoneShort(st.tz_name)} time` : 'company time';
  out.textContent = `Shift and break times are in ${where} time. ${hhmmText(s)} to ${hhmmText(e)} there is ${sh(s)} to ${sh(e)} in ${company} today.`;
}
document.addEventListener('change', (e) => { const f = e.target.closest && e.target.closest('form.modal'); if (f && f.querySelector('[data-tzhint]') && (e.target.matches('[data-tz]') || /^shift_/.test(e.target.name))) tzHint(f); });
document.addEventListener('input', (e) => { const f = e.target.closest && e.target.closest('form.modal'); if (f && f.querySelector('[data-tzhint]') && /^shift_/.test(e.target.name)) tzHint(f); });

actions['edit-user'] = (el) => {
  const id = el.dataset.id ? Number(el.dataset.id) : null;
  const u = id ? cache.users.find((x) => x.id === id) : null;
  const owner = S.me.role === 'owner';
  const wd = new Set(String((u && u.work_days) || S.settings.work_days).split(',').filter(Boolean).map(Number));
  const editingOwner = u && u.role === 'owner';
  const m = openModal({
    title: u ? `Edit ${u.name}` : 'Add a person', submit: u ? 'Save changes' : 'Add person', wide: true,
    body: html`
      <div class="grid2"><div class="field"><label class="f" for="pn">Full name</label><input id="pn" name="name" value="${u ? u.name : ''}" required maxlength="100"></div>
        <div class="field"><label class="f" for="pt">Job title</label><input id="pt" name="title" value="${(u && u.title) || ''}" maxlength="100"></div></div>
      <div class="grid2"><div class="field"><label class="f" for="pe">Work email</label><input id="pe" name="email" type="email" value="${u ? u.email : ''}" ${u ? raw('disabled') : raw('required')} autocomplete="off"></div>
        ${u ? html`<div class="field"><label class="f" for="pp">Reset password (optional)</label><input id="pp" name="password" type="text" minlength="10" autocomplete="off" placeholder="At least 10 characters"></div>`
          : html`<div class="field"><label class="f" for="phow">How they get in</label><select id="phow" name="how"><option value="invite" selected>Email them an invite</option><option value="password">Give them a password</option></select>
            <input id="pp" name="password" type="text" minlength="10" autocomplete="off" placeholder="First password, at least 10 characters" aria-label="First password" hidden style="margin-top:8px">
            <p class="hint" id="phow-h">They choose their own password from the email, and see what is tracked before they join.</p></div>`}</div>
      <div class="grid3"><div class="field"><label class="f" for="ptm">Team</label><select id="ptm" name="team_id"><option value="">No team</option>${cache.teams.map((t) => html`<option value="${t.id}" ${u && u.team_id === t.id ? raw('selected') : ''}>${t.name}</option>`)}</select></div>
        <div class="field"><label class="f" for="pr">Role</label><select id="pr" name="role" ${owner && !editingOwner ? '' : raw('disabled')}><option value="employee" ${!u || u.role === 'employee' ? raw('selected') : ''}>Employee</option><option value="manager" ${u && u.role === 'manager' ? raw('selected') : ''}>Manager</option>${editingOwner ? html`<option selected>Owner</option>` : ''}</select></div>
        <div class="field"><label class="f" for="pw">Weekly target (hours)</label><input id="pw" name="weekly_h" type="number" min="0" max="100" step="0.5" value="${u && u.weekly_target_min != null ? u.weekly_target_min / 60 : ''}" placeholder="${S.settings.weekly_target_min / 60} (company)"></div></div>
      <div class="grid2"><div class="field"><label class="f" for="psh">Screenshots</label><select id="psh" name="shots" ${owner ? '' : raw('disabled')}>${shotsOptions(u ? u.shots_per_10 : null, (() => { const t = cache.teams.find((x) => u && x.id === u.team_id); return t && t.shots_per_10 != null ? t.shots_per_10 : S.settings.shots_per_10; })(), (() => { const t = cache.teams.find((x) => u && x.id === u.team_id); return t && t.shots_per_10 != null ? 'Same as their team' : 'Company default'; })())}</select>
        <p class="hint">${owner ? 'Taken at random moments in every 10 minutes while their timer runs. Off still tracks their time and activity.' : 'Only the owner changes screenshots and tracking.'}</p></div></div>
      <div class="field check"><input id="pod" type="checkbox" name="other_device" ${u && u.other_device ? raw('checked') : ''} ${owner ? '' : raw('disabled')}><label for="pod">Works on another device, like an iPad</label></div>
      <p class="hint" style="margin:-6px 0 14px">Their computer keeps the timer but sits unused. While the timer is on, the desktop app keeps that computer awake, does not mark idle time and does not measure keyboard and mouse activity. Screenshots of that computer show little, so you may want to turn them off. Needs desktop app 0.9.13 or later.</p>
      <h3 style="margin:6px 0 10px">Schedule</h3>
      <div class="field"><label class="f" for="pz">Time zone</label><select id="pz" name="tz" data-tz>${zoneOptions(u ? u.tz_name : null, { fixed: u ? u.tz_offset_min : null, inherit: `Company default: ${tzPlace(S.settings.tz_name, S.settings.tz_offset_min)}` })}</select>${seenHint(u)}</div>
      <div class="grid2"><div class="field"><label class="f" for="ps">Shift starts</label><input id="ps" type="time" name="shift_start" value="${(u && u.shift_start) || ''}"><p class="hint">Blank: ${hhmmText(S.settings.shift_start)}</p></div>
        <div class="field"><label class="f" for="pe2">Shift ends</label><input id="pe2" type="time" name="shift_end" value="${(u && u.shift_end) || ''}"><p class="hint">Blank: ${hhmmText(S.settings.shift_end)}</p></div></div>
      <div class="grid2"><div class="field"><label class="f" for="pbs">Break starts</label><input id="pbs" type="time" name="break_start" value="${(u && u.break_start) || ''}"><p class="hint">Blank: ${S.settings.break_start ? hhmmText(S.settings.break_start) : 'company (no fixed break)'}</p></div>
        <div class="field"><label class="f" for="pbe">Break ends</label><input id="pbe" type="time" name="break_end" value="${(u && u.break_end) || ''}"><p class="hint">Blank: ${S.settings.break_end ? hhmmText(S.settings.break_end) : 'company (no fixed break)'}</p></div></div>
      <p class="hint tz-hint" data-tzhint></p>
      <div class="field"><span class="f" style="display:block">Working days</span><div class="chips">${DAYS.map(([v, n]) => html`<label class="chip" style="display:inline-flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" name="wd" value="${v}" ${wd.has(v) ? raw('checked') : ''}> ${n}</label>`)}</div></div>
      ${dhSection(u)}
      ${u && (u.role !== 'employee' || owner) ? html`<div class="field check"><input id="ptr" type="checkbox" name="tracks" ${u.tracks_time ? raw('checked') : ''} ${owner ? '' : raw('disabled')}><label for="ptr">${u.role === 'employee' ? 'Tracks their time with the desktop app. Untick for a test or developer account: it then stays out of attendance, the dashboard and everyone’s lists.' : 'This person also tracks their own time with the desktop app'}</label></div>` : ''}
      ${owner && !editingOwner ? html`<div class="field check"><input id="phr" type="checkbox" name="hr" ${u && u.hr ? raw('checked') : ''}><label for="phr">In HR: sees people’s records, pay and time off, and runs payroll. Never screenshots or activity.</label></div>` : ''}
      ${owner && !S.me.dev_owner && u ? html`<div class="field check"><input id="pdev" type="checkbox" name="is_dev" ${u.is_dev ? raw('checked') : ''}><label for="pdev">${editingOwner ? 'Show me the developer pages: server health, desktop app releases, error reports and test tools.' : 'Developer access: everything you see and can do, including screenshots, activity, pay and HR records, plus the developer tools. They can’t change your account or give this access to anyone. Everyone is told.'}</label></div>` : ''}
      ${owner && !editingOwner ? html`<div class="field"><span class="f" style="display:block">Teams this person manages</span><div class="chips">${cache.teams.map((t) => html`<label class="chip" style="display:inline-flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" name="mg" value="${t.id}" ${u && u.manages.includes(t.id) ? raw('checked') : ''}> ${t.name}</label>`)}</div><p class="hint">Only used for managers. A manager with no team ticked sees everyone.</p></div>` : ''}
      ${u && u.id !== S.me.id && !editingOwner ? html`<div class="field"><button type="button" class="btn ${u.active ? 'danger' : ''}" data-act="toggle-active" data-id="${u.id}" data-active="${u.active ? 1 : 0}" data-name="${u.name}">${u.active ? 'Deactivate this account' : 'Reactivate this account'}</button><p class="hint">${u.active ? 'They are signed out and can no longer track time. Their history stays.' : 'They can sign in and track time again.'}</p></div>` : ''}`,
    onSubmit: async (fd, form) => {
      const dh = readDayHours(form);
      // a day with its own hours is a working day
      const wdv = [...new Set([...fd.getAll('wd').map(Number), ...Object.keys(dh).map(Number)])].sort();
      const defWd = String(S.settings.work_days).split(',').map(Number).sort();
      const sameWd = wdv.length === defWd.length && wdv.every((v, i) => v === defWd[i]);
      const num = (k) => (fd.get(k) === '' || fd.get(k) == null ? null : Number(fd.get(k)));
      const sched = {
        ...(readZone(String(fd.get('tz') || '')) || {}), shift_start: fd.get('shift_start') || null, shift_end: fd.get('shift_end') || null,
        break_start: fd.get('break_start') || null, break_end: fd.get('break_end') || null,
        work_days: sameWd ? null : wdv.join(','), weekly_target_min: fd.get('weekly_h') === '' ? null : Math.round(Number(fd.get('weekly_h')) * 60),
        day_hours: Object.keys(dh).length ? dh : null,
      };
      if (!wdv.length) throw new Error('Pick at least one working day');
      if (!fd.get('break_start') !== !fd.get('break_end')) throw new Error('Give the break both a start and an end, or leave both blank');
      const team_id = fd.get('team_id') ? Number(fd.get('team_id')) : null;
      if (!u) {
        const { day_hours, ...firstSched } = sched;
        const invite = fd.get('how') !== 'password';
        if (!invite && String(fd.get('password') || '').length < 10) throw new Error('Give a first password of at least 10 characters');
        const made = await post('/api/users', { email: fd.get('email'), name: fd.get('name'), ...(invite ? { invite: true } : { password: fd.get('password') }), title: fd.get('title') || null, role: fd.get('role') || 'employee', team_id, ...firstSched });
        if (made.invite_link) setTimeout(() => showInviteLink(fd.get('name'), made.invite_link), 50);
        const extra = { ...(owner && fd.get('hr') ? { hr: true } : {}), ...(day_hours ? { day_hours } : {}), ...(owner && fd.get('shots') ? { shots_per_10: Number(fd.get('shots')) } : {}), ...(owner && fd.get('other_device') ? { other_device: true } : {}) };
        if (Object.keys(extra).length) await patch(`/api/users/${made.id}`, extra);
        if (owner && fd.get('role') === 'manager') { /* managers are assigned teams on the next edit */ }
        toast(invite ? (made.invite_sent ? `Invite sent to ${fd.get('email')}` : `${fd.get('name')} added`) : `${fd.get('name')} added`);
      } else {
        const body = { name: fd.get('name'), title: fd.get('title') || null, team_id, ...sched, ...(owner ? { shots_per_10: fd.get('shots') === '' ? null : Number(fd.get('shots')), other_device: !!fd.get('other_device') } : {}) };
        if (fd.get('password')) body.password = fd.get('password');
        if (owner && !editingOwner) { body.role = fd.get('role'); body.manages = fd.getAll('mg').map(Number); body.hr = !!fd.get('hr'); }
        if (owner && u && !S.me.dev_owner && !!fd.get('is_dev') !== !!u.is_dev) body.is_dev = !!fd.get('is_dev');
        if (owner && !!fd.get('tracks') !== !!u.tracks_time) body.tracks_time = !!fd.get('tracks');
        await patch(`/api/users/${u.id}`, body);
        toast('Saved');
      }
      S.refresh();
    },
  });
  const f = [...document.querySelectorAll('#overlay form.modal')].pop();
  if (f) { dhUpdate(f); tzHint(f); }
  return m;
};
actions['toggle-active'] = async (el) => {
  const active = el.dataset.active === '1';
  if (active && !(await confirmBox({ title: `Deactivate ${el.dataset.name}?`, message: 'They will be signed out and cannot track time until you reactivate them. Their history is kept.', confirm: 'Deactivate', danger: true }))) return;
  try { await patch(`/api/users/${el.dataset.id}`, { active: !active }); toast(active ? 'Deactivated' : 'Reactivated'); document.querySelectorAll('#overlay .scrim').forEach((s) => s.remove()); S.refresh(); }
  catch (e) { toast(errMsg(e), true); }
};
actions['new-team'] = () => openModal({
  title: 'New team', submit: 'Create team',
  body: html`<div class="field"><label class="f" for="tn">Team name</label><input id="tn" name="name" maxlength="80" required placeholder="Design"></div>`,
  onSubmit: async (fd) => { await post('/api/teams', { name: fd.get('name') }); toast('Team created'); S.refresh(); },
});
actions['team-shots'] = (el) => openModal({
  title: `Screenshots for ${el.dataset.name}`, submit: 'Save',
  body: html`<div class="field"><label class="f" for="tsh">Screenshots per 10 minutes</label><select id="tsh" name="shots">${shotsOptions(el.dataset.v === '' ? null : Number(el.dataset.v), S.settings.shots_per_10, 'Company default')}</select>
    <p class="hint">Applies to everyone in this team, unless a person has their own setting.</p></div>`,
  onSubmit: async (fd) => { await patch(`/api/teams/${el.dataset.id}`, { shots_per_10: fd.get('shots') === '' ? null : Number(fd.get('shots')) }); toast('Saved'); S.refresh(); },
});
actions['rename-team'] = (el) => openModal({
  title: 'Rename team', submit: 'Rename',
  body: html`<div class="field"><label class="f" for="tn">Team name</label><input id="tn" name="name" maxlength="80" required value="${el.dataset.name}"></div>`,
  onSubmit: async (fd) => { await patch(`/api/teams/${el.dataset.id}`, { name: fd.get('name') }); toast('Renamed'); S.refresh(); },
});
actions['del-team'] = async (el) => {
  if (!(await confirmBox({ title: `Delete the ${el.dataset.name} team?`, message: 'People in it are kept, but will have no team.', confirm: 'Delete team', danger: true }))) return;
  try { await del(`/api/teams/${el.dataset.id}`); toast('Team deleted'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};

// adding someone: an emailed invite, or a first password typed here
document.addEventListener('change', (e) => {
  const how = e.target.closest && e.target.closest('#phow');
  if (!how) return;
  const f = how.closest('form'), pw = f.querySelector('#pp'), hint = f.querySelector('#phow-h');
  pw.hidden = how.value !== 'password';
  if (how.value === 'password') pw.focus();
  hint.textContent = how.value === 'password' ? 'Share it with them. They can change it from their profile.' : 'They choose their own password from the email, and see what is tracked before they join.';
});
// email isn't set up: the link to pass on yourself
function showInviteLink(name, link) {
  const m = openModal({
    title: `Send ${String(name).split(' ')[0]} their invite`, submit: 'Copy the link', cancel: 'Done',
    body: html`<p>Email isn’t set up on this server, so send this link yourself, by chat or email. It works once, for 7 days.</p><input class="mt" readonly value="${link}" aria-label="Invite link" style="font-size:13px">`,
    onSubmit: async () => { if (!(await copyText(link))) throw new Error('Couldn’t copy. Select the link above and copy it.'); toast('Link copied'); },
  });
  const i = m.form.querySelector('input'); i.addEventListener('focus', () => i.select());
}
actions['invite-again'] = async (el) => {
  el.disabled = true;
  try {
    const r = await post(`/api/users/${el.dataset.id}/invite`);
    if (r.link) showInviteLink(el.dataset.name, r.link); else toast(`A new invite is on its way to ${el.dataset.name.split(' ')[0]}`);
  } catch (e) { toast(errMsg(e), true); }
  el.disabled = false;
};

// invite many at once: paste their emails, each gets an email to join (or a link to pass on)
const nameFrom = (email) => email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 100) || email;
actions['invite-many'] = () => {
  const m = openModal({
    title: 'Invite people', submit: 'Send invites', wide: true, sub: 'Each person gets an email to join. They set their own password and see what is tracked before they start.',
    body: html`<div class="field"><label class="f" for="iv-em">Their work emails</label><textarea id="iv-em" name="emails" rows="5" placeholder="liam@company.com, olivia@company.com" required></textarea>
        <p class="hint" id="iv-h">Paste a list from a spreadsheet, or type them separated by commas or new lines.</p></div>
      <div class="field" style="max-width:260px"><label class="f" for="iv-tm">Team</label><select id="iv-tm" name="team_id"><option value="">No team</option>${cache.teams.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></div>
      <div id="iv-out"></div>`,
    onSubmit: async (fd, form) => {
      const list = [...new Set(String(fd.get('emails') || '').split(/[\s,;<>"()]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
      const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e));
      if (!list.length) throw new Error('Type at least one email');
      if (bad.length) throw new Error(`${bad.join(', ')} ${bad.length === 1 ? 'doesn’t' : 'don’t'} look complete. Check the part after the @.`);
      const team_id = fd.get('team_id') ? Number(fd.get('team_id')) : null;
      const links = [], failed = [];
      let sent = 0;
      for (const email of list) {
        try { const r = await post('/api/users', { email, name: nameFrom(email), role: 'employee', team_id, invite: true }); if (r.invite_link) links.push([email, r.invite_link]); else sent++; }
        catch (e) { failed.push(`${email}: ${errMsg(e)}`); }
      }
      S.refresh();
      const out = form.querySelector('#iv-out');
      out.innerHTML = html`${sent ? html`<p class="banner info" style="margin:0 0 10px"><span>${sent === 1 ? '1 invite sent' : `${sent} invites sent`}.</span></p>` : ''}
        ${links.length ? html`<p class="hint">Email isn’t set up on this server, so send each person their link yourself. Each works once, for 7 days.</p><ul class="iv-links">${links.map(([e, l], i) => html`<li><span>${e}</span><button type="button" class="btn sm" data-iv-copy="${i}">Copy link</button></li>`)}</ul>` : ''}
        ${failed.length ? html`<p class="err">${failed.join(' ')}</p>` : ''}`.toString();
      out.querySelectorAll('[data-iv-copy]').forEach((b) => b.addEventListener('click', async () => { b.textContent = (await copyText(links[Number(b.dataset.ivCopy)][1])) ? 'Copied' : 'Select and copy'; }));
      form.querySelector('#iv-em').value = failed.map((f) => f.split(':')[0]).join(', ');
      const btn = form.querySelector('button[type=submit]'); if (!failed.length) btn.style.display = 'none';
      form.querySelector('[data-close]').textContent = 'Done';
      return false;
    },
  });
  setTimeout(() => m.form.querySelector('#iv-em').focus(), 30);
};
