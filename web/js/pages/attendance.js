import { html, raw, dur, pctText, dayNum, dow, addDays, monthKey, monthStart, monthEnd, addMonths, monthLabel, todayIn, tod, hhmmText, plural, LEAVE_KIND, eachDay, dayLong } from '../util.js';
import { get, qs } from '../api.js';
import { S, kpis, person, empty, qAttr, dateNav, toneFor, tag, meter } from '../ui.js';
import { isMgr, loadPeople, select, teamSelect, dayNav, companyToday, myToday, withZone } from '../parts.js';

// One word or phrase per status, the same everywhere on this page.
function statusTag(c) {
  switch (c.status) {
    case 'present': return c.running ? tag('working', 'On time, working') : tag('present', 'On time');
    case 'late': return tag('late', c.late_by_min ? `Late by ${lateText(c.late_by_min)}` : 'Late');
    case 'absent': return tag('absent', 'Absent');
    case 'not_started': return tag('not_started', 'Not started');
    case 'leave': return tag('leave', c.leave_kind ? LEAVE_KIND[c.leave_kind] || 'Time off' : 'Time off');
    case 'holiday': return tag('holiday', c.holiday || 'Holiday');
    case 'upcoming': return tag('off', 'Shift not started');
    case 'before': return tag('off', 'Not joined yet');
    default: return tag('off', c.extra ? 'Extra day' : 'Day off');
  }
}
const lateText = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`);
// Problems first, so a manager sees who needs attention without scrolling.
const ORDER = { absent: 0, not_started: 1, late: 2, present: 3, leave: 4, holiday: 5, upcoming: 6, off: 7, before: 8 };
const shiftOf = (id) => { const p = (S.people || []).find((x) => x.id === id); const e = p && p.effective; return e ? `${hhmmText(e.shift_start)} to ${hhmmText(e.shift_end)}` : ''; };

export default {
  title: 'Attendance',
  async load(q) {
    const mgr = isMgr();
    const tz = mgr ? S.settings.tz_offset_min : S.me.tz_offset_min;
    const today = mgr ? companyToday() : myToday();
    const view = mgr ? (q.get('view') === 'month' ? 'month' : 'day') : 'month';
    let who = 'me';
    if (mgr) { await loadPeople(); who = q.get('user') || 'all'; }
    const day = view === 'day' ? (q.get('day') && q.get('day') <= today ? q.get('day') : today) : null;
    const month = view === 'month' ? (q.get('month') || monthKey(today)) : null;
    const from = day || monthStart(month), to = day || monthEnd(month);
    const [g, teams] = await Promise.all([
      get(`/api/attendance${qs({ from, to, user_id: who === 'all' ? undefined : who, team_id: who === 'all' ? q.get('team') : undefined })}`),
      mgr ? get('/api/teams') : Promise.resolve([]),
    ]);
    S.teams = teams;
    return { g, view, day, month, who, today };
  },

  render(d, q) {
    const mgr = isMgr();
    const tools = html`
      ${mgr ? html`<div class="seg" role="group" aria-label="View">${[['day', 'Day'], ['month', 'Month']].map(([v, t]) => html`<button type="button" data-act="q" ${raw(qAttr('view', v === 'day' ? '' : v))} aria-pressed="${String(d.view === v)}">${t}</button>`)}</div>
        ${select({ q: 'user', value: d.who, label: 'Person', options: [['all', 'Everyone'], ...S.people.map((p) => [p.id, p.name])] })}
        ${d.who === 'all' ? teamSelect(q.get('team')) : ''}` : ''}
      ${d.view === 'day' ? dayNav(d.day, d.today) : monthNav(d.month, d.today)}`;
    const sub = d.view === 'day' ? dayLong(d.day) : mgr && d.who === 'all' ? `${monthLabel(d.month)}, ${plural(d.g.rows.length, 'person', 'people')}` : monthLabel(d.month);
    const body = d.view === 'day' ? dayView(d) : d.who === 'all' ? monthTable(d) : monthCalendar(d);
    return html`
      <div class="page-h"><div><h1>Attendance</h1><p class="sub">${sub}</p></div><div class="tools">${tools}</div></div>
      ${body}
      <p class="small muted foot-note">On time means the first start of the day was within ${S.settings.grace_min} minutes of the shift start. Absent means a working day with no tracked time and no approved time off.</p>`;
  },
};

function monthNav(month, today) {
  const now = monthKey(today);
  return dateNav({ label: monthLabel(month), prevQ: qAttr('month', addMonths(month, -1)), nextQ: qAttr('month', addMonths(month, 1)), nextDisabled: month >= now, todayQ: qAttr('month', ''), todayShown: month !== now });
}

// ---------- one day, everyone: who came in, when, and who didn't ----------
function dayView({ g, day }) {
  const rows = g.rows.map((r) => ({ r, c: r.cells[day] })).sort((a, b) => (ORDER[a.c.status] ?? 9) - (ORDER[b.c.status] ?? 9) || a.r.name.localeCompare(b.r.name));
  const n = (s) => rows.filter((x) => s.includes(x.c.status)).length;
  const came = n(['present', 'late']), absent = n(['absent']), waiting = n(['not_started']);
  const planned = came + absent + waiting;
  const rate = planned ? Math.round((100 * came) / planned) : null;
  const cells = [
    { label: 'Present', value: `${came}`, unit: planned ? `of ${planned}` : '', tone: toneFor(rate, 70, 90), meter: rate, foot: planned ? `${pctText(rate)} of people due to work` : 'Nobody was due to work' },
    { label: 'Late', value: String(n(['late'])), tone: n(['late']) ? 'warn' : '', foot: 'Started after the grace period' },
    { label: 'Absent', value: String(absent), tone: absent ? 'bad' : '', foot: 'No time tracked, no time off' },
    { label: 'Not started yet', value: String(waiting), tone: waiting ? 'warn' : '', foot: 'Shift has begun, timer not started' },
    { label: 'On time off', value: String(n(['leave', 'holiday'])), foot: 'Approved leave or a holiday' },
  ];
  if (!rows.length) return html`${kpis(cells)}<section class="panel">${empty('Nobody to show', 'Pick another team or person.')}</section>`;
  return html`${kpis(cells)}
    <section class="panel flush"><div class="tbl-wrap"><table class="t att-day stack"><thead><tr>
      <th>Person</th><th>Status</th><th>Shift</th><th>Started</th><th>Stopped</th><th class="r">Worked</th></tr></thead><tbody>
      ${rows.map(({ r, c }) => html`<tr class="link" data-k="u${r.user_id}" data-act="go" data-href="#/timeline?user=${r.user_id}&day=${day}" tabindex="0">
        <td class="nm">${person(r, withZone(r.title || '', r))}</td>
        <td>${statusTag(c)}</td>
        <td class="num muted">${shiftOf(r.user_id) || '–'}</td>
        <td class="num">${c.first_in ? tod(c.first_in, r.tz_offset_min) : html`<span class="faint">–</span>`}</td>
        <td class="num">${c.running ? html`<span class="muted">Still working</span>` : c.last_out ? tod(c.last_out, r.tz_offset_min) : html`<span class="faint">–</span>`}</td>
        <td class="num r"><b>${c.worked_secs ? dur(c.worked_secs) : html`<span class="faint">–</span>`}</b></td></tr>`)}
    </tbody></table></div></section>`;
}

// ---------- one month, everyone: a plain summary, one row each ----------
function monthKpis(g) {
  const sum = (k) => g.rows.reduce((n, r) => n + r.totals[k], 0);
  const present = sum('days_present'), late = sum('days_late'), absent = sum('days_absent');
  const attended = present + absent ? Math.round((100 * present) / (present + absent)) : null;
  const punctual = present ? Math.round((100 * (present - late)) / present) : null;
  const worked = sum('worked_secs'), expected = sum('expected_secs');
  return kpis([
    { label: 'Attendance', value: pctText(attended), tone: toneFor(attended, 70, 90), meter: attended, foot: `${plural(present, 'day')} present of ${present + absent} due` },
    { label: 'On time', value: pctText(punctual), tone: toneFor(punctual, 70, 90), meter: punctual, foot: plural(late, 'late start') },
    { label: 'Absent', value: String(absent), tone: absent ? 'bad' : 'good', foot: absent ? 'Days with no work and no time off' : 'No missed days' },
    { label: 'Time off', value: String(sum('days_leave')), foot: 'Approved days' },
    { label: 'Worked', value: dur(worked), foot: expected ? `of ${dur(expected)} expected so far` : 'Nothing expected yet' },
  ]);
}

function monthTable({ g, month }) {
  if (!g.rows.length) return html`${monthKpis(g)}<section class="panel">${empty('Nobody to show', 'Pick another team or person.')}</section>`;
  return html`${monthKpis(g)}
    <section class="panel flush"><div class="tbl-wrap"><table class="t"><thead><tr>
      <th>Person</th><th class="r">Present</th><th>On time</th><th class="r">Late</th><th class="r">Absent</th><th class="r">Time off</th><th>Worked</th></tr></thead><tbody>
      ${g.rows.map((r) => {
        const t = r.totals, ont = t.days_present ? Math.round((100 * (t.days_present - t.days_late)) / t.days_present) : null;
        const prog = t.expected_secs ? Math.round((100 * t.worked_secs) / t.expected_secs) : null;
        return html`<tr class="link" data-k="u${r.user_id}" data-act="go" data-href="#/attendance?view=month&user=${r.user_id}&month=${month}" tabindex="0">
          <td class="nm">${person(r, r.title || '')}</td>
          <td class="num r"><b>${t.days_present}</b></td>
          <td style="min-width:140px"><span class="inline-meter">${meter(ont ?? 0, toneFor(ont, 70, 90))}<span class="num">${pctText(ont)}</span></span></td>
          <td class="num r">${t.days_late || html`<span class="faint">0</span>`}</td>
          <td class="num r">${t.days_absent ? html`<b class="bad-ink">${t.days_absent}</b>` : html`<span class="faint">0</span>`}</td>
          <td class="num r">${t.days_leave || html`<span class="faint">0</span>`}</td>
          <td style="min-width:170px"><span class="inline-meter">${meter(prog ?? 0, toneFor(prog, 70, 90))}<span class="num">${dur(t.worked_secs)}</span></span></td></tr>`;
      })}
    </tbody></table></div><p class="small muted" style="padding:10px 18px 14px;border-top:1px solid var(--line-2)">Select a person to see their month as a calendar.</p></section>`;
}

// ---------- one month, one person: a calendar ----------
function monthCalendar({ g, month, today }) {
  const r = g.rows[0];
  if (!r) return html`${monthKpis(g)}<section class="panel">${empty('Nobody to show', 'Pick another person.')}</section>`;
  const days = eachDay(monthStart(month), monthEnd(month));
  const lead = (dow(days[0]) + 6) % 7; // Monday first
  const trail = (7 - ((lead + days.length) % 7)) % 7;
  const href = (day) => `#/timeline?user=${isMgr() ? r.user_id : 'me'}&day=${day}`;
  return html`${monthKpis(g)}
    <section class="panel flush">
      ${isMgr() ? html`<header><h2>${person(r, shiftOf(r.user_id))}</h2><a class="btn sm" href="#/attendance?view=month&month=${month}">Back to everyone</a></header>` : ''}
      <div class="cal" role="grid" aria-label="${monthLabel(month)}">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => html`<div class="h" role="columnheader">${w}</div>`)}
        ${Array.from({ length: lead }, (_, i) => html`<div class="d blank" data-k="l${i}"></div>`)}
        ${days.map((day) => {
          const c = r.cells[day] || { status: 'off' };
          const future = day > today;
          const quiet = future || ['off', 'before', 'upcoming'].includes(c.status);
          const inner = html`<span class="n">${dayNum(day)}</span>
            ${quiet && !c.worked_secs && !['leave', 'holiday'].includes(c.status) ? '' : statusTag(c)}
            ${c.worked_secs ? html`<span class="w num">${dur(c.worked_secs)}${c.first_in ? html`<span class="muted"> from ${tod(c.first_in, r.tz_offset_min)}</span>` : ''}</span>` : ''}`;
          const cls = `d st-${c.status}${day === today ? ' today' : ''}${quiet ? ' quiet' : ''}`;
          return future ? html`<div class="${cls}" data-k="${day}">${inner}</div>` : html`<a class="${cls}" data-k="${day}" href="${href(day)}" aria-label="${dayLong(day)}">${inner}</a>`;
        })}
        ${Array.from({ length: trail }, (_, i) => html`<div class="d blank" data-k="t${i}"></div>`)}
      </div>
    </section>`;
}
