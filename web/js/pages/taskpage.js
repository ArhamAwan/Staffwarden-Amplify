// The task page: one page that changes with the stage (To do, In progress, In review, Done).
// Designed on the "Task page redesign" canvas. The header always says what to do next; the side panel is
// the conversation; "Done when" checks sit next to the decision when the approver is reviewing.
// Approval: the project lead approves (their manager when the lead is doing it, or the person's manager
// with no project); the owner always can. Review feedback is team only and never reaches a client.
import { html, raw, esc, dur, plural, dayShort, todayIn, addDays, initials, avColor, relTime, callName } from '../util.js';
import { get, post, patch, del, download, fileUrl, fileBase64 } from '../api.js';
import { S, actions, toast, errMsg, openModal, confirmBox } from '../ui.js';
import { isMgr, loadPeople } from '../parts.js';
import { assigneeOptions, PRIORITY } from './tasks.js';

const RECUR = { none: 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month' };
const MANY = { check_added: (n) => `added ${n} “Done when” checks`, check_ticked: (n) => `ticked ${n} checks`, check_unticked: (n) => `unticked ${n} checks`, file: (n) => `added ${n} files`, link: (n) => `added ${n} links` };
const STAGES = [['todo', 'To do'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['done', 'Done']];
const EVENT = { member: 'added a project member', created: 'made this task', status: 'moved it', submitted: 'sent it for review', sent_back: 'asked for changes', approved: 'approved it', completed: 'marked it done', reopened: 'reopened it', withdrawn: 'took it back from review', assigned: 'reassigned it', due: 'changed the deadline', edited: 'edited', file: 'added a file', link: 'added a link', check_added: 'added a “Done when” check', check_ticked: 'ticked', check_unticked: 'unticked' };

// ---------- icons ----------
const P = {
  back: '<path d="M15 5l-7 7 7 7"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', play: null, arrow: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  dots: null, plus: '<path d="M12 5v14M5 12h14"/>', clip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  img: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8 8"/>', at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  chev: '<path d="M6 9l6 6 6-6"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5s1.2-5.9 3.6-8.5z"/>',
  steps: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>', shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>', repeat: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"/>', clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  move: '<path d="M3 7h13l-3-3M21 17H8l3 3"/>', eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', up: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>', task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
};
const I = (n, s = 18, sw = 2) => {
  if (n === 'play') return raw(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>`);
  if (n === 'dots') return raw(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`);
  return raw(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`);
};
const av = (id, name, small = true) => html`<span class="tk-av${small ? ' tk-s' : ''}" style="background:${avColor(id)}" aria-hidden="true">${initials(name || '?')}</span>`;
const first = (n) => callName(n);
const isImg = (f) => /^image\/(png|jpeg|webp|gif)$/.test(f.mime || '');

// ---------- per-task view state (kept across live refreshes) ----------
const ui = { id: null, tab: 'all', mode: 'comment', shown: new Set(), view: null };
let cur = null;
const imgCache = new Map();
const fileSrc = (t, f) => `/api/tasks/${t.id}/files/${f.id}?inline=1`;

export default {
  title: 'Task',
  async load(q) {
    const id = Number(q.get('id'));
    const [t, projects] = await Promise.all([get(`/api/tasks/${id}`), get('/api/projects')]);
    if (isMgr()) await loadPeople().catch(() => {});
    return { t, projects };
  },
  render({ t, projects }) {
    if (ui.id !== t.id) Object.assign(ui, { id: t.id, tab: 'all', mode: 'comment', shown: new Set(), view: null });
    cur = { t, projects };
    return page(t, projects);
  },
  after(view) {
    // pictures behind sign-in: fetched once with the login, then kept
    for (const img of view.querySelectorAll('img[data-tkimg]')) {
      const p = img.dataset.tkimg;
      if (imgCache.has(p)) { if (img.getAttribute('src') !== imgCache.get(p)) img.src = imgCache.get(p); continue; }
      imgCache.set(p, null);
      fileUrl(p).then((u) => { imgCache.set(p, u); for (const i of document.querySelectorAll(`img[data-tkimg="${CSS.escape(p)}"]`)) i.src = u; }).catch(() => imgCache.delete(p));
    }
    const ti = view.querySelector('.tk-title[data-tf]');
    if (ti) { ti.style.height = 'auto'; ti.style.height = `${ti.scrollHeight}px`; }
  },
};

// ---------- who can do what ----------
function roles(t) {
  const mine = t.is_mine || (t.assignee_id == null && t.created_by === S.me.id);
  return {
    mine, approver: t.can_approve, manage: t.can_manage, edit: t.can_edit,
    reopen: t.status === 'done' && (t.can_manage || t.can_approve || t.created_by === S.me.id),
  };
}
const approverName = (t) => (t.approver.names.length ? t.approver.names.join(' or ') : 'A manager');

// ---------- the page ----------
function page(t, projects) {
  const r = roles(t);
  const stage = t.status;
  const changes = stage === 'in_progress' && t.review_rounds > 0;
  const main = html`
    ${head(t, r)}
    ${t.live ? liveStrip(t) : ''}
    ${stage === 'done' ? doneView(t) : ''}
    ${changes ? changesView(t, r) : ''}
    ${stage === 'in_review' ? reviewView(t, r) : ''}
    ${stage !== 'done' && stage !== 'in_review' && !changes ? brief(t, r) : ''}
    ${stage !== 'done' && stage !== 'in_review' ? workCards(t, r, changes) : ''}
    ${stage !== 'done' && stage !== 'in_review' ? addRow(t, r, projects) : ''}`;
  return html`<div class="tk" data-k="tk${t.id}">
    <main class="tk-main">${main}</main>
    ${rail(t, r)}
  </div>`;
}

function head(t, r) {
  const acts = [];
  const btn = (act, label, cls = '', extra = '') => html`<button type="button" class="tk-btn ${cls}" data-act="${act}" ${raw(extra)}>${label}</button>`;
  if (t.assignee_id == null && t.project_id && t.status !== 'done') acts.push(btn('tk-pickup', 'Assign to me', 'tk-pri'));
  if (t.status === 'in_review' && r.approver) acts.push(btn('tk-ask', 'Ask for changes', 'tk-warn'), btn('tk-approve', html`${I('check', 16, 2.6)}Approve`, 'tk-ok'));
  else if (r.mine && t.status === 'todo') acts.push(btn('tk-stage', html`${I('play', 16)}Start working`, 'tk-pri', 'data-v="in_progress"'));
  else if (r.mine && t.status === 'in_progress') acts.push(t.needs_review && !r.approver
    ? btn('tk-stage', html`${t.review_rounds ? `Send round ${t.review_rounds + 1} to ${first(t.approver.names[0]) || 'review'}` : `Send to ${first(t.approver.names[0]) || 'a manager'} for review`}${I('arrow', 16, 2.2)}`, 'tk-pri', 'data-v="in_review"')
    : btn('tk-stage', html`${I('check', 16, 2.6)}Mark done`, 'tk-ok', 'data-v="done"'));
  else if (r.mine && t.status === 'in_review') acts.push(btn('tk-stage', 'Take back from review', '', 'data-v="in_progress"'));
  else if (t.status !== 'done' && t.status !== 'in_review' && (r.approver || (r.manage && !t.needs_review))) acts.push(btn('tk-stage', html`${I('check', 16, 2.6)}Mark done`, 'tk-ok', 'data-v="done"'));
  if (t.status === 'done') { if (r.manage || r.mine) acts.push(btn('tk-followup', 'Make a follow-up task')); if (r.reopen) acts.push(btn('tk-stage', 'Reopen', '', 'data-v="todo"')); }
  acts.push(moreMenu(t, r));

  return html`<header style="display:flex;flex-direction:column;gap:14px">
    <div class="tk-crumbs"><a href="#/tasks">${I('back', 16)}Tasks</a>${t.key ? html`<b>${t.key}</b>` : ''}${t.project ? html`<span aria-hidden="true">·</span><a href="#/project?id=${t.project_id}">${t.project}</a>` : ''}</div>
    <div class="tk-head">
      ${r.edit ? html`<textarea class="tk-title" data-tf="title" rows="1" maxlength="200" aria-label="Task title">${t.title}</textarea>` : html`<h1>${t.title}</h1>`}
      <div class="tk-acts">${acts}</div>
    </div>
    ${stages(t, r)}
    ${chips(t, r)}
  </header>`;
}

function stages(t, r) {
  const list = t.needs_review ? STAGES : STAGES.filter(([k]) => k !== 'in_review');
  const idx = list.findIndex(([k]) => k === t.status);
  const can = (k) => {
    if (k === t.status) return true;
    if (k === 'done') return r.approver || (!t.needs_review && (r.mine || r.manage));
    if (k === 'in_review') return t.status === 'in_progress' && r.mine;
    if (t.status === 'in_review') return r.approver || r.mine;
    return r.mine || r.manage || r.approver;
  };
  const why = (k) => (k === 'done' ? `${approverName(t)} approves this one` : k === 'in_review' ? 'Sent from In progress, by the person doing it' : 'Not yours to move');
  const items = list.map(([k, n], i) => {
    const cls = k === t.status ? (k === 'done' ? 'tk-end' : 'tk-now') : i < idx ? 'tk-done' : '';
    const ok = can(k);
    return html`${i ? html`<li class="tk-sep${i <= idx ? ' tk-g' : ''}" aria-hidden="true"></li>` : ''}<li><button type="button" class="tk-st ${cls}" data-act="tk-stage" data-v="${k}" ${raw(k === t.status ? 'aria-current="step"' : '')} ${raw(ok ? '' : `aria-disabled="true" title="${esc(why(k))}"`)}>${i < idx || (k === 'done' && t.status === 'done') ? I('check', 14, 2.6) : ''}${n}</button></li>`;
  });
  return html`<ol class="tk-stages" aria-label="Stage">${items}</ol>`;
}

function chips(t, r) {
  const out = [];
  const people = (S.people || []);
  // doing it
  out.push(r.manage
    ? html`<label class="tk-chip">${t.assignee ? av(t.assignee_id, t.assignee, false) : ''}<span class="tk-l"><small>Doing it</small><b>${t.assignee || 'Nobody yet'}</b></span><select data-tf="assignee_id" aria-label="Who is doing it">${raw(assigneeOptions(t.project_id, cur.projects, t.assignee_id))}</select></label>`
    : html`<span class="tk-chip tk-flat">${t.assignee ? av(t.assignee_id, t.assignee, false) : ''}<span class="tk-l"><small>Doing it</small><b>${t.assignee || 'Nobody yet'}</b></span></span>`);
  void people;
  // who approves
  if (t.needs_review) out.push(html`<span class="tk-chip tk-flat">${t.approver.ids[0] ? av(t.approver.ids[0], t.approver.names[0], false) : ''}<span class="tk-l"><small>Approves${t.approver.why === 'project lead' ? ' · project lead' : ''}</small><b>${approverName(t)}</b></span></span>`);
  else out.push(html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Approval</small><b>Not needed</b></span></span>`);
  // waiting for the approver
  if (t.status === 'in_review' && t.submitted_at && r.approver) out.push(html`<span class="tk-chip tk-amber tk-np tk-flat"><span class="tk-l"><small>Waiting for you</small><b>${relTime(t.submitted_at).replace(/ ago$/, '')}</b></span></span>`);
  // due
  if (t.status !== 'done') {
    const today = todayIn((S.me.tz_offset_min ?? S.settings.tz_offset_min) - (S.me.day_start_min || 0));
    const label = !t.due_day ? 'No deadline' : t.due_day === today ? 'Today' : t.due_day === addDays(today, 1) ? 'Tomorrow' : dayShort(t.due_day);
    out.push(r.edit
      ? html`<label class="tk-chip tk-np${t.overdue || t.due_today ? ' tk-amber' : ''}"><span class="tk-l"><small>${t.overdue ? 'Overdue' : 'Due'}</small><b>${label}</b></span><input type="date" data-tf="due_day" value="${t.due_day || ''}" aria-label="Due date"></label>`
      : html`<span class="tk-chip tk-np tk-flat${t.overdue || t.due_today ? ' tk-amber' : ''}"><span class="tk-l"><small>${t.overdue ? 'Overdue' : 'Due'}</small><b>${label}</b></span></span>`);
  }
  // priority
  out.push(r.edit
    ? html`<label class="tk-chip tk-np${t.priority === 'urgent' ? ' tk-red' : ''}"><span class="tk-l"><small>Priority</small><b>${PRIORITY[t.priority]}</b></span><select data-tf="priority" aria-label="Priority">${Object.entries(PRIORITY).map(([v, n]) => html`<option value="${v}" ${raw(v === t.priority ? 'selected' : '')}>${n}</option>`)}</select></label>`
    : html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Priority</small><b>${PRIORITY[t.priority]}</b></span></span>`);
  // time
  if (t.estimate_min || t.tracked_secs) out.push(html`<button type="button" class="tk-chip tk-np" data-act="tk-estimate" ${raw(r.edit ? '' : 'disabled')}><span class="tk-l"><small>${t.estimate_min ? 'Estimate' : 'Tracked'}</small><b>${t.estimate_min ? `${dur(t.estimate_min * 60)}${t.tracked_secs ? ` · ${dur(t.tracked_secs)} used` : ''}` : dur(t.tracked_secs)}</b></span></button>`);
  if (t.review_rounds && t.status !== 'done') out.push(html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Round</small><b>${t.review_rounds + 1}</b></span></span>`);
  if (t.recurrence !== 'none' || ui.shown.has('repeat')) out.push(r.edit
    ? html`<label class="tk-chip tk-np"><span class="tk-l"><small>Repeats</small><b>${RECUR[t.recurrence]}</b></span><select data-tf="recurrence" aria-label="Repeats">${Object.entries(RECUR).map(([v, n]) => html`<option value="${v}" ${raw(v === t.recurrence ? 'selected' : '')}>${n}</option>`)}</select></label>`
    : html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Repeats</small><b>${RECUR[t.recurrence]}</b></span></span>`);
  if ((t.milestone_id || ui.shown.has('milestone')) && t.milestones.length) out.push(r.edit
    ? html`<label class="tk-chip tk-np"><span class="tk-l"><small>Milestone</small><b>${(t.milestones.find((m) => m.id === t.milestone_id) || {}).title || 'None'}</b></span><select data-tf="milestone_id" aria-label="Milestone"><option value="">None</option>${t.milestones.map((m) => html`<option value="${m.id}" ${raw(m.id === t.milestone_id ? 'selected' : '')}>${m.title}</option>`)}</select></label>`
    : html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Milestone</small><b>${(t.milestones.find((m) => m.id === t.milestone_id) || {}).title || 'None'}</b></span></span>`);
  if (t.client) out.push(html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Client</small><b>${t.client_sees ? `${t.client} sees this task` : 'Team only'}</b></span></span>`);
  return html`<div class="tk-meta">${out}</div>`;
}

function moreMenu(t, r) {
  const items = [];
  const mi = (act, icon, label, sub = '', cls = '') => html`<button type="button" class="tk-mi ${cls}" data-act="${act}">${I(icon, 16)}<span class="tk-x">${label}${sub ? html`<span>${sub}</span>` : ''}</span></button>`;
  if (r.edit) items.push(mi('tk-move', 'move', 'Move to another project'));
  items.push(mi('tk-copy', 'task', 'Make a copy'));
  if (t.client && r.manage) items.push(mi('tk-who', 'eye', 'Who sees it', `${t.client_sees ? `${t.client} sees it now` : 'Only the team sees it now'}`));
  if (t.can_set_review) items.push(html`<div class="tk-mlab">Project lead and owner</div>`, mi('tk-approval', 'shield', 'Approval', t.needs_review ? `${approverName(t)} approves it. Turn it off for this task` : 'Off for this task. Turn it on'));
  if (r.manage || (t.created_by === S.me.id && r.mine)) items.push(mi('tk-delete', 'trash', 'Delete', 'Its comments and files go too', 'tk-bad'));
  return html`<details class="tk-more"><summary class="tk-btn tk-icon" aria-label="More: move, copy, ${t.can_set_review ? 'approval, ' : ''}delete">${I('dots')}</summary><div class="tk-menu" role="menu">${items}</div></details>`;
}

function liveStrip(t) {
  const me = t.live.user_id === S.me.id;
  return html`<section class="tk-live" aria-label="Time on this task">
    <div style="display:flex;align-items:center;gap:12px;flex:1 1 280px">
      <span aria-hidden="true" style="width:12px;height:12px;border-radius:99px;background:${t.live.paused ? '#F7B544' : '#3DD68C'};box-shadow:0 0 0 6px ${t.live.paused ? 'rgba(247,181,68,.18)' : 'rgba(61,214,140,.18)'};flex:none"></span>
      <div style="display:flex;flex-direction:column;gap:2px"><b style="font-size:16px">${me ? 'You’re' : `${first(t.live.name)} is`} ${t.live.paused ? 'on a pause' : 'working on this now'}</b><span style="font-size:13.5px;color:#B9E9D2">Timer on this task · ${me ? 'you and your managers see this' : 'managers and the approver see this'}</span></div>
    </div>
    <div style="display:flex;gap:28px"><div class="tk-stat"><span>This session</span><b>${dur(t.live.session_secs)}</b></div><div class="tk-stat"><span>On this task</span><b>${dur(t.tracked_secs)}</b></div></div>
  </section>`;
}

// ---------- the brief, the checks, the work ----------
function brief(t, r) {
  return html`<section class="tk-card"><h2>What and why</h2>
    ${r.edit ? html`<label class="tk-sr" for="tk-desc">What and why</label><textarea id="tk-desc" class="tk-desc" data-tf="description" maxlength="10000" placeholder="What needs doing, and why. Paste links and screenshots too.">${t.description}</textarea>` : html`<p class="tk-p">${t.description || 'No details yet.'}</p>`}
    <p class="tk-small tk-muted" style="margin:0">Written by ${t.creator || 'someone'}${t.created_at ? ` · ${relTime(t.created_at)}` : ''}</p>
  </section>`;
}

function checksCard(t, r, { tick = false } = {}) {
  if (!t.checks.length && !ui.shown.has('checks')) return '';
  const done = t.checks.filter((c) => c.checked).length;
  return html`<section class="tk-card"><div class="tk-ch"><h2>Done when</h2><span class="tk-small tk-muted">${t.checks.length ? `${done} of ${t.checks.length}${t.needs_review ? ` · ${first(t.approver.names[0]) || 'the approver'} ticks these` : ''}` : 'What has to be true before it’s done'}</span></div>
    <ul class="tk-checks">${t.checks.map((c) => html`<li class="tk-check" data-k="ck${c.id}">${tick
      ? html`<input type="checkbox" data-act="tk-tick" data-id="${c.id}" ${raw(c.checked ? 'checked' : '')} aria-label="${c.title}" style="accent-color:#3DD68C">`
      : html`<span class="tk-box" aria-hidden="true" style="${c.checked ? 'background:#3DD68C;border-color:#3DD68C' : ''}"></span>`}<span style="flex:1">${c.title}${c.checked && c.checked_by ? html` <span class="tk-small tk-muted">· ticked by ${first(c.checked_by)}</span>` : ''}</span>${r.edit && !c.checked && !tick ? html`<button type="button" class="tk-x-btn" data-act="tk-delcheck" data-id="${c.id}" aria-label="Remove ${c.title}">${I('x', 14)}</button>` : ''}</li>`)}</ul>
    ${r.edit ? html`<form class="tk-row" data-tk-form="check"><label class="tk-sr" for="tk-nc">Add a check</label><input id="tk-nc" class="tk-in" name="title" maxlength="200" placeholder="Add a check, like “Works on a phone”" required><button type="submit" class="tk-btn tk-sm" style="height:40px">Add</button></form>` : ''}
  </section>`;
}

function stepsCard(t, r) {
  const list = t.steps_list || [];
  if (!list.length && !ui.shown.has('steps')) return '';
  const done = list.filter((x) => x.done).length;
  const can = r.edit || r.mine;
  return html`<section class="tk-card"><div class="tk-ch"><h2>Steps</h2><span class="tk-small tk-muted">${list.length ? `${done} of ${list.length}` : ''}</span></div>
    ${list.length ? html`<div aria-hidden="true" style="height:6px;border-radius:99px;background:rgba(255,255,255,.08)"><div style="width:${Math.round((100 * done) / list.length)}%;height:100%;border-radius:99px;background:linear-gradient(90deg,#7C5CF0,#9B7BFF)"></div></div>` : ''}
    <ul class="tk-checks">${list.map((x, i) => html`<li class="tk-check" data-k="st${x.id}"><label class="tk-check${x.done ? ' tk-did' : ''}" style="flex:1"><input type="checkbox" data-act="tk-step" data-i="${i}" ${raw(x.done ? 'checked' : '')} ${raw(can ? '' : 'disabled')}>${x.title}</label>${can ? html`<button type="button" class="tk-x-btn" data-act="tk-delstep" data-i="${i}" aria-label="Remove ${x.title}">${I('x', 14)}</button>` : ''}</li>`)}</ul>
    ${can ? html`<form class="tk-row" data-tk-form="step"><label class="tk-sr" for="tk-ns">Add a step</label><input id="tk-ns" class="tk-in" name="title" maxlength="200" placeholder="Add a step" required><button type="submit" class="tk-btn tk-sm" style="height:40px">Add</button></form>` : ''}
  </section>`;
}

function workItem(t, w, r) {
  if (w.kind === 'link') {
    const gh = /github\.com$/.test(w.host) && /\/pull\/\d+/.test(w.url);
    return html`<li class="tk-item" data-k="ln${w.id}"><span class="tk-thumb ${gh ? 'tk-pr' : 'tk-ln'}" aria-hidden="true">${I(gh ? 'pr' : 'globe', 20)}</span><span class="tk-t"><a href="${w.url}" target="_blank" rel="noopener noreferrer" style="color:#F2EFFF;font-weight:600;font-size:14.5px">${w.title || w.host}</a><span>Link · ${w.host}${w.user ? ` · ${first(w.user)}` : ''}</span></span>${w.user_id === S.me.id || r.manage ? html`<button type="button" class="tk-x-btn" data-act="tk-dellink" data-id="${w.id}" aria-label="Remove link">${I('x', 14)}</button>` : ''}</li>`;
  }
  const f = w;
  return html`<li class="tk-item" data-k="fl${f.id}">${isImg(f) ? html`<img class="tk-thumbimg" alt="" data-tkimg="${fileSrc(t, f)}" ${raw(imgCache.get(fileSrc(t, f)) ? `src="${imgCache.get(fileSrc(t, f))}"` : '')}>` : html`<span class="tk-thumb tk-doc" aria-hidden="true"><i style="width:80%"></i><i style="width:60%"></i><i style="width:70%"></i></span>`}
    <span class="tk-t"><button type="button" class="tk-lnk" style="color:#F2EFFF;font-size:14.5px;text-align:left;min-height:0" data-act="tk-file" data-id="${f.id}" data-name="${f.name}">${f.name}</button><span>${isImg(f) ? 'Picture' : 'File'} · ${Math.max(1, Math.round(f.size / 1024))} KB${f.user ? ` · ${first(f.user)}` : ''}</span></span>
    ${f.user_id === S.me.id || r.manage ? html`<button type="button" class="tk-x-btn" data-act="tk-delfile" data-id="${f.id}" aria-label="Remove ${f.name}">${I('x', 14)}</button>` : ''}</li>`;
}
function filesCard(t, r, title) {
  const work = [...t.links.map((l) => ({ ...l, kind: 'link' })), ...t.files];
  if (!work.length && !ui.shown.has('files') && t.status === 'todo') return '';
  return html`<section class="tk-card"><div class="tk-ch"><h2>${title}</h2><span class="tk-small tk-muted">${t.status === 'todo' ? (work.length || '') : t.needs_review ? `${first(t.approver.names[0]) || 'The approver'} sees these when reviewing` : ''}</span></div>
    ${work.length ? html`<ul class="tk-list">${work.map((w) => workItem(t, w, r))}</ul>` : ''}
    ${r.edit ? html`<form class="tk-row" data-tk-form="link"><label class="tk-sr" for="tk-nl">Add a link</label><input id="tk-nl" class="tk-in" name="url" type="url" inputmode="url" placeholder="Paste a link: a pull request, a page, a doc" required><button type="submit" class="tk-btn tk-sm" style="height:40px">Add</button></form>
      <label class="tk-drop" style="cursor:pointer">Drop a file here, paste a screenshot, or <u>pick a file</u> (up to 5 MB)<input type="file" data-tk-file hidden></label>` : ''}
  </section>`;
}

function workCards(t, r, changes) {
  const two = [checksCard(t, r), filesCard(t, r, t.status === 'todo' ? 'Files and links' : 'Work to show')].filter((x) => x);
  const steps = stepsCard(t, r);
  void changes;
  return html`${steps && two.length ? html`<div class="tk-g2">${steps}${two[0]}</div>${two.slice(1)}` : html`${steps}${two.length === 2 ? html`<div class="tk-g2">${two}</div>` : two}`}`;
}

function addRow(t, r, projects) {
  if (!r.edit && !r.mine) return '';
  const b = (key, icon, label) => html`<button type="button" class="tk-add" data-act="tk-show" data-v="${key}">${I(icon, 16)}${label}</button>`;
  const out = [];
  if (!(t.steps_list || []).length && !ui.shown.has('steps')) out.push(b('steps', 'steps', 'Steps'));
  if (!t.checks.length && !ui.shown.has('checks') && r.edit) out.push(b('checks', 'shield', 'Done when'));
  if (t.status === 'todo' && !t.files.length && !t.links.length && !ui.shown.has('files') && r.edit) out.push(b('files', 'clip', 'Files or links'));
  if (r.edit && !t.estimate_min) out.push(b('estimate', 'clock', 'Estimate'));
  if (r.edit && t.recurrence === 'none' && !ui.shown.has('repeat')) out.push(b('repeat', 'repeat', 'Repeat'));
  if (r.edit && t.milestones.length && !t.milestone_id && !ui.shown.has('milestone')) out.push(b('milestone', 'flag', 'Milestone'));
  void projects;
  return out.length ? html`<div class="tk-addrow" aria-label="Add to this task"><span>Add to this task</span>${out}</div>` : '';
}

// ---------- review: the work, big ----------
function reviewView(t, r) {
  const work = [...t.files.map((f) => ({ ...f, kind: 'file', key: `f${f.id}` })), ...t.links.map((l) => ({ ...l, kind: 'link', key: `l${l.id}` }))];
  const sel = work.find((w) => w.key === ui.view) || work.find((w) => w.kind === 'file' && isImg(w)) || work[0];
  const tabs = work.map((w) => html`<button type="button" class="tk-ftab" role="tab" aria-selected="${String(sel && w.key === sel.key)}" data-act="tk-view" data-v="${w.key}">${w.kind === 'link' ? I(/github/.test(w.host) ? 'pr' : 'globe', 16) : I(isImg(w) ? 'img' : 'clip', 16)}${w.kind === 'link' ? w.title || w.host : w.name}</button>`);
  let body;
  if (!sel) body = html`<p class="tk-empty">${first(t.assignee) || 'They'} sent this without files or links. Check the steps and the conversation.</p>`;
  else if (sel.kind === 'link') body = html`<a class="tk-linkcard" href="${sel.url}" target="_blank" rel="noopener noreferrer"><span class="tk-thumb ${/github/.test(sel.host) ? 'tk-pr' : 'tk-ln'}" aria-hidden="true">${I(/github/.test(sel.host) ? 'pr' : 'globe', 22)}</span><span class="tk-t"><b>${sel.title || sel.host}</b><span>Opens ${sel.host} in a new tab</span></span>${I('arrow', 18)}</a>`;
  else if (isImg(sel)) body = html`<img class="tk-shot" alt="${sel.name}" data-tkimg="${fileSrc(t, sel)}" ${raw(imgCache.get(fileSrc(t, sel)) ? `src="${imgCache.get(fileSrc(t, sel))}"` : '')}>`;
  else body = html`<div class="tk-linkcard"><span class="tk-thumb tk-doc" aria-hidden="true"><i style="width:80%"></i><i style="width:60%"></i><i style="width:70%"></i></span><span class="tk-t"><b>${sel.name}</b><span>${Math.max(1, Math.round(sel.size / 1024))} KB</span></span><button type="button" class="tk-btn tk-sm" data-act="tk-file" data-id="${sel.id}" data-name="${sel.name}">${I('dl', 16)}Download</button></div>`;
  return html`<section class="tk-viewer" aria-label="Work to show">
    ${work.length ? html`<div class="tk-ftabs" role="tablist" aria-label="Work to show">${tabs}</div>` : ''}
    ${body}
    ${r.mine ? html`<p class="tk-hint">${approverName(t)} is reviewing this. You can still add a comment.</p>` : ''}
  </section>
  ${stepsCard(t, r)}
  ${!r.approver ? checksCard(t, r) : ''}
  ${t.description ? html`<section class="tk-card"><h2>What and why</h2><p class="tk-p" style="white-space:pre-line">${t.description}</p></section>` : ''}`;
}

// ---------- changes asked: a to-do list made from the feedback ----------
function changesView(t, r) {
  const fb = [...t.comments].reverse().find((c) => c.kind === 'feedback');
  const open = t.checks.filter((c) => !c.checked);
  const by = fb ? fb.user : approverName(t);
  const note = fb ? fb.body.split('\n\nStill to do:')[0].replace(/^Still to do:[\s\S]*$/, '') : '';
  return html`<section class="tk-banner tk-amber">
    ${fb ? av(fb.user_id, fb.user, false) : ''}
    <div style="display:flex;flex-direction:column;gap:4px;flex:1 1 260px;min-width:0"><b style="font-size:17px">${first(by)} asked for ${open.length ? plural(open.length + (note ? 1 : 0), 'change') : 'changes'}</b>${note ? html`<span class="tk-feedtext" style="color:#F1DDB3">“${note}”</span>` : ''}${fb ? html`<span class="tk-small" style="color:#F1DDB3">${relTime(fb.created_at)}</span>` : ''}</div>
  </section>
  ${open.length ? html`<section class="tk-card"><div class="tk-ch"><h2>What to change</h2><span class="tk-small tk-muted">The checks ${first(by)} left unticked</span></div>
    <ul class="tk-list">${open.map((c) => html`<li class="tk-item" data-k="oc${c.id}"><span class="tk-tag">Done when</span><span class="tk-t"><b>${c.title}</b></span></li>`)}</ul></section>` : ''}
  ${brief(t, r)}`;
}

// ---------- done: what happened ----------
function doneView(t) {
  const ap = [...t.events].reverse().find((e) => e.kind === 'approved' || e.kind === 'completed');
  const steps = t.steps_list || [];
  const tiles = [
    ...(t.tracked_secs ? [['Time on it', dur(t.tracked_secs), `${t.estimate_min ? `of a ${dur(t.estimate_min * 60)} estimate, ` : ''}in ${plural(t.sessions, 'session')}`]] : []),
    ...(t.needs_review ? [['Rounds', String(t.review_rounds + 1), t.review_rounds ? `${plural(t.review_rounds, 'time')} sent back` : 'approved first time']] : []),
    ...(steps.length ? [['Steps', `${steps.filter((x) => x.done).length} of ${steps.length}`, 'done']] : []),
    ...(t.checks.length ? [['Done when', `${t.checks.filter((c) => c.checked).length} of ${t.checks.length}`, 'ticked']] : []),
  ];
  const work = [...t.links.map((l) => ({ ...l, kind: 'link' })), ...t.files];
  return html`<section class="tk-banner tk-ok">
    <span style="width:48px;height:48px;border-radius:99px;background:#3DD68C;color:#062016;display:flex;align-items:center;justify-content:center;flex:none">${I('check', 24, 2.8)}</span>
    <div style="display:flex;flex-direction:column;gap:4px;min-width:0"><b style="font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:30px;line-height:1.1">${ap && ap.kind === 'approved' ? `Approved by ${ap.user}` : 'Done'}</b><span style="font-size:14.5px;color:#B9E9D2">${t.completed_at ? relTime(t.completed_at) : ''}${t.due_day && t.completed_at && t.completed_at.slice(0, 10) <= t.due_day ? ' · on time' : t.due_day ? ' · after the deadline' : ''}</span></div>
  </section>
  <div class="tk-g4">${tiles.map(([a, b, c]) => html`<div class="tk-tile"><span>${a}</span><b>${b}</b><span>${c}</span></div>`)}</div>
  ${work.length ? html`<section class="tk-card"><div class="tk-ch"><h2>What was handed in</h2></div><ul class="tk-g3" style="list-style:none;margin:0;padding:0">${work.map((w) => workItem(t, w, { manage: false }))}</ul></section>` : ''}
  ${t.description ? html`<section class="tk-card"><h2>What and why</h2><p class="tk-p" style="white-space:pre-line">${t.description}</p></section>` : ''}`;
}

// ---------- the side panel: deciding, and the conversation ----------
function rail(t, r) {
  const deciding = t.status === 'in_review' && r.approver && t.checks.length;
  const comments = t.comments.map((c) => ({ at: c.created_at, c }));
  const events = t.events.filter((e) => !['edited', 'member'].includes(e.kind)).map((e) => ({ at: e.at, e }));
  let items = [...comments, ...events];
  if (ui.tab === 'feedback') items = items.filter((x) => (x.c && x.c.kind === 'feedback') || (x.e && /^(sent_back|approved|check_)/.test(x.e.kind)));
  else if (ui.tab === 'activity') items = events;
  items.sort((a, b) => a.at.localeCompare(b.at));
  // the same person doing the same thing a few times in a row reads as one line
  items = items.reduce((out, x) => {
    const prev = out[out.length - 1];
    if (x.e && prev && prev.e && prev.e.kind === x.e.kind && prev.e.user === x.e.user && /^(check_added|check_ticked|check_unticked|file|link)$/.test(x.e.kind) && Date.parse(x.at) - Date.parse(prev.last || prev.at) < 30 * 60000) {
      prev.n = (prev.n || 1) + 1; prev.last = x.at; prev.details = [...(prev.details || [prev.e.detail]), x.e.detail]; return out;
    }
    out.push({ ...x }); return out;
  }, []);
  const fbCount = t.comments.filter((c) => c.kind === 'feedback').length;
  const feed = items.map((x) => (x.c ? commentItem(t, x.c, r) : html`<li class="tk-ev" data-k="e${x.e.at}${x.e.kind}"><i style="background:${/approved|completed/.test(x.e.kind) ? '#3DD68C' : /sent_back/.test(x.e.kind) ? '#F7B544' : /submitted/.test(x.e.kind) ? '#9B7BFF' : '#8E87B5'}"></i><span><b>${x.e.user || 'Someone'}</b> ${x.n ? `${MANY[x.e.kind](x.n)}: ${x.details.join(' · ')}` : `${EVENT[x.e.kind] || x.e.kind}${x.e.detail && !/^(sent_back|submitted)$/.test(x.e.kind) ? `: ${x.e.detail}` : ''}`} · ${relTime(x.last || x.e.at)}</span></li>`));
  return html`<aside class="tk-rail" aria-label="${deciding ? 'Decide and conversation' : 'Conversation'}">
    ${deciding ? html`<section class="tk-decide" aria-label="Done when"><div class="tk-ch"><h3>Done when</h3><span class="tk-small tk-muted">${t.checks.filter((c) => c.checked).length} of ${t.checks.length}</span></div>
      <ul class="tk-checks">${t.checks.map((c) => html`<li data-k="dk${c.id}"><label class="tk-check tk-ok"><input type="checkbox" data-act="tk-tick" data-id="${c.id}" ${raw(c.checked ? 'checked' : '')}>${c.title}</label></li>`)}</ul>
      <span class="tk-small tk-muted">Anything left unticked goes back with Ask for changes.</span></section>` : ''}
    <div class="tk-rh">${deciding ? '' : html`<h2>Conversation</h2>`}
      <div class="tk-tabs" role="tablist" aria-label="Show">${[['all', 'Everything'], ['feedback', 'Feedback'], ['activity', 'Activity']].map(([k, n]) => html`<button type="button" class="tk-tab" role="tab" aria-selected="${String(ui.tab === k)}" data-act="tk-tab" data-v="${k}">${n}${k === 'feedback' && fbCount ? html`<span class="tk-n">${fbCount}</span>` : ''}</button>`)}</div>
    </div>
    <ol class="tk-feed">${feed.length ? feed : html`<li class="tk-small tk-muted">${ui.tab === 'feedback' ? 'No feedback yet.' : 'Nothing here yet. Write the first comment below.'}</li>`}</ol>
    ${composer(t, r)}
  </aside>`;
}

function commentItem(t, c, r) {
  const kind = c.kind === 'update' ? 'progress update' : c.kind === 'feedback' ? 'asked for changes' : '';
  const body = html`<li class="tk-cm${c.kind === 'feedback' ? ' tk-fb' : ''}" data-k="c${c.id}">${av(c.user_id || c.client_user_id, c.user)}<div class="tk-w">
    <div class="tk-by"><b>${c.user || 'Someone'}</b>${relTime(c.created_at)}${kind ? html` · <span class="tk-kind">${kind}</span>` : ''}${c.from_client ? html` · <span class="tk-kind">${t.client || 'Client'}</span>` : ''}${c.team_only && c.kind !== 'feedback' ? html` · <span class="tk-kind">team only</span>` : ''}${c.user_id === S.me.id || r.manage ? html` <button type="button" class="tk-lnk" style="font-size:12px;min-height:0;color:#8E87B5" data-act="tk-delc" data-id="${c.id}">Delete</button>` : ''}</div>
    ${c.body ? html`<p class="tk-feedtext">${c.body}</p>` : ''}
    ${c.file ? html`<button type="button" class="tk-lnk" style="min-height:0" data-act="tk-cfile" data-url="${c.file.url}" data-name="${c.file.name}">${I('clip', 14)} ${c.file.name}</button>` : ''}
  </div></li>`;
  return body;
}

function composer(t, r) {
  const modes = [['comment', 'Comment'], ['update', 'Progress update'], ...(t.client && t.client_sees ? [['team', 'Team only']] : [])];
  if (!modes.some(([k]) => k === ui.mode)) ui.mode = 'comment';
  const canAsk = t.status === 'in_review' && r.approver;
  return html`<form class="tk-comp" data-tk-form="comment" aria-label="Write in the conversation">
    <div class="tk-cbox">
      <div class="tk-cmodes" role="tablist" aria-label="Kind of message">${modes.map(([k, n]) => html`<button type="button" class="tk-cmode" role="tab" aria-selected="${String(ui.mode === k)}" data-act="tk-mode" data-v="${k}">${k === 'team' ? I('lock', 13, 2.2) : ''}${n}</button>`)}</div>
      <div class="tk-cin">
        <label for="tk-c" class="tk-sr">Write a comment</label>
        <textarea id="tk-c" name="body" rows="2" maxlength="4000" placeholder="${ui.mode === 'update' ? 'How it’s going: what’s done, what’s next' : ui.mode === 'team' ? `Only the team sees this, never ${t.client}` : 'Write a comment, @ to mention'}"></textarea>
        <div class="tk-tools">
          <details class="tk-more"><summary class="tk-ti" aria-label="Turn into a step, a check or a new task">${I('plus')}</summary><div class="tk-menu tk-cmenu" role="menu"><div class="tk-mlab">Turn what you wrote into</div>
            <button type="button" class="tk-mi" data-act="tk-as" data-v="step">${I('steps', 16)}<span class="tk-x">A step<span>Added to the steps on this task</span></span></button>
            ${r.edit ? html`<button type="button" class="tk-mi" data-act="tk-as" data-v="check">${I('shield', 16)}<span class="tk-x">A “Done when” check<span>The approver ticks it to approve</span></span></button>` : ''}
            <button type="button" class="tk-mi" data-act="tk-as" data-v="task">${I('plus', 16)}<span class="tk-x">A new task<span>In the same project</span></span></button></div></details>
          <label class="tk-ti" aria-label="Attach a file" title="Attach a file">${I('clip')}<input type="file" data-tk-file hidden></label>
          <button type="button" class="tk-ti" aria-label="Mention someone" data-act="tk-at">${I('at')}</button>
          <span class="tk-send"><button type="submit">Send</button>${canAsk ? html`<details class="tk-more" style="display:flex"><summary aria-label="More ways to send" style="height:34px;width:30px;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#7C5CF0,#9B7BFF);color:#fff;border-left:1px solid rgba(255,255,255,.28);cursor:pointer">${I('chev', 14, 2.4)}</summary><div class="tk-menu" role="menu" style="bottom:calc(100% + 6px);top:auto"><button type="button" class="tk-mi" data-act="tk-sendask">${I('up', 16)}<span class="tk-x">Send and ask for changes<span>Sends it back with this note and the unticked checks</span></span></button></div></details>` : ''}</span>
        </div>
      </div>
      <div class="tk-chint">Enter to send · Shift + Enter for a new line · paste a screenshot to add it</div>
    </div>
  </form>`;
}

// ---------- actions ----------
const T = () => cur && cur.t;
const done = async (msg) => { if (msg) toast(msg); S.refresh(); };
const run = (fn) => async (el, e) => { try { await fn(el, e); } catch (err) { toast(errMsg(err), true); } };
const closeMenus = () => document.querySelectorAll('.tk details[open]').forEach((d) => d.removeAttribute('open'));

actions['tk-stage'] = run(async (el) => {
  const t = T(), to = el.dataset.v;
  if (el.getAttribute('aria-disabled') === 'true') { toast(el.title || 'Not yours to move', true); return; }
  if (to === t.status) return;
  if (t.status === 'in_review' && t.can_approve && !t.is_mine && to === 'done') return actions['tk-approve']();
  if (t.status === 'in_review' && t.can_approve && !t.is_mine && (to === 'in_progress' || to === 'todo')) return actions['tk-ask']();
  await patch(`/api/tasks/${t.id}`, { status: to });
  done(to === 'in_review' ? `Sent to ${first(t.approver.names[0]) || 'review'}` : to === 'done' ? 'Done' : to === 'in_progress' && t.status === 'todo' ? 'Started. Start the timer in the desktop app to track time on it.' : to === 'todo' ? 'Reopened' : null);
});
actions['tk-pickup'] = run(async () => { await patch(`/api/tasks/${T().id}`, { assignee_id: S.me.id }); done('It’s yours'); });
actions['tk-approve'] = run(async () => {
  const t = T(), open = t.checks.filter((c) => !c.checked);
  if (open.length && !(await confirmBox({ title: `Approve with ${plural(open.length, 'check')} unticked?`, message: open.map((c) => `• ${c.title}`).join('\n'), confirm: 'Approve anyway' }))) return;
  await post(`/api/tasks/${t.id}/approve`); done(`Approved. ${first(t.assignee) || 'They'}’ll hear about it.`);
});
function askChanges(prefill = '') {
  const t = T(), open = t.checks.filter((c) => !c.checked);
  openModal({
    title: 'Ask for changes', submit: 'Send it back', top: true,
    sub: `${first(t.assignee) || 'They'} gets it back as a to-do list. Feedback stays with the team${t.client ? `, never ${t.client}` : ''}.`,
    body: html`${open.length ? html`<div class="field"><span class="f">Goes back as still to do</span><ul style="margin:6px 0 0;padding-left:18px">${open.map((c) => html`<li>${c.title}</li>`)}</ul></div>` : ''}
      <div class="field"><label class="f" for="tk-sb">${open.length ? 'Anything else? (optional)' : 'What needs to change?'}</label><textarea id="tk-sb" name="note" maxlength="2000" ${raw(open.length ? '' : 'required')}>${prefill}</textarea><p class="hint">Sending work back counts as a round of changes.</p></div>`,
    onSubmit: async (fd) => { await post(`/api/tasks/${t.id}/send-back`, { note: fd.get('note') || null }); done('Sent back with your notes'); },
  });
}
actions['tk-ask'] = () => askChanges();
actions['tk-sendask'] = () => { const ta = document.getElementById('tk-c'); closeMenus(); askChanges(ta ? ta.value : ''); if (ta) { ta.value = ''; delete ta.dataset.dirty; } };
actions['tk-tick'] = run(async (el) => { await patch(`/api/tasks/${T().id}/checks/${el.dataset.id}`, { checked: el.checked }); done(); });
actions['tk-delcheck'] = run(async (el) => { await del(`/api/tasks/${T().id}/checks/${el.dataset.id}`); done(); });
actions['tk-step'] = run(async (el) => {
  const t = T(); const list = (t.steps_list || []).map((x, i) => ({ id: x.id, title: x.title, done: i === Number(el.dataset.i) ? el.checked : x.done }));
  await (await import('../api.js')).put(`/api/tasks/${t.id}/steps`, { steps: list }); done();
});
actions['tk-delstep'] = run(async (el) => {
  const t = T(); const list = (t.steps_list || []).filter((_, i) => i !== Number(el.dataset.i)).map((x) => ({ id: x.id, title: x.title, done: x.done }));
  await (await import('../api.js')).put(`/api/tasks/${t.id}/steps`, { steps: list }); done();
});
actions['tk-file'] = run(async (el) => download(`/api/tasks/${T().id}/files/${el.dataset.id}`, el.dataset.name));
actions['tk-cfile'] = run(async (el) => download(el.dataset.url, el.dataset.name));
actions['tk-delfile'] = run(async (el) => { if (!(await confirmBox({ title: 'Remove this file?', message: 'It is deleted from the task.', confirm: 'Remove', danger: true }))) return; await del(`/api/tasks/${T().id}/files/${el.dataset.id}`); done('File removed'); });
actions['tk-dellink'] = run(async (el) => { await del(`/api/tasks/${T().id}/links/${el.dataset.id}`); done(); });
actions['tk-delc'] = run(async (el) => { if (!(await confirmBox({ title: 'Delete this comment?', message: 'It is removed for everyone.', confirm: 'Delete', danger: true }))) return; await del(`/api/tasks/${T().id}/comments/${el.dataset.id}`); done(); });
actions['tk-tab'] = (el) => { ui.tab = el.dataset.v; S.refresh(); };
actions['tk-mode'] = (el) => { ui.mode = el.dataset.v; S.refresh(); };
actions['tk-view'] = (el) => { ui.view = el.dataset.v; S.refresh(); };
actions['tk-show'] = (el) => {
  const k = el.dataset.v;
  if (k === 'estimate') return actions['tk-estimate']();
  ui.shown.add(k); S.refresh();
  setTimeout(() => { const f = document.getElementById(k === 'steps' ? 'tk-ns' : k === 'checks' ? 'tk-nc' : k === 'files' ? 'tk-nl' : ''); if (f) f.focus(); }, 120);
};
actions['tk-at'] = () => { const ta = document.getElementById('tk-c'); if (!ta) return; ta.focus(); const p = ta.selectionStart; ta.value = `${ta.value.slice(0, p)}@${ta.value.slice(p)}`; ta.selectionStart = ta.selectionEnd = p + 1; ta.dataset.dirty = '1'; };
actions['tk-as'] = run(async (el) => {
  const t = T(), ta = document.getElementById('tk-c'), text = ta ? ta.value.trim() : '';
  closeMenus();
  if (!text) { toast('Write it first, then choose what to turn it into', true); ta && ta.focus(); return; }
  if (el.dataset.v === 'step') await (await import('../api.js')).put(`/api/tasks/${t.id}/steps`, { steps: [...(t.steps_list || []).map((x) => ({ id: x.id, title: x.title, done: x.done })), { title: text.slice(0, 200) }] });
  else if (el.dataset.v === 'check') await post(`/api/tasks/${t.id}/checks`, { title: text.slice(0, 200) });
  else { const n = await post('/api/tasks', { title: text.slice(0, 200), project_id: t.project_id || null }); toast(`${n.key || 'New task'} made`); }
  ta.value = ''; delete ta.dataset.dirty;
  done(el.dataset.v === 'step' ? 'Added as a step' : el.dataset.v === 'check' ? 'Added as a “Done when” check' : null);
});
actions['tk-estimate'] = () => {
  const t = T();
  openModal({ title: 'Estimate', submit: 'Save', body: html`<div class="field"><label class="f" for="tk-est">How long it should take (hours)</label><input id="tk-est" name="h" type="number" min="0" max="1000" step="0.25" value="${t.estimate_min != null ? t.estimate_min / 60 : ''}" placeholder="2.5"></div>`,
    onSubmit: async (fd) => { await patch(`/api/tasks/${t.id}`, { estimate_min: fd.get('h') ? Math.round(Number(fd.get('h')) * 60) : null }); done(); } });
};
actions['tk-move'] = () => {
  const t = T(); closeMenus();
  openModal({ title: 'Move to another project', submit: 'Move', body: html`<div class="field"><label class="f" for="tk-mv">Project</label><select id="tk-mv" name="p"><option value="">No project</option>${cur.projects.filter((p) => !p.archived).map((p) => html`<option value="${p.id}" ${raw(p.id === t.project_id ? 'selected' : '')}>${p.key} · ${p.name}</option>`)}</select><p class="hint">It gets a new number in that project. Who approves follows the project’s lead.</p></div>`,
    onSubmit: async (fd) => { await patch(`/api/tasks/${t.id}`, { project_id: fd.get('p') ? Number(fd.get('p')) : null }); done('Moved'); } });
};
actions['tk-copy'] = run(async () => {
  const t = T(); closeMenus();
  const n = await post('/api/tasks', { title: `${t.title} (copy)`.slice(0, 200), description: t.description || null, project_id: t.project_id || null, priority: t.priority, estimate_min: t.estimate_min });
  for (const c of t.checks) await post(`/api/tasks/${n.id}/checks`, { title: c.title });
  toast('Copy made'); location.hash = `#/task?id=${n.id}`;
});
actions['tk-followup'] = run(async () => {
  const t = T();
  const n = await post('/api/tasks', { title: `Follow-up: ${t.title}`.slice(0, 200), description: `Follows on from ${t.key || 'an earlier task'}.`, project_id: t.project_id || null, priority: t.priority });
  toast(`${n.key || 'Follow-up'} made`); location.hash = `#/task?id=${n.id}`;
});
actions['tk-who'] = () => {
  const t = T(); closeMenus();
  openModal({ title: `Does ${t.client} see this task?`, submit: 'Save', body: html`<div class="field"><label class="f" for="tk-cv">Who sees it</label><select id="tk-cv" name="v"><option value="" ${raw(t.client_visible == null ? 'selected' : '')}>Their setting</option><option value="1" ${raw(t.client_visible === 1 ? 'selected' : '')}>Shared with ${t.client}</option><option value="0" ${raw(t.client_visible === 0 ? 'selected' : '')}>Team only</option></select><p class="hint">Review feedback and team-only comments are never shown to the client.</p></div>`,
    onSubmit: async (fd) => { await patch(`/api/tasks/${t.id}`, { client_visible: fd.get('v') === '' ? null : Number(fd.get('v')) }); done(); } });
};
actions['tk-approval'] = () => {
  const t = T(); closeMenus();
  const v = t.needs_review_set == null ? '' : t.needs_review_set ? '1' : '0';
  openModal({ title: 'Approval for this task', submit: 'Save', body: html`<div class="field"><label class="f" for="tk-ap">Does it need approval before it’s done?</label><select id="tk-ap" name="v"><option value="" ${raw(v === '' ? 'selected' : '')}>The company setting (${S.settings.task_review_required !== false ? 'yes' : 'no'})</option><option value="1" ${raw(v === '1' ? 'selected' : '')}>Yes, ${approverName(t)} approves it</option><option value="0" ${raw(v === '0' ? 'selected' : '')}>No, the person doing it marks it done</option></select><p class="hint">Who approves is the project lead. Change the lead on the project page.</p></div>`,
    onSubmit: async (fd) => { await patch(`/api/tasks/${t.id}`, { needs_review: fd.get('v') === '' ? null : Number(fd.get('v')) }); done(); } });
};
actions['tk-delete'] = run(async () => {
  const t = T(); closeMenus();
  if (!(await confirmBox({ title: 'Delete this task?', message: 'Its comments and files are deleted too. Time already tracked is kept.', confirm: 'Delete task', danger: true }))) return;
  await del(`/api/tasks/${t.id}`); toast('Task deleted'); location.hash = '#/tasks';
});

// ---------- typing, saving, uploading ----------
async function upload(file) {
  const t = T();
  if (!t) return;
  if (file.size > 5 * 1024 * 1024) { toast('Files can be at most 5 MB', true); return; }
  const name = file.name && file.name !== 'image.png' ? file.name : `screenshot-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.png`;
  try { await post(`/api/tasks/${t.id}/files`, { name, mime: file.type || null, data_base64: await fileBase64(file) }); done(`${name} added`); } catch (err) { toast(errMsg(err), true); }
}
document.addEventListener('change', async (e) => {
  if (!e.target.closest || !e.target.closest('.tk')) return;
  const f = e.target.dataset && e.target.dataset.tf;
  const t = T();
  if (f && t) {
    let v = e.target.value;
    if (f === 'assignee_id' || f === 'milestone_id') v = v ? Number(v) : null;
    if (f === 'due_day') v = v || null;
    if (f === 'title' && !v.trim()) { e.target.value = t.title; return; }
    try { await patch(`/api/tasks/${t.id}`, { [f]: v }); delete e.target.dataset.dirty; done(f === 'assignee_id' ? 'Reassigned' : null); } catch (err) { toast(errMsg(err), true); }
    return;
  }
  if (e.target.matches('[data-tk-file]') && e.target.files[0]) { const file = e.target.files[0]; e.target.value = ''; await upload(file); }
});
document.addEventListener('click', (e) => {
  // a due chip opens the date picker; menus close when you click elsewhere
  const due = e.target.closest && e.target.closest('.tk input[type="date"]');
  if (due && due.showPicker) { try { due.showPicker(); } catch { /* not allowed here */ } }
  if (!e.target.closest || !e.target.closest('.tk')) return;
  for (const d of document.querySelectorAll('.tk details.tk-more[open]')) if (!d.contains(e.target) || e.target.closest('.tk-mi')) d.removeAttribute('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'tk-c') { e.preventDefault(); e.target.form.requestSubmit(); }
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('tk-title')) { e.preventDefault(); e.target.blur(); }
});
document.addEventListener('focusout', (e) => {
  // the title and the description save when you leave them
  if (!e.target.closest || !e.target.closest('.tk') || !e.target.dataset.tf || !['title', 'description'].includes(e.target.dataset.tf)) return;
  const t = T(); if (!t) return;
  const v = e.target.value;
  if ((t[e.target.dataset.tf] || '') === v) return;
  e.target.dispatchEvent(new Event('change', { bubbles: true }));
});
document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('tk-title')) { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }
});
document.addEventListener('paste', (e) => {
  if (!document.querySelector('.tk') || !e.clipboardData) return;
  const file = [...e.clipboardData.files].find((f) => /^image\//.test(f.type));
  if (file) { e.preventDefault(); upload(file); }
});
document.addEventListener('dragover', (e) => { if (e.target.closest && e.target.closest('.tk') && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!e.target.closest || !e.target.closest('.tk') || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault(); upload(e.dataTransfer.files[0]);
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest && e.target.closest('.tk [data-tk-form]');
  if (!form) return;
  e.preventDefault();
  const t = T(), kind = form.dataset.tkForm, fd = new FormData(form);
  const clear = () => form.querySelectorAll('input,textarea').forEach((x) => { if (x.type !== 'file') { x.value = ''; delete x.dataset.dirty; } });
  try {
    if (kind === 'comment') {
      const body = String(fd.get('body') || '').trim(); if (!body) return;
      await post(`/api/tasks/${t.id}/comments`, { body, kind: ui.mode === 'update' ? 'update' : 'comment', team_only: ui.mode === 'team' });
      clear(); done(); setTimeout(() => document.getElementById('tk-c')?.focus(), 60); return;
    }
    if (kind === 'check') { await post(`/api/tasks/${t.id}/checks`, { title: fd.get('title') }); clear(); done(); setTimeout(() => document.getElementById('tk-nc')?.focus(), 60); return; }
    if (kind === 'step') { await (await import('../api.js')).put(`/api/tasks/${t.id}/steps`, { steps: [...(t.steps_list || []).map((x) => ({ id: x.id, title: x.title, done: x.done })), { title: fd.get('title') }] }); clear(); done(); setTimeout(() => document.getElementById('tk-ns')?.focus(), 60); return; }
    if (kind === 'link') { await post(`/api/tasks/${t.id}/links`, { url: fd.get('url') }); clear(); done('Link added'); }
  } catch (err) { toast(errMsg(err), true); }
});
