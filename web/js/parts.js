// Page-level pieces used by more than one page.
import { html, raw, esc, icon, dur, tod, todOn, reasonLabel, dayLong, todayIn, addDays, STOP, tzLabel, plural, ZONES, zoneName, zoneOffset, zoneShort } from './util.js';
import { S, empty, tag, ribbon, ribbonAxis, ribbonLegend, qAttr, dateNav } from './ui.js';
import { get } from './api.js';

// Choices for a time zone picker. Values: "" (the default), "z:<zone>" or "o:<minutes>" for an old fixed offset.
let allZones = null;
export function zoneOptions(cur, { fixed = null, inherit = null } = {}) {
  const common = new Set(ZONES.map((z) => z[0]));
  if (!allZones) { try { allZones = Intl.supportedValuesOf('timeZone').filter((z) => !common.has(z) && z.includes('/')); } catch { allZones = []; } }
  const off = (z) => tzLabel(zoneOffset(z));
  const opt = (z, label) => html`<option value="z:${z}" ${z === cur ? raw('selected') : ''}>${label}</option>`;
  const known = !cur || common.has(cur) || allZones.includes(cur);
  return html`${inherit ? html`<option value="" ${!cur && fixed == null ? raw('selected') : ''}>${inherit}</option>` : ''}${!cur && fixed != null ? html`<option value="o:${fixed}" selected>${tzLabel(fixed)}, fixed (pick a place so daylight saving is followed)</option>` : ''}
    <optgroup label="Common">${ZONES.map(([z]) => opt(z, `${zoneName(z)} · ${off(z)}`))}</optgroup>
    ${known ? '' : opt(cur, `${cur} · ${off(cur)}`)}
    ${allZones.length ? html`<optgroup label="Every time zone">${allZones.map((z) => opt(z, `${z.replace(/_/g, ' ')} · ${off(z)}`))}</optgroup>` : ''}`;
}
// reads a zone picker back: { tz_name, tz_offset_min } or null when it was left on an old fixed offset
export function readZone(v) {
  if (!v) return { tz_name: null, tz_offset_min: null };
  if (v.startsWith('z:')) return { tz_name: v.slice(2), tz_offset_min: null };
  return null;
}

export const isMgr = () => S.me.role === 'owner' || S.me.role === 'manager';
// "Today" as a work day: with a night shift, 1 AM still belongs to the shift that began the evening before.
export const companyToday = () => todayIn(S.settings.tz_offset_min - (S.settings.day_start_min || 0));
export const myToday = () => todayIn((S.me.tz_offset_min ?? S.settings.tz_offset_min) - (S.me.day_start_min || 0));

// The people list changes rarely: pages use the copy already here and refresh it in the background
// (at most once a minute, or straight away after someone is added or changed).
let peopleAt = 0, peopleLoading = null;
export function invalidatePeople() { peopleAt = 0; }
export async function loadPeople() {
  if (!isMgr()) return [];
  const fetchIt = () => (peopleLoading = peopleLoading || get('/api/users').then((list) => {
    S.people = list.filter((u) => u.active && u.tracks_time); peopleAt = Date.now(); return S.people;
  }).finally(() => { peopleLoading = null; }));
  if (peopleAt && Array.isArray(S.people)) {
    if (Date.now() - peopleAt > 60000) fetchIt().catch(() => {});
    return S.people;
  }
  return fetchIt();
}

export function dayNav(day, today, label) {
  return dateNav({
    label: label || dayLong(day),
    prevQ: qAttr('day', addDays(day, -1)), nextQ: qAttr('day', addDays(day, 1)),
    nextDisabled: day >= today, todayQ: qAttr('day', ''), todayShown: day !== today,
  });
}

export function select({ q, value, options, label, wide }) {
  return html`<label class="sr" for="sel-${q}" data-k="lbl-${q}">${label}</label><select id="sel-${q}" data-q="${q}" data-k="sel-${q}" aria-label="${label}">${options.map(([v, t]) => html`<option value="${v}" ${String(v) === String(value) ? raw('selected') : ''}>${t}</option>`)}</select>`;
}
export const teamSelect = (value) => (S.teams.length > 1 || (S.teams.length === 1 && isMgr()) ? select({ q: 'team', value: value || '', label: 'Team', options: [['', 'All teams'], ...S.teams.map((t) => [t.id, t.name])] }) : '');

