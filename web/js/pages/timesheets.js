import { html, raw, icon, dur, hoursText, pctText, dayShort, dayNum, dowShort, dow, mondayOf, addDays, eachDay, tod, plural, dayMD, ATT, todayIn, tzLabel } from '../util.js';
import { get, qs, download } from '../api.js';
import { S, actions, ring, kpis, tag, attTag, person, meter, toneFor, empty, toast, errMsg, qAttr, dateNav, avatar, findPeople, findBox, longList, noMatch } from '../ui.js';
import { isMgr, loadPeople, select, teamSelect, companyToday, myToday, withZone } from '../parts.js';

// ---------- the week grid: one row a person, one cell a day ----------
const SORTS = [['name', 'Name'], ['most', 'Most hours'], ['least', 'Fewest hours'], ['behind', 'Furthest behind'], ['activity', 'Activity']];
const dueOf = (t) => t.expected_done_secs ?? t.expected_secs;
const sorters = {
  name: (a, b) => a.name.localeCompare(b.name),
  most: (a, b) => b.totals.worked_secs - a.totals.worked_secs,
  least: (a, b) => a.totals.worked_secs - b.totals.worked_secs,
  behind: (a, b) => (a.totals.worked_secs - dueOf(a.totals)) - (b.totals.worked_secs - dueOf(b.totals)),
  activity: (a, b) => (b.totals.activity_pct ?? -1) - (a.totals.activity_pct ?? -1),
};
const pace = (worked, due) => {
  if (!due) return worked ? html`<span class="tsg-pace">No hours due</span>` : html`<span class="tsg-pace faint">Nothing due yet</span>`;
  const d = worked - due;
  if (Math.abs(d) < 900) return html`<span class="tsg-pace ok">On pace</span>`;
  return d > 0 ? html`<span class="tsg-pace ok">${dur(d)} ahead</span>` : html`<span class="tsg-pace ${worked < due * 0.85 ? 'bad' : 'warn'}">${dur(-d)} behind</span>`;
};
const fill = (worked, of) => (of ? Math.min(100, Math.round((100 * worked) / of)) : 0);

function dayCell(r, d, c, today) {
  const isToday = d === today;
  const cls = `tsg-d${dow(d) % 6 === 0 ? ' we' : ''}${isToday ? ' today' : ''}`;
  if (c.worked_secs > 0 || c.running) {
    const tip = [dayShort(d), `${dur(c.worked_secs)} worked${c.expected_secs ? ` of ${dur(c.expected_secs)}` : ''}`,
      c.late_by_min ? `started ${c.late_by_min} min late` : '', c.running ? 'timer running now' : '', c.extra ? 'on a day off' : ''].filter(Boolean).join('. ');
    const f = c.expected_secs ? fill(c.worked_secs, c.expected_secs) : 100;
    return html`<td class="${cls}"><a class="tsg-c${c.late_by_min ? ' late' : ''}${c.running ? ' live' : ''}${c.extra ? ' extra' : ''}" href="#/timeline?user=${r.user_id}&day=${d}" title="${tip}" aria-label="${tip}">
      <span class="tsg-h num">${dur(c.worked_secs)}</span><span class="tsg-bar"><i class="${f >= 100 ? 'full' : ''}" style="width:${f}%"></i></span></a></td>`;
  }
  const word = { absent: 'Absent', leave: 'Leave', holiday: 'Holiday', not_started: 'Not started' }[c.status];
  const tip = c.status === 'holiday' && c.holiday ? c.holiday : c.status === 'leave' && c.leave_kind ? `On leave (${c.leave_kind})` : ATT[c.status] || '';
  return html`<td class="${cls}">${word ? html`<span class="tsg-x ${c.status}" title="${tip}">${word}</span>` : html`<span class="tsg-x none" title="${tip}">–</span>`}</td>`;
}

