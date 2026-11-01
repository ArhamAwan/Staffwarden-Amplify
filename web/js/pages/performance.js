// Performance: hours worked, keyboard/mouse activity and task results (done, completion, on time,
// accuracy) for a chosen period, per person and in total. Which apps or sites people use is not tracked.
import { html, raw, dur, pctText, dayShort, addDays, todayIn, mondayOf, plural } from '../util.js';
import { get, qs } from '../api.js';
import { S, kpis, toneFor, meter, empty, person, qAttr } from '../ui.js';
import { isMgr, loadPeople, select, teamSelect, companyToday, myToday } from '../parts.js';

const PERIODS = [['today', 'Today'], ['7', 'Last 7 days'], ['week', 'This week'], ['30', 'Last 30 days'], ['month', 'This month']];
function rangeFor(p, today) {
  if (p === 'today') return [today, today];
  if (p === 'week') return [mondayOf(today), today];
  if (p === '30') return [addDays(today, -29), today];
  if (p === 'month') return [today.slice(0, 8) + '01', today];
  return [addDays(today, -6), today];
}
const pctCell = (v, bad, warn) => (v == null ? html`<span class="faint">–</span>` : html`<span class="inline-meter">${meter(v, toneFor(v, bad, warn))}<span class="num">${v}%</span></span>`);

export default {
  title: 'Performance',
  async load(q) {
    const mgr = isMgr();
    const today = mgr ? companyToday() : myToday();
    const period = q.get('p') || '7';
    const [from, to] = rangeFor(period, today);
    const who = mgr ? q.get('user') || 'all' : 'me';
    const [d, teams] = await Promise.all([
      get(`/api/performance${qs({ from, to, user_id: who === 'all' ? undefined : who, team_id: who === 'all' ? q.get('team') : undefined })}`),
      mgr ? get('/api/teams') : Promise.resolve([]),
      mgr ? loadPeople() : null,
    ]);
    S.teams = teams;
    return { d, period, who };
  },
  render({ d, period, who }, q) {
    const mgr = isMgr(), k = d.kpis, t = k.tasks;
    const cells = [
      { label: 'Hours worked', value: dur(k.worked_secs), foot: d.people.length > 1 ? `${plural(d.people.length, 'person', 'people')}` : `${plural(d.people[0] ? d.people[0].days_worked : 0, 'day')} worked` },
      { label: 'Activity', value: pctText(k.activity_pct), tone: toneFor(k.activity_pct, 30, 50), meter: k.activity_pct, foot: 'Keyboard and mouse use while the timer ran' },
      { label: 'Tasks done', value: String(t.done), foot: `${t.open} still open${t.overdue_open ? `, ${t.overdue_open} overdue` : ''}` },
      { label: 'In review', value: String(t.in_review), foot: 'Waiting for approval' },
      { label: 'Completion', value: pctText(t.completion_pct), tone: toneFor(t.completion_pct, 60, 85), meter: t.completion_pct, foot: t.due ? `${t.due_done} of ${t.due} tasks due were done` : 'No deadlines in this period' },
      { label: 'On time', value: pctText(t.on_time_pct), tone: toneFor(t.on_time_pct, 60, 85), meter: t.on_time_pct, foot: t.with_due ? `${t.on_time} of ${t.with_due} finished by their deadline` : 'Nothing with a deadline finished' },
      { label: 'Accuracy', value: pctText(t.accuracy_pct), tone: toneFor(t.accuracy_pct, 60, 85), meter: t.accuracy_pct, foot: t.approved ? `${t.first_time} of ${t.approved} approved without changes` : 'Nothing reviewed yet' },
    ];
    const tools = html`<div class="seg" role="group" aria-label="Period">${PERIODS.map(([v, n]) => html`<button type="button" data-act="q" ${raw(qAttr('p', v === '7' ? '' : v))} aria-pressed="${String(period === v)}">${n}</button>`)}</div>
      ${mgr ? html`${select({ q: 'user', value: who, label: 'Person', options: [['all', 'Everyone'], ...S.people.map((p) => [p.id, p.name])] })}${who === 'all' ? teamSelect(q.get('team')) : ''}` : ''}`;
    const people = mgr && d.people.length > 1 ? html`<section class="panel flush"><header><h2>People</h2><span class="muted small">Select a person to see only them</span></header><div class="tbl-wrap"><table class="t"><thead><tr>
        <th>Person</th><th class="r">Worked</th><th>Activity</th><th class="r">Done</th><th class="r">Open</th><th class="r">Overdue</th><th>Completion</th><th>On time</th><th>Accuracy</th></tr></thead><tbody>
        ${[...d.people].sort((a, b) => b.worked_secs - a.worked_secs).map((p) => html`<tr class="link" data-k="u${p.user_id}" data-act="q" ${raw(qAttr('user', String(p.user_id)))} tabindex="0">
          <td class="nm">${person({ id: p.user_id, name: p.name }, p.title || '')}</td>
          <td class="r num">${dur(p.worked_secs)}</td>
          <td style="min-width:120px">${pctCell(p.activity_pct, 30, 50)}</td>
          <td class="r num">${p.tasks.done}</td>
          <td class="r num">${p.tasks.open}</td>
          <td class="r num">${p.tasks.overdue_open ? html`<b class="bad-ink">${p.tasks.overdue_open}</b>` : '0'}</td>
          <td style="min-width:110px">${pctCell(p.tasks.completion_pct, 60, 85)}</td>
          <td style="min-width:110px">${pctCell(p.tasks.on_time_pct, 60, 85)}</td>
          <td style="min-width:110px">${pctCell(p.tasks.accuracy_pct, 60, 85)}</td></tr>`)}
      </tbody></table></div></section>` : '';
    const none = !d.people.length ? html`<section class="panel">${empty('Nobody to show', 'People who track time appear here.')}</section>` : '';
    return html`
      <div class="page-h"><div><h1>Performance</h1><p class="sub">${d.from === d.to ? dayShort(d.from) : `${dayShort(d.from)} to ${dayShort(d.to)}`}${mgr && who === 'all' ? `, ${plural(d.people.length, 'person', 'people')}` : who !== 'all' && d.people[0] ? `, ${d.people[0].name}` : ''}</p></div><div class="tools">${tools}</div></div>
      ${kpis(cells)}${people}${none}
      <p class="small muted foot-note">Completion: tasks due in the period that were finished. On time: finished by their deadline. Accuracy: approved the first time, without being sent back. Which apps or websites people use is not tracked.</p>`;
  },
};
