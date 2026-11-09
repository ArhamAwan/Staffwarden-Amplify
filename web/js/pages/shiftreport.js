// The shift report: one work day, everyone on it. What each person did, the hours they kept, their breaks,
// the tasks they finished and what they wrote in their check-in, with the PDF to download.
import { html, raw, icon, dur, pctText, dayShort, plural } from '../util.js';
import { get, download } from '../api.js';
import { S, actions, toast, errMsg, avatar, ring, meter, empty, findPeople, findBox, longList, noMatch } from '../ui.js';

const LABEL = { present: 'On time', late: 'Late', absent: 'Absent', not_started: 'Not started', leave: 'On leave', holiday: 'Holiday', off: 'Day off', upcoming: 'Not yet' };
const TONE = { present: 'good', late: 'warn', absent: 'bad', not_started: 'bad', leave: 'muted', holiday: 'muted', off: 'muted', upcoming: 'muted' };
const MOOD = { smooth: 'Smooth', busy: 'Busy', rough: 'Rough' };
const clock = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const dowNum = (day) => { const d = new Date(`${day}T00:00:00Z`); return [['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()], d.getUTCDate()]; };

export default {
  title: 'Shift report',
  async load(q) {
    const list = await get('/api/shift-reports');
    const fallback = (list.days.find((d) => d.final) || list.days[0] || { day: list.today }).day;
    const day = /^\d{4}-\d\d-\d\d$/.test(q.get('day') || '') ? q.get('day') : fallback;
    const r = await get(`/api/shift-reports/${day}`);
    return { list, r };
  },
  render({ list, r }, q) {
    const t = r.totals;
    const worked = r.people.filter((p) => p.worked_secs > 0 || p.running || p.checkin);
    // a big team: find a person, 25 at a time; the ones with flags come first
    const LVN2 = { red: 0, amber: 1 }, found = findPeople([...r.people].sort((a, b) => (LVN2[a.level] ?? 2) - (LVN2[b.level] ?? 2)), q), pg = longList(found, q);
    const missing = r.people.filter((p) => !worked.includes(p));
    const days = list.days.some((d) => d.day === r.day) ? list.days : [{ day: r.day, final: r.final }, ...list.days];
    const readyAt = r.ready_at ? new Date(r.ready_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    return html`
      <div class="page-h"><div><h1>Shift report</h1><p class="sub">What everyone did on ${dayShort(r.day)}: hours, breaks, tasks and check-ins</p></div>
        <div class="tools"><button class="btn primary sr-dl" data-act="sr-pdf" data-day="${r.day}">${icon('download')}Download PDF</button></div></div>
      <nav class="sr-days" aria-label="Choose a day">${days.slice(0, 14).map((d) => { const [w, n] = dowNum(d.day); return html`<a class="sr-day${d.day === r.day ? ' on' : ''}${d.final ? '' : ' live'}" href="#/shift-report?day=${d.day}" aria-current="${d.day === r.day ? 'page' : 'false'}" title="${dayShort(d.day)}${d.final ? '' : ' (in progress)'}"><small>${w}</small><b class="num">${n}</b><i aria-hidden="true"></i></a>`; })}</nav>
      <div class="sr-state ${r.final ? 'final' : 'live'}" role="status">${icon(r.final ? 'check' : 'clock')}<span>${r.final
        ? html`<b>Final.</b> Ready since ${readyAt}, after the last shift ended. A time request approved later still changes it.`
        : html`<b>In progress.</b> These are the numbers so far.${readyAt ? html` The report is final at ${readyAt}, and the owner and managers get a notification then.` : ''}`}</span></div>
      ${bento(r)}
      ${attention(r)}
      <section class="panel flush"><header><h2>The team at a glance</h2><span class="muted small">${plural(t.people, 'person', 'people')}, times in each person’s own time zone</span>${r.people.length > 8 ? findBox(q) : ''}</header><div class="body">
        ${r.people.length && !found.length ? noMatch(q) : r.people.length ? html`<div class="tbl-wrap"><table class="t sr-t"><thead><tr><th>Name</th><th>Status</th><th>In</th><th>Out</th><th class="r">Worked</th><th class="r">Breaks</th><th class="r">Idle</th><th class="r">Activity</th><th class="r">Tasks done</th><th>Check-in</th><th class="r">Flags</th></tr></thead><tbody>
          ${pg.items.map((p) => html`<tr class="${p.level === 'red' || p.level === 'amber' ? `sr-f-${p.level}` : ''}"><td><span class="sr-who">${avatar(p, true)}<b>${p.name}</b></span></td>
            <td><span class="tag ${p.status}"><i></i>${p.status === 'late' ? `Late ${p.late_by_min}m` : LABEL[p.status] || p.status}</span></td>
            <td class="num ${lv(p, 'late')}">${p.first_start || '–'}</td><td class="num ${lv(p, 'early', 'running')}">${p.running ? html`<span class="sr-on">working</span>` : p.last_end || '–'}</td>
            <td class="r num ${lv(p, 'short', 'overtime', 'dayoff')}"><b>${p.worked_secs ? dur(p.worked_secs) : '–'}</b></td><td class="r num ${lv(p, 'breaks')}">${p.break_secs >= 60 ? dur(p.break_secs) : '–'}</td>
            <td class="r num ${lv(p, 'idle')}">${p.idle_secs >= 60 ? dur(p.idle_secs) : '–'}</td><td class="r num ${lv(p, 'activity')}">${pctText(p.activity_pct)}</td>
            <td class="r num">${p.tasks.filter((x) => x.done).length || '–'}</td>
            <td>${p.checkin ? html`<span class="sr-ci${p.checkin.blockers.trim() ? ' bad' : ''}">${icon(p.checkin.blockers.trim() ? 'alert' : 'check')}${p.checkin.blockers.trim() ? 'Blocked' : 'Written'}</span>` : html`<span class="muted">–</span>`}</td>
            <td class="r">${p.flags.length ? html`<span class="sr-fn lv-${p.level}">${p.flags.length}</span>` : html`<span class="muted">–</span>`}</td></tr>`)}
        </tbody></table></div>${pg.more}` : empty('Nobody was scheduled on this day', 'Pick another day above.')}</div></section>
      ${worked.length ? html`<h2 class="sr-h2">Each person</h2><div class="sr-grid">${pg.items.filter((p) => worked.includes(p)).map(card)}</div>${pg.more}` : ''}
      ${missing.length ? html`<section class="panel sr-miss"><div class="body"><b>Didn’t work this day</b><div class="sr-chips">${missing.map((p) => html`<span class="sr-chip">${avatar(p, true)}${p.name}<em class="${TONE[p.status] || ''}">${LABEL[p.status] || p.status}</em></span>`)}</div></div></section>` : ''}`;
  },
};

const lv = (p, ...keys) => { const f = p.flags.find((x) => keys.includes(x.key)); return f ? `lv-${f.level}` : ''; };
const LVN = { red: 0, amber: 1, blue: 2 };

// what's out of the ordinary, person by person: red to act on, amber worth a look, blue unusual but fine
function attention(r) {
  const list = r.people.filter((p) => p.flags.length).sort((a, b) => LVN[a.level] - LVN[b.level]);
  if (!list.length) return html`<section class="panel sr-att ok"><div class="body">${icon('check')}<b>Nothing unusual.</b><span>Everyone kept to their hours.</span></div></section>`;
  return html`<section class="panel sr-att"><header><h2>Needs attention</h2><span class="sr-key"><span class="lv-red"><i></i>Act on it</span><span class="lv-amber"><i></i>Worth a look</span><span class="lv-blue"><i></i>Unusual but fine</span></span></header>
    <div class="body"><ul class="sr-att-l">${list.map((p) => html`<li class="lv-${p.level}"><span class="sr-who">${avatar(p, true)}<b>${p.name}</b></span><ul class="sr-flags">${p.flags.map((f) => html`<li class="lv-${f.level}"><i></i>${f.label}</li>`)}</ul></li>`)}</ul></div></section>`;
}

function bento(r) {
  // a day still going is measured against the part of the shift that's gone by, and isn't coloured
  const t = r.totals, base = r.final ? t.expected_secs : t.expected_done_secs, pct = base ? Math.min(999, Math.round((100 * t.worked_secs) / base)) : null;
  const tone = !r.final || pct == null ? '' : pct >= 90 ? 'good' : pct >= 70 ? 'warn' : 'bad';
  const k = (cls, ic, label, v, f, tone = '') => html`<div class="kpi ${cls} ${tone}"><div class="l">${icon(ic)}${label}</div><div class="v num">${v}</div><div class="f">${f}</div></div>`;
  return html`<section class="kpis bento sr-bento" aria-label="The day at a glance">
    <div class="kpi bt-hw ${tone}"><div class="l">${icon('clock')}Hours worked</div>
      <div class="sr-hw"><div class="bt-ringw">${ring(pct || 0)}<div class="bt-rv"><b>${pct == null ? '–' : `${pct}%`}</b><small>${r.final ? 'of planned' : 'of due so far'}</small></div></div>
      <div><div class="v num">${dur(t.worked_secs)}</div><div class="f">${t.expected_secs ? `${dur(t.expected_secs)} planned` : 'Nothing planned'}${t.still_running ? `, ${t.still_running} still working` : ''}</div></div></div></div>
    <div class="kpi bt-at ${t.absent ? 'bad' : t.late ? 'warn' : ''}"><div class="l">${icon('users')}Attendance</div><div class="v num">${t.present}<small>/${t.people}</small></div>
      <div class="bt-dots" aria-hidden="true">${r.people.map((p) => html`<i class="${{ present: 'd-ok', late: 'd-late', absent: 'd-bad', not_started: 'd-bad', leave: 'd-leave' }[p.status] || 'd-wait'}" title="${p.name}"></i>`)}</div>
      <div class="f">${[t.late ? `${t.late} late` : null, t.absent ? `${t.absent} absent` : null, t.on_leave ? `${t.on_leave} on leave` : null].filter(Boolean).join(', ') || 'Everyone in on time'}</div></div>
    ${k('bt-ac', 'pulse', 'Activity', pctText(t.activity_pct), 'Average while working')}
    ${k('bt-br', 'pause', 'Breaks', dur(t.break_secs), `Idle ${dur(t.idle_secs)}`)}
    ${k('bt-tk', 'tasks', 'Tasks done', String(t.tasks_done), t.tasks_review ? `${t.tasks_review} sent for review` : 'Finished during the shift')}
    ${k('bt-ci', 'checkin', 'Check-ins', html`${t.checked_in}<small>/${t.present || t.people}</small>`, t.blockers ? `${plural(t.blockers, 'person', 'people')} blocked` : 'Nobody blocked', t.blockers ? 'bad' : '')}
  </section>`;
}

// the day on one bar: work, breaks, idle and computer-away, against the shift
function ribbon(p) {
  const segs = p.segs || [];
  const [ss, se] = p.shift_min;
  const lo = Math.min(ss, ...segs.map((s) => s[0])), hi = Math.max(se, ...segs.map((s) => s[1]));
  const span = Math.max(1, hi - lo), at = (m) => `${(((m - lo) / span) * 100).toFixed(2)}%`;
  const name = { w: 'Working', b: 'Break', i: 'Idle', o: 'Computer away' };
  return html`<div class="sr-rib" aria-label="The day: ${dur(p.worked_secs)} worked">
    <div class="sr-bar"><span class="sr-shift" style="left:${at(ss)};width:${(((se - ss) / span) * 100).toFixed(2)}%"></span>
      ${segs.map(([a, b, kk]) => html`<i class="k-${kk}" style="left:${at(a)};width:${Math.max(0.4, ((b - a) / span) * 100).toFixed(2)}%" title="${name[kk] || ''} ${clock(a + p.day_start_min)}–${clock(b + p.day_start_min)}"></i>`)}</div>
    <div class="sr-ticks num"><span>${clock(lo + p.day_start_min)}</span><span>${clock(hi + p.day_start_min)}</span></div></div>`;
}

function card(p) {
  const maxP = Math.max(1, ...p.projects.map((x) => x.secs));
  const ci = p.checkin;
  return html`<article class="panel sr-card">
    <header class="sr-ch">${avatar(p)}<div class="sr-cn"><b>${p.name}</b><span>${[p.title, p.team, `shift ${p.shift}`].filter(Boolean).join(' · ')}</span></div>
      <div class="sr-cs"><span class="tag ${p.status}"><i></i>${p.status === 'late' ? `Late ${p.late_by_min} min` : LABEL[p.status] || p.status}</span><span class="num">${p.first_start ? `${p.first_start} – ${p.running ? 'now' : p.last_end}` : 'Didn’t start'}</span></div></header>
    ${p.flags.length ? html`<ul class="sr-flags">${p.flags.map((f) => html`<li class="lv-${f.level}"><i></i>${f.label}</li>`)}</ul>` : ''}
    ${ribbon(p)}
    <dl class="sr-nums">
      <div><dt>Worked</dt><dd class="num">${dur(p.worked_secs)}</dd></div>
      <div><dt>Breaks</dt><dd class="num">${p.break_secs >= 60 ? dur(p.break_secs) : '–'}</dd></div>
      <div><dt>Idle</dt><dd class="num">${p.idle_secs >= 60 ? dur(p.idle_secs) : '–'}</dd></div>
      <div><dt>Activity</dt><dd class="num">${pctText(p.activity_pct)}</dd></div>
      <div><dt>Screenshots</dt><dd class="num">${p.shots || 0}</dd></div></dl>
    ${p.projects.length ? html`<div class="sr-sec"><h3>Time on</h3><ul class="sr-proj">${p.projects.map((x) => html`<li><span>${x.name}</span>${meter((100 * x.secs) / maxP)}<b class="num">${dur(x.secs)}</b></li>`)}</ul></div>` : ''}
    ${p.tasks.length ? html`<div class="sr-sec"><h3>Tasks</h3><ul class="sr-tasks">${p.tasks.map((x) => html`<li class="${x.done ? 'done' : 'rev'}">${icon(x.done ? 'check' : 'clock')}<span>${x.title}${x.project ? html`<em>${x.project}</em>` : ''}</span><small class="num">${x.done ? 'Done' : 'For review'} ${x.at || ''}</small></li>`)}</ul></div>` : ''}
    ${p.breaks.length || p.away_secs >= 60 ? html`<div class="sr-sec"><h3>Breaks</h3><div class="sr-brks">${p.breaks.map((b) => html`<span class="num">${b.from}–${b.to || 'now'}<b>${dur(b.secs)}</b>${b.reason ? html`<em>${b.reason}</em>` : ''}</span>`)}${p.away_secs >= 60 ? html`<span class="away">Computer away<b>${dur(p.away_secs)}</b></span>` : ''}</div></div>` : ''}
    <div class="sr-sec sr-cin"><h3>Check-in${ci && ci.mood ? html`<span class="sr-mood m-${ci.mood}">${MOOD[ci.mood] || ci.mood}</span>` : ''}</h3>
      ${ci ? html`${ci.did ? html`<p><b>Did</b>${ci.did}</p>` : ''}${ci.next ? html`<p><b>Next</b>${ci.next}</p>` : ''}${ci.blockers.trim() ? html`<p class="blk"><b>Blocked by</b>${ci.blockers}</p>` : ''}`
      : html`<p class="muted">No check-in written${p.running ? ' yet' : ''}.</p>`}</div>
    ${p.time_requests.length ? html`<div class="sr-sec"><h3>Missing time asked for</h3><ul class="sr-req">${p.time_requests.map((q) => html`<li><span class="num">${q.from}–${q.to}</span><span>${q.reason}</span><span class="tag ${q.status}">${q.status}</span></li>`)}</ul></div>` : ''}
  </article>`;
}

actions['sr-pdf'] = async (el) => {
  const day = el.dataset.day;
  el.disabled = true;
  try { await download(`/api/shift-reports/${day}/pdf`, `shift-report-${day}.pdf`); toast('Shift report downloaded'); }
  catch (e) { toast(errMsg(e), true); } finally { el.disabled = false; }
};