function grid(g, days, today, q) {
  const sort = sorters[q.get('sort')] ? q.get('sort') : 'name';
  const found = findPeople([...g.rows].sort(sorters[sort]), q), pg = longList(found, q), rows = pg.items;
  const dayTot = (d) => g.rows.reduce((n, r) => n + r.cells[d].worked_secs, 0);
  const dayDue = (d) => g.rows.reduce((n, r) => n + (r.cells[d].expected_secs || 0), 0);
  const worked = g.rows.reduce((n, r) => n + r.totals.worked_secs, 0), due = g.rows.reduce((n, r) => n + dueOf(r.totals), 0);
  const actW = g.rows.reduce((n, r) => n + (r.totals.activity_pct == null ? 0 : r.totals.activity_pct * r.totals.worked_secs), 0);
  const act = worked ? Math.round(actW / worked) : null;
  const week = q.get('week') ? `&week=${q.get('week')}` : '';
  return html`<header class="tsg-head"><h2>Hours by day</h2>
      <div class="tsg-tools"><span class="tsg-key" aria-hidden="true"><span><i class="k-live"></i>Timer running</span><span><i class="k-late"></i>Started late</span><span><i class="k-bar"></i>Share of the day’s hours</span></span>
      ${findBox(q)}<span class="tsg-sort"><span aria-hidden="true">Sort by</span>${select({ q: 'sort', value: sort, label: 'Sort people by', options: SORTS })}</span></div></header>
    ${found.length ? '' : html`<div class="body">${noMatch(q)}</div>`}
    <div class="tbl-wrap tsg-wrap"><table class="t grid tsg"><thead><tr><th class="nm">Person</th>
      ${days.map((d) => html`<th class="tsg-dh${dow(d) % 6 === 0 ? ' we' : ''}${d === today ? ' today' : ''}"><span>${dowShort(d)}</span><b>${dayNum(d)}</b>${d === today ? html`<em>Today</em>` : ''}</th>`)}
      <th class="tsg-wk">Week</th><th class="tsg-act">Activity</th></tr></thead><tbody>
      ${rows.map((r) => { const t = r.totals, rd = dueOf(t); return html`<tr data-k="u${r.user_id}"><td class="nm"><a class="tsg-p" href="#/timesheets?user=${r.user_id}${week}" title="Open ${r.name}’s week">${person(r, withZone(r.title, r))}</a></td>
        ${days.map((d) => dayCell(r, d, r.cells[d], today))}
        <td class="tsg-wk"><span class="tsg-tot"><b class="num">${dur(t.worked_secs)}</b>${rd ? html`<span class="num">of ${dur(rd)}</span>` : ''}</span>
          <span class="tsg-bar"><i class="${rd && t.worked_secs >= rd ? 'full' : ''}" style="width:${fill(t.worked_secs, rd)}%"></i></span>${pace(t.worked_secs, rd)}</td>
        <td class="tsg-act">${t.activity_pct == null ? html`<span class="faint">–</span>` : html`<span class="pct">${meter(t.activity_pct, toneFor(t.activity_pct, 35, 50))}<span class="num">${t.activity_pct}%</span></span>`}</td></tr>`; })}
      </tbody><tfoot><tr><td class="nm"><b>Everyone</b><span class="muted small">${plural(g.rows.length, 'person', 'people')}</span></td>
        ${days.map((d) => { const w = dayTot(d), e = dayDue(d); return html`<td class="tsg-d${dow(d) % 6 === 0 ? ' we' : ''}${d === today ? ' today' : ''}">${w ? html`<span class="tsg-h num">${dur(w)}</span><span class="tsg-bar"><i style="width:${fill(w, e) || (w ? 100 : 0)}%"></i></span>` : html`<span class="tsg-x none">–</span>`}</td>`; })}
        <td class="tsg-wk"><span class="tsg-tot"><b class="num">${dur(worked)}</b>${due ? html`<span class="num">of ${dur(due)}</span>` : ''}</span><span class="tsg-bar"><i style="width:${fill(worked, due)}%"></i></span>${pace(worked, due)}</td>
        <td class="tsg-act">${act == null ? html`<span class="faint">–</span>` : html`<span class="pct">${meter(act, toneFor(act, 35, 50))}<span class="num">${act}%</span></span>`}</td></tr></tfoot></table></div>${pg.more}`;
}


