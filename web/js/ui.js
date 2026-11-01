// Shared building blocks: app state, toasts, dialogs, the screenshot viewer, ribbons, KPI cells.
import { nowMs, html, raw, esc, icon, dur, initials, avColor, tod, todOn, fmtMin, hourLabel, pctText, reasonLabel, clock, ATT, tzLabel, dayShort, plural } from './util.js';
import { shotUrl, cachedThumb, del, forgetShot, get, put } from './api.js';
import { leave } from './motion.js';

export const S = { me: null, settings: null, teams: [], shots: [], refresh: () => {}, navigate: () => {} };
export const actions = {};

// ---------- toasts
export function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3200);
}
export const errMsg = (e) => (e && e.message) || 'Something went wrong';

// ---------- dialogs (rendered outside the refreshed area so live updates never disturb them)
const overlay = () => document.getElementById('overlay');
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function trap(root, e) {
  if (e.key !== 'Tab') return;
  const f = Array.from(root.querySelectorAll(FOCUSABLE)).filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function openModal({ title, body, submit = 'Save', cancel = 'Cancel', danger = false, wide = false, top = false, onSubmit, footer = true, sub }) {
  const opener = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = `scrim${top ? ' top' : ''}`;
  const id = `m${Math.random().toString(36).slice(2, 8)}`;
  scrim.innerHTML = `<form class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}-t" novalidate>
    <header><h2 id="${id}-t">${esc(title)}</h2>${sub ? `<p class="muted" style="margin-top:4px">${esc(sub)}</p>` : ''}</header>
    <div class="body">${body.toString()}<p class="err" role="alert"></p></div>
    ${footer ? `<footer><button type="button" class="btn" data-close>${esc(cancel)}</button>${onSubmit ? `<button type="submit" class="btn ${danger ? 'solid-danger' : 'primary'}">${esc(submit)}</button>` : ''}</footer>` : ''}
  </form>`;
  overlay().appendChild(scrim);
  const form = scrim.querySelector('form');
  const errEl = scrim.querySelector('.err');
  const close = () => { document.removeEventListener('keydown', onKey, true); leave(scrim); if (opener && opener.focus && document.contains(opener)) opener.focus(); };
  function onKey(e) {
    if (!scrim.isConnected) return;
    const topMost = overlay().lastElementChild === scrim;
    if (!topMost) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else trap(form, e);
  }
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  scrim.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = form.querySelector('button[type="submit"]');
    errEl.textContent = ''; btn.disabled = true;
    try {
      const out = await onSubmit(new FormData(form), form);
      if (out !== false) close();
    } catch (err) { errEl.textContent = errMsg(err); }
    finally { btn.disabled = false; }
  });
  const first = form.querySelector('[autofocus]') || form.querySelector('input:not([type=hidden]),select,textarea') || form.querySelector('button[type=submit]');
  setTimeout(() => first && first.focus(), 20);
  return { close, form, setError: (m) => { errEl.textContent = m; } };
}

export function confirmBox({ title, message, confirm = 'Confirm', danger = false, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title, body: html`<p>${message}</p>`, submit: confirm, danger, cancel, top: true,
      onSubmit: async () => { done = true; resolve(true); },
    });
    const obs = new MutationObserver(() => { if (!m.form.isConnected) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(overlay(), { childList: true });
  });
}

// ---------- pieces
export const avatar = (u, small = false) => html`<span class="avatar${small ? ' sm' : ''}" style="background:${avColor(u.user_id ?? u.id)}" aria-hidden="true">${initials(u.name)}</span>`;
export const person = (u, subtitle) => html`<span class="person">${avatar(u)}<span><b>${u.name}</b><span>${subtitle ?? u.title ?? ''}</span></span></span>`;

