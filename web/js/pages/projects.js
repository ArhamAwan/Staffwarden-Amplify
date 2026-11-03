// Projects, Jira / ClickUp style: a space per project with a key (MA) that numbers its tasks (MA-12),
// a lead, members, a board, a list, an overview and settings.
import { html, raw, esc, dur, hoursText, plural, dayShort, todayIn, daysBetween, initials, avColor, relTime, icon } from '../util.js';
import { get, post, patch, del, put, qs } from '../api.js';
import { S, actions, empty, toast, errMsg, openModal, confirmBox, kpis, meter, toneFor, qAttr, person } from '../ui.js';
import { isMgr, loadPeople, select } from '../parts.js';
import { boardHtml, listHtml, setTasks, dueChip, STATUS } from './tasks.js';
import { loadClientTab, clientTab, mountClientTab } from './clients.js';

export const COLORS = ['#6B55D6', '#B45309', '#7C3AED', '#0F766E', '#BE185D', '#4F46E5', '#15803D', '#C2410C'];
const PSTATUS = { active: 'Active', on_hold: 'On hold', done: 'Done' };
const today = () => todayIn((S.me.tz_offset_min ?? S.settings.tz_offset_min) - (S.me.day_start_min || 0));

const keyBlock = (p, big = false) => html`<span class="pkey${big ? ' big' : ''}" style="background:${p.color}" aria-hidden="true">${p.key}</span>`;
function faces(members, max = 5) {
  const shown = members.slice(0, max), more = members.length - shown.length;
  return html`<span class="faces">${shown.map((m) => html`<span class="avatar sm" style="background:${avColor(m.id)}" title="${m.name}${m.role === 'lead' ? ' (lead)' : ''}">${initials(m.name)}</span>`)}${more > 0 ? html`<span class="avatar sm more">+${more}</span>` : ''}</span>`;
}
function dueText(p) {
  if (!p.due_day) return null;
  const d = daysBetween(today(), p.due_day);
  if (p.status === 'done') return html`<span class="due">${icon('cal')}${dayShort(p.due_day)}</span>`;
  if (d < 0) return html`<span class="due over">${icon('cal')}${plural(-d, 'day')} late</span>`;
  if (d === 0) return html`<span class="due today">${icon('cal')}Due today</span>`;
  return html`<span class="due ${d <= 7 ? 'today' : ''}">${icon('cal')}Due ${dayShort(p.due_day)}</span>`;
}
const statusTag = (p) => (p.archived ? html`<span class="tag off"><i></i>Archived</span>` : p.status === 'on_hold' ? html`<span class="tag late"><i></i>On hold</span>` : p.status === 'done' ? html`<span class="tag present"><i></i>Done</span>` : '');

// ---------------- the list of projects ----------------
export const projectsPage = {
  title: 'Projects',
  async load(q) { return get(`/api/projects${q.get('show') === 'archived' ? '?all=1' : ''}`); },
  render(list, q) {
    const show = q.get('show') || 'open';
    const term = (q.get('q') || '').trim().toLowerCase();
    const shown = list.filter((p) => (show === 'archived' ? p.archived : !p.archived && (show === 'done' ? p.status === 'done' : p.status !== 'done')))
      .filter((p) => !term || `${p.key} ${p.name} ${p.client || ''}`.toLowerCase().includes(term));
    const active = list.filter((p) => !p.archived && p.status === 'active').length, hold = list.filter((p) => !p.archived && p.status === 'on_hold').length;
    const mine = !isMgr();
    return html`
      <div class="page-h"><div><h1>Projects</h1><p class="sub">${mine ? 'Projects you are part of' : `${plural(active, 'active project')}${hold ? `, ${hold} on hold` : ''}`}</p></div>
        <div class="tools">
          <div class="seg" role="group" aria-label="Show">${[['open', 'Open'], ['done', 'Done'], ['archived', 'Archived']].map(([v, n]) => html`<button type="button" data-act="q" ${raw(qAttr('show', v === 'open' ? '' : v))} aria-pressed="${String(show === v)}">${n}</button>`)}</div>
          <label class="sr" for="pq">Search projects</label><input id="pq" class="search" type="search" placeholder="Search" value="${q.get('q') || ''}" data-q="q">
          ${isMgr() ? html`<button class="btn primary" data-act="project-new">${raw('+')} New project</button>` : html`<button class="btn" data-act="guide-projects">${icon('help')} How projects work</button>`}</div></div>
      ${show === 'open' && !term && shown.length ? summary(shown) : ''}
      ${shown.length ? grouped(shown)
        : html`<section class="panel">${empty(term ? 'No projects match' : show === 'open' ? (mine ? 'You are not in any project yet' : 'No projects yet') : `No ${show} projects`,
          mine ? 'A manager or project lead adds you to a project. Its tasks then show up here and in the desktop app.' : show === 'open' ? html`<button class="btn primary mt" data-act="project-new">${raw('+')} Create the first project</button>` : '')}</section>`}`;
  },
};

