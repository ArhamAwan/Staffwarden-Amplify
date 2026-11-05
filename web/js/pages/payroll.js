// Payroll for HR and the owner: the month (draft → review → approved → paid), one person's pay with
// every line, what HR adds, the rules HR chooses, and past months.
import { html, raw, esc, icon, money, periodLabel, dayShort, dateY, relTime, plural, addMonths, initials, avColor } from '../util.js';
import { get, post, put, del, qs, download } from '../api.js';
import { S, actions, tag, empty, openModal, confirmBox, toast, errMsg, qAttr } from '../ui.js';
import { companyToday } from '../parts.js';
import { payBar, slipLines, questionsBlock, STATUS } from './pay.js';

const STEPS = ['Draft', 'Review', 'Approved', 'Paid'];
const stepAt = { draft: 0, review: 1, approved: 2, paid: 4 };
export function stepper(status) {
  const at = stepAt[status];
  return html`<ol class="psteps" aria-label="Payroll steps">${STEPS.map((s, i) => html`<li class="${i < at ? 'done' : i === at ? 'now' : ''}" ${i === at ? raw('aria-current="step"') : ''}><span>${i < at ? icon('check') : i + 1}</span>${s}</li>`)}</ol>`;
}
export const ptabs = (cur) => html`<nav class="tabs" aria-label="Payroll">${[['month', 'Month', '#/payroll'], ['people', 'People and pay', '#/hr'], ['expenses', 'Expenses', '#/expenses'], ['rules', 'Rules', '#/payroll?tab=rules'], ['history', 'History', '#/payroll?tab=history']]
  .map(([k, n, h]) => html`<a class="tab" href="${h}" aria-current="${cur === k ? 'page' : 'false'}">${n}</a>`)}</nav>`;
const av = (s) => html`<span class="avatar" style="background:${avColor(s.user_id ?? s.id)}" aria-hidden="true">${initials(s.name)}</span>`;
const changes = (s) => {
  const c = s.lines.filter((l) => (l.kind !== 'base' || /^prev:/.test(l.key)) && l.counted);
  const shown = s.lines.filter((l) => !l.counted);
  if (!c.length && !shown.length) return html`<span class="muted">None</span>`;
  return html`<div class="pchg">${c.map((l) => html`<span class="${l.amount < 0 ? 'neg' : 'pos'} num">${l.amount < 0 ? '−' : '+'} ${money(Math.abs(l.amount), s.currency)} <i>${l.label.toLowerCase()}</i></span>`)}${shown.map((l) => html`<span class="shown num">${money(Math.abs(l.amount), s.currency)} <i>${l.label.toLowerCase()}, ${l.removed ? 'removed' : 'shown only'}</i></span>`)}</div>`;
};

export default {
  title: 'Payroll',
  async load(q) {
    const tab = q.get('tab') || 'month';
    if (q.get('id')) {
      const slip = await get(`/api/payroll/slips/${q.get('id')}`);
      const run = await get(`/api/payroll/runs/${slip.run_id}`);
      return { tab: 'slip', slip, run };
    }
    const ov = await get('/api/payroll');
    if (tab === 'rules') return { tab, ov };
    if (tab === 'history') return { tab, ov };
    const runId = q.get('run') || (ov.runs.find((r) => r.status !== 'paid') || ov.runs[0] || {}).id;
    const run = runId ? await get(`/api/payroll/runs/${runId}`) : null;
    return { tab, ov, run };
  },
  render(d) {
    if (d.tab === 'slip') return slipView(d);
    if (d.tab === 'rules') return rulesView(d.ov);
    if (d.tab === 'history') return historyView(d.ov);
    if (!d.run) return firstView(d.ov);
    return runView(d.ov, d.run);
  },
};