export function kpis(cells) {
  // rows as even as they can be (7 is 4 + 3, 11 is 4 + 4 + 3) on a 60-column grid, so every row is
  // full and no tile is left stretched or an empty slot left over
  const n = cells.length, most = n <= 5 ? n : n === 6 ? 3 : 4, rows = Math.max(1, Math.ceil(n / most));
  const span = [];
  for (let r = 0, left = n; r < rows; r++) { const size = Math.ceil(left / (rows - r)); for (let k = 0; k < size; k++) span.push(60 / size); left -= size; }
  return html`<section class="kpis" style="--cols:60" aria-label="Key numbers">${cells.map((c, i) => html`<div class="kpi ${c.tone || ''}" data-k="${c.label}" style="--span:${span[i]}">
    <div class="l">${c.ic ? icon(c.ic) : ''}${c.label}</div><div class="v">${c.value}${c.unit ? html` <small>${c.unit}</small>` : ''}</div>
    ${c.meter != null ? html`<div class="meter ${c.tone || ''}"><i style="width:${Math.max(0, Math.min(100, c.meter))}%"></i></div>` : ''}
    ${c.foot ? html`<div class="f">${c.foot}</div>` : ''}</div>`)}</section>`;
}

export const tag = (cls, text) => html`<span class="tag ${cls}"><i></i>${text}</span>`;
export const attTag = (status) => tag(status, ATT[status] || status);

// What someone is doing right now, from a dashboard row or a day payload.
// the live state and the day's attendance, without saying the same thing twice
export function stateTags(r, att) {
  const live = liveTag({ ...r, attendance: att }).toString(), a = attTag(att || 'off').toString();
  const label = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ')[0];
  return raw(live + (att && label(live) !== label(a) && !(att === 'not_started' && /not_started/.test(live)) ? a : ''));
}
export function liveTag(r) {
  switch (r.state) {
    // how long, inside the pill, so it reads as one thing
    case 'working': return html`<span class="tag working"><i></i>Working <span class="tag-t num" data-since="${r.since}"></span></span>`;
    case 'break': return html`<span class="tag break"><i></i>${reasonLabel(r.reason)} <span class="tag-t num" data-since="${r.since}"></span></span>`;
    case 'idle': return html`<span class="tag idle"><i></i>Idle <span class="tag-t num" data-since="${r.since}"></span></span>`;
    case 'no_signal': return html`<span class="tag no_signal"><i></i>No signal <span class="tag-t">since ${tod(r.since, r.tz_offset_min ?? 0)}</span></span>`;
    default: break;
  }
  const a = r.attendance;
  if (!a) return tag('offline', 'Offline');
  if (a === 'present' || a === 'late') return tag('offline', 'Signed off');
  if (a === 'not_started') return tag('not_started', 'Not started');
  return attTag(a || 'off');
}

export function empty(title, text) { return html`<div class="empty"><b>${title}</b>${text || ''}</div>`; }

