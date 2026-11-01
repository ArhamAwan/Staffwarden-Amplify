// Expense claims and advances to review. Managers approve their team's claims first (when the owner has
// that on); HR approves them for payroll and decides advances.
import { html, raw, icon, money, dayShort, dayMD, relTime, plural, initials, avColor } from '../util.js';
import { get, post, qs, fileUrl } from '../api.js';
import { S, actions, tag, empty, openModal, toast, errMsg, qAttr, kpis } from '../ui.js';
import { ptabs } from './payroll.js';
import { EXP_STATUS, CATS } from './pay.js';
import { isHRme } from './hr.js';

const catName = (c) => (CATS.find((x) => x[0] === c) || [c, c])[1];
const av = (id, name) => html`<span class="avatar" style="background:${avColor(id)}" aria-hidden="true">${initials(name)}</span>`;
const mine = (e) => (isHRme() ? e.status === 'pending' || e.status === 'manager_ok' : e.status === 'pending');

export default {
  title: 'Expenses',
  async load(q) {
    const tab = q.get('tab') || 'claims';
    const claims = await get('/api/expenses');
    const advances = isHRme() ? await get('/api/advances') : [];
    const sel = Number(q.get('id')) || (claims.find(mine) || claims[0] || {}).id;
    let receipt = null;
    const c = claims.find((x) => x.id === sel);
    if (c && c.has_receipt && tab === 'claims') { try { receipt = await fileUrl(`/api/expenses/${c.id}/receipt`); } catch { receipt = null; } }
    return { tab, claims, advances, sel, receipt };
  },
  render({ tab, claims, advances, sel, receipt }) {
    const hr = isHRme();
    const waiting = claims.filter(mine);
    const sub = hr ? html`<nav class="seg-tabs" aria-label="Show">${[['claims', `Claims${waiting.length ? ' · ' + waiting.length : ''}`], ['advances', `Advances${advances.filter((a) => a.status === 'pending').length ? ' · ' + advances.filter((a) => a.status === 'pending').length : ''}`]].map(([v, n]) => html`<button type="button" data-act="q" ${raw(qAttr('tab', v === 'claims' ? '' : v))} aria-pressed="${String(tab === v)}">${n}</button>`)}</nav>` : '';
    const head = html`<div class="page-h"><div><h1>Expenses</h1><p class="sub">${hr ? 'People send a receipt, their manager approves it, and it is paid with their salary.' : 'Claims from your team. You approve them first, then HR.'}</p></div>
      <div class="tools">${sub}</div>${hr ? ptabs('expenses') : ''}</div>`;
    if (tab === 'advances' && hr) return html`${head}${advancesView(advances)}`;
    const sum = (list) => list.reduce((n, e) => n + (e.currency === 'PKR' ? e.amount : 0), 0);
    const cells = [
      { label: hr ? 'Waiting for you' : 'Waiting for you', value: String(waiting.length), tone: waiting.length ? 'warn' : '', foot: money(sum(waiting)) },
      { label: 'Going on the next payroll', value: String(claims.filter((e) => e.status === 'approved').length), foot: money(sum(claims.filter((e) => e.status === 'approved'))) },
      { label: 'Paid', value: String(claims.filter((e) => e.status === 'paid').length), foot: money(sum(claims.filter((e) => e.status === 'paid'))) },
      { label: 'Declined', value: String(claims.filter((e) => e.status === 'declined').length), foot: money(sum(claims.filter((e) => e.status === 'declined'))) },
    ];
    if (!claims.length) return html`${head}<section class="panel">${empty('No expense claims yet', 'People send them from their Pay page with a photo of the receipt.')}</section>`;
    const c = claims.find((x) => x.id === sel) || claims[0];
    const list = html`<section class="panel flush"><div class="body"><div class="tbl-wrap"><table class="t ext"><thead><tr><th>Person</th><th>Claim</th><th class="r">Amount</th><th>Where it is</th></tr></thead><tbody>
      ${claims.map((e) => { const over = e.limit != null && e.amount > e.limit; const [k, w] = EXP_STATUS[e.status];
        return html`<tr class="link ${e.id === c.id ? 'sel' : ''}" data-k="e${e.id}" data-act="q" ${raw(qAttr('id', e.id))} tabindex="0"><td class="nm"><span class="person">${av(e.user_id, e.user_name)}<span><b>${e.user_name}</b><span>${relTime(e.created_at)}</span></span></span></td>
        <td><b>${e.note}</b><div class="small muted">${catName(e.category)} · ${dayMD(e.spent_on)}</div></td><td class="r num"><b>${money(e.amount, e.currency)}</b></td>
        <td>${over && mine(e) ? tag('absent', `Over the ${catName(e.category).toLowerCase()} limit`) : tag(k, mine(e) ? (e.status === 'manager_ok' ? `${e.manager_name || 'Manager'} approved, waiting for you` : 'Waiting for you') : w)}</td></tr>`; })}</tbody></table></div></div></section>`;
    const [k, w] = EXP_STATUS[c.status];
    const over = c.limit != null && c.amount > c.limit;
    const detail = html`<section class="panel exp-detail" data-k="d${c.id}"><div class="body">
      <div class="exp-h"><span class="person">${av(c.user_id, c.user_name)}<span><b>${c.user_name}</b><span>Sent ${dayShort(c.created_at.slice(0, 10))}</span></span></span><b class="exp-amt num">${money(c.amount, c.currency)}</b></div>
      <ol class="exp-steps"><li class="done">${icon('check')}Sent</li><li class="${c.manager_by ? 'done' : c.status === 'pending' ? 'now' : ''}">${c.manager_by ? icon('check') : ''}Manager</li><li class="${['approved', 'paid'].includes(c.status) ? 'done' : c.status === 'manager_ok' ? 'now' : ''}">${['approved', 'paid'].includes(c.status) ? icon('check') : ''}HR</li><li class="${c.status === 'paid' ? 'done' : ''}">${c.status === 'paid' ? icon('check') : ''}Paid</li></ol>
      <div class="receipt">${receipt ? html`<img src="${receipt}" alt="Receipt for ${c.note}" data-act="exp-open" data-id="${c.id}">` : c.has_receipt ? html`<button class="btn" data-act="exp-open" data-id="${c.id}">${icon('file')} Open the receipt</button>` : html`<span class="muted">No receipt attached</span>`}</div>
      <dl class="kv tight"><dt>Category</dt><dd>${catName(c.category)}</dd><dt>Spent on</dt><dd>${dayShort(c.spent_on)}</dd><dt>What for</dt><dd>${c.note}</dd>
        ${c.limit != null ? html`<dt>Limit</dt><dd class="${over ? 'bad-t' : 'good-t'}">${over ? `Over the ${catName(c.category).toLowerCase()} limit of ${money(c.limit, c.currency)}` : `Within the ${catName(c.category).toLowerCase()} limit (${money(c.limit, c.currency)})`}</dd>` : ''}
        ${c.manager_name ? html`<dt>Manager</dt><dd>${c.manager_name}${c.manager_at ? `, ${relTime(c.manager_at)}` : ''}</dd>` : ''}${c.status === 'declined' && c.decline_reason ? html`<dt>Declined</dt><dd>${c.decline_reason}</dd>` : ''}</dl>
      ${mine(c) && c.user_id !== S.me.id ? html`<div class="exp-act"><button class="btn" data-act="exp-decide" data-id="${c.id}" data-name="${c.user_name}">${icon('x')} Decline</button><button class="btn go" data-act="exp-decide" data-id="${c.id}" data-approve="1" data-name="${c.user_name}">${icon('check')} ${hr ? 'Approve for the next payroll' : 'Approve, then HR'}</button></div>` : html`<p class="muted small">${tag(k, w)}</p>`}</div></section>`;
    return html`${head}${kpis(cells)}<div class="cols exp-cols">${list}${detail}</div>`;
  },
};