// ---------- the month ----------
// the month to pay: the latest one that has ended and has no payroll yet (pay goes out in the month after)
function nextPeriod(ov) {
  const latest = ov.runs.reduce((m, r) => (r.period > m ? r.period : m), '');
  const opts = periodChoices(ov).filter((o) => !o.run && o.ended && o.period > latest);
  return opts.length ? opts[0].period : null;
}
// the current month (once it is nearly over) and the three before it
function periodChoices(ov) {
  const today = companyToday(), cur = today.slice(0, 7), out = [];
  for (let i = 0; i < 4; i++) {
    const period = addMonths(cur, -i);
    if (i === 0 && Number(today.slice(8)) < 20) continue;
    out.push({ period, ended: i > 0, run: ov.runs.find((r) => r.period === period) || null });
  }
  return out;
}
const payWindowText = (ov, period) => {
  const nx = addMonths(period, 1), R = ov.rules || {}, from = Number(R.pay_day) || 1, by = Math.max(Number(R.pay_by) || 10, from);
  const m = new Date(`${nx}-01T12:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${m} ${from} to ${by}`;
};
// the month's files under one button: what each is for, and its format
function dlMenu(r) {
  const item = (kind, fmt, ic, t, sub) => html`<button type="button" class="pr-mi" role="menuitem" data-act="pr-dl" data-id="${r.id}" data-kind="${kind}" ${raw(fmt ? `data-fmt="${fmt}"` : '')} data-period="${r.period}"><span class="pr-mic">${icon(ic)}</span><span><b>${t}</b><small>${sub}</small></span></button>`;
  return html`<details class="pr-dlm" data-own="prdl${r.id}"><summary class="btn">${icon('download')} Download${raw('<svg class="pr-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>')}</summary>
    <div class="pr-menu" role="menu">${item('bank', '', 'download', 'Bank sheet', 'Excel · who gets paid, to which account')}${item('bank', 'csv', 'bank', 'Bank upload file', 'CSV · for banks that take a file of transfers')}${item('register', '', 'file', 'Payroll register', 'Excel · every line of pay, for your accountant')}</div></details>`;
}
document.addEventListener('click', (e) => { for (const d of document.querySelectorAll('.pr-dlm[open]')) if (!d.contains(e.target) || e.target.closest('.pr-mi')) d.open = false; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const d of document.querySelectorAll('.pr-dlm[open]')) { d.open = false; d.querySelector('summary').focus(); } });
function runView(ov, d) {
  const r = d.run, s = r.status, pk = d.totals.PKR, usd = d.totals.USD;
  const tools = s === 'draft' ? html`<button class="btn" data-act="pr-refresh" data-id="${r.id}">${icon('refresh')} Work it out again</button><button class="btn primary" data-act="pr-submit" data-id="${r.id}">Send for approval</button>`
    : s === 'review' ? html`<button class="btn" data-act="pr-refresh" data-id="${r.id}">${icon('refresh')} Work it out again</button>${d.can_approve ? html`<button class="btn primary" data-act="pr-approve" data-id="${r.id}">${icon('check')} Approve ${periodLabel(r.period).split(' ')[0]}</button>` : ''}`
    : html`${dlMenu(r)}${s === 'approved' ? html`<button class="btn primary" data-act="pr-paid" data-id="${r.id}" data-left="${d.slips.length - r.paid_count}">${r.paid_count ? `Mark the other ${d.slips.length - r.paid_count} paid` : 'Mark everyone paid'}</button>` : html`<button class="btn primary" data-act="pr-start">${icon('plus')} Start a month</button>`}`;
  const who = s === 'draft' ? `Started by ${r.created_by_name || 'HR'} ${relTime(r.created_at)}. People do not see it until you send it for approval.`
    : s === 'review' ? (d.can_approve ? `Sent by ${r.submitted_by_name || 'HR'} ${relTime(r.submitted_at)}. Everyone can see and ask about their payslip.` : `Sent for approval ${relTime(r.submitted_at)}. Waiting for the owner. Everyone can see and ask about their payslip.`)
    : s === 'approved' ? `Approved by ${r.approved_by_name} ${relTime(r.approved_at)}. ${r.paid_count} of ${d.slips.length} paid. Pay each person by ${dayShort(r.pay_by)} and mark them paid as you go.`
    : `Everyone paid${r.paid_ref ? `, reference ${r.paid_ref}` : ''}. Locked.`;
  const prevNet = d.previous && d.previous.totals.PKR ? d.previous.totals.PKR.net : null;
  const hero = html`<div class="pr-hero">
      <div class="pr-sum">${pk ? html`<div class="pr-sum-h"><b>${periodLabel(r.period)}, in rupees</b><span>${plural(pk.people, 'person', 'people')}${usd ? `, and ${usd.people} in dollars (${money(usd.net, 'USD')})` : ''}</span></div>${payBar({ ...pk, currency: 'PKR', people: true }, { dark: true })}
        ${prevNet != null ? html`<div class="pr-vs">${icon(pk.net >= prevNet ? 'up' : 'down')}<b class="num">${money(Math.abs(pk.net - prevNet))} ${pk.net >= prevNet ? 'more' : 'less'} than ${d.previous.name.split(' ')[0]}</b></div>` : ''}`
        : usd ? html`<div class="pr-sum-h"><b>${periodLabel(r.period)}, in dollars</b></div>${payBar({ ...usd, currency: 'USD', people: true }, { dark: true })}` : html`<p>No one has pay set yet.</p>`}</div>
      <div class="pr-checks"><b>${s === 'draft' || s === 'review' ? 'Before it is approved' : 'This month'}</b>
        ${d.checks.length ? d.checks.map((c) => html`<a class="pr-check ${c.kind}" href="${c.kind === 'missing' ? '#/hr' : c.people && c.people[0] && c.kind !== 'missing' ? `#/payroll?id=${c.people[0].id}` : '#/payroll'}" data-k="c${c.kind}">${icon({ question: 'msg', bank: 'bank', attendance: 'flag', shown: 'eye', missing: 'users' }[c.kind])}<span>${c.text}</span>${icon('right')}</a>`)
          : html`<p class="pr-ok">${icon('check')} Nothing to look at.</p>`}</div></div>`;
  const paidCol = s === 'approved' || s === 'paid', canEdit = s === 'draft' || s === 'review';
  const rows = d.slips.map((x) => html`<tr class="link" data-k="s${x.id}" data-act="go" data-href="#/payroll?id=${x.id}" tabindex="0">
      <td class="nm"><span class="person">${av(x)}<span><b>${x.name}</b><span>${x.title || ''}</span></span></span></td>
      <td class="r num">${money(x.lines.find((l) => l.kind === 'base').amount, x.currency)}${x.facts.employed_days < x.facts.workdays ? html`<div class="small muted">${x.facts.employed_days} of ${x.facts.workdays} days</div>` : ''}</td>
      <td>${changes(x)}</td><td class="r num">${x.tax ? money(x.tax, x.currency) : html`<span class="muted">None</span>`}</td><td class="r num"><b>${money(x.net, x.currency)}</b></td>
      ${paidCol ? html`<td class="nowrap">${x.paid_on ? html`<span class="pr-paid">${icon('check')} ${dayShort(x.paid_on)}</span>${s === 'approved' ? html` <button class="linkbtn small" data-act="pr-unpay" data-id="${x.id}" data-name="${x.name}">Undo</button>` : ''}` : html`<button class="btn sm" data-act="pr-pay-one" data-id="${x.id}" data-name="${x.name}" data-net="${money(x.net, x.currency)}" data-from="${r.period}-01">Mark paid</button>`}</td>` : ''}
      <td><div class="chips">${x.open_questions ? tag('break', 'Question') : ''}${!x.facts.bank ? (x.by_hand ? tag('idle', 'Paid by hand') : tag('absent', 'No bank details')) : ''}${x.currency === 'USD' ? tag('idle', 'Dollars, no tax') : ''}${!x.open_questions && x.facts.bank && x.currency !== 'USD' ? tag('working', 'Ready') : ''}</div></td>
      ${canEdit ? html`<td class="pr-off"><button type="button" class="linkbtn small" data-act="pr-leave-off" data-run="${r.id}" data-id="${x.user_id}" data-name="${x.name}" data-net="${money(x.net, x.currency)}" title="Leave ${x.name} off ${periodLabel(r.period).split(' ')[0]}">Leave off</button></td>` : ''}</tr>`);
  const off = d.left_off || [];
  const offList = off.length ? html`<section class="panel pr-offl"><header><h2>Left off ${periodLabel(r.period).split(' ')[0]} <span class="faint">${off.length}</span></h2><span class="muted small">Not paid this month. Their HR record is unchanged.</span></header><div class="body"><ul class="pr-offu">${off.map((o) => html`<li data-k="o${o.user_id}"><span class="person">${av(o)}<span><b>${o.name}</b><span>${o.reason} · ${String(o.by_name || 'HR').split(' ')[0]}, ${relTime(o.created_at)}</span></span></span>${canEdit ? html`<button type="button" class="btn sm" data-act="pr-put-back" data-run="${r.id}" data-id="${o.user_id}" data-name="${o.name}">Put back</button>` : ''}</li>`)}</ul></div></section>` : '';
  const totalRow = pk ? html`<tr class="tot"><td><b>Total in rupees</b></td><td></td><td></td><td class="r num"><b>${money(pk.tax)}</b></td><td class="r num"><b>${money(pk.net)}</b></td>${paidCol ? html`<td></td>` : ''}<td></td>${canEdit ? html`<td></td>` : ''}</tr>` : '';
  return html`
    <div class="page-h pr-head"><div><h1>Payroll</h1><p class="sub">Pay for work in <b>${periodLabel(r.period)}</b>, paid out ${dayShort(r.pay_day)} to ${dayShort(r.pay_by)}. Worked out from Staffwarden hours, attendance and time off.</p></div>
      <div class="tools">${tools}</div>
      <div class="pr-stepline">${stepper(s)}<span>${who}</span></div>
      ${hero}
      ${ptabs('month')}</div>
    <section class="panel flush"><header><h2>Everyone this month</h2><span class="muted small">Open a person to see every line and where it came from</span></header><div class="body">
      ${d.slips.length ? html`<div class="tbl-wrap"><table class="t prt"><thead><tr><th>Person</th><th class="r">Base</th><th>This month</th><th class="r">Income tax</th><th class="r">Net pay</th>${paidCol ? html`<th>Paid</th>` : ''}<th>Check</th>${canEdit ? html`<th><span class="sr">Leave off</span></th>` : ''}</tr></thead><tbody>${rows}${totalRow}</tbody></table></div>` : empty('Nobody on this month', 'Set pay for people on People and pay, then work it out again.')}</div></section>
    ${offList}
    ${s === 'draft' ? html`<p class="small muted">${icon('lock')} Only HR and the owner see this page. Every change is in the audit log. <button class="linkbtn danger" data-act="pr-remove" data-id="${r.id}" data-period="${periodLabel(r.period)}">Remove this draft</button></p>` : html`<p class="small muted">${icon('lock')} Only HR and the owner see this page. Every change is in the audit log.${S.me.role === 'owner' || S.me.is_dev ? html` <button class="linkbtn danger" data-act="pr-remove-any" data-id="${r.id}" data-period="${periodLabel(r.period)}" data-status="${s}">Remove this month</button>` : ''}</p>`}`;
}

