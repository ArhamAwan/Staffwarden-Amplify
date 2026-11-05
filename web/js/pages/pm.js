// Projects run by their manager: the Team tab (the manager, their stand-in, the people under them and who
// can do what), Plan today (put the project's tasks on each person's day and send it), "Waiting for you"
// (work the manager is asked to approve), "Your day" for the person, and @mentions on the task page.
import { html, raw, esc, plural, dayShort, dayLong, addDays, icon, initials, avColor, relTime, tod, nowMs } from '../util.js';
import { get, post, put, del, patch, qs } from '../api.js';
import { S, actions, empty, toast, errMsg, openModal, confirmBox, qAttr } from '../ui.js';
import { morph } from '../morph.js';

const first = (n) => String(n || '').split(/\s+/)[0];
const av = (id, name, cls = '') => html`<span class="avatar${cls ? ` ${cls}` : ''}" style="background:${avColor(id)}" aria-hidden="true">${initials(name)}</span>`;
export const hrs = (min) => { if (min == null) return null; const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`; };
const PRIO = { urgent: 'Urgent', high: 'High' };
// "6 PM–3:30 AM"
const clockShort = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}\u00a0${h < 12 ? 'AM' : 'PM'}`; };
const shiftShort = (a, b) => (a && b ? `${clockShort(a)}–${clockShort(b)}` : '');

// ================================================================================================
// @mentions
// ================================================================================================
// Text with "@Full Name" for anyone in the list lit up; the rest escaped. The longest names go first so
// "@Ali Subhan" is never cut down to "@Ali".
export function withMentions(text, names) {
  let h = esc(text == null ? '' : String(text).replace(/\u0000/g, ''));
  const list = [...new Set((names || []).filter(Boolean))].sort((a, b) => b.length - a.length);
  const marks = [];
  for (const n of list) {
    const tag = `@${esc(n)}`;
    let i = h.indexOf(tag);
    while (i !== -1) {
      const next = h.charAt(i + tag.length);
      if (!/[\p{L}\p{N}_]/u.test(next)) {
        const me = S.me && n === S.me.name;
        marks.push(`<span class="mention${me ? ' me' : ''}">${tag}</span>`);
        const ph = `\u0000${marks.length - 1}\u0000`;
        h = h.slice(0, i) + ph + h.slice(i + tag.length);
        i = h.indexOf(tag, i + ph.length);
      } else i = h.indexOf(tag, i + 1);
    }
  }
  h = h.replace(/\u0000(\d+)\u0000/g, (_, k) => marks[Number(k)]);
  return raw(h);
}

// The people the field at hand can mention, set by the page (the task page sets its task's people).
let pool = [];
export function setMentionPool(list) { pool = Array.isArray(list) ? list : []; }

