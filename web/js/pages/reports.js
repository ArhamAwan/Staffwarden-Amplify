import { html, raw, dur, pctText, dayShort, dayMD, addDays, mondayOf, monthKey, monthStart, monthEnd, addMonths, plural, hoursText } from '../util.js';
import { get, qs } from '../api.js';
import { S, actions, kpis, empty, meter, qAttr } from '../ui.js';
import { teamSelect, companyToday } from '../parts.js';

function presets(today) {
  const mon = mondayOf(today), m = monthKey(today);
  return [
    ['This week', mon, addDays(mon, 6)], ['Last week', addDays(mon, -7), addDays(mon, -1)],
    ['This month', monthStart(m), monthEnd(m)], ['Last month', monthStart(addMonths(m, -1)), monthEnd(addMonths(m, -1))],
    ['Last 30 days', addDays(today, -29), today],
  ];
}

export default {
  title: 'Reports',
  async load(q) {
    const today = companyToday();
    const from = q.get('from') || mondayOf(today), to = q.get('to') || addDays(mondayOf(today), 6);
    const group = q.get('group') || 'member';
    const [r, teams] = await Promise.all([get(`/api/reports${qs({ from, to, group, team_id: q.get('team') })}`), get('/api/teams')]);
    S.teams = teams;
    return { r, from, to, group, today };
  },
  render({ r, from, to, group, today }, q) {
    const rows = r.rows;
    const worked = rows.reduce((n, x) => n + x.worked_secs, 0);
    const maxW = Math.max(1, ...rows.map((x) => x.worked_secs));
    const actW = rows.reduce((n, x) => n + (x.activity_pct == null ? 0 : x.activity_pct * x.worked_secs), 0);
    const sum = (k) => rows.reduce((n, x) => n + x[k], 0);
    const full = group !== 'project';
    const cells = [
      { label: 'Total worked', value: dur(worked), foot: `${dayMD(from)} to ${dayMD(to)}` },
      ...(full ? [
        { label: 'Activity', value: pctText(worked ? Math.round(actW / worked) : null), foot: 'Weighted by hours' },
        { label: 'Breaks', value: dur(sum('break_secs')), foot: 'Not counted as work' },
        { label: 'Idle', value: dur(sum('idle_secs')), foot: 'No input, still counted as work' },
        { label: 'Late days', value: String(sum('late_days')), tone: sum('late_days') ? 'warn' : '', foot: 'Started after the grace period' },
        { label: 'Absent days', value: String(sum('absent_days')), tone: sum('absent_days') ? 'bad' : '', foot: 'No work and no leave' },
      ] : [{ label: 'Projects', value: String(rows.length), foot: 'With time tracked' }]),
    ];
    const label = { member: 'Person', project: 'Project', day: 'Day' }[group];
    const active = presets(today).find((p) => p[1] === from && p[2] === to);
    const exportQ = `from=${from}&to=${to}${q.get('team') ? '&team_id=' + q.get('team') : ''}`;
    return html`
      <div class="page-h"><div><h1>Reports</h1><p class="sub">Hours, breaks, activity and attendance for any period</p></div>
        <div class="tools">${teamSelect(q.get('team'))}<button class="btn" data-act="csv" data-query="${exportQ}" data-name="timesheets-${from}-to-${to}.csv">Export CSV</button></div></div>
      <section class="panel"><div class="body rp-filter">
        <div class="seg" role="group" aria-label="Group by">${[['member', 'By person'], ['project', 'By project'], ['day', 'By day']].map(([v, t]) => html`<button type="button" data-act="q" ${raw(qAttr('group', v))} aria-pressed="${String(group === v)}">${t}</button>`)}</div>
        <div class="chips" role="group" aria-label="Period">${presets(today).map((p) => html`<button type="button" class="chip" aria-pressed="${String(active === p)}" data-act="range" data-from="${p[1]}" data-to="${p[2]}">${p[0]}</button>`)}</div>
        <div class="inline-form rp-dates"><div><label class="f" for="rf">From</label><input id="rf" type="date" value="${from}" data-q="from"></div><div><label class="f" for="rt">To</label><input id="rt" type="date" value="${to}" data-q="to"></div></div></div></section>
      ${kpis(cells)}
      <section class="panel flush"><div class="body">${rows.length ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>${label}</th><th style="min-width:200px">Worked</th>${full ? html`<th class="r">Breaks</th><th class="r">Idle</th><th class="r">Activity</th>` : ''}<th class="r">Days worked</th>${full ? html`<th class="r">Late</th><th class="r">Absent</th><th class="r">Screenshots</th>` : ''}</tr></thead><tbody>
        ${rows.map((x) => html`<tr data-k="${x.key}"><td><b>${group === 'day' ? dayShort(x.label) : x.label}</b></td>
          <td><span class="pct"><b class="num" style="min-width:64px">${dur(x.worked_secs)}</b>${meter((100 * x.worked_secs) / maxW)}</span></td>
          ${full ? html`<td class="r num">${dur(x.break_secs)}</td><td class="r num">${dur(x.idle_secs)}</td><td class="r num">${pctText(x.activity_pct)}</td>` : ''}
          <td class="r num">${x.days_worked}</td>${full ? html`<td class="r num">${x.late_days || '–'}</td><td class="r num">${x.absent_days || '–'}</td><td class="r num">${x.shots}</td>` : ''}</tr>`)}</tbody></table></div>` : empty('No data for this period', 'Try a longer period or another team.')}</div></section>`;
  },
};

actions.range = (el) => {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  p.set('from', el.dataset.from); p.set('to', el.dataset.to);
  location.hash = `#/reports?${p}`;
};