function advancesView(list) {
  if (!list.length) return html`<section class="panel">${empty('No advances', 'People ask for one from their Pay page. You decide here.')}</section>`;
  const st = { pending: ['break', 'Waiting for you'], approved: ['working', 'Being paid back'], repaid: ['offline', 'Paid back'], declined: ['absent', 'Declined'] };
  return html`<section class="panel flush"><div class="body"><div class="tbl-wrap"><table class="t"><thead><tr><th>Person</th><th class="r">Amount</th><th>Paid back</th><th>Why</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((a) => html`<tr data-k="a${a.id}"><td class="nm"><span class="person">${av(a.user_id, a.user_name)}<span><b>${a.user_name}</b><span>${relTime(a.created_at)}</span></span></span></td><td class="r num"><b>${money(a.amount, a.currency)}</b></td>
      <td class="num">${money(a.installment, a.currency)} × ${a.months}</td><td class="small">${a.reason || html`<span class="muted">–</span>`}</td><td>${tag(...st[a.status])}${a.decision_note ? html`<div class="small muted">${a.decision_note}</div>` : ''}</td>
      <td class="r nowrap">${a.status === 'pending' && a.user_id !== S.me.id ? html`<button class="btn sm" data-act="adv-decide" data-id="${a.id}" data-name="${a.user_name}">Decline</button> <button class="btn sm primary" data-act="adv-decide" data-id="${a.id}" data-approve="1" data-name="${a.user_name}">Approve</button>` : ''}</td></tr>`)}
    </tbody></table></div></div></section><p class="small muted">An approved advance is paid to them straight away, by hand. It comes off their payslips from the next month, and each payslip shows what is left.</p>`;
}