// ---------- ribbon: one person's day as coloured segments
// rows: lists of segments; base: the part of the day always shown (usually the shift), in day minutes.
export function windowFor(rows, base = [9 * 60, 19 * 60], pad = true) {
  if (base === true || base === false) base = [9 * 60, 19 * 60];
  let lo = Math.floor(base[0] / 60) * 60, hi = Math.min(1440, Math.ceil(base[1] / 60) * 60);
  for (const segs of rows) for (const [s, e] of segs) { lo = Math.min(lo, Math.floor(s / 60) * 60); hi = Math.max(hi, Math.ceil(e / 60) * 60); }
  if (pad) { lo = Math.max(0, lo - 60 * 0); hi = Math.min(1440, hi); }
  if (hi - lo < 360) hi = Math.min(1440, lo + 360);
  return [lo, hi];
}
const SEGNAME = { w: 'Working', b: 'Break', i: 'Idle' };
// ds: where the day starts (minutes after midnight), so tooltips show clock times; brk: scheduled break.
export function ribbon(segs, [lo, hi], { large = false, nowMin = null, shift = null, brk = null, ds = 0 } = {}) {
  const clock = (m) => fmtMin((m + ds) % 1440);
  const span = hi - lo, n = Math.max(1, Math.round(span / 60));
  const pos = (m) => ((m - lo) / span) * 100;
  const bits = [];
  // a faint line on every whole clock hour, so the hour labels underneath sit right on them
  for (let m = Math.ceil((lo + ds) / 60) * 60 - ds; m < hi; m += 60) if (m > lo) bits.push(html`<u style="left:${pos(m)}%"></u>`);
  if (shift) { const s = Math.max(lo, shift[0]), e = Math.min(hi, shift[1]); if (e > s) bits.push(html`<i class="shift" style="left:${pos(s)}%;width:${pos(e) - pos(s)}%" title="Scheduled shift ${clock(shift[0])} to ${clock(shift[1])}"></i>`); }
  if (brk) { const s = Math.max(lo, brk[0]), e = Math.min(hi, brk[1]); if (e > s) bits.push(html`<i class="sbrk" style="left:${pos(s)}%;width:${pos(e) - pos(s)}%" title="Scheduled break ${clock(brk[0])} to ${clock(brk[1])}"></i>`); }
  for (const [s0, e0, t] of segs) {
    const s = Math.max(lo, s0), e = Math.min(hi, e0);
    if (e <= s) continue;
    bits.push(html`<i class="${t}" style="left:${pos(s)}%;width:${Math.max(0.25, pos(e) - pos(s))}%" title="${SEGNAME[t]} ${clock(s0)} to ${clock(e0)} (${dur((e0 - s0) * 60)})"></i>`);
  }
  if (nowMin != null && nowMin >= lo && nowMin <= hi) bits.push(html`<b class="now" style="left:${pos(nowMin)}%" title="Now"></b>`);
  return html`<div class="rib${large ? ' lg' : ''}" style="--n:${n}" role="img" aria-label="Timeline of the day">${bits}</div>`;
}
// Hour labels under a ribbon. The spacing grows with the hours shown so labels never run together:
// at most `maxLabels` (fewer in narrow places like a table column), on whole hours.
export function ribbonAxis([lo, hi], { maxLabels = 8, ds = 0 } = {}) {
  const span = hi - lo;
  const step = [1, 2, 3, 4, 6, 12].find((h) => Math.floor(span / (h * 60)) + 1 <= maxLabels) || 12;
  const first = Math.ceil((lo + ds) / (step * 60)) * step * 60 - ds;   // on whole clock hours
  const ticks = [];
  for (let m = first; m <= hi; m += step * 60) {
    const pct = ((m - lo) / span) * 100;
    const edge = pct < 6 ? ' first' : pct > 94 ? ' last' : '';
    ticks.push(html`<span class="${edge.trim()}" style="left:${pct}%">${hourLabel(((m + ds) % 1440) / 60)}</span>`);
  }
  return html`<div class="rib-axis" aria-hidden="true">${ticks}</div>`;
}
export const ribbonLegend = (brk = false) => html`<div class="legend"><span><i class="sw s-working"></i>Working</span><span><i class="sw s-break"></i>Break</span><span><i class="sw s-idle"></i>Idle (still counted)</span>${brk ? html`<span><i class="sw s-sbrk"></i>Scheduled break</span>` : ''}</div>`;

export function bars(items, { max, fmt = dur } = {}) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  // a week with nothing in it says so, instead of drawing seven empty stubs
  if (!items.some((i) => i.value)) return html`<div class="bars-empty"><b>Nothing tracked in these days yet</b><span>Hours show here as soon as the timer runs.</span></div>`;
  const anySub = items.some((i) => i.sub);
  // every bar stands on the same baseline: the labels under it always take the same room
  return html`<div class="bars${anySub ? ' has-sub' : ''}">${items.map((i) => html`<div class="c" data-k="${i.label}">
    <div class="bw"><span class="val">${i.value ? fmt(i.value) : '–'}</span>
    <div class="col${i.today ? ' today' : ''}${i.value ? '' : ' zero'}" style="height:calc((100% - 22px) * ${(Math.max(0.015, i.value / m)).toFixed(4)})" title="${i.title || ''}"></div></div>
    <span class="lab">${i.label}</span>${anySub ? html`<span class="sub">${i.sub || raw('&nbsp;')}</span>` : ''}</div>`)}</div>`;
}

export function meter(pct, tone = '') { return html`<span class="meter ${tone}"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></span>`; }
export const toneFor = (v, bad, warn) => (v == null ? '' : v < bad ? 'bad' : v < warn ? 'warn' : 'good');

