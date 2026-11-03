// The end-of-shift check-in: what I did, what's next, anything in my way. The hours come from the
// timer, so nobody types them. It posts in #check-ins, and managers see everyone's on one page.
import { html, raw, esc, dur, plural, dayLong, initials, avColor, hhmmText, dayShort } from '../util.js';
import { get, post, put, qs } from '../api.js';
import { S, actions, toast, errMsg, openModal } from '../ui.js';
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
  // each part under its own small label; long ones are cut to a few lines with "Read all" (see clampCards)
  const sec = (label, txt, cls = '') => html`<div class="cic-s${cls}"><span class="cic-lb">${label}</span><p class="cic-tx">${txt}</p></div>`;
  return html`<div class="cic-h">${av(c.user)}<span class="cic-w"><b>${c.user.name}</b><span>${c.user.title ? `${c.user.title} · ` : ''}${t12(c.created_at)}</span></span><span class="cic-hr"><b class="num">${hm(c.tracked_secs)}</b><span>tracked</span></span></div>
    <div class="cic-body">${sec('Did', t(c.did) || html`<span class="faint">What you did shows here</span>`, ' did')}
    ${c.next ? sec('Next', t(c.next), ' next') : ''}
    ${c.blockers ? sec('Blocked', t(c.blockers), ' cic-blk') : ''}</div>
    ${preview ? '' : html`<button type="button" class="linkbtn cic-more" data-act="ci-more" data-id="${c.id}" aria-haspopup="dialog" hidden>Read all</button>`}
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
// a long check-in opens whole in a reading window, so the cards beside it keep their places
let ciItems = new Map(), ciDay = null;
actions['ci-more'] = (el) => {
  const c = ciItems.get(Number(el.dataset.id)); if (!c) return;
  const sec = (label, txt, cls = '') => (txt ? html`<div class="cic-s${cls}"><span class="cic-lb">${label}</span><p class="cic-tx">${txt}</p></div>` : '');
  const md = openModal({ title: c.user.name, wide: true, footer: false, sub: `${c.user.title ? `${c.user.title} · ` : ''}Checked in at ${t12(c.created_at)} · ${hm(c.tracked_secs)} tracked`,
    body: html`<div class="ci-read">${sec('Did', c.did, ' did')}<div class="ci-read-side">${sec('Next', c.next, ' next')}${sec('Blocked', c.blockers, ' cic-blk')}</div></div>
      <div class="ci-read-f">${moodTag(c.mood)}<span class="cic-a">${c.user.id !== S.me.id ? html`<button type="button" class="linkbtn" data-act="ci-reply" data-id="${c.user.id}">Reply</button>` : html`<a class="linkbtn" href="#/checkin">Change it</a>`}<a class="linkbtn" href="#/timeline?user=${c.user.id}&day=${ciDay}">See the day</a><button type="button" class="btn sm" data-close>Close</button></span></div>` });
  md.form.addEventListener('click', (ev) => { if (ev.target.closest('a, [data-act]')) md.close(); });
};
// a card shows "Read all" only when something in it is actually cut off
function clampCards() {
  for (const card of document.querySelectorAll('.cic-grid .cic')) {
    const btn = card.querySelector('.cic-more'); if (!btn) continue;
    let cut = false;
    for (const p of card.querySelectorAll('.cic-tx')) { const c = p.scrollHeight > p.clientHeight + 2; p.classList.toggle('cut', c); cut = cut || c; }
    btn.hidden = !cut;
  }
}
let ciResize = null;
window.addEventListener('resize', () => { clearTimeout(ciResize); ciResize = setTimeout(clampCards, 120); });
export const checkinsPage = {
  title: 'Check-ins',
  after() { clampCards(); },
  async load(q) { return get(`/api/checkins${qs({ day: q.get('day') })}`); },
  render(d, q) {
    const f = q.get('f') || '';
    const today = companyToday();
    const c = d.counts;
    ciItems = new Map(d.items.map((x) => [x.id, x])); ciDay = d.day;
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
      <div class="tools">${S.me.tracks_time && !mine && d.day === today ? html`<a class="btn primary" href="#/checkin">Check in yourself</a>` : ''}${dayNav(d.day, today)}</div></div>
      ${d.week ? ciBento(d, d.day === today) : stats}
      <div class="csub"><nav class="cseg" aria-label="Show">${seg('Everyone', '', d.items.length)}${seg('Blocked', 'blocked', c.blocked)}${seg('Rough shift', 'rough', c.moods.rough)}</nav></div>
      <div class="cols ci-team"><div>${list.length ? html`<div class="cic-grid">${list.map(card)}</div>` : html`<section class="panel"><div class="body"><div class="empty"><b>${d.items.length ? 'Nobody here with this filter' : 'No check-ins yet'}</b>${d.items.length ? 'Try Everyone.' : 'They show up here as people finish their shift.'}</div></div></section>`}${d.week && list.length < 5 ? weekPanel(d.week, true) : ''}</div><div>${miss}${blocks}${d.week && list.length >= 5 ? weekPanel(d.week) : ''}</div></div>`;
  },
};

