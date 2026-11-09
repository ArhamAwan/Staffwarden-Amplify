import { html, raw, esc, icon, initials, avColor, dayShort, dayMD, dayLong, plural, todayIn, addDays, eachDay, monthEnd, monthLabel, dow, LEAVE_KIND } from '../util.js';
import { get, post, del, qs } from '../api.js';
import { S, actions, ring, kpis, tag, person, empty, openModal, confirmBox, toast, errMsg, meter } from '../ui.js';
import { isMgr as isMgrOnly, loadPeople, select, companyToday, myToday } from '../parts.js';
// HR decides everyone's time off, like a manager
const isMgr = () => isMgrOnly() || !!S.me.hr;

// the company's rules: paid days a month (no carrying over), unpaid any time, nothing next to a weekend or
// holiday unless it's an emergency, and only the owner decides
// the one who approves, by name; "the CEO" when the install has no owner's name
const owner = (cap = true) => S.settings.owner_name || (cap ? 'The CEO' : 'the CEO');
const ownerFirst = (cap = true) => (S.settings.owner_name ? S.settings.owner_name.split(' ')[0] : cap ? 'The CEO' : 'the CEO');
const perMonth = () => Number(S.settings.paid_leave_per_month ?? 1);
const isOwner = () => S.me.role === 'owner';
const range = (r) => (r.start_day === r.end_day ? dayShort(r.start_day) : `${dayMD(r.start_day)} to ${dayMD(r.end_day)}`);