// a bento over the open projects: this week's hours by project, and the numbers that need someone
function summary(list) {
  const sum = (f) => list.reduce((n, p) => n + f(p), 0);
  const open = sum((p) => p.counts.open), late = sum((p) => p.counts.overdue), lateIn = list.filter((p) => p.counts.overdue).length;
  const review = sum((p) => p.counts.in_review), week = sum((p) => p.week_secs || 0), month = sum((p) => p.month_secs || 0);
  const top = [...list].sort((a, b) => (b.week_secs || 0) - (a.week_secs || 0)).slice(0, 7), max = Math.max(1, ...top.map((p) => p.week_secs || 0));
  const tile = (cls, label, ic, val, foot, href, area) => html`<a class="kpi ${cls} bt-${area}" href="${href}"><div class="l">${icon(ic)}${label}</div><div class="v">${val}</div><div class="f">${foot}</div></a>`;
  return html`<section class="kpis bento pj-bento" aria-label="Projects at a glance">
    <div class="kpi bt-chart"><div class="l">${icon('chart')}Hours this week, by project<span class="bt-r">${dur(week)} in total</span></div>
      ${week ? html`<div class="pj-bars">${top.map((p) => html`<a class="pj-bar" href="#/project?id=${p.id}" title="${p.name}: ${dur(p.week_secs || 0)} this week"><span class="pj-bv num">${p.week_secs ? hoursText(p.week_secs) : '–'}</span><i style="height:calc((100% - 44px) * ${Math.max(0.03, (p.week_secs || 0) / max).toFixed(3)});--pc:${p.color}"></i><span class="pj-bn">${p.key}</span></a>`)}</div>`
        : html`<div class="bt-noshot">${icon('clock')}<span>No time on projects this week yet. Hours show here as soon as someone tracks time on a project.</span></div>`}</div>
    ${tile('', 'Open tasks', 'tasks', String(open), `across ${plural(list.length, 'project')}`, '#/tasks', 'a')}
    ${tile(late ? 'bad' : 'good', 'Past deadline', 'cal', String(late), late ? `in ${plural(lateIn, 'project')}` : 'Nothing late', '#/tasks?due=overdue', 'b')}
    ${tile(review ? 'warn' : '', 'Waiting for approval', 'check', String(review), 'in review', '#/tasks?status=in_review', 'c')}
    ${tile('', 'This month', 'clock', dur(month), 'tracked on projects', '#/reports?group=project', 'd')}
  </section>`;
}

