import { rel, relRange, html, dur, pctText, dayLong, tod, minOfDayIn, todayIn, tzLabel, tzShort, hourLabel, hhmmText, plural, ATT, shiftText } from '../util.js';
import { get, qs } from '../api.js';
import { S, kpis, tag, attTag, liveTag, stateTags, person, windowFor, bars, toneFor, empty, shotGroups, setShots, dial } from '../ui.js';
import { isMgr, loadPeople, dayNav, select, breaksPanel, sessionsList, dayRibbonBlock } from '../parts.js';
import { notesPanel } from './explain.js';

function who(q) {
  if (!isMgr()) return 'me';
  let u = q.get('user');
  if (!u) { try { u = sessionStorage.getItem('at_tl_user'); } catch { /* ignore */ } }
  if (!u || (u !== 'me' && !S.people.some((p) => String(p.id) === u))) u = S.people.length ? String(S.people[0].id) : 'me';
  try { sessionStorage.setItem('at_tl_user', u); } catch { /* ignore */ }
  return u;
}

export default {
  title: 'Activity',
  async load(q) {
    await loadPeople();
    const id = who(q);
    const d = await get(`/api/users/${id}/day${qs({ day: q.get('day') })}`);
    return { d, id };
  },
  render({ d, id }, q) {
    const tz = d.user.tz_offset_min, ds = d.user.day_start_min || 0, today = todayIn(tz - ds), isToday = d.day === today;
    const att = d.attendance, lv = d.live || { state: 'offline' };
    const shift = relRange(d.user.shift_start, d.user.shift_end, ds), brk = relRange(d.user.break_start, d.user.break_end, ds);
    const win = windowFor([d.segs], shift || undefined);
    const shots = d.shots_list;
    setShots(shots);
    S.dayNotes = d.notes || [];
    // activity by hour in the person's clock
    const byHour = new Map();
    for (const a of d.activity) {
      const h = Math.floor(minOfDayIn(tz, Date.parse(a.slot_start)) / 60);
      const r = byHour.get(h) || { t: 0, a: 0 };
      r.t += a.tracked_secs; r.a += a.active_secs; byHour.set(h, r);
    }
    const hours = Array.from(byHour.keys()).sort((a, b) => rel(a * 60, ds) - rel(b * 60, ds));   // in shift order, also past midnight
    const cells = [   // worked, breaks, idle and activity are in the band above
      { label: 'First start', value: d.first_start ? tod(d.first_start, tz) : '–', tone: att.late_by_min ? 'warn' : '', foot: att.late_by_min ? `${att.late_by_min} min after shift start` : `Shift starts ${hhmmText(d.user.shift_start)}` },
      { label: 'Last stop', value: d.running ? 'Running' : d.last_end ? tod(d.last_end, tz) : '–', foot: `Shift ends ${hhmmText(d.user.shift_end)}` },
      { label: 'Sessions', value: String(d.sessions), foot: d.sessions === 1 ? 'One start and stop' : 'Starts and stops' },
      { label: 'Screenshots', value: String(d.shots), foot: d.last_shot_at ? `Last at ${tod(d.last_shot_at, tz)}` : 'None yet' },
    ];
    return html`
      <div class="page-h"><div><h1>${d.user.name}</h1><p class="sub">${d.user.title ? d.user.title + ' · ' : ''}Work day ${dayLong(d.day)} · shift ${shiftText(d.user.shift_start, d.user.shift_end)} · ${tzShort(d.user.tz_name, tz)}</p></div>
        <div class="tools">${isMgr() ? select({ q: 'user', value: id, label: 'Person', options: S.people.map((p) => [p.id, p.name]) }) : ''}${dayNav(d.day, today)}</div>
        <div class="hero hero-day">${dial(d.segs, shift || win, { size: 232, stroke: 14, ticks: true, now: isToday ? rel(minOfDayIn(tz), ds) : null, brk, ping: lv.state === 'working', key: 'tl', label: `${d.user.name}'s shift so far`, center: html`<span class="cap">Worked</span><b class="big num">${dur(d.worked_secs)}</b><span class="cap">${att.expected_secs ? 'of ' + dur(att.expected_secs) : 'Not a working day'}</span>` })}
          <div class="hero-side"><div class="hero-tags">${isToday ? stateTags({ ...lv, tz_offset_min: tz }, att.status) : attTag(att.status)}${att.holiday ? html`<span class="muted">${att.holiday}</span>` : ''}${att.extra ? tag('pending', 'Worked on a day off') : ''}</div>
            <div class="hero-stats"><div><span>Breaks</span><b class="num">${dur(d.break_secs)}</b><small>${d.break_count ? plural(d.break_count, 'break') : 'None'}</small></div><div><span>Idle</span><b class="num">${dur(d.idle_secs)}</b><small>Still counted as work</small></div><div><span>Activity</span><b class="num">${pctText(d.activity_pct)}</b><small>Keyboard and mouse</small></div></div>
            <div class="hero-legend"><span><i class="sw s-working"></i>Working</span><span><i class="sw s-break"></i>Break</span><span><i class="sw s-idle"></i>Idle</span>${brk ? html`<span><i class="sw sched"></i>Scheduled break</span>` : ''}</div></div></div></div>
      ${kpis(cells)}
      <section class="panel"><header><h2>Timeline</h2><span class="muted small">The blue line under the bar is the scheduled shift${brk ? "; the striped part is the scheduled break" : ""}</span></header>
        <div class="body">${dayRibbonBlock(d.segs, win, { nowMin: isToday ? rel(minOfDayIn(tz), ds) : null, shift, brk, ds })}</div></section>
      ${notesPanel(d, { isMgr: isMgr(), today })}
      <section class="panel flush"><header><h2>Breaks and pauses</h2></header><div class="body">${breaksPanel(d.breaks, tz, d.day)}</div></section>
      <div class="cols">
        <section class="panel flush"><header><h2>Timer sessions</h2></header><div class="body">${sessionsList(d.entries, tz)}</div></section>
        <section class="panel"><header><h2>Time by project</h2></header><div class="body">
          ${d.by_project.length ? html`<ul class="steps" style="list-style:none;margin:0;padding:0">${d.by_project.map((p) => html`<li data-k="p${p.project_id ?? 0}" style="display:flex;justify-content:space-between;gap:10px"><span>${p.name}</span><b class="num">${dur(p.secs)}</b></li>`)}</ul>` : html`<p class="muted">No time tracked.</p>`}</div></section>
      </div>
      ${hours.length ? html`<section class="panel"><header><h2>Activity by hour</h2><span class="muted small">Share of each hour with keyboard or mouse input</span></header><div class="body">
        ${bars(hours.map((h) => { const r = byHour.get(h); return { label: hourLabel(h), value: r.t ? Math.round((100 * r.a) / r.t) : 0, title: `${hourLabel(h)}: ${r.t ? Math.round((100 * r.a) / r.t) : 0}% active` }; }), { max: 100, fmt: (v) => v + '%' })}</div></section>` : ''}
      <section class="panel"><header><h2>Screenshots</h2><span class="muted small">${plural(shots.length, 'screenshot')}, grouped into stretches of work</span></header><div class="body">
        ${shots.length ? shotGroups(shots, { day: d.day }) : empty('No screenshots', 'Screenshots are only taken while the timer is running, never during breaks.')}</div></section>`;
  },
};