export default {
  title: 'Time off',
  async load(q) {
    const year = (isMgr() ? companyToday() : myToday()).slice(0, 4);
    const [reqs, bal, hol] = await Promise.all([get(`/api/timeoff${qs({ status: q.get('status') })}`), get(`/api/timeoff/balances${qs({ month: (isMgr() ? companyToday() : myToday()).slice(0, 7) })}`), get(`/api/holidays${qs({ year })}`)]);
    if (isMgrOnly()) await loadPeople();
    else if (isMgr()) S.people = (await get('/api/hr/people')).filter((p) => p.role !== 'owner');
    return { reqs, bal, hol, year };
  },
  render({ reqs, bal, hol, year }, q) {
    const status = q.get('status') || '';
    const today = isMgr() ? companyToday() : myToday();
    const pending = reqs.filter((r) => r.status === 'pending');
    const mgr = isMgr();
    const mine = bal.find((b) => b.user_id === S.me.id);
    const away = reqs.filter((r) => r.status === 'approved' && r.start_day <= today && r.end_day >= today);
    const upcoming = reqs.filter((r) => r.status === 'approved' && r.start_day > today);
    const row = (r) => html`<tr data-k="r${r.id}">
      ${mgr ? html`<td><b>${r.user_name}</b></td>` : ''}
      <td>${r.paid ? 'Paid' : 'Unpaid'}${r.emergency ? html` ${tag('pending', 'Emergency')}` : ''}</td><td class="num">${range(r)}</td><td class="num">${plural(r.working_days, 'working day')}</td>
      <td>${tag(r.status, { pending: 'Waiting', approved: 'Approved', denied: 'Declined', cancelled: 'Cancelled' }[r.status] || r.status)}${r.decided_by ? html` <span class="small muted">by ${r.decided_by}</span>` : ''}</td>
      <td class="muted small">${r.note || ''}${r.decision_note ? html`<br><i>Reply: ${r.decision_note}</i>` : ''}</td>
      <td class="r nowrap">${r.status === 'pending' && isOwner() && r.user_id !== S.me.id ? html`<button class="btn sm primary" data-act="decide" data-id="${r.id}" data-approve="1" data-who="${r.user_name}" data-range="${range(r)}" data-emergency="${r.emergency ? '1' : ''}" data-note="${r.note || ''}">Approve</button> <button class="btn sm" data-act="decide" data-id="${r.id}" data-who="${r.user_name}" data-range="${range(r)}">Decline</button> `
        : ''}${(r.status === 'approved' && (mgr || r.user_id === S.me.id)) || (r.status === 'pending' && r.user_id === S.me.id) ? html`<button class="btn sm danger" data-act="cancel-leave" data-id="${r.id}">Cancel</button>` : ''}</td></tr>`;
    const table = (list, empt) => list.length ? html`<div class="tbl-wrap"><table class="t stack"><thead><tr>${mgr ? html`<th>Person</th>` : ''}<th>Pay</th><th>Dates</th><th>Length</th><th>Status</th><th>Reason</th><th></th></tr></thead><tbody>${list.map(row)}</tbody></table></div>` : empty(empt[0], empt[1]);
    return html`
      <div class="page-h"><div><h1>Time off</h1><p class="sub">${isOwner() ? 'You approve or decline every request' : `${owner()} approves every request`}</p></div>
        <div class="tools"><button class="btn primary" data-act="new-leave">${isOwner() ? 'Record time off' : mgr ? 'Ask for time off' : 'Request time off'}</button></div></div>
      ${rules()}
      ${leaveBento({ reqs, hol, pending, away, upcoming, mine, mgr, today })}
      ${pending.length && !status ? html`<section class="panel flush"><header><h2>${isOwner() ? 'Waiting for your decision' : `Waiting for ${ownerFirst(false)}`}</h2></header><div class="body">${table(pending, ['', ''])}</div></section>` : ''}
      <section class="panel flush"><header><h2>${status ? 'Requests' : 'All requests'}</h2>${select({ q: 'status', value: status, label: 'Status', options: [['', 'Any status'], ['pending', 'Waiting'], ['approved', 'Approved'], ['denied', 'Declined'], ['cancelled', 'Cancelled']] })}</header>
        <div class="body">${table(status ? reqs : reqs.filter((r) => r.status !== 'pending'), ['No requests yet', mgr ? 'Requests from your people appear here.' : 'Use "Request time off" to ask for days off.'])}</div></section>
      <div class="cols even">
        ${mgr ? html`<section class="panel flush"><header><h2>This month</h2><span class="muted small">${monthLabel(today.slice(0, 7))} · ${plural(perMonth(), 'paid day')} each</span></header><div class="body"><div class="tbl-wrap"><table class="t"><thead><tr><th>Person</th><th class="r">Paid used</th><th class="r">Paid left</th><th class="r">Unpaid</th><th></th></tr></thead><tbody>
          ${bal.map((b) => html`<tr data-k="b${b.user_id}"><td><b>${b.name}</b></td><td class="r num">${b.taken} / ${b.allowance}</td><td class="r num"><b>${b.left}</b></td><td class="r num">${b.unpaid ? plural(b.unpaid, 'day') : '—'}</td><td class="small muted">${b.asked ? `${b.asked} paid asked for` : ''}${b.pending ? `${b.asked ? ', ' : ''}${b.pending} waiting` : ''}</td></tr>`)}</tbody></table></div></div></section>` : ''}
        <section class="panel flush"><header><h2>Company holidays</h2>${S.me.role === 'owner' ? html`<button class="btn sm" data-act="new-holiday">${raw('+')} Add holiday</button>` : ''}</header><div class="body">
          ${hol.length ? html`<ul class="blist">${hol.map((h) => html`<li data-k="h${h.day}"><i class="dotbox" style="background:#3B8ED0"></i><span class="what">${h.name}</span><span class="len num">${S.me.role === 'owner' ? html`<button class="linkbtn" data-act="del-holiday" data-day="${h.day}">Remove</button>` : ''}</span><span class="when">${dayLong(h.day)}</span></li>`)}</ul>` : empty('No holidays added', S.me.role === 'owner' ? 'Add public holidays so they are not counted as absences.' : 'Public holidays show here once your company adds them.')}</div></section>
      </div>`;
  },
};

function rules() {
  const n = perMonth();
  return html`<section class="lv-rules" aria-label="How time off works here">
    <div><b>${plural(n, 'paid day')} a month</b><span>Use ${n === 1 ? 'it' : 'them'} that month; unused days don’t carry over.</span></div>
    <div><b>Unpaid, any time</b><span>Take as many as you need. Each one comes off that month’s pay.</span></div>
    ${S.settings.no_sandwich_leave !== false ? html`<div><b>Not next to a weekend</b><span>No time off on a Friday, a Monday or beside a holiday, unless it’s an emergency.</span></div>` : ''}
    <div><b>${ownerFirst()} approves</b><span>Every request goes to ${isOwner() ? 'you' : owner(false)}. You get a notification either way.</span></div></section>`;
}