actions['exp-open'] = async (el) => { try { window.open(await fileUrl(`/api/expenses/${el.dataset.id}/receipt`), '_blank', 'noopener'); } catch (e) { toast(errMsg(e), true); } };
actions['exp-decide'] = (el) => {
  const approve = !!el.dataset.approve;
  openModal({
    title: approve ? `Approve ${el.dataset.name}’s claim?` : `Decline ${el.dataset.name}’s claim?`, submit: approve ? 'Approve' : 'Decline', danger: !approve,
    sub: approve ? (isHRme() ? 'It is paid with their next salary, as its own line, not taxed.' : 'HR approves it next.') : 'They see your reason.',
    body: approve ? html`<p class="muted">They are told it was approved.</p>` : html`<div class="field"><label class="f" for="xr">Reason</label><input id="xr" name="reason" maxlength="300" required placeholder="Over the meal limit; send the per-person bill"></div>`,
    onSubmit: async (fd) => { await post(`/api/expenses/${el.dataset.id}/decide`, { approve, reason: fd.get('reason') || null }); toast(approve ? 'Approved' : 'Declined'); S.refresh(); },
  });
};
actions['adv-decide'] = (el) => {
  const approve = !!el.dataset.approve;
  openModal({
    title: approve ? `Approve ${el.dataset.name}’s advance?` : `Decline ${el.dataset.name}’s advance?`, submit: approve ? 'Approve' : 'Decline', danger: !approve,
    sub: approve ? 'Pay it to them now. It comes off their payslips from next month.' : 'They see your reason.',
    body: html`<div class="field"><label class="f" for="an">${approve ? 'Note (optional)' : 'Reason'}</label><input id="an" name="note" maxlength="300" ${approve ? '' : raw('required')}></div>`,
    onSubmit: async (fd) => { await post(`/api/advances/${el.dataset.id}/decide`, { approve, note: fd.get('note') || null }); toast(approve ? 'Approved' : 'Declined'); S.refresh(); },
  });
};
