// Tasks: a board (To do / In progress / In review / Done) and a list, with a task panel for details,
// review, comments, files and history. Starting the desktop timer on a task tracks time against it.
import { html, raw, esc, dur, plural, dayShort, todayIn, addDays, icon, initials, avColor, relTime } from '../util.js';
import { get, post, patch, put, del, qs, download } from '../api.js';
import { S, actions, empty, toast, errMsg, openModal, confirmBox, qAttr, trap } from '../ui.js';
import { isMgr, loadPeople, select } from '../parts.js';
import { leave } from '../motion.js';
import { loadMyDay, myDay } from './pm.js';

export const STATUS = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };
// god mode (the owner turns it on for someone): the same board, as a quest board
const GOD_COLS = { todo: 'Not started', in_progress: 'In battle', in_review: 'Awaiting judgment', done: 'Looted' };
const godOn = () => !!(S.me && S.me.fun_mode);
const questXp = (t) => Math.max(20, Math.round(t.estimate_min || 60));
export const PRIORITY = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const RECUR = { none: 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month' };
const COLS = ['todo', 'in_progress', 'in_review', 'done'];
let cache = { tasks: [], projects: [], people: [] };

const myToday = () => todayIn((S.me.tz_offset_min ?? S.settings.tz_offset_min) - (S.me.day_start_min || 0));
export function dueChip(t) {
  if (!t.due_day) return '';
  const today = myToday();
  const label = t.due_day === today ? 'Today' : t.due_day === addDays(today, 1) ? 'Tomorrow' : t.due_day === addDays(today, -1) ? 'Yesterday' : dayShort(t.due_day);
  const cls = t.status === 'done' ? '' : t.overdue ? 'over' : t.due_today ? 'today' : '';
  return html`<span class="due ${cls}" title="Due ${dayShort(t.due_day)}">${icon('cal')}${t.overdue && t.status !== 'done' ? 'Overdue · ' : ''}${label}</span>`;
}
const prio = (p) => (p === 'normal' ? '' : html`<span class="prio p-${p}" title="${PRIORITY[p]} priority"><i></i>${PRIORITY[p]}</span>`);
const who = (t) => (t.assignee ? html`<span class="avatar sm" style="background:${avColor(t.assignee_id)}" title="${t.assignee}">${initials(t.assignee)}</span>` : html`<span class="avatar sm none" title="Unassigned">?</span>`);

export const projTag = (t) => (t.project ? html`<span class="proj"><i style="background:${t.project_color || '#9E98B6'}"></i><span class="proj-n">${t.project}</span></span>` : '');
const keyTag = (t) => (t.key ? html`<span class="tkey">${t.key}</span>` : '');
export function setTasks(list) { cache.tasks = list; }

function card(t, { showProject = true } = {}) {
  return html`<article class="tcard${t.overdue ? ' is-over' : ''}" data-k="t${t.id}" draggable="true" data-task="${t.id}" data-act="open-task" data-id="${t.id}" tabindex="0" aria-label="${t.key ? t.key + ' ' : ''}${t.title}">
    <div class="tc-top">${keyTag(t)}${prio(t.priority)}${t.client ? (t.client_sees ? html`<span class="cvis yes" title="${t.client} can see this task and comment">${icon('eye')}Client sees</span>` : html`<span class="cvis no" title="Only the team sees this task">${icon('lock')}Team only</span>`) : ''}${showProject ? (t.project ? projTag(t) : html`<span class="proj none" title="This task is not in a project. Open it to choose one.">No project</span>`) : ''}${t.recurrence !== 'none' ? html`<span class="faint" title="${RECUR[t.recurrence]}">${icon('repeat')}</span>` : ''}</div>
    <h3>${t.title}</h3>
    ${godOn() && t.status !== 'done' && t.assignee_id === S.me.id ? html`<span class="px tc-xp${t.overdue ? ' boss' : ''}">${t.overdue ? 'BOSS · ' : ''}+${questXp(t)} XP</span>` : ''}
    ${t.steps && t.steps.total ? html`<span class="tc-steps"><span class="meter"><i style="width:${Math.round((t.steps.done / t.steps.total) * 100)}%"></i></span><span class="faint small">${t.steps.done} of ${t.steps.total} steps</span></span>` : ''}
    ${t.status === 'in_progress' && t.review_rounds ? html`<span class="tag late" style="margin-bottom:6px">Changes requested</span>` : ''}
    <div class="tc-foot">${who(t)}${dueChip(t)}<span class="tc-meta">${t.tracked_secs ? html`<span title="Time tracked">${icon('clock')}${dur(t.tracked_secs)}</span>` : ''}${t.comment_count ? html`<span title="Comments">${icon('chat')}${t.comment_count}</span>` : ''}${t.file_count ? html`<span title="Files">${icon('clip')}${t.file_count}</span>` : ''}</span></div>
  </article>`;
}

export default {
  title: 'Tasks',
  async load(q) {
    const mgr = isMgr();
    const assignee = q.get('who') || (mgr ? 'all' : 'me');
    const [tasks, projects, , day, sum] = await Promise.all([
      get(`/api/tasks${qs({ assignee, project: q.get('project'), due: q.get('due'), q: q.get('q'), status: q.get('status') })}`),
      get('/api/projects'),
      mgr ? loadPeople() : Promise.resolve([]),
      loadMyDay(),
      get('/api/tasks/summary').catch(() => ({})),
    ]);
    cache = { tasks, projects, people: mgr ? S.people : [] };
    return { tasks, projects, assignee, day, toReview: sum.to_review || 0 };
  },
  render({ tasks, projects, assignee, day, toReview }, q) {
    const mgr = isMgr();
    const view = q.get('view') === 'list' ? 'list' : 'board';
    const open = tasks.filter((t) => t.status !== 'done');
    const over = open.filter((t) => t.overdue).length, review = tasks.filter((t) => t.status === 'in_review').length;
    const tools = html`
      <div class="seg" role="group" aria-label="View">${[['board', 'Board'], ['list', 'List']].map(([v, t]) => html`<button type="button" data-act="q" ${raw(qAttr('view', v === 'board' ? '' : v))} aria-pressed="${String(view === v)}">${t}</button>`)}</div>
      ${mgr ? select({ q: 'who', value: assignee, label: 'Person', options: [['all', 'Everyone'], ['me', 'My tasks'], ['unassigned', 'Unassigned'], ...cache.people.filter((p) => p.id !== S.me.id).map((p) => [p.id, p.name])] }) : ''}
      ${projects.length ? select({ q: 'project', value: q.get('project') || '', label: 'Project', options: [['', 'All projects'], ['none', 'No project'], ...projects.map((p) => [p.id, `${p.key} · ${p.name}`])] }) : ''}
      ${select({ q: 'due', value: q.get('due') || '', label: 'Due', options: [['', 'Any deadline'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due this week'], ['none', 'No deadline']] })}
      <label class="sr" for="tq">Search tasks</label><input id="tq" class="search" type="search" placeholder="Search" value="${q.get('q') || ''}" data-q="q">
      ${S.me.role === 'employee' ? html`<button class="btn" data-act="guide-projects" aria-label="How tasks work" title="How tasks work">${icon('help')}</button>` : ''}
      <button class="btn primary" data-act="task-new" data-project="${/^\d+$/.test(q.get('project') || '') ? q.get('project') : ''}">${raw('+')} New task</button>`;
    const reviewBanner = toReview ? html`<div class="banner info"><span><b>${plural(toReview, 'task')}</b> waiting for you to approve.</span><a class="btn sm" href="#/review">Review ${toReview === 1 ? 'it' : 'them'}</a></div>` : '';
    const dayPanel = !q.get('q') && !q.get('status') && (!q.get('who') || q.get('who') === 'me' || !mgr) ? myDay(day, { focus: q.get('view') === 'day' }) : '';
    const filtered = q.get('status') ? html`<div class="banner"><span>Showing ${STATUS[q.get('status')] || q.get('status')} only.</span><button class="btn sm" data-act="q" ${raw(qAttr('status', ''))}>Show all</button></div>` : '';
    let body;
    if (!tasks.length) body = html`<section class="panel">${empty(q.get('q') || q.get('due') || q.get('project') ? 'No tasks match' : 'No tasks yet', html`<button class="btn primary mt" data-act="task-new" data-project="${/^\d+$/.test(q.get('project') || '') ? q.get('project') : ''}">${raw('+')} Create the first task</button>`)}</section>`;
    else body = view === 'board' ? boardHtml(tasks) : listHtml(tasks);
    return html`
      <div class="page-h"><div><h1>Tasks</h1><p class="sub">${plural(open.length, 'open task')}${over ? html` · <b class="bad-ink">${over} overdue</b>` : ''}${review ? ` · ${review} in review` : ''}</p></div>
        <div class="tools">${tools}</div></div>
      ${reviewBanner}${dayPanel}${filtered}${body}`;
  },
};

// The board and the list, shared with the project page.
export function boardHtml(tasks, { showProject = true } = {}) {
  return html`<div class="board">${COLS.map((c) => {
    const list = tasks.filter((t) => t.status === c).sort((a, b) => a.position - b.position || a.id - b.id);
    return html`<section class="tcol c-${c}" data-k="col-${c}" data-col="${c}" aria-label="${STATUS[c]}">
      <header><h2>${godOn() ? raw(`<span class="px">${GOD_COLS[c].toUpperCase()}</span>`) : STATUS[c]}</h2><span class="count num">${list.length}</span>${c === 'done' ? html`<span class="faint small">last 14 days</span>` : ''}</header>
      <div class="tlist">${list.length ? list.map((t) => card(t, { showProject })) : html`<p class="drop-hint">${c === 'in_review' ? 'Finished work waits here for review' : 'Drop a task here'}</p>`}</div>
    </section>`;
  })}</div>`;
}
export function listHtml(tasks, { showProject = true } = {}) {
  const rows = [...tasks].sort((a, b) => COLS.indexOf(a.status) - COLS.indexOf(b.status) || (a.due_day || '9999').localeCompare(b.due_day || '9999'));
  return html`<section class="panel flush"><div class="tbl-wrap"><table class="t tasks-t"><thead><tr><th>Task</th><th>Status</th><th>Assignee</th><th>Due</th><th>Priority</th><th class="r">Time</th></tr></thead><tbody>
    ${rows.map((t) => html`<tr class="link" data-k="r${t.id}" data-act="open-task" data-id="${t.id}" tabindex="0">
      <td>${t.key ? html`<span class="tkey">${t.key}</span> ` : ''}<b>${t.title}</b>${showProject && t.project ? html`<br>${projTag(t)}` : ''}</td>
      <td><span class="st s-${t.status}">${STATUS[t.status]}</span></td>
      <td>${t.assignee ? html`<span class="who-cell">${who(t)}${t.assignee}</span>` : html`<span class="faint">Unassigned</span>`}</td>
      <td>${dueChip(t) || html`<span class="faint">–</span>`}</td>
      <td><span class="prio p-${t.priority}"><i></i>${PRIORITY[t.priority]}</span></td>
      <td class="r num">${t.tracked_secs ? dur(t.tracked_secs) : html`<span class="faint">–</span>`}</td></tr>`)}
  </tbody></table></div></section>`;
}

// ---------------- drag and drop on the board ----------------
let dragId = null;
document.addEventListener('dragstart', (e) => {
  const c = e.target.closest && e.target.closest('.tcard[data-task]');
  if (!c) return;
  dragId = Number(c.dataset.task);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId));
  c.classList.add('dragging');
});
document.addEventListener('dragend', (e) => { const c = e.target.closest && e.target.closest('.tcard'); if (c) c.classList.remove('dragging'); document.querySelectorAll('.tcol.over').forEach((x) => x.classList.remove('over')); });
document.addEventListener('dragover', (e) => {
  const col = e.target.closest && e.target.closest('.tcol[data-col]');
  if (!col || dragId == null) return;
  e.preventDefault();
  document.querySelectorAll('.tcol.over').forEach((x) => x !== col && x.classList.remove('over'));
  col.classList.add('over');
});
document.addEventListener('drop', async (e) => {
  const col = e.target.closest && e.target.closest('.tcol[data-col]');
  if (!col || dragId == null) return;
  e.preventDefault();
  col.classList.remove('over');
  const id = dragId; dragId = null;
  const t = cache.tasks.find((x) => x.id === id);
  if (!t) return;
  const to = col.dataset.col;
  // position: just above the card it was dropped on, or at the end
  const over = e.target.closest('.tcard[data-task]');
  const list = cache.tasks.filter((x) => x.status === to && x.id !== id).sort((a, b) => a.position - b.position);
  let position = list.length ? list[list.length - 1].position + 1 : 1;
  if (over) { const i = list.findIndex((x) => x.id === Number(over.dataset.task)); if (i >= 0) position = i === 0 ? list[0].position - 1 : (list[i - 1].position + list[i].position) / 2; }
  try {
    if (to === t.status) { await patch(`/api/tasks/${id}`, { position }); }
    else await moveTo(t, to, position);
    S.refresh();
  } catch (err) { toast(errMsg(err), true); }
});

