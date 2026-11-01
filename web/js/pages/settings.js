import { html, raw, plural, tod, dayShort, addDays, minOfDayIn, dur, hhmmText, hm, zoneOffset } from '../util.js';

const breakLen = (a, b) => (((hm(b) - hm(a)) % 1440) + 1440) % 1440;
import { get, post, put } from '../api.js';
import { S, actions, empty, toast, errMsg, confirmBox, qAttr } from '../ui.js';
import { zoneOptions } from '../parts.js';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const bytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

export const settingsPage = {
  title: 'Settings',
  async load() {
    const [s, storage, gifs] = await Promise.all([get('/api/settings'), get('/api/admin/storage'), get('/api/chat/gifs/setup').catch(() => null)]);
    S.settings = s;
    return { s, storage, gifs };
  },
  render({ s, storage, gifs }) {
    const wd = new Set(String(s.work_days).split(',').map(Number));
    const num = (id, name, label, v, min, max, hint, step = 1) => html`<div class="field"><label class="f" for="${id}">${label}</label><input id="${id}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${v}" required>${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`;
    return html`
      <div class="page-h"><div><h1>Settings</h1><p class="sub">Company-wide rules. Each person can override their own schedule on the People page.</p></div></div>
      <form data-submit="save-settings" novalidate>
        <section class="panel"><header><h2>Company</h2></header><div class="body"><div class="field" style="max-width:380px"><label class="f" for="s-org">Company name</label><input id="s-org" name="org_name" value="${s.org_name}" maxlength="80" required></div></div></section>
        <section class="panel"><header><h2>Working hours</h2><span class="muted small">Used for attendance, lateness and targets</span></header><div class="body">
          <div class="grid3"><div class="field"><label class="f" for="s-ss">Shift starts</label><input id="s-ss" type="time" name="shift_start" value="${s.shift_start}" required></div>
            <div class="field"><label class="f" for="s-se">Shift ends</label><input id="s-se" type="time" name="shift_end" value="${s.shift_end}" required></div>
            ${num('s-gr', 'grace_min', 'Grace period (minutes)', s.grace_min, 0, 120, 'Starting this much after the shift start is still on time')}</div>
          <div class="grid3"><div class="field"><label class="f" for="s-bs">Break starts</label><input id="s-bs" type="time" name="break_start" value="${s.break_start || ''}"></div>
            <div class="field"><label class="f" for="s-be">Break ends</label><input id="s-be" type="time" name="break_end" value="${s.break_end || ''}"></div>
            <div class="field"></div></div>
          <p class="hint" style="margin:-4px 0 12px">${s.break_start && s.break_end ? html`Break of ${dur(breakLen(s.break_start, s.break_end) * 60)}. The desktop app reminds people when it starts and when it is over.` : 'The break is optional. Leave both blank for no fixed break.'}</p>
          ${s.day_start_min ? html`<p class="hint" style="margin:-4px 0 12px">This shift runs past midnight, so each work day is counted from the shift start: work until ${hhmmText(s.shift_end)} counts for the day the shift began.</p>` : ''}
          <div class="grid3"><div class="field"><label class="f" for="s-tz">Company time zone</label><select id="s-tz" name="tz">${zoneOptions(s.tz_name || null, { fixed: s.tz_name ? null : s.tz_offset_min })}</select><p class="hint">The default for everyone. Pick each remote person's own zone on the People page.</p></div>
            ${num('s-wt', 'weekly_h', 'Weekly target (hours)', s.weekly_target_min / 60, 0, 100, '', 0.5)}
            ${num('s-lv', 'leave_days_per_year', 'Time off per year (days)', s.leave_days_per_year, 0, 365, '')}</div>
          <div class="field"><span class="f fl">Working days</span><div class="chips">${DAYS.map(([v, n]) => html`<label class="chip" style="display:inline-flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" name="wd" value="${v}" ${wd.has(v) ? raw('checked') : ''}> ${n}</label>`)}</div></div></div></section>
        <section class="panel"><header><h2>Screenshots and activity</h2><span class="muted small">Employees see this same policy in the desktop app</span></header><div class="body">
          <div class="grid3"><div class="field"><label class="f" for="s-sh">Screenshots per 10 minutes</label><select id="s-sh" name="shots_per_10">${[[0, 'Off (time is still tracked)'], [1, '1 per 10 minutes'], [2, '2 per 10 minutes'], [3, '3 per 10 minutes']].map(([v, t]) => html`<option value="${v}" ${s.shots_per_10 === v ? raw('selected') : ''}>${t}</option>`)}</select><p class="hint">Company default, at random moments. Teams and people can have their own on the People page.</p></div>
            ${num('s-il', 'idle_limit_min', 'Mark as idle after (minutes)', s.idle_limit_min, 1, 120, 'With no keyboard or mouse, the timer keeps running; that time is shown as idle and no screenshots are taken')}
            ${num('s-rd', 'retention_days', 'Keep screenshots for (days)', s.retention_days, 1, 3650, 'Older ones are deleted automatically')}</div>
          <div class="grid2"><div class="field"><label class="f" for="s-scr">Screens to capture</label><select id="s-scr" name="capture_screens"><option value="active" ${s.capture_screens !== 'all' ? raw('selected') : ''}>Only the screen being worked on (recommended)</option><option value="all" ${s.capture_screens === 'all' ? raw('selected') : ''}>Every connected screen</option></select>
            <p class="hint">Staff use their own computers: "only the screen being worked on" leaves out their other monitors.</p></div></div>
          <div class="check"><input id="s-blur" type="checkbox" name="blur_shots" ${s.blur_shots ? raw('checked') : ''}><label for="s-blur">Blur screenshots</label></div>
          <p class="hint" style="margin:-4px 0 10px 28px">Blurred on the employee's computer before sending: you can see that work is happening (which kind of app, the layout), but not what is on screen.</p>
          <div class="check"><input id="s-del" type="checkbox" name="employees_can_delete_shots" ${s.employees_can_delete_shots ? raw('checked') : ''}><label for="s-del">Employees can delete their own screenshots</label></div>
          <p class="hint" style="margin:-4px 0 0 28px">Employees can always see their own screenshots and who opened each one.</p></div></section>
        <section class="panel"><header><h2>Private windows</h2><span class="muted small">Hidden on the employee's computer before a screenshot is saved</span></header><div class="body">
          <p class="muted" style="margin-bottom:10px">Matching windows are painted solid black before the screenshot leaves the computer, so the private content never reaches you or the server.</p>
          <div class="field"><span class="f fl">Always hidden</span><div class="chips">${['WhatsApp, Telegram, Signal and other messaging apps', 'Password managers', 'Private and incognito browser windows', 'Banking and payments (banks, JazzCash, Easypaisa, PayPal, Payoneer)', 'Social media (Facebook, Instagram, TikTok, X, Reddit)'].map((t) => html`<span class="chip">${t}</span>`)}</div></div>
          <div class="field"><label class="f" for="s-bo">Other apps or sites to hide</label>
            <input id="s-bo" name="blackout_apps" value="${(s.blackout_apps || []).filter((a) => a.toLowerCase() !== 'whatsapp').join(', ')}" maxlength="300" placeholder="Names separated by commas. For example: Gmail, Zoom">
            <p class="hint">Matches the app name or the window title, so a site open in any browser is covered too.</p></div>
          <p class="hint" style="margin-top:6px">Only the private window is painted black; the rest of the screenshot stays visible. Message pop-ups are not windows; ask staff to turn off message previews.</p></div></section>
        <section class="panel"><header><h2>Tasks</h2></header><div class="body">
          <div class="check"><input id="s-rv" type="checkbox" name="task_review_required" ${s.task_review_required !== false ? raw('checked') : ''}><label for="s-rv">Assigned tasks go to a manager or the project lead for review before they count as done</label></div>
          <p class="hint" style="margin:-4px 0 0 28px">Task accuracy on the Performance page is the share approved without being sent back.</p></div></section>
        <section class="panel"><header><h2>Transparency</h2><span class="muted small">Changes here are shown to everyone they affect</span></header><div class="body">
          <div class="grid2"><div class="field"><label class="f" for="s-tv">Employees can see their colleagues' status</label><select id="s-tv" name="team_visibility">${[['everyone', 'Everyone in the company'], ['team', 'Only people in their own team'], ['off', 'Nobody (only managers see it)']].map(([v, t]) => html`<option value="${v}" ${(s.team_visibility || 'everyone') === v ? raw('selected') : ''}>${t}</option>`)}</select>
            <p class="hint">Working, on a break, idle or not started, and hours today. Never screenshots, activity or break reasons. Widening it asks everyone to agree again.</p></div></div>
          <div class="check"><input id="s-rl" type="checkbox" name="require_latest_app" ${s.require_latest_app !== false ? raw('checked') : ''}><label for="s-rl">Only the newest desktop app can start the timer</label></div>
          <p class="hint" style="margin:-4px 0 0 28px">When a newer installer is on the server, older apps show "Update to start your timer". A timer that is already running keeps going.</p></div></section>
        <section class="panel"><header><h2>Live status</h2></header><div class="body"><div class="grid3">
          ${num('s-ns', 'no_signal_min', 'Show "no signal" after (minutes)', s.no_signal_min, 1, 60, 'A running timer that has gone quiet')}
          ${num('s-st', 'stale_min', 'Close a silent session after (minutes)', s.stale_min, 5, 240, 'It is closed at the last time we heard from the app')}</div></div></section>
        <div class="set-save"><button type="submit" class="btn primary">Save settings</button><span class="muted small">Saves everything above</span><span class="err" data-err></span></div>
      </form>
      <section class="panel"><header><h2>Stored screenshots</h2></header><div class="body" style="display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between">
        <p>${plural(storage.screenshots, 'screenshot')} using <b>${bytes(storage.bytes)}</b>. Anything older than ${s.retention_days} days is removed automatically.</p>
        <button class="btn danger" data-act="purge">Delete expired screenshots now</button></div></section>
      ${gifs ? html`<section class="panel"><header><h2>Chat</h2><span class="muted small">GIFs in every chat, for everyone</span></header><div class="body">
        <form class="gif-set" data-submit="gif-key" novalidate>
          <div class="field"><label class="f" for="s-gif">GIF search key</label><input id="s-gif" name="key" autocomplete="off" spellcheck="false" placeholder="${gifs.has_key ? `${gifs.provider === 'tenor' ? 'Tenor' : 'GIPHY'} key ending ${gifs.hint}` : 'Paste a GIPHY or Tenor API key'}">
            <p class="hint">${gifs.has_key ? html`GIF search is on, from <b>${gifs.provider === 'tenor' ? 'Tenor' : 'GIPHY'}</b>. Paste a new key to change it.` : 'Free from developers.giphy.com, or a Tenor key from Google Cloud. GIFs come through Staffwarden, so nobody’s browser talks to GIPHY or Tenor directly.'}</p></div>
          <div class="gif-set-b"><button type="submit" class="btn primary">Save key</button>${gifs.has_key ? html`<button type="button" class="btn" data-act="gif-off">Turn GIFs off</button>` : ''}<span class="err" data-err></span></div>
        </form></div></section>` : ''}`;
  },
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
  if (!fd.get('break_start') !== !fd.get('break_end')) { err.textContent = 'Give the break both a start and an end, or leave both blank.'; return; }
  const body = {
    org_name: fd.get('org_name'), shift_start: fd.get('shift_start'), shift_end: fd.get('shift_end'), break_start: fd.get('break_start') || null, break_end: fd.get('break_end') || null, grace_min: n('grace_min'),
    ...(() => { const v = String(fd.get('tz') || ''); if (v.startsWith('z:')) return { tz_name: v.slice(2), tz_offset_min: zoneOffset(v.slice(2)) }; return {}; })(), weekly_target_min: Math.round(n('weekly_h') * 60), leave_days_per_year: n('leave_days_per_year'),
    work_days: wd.join(','), shots_per_10: n('shots_per_10'), idle_limit_min: n('idle_limit_min'), retention_days: n('retention_days'),
    blackout_apps: String(fd.get('blackout_apps') || '').split(',').map((x) => x.trim()).filter(Boolean),
    employees_can_delete_shots: !!fd.get('employees_can_delete_shots'), team_visibility: ['everyone', 'team', 'off'].includes(fd.get('team_visibility')) ? fd.get('team_visibility') : 'everyone', require_latest_app: !!fd.get('require_latest_app'), capture_screens: fd.get('capture_screens') === 'all' ? 'all' : 'active', blur_shots: !!fd.get('blur_shots'), task_review_required: !!fd.get('task_review_required'), no_signal_min: n('no_signal_min'), stale_min: n('stale_min'),
  };
  btn.disabled = true;
  try {
    await put('/api/settings', body);
    form.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
    toast('Settings saved. Desktop apps pick up changes the next time they start a session.');
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
  'payroll.reopened': 'Reopened payroll', 'payroll.removed': 'Removed a payroll draft', 'payroll.item_added': 'Added a payroll line', 'payroll.item_removed': 'Removed a payroll line',
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
  render({ rows, users, more, want }) {
    const name = (id) => (id == null ? '' : (users.find((u) => u.id === id) || {}).name || `#${id}`);
    const tz = S.settings.tz_offset_min;
    const stamp = (iso) => { const d = new Date(Date.parse(iso) + tz * 60000).toISOString().slice(0, 10); return `${dayShort(d)}, ${tod(iso, tz)}`; };
    return html`
      <div class="page-h"><div><h1>Audit log</h1><p class="sub">Who changed what, newest first. Deleted screenshots are recorded here too.</p></div></div>
      <section class="panel flush"><div class="body">${rows.length ? html`<div class="tbl-wrap"><table class="t stack"><thead><tr><th>When</th><th>Who</th><th>What</th><th>About</th><th>Details</th></tr></thead><tbody>
        ${rows.map((r) => html`<tr data-k="a${r.id}"><td class="num small nowrap">${stamp(r.at)}</td><td class="nowrap">${r.actor_name || 'System'}</td><td>${LABEL[r.action] || words(r.action)}</td><td>${name(r.target_user_id)}</td><td class="au-d">${r.detail || ''}</td></tr>`)}</tbody></table></div>
        <div class="au-more"><span class="muted small">${more ? `Showing the latest ${rows.length}` : `${plural(rows.length, 'entry', 'entries')}, all of them`}</span>${more ? html`<button type="button" class="btn sm" data-act="q" ${raw(qAttr('n', String(want + AUDIT_PAGE)))}>Show ${AUDIT_PAGE} older</button>` : ''}</div>` : empty('Nothing recorded yet', '')}</div></section>`;
  },
};