export function dateNav({ label, prevQ, nextQ, nextDisabled, todayQ, todayShown }) {
  return html`<span class="datenav">
    <button class="btn icon" data-act="q" ${raw(prevQ)} aria-label="Previous">${icon('left')}</button>
    <span class="lbl num">${label}</span>
    <button class="btn icon" data-act="q" ${raw(nextQ)} aria-label="Next" ${nextDisabled ? raw('disabled') : ''}>${icon('right')}</button>
    ${todayShown ? html`<button class="btn sm" data-act="q" ${raw(todayQ)}>Today</button>` : ''}</span>`;
}
export const qAttr = (k, v) => `data-q="${esc(k)}" data-v="${esc(v ?? '')}"`;

// ---------- screenshots
export function setShots(list) { S.shots = list; }
export function shotTile(s, i, { showName = false } = {}) {
  const tz = s.tz_offset_min ?? 0;
  return html`<button class="shot" data-k="s${s.id}" data-act="openshot" data-i="${i}" aria-label="Open screenshot taken at ${tod(s.taken_at, tz)}${showName ? ' by ' + s.user_name : ''}">
    ${s.privacy === 'full'
      ? html`<span class="im private" title="This whole screenshot was hidden on the employee's computer to protect a private window">${icon('lock')}<span>Private window<br>Screenshot hidden</span></span>`
      : html`<span class="im"><img data-shot="${s.id}" alt="" decoding="async">${s.privacy === 'partial' ? html`<span class="privtag">${icon('lock')} Private window hidden</span>` : ''}${s.viewers ? html`<span class="seen" title="Opened by ${s.viewers === 1 ? 'one person' : s.viewers + ' people'}. Open it to see who.">${icon('eye')} ${s.viewers}</span>` : ''}${s.note ? html`<span class="noted" title="Has a note: ${s.note}">${icon('chat')} Note</span>` : ''}</span>`}
    ${showName ? html`<span class="who">${s.user_name}</span>` : ''}
    <footer><b class="num">${tod(s.taken_at, tz)}</b><span class="muted num">${s.activity == null ? 'no activity data' : s.activity + '% active'}</span></footer>
    ${s.activity != null ? html`<span class="meter" style="display:block"><i style="width:${s.activity}%"></i></span>` : ''}
  </button>`;
}
// groups screenshots under their hour heading, in each person's own clock
export function shotsByHour(list, opts = {}) {
  if (!list.length) return '';
  const groups = new Map();
  list.forEach((s, i) => {
    const tz = s.tz_offset_min ?? 0;
    const h = Math.floor(((Math.floor((Date.parse(s.taken_at) + tz * 60000) / 60000) % 1440) + 1440) % 1440 / 60);
    const key = opts.byPerson ? `${s.user_id}-${h}` : String(h);
    if (!groups.has(key)) groups.set(key, { h, name: s.user_name, items: [] });
    groups.get(key).items.push([s, i]);
  });
  let entries = Array.from(groups.entries());
  if (opts.byPerson) entries.sort((a, b) => a[1].name.localeCompare(b[1].name) || a[1].h - b[1].h);
  return entries.map(([key, g]) => {
    const acts = g.items.map(([s]) => s.activity).filter((a) => a != null);
    const avg = acts.length ? Math.round(acts.reduce((a, b) => a + b, 0) / acts.length) : null;
    return html`<section data-k="h${key}"><div class="hourhd"><b>${opts.byPerson ? g.name + ' · ' : ''}${hourLabel(g.h)}</b><span class="muted">${g.items.length} ${g.items.length === 1 ? 'screenshot' : 'screenshots'}${avg != null ? ` · ${avg}% average activity` : ''}</span></div>
      <div class="shots">${g.items.map(([s, i]) => shotTile(s, i, opts))}</div></section>`;
  });
}

