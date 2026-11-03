import { html, raw, icon, dur, pctText, dayShort, dayMD, addDays, mondayOf, monthKey, monthStart, monthEnd, addMonths, plural, hoursText } from '../util.js';
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
    const [r, teams, byDay] = await Promise.all([get(`/api/reports${qs({ from, to, group, team_id: q.get('team') })}`), get('/api/teams'),
      group === 'day' ? null : get(`/api/reports${qs({ from, to, group: 'day', team_id: q.get('team') })}`).catch(() => null)]);
    S.teams = teams;
    return { r, from, to, group, today, days: group === 'day' ? r.rows : byDay ? byDay.rows : [] };
  },
  render({ r, from, to, group, today, days }, q) {
    const rows = r.rows;
    const worked = rows.reduce((n, x) => n + x.worked_secs, 0);
    const maxW = Math.max(1, ...rows.map((x) => x.worked_secs));
    const actW = rows.reduce((n, x) => n + (x.activity_pct == null ? 0 : x.activity_pct * x.worked_secs), 0);
    const sum = (k) => rows.reduce((n, x) => n + x[k], 0);
    const full = group !== 'project';
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
      ${reportBento({ rows, days, from, to, group, full, worked, act: worked ? Math.round(actW / worked) : null, sum })}
      <section class="panel flush"><div class="body">${rows.length ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>${label}</th><th style="min-width:200px">Worked</th>${full ? html`<th class="r">Breaks</th><th class="r">Idle</th><th class="r">Activity</th>` : ''}<th class="r">Days worked</th>${full ? html`<th class="r">Late</th><th class="r">Absent</th><th class="r">Screenshots</th>` : ''}</tr></thead><tbody>
        ${rows.map((x) => html`<tr data-k="${x.key}"><td><b>${group === 'day' ? dayShort(x.label) : x.label}</b></td>
          <td><span class="pct"><b class="num" style="min-width:64px">${dur(x.worked_secs)}</b>${meter((100 * x.worked_secs) / maxW)}</span></td>
          ${full ? html`<td class="r num">${dur(x.break_secs)}</td><td class="r num">${dur(x.idle_secs)}</td><td class="r num">${pctText(x.activity_pct)}</td>` : ''}
          <td class="r num">${x.days_worked}</td>${full ? html`<td class="r num">${x.late_days || '–'}</td><td class="r num">${x.absent_days || '–'}</td><td class="r num">${x.shots}</td>` : ''}</tr>`)}</tbody></table></div>` : empty('No data for this period', 'Try a longer period or another team.')}</div></section>`;
  },
};

// the period as a bento: the total, the team's hours each day, the other numbers, and who did the most
function reportBento({ rows, days, from, to, group, full, worked, act, sum }) {
  const ds = [...days].sort((a, b) => (a.label < b.label ? -1 : 1)), dmax = Math.max(1, ...ds.map((x) => x.worked_secs));
  const workedDays = ds.filter((x) => x.worked_secs > 0).length;
  const step = Math.max(1, Math.ceil(ds.length / 6));
  const top = [...rows].sort((a, b) => b.worked_secs - a.worked_secs).filter((x) => x.worked_secs).slice(0, 3);
  const t = (cls, label, ic, val, foot, tone = '') => html`<div class="kpi ${cls} ${tone}"><div class="l">${icon(ic)}${label}</div><div class="v">${val}</div><div class="f">${foot}</div></div>`;
  return html`<section class="kpis bento rp-bento${full ? '' : ' short'}" aria-label="The period at a glance">
    <div class="kpi bt-tw"><div class="l">${icon('clock')}Total worked</div><div class="v rp-big">${dur(worked)}</div><div class="f">${dayMD(from)} to ${dayMD(to)}${full && rows.length ? `, ${plural(rows.length, group === 'day' ? 'day' : 'person', group === 'day' ? 'days' : 'people')}` : ''}</div></div>
    <div class="kpi bt-ch"><div class="l">${icon('chart')}Team hours per day${workedDays ? html`<span class="bt-r">Average ${hoursText(worked / workedDays)} on working days</span>` : ''}</div>
      ${ds.length ? html`<div class="rp-bars">${ds.map((x, i) => html`<span class="rp-b" title="${dayShort(x.label)}: ${dur(x.worked_secs)}"><i style="height:${x.worked_secs ? Math.max(3, Math.round((100 * x.worked_secs) / dmax)) : 2}%" class="${x.worked_secs ? '' : 'zero'}"></i><small>${i % step === 0 ? dayMD(x.label) : ''}</small></span>`)}</div>` : html`<div class="bt-noshot">${icon('chart')}<span>No hours in this period.</span></div>`}</div>
    ${full ? html`${t('bt-ac', 'Activity', 'pulse', pctText(act), 'Weighted by hours')}
      ${t('bt-br', 'Breaks', 'pause', dur(sum('break_secs')), 'Not counted as work')}
      ${t('bt-id', 'Idle', 'sun', dur(sum('idle_secs')), 'Still counted as work')}
      ${t('bt-ld', 'Late days', 'cal', String(sum('late_days')), 'After the grace period', sum('late_days') ? 'warn' : '')}
      ${t('bt-ab', 'Absent days', 'alert', String(sum('absent_days')), 'No work, no leave', sum('absent_days') ? 'bad' : '')}
      <div class="kpi bt-mh"><div class="l">${icon('trophy')}Most hours</div>${top.length ? html`<ol class="rp-top">${top.map((x, i) => html`<li><span class="num">${i + 1}</span><b>${group === 'day' ? dayShort(x.label) : x.label}</b><span class="num">${dur(x.worked_secs)}</span></li>`)}</ol>` : html`<div class="f">Nobody has tracked time yet</div>`}</div>`
    : t('bt-ac', 'Projects', 'folder', String(rows.length), 'With time tracked')}
  </section>`;
}

actions.range = (el) => {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  p.set('from', el.dataset.from); p.set('to', el.dataset.to);
  location.hash = `#/reports?${p}`;
};
