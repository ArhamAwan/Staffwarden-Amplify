// HR: people and pay (everyone's record at a glance), one person's record (details, pay, documents,
// joining and leaving), and what is waiting on HR (shown on HR's home page).
import { html, raw, esc, icon, money, dayShort, dayMD, dateY, relTime, plural, initials, avColor, periodLabel } from '../util.js';
import { get, post, put, patch, del, qs, fileBase64, fileUrl } from '../api.js';
import { S, actions, tag, empty, openModal, confirmBox, toast, errMsg, qAttr } from '../ui.js';
import { companyToday } from '../parts.js';
import { ptabs } from './payroll.js';
import { STATUS } from './pay.js';

export const CONTRACT = { full_time: 'Full-time', part_time: 'Part-time', probation: 'Probation', contractor: 'Contractor', intern: 'Intern' };
const DOC_KIND = { contract: 'Employment contract', offer: 'Offer letter', cnic: 'CNIC copy', degree: 'Degree', policy: 'Policy', letter: 'Letter', other: 'Other' };
const ADV_ST = { pending: ['break', 'Waiting'], approved: ['working', 'Being paid back'], repaid: ['offline', 'Paid back'], declined: ['absent', 'Declined'] };
const DOC_STATUS = { kept: ['idle', 'Kept'], signed: ['working', 'Signed'], waiting: ['break', 'Waiting'] };
const av = (p, size = '') => html`<span class="avatar ${size}" style="background:${avColor(p.id ?? p.user_id)}" aria-hidden="true">${initials(p.name)}</span>`;
export const isHRme = () => !!S.me && (S.me.role === 'owner' || !!S.me.hr);

export default {
  title: 'People and pay',
  async load(q) {
    if (q.get('id')) return { person: await get(`/api/hr/people/${q.get('id')}`), tab: q.get('tab') || 'overview' };
    return { people: await get(`/api/hr/people${qs({ all: q.get('all') })}`) };
  },
  render(d, q) { return d.person ? personView(d.person, d.tab) : listView(d.people, q); },
};