function firstView(ov) {
  const period = nextPeriod(ov) || addMonths(companyToday().slice(0, 7), -1);
  const st = (done, now) => (done ? 'done' : now ? 'now' : '');
  const pay = ov.with_pay, missing = ov.missing_pay.length, nobank = ov.no_bank.length;
  const items = [
    [st(true), 'Choose the rules', 'Days, leave, lates, overtime and tax brackets', html`<a class="btn sm" href="#/payroll?tab=rules">Review</a>`],
    [st(!missing, true), 'Set pay for everyone', missing ? `${pay} done. ${ov.missing_pay.slice(0, 3).map((m) => m.name).join(', ')}${missing > 3 ? ` and ${missing - 3} more` : ''} ${missing === 1 ? 'has' : 'have'} no pay yet` : `Everyone has pay set`, html`<a class="btn sm ${missing ? 'primary' : ''}" href="#/hr">Set pay</a>`],
    [st(!nobank && pay > 0, !missing), 'Bank details', nobank ? `${ov.no_bank.map((m) => m.name).slice(0, 3).join(', ')} ${nobank === 1 ? 'is' : 'are'} missing` : pay ? 'Everyone with pay has bank details' : 'Add them with pay', html`<a class="btn sm" href="#/hr">Open</a>`],
    [st(ov.rules.eobi.on), 'Contributions', 'EOBI applies to most companies in Pakistan', html`<a class="btn sm" href="#/payroll?tab=rules#eobi">Set up</a>`],
  ];
  return html`
    <div class="page-h"><div><h1>Payroll</h1><p class="sub">Set up once, then every month takes a few minutes</p></div>${ptabs('month')}</div>
    <div class="cols">
      <section class="panel"><header><h2>Your first payroll</h2><span class="muted small">Staffwarden already has everyone’s hours, attendance and leave</span></header><div class="body">
        <ul class="checklist">${items.map(([s, t, sub, b]) => html`<li class="${s}"><span class="ck">${s === 'done' ? icon('check') : ''}</span><div><b>${t}</b><span>${sub}</span></div>${b}</li>`)}</ul>
        <div class="pr-start"><span>Start ${periodLabel(period)}, paid ${payWindowText(ov, period)}, when everyone has pay. Nothing is paid until it is approved.</span><button class="btn primary" data-act="pr-start" ${pay ? '' : raw('disabled')}>${icon('right')} Start a month</button></div></div></section>
      <section class="panel"><header><h2>How it works</h2></header><div class="body"><ul class="howto">
        <li>${icon('clock')}<div><b>From hours you already track</b><span>Absences, unpaid leave, lates and overtime come from attendance, as your rules say.</span></div></li>
        <li>${icon('check')}<div><b>You check every line</b><span>Each line says where it came from. People can ask about theirs before it is approved.</span></div></li>
        <li>${icon('download')}<div><b>You pay from your bank</b><span>A sheet for your bank’s bulk transfer, payslips for everyone and a register for your accountant.</span></div></li></ul></div></section></div>`;
}

