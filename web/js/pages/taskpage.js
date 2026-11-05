// The task page: one page that changes with the stage (To do, In progress, In review, Done).
// Designed on the "Task page redesign" canvas. The header always says what to do next; the side panel is
// the conversation; "Done when" checks sit next to the decision when the approver is reviewing.
// Approval: the project manager approves (their manager when the lead is doing it, or the person's manager
// with no project); the owner always can. Review feedback is team only and never reaches a client.
import { html, raw, esc, dur, plural, dayShort, todayIn, addDays, initials, avColor, relTime, callName } from '../util.js';
import { get, post, patch, put, del, download, fileUrl, fileBytes, fileBase64, getToken } from '../api.js';
import { S, actions, toast, errMsg, openModal, confirmBox } from '../ui.js';
import { morph } from '../morph.js';
import { isMgr, loadPeople } from '../parts.js';
import { assigneeOptions, PRIORITY } from './tasks.js';
import { withMentions, setMentionPool } from './pm.js';
// "@Full Name" lit up for everyone on the task's project (and me)
const M = (text) => withMentions(text, cur && cur.t ? [...(cur.t.mention_pool || []).map((p) => p.name), S.me.name] : [S.me.name]);

const RECUR = { none: 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month' };
const MANY = { check_added: (n) => `added ${n} “Done when” checks`, check_ticked: (n) => `ticked ${n} checks`, check_unticked: (n) => `unticked ${n} checks`, file: (n) => `added ${n} files`, link: (n) => `added ${n} links` };
const STAGES = [['todo', 'To do'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['done', 'Done']];
const EVENT = { member: 'added a project member', created: 'made this task', status: 'moved it', submitted: 'sent it for review', sent_back: 'asked for changes', approved: 'approved it', completed: 'marked it done', reopened: 'reopened it', withdrawn: 'took it back from review', assigned: 'reassigned it', due: 'changed the deadline', edited: 'edited', file: 'added a file', link: 'added a link', check_added: 'added a “Done when” check', check_ticked: 'ticked', check_unticked: 'unticked', version: 'added', pin: 'pinned a comment on', pin_resolved: 'marked fixed', pin_reopened: 'reopened', count: 'set a count', outcome: 'wrote how it went' };

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
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>', layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>', cmp: '<rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/>', minus: '<path d="M5 12h14"/>', pen: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>', reply: '<path d="M10 8L4 13l6 5"/><path d="M4 13h10a6 6 0 0 1 6 6"/>', prev: '<path d="M15 6l-6 6 6 6"/>', next: '<path d="M9 6l6 6-6 6"/>',
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
const isPdf = (f) => f.mime === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const pinnable = (f) => isImg(f) || isPdf(f);
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const hm = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
// every version of one piece of work, oldest first
function chainsOf(t) {
  const m = new Map();
  for (const f of t.files) { const k = f.chain_id || f.id; if (!m.has(k)) m.set(k, []); m.get(k).push(f); }
  return [...m.entries()].map(([id, vs]) => { vs.sort((a, b) => a.version - b.version); const latest = vs[vs.length - 1]; return { id, versions: vs, latest, label: latest.label || latest.name }; });
}
const openPins = (t, chainId = null) => t.pins.filter((p) => !p.resolved && (chainId == null || p.chain_id === chainId));
const fileOf = (t, id) => t.files.find((f) => f.id === id);
const verOf = (t, p) => (fileOf(t, p.file_id) || {}).version || 1;
const chainName = (t, chainId) => { const c = chainsOf(t).find((x) => x.id === chainId); return c ? c.label : 'Work'; };

// ---------- per-task view state (kept across live refreshes) ----------
const ui = { id: null, tab: 'talk', mode: 'comment', shown: new Set(), sel: null, ver: null, page: 1, pin: null, draft: null, compare: null, cmode: 'side', mtab: 'work', replyPin: null, open: false, wantPin: null };
const FRESH = () => ({ tab: 'talk', mode: 'comment', shown: new Set(), sel: null, ver: null, page: 1, pin: null, draft: null, compare: null, cmode: 'side', mtab: 'work', replyPin: null, open: false });
const pdfDocs = new Map(), pdfPages = new Map();
let cur = null, mod = null;
const imgCache = new Map();
const fileSrc = (t, f) => `/api/tasks/${t.id}/files/${f.id}?inline=1`;

const pageMod = {
  title: 'Task',
  async load(q) {
    const id = Number(q.get('id'));
    if (q.get('pin')) ui.wantPin = Number(q.get('pin'));
    const [t, projects] = await Promise.all([get(`/api/tasks/${id}`), get('/api/projects')]);
    if (isMgr()) await loadPeople().catch(() => {});
    return { t, projects };
  },
  render({ t, projects }) {
    if (ui.id !== t.id) Object.assign(ui, { id: t.id, ...FRESH() });
    cur = { t, projects };
    setMentionPool(t.mention_pool);
    // opened from a pin's notification: show that pin
    if (ui.wantPin) {
      const p = t.pins.find((x) => x.id === ui.wantPin);
      if (p) Object.assign(ui, { sel: `c${p.chain_id}`, ver: p.file_id, page: p.page, pin: p.id, open: true, compare: null, mtab: 'work', scrollPin: true });
      ui.wantPin = null;
      history.replaceState(null, '', `#/task?id=${t.id}`);
    }
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
    // PDF pages are drawn once into pictures, so pins sit on them like on any picture
    for (const img of view.querySelectorAll('img[data-tkpdf]')) {
      const key = `pdf:${img.dataset.tkpdf}`;
      if (imgCache.get(key)) { if (img.getAttribute('src') !== imgCache.get(key)) img.src = imgCache.get(key); continue; }
      if (imgCache.has(key)) continue;
      imgCache.set(key, null);
      const [fid, pg] = img.dataset.tkpdf.split(':').map(Number);
      const known = pdfPages.has(fid);
      pdfPage(fid, pg).then((u) => { imgCache.set(key, u); for (const i of document.querySelectorAll(`img[data-tkpdf="${img.dataset.tkpdf}"]`)) i.src = u; if (!known) redraw(); })
        .catch(() => { imgCache.delete(key); for (const i of document.querySelectorAll(`img[data-tkpdf="${img.dataset.tkpdf}"]`)) i.closest('.tk-stage')?.classList.add('tk-bad'); });
    }
    if (ui.scrollPin) { ui.scrollPin = false; setTimeout(() => document.querySelector('.tk-mark.tk-on')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400); }
    const pd = view.querySelector('#tk-pd'); if (pd && ui.draft && !ui.draft.focused) { ui.draft.focused = true; pd.focus(); }
    const ti = view.querySelector('.tk-title[data-tf]');
    const fit = () => { if (ti && ti.isConnected) { ti.style.height = 'auto'; ti.style.height = `${ti.scrollHeight}px`; } };
    fit();
    // again once the title font has loaded, since it changes how many lines the title takes
    if (ti && document.fonts && document.fonts.load) document.fonts.load(`400 ${getComputedStyle(ti).fontSize} 'Instrument Serif'`).then(fit, () => {});
  },
};
mod = pageMod;
export default pageMod;

// ---------- who can do what ----------
function roles(t) {
  const mine = t.is_mine || (t.assignee_id == null && t.created_by === S.me.id);
  return {
    mine, approver: t.can_approve, manage: t.can_manage, edit: t.can_edit, change: t.can_change,
    reopen: t.status === 'done' && (t.can_manage || t.can_approve || t.created_by === S.me.id),
  };
}
const approverName = (t) => (t.approver.names.length ? t.approver.names.join(' or ') : 'A manager');

// ---------- the page ----------
function page(t, projects) {
  const r = roles(t);
  const stage = t.status;
  const changes = stage === 'in_progress' && t.review_rounds > 0;
  if (ui.compare && !chainsOf(t).some((c) => c.id === ui.compare && c.versions.length > 1)) ui.compare = null;
  const showViewer = !ui.compare && stage !== 'in_review' && ui.open && (t.files.length || t.links.length);
  const main = html`
    ${head(t, r)}
    ${phoneTabs(t)}
    ${t.live ? liveStrip(t) : ''}
    ${ui.compare ? compareView(t, r) : ''}
    ${showViewer ? viewer(t, r, { close: true }) : ''}
    ${stage === 'done' ? doneView(t, r) : ''}
    ${changes ? changesView(t, r) : ''}
    ${stage === 'in_review' && !ui.compare ? reviewView(t, r) : ''}
    ${stage === 'in_review' && ui.compare ? reviewExtras(t, r) : ''}
    ${stage !== 'done' && stage !== 'in_review' && !changes ? brief(t, r) : ''}
    ${stage !== 'done' && t.count ? countCard(t, r) : ''}
    ${stage !== 'done' && stage !== 'in_review' ? workCards(t, r, changes) : ''}
    ${stage !== 'done' && stage !== 'in_review' ? addRow(t, r, projects) : ''}`;
  return html`<div class="tkp" data-k="tk${t.id}" data-m="${ui.mtab}">
    <main class="tk-main">${main}</main>
    ${rail(t, r)}
  </div>`;
}

function head(t, r) {
  return html`<header class="tk-header">
    <div class="tk-crumbs"><a href="#/tasks">${I('back', 16)}Tasks</a>${t.key ? html`<b>${t.key}</b>` : ''}${t.project ? html`<span aria-hidden="true">·</span><a href="#/project?id=${t.project_id}">${t.project}</a>` : ''}</div>
    <div class="tk-head">
      ${r.change ? html`<textarea class="tk-title" data-tf="title" rows="1" maxlength="200" aria-label="Task title">${t.title}</textarea>` : html`<h1>${t.title}</h1>`}
      ${moreMenu(t, r)}
    </div>
    ${stages(t)}
    ${chips(t, r)}
  </header>
  ${nextStep(t, r)}`;
}

// The one box that says, in plain words, what happens next and who does it, with the button for it.
function nextStep(t, r) {
  const btn = (act, label, cls = '', extra = '') => html`<button type="button" class="tk-btn ${cls}" data-act="${act}" ${raw(extra)}>${label}</button>`;
  const ap = first(t.approver.names[0]) || 'your manager';
  const doer = first(t.assignee) || 'Someone';
  const fb = [...t.comments].reverse().find((c) => c.kind === 'feedback');
  const todo = openPins(t).length + t.checks.filter((c) => !c.checked).length;
  let tone = 'you', title = '', text = '';
  const acts = [];
  if (t.status === 'done') {
    const ev = [...t.events].reverse().find((e) => e.kind === 'approved' || e.kind === 'completed');
    tone = 'done'; title = ev && ev.kind === 'approved' ? `Done. ${first(ev.user)} approved it.` : 'Done';
    text = `${t.completed_at ? relTime(t.completed_at) : ''}${t.due_day && t.completed_at && t.completed_at.slice(0, 10) <= t.due_day ? ' · on time' : t.due_day && t.completed_at ? ' · after the deadline' : ''}`;
    if (r.manage || r.mine) acts.push(btn('tk-followup', 'Make a follow-up task'));
    if (r.reopen) acts.push(btn('tk-stage', 'Reopen', '', 'data-v="todo"'));
  } else if (t.assignee_id == null) {
    tone = 'wait'; title = 'Nobody is doing this yet';
    text = t.project_id ? 'Anyone in the project can pick it up.' : '';
    if (t.project_id) acts.push(btn('tk-pickup', 'Assign to me', 'tk-pri'));
  } else if (t.status === 'in_review') {
    if (r.approver && !r.mine && t.review_mine === false) {
      // the owner can step in, but isn't the one asked
      tone = 'wait'; title = `${doer} sent it to ${ap} to check`;
      text = `${ap} approves it. You can step in if it can’t wait.`;
      acts.push(btn('tk-ask', 'Ask for changes'), btn('tk-approve', html`${I('check', 16, 2.6)}Approve it yourself`));
    } else if (r.approver && !r.mine) {
      title = 'Your turn: check the work';
      text = `${doer} sent it${t.submitted_at ? ` ${relTime(t.submitted_at)}` : ''}. Look at the files below. Click a picture to leave a comment on it.`;
      acts.push(btn('tk-ask', 'Ask for changes', 'tk-warn'), btn('tk-approve', html`${I('check', 16, 2.6)}Approve`, 'tk-ok'));
    } else {
      tone = 'wait'; title = r.mine ? `Waiting for ${ap} to check it` : `${doer} sent it to ${ap} to check`;
      text = r.mine ? 'You’ll get a notification when they approve it or ask for changes.' : '';
      if (r.mine) acts.push(btn('tk-stage', 'Take it back', '', 'data-v="in_progress"'));
    }
  } else if (r.mine) {
    if (t.status === 'todo') { title = 'Your turn: start when you’re ready'; text = t.description ? 'Read what to do below.' : ''; acts.push(btn('tk-stage', html`${I('play', 16)}Start working`, 'tk-pri', 'data-v="in_progress"')); }
    else {
      if (t.review_rounds && fb) {
        tone = 'fix'; title = `${first(fb.user)} asked for changes`;
        const note = fb.body.split('\n\nStill to do:')[0].replace(/^Still to do:[\s\S]*$/, '');
        text = `${note ? `“${note}” ` : ''}${todo ? `Fix the ${plural(todo, 'thing')} below, then send it back.` : 'Make the changes, then send it back.'}`;
      } else { title = 'Your turn: do the work'; text = t.needs_review && !r.approver ? `When it’s ready, add your files below and send it to ${ap} to check.` : 'Mark it done when you finish.'; }
      acts.push(t.needs_review && !r.approver
        ? btn('tk-stage', html`${t.review_rounds ? `Send it back to ${ap}` : `Send to ${ap} to check`}${I('arrow', 16, 2.2)}`, 'tk-pri', 'data-v="in_review"')
        : btn('tk-stage', html`${I('check', 16, 2.6)}Mark done`, 'tk-ok', 'data-v="done"'));
    }
  } else {
    tone = 'wait'; title = t.status === 'todo' ? `${doer} hasn’t started yet` : `${doer} is working on it`;
    if (r.approver || (r.manage && !t.needs_review)) acts.push(btn('tk-stage', html`${I('check', 16, 2.6)}Mark done`, '', 'data-v="done"'));
  }
  return html`<section class="tk-next tk-n-${tone}" data-k="next-${tone}-${t.status}-${t.review_rounds}" aria-label="What happens next">
    <div class="tk-nt"><b>${title}</b>${text ? html`<span>${text}</span>` : ''}</div>
    ${acts.length ? html`<div class="tk-acts">${acts}</div>` : ''}
  </section>`;
}

// where the task is: read only, so nobody wonders which pill to press
function stages(t) {
  const list = t.needs_review ? STAGES : STAGES.filter(([k]) => k !== 'in_review');
  const idx = list.findIndex(([k]) => k === t.status);
  return html`<p class="tk-pathm">Step ${idx + 1} of ${list.length}: <b>${list[idx][1]}</b></p><ol class="tk-path" aria-label="Stage">${list.map(([k, n], i) => html`<li class="${i < idx || (t.status === 'done' && i === idx) ? 'tk-past' : i === idx ? 'tk-cur' : ''}" ${raw(i === idx ? 'aria-current="step"' : '')}>${i < idx || (t.status === 'done' && i === idx) ? I('check', 13, 2.8) : html`<i aria-hidden="true"></i>`}${n}</li>`)}</ol>`;
}

function chips(t, r) {
  const out = [];
  const people = (S.people || []);
  // doing it
  out.push(r.manage
    ? html`<label class="tk-chip">${t.assignee ? av(t.assignee_id, t.assignee, false) : ''}<span class="tk-l"><small>Doing it</small><b title="${t.assignee || ''}">${t.assignee || 'Nobody yet'}</b></span><select data-tf="assignee_id" aria-label="Who is doing it">${raw(assigneeOptions(t.project_id, cur.projects, t.assignee_id))}</select></label>`
    : html`<span class="tk-chip tk-flat">${t.assignee ? av(t.assignee_id, t.assignee, false) : ''}<span class="tk-l"><small>Doing it</small><b title="${t.assignee || ''}">${t.assignee || 'Nobody yet'}</b></span></span>`);
  void people;
  // who approves
  if (t.needs_review) out.push(html`<span class="tk-chip tk-flat">${t.approver.ids[0] ? av(t.approver.ids[0], t.approver.names[0], false) : ''}<span class="tk-l"><small>Approves${t.approver.why === 'project lead' ? ' · project lead' : ''}</small><b title="${approverName(t)}">${t.approver.names.length > 1 ? t.approver.names.map((n) => n.split(' ')[0]).join(' or ') : approverName(t)}</b></span></span>`);
  else out.push(html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Approval</small><b>Not needed</b></span></span>`);
  // waiting for the approver
  // due
  if (t.status !== 'done') {
    const today = todayIn((S.me.tz_offset_min ?? S.settings.tz_offset_min) - (S.me.day_start_min || 0));
    const label = !t.due_day ? 'No deadline' : t.due_day === today ? 'Today' : t.due_day === addDays(today, 1) ? 'Tomorrow' : dayShort(t.due_day);
    out.push(r.change
      ? html`<label class="tk-chip tk-np${t.overdue || t.due_today ? ' tk-amber' : ''}"><span class="tk-l"><small>${t.overdue ? 'Overdue' : 'Due'}</small><b>${label}</b></span><input type="date" data-tf="due_day" value="${t.due_day || ''}" aria-label="Due date"></label>`
      : html`<span class="tk-chip tk-np tk-flat${t.overdue || t.due_today ? ' tk-amber' : ''}"><span class="tk-l"><small>${t.overdue ? 'Overdue' : 'Due'}</small><b>${label}</b></span></span>`);
  }
  const keep = out.length;
  // priority
  out.push(r.change
    ? html`<label class="tk-chip tk-np${t.priority === 'urgent' ? ' tk-red' : ''}"><span class="tk-l"><small>Priority</small><b>${PRIORITY[t.priority]}</b></span><select data-tf="priority" aria-label="Priority">${Object.entries(PRIORITY).map(([v, n]) => html`<option value="${v}" ${raw(v === t.priority ? 'selected' : '')}>${n}</option>`)}</select></label>`
    : html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Priority</small><b>${PRIORITY[t.priority]}</b></span></span>`);
  // time
  if (t.estimate_min || t.tracked_secs) out.push(html`<button type="button" class="tk-chip tk-np" data-act="tk-estimate" ${raw(r.change ? '' : 'disabled')}><span class="tk-l"><small>${t.estimate_min ? 'Estimate' : 'Tracked'}</small><b>${t.estimate_min ? `${dur(t.estimate_min * 60)}${t.tracked_secs ? ` · ${dur(t.tracked_secs)} used` : ''}` : dur(t.tracked_secs)}</b></span></button>`);
  if (t.recurrence !== 'none' || ui.shown.has('repeat')) out.push(r.change
    ? html`<label class="tk-chip tk-np"><span class="tk-l"><small>Repeats</small><b>${RECUR[t.recurrence]}</b></span><select data-tf="recurrence" aria-label="Repeats">${Object.entries(RECUR).map(([v, n]) => html`<option value="${v}" ${raw(v === t.recurrence ? 'selected' : '')}>${n}</option>`)}</select></label>`
    : html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Repeats</small><b>${RECUR[t.recurrence]}</b></span></span>`);
  if ((t.milestone_id || ui.shown.has('milestone')) && t.milestones.length) out.push(r.change
    ? html`<label class="tk-chip tk-np"><span class="tk-l"><small>Milestone</small><b>${(t.milestones.find((m) => m.id === t.milestone_id) || {}).title || 'None'}</b></span><select data-tf="milestone_id" aria-label="Milestone"><option value="">None</option>${t.milestones.map((m) => html`<option value="${m.id}" ${raw(m.id === t.milestone_id ? 'selected' : '')}>${m.title}</option>`)}</select></label>`
    : html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>Milestone</small><b>${(t.milestones.find((m) => m.id === t.milestone_id) || {}).title || 'None'}</b></span></span>`);
  if (t.client) out.push(html`<span class="tk-chip tk-np tk-flat"><span class="tk-l"><small>${t.client}</small><b>${t.client_sees ? 'Can see this task' : 'Doesn’t see it'}</b></span></span>`);
  // the rest waits behind one button, so the top of the page stays short
  const extra = out.slice(keep);
  const open = ui.more || matchMedia('(max-width: 760px)').matches;
  return html`<div class="tk-metaw"><div class="tk-meta tk-md">${out.slice(0, keep)}${open ? extra : ''}</div>${extra.length && !matchMedia('(max-width: 760px)').matches ? html`<button type="button" class="tk-morebtn" data-act="tk-moredet" aria-expanded="${String(!!ui.more)}">${ui.more ? 'Fewer details' : `${extra.length} more details`}${I('chev', 14, 2.4)}</button>` : ''}</div>`;
}

function moreMenu(t, r) {
  const items = [];
  const mi = (act, icon, label, sub = '', cls = '') => html`<button type="button" class="tk-mi ${cls}" data-act="${act}">${I(icon, 16)}<span class="tk-x">${label}${sub ? html`<span>${sub}</span>` : ''}</span></button>`;
  if (r.change) items.push(mi('tk-move', 'move', 'Move to another project'));
  items.push(mi('tk-copy', 'task', 'Make a copy'));
  if (t.client && r.manage) items.push(mi('tk-who', 'eye', 'Who sees it', `${t.client_sees ? `${t.client} sees it now` : 'Only the team sees it now'}`));
  if (t.can_set_review) items.push(html`<div class="tk-mlab">Project manager and owner</div>`, mi('tk-approval', 'shield', 'Approval', t.needs_review ? `${approverName(t)} approves it. Turn it off for this task` : 'Off for this task. Turn it on'));
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
  if (!r.change && !t.description) return '';
  return html`<section class="tk-card tk-md"><h2>What to do</h2>
    ${r.change ? html`<label class="tk-sr" for="tk-desc">What and why</label><textarea id="tk-desc" class="tk-desc" data-tf="description" data-mention maxlength="10000" placeholder="What needs doing, and why. Type @ to mention someone.">${t.description}</textarea>` : html`<p class="tk-p">${t.description ? M(t.description) : 'No details yet.'}</p>`}
    <p class="tk-small tk-muted" style="margin:0">Written by ${t.creator || 'someone'}${t.created_at ? ` · ${relTime(t.created_at)}` : ''}</p>
  </section>`;
}

function checksCard(t, r, { tick = false } = {}) {
  if (!t.checks.length && !ui.shown.has('checks')) return '';
  const done = t.checks.filter((c) => c.checked).length;
  return html`<section class="tk-card"><div class="tk-ch"><h2>Checklist</h2><span class="tk-small tk-muted">${t.checks.length ? `${done} of ${t.checks.length}${t.needs_review ? ` · ${first(t.approver.names[0]) || 'the approver'} ticks these before approving` : ''}` : 'What has to be true before it’s done'}</span></div>
    <ul class="tk-checks">${t.checks.map((c) => html`<li class="tk-check" data-k="ck${c.id}">${tick
      ? html`<input type="checkbox" data-act="tk-tick" data-id="${c.id}" ${raw(c.checked ? 'checked' : '')} aria-label="${c.title}" style="accent-color:#3DD68C">`
      : html`<span class="tk-box" aria-hidden="true" style="${c.checked ? 'background:#3DD68C;border-color:#3DD68C' : ''}"></span>`}<span style="flex:1">${M(c.title)}${c.checked && c.checked_by ? html` <span class="tk-small tk-muted">· ticked by ${first(c.checked_by)}</span>` : ''}</span>${r.edit && !c.checked && !tick ? html`<button type="button" class="tk-x-btn" data-act="tk-delcheck" data-id="${c.id}" aria-label="Remove ${c.title}">${I('x', 14)}</button>` : ''}</li>`)}</ul>
    ${r.edit ? html`<form class="tk-row" data-tk-form="check"><label class="tk-sr" for="tk-nc">Add a check</label><input id="tk-nc" class="tk-in" name="title" maxlength="200" data-mention autocomplete="off" placeholder="Add an item, like “Works on a phone”" required><button type="submit" class="tk-btn tk-sm" style="height:40px">Add</button></form>` : ''}
  </section>`;
}

function stepsCard(t, r) {
  const list = t.steps_list || [];
  if (!list.length && !ui.shown.has('steps')) return '';
  const done = list.filter((x) => x.done).length;
  const can = r.edit || r.mine;
  return html`<section class="tk-card"><div class="tk-ch"><h2>Steps</h2><span class="tk-small tk-muted">${list.length ? `${done} of ${list.length}` : ''}</span></div>
    ${list.length ? html`<div aria-hidden="true" style="height:6px;border-radius:99px;background:rgba(255,255,255,.08)"><div style="width:${Math.round((100 * done) / list.length)}%;height:100%;border-radius:99px;background:linear-gradient(90deg,rgb(var(--v-7c5cf0, 124 92 240)),rgb(var(--v-9b7bff, 155 123 255)))"></div></div>` : ''}
    <ul class="tk-checks">${list.map((x, i) => html`<li class="tk-check" data-k="st${x.id}"><label class="tk-check${x.done ? ' tk-did' : ''}" style="flex:1"><input type="checkbox" data-act="tk-step" data-i="${i}" ${raw(x.done ? 'checked' : '')} ${raw(can ? '' : 'disabled')}><span>${M(x.title)}</span></label>${can ? html`<button type="button" class="tk-x-btn" data-act="tk-delstep" data-i="${i}" aria-label="Remove ${x.title}">${I('x', 14)}</button>` : ''}</li>`)}</ul>
    ${can ? html`<form class="tk-row" data-tk-form="step"><label class="tk-sr" for="tk-ns">Add a step</label><input id="tk-ns" class="tk-in" name="title" maxlength="200" data-mention autocomplete="off" placeholder="Add a step. Type @ to mention someone" required><button type="submit" class="tk-btn tk-sm" style="height:40px">Add</button></form>` : ''}
  </section>`;
}

// a file or link on a project's task can be saved to the client's assets in one click
function saveBtn(t, { file = null, link = null, url = null }) {
  const a = t.assets;
  if (!a) return '';
  const inIt = file != null ? a.files.includes(file) : a.urls.includes(url);
  return inIt ? html`<span class="tk-tag tk-green tk-inas" title="Saved to ${a.name}’s assets">${I('check', 12, 3)}In ${a.client_id ? 'their' : 'project'} assets</span>`
    : html`<button type="button" class="tk-btn tk-sm tk-saveas" data-act="tk-saveasset" ${raw(file != null ? `data-file="${file}"` : `data-link="${link}"`)} title="Save to ${esc(a.name)}’s assets">${I('plus', 14, 2.4)}<span>Save to assets</span></button>`;
}
function linkItem(t, w, r) {
  const gh = /github\.com$/.test(w.host) && /\/pull\/\d+/.test(w.url);
  return html`<li class="tk-item" data-k="ln${w.id}"><span class="tk-thumb ${gh ? 'tk-pr' : 'tk-ln'}" aria-hidden="true">${I(gh ? 'pr' : 'globe', 20)}</span><span class="tk-t"><a href="${w.url}" target="_blank" rel="noopener noreferrer" style="color:rgb(var(--v-f2efff, 242 239 255));font-weight:600;font-size:14.5px">${w.title || w.host}</a><span>Link · ${w.host}${w.user ? ` · ${first(w.user)}` : ''}</span></span>${r.noSave ? '' : saveBtn(t, { link: w.id, url: w.url })}${r.manage || w.user_id === S.me.id ? html`<button type="button" class="tk-x-btn" data-act="tk-dellink" data-id="${w.id}" aria-label="Remove link">${I('x', 14)}</button>` : ''}</li>`;
}
const thumb = (t, f) => (isImg(f) ? html`<img class="tk-thumbimg" alt="" data-tkimg="${fileSrc(t, f)}" ${raw(imgCache.get(fileSrc(t, f)) ? `src="${imgCache.get(fileSrc(t, f))}"` : '')}>`
  : isPdf(f) ? html`<img class="tk-thumbimg tk-pdfthumb" alt="" data-tkpdf="${f.id}:1" ${raw(imgCache.get(`pdf:${f.id}:1`) ? `src="${imgCache.get(`pdf:${f.id}:1`)}"` : '')}>`
    : html`<span class="tk-thumb tk-doc" aria-hidden="true"><i style="width:80%"></i><i style="width:60%"></i><i style="width:70%"></i></span>`);
// one piece of work: its latest version, how many versions, and the pins still open on it
function chainItem(t, c, r, { canAdd = true } = {}) {
  const f = c.latest, open = openPins(t, c.id).length;
  const meta = [isImg(f) ? 'Picture' : isPdf(f) ? 'PDF' : 'File', kb(f.size), c.versions.length > 1 ? `V${f.version}` : '', f.user ? first(f.user) : ''].filter(Boolean).join(' · ');
  return html`<li class="tk-item" data-k="ch${c.id}">${thumb(t, f)}
    <span class="tk-t">${pinnable(f)
      ? html`<button type="button" class="tk-lnk tk-open" data-act="tk-open" data-v="c${c.id}">${c.label}</button>`
      : html`<button type="button" class="tk-lnk tk-open" data-act="tk-file" data-id="${f.id}" data-name="${f.name}">${c.label}</button>`}
      <span>${meta}${open ? html` · <b class="tk-amber-t">${plural(open, 'open pin')}</b>` : ''}</span></span>
    ${saveBtn(t, { file: f.id })}
    ${canAdd && (r.edit || r.approver) ? html`<label class="tk-btn tk-sm tk-ver" title="Upload a new version of ${c.label}">${I('up', 15)}<span>New version</span><input type="file" data-tk-file data-ver="${f.id}" hidden></label>` : ''}
    ${canAdd && (f.user_id === S.me.id || r.manage) ? html`<button type="button" class="tk-x-btn" data-act="tk-delfile" data-id="${f.id}" data-v="${c.versions.length}" aria-label="Remove ${c.label}${c.versions.length > 1 ? `, V${f.version}` : ''}">${I('x', 14)}</button>` : ''}</li>`;
}
function filesCard(t, r, title) {
  const chains = chainsOf(t);
  if (!chains.length && !t.links.length && !ui.shown.has('files') && t.status === 'todo') return '';
  return html`<section class="tk-card"><div class="tk-ch"><h2>${title}</h2><span class="tk-small tk-muted">${t.status === 'todo' ? '' : t.needs_review ? `${first(t.approver.names[0]) || 'The approver'} looks at these when checking your work` : ''}</span></div>
    ${chains.length || t.links.length ? html`<ul class="tk-list">${t.links.map((w) => linkItem(t, w, r))}${chains.map((c) => chainItem(t, c, r))}</ul>` : ''}
    ${r.edit ? html`<form class="tk-row" data-tk-form="link"><label class="tk-sr" for="tk-nl">Add a link</label><input id="tk-nl" class="tk-in" name="url" type="url" inputmode="url" placeholder="Paste a link: a pull request, a page, a doc" required><button type="submit" class="tk-btn tk-sm" style="height:40px">Add</button></form>
      <label class="tk-drop" style="cursor:pointer">Drop a file here, paste a screenshot, or <u>pick a file</u> (up to 50 MB)<input type="file" data-tk-file hidden></label>` : ''}
  </section>`;
}

function workCards(t, r, changes) {
  // while changes are asked, the checklist is already in “What to change”
  const two = [changes ? '' : checksCard(t, r), filesCard(t, r, 'Files and links')].filter((x) => x);
  const steps = stepsCard(t, r);
  return html`${steps && two.length ? html`<div class="tk-g2">${steps}${two[0]}</div>${two.slice(1)}` : html`${steps}${two.length === 2 ? html`<div class="tk-g2">${two}</div>` : two}`}`;
}

function addRow(t, r, projects) {
  if (!r.edit && !r.mine) return '';
  const b = (key, icon, label, sub) => html`<button type="button" class="tk-mi" data-act="tk-show" data-v="${key}">${I(icon, 16)}<span class="tk-x">${label}<span>${sub}</span></span></button>`;
  const out = [];
  if (!(t.steps_list || []).length && !ui.shown.has('steps')) out.push(b('steps', 'steps', 'Steps', 'Break the work into smaller pieces'));
  if (!t.checks.length && !ui.shown.has('checks') && r.edit) out.push(b('checks', 'shield', 'Checklist', t.needs_review ? `What ${first(t.approver.names[0]) || 'the approver'} checks before approving` : 'What has to be true when it’s done'));
  if (t.status === 'todo' && !t.files.length && !t.links.length && !ui.shown.has('files') && r.edit) out.push(b('files', 'clip', 'Files or links', 'Pictures, PDFs, documents, links'));
  if (r.edit && !t.count) out.push(b('count', 'layers', 'A number to reach', 'Like “20 calls” or “5 posts”'));
  if (r.change && !t.estimate_min) out.push(b('estimate', 'clock', 'Time estimate', 'How long it should take'));
  if (r.change && t.recurrence === 'none' && !ui.shown.has('repeat')) out.push(b('repeat', 'repeat', 'Repeat', 'Every day, week or month'));
  if (r.change && t.milestones.length && !t.milestone_id && !ui.shown.has('milestone')) out.push(b('milestone', 'flag', 'Milestone', 'Group it with related work'));
  void projects;
  return out.length ? html`<div class="tk-md tk-addwrap"><details class="tk-more tk-addmenu"><summary class="tk-btn">${I('plus', 16, 2.4)}Add to this task</summary><div class="tk-menu" role="menu">${out}</div></details></div>` : '';
}

// ---------- a count ("12 of 20 called") and how it went ----------
function countCard(t, r) {
  const c = t.count, pct = Math.min(100, Math.round((100 * c.done) / c.target));
  const can = r.edit && t.status !== 'done';
  return html`<section class="tk-card tk-count"><div class="tk-ch"><h2>Progress</h2>${can ? html`<button type="button" class="tk-lnk tk-small" data-act="tk-count">Change</button>` : ''}</div>
    <div class="tk-cnt">
      <div class="tk-cntn"><b>${c.done}</b><span>of ${c.target}${c.unit ? ` ${c.unit}` : ''}</span></div>
      ${can ? html`<div class="tk-cntb"><button type="button" class="tk-btn" data-act="tk-bump" data-v="-1" ${raw(c.done ? '' : 'disabled')} aria-label="One less">− 1</button><button type="button" class="tk-btn tk-pri" data-act="tk-bump" data-v="1">+ 1${c.unit ? ` ${c.unit}` : ''}</button></div>` : ''}
    </div>
    <div class="tk-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${c.target}" aria-valuenow="${c.done}" aria-label="How far"><i style="width:${pct}%"></i></div>
    ${can || t.outcome ? html`<div class="field" style="margin:4px 0 0"><label class="f" for="tk-oc">How it went</label>${can ? html`<textarea id="tk-oc" class="tk-in tk-oc" data-tko maxlength="2000" rows="2" placeholder="What came of it: booked, sorted, still to follow up">${t.outcome || ''}</textarea><span class="tk-small tk-muted">Shown on the task when it’s done.</span>` : html`<p class="tk-p">${t.outcome}</p>`}</div>` : ''}
  </section>`;
}

// ---------- the work, big: versions, pins and pages ----------
function selected(t) {
  const chains = chainsOf(t);
  let key = ui.sel;
  if (!key || (key[0] === 'c' && !chains.some((c) => `c${c.id}` === key)) || (key[0] === 'l' && !t.links.some((l) => `l${l.id}` === key))) {
    const c = chains.find((x) => pinnable(x.latest)) || chains[0];
    key = c ? `c${c.id}` : t.links[0] ? `l${t.links[0].id}` : null;
  }
  const chain = key && key[0] === 'c' ? chains.find((c) => `c${c.id}` === key) : null;
  const link = key && key[0] === 'l' ? t.links.find((l) => `l${l.id}` === key) : null;
  const file = chain ? chain.versions.find((v) => v.id === ui.ver) || chain.latest : null;
  return { chains, key, chain, link, file };
}
function pinMarks(t, f, page, { live = true } = {}) {
  return t.pins.filter((p) => p.file_id === f.id && p.page === page).map((p) => html`<button type="button" class="tk-mark${p.resolved ? ' tk-fixed' : ''}${ui.pin === p.id ? ' tk-on' : ''}" style="left:${p.x * 100}%;top:${p.y * 100}%" ${raw(live ? `data-act="tk-pinsel" data-id="${p.id}"` : 'tabindex="-1"')} aria-label="Pin ${p.num}${p.resolved ? ', fixed' : ''}: ${esc(p.body.slice(0, 80))}">${p.num}</button>`);
}
function pinCard(t, p, r, { float = true } = {}) {
  const can = p.user_id === S.me.id || t.is_mine || r.approver || r.manage;
  const side = p.x > 0.58 ? `right:calc(${(1 - p.x) * 100}% + 20px)` : `left:calc(${p.x * 100}% + 20px)`;
  return html`<div class="tk-pop${float ? ' tk-float' : ''}" style="${float ? `${side};top:clamp(0px, calc(${p.y * 100}% - 24px), calc(100% - 120px))` : ''}" role="dialog" aria-label="Pin ${p.num}" data-k="pop${p.id}">
    <div class="tk-poph"><span class="tk-pn${p.resolved ? ' tk-g' : ''}">${p.num}</span><b>Pin ${p.num} · ${p.resolved ? 'fixed' : 'open'}</b><span class="tk-tag">${I('lock', 12, 2.2)}Team only</span><button type="button" class="tk-x-btn" data-act="tk-pinsel" data-id="0" aria-label="Close">${I('x', 14)}</button></div>
    <div class="tk-cm">${av(p.user_id, p.user)}<div class="tk-w"><div class="tk-by"><b>${p.user || 'Someone'}</b>${hm(p.created_at)}${verOf(t, p) > 1 || chainsOf(t).find((c) => c.id === p.chain_id)?.versions.length > 1 ? ` · on V${verOf(t, p)}` : ''}</div><p class="tk-feedtext">${M(p.body)}</p></div></div>
    ${p.replies.map((x) => html`<div class="tk-cm tk-rep" data-k="pr${x.id}">${av(x.user_id, x.user)}<div class="tk-w"><div class="tk-by"><b>${x.user || 'Someone'}</b>${hm(x.created_at)}</div><p class="tk-feedtext">${M(x.body)}</p></div></div>`)}
    ${p.pending ? html`<div class="tk-popa"><span class="tk-small tk-muted">Saving…</span></div>` : html`<div class="tk-popa"><button type="button" class="tk-btn tk-sm" data-act="tk-reply" data-id="${p.id}">${I('reply', 15)}Reply on pin ${p.num}</button>
      ${can ? html`<button type="button" class="tk-btn tk-sm ${p.resolved ? '' : 'tk-ok'}" data-act="tk-resolve" data-id="${p.id}" data-v="${p.resolved ? '0' : '1'}">${p.resolved ? 'Reopen' : html`${I('check', 15, 2.6)}Mark fixed`}</button>` : ''}
      ${p.user_id === S.me.id || r.manage ? html`<button type="button" class="tk-lnk tk-small" data-act="tk-delpin" data-id="${p.id}" style="margin-left:auto;color:rgb(var(--v-8e87b5, 142 135 181))">Remove</button>` : ''}</div>`}
  </div>`;
}
function draftCard(d) {
  const side = d.x > 0.58 ? `right:calc(${(1 - d.x) * 100}% + 20px)` : `left:calc(${d.x * 100}% + 20px)`;
  return html`<form class="tk-pop tk-float tk-draft" data-tk-form="pin" style="${side};top:clamp(0px, calc(${d.y * 100}% - 24px), calc(100% - 150px))" aria-label="Pin a comment here">
    <label class="f" for="tk-pd">Pin a comment here</label>
    <textarea id="tk-pd" name="body" rows="3" maxlength="2000" data-mention required placeholder="What should change at this spot? Type @ to mention someone"></textarea>
    <div class="tk-popa"><span class="tk-tag">${I('lock', 12, 2.2)}Team only</span><button type="button" class="tk-btn tk-sm" data-act="tk-undraft" style="margin-left:auto">Cancel</button><button type="submit" class="tk-btn tk-sm tk-pri">Pin it</button></div>
  </form>`;
}
// a picture or a PDF page, with its pins; click to pin
function stage(t, f, r, { live = true, page = 1 } = {}) {
  const pdf = isPdf(f);
  const src = pdf ? null : fileSrc(t, f);
  const img = pdf
    ? html`<img class="tk-shot" alt="${f.name}, page ${page}" data-tkpdf="${f.id}:${page}" ${raw(imgCache.get(`pdf:${f.id}:${page}`) ? `src="${imgCache.get(`pdf:${f.id}:${page}`)}"` : '')}>`
    : html`<img class="tk-shot" alt="${f.name}" data-tkimg="${src}" ${raw(imgCache.get(src) ? `src="${imgCache.get(src)}"` : '')}>`;
  const sel = live && ui.pin ? t.pins.find((p) => p.id === ui.pin && p.file_id === f.id && p.page === page) : null;
  const d = live && ui.draft && ui.draft.fid === f.id && ui.draft.page === page ? ui.draft : null;
  return html`<div class="tk-stagewrap"><div class="tk-stage${live ? ' tk-live-st' : ''}" ${raw(live ? `data-act="tk-pinat" data-fid="${f.id}" data-page="${page}"` : '')}>${img}${pinMarks(t, f, page, { live })}${d ? html`<span class="tk-mark tk-new" style="left:${d.x * 100}%;top:${d.y * 100}%" aria-hidden="true">+</span>` : ''}</div>
    ${sel ? pinCard(t, sel, r) : ''}${d ? draftCard(d) : ''}</div>`;
}
function pageNav(f) {
  const n = pdfPages.get(f.id);
  return html`<div class="tk-pages" aria-label="Pages"><button type="button" class="tk-btn tk-sm tk-icon" data-act="tk-page" data-v="-1" ${raw(ui.page > 1 ? '' : 'disabled')} aria-label="Previous page">${I('prev', 16)}</button><span>Page ${ui.page}${n ? ` of ${n}` : ''}</span><button type="button" class="tk-btn tk-sm tk-icon" data-act="tk-page" data-v="1" ${raw(!n || ui.page < n ? '' : 'disabled')} aria-label="Next page">${I('next', 16)}</button></div>`;
}
function viewer(t, r, { close = false } = {}) {
  const { chains, key, chain, link, file } = selected(t);
  if (file && isPdf(file) && pdfPages.get(file.id) && ui.page > pdfPages.get(file.id)) ui.page = 1;
  const tabs = [...chains.map((c) => { const n = openPins(t, c.id).length; return html`<button type="button" class="tk-ftab" role="tab" aria-selected="${String(key === `c${c.id}`)}" data-act="tk-sel" data-v="c${c.id}">${I(isImg(c.latest) ? 'img' : 'clip', 16)}${c.label}${n ? html`<span class="tk-pn">${n}</span>` : ''}</button>`; }),
    ...t.links.map((l) => html`<button type="button" class="tk-ftab" role="tab" aria-selected="${String(key === `l${l.id}`)}" data-act="tk-sel" data-v="l${l.id}">${I(/github/.test(l.host) ? 'pr' : 'globe', 16)}${l.title || l.host}</button>`)];
  let body;
  if (!key) body = html`<p class="tk-empty">${first(t.assignee) || 'They'} sent this without files or links. Check the steps and the conversation.</p>`;
  else if (link) body = html`<a class="tk-linkcard" href="${link.url}" target="_blank" rel="noopener noreferrer"><span class="tk-thumb ${/github/.test(link.host) ? 'tk-pr' : 'tk-ln'}" aria-hidden="true">${I(/github/.test(link.host) ? 'pr' : 'globe', 22)}</span><span class="tk-t"><b>${link.title || link.host}</b><span>Opens ${link.host} in a new tab</span></span>${I('arrow', 18)}</a>`;
  else {
    const vers = chain.versions.length > 1 ? html`<div class="tk-vers" role="group" aria-label="Versions">${chain.versions.map((v) => html`<button type="button" class="tk-ver-b" aria-pressed="${String(v.id === file.id)}" data-act="tk-ver" data-id="${v.id}">V${v.version}${v === chain.latest ? ' · latest' : ''}</button>`)}</div>` : '';
    const tools = html`<div class="tk-vtools">${vers}
      ${chain.versions.length > 1 && pinnable(file) ? html`<button type="button" class="tk-btn tk-sm" data-act="tk-compare" data-v="${chain.id}">${I('cmp', 15)}Compare</button>` : ''}
      ${r.edit || r.approver ? html`<label class="tk-btn tk-sm" title="Upload a new version of ${chain.label}">${I('up', 15)}New version<input type="file" data-tk-file data-ver="${chain.latest.id}" hidden></label>` : ''}
      <button type="button" class="tk-btn tk-sm tk-icon" data-act="tk-file" data-id="${file.id}" data-name="${file.name}" aria-label="Download ${file.name}" title="Download">${I('dl', 16)}</button>
      ${r.edit ? html`<button type="button" class="tk-btn tk-sm tk-icon" data-act="tk-rename" data-id="${file.id}" aria-label="Rename ${chain.label}" title="Rename">${I('pen', 15)}</button>` : ''}</div>`;
    const earlier = chain.versions.length > 1 ? openPins(t, chain.id).filter((p) => p.file_id !== file.id) : [];
    body = html`${tools}
      ${file.note && file.version > 1 ? html`<p class="tk-vnote"><b>${first(file.user)} with V${file.version}:</b> ${file.note}</p>` : ''}
      ${pinnable(file) ? html`${isPdf(file) ? pageNav(file) : ''}${stage(t, file, r, { page: isPdf(file) ? ui.page : 1 })}
        <p class="tk-hint">${matchMedia('(hover: none)').matches ? 'Tap' : 'Click'} the ${isPdf(file) ? 'page' : 'picture'} to leave a comment on that spot.</p>`
        : html`<div class="tk-linkcard">${thumb(t, file)}<span class="tk-t"><b>${file.name}</b><span>${kb(file.size)}</span></span><button type="button" class="tk-btn tk-sm" data-act="tk-file" data-id="${file.id}" data-name="${file.name}">${I('dl', 16)}Download</button></div>`}
      ${earlier.length ? html`<div class="tk-earlier"><span class="tk-small tk-muted">Still open from earlier versions</span>${earlier.map((p) => html`<button type="button" class="tk-pinrow" data-act="tk-goto" data-id="${p.id}"><span class="tk-pn">${p.num}</span><span>V${verOf(t, p)} · ${p.body}</span></button>`)}</div>` : ''}`;
  }
  return html`<section class="tk-viewer" aria-label="Work to show" data-k="viewer">
    ${tabs.length || close ? html`<div class="tk-vhead">${tabs.length ? html`<div class="tk-ftabs" role="tablist" aria-label="Work to show">${tabs}</div>` : ''}${close ? html`<button type="button" class="tk-btn tk-sm" data-act="tk-close" style="margin-left:auto">Close</button>` : ''}</div>` : ''}
    ${body}
    ${t.status === 'in_review' && r.mine ? html`<p class="tk-hint">${approverName(t)} is reviewing this. You can still add a comment or a new version.</p>` : ''}
  </section>`;
}

// ---------- compare two versions ----------
function compareView(t, r) {
  const c = chainsOf(t).find((x) => x.id === ui.compare);
  const vs = c.versions;
  const a = vs.find((v) => v.id === ui.cmpA) || vs[vs.length - 2], b = vs.find((v) => v.id === ui.cmpB) || vs[vs.length - 1];
  const pick = (which, v) => html`<label class="tk-vpick"><span class="tk-sr">${which === 'a' ? 'Left' : 'Right'} version</span><select data-tk-cmp="${which}">${vs.map((x) => html`<option value="${x.id}" ${raw(x.id === v.id ? 'selected' : '')}>V${x.version} · ${hm(x.created_at)}</option>`)}</select><span>Round ${v.round || 1}${v === c.latest ? ' · latest' : ''}</span></label>`;
  const pg = isPdf(b) ? ui.page : 1;
  const side = html`<div class="tk-cmpgrid"><div>${pick('a', a)}${stage(t, a, r, { live: false, page: pg })}</div><div>${pick('b', b)}${stage(t, b, r, { live: false, page: pg })}</div></div>`;
  const srcOf = (f) => (isPdf(f) ? `pdf:${f.id}:${pg}` : fileSrc(t, f));
  const im = (f, cls) => (isPdf(f) ? html`<img class="tk-shot ${cls}" alt="V${f.version}" data-tkpdf="${f.id}:${pg}" ${raw(imgCache.get(srcOf(f)) ? `src="${imgCache.get(srcOf(f))}"` : '')}>` : html`<img class="tk-shot ${cls}" alt="V${f.version}" data-tkimg="${srcOf(f)}" ${raw(imgCache.get(srcOf(f)) ? `src="${imgCache.get(srcOf(f))}"` : '')}>`);
  const slide = html`<div class="tk-cmprow">${pick('a', a)}${pick('b', b)}</div>
    <div class="tk-stagewrap"><div class="tk-slider" style="--cut:${ui.cut ?? 50}%">${im(a, 'tk-sa')}${im(b, 'tk-sb')}<i class="tk-cutline" aria-hidden="true"></i></div></div>
    <label class="tk-cutr"><span class="tk-sr">Slide between V${a.version} and V${b.version}</span><span>V${a.version}</span><input type="range" min="0" max="100" value="${ui.cut ?? 50}" data-tk-cut><span>V${b.version}</span></label>`;
  const pins = t.pins.filter((p) => p.chain_id === c.id);
  const rounds = [...new Set(pins.map((p) => p.round).concat(vs.map((v) => v.round || 1)))].sort((x, y) => x - y);
  return html`<section class="tk-viewer tk-cmp" aria-label="Compare versions" data-k="cmp">
    <div class="tk-vhead"><button type="button" class="tk-btn tk-sm" data-act="tk-uncompare">${I('back', 15)}${t.status === 'in_review' ? 'Back to review' : 'Back'}</button><b class="tk-cmpt">${c.label}</b>
      <div class="tk-seg" role="group" aria-label="How to compare"><button type="button" aria-pressed="${String(ui.cmode === 'side')}" data-act="tk-cmode" data-v="side">Side by side</button><button type="button" aria-pressed="${String(ui.cmode === 'slide')}" data-act="tk-cmode" data-v="slide">Slider</button></div></div>
    ${isPdf(b) ? pageNav(b) : ''}
    ${ui.cmode === 'slide' ? slide : side}
  </section>
  <section class="tk-card"><div class="tk-ch"><h2>What changed in V${b.version}</h2></div>
    ${b.note ? html`<div class="tk-cm">${av(b.user_id, b.user)}<div class="tk-w"><div class="tk-by"><b>${b.user || 'Someone'}</b>with V${b.version}</div><p class="tk-feedtext">${b.note}</p></div></div>` : html`<p class="tk-small tk-muted" style="margin:0">${first(b.user) || 'They'} didn’t say what changed.</p>`}
    ${pins.length ? html`<ul class="tk-list">${pins.map((p) => { const v = verOf(t, p); const st = p.resolved ? 'is fixed' : v === b.version ? `is new on V${v}` : `is still open from V${v}`; return html`<li class="tk-item" data-k="cp${p.id}"><span class="tk-pn${p.resolved ? ' tk-g' : ''}">${p.num}</span><span class="tk-t"><b>Pin ${p.num} ${st}</b><span>“${p.body.length > 90 ? `${p.body.slice(0, 87)}…` : p.body}”</span></span><button type="button" class="tk-lnk tk-small" data-act="tk-goto" data-id="${p.id}">Go to pin</button></li>`; })}</ul>` : ''}
    <p class="tk-small tk-muted" style="margin:0"><b>Rounds:</b> ${rounds.map((n) => { const k = pins.filter((p) => p.round === n).length; return n === t.review_rounds + 1 && t.status !== 'done' ? `round ${n} is open now${k ? ` with ${plural(k, 'pin')}` : ''}` : `round ${n} asked for ${plural(k, 'change')}`; }).join(' · ')}</p>
  </section>`;
}

// ---------- review: the work, big ----------
function reviewView(t, r) {
  return html`${viewer(t, r)}${reviewExtras(t, r)}`;
}
function reviewExtras(t, r) {
  return html`${t.count ? '' : ''}${stepsCard(t, r)}
  ${!r.approver ? checksCard(t, r) : ''}
  ${t.description ? html`<section class="tk-card tk-md"><h2>What to do</h2><p class="tk-p" style="white-space:pre-line">${t.description}</p></section>` : ''}`;
}

// ---------- changes asked: a to-do list made from the feedback ----------
function changesView(t, r) {
  const fb = [...t.comments].reverse().find((c) => c.kind === 'feedback');
  const open = t.checks.filter((c) => !c.checked);
  const pins = openPins(t);
  const by = fb ? fb.user : approverName(t);
  const note = fb ? fb.body.split('\n\nStill to do:')[0].replace(/^Still to do:[\s\S]*$/, '') : '';
  const n = open.length + pins.length + (note ? 1 : 0);
  void n; void by; void note;
  return html`${open.length || pins.length ? html`<section class="tk-card"><div class="tk-ch"><h2>What to change</h2><span class="tk-small tk-muted">Mark each one fixed as you go</span></div>
    <ul class="tk-list">${pins.map((p) => html`<li class="tk-item" data-k="op${p.id}"><span class="tk-pn">${p.num}</span><span class="tk-t"><b>${M(p.body)}</b><span>${chainName(t, p.chain_id)} · V${verOf(t, p)} · ${first(p.user)}${p.replies.length ? ` · ${plural(p.replies.length, 'reply', 'replies')}` : ''}</span></span><button type="button" class="tk-btn tk-sm" data-act="tk-goto" data-id="${p.id}">Go to pin</button>${t.is_mine || r.manage ? html`<button type="button" class="tk-btn tk-sm tk-ok" data-act="tk-resolve" data-id="${p.id}" data-v="1">${I('check', 15, 2.6)}Mark fixed</button>` : ''}</li>`)}
      ${open.map((c) => html`<li class="tk-item" data-k="oc${c.id}"><span class="tk-tag">Checklist</span><span class="tk-t"><b>${M(c.title)}</b></span></li>`)}</ul></section>` : ''}
  ${brief(t, r)}`;
}

// ---------- done: what happened ----------
function doneView(t, r) {
  const ap = [...t.events].reverse().find((e) => e.kind === 'approved' || e.kind === 'completed');
  const steps = t.steps_list || [];
  const tiles = [
    ...(t.count ? [['Progress', `${t.count.done} of ${t.count.target}`, t.count.unit || 'done']] : []),
    ...(t.tracked_secs ? [['Time on it', dur(t.tracked_secs), `${t.estimate_min ? `of a ${dur(t.estimate_min * 60)} estimate, ` : ''}in ${plural(t.sessions, 'session')}`]] : []),
    ...(t.needs_review ? [['Rounds', String(t.review_rounds + 1), t.review_rounds ? `${plural(t.review_rounds, 'time')} sent back` : 'approved first time']] : []),
    ...(t.pins.length ? [['Pins', `${t.pins.filter((p) => p.resolved).length} of ${t.pins.length}`, 'fixed']] : []),
    ...(steps.length ? [['Steps', `${steps.filter((x) => x.done).length} of ${steps.length}`, 'done']] : []),
    ...(t.checks.length ? [['Checklist', `${t.checks.filter((c) => c.checked).length} of ${t.checks.length}`, 'ticked']] : []),
  ].slice(0, 4);
  const chains = chainsOf(t);
  void ap;
  return html`${tiles.length ? html`<div class="tk-g4">${tiles.map(([a, b, c]) => html`<div class="tk-tile"><span>${a}</span><b>${b}</b><span>${c}</span></div>`)}</div>` : ''}
  ${t.assets && t.assets.saved.length ? savedCard(t) : ''}
  ${t.outcome ? html`<section class="tk-card"><h2>How it went</h2><p class="tk-p" style="white-space:pre-line">${t.outcome}</p></section>` : ''}
  ${chains.length || t.links.length ? html`<section class="tk-card"><div class="tk-ch"><h2>Files and links</h2></div><ul class="tk-list">${t.links.map((w) => linkItem(t, w, { manage: false }))}${chains.map((c) => chainItem(t, c, r, { canAdd: false }))}</ul></section>` : ''}
  ${t.description ? html`<section class="tk-card tk-md"><h2>What to do</h2><p class="tk-p" style="white-space:pre-line">${t.description}</p></section>` : ''}`;
}

function savedCard(t) {
  const a = t.assets, href = a.client_id && isMgr() ? `#/clients?id=${a.client_id}&tab=assets` : `#/project?id=${t.project_id}&tab=assets`;
  return html`<section class="tk-card tk-savedas" aria-label="Saved to assets"><div class="tk-ch"><h2>Saved to ${a.name}’s assets</h2><span class="tk-small tk-muted">The approved version of each picture and PDF</span></div>
    <ul class="tk-list">${a.saved.map((x) => html`<li class="tk-item" data-k="sa${x.id}"><span class="tk-thumb tk-ln" aria-hidden="true">${I('img', 18)}</span><span class="tk-t"><b>${x.title}</b><span>${x.version > 1 ? `V${x.version} · ` : ''}${x.shared ? `${a.name} sees it` : 'Team only'}</span></span></li>`)}</ul>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="tk-btn tk-sm" href="${href}">Open their assets</a><button type="button" class="tk-btn tk-sm" data-act="tk-unsave">Undo</button></div></section>`;
}

// ---------- on a phone: Work, Conversation and Details as tabs ----------
function phoneTabs(t) {
  const n = openPins(t).length;
  return html`<div class="tk-mtabs" role="tablist" aria-label="Show">${[['work', 'Work'], ['talk', 'Comments'], ['details', 'Details']].map(([k, label]) => html`<button type="button" role="tab" aria-selected="${String(ui.mtab === k)}" data-act="tk-mtab" data-v="${k}">${label}${k === 'talk' && n ? html`<span class="tk-n">${n}</span>` : ''}</button>`)}</div>`;
}

// ---------- the side panel: deciding, and the conversation ----------
function rail(t, r) {
  const deciding = t.status === 'in_review' && r.approver && t.checks.length;
  const comments = t.comments.map((c) => ({ at: c.created_at, c }));
  const pins = t.pins.map((p) => ({ at: p.created_at, p }));
  // pin events show as the pin itself; repeats of the same event fold into one line below
  const events = t.events.filter((e) => !['edited', 'member', 'pin'].includes(e.kind)).map((e) => ({ at: e.at, e }));
  let items = [...comments, ...pins, ...events];
  // Comments: what people wrote (comments, pins, feedback). Activity: everything that happened.
  if (ui.tab === 'activity') items = events;
  else items = [...comments, ...pins];
  items.sort((a, b) => a.at.localeCompare(b.at));
  // the same person doing the same thing a few times in a row reads as one line
  items = items.reduce((out, x) => {
    const prev = out[out.length - 1];
    if (x.e && prev && prev.e && prev.e.kind === x.e.kind && prev.e.user === x.e.user && /^(check_added|check_ticked|check_unticked|file|link)$/.test(x.e.kind) && Date.parse(x.at) - Date.parse(prev.last || prev.at) < 30 * 60000) {
      prev.n = (prev.n || 1) + 1; prev.last = x.at; prev.details = [...(prev.details || [prev.e.detail]), x.e.detail]; return out;
    }
    out.push({ ...x }); return out;
  }, []);
  const fbCount = openPins(t).length;
  const feed = items.map((x) => (x.p ? pinItem(t, x.p, r) : x.c ? commentItem(t, x.c, r) : html`<li class="tk-ev" data-k="e${x.e.at}${x.e.kind}"><i style="background:${/approved|completed/.test(x.e.kind) ? '#3DD68C' : /sent_back/.test(x.e.kind) ? '#F7B544' : /submitted/.test(x.e.kind) ? 'rgb(var(--v-9b7bff, 155 123 255))' : 'rgb(var(--v-8e87b5, 142 135 181))'}"></i><span><b>${x.e.user || 'Someone'}</b> ${x.n ? `${MANY[x.e.kind](x.n)}: ${x.details.join(' · ')}` : `${EVENT[x.e.kind] || x.e.kind}${x.e.detail && !/^(sent_back|submitted)$/.test(x.e.kind) ? `: ${x.e.detail}` : ''}`} · ${relTime(x.last || x.e.at)}</span></li>`));
  return html`<aside class="tk-rail" aria-label="${deciding ? 'Decide and conversation' : 'Conversation'}">
    ${deciding ? html`<section class="tk-decide" aria-label="Checklist"><div class="tk-ch"><h3>Checklist</h3><span class="tk-small tk-muted">${t.checks.filter((c) => c.checked).length} of ${t.checks.length}</span></div>
      <ul class="tk-checks">${t.checks.map((c) => html`<li data-k="dk${c.id}"><label class="tk-check tk-ok"><input type="checkbox" data-act="tk-tick" data-id="${c.id}" ${raw(c.checked ? 'checked' : '')}><span>${M(c.title)}</span></label></li>`)}</ul>
      <span class="tk-small tk-muted">Tick what’s right. Anything left unticked goes back when you ask for changes.</span></section>` : ''}
    <div class="tk-rh">
      <div class="tk-tabs" role="tablist" aria-label="Show">${[['talk', 'Comments'], ['activity', 'Activity']].map(([k, n]) => html`<button type="button" class="tk-tab" role="tab" aria-selected="${String(ui.tab === k)}" data-act="tk-tab" data-v="${k}">${n}${k === 'talk' && fbCount ? html`<span class="tk-n" title="${plural(fbCount, 'pin')} still open">${fbCount}</span>` : ''}</button>`)}</div>
    </div>
    <ol class="tk-feed">${feed.length ? feed : html`<li class="tk-small tk-muted">${ui.tab === 'activity' ? 'Nothing has happened yet.' : 'No comments yet. Write one below.'}</li>`}</ol>
    ${composer(t, r)}
  </aside>`;
}

function pinItem(t, p, r) {
  const multi = chainsOf(t).find((c) => c.id === p.chain_id)?.versions.length > 1;
  const can = p.user_id === S.me.id || t.is_mine || r.approver || r.manage;
  return html`<li class="tk-pinit${p.pending ? ' tk-pending' : ''}${p.resolved ? ' tk-res' : ''}${ui.pin === p.id ? ' tk-on' : ''}" data-k="fp${p.id}">
    <div class="tk-pinh"><span class="tk-pn${p.resolved ? ' tk-g' : ''}">${p.num}</span><span>${chainName(t, p.chain_id)}${multi ? ` · ${p.resolved ? `from V${verOf(t, p)}` : `V${verOf(t, p)}`}` : ''}${isPdf(fileOf(t, p.file_id) || {}) ? ` · page ${p.page}` : ''} · ${p.resolved ? 'fixed' : 'open'}</span><button type="button" class="tk-lnk tk-small" data-act="tk-goto" data-id="${p.id}">Go to pin</button></div>
    <p class="tk-feedtext"><b>${first(p.user)}:</b> ${M(p.body)}</p>
    ${p.replies.map((x) => html`<p class="tk-feedtext tk-rep" data-k="fr${x.id}"><b>${first(x.user)}:</b> ${M(x.body)}</p>`)}
    <div class="tk-popa">${p.pending ? html`<span class="tk-small tk-muted">Saving…</span>` : html`<button type="button" class="tk-lnk tk-small" data-act="tk-reply" data-id="${p.id}">Reply</button>`}${can && !p.pending ? html`<button type="button" class="tk-lnk tk-small" data-act="tk-resolve" data-id="${p.id}" data-v="${p.resolved ? '0' : '1'}">${p.resolved ? 'Reopen' : 'Mark fixed'}</button>` : ''}<span class="tk-small tk-muted" style="margin-left:auto">${relTime(p.created_at)}</span></div>
  </li>`;
}

// review feedback: the reviewer's note, and the list folded away (the same list is on the page)
function feedbackBody(body) {
  const [note, rest] = String(body).split(/(?:^|\n\n)Still to do:\n/);
  const items = rest ? rest.split('\n').filter(Boolean) : [];
  return html`${note ? html`<p class="tk-feedtext">${M(note)}</p>` : ''}${items.length ? html`<details class="tk-fbl"><summary>${plural(items.length, 'thing')} to fix</summary><p class="tk-feedtext">${items.join('\n')}</p></details>` : ''}`;
}

function commentItem(t, c, r) {
  const kind = c.kind === 'update' ? 'progress update' : c.kind === 'feedback' ? 'asked for changes' : '';
  const body = html`<li class="tk-cm${c.kind === 'feedback' ? ' tk-fb' : ''}${c.pending ? ' tk-pending' : ''}" data-k="c${c.id}">${av(c.user_id || c.client_user_id, c.user)}<div class="tk-w">
    <div class="tk-by"><b>${c.user || 'Someone'}</b>${c.pending ? 'Sending…' : relTime(c.created_at)}${kind ? html` · <span class="tk-kind">${kind}</span>` : ''}${c.from_client ? html` · <span class="tk-kind">${t.client || 'Client'}</span>` : ''}${c.team_only && c.kind !== 'feedback' ? html` · <span class="tk-kind">team only</span>` : ''}${!c.pending && (c.user_id === S.me.id || r.manage) ? html` <button type="button" class="tk-lnk" style="font-size:12px;min-height:0;color:rgb(var(--v-8e87b5, 142 135 181))" data-act="tk-delc" data-id="${c.id}">Delete</button>` : ''}</div>
    ${c.kind === 'feedback' ? feedbackBody(c.body) : c.body ? html`<p class="tk-feedtext">${M(c.body)}</p>` : ''}
    ${c.file ? html`<button type="button" class="tk-lnk" style="min-height:0" data-act="tk-cfile" data-url="${c.file.url}" data-name="${c.file.name}">${I('clip', 14)} ${c.file.name}</button>` : ''}
  </div></li>`;
  return body;
}

function composer(t, r) {
  const modes = [['comment', 'Comment'], ['update', 'Progress update'], ...(t.client && t.client_sees ? [['team', 'Team only']] : [])];
  if (!modes.some(([k]) => k === ui.mode) && ui.mode !== 'update') ui.mode = 'comment';
  const canAsk = t.status === 'in_review' && r.approver;
  const rp = ui.replyPin ? t.pins.find((p) => p.id === ui.replyPin) : null;
  if (ui.replyPin && !rp) ui.replyPin = null;
  return html`<form class="tk-comp" data-tk-form="comment" aria-label="Write in the conversation">
    <div class="tk-cbox">
      ${rp ? html`<div class="tk-replying"><span class="tk-pn">${rp.num}</span><span>Replying on pin ${rp.num} · ${chainName(t, rp.chain_id)} · team only</span><button type="button" class="tk-x-btn" data-act="tk-reply" data-id="0" aria-label="Stop replying on the pin">${I('x', 14)}</button></div>`
        : ui.mode === 'update' ? html`<div class="tk-replying tk-upd"><span>Posting as a progress update</span><button type="button" class="tk-x-btn" data-act="tk-mode" data-v="comment" aria-label="Post as a normal comment">${I('x', 14)}</button></div>` : ''}
      <div class="tk-cin">
        <label for="tk-c" class="tk-sr">Write a comment</label>
        <textarea id="tk-c" name="body" rows="2" maxlength="4000" data-mention placeholder="${rp ? `Reply on pin ${rp.num}. Type @ to mention someone` : ui.mode === 'update' ? 'How it’s going: what’s done, what’s next' : ui.mode === 'team' ? `Only the team sees this, never ${t.client}` : 'Write a comment. Type @ to mention someone'}"></textarea>
        <div class="tk-tools">
          <details class="tk-more"><summary class="tk-ti" aria-label="More: progress update, step, checklist item or new task">${I('plus')}</summary><div class="tk-menu tk-cmenu" role="menu">
            <button type="button" class="tk-mi" data-act="tk-mode" data-v="update">${I('layers', 16)}<span class="tk-x">Post as a progress update<span>What’s done and what’s next</span></span></button>
            <div class="tk-mlab">Turn what you wrote into</div>
            <button type="button" class="tk-mi" data-act="tk-as" data-v="step">${I('steps', 16)}<span class="tk-x">A step<span>Added to the steps on this task</span></span></button>
            ${r.edit ? html`<button type="button" class="tk-mi" data-act="tk-as" data-v="check">${I('shield', 16)}<span class="tk-x">A checklist item<span>${first(t.approver.names[0]) || 'The approver'} ticks it before approving</span></span></button>` : ''}
            <button type="button" class="tk-mi" data-act="tk-as" data-v="task">${I('plus', 16)}<span class="tk-x">A new task<span>In the same project</span></span></button></div></details>
          <label class="tk-ti" aria-label="Attach a file" title="Attach a file">${I('clip')}<input type="file" data-tk-file hidden></label>
          ${t.client && t.client_sees ? html`<label class="tk-teamonly" title="Only the team sees it, never ${t.client}"><input type="checkbox" data-tk-team ${raw(ui.mode === 'team' ? 'checked' : '')}>${I('lock', 13, 2.2)}Team only</label>` : ''}
          <span class="tk-send"><button type="submit">Send</button>${canAsk ? html`<details class="tk-more" style="display:flex"><summary aria-label="More ways to send" style="height:34px;width:30px;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgb(var(--v-7c5cf0, 124 92 240)),rgb(var(--v-9b7bff, 155 123 255)));color:#fff;border-left:1px solid rgba(255,255,255,.28);cursor:pointer">${I('chev', 14, 2.4)}</summary><div class="tk-menu" role="menu" style="bottom:calc(100% + 6px);top:auto"><button type="button" class="tk-mi" data-act="tk-sendask">${I('up', 16)}<span class="tk-x">Send and ask for changes<span>Sends it back with this note and the unticked checks</span></span></button></div></details>` : ''}</span>
        </div>
      </div>
      <div class="tk-chint">Press Enter to send · type @ to mention someone</div>
    </div>
  </form>`;
}

// ---------- actions ----------
const T = () => cur && cur.t;
const done = async (msg) => { if (msg) toast(msg); (S.refreshNow || S.refresh)(); };
// redraw from what we already have: for switching tabs, versions, pins and the like, nothing to fetch
function redraw() {
  const v = document.getElementById('view'), root = v && v.querySelector('.tkp');
  if (!root || !cur) { S.refresh(); return; }
  morph(v, page(cur.t, cur.projects).toString());
  if (mod && mod.after) mod.after(v);
}
// a button shows it's working until the server answers, so a click never looks ignored
const busy = (b, on) => { if (!b) return; b.classList.toggle('tk-busy', on); if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy'); };
const run = (fn) => async (el, e) => {
  const b = el && el.closest && el.matches && !el.matches('input') ? el.closest('button, label.tk-btn') : null;
  if (b && b.classList.contains('tk-busy')) return;
  busy(b, true);
  try { await fn(el, e); } catch (err) { toast(errMsg(err), true); (S.refreshNow || S.refresh)(); } finally { busy(b, false); }
};
const closeMenus = () => document.querySelectorAll('.tkp details[open]').forEach((d) => d.removeAttribute('open'));

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
  const t = T(), open = t.checks.filter((c) => !c.checked), pins = openPins(t);
  const what = [open.length ? plural(open.length, 'check') + ' unticked' : '', pins.length ? plural(pins.length, 'pin') + ' still open' : ''].filter(Boolean).join(' and ');
  if (what && !(await confirmBox({ title: `Approve with ${what}?`, message: [...open.map((c) => `• ${c.title}`), ...pins.map((p) => `• Pin ${p.num}: ${p.body}`)].join('\n'), confirm: 'Approve anyway' }))) return;
  await post(`/api/tasks/${t.id}/approve`); done(`Approved. ${first(t.assignee) || 'They'}’ll hear about it.`);
});
function askChanges(prefill = '') {
  const t = T(), open = [...t.checks.filter((c) => !c.checked).map((c) => ({ title: c.title })), ...openPins(t).map((p) => ({ title: `${chainName(t, p.chain_id)}, pin ${p.num}: ${p.body}` }))];
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
actions['tk-tick'] = run(async (el) => {
  const t = T(), c = t.checks.find((x) => x.id === Number(el.dataset.id)), on = el.checked;
  if (c) { c.checked = on; c.checked_by = on ? S.me.name : null; redraw(); }
  await patch(`/api/tasks/${t.id}/checks/${el.dataset.id}`, { checked: on }); done();
});
actions['tk-delcheck'] = run(async (el) => { await del(`/api/tasks/${T().id}/checks/${el.dataset.id}`); done(); });
actions['tk-step'] = run(async (el) => {
  const t = T(); const list = (t.steps_list || []).map((x, i) => ({ id: x.id, title: x.title, done: i === Number(el.dataset.i) ? el.checked : x.done }));
  t.steps_list = list.map((x) => ({ ...x })); redraw();
  await (await import('../api.js')).put(`/api/tasks/${t.id}/steps`, { steps: list }); done();
});
actions['tk-delstep'] = run(async (el) => {
  const t = T(); const list = (t.steps_list || []).filter((_, i) => i !== Number(el.dataset.i)).map((x) => ({ id: x.id, title: x.title, done: x.done }));
  await (await import('../api.js')).put(`/api/tasks/${t.id}/steps`, { steps: list }); done();
});
actions['tk-file'] = run(async (el) => download(`/api/tasks/${T().id}/files/${el.dataset.id}`, el.dataset.name));
actions['tk-cfile'] = run(async (el) => download(el.dataset.url, el.dataset.name));
actions['tk-delfile'] = run(async (el) => { if (!(await confirmBox({ title: Number(el.dataset.v) > 1 ? 'Remove this version?' : 'Remove this file?', message: Number(el.dataset.v) > 1 ? 'Only the latest version goes. Its pins go with it; earlier versions stay.' : 'It is deleted from the task, with any pins on it.', confirm: 'Remove', danger: true }))) return; await del(`/api/tasks/${T().id}/files/${el.dataset.id}`); done('File removed'); });
actions['tk-dellink'] = run(async (el) => { await del(`/api/tasks/${T().id}/links/${el.dataset.id}`); done(); });
actions['tk-delc'] = run(async (el) => { if (!(await confirmBox({ title: 'Delete this comment?', message: 'It is removed for everyone.', confirm: 'Delete', danger: true }))) return; await del(`/api/tasks/${T().id}/comments/${el.dataset.id}`); done(); });
actions['tk-tab'] = (el) => { ui.tab = el.dataset.v; redraw(); };
actions['tk-mode'] = (el) => { ui.mode = el.dataset.v; closeMenus(); redraw(); setTimeout(() => document.getElementById('tk-c')?.focus(), 60); };
actions['tk-view'] = (el) => { ui.view = el.dataset.v; redraw(); };
actions['tk-show'] = (el) => {
  const k = el.dataset.v;
  closeMenus();
  if (k === 'estimate') return actions['tk-estimate']();
  if (k === 'count') return actions['tk-count']();
  ui.shown.add(k); redraw();
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
  done(el.dataset.v === 'step' ? 'Added as a step' : el.dataset.v === 'check' ? 'Added to the checklist' : null);
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
  openModal({ title: 'Approval for this task', submit: 'Save', body: html`<div class="field"><label class="f" for="tk-ap">Does it need approval before it’s done?</label><select id="tk-ap" name="v"><option value="" ${raw(v === '' ? 'selected' : '')}>The company setting (${S.settings.task_review_required !== false ? 'yes' : 'no'})</option><option value="1" ${raw(v === '1' ? 'selected' : '')}>Yes, ${approverName(t)} approves it</option><option value="0" ${raw(v === '0' ? 'selected' : '')}>No, the person doing it marks it done</option></select><p class="hint">Who approves is the project manager. Change the lead on the project page.</p></div>`,
    onSubmit: async (fd) => { await patch(`/api/tasks/${t.id}`, { needs_review: fd.get('v') === '' ? null : Number(fd.get('v')) }); done(); } });
};
actions['tk-delete'] = run(async () => {
  const t = T(); closeMenus();
  if (!(await confirmBox({ title: 'Delete this task?', message: 'Its comments and files are deleted too. Time already tracked is kept.', confirm: 'Delete task', danger: true }))) return;
  await del(`/api/tasks/${t.id}`); toast('Task deleted'); location.hash = '#/tasks';
});

// ---------- typing, saving, uploading ----------
const BIG = 4 * 1024 * 1024, MAX = 50 * 1024 * 1024;
async function upload(file, extra = {}) {
  const t = T();
  if (!t) return;
  if (file.size > MAX) { toast(`${file.name} is ${kb(file.size)}. Files can be at most 50 MB.`, true); return; }
  const name = file.name && file.name !== 'image.png' ? file.name : `screenshot-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.png`;
  const opts = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== ''));
  try {
    let out;
    if (file.size > BIG) {
      // big files go as they are, not as text
      toast(`Uploading ${name}…`);
      const q = new URLSearchParams({ name, mime: file.type || '', ...opts });
      const res = await fetch(`/api/tasks/${t.id}/upload?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: file });
      out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'The upload didn’t go through. Try again.');
    } else out = await post(`/api/tasks/${t.id}/files`, { name, mime: file.type || null, data_base64: await fileBase64(file), ...opts });
    if (out.version > 1 || pinnable({ mime: file.type, name })) Object.assign(ui, { sel: `c${out.chain_id}`, ver: null, page: 1, pin: null, draft: null, open: true, compare: null });
    done(out.version > 1 ? `V${out.version} added` : `${name} added`);
  } catch (err) { toast(errMsg(err), true); }
}
// a new version: say what changed, then upload
function newVersion(file, prevId) {
  const t = T(), prev = fileOf(t, prevId);
  const c = chainsOf(t).find((x) => x.id === (prev ? prev.chain_id : null));
  openModal({
    title: `New version of ${c ? c.label : 'this'}`, submit: `Upload V${c ? c.latest.version + 1 : 2}`,
    sub: `${file.name} · ${kb(file.size)}. Earlier versions and their pins stay, so you can compare.`,
    body: html`<div class="field"><label class="f" for="tk-vn">What changed? (optional)</label><textarea id="tk-vn" name="note" maxlength="1000" placeholder="New presenter from the brand kit. Kept the rest the same."></textarea><p class="hint">Shown next to the new version, and when comparing.</p></div>`,
    onSubmit: async (fd) => { await upload(file, { version_of: prevId, note: fd.get('note') || null }); },
  });
}
document.addEventListener('change', async (e) => {
  if (!e.target.closest || !e.target.closest('.tkp')) return;
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
  if (e.target.matches('[data-tk-file]') && e.target.files[0]) { const file = e.target.files[0], ver = e.target.dataset.ver; e.target.value = ''; if (ver) newVersion(file, Number(ver)); else await upload(file); return; }
  if (e.target.matches('[data-tk-team]')) { ui.mode = e.target.checked ? 'team' : 'comment'; return; }
  if (e.target.matches('[data-tk-cmp]')) { ui[e.target.dataset.tkCmp === 'a' ? 'cmpA' : 'cmpB'] = Number(e.target.value); redraw(); }
});
document.addEventListener('click', (e) => {
  // a due chip opens the date picker; menus close when you click elsewhere
  const due = e.target.closest && e.target.closest('.tkp input[type="date"]');
  if (due && due.showPicker) { try { due.showPicker(); } catch { /* not allowed here */ } }
  if (!e.target.closest || !e.target.closest('.tkp')) return;
  for (const d of document.querySelectorAll('.tkp details.tk-more[open]')) if (!d.contains(e.target) || e.target.closest('.tk-mi')) d.removeAttribute('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenus(); if (document.querySelector('.tkp') && (ui.draft || ui.pin) && !document.querySelector('#overlay > *')) { ui.draft = null; ui.pin = null; redraw(); } }
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'tk-c') { e.preventDefault(); e.target.form.requestSubmit(); }
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('tk-title')) { e.preventDefault(); e.target.blur(); }
});
document.addEventListener('focusout', (e) => {
  // the title and the description save when you leave them
  if (!e.target.closest || !e.target.closest('.tkp') || !e.target.dataset.tf || !['title', 'description'].includes(e.target.dataset.tf)) return;
  const t = T(); if (!t) return;
  const v = e.target.value;
  if ((t[e.target.dataset.tf] || '') === v) return;
  e.target.dispatchEvent(new Event('change', { bubbles: true }));
});
window.addEventListener('resize', () => { const ti = document.querySelector('.tk-title[data-tf]'); if (ti) { ti.style.height = 'auto'; ti.style.height = `${ti.scrollHeight}px`; } });
document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('tk-title')) { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }
});
document.addEventListener('paste', (e) => {
  if (!document.querySelector('.tkp') || !e.clipboardData) return;
  const file = [...e.clipboardData.files].find((f) => /^image\//.test(f.type));
  if (file) { e.preventDefault(); upload(file); }
});
document.addEventListener('dragover', (e) => { if (e.target.closest && e.target.closest('.tkp') && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!e.target.closest || !e.target.closest('.tkp') || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault(); upload(e.dataTransfer.files[0]);
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest && e.target.closest('.tkp [data-tk-form]');
  if (!form) return;
  e.preventDefault();
  const t = T(), kind = form.dataset.tkForm, fd = new FormData(form);
  const clear = () => form.querySelectorAll('input,textarea').forEach((x) => { if (x.type !== 'file') { x.value = ''; delete x.dataset.dirty; } });
  const sb = form.querySelector('button[type="submit"]');
  if (sb && sb.classList.contains('tk-busy')) return;
  const now = new Date().toISOString();
  busy(sb, true);
  try {
    if (kind === 'pin') {
      const body = String(fd.get('body') || '').trim(); if (!body || !ui.draft) return;
      // shown at once; the real pin replaces it when the server answers
      const d = ui.draft, f = fileOf(t, d.fid), num = Math.max(0, ...t.pins.filter((x) => x.chain_id === (f ? f.chain_id : 0)).map((x) => x.num)) + 1;
      t.pins.push({ id: -1, file_id: d.fid, chain_id: f ? f.chain_id : d.fid, page: d.page, x: d.x, y: d.y, num, user_id: S.me.id, user: S.me.name, body, round: t.review_rounds + 1, created_at: now, resolved: false, replies: [], pending: true });
      Object.assign(ui, { draft: null, pin: -1 }); clear(); redraw();
      const p = await post(`/api/tasks/${t.id}/pins`, { file_id: d.fid, page: d.page, x: d.x, y: d.y, body });
      t.pins = t.pins.filter((x) => x.id !== -1).concat(p); ui.pin = p.id; redraw(); done(); return;
    }
    if (kind === 'comment' && ui.replyPin) {
      const body = String(fd.get('body') || '').trim(); if (!body) return;
      const pin = pinById(ui.replyPin), pid = ui.replyPin;
      if (pin) pin.replies.push({ id: -1, user_id: S.me.id, user: S.me.name, body, created_at: now });
      ui.replyPin = null; clear(); redraw();
      await post(`/api/tasks/${t.id}/pins/${pid}/replies`, { body }); done(); return;
    }
    if (kind === 'comment') {
      const body = String(fd.get('body') || '').trim(); if (!body) return;
      const kind2 = ui.mode === 'update' ? 'update' : 'comment', team = ui.mode === 'team';
      t.comments.push({ id: -Date.now(), user_id: S.me.id, user: S.me.name, team_only: team, kind: kind2, body, created_at: now, pending: true });
      if (ui.mode === 'update') ui.mode = 'comment';
      clear(); redraw(); setTimeout(() => document.getElementById('tk-c')?.focus(), 30);
      await post(`/api/tasks/${t.id}/comments`, { body, kind: kind2, team_only: team });
      done(); return;
    }
    if (kind === 'check') { await post(`/api/tasks/${t.id}/checks`, { title: fd.get('title') }); clear(); done(); setTimeout(() => document.getElementById('tk-nc')?.focus(), 60); return; }
    if (kind === 'step') { await (await import('../api.js')).put(`/api/tasks/${t.id}/steps`, { steps: [...(t.steps_list || []).map((x) => ({ id: x.id, title: x.title, done: x.done })), { title: fd.get('title') }] }); clear(); done(); setTimeout(() => document.getElementById('tk-ns')?.focus(), 60); return; }
    if (kind === 'link') { await post(`/api/tasks/${t.id}/links`, { url: fd.get('url') }); clear(); done('Link added'); }
  } catch (err) { toast(errMsg(err), true); (S.refreshNow || S.refresh)(); } finally { busy(sb, false); }
});

// ---------- the work: pick, versions, pins, compare ----------
const pinById = (id) => T().pins.find((p) => p.id === Number(id));
actions['tk-open'] = (el) => { Object.assign(ui, { sel: el.dataset.v, ver: null, page: 1, pin: null, draft: null, open: true, compare: null, mtab: 'work' }); redraw(); setTimeout(() => document.querySelector('.tk-viewer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); };
actions['tk-close'] = () => { Object.assign(ui, { open: false, pin: null, draft: null }); redraw(); };
actions['tk-sel'] = (el) => { Object.assign(ui, { sel: el.dataset.v, ver: null, page: 1, pin: null, draft: null }); redraw(); };
actions['tk-ver'] = (el) => { Object.assign(ui, { ver: Number(el.dataset.id), pin: null, draft: null }); redraw(); };
actions['tk-page'] = (el) => { ui.page = Math.max(1, ui.page + Number(el.dataset.v)); Object.assign(ui, { pin: null, draft: null }); redraw(); };
actions['tk-compare'] = (el) => { Object.assign(ui, { compare: Number(el.dataset.v), cmpA: null, cmpB: null, pin: null, draft: null, cut: 50 }); redraw(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
actions['tk-uncompare'] = () => { ui.compare = null; redraw(); };
actions['tk-cmode'] = (el) => { ui.cmode = el.dataset.v; redraw(); };
actions['tk-mtab'] = (el) => { ui.mtab = el.dataset.v; redraw(); window.scrollTo({ top: 0 }); };
actions['tk-pinat'] = (el, e) => {
  const b = el.getBoundingClientRect();
  if (!b.width || !b.height) return;
  const x = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
  ui.pin = null; ui.draft = { fid: Number(el.dataset.fid), page: Number(el.dataset.page) || 1, x, y };
  redraw();
};
actions['tk-undraft'] = () => { ui.draft = null; redraw(); };
actions['tk-pinsel'] = (el) => { const id = Number(el.dataset.id); ui.pin = id && ui.pin !== id ? id : null; ui.draft = null; redraw(); };
// show a pin wherever it is: its piece of work, its version, its page
actions['tk-goto'] = (el) => {
  const p = pinById(el.dataset.id); if (!p) return;
  Object.assign(ui, { sel: `c${p.chain_id}`, ver: p.file_id, page: p.page, pin: p.id, draft: null, compare: null, open: true, mtab: 'work' });
  redraw();
  setTimeout(() => (document.querySelector('.tk-mark.tk-on') || document.querySelector('.tk-viewer'))?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
};
actions['tk-reply'] = (el) => {
  const id = Number(el.dataset.id);
  ui.replyPin = id || null;
  if (id && matchMedia('(max-width: 760px)').matches) ui.mtab = 'talk';
  redraw();
  if (id) setTimeout(() => document.getElementById('tk-c')?.focus(), 80);
};
actions['tk-resolve'] = run(async (el) => {
  const mine = pinById(el.dataset.id);
  if (mine) { mine.resolved = el.dataset.v === '1'; redraw(); }
  const p = await patch(`/api/tasks/${T().id}/pins/${el.dataset.id}`, { resolved: el.dataset.v === '1' });
  done(p.resolved ? `Pin ${p.num} marked fixed` : `Pin ${p.num} reopened`);
});
actions['tk-delpin'] = run(async (el) => {
  const p = pinById(el.dataset.id);
  if (!(await confirmBox({ title: `Remove pin ${p.num}?`, message: 'Its replies go too.', confirm: 'Remove', danger: true }))) return;
  await del(`/api/tasks/${T().id}/pins/${p.id}`); ui.pin = null; done('Pin removed');
});
actions['tk-rename'] = (el) => {
  const t = T(), f = fileOf(t, Number(el.dataset.id)), c = chainsOf(t).find((x) => x.id === f.chain_id);
  openModal({ title: 'Rename', submit: 'Save', body: html`<div class="field"><label class="f" for="tk-rn">Name</label><input id="tk-rn" name="label" maxlength="80" value="${c.label}" placeholder="Static 1" required><p class="hint">Every version takes this name.</p></div>`,
    onSubmit: async (fd) => { await patch(`/api/tasks/${t.id}/files/${f.id}`, { label: fd.get('label') }); done(); } });
};

// ---------- a count ----------
actions['tk-count'] = () => {
  const t = T(), c = t.count;
  openModal({
    title: c ? 'Change the count' : 'Add a count', submit: 'Save', sub: 'For work measured in numbers: calls made, posts written, pages checked.',
    body: html`<div class="field"><label class="f" for="tk-ct">How many</label><input id="tk-ct" name="target" type="number" min="1" max="1000000" required value="${c ? c.target : ''}" placeholder="20"></div>
      <div class="field"><label class="f" for="tk-cu">Of what (optional)</label><input id="tk-cu" name="unit" maxlength="40" value="${c && c.unit ? c.unit : ''}" placeholder="called"><p class="hint">Reads as “12 of 20 called”.</p></div>
      ${c ? html`<button type="button" class="linkbtn small" data-act="tk-uncount">Remove the count</button>` : ''}`,
    onSubmit: async (fd) => { await post(`/api/tasks/${t.id}/progress`, { count_target: Number(fd.get('target')), count_unit: fd.get('unit') || null }); done(); },
  });
};
actions['tk-uncount'] = run(async () => { [...document.querySelectorAll('#overlay [data-close]')].pop()?.click(); await post(`/api/tasks/${T().id}/progress`, { count_target: null }); done('Count removed'); });
let bumpT = null, bumpTo = null;
actions['tk-bump'] = (el) => {
  // quick taps add up and are sent once
  const t = T(); if (!t.count) return;
  bumpTo = Math.max(0, (bumpTo ?? t.count.done) + Number(el.dataset.v));
  t.count.done = bumpTo; redraw();
  clearTimeout(bumpT);
  bumpT = setTimeout(async () => { const v = bumpTo; bumpTo = null; try { await post(`/api/tasks/${t.id}/progress`, { count_done: v }); done(); } catch (err) { toast(errMsg(err), true); done(); } }, 500);
};
document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('[data-tk-cut]')) { ui.cut = Number(e.target.value); const s = e.target.closest('.tk-cmp')?.querySelector('.tk-slider'); if (s) s.style.setProperty('--cut', `${ui.cut}%`); }
});
document.addEventListener('focusout', async (e) => {
  if (!e.target.matches || !e.target.matches('[data-tko]')) return;
  const t = T(); if (!t || (t.outcome || '') === e.target.value) return;
  try { await post(`/api/tasks/${t.id}/progress`, { outcome: e.target.value }); delete e.target.dataset.dirty; done('Saved'); } catch (err) { toast(errMsg(err), true); }
});

// ---------- PDF pages, drawn with pdf.js ----------
let pdfLibP = null;
const pdfLib = () => (pdfLibP ||= new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = '/vendor/pdf/pdf.min.js'; sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf/pdf.worker.min.js'; res(window.pdfjsLib); }; sc.onerror = () => { pdfLibP = null; rej(new Error('Could not load the PDF viewer')); }; document.head.appendChild(sc); }));
async function pdfPage(fid, page) {
  const tid = T().id;
  if (!pdfDocs.has(fid)) pdfDocs.set(fid, (async () => { const L = await pdfLib(); return L.getDocument({ data: new Uint8Array(await fileBytes(`/api/tasks/${tid}/files/${fid}`)), isEvalSupported: false }).promise; })().catch((e) => { pdfDocs.delete(fid); throw e; }));
  const doc = await pdfDocs.get(fid);
  pdfPages.set(fid, doc.numPages);
  const pg = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
  const base = pg.getViewport({ scale: 1 });
  const vp = pg.getViewport({ scale: Math.min(2.5, 1800 / base.width) });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: g, viewport: vp }).promise;
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return URL.createObjectURL(blob);
}

actions['tk-moredet'] = () => { ui.more = !ui.more; redraw(); };

actions['tk-saveasset'] = run(async (el) => {
  const t = T();
  const a = await post(`/api/tasks/${t.id}/save-asset`, el.dataset.file ? { file_id: Number(el.dataset.file) } : { link_id: Number(el.dataset.link) });
  if (t.assets) { if (el.dataset.file) t.assets.files.push(Number(el.dataset.file)); else t.assets.urls.push(a.url); redraw(); }
  done(`Saved to ${t.assets ? t.assets.name : 'the client'}’s assets`);
});
actions['tk-unsave'] = run(async () => {
  const t = T();
  if (!(await confirmBox({ title: 'Take these out of the assets?', message: 'The files stay on this task.', confirm: 'Take them out' }))) return;
  for (const x of t.assets.saved) await del(`/api/assets/${x.id}`);
  done('Taken out of the assets');
});
