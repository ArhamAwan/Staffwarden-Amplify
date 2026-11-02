// The end-of-shift check-in: what I did, what's next, anything in my way. The hours come from the
// timer, so nobody types them. It posts in #check-ins, and managers see everyone's on one page.
import { html, raw, esc, dur, plural, dayLong, initials, avColor, hhmmText, dayShort } from '../util.js';
import { get, post, put, qs } from '../api.js';
import { S, actions, toast, errMsg } from '../ui.js';
import { dayNav, companyToday } from '../parts.js';
import { gameSaved } from '../v4.js';

const MOODS = [['smooth', 'Smooth'], ['busy', 'Busy'], ['rough', 'Rough']];
const av = (u, size = 36) => html`<span class="cav" style="width:${size}px;height:${size}px;background:${avColor(u.id)};font-size:${Math.round(size * 0.38)}px" aria-hidden="true">${initials(u.name)}</span>`;
const hm = (s) => { const m = Math.round((s || 0) / 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const t12 = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const moodTag = (m) => (m ? html`<span class="ci-mood ${m}">${(MOODS.find((x) => x[0] === m) || [0, m])[1]}</span>` : '');

// ---------- my check-in ----------
let draftMood = null, curWorked = 0;
export const checkinPage = {
  title: 'Check-in',
  async load() { return get('/api/checkins/mine'); },
  render(d) {
    const ex = d.existing;
    curWorked = d.worked_secs;
    const mood = draftMood || (ex && ex.mood) || null;
    const total = Math.max(1, ...d.breakdown.map((b) => b.secs));
    const color = (i, b) => (b.label === 'Not on a task' ? 'var(--faint)' : i % 2 ? 'var(--work)' : 'var(--blue)');
    const hours = html`<section class="panel"><header><h2>Your hours ${d.shift.end && d.shift.end < d.shift.start ? 'tonight' : 'today'}</h2></header><div class="body">
      <div class="ci-big"><b class="num">${hm(d.worked_secs)}</b><span>tracked, from the timer${d.break_secs ? ` · ${dur(d.break_secs)} on breaks` : ''}</span></div>
      ${d.breakdown.length ? html`<ul class="ci-bd">${d.breakdown.map((b, i) => html`<li data-k="b${i}"><span><span class="ci-bl">${b.label}</span><b class="num">${hm(b.secs)}</b></span><i><i style="width:${Math.round((100 * b.secs) / total)}%;background:${color(i, b)}"></i></i></li>`)}</ul>` : html`<p class="hint">Nothing tracked yet today. Start the timer in the desktop app and your hours fill in here.</p>`}
      ${d.breakdown.length ? html`<p class="hint">Nobody types hours. These come from your timer and go with the check-in as they are.</p>` : ''}</div></section>`;
    const form = html`<section class="panel ci-form"><header><h2>${d.shift.end < d.shift.start ? 'Tonight’s check-in' : 'Today’s check-in'}</h2>${d.shift.end ? html`<span class="ci-due">${ex ? `Posted ${t12(ex.created_at)}` : `Due ${hhmmText(d.shift.end)}`}</span>` : ''}</header><div class="body">
      <form id="ci-form" novalidate>
        <div class="field"><label class="f" for="ci-did">What I did</label><textarea id="ci-did" name="did" rows="3" maxlength="4000" required placeholder="Fixed the double texts: one retry, checked by lead id.">${ex ? ex.did : ''}</textarea></div>
        ${d.suggestions.length ? html`<div class="ci-sug"><span>From your board${d.shift.end < d.shift.start ? ' tonight' : ' today'}:</span>${d.suggestions.map((s) => html`<button type="button" class="ci-chip" data-act="ci-add" data-line="${s}">${raw('<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>')}${s}</button>`)}</div>` : ''}
        <div class="field"><label class="f" for="ci-next">What’s next</label><textarea id="ci-next" name="next" rows="2" maxlength="4000" placeholder="Broker report columns, with Hira before the Friday call">${ex ? ex.next || '' : ''}</textarea></div>
        <div class="field"><label class="f" for="ci-blk">Anything in your way? <span class="muted">(optional)</span></label><textarea id="ci-blk" name="blockers" rows="2" maxlength="2000" placeholder="Waiting on the Follow Up Boss export">${ex ? ex.blockers || '' : ''}</textarea><p class="hint">Blockers go to your lead and the owner, and show on the team’s check-ins.</p></div>
        <div class="ci-moodrow" role="radiogroup" aria-label="How was the shift?"><span>How was the shift?</span>${MOODS.map(([k, l]) => html`<button type="button" role="radio" class="ci-m" data-act="ci-mood" data-v="${k}" aria-checked="${mood === k ? 'true' : 'false'}">${l}</button>`)}</div>
        <p class="err" data-err></p>
        <div class="ci-go"><button type="button" class="btn primary" data-act="ci-post">${raw('<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>')} ${ex ? 'Update my check-in' : 'Post my check-in'}</button>${S.me.role !== 'employee' ? html`<a class="btn quiet" href="#/checkins">Everyone’s check-ins</a>` : ''}</div>
      </form></div></section>`;
    const me = { id: S.me.id, name: S.me.name };
    const preview = html`<section class="panel"><header><h2>What your team sees</h2></header><div class="body">
      <div class="ci-card" id="ci-prev">${cardInner({ user: { ...me, title: S.me.title }, did: ex ? ex.did : '', next: ex ? ex.next : '', blockers: ex ? ex.blockers : '', mood, tracked_secs: d.worked_secs, created_at: ex ? ex.created_at : new Date().toISOString() }, true)}</div>
      <p class="hint">Posted in #check-ins and on your managers’ check-ins page. Never your screenshots or activity.</p></div></section>`;
    const MOODL = { good: 'Smooth', ok: 'Busy', rough: 'Rough', smooth: 'Smooth', busy: 'Busy' };
    const recent = html`<section class="panel ci-recent"><header><h2>Your last check-ins</h2></header><div class="body">${(d.recent || []).length
      ? html`<ul class="ci-rl">${d.recent.map((r) => html`<li data-k="r${r.day}"><b>${dayShort(r.day)}</b><span>${(r.did || '').split('\n')[0] || 'No notes'}</span>${r.mood ? html`<span class="chip">${MOODL[r.mood] || r.mood}</span>` : ''}</li>`)}</ul>`
      : html`<p class="muted">Your earlier check-ins show here, so you can see what you said you’d do next.</p>`}</div></section>`;
    return html`<div class="page-h"><div><h1>${ex ? 'Your check-in' : 'Wrap up your shift'}</h1><p class="sub">${ex ? 'Posted. You can still change it tonight; the chat keeps the first one.' : 'Two minutes, once a shift. It replaces the WhatsApp status message.'}</p></div></div>
      <div class="cols ci-cols"><div>${form}</div><div>${hours}${preview}${recent}</div></div>`;
  },
  after() { wirePreview(); },
};
function cardInner(c, preview = false, foot = null) {
  const t = (s, n = 90) => (preview && s && s.length > n ? `${s.slice(0, n)}…` : s);
  return html`<div class="cic-h">${av(c.user)}<span class="cic-w"><b>${c.user.name}</b><span>${c.user.title ? `${c.user.title} · ` : ''}${t12(c.created_at)}</span></span><span class="cic-hr"><b class="num">${hm(c.tracked_secs)}</b><span>tracked</span></span></div>
    <p><b>Did</b> · ${t(c.did) || html`<span class="faint">What you did shows here</span>`}</p>
    ${c.next ? html`<p><b>Next</b> · ${t(c.next)}</p>` : ''}
    ${c.blockers ? html`<p class="cic-blk"><b>Blocked</b> · ${t(c.blockers)}</p>` : ''}
    ${c.mood || foot ? html`<div class="cic-f">${moodTag(c.mood)}${foot || ''}</div>` : ''}`;
}
function wirePreview() {
  const f = document.getElementById('ci-form'), box = document.getElementById('ci-prev');
  if (!f || !box || f.dataset.wired) return;
  f.dataset.wired = '1';
  const paint = () => {
    const fd = new FormData(f);
    box.innerHTML = cardInner({ user: { id: S.me.id, name: S.me.name, title: S.me.title }, did: fd.get('did').trim(), next: fd.get('next').trim(), blockers: fd.get('blockers').trim(), mood: draftMood || (document.querySelector('.ci-m[aria-checked="true"]') || {}).dataset?.v || null, tracked_secs: curWorked, created_at: new Date().toISOString() }, true).toString();
  };
  f.addEventListener('input', paint);
  f.addEventListener('ci-paint', paint);
}
actions['ci-add'] = (el) => {
  const ta = document.getElementById('ci-did'); if (!ta) return;
  ta.value = ta.value.trim() ? `${ta.value.trim()}${/[.!?]$/.test(ta.value.trim()) ? '' : '.'} ${el.dataset.line}.` : `${el.dataset.line}.`;
  ta.dataset.dirty = '1'; el.disabled = true;
  document.getElementById('ci-form').dispatchEvent(new Event('ci-paint'));
  ta.focus();
};
actions['ci-mood'] = (el) => {
  draftMood = el.getAttribute('aria-checked') === 'true' ? null : el.dataset.v;
  for (const b of document.querySelectorAll('.ci-m')) b.setAttribute('aria-checked', String(b.dataset.v === draftMood));
  const f = document.getElementById('ci-form'); if (f) f.dispatchEvent(new Event('ci-paint'));
};
actions['ci-post'] = async (el) => {
  const f = document.getElementById('ci-form'); if (!f) return;
  const fd = new FormData(f), err = f.querySelector('[data-err]');
  err.textContent = '';
  if (!fd.get('did').trim()) { err.textContent = 'Say what you did. One line is enough.'; document.getElementById('ci-did').focus(); return; }
  el.disabled = true;
  try {
    const had = !!document.querySelector('.ci-due') && /Posted/.test(document.querySelector('.ci-due').textContent);
    await put('/api/checkins/mine', { did: fd.get('did'), next: fd.get('next'), blockers: fd.get('blockers') || null, mood: draftMood || (document.querySelector('.ci-m[aria-checked="true"]') || {}).dataset?.v || null });
    for (const x of f.querySelectorAll('[data-dirty]')) delete x.dataset.dirty;
    draftMood = null;
    toast(had ? 'Check-in updated' : 'Check-in posted in #check-ins. Good shift.');
    // god mode: the night as a save screen, the first time it is posted
    if (!had && S.me.fun_mode) { try { gameSaved(await get('/api/me/fun')); } catch { /* the toast said it */ } }
    S.refresh();
  } catch (e) { err.textContent = errMsg(e); } finally { el.disabled = false; }
};

// ---------- everyone's check-ins ----------
export const checkinsPage = {
  title: 'Check-ins',
  async load(q) { return get(`/api/checkins${qs({ day: q.get('day') })}`); },
  render(d, q) {
    const f = q.get('f') || '';
    const today = companyToday();
    const c = d.counts;
    const list = d.items.filter((x) => (f === 'blocked' ? x.blockers : f === 'rough' ? x.mood === 'rough' : true));
    const st = (l, v, foot, cls = '') => html`<div class="ibx-st"><span>${l}</span><b class="${cls}">${v}</b><small>${foot}</small></div>`;
    const moodsTxt = [c.moods.busy ? `${c.moods.busy} busy` : '', c.moods.rough ? `${c.moods.rough} rough` : ''].filter(Boolean).join(' · ') || 'nobody had a rough one';
    const stats = html`<div class="ibx-stats ci-stats">${st('Checked in', `${c.checked} of ${c.expected}`, c.expected - c.checked > 0 ? `${c.expected - c.checked} still to go` : 'everyone')}${st('Tracked', `${Math.round(c.tracked_secs / 3600)}h`, 'all of you, from timers')}${st('Blocked', String(c.blocked), c.blocked ? 'their leads have been told' : 'nothing in the way', c.blocked ? 'warn' : '')}${c.checked ? st('How it went', `${c.moods.smooth} smooth`, moodsTxt) : ''}</div>`;
    const seg = (label, v, n) => html`<button type="button" data-act="q" data-q="f" data-v="${v}" aria-current="${f === v ? 'page' : 'false'}">${label}${n != null ? html` <span>${n}</span>` : ''}</button>`;
    const card = (x) => html`<article class="cic${x.blockers ? ' blk' : ''}" data-k="c${x.id}">${cardInner(x, false, html`<span class="cic-a">${x.user.id !== S.me.id ? html`<button type="button" class="linkbtn" data-act="ci-reply" data-id="${x.user.id}">Reply</button>` : html`<a class="linkbtn" href="#/checkin">Change it</a>`}<a class="linkbtn" href="#/timeline?user=${x.user.id}&day=${d.day}">See the day</a></span>`)}</article>`;
    const miss = d.missing.length ? html`<section class="panel"><header><h2>Not checked in yet</h2></header><div class="body"><ul class="ci-miss">${d.missing.map((m) => html`<li data-k="m${m.user.id}">${av(m.user, 32)}<span><b>${m.user.name}</b><span>${m.state === 'running' ? `Timer still running · ${hm(m.worked_secs)}` : m.state === 'off' ? 'On time off · skipped' : `Stopped, no check-in · ${hm(m.worked_secs)}`}</span></span>${m.state !== 'off' && S.me.role !== 'employee' ? html`<button type="button" class="btn sm" data-act="ci-nudge" data-id="${m.user.id}">Nudge</button>` : ''}</li>`)}</ul></div></section>` : '';
    const blk = d.items.filter((x) => x.blockers);
    const blocks = blk.length ? html`<section class="panel"><header><h2>Blockers</h2></header><div class="body"><ul class="ci-blks">${blk.map((x) => html`<li data-k="b${x.id}">${av(x.user, 30)}<span><b>${x.user.name}</b><span>${x.blockers}</span></span></li>`)}</ul></div></section>` : '';
    const mine = d.items.find((x) => x.user.id === S.me.id);
    return html`<div class="page-h"><div><h1>Check-ins</h1><p class="sub">What everyone did and what’s next, with their tracked hours. Newest first.</p></div>
      <div class="tools">${S.me.tracks_time && !mine && d.day === today ? html`<a class="btn primary" href="#/checkin">Check in yourself</a>` : ''}${dayNav(d.day, today)}</div>${stats}</div>
      <div class="csub"><nav class="cseg" aria-label="Show">${seg('Everyone', '', d.items.length)}${seg('Blocked', 'blocked', c.blocked)}${seg('Rough shift', 'rough', c.moods.rough)}</nav></div>
      <div class="cols ci-team"><div>${list.length ? html`<div class="cic-grid">${list.map(card)}</div>` : html`<section class="panel"><div class="body"><div class="empty"><b>${d.items.length ? 'Nobody here with this filter' : 'No check-ins yet'}</b>${d.items.length ? 'Try Everyone.' : 'They show up here as people finish their shift.'}</div></div></section>`}</div><div>${miss}${blocks}</div></div>`;
  },
};
actions['ci-nudge'] = async (el) => { el.disabled = true; try { await post('/api/checkins/nudge', { user_id: Number(el.dataset.id) }); el.textContent = 'Nudged'; toast('Asked for their check-in'); } catch (e) { el.disabled = false; toast(errMsg(e), true); } };
actions['ci-reply'] = async (el) => { try { const r = await post('/api/team/dm', { user_id: Number(el.dataset.id) }); location.hash = `#/chat?t=${r.id}`; } catch (e) { toast(errMsg(e), true); } };
void esc; void plural;