function historyView(ov) {
  const rows = ov.runs.map((r) => { const t = r.totals.PKR || r.totals.USD || { net: 0 }; const [c, w] = STATUS[r.status]; return html`<li class="clickable" data-k="r${r.id}" data-act="go" data-href="#/payroll?run=${r.id}" tabindex="0"><span class="what">${r.name}</span><span class="len num">${money(t.net, r.totals.PKR ? 'PKR' : 'USD')}</span><span class="when">${plural(r.people, 'person', 'people')} · ${tag(c, w)}${r.paid_at ? ` · paid ${dayShort(r.paid_at.slice(0, 10))}` : ''}</span></li>`; });
  return html`<div class="page-h"><div><h1>Payroll</h1><p class="sub">Every month, kept as it was paid</p></div><div class="tools"><button class="btn primary" data-act="pr-start">${icon('plus')} Start a month</button></div>${ptabs('history')}</div>
    <section class="panel flush"><header><h2>Every month</h2><span class="muted small">Locked once approved. A mistake is fixed with a correction on a later month.</span></header><div class="body">${rows.length ? html`<ul class="blist">${rows}</ul>` : empty('No months yet', 'Start your first payroll on the Month tab.')}</div></section>`;
}

// ---------- one person ----------
function slipView({ slip, run }) {
  const r = run.run, editable = r.status === 'draft' || r.status === 'review';
  const ids = run.slips.map((x) => x.id), i = ids.indexOf(slip.id);
  const prev = ids[i - 1], next = ids[i + 1];
  const f = slip.facts;
  const kinds = [['commission', 'Commission'], ['bonus', 'Bonus'], ['allowance', 'Allowance'], ['deduction', 'Deduction'], ['correction', 'Correction']];
  const add = editable ? html`<form class="pr-add" data-submit="pr-add-item" data-run="${r.id}" data-user="${slip.user_id}" novalidate>
      <b>Add to this month</b>
      <div class="chips" role="radiogroup" aria-label="What to add">${kinds.map(([v, n], j) => html`<label class="chip"><input type="radio" name="kind" value="${v}" ${j === 0 ? raw('checked') : ''}> ${n}</label>`)}</div>
      <div class="pr-add-f"><div class="field"><label class="f" for="pa-a">Amount</label><input id="pa-a" name="amount" type="number" step="1" required inputmode="numeric" placeholder="12000"></div>
        <div class="field"><label class="f" for="pa-r">Reason (${slip.name.split(' ')[0]} sees this)</label><input id="pa-r" name="reason" maxlength="300" required placeholder="9 closed deals in October"></div></div>
      <p class="hint">A correction can be negative, to take back something paid before.</p>
      <div class="form-end"><p class="err" data-err></p><button class="btn primary" type="submit">${icon('plus')} Add</button></div></form>` : '';
  return html`
    <div class="page-h"><div><h1>${slip.name}, ${periodLabel(r.period).split(' ')[0]}</h1><p class="sub">Payroll · ${periodLabel(r.period)} · ${STATUS[r.status][1].toLowerCase()}</p></div>
      <div class="tools"><a class="btn" href="#/payroll?run=${r.id}">${icon('left')} Back to ${periodLabel(r.period).split(' ')[0]}</a></div>
      <div class="pr-stepline">${stepper(r.status)}</div></div>
    <div class="cols">
      <section class="panel"><div class="body">
        <div class="slip-h"><span class="person">${av(slip)}<span><b>${slip.name}</b><span>${slip.title || ''}</span></span></span>
          <div class="pr-pn">${prev ? html`<a class="btn sm" href="#/payroll?id=${prev}">${icon('left')} Previous</a>` : ''}${next ? html`<a class="btn sm" href="#/payroll?id=${next}">Next ${icon('right')}</a>` : ''}</div></div>
        <div style="margin:18px 0 6px">${payBar(slip)}</div>
        ${slipLines(slip, { hr: editable })}
        ${questionsBlock(slip, { hr: true })}
        ${add}</div></section>
      <div>
        <section class="panel"><header><h2>Their ${periodLabel(r.period).split(' ')[0]}</h2><a href="#/attendance">Attendance</a></header><div class="body"><dl class="pr-facts">
          <div><dt>Worked</dt><dd class="num">${plural(f.present || 0, 'day')} of ${f.employed_days}</dd></div><div><dt>Hours</dt><dd class="num">${Math.round(f.worked_secs / 3600)}h of ${Math.round(f.expected_secs / 3600)}h</dd></div>
          <div><dt>Late starts</dt><dd class="num">${f.late}</dd></div><div><dt>Unpaid leave</dt><dd class="num">${plural(f.unpaid, 'day')}</dd></div></dl></div></section>
        <section class="panel"><header><h2>Pay details</h2><a href="#/hr?id=${slip.user_id}">Their record</a></header><div class="body"><dl class="kv tight">
          ${slip.base ? html`<dt>Base salary</dt><dd>${money(slip.base.amount, slip.base.currency)} a month</dd><dt>Tax</dt><dd>${slip.base.tax_mode === 'pk' && slip.base.currency === 'PKR' ? 'Pakistan brackets' : 'None'}</dd>` : ''}
          <dt>Bank</dt><dd>${slip.bank ? `${slip.bank.name || 'Bank'} ••• ${slip.bank.last4}` : html`<span class="bad-t">Missing</span>`}</dd>${f.joined ? html`<dt>Joined</dt><dd>${dateY(f.joined)}</dd>` : ''}${f.leaving ? html`<dt>Last day</dt><dd>${dateY(f.leaving)}</dd>` : ''}</dl>
          ${!slip.bank && editable ? html`<label class="check mt"><input type="checkbox" data-act="pr-byhand" data-id="${slip.id}" ${slip.by_hand ? raw('checked') : ''}> Pay ${slip.name.split(' ')[0]} by hand this month</label>` : ''}</div></section>
        ${slip.items && slip.items.length ? html`<section class="panel"><header><h2>Added by HR</h2></header><div class="body"><ul class="plain small">${slip.items.map((it) => html`<li><b>${it.label}</b> ${money(it.amount, slip.currency)} by ${it.by_name || 'HR'}, ${relTime(it.created_at)}</li>`)}</ul></div></section>` : ''}
      </div></div>`;
}

