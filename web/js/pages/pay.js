// An employee's own pay: payslips (every line says where it came from, and each can be asked about),
// this tax year, expense claims, an advance, and the yearly salary and tax certificate.
import { html, raw, esc, icon, money, periodLabel, dayShort, dateY, dayMD, relTime, plural, addMonths } from '../util.js';
import { get, post, del, qs, fileBase64, fileUrl, download } from '../api.js';
import { S, actions, tag, empty, openModal, confirmBox, toast, errMsg } from '../ui.js';
import { myToday } from '../parts.js';
import { qAttr } from '../ui.js';
import { companyMark } from './company.js';

export const STATUS = { draft: ['idle', 'Draft'], review: ['break', 'Being checked'], approved: ['working', 'Approved'], paid: ['working', 'Paid'] };
export const EXP_STATUS = { pending: ['break', 'Waiting'], manager_ok: ['break', 'Manager approved, waiting for HR'], approved: ['working', 'Approved: with your next salary'], paid: ['working', 'Paid'], declined: ['absent', 'Declined'] };
export const CATS = [['travel', 'Travel'], ['meals', 'Meals'], ['equipment', 'Equipment'], ['software', 'Software'], ['phone', 'Phone'], ['other', 'Other']];
const catName = (c) => (CATS.find((x) => x[0] === c) || [c, c])[1];

