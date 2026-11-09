import { html, raw, esc, icon, initials, avColor, dayShort, dayMD, dayLong, plural, todayIn, addDays, eachDay, monthEnd, monthLabel, dow, LEAVE_KIND } from '../util.js';
import { get, post, del, qs } from '../api.js';
import { S, actions, ring, kpis, tag, person, empty, openModal, confirmBox, toast, errMsg, meter, qAttr } from '../ui.js';
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
// who did what: approved or declined by the CEO; cancelled by whoever cancelled it (and approved by whom, before)
const first1 = (n) => String(n || '').split(' ')[0];
const statusBy = (r) => {
  if (r.status === 'cancelled') return r.cancelled_by ? html` <span class="small muted">by ${r.cancelled_by_id === r.user_id ? 'them' : r.cancelled_by}${r.decided_by && r.decided_at ? `, after ${first1(r.decided_by)} approved it` : ''}</span>` : '';
  return r.decided_by ? html` <span class="small muted">by ${r.decided_by}</span>` : '';
};
// the person: their own while it waits, or before approved time off starts. The CEO: anyone's, with a reason.
const canCancel = (r, today) => ['pending', 'approved'].includes(r.status) && (isOwner() || (r.user_id === S.me.id && (r.status === 'pending' || r.start_day > today)));
const range = (r) => (r.start_day === r.end_day ? dayShort(r.start_day) : `${dayMD(r.start_day)} to ${dayMD(r.end_day)}`);