// ---------- rules ----------
function rulesView(ov) {
  const R = ov.rules, owner = S.me.role === 'owner';
  const opt = (name, cur, list) => html`<select name="${name}" aria-label="${name}">${list.map(([v, n]) => html`<option value="${v}" ${String(cur) === String(v) ? raw('selected') : ''}>${n}</option>`)}</select>`;
  const rule = (t, d, ctl, extra = '') => html`<div class="prule"><div><b>${t}</b><span>${d}</span>${extra}</div><div>${ctl}</div></div>`;
  const brackets = R.tax.brackets.map((b, i) => html`<tr data-k="b${i}"><td class="num">${money(i ? R.tax.brackets[i - 1][0] + 1 : 0)}</td><td><input class="num" name="b_hi" type="number" value="${b[0] ?? ''}" ${b[0] == null ? raw('placeholder="and above" disabled') : ''} aria-label="Up to"></td><td><input class="num" name="b_fx" type="number" value="${b[1]}" aria-label="Fixed tax"></td><td><input class="num" name="b_pct" type="number" step="0.5" value="${b[2]}" aria-label="Percent"></td></tr>`);
  const sw = (name, on, dis) => html`<label class="switch"><input type="checkbox" name="${name}" ${on ? raw('checked') : ''} ${dis ? raw('disabled') : ''}><span></span></label>`;
  return html`
    <div class="page-h"><div><h1>Payroll rules</h1><p class="sub">How Staffwarden turns attendance into pay. Changes apply when a month is next worked out.</p></div>${ptabs('rules')}</div>
    <form data-submit="pr-rules" novalidate>
    <div class="cols even">
      <section class="panel"><header><h2>Attendance and pay</h2><span class="muted small">“Show only” puts the number on the payslip for you to decide by hand</span></header><div class="body">
        ${rule("A day's pay is", 'Used for absences, unpaid leave, and someone who joins or leaves mid-month', opt('day_basis', R.day_basis, [['working', 'Salary ÷ working days'], ['30', 'Salary ÷ 30'], ['calendar', 'Salary ÷ days in the month']]))}
        ${rule('Unpaid leave', 'Leave approved as unpaid on the Time off page', opt('unpaid_leave', R.unpaid_leave, [['deduct', "Take off a day's pay"], ['show', 'Show only']]))}
        ${rule('Someone who joins mid-month', 'Their first, part month', opt('first_month', R.first_month || 'same', [['same', 'Paid that month'], ['next', 'Paid with their next month']]))}
        ${rule('Absent days', 'A working day with no time tracked and no leave', opt('absent', R.absent, [['deduct', "Take off a day's pay"], ['show', 'Show only'], ['off', 'Ignore']]))}
        ${rule('Late arrivals', "After the grace period on the person's own shift", opt('late_mode', R.late.mode, [['off', 'Off'], ['show', 'Show only'], ['deduct', 'Take off pay']]), html`<div class="prule-x">Every <input name="late_every" type="number" min="1" max="31" value="${R.late.every}" class="num tiny" aria-label="Late starts"> late starts in a month takes off ${opt('late_days', R.late.days, [['0.25', 'a quarter day'], ['0.5', 'half a day'], ['1', 'a day']])}</div>`)}
        ${rule('Overtime', "Hours past the person's target, from tracked time", opt('ot_mode', R.overtime.mode, [['off', 'Off'], ['show', 'Show only'], ['deduct', 'Pay extra']]), html`<div class="prule-x">Paid at <input name="ot_rate" type="number" min="1" max="3" step="0.25" value="${R.overtime.rate}" class="num tiny" aria-label="Rate">× the hourly rate</div>`)}
        ${rule('Unused leave when someone leaves', 'Leave earned this year and not taken is paid in their last month', sw('leave_payout', R.leave_payout))}
        ${rule('Pay days', 'Each person is paid on their own day in this window, and marked paid one by one', html`<span class="prule-x">From the <input name="pay_day" type="number" min="1" max="28" value="${R.pay_day}" class="num tiny" aria-label="First pay day"> to the <input name="pay_by" type="number" min="1" max="28" value="${R.pay_by || 10}" class="num tiny" aria-label="Last pay day"> of the next month</span>`)}</div></section>
      <div>
        <section class="panel${R.tax.on === false ? ' tax-off' : ''}" id="tax"><header><h2>Income tax</h2><span class="muted small">${R.tax.label}</span></header><div class="body">
          ${rule('Take income tax off pay', R.tax.on === false ? TAX_OFF_TXT : TAX_ON_TXT, sw('tax_on', R.tax.on !== false))}
          <div class="tbl-wrap tax-br"><table class="t tight"><thead><tr><th>Yearly income from</th><th>Up to</th><th>Fixed tax</th><th>% on the rest</th></tr></thead><tbody>${brackets}</tbody></table></div>
          <div class="field mt"><label class="f" for="tl">Label</label><input id="tl" name="tax_label" value="${R.tax.label}" maxlength="160"></div>
          <p class="hint">Each month’s taxable pay × 12, taxed on these brackets, ÷ 12. When the budget changes them, edit them here and check with your accountant. Months already approved keep what they were paid with.</p></div></section>
        <section class="panel" id="eobi"><header><h2>Contributions</h2></header><div class="body">
          ${rule('EOBI', 'Old-age pension, on the minimum wage. For people paid in rupees; contractors are left out.', sw('eobi_on', R.eobi.on))}
          <div class="grid3"><div class="field"><label class="f" for="e1">Minimum wage</label><input id="e1" class="num" name="eobi_min" type="number" value="${R.eobi.min_wage}"><p class="hint">Check your EOBI notice</p></div>
            <div class="field"><label class="f" for="e2">Company pays %</label><input id="e2" class="num" name="eobi_er" type="number" step="0.5" value="${R.eobi.er}"></div>
            <div class="field"><label class="f" for="e3">Employee pays %</label><input id="e3" class="num" name="eobi_ee" type="number" step="0.5" value="${R.eobi.ee}"></div></div></div></section>
        <section class="panel"><header><h2>Who approves</h2>${owner ? '' : html`<span class="muted small">Only the owner changes these</span>`}</header><div class="body">
          ${rule('Payroll needs the owner to approve it', 'HR prepares it, the owner approves it. Off: HR can approve on its own.', sw('owner_approves', R.owner_approves, !owner))}
          ${rule('HR can change their own pay', 'Off: a change to an HR person’s pay is made by the owner', sw('hr_own_pay', R.hr_own_pay, !owner))}
          ${rule('Managers approve expenses first', 'Then HR approves them and they go on payroll', sw('managers_first', R.managers_first, !owner))}</div></section>
      </div></div>
    <div class="form-end"><p class="err" data-err></p><button class="btn primary" type="submit">${icon('check')} Save rules</button></div></form>`;
}