// gross split into what reaches the person, tax and deductions
export function payBar(s, { dark = false } = {}) {
  const g = Math.max(1, s.gross), w = (n) => `${Math.max(0, (100 * n) / g).toFixed(2)}%`;
  return html`<div class="paybar${dark ? ' dark' : ''}"><div class="pb-bar" aria-hidden="true"><i class="pb-net" style="width:${w(Math.max(0, s.net))}"></i><i class="pb-tax" style="width:${w(s.tax)}"></i><i class="pb-ded" style="width:${w(s.deductions)}"></i></div>
    <div class="pb-keys"><div><span><i class="pb-k gross"></i>Gross pay</span><b class="num">${money(s.gross, s.currency)}</b></div><div><span><i class="pb-k net"></i>Paid to ${s.people ? 'people' : 'you'}</span><b class="num">${money(s.net, s.currency)}</b></div>
    <div><span><i class="pb-k tax"></i>Income tax</span><b class="num">${money(s.tax, s.currency)}</b></div><div><span><i class="pb-k ded"></i>Deductions</span><b class="num">${money(s.deductions, s.currency)}</b></div></div></div>`;
}
// the lines of a payslip; ask: show "Ask about this" on each
export function slipLines(s, { ask = false, hr = false } = {}) {
  // a line worked out by Staffwarden (absent, late, a fixed deduction...) can be taken off this month by HR
  const removable = (l) => hr && !l.item && !l.expense && (l.kind !== 'base' || /^prev:/.test(l.key)) && !/^adv:/.test(l.key);
  const act = (l) => (ask ? html`<button type="button" class="linkbtn" data-act="pay-ask" data-id="${s.id}" data-line="${l.label}">Ask about this</button>`
    : hr && l.item ? html`<button type="button" class="linkbtn danger" data-act="pr-del-item" data-id="${l.item}" data-label="${l.label}">Remove</button>`
      : removable(l) && l.removed ? html`<button type="button" class="linkbtn" data-act="pr-line-back" data-id="${s.id}" data-key="${l.key}" data-label="${l.label}">Put back</button>`
        : removable(l) && l.counted ? html`<button type="button" class="linkbtn danger" data-act="pr-line-off" data-id="${s.id}" data-key="${l.key}" data-label="${l.label}" data-amount="${money(Math.abs(l.amount), s.currency)}" data-name="${s.name || ''}">Remove</button>`
          : html`<span></span>`);
  const ln = (l) => html`<div class="sl${l.counted ? '' : ' shown'}${l.removed ? ' removed' : ''}" data-k="l${l.key}">
      <b>${l.label}${l.removed ? html` <span class="tag idle"><i></i>Taken off this month</span>` : l.counted ? '' : html` <span class="tag idle"><i></i>Shown only</span>`}</b>
      <b class="num ${l.amount < 0 ? 'neg' : ''}">${l.amount < 0 ? '− ' : ''}${money(Math.abs(l.amount), s.currency).replace('− ', '')}</b>
      <span class="src">${l.removed ? html`Removed by ${l.removed.by}: ${l.removed.reason}` : html`${l.source}${l.link && hr ? html` · <a href="${l.link}">See the days</a>` : ''}`}</span>
      ${act(l)}</div>`;
  return html`<div class="slines">${s.lines.map(ln)}
    ${s.tax || s.facts.tax_note ? html`<div class="sl" data-k="ltax"><b>Income tax</b><b class="num tax">${s.tax ? '− ' + money(s.tax, s.currency) : money(0, s.currency)}</b><span class="src">${s.facts.tax_note}</span>${ask ? html`<button type="button" class="linkbtn" data-act="pay-ask" data-id="${s.id}" data-line="Income tax">Ask about this</button>` : html`<span></span>`}</div>` : ''}
    <div class="sl-total"><b>Net pay</b><b class="num">${money(s.net, s.currency)}</b></div>
    ${s.employer && s.employer.length ? html`<div class="sl-employer"><b>Paid by ${esc(S.settings.org_name)} for you, not from your pay:</b> ${s.employer.map((e) => `${e.label} ${money(e.amount, s.currency)}`).join(', ')}</div>` : ''}</div>`;
}
export function questionsBlock(s, { hr = false } = {}) {
  if (!s.questions || !s.questions.length) return '';
  return html`<div class="pqs">${s.questions.map((q) => html`<div class="pq ${q.answer ? 'done' : ''}" data-k="q${q.id}">
      <div class="pq-h">${icon('msg')}<b>${hr ? `${s.name} asked` : 'You asked'}${q.line ? ` about “${q.line}”` : ''}</b><span class="muted small">${relTime(q.created_at)}</span></div>
      <p>${q.text}</p>
      ${q.answer ? html`<p class="pq-a"><b>${q.answered_by_name || 'HR'}:</b> ${q.answer}</p>` : hr ? html`<form class="pq-form" data-submit="pr-answer" data-id="${q.id}" novalidate><input name="answer" placeholder="Write an answer ${s.name.split(' ')[0]} will see" maxlength="800" required aria-label="Answer"><button class="btn primary sm" type="submit">Answer</button></form>` : html`<p class="muted small">HR answers before the month is approved. You are told when they do.</p>`}</div>`)}</div>`;
}