// Screenshots in working stretches: a new stretch starts after a gap of 20 minutes or more (a break, the
// computer asleep, or the timer stopped). Each stretch says when it ran and how active it was; long ones
// show two rows and open to show the rest. With several people, each person gets their own block.
const STRETCH_GAP_MS = 20 * 60000, FIRST_SHOTS = 10;
function stretchesOf(items) {
  const out = [];
  for (const it of items) {
    const t = Date.parse(it[0].taken_at), last = out[out.length - 1];
    if (last && t - last.end < STRETCH_GAP_MS) { last.items.push(it); last.end = t; }
    else out.push({ start: t, end: t, items: [it] });
  }
  return out;
}
const avgOf = (items) => { const a = items.map(([s]) => s.activity).filter((x) => x != null); return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null; };
function stretchBlock(st, key, day, opts) {
  const tz = st.items[0][0].tz_offset_min ?? 0, avg = avgOf(st.items);
  const first = st.items.slice(0, FIRST_SHOTS), more = st.items.slice(FIRST_SHOTS);
  const range = st.items.length > 1 ? `${todOn(st.items[0][0].taken_at, tz, day)} – ${todOn(st.items[st.items.length - 1][0].taken_at, tz, day)}` : todOn(st.items[0][0].taken_at, tz, day);
  return html`<section class="stretch" data-k="${key}"><div class="stretch-h"><b class="num">${range}</b><span class="muted">${plural(st.items.length, 'screenshot')}${avg != null ? html` · <span class="num">${avg}%</span> active` : ''}</span></div>
    <div class="shots">${first.map(([s, i]) => shotTile(s, i, opts))}</div>
    ${more.length ? html`<details class="shots-more" data-k="${key}m"><summary>Show ${plural(more.length, 'more screenshot')}</summary><div class="shots">${more.map(([s, i]) => shotTile(s, i, opts))}</div></details>` : ''}</section>`;
}
export function shotGroups(list, { byPerson = false, day = null } = {}) {
  if (!list.length) return '';
  const opts = { showName: false };
  if (!byPerson) return stretchesOf(list.map((s, i) => [s, i])).map((st, n) => stretchBlock(st, `st${st.items[0][0].id}`, day, opts));
  const people = new Map();
  list.forEach((s, i) => { if (!people.has(s.user_id)) people.set(s.user_id, { name: s.user_name, id: s.user_id, items: [] }); people.get(s.user_id).items.push([s, i]); });
  return Array.from(people.values()).map((p) => {
    const avg = avgOf(p.items);
    return html`<details class="panel personshots" open data-k="ps${p.id}"><summary><span class="avatar" style="background:${avColor(p.id)}">${initials(p.name)}</span><span class="ps-name">${p.name}</span><span class="muted">${plural(p.items.length, 'screenshot')}${avg != null ? ` · ${avg}% active` : ''}</span></summary>
      <div class="body">${stretchesOf(p.items).map((st) => stretchBlock(st, `st${st.items[0][0].id}`, day, opts))}</div></details>`;
  });
}

// fills in <img data-shot> once the (authenticated) image bytes arrive
// Thumbnails already downloaded appear at once; the rest load as they come near the screen, so a long
// day of screenshots does not hold up the page (or ones hidden under "Show more" until opened).
let thumbObserver = null;
function loadThumb(img) {
  if (img.getAttribute('src') || img.dataset.loading) return;
  img.dataset.loading = '1';
  const id = Number(img.dataset.shot);
  shotUrl(id, 'thumb').then((u) => { if (img.isConnected) img.src = u; }).catch(() => { img.alt = 'Image unavailable'; }).finally(() => { delete img.dataset.loading; });
}
export function hydrateImages(root) {
  if (!thumbObserver && 'IntersectionObserver' in window) {
    thumbObserver = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { thumbObserver.unobserve(e.target); loadThumb(e.target); } }, { rootMargin: '600px 0px' });
  }
  for (const img of root.querySelectorAll('img[data-shot]')) {
    if (img.getAttribute('src')) continue;
    const c = cachedThumb(Number(img.dataset.shot));
    if (c) { img.src = c; continue; }
    if (thumbObserver) thumbObserver.observe(img); else loadThumb(img);
  }
}