const TAX_ON_TXT = 'On the brackets below, for people paid in rupees whose own pay has tax switched on (in People and pay)';
const TAX_OFF_TXT = 'Off: nobody has tax taken, and payslips say so. Months already approved keep what they had.';
// ---------- actions ----------
const act = (fn) => async (el) => { try { await fn(el); } catch (e) { toast(errMsg(e), true); } };
// which month's pay: named by the month worked, with when it goes out, so October's pay in November is October
actions['pr-start'] = async () => {
  let ov; try { ov = await get('/api/payroll'); } catch (e) { toast(errMsg(e), true); return; }
  const pick = nextPeriod(ov), month = (p) => periodLabel(p).split(' ')[0];
  openModal({
    title: 'Which month are you paying for?', submit: 'Start',
    sub: pick ? 'Pick the month people worked. Their pay goes out early in the month after.' : 'Your latest month is already started. Pick an earlier month only to catch up on one that was missed.',
    body: html`<div class="pr-pick" role="radiogroup" aria-label="Month">${periodChoices(ov).map((o) => html`<label class="pr-po${o.run ? ' taken' : ''}">
      <input type="radio" name="period" value="${o.period}" ${raw(o.period === pick && !o.run ? 'checked' : '')} ${raw(o.run ? 'disabled' : '')}>
      <span class="pr-pt"><b>${periodLabel(o.period)}</b><small>${o.run ? `Already started · ${STATUS[o.run.status] ? STATUS[o.run.status][1].toLowerCase() : o.run.status}` : `Work in ${month(o.period)}, paid ${payWindowText(ov, o.period)}${o.ended ? '' : ' · not over yet'}`}</small></span>
      ${o.run ? html`<a class="linkbtn small" href="#/payroll?run=${o.run.id}" data-close>Open</a>` : ''}</label>`)}</div>`,
    onSubmit: async (fd) => {
      const period = fd.get('period'); if (!period) throw new Error('Pick a month');
      const d = await post('/api/payroll/runs', { period }); toast(`${periodLabel(period)} started`); S.navigate(`#/payroll?run=${d.run.id}`);
    },
  });
};
actions['pr-refresh'] = act(async (el) => { await post(`/api/payroll/runs/${el.dataset.id}/refresh`); toast('Worked out again'); S.refresh(); });
actions['pr-submit'] = async (el) => {
  if (!(await confirmBox({ title: 'Send for approval?', message: 'Everyone on this month can then see their payslip and ask about it. You can still change it until it is approved.', confirm: 'Send' }))) return;
  try { await post(`/api/payroll/runs/${el.dataset.id}/submit`); toast('Sent for approval'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['pr-remove'] = async (el) => {
  if (!(await confirmBox({ title: `Remove the ${el.dataset.period} draft?`, message: 'What HR added to it goes too. Nobody has seen it yet.', confirm: 'Remove', danger: true }))) return;
  try { await del(`/api/payroll/runs/${el.dataset.id}`); toast('Removed'); S.navigate('#/payroll?tab=history'); } catch (e) { toast(errMsg(e), true); }
};
// Excel files laid out to read and print; the plain CSV only for a bank's upload
actions['pr-dl'] = act(async (el) => {
  const fmt = el.dataset.fmt || 'xlsx', k = el.dataset.kind;
  await download(`/api/payroll/runs/${el.dataset.id}/${k}.${fmt}`, `${k === 'bank' ? 'bank-sheet' : fmt === 'csv' ? 'payroll' : 'payroll-register'}-${el.dataset.period}.${fmt}`);
});
actions['pr-approve'] = act(async (el) => {
  const d = await get(`/api/payroll/runs/${el.dataset.id}`);
  const pk = d.totals.PKR, usd = d.totals.USD;
  const toBank = d.slips.filter((s) => s.currency === 'PKR' && s.facts.bank && !s.by_hand).reduce((n, s) => n + s.net, 0);
  const q = d.checks.find((c) => c.kind === 'question'), bank = d.checks.find((c) => c.kind === 'bank');
  const item = (state, t, sub) => html`<li class="${state}"><span class="ck">${state === 'done' ? icon('check') : state === 'warn' ? icon('flag') : icon('x')}</span><div><b>${t}</b><span>${sub}</span></div></li>`;
  openModal({
    title: `Approve ${d.run.name.split(' ')[0]}?`, sub: `${plural(d.slips.length, 'person', 'people')} · paid ${dayShort(d.run.pay_day)} to ${dayShort(d.run.pay_by)}`, submit: 'Approve and send payslips',
    body: html`<div class="ap-sum"><div class="g"><span>To your bank</span><b class="num">${money(toBank)}</b></div>${usd ? html`<div><span>Separately</span><b class="num">${money(usd.net, 'USD')}</b></div>` : ''}<div class="t"><span>Income tax withheld</span><b class="num">${money(pk ? pk.tax : 0)}</b></div></div>
      <ul class="checklist noline">${item('done', 'Hours and attendance are final', `Everything up to the end of ${d.run.name.split(' ')[0]}. Later changes go on the next month.`)}
        ${q ? item('bad', q.text, 'Answer them first. People are told when you do.') : item('done', 'No questions waiting', 'Everyone could check their payslip')}
        ${bank ? item('warn', bank.text, 'They are left off the bank sheet unless you mark them paid by hand. Their payslip still goes out.') : ''}</ul>
      <div class="banner info" style="margin:14px 0 0"><span><b>When you approve:</b> the month is locked, everyone gets their payslip and a notification, and the bank sheet is ready. A mistake found later is fixed with a correction on the next month.</span></div>`,
    onSubmit: async () => { if (q) throw new Error('Answer the questions first'); await post(`/api/payroll/runs/${d.run.id}/approve`); toast(`${d.run.name.split(' ')[0]} approved. Payslips sent.`); S.refresh(); },
  });
});
const paidFields = (from) => html`<div class="grid2"><div class="field"><label class="f" for="pon">Paid on</label><input id="pon" name="on" type="date" value="${companyToday()}" min="${from || ''}" max="${companyToday()}" required></div>
  <div class="field"><label class="f" for="pref">Bank reference (optional)</label><input id="pref" name="ref" maxlength="120" placeholder="From your bank’s confirmation"></div></div>`;
actions['pr-paid'] = (el) => openModal({
  title: el.dataset.left && Number(el.dataset.left) < 1 ? 'Mark as paid?' : `Mark ${plural(Number(el.dataset.left) || 0, 'person', 'people')} paid?`, submit: 'Mark paid',
  sub: 'Everyone not marked yet, paid on the same day (one bank batch). Each person is told. People paid on other days can be marked one by one instead.',
  body: paidFields(),
  onSubmit: async (fd) => { await post(`/api/payroll/runs/${el.dataset.id}/paid`, { on: fd.get('on'), ref: fd.get('ref') || null }); toast('Marked paid'); S.refresh(); },
});
actions['pr-pay-one'] = (el) => openModal({
  title: `Mark ${el.dataset.name} paid?`, submit: 'Mark paid', sub: `${el.dataset.net}. They are told it was sent.`,
  body: paidFields(el.dataset.from),
  onSubmit: async (fd) => { await post(`/api/payroll/slips/${el.dataset.id}/paid`, { on: fd.get('on'), ref: fd.get('ref') || null }); toast(`${el.dataset.name} marked paid`); S.refresh(); },
});
actions['pr-unpay'] = async (el) => { try { await del(`/api/payroll/slips/${el.dataset.id}/paid`); toast(`${el.dataset.name} is not marked paid now`); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['pr-remove-any'] = (el) => openModal({
  title: `Remove ${el.dataset.period}?`, submit: 'Remove', danger: true,
  sub: `It was ${el.dataset.status === 'paid' ? 'marked paid' : el.dataset.status === 'approved' ? 'approved' : 'sent for review'}. Its payslips are removed and everyone on it is told. Use this for a test month or one started by mistake, never for a month people were really paid for.`,
  body: html`<div class="field"><label class="f" for="rmc">Type <b>${el.dataset.period}</b> to remove it</label><input id="rmc" name="confirm" autocomplete="off" required></div>`,
  onSubmit: async (fd) => { await del(`/api/payroll/runs/${el.dataset.id}?confirm=${encodeURIComponent(fd.get('confirm') || '')}`); toast(`${el.dataset.period} removed`); S.navigate('#/payroll'); },
});
actions['pr-add-item'] = async (form) => {
  const fd = new FormData(form), err = form.querySelector('[data-err]');
  err.textContent = '';
  try {
    const kind = fd.get('kind'), amount = Number(fd.get('amount'));
    if (!amount) throw new Error('Give an amount');
    if (kind !== 'correction' && amount < 0) throw new Error('Give the amount as a positive number. Use Deduction or Correction to take money off.');
    await post(`/api/payroll/runs/${form.dataset.run}/items`, { user_id: Number(form.dataset.user), kind, amount, reason: fd.get('reason') });
    toast('Added'); form.reset(); S.refresh();
  } catch (e) { err.textContent = errMsg(e); }
};
actions['pr-del-item'] = async (el) => {
  if (!(await confirmBox({ title: `Remove “${el.dataset.label}”?`, message: 'It comes off this month. The audit log keeps a record.', confirm: 'Remove', danger: true }))) return;
  try { await del(`/api/payroll/items/${el.dataset.id}`); toast('Removed'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['pr-line-off'] = (el) => openModal({
  title: `Remove “${el.dataset.label}”?`, submit: 'Remove from this month', danger: true,
  sub: `${el.dataset.amount} won’t count on ${el.dataset.name ? `${el.dataset.name.split(' ')[0]}’s` : 'this'} pay this month. The line stays on the payslip, crossed out, with your reason. You can put it back until the month is approved.`,
  body: html`<div class="field"><label class="f" for="rl-r">Why (they see this)</label><input id="rl-r" name="reason" maxlength="300" required placeholder="Worked from home those days, agreed with the manager" autocomplete="off"></div>`,
  onSubmit: async (fd) => { const reason = String(fd.get('reason') || '').trim(); if (!reason) throw new Error('Say why, in a few words'); await post(`/api/payroll/slips/${el.dataset.id}/remove-line`, { key: el.dataset.key, reason }); toast(`${el.dataset.label} removed`); S.refresh(); },
});
actions['pr-leave-off'] = (el) => openModal({
  title: `Leave ${el.dataset.name.split(' ')[0]} off this month?`, submit: 'Leave off', danger: true,
  sub: `${el.dataset.net} isn’t paid to ${el.dataset.name} this month and they get no payslip. Their pay and HR record don’t change, and next month works as usual. You can put them back until the month is approved.`,
  body: html`<div class="field"><label class="f" for="lo-r">Why</label><input id="lo-r" name="reason" maxlength="300" required placeholder="Joined mid-month, paid with November" autocomplete="off"></div>`,
  onSubmit: async (fd) => { const reason = String(fd.get('reason') || '').trim(); if (!reason) throw new Error('Say why, in a few words'); await post(`/api/payroll/runs/${el.dataset.run}/leave-off`, { user_id: Number(el.dataset.id), reason }); toast(`${el.dataset.name} left off this month`); S.refresh(); },
});
actions['pr-put-back'] = async (el) => { try { await post(`/api/payroll/runs/${el.dataset.run}/leave-off`, { user_id: Number(el.dataset.id), undo: true }); toast(`${el.dataset.name} is back on this month`); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['pr-line-back'] = async (el) => { try { await post(`/api/payroll/slips/${el.dataset.id}/remove-line`, { key: el.dataset.key, undo: true }); toast(`${el.dataset.label} put back`); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['pr-answer'] = async (form) => {
  try { await post(`/api/payroll/questions/${form.dataset.id}/answer`, { answer: new FormData(form).get('answer') }); toast('Answered'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (!el.matches || !el.matches('[data-act="pr-byhand"]')) return;
  try { await post(`/api/payroll/slips/${el.dataset.id}/by-hand`, { by_hand: el.checked }); toast(el.checked ? 'Marked to pay by hand' : 'Back on the bank sheet'); S.refresh(); } catch (er) { toast(errMsg(er), true); }
});
actions['pr-rules'] = async (form) => {
  const fd = new FormData(form), err = form.querySelector('[data-err]');
  err.textContent = '';
  const n = (k) => Number(fd.get(k));
  const his = fd.getAll('b_hi'), fxs = fd.getAll('b_fx'), pcts = fd.getAll('b_pct');
  const brackets = fxs.map((fx, i) => [i < his.length ? Number(his[i]) : null, Number(fx), Number(pcts[i])]);
  const body = {
    day_basis: fd.get('day_basis'), unpaid_leave: fd.get('unpaid_leave'), absent: fd.get('absent'), first_month: fd.get('first_month'),
    late: { mode: fd.get('late_mode'), every: n('late_every'), days: n('late_days') }, overtime: { mode: fd.get('ot_mode'), rate: n('ot_rate') },
    leave_payout: !!fd.get('leave_payout'), pay_day: n('pay_day'), pay_by: n('pay_by'), tax: { on: !!fd.get('tax_on'), label: fd.get('tax_label'), brackets },
    eobi: { on: !!fd.get('eobi_on'), min_wage: n('eobi_min'), er: n('eobi_er'), ee: n('eobi_ee') },
  };
  if (S.me.role === 'owner') Object.assign(body, { owner_approves: !!fd.get('owner_approves'), hr_own_pay: !!fd.get('hr_own_pay'), managers_first: !!fd.get('managers_first') });
  try { await put('/api/payroll/rules', body); toast('Rules saved'); S.refresh(); } catch (e) { err.textContent = errMsg(e); }
};
// the brackets fade as soon as income tax is switched off (saved with "Save rules")
document.addEventListener('change', (e) => {
  const box = e.target && e.target.name === 'tax_on' && e.target.closest('#tax'); if (!box) return;
  box.classList.toggle('tax-off', !e.target.checked);
  const say = box.querySelector('.prule span');
  if (say) say.textContent = e.target.checked ? TAX_ON_TXT : TAX_OFF_TXT;
});