export default {
  title: 'Pay',
  async load(q) {
    const tab = q.get('tab') || 'slips';
    const me = await get('/api/me/pay');
    let slip = null, expenses = null, cert = null;
    if (tab === 'slips') { const id = q.get('id') || (me.slips[0] && me.slips[0].id); if (id) slip = await get(`/api/payroll/slips/${id}`); }
    if (tab === 'expenses') expenses = await get('/api/expenses?scope=mine');
    if (tab === 'certificate') cert = await get(`/api/me/certificate${qs({ tax_year: q.get('year') })}`);
    return { me, slip, expenses, cert, tab };
  },
  render({ me, slip, expenses, cert, tab }) {
    const tabs = [['slips', 'Payslips'], ['expenses', 'Expenses'], ['advance', 'Advance'], ...(me.year.pk ? [['certificate', 'Tax certificate']] : [])];
    const head = html`<div class="page-h"><div><h1>Your pay</h1><p class="sub">${me.base ? `${money(me.base.amount, me.base.currency)} a month${me.bank ? ` · paid to ${me.bank.name || 'your bank'} ••• ${me.bank.last4}` : ''}` : 'Every line says where it came from'}</p></div>
      <div class="tools">${tab === 'expenses' ? html`<button class="btn primary" data-act="exp-new">${icon('plus')} New expense</button>` : tab === 'advance' ? (me.advances.some((a) => a.status === 'pending' || a.status === 'approved') ? '' : html`<button class="btn primary" data-act="adv-new">Ask for an advance</button>`) : tab === 'certificate' && cert && cert.months ? html`<button class="btn primary" data-act="pay-pdf" data-url="/api/me/certificate.pdf?tax_year=${cert.tax_year}" data-name="tax-certificate-${cert.tax_year}.pdf">${icon('download')} Download PDF</button>` : slip ? html`<button class="btn" data-act="pay-pdf" data-url="/api/payroll/slips/${slip.id}/pdf" data-name="payslip-${slip.run ? slip.run.period : slip.id}.pdf">${icon('download')} Download PDF</button>` : ''}</div>
      <nav class="tabs" aria-label="Pay">${tabs.map(([v, n]) => html`<button type="button" class="tab" data-act="q" ${raw(qAttr('tab', v === 'slips' ? '' : v))} aria-current="${tab === v ? 'page' : 'false'}">${n}</button>`)}</nav></div>`;
    if (tab === 'expenses') return html`${head}${expensesView(expenses)}`;
    if (tab === 'advance') return html`${head}${advanceView(me)}`;
    if (tab === 'certificate') return html`${head}${certView(cert)}`;
    if (!me.slips.length) return html`${head}<section class="panel">${empty('No payslips yet', me.base ? 'Your payslip shows here when HR prepares the month. You can check every line and ask about anything before it is approved.' : 'HR has not set up your pay yet.')}</section>`;
    const [cls, word] = STATUS[slip.run.status];
    const canAsk = slip.run.status === 'review' || slip.run.status === 'approved';
    const main = html`<section class="panel printable slip" data-k="slip${slip.id}"><div class="body">
        <div class="slip-h"><div><div class="muted small">${slip.paid_on ? `Paid ${dayShort(slip.paid_on)}` : slip.run.status === 'approved' || slip.run.status === 'paid' ? `Paid by ${dayShort(slip.run.pay_by)}` : `Pay day ${dayShort(slip.run.pay_day)} to ${dayShort(slip.run.pay_by)}`}${slip.bank ? `, to ${slip.bank.name || 'your bank'} ••• ${slip.bank.last4}` : ''}</div>
          <b class="slip-net num">${money(slip.net, slip.currency)}</b><div class="muted">Net pay for ${periodLabel(slip.run.period)} ${tag(cls, word)}</div></div>
          <div class="slip-org">${companyMark()}<span class="muted small">${S.me.name}</span></div></div>
        ${slip.run.status === 'review' ? html`<div class="banner info" style="margin:14px 0 0"><span>This month is still being checked, so it can change. Ask about anything that looks wrong.</span></div>` : ''}
        <div style="margin:18px 0 6px">${payBar(slip)}</div>
        ${slipLines(slip, { ask: canAsk })}
        ${questionsBlock(slip)}</div></section>`;
    const y = me.year;
    const side = html`<div class="noprint">
      <section class="panel"><header><h2>${y.pk ? 'This tax year' : `${y.tax_year} so far`}</h2><span class="muted small">${periodLabel(y.from)} to ${periodLabel(y.to)}</span></header><div class="body"><dl class="kv tight">
        <dt>Gross pay</dt><dd class="num r">${money(y.gross, y.currency)}</dd>${y.pk || y.tax ? html`<dt>Income tax</dt><dd class="num r">${money(y.tax, y.currency)}</dd>` : ''}<dt>Deductions</dt><dd class="num r">${money(y.deductions, y.currency)}</dd><dt>Net pay</dt><dd class="num r">${money(y.net, y.currency)}</dd></dl>
        <p class="small muted mt">${plural(y.months, 'month')} approved so far.</p></div></section>
      <section class="panel flush"><header><h2>Payslips</h2></header><div class="body"><ul class="blist">${me.slips.map((s) => html`<li class="clickable" data-k="p${s.id}" data-act="go" data-href="#/pay?id=${s.id}" tabindex="0" ${s.id === slip.id ? raw('aria-current="true"') : ''}><span class="what">${s.name}</span><span class="len num">${money(s.net, s.currency)}</span><span class="when">${STATUS[s.status][1]}${s.open_questions ? ' · question waiting' : ''}</span></li>`)}</ul></div></section>
      <div class="pay-tiles"><a class="pay-tile" href="#/pay?tab=expenses">${icon('receipt')}<b>Expenses</b><span>Send a receipt; it’s paid with your salary</span></a><a class="pay-tile" href="#/pay?tab=advance">${icon('wallet')}<b>Advance</b><span>Ask for part of your pay early</span></a></div></div>`;
    return html`${head}<div class="cols">${main}${side}</div>`;
  },
};