// Moving between columns follows the review rules: a manager dropping into Done approves, dropping a task
// out of review sends it back (with a reason).
async function moveTo(t, to, position) {
  const reviewer = !!t.can_approve && t.assignee_id !== S.me.id;
  if (t.status === 'in_review' && to === 'done' && reviewer) { await post(`/api/tasks/${t.id}/approve`); toast('Approved'); return; }
  if (t.status === 'in_review' && (to === 'in_progress' || to === 'todo') && reviewer) { await sendBack(t); return; }
  await patch(`/api/tasks/${t.id}`, { status: to, ...(position != null ? { position } : {}) });
  if (to === 'in_review') toast('Sent for review');
}
function sendBack(t) {
  return new Promise((resolve, reject) => openModal({
    title: `Send "${t.title}" back`, submit: 'Send back', top: true,
    body: html`<div class="field"><label class="f" for="sb">What needs to change?</label><textarea id="sb" name="note" required maxlength="2000" placeholder="This is posted as a comment for ${t.assignee || 'them'}"></textarea><p class="hint">Sending work back counts against first-time accuracy.</p></div>`,
    onSubmit: async (fd) => { try { await post(`/api/tasks/${t.id}/send-back`, { note: fd.get('note') }); toast('Sent back with your note'); resolve(); } catch (e) { reject(e); throw e; } },
  }));
}