export default {
  title: 'Time off',
  async load(q) {
    const year = (isMgr() ? companyToday() : myToday()).slice(0, 4);
    const [reqs, bal, allHol, refs] = await Promise.all([get(`/api/timeoff${qs({ status: q.get('status'), from: `${Number(year) - 1}-01-01` })}`), get(`/api/timeoff/balances${qs({ month: (isMgr() ? companyToday() : myToday()).slice(0, 7) })}`), get('/api/holidays'), get('/api/observances').catch(() => [])]);
    if (isMgrOnly()) await loadPeople();
    else if (isMgr()) S.people = (await get('/api/hr/people')).filter((p) => p.role !== 'owner');
    const hol = allHol.filter((h) => h.day.startsWith(year));
    return { reqs, bal, hol, allHol, refs, year };
  },
  render({ reqs, bal, hol, allHol, refs, year }, q) {
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
      <td>${tag(r.status, { pending: 'Waiting', approved: 'Approved', denied: 'Declined', cancelled: 'Cancelled' }[r.status] || r.status)}${statusBy(r)}</td>
      <td class="muted small">${r.note || ''}${r.decision_note ? html`<br><i>Reply: ${r.decision_note}</i>` : ''}${r.cancel_note ? html`<br><i>Why it was cancelled: ${r.cancel_note}</i>` : ''}</td>
      <td class="r nowrap">${r.status === 'pending' && isOwner() && r.user_id !== S.me.id ? html`<button class="btn sm primary" data-act="decide" data-id="${r.id}" data-approve="1" data-who="${r.user_name}" data-range="${range(r)}" data-emergency="${r.emergency ? '1' : ''}" data-note="${r.note || ''}">Approve</button> <button class="btn sm" data-act="decide" data-id="${r.id}" data-who="${r.user_name}" data-range="${range(r)}">Decline</button> `
        : ''}${canCancel(r, today) ? html`<button class="btn sm danger" data-act="cancel-leave" data-id="${r.id}" data-mine="${r.user_id === S.me.id ? '1' : ''}" data-who="${r.user_name}" data-range="${range(r)}">Cancel</button>` : ''}</td></tr>`;
    const table = (list, empt) => list.length ? html`<div class="tbl-wrap"><table class="t stack"><thead><tr>${mgr ? html`<th>Person</th>` : ''}<th>Pay</th><th>Dates</th><th>Length</th><th>Status</th><th>Reason</th><th></th></tr></thead><tbody>${list.map((r) => (r.mo ? html`<tr class="lv-mo" data-k="m${r.mo}"><th colspan="${mgr ? 7 : 6}" scope="colgroup">${monthLabel(r.mo)}<span>${plural(r.n, 'request')}</span></th></tr>` : row(r)))}</tbody></table></div>` : empty(empt[0], empt[1]);
    return html`
      <div class="page-h"><div><h1>Time off</h1><p class="sub">${isOwner() ? 'You approve or decline every request' : `${owner()} approves every request`}</p></div>
        <div class="tools"><button class="btn primary" data-act="new-leave">${isOwner() ? 'Record time off' : mgr ? 'Ask for time off' : 'Request time off'}</button></div></div>
      ${rules()}
      ${leaveBento({ reqs, hol, refs, pending, away, upcoming, mine, mgr, today })}
      ${pending.length && !status ? html`<section class="panel flush"><header><h2>${isOwner() ? 'Waiting for your decision' : `Waiting for ${ownerFirst(false)}`}</h2></header><div class="body">${table(pending, ['', ''])}</div></section>` : ''}
      ${requestsPanel({ reqs, status, mgr, today, q, table })}
      ${holidaysPanel(allHol, refs, today)}
      ${mgr ? html`<section class="panel flush"><header><h2>This month</h2><span class="muted small">${monthLabel(today.slice(0, 7))} · ${plural(perMonth(), 'paid day')} each</span></header><div class="body"><div class="tbl-wrap"><table class="t"><thead><tr><th>Person</th><th class="r">Paid used</th><th class="r">Paid left</th><th class="r">Unpaid</th><th></th></tr></thead><tbody>
          ${bal.map((b) => html`<tr data-k="b${b.user_id}"><td><b>${b.name}</b></td><td class="r num">${b.taken} / ${b.allowance}</td><td class="r num"><b>${b.left}</b></td><td class="r num">${b.unpaid ? plural(b.unpaid, 'day') : '—'}</td><td class="small muted">${b.asked ? `${b.asked} paid asked for` : ''}${b.pending ? `${b.asked ? ', ' : ''}${b.pending} waiting` : ''}</td></tr>`)}</tbody></table></div></div></section>` : ''}
      `;
  },
};

// every request, built to stay usable at a few thousand: what's coming up first, then the past; grouped by month;
// 25 at a time; managers can find a person by name
const PAGE = 25;
function requestsPanel({ reqs, status, mgr, today, q, table }) {
  const when = q.get('when') || (mgr ? 'up' : 'all');
  const find = (q.get('find') || '').trim().toLowerCase();
  const shown = Math.max(PAGE, Number(q.get('n')) || PAGE);
  let list = status ? reqs : reqs.filter((r) => r.status !== 'pending');
  const up = list.filter((r) => r.end_day >= today), past = list.filter((r) => r.end_day < today);
  list = when === 'up' ? up.sort((a, b) => (a.start_day < b.start_day ? -1 : 1)) : when === 'past' ? past : [...up.sort((a, b) => (a.start_day < b.start_day ? -1 : 1)), ...past];
  if (find) list = list.filter((r) => String(r.user_name || '').toLowerCase().includes(find));
  const page = list.slice(0, shown);
  // a header row each time the month changes
  const rows = []; let mo = '';
  for (const r of page) { const m = r.start_day.slice(0, 7); if (m !== mo) { mo = m; const n = list.filter((x) => x.start_day.slice(0, 7) === m).length; rows.push({ mo: m, n }); } rows.push(r); }
  const seg = (v, t, n) => html`<button type="button" data-act="q" ${raw(qAttr('when', v === (mgr ? 'up' : 'all') ? '' : v))} aria-pressed="${String(when === v)}">${t}${n != null ? html` <i>${n}</i>` : ''}</button>`;
  const left = list.length - page.length;
  return html`<section class="panel flush lv-reqs"><header><h2>${status ? 'Requests' : 'All requests'}</h2>
      <div class="lv-tools">
        ${mgr ? html`<label class="psearch"><span class="sr">Find a person</span>${icon('search')}<input type="search" placeholder="Find a person" value="${q.get('find') || ''}" data-q="find" autocomplete="off"></label>` : ''}
        <div class="seg" role="group" aria-label="When">${seg('up', 'Now and coming up', up.length)}${seg('past', 'Past', past.length)}${seg('all', 'All')}</div>
        ${select({ q: 'status', value: status, label: 'Status', options: [['', 'Any status'], ['pending', 'Waiting'], ['approved', 'Approved'], ['denied', 'Declined'], ['cancelled', 'Cancelled']] })}
      </div></header>
    <div class="body">${list.length ? table(rows, null) : empty(find ? `Nobody called “${q.get('find')}”` : when === 'up' ? 'Nothing coming up' : 'No requests yet', find ? 'Check the spelling, or clear the search.' : when === 'up' ? 'Approved and declined requests from today on show here. See “Past” for earlier ones.' : mgr ? 'Requests from your people appear here.' : 'Use "Request time off" to ask for days off.')}
      ${left > 0 ? html`<div class="lv-pg"><span class="muted small">Showing ${page.length} of ${list.length}</span><button class="btn sm" type="button" data-act="q" ${raw(qAttr('n', String(shown + PAGE)))}>Show ${Math.min(PAGE, left)} more</button></div>` : ''}</div></section>`;
}

function rules() {
  const n = perMonth();
  return html`<section class="lv-rules" aria-label="How time off works here">
    <div><b>${plural(n, 'paid day')} a month</b><span>Use ${n === 1 ? 'it' : 'them'} that month; unused days don’t carry over.</span></div>
    <div><b>Unpaid, any time</b><span>Take as many as you need. Each one comes off that month’s pay.</span></div>
    ${S.settings.no_sandwich_leave !== false ? html`<div><b>Not next to a weekend</b><span>No time off on a Friday, a Monday or beside a holiday, unless it’s an emergency.</span></div>` : ''}
    <div><b>${ownerFirst()} approves</b><span>Every request goes to ${isOwner() ? 'you' : owner(false)}. You get a notification either way.</span></div></section>`;
}

const code = (r) => ({ 'United States': 'US', Pakistan: 'PK' }[r] || String(r || '').slice(0, 2).toUpperCase());
const wd = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow(d)];

// holidays as a year at a glance: one small card per month, days off in green, other countries' days in blue.
// Runs of the same holiday (Eid over three days) are one line. The next six months show; the rest a click away.
function holidaysPanel(allHol, refs, today) {
  const own = S.me.role === 'owner';
  const items = [
    ...allHol.map((h) => ({ day: h.day, name: h.name, off: true, key: h.day })),
    // a reference day that is also one of our days off shows once, as the day off
    ...refs.filter((r) => !allHol.some((h) => h.day === r.day && h.name.replace(/\s*\(.*\)$/, '') === r.name.replace(/\s*\(.*\)$/, ''))).map((r) => ({ day: r.day, name: r.name, off: false, region: r.region, key: String(r.id) })),
  ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.off === b.off ? 0 : a.off ? -1 : 1));
  // join back-to-back days of the same holiday into one run
  const runs = [];
  for (const it of items) {
    const last = runs.filter((r) => r.name === it.name && r.off === it.off && r.region === it.region).pop();
    if (last && addDays(last.to, 1) === it.day && last.to.slice(0, 7) === it.day.slice(0, 7)) { last.to = it.day; last.keys.push(it.key); }
    else runs.push({ ...it, from: it.day, to: it.day, keys: [it.key] });
  }
  const next = runs.filter((r) => r.to >= today), past = runs.filter((r) => r.to < today && r.from.slice(0, 4) === today.slice(0, 4));
  const months = (list) => { const m = new Map(); for (const r of list) { const k = r.from.slice(0, 7); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m]; };
  const line = (r) => {
    const d1 = Number(r.from.slice(8)), d2 = Number(r.to.slice(8)), span = r.from !== r.to;
    const label = `${r.name}${span ? `, ${dayMD(r.from)} to ${dayMD(r.to)}` : `, ${dayLong(r.from)}`}`;
    return html`<li class="lvy-i ${r.off ? 'off' : 'ref'}${r.to < today ? ' gone' : ''}" data-k="y${r.off ? 'h' : 'o'}${r.keys.join('-')}" title="${label}${r.off ? ': day off' : `: ${r.region || 'elsewhere'}, a working day here`}">
      <span class="lvy-d${span ? ' span' : ''}"><b class="num">${span ? `${d1}–${d2}` : d1}</b><small>${span ? `${r.to.slice(8) - r.from.slice(8) + 1} days` : wd(r.from)}</small></span>
      <span class="lvy-n">${r.name}</span>
      ${r.off ? '' : html`<span class="lvy-c">${code(r.region)}</span>`}
      ${own ? html`<button class="lvy-x" data-act="${r.off ? 'del-holiday' : 'del-ref'}" data-${r.off ? 'day' : 'id'}="${r.keys.join(',')}" aria-label="Remove ${r.name}" title="Remove">${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>')}</button>` : ''}</li>`;
  };
  const card = ([ym, list]) => { const [mn, yr] = monthLabel(ym).split(' '); const offs = list.filter((r) => r.off).reduce((n, r) => n + r.keys.length, 0);
    return html`<section class="lvy-m${ym === today.slice(0, 7) ? ' now' : ''}" data-k="m${ym}"><h3>${mn}${yr !== today.slice(0, 4) ? html` <span>${yr}</span>` : ''}<em>${offs ? plural(offs, 'day off', 'days off') : 'We work'}</em></h3><ul>${list.map(line)}</ul></section>`; };
  const ahead = months(next), soon = ahead.slice(0, 6), later = ahead.slice(6);
  const offCount = next.filter((r) => r.off).reduce((n, r) => n + r.keys.length, 0);
  return html`<section class="panel flush lvy" aria-label="Holidays"><header><h2>Holidays</h2>
      <span class="lvy-key" aria-hidden="true"><span class="off"><i></i>Day off</span><span class="ref"><i></i>Holiday elsewhere, we work</span></span>
      ${own ? html`<span class="lv-hb"><button class="btn sm" data-act="import-holidays">Add a country’s holidays</button><button class="btn sm" data-act="new-holiday">${raw('+')} Add one</button></span>` : ''}</header>
    <div class="body">
      ${!next.length ? empty('No holidays coming up', own ? 'Add your country’s public holidays so they aren’t counted as absences.' : 'Public holidays show here once your company adds them.')
        : html`${!offCount ? html`<p class="lvy-note">${own ? 'None of these are days off yet. Add your own country’s holidays as “Days off” so nobody is marked absent on them.' : 'None of these are days off. Everyone works them as normal.'}</p>` : ''}<div class="lvy-grid">${soon.map(card)}</div>`}
      ${later.length || past.length ? html`<div class="lvy-foot">
        ${later.length ? html`<details class="lvy-more"><summary>Show ${plural(later.length, 'more month')}, to ${monthLabel(later[later.length - 1][0])}</summary><div class="lvy-grid">${later.map(card)}</div></details>` : ''}
        ${past.length ? html`<details class="lvy-more lvy-past"><summary>Earlier this year</summary><div class="lvy-grid">${months(past).map(card)}</div></details>` : ''}</div>` : ''}
    </div></section>`;
}

function leaveBento({ reqs, hol, refs, pending, away, upcoming, mine, mgr, today }) {
  const m = today.slice(0, 7), days = eachDay(`${m}-01`, monthEnd(m)), lead = (dow(days[0]) + 6) % 7;
  const live = reqs.filter((r) => (r.status === 'approved' || r.status === 'pending') && r.end_day >= `${m}-01` && r.start_day <= days[days.length - 1]);
  const hols = hol.filter((h) => h.day.startsWith(m)), rfs = (refs || []).filter((r) => r.day.startsWith(m));
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
  // this month, in date order: holidays (off or for reference), then who is away or asked
  const rows = [
    ...hols.map((h) => ({ day: h.day, k: `h${h.day}`, html: html`<li class="lv-ev hol"><span class="lv-dt"><small>${wd(h.day)}</small>${Number(h.day.slice(8))}</span><span class="lv-ev-t"><b>${h.name}</b><span>Day off for everyone</span></span><span class="lv-tag hol">Day off</span></li>` })),
    ...rfs.map((r) => ({ day: r.day, k: `o${r.id}`, html: html`<li class="lv-ev ref"><span class="lv-dt"><small>${wd(r.day)}</small>${Number(r.day.slice(8))}</span><span class="lv-ev-t"><b>${r.name}</b><span>${r.region || 'Holiday elsewhere'} · a normal working day here</span></span><span class="lv-tag ref">${code(r.region)}</span></li>` })),
    ...live.map((r) => ({ day: r.start_day < `${m}-01` ? `${m}-01` : r.start_day, k: `r${r.id}`, html: html`<li class="lv-ev ${r.status === 'pending' ? 'ask' : 'off'}"><span class="lv-dt"><small>${wd(r.start_day)}</small>${Number(r.start_day.slice(8))}</span><span class="lv-ev-t"><b>${r.user_name}</b><span>${range(r)} · ${r.paid ? 'paid' : 'unpaid'}</span></span><span class="lv-tag ${r.status === 'pending' ? 'ask' : 'off'}">${r.status === 'pending' ? 'Asked' : 'Away'}</span></li>` })),
  ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const chips = rows.map((x) => x.html);
  return html`<section class="kpis bento lv-bento" aria-label="Time off at a glance">
    ${lead1}
    <div class="kpi bt-aw"><div class="l">${icon('users')}Away today</div><div class="bt-row"><div class="v">${away.length}</div>${away.length ? html`<span class="stack bt-faces">${away.slice(0, 5).map((a) => face(a.user_id, a.user_name))}</span>` : ''}</div>
      <div class="f">${away.length ? away.map((a) => first(a.user_name)).join(', ') : upcoming.length ? `Nobody. ${plural(upcoming.length, 'request')} coming up` : 'Nobody'}</div></div>
    <div class="kpi bt-ho"><div class="l">${icon('cal')}Holidays this year</div><div class="v">${hol.length}</div><div class="f">${nextHol ? `Next: ${nextHol.name}, ${dayMD(nextHol.day)}` : hol.length ? 'No more this year' : 'None added yet'}</div></div>
    <div class="kpi bt-ca"><div class="l">${icon('cal')}${monthLabel(m)}<span class="bt-r">Who’s away</span></div>
      <div class="lv-cal">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w) => html`<span class="h">${w}</span>`)}${Array.from({ length: lead }, () => html`<span></span>`)}
        ${days.map((d) => { const o = on(d), h = hols.find((x) => x.day === d), rf = rfs.filter((x) => x.day === d); const cls = (h ? 'hol' : o.some((r) => r.status === 'approved') ? 'off' : o.length ? 'ask' : rf.length ? 'ref' : ''); return html`<span class="d ${cls}${d === today ? ' today' : ''}" title="${[dayLong(d), h ? `${h.name}: day off` : '', ...rf.map((x) => `${x.name} (${x.region || 'elsewhere'}): a working day here`), ...o.map((r) => `${r.user_name}${r.status === 'pending' ? ' (asked)' : ' away'}`)].filter(Boolean).join('\n')}"><b>${Number(d.slice(8))}</b>${h ? html`<small>OFF</small>` : rf.length ? html`<small>${code(rf[0].region)}</small>` : o.length ? html`<small>${o.length}</small>` : ''}</span>`; })}</div>
      <div class="lv-key" aria-hidden="true"><span class="hol"><i></i>Day off</span><span class="ref"><i></i>Holiday elsewhere, we work</span><span class="off"><i></i>Someone away</span><span class="ask"><i></i>Asked</span></div>
      ${chips.length ? html`<ul class="lv-evs" aria-label="This month">${chips}</ul>` : html`<p class="muted small lv-none">No holidays this month and nobody away.</p>`}</div>
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
  if (el.dataset.mine) {
    if (!(await confirmBox({ title: 'Cancel this time off?', message: 'The days go back to being normal working days.', confirm: 'Cancel time off', cancel: 'Keep it', danger: true }))) return;
    try { await del(`/api/timeoff/${el.dataset.id}`); toast('Cancelled'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
    return;
  }
  openModal({
    title: `Cancel ${el.dataset.who}’s time off?`, sub: `${el.dataset.range}. The days go back to being working days.`, submit: 'Cancel time off', cancel: 'Keep it', danger: true,
    body: html`<div class="field"><label class="f" for="cx-r">Why (they see this)</label><textarea id="cx-r" name="reason" maxlength="500" placeholder="A client call moved to that day"></textarea></div>`,
    onSubmit: async (fd) => {
      const reason = String(fd.get('reason') || '').trim();
      if (reason.length < 3) throw new Error('Give a reason; they see it');
      await del(`/api/timeoff/${el.dataset.id}?reason=${encodeURIComponent(reason)}`); toast(`Cancelled. ${first1(el.dataset.who)} gets a notification.`); S.refresh();
    },
  });
};
actions['new-holiday'] = () => openModal({
  title: 'Add a company holiday', submit: 'Add holiday',
  body: html`<div class="field"><label class="f" for="hd">Date</label><input id="hd" type="date" name="day" required></div><div class="field"><label class="f" for="hn">Name</label><input id="hn" name="name" maxlength="100" required placeholder="Eid al-Fitr"></div>`,
  onSubmit: async (fd) => { await post('/api/holidays', { day: fd.get('day'), name: fd.get('name') }); toast('Holiday added'); S.refresh(); },
});
actions['import-holidays'] = async () => {
  const lists = await get('/api/holidays/lists');
  openModal({
    title: 'Add a country’s holidays', submit: 'Add them', sub: 'From today on. Days already on the calendar stay as they are. Islamic holidays are expected dates: move them when the final dates are announced.',
    body: html`<div class="field"><label class="f" for="ih-c">Country</label><select id="ih-c" name="country">${lists.map((l) => html`<option value="${l.code}">${l.name}</option>`)}</select></div>
      <fieldset class="lv-pay"><legend class="f">Add them as</legend>
        <label class="lv-opt"><input type="radio" name="as" value="off" checked><span><b>Days off</b><small>Nobody is expected to work; nobody is marked absent</small></span></label>
        <label class="lv-opt"><input type="radio" name="as" value="reference"><span><b>For reference</b><small>Shown on the calendar; a normal working day</small></span></label></fieldset>`,
    onSubmit: async (fd) => {
      const r = await post('/api/holidays/import', { country: fd.get('country'), as: fd.get('as') });
      toast(r.added ? `${plural(r.added, 'day')} added for ${r.country}${r.kept ? `, ${r.kept} already there` : ''}` : `Nothing new: ${r.country}’s holidays are already on the calendar`); S.refresh();
    },
  });
};
actions['del-ref'] = async (el) => { try { for (const id of el.dataset.id.split(',')) await del(`/api/observances/${id}`); toast('Removed'); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['del-holiday'] = async (el) => {
  if (!(await confirmBox({ title: 'Remove this holiday?', message: 'People will be expected to work that day again.', confirm: 'Remove', danger: true }))) return;
  try { for (const d of el.dataset.day.split(',')) await del(`/api/holidays/${d}`); toast('Holiday removed'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