export default {
  title: 'Timesheets',
  async load(q) {
    const tz = isMgr() ? S.settings.tz_offset_min : S.me.tz_offset_min;
    const anchor = q.get('week') || (isMgr() ? companyToday() : myToday());
    const from = mondayOf(anchor), to = addDays(from, 6);
    let who = 'me';
    if (isMgr()) { await loadPeople(); who = q.get('user') || 'all'; }
    const [g, teams] = await Promise.all([
      get(`/api/timesheets${qs({ from, to, user_id: who === 'all' ? undefined : who, team_id: who === 'all' ? q.get('team') : undefined })}`),
      isMgr() ? get('/api/teams') : Promise.resolve([]),
    ]);
    S.teams = teams;
    return { g, who, from, to, tz };
  },
  render({ g, who, from, to, tz }, q) {
    const today = isMgr() ? companyToday() : myToday();
    const thisWeek = mondayOf(today);
    const nav = dateNav({ label: `${dayMD(from)} to ${dayMD(to)}`, prevQ: qAttr('week', addDays(from, -7)), nextQ: qAttr('week', addDays(from, 7)), nextDisabled: from >= thisWeek, todayQ: qAttr('week', ''), todayShown: from !== thisWeek });
    const single = g.rows.length === 1;
    const sum = (f) => g.rows.reduce((n, r) => n + f(r.totals), 0);
    const worked = sum((t) => t.worked_secs), expected = sum((t) => t.expected_done_secs ?? t.expected_secs);
    const actW = g.rows.reduce((n, r) => n + (r.totals.activity_pct == null ? 0 : r.totals.activity_pct * r.totals.worked_secs), 0);
    const days = g.days;
    let table;
    if (!g.rows.length) table = empty('Nobody to show', 'Pick another team or person.');
    else if (single) {
      const r = g.rows[0];
      table = html`<div class="tbl-wrap"><table class="t stack"><thead><tr><th>Day</th><th>Status</th><th>First start</th><th>Last stop</th><th class="r">Worked</th><th class="r">Breaks</th><th class="r">Idle</th><th class="r">Activity</th><th class="r">Expected</th><th class="r">Shots</th></tr></thead><tbody>
        ${days.map((d) => { const c = r.cells[d]; const link = `#/timeline?user=${r.user_id === S.me.id && !isMgr() ? 'me' : r.user_id}&day=${d}`; return html`<tr class="link" data-k="d${d}" data-act="go" data-href="${link}" tabindex="0">
          <td><b>${dayShort(d)}</b></td><td>${attTag(c.status)}${c.late_by_min ? html` <span class="small muted">${c.late_by_min} min</span>` : ''}${c.holiday ? html` <span class="small muted">${c.holiday}</span>` : ''}</td>
          <td class="num">${c.first_in ? tod(c.first_in, r.tz_offset_min) : html`<span class="faint">–</span>`}</td><td class="num">${c.running ? tag('working', 'Running') : c.last_out ? tod(c.last_out, r.tz_offset_min) : html`<span class="faint">–</span>`}</td>
          <td class="r num"><b>${c.worked_secs ? dur(c.worked_secs) : '–'}</b></td><td class="r num">${c.break_secs ? dur(c.break_secs) : '–'}</td><td class="r num">${c.idle_secs ? dur(c.idle_secs) : '–'}</td>
          <td class="r num">${pctText(c.activity_pct)}</td><td class="r num muted">${c.expected_secs ? dur(c.expected_secs) : '–'}</td><td class="r num">${c.shots || '–'}</td></tr>`; })}
        <tr class="note-row"><td><b>Week total</b></td><td></td><td></td><td></td><td class="r num"><b>${dur(r.totals.worked_secs)}</b></td><td class="r num">${dur(r.totals.break_secs)}</td><td class="r num">${dur(r.totals.idle_secs)}</td><td class="r num">${pctText(r.totals.activity_pct)}</td><td class="r num">${dur(r.totals.expected_secs)}</td><td class="r num">${r.totals.shots}</td></tr>
        </tbody></table></div>`;
    } else {
      table = grid(g, days, today, q);
    }
    const exportQ = `from=${from}&to=${to}${who !== 'all' ? '&user_id=' + who : ''}${who === 'all' && q.get('team') ? '&team_id=' + q.get('team') : ''}`;
    return html`
      <div class="page-h"><div><h1>${isMgr() ? 'Timesheets' : 'Your timesheet'}</h1><p class="sub">${dayMD(from)} to ${dayMD(to)} · ${single ? g.rows[0].name : plural(g.rows.length, 'person', 'people')}</p></div>
        <div class="tools">${isMgr() ? html`${select({ q: 'user', value: who, label: 'Person', options: [['all', 'Everyone'], ...S.people.map((p) => [p.id, p.name])] })}${who === 'all' ? teamSelect(q.get('team')) : ''}` : ''}${nav}
          <button class="btn" data-act="csv" data-query="${exportQ}" data-name="timesheets-${from}-to-${to}.csv">Export CSV</button></div></div>
      ${sheetBento(g, { worked, expected, act: worked ? Math.round(actW / worked) : null, sum }, today)}
      ${single || !g.rows.length ? html`<section class="panel flush"><div class="body" style="padding-top:0">${table}</div></section>` : html`<section class="panel flush tsg-panel">${table}</section>`}`;
  },
};