// ---------------- create ----------------
// Who a task can go to: managers pick anyone they manage; a project lead picks the project's members;
// everyone else takes it themselves (or leaves a project task open for someone to pick up).
export function assigneeOptions(projectId, projects, selected) {
  const p = projects.find((x) => x.id === Number(projectId));
  let list = [];
  if (isMgr()) list = (S.people || []).filter((x) => x.id !== S.me.id);
  else if (p && p.my_role === 'lead') list = p.members.filter((m) => m.id !== S.me.id);
  const opts = [`<option value="${S.me.id}" ${selected === S.me.id ? 'selected' : ''}>Me</option>`,
    ...list.map((x) => `<option value="${x.id}" ${selected === x.id ? 'selected' : ''}>${esc(x.name)}${p && isMgr() && !p.members.some((m) => m.id === x.id) && p.access !== 'everyone' ? ' (will join the project)' : ''}</option>`)];
  if (selected != null && selected !== S.me.id && !list.some((x) => x.id === selected)) opts.push(`<option value="${selected}" selected>Current assignee</option>`);
  if (p || isMgr()) opts.push(`<option value="" ${selected == null ? 'selected' : ''}>Unassigned${p ? ' (anyone in the project can pick it up)' : ''}</option>`);
  return opts.join('');
}
function fieldsHtml(t, { projects, projectId }) {
  const pid = t ? t.project_id : projectId != null ? Number(projectId) : null;
  return html`
    <div class="field"><label class="f" for="tt">Task</label><input id="tt" name="title" required maxlength="200" value="${t ? t.title : ''}" placeholder="What needs doing?"></div>
    <div class="field"><label class="f" for="td">Description</label><textarea id="td" name="description" maxlength="10000" placeholder="Details, links, acceptance criteria">${t ? t.description : ''}</textarea></div>
    <div class="grid3">
      <div class="field"><label class="f" for="tpr">Project</label><select id="tpr" name="project_id"><option value="">No project</option>${projects.filter((p) => !p.archived).map((p) => html`<option value="${p.id}" ${pid === p.id ? raw('selected') : ''}>${p.key} · ${p.name}</option>`)}</select></div>
      <div class="field"><label class="f" for="ta">Assignee</label><select id="ta" name="assignee_id">${raw(assigneeOptions(pid, projects, t ? t.assignee_id : S.me.id))}</select></div>
      <div class="field"><label class="f" for="tdue">Due date</label><input id="tdue" type="date" name="due_day" value="${(t && t.due_day) || ''}"></div></div>
    <div class="grid3">
      <div class="field"><label class="f" for="tp">Priority</label><select id="tp" name="priority">${Object.entries(PRIORITY).map(([v, n]) => html`<option value="${v}" ${(t ? t.priority : 'normal') === v ? raw('selected') : ''}>${n}</option>`)}</select></div>
      <div class="field"><label class="f" for="test">Estimate (hours)</label><input id="test" name="estimate_h" type="number" min="0" max="1000" step="0.25" value="${t && t.estimate_min != null ? t.estimate_min / 60 : ''}" placeholder="Optional"></div>
      <div class="field"><label class="f" for="trc">Repeats</label><select id="trc" name="recurrence">${Object.entries(RECUR).map(([v, n]) => html`<option value="${v}" ${(t ? t.recurrence : 'none') === v ? raw('selected') : ''}>${n}</option>`)}</select><p class="hint">The next one is created when this is done</p></div></div>`;
}
const readFields = (fd) => ({
  title: fd.get('title'), description: fd.get('description') || null, priority: fd.get('priority'), due_day: fd.get('due_day') || null,
  project_id: fd.get('project_id') ? Number(fd.get('project_id')) : null, recurrence: fd.get('recurrence'),
  estimate_min: fd.get('estimate_h') ? Math.round(Number(fd.get('estimate_h')) * 60) : null,
  assignee_id: fd.get('assignee_id') ? Number(fd.get('assignee_id')) : null,
});