// one grid of cards, client work first; each card says whose it is (a client, or internal)
function grouped(list) {
  const client = list.filter((p) => p.client_id).sort((a, b) => String(a.client).localeCompare(String(b.client))), own = list.filter((p) => !p.client_id);
  return html`<div class="pgrid pj-all">${[...client, ...own].map(cardHtml)}</div>`;
}
function cardHtml(p) {
  const c = p.counts;
  return html`<a class="pcard" href="#/project?id=${p.id}" data-k="p${p.id}" style="--pc:${p.color}">
    <div class="pc-top">${keyBlock(p)}<div class="pc-name"><h2>${p.name}</h2><span>${p.client_id ? html`<b class="pc-cl">${icon('client')}${p.client}</b>` : 'Internal'} · ${p.lead ? `Led by ${p.lead.name}` : 'No lead yet'}</span></div>${statusTag(p)}</div>
    ${p.description ? html`<p class="pc-desc">${p.description}</p>` : ''}
    <div class="pc-prog"><div class="pc-prog-l"><b class="num">${c.progress_pct == null ? '–' : c.progress_pct + '%'}</b><span>${c.total ? `${c.done} of ${plural(c.total, 'task')} done` : 'No tasks yet'}</span></div>${meter(c.progress_pct || 0, 'good')}</div>
    <div class="pc-stats"><span><b class="num">${c.open}</b> open</span>${c.overdue ? html`<span class="bad-ink"><b class="num">${c.overdue}</b> overdue</span>` : ''}${c.in_review ? html`<span><b class="num">${c.in_review}</b> in review</span>` : ''}${p.tracked_secs ? html`<span>${icon('clock')}${dur(p.tracked_secs)}</span>` : ''}</div>
    <div class="pc-foot">${p.members.length ? faces(p.members) : html`<span class="faint small">${p.access === 'everyone' ? 'Open to everyone' : 'No members yet'}</span>`}${dueText(p) || ''}</div>
  </a>`;
}