// every pause in the day, newest last, with a note about screenshots
export function breaksList(breaks, tz, { note = true } = {}) {
  if (!breaks.length) return empty('No breaks yet', 'Every pause, with its reason and length, will be listed here.');
  return html`<ul class="blist">${breaks.map((b) => html`<li data-k="b${b.id}">
      <i class="dotbox" style="background:${b.type === 'idle' ? 'var(--idle)' : b.type === 'away' ? 'var(--line)' : 'var(--brk)'}"></i>
      <span class="what">${b.type === 'idle' ? 'Idle: no keyboard or mouse activity' : b.type === 'away' ? 'Computer asleep or off' : reasonLabel(b.reason)}${b.type === 'idle' ? html` <span class="faint small">${b.counted ? '(timer kept running, counted as work, no screenshots)' : '(timer paused itself)'}</span>` : b.type === 'away' ? html` <span class="faint small">(not counted; the timer carried on afterwards)</span>` : ''}</span>
      <span class="len num">${b.open ? html`<span data-since="${b.started_at}"></span>` : dur(b.secs)}</span>
      <span class="when num">${tod(b.started_at, tz)} to ${b.open ? 'now' : tod(b.ended_at, tz)}</span></li>`)}</ul>
    ${note ? html`<p class="small muted" style="padding:10px 18px 14px;border-top:1px solid var(--line-2)">No screenshots are taken during a pause or while idle. Paused time is not counted as work; idle time is counted but shown separately.</p>` : ''}`;
}

// ---------- Breaks and pauses, readable even on a messy day ----------
// Three kinds: breaks the person took (Pause), the computer asleep or off (not counted), and idle
// stretches (counted, no screenshots). Automatic ones that come in quick succession (a laptop that keeps
// dozing off) are folded into one row that opens to show each one.
const KIND = (b) => (b.type === 'idle' ? 'idle' : b.type === 'away' ? 'away' : 'break');
const KIND_LABEL = { break: 'Break', away: 'Computer asleep or off', idle: 'Idle' };
const FOLD_GAP_MS = 5 * 60000;
const VISIBLE_ROWS = 8;

function pauseRow(b, tz, day, sub = false) {
  const k = KIND(b);
  const label = k === 'break' ? reasonLabel(b.reason) : k === 'idle' && !b.counted ? 'Idle (timer paused itself)' : KIND_LABEL[k];
  return html`<li class="pz${sub ? ' sub' : ''}" data-k="b${b.id}"><i class="pz-dot ${k}"></i>
    <span class="pz-what">${label}</span>
    <span class="pz-when num">${todOn(b.started_at, tz, day)} – ${b.open ? 'now' : todOn(b.ended_at, tz, day)}</span>
    <span class="pz-len num">${b.open ? html`<span data-since="${b.started_at}"></span>` : b.secs < 60 ? '<1m' : dur(b.secs)}</span></li>`;
}

function foldRow(run, tz, day) {
  const n = { away: 0, idle: 0 }, secs = { away: 0, idle: 0 };
  for (const b of run) { const k = KIND(b); n[k]++; secs[k] += b.secs || 0; }
  const both = n.away && n.idle;
  const title = both ? 'Asleep and idle, on and off' : n.away ? 'Computer asleep or off, on and off' : 'Idle, on and off';
  const first = run[0], last = run[run.length - 1];
  const lenTxt = [n.away ? `${dur(secs.away)} asleep` : '', n.idle ? `${dur(secs.idle)} idle` : ''].filter(Boolean).join(' · ');
  return html`<li class="pz fold" data-k="f${first.id}"><details><summary>
      <i class="pz-dot ${both ? 'mixed' : n.away ? 'away' : 'idle'}"></i>
      <span class="pz-what">${title} <span class="pz-n">${run.length} times</span></span>
      <span class="pz-when num">${todOn(first.started_at, tz, day)} – ${last.open ? 'now' : todOn(last.ended_at, tz, day)}</span>
      <span class="pz-len num">${lenTxt}</span></summary>
    <ul class="pz-list">${run.map((b) => pauseRow(b, tz, day, true))}</ul></details></li>`;
}