// the week as a bento: hours worked against what was due (a ring and a bar a day), and six numbers
function sheetBento(g, { worked, expected, act, sum }, today) {
  const pct = expected ? Math.round((100 * worked) / expected) : null, tone = expected ? toneFor(pct, 70, 90) : '';
  const per = g.days.map((d) => g.rows.reduce((n, r) => n + (r.cells[d] ? r.cells[d].worked_secs : 0), 0)), max = Math.max(1, ...per);
  const gap = worked - expected, late = sum((t) => t.days_late), absent = sum((t) => t.days_absent);
  const t = (cls, label, ic, val, foot, tone2 = '') => html`<div class="kpi ${cls} ${tone2}"><div class="l">${icon(ic)}${label}</div><div class="v">${val}</div><div class="f">${foot}</div></div>`;
  return html`<section class="kpis bento ts-bento" aria-label="The week at a glance">
    <div class="kpi bt-wk"><div class="l">${icon('clock')}Worked this week<span class="bt-r">${expected ? `of ${dur(expected)} due by now` : 'Nothing due yet'}</span></div>
      <div class="ts-wk"><div class="bt-ringw">${ring(pct, tone)}<span class="bt-rv ${tone}"><b class="num">${pct == null ? '–' : pct + '%'}</b><small>${dur(worked)}</small></span></div>
        <div class="ts-days">${g.days.map((d, i) => html`<a class="ts-day${d === today ? ' today' : ''}${d > today ? ' later' : ''}" href="#/attendance?day=${d}" title="${dayShort(d)}: ${dur(per[i])}"><span class="num">${per[i] ? hoursText(per[i]) : ''}</span><i style="height:${per[i] ? Math.max(6, Math.round((100 * per[i]) / max)) : 4}%"></i><b>${dowShort(d).slice(0, 1)}</b></a>`)}</div></div></div>
    ${t('bt-a', gap >= 0 ? 'Ahead of schedule' : 'Behind schedule', 'chart', Math.abs(gap) < 900 ? 'On pace' : dur(Math.abs(gap)), 'Today counts only the hours gone by', expected && worked < expected * 0.85 ? 'warn' : gap >= 0 && expected ? 'good' : '')}
    ${t('bt-b', 'Breaks', 'pause', dur(sum((x) => x.break_secs)), 'Not counted as work')}
    ${t('bt-c', 'Activity', 'pulse', pctText(act), 'Weighted by hours', toneFor(act, 35, 50))}
    ${t('bt-d', 'Idle', 'sun', dur(sum((x) => x.idle_secs)), 'No input, still counted')}
    ${t('bt-e', 'Days late', 'cal', String(late), `${plural(sum((x) => x.days_present), 'day')} present`, late ? 'warn' : '')}
    ${t('bt-f', 'Days absent', 'alert', String(absent), `${sum((x) => x.days_leave)} on leave`, absent ? 'bad' : '')}
  </section>`;
}

actions.csv = async (el) => {
  try { await download(`/api/reports/export.csv?${el.dataset.query}`, el.dataset.name); toast('CSV downloaded'); }
  catch (e) { toast(errMsg(e), true); }
};