// ---------- the viewer
let viewer = null;
export function openViewer(index, { onDeleted } = {}) {
  if (viewer) viewer.close();
  const list = S.shots.slice();
  if (!list.length) return;
  const opener = document.activeElement;
  let i = Math.max(0, Math.min(index, list.length - 1));
  const root = document.createElement('div');
  root.className = 'viewer';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Screenshot viewer');
  overlay().appendChild(root);
  let zoom = false, token = 0, fullUrl = null;

  async function show() {
    const s = list[i], my = ++token, tz = s.tz_offset_min ?? 0;
    const canDelete = S.me && (S.me.role === 'owner' || s.user_id === S.me.id || s.user_id == null);
    root.innerHTML = `<div class="stage${zoom ? ' zoom' : ''}">
        <button class="nav-b prev" data-v="prev" aria-label="Previous screenshot" ${i === 0 ? 'disabled' : ''}>${icon('left')}</button>
        <img alt="Screenshot of ${esc(s.user_name)}'s screen at ${esc(tod(s.taken_at, tz))}" data-zoom>
        <button class="nav-b next" data-v="next" aria-label="Next screenshot" ${i === list.length - 1 ? 'disabled' : ''}>${icon('right')}</button>
      </div>
      <aside>
        <button class="btn icon x" data-v="close" aria-label="Close viewer">${icon('x')}</button>
        <div><h2>${esc(s.user_name)}</h2><p class="muted num">${esc(dayShort(new Date(Date.parse(s.taken_at) + tz * 60000).toISOString().slice(0, 10)))} at ${esc(tod(s.taken_at, tz))} <span class="faint">(${esc(tzLabel(tz))})</span></p></div>
        <dl>
          <dt>Activity</dt><dd class="num">${s.activity == null ? 'Not recorded' : s.activity + '%'}</dd>
          ${s.privacy ? `<dt>Privacy</dt><dd>${s.privacy === 'full' ? 'The whole screenshot was hidden to protect a private window' : 'Private windows were blacked out'}</dd>` : ''}
          ${s.project ? `<dt>Project</dt><dd>${esc(s.project)}</dd>` : ''}
          ${S.me && s.user_id === S.me.id ? `<dt>Opened by</dt><dd id="shot-views" class="small">Checking…</dd>` : ''}
          <dt>Screenshot</dt><dd class="num">${i + 1} of ${list.length}</dd>
        </dl>
        ${s.activity != null ? `<div class="meter"><i style="width:${s.activity}%"></i></div>` : ''}
        ${s.note ? `<div class="shot-note"><span>${S.me && s.user_id === S.me.id ? 'Your note' : `${esc(s.user_name.split(' ')[0])}'s note`}</span><p>${esc(s.note)}</p></div>` : ''}
        <p class="small muted">Taken while the timer was running. The timer's pauses are never captured.</p>
        <div class="steps">
          <button class="btn" data-v="open">${icon('ext')} Open full size</button>
          <a class="btn" data-v="save" download="screenshot-${s.id}.jpg" href="#">${icon('down')} Download</a>
          ${S.me && s.user_id === S.me.id ? `<button class="btn" data-v="note">${icon('chat')} ${s.note ? 'Edit your note' : 'Add a note'}</button>` : ''}
          ${canDelete ? `<button class="btn danger" data-v="delete">${icon('trash')} Delete screenshot</button>` : ''}
        </div>
        <p class="small faint">Use the left and right arrow keys to move between screenshots. Esc closes.</p>
      </aside>`;
    const img = root.querySelector('img[data-zoom]');
    const th = cachedThumb(s.id);
    if (th) img.src = th;
    try {
      const u = await shotUrl(s.id, 'full');
      if (my !== token) return;
      fullUrl = u; img.src = u;
      const a = root.querySelector('[data-v="save"]'); if (a) a.href = u;
    } catch { if (my === token && !th) root.querySelector('.stage').insertAdjacentHTML('beforeend', '<p style="color:#fff">This image is no longer available.</p>'); }
    // Only your own screenshots are loaded ahead: opening someone else's is recorded for them, so it
    // happens only when it is actually shown.
    const mine = (x) => x && S.me && x.user_id === S.me.id;
    if (mine(list[i + 1])) shotUrl(list[i + 1].id, 'full').catch(() => {});
    if (mine(list[i - 1])) shotUrl(list[i - 1].id, 'full').catch(() => {});
    if (mine(s)) {
      get(`/api/screenshots/${s.id}/views`).then((v) => {
        const dd = my === token && root.querySelector('#shot-views');
        if (!dd) return;
        dd.textContent = v.length ? v.map((x) => `${x.name} (${x.times === 1 ? 'once' : x.times + ' times'}, last ${dayShort(new Date(Date.parse(x.last_at) + tz * 60000).toISOString().slice(0, 10))} ${tod(x.last_at, tz)})`).join('; ') : 'No one else has opened it';
      }).catch(() => { const dd = root.querySelector('#shot-views'); if (dd) dd.textContent = 'Not available'; });
    }
    const f = root.querySelector('[data-v="close"]'); if (f && !root.contains(document.activeElement)) f.focus();
  }
  const go = (d) => { const n = i + d; if (n < 0 || n >= list.length) return; i = n; zoom = false; show(); };
  function close() { root.remove(); document.removeEventListener('keydown', onKey, true); viewer = null; if (opener && document.contains(opener)) opener.focus(); }
  function onKey(e) {
    if (!root.isConnected) return;
    if (overlay().lastElementChild !== root) return;      // a dialog is on top
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else trap(root, e);
  }
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-v]'), z = e.target.closest('[data-zoom]');
    if (z && !b) { zoom = !zoom; root.querySelector('.stage').classList.toggle('zoom', zoom); return; }
    if (!b) { if (e.target.classList.contains('stage')) close(); return; }
    const v = b.dataset.v;
    if (v === 'prev') go(-1); else if (v === 'next') go(1); else if (v === 'close') close();
    else if (v === 'open') { if (fullUrl) window.open(fullUrl, '_blank', 'noopener'); }
    else if (v === 'save') { if (!fullUrl) e.preventDefault(); }
    else if (v === 'note') {
      const s = list[i];
      openModal({
        title: 'A note about this screenshot', sub: 'Your manager sees it with the screenshot.', submit: 'Save note', top: true,
        body: html`<div class="field"><label class="f" for="sn-t">Your note</label><textarea id="sn-t" name="text" rows="4" maxlength="500">${s.note || ''}</textarea><p class="hint">For example: "Waiting for the client to send the file."</p></div>`,
        onSubmit: async (fd) => {
          const text = String(fd.get('text') || '').trim();
          if (!text) throw new Error('Write a note first');
          await put('/api/notes', { kind: 'shot', ref: s.id, text });
          s.note = text; const g = S.shots.find((x) => x.id === s.id); if (g) g.note = text;
          toast('Note saved'); show();
        },
      });
    }
    else if (v === 'delete') {
      const s = list[i];
      const ok = await confirmBox({ title: 'Delete this screenshot?', message: `The screenshot of ${s.user_name} taken at ${tod(s.taken_at, s.tz_offset_min ?? 0)} will be removed for good. The time it covers still counts.${S.me && s.user_id !== S.me.id ? ` ${s.user_name} is told that you deleted it.` : ''}`, confirm: 'Delete', danger: true });
      if (!ok) return;
      try {
        await del(`/api/screenshots/${s.id}`);
        forgetShot(s.id);
        list.splice(i, 1);
        S.shots = S.shots.filter((x) => x.id !== s.id);
        toast('Screenshot deleted');
        if (onDeleted) onDeleted(s);
        if (!list.length) return close();
        i = Math.min(i, list.length - 1); zoom = false; show();
      } catch (err) { toast(errMsg(err), true); }
    }
  });
  viewer = { close };
  show();
}