// the top of the page as a bento: what needs a decision, who is away, the holidays, and this month
function leaveBento({ reqs, hol, pending, away, upcoming, mine, mgr, today }) {
  const m = today.slice(0, 7), days = eachDay(`${m}-01`, monthEnd(m)), lead = (dow(days[0]) + 6) % 7;
  const live = reqs.filter((r) => (r.status === 'approved' || r.status === 'pending') && r.end_day >= `${m}-01` && r.start_day <= days[days.length - 1]);
  const hols = hol.filter((h) => h.day.startsWith(m));
  const on = (d) => live.filter((r) => r.start_day <= d && r.end_day >= d);
  const nextHol = hol.find((h) => h.day >= today);
  const p0 = pending[0];
  const first = (n) => String(n || '').split(' ')[0];
  const face = (id, name) => html`<span class="avatar sm" style="background:${avColor(id)}" title="${name}">${initials(name)}</span>`;
  const lead1 = mgr
    ? html`<div class="kpi bt-wa ${pending.length ? 'warn' : 'good'}"><div class="l">${icon('bell')}Waiting for a decision</div><div class="v">${pending.length}</div>
        ${p0 ? html`${p0.note ? html`<p class="lv-q">“${p0.note}”</p>` : ''}<div class="lv-who">${face(p0.user_id, p0.user_name)}<span><b>${p0.user_name}</b>, ${range(p0)}<br><span class="muted">${plural(p0.working_days, 'working day')}</span></span></div>` : html`${upcoming.length ? html`<ul class="at-who lv-up">${upcoming.slice(0, 3).map((r) => html`<li>${face(r.user_id, r.user_name)}<span><b>${first(r.user_name)}</b>, ${range(r)}</span></li>`)}</ul>` : ''}<div class="f">All caught up.${upcoming.length ? ` ${plural(upcoming.length, 'approved request')} coming up.` : ''} New requests show here and you get a notification.</div>`}</div>`
    : html`<div class="kpi bt-wa good"><div class="l">${icon('sun')}Paid days left in ${monthLabel(today.slice(0, 7)).split(' ')[0]}</div><div class="lv-ring"><div class="bt-ringw">${ring(mine ? (100 * mine.left) / Math.max(1, mine.allowance) : 0, 'good')}<span class="bt-rv"><b class="num">${mine ? mine.left : 0}</b><small>of ${mine ? mine.allowance : 0}</small></span></div>
        <span class="muted small">${mine && mine.taken ? `${mine.taken} used` : 'None used yet'}${mine && mine.asked ? `, ${mine.asked} asked for` : ''}${mine && mine.unpaid ? `. ${plural(mine.unpaid, 'unpaid day')} this month` : ''}${pending.length ? `. ${pending.length} waiting for ${ownerFirst(false)}` : ''}</span></div></div>`;
  const chips = [...new Map([...live.map((r) => [`r${r.id}`, html`<span class="lv-chip ${r.status === 'pending' ? 'ask' : ''}"><i></i>${first(r.user_name)}, ${r.status === 'pending' ? 'asked' : r.paid ? 'paid' : 'unpaid'}</span>`]), ...hols.map((h) => [h.day, html`<span class="lv-chip hol"><i></i>${h.name}</span>`])]).values()].slice(0, 5);
  return html`<section class="kpis bento lv-bento" aria-label="Time off at a glance">
    ${lead1}
    <div class="kpi bt-aw"><div class="l">${icon('users')}Away today</div><div class="bt-row"><div class="v">${away.length}</div>${away.length ? html`<span class="stack bt-faces">${away.slice(0, 5).map((a) => face(a.user_id, a.user_name))}</span>` : ''}</div>
      <div class="f">${away.length ? away.map((a) => first(a.user_name)).join(', ') : upcoming.length ? `Nobody. ${plural(upcoming.length, 'request')} coming up` : 'Nobody'}</div></div>
    <div class="kpi bt-ho"><div class="l">${icon('cal')}Holidays this year</div><div class="v">${hol.length}</div><div class="f">${nextHol ? `Next: ${nextHol.name}, ${dayMD(nextHol.day)}` : hol.length ? 'No more this year' : 'None added yet'}</div></div>
    <div class="kpi bt-ca"><div class="l">${icon('cal')}${monthLabel(m)}<span class="bt-r">Who’s away</span></div>
      <div class="lv-cal">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w) => html`<span class="h">${w}</span>`)}${Array.from({ length: lead }, () => html`<span></span>`)}
        ${days.map((d) => { const o = on(d), h = hols.find((x) => x.day === d); const cls = h ? 'hol' : o.some((r) => r.status === 'approved') ? 'off' : o.length ? 'ask' : ''; return html`<span class="d ${cls}${d === today ? ' today' : ''}" title="${[dayLong(d), h ? h.name : '', ...o.map((r) => `${r.user_name}${r.status === 'pending' ? ' (asked)' : ''}`)].filter(Boolean).join(', ')}">${Number(d.slice(8))}</span>`; })}</div>
      <div class="lv-chips">${chips.length ? chips : html`<span class="muted small">Nobody away this month and no holidays</span>`}</div></div>
  </section>`;
}

