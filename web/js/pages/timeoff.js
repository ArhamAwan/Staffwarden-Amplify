import { html, raw, esc, icon, initials, avColor, dayShort, dayMD, dayLong, plural, todayIn, addDays, eachDay, monthEnd, monthLabel, dow, LEAVE_KIND } from '../util.js';
import { get, post, del, qs } from '../api.js';
import { S, actions, ring, kpis, tag, person, empty, openModal, confirmBox, toast, errMsg, meter } from '../ui.js';
import { isMgr as isMgrOnly, loadPeople, select, companyToday, myToday } from '../parts.js';
// HR decides everyone's time off, like a manager
const isMgr = () => isMgrOnly() || !!S.me.hr;

const range = (r) => (r.start_day === r.end_day ? dayShort(r.start_day) : `${dayMD(r.start_day)} to ${dayMD(r.end_day)}`);
const kindOptions = (cur) => Object.entries(LEAVE_KIND).map(([k, v]) => html`<option value="${k}" ${k === cur ? raw('selected') : ''}>${v}</option>`);

export default {
  title: 'Time off',
  async load(q) {
    const year = (isMgr() ? companyToday() : myToday()).slice(0, 4);
    const [reqs, bal, hol] = await Promise.all([get(`/api/timeoff${qs({ status: q.get('status') })}`), get(`/api/timeoff/balances${qs({ year })}`), get(`/api/holidays${qs({ year })}`)]);
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
      <td>${LEAVE_KIND[r.kind] || r.kind}</td><td class="num">${range(r)}</td><td class="num">${plural(r.working_days, 'working day')}</td>
      <td>${tag(r.status, r.status[0].toUpperCase() + r.status.slice(1))}${r.decided_by ? html` <span class="small muted">by ${r.decided_by}</span>` : ''}</td>
      <td class="muted small">${r.note || ''}${r.decision_note ? html`<br><i>Reply: ${r.decision_note}</i>` : ''}</td>
      <td class="r nowrap">${r.status === 'pending' && mgr && r.user_id !== S.me.id ? html`<button class="btn sm primary" data-act="decide" data-id="${r.id}" data-approve="1" data-who="${r.user_name}" data-range="${range(r)}">Approve</button> <button class="btn sm" data-act="decide" data-id="${r.id}" data-who="${r.user_name}" data-range="${range(r)}">Deny</button> `
        : ''}${(r.status === 'approved' && (mgr || r.user_id === S.me.id)) || (r.status === 'pending' && r.user_id === S.me.id) ? html`<button class="btn sm danger" data-act="cancel-leave" data-id="${r.id}">Cancel</button>` : ''}</td></tr>`;
    const table = (list, empt) => list.length ? html`<div class="tbl-wrap"><table class="t stack"><thead><tr>${mgr ? html`<th>Person</th>` : ''}<th>Type</th><th>Dates</th><th>Length</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>${list.map(row)}</tbody></table></div>` : empty(empt[0], empt[1]);
    return html`
      <div class="page-h"><div><h1>Time off</h1><p class="sub">${year} · ${mgr ? 'Requests from your people' : 'Request days off and see your balance'}</p></div>
        <div class="tools"><button class="btn primary" data-act="new-leave">${mgr ? 'Record time off' : 'Request time off'}</button></div></div>
      ${leaveBento({ reqs, hol, pending, away, upcoming, mine, mgr, today })}
      ${pending.length && !status ? html`<section class="panel flush"><header><h2>${mgr ? 'Waiting for a decision' : 'Waiting for approval'}</h2></header><div class="body">${table(pending, ['', ''])}</div></section>` : ''}
      <section class="panel flush"><header><h2>${status ? 'Requests' : 'All requests'}</h2>${select({ q: 'status', value: status, label: 'Status', options: [['', 'Any status'], ['pending', 'Waiting'], ['approved', 'Approved'], ['denied', 'Denied'], ['cancelled', 'Cancelled']] })}</header>
        <div class="body">${table(status ? reqs : reqs.filter((r) => r.status !== 'pending'), ['No requests yet', mgr ? 'Requests from your people appear here.' : 'Use "Request time off" to ask for days off.'])}</div></section>
      <div class="cols even">
        ${mgr ? html`<section class="panel flush"><header><h2>Balances</h2><span class="muted small">Working days used in ${year}</span></header><div class="body"><div class="tbl-wrap"><table class="t"><thead><tr><th>Person</th><th class="r">Used</th><th class="r">Left</th><th style="width:38%"></th></tr></thead><tbody>
          ${bal.map((b) => html`<tr data-k="b${b.user_id}"><td><b>${b.name}</b></td><td class="r num">${b.taken} / ${b.allowance}</td><td class="r num"><b>${b.left}</b></td><td style="min-width:110px">${meter((100 * b.taken) / Math.max(1, b.allowance))}${b.pending ? html` <span class="small muted">${b.pending} waiting</span>` : ''}</td></tr>`)}</tbody></table></div></div></section>` : ''}
        <section class="panel flush"><header><h2>Company holidays</h2>${S.me.role === 'owner' ? html`<button class="btn sm" data-act="new-holiday">${raw('+')} Add holiday</button>` : ''}</header><div class="body">
          ${hol.length ? html`<ul class="blist">${hol.map((h) => html`<li data-k="h${h.day}"><i class="dotbox" style="background:#3B8ED0"></i><span class="what">${h.name}</span><span class="len num">${S.me.role === 'owner' ? html`<button class="linkbtn" data-act="del-holiday" data-day="${h.day}">Remove</button>` : ''}</span><span class="when">${dayLong(h.day)}</span></li>`)}</ul>` : empty('No holidays added', S.me.role === 'owner' ? 'Add public holidays so they are not counted as absences.' : 'Public holidays show here once your company adds them.')}</div></section>
      </div>`;
  },
};

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
    : html`<div class="kpi bt-wa good"><div class="l">${icon('sun')}Days left this year</div><div class="lv-ring"><div class="bt-ringw">${ring(mine ? (100 * mine.left) / Math.max(1, mine.allowance) : 0, 'good')}<span class="bt-rv"><b class="num">${mine ? mine.left : 0}</b><small>of ${mine ? mine.allowance : 0}</small></span></div>
        <span class="muted small">${mine ? mine.taken : 0} used${pending.length ? `, ${pending.length} waiting for approval` : ''}</span></div></div>`;
  const chips = [...new Map([...live.map((r) => [`r${r.id}`, html`<span class="lv-chip ${r.status === 'pending' ? 'ask' : ''}"><i></i>${first(r.user_name)}, ${r.status === 'pending' ? 'asked' : (LEAVE_KIND[r.kind] || r.kind).toLowerCase()}</span>`]), ...hols.map((h) => [h.day, html`<span class="lv-chip hol"><i></i>${h.name}</span>`])]).values()].slice(0, 5);
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
  const mgr = isMgr();
  const today = mgr ? companyToday() : myToday();
  openModal({
    title: mgr ? 'Record time off' : 'Request time off', submit: mgr ? 'Record' : 'Send request',
    sub: mgr ? 'Time you record for someone is approved straight away.' : 'Your manager will approve or deny it.',
    body: html`${mgr ? html`<div class="field"><label class="f" for="lv-u">Person</label><select id="lv-u" name="user_id">${(S.people || []).map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>` : ''}
      <div class="field"><label class="f" for="lv-k">Type</label><select id="lv-k" name="kind">${kindOptions('vacation')}</select></div>
      <div class="grid2"><div class="field"><label class="f" for="lv-s">First day</label><input id="lv-s" type="date" name="start_day" value="${today}" required></div>
      <div class="field"><label class="f" for="lv-e">Last day</label><input id="lv-e" type="date" name="end_day" value="${today}" required></div></div>
      <div class="field"><label class="f" for="lv-n">Note (optional)</label><textarea id="lv-n" name="note" maxlength="500"></textarea></div>`,
    onSubmit: async (fd) => {
      await post('/api/timeoff', { user_id: fd.get('user_id') ? Number(fd.get('user_id')) : undefined, kind: fd.get('kind'), start_day: fd.get('start_day'), end_day: fd.get('end_day'), note: fd.get('note') || null });
      toast(mgr ? 'Time off recorded' : 'Request sent'); S.refresh();
    },
  });
};
actions.decide = (el) => {
  const approve = !!el.dataset.approve, id = el.dataset.id;
  openModal({
    title: `${approve ? 'Approve' : 'Deny'} ${el.dataset.who}'s time off?`, sub: el.dataset.range, submit: approve ? 'Approve' : 'Deny', danger: !approve,
    body: html`<div class="field"><label class="f" for="dn">Reply (optional)</label><textarea id="dn" name="note" maxlength="500"></textarea></div>`,
    onSubmit: async (fd) => { await post(`/api/timeoff/${id}/decision`, { approve, note: fd.get('note') || null }); toast(approve ? 'Approved' : 'Denied'); S.refresh(); },
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