export function breaksPanel(breaks, tz, day) {
  if (!breaks.length) return empty('No breaks or pauses', 'Every break, with its reason and length, is listed here.');
  const list = [...breaks].sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  const tot = { break: [0, 0], away: [0, 0], idle: [0, 0] };
  for (const b of list) { const t = tot[KIND(b)]; t[0]++; t[1] += b.secs || 0; }
  // fold automatic pauses that follow each other closely
  const rows = [];
  for (const b of list) {
    const auto = KIND(b) !== 'break';
    const last = rows[rows.length - 1];
    if (auto && last && last.auto && !last.items[last.items.length - 1].open && Date.parse(b.started_at) - Date.parse(last.items[last.items.length - 1].ended_at) <= FOLD_GAP_MS) last.items.push(b);
    else rows.push({ auto, items: [b] });
  }
  const render = (r) => (r.items.length > 1 ? foldRow(r.items, tz, day) : pauseRow(r.items[0], tz, day));
  const shown = rows.length > VISIBLE_ROWS + 2 ? rows.slice(0, VISIBLE_ROWS) : rows;
  const rest = rows.slice(shown.length);
  const stat = (k, note) => html`<div class="pz-stat ${tot[k][0] ? '' : 'none'}"><i class="pz-dot ${k}"></i><span><b class="num">${tot[k][0] ? dur(tot[k][1]) : 'None'}</b><span class="muted">${k === 'break' ? 'Breaks' : k === 'away' ? 'Asleep or off' : 'Idle'}${tot[k][0] ? ' · ' + tot[k][0] : ''}</span><span class="faint">${note}</span></span></div>`;
  return html`<div class="pzc"><div class="pz-sum">${stat('break', 'Not counted')}${stat('away', 'Not counted')}${stat('idle', 'Counted as work')}</div>
    <ul class="pz-rows">${shown.map(render)}</ul>
    ${rest.length ? html`<details class="pz-more" data-k="pzmore"><summary>Show ${plural(rest.length, 'more row')}</summary><ul class="pz-rows">${rest.map(render)}</ul></details>` : ''}
    <p class="pz-foot small muted">No screenshots are taken during any of these. Rows marked “on and off” group pauses that came within 5 minutes of each other; open one to see each.</p></div>`;
}

export function sessionsList(entries, tz) {
  if (!entries.length) return empty('No timer sessions', 'A session is the time between pressing Start and Stop.');
  return html`<div class="tbl-wrap"><table class="t stack"><thead><tr><th>Started</th><th>Stopped</th><th>Project</th><th class="r">Worked</th><th>How it ended</th></tr></thead><tbody>
    ${entries.map((e) => html`<tr data-k="e${e.id}"><td class="num">${e.started_before_day ? 'Before midnight' : tod(e.started_at, tz)}</td>
      <td class="num">${e.ended_at ? tod(e.ended_at, tz) : tag('working', 'Running')}</td>
      <td>${e.project || html`<span class="muted">No project</span>`}${e.task ? html` <span class="muted">· ${e.task}</span>` : ''}${e.source === 'manual' ? html` ${tag('pending', 'Added by hand')}` : ''}</td>
      <td class="r num"><b>${dur(e.worked_secs)}</b></td>
      <td class="muted small">${e.ended_at ? (STOP[e.stop_reason] || 'Stopped') : 'Still running'}</td></tr>`)}
    </tbody></table></div>`;
}

export function dayRibbonBlock(segs, win, { nowMin, shift, brk, ds = 0 } = {}) {
  return html`${ribbon(segs, win, { large: true, nowMin, shift, brk, ds })}${ribbonAxis(win, { ds })}<div style="margin-top:6px">${ribbonLegend(!!brk)}</div>`;
}

export const tzNote = (tz) => `Times are shown in ${tzLabel(tz)}`;
// For someone outside the company time zone: "New York time", so their clock times are read as theirs.
const companyTzNow = () => (S.settings.tz_name ? zoneOffset(S.settings.tz_name) : S.settings.tz_offset_min);
export const zoneWord = (r) => (r && r.tz_offset_min != null && r.tz_offset_min !== companyTzNow() ? `${r.tz_name ? zoneShort(r.tz_name) : tzLabel(r.tz_offset_min)} time` : '');
export const zoneBadge = (r) => { const w = zoneWord(r); return w ? html`<span class="tzc" title="Their clock times are in ${w}">${icon('clock')}${w}</span>` : ''; };
export const withZone = (sub, r) => [sub, zoneWord(r)].filter(Boolean).join(' · ');

