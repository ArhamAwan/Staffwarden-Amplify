// Transparency, in the web app:
//  - notesPanel: on a person's day, what they explained (a late start, idle stretches, the day) and the
//    time they asked to have added. The person writes; managers read, and approve or decline requests.
//  - teamNow: the whole team's status right now, on an employee's dashboard.
//  - changesPanel / agreedPanel: on the profile, every change made to their tracking, schedule or time,
//    and what changed since they last agreed to the tracking policy.
import { html, raw, esc, dur, tod, fmtMin, relTime, dayShort, plural, initials, avColor, rel, icon, nowMs, zoneShort, todayIn } from '../util.js';
import { get, post, put, del } from '../api.js';
import { S, actions, tag, empty, openModal, confirmBox, toast, errMsg, findPeople, findBox, longList, noMatch } from '../ui.js';

// ---------------- a person's day ----------------
const KIND_WORDS = { late: 'Late start', idle: 'Idle', shot: 'Screenshot', day: 'This day' };
const STATUS = { pending: ['pending', 'Waiting for a manager'], approved: ['present', 'Approved'], declined: ['late', 'Declined'], cancelled: ['offline', 'Cancelled'] };

// The day as the person sees it: d is /api/users/:id/day. `mine`: they can write; otherwise read only.
export function notesPanel(d, { isMgr, today }) {
  const tz = d.user.tz_offset_min, mine = !!d.mine, att = d.attendance || {};
  const noteFor = (kind, ref) => d.notes.find((n) => n.kind === kind && n.ref === String(ref));
  const items = [];
  if (att.late_by_min > 0) items.push({ kind: 'late', ref: d.day, title: `Started ${att.late_by_min} min after the shift start`, when: d.first_start ? tod(d.first_start, tz) : '' });
  for (const i of d.idles || []) {
    const secs = Math.round(((i.ended_at ? Date.parse(i.ended_at) : Date.now()) - Date.parse(i.started_at)) / 1000);
    items.push({ kind: 'idle', ref: i.id, title: `Idle for ${dur(secs)}`, when: `${tod(i.started_at, tz)} to ${i.ended_at ? tod(i.ended_at, tz) : 'now'}` });
  }
  for (const n of d.notes.filter((x) => x.kind === 'shot')) { const sh = (d.shots_list || []).find((x) => String(x.id) === n.ref); items.push({ kind: 'shot', ref: n.ref, title: sh ? `Screenshot at ${tod(sh.taken_at, tz)}` : 'A screenshot', when: '' }); }
  const row = (it) => {
    const n = noteFor(it.kind, it.ref);
    return html`<li class="ex-item${n ? ' has' : ''}" data-k="x${it.kind}${it.ref}">
      <div class="ex-what"><span class="ex-kind">${KIND_WORDS[it.kind]}</span><b>${it.title}</b>${it.when ? html`<span class="muted small num">${it.when}</span>` : ''}</div>
      <div class="ex-note">${n ? html`<p>${n.text}</p><span class="faint small">${mine ? 'You wrote this' : `${d.user.name} wrote this`} ${relTime(n.updated_at)}</span>` : html`<span class="faint small">${mine ? 'No note yet' : 'No note'}</span>`}</div>
      ${mine ? html`<button class="btn sm" data-act="ex-note" data-kind="${it.kind}" data-ref="${it.ref}" data-day="${d.day}" data-title="${it.title}">${n ? 'Edit' : 'Explain'}</button>` : ''}
    </li>`;
  };
  const dayNote = noteFor('day', d.day);
  const reqs = d.requests || [];
  const canAsk = mine && d.day <= today;
  return html`<section class="panel ex" id="explain"><header><h2>${mine ? 'Explain your day' : `${d.user.name}'s notes`}</h2>
      <span class="muted small">${mine ? 'Your manager sees these next to your time. Only you can write them.' : 'Written by them. You are told when they add one.'}</span></header>
    <div class="body">
      <div class="ex-day${dayNote ? ' has' : ''}">
        <div class="ex-day-t">${dayNote ? html`<p>${dayNote.text}</p><span class="faint small">${mine ? 'Your note about this day' : 'Their note about this day'} · ${relTime(dayNote.updated_at)}</span>`
          : html`<p class="muted">${mine ? 'Anything your manager should know about this day? A power cut, an outage, an errand on the clock.' : 'No note about this day.'}</p>`}</div>
        ${mine ? html`<button class="btn sm" data-act="ex-note" data-kind="day" data-ref="${d.day}" data-day="${d.day}" data-title="this day">${dayNote ? 'Edit note' : 'Add a note'}</button>` : ''}
      </div>
      ${items.length ? html`<ul class="ex-list">${items.map(row)}</ul>` : ''}
      <div class="ex-req">
        <div class="ex-req-h"><h3>${mine ? 'Time you asked to add' : 'Time they asked to add'}</h3>${canAsk ? html`<button class="btn sm" data-act="ex-ask" data-day="${d.day}" data-tz="${tz}" data-ds="${d.user.day_start_min || 0}">Ask to add time</button>` : ''}</div>
        ${reqs.length ? html`<ul class="ex-reqs">${reqs.map((r) => html`<li data-k="r${r.id}">
          <div><b class="num">${tod(r.start_at, tz)} to ${tod(r.end_at, tz)}</b> <span class="muted small">${dur((Date.parse(r.end_at) - Date.parse(r.start_at)) / 1000)}${r.project ? ' · ' + r.project : ''}</span>
            <p class="small">${r.reason}</p>
            ${r.decision_note || r.decided_by ? html`<p class="small muted">${r.decided_by ? r.decided_by + ': ' : ''}${r.decision_note || ''}</p>` : ''}</div>
          <div class="ex-req-a">${tag(...STATUS[r.status])}
            ${r.status === 'pending' && mine ? html`<button class="btn sm" data-act="ex-cancel" data-id="${r.id}">Cancel</button>` : ''}
            ${r.status === 'pending' && isMgr && !mine ? html`<button class="btn sm primary" data-act="ex-decide" data-id="${r.id}" data-ok="1">Approve</button><button class="btn sm" data-act="ex-decide" data-id="${r.id}" data-ok="0">Decline</button>` : ''}</div>
        </li>`)}</ul>` : html`<p class="muted small">${mine ? 'Forgot to start the timer? Ask for the time to be added. A manager approves it, and you are told.' : 'None for this day.'}</p>`}
      </div>
    </div></section>`;
}

actions['ex-note'] = (el) => {
  const { kind, ref, day, title } = el.dataset;
  const cur = (S.dayNotes || []).find((n) => n.kind === kind && n.ref === String(ref));
  openModal({
    title: kind === 'day' ? 'A note about this day' : `Explain: ${title}`,
    sub: 'Your manager sees this next to your time.',
    submit: 'Save note',
    body: html`<div class="field"><label class="f" for="ex-t">Your note</label><textarea id="ex-t" name="text" rows="4" maxlength="500" required>${cur ? cur.text : ''}</textarea><p class="hint">Up to 500 characters.</p></div>
      ${cur ? html`<button type="button" class="btn sm danger" data-act="ex-del" data-id="${cur.id}">Delete this note</button>` : ''}`,
    onSubmit: async (fd) => {
      const text = String(fd.get('text') || '').trim();
      if (!text) throw new Error('Write a note first');
      await put('/api/notes', { kind, ref: kind === 'idle' || kind === 'shot' ? Number(ref) : ref, day, text });
      toast('Note saved'); S.refresh();
    },
  });
};
actions['ex-del'] = async (el) => {
  if (!(await confirmBox({ title: 'Delete this note?', message: 'Your manager will no longer see it.', confirm: 'Delete', danger: true }))) return;
  try { await del(`/api/notes/${el.dataset.id}`); document.querySelectorAll('#overlay .scrim').forEach((s) => s.remove()); toast('Note deleted'); S.refresh(); }
  catch (e) { toast(errMsg(e), true); }
};

// A clock time on this work day (which may run past midnight) as an instant.
function instantOn(day, hhmm, tz, ds) {
  const [h, m] = hhmm.split(':').map(Number);
  const midnight = Date.UTC(...day.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) - tz * 60000;
  return midnight + (ds + rel(h * 60 + m, ds)) * 60000;
}
actions['ex-ask'] = async (el) => {
  const { day } = el.dataset, tz = Number(el.dataset.tz), ds = Number(el.dataset.ds);
  let projects = [];
  try { projects = (await get('/api/projects')).filter((p) => !p.archived); } catch { /* optional */ }
  openModal({
    title: 'Ask to add time', sub: `${dayShort(day)}. A manager approves it, and you are told either way.`, submit: 'Send request',
    body: html`<div class="grid2"><div class="field"><label class="f" for="ra-s">From</label><input id="ra-s" type="time" name="start" required></div>
        <div class="field"><label class="f" for="ra-e">To</label><input id="ra-e" type="time" name="end" required></div></div>
      ${projects.length ? html`<div class="field"><label class="f" for="ra-p">Project (optional)</label><select id="ra-p" name="project_id"><option value="">No project</option>${projects.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>` : ''}
      <div class="field"><label class="f" for="ra-r">What were you working on?</label><textarea id="ra-r" name="reason" rows="3" maxlength="500" required></textarea><p class="hint">For example: "Forgot to start the timer after the team call."</p></div>`,
    onSubmit: async (fd) => {
      const s = fd.get('start'), e = fd.get('end'), reason = String(fd.get('reason') || '').trim();
      if (!s || !e) throw new Error('Give a start and an end time');
      if (!reason) throw new Error('Say what you were working on');
      const a = instantOn(day, s, tz, ds), b = instantOn(day, e, tz, ds);
      if (b <= a) throw new Error('The end must be after the start (on this work day)');
      await post('/api/time-requests', { start: new Date(a).toISOString(), end: new Date(b).toISOString(), reason, project_id: fd.get('project_id') || null });
      toast('Request sent'); S.refresh();
    },
  });
};
actions['ex-cancel'] = async (el) => {
  if (!(await confirmBox({ title: 'Cancel this request?', message: 'It is withdrawn and no time is added.', confirm: 'Cancel request', danger: true, cancel: 'Keep it' }))) return;
  try { await del(`/api/time-requests/${el.dataset.id}`); toast('Request cancelled'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['ex-decide'] = (el) => {
  const approve = el.dataset.ok === '1';
  openModal({
    title: approve ? 'Approve this time?' : 'Decline this time?', submit: approve ? 'Approve and add the time' : 'Decline', danger: !approve,
    sub: approve ? 'The time is added to their day and they are told.' : 'They are told, with your reason.',
    body: html`<div class="field"><label class="f" for="rd-n">${approve ? 'A note for them (optional)' : 'Why? (they see this)'}</label><textarea id="rd-n" name="note" rows="3" maxlength="500" ${approve ? '' : raw('required')}></textarea></div>`,
    onSubmit: async (fd) => {
      const note = String(fd.get('note') || '').trim();
      if (!approve && !note) throw new Error('Say why, so they know what to do');
      await post(`/api/time-requests/${el.dataset.id}/decide`, { approve, note: note || null });
      toast(approve ? 'Approved. The time was added.' : 'Declined'); S.refresh();
    },
  });
};

// ---------------- the team, right now (employee dashboard) ----------------
const GROUP = [
  ['working', 'Working', 'working'], ['break', 'On a break', 'break'], ['idle', 'Idle', 'idle'], ['no_signal', 'No signal', 'no_signal'],
  ['not_started', 'Not started', 'late'], ['upcoming', 'Starts later', 'offline'], ['done', 'Signed off', 'offline'], ['leave', 'On leave', 'leave'], ['off', 'Not working today', 'offline'],
];
function groupOf(m) {
  if (['working', 'break', 'idle', 'no_signal'].includes(m.state)) return m.state;
  const a = m.attendance;
  if (a === 'present' || a === 'late') return 'done';
  if (a === 'not_started' || a === 'absent') return 'not_started';
  if (a === 'upcoming') return 'upcoming';
  if (a === 'leave' || a === 'holiday') return 'leave';
  return 'off';
}
// Story rings: everyone as a round avatar whose ring says what they are doing (a spinning green ring
// while working, amber on a break, dashed grey not started...). Click or tap one for their details.
const RING = { working: 'working', break: 'break', idle: 'idle', no_signal: 'no_signal', not_started: 'not_started', upcoming: 'not_started', done: 'done', leave: 'leave', off: 'done' };
const PILL = { break: 'Break', idle: 'Idle', no_signal: 'No signal', leave: 'Leave' };
const ORDER = ['working', 'break', 'idle', 'no_signal', 'not_started', 'upcoming', 'done', 'leave', 'off'];
// The name people go by: "Syed Sikandar Ali Naqvi" is Sikandar, "Muhammad Waseem Abbas" is Waseem.
const PREFIX = /^(muhammad|mohammad|mohammed|muhammed|mohd|md|m\.?|syed|sayed|sayyed|mian|ch\.?|chaudhry|hafiz|haji|rana|malik|mirza|sheikh|shaikh)$/i;
const firstName = (n) => { const w = String(n || '').trim().split(/\s+/); const i = w.findIndex((x, k) => k < w.length - 1 ? !PREFIX.test(x) : true); return w[Math.max(0, i)] || n; };
function subLine(m, g) {
  if (g === 'not_started') return 'Not started';
  if (g === 'upcoming') return 'Starts later';
  if (g === 'leave') return 'On leave';
  if (g === 'off') return 'Day off';
  return m.worked_secs ? dur(m.worked_secs) : (g === 'done' ? 'Signed off' : 'Just started');
}
let storyData = new Map();
export function teamNow(t) {
  if (!t || t.visible === 'off') return '';
  const list = t.members;
  if (list.length < 2) return '';
  storyData = new Map(list.map((m) => [m.user_id, m]));
  const sorted = [...list].sort((a, b) => (b.me - a.me) || ORDER.indexOf(groupOf(a)) - ORDER.indexOf(groupOf(b)) || (b.worked_secs - a.worked_secs) || a.name.localeCompare(b.name));
  const count = (g) => list.filter((m) => groupOf(m) === g).length;
  const chips = [['working', 'Working', 'working'], ['break', 'On a break', 'break'], ['idle', 'Idle', 'idle'], ['no_signal', 'No signal', 'no_signal'], ['not_started', 'Not started', 'late'], ['leave', 'On leave', 'leave']]
    .filter(([g], i) => i < 2 || count(g));
  return html`<section class="panel stories" aria-label="${t.visible === 'team' ? 'Your team right now' : 'Everyone right now'}">
    <header><div class="sto-h"><h2>${t.visible === 'team' ? 'Your team right now' : 'Everyone right now'}</h2><span class="muted small">Status and hours today. Never screenshots or activity.</span></div>
      <div class="sto-sum">${chips.map(([g, label, dot]) => html`<span><i class="sw s-${dot}"></i><b class="num">${count(g)}</b> ${label}</span>`)}</div></header>
    <div class="sto-row" role="list">${sorted.map((m) => {
      const g = groupOf(m), ring = RING[g];
      return html`<div role="listitem" class="sto-i" data-k="st${m.user_id}"><button type="button" class="sto${LIVE.has(g) ? '' : ' away'}" data-act="story" data-id="${m.user_id}" aria-haspopup="dialog" aria-label="${m.name}: ${g === 'working' ? 'working' : subLine(m, g)}${m.worked_secs ? ', ' + dur(m.worked_secs) + ' today' : ''}">
        <span class="sto-ring r-${ring}"><span class="sto-av" style="background:${avColor(m.user_id)}">${initials(m.name)}</span>
          ${g === 'working' && m.since ? html`<span class="sto-pill p-working"><i aria-hidden="true"></i><span class="num" data-since="${m.since}" data-hm="1"></span></span>` : PILL[g] ? html`<span class="sto-pill p-${g}">${PILL[g]}</span>` : ''}</span>
        <span class="sto-n${m.me ? ' me' : ''}">${m.me ? 'You' : firstName(m.name)}</span>
        <span class="sto-s">${subLine(m, g)}</span>
      </button></div>`;
    })}</div></section>`;
}

// The details card: next to the ring on a computer, a sheet from the bottom on a phone.
let storyCard = null;
function closeStory() {
  if (!storyCard) return;
  const c = storyCard; storyCard = null;
  clearInterval(c._tick); window.removeEventListener('resize', c._place); window.removeEventListener('scroll', c._place, true);
  document.removeEventListener('pointerdown', c._outside, true); document.removeEventListener('keydown', c._key, true);
  c.classList.add('out');
  setTimeout(() => { c.remove(); if (c._back) c._back.remove(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  if (c._opener && document.contains(c._opener)) c._opener.focus({ preventScroll: true });
}
const STATE = {
  working: ['Working for', 'working'], break: ['On a break for', 'break'], idle: ['Idle for', 'idle'], no_signal: ['No signal since', 'late'],
  not_started: ['Not started yet', 'late'], upcoming: ['Their shift starts later', 'offline'], done: ['Signed off', 'offline'], leave: ['On leave today', 'leave'], off: ['Not working today', 'offline'],
};
// someone whose clock is not the viewer's: their card says what time it is for them
const myTz = () => (S.me.tz_offset_min ?? S.settings.tz_offset_min);
const otherZone = (m) => m.tz_offset_min != null && m.tz_offset_min !== myTz();
// working, on a break or idle: the timer is running. Everyone else is shown muted.
const LIVE = new Set(['working', 'break', 'idle', 'no_signal']);
actions.story = (el) => {
  const id = Number(el.dataset.id), m = storyData.get(id);
  if (!m) return;
  const again = storyCard && storyCard._id === id;
  closeStory();
  if (again) return;
  const g = groupOf(m), [label, tone] = STATE[g];
  const live = ['working', 'break', 'idle'].includes(g) && m.since;
  const value = live ? '' : g === 'no_signal' && m.since ? tod(m.since, m.tz_offset_min ?? 0) : '';
  const card = document.createElement('div');
  card.className = 'sto-card';
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', m.name);
  card.innerHTML = `<span class="sto-arrow" aria-hidden="true"></span><span class="sto-grip" aria-hidden="true"></span>
    <div class="sto-who"><span class="sto-ring sm r-${RING[g]}"><span class="sto-av" style="background:${avColor(m.user_id)}">${esc(initials(m.name))}</span></span>
      <div><b>${esc(m.name)}${m.me ? ' <span class="tn-you">You</span>' : ''}</b><span>${esc(m.title || (m.team ? m.team : ''))}</span></div>
      <button type="button" class="btn icon sm sto-x" aria-label="Close">${icon('x').toString()}</button></div>
    <div class="sto-stats"><div class="t-${tone}"><span>${esc(label)}</span>${live ? `<b class="num" data-since="${esc(m.since)}"></b>` : value ? `<b class="num">${esc(value)}</b>` : ''}</div>
      <div><span>Today</span><b class="num">${esc(m.worked_secs ? dur(m.worked_secs) : '0m')}</b></div></div>
    ${otherZone(m) ? `<div class="sto-tz">${icon('clock').toString()}<span>It's <b class="num" data-local="${m.tz_offset_min}"></b> for ${m.me ? 'you' : 'them'}${m.tz_name ? ` in ${esc(zoneShort(m.tz_name))}` : ''}</span></div>` : ''}
    <p>Everyone sees status and hours today. Never screenshots or activity.</p>`;
  const phone = matchMedia('(max-width: 600px)').matches;
  if (phone) { const back = document.createElement('div'); back.className = 'sto-back'; document.body.appendChild(back); card._back = back; card.classList.add('sheet'); }
  document.body.appendChild(card);
  card._id = id; card._opener = el;
  const tick = () => {
    for (const x of card.querySelectorAll('[data-since]')) { const s = (nowMs() - Date.parse(x.dataset.since)) / 1000; x.textContent = clockText(s); }
    for (const x of card.querySelectorAll('[data-local]')) x.textContent = tod(new Date(nowMs()).toISOString(), Number(x.dataset.local));
  };
  tick(); card._tick = setInterval(tick, 1000);
  card._place = () => {
    if (phone) return;
    const r = el.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
    let left = Math.min(Math.max(12, r.left + r.width / 2 - 46), innerWidth - w - 12);
    let top = r.bottom + 12;
    const above = top + h > innerHeight - 12 && r.top - h - 12 > 12;
    if (above) top = r.top - h - 12;
    card.style.left = `${left}px`; card.style.top = `${top}px`;
    card.classList.toggle('above', above);
    card.style.setProperty('--ax', `${Math.min(w - 24, Math.max(16, r.left + r.width / 2 - left - 6))}px`);
    if (r.bottom < 0 || r.top > innerHeight) closeStory();
  };
  card._place();
  window.addEventListener('resize', card._place); window.addEventListener('scroll', card._place, true);
  card._outside = (e) => { if (!card.contains(e.target) && !e.target.closest('[data-act="story"]')) closeStory(); };
  card._key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeStory(); } };
  document.addEventListener('pointerdown', card._outside, true); document.addEventListener('keydown', card._key, true);
  card.querySelector('.sto-x').addEventListener('click', closeStory);
  storyCard = card;
  card.querySelector('.sto-x').focus({ preventScroll: true });
};
window.addEventListener('hashchange', closeStory);
const clockText = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };

// ---------------- the profile ----------------
const AREA = { tracking: 'What is captured', schedule: 'Schedule', time: 'Your time', screenshots: 'Screenshots' };
export function changesPanel(list) {
  return html`<section class="panel" id="changes"><header><h2>Changes made for you</h2><span class="muted small">Every change to your tracking, schedule or time, and who made it. You are told each time.</span></header>
    <div class="body">${list.length ? html`<ol class="chg">${list.map((c) => html`<li data-k="c${c.id}">
      <div class="chg-h"><span class="ex-kind">${AREA[c.area] || 'Change'}</span><b>${c.title}</b><span class="faint small">${relTime(c.created_at)}${c.by ? ' · by ' + c.by : ''}</span></div>
      ${c.lines.length ? html`<ul>${c.lines.map((l) => html`<li>${l}</li>`)}</ul>` : ''}
      ${c.reason ? html`<p class="small"><span class="muted">Reason:</span> ${c.reason}</p>` : ''}</li>`)}</ol>`
      : empty('Nothing has been changed yet', 'If anyone changes your schedule, what is captured, or your time, it shows here and you get a notification.')}</div></section>`;
}
export function agreedPanel(me) {
  const pc = me.policy_changes || { news: [], settings: [] };
  if (!pc.news.length && !pc.settings.length) return '';
  return html`<section class="panel agreed${pc.reaccept ? ' must' : ''}" id="agreed"><header><h2>What changed since you agreed</h2>${pc.reaccept ? tag('pending', 'Needs your agreement') : ''}</header>
    <div class="body">
      ${pc.news.length ? html`<ul class="chg-news">${pc.news.map((t) => html`<li>${t}</li>`)}</ul>` : ''}
      ${pc.settings.length ? html`<table class="t chg-t"><thead><tr><th>Setting</th><th>When you agreed</th><th>Now</th></tr></thead><tbody>${pc.settings.map((l) => html`<tr data-k="s${l.key}"><td>${l.label}${l.more ? html` <span class="more">captures more</span>` : ''}</td><td class="muted">${l.from}</td><td><b>${l.to}</b></td></tr>`)}</tbody></table>` : ''}
      <div class="agreed-a"><p class="small muted">${pc.reaccept ? 'More is captured or shared than when you agreed, so your timer cannot start until you agree again. You can do it here or in the desktop app.' : 'Less is captured than before, so nothing is needed from you.'}</p>
        <button class="btn ${pc.reaccept ? 'primary' : ''}" data-act="agree-now">${pc.reaccept ? 'I have read this and I agree' : 'Got it'}</button></div>
    </div></section>`;
}
actions['agree-now'] = async () => {
  try { await post('/api/me/consent'); S.me = await get('/api/me'); toast('Thanks. You are up to date.'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};

// ---------------- managers: every request to add missing time ----------------
// why people ask, sorted into a few plain reasons by the words they used
const WHY = [['Forgot to start after a break', /forg|break|lunch|prayer|namaz/i], ['Power cut or internet down', /power|electric|internet|wifi|wi-fi|connection|network|load ?shed/i], ['App or laptop restarted', /app|laptop|computer|crash|restart|update|froze|frozen|battery/i]];
const whyOf = (t) => (WHY.find(([, re]) => re.test(t || '')) || ['Other'])[0];
function askBento(list, pending) {
  const secs = (r) => Math.max(0, (Date.parse(r.end_at) - Date.parse(r.start_at)) / 1000);
  const month = (S.settings && todayIn(S.settings.tz_offset_min || 0).slice(0, 7)) || '';
  const decided = list.filter((r) => r.status !== 'pending' && String(r.decided_at || r.created_at).slice(0, 7) === month);
  const ok = decided.filter((r) => r.status === 'approved'), no = decided.filter((r) => r.status !== 'approved');
  const recent = list.filter((r) => nowMs() - Date.parse(r.created_at) < 30 * 86400000);
  const why = [...WHY.map(([n]) => n), 'Other'].map((n) => [n, recent.filter((r) => whyOf(r.reason) === n).length]).filter(([, c]) => c).sort((a, b) => b[1] - a[1]);
  const wmax = Math.max(1, ...why.map(([, c]) => c));
  const per = new Map(); for (const r of recent) { const x = per.get(r.user_id) || { id: r.user_id, name: r.user_name, secs: 0 }; x.secs += secs(r); per.set(r.user_id, x); }
  const people = [...per.values()].sort((a, b) => b.secs - a.secs).slice(0, 4);
  const face = (id, name) => html`<span class="avatar sm" style="background:${avColor(id)}" title="${name}">${initials(name)}</span>`;
  return html`<section class="kpis bento rq-bento" aria-label="Missing time at a glance">
    <div class="kpi bt-w ${pending.length ? 'warn' : 'good'}"><div class="l">${icon('bell')}Waiting</div><div class="v">${pending.length}</div>
      ${pending.length ? html`<span class="stack bt-faces">${pending.slice(0, 6).map((r) => face(r.user_id, r.user_name))}</span>` : ''}
      <div class="f">${pending.length ? `${dur(pending.reduce((n, r) => n + secs(r), 0))} asked in total` : 'All caught up'}</div></div>
    <div class="kpi bt-ok ${ok.length ? 'good' : ''}"><div class="l">${icon('check')}Approved this month</div><div class="v">${dur(ok.reduce((n, r) => n + secs(r), 0))}</div><div class="f">${plural(ok.length, 'request')}</div></div>
    <div class="kpi bt-no"><div class="l">${icon('alert')}Declined</div><div class="v">${no.length}</div><div class="f">This month</div></div>
    <div class="kpi bt-why"><div class="l">${icon('help')}Why people asked<span class="bt-r">30 days</span></div>
      ${why.length ? html`<ul class="rq-why">${why.map(([n, c], i) => html`<li><span><b>${n}</b><span class="num">${c}</span></span><span class="meter ${['', 'warn', 'good', ''][i] || ''}"><i style="width:${Math.round((100 * c) / wmax)}%"></i></span></li>`)}</ul>`
        : html`<div class="bt-noshot">${icon('check')}<span>Nobody has asked for missing time in the last 30 days.</span></div>`}</div>
    <div class="kpi bt-by"><div class="l">${icon('users')}By person, 30 days</div>
      ${people.length ? html`<ul class="at-who">${people.map((p) => html`<li>${face(p.id, p.name)}<span><b>${p.name.split(' ')[0]}</b></span><b class="num">${dur(p.secs)}</b></li>`)}</ul>` : html`<div class="f">Nobody yet</div>`}</div>
  </section>
  <p class="rq-note small muted">${icon('help')}Approved time counts as work but has no screenshots or activity, and is marked “added by request” on their day.</p>`;
}

export const requestsPage = {
  title: 'Missing time',
  async load(q) { return get('/api/time-requests'); },
  render(list, q) {
    const pending = list.filter((r) => r.status === 'pending'), allDone = findPeople(list.filter((r) => r.status !== 'pending'), q), done = longList(allDone, q);
    const tzOf = (r) => ((S.people || []).find((p) => p.id === r.user_id) || {}).tz_offset_min ?? S.settings.tz_offset_min;
    const row = (r) => html`<li data-k="q${r.id}">
      <div class="rq-who"><span class="avatar" style="background:${avColor(r.user_id)}">${initials(r.user_name)}</span><span><b>${r.user_name}</b><span class="small muted">${dayShort(r.day)} · asked ${relTime(r.created_at)}</span></span></div>
      <div class="rq-what"><b class="num">${tod(r.start_at, tzOf(r))} to ${tod(r.end_at, tzOf(r))}</b> <span class="muted small">${dur((Date.parse(r.end_at) - Date.parse(r.start_at)) / 1000)}${r.project ? ' · ' + r.project : ''}</span><p class="small">${r.reason}</p>
        ${r.decided_by ? html`<p class="small muted">${r.decided_by}${r.decision_note ? ': ' + r.decision_note : ''}</p>` : ''}</div>
      <div class="rq-a">${r.status === 'pending' ? (r.user_id === S.me.id && S.me.role !== 'owner' ? html`<span class="faint small">Another manager decides your own</span>` : html`<button class="btn sm primary" data-act="ex-decide" data-id="${r.id}" data-ok="1">Approve</button><button class="btn sm" data-act="ex-decide" data-id="${r.id}" data-ok="0">Decline</button>`) : tag(...STATUS[r.status])}
        <a class="btn sm" href="#/timeline?user=${r.user_id}&day=${r.day}">Their day</a></div></li>`;
    return html`<div class="page-h"><div><h1>Missing time</h1><p class="sub">Time people asked to have added because the timer was not running. Approving adds it to their day; they are told either way.</p></div></div>
      ${askBento(list, pending)}
      <section class="panel flush"><header><h2>Waiting for a decision</h2><span class="muted small">${plural(pending.length, 'request')}</span></header>
        <div class="body">${pending.length ? html`<ul class="rq">${pending.map(row)}</ul>` : empty('All caught up', 'When someone asks for missing time, it shows here and you get a notification.')}</div></section>
      ${list.some((r) => r.status !== 'pending') ? html`<section class="panel flush"><header><h2>Decided</h2><span class="muted small">${plural(allDone.length, 'request')}</span>${findBox(q)}</header><div class="body">${done.items.length ? html`<ul class="rq">${done.items.map(row)}</ul>` : noMatch(q)}${done.more}</div></section>` : ''}`;
  },
};