actions['new-leave'] = () => {
  const mgr = isMgr(), own = isOwner();
  const today = mgr ? companyToday() : myToday();
  const m = openModal({
    title: own ? 'Record time off' : mgr ? 'Ask for time off' : 'Request time off', submit: own ? 'Record' : 'Send request',
    sub: own ? 'Time off you record is approved straight away.' : `${owner()} approves it. You’ll get a notification.`,
    body: html`${mgr ? html`<div class="field"><label class="f" for="lv-u">Person</label><select id="lv-u" name="user_id"><option value="${S.me.id}">Me</option>${(S.people || []).filter((p) => p.id !== S.me.id).map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>` : ''}
      <div class="grid2"><div class="field"><label class="f" for="lv-s">First day</label><input id="lv-s" type="date" name="start_day" value="${today}" required></div>
      <div class="field"><label class="f" for="lv-e">Last day</label><input id="lv-e" type="date" name="end_day" value="${today}" required></div></div>
      <fieldset class="lv-pay"><legend class="f">Pay</legend>
        <label class="lv-opt"><input type="radio" name="kind" value="paid" checked><span><b>Paid</b><small data-lv-paid>${plural(perMonth(), 'paid day')} a month</small></span></label>
        <label class="lv-opt"><input type="radio" name="kind" value="unpaid"><span><b>Unpaid</b><small>Comes off that month’s pay</small></span></label></fieldset>
      <div class="lv-check" data-lv-check role="status" aria-live="polite"></div>
      <label class="lv-em" data-lv-em hidden><input type="checkbox" name="emergency"><span><b>This is an emergency</b><small>Say what happened below. ${ownerFirst()} decides.</small></span></label>
      <div class="field"><label class="f" for="lv-n" data-lv-nl>Reason</label><textarea id="lv-n" name="note" maxlength="500" minlength="3" required placeholder="A family wedding, a doctor’s visit…"></textarea></div>`,
    onSubmit: async (fd) => {
      if (String(fd.get('note') || '').trim().length < 3) { f.querySelector('#lv-n').focus(); throw new Error(f.emergency && f.emergency.checked ? 'Say what the emergency is' : 'Give a reason for the time off'); }
      await post('/api/timeoff', { user_id: fd.get('user_id') ? Number(fd.get('user_id')) : undefined, kind: fd.get('kind'), start_day: fd.get('start_day'), end_day: fd.get('end_day'), note: fd.get('note') || null, emergency: !!fd.get('emergency') });
      toast(own ? 'Time off recorded' : `Sent to ${ownerFirst(false)}`); S.refresh();
    },
  });
  // as the dates and pay change: how many days, paid days left, and whether a day sits next to a weekend
  const f = m.form, box = f.querySelector('[data-lv-check]'), em = f.querySelector('[data-lv-em]'), nl = f.querySelector('[data-lv-nl]'), note = f.querySelector('#lv-n');
  const sub = f.querySelector('button[type="submit"]');
  let seq = 0;
  const check = async () => {
    const n = ++seq;
    const body = { user_id: f.user_id ? Number(f.user_id.value) : undefined, start_day: f.start_day.value, end_day: f.end_day.value, kind: f.kind.value };
    if (!body.start_day || !body.end_day) return;
    if (body.end_day < body.start_day) { box.innerHTML = '<p class="lv-msg bad">The last day is before the first day.</p>'; sub.disabled = true; return; }
    let w;
    try { w = await post('/api/timeoff/check', body); } catch (e) { if (n === seq) { box.innerHTML = `<p class="lv-msg bad">${esc(errMsg(e))}</p>`; } return; }
    if (n !== seq) return;
    const left = w.months.map((x) => `${x.left} left in ${x.name}`).join(', ');
    f.querySelector('[data-lv-paid]').textContent = w.months.length ? `${left}` : `${plural(w.allowance, 'paid day')} a month`;
    const parts = [];
    if (w.working_days) parts.push(`<p class="lv-msg">${esc(plural(w.working_days, 'working day'))} off${w.paid ? '' : ', unpaid'}.</p>`);
    if (w.problem) parts.push(`<p class="lv-msg bad">${esc(w.problem)}${w.paid && w.over.length ? ' <button type="button" class="linkbtn" data-lv-unpaid>Make it unpaid</button>' : ''}</p>`);
    if (w.needs_emergency) parts.push(`<p class="lv-msg warn"><b>${esc(w.sandwich_days.map((d) => dayShort(d)).join(', '))} ${w.sandwich_days.length === 1 ? 'is' : 'are'} next to a weekend or a holiday.</b> That isn’t allowed unless it’s an emergency.</p>`);
    box.innerHTML = parts.join('');
    em.hidden = !w.needs_emergency;
    const emer = w.needs_emergency && f.emergency.checked;
    nl.textContent = emer ? 'What happened' : 'Reason';
    note.placeholder = emer ? 'What the emergency is, in a few words' : 'A family wedding, a doctor’s visit…';
    sub.disabled = !!w.problem || (w.needs_emergency && !f.emergency.checked) || !w.working_days;
  };
  f.addEventListener('click', (e) => { if (e.target.closest('[data-lv-unpaid]')) { f.querySelector('input[name=kind][value=unpaid]').checked = true; check(); } });
  f.addEventListener('change', check); f.addEventListener('input', (e) => { if (e.target.type === 'date') check(); });
  check();
};
actions.decide = (el) => {
  const approve = !!el.dataset.approve, id = el.dataset.id;
  openModal({
    title: `${approve ? 'Approve' : 'Decline'} ${el.dataset.who}'s time off?`, sub: el.dataset.range, submit: approve ? 'Approve' : 'Decline', danger: !approve,
    body: html`${el.dataset.emergency ? html`<p class="lv-msg warn"><b>Asked as an emergency</b>, next to a weekend or a holiday${el.dataset.note ? html`: “${el.dataset.note}”` : '.'}</p>` : ''}<div class="field"><label class="f" for="dn">Reply (optional)</label><textarea id="dn" name="note" maxlength="500"></textarea></div>`,
    onSubmit: async (fd) => { await post(`/api/timeoff/${id}/decision`, { approve, note: fd.get('note') || null }); toast(approve ? 'Approved' : 'Declined'); S.refresh(); },
  });
};
actions['cancel-leave'] = async (el) => {
  if (!(await confirmBox({ title: 'Cancel this time off?', message: 'The days go back to being normal working days.', confirm: 'Cancel time off', cancel: 'Keep it', danger: true }))) return;
  try { await del(`/api/timeoff/${el.dataset.id}`); toast('Cancelled'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['new-holiday'] = () => openModal({
  title: 'Add a company holiday', submit: 'Add holiday',
  body: html`<div class="field"><label class="f" for="hd">Date</label><input id="hd" type="date" name="day" required></div><div class="field"><label class="f" for="hn">Name</label><input id="hn" name="name" maxlength="100" required placeholder="Eid al-Fitr"></div>`,
  onSubmit: async (fd) => { await post('/api/holidays', { day: fd.get('day'), name: fd.get('name') }); toast('Holiday added'); S.refresh(); },
});
actions['del-holiday'] = async (el) => {
  if (!(await confirmBox({ title: 'Remove this holiday?', message: 'People will be expected to work that day again.', confirm: 'Remove', danger: true }))) return;
  try { await del(`/api/holidays/${el.dataset.day}`); toast('Holiday removed'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