// the day as a bento: who checked in (a ring), their hours, how the week went, what got in the way
function ciBento(d, isToday) {
  const c = d.counts, pct = c.expected ? Math.round((100 * c.checked) / c.expected) : 0;
  const hrs = d.items.map((x) => ({ u: x.user, s: x.tracked_secs })).sort((a, b) => b.s - a.s).slice(0, 8), hmax = Math.max(1, ...hrs.map((x) => x.s));
  const wk = [...d.week.days]; while (wk.length < 7) { const last = wk[wk.length - 1].day, nx = new Date(Date.parse(last + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); wk.push({ day: nx, smooth: 0, busy: 0, rough: 0, none: 0, later: true }); }
  const wmax = Math.max(1, ...wk.map((x) => x.smooth + x.busy + x.rough + x.none));
  const blk = d.items.filter((x) => x.blockers), rough = d.items.filter((x) => x.mood === 'rough');
  const first = (n) => String(n).split(' ')[0];
  const ic = (n) => raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${{ ck: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', cl: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', ch: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>', fl: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', cl2: '<path d="M7 18a4.5 4.5 0 1 1 .6-8.96A6 6 0 0 1 19 10.5a3.75 3.75 0 0 1-.75 7.5z"/>' }[n]}</svg>`);
  return html`<section class="kpis bento ci-bento" aria-label="Check-ins at a glance">
    <div class="kpi bt-ck"><div class="l">${ic('ck')}Checked in</div><div class="bt-ringw ci-ring">${ringSvg(pct)}<span class="bt-rv"><b class="num">${c.checked} of ${c.expected}</b><small>${isToday ? 'tonight' : dayShort(d.day)}</small></span></div>
      <div class="f">${c.expected - c.checked > 0 ? `${c.expected - c.checked} still to go` : c.expected ? 'Everyone has checked in' : 'Nobody worked'}</div></div>
    <div class="kpi bt-tr"><div class="l">${ic('cl')}Tracked ${isToday ? 'tonight' : 'that day'}</div><div class="bt-row"><div class="v">${dur(c.tracked_secs)}</div><span class="bt-say">by everyone on a timer, from their timers</span></div>
      ${hrs.length ? html`<div class="ci-hrs">${hrs.map((x) => html`<span title="${x.u.name}: ${dur(x.s)}"><i style="width:${Math.max(4, Math.round((100 * x.s) / hmax))}%;background:${avColor(x.u.id)}"></i><small>${first(x.u.name)}</small></span>`)}</div>` : html`<div class="f">Hours show here as people check in</div>`}</div>
    <div class="kpi bt-mo"><div class="l">${ic('ch')}How shifts went this week</div>
      <div class="ci-wk">${wk.map((x) => html`<span class="ci-wd${x.day === d.day ? ' on' : ''}${x.later ? ' later' : ''}" title="${dayShort(x.day)}: ${x.smooth} good, ${x.busy} okay, ${x.rough} rough"><span class="ci-stack">${x.smooth + x.busy + x.rough + x.none ? ['rough', 'busy', 'smooth', 'none'].map((k) => (x[k] ? html`<i class="m-${k}" style="height:${(100 * x[k]) / wmax}%"></i>` : '')) : html`<i class="m-empty"></i>`}</span><small>${dayShort(x.day).slice(0, 2)}</small></span>`)}</div>
      <div class="ci-key"><span><i class="m-smooth"></i>Good</span><span><i class="m-busy"></i>Busy</span><span><i class="m-rough"></i>Rough</span></div></div>
    <div class="kpi bt-bl ${blk.length ? 'warn' : 'good'}"><div class="l">${ic('fl')}Blocked</div><div class="v">${blk.length}</div><div class="f">${blk.length ? `${blk.slice(0, 2).map((x) => first(x.user.name)).join(', ')}: ${blk[0].blockers}` : 'Nothing in the way'}</div></div>
    <div class="kpi bt-ro ${rough.length ? 'bad' : ''}"><div class="l">${ic('cl2')}Rough shifts</div><div class="v">${rough.length}</div><div class="f">${rough.length ? `${rough.map((x) => first(x.user.name)).join(', ')}. Worth a word tomorrow` : 'Nobody had a rough one'}</div></div>
  </section>`;
}
const ringSvg = (pct) => { const r = 40, cc = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct || 0)); return raw(`<svg class="bt-ring" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="${r}" class="tr"/><circle cx="48" cy="48" r="${r}" class="fg" stroke-dasharray="${((cc * v) / 100).toFixed(1)} ${cc.toFixed(1)}" transform="rotate(-90 48 48)"/></svg>`); };
// who checked in on which days this week
function weekPanel(w, wide = false) {
  if (!w.people.length) return '';
  return html`<section class="panel ci-week${wide ? ' wide' : ''}"><header><h2>Check-ins this week</h2><span class="muted small">${dayShort(w.days[0].day).slice(0, 3)} to ${dayShort(w.days[w.days.length - 1].day).slice(0, 3)}</span></header><div class="body"><ul class="ci-wl">${w.people.map((p) => html`<li>${av(p.user, 28)}<b>${p.user.name.split(' ')[0]}</b><span class="ci-dots" aria-label="${p.days.filter(Boolean).length} of ${p.days.length} days">${p.days.map((on) => html`<i class="${on ? 'on' : ''}"></i>`)}</span></li>`)}</ul></div></section>`;
}
actions['ci-nudge'] = async (el) => { el.disabled = true; try { await post('/api/checkins/nudge', { user_id: Number(el.dataset.id) }); el.textContent = 'Nudged'; toast('Asked for their check-in'); } catch (e) { el.disabled = false; toast(errMsg(e), true); } };
actions['ci-reply'] = async (el) => { try { const r = await post('/api/team/dm', { user_id: Number(el.dataset.id) }); location.hash = `#/chat?t=${r.id}`; } catch (e) { toast(errMsg(e), true); } };
void esc; void plural;