actions["task-new"] = async (el) => {
  const [projects] = await Promise.all([get('/api/projects'), isMgr() ? loadPeople() : null]);
  const projectId = el && el.dataset && el.dataset.project ? Number(el.dataset.project) : null;
  const p = projects.find((x) => x.id === projectId);
  const m = openModal({
    title: p ? `New task in ${p.name}` : 'New task', submit: 'Create task', wide: true,
    body: fieldsHtml(null, { projects, projectId }),
    onSubmit: async (fd) => { const t = await post('/api/tasks', readFields(fd)); toast(`${t.key ? t.key + ' created' : 'Task created'}${t.assignee_id && t.assignee_id !== S.me.id ? ` and assigned to ${t.assignee}` : ''}`); S.refresh(); },
  });
  // the people offered follow the project chosen
  m.form.querySelector('#tpr').addEventListener('change', (e) => {
    const sel = m.form.querySelector('#ta'), cur = sel.value ? Number(sel.value) : null;
    sel.innerHTML = assigneeOptions(e.target.value, projects, cur);
  });
};

// ---------------- the task panel ----------------
let panel = null;
actions['open-task'] = (el) => openTask(Number(el.dataset.id));
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-act="open-task"]') && !e.target.closest('.tpanel')) { e.preventDefault(); openTask(Number(e.target.dataset.id)); }
});