// Autocomplete for any field marked data-mention: type @ and a few letters, pick a person with the
// arrow keys and Enter (or a tap). Enter and Tab pick while the list is open, so they never send.
let menu = null, field = null, hits = [], at = 0, start = -1;
function closeMenu() { if (menu) menu.remove(); menu = null; field = null; hits = []; start = -1; }
function place() {
  if (!menu || !field) return;
  const r = field.getBoundingClientRect(), h = menu.offsetHeight, w = Math.min(340, Math.max(260, r.width));
  // in the lower half of the screen the list opens above the field, so it never covers the send button
  const roomBelow = window.innerHeight - r.bottom > h + 12, roomAbove = r.top > h + 12;
  const below = r.top + r.height / 2 < window.innerHeight / 2 ? roomBelow || !roomAbove : !roomAbove;
  menu.style.width = `${w}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  menu.style.top = `${below ? r.bottom + 6 : r.top - h - 6}px`;
}
function paintMenu() {
  if (!menu) return;
  menu.innerHTML = hits.map((p, i) => { const sub = p.role ? (p.role === 'manager' ? 'Project manager' : 'Stand-in') : p.title || ''; return `<button type="button" role="option" id="mn-${i}" class="mn-o" aria-selected="${i === at}" data-i="${i}">${av(p.id, p.name, 'sm')}<span class="mn-t"><b>${esc(p.name)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span></button>`; }).join('')
    + '<p class="mn-foot">Only people on this project can be mentioned. They get a notification that opens this spot.</p>';
  field.setAttribute('aria-activedescendant', `mn-${at}`);
}
function check(el) {
  const v = el.value.slice(0, el.selectionStart);
  const m = /(?:^|[\s(])@([^\s@]{0,24}(?: [^\s@]{0,24})?)$/u.exec(v);
  if (!m) return closeMenu();
  const q = m[1].toLowerCase();
  const list = pool.filter((p) => p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).slice(0, 6);
  if (!list.length) return closeMenu();
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'mn-menu'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'People on this project');
    menu.addEventListener('mousedown', (e) => e.preventDefault());   // keep the field focused
    menu.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(Number(b.dataset.i)); });
    document.body.appendChild(menu);
  }
  field = el; hits = list; at = Math.min(at, list.length - 1); start = v.length - m[1].length - 1;
  paintMenu(); place();
}
function pick(i) {
  const p = hits[i]; if (!p || !field) return;
  const el = field, end = el.selectionStart;
  const text = `@${p.name} `;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  closeMenu(); el.focus();
}
document.addEventListener('input', (e) => { const el = e.target; if (el && el.matches && el.matches('[data-mention]')) { if (field !== el) at = 0; check(el); } });
document.addEventListener('keydown', (e) => {
  if (!menu || e.target !== field) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; paintMenu(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(at); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
}, true);
document.addEventListener('focusout', (e) => { if (e.target === field) setTimeout(() => { if (document.activeElement !== field) closeMenu(); }, 120); });
document.addEventListener('click', (e) => { if (e.target && e.target.matches && e.target.matches('[data-mention]')) check(e.target); });
window.addEventListener('resize', place);
document.addEventListener('scroll', place, true);
window.addEventListener('hashchange', closeMenu);

// ================================================================================================
// The Team tab
// ================================================================================================
const roleName = (r) => (r === 'lead' ? 'Project manager' : r === 'deputy' ? 'Stand-in' : 'Member');
export function teamTab(p, plan) {
  const mgr = p.lead, dep = p.deputy, owner = p.owner;
  const mName = mgr ? first(mgr.name) : 'the manager';
  const ownerName = owner ? first(owner.name) : 'The owner';
  const team = [...p.workload].sort((a, b) => (a.role === 'lead') - (b.role === 'lead') || (a.role === 'deputy') - (b.role === 'deputy') || a.name.localeCompare(b.name));
  const today = plan ? new Map(plan.people.map((x) => [x.user_id, x])) : null;
  const todayCell = (uid) => {
    const d = today && today.get(uid);
    if (!d) return html`<span class="faint">–</span>`;
    if (d.status === 'leave') return html`<span class="pmc amber">On leave</span>`;
    if (d.status === 'holiday') return html`<span class="pmc">Holiday</span>`;
    const here = d.tasks.filter((t) => t.here);
    if (!d.tasks.length) return d.status === 'off' ? html`<span class="faint">Day off</span>` : d.role === 'manager' ? html`<span class="faint">Plans the day</span>` : html`<span class="pmc amber">Nothing planned</span>`;
    return html`<span>${plural(d.tasks.length, 'task')}${d.planned_min ? ` · ${hrs(d.planned_min)} of ${hrs(d.capacity_min) || '0h'}` : ''}${here.length < d.tasks.length ? html` <span class="faint">(${d.tasks.length - here.length} elsewhere)</span>` : ''}</span>`;
  };
  const cols = !!plan;
  return html`<div class="pm-team">
    <div class="pm-col">
      ${mgr ? html`<section class="pm-mgr" aria-labelledby="pm-mh">
          ${av(mgr.id, mgr.name, 'lg')}
          <div class="pm-mgr-t"><span class="pmc pm">Project manager</span><b id="pm-mh">${mgr.name}</b>
            <span>Runs ${p.name}: changes anything in it, decides who works on it, plans their days and approves their work.${mgr.away ? html` <b class="amber-ink">On leave today${dep ? `, so ${first(dep.name)} approves.` : '.'}</b>` : ''}</span></div>
          ${p.can_pick_manager ? html`<button type="button" class="btn sm" data-act="pm-pick" data-v="lead">Change manager</button>` : ''}
        </section>`
        : html`<section class="pm-mgr none" aria-labelledby="pm-mh"><span class="avatar lg none" aria-hidden="true">?</span>
          <div class="pm-mgr-t"><b id="pm-mh">No project manager yet</b><span>Until someone runs ${p.name}, its finished work waits for ${p.can_pick_manager && S.me.role === 'owner' ? 'you' : ownerName} to approve.</span></div>
          ${p.can_pick_manager ? html`<button type="button" class="btn primary sm" data-act="pm-pick" data-v="lead">Choose a manager</button>` : ''}</section>`}
      ${mgr ? (dep ? html`<section class="pm-dep" aria-labelledby="pm-dh">${av(dep.id, dep.name)}<div class="pm-grow"><b id="pm-dh">${dep.name} stands in</b><span>When ${mName} is on leave, or for work ${mName} does herself, ${first(dep.name)} plans and approves instead.</span></div>${p.can_manage ? html`<button type="button" class="btn sm quiet" data-act="pm-pick" data-v="deputy">Change</button>` : ''}</section>`
        : html`<section class="pm-dep none" aria-labelledby="pm-dh"><span class="avatar none" aria-hidden="true">?</span><div class="pm-grow"><b id="pm-dh">No stand-in yet</b><span>Work ${mName} does herself, and everything while ${mName} is on leave, goes to ${ownerName} to approve. Choose a stand-in so it doesn’t.</span></div>${p.can_manage ? html`<button type="button" class="btn sm" data-act="pm-pick" data-v="deputy">Choose a stand-in</button>` : ''}</section>`) : ''}
      <section class="panel flush pm-people" aria-labelledby="pm-th">
        <header><h2 id="pm-th">${mgr ? `Working under ${mName}` : 'The team'} <span class="muted">${p.workload.filter((w) => w.role !== 'lead').length}</span></h2>${p.can_manage ? html`<button class="btn sm" data-act="project-add-members">${raw('+')} Add people</button>` : ''}</header>
        <div class="pm-row pm-head${cols ? '' : ' np'}" aria-hidden="true"><span>Person</span>${cols ? html`<span>Today</span>` : ''}<span class="r">Open</span><span></span></div>
        ${team.length ? team.map((w) => html`<div class="pm-row${cols ? '' : ' np'}" data-k="m${w.user_id}">
            <span class="pm-who">${av(w.user_id, w.name)}<span class="pm-grow"><b>${w.name}${w.user_id === S.me.id ? html` <span class="faint">(you)</span>` : ''}</b><span class="muted small">${w.title || ''}${w.role === 'deputy' ? `${w.title ? ' · ' : ''}stands in for ${mName}` : ''}</span></span></span>
            ${cols ? html`<span class="pm-today small">${todayCell(w.user_id)}</span>` : ''}
            <span class="pm-open num r">${w.open}${w.overdue ? html` <span class="bad-ink small">· ${w.overdue} late</span>` : ''}</span>
            <span class="pm-end"><span class="pmc${w.role === 'lead' ? ' pm' : w.role === 'deputy' ? ' dep' : ''}">${roleName(w.role)}</span>${p.can_manage && w.role !== 'lead' ? html`<button type="button" class="pm-x" data-act="project-remove-member" data-id="${w.user_id}" data-name="${w.name}" aria-label="Remove ${w.name} from ${p.name}" title="Remove from the project">${icon('x')}</button>` : html`<span class="pm-x-s" aria-hidden="true"></span>`}</span>
          </div>`) : html`<div class="body pad">${empty('Nobody on the team yet', p.can_manage ? 'Add the people who work on this project.' : '')}</div>`}
        <p class="pm-foot small muted">${p.access === 'everyone' ? 'Everyone in the company can see this project; the team are the people working on it.' : 'Only the team sees this project and its tasks, and only they can track time on it.'} Giving someone a task adds them to the team.</p>
      </section>
    </div>
    <aside class="pm-side">
      <section class="panel pm-who-can" aria-labelledby="pm-wc"><header><h2 id="pm-wc">Who can do what</h2></header><div class="body">
        <div class="pm-mx" role="table" aria-label="Who can do what">
          <div role="row" class="pm-mx-h"><span role="columnheader"><span class="sr">Can</span></span><span role="columnheader">${mgr ? first(mgr.name) : 'Manager'}</span><span role="columnheader">Stand-in</span><span role="columnheader">Team</span></div>
          ${[
            ['Change the project, its team and client settings', 1, 0, 0],
            ['Create tasks and give them to people', 1, 1, 'Own only'],
            ['Plan who does what each day', 1, 1, 0],
            ['Approve finished work, or send it back', 1, 'When asked', 0],
            ['Comment, pin, @mention, track time', 1, 1, 1],
          ].map(([what, a, b, c]) => html`<div role="row"><span role="cell">${what}</span>${[a, b, c].map((v) => html`<span role="cell" class="${v === 1 ? 'yes' : v === 0 ? 'no' : 'some'}">${v === 1 ? 'Yes' : v === 0 ? 'No' : v}</span>`)}</div>`)}
        </div></div></section>
      <section class="panel pm-owner" aria-labelledby="pm-oh"><div class="body">
        <div class="pm-oh">${owner ? av(owner.id, owner.name, 'sm') : ''}<h2 id="pm-oh">${owner ? `${owner.name}, as the owner` : 'The owner'}</h2></div>
        <p class="muted">Sees every project and can step in, but isn’t asked to approve anything while ${p.name} has a manager${dep ? ' and a stand-in' : ''}. Picks each project’s manager.</p></div></section>
    </aside>
  </div>`;
}

// choose the manager (owner or a manager) or the stand-in (the manager)
actions['pm-pick'] = async (el) => {
  const p = S.project; if (!p) return;
  const lead = el.dataset.v === 'lead';
  const people = lead ? await get('/api/directory') : p.members.filter((m) => m.id !== (p.lead && p.lead.id));
  const curId = lead ? p.lead && p.lead.id : p.deputy && p.deputy.id;
  openModal({
    title: lead ? `Who manages ${p.name}?` : `Who stands in for ${p.lead ? first(p.lead.name) : 'the manager'}?`,
    sub: lead ? 'They change anything in the project, choose who works on it, plan their days and approve their work.' : 'They plan and approve when the manager is on leave, and approve work the manager does themselves.',
    submit: 'Save',
    body: html`${people.length ? html`<input class="search" type="search" placeholder="Find a person" data-filter-people style="width:100%!important;margin-bottom:8px" aria-label="Find a person">
      <div class="pickl" role="radiogroup">${!lead ? html`<label class="pick" data-name="nobody"><input type="radio" name="who" value="" ${raw(!curId ? 'checked' : '')}><span class="avatar sm none" aria-hidden="true">–</span><span><b>Nobody</b><span class="muted small"> · the owner covers</span></span></label>` : ''}
        ${people.map((u) => html`<label class="pick" data-name="${u.name.toLowerCase()}"><input type="radio" name="who" value="${u.id}" ${raw(u.id === curId ? 'checked' : '')}>${av(u.id, u.name, 'sm')}<span><b>${u.name}</b>${u.title ? html`<span class="muted small"> · ${u.title}</span>` : ''}</span></label>`)}</div>`
      : html`<p class="muted">Add people to the team first. The stand-in is someone on the team.</p>`}`,
    onSubmit: async (fd) => {
      const v = fd.get('who');
      if (lead && !v) throw new Error('Choose a person');
      await patch(`/api/projects/${p.id}`, lead ? { lead_id: Number(v) } : { deputy_id: v ? Number(v) : null });
      toast(lead ? 'Project manager changed' : v ? 'Stand-in chosen' : 'No stand-in now');
      S.refresh();
    },
  });
};

// ================================================================================================
// Plan today
// ================================================================================================
export const loadPlan = (p, day) => get(`/api/projects/${p.id}/plan${qs({ day })}`);
let board = null;
const capText = (d) => (!d.planned_min ? (d.tasks && d.tasks.length ? 'No estimates yet' : 'Nothing yet') : d.capacity_min ? `${hrs(d.planned_min)} of ${hrs(d.capacity_min)}` : hrs(d.planned_min));
function statusChip(d) {
  if (d.status === 'leave') return html`<span class="pmc amber">On leave</span>`;
  if (d.status === 'holiday') return html`<span class="pmc">${d.holiday || 'Holiday'}</span>`;
  if (d.status === 'off') return html`<span class="pmc">Day off</span>`;
  if (d.starts_in_min != null) return html`<span class="faint small">Starts in ${hrs(Math.round(d.starts_in_min / 15) * 15 || 15)}</span>`;
  if (d.shift_over) return html`<span class="faint small">Shift over</span>`;
  return '';
}
function card(t, { planned = false, n = null, draggable = true, uid = null } = {}) {
  const st = t.status === 'done' ? html`<span class="pmc green">Done</span>` : t.status === 'in_review' ? html`<span class="pmc">In review</span>` : t.status === 'in_progress' ? html`<span class="pl-dot" title="In progress"></span>` : '';
  const other = planned && !t.here;
  const meta = [t.estimate_min ? `about ${hrs(t.estimate_min)}` : null, t.due_day ? `due ${dayShort(t.due_day).replace(/^\w+, /, '')}` : null].filter(Boolean).join(' · ');
  const can = draggable && !other && !['done', 'in_review'].includes(t.status);
  return html`<article class="pl-card${planned ? ' on' : ''}${other ? ' other' : ''}${t.status === 'done' ? ' did' : ''}" data-k="pc${t.id}" data-task="${t.id}" ${raw(can ? 'draggable="true"' : '')} ${raw(uid ? `data-uid="${uid}"` : '')}>
    <div class="pl-k">${n != null ? html`<span class="num">${n}</span><i aria-hidden="true">·</i>` : ''}<span>${t.key || ''}</span>${other ? html`<span class="pl-proj" style="--pc:${t.project_color}">${t.project_key}</span>` : ''}${PRIO[t.priority] ? html`<span class="pmc red">${PRIO[t.priority]}</span>` : ''}${st}</div>
    <b class="pl-t">${t.title}</b>
    <div class="pl-m">${!planned && t.assignee ? html`${av(t.assignee_id, t.assignee, 'xs')}<span>${first(t.assignee)}</span>${meta ? html`<i aria-hidden="true">·</i>` : ''}` : ''}<span>${meta || (t.estimate_min == null && !other ? 'No estimate' : '')}</span>
      ${can ? html`<button type="button" class="pl-more" data-act="pl-menu" data-id="${t.id}" aria-label="${planned ? `Move ${t.key || t.title}` : `Plan ${t.key || t.title} for someone`}">${planned ? icon('right') : icon('plus')}</button>` : other ? html`<span class="pl-else">Planned by ${t.project_key}</span>` : ''}</div>
  </article>`;
}
function column(d, b) {
  const over = d.capacity_min && d.planned_min > d.capacity_min;
  const pct = d.capacity_min ? Math.min(100, Math.round((100 * d.planned_min) / d.capacity_min)) : 0;
  const leave = d.status === 'leave';
  const empty_ = !d.tasks.length;
  const nth = new Map(d.tasks.map((t, i) => [t.id, i + 1]));
  return html`<section class="pl-col${leave ? ' leave' : ''}${empty_ && !leave && d.status === 'work' && b.editable && b.day === b.today ? ' want' : ''}" data-k="u${d.user_id}" data-drop="${leave || !b.editable ? '' : d.user_id}" aria-label="${d.name}">
    <header class="pl-ch">${av(d.user_id, d.name, 'sm')}<b class="ell" title="${d.name}">${d.name}</b></header>
    ${d.role !== 'member' ? html`<span class="pl-role faint small">${d.role === 'manager' ? 'Project manager' : 'Stand-in'}</span>` : ''}
    ${leave ? html`<span class="pmc amber" style="align-self:flex-start">On leave ${b.day === b.today ? 'today' : 'this day'}</span><p class="muted small pl-note">Approved time off. Tasks can’t be planned for ${first(d.name)}.</p>`
      : html`<div class="pl-cap"><div class="pl-cap-l small"><span class="${over ? 'amber-ink' : 'muted'}">${capText(d)}</span><span class="faint">${d.status === 'work' ? shiftShort(d.shift_start, d.shift_end) : ''}</span></div>
          <span class="pl-bar${over ? ' over' : ''}" role="img" aria-label="${capText(d)} planned${over ? `, ${hrs(d.planned_min - d.capacity_min)} over` : ''}"><i style="width:${pct}%"></i></span>${over || statusChip(d) || d.no_estimate ? html`<div class="pl-st">${over ? html`<span class="pmc amber">${hrs(d.planned_min - d.capacity_min)} over</span>` : ''}${statusChip(d)}${d.no_estimate ? html`<span class="faint small">${plural(d.no_estimate, 'task')} without an estimate</span>` : ''}</div>` : ''}</div>
        <div class="pl-list" data-list="${d.user_id}">${d.tasks.map((t) => card(t, { planned: true, n: nth.get(t.id), draggable: b.editable, uid: d.user_id }))}
          ${empty_ ? html`<div class="pl-drop">${b.editable ? html`<span class="pl-mouse">Drop a task here</span><span class="pl-touch">Use + on a task to plan it here</span>${d.status === 'work' && d.starts_in_min != null ? html`<br><span>${first(d.name)} starts in ${hrs(Math.round(d.starts_in_min / 15) * 15 || 15)}.</span>` : ''}` : 'Nothing was planned'}</div>` : ''}</div>`}
  </section>`;
}
export function planTab(p, b) {
  board = b;
  if (!b) return html`<section class="panel">${empty('Only the project manager plans the day', 'Your own day is on your Tasks page once it is sent.')}</section>`;
  const isToday = b.day === b.today;
  const planned = b.people.reduce((n, d) => n + d.tasks.filter((t) => t.here).length, 0);
  const tomorrow = addDays(b.today, 1);
  const dayName = isToday ? 'Today' : b.day === tomorrow ? 'Tomorrow' : dayShort(b.day);
  const sentTo = b.people.filter((d) => d.tasks.some((t) => t.here)).map((d) => first(d.name));
  return html`<div class="pl" data-k="plan-${b.day}">
    <div class="pl-top">
      <div class="pl-day"><span class="pl-dn" role="group" aria-label="Day"><button type="button" class="btn icon sm" data-act="q" ${raw(qAttr('day', addDays(b.day, -1) === b.today ? '' : addDays(b.day, -1)))} aria-label="Day before" ${raw(addDays(b.day, -1) < addDays(b.today, -60) ? 'disabled' : '')}>${icon('left')}</button>
        <b class="pl-dl">${dayName}<span class="muted">${isToday || b.day === tomorrow ? `, ${dayLong(b.day).replace(/^\w+, /, '')}` : ''}</span></b>
        <button type="button" class="btn icon sm" data-act="q" ${raw(qAttr('day', addDays(b.day, 1) === b.today ? '' : addDays(b.day, 1)))} aria-label="Next day" ${raw(addDays(b.day, 1) > addDays(b.today, 14) ? 'disabled' : '')}>${icon('right')}</button>
        ${!isToday ? html`<button type="button" class="btn sm" data-act="q" ${raw(qAttr('day', ''))}>Today</button>` : ''}</span></div>
      <div class="pl-tools">${b.editable && b.prev_day ? html`<button type="button" class="btn sm" data-act="pl-copy">Same as ${b.prev_day === addDays(b.day, -1) ? (b.prev_day === b.today ? 'today' : 'the day before') : dayShort(b.prev_day)}</button>` : ''}
        ${b.editable ? html`<button type="button" class="btn primary sm" data-act="pl-send" ${raw(planned ? '' : 'disabled')}>${b.sent ? 'Send the day again' : 'Send everyone their day'}</button>` : ''}</div>
    </div>
    <p class="muted small pl-hint">${b.editable ? 'Drag a task onto a person, or use its + button. Each person sees only their own day, in this order, once you send it.' : 'This day has gone by. You can look, but not change it.'}</p>
    <div class="pl-board" role="list">
      <section class="pl-col back" data-drop="${b.editable ? 'back' : ''}" aria-label="Not planned yet" role="listitem">
        <header class="pl-ch"><b>Not planned yet</b><span class="pmc">${b.backlog.length}</span></header>
        <div class="pl-list">${b.backlog.length ? b.backlog.map((t) => card(t, { draggable: b.editable })) : html`<div class="pl-drop">Everything open is planned.</div>`}</div>
        ${p.can_plan ? html`<button type="button" class="btn sm quiet pl-new" data-act="task-new" data-project="${p.id}">${raw('+')} New task</button>` : ''}
      </section>
      ${b.people.map((d) => html`<div role="listitem" class="pl-li">${column(d, b)}</div>`)}
    </div>
    <section class="pl-sent${b.sent ? ' is' : ''}" aria-live="polite">${b.sent
      ? html`<span class="pmc green">Sent at ${tod(b.sent.sent_at, (S.me.tz_offset_min ?? S.settings.tz_offset_min))}</span><span class="pl-grow muted">${b.sent.by ? `${first(b.sent.by)} sent it. ` : ''}Changes after this tell the person straight away.</span>`
      : html`<span class="pmc">Not sent</span><span class="pl-grow muted">${planned ? `Nobody sees this yet. Send it and ${sentTo.slice(0, 3).join(', ')}${sentTo.length > 3 ? ` and ${sentTo.length - 3} more` : ''} ${sentTo.length === 1 ? 'gets their' : 'get their'} day.` : 'Plan a task, then send everyone their day.'}</span>`}</section>
  </div>`;
}

// ---- changing the plan: every change comes back as the whole board, drawn without a reload
let redraw = () => S.refresh();
export function setPlanRedraw(fn) { redraw = fn; }
const pid = () => board && board.project.id;
async function apply(promise, msg) {
  try { const b = await promise; board = b; redraw(b); if (msg) toast(typeof msg === 'function' ? msg(b) : msg); return b; } catch (e) { toast(errMsg(e), true); S.refresh(); return null; }
}
const planOn = (taskId, uid, before = null) => apply(post(`/api/projects/${pid()}/plan`, { day: board.day, task_id: taskId, user_id: uid, before_task_id: before }));
const unplan = (taskId) => apply(del(`/api/projects/${pid()}/plan/${taskId}?day=${board.day}`));
const findTask = (id) => board.backlog.find((t) => t.id === id) || board.people.flatMap((d) => d.tasks.map((t) => ({ ...t, uid: d.user_id }))).find((t) => t.id === id);

actions['pl-send'] = async () => {
  if (!board) return;
  const people = board.people.filter((d) => d.tasks.some((t) => t.here));
  const nothing = board.people.filter((d) => d.status === 'work' && !d.tasks.length).map((d) => first(d.name));
  if (nothing.length && !(await confirmBox({ title: 'Send with someone’s day empty?', message: `${nothing.join(', ')} ${nothing.length === 1 ? 'has' : 'have'} nothing planned. Send anyway?`, confirm: 'Send' }))) return;
  apply(post(`/api/projects/${pid()}/plan/send`, { day: board.day }), (b) => `Sent to ${plural(b.told || people.length, 'person', 'people')}`);
};
actions['pl-copy'] = async () => {
  if (!board) return;
  apply(post(`/api/projects/${pid()}/plan/copy`, { day: board.day }), (b) => (b.copied ? `${plural(b.copied, 'task')} planned like ${dayShort(b.from)}${b.skipped ? `. ${plural(b.skipped, 'task')} left out: done, moved or on leave` : ''}` : 'Nothing to copy: those tasks are done or already planned'));
};
// + on a card: plan it for someone, move it, change its place, or take it off the day
actions['pl-menu'] = (el) => {
  const id = Number(el.dataset.id), t = findTask(id); if (!t) return;
  const people = board.people.filter((d) => d.status !== 'leave');
  const planned = t.uid != null;
  const list = planned ? board.people.find((d) => d.user_id === t.uid).tasks.filter((x) => x.here) : [];
  const idx = list.findIndex((x) => x.id === id);
  const m = openModal({
    title: `${planned ? 'Move' : 'Plan'} ${t.key || ''} ${t.title}`.replace(/\s+/g, ' '),
    sub: planned ? `On ${first(board.people.find((d) => d.user_id === t.uid).name)}’s day, number ${idx + 1}` : 'Choose whose day it goes on. It goes last; drag it to change its place.',
    submit: planned ? 'Move' : 'Plan it',
    body: html`<div class="pickl pl-pick" role="radiogroup" aria-label="Person">${people.map((d) => html`<label class="pick"><input type="radio" name="uid" value="${d.user_id}" ${raw(d.user_id === (t.uid ?? t.assignee_id) ? 'checked' : '')}>${av(d.user_id, d.name, 'sm')}<span class="pm-grow"><b>${d.name}</b><span class="muted small">${d.status === 'off' ? 'Day off' : d.status === 'holiday' ? 'Holiday' : capText(d)}${d.role !== 'member' ? ` · ${d.role === 'manager' ? 'Project manager' : 'Stand-in'}` : ''}</span></span></label>`)}</div>
      ${planned ? html`<div class="pl-acts">${idx > 0 ? html`<button type="button" class="btn sm" data-pl="up">${icon('left')} Earlier in the day</button>` : ''}${idx < list.length - 1 ? html`<button type="button" class="btn sm" data-pl="down">Later in the day ${icon('right')}</button>` : ''}<button type="button" class="btn sm" data-pl="off">Back to not planned</button><a class="btn sm quiet" href="#/task?id=${t.id}">Open the task</a></div>` : html`<p class="hint"><a href="#/task?id=${t.id}">Open the task</a></p>`}`,
    onSubmit: async (fd) => {
      const uid = Number(fd.get('uid'));
      if (!uid) throw new Error('Choose a person');
      if (planned && uid === t.uid) return true;
      await planOn(id, uid);
      const d = board.people.find((x) => x.user_id === uid);
      toast(`On ${first(d.name)}’s day`);
    },
  });
  m.form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pl]'); if (!b) return;
    e.preventDefault(); m.close();
    if (b.dataset.pl === 'off') return unplan(id);
    const order = list.map((x) => x.id), j = idx + (b.dataset.pl === 'up' ? -1 : 1);
    [order[idx], order[j]] = [order[j], order[idx]];
    apply(put(`/api/projects/${pid()}/plan/order`, { day: board.day, user_id: t.uid, task_ids: order }));
  });
};

// ---- drag and drop: onto a person (before the card under the pointer), within a day, or back
let drag = null;
export function planAfter(view) {
  const root = view.querySelector('.pl-board'); if (!root) return;
  // a soft edge where more people are off to the side
  const edge = () => { root.classList.toggle('more-r', root.scrollLeft + root.clientWidth < root.scrollWidth - 4); root.classList.toggle('more-l', root.scrollLeft > 4); };
  edge();
  if (root.dataset.wired) return;
  root.dataset.wired = '1';
  root.addEventListener('scroll', edge, { passive: true });
  window.addEventListener('resize', edge);
  const clear = () => { root.querySelectorAll('.pl-hover').forEach((x) => x.classList.remove('pl-hover')); root.querySelectorAll('.pl-gap').forEach((x) => x.remove()); };
  const beforeOf = (list, y) => [...list.querySelectorAll('.pl-card:not(.dragging):not(.other)')].find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  root.addEventListener('dragstart', (e) => {
    const c = e.target.closest('.pl-card[draggable="true"]'); if (!c) return;
    drag = { id: Number(c.dataset.task), from: c.dataset.uid ? Number(c.dataset.uid) : null };
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(drag.id));
    requestAnimationFrame(() => c.classList.add('dragging'));
  });
  root.addEventListener('dragend', (e) => { const c = e.target.closest('.pl-card'); if (c) c.classList.remove('dragging'); clear(); drag = null; });
  root.addEventListener('dragover', (e) => {
    if (!drag) return;
    const col = e.target.closest('[data-drop]'); if (!col || !col.dataset.drop) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (!col.classList.contains('pl-hover')) { clear(); col.classList.add('pl-hover'); }
    if (col.dataset.drop === 'back') return;
    const list = col.querySelector('.pl-list'); if (!list) return;
    const b = beforeOf(list, e.clientY);
    let gap = list.querySelector('.pl-gap');
    if (!gap) { gap = document.createElement('div'); gap.className = 'pl-gap'; }
    if (b) { if (gap.nextElementSibling !== b) list.insertBefore(gap, b); } else if (list.lastElementChild !== gap) list.appendChild(gap);
  });
  root.addEventListener('dragleave', (e) => { const col = e.target.closest('[data-drop]'); if (col && !col.contains(e.relatedTarget)) { col.classList.remove('pl-hover'); const g = col.querySelector('.pl-gap'); if (g) g.remove(); } });
  root.addEventListener('drop', async (e) => {
    if (!drag) return;
    const col = e.target.closest('[data-drop]'); if (!col || !col.dataset.drop) return;
    e.preventDefault();
    const d = drag; drag = null;
    if (col.dataset.drop === 'back') { clear(); if (d.from != null) unplan(d.id); return; }
    const uid = Number(col.dataset.drop), list = col.querySelector('.pl-list');
    const gap = list && list.querySelector('.pl-gap');
    let before = gap && gap.nextElementSibling && gap.nextElementSibling.classList.contains('pl-card') ? Number(gap.nextElementSibling.dataset.task) : null;
    clear();
    if (before === d.id) return;
    if (d.from === uid) {   // a new place in the same day
      const ids = board.people.find((x) => x.user_id === uid).tasks.filter((t) => t.here).map((t) => t.id).filter((x) => x !== d.id);
      const at = before == null ? ids.length : ids.indexOf(before);
      if (at === -1) return;
      ids.splice(at, 0, d.id);
      apply(put(`/api/projects/${pid()}/plan/order`, { day: board.day, user_id: uid, task_ids: ids }));
      return;
    }
    const person = board.people.find((x) => x.user_id === uid);
    if (before != null && !person.tasks.some((t) => t.id === before)) before = null;
    await planOn(d.id, uid, before);
  });
}

// ================================================================================================
// "Waiting for you": the work this person is asked to approve
// ================================================================================================
export const reviewPage = {
  title: 'Waiting for you',
  after(view) {
    // on a phone the details sit under the list: show them when a task was picked
    if (/[?&]id=/.test(location.hash) && window.innerWidth < 900) { const d = view.querySelector('.rv-d'); if (d) setTimeout(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60); }
  },
  async load(q) {
    const list = await get('/api/tasks?review=mine&status=in_review&done_days=1');
    list.sort((a, b) => String(a.submitted_at || a.updated_at).localeCompare(String(b.submitted_at || b.updated_at)));
    const id = Number(q.get('id')) || (list[0] && list[0].id);
    const t = id && list.some((x) => x.id === id) ? await get(`/api/tasks/${id}`) : null;
    return { list, t };
  },
  render({ list, t }) {
    setMentionPool(t ? t.mention_pool : []);
    const age = (x) => (x.submitted_at ? relTime(x.submitted_at) : '');
    const hours = (x) => (x.submitted_at ? (nowMs() - Date.parse(x.submitted_at)) / 3600000 : 0);
    const projs = [...new Set(list.map((x) => x.project).filter(Boolean))];
    return html`<div class="page-h"><div><h1>Waiting for you</h1><p class="sub">${list.length ? `Finished work from ${projs.length === 1 ? projs[0] : projs.length ? 'the projects you manage' : 'your team'}, oldest first` : 'Finished work that you approve shows here'}</p></div>
      <div class="tools"><a class="btn" href="#/tasks">${icon('tasks')} All tasks</a></div></div>
      ${list.length ? html`<div class="rv">
        <section class="panel flush rv-list" aria-labelledby="rv-lh"><header><h2 id="rv-lh">To review <span class="muted">${list.length}</span></h2><span class="muted small">Oldest first</span></header>
          <div class="rv-items">${list.map((x) => html`<a class="rv-i${t && t.id === x.id ? ' on' : ''}" href="#/review?id=${x.id}" data-k="r${x.id}" ${raw(t && t.id === x.id ? 'aria-current="true"' : '')}>${x.assignee ? av(x.assignee_id, x.assignee, 'sm') : ''}<span class="pm-grow"><b>${x.title}</b><span class="muted small">${[x.key, x.assignee, age(x) ? `sent ${age(x)}` : ''].filter(Boolean).join(' · ')}</span></span>${hours(x) >= 3 ? html`<span class="pmc amber" title="Waiting for over ${Math.floor(hours(x))} hours">${Math.floor(hours(x))}h</span>` : ''}</a>`)}</div></section>
        <div class="rv-main">${t ? detail(t) : html`<section class="panel">${empty('Pick a task', '')}</section>`}
          <section class="panel rv-who" aria-labelledby="rv-wh"><header><h2 id="rv-wh">Who approves</h2></header><div class="body">
            <p><b>The project manager</b>, for everything done on their project.</p>
            <p><b>Their stand-in</b>, for work the manager did themselves, or while the manager is on leave.</p>
            <p><b>The owner is not asked.</b> They see who approved it on the task, and can step in on any project.</p></div></section></div>
      </div>` : html`<section class="panel">${empty('Nothing is waiting for you', 'When someone on a project you manage sends work for review, it shows here and you get a notification.')}</section>`}`;
  },
};
function detail(t) {
  const open = t.checks.filter((c) => !c.checked).length, pins = t.pins.filter((p) => !p.resolved).length;
  const names = [...(t.mention_pool || []).map((p) => p.name), S.me.name];
  const note = [...t.events].reverse().find((e) => e.kind === 'submitted');
  return html`<section class="panel rv-d" aria-labelledby="rv-dh"><div class="body">
    <div class="rv-tags"><span class="pmc amber">In review</span><span class="muted small">${[t.key, t.project].filter(Boolean).join(' · ')}</span>${t.review_rounds ? html`<span class="pmc">Round ${t.review_rounds + 1}</span>` : ''}</div>
    <h2 id="rv-dh" class="rv-t">${t.title}</h2>
    <div class="rv-from">${t.assignee ? av(t.assignee_id, t.assignee) : ''}<div class="pm-grow"><b>${first(t.assignee) || 'Someone'} sent it for review</b><span class="muted small">${note && note.detail ? withMentions(`“${note.detail}”`, names) : note ? relTime(note.at) : ''}</span></div></div>
    <div class="rv-stats">
      <div><span class="muted small">Checklist</span><b>${t.checks.length ? `${t.checks.length - open} of ${t.checks.length} done` : 'None'}</b></div>
      <div><span class="muted small">Pins</span><b>${t.pins.length ? (pins ? `${pins} still open` : `${t.pins.length} fixed`) : 'None'}</b></div>
      <div><span class="muted small">Time</span><b>${t.tracked_secs ? hrs(Math.round(t.tracked_secs / 60)) : '0m'}${t.estimate_min ? ` of ${hrs(t.estimate_min)}` : ''}</b></div>
    </div>
    <div class="rv-acts"><button type="button" class="btn primary" data-act="rv-ok" data-id="${t.id}" data-open="${open + pins}">${icon('check')} Approve</button><button type="button" class="btn" data-act="rv-back" data-id="${t.id}">Send back with a note</button><a class="btn quiet" href="#/task?id=${t.id}">Open the task</a></div>
  </div></section>`;
}
actions['rv-ok'] = async (el) => {
  const n = Number(el.dataset.open);
  if (n && !(await confirmBox({ title: 'Approve with things still open?', message: `${plural(n, 'checklist item or pin', 'checklist items or pins')} ${n === 1 ? 'is' : 'are'} not done yet.`, confirm: 'Approve anyway' }))) return;
  try { await post(`/api/tasks/${el.dataset.id}/approve`); toast('Approved'); S.navigate('#/review'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['rv-back'] = (el) => {
  openModal({ title: 'Send it back', submit: 'Send back', body: html`<div class="field"><label class="f" for="rv-n">What needs to change?</label><textarea id="rv-n" name="note" maxlength="2000" data-mention placeholder="Unticked checklist items and open pins go with it."></textarea><p class="hint">Sending work back counts as a round of changes.</p></div>`,
    onSubmit: async (fd) => { await post(`/api/tasks/${el.dataset.id}/send-back`, { note: fd.get('note') || null }); toast('Sent back'); S.navigate('#/review'); S.refresh(); } });
};

// ================================================================================================
// Your day: what your project managers sent you, on the Tasks page
// ================================================================================================
export const loadMyDay = () => get('/api/plan/me').catch(() => null);
export function myDay(d, { focus = false } = {}) {
  if (!d || !d.tasks.length) return '';
  const left = d.tasks.filter((t) => !['done', 'in_review'].includes(t.status));
  const by = [...new Set(d.tasks.map((t) => t.planned_by).filter(Boolean))].map(first);
  return html`<section class="panel md${focus ? ' focus' : ''}" aria-labelledby="md-h"><header><h2 id="md-h">Your day <span class="muted">${d.done ? `${d.done} of ${d.tasks.length} done` : plural(d.tasks.length, 'task')}${d.planned_min ? ` · about ${hrs(d.planned_min)}` : ''}</span></h2><span class="muted small">${by.length ? `Planned by ${by.join(' and ')}, in this order` : 'In this order'}</span></header>
    <ol class="md-l">${d.tasks.map((t, i) => html`<li class="md-i${t.status === 'done' ? ' did' : ''}${t === left[0] ? ' next' : ''}" data-k="md${t.id}"><a href="#/task?id=${t.id}"><span class="md-n num">${t.status === 'done' ? icon('check') : i + 1}</span><span class="pm-grow"><span class="muted small">${t.key || ''}${t.project_key && !t.key ? t.project_key : ''}${t === left[0] ? ' · up next' : ''}</span><b>${t.title}</b><span class="muted small">${[t.estimate_min ? `about ${hrs(t.estimate_min)}` : null, t.status === 'in_review' ? 'In review' : t.status === 'in_progress' ? 'In progress' : null].filter(Boolean).join(' · ')}</span></span></a></li>`)}</ol>
  </section>`;
}