// ---------------- one project ----------------
let cur = null;
export const projectPage = {
  title: 'Project',
  async load(q) {
    const id = Number(q.get('id'));
    const onClient = q.get('tab') === 'client';
    // the Client tab loads alongside the project (it knows the project from the last visit, if any)
    const known = cur && cur.id === id ? cur : null;
    const early = onClient && known ? loadClientTab(known, q).catch(() => null) : null;
    const [p, tasks] = await Promise.all([get(`/api/projects/${id}`), get(`/api/tasks${qs({ assignee: 'all', project: id, done_days: 30 })}`), isMgr() ? loadPeople() : null]);
    cur = p; setTasks(tasks);
    document.title = `${p.key} ${p.name} · Staffwarden`;
    const client = onClient && (p.client_id || isMgr()) ? ((early && (await early) && known.client_id === p.client_id ? await early : null) || await loadClientTab(p, q)) : null;
    return { p, tasks, client };
  },
  after(view, data) {
    if (data && data.client) mountClientTab(view, data.client);
    // on a narrow screen the tabs scroll sideways: keep the open one in sight
    const bar = view.querySelector('.page-h > .tabs'), t = bar && bar.querySelector('.tab[aria-current="page"]');
    if (t && bar.scrollWidth > bar.clientWidth) { const l = t.offsetLeft - bar.offsetLeft, r = l + t.offsetWidth; if (l < bar.scrollLeft || r > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = Math.max(0, r - bar.clientWidth + 16); }
  },
  render({ p, tasks, client }, q) {
    const tab = ['board', 'list', 'members', 'client'].includes(q.get('tab')) && (q.get('tab') !== 'client' || client) ? q.get('tab') : 'overview';
    const whoF = q.get('who') || '';
    const shown = whoF ? tasks.filter((t) => (whoF === 'none' ? t.assignee_id == null : String(t.assignee_id) === whoF)) : tasks;
    const tabs = [['overview', 'Overview'], ['board', 'Board'], ['list', 'List'], ['members', 'Members', p.members.length], ...(p.client_id || isMgr() ? [['client', p.client_id ? 'Client' : 'Share with a client']] : [])];
    const lead = p.lead ? p.lead.name : 'No lead';
    let body, sub = '';
    if (tab === 'overview') body = overview(p, tasks);
    else if (tab === 'members') body = membersTab(p);
    else if (tab === 'client') body = clientTab(p, client);
    else {
      const filter = select({ q: 'who', value: whoF, label: 'Assignee', options: [['', 'Everyone'], ['none', 'Unassigned'], ...p.members.map((m) => [String(m.id), m.id === S.me.id ? 'Me' : m.name])] });
      sub = html`<div class="subbar">${filter}<span class="muted small">${plural(shown.filter((t) => t.status !== 'done').length, 'open task')}.${tab === 'board' ? ' Drag cards between columns; finished work goes to In review.' : ' Open a task to change it.'}</span></div>`;
      body = html`${shown.length ? (tab === 'board' ? boardHtml(shown, { showProject: false }) : listHtml(shown, { showProject: false })) : html`<section class="panel">${empty('No tasks here yet', html`<button class="btn primary mt" data-act="task-new" data-project="${p.id}">${raw('+')} Add the first task</button>`)}</section>`}`;
    }
    return html`
      <div class="page-h phead" style="--pc:${p.color}"><a class="crumb" href="#/projects">${icon('left')}Projects</a><div class="ph-id">${keyBlock(p, true)}<div><h1>${p.name} ${statusTag(p)}</h1>
          <p class="sub">${p.client ? `${p.client} · ` : ''}Lead: ${lead}${p.due_day ? ` · Due ${dayShort(p.due_day)}` : ''}${p.access === 'everyone' ? ' · Open to everyone' : ''}</p></div></div>
        <div class="tools">${p.can_manage ? html`<button class="btn" data-act="project-settings">${icon('gear')} Settings</button>` : html`<button class="btn" data-act="guide-projects">${icon('help')} How it works</button>`}<button class="btn primary" data-act="task-new" data-project="${p.id}">${raw('+')} New task</button></div>
        <nav class="tabs" aria-label="Project views">${tabs.map(([v, n, count]) => html`<button type="button" class="tab" data-act="q" ${raw(qAttr('tab', v === 'overview' ? '' : v))} aria-current="${tab === v ? 'page' : 'false'}">${n}${count != null ? html`<span class="tab-n" aria-label="${plural(count, 'person', 'people')}">${count}</span>` : ''}${v === 'client' && client && client.pj && client.pj.unread ? html`<span class="badge" aria-label="${client.pj.unread} unread">${client.pj.unread}</span>` : ''}</button>`)}</nav>
        ${sub}</div>
      ${body}`;
  },
};

function overview(p, tasks) {
  const c = p.counts;
  const d = p.due_day ? daysBetween(today(), p.due_day) : null;
  const cells = [
    { label: 'Progress', value: c.progress_pct == null ? '–' : `${c.progress_pct}%`, meter: c.progress_pct || 0, tone: 'good', foot: c.total ? `${c.done} of ${plural(c.total, 'task')} done` : 'No tasks yet' },
    { label: 'Open', value: String(c.open), foot: !c.open ? 'Nothing open' : c.unassigned ? `${c.unassigned} not assigned yet` : 'All assigned' },
    { label: 'Overdue', value: String(c.overdue), tone: c.overdue ? 'bad' : '', foot: c.overdue ? 'Past their deadline' : 'Nothing late' },
    { label: 'In review', value: String(c.in_review), foot: 'Waiting for approval' },
    { label: 'Time tracked', value: dur(p.tracked_secs), foot: 'On this project, all time' },
    { label: 'Deadline', value: p.due_day ? dayShort(p.due_day) : 'None', tone: d != null && d < 0 && p.status !== 'done' ? 'bad' : '', foot: d == null ? 'No end date set' : p.status === 'done' ? 'Project done' : d < 0 ? `${plural(-d, 'day')} late` : d === 0 ? 'Today' : `${plural(d, 'day')} left` },
  ];
  const statusBar = c.total ? html`<div class="sbar" role="img" aria-label="Tasks by status">${['done', 'in_review', 'in_progress', 'todo'].map((s) => (c[s] ? html`<i class="sb-${s}" style="flex:${c[s]}" title="${STATUS[s]}: ${c[s]}"></i>` : ''))}</div>
    <div class="legend">${['todo', 'in_progress', 'in_review', 'done'].map((s) => html`<span><i class="sw sb-${s}"></i>${STATUS[s]} ${c[s]}</span>`)}</div>` : '';
  return html`${kpis(cells)}
    <div class="cols">
      <div>
        <section class="panel"><header><h2>About</h2>${p.can_manage ? html`<button class="btn sm" data-act="project-settings">Edit</button>` : ''}</header><div class="body">
          ${p.description ? html`<p class="pdesc">${p.description}</p>` : html`<p class="muted">${p.can_manage ? 'Add a short description so everyone knows what this project is for.' : 'No description yet.'}</p>`}
          ${statusBar ? html`<div class="mt">${statusBar}</div>` : ''}</div></section>
        <section class="panel flush"><header><h2>Coming up</h2><span class="muted small">Open tasks with a deadline</span></header>
          ${p.upcoming.length ? html`<ul class="plist">${p.upcoming.map((t) => html`<li data-act="open-task" data-id="${t.id}" tabindex="0" class="link"><span class="tkey">${t.key}</span><span class="pl-t"><b>${t.title}</b><span class="muted small">${t.assignee || 'Unassigned'} · ${STATUS[t.status]}</span></span>${dueChip({ ...t, due_today: t.due_day === today() })}</li>`)}</ul>`
            : html`<div class="body pad"><p class="muted">No deadlines coming up.</p></div>`}</section>
      </div>
      <div>
        <section class="panel flush"><header><h2>Workload</h2><span class="muted small">Open tasks per person</span></header>
          ${p.workload.length ? html`<ul class="plist">${[...p.workload].sort((a, b) => b.open - a.open).map((w) => html`<li><span class="avatar sm" style="background:${avColor(w.user_id)}">${initials(w.name)}</span><span class="pl-t"><b>${w.name}${w.role === 'lead' ? html` <span class="tag holiday" style="font-size:11px;padding:0 7px">Lead</span>` : ''}</b><span class="muted small">${w.done} done${w.tracked_secs ? ` · ${dur(w.tracked_secs)}` : ''}</span></span><span class="pl-n"><b class="num">${w.open}</b>${w.overdue ? html`<span class="bad-ink small"> ${w.overdue} late</span>` : ''}</span></li>`)}</ul>`
            : html`<div class="body pad"><p class="muted">No members yet.</p></div>`}</section>
        <section class="panel flush"><header><h2>Recent activity</h2></header>
          ${p.activity.length ? html`<ul class="feed">${p.activity.slice(0, 12).map((e) => html`<li><span class="muted small num">${relTime(e.at)}</span><span>${e.kind === 'member' ? html`<b>${e.user || 'Someone'}</b> added the person on <a href="#" data-act="open-task" data-id="${e.task_id}">${e.key}</a> to the project` : html`<b>${e.user || 'Someone'}</b> ${FEED[e.kind] || e.kind} <a href="#" data-act="open-task" data-id="${e.task_id}">${e.key}</a>${e.kind === 'created' ? html` <span class="muted">${e.title}</span>` : ''}`}</span></li>`)}</ul>`
            : html`<div class="body pad"><p class="muted">Nothing yet.</p></div>`}</section>
      </div>
    </div>`;
}
const FEED = { created: 'created', status: 'moved', submitted: 'sent for review', sent_back: 'sent back', approved: 'approved', completed: 'finished', reopened: 'reopened', withdrawn: 'withdrew', assigned: 'reassigned', due: 'changed the deadline of', edited: 'edited', file: 'attached a file to', member: 'added the assignee as a member with' };

function membersTab(p) {
  return html`<section class="panel flush"><header><h2>Members</h2>${p.can_manage ? html`<button class="btn primary sm" data-act="project-add-members">${raw('+')} Add people</button>` : ''}</header>
    ${p.workload.length ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Person</th><th>Role</th><th class="r">Open</th><th class="r">Overdue</th><th class="r">Done</th><th class="r">Time on project</th>${p.can_manage ? html`<th></th>` : ''}</tr></thead><tbody>
      ${p.workload.map((w) => html`<tr data-k="m${w.user_id}"><td>${person({ id: w.user_id, name: w.name }, w.title || '')}</td>
        <td>${w.role === 'lead' ? html`<span class="tag holiday"><i></i>Lead</span>` : html`<span class="muted">Member</span>`}</td>
        <td class="r num">${w.open}</td><td class="r num">${w.overdue ? html`<b class="bad-ink">${w.overdue}</b>` : '0'}</td><td class="r num">${w.done}</td><td class="r num">${w.tracked_secs ? dur(w.tracked_secs) : html`<span class="faint">–</span>`}</td>
        ${p.can_manage ? html`<td class="r">${w.role === 'lead' ? '' : html`<button class="linkbtn danger-ink" data-act="project-remove-member" data-id="${w.user_id}" data-name="${w.name}">Remove</button>`}</td>` : ''}</tr>`)}
    </tbody></table></div>` : html`<div class="body pad">${empty('No members yet', p.can_manage ? 'Add the people working on this project. Only members see it, unless it is open to everyone.' : '')}</div>`}
    <p class="small muted" style="padding:10px 18px 14px;border-top:1px solid var(--line-2)">${p.access === 'everyone' ? 'This project is open to everyone in the company; members are the people working on it.' : 'Only members (and managers) see this project and its tasks, and only they can track time on it.'} Assigning a task to someone adds them automatically.</p></section>`;
}

// ---------------- create, settings, members ----------------
async function directory() { return get('/api/directory'); }
const suggestKey = (name) => {
  const w = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let k = w.length >= 2 ? w.slice(0, 4).map((x) => x[0]).join('') : (w[0] || '').slice(0, 3);
  if (k && !/^[A-Z]/.test(k)) k = 'P' + k;
  return k.slice(0, 6);
};
function swatches(sel) {
  return html`<div class="swatches" role="radiogroup" aria-label="Colour">${COLORS.map((c, i) => html`<label class="sw-pick" style="--c:${c}"><input type="radio" name="color" value="${c}" ${sel === c || (!sel && i === 0) ? raw('checked') : ''}><span aria-label="Colour ${i + 1}"></span></label>`)}</div>`;
}
function projectFields(p, people) {
  return html`
    <div class="grid2" style="grid-template-columns:minmax(0,1fr) 120px">
      <div class="field"><label class="f" for="pn">Project name</label><input id="pn" name="name" maxlength="100" required value="${p ? p.name : ''}" placeholder="Mobile app"></div>
      <div class="field"><label class="f" for="pk">Key</label><input id="pk" name="key" maxlength="6" value="${p ? p.key : ''}" placeholder="MA" style="text-transform:uppercase"><p class="hint" data-key-hint>Tasks become ${p ? p.key : 'MA'}-1, -2…</p></div></div>
    <div class="field"><label class="f" for="pd">Description</label><textarea id="pd" name="description" maxlength="5000" placeholder="What is this project for?">${p ? p.description : ''}</textarea></div>
    <div class="grid3">
      <div class="field"><label class="f" for="pcl">Client (optional)</label><input id="pcl" name="client" maxlength="100" value="${(p && p.client) || ''}"></div>
      <div class="field"><label class="f" for="psd">Start date</label><input id="psd" name="start_day" type="date" value="${(p && p.start_day) || ''}"></div>
      <div class="field"><label class="f" for="pdd">Deadline</label><input id="pdd" name="due_day" type="date" value="${(p && p.due_day) || ''}"></div></div>
    <div class="grid3">
      <div class="field"><label class="f" for="pl">Lead</label>${isMgr() ? html`<select id="pl" name="lead_id"><option value="">No lead</option>${people.map((u) => html`<option value="${u.id}" ${p && p.lead && p.lead.id === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select><p class="hint">Runs the project: members, assigning and review</p>` : html`<input id="pl" value="${p && p.lead ? p.lead.name : 'No lead'}" disabled>`}</div>
      ${p ? html`<div class="field"><label class="f" for="pst">Status</label><select id="pst" name="status">${Object.entries(PSTATUS).map(([v, n]) => html`<option value="${v}" ${p.status === v ? raw('selected') : ''}>${n}</option>`)}</select></div>` : ''}
      <div class="field"><label class="f" for="pac">Who can see it</label><select id="pac" name="access"><option value="members" ${!p || p.access === 'members' ? raw('selected') : ''}>Members only</option><option value="everyone" ${p && p.access === 'everyone' ? raw('selected') : ''}>Everyone in the company</option></select></div></div>
    <div class="field"><span class="f" style="display:block">Colour</span>${swatches(p && p.color)}</div>`;
}
const readProject = (fd) => ({
  name: fd.get('name'), key: String(fd.get('key') || '').trim().toUpperCase() || null, description: fd.get('description') || null, client: fd.get('client') || null,
  start_day: fd.get('start_day') || null, due_day: fd.get('due_day') || null, access: fd.get('access'), color: fd.get('color'),
  ...(fd.has('status') ? { status: fd.get('status') } : {}), ...(isMgr() ? { lead_id: fd.get('lead_id') ? Number(fd.get('lead_id')) : null } : {}),
});
function memberPicker(people, exclude = new Set()) {
  const list = people.filter((u) => !exclude.has(u.id));
  if (!list.length) return html`<p class="muted">Everyone is already in this project.</p>`;
  return html`<input class="search" type="search" placeholder="Find a person" data-filter-people style="width:100%!important;margin-bottom:8px" aria-label="Find a person">
    <div class="pickl">${list.map((u) => html`<label class="pick" data-name="${u.name.toLowerCase()}"><input type="checkbox" name="member" value="${u.id}"><span class="avatar sm" style="background:${avColor(u.id)}">${initials(u.name)}</span><span><b>${u.name}</b>${u.title ? html`<span class="muted small"> · ${u.title}</span>` : ''}</span></label>`)}</div>`;
}
document.addEventListener('input', (e) => {
  if (!e.target.matches || !e.target.matches('[data-filter-people]')) return;
  const v = e.target.value.trim().toLowerCase();
  e.target.parentElement.querySelectorAll('.pick').forEach((l) => { l.hidden = v && !l.dataset.name.includes(v); });
});

actions['project-new'] = async () => {
  const people = await directory();
  const m = openModal({
    title: 'New project', submit: 'Create project', wide: true,
    body: html`${projectFields(null, people)}<div class="field"><span class="f" style="display:block">Members</span>${memberPicker(people)}</div>`,
    onSubmit: async (fd) => {
      const body = { ...readProject(fd), member_ids: fd.getAll('member').map(Number) };
      const p = await post('/api/projects', body);
      toast(`${p.key} ${p.name} created`);
      S.navigate(`#/project?id=${p.id}`);
    },
  });
  // the key follows the name until it is typed by hand
  const name = m.form.querySelector('#pn'), key = m.form.querySelector('#pk');
  let touched = false;
  const hint = m.form.querySelector('[data-key-hint]');
  const showKey = () => { if (hint) hint.textContent = `Tasks become ${(key.value || 'MA').toUpperCase()}-1, -2…`; };
  key.addEventListener('input', () => { touched = true; showKey(); });
  name.addEventListener('input', () => { if (!touched) key.value = suggestKey(name.value); showKey(); });
};

actions['project-settings'] = async () => {
  const p = cur; if (!p) return;
  const people = isMgr() ? await directory() : [];
  openModal({
    title: `${p.key} settings`, submit: 'Save', wide: true,
    body: html`${projectFields(p, people)}
      <div class="check"><input id="parc" type="checkbox" name="archived" ${p.archived ? raw('checked') : ''}><label for="parc">Archived: hidden from lists and the desktop app; nothing is deleted</label></div>`,
    onSubmit: async (fd) => { await patch(`/api/projects/${p.id}`, { ...readProject(fd), archived: !!fd.get('archived') }); toast('Project saved'); S.refresh(); },
  });
};

actions['project-add-members'] = async () => {
  const p = cur; if (!p) return;
  const people = await directory();
  openModal({
    title: `Add people to ${p.name}`, submit: 'Add',
    body: memberPicker(people, new Set(p.members.map((m) => m.id))),
    onSubmit: async (fd) => {
      const ids = fd.getAll('member').map(Number);
      if (!ids.length) throw new Error('Choose at least one person');
      await put(`/api/projects/${p.id}/members`, { user_ids: ids });
      toast(`${plural(ids.length, 'person', 'people')} added`); S.refresh();
    },
  });
};

actions['project-remove-member'] = async (el) => {
  const p = cur; if (!p) return;
  if (!(await confirmBox({ title: `Remove ${el.dataset.name}?`, message: 'They will no longer see this project unless it is open to everyone. Their tasks stay assigned to them.', confirm: 'Remove', danger: true }))) return;
  try { await del(`/api/projects/${p.id}/members/${el.dataset.id}`); toast(`${el.dataset.name} removed`); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};

export default projectsPage;