// elapsed counters on the page (data-since="ISO")
export function tickClocks(root = document) {
  const now = nowMs();
  for (const el of root.querySelectorAll('[data-since]')) {
    const t = Date.parse(el.dataset.since);
    if (Number.isNaN(t)) continue;
    const secs = (now - t) / 1000;
    const txt = el.dataset.hm ? `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}` : clock(secs);
    if (el.textContent !== txt) el.textContent = txt;
  }
}

// ---------- the shift dial (the same drawing as the desktop app) ----------
// segs: [start, end, type] in minutes on the same axis as [lo, hi] (the shift). The ring starts at the top
// (shift start) and runs clockwise to the shift end. Returns safe markup.
let dialSeq = 0;
export function dial(segs, [lo, hi], { size = 120, stroke = 16, now = null, brk = null, ticks = false, ping = false, label = 'Shift so far', center = '', key = null } = {}) {
  const R = 100, C = 2 * Math.PI * R, span = Math.max(1, hi - lo), per = C / span, id = 'dg' + (key != null ? String(key).replace(/[^\w-]/g, '') : ++dialSeq);
  const clamp = (m) => Math.max(lo, Math.min(hi, m));
  const col = { w: `url(#${id})`, b: '#F0A800', i: '#8279A5' };
  let arcs = '', n = 0;
  for (const [s0, e0, t] of segs || []) {
    const s = clamp(s0), e = clamp(e0);
    if (e <= s) continue;
    arcs += `<circle class="arc" style="--d:${(0.15 + 0.08 * n++).toFixed(2)}s" cx="120" cy="120" r="100" fill="none" stroke="${col[t] || col.w}" stroke-width="${stroke}" stroke-dasharray="${Math.max(0.01, (e - s) * per).toFixed(2)} ${C.toFixed(1)}" stroke-dashoffset="${(-(s - lo) * per).toFixed(2)}" transform="rotate(-90 120 120)"></circle>`;
  }
  let tk = '';
  if (ticks) for (let k = 0; k * 60 <= span; k++) {
    const a = ((k * 60) / span) * 2 * Math.PI - Math.PI / 2, major = k % 3 === 0;
    const r1 = R + stroke / 2 + 5, r2 = R + stroke / 2 + (major ? 12 : 8);
    tk += `<line class="tick${major ? ' major' : ''}" x1="${(120 + r1 * Math.cos(a)).toFixed(1)}" y1="${(120 + r1 * Math.sin(a)).toFixed(1)}" x2="${(120 + r2 * Math.cos(a)).toFixed(1)}" y2="${(120 + r2 * Math.sin(a)).toFixed(1)}" stroke-width="${major ? 2 : 1.4}" stroke-linecap="round"></line>`;
  }
  let sc = '';
  if (brk && brk[1] > brk[0]) {
    const rs = R + stroke / 2 + 5, cs = 2 * Math.PI * rs;
    sc = `<circle class="sched" cx="120" cy="120" r="${rs}" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(((clamp(brk[1]) - clamp(brk[0])) / span) * cs).toFixed(1)} ${cs.toFixed(1)}" stroke-dashoffset="${(-((clamp(brk[0]) - lo) / span) * cs).toFixed(1)}" transform="rotate(-90 120 120)"></circle>`;
  }
  let nw = '';
  if (now != null && now >= lo && now <= hi) {
    const a = ((now - lo) / span) * 2 * Math.PI - Math.PI / 2, x = (120 + R * Math.cos(a)).toFixed(1), y = (120 + R * Math.sin(a)).toFixed(1);
    nw = (ping ? `<circle class="ping" cx="${x}" cy="${y}" r="9" fill="none" stroke-width="2"></circle>` : '') + `<circle class="nowdot" cx="${x}" cy="${y}" r="${stroke < 20 ? 9 : 13}" stroke-width="${stroke < 20 ? 4 : 6}"></circle>`;
  }
  const svg = `<svg class="dial" width="${size}" height="${size}" viewBox="-14 -14 268 268" role="img" aria-label="${esc(label)}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2BD08F"></stop><stop offset="1" stop-color="#0E9A63"></stop></linearGradient></defs><circle class="track" cx="120" cy="120" r="100" fill="none" stroke-width="${stroke}"></circle>${tk}${sc}${arcs}${nw}</svg>`;
  return raw(`<span class="dialbox" style="width:${size}px;height:${size}px">${svg}${center ? `<span class="dial-c">${String(center)}</span>` : ''}</span>`);
}