function expensesView(list) {
  if (!list.length) return html`<section class="panel">${empty('No expense claims', 'Paid for something for work? Send the receipt with New expense. Once approved it is paid with your next salary, not taxed.')}</section>`;
  return html`<section class="panel flush"><header><h2>Your claims</h2><span class="muted small">Paid back with your salary, not taxed</span></header><div class="body"><ul class="claims">
    ${list.map((e) => { const [c, w] = EXP_STATUS[e.status]; return html`<li data-k="e${e.id}"><div class="cl-main"><b>${e.note}</b><span>${dayShort(e.spent_on)} · ${catName(e.category)}${e.has_receipt ? html` · <button class="linkbtn" data-act="exp-receipt" data-id="${e.id}">Receipt</button>` : ''}</span></div>
      <b class="num cl-amt">${money(e.amount, e.currency)}</b>
      <div class="cl-st">${tag(c, w)}${e.status === 'declined' && e.decline_reason ? html`<span class="small muted">${e.decline_reason}</span>` : ''}${e.status === 'pending' ? html`<button class="btn sm danger" data-act="exp-cancel" data-id="${e.id}">Take back</button>` : ''}</div></li>`; })}
    </ul></div></section>`;
}
function advanceView(me) {
  const a = me.advances[0];
  const info = html`<section class="panel"><header><h2>How advances work</h2></header><div class="body"><ul class="plain">
    <li>Ask for up to one month of your salary${me.base ? ` (${money(me.base.amount, me.base.currency)})` : ''}.</li><li>HR decides. Once approved, you are paid it straight away.</li><li>It comes off your payslips in equal parts, starting the month after, and each payslip shows what is left.</li></ul></div></section>`;
  if (!a) return html`<div class="cols">${html`<section class="panel">${empty('No advance', 'Need money before pay day? Ask for an advance and choose how many months to pay it back over.')}</section>`}${info}</div>`;
  const [c, w] = { pending: ['break', 'Waiting for HR'], approved: ['working', 'Being paid back'], repaid: ['working', 'Paid back'], declined: ['absent', 'Declined'] }[a.status];
  return html`<div class="cols"><section class="panel"><header><h2>Your advance</h2>${tag(c, w)}</header><div class="body">
      <b class="slip-net num">${money(a.amount, a.currency)}</b><p class="muted">${money(a.installment, a.currency)} a month over ${plural(a.months, 'month')}. Asked ${relTime(a.created_at)}${a.reason ? `: ${a.reason}` : ''}</p>
      ${a.decision_note ? html`<p class="muted small">${a.decided_name || 'HR'}: ${a.decision_note}</p>` : ''}
      ${me.advances.length > 1 ? html`<p class="small muted mt">Earlier: ${me.advances.slice(1).map((x) => `${money(x.amount, x.currency)} (${x.status})`).join(', ')}</p>` : ''}</div></section>${info}</div>`;
}
function certView(c) {
  if (!c || !c.months) return html`<section class="panel">${empty('No certificate yet', `Tax year ${c ? c.tax_year : ''} has no approved payslips. The certificate is ready once a year’s payroll is approved.`)}</section>`;
  const row = (a, b, strong) => html`<div class="cert-r ${strong ? 'strong' : ''}"><span>${a}</span><b class="num">${money(b, c.currency)}</b></div>`;
  return html`<section class="panel printable cert"><div class="body">
    <div class="cert-h"><div class="cert-org"><span class="mark-sm">${esc(c.company)}</span></div><div class="muted small r">Issued ${dayShort(c.issued)}</div></div>
    <h2 class="cert-t">Salary and tax certificate</h2><p class="muted">Tax year ${c.tax_year}: July 1, ${c.tax_year - 1} to June 30, ${c.tax_year}</p>
    <dl class="cert-who"><dt>Name</dt><dd>${c.person.name}</dd><dt>Job title</dt><dd>${c.person.title || '–'}</dd><dt>Employed since</dt><dd>${c.person.joined ? dateY(c.person.joined) : '–'}</dd><dt>Months paid</dt><dd>${c.months}</dd></dl>
    ${row('Salary', c.salary)}${row('Allowances', c.allowances)}${row('Commission, bonuses and other pay', c.extra)}${row('Total pay', c.total, true)}${row('Income tax taken from pay', c.tax)}${c.eobi ? row('EOBI, employee share', c.eobi) : ''}${c.other ? row('Advances and other deductions', c.other) : ''}${c.expenses ? row('Expenses paid back, not taxed', c.expenses) : ''}${row('Net pay', c.net, true)}
    <p class="small muted mt">Made from ${esc(c.company)}’s payroll records in Staffwarden. Income tax was taken from salary each month.</p>
    <div class="cert-sign"><span>Authorised signature</span></div></div></section>
    <p class="small muted noprint">Other years: ${[c.tax_year - 1, c.tax_year + 1].map((y) => html`<a href="#/pay?tab=certificate&year=${y}">Tax year ${y}</a>`).reduce((a, b) => html`${a} · ${b}`)}</p>`;
}