// ---------- everyone ----------
function listView(people, q) {
  const find = (q.get('find') || '').toLowerCase();
  const all = people.filter((p) => p.role !== 'owner' && (!find || p.name.toLowerCase().includes(find)));
  // developer and test accounts are not employees: listed on their own, off payroll
  const list = all.filter((p) => p.employed !== false), others = all.filter((p) => p.employed === false);
  const owner = people.find((p) => p.role === 'owner');
  const noPay = list.filter((p) => p.flags.no_pay).length, noBank = list.filter((p) => p.flags.no_bank).length;
  const rows = list.map((p) => {
    const r = p.record, pay = p.pay;
    return html`<tr class="link" data-k="p${p.id}" data-act="go" data-href="#/hr?id=${p.id}" tabindex="0">
      <td class="nm"><span class="person">${av(p)}<span><b>${p.name}</b><span>${p.title || ''}${p.hr ? ' · HR' : ''}</span></span></span></td>
      <td>${tag(r.contract === 'probation' ? 'break' : r.contract === 'contractor' ? 'idle' : 'offline', CONTRACT[r.contract])}${r.leaving_on ? html` ${tag('absent', `Leaves ${dayMD(r.leaving_on)}`)}` : ''}</td>
      <td class="num nowrap">${r.joined_on ? dateY(r.joined_on) : '–'}</td>
      <td>${pay ? html`<b class="num">${money(pay.base, pay.currency)}</b>${pay.allowances.length ? html`<div class="small muted">+ ${pay.allowances.map((a) => `${money(a.amount, pay.currency)} ${a.label.toLowerCase()}`).join(', ')}</div>` : ''}` : tag('absent', 'No pay set')}</td>
      <td>${pay ? (pay.tax_mode === 'pk' && pay.currency === 'PKR' ? 'Pakistan' : 'None') : '–'}</td>
      <td class="num">${r.iban_masked ? html`${r.bank_name || 'Bank'} ${r.iban_masked}` : pay ? tag('absent', 'Missing') : '–'}</td>
      <td>${p.advance_left ? html`<span class="small">Advance ${money(p.advance_left, pay ? pay.currency : 'PKR')}</span>` : html`<span class="muted">None</span>`}</td>
      <td class="row-a"><button class="btn sm ghost" data-act="hr-employed" data-id="${p.id}" data-name="${p.name}" data-v="0" title="Move ${p.name} to Not employees">Not an employee</button></td></tr>`;
  });
  const otherRows = others.map((p) => html`<li data-k="o${p.id}"><a class="person" href="#/hr?id=${p.id}">${av(p)}<span><b>${p.name}</b><span>${[p.title, p.is_dev ? 'Developer access' : null, p.tracks_time === false ? 'Time not tracked' : null].filter(Boolean).join(' · ')}</span></span></a>
    <button class="btn sm" data-act="hr-employed" data-id="${p.id}" data-name="${p.name}" data-v="1">Move to employees</button></li>`);
  return html`
    <div class="page-h"><div><h1>People and pay</h1><p class="sub">HR records, pay and bank details. Only HR and the owner can open this.</p></div>
      <div class="tools"><a class="btn" href="#/hr-import">${icon('file')} Import from contracts</a><label class="psearch"><span class="sr">Find a person</span>${icon('search')}<input type="search" placeholder="Find by name" value="${q.get('find') || ''}" data-q="find" autocomplete="off"></label></div>
      ${ptabs('people')}</div>
    ${noPay || noBank ? html`<div class="banner"><span>${noPay ? `${plural(noPay, 'person has', 'people have')} no pay set, so they are left off payroll. ` : ''}${noBank ? `${plural(noBank, 'person has', 'people have')} no bank details.` : ''}</span></div>` : ''}
    <section class="panel flush"><div class="body">${list.length ? html`<div class="tbl-wrap"><table class="t stack"><thead><tr><th>Person</th><th>Contract</th><th>Joined</th><th>Pay</th><th>Tax</th><th>Bank</th><th>Advances</th><th class="row-a"><span class="sr">Move</span></th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('Nobody here', 'Add people on the People page first.')}</div></section>
    ${others.length ? html`<section class="panel hr-others" data-k="others"><header><div><h2>Not employees <span class="muted num hr-ocount">${others.length}</span></h2><p class="small muted">Developer and test accounts. They are kept off payroll and out of HR’s reminders, so they need no pay, bank or contract.</p></div></header><div class="body"><ul class="hr-olist">${otherRows}</ul></div></section>` : ''}
    <p class="small muted">${icon('lock')} Pay, bank details and documents are only for HR, the owner${owner ? ` (${owner.name})` : ''} and the person. Opening someone’s record is kept in the audit log.</p>`;
}

// ---------- one person ----------
function personView(p, tab) {
  const r = p.record, pay = p.pay, me = S.me.id === p.id;
  const tabs = [['overview', 'Overview'], ['documents', `Documents${p.docs.length ? ' ' + p.docs.length : ''}`], ['joining', 'Joining'], ...(p.leave_steps ? [['leaving', 'Leaving']] : [])];
  const head = html`<div class="page-h"><div class="hr-who">${av(p, 'lg')}<div><h1>${p.name}</h1><p class="sub">${[p.title, p.team, CONTRACT[r.contract], p.active ? null : 'Deactivated'].filter(Boolean).join(' · ')}</p></div></div>
    <div class="tools"><a class="btn" href="#/hr">${icon('left')} Everyone</a>${!r.leaving_on && p.active ? html`<button class="btn" data-act="hr-leave" data-id="${p.id}" data-name="${p.name}">Leaving</button>` : ''}${p.employed === false ? html`<button class="btn" data-act="hr-employed" data-id="${p.id}" data-name="${p.name}" data-v="1">Make an employee</button>` : html`<button class="btn" data-act="hr-employed" data-id="${p.id}" data-name="${p.name}" data-v="0">Not an employee</button>`}<button class="btn primary" data-act="hr-edit" data-id="${p.id}">Edit record</button></div>
    <nav class="tabs" aria-label="Their record">${tabs.map(([v, n]) => html`<button type="button" class="tab" data-act="q" ${raw(qAttr('tab', v === 'overview' ? '' : v))} aria-current="${tab === v ? 'page' : 'false'}">${n}</button>`)}<span class="tab locked" title="HR never sees screenshots or activity">${icon('lock')} Screenshots and activity</span></nav></div>`;
  let body;
  if (tab === 'documents') body = docsView(p);
  else if (tab === 'joining') body = stepsView(p, 'join');
  else if (tab === 'leaving' && p.leave_steps) body = stepsView(p, 'leave');
  else body = overview(p);
  return html`${head}${p.employed === false ? html`<div class="banner"><span><b>Not an employee.</b> ${p.name.split(' ')[0]} is a developer or test account, so they are kept off payroll and out of HR’s reminders.</span></div>` : ''}${r.leaving_on ? html`<div class="banner"><span><b>${p.name.split(' ')[0]} leaves on ${dayShort(r.leaving_on)}.</b> ${r.leaving_reason ? r.leaving_reason + '. ' : ''}Their last month on payroll is cut at that day.</span><a class="btn sm" href="#/hr?id=${p.id}&tab=leaving">Leaving steps</a></div>` : ''}${body}
    <p class="small muted">${icon('eye')} ${p.name.split(' ')[0]} can see this record too, except HR’s notes. Every time HR opens it is kept in the audit log.</p>`;
}
function overview(p) {
  const r = p.record, pay = p.pay;
  const kv = (rows) => html`<dl class="kv">${rows.filter(Boolean).map(([a, b]) => html`<dt>${a}</dt><dd>${b ?? html`<span class="muted">Not set</span>`}</dd>`)}</dl>`;
  const details = html`<section class="panel"><header><h2>Details</h2><button class="btn sm" data-act="hr-edit" data-id="${p.id}">Edit</button></header><div class="body">${kv([
    ['Contract', CONTRACT[r.contract]], ['Joined', r.joined_on ? dateY(r.joined_on) : null], ['Probation ends', r.probation_end ? dateY(r.probation_end) : null], ['Notice period', r.notice_days != null ? plural(r.notice_days, 'day') : null],
    ['Work email', html`${p.email.split('@')[0]}@<wbr>${p.email.split('@').slice(1).join('@')}`], ['Phone', r.phone || null], ['CNIC', r.cnic || null], ['Address', r.address || null], ['Emergency contact', r.emergency_name ? `${r.emergency_name}${r.emergency_phone ? ' · ' + r.emergency_phone : ''}` : null],
    r.notes ? ['HR notes', r.notes] : null])}</div></section>`;
  const payCard = html`<section class="panel"><header><h2>Pay</h2>${p.can_edit_pay ? html`<button class="btn sm ${pay ? '' : 'primary'}" data-act="hr-pay" data-id="${p.id}">${pay ? 'Change pay' : 'Set pay'}</button>` : html`<span class="muted small">The owner changes this</span>`}</header><div class="body">
    ${pay ? kv([['Base salary', `${money(pay.base, pay.currency)} a month`], ['Income tax', pay.tax_mode === 'pk' && pay.currency === 'PKR' ? 'Pakistan brackets' : 'None'], ...pay.allowances.map((a) => [a.label, `+ ${money(a.amount, pay.currency)} every month`]), ...pay.deductions.map((x) => [x.label, `− ${money(x.amount, pay.currency)} every month`]),
      ['Bank', r.iban ? `${r.bank_name || ''} ${r.iban}`.trim() : html`<span class="bad-t">Missing: needed for the bank sheet</span>`], r.account_title ? ['Account title', r.account_title] : null])
      : empty('No pay set', `${p.name.split(' ')[0]} is left off payroll until it is.`)}</div></section>`;
  const hist = html`<section class="panel hr-hist"><header><h2>Salary history</h2></header><div class="body">${p.history.length ? html`<ul class="tline">${p.history.map((h) => html`<li><i></i><div><b class="num">${money(h.base, h.currency)}</b><span>${h.note || ''}${h.by_name ? ` · ${h.by_name}` : ''}</span></div><span class="muted small">${dateY(h.effective_from)}</span></li>`)}</ul>` : empty('Nothing yet', `Each change to ${p.name.split(' ')[0]}’s base salary is kept here, starting when you set their pay.`)}</div></section>`;
  const leave = html`<section class="panel"><header><h2>Time off</h2><span class="muted small">This year</span></header><div class="body"><div class="mini-stats"><div><span>Annual left</span><b class="num">${Math.max(0, p.leave.allowance - p.leave.taken)}</b><small>of ${p.leave.allowance} days</small></div><div><span>Taken</span><b class="num">${p.leave.taken}</b><small>days</small></div><div><span>Unpaid</span><b class="num">${p.leave.unpaid}</b><small>${p.leave.unpaid === 1 ? 'request' : 'requests'}</small></div></div></div></section>`;
  const slips = html`<section class="panel flush"><header><h2>Payslips</h2></header><div class="body">${p.slips.length ? html`<ul class="blist">${p.slips.map((s) => html`<li class="clickable" data-act="go" data-href="#/payroll?id=${s.id}" tabindex="0"><span class="what">${s.name}</span><span class="len num">${money(s.net, s.currency)}</span><span class="when">${STATUS[s.status][1]}</span></li>`)}</ul>` : empty('None yet', `${p.name.split(' ')[0]}’s payslips show here after their first payroll.`)}</div></section>`;
  const adv = p.advances.length ? html`<section class="panel"><header><h2>Advances</h2></header><div class="body"><ul class="adv-list">${p.advances.map((a) => { const [c, w] = ADV_ST[a.status] || ['idle', a.status]; return html`<li><div><p><b class="num">${money(a.amount, pay ? pay.currency : 'PKR')}</b> over ${plural(a.months, 'month')}</p>${a.reason ? html`<span>${a.reason}</span>` : ''}</div>${tag(c, w)}</li>`; })}</ul></div></section>` : '';
  return html`<div class="hr-cols"><div class="hr-col">${details}${hist}</div><div class="hr-col">${payCard}${leave}${slips}${adv}</div></div>`;
}
function docsView(p) {
  return html`<section class="panel flush"><header><h2>Documents</h2><button class="btn sm primary" data-act="hr-doc-add" data-id="${p.id}">${icon('plus')} Upload</button></header><div class="body">
    ${p.docs.length ? html`<ul class="docs">${p.docs.map((d) => { const [c, w] = DOC_STATUS[d.status] || DOC_STATUS.kept; return html`<li data-k="d${d.id}"><span class="doc-ic">${icon('file')}</span><div><b>${d.name}</b><span>${DOC_KIND[d.kind] || d.kind} · ${Math.max(1, Math.round(d.size / 1024))} KB · added ${relTime(d.created_at)}${d.uploaded_by_name ? ` by ${d.uploaded_by_name}` : ''}${d.expires_on ? ` · expires ${dateY(d.expires_on)}` : ''}</span></div>
      ${tag(c, w)}<span class="doc-a"><button class="btn sm" data-act="hr-doc-open" data-id="${d.id}">Open</button>${d.status === 'waiting' ? html`<button class="btn sm" data-act="hr-doc-status" data-id="${d.id}" data-status="signed">Mark signed</button>` : ''}<button class="btn sm danger" data-act="hr-doc-del" data-id="${d.id}" data-name="${d.name}">Remove</button></span></li>`; })}</ul>`
      : empty('No documents yet', `Keep ${p.name.split(' ')[0]}’s contract, offer letter, CNIC copy and other papers here. Only HR, the owner and ${p.name.split(' ')[0]} can open them.`)}</div></section>`;
}
function stepsView(p, flow) {
  const list = flow === 'join' ? p.join_steps : p.leave_steps;
  const done = list.filter((s) => s.done).length;
  return html`<section class="panel"><header><h2>${flow === 'join' ? 'Joining' : 'Leaving'}</h2><span class="muted small">${done} of ${list.length} done${flow === 'join' ? ' · some tick themselves from what Staffwarden already knows' : ''}</span></header><div class="body">
    <ul class="checklist big">${list.map((s) => html`<li class="${s.done ? 'done' : ''}" data-k="s${s.key}"><span class="ck">${s.done ? icon('check') : ''}</span><div><b>${s.title}</b><span>${s.done && s.done_at ? `Done ${relTime(s.done_at)}${s.done_by ? ` by ${s.done_by}` : ''}` : s.done && s.auto ? 'Done' : s.sub}</span></div>
      ${s.auto ? html`<span class="muted small">${s.done ? 'Automatic' : 'Ticks itself'}</span>` : html`<button class="btn sm" data-act="hr-step" data-id="${p.id}" data-flow="${flow}" data-step="${s.key}" data-done="${s.done ? '' : '1'}">${s.done ? 'Undo' : 'Mark done'}</button>`}</li>`)}</ul></div></section>`;
}

// ---------- what is waiting on HR (HR's home) ----------
const KIND_IC = { payroll: ['wallet', 'good'], expenses: ['receipt', 'blue'], advance: ['bank', 'leave'], no_pay: ['wallet', 'bad'], no_bank: ['bank', 'bad'], joining: ['users', 'warn'], leaving: ['users', 'warn'], timeoff: ['sun', 'idle'] };
export function hrPanel(o) {
  if (!o) return '';
  const today = o.today;
  const item = (i) => { const [ic, tone] = KIND_IC[i.kind] || ['flag', 'idle']; const days = i.due ? Math.round((Date.parse(i.due) - Date.parse(today)) / 86400000) : null;
    return html`<li data-k="w${i.kind}${i.user_id || ''}${i.title.length}"><span class="w-ic ${tone}">${icon(ic)}</span><div><b>${i.title}</b>${days != null ? html` ${tag(i.urgent || days <= 3 ? 'absent' : 'break', days <= 0 ? 'Today' : `In ${plural(days, 'day')}`)}` : i.since ? html` ${tag('idle', `Since ${dayMD(i.since.slice(0, 10))}`)}` : ''}<span>${i.sub}</span></div>
      ${i.start ? html`<button class="btn sm primary" data-act="pr-start" data-period="${i.start}">Start</button>` : html`<a class="btn sm ${i.kind === 'payroll' ? 'primary' : ''}" href="${i.link}">Open</a>`}</li>`; };
  const soon = (s) => { const [, m, d] = s.day.split('-'); return html`<li><span class="cal-d"><small>${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(m) - 1]}</small><b>${Number(d)}</b></span><div><b>${s.title}</b><span>${s.sub}</span></div></li>`; };
  return html`<div class="hr-home" data-k="hrhome">
    <section class="panel"><header><h2>Waiting on you</h2><span class="muted small">${o.items.length ? `${plural(o.items.length, 'thing')}, most urgent first` : 'All caught up'}</span></header><div class="body">
      ${o.items.length ? html`<ul class="waiting">${o.items.map(item)}</ul>` : empty('Nothing waiting', 'Expense claims, advances, people joining or leaving and payroll show here when they need you.')}</div></section>
    <div><section class="panel"><header><h2>Coming up</h2></header><div class="body">${o.soon.length ? html`<ul class="soon">${o.soon.map(soon)}</ul>` : empty('Nothing in the next 90 days', '')}</div></section>
      <section class="panel"><header><h2>People</h2><a href="#/hr">Everyone</a></header><div class="body"><div class="mini-stats">
        <div><span>People</span><b class="num">${o.stats.people}</b><small>${o.stats.monthly} with pay</small></div><div><span>On probation</span><b class="num">${o.stats.probation.length}</b><small>${o.stats.probation.slice(0, 2).map((n) => n.split(' ')[0]).join(', ') || 'Nobody'}</small></div>
        <div><span>Joined this year</span><b class="num">${o.stats.joined_year}</b><small>${o.stats.joined_month} this month</small></div><div><span>Leaving</span><b class="num">${o.stats.leaving.length}</b><small>${o.stats.leaving.slice(0, 2).map((n) => n.split(' ')[0]).join(', ') || 'Nobody'}</small></div></div></div></section></div></div>`;
}

// ---------- actions ----------
actions['hr-edit'] = async (el) => {
  let p; try { p = await get(`/api/hr/people/${el.dataset.id}`); } catch (e) { toast(errMsg(e), true); return; }
  const r = p.record;
  openModal({
    title: `Edit ${p.name}’s record`, submit: 'Save', wide: true,
    body: html`<h3 class="mh">Employment</h3>
      <div class="grid3"><div class="field"><label class="f" for="hc">Contract</label><select id="hc" name="contract">${Object.entries(CONTRACT).map(([v, n]) => html`<option value="${v}" ${r.contract === v ? raw('selected') : ''}>${n}</option>`)}</select></div>
        <div class="field"><label class="f" for="hj">Joined</label><input id="hj" type="date" name="joined_on" value="${r.joined_on || ''}"></div>
        <div class="field"><label class="f" for="hp">Probation ends</label><input id="hp" type="date" name="probation_end" value="${r.probation_end || ''}"></div></div>
      <div class="field" style="max-width:220px"><label class="f" for="hn">Notice period (days)</label><input id="hn" type="number" min="0" max="365" name="notice_days" value="${r.notice_days ?? ''}"></div>
      <h3 class="mh">Personal</h3>
      <div class="grid2"><div class="field"><label class="f" for="hph">Phone</label><input id="hph" name="phone" value="${r.phone || ''}" maxlength="40" placeholder="0301 2345678"></div>
        <div class="field"><label class="f" for="hcn">CNIC</label><input id="hcn" name="cnic" value="${r.cnic || ''}" maxlength="15" placeholder="61101-1234567-1" autocomplete="off"></div></div>
      <div class="field"><label class="f" for="had">Address</label><input id="had" name="address" value="${r.address || ''}" maxlength="300"></div>
      <h3 class="mh">Bank, for the transfer sheet</h3>
      <div class="grid2"><div class="field"><label class="f" for="hb">Bank</label><input id="hb" name="bank_name" value="${r.bank_name || ''}" maxlength="80" placeholder="Meezan Bank"></div>
        <div class="field"><label class="f" for="ht">Account title</label><input id="ht" name="account_title" value="${r.account_title || ''}" maxlength="100"></div></div>
      <div class="field"><label class="f" for="hi">IBAN</label><input id="hi" name="iban" value="${r.iban || ''}" maxlength="40" placeholder="PK36 MEZN 0000 0011 2233 4455" autocomplete="off"><p class="hint">Only HR and the owner see it in full. ${p.name.split(' ')[0]} sees the last 4 digits.</p></div>
      <h3 class="mh">Emergency contact</h3>
      <div class="grid2"><div class="field"><label class="f" for="he">Name</label><input id="he" name="emergency_name" value="${r.emergency_name || ''}" maxlength="100"></div>
        <div class="field"><label class="f" for="hf">Phone</label><input id="hf" name="emergency_phone" value="${r.emergency_phone || ''}" maxlength="40"></div></div>
      <div class="field"><label class="f" for="hnotes">HR notes (${p.name.split(' ')[0]} does not see these)</label><textarea id="hnotes" name="notes" maxlength="2000">${r.notes || ''}</textarea></div>`,
    onSubmit: async (fd) => {
      const b = {}; for (const k of ['contract', 'joined_on', 'probation_end', 'notice_days', 'phone', 'cnic', 'address', 'bank_name', 'account_title', 'iban', 'emergency_name', 'emergency_phone', 'notes']) b[k] = fd.get(k) === '' ? null : fd.get(k);
      if (b.notice_days != null) b.notice_days = Number(b.notice_days);
      await put(`/api/hr/people/${p.id}/record`, b); toast('Saved'); S.refresh();
    },
  });
};
actions['hr-pay'] = async (el) => {
  let p; try { p = await get(`/api/hr/people/${el.dataset.id}`); } catch (e) { toast(errMsg(e), true); return; }
  const pay = p.pay || { base: '', currency: 'PKR', tax_mode: 'pk', allowances: [], deductions: [] };
  const row = (kind, x = {}) => html`<div class="pay-row" data-row="${kind}"><input name="${kind}_label" value="${x.label || ''}" placeholder="${kind === 'alw' ? 'Team lead allowance' : 'Loan repayment'}" maxlength="60" aria-label="What"><input class="num" name="${kind}_amount" type="number" min="0" value="${x.amount ?? ''}" placeholder="Amount" aria-label="Amount"><button type="button" class="btn icon sm" data-act="pay-row-del" aria-label="Remove">${icon('x')}</button></div>`;
  openModal({
    title: `${p.pay ? 'Change' : 'Set'} ${p.name}’s pay`, submit: 'Save', wide: true, sub: `${p.name.split(' ')[0]} is told when their pay changes. The change is kept in their salary history.`,
    body: html`<div class="grid3"><div class="field"><label class="f" for="pb">Base salary, a month</label><input id="pb" class="num" name="base" type="number" min="0" step="1" value="${pay.base}" required inputmode="numeric"></div>
        <div class="field"><label class="f" for="pc">Currency</label><select id="pc" name="currency"><option value="PKR" ${pay.currency === 'PKR' ? raw('selected') : ''}>Rupees (Rs)</option><option value="USD" ${pay.currency === 'USD' ? raw('selected') : ''}>Dollars ($)</option></select></div>
        <div class="field"><label class="f" for="pt">Income tax</label><select id="pt" name="tax_mode"><option value="pk" ${pay.tax_mode === 'pk' ? raw('selected') : ''}>Pakistan brackets</option><option value="none" ${pay.tax_mode === 'none' ? raw('selected') : ''}>None (contractor, or taxed elsewhere)</option></select></div></div>
      <div class="grid2"><div class="field"><label class="f" for="pe">From</label><input id="pe" type="date" name="effective_from" value="${companyToday()}"></div><div class="field"><label class="f" for="pn">Reason (${p.name.split(' ')[0]} sees this)</label><input id="pn" name="note" maxlength="200" placeholder="Yearly review"></div></div>
      <div class="pay-list"><div class="pay-h"><b>Every month: allowances</b><button type="button" class="linkbtn" data-act="pay-row-add" data-kind="alw">+ Add</button></div><div data-rows="alw">${pay.allowances.map((a) => row('alw', a))}</div></div>
      <div class="pay-list"><div class="pay-h"><b>Every month: deductions</b><button type="button" class="linkbtn" data-act="pay-row-add" data-kind="ded">+ Add</button></div><div data-rows="ded">${pay.deductions.map((x) => row('ded', x))}</div></div>`,
    onSubmit: async (fd) => {
      const pairs = (k) => fd.getAll(`${k}_label`).map((l, i) => ({ label: l.trim(), amount: Number(fd.getAll(`${k}_amount`)[i]) })).filter((x) => x.label && x.amount > 0);
      await put(`/api/hr/people/${p.id}/pay`, { base: Number(fd.get('base')), currency: fd.get('currency'), tax_mode: fd.get('tax_mode'), allowances: pairs('alw'), deductions: pairs('ded'), effective_from: fd.get('effective_from') || null, note: fd.get('note') || null });
      toast('Pay saved'); S.refresh();
    },
  });
  actions['pay-row-add'] = (b) => { const box = b.closest('form').querySelector(`[data-rows="${b.dataset.kind}"]`); box.insertAdjacentHTML('beforeend', row(b.dataset.kind).toString()); box.lastElementChild.querySelector('input').focus(); };
};
actions['pay-row-del'] = (b) => b.closest('.pay-row').remove();
actions['hr-leave'] = (el) => openModal({
  title: `${el.dataset.name} is leaving`, submit: 'Save', sub: 'Their last month on payroll is cut at their last day. Leaving steps start for HR.',
  body: html`<div class="grid2"><div class="field"><label class="f" for="lo">Last working day</label><input id="lo" type="date" name="leaving_on" required value="${companyToday()}"></div>
    <div class="field"><label class="f" for="lr">Reason</label><select id="lr" name="leaving_reason"><option>Resigned</option><option>Contract ended</option><option>Let go</option><option>Other</option></select></div></div>`,
  onSubmit: async (fd) => { await put(`/api/hr/people/${el.dataset.id}/record`, { leaving_on: fd.get('leaving_on'), leaving_reason: fd.get('leaving_reason') }); toast('Saved'); S.navigate(`#/hr?id=${el.dataset.id}&tab=leaving`); },
});
actions['hr-employed'] = async (el) => {
  const on = el.dataset.v === '1';
  try { await put(`/api/hr/people/${el.dataset.id}/record`, { employed: on }); toast(on ? `${el.dataset.name} is back with the employees` : `${el.dataset.name} moved to Not employees`); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['hr-step'] = async (el) => { try { await put(`/api/hr/people/${el.dataset.id}/steps`, { flow: el.dataset.flow, step: el.dataset.step, done: !!el.dataset.done }); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['hr-doc-add'] = (el) => openModal({
  title: 'Upload a document', submit: 'Upload',
  body: html`<div class="field"><label class="f" for="df">File (PDF or image, up to 5 MB)</label><input id="df" type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required></div>
    <div class="grid2"><div class="field"><label class="f" for="dk">What it is</label><select id="dk" name="kind">${Object.entries(DOC_KIND).map(([v, n]) => html`<option value="${v}">${n}</option>`)}</select></div>
      <div class="field"><label class="f" for="dn">Name</label><input id="dn" name="name" maxlength="120" required placeholder="Employment contract"></div></div>
    <div class="grid2"><div class="field"><label class="f" for="ds">Status</label><select id="ds" name="status"><option value="kept">Kept</option><option value="signed">Signed</option><option value="waiting">Waiting for a signature</option></select></div>
      <div class="field"><label class="f" for="dx">Expires (optional)</label><input id="dx" type="date" name="expires_on"></div></div>`,
  onSubmit: async (fd) => {
    const f = fd.get('file');
    if (!f || !f.size) throw new Error('Choose a file');
    if (f.size > 5 * 1024 * 1024) throw new Error('The file is over 5 MB');
    await post(`/api/hr/people/${el.dataset.id}/docs`, { name: fd.get('name'), kind: fd.get('kind'), status: fd.get('status'), expires_on: fd.get('expires_on') || null, type: f.type, data_base64: await fileBase64(f) });
    toast('Uploaded'); S.refresh();
  },
});
actions['hr-doc-open'] = async (el) => { try { window.open(await fileUrl(`/api/hr/docs/${el.dataset.id}`), '_blank', 'noopener'); } catch (e) { toast(errMsg(e), true); } };
actions['hr-doc-status'] = async (el) => { try { await patch(`/api/hr/docs/${el.dataset.id}`, { status: el.dataset.status }); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['hr-doc-del'] = async (el) => {
  if (!(await confirmBox({ title: `Remove “${el.dataset.name}”?`, message: 'The file is deleted for good. The audit log keeps a record that it was removed.', confirm: 'Remove', danger: true }))) return;
  try { await del(`/api/hr/docs/${el.dataset.id}`); toast('Removed'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