// every way of opening a task goes to the task page; links from notifications (#/tasks?task=12) are swapped for it
export async function openTask(id) {
  const to = `#/task?id=${Number(id)}`;
  if (/[?&]task=\d+/.test(location.hash)) location.replace(to); else location.hash = to;
}
// the old side panel, kept for now
export async function openTaskPanel(id) {
  if (panel) panel.close(false);
  const opener = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'scrim tpanel-scrim';
  scrim.innerHTML = '<aside class="tpanel" role="dialog" aria-modal="true" aria-label="Task"><div class="skeleton" style="height:100%"></div></aside>';
  document.getElementById('overlay').appendChild(scrim);
  const box = scrim.querySelector('.tpanel');
  let t = null, projects = [];
  const close = (refocus = true) => {
    document.removeEventListener('keydown', onKey, true); leave(scrim); panel = null;
    // opened from a link (#/tasks?task=12): drop it from the address so a refresh does not reopen it
    if (/[?&]task=/.test(location.hash)) history.replaceState(null, '', location.hash.replace(/([?&])task=\d+&?/, '$1').replace(/[?&]$/, '')); if (refocus && opener && opener.focus && document.contains(opener)) opener.focus(); };
  function onKey(e) {
    if (!scrim.isConnected || document.getElementById('overlay').lastElementChild !== scrim) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); } else trap(box, e);
  }
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  panel = { close, id };

  async function load() {
    try {
      [t, projects] = await Promise.all([get(`/api/tasks/${id}`), get('/api/projects')]);
      if (isMgr()) await loadPeople();
      render();
    } catch (e) { box.innerHTML = `<div class="empty"><b>Couldn't open this task</b>${esc(errMsg(e))}</div>`; }
  }
  const after = async (msg) => { if (msg) toast(msg); S.refresh(); await load(); };
  const canEdit = () => t.can_manage || t.created_by === S.me.id;

  function actionsFor() {
    const mine = t.is_mine || (t.assignee_id == null && t.created_by === S.me.id);
    const btn = (act, label, cls = '') => `<button class="btn ${cls}" data-tp="${act}">${label}</button>`;
    const out = [];
    if (t.assignee_id == null && t.project_id && t.status !== 'done') out.push(btn('pickup', 'Assign to me', 'primary'));
    if (t.status === 'in_review' && t.can_approve && !t.is_mine) out.push(btn('approve', `${icon('check')} Approve`, t.review_mine === false ? '' : 'primary'), btn('sendback', 'Send back'));
    if (mine && t.status === 'todo') out.push(btn('status:in_progress', 'Start working'));
    if (mine && (t.status === 'todo' || t.status === 'in_progress')) {
      const personal = t.created_by === S.me.id;
      if (personal && !t.can_manage) out.push(btn('status:done', `${icon('check')} Mark done`, 'primary'));
      else if (!t.can_manage || t.is_mine) out.push(btn('status:in_review', 'Send for review', 'primary'));
    }
    if (mine && t.status === 'in_review') out.push(btn('status:in_progress', 'Withdraw from review'));
    if (t.can_manage && t.status !== 'done' && t.status !== 'in_review') out.push(btn('status:done', `${icon('check')} Mark done`, out.some((b) => b.includes('primary')) ? '' : 'primary'));
    if (t.status === 'done' && (t.can_manage || t.created_by === S.me.id)) out.push(btn('status:todo', 'Reopen'));
    return out.join('');
  }

  function render() {
    const est = t.estimate_min ? Math.min(100, Math.round((100 * t.tracked_secs) / (t.estimate_min * 60))) : null;
    const editable = canEdit();
    const opt = (sel, v) => (sel === v ? 'selected' : '');
    box.innerHTML = `
      <header class="tp-head">
        <div class="tp-crumbs">${t.key ? `<span class="tkey">${esc(t.key)}</span>` : ''}<span class="st s-${t.status}">${STATUS[t.status]}</span>${t.project ? `<a class="muted small" href="#/project?id=${t.project_id}">${esc(t.project)}</a>` : ''}${t.review_rounds ? `<span class="tag late">Sent back ${t.review_rounds}×</span>` : ''}${t.status === 'done' && t.first_time != null ? `<span class="tag ${t.first_time ? 'present' : 'late'}">${t.first_time ? 'Approved first time' : 'Approved after changes'}</span>` : ''}</div>
        <button class="btn icon" data-tp="close" aria-label="Close">${icon('x')}</button>
      </header>
      <div class="tp-body">
        ${editable ? `<textarea class="tp-title" data-f="title" rows="1" maxlength="200" aria-label="Task title">${esc(t.title)}</textarea>` : `<h2 class="tp-title">${esc(t.title)}</h2>`}
        <div class="tp-actions">${actionsFor()}</div>
        <dl class="tp-grid">
          <dt>Assignee</dt><dd>${t.can_manage ? `<select data-f="assignee_id">${assigneeOptions(t.project_id, projects, t.assignee_id)}</select>` : esc(t.assignee || 'Unassigned')}</dd>
          <dt>Due</dt><dd>${editable ? `<input type="date" data-f="due_day" value="${t.due_day || ''}">` : (t.due_day ? esc(dayShort(t.due_day)) : 'No deadline')} ${t.overdue ? '<span class="tag absent">Overdue</span>' : t.due_today ? '<span class="tag late">Due today</span>' : ''}</dd>
          <dt>Priority</dt><dd>${editable ? `<select data-f="priority">${Object.entries(PRIORITY).map(([v, n]) => `<option value="${v}" ${opt(t.priority, v)}>${n}</option>`).join('')}</select>` : PRIORITY[t.priority]}</dd>
          <dt>Project</dt><dd>${editable ? `<select data-f="project_id"><option value="">No project</option>${projects.map((p) => `<option value="${p.id}" ${opt(t.project_id, p.id)}>${esc(p.key + ' · ' + p.name)}</option>`).join('')}</select>` : t.project ? `<a href="#/project?id=${t.project_id}">${esc(t.project)}</a>` : 'No project'}</dd>
          <dt>Repeats</dt><dd>${editable ? `<select data-f="recurrence">${Object.entries(RECUR).map(([v, n]) => `<option value="${v}" ${opt(t.recurrence, v)}>${n}</option>`).join('')}</select>` : RECUR[t.recurrence]}</dd>
          ${t.client ? `<dt>Client sees it</dt><dd>${t.can_manage ? `<select data-f="client_visible" aria-label="Does ${esc(t.client)} see this task?"><option value="" ${t.client_visible == null ? 'selected' : ''}>Their setting: ${t.client_sees ? 'shared' : 'not shared'}</option><option value="1" ${t.client_visible === 1 ? 'selected' : ''}>Shared with ${esc(t.client)}</option><option value="0" ${t.client_visible === 0 ? 'selected' : ''}>Team only</option></select>` : t.client_sees ? `Yes, ${esc(t.client)} sees it` : 'No, team only'}</dd>` : ''}
          ${t.milestones && t.milestones.length ? `<dt>Milestone</dt><dd>${editable ? `<select data-f="milestone_id"><option value="">None</option>${t.milestones.map((m) => `<option value="${m.id}" ${opt(t.milestone_id, m.id)}>${esc(m.title)}${m.done_at ? ' (done)' : ''}</option>`).join('')}</select>` : esc((t.milestones.find((m) => m.id === t.milestone_id) || {}).title || 'None')}</dd>` : ''}
          <dt>Time tracked</dt><dd><b class="num">${dur(t.tracked_secs)}</b> <span class="muted small">in ${plural(t.sessions, 'session')}${t.estimate_min ? ` of ${dur(t.estimate_min * 60)} estimated` : ''}</span>${est != null ? `<span class="meter ${est > 100 ? 'bad' : ''}" style="display:block;margin-top:6px"><i style="width:${est}%"></i></span>` : ''}</dd>
        </dl>
        <section class="tp-sec"><h3>Description</h3>${editable ? `<textarea class="tp-desc" data-f="description" maxlength="10000" placeholder="Add details">${esc(t.description)}</textarea>` : `<p class="tp-text">${esc(t.description || 'No description.')}</p>`}</section>
        <section class="tp-sec tp-steps"><h3>Steps <span class="faint">${t.steps_list && t.steps_list.length ? `${t.steps_list.filter((x) => x.done).length} of ${t.steps_list.length}` : ''}</span></h3>
          ${t.client && t.client_sees ? `<p class="hint" style="margin:-4px 0 8px">${esc(t.client)} sees how many steps are done, and each step’s name.</p>` : ''}
          <ul class="tp-stl">${(t.steps_list || []).map((x, i) => `<li><label class="check"><input type="checkbox" data-step="${i}" ${x.done ? 'checked' : ''} ${editable || t.is_mine ? '' : 'disabled'}><span class="${x.done ? 'done' : ''}">${esc(x.title)}</span></label>${editable || t.is_mine ? `<button class="linkbtn faint small" data-tp="delstep:${i}" aria-label="Remove ${esc(x.title)}">Remove</button>` : ''}</li>`).join('')}</ul>
          ${editable || t.is_mine ? '<form class="tp-stadd" data-tp-step><input name="title" maxlength="200" placeholder="Add a step" aria-label="Add a step" required><button class="btn sm" type="submit">Add</button></form>' : ''}</section>
        <section class="tp-sec"><h3>Files <span class="faint">${t.files.length || ''}</span></h3>
          ${t.files.length ? `<ul class="tp-files">${t.files.map((f) => `<li>${icon('clip')}<button class="linkbtn" data-tp="file:${f.id}" data-name="${esc(f.name)}">${esc(f.name)}</button><span class="muted small">${Math.max(1, Math.round(f.size / 1024))} KB · ${esc(f.user || '')}</span>${f.user_id === S.me.id || t.can_manage ? `<button class="linkbtn danger-ink" data-tp="delfile:${f.id}" aria-label="Remove ${esc(f.name)}">Remove</button>` : ''}</li>`).join('')}</ul>` : ''}
          <label class="btn sm upload">${icon('clip')} Attach a file<input type="file" data-tp-file hidden></label><span class="hint" style="margin-left:8px">Up to 5 MB</span></section>
        <section class="tp-sec"><h3>Comments <span class="faint">${t.comments.length || ''}</span></h3>
          <ul class="tp-comments">${t.comments.map((c) => `<li><span class="avatar sm" style="background:${avColor(c.user_id)}">${esc(initials(c.user || '?'))}</span><div><p><b>${esc(c.user || 'Someone')}</b>${c.from_client ? ` <span class="ch-tag client">${esc(t.client || 'Client')}</span>` : ''}${c.team_only ? ` <span class="ch-tag note">Team only</span>` : ''} <span class="muted small">${esc(relTime(c.created_at))}</span>${c.user_id === S.me.id || t.can_manage ? ` <button class="linkbtn faint small" data-tp="delc:${c.id}">Delete</button>` : ''}</p>${c.body ? `<p class="tp-text">${esc(c.body)}</p>` : ''}${c.file ? `<button class="linkbtn small" data-tp="cfile:${c.id}" data-url="${esc(c.file.url)}" data-name="${esc(c.file.name)}">${icon('clip')} ${esc(c.file.name)}</button>` : ''}</div></li>`).join('')}</ul>
          <form class="tp-compose" data-tp-form><label class="sr" for="tpc">Write a comment</label><textarea id="tpc" name="body" maxlength="4000" rows="2" placeholder="Write a comment" required></textarea>${t.client && t.client_sees ? `<label class="check small tp-teamonly"><input type="checkbox" name="team_only" value="1"><span>Team only: ${esc(t.client)} won't see it</span></label>` : ''}<button class="btn primary sm" type="submit">Comment</button></form></section>
        <details class="tp-sec tp-hist"><summary>History</summary><ul>${t.events.map((e) => `<li><span class="muted small num">${esc(relTime(e.at))}</span> ${esc(e.user || 'Someone')} ${esc(EVENT[e.kind] || e.kind)}${e.detail ? `: <span class="muted">${esc(e.detail)}</span>` : ''}</li>`).join('')}</ul></details>
        ${t.can_manage || (t.created_by === S.me.id && t.is_mine) ? '<div class="tp-sec"><button class="btn danger sm" data-tp="delete">Delete task</button></div>' : ''}
      </div>`;
    const ti = box.querySelector('.tp-title[data-f]');
    if (ti) { const fit = () => { ti.style.height = 'auto'; ti.style.height = ti.scrollHeight + 'px'; }; fit(); ti.addEventListener('input', fit); }
  }

  // field edits save on change
  box.addEventListener('change', async (e) => {
    const f = e.target.dataset && e.target.dataset.f;
    if (f) {
      let v = e.target.value;
      if (f === 'assignee_id' || f === 'project_id') v = v ? Number(v) : null;
      if (f === 'due_day') v = v || null;
      if (f === 'client_visible' || f === 'milestone_id') v = v === '' ? null : Number(v);
      if (f === 'title' && !v.trim()) { e.target.value = t.title; return; }
      try { await patch(`/api/tasks/${t.id}`, { [f]: v }); await after(f === 'assignee_id' ? 'Reassigned' : null); } catch (err) { toast(errMsg(err), true); }
      return;
    }
    if (e.target.matches('[data-step]')) {
      const list = (t.steps_list || []).map((x, i) => ({ id: x.id, title: x.title, done: i === Number(e.target.dataset.step) ? e.target.checked : x.done }));
      try { await put(`/api/tasks/${t.id}/steps`, { steps: list }); await after(); } catch (err) { toast(errMsg(err), true); }
      return;
    }
    if (e.target.matches('[data-tp-file]') && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) { toast('Files can be at most 5 MB', true); return; }
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
      try { await post(`/api/tasks/${t.id}/files`, { name: file.name, mime: file.type || null, data_base64: b64 }); await after('File attached'); } catch (err) { toast(errMsg(err), true); }
    }
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.tp-title')) { e.preventDefault(); e.target.blur(); } });
  box.addEventListener('submit', async (e) => {
    if (e.target.matches('[data-tp-step]')) {
      e.preventDefault();
      const title = e.target.title.value.trim(); if (!title) return;
      try { await put(`/api/tasks/${t.id}/steps`, { steps: [...(t.steps_list || []).map((x) => ({ id: x.id, title: x.title, done: x.done })), { title }] }); await after(); box.querySelector('[data-tp-step] input')?.focus(); } catch (err) { toast(errMsg(err), true); }
      return;
    }
    if (!e.target.matches('[data-tp-form]')) return;
    e.preventDefault();
    const fd = new FormData(e.target), body = fd.get('body');
    if (!String(body).trim()) return;
    try { await post(`/api/tasks/${t.id}/comments`, { body, team_only: fd.get('team_only') === '1' }); await after(); box.querySelector('#tpc')?.focus(); } catch (err) { toast(errMsg(err), true); }
  });
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tp]');
    if (!b) return;
    const [a, arg] = b.dataset.tp.split(':');
    try {
      if (a === 'close') return close();
      if (a === 'pickup') { await patch(`/api/tasks/${t.id}`, { assignee_id: S.me.id }); return after('It is yours'); }
      if (a === 'approve') { await post(`/api/tasks/${t.id}/approve`); return after('Approved'); }
      if (a === 'sendback') { await sendBack(t); return after(); }
      if (a === 'status') { await moveTo(t, arg); return after(arg === 'done' ? 'Done' : arg === 'in_progress' && t.status === 'todo' ? 'Started' : null); }
      if (a === 'file') return download(`/api/tasks/${t.id}/files/${arg}`, b.dataset.name);
      if (a === 'delfile') { await del(`/api/tasks/${t.id}/files/${arg}`); return after('File removed'); }
      if (a === 'delc') { await del(`/api/tasks/${t.id}/comments/${arg}`); return after(); }
      if (a === 'delstep') { await put(`/api/tasks/${t.id}/steps`, { steps: (t.steps_list || []).filter((_, i) => i !== Number(arg)).map((x) => ({ id: x.id, title: x.title, done: x.done })) }); return after(); }
      if (a === 'cfile') return download(b.dataset.url, b.dataset.name);
      if (a === 'delete') {
        if (!(await confirmBox({ title: 'Delete this task?', message: 'Its comments and files are deleted too. Time already tracked is kept.', confirm: 'Delete task', danger: true }))) return;
        await del(`/api/tasks/${t.id}`); toast('Task deleted'); S.refresh(); return close();
      }
    } catch (err) { toast(errMsg(err), true); }
  });
  await load();
  box.querySelector('[data-tp="close"]')?.focus();
}
const EVENT = { member: 'added a project member', created: 'created it', status: 'changed the status', submitted: 'sent it for review', sent_back: 'sent it back', approved: 'approved it', completed: 'marked it done', reopened: 'reopened it', withdrawn: 'withdrew it from review', assigned: 'reassigned it', due: 'changed the deadline', edited: 'edited', file: 'attached a file' };