// ---- actions ----
actions.print = () => window.print();
// a real PDF from the server: works in Safari and on phones, where print() often does nothing
actions['pay-pdf'] = async (el) => { el.disabled = true; try { await download(el.dataset.url, el.dataset.name); } catch (e) { toast(errMsg(e), true); } finally { el.disabled = false; } };
actions['pay-ask'] = (el) => {
  openModal({
    title: `Ask about “${el.dataset.line}”`, submit: 'Send to HR', sub: 'HR answers before the month is approved, and you are told when they do.',
    body: html`<div class="field"><label class="f" for="pq">Your question</label><textarea id="pq" name="text" maxlength="600" required placeholder="What looks wrong, and why?"></textarea></div>`,
    onSubmit: async (fd) => { await post(`/api/payroll/slips/${el.dataset.id}/questions`, { line: el.dataset.line, text: fd.get('text') }); toast('Sent to HR'); S.refresh(); },
  });
};
actions['exp-new'] = () => {
  const today = myToday();
  openModal({
    title: 'New expense', submit: 'Send', sub: 'Your manager approves it, then HR. It is paid with your next salary as its own line, and not taxed.',
    body: html`<div class="field"><label class="f" for="ex-r">Receipt (photo or PDF)</label><input id="ex-r" type="file" name="receipt" accept="image/png,image/jpeg,image/webp,application/pdf"><p class="hint">Up to 5 MB.</p></div>
      <div class="grid2"><div class="field"><label class="f" for="ex-a">Amount</label><input id="ex-a" name="amount" type="number" min="1" step="1" required inputmode="numeric"></div>
        <div class="field"><label class="f" for="ex-d">Date</label><input id="ex-d" type="date" name="spent_on" value="${today}" max="${today}" required></div></div>
      <div class="field"><span class="f" style="display:block">Category</span><div class="chips">${CATS.map(([v, n], i) => html`<label class="chip"><input type="radio" name="category" value="${v}" ${i === 0 ? raw('checked') : ''}> ${n}</label>`)}</div></div>
      <div class="field"><label class="f" for="ex-n">What it was for</label><input id="ex-n" name="note" maxlength="300" required placeholder="Careem to a client meeting"></div>`,
    onSubmit: async (fd) => {
      const f = fd.get('receipt');
      const body = { amount: Number(fd.get('amount')), category: fd.get('category'), spent_on: fd.get('spent_on'), note: fd.get('note') };
      if (!(body.amount > 0)) throw new Error('Give the amount');
      if (f && f.size) { if (f.size > 5 * 1024 * 1024) throw new Error('The receipt is over 5 MB'); body.receipt_base64 = await fileBase64(f); body.receipt_type = f.type; }
      await post('/api/expenses', body); toast('Sent'); S.refresh();
    },
  });
};
actions['exp-cancel'] = async (el) => {
  if (!(await confirmBox({ title: 'Take back this claim?', message: 'It is removed. You can send it again later.', confirm: 'Take back', danger: true }))) return;
  try { await del(`/api/expenses/${el.dataset.id}`); toast('Taken back'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['exp-receipt'] = async (el) => {
  try { const url = await fileUrl(`/api/expenses/${el.dataset.id}/receipt`); window.open(url, '_blank', 'noopener'); } catch (e) { toast(errMsg(e), true); }
};
actions['adv-new'] = async () => {
  let me;
  try { me = await get('/api/me/pay'); } catch (e) { toast(errMsg(e), true); return; }
  if (!me.base) { toast('HR has not set up your pay yet', true); return; }
  const cur = me.base.currency, max = me.base.amount;
  const next = addMonths(myToday().slice(0, 7), 1);
  const m = openModal({
    title: 'Ask for an advance', submit: 'Send to HR',
    body: html`<div class="field"><label class="f" for="ad-a">How much</label><input id="ad-a" name="amount" type="number" min="1000" max="${max}" step="500" value="${Math.min(max, Math.round(max / 2 / 1000) * 1000)}" required inputmode="numeric"><p class="hint">Up to ${money(max, cur)}, one month of your salary.</p></div>
      <div class="field"><span class="f" style="display:block">Pay it back over</span><div class="chips">${[2, 3, 5, 10].map((n) => html`<label class="chip"><input type="radio" name="months" value="${n}" ${n === 5 ? raw('checked') : ''}> ${n} months</label>`)}</div></div>
      <div class="adv-prev" data-advprev aria-live="polite"></div>
      <div class="field"><label class="f" for="ad-r">Why (only HR sees this)</label><input id="ad-r" name="reason" maxlength="300"></div>`,
    onSubmit: async (fd) => { await post('/api/advances', { amount: Number(fd.get('amount')), months: Number(fd.get('months')), reason: fd.get('reason') || null }); toast('Sent to HR'); S.refresh('advance'); },
  });
  const form = [...document.querySelectorAll('#overlay form.modal')].pop();
  const upd = () => {
    const a = Number(form.amount.value) || 0, n = Number(new FormData(form).get('months')) || 1, inst = Math.ceil(a / n);
    const months = Array.from({ length: n }, (_, i) => periodLabel(addMonths(next, i)).split(' ')[0].slice(0, 3));
    form.querySelector('[data-advprev]').innerHTML = html`<div class="adv-h"><b>${money(inst, cur)} a month</b><span>${months[0]} to ${months[months.length - 1]}</span></div><div class="adv-bars">${months.map((x) => html`<span><i></i>${x}</span>`)}</div><p>Comes off each payslip on its own. Your pay those months: about ${money(Math.max(0, max - inst), cur)}.</p>`.toString();
  };
  form.addEventListener('input', upd); upd();
  return m;
};
