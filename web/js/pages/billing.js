// The company's account, inside Settings: Billing (the owner, on Staffwarden as a service) and Account
// (who runs it, the money people are paid in, taking everything away, closing). Also the notes at the top
// of every page when the trial is ending, a card was declined or tracking is paused, and the screen for a
// page the plan doesn't include.
import { html, raw, esc, icon, plural, currencyOptions, homeCurrency, curName, setHomeCurrency } from '../util.js';
import { get, post, put, download } from '../api.js';
import { S, actions, toast, errMsg, openModal } from '../ui.js';

const DAY = 86400000;
const usd = (cents, { round = false } = {}) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: round || cents % 100 === 0 ? 0 : 2, maximumFractionDigits: round ? 0 : 2 })}`;
const usd2 = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDay = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const shortDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const brief = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const daysTo = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / DAY));
const FEAT = { payroll: 'payroll', hr: 'HR records, contracts and expenses', projects: 'projects and tasks', reports: 'reports', portal: 'the client portal', screenshots: 'screenshots', shift_reports: 'shift reports by email' };
const PLAN_ADDS = { starter: 'Hours, attendance and time off.', business: 'Adds payroll, HR, expenses, projects and reports.', pro: 'Adds the client portal, screenshots and shift reports.' };
const planOf = (b, id) => b.plans.find((p) => p.id === id);
const each = (p, interval) => (interval === 'month' ? p.month_cents : p.year_cents / 12);
const priceWord = (cents) => usd(cents);
export const account = () => (S.me && S.me.account) || null;
export const hasFeature = (f) => { const a = account(); return !a || !a.features || a.features.includes(f); };

// ---------------- what a page needs from the plan ----------------
export const PAGE_FEATURE = { payroll: 'payroll', pay: 'payroll', hr: 'hr', 'hr-import': 'hr', expenses: 'hr', projects: 'projects', project: 'projects', tasks: 'projects', task: 'projects', review: 'projects', reports: 'reports', clients: 'portal', inbox: 'portal', screenshots: 'screenshots', 'shift-report': 'shift_reports' };
const PLAN_NEEDED = { payroll: 'Business', hr: 'Business', projects: 'Business', reports: 'Business', portal: 'Pro', screenshots: 'Pro', shift_reports: 'Pro' };
export function planGatePage(feature) {
  return {
    title: 'Not on your plan',
    async load() { return {}; },
    render() {
      const a = account() || {}, owner = !!a.billing, need = PLAN_NEEDED[feature] || 'Business';
      return html`<div class="pg-gate"><span class="pg-ic" aria-hidden="true">${icon('lock')}</span>
        <h1>${FEAT[feature] ? FEAT[feature].replace(/^\w/, (c) => c.toUpperCase()) : 'This page'} ${FEAT[feature] && /s$/.test(FEAT[feature]) && !/HR/.test(FEAT[feature]) ? 'are' : 'is'} on the ${need} plan</h1>
        <p>${esc(S.settings.org_name || 'Your company')} is on ${esc((a.plan || 'starter').replace(/^\w/, (c) => c.toUpperCase()))}. ${owner ? `Move to ${need} and it opens for everyone straight away. Nothing is lost by waiting.` : 'Ask the owner if you need it.'}</p>
        ${owner ? html`<a class="btn primary" href="#/settings?sec=billing">See plans</a>` : ''}</div>`;
    },
  };
}

// ---------------- the note at the top of every page ----------------
export function accountBar() {
  const a = account();
  if (!a || a.comped) return null;
  const co = esc(S.settings.org_name || 'your company');
  if (a.paused) {
    if (a.billing) return { tone: 'bad', html: `<b>Tracking is paused.</b> <span>${a.status === 'closed' ? 'The account is closed.' : 'Your team can still sign in and look at everything. Choose a plan to start tracking again.'}</span>`, act: a.status === 'closed' ? null : ['Choose a plan', '#/settings?sec=billing'] };
    return { tone: 'warn', html: `<b>Tracking is paused at ${co}.</b> <span>The company’s Staffwarden account needs attention, and ${esc(S.settings.owner_name || 'the owner')} already knows. Your hours, payslips and time off are all still here.</span>` };
  }
  if (!a.billing) return null;
  if (a.status === 'past_due') return { tone: 'bad', html: `<b>Your card was declined.</b> <span>Update it${a.grace_ends_at ? ` by <b>${esc(longDay(a.grace_ends_at))}</b>` : ''} or tracking pauses for everyone. Only you see this.</span>`, act: ['Update card', '#/settings?sec=billing'] };
  if (a.closing_at) return { tone: 'warn', html: `<b>The account closes on ${esc(shortDay(a.closing_at))}.</b> <span>Everyone can keep working until then.</span>`, act: ['Keep the account', '#/settings?sec=billing'] };
  if (a.status === 'trial' && !a.has_card && a.trial_days_left != null && a.trial_days_left <= 7) {
    return { tone: 'warn', html: `<b>${a.trial_days_left === 0 ? 'Your free trial ends today.' : `${plural(a.trial_days_left, 'day')} left in your free trial.`}</b> <span>${a.cards === false ? `We’ll email you an invoice before it ends${a.trial_ends_at ? ` on ${esc(longDay(a.trial_ends_at))}` : ''}. Nothing pauses while we sort it out.` : `Add a card any time; you’re only charged when the trial ends${a.trial_ends_at ? ` on ${esc(longDay(a.trial_ends_at))}` : ''}.`}</span>`, act: a.cards === false ? null : ['Add a card', '#/settings?sec=billing'] };
  }
  return null;
}

// ---------------- Settings › Billing ----------------
export async function loadBilling() {
  const a = account();
  const out = { acc: null, bill: null };
  try { out.acc = await get('/api/account'); } catch { /* not a manager */ }
  if (a && a.billing) { try { out.bill = await get('/api/billing'); } catch { /* billing isn't used on this server */ } }
  return out;
}
const cardWord = (c) => `${(c.brand || 'card').replace(/^\w/, (x) => x.toUpperCase())} ending ${c.last4}`;
function billRows(b) {
  const rows = [];
  if (b.next) rows.push(html`<tr><td>${shortDay(b.next.at)}</td><td>${planOf(b, b.pending_plan || b.plan).name}, ${b.interval === 'year' ? 'a year' : 'a month'}, ${plural(b.next.seats, 'person', 'people')}</td><td class="r num">${usd2(b.next.amount_cents)}</td><td><span class="tag idle"><i></i>Coming up</span></td><td></td></tr>`);
  for (const p of b.payments) {
    rows.push(html`<tr><td>${shortDay(p.at)}</td><td>${p.description || ''}</td><td class="r num">${usd2(p.amount_cents)}</td>
      <td>${p.status === 'paid' ? html`<span class="tag working"><i></i>Paid</span>` : html`<span class="tag absent"><i></i>Declined${p.next_try_at ? `, trying again ${brief(p.next_try_at)}` : ''}</span>`}</td>
      <td class="r">${p.pdf_url || p.receipt_url ? html`<a class="btn sm" href="${p.pdf_url || p.receipt_url}" target="_blank" rel="noopener">Receipt</a>` : ''}</td></tr>`);
  }
  return rows;
}
export function billingBlock({ bill: b, acc }) {
  if (!b) return '';
  const plan = planOf(b, b.plan), people = Math.max(1, b.seats);
  const status = b.comped ? html`<span class="tag working"><i></i>Free</span>` : b.status === 'trial' ? html`<span class="tag late"><i></i>Trial</span>` : b.status === 'past_due' ? html`<span class="tag absent"><i></i>Payment due</span>` : b.status === 'paused' ? html`<span class="tag absent"><i></i>Paused</span>` : b.closing_at ? html`<span class="tag late"><i></i>Closing</span>` : html`<span class="tag working"><i></i>Active</span>`;
  const priceLine = `${usd(each(plan, b.interval))} a person a month, billed ${b.interval === 'year' ? 'yearly' : 'monthly'}.`;
  // the three tiles: the plan, the next bill (or what's owed), the card
  let mid;
  if (b.comped) mid = html`<p class="lbl">Bills</p><div class="bl-big num">$0</div><p class="muted">${esc(S.settings.org_name)} uses Staffwarden free. Nothing is ever charged.</p>`;
  else if (b.owed) mid = html`<p class="lbl">Owed</p><div class="bl-big num">${usd2(b.owed.amount_cents)}</div><p class="muted">${b.owed.failure ? `${esc(b.owed.failure)}. ` : ''}${b.owed.next_try_at ? `We try the card again on ${brief(b.owed.next_try_at)}.` : 'Update the card and try again.'}</p>`;
  else if (b.status === 'paused' || b.status === 'closed') mid = html`<p class="lbl">Bills</p><div class="bl-big num">$0</div><p class="muted">Nothing is charged while tracking is paused. Choose a plan to start again.</p>`;
  else if (b.next) {
    const other = b.interval === 'year' ? `Pay monthly instead: ${usd(people * plan.month_cents, { round: true })} a month.` : `Pay yearly instead: ${usd(people * plan.year_cents, { round: true })} a year, two months free.`;
    mid = html`<p class="lbl">${b.status === 'trial' ? 'First bill' : 'Next bill'}</p><div class="bl-big num">${usd(b.next.amount_cents, { round: b.next.amount_cents >= 100000 })}</div>
      <p class="muted">${brief(b.next.at)}, for a ${b.interval}: ${plural(b.next.seats, 'person', 'people')} at ${usd(each(planOf(b, b.pending_plan || b.plan), b.pending_interval || b.interval))} a month.${b.pending_plan ? ` Moves to ${planOf(b, b.pending_plan).name} then.` : ` ${other}`}</p>`;
  } else mid = html`<p class="lbl">Next bill</p><div class="bl-big num">–</div><p class="muted">Shown once a card is added.</p>`;
  const graceLeft = b.owed && b.grace_ends_at ? daysTo(b.grace_ends_at) : null;
  const third = b.comped ? html`<p class="lbl">Paying with</p><p class="bl-strong">Nothing to pay</p>`
    : graceLeft != null ? html`<p class="lbl">Days left before pausing</p><div class="bl-big num">${graceLeft}</div><div class="bl-days" aria-label="${b.grace_days - graceLeft} of ${b.grace_days} grace days used">${Array.from({ length: b.grace_days }, (_, i) => html`<i class="${i < b.grace_days - graceLeft ? 'bad' : ''}"></i>`)}</div><p class="muted">Nothing changes for your team until then.</p>`
    : b.card ? html`<p class="lbl">Paying with</p><div class="bl-card"><i>${esc((b.card.brand || 'card').slice(0, 4).toUpperCase())}</i><span><b>${cardWord(b.card)}</b><small>Expires ${esc(b.card.exp || '')}</small></span></div><p class="muted">Receipts go to ${esc(b.owner_email)}.</p><button class="btn sm" type="button" data-act="bill-portal">Update card</button>`
    : b.manual_billing ? html`<p class="lbl">Paying with</p><p class="bl-strong">Bank transfer</p><p class="muted">We send an invoice to ${esc(b.owner_email)} before each period.</p>`
    : !b.stripe_ready ? html`<p class="lbl">Paying with</p><p class="bl-strong">Invoice</p><p class="muted">We email an invoice to ${esc(b.owner_email)} before ${b.status === 'trial' ? 'your trial ends' : 'each period'}, and you pay by bank transfer. Questions? <a href="mailto:hello@staffwarden.com">hello@staffwarden.com</a></p>`
    : html`<p class="lbl">Paying with</p><p class="bl-strong">No card yet</p><p class="muted">Any card, Apple Pay or Google Pay, paid securely through Stripe. Receipts go to ${esc(b.owner_email)}.</p><button class="btn primary sm" type="button" data-act="bill-checkout">Add a card</button>`;
  const days = b.status === 'trial' && b.trial_day != null ? html`<div class="bl-days" aria-label="Day ${b.trial_day} of ${b.trial_days}">${Array.from({ length: b.trial_days }, (_, i) => html`<i class="${i < b.trial_day ? 'on' : ''}"></i>`)}</div>` : '';
  const owedBar = b.owed ? html`<div class="bl-bad" role="alert"><span>${icon('flag')}</span><div><b>Your card was declined on ${brief(b.owed.at)}.</b> <span>Update it${b.grace_ends_at ? ` by ${longDay(b.grace_ends_at)}` : ''} or tracking pauses for everyone. Only you see this.</span></div><button class="btn sm" type="button" data-act="bill-retry">Try the card again</button><button class="btn sm primary" type="button" data-act="bill-portal">Update card</button></div>` : '';
  const pausedBar = b.status === 'paused' ? html`<div class="bl-bad" role="status"><span>${icon('pause')}</span><div><b>Tracking is paused since ${brief(b.paused_at)}.</b> <span>Nothing is lost. Your team can sign in and look at everything; the desktop app won’t start new time until ${b.stripe_ready ? 'you choose a plan' : 'the account is paid'}.${b.delete_after ? ` If nothing changes, the data is deleted on ${shortDay(b.delete_after)}, after two warning emails.` : ''}</span></div>${b.stripe_ready ? html`<button class="btn sm primary" type="button" data-act="bill-checkout">Choose a plan</button>` : html`<a class="btn sm primary" href="mailto:hello@staffwarden.com?subject=${encodeURIComponent(`Restart ${b.name}`)}">Write to us</a>`}</div>` : '';
  const closingBar = b.closing_at ? html`<div class="bl-warn" role="status"><span>${icon('cal')}</span><div><b>The account closes on ${shortDay(b.closing_at)}.</b> <span>No charges after that. The data is kept until ${shortDay(b.delete_after)}, then deleted.</span></div><button class="btn sm" type="button" data-act="bill-reopen">Keep the account</button></div>` : '';
  const free = b.free || {};
  return html`<section class="panel sset bl" id="set-billing" data-k="set-billing"><header><div><h2>Billing</h2><p>Paid in US dollars${b.stripe_ready ? ' through Stripe' : ''}. Prices exclude any sales tax or VAT your country adds.</p></div></header><div class="body">
    ${owedBar}${pausedBar}${closingBar}
    <div class="bl-tops">
      <div class="bl-tile"><p class="lbl">Your plan</p><div class="bl-plan"><b>${plan.name}</b>${status}<span class="sp"></span>${b.comped ? '' : html`<button class="btn sm" type="button" data-act="bill-plan">Change plan</button>`}</div>
        <p class="muted">${b.comped ? 'Every feature, free.' : html`${priceLine} ${PLAN_ADDS[b.plan]}${b.status === 'trial' ? ' During the trial every feature is on, Pro’s too.' : ''}`}</p>${days}</div>
      <div class="bl-tile">${mid}</div>
      <div class="bl-tile${b.owed ? ' bad' : ''}">${third}</div>
    </div>
    ${b.comped ? '' : html`<div class="bl-who"><div class="bl-whoh"><h3>Who you pay for</h3><span class="muted small">Counted on the day the bill is made. Adding someone mid-${b.interval} charges only the time left.</span></div>
      <div class="bl-grid"><div class="pay"><b class="num">${b.seats}</b><span>Active ${b.seats === 1 ? 'person' : 'people'}, paid for</span></div><div><b class="num">1</b><span>You, the owner: free</span></div>${free.invited ? html`<div><b class="num">${free.invited}</b><span>Invited, not joined: free until they do</span></div>` : ''}<div><b class="num">${free.archived || 0}</b><span>Archived: free, records kept</span></div><div><b class="num">${free.clients || 0}</b><span>Clients on the portal: free</span></div></div></div>`}
    ${b.comped ? '' : html`<div class="bl-bills"><h3>Bills</h3>${b.next || b.payments.length ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Date</th><th>What</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>${billRows(b)}</tbody></table></div>` : html`<p class="muted">No bills yet.</p>`}
      <p class="hint">Paid bills appear here with a receipt.</p></div>`}
    <p class="bl-leave muted">Leaving? <button type="button" class="linkbtn" data-act="acc-export">Download all your data</button>${acc && b.status !== 'closed' && !b.closing_at ? html` or <button type="button" class="linkbtn" data-act="bill-close">close the account</button>` : ''}. We keep everything for ${b.keep_days || 60} days in case you come back.</p>
  </div></section>`;
}

// ---------------- Settings › Account (the owner) ----------------
export function accountBlock({ acc, bill }) {
  if (!acc) return '';
  const canHand = acc.can_handover && acc.mail;
  return html`<section class="panel sset" id="set-account" data-k="set-account"><header><div><h2>Account</h2><p>Who runs ${esc(acc.name)} on Staffwarden, and the money people are paid in.</p></div></header><div class="body">
    ${acc.address ? html`<div class="srow"><div class="srow-t"><span class="srow-l">Address</span><p>Where your team signs in. Changing it would sign everyone out, so write to us if you need to.</p></div><div class="srow-c"><a class="acc-addr" href="${acc.url}" target="_blank" rel="noopener">${acc.address}</a></div></div>` : ''}
    <div class="srow"><div class="srow-t"><label for="acc-cur">Pay people in</label><p>The default for payroll, expenses and payslips. Each person can be paid in another currency from People and pay.</p></div>
      <div class="srow-c"><select id="acc-cur" data-act-change="acc-currency">${raw(currencyOptions(acc.pay_currency))}</select></div></div>
    <div class="srow wide"><div class="srow-t"><span class="srow-l">Owner</span><p>The owner can see billing, change the plan and close the account.</p></div>
      <div class="srow-c acc-own"><span><b>${acc.owner ? acc.owner.name : ''}</b><span class="muted small">${acc.owner ? acc.owner.email : ''}</span></span>
        ${acc.handover ? html`<span class="muted small">Waiting for ${acc.handover.name} to accept, until ${brief(acc.handover.expires_at)}</span><button class="btn sm" type="button" data-act="acc-hand-cancel">Cancel</button>`
          : canHand ? html`<button class="btn sm" type="button" data-act="acc-hand" ${acc.admins.length ? '' : raw('disabled title="Make someone an admin first"')}>Hand over</button>` : ''}</div></div>
    <div class="srow wide"><div class="srow-t"><span class="srow-l">Admins</span><p>Managers of the whole company. ${acc.team_managers ? `${plural(acc.team_managers, 'team manager')} also look after their own teams.` : ''} Change who is an admin on the People page.</p></div>
      <div class="srow-c">${acc.admins.length ? html`<ul class="acc-admins">${acc.admins.map((a) => html`<li><b>${a.name}</b><span class="muted small">${a.email}${a.hr ? ', HR' : ''}</span></li>`)}</ul>` : html`<span class="muted">No admins yet.</span>`}</div></div>
    <div class="srow wide"><div class="srow-t"><span class="srow-l">Everything, to take away</span><p>Every record as spreadsheets, with screenshots and files, in one zip. Passwords are left out.</p></div>
      <div class="srow-c acc-exp">${acc.export && acc.export.building ? html`<span class="muted">Getting it ready…</span>` : acc.export && acc.export.ready ? html`<span class="muted small">Made ${shortDay(acc.export.ready.at)}, ${(acc.export.ready.bytes / 1048576).toFixed(acc.export.ready.bytes > 1048576 * 10 ? 0 : 1)} MB</span><button class="btn sm" type="button" data-act="acc-export-dl" data-file="${acc.export.ready.file}">Download</button><button class="btn sm" type="button" data-act="acc-export">Make a new one</button>` : html`<button class="btn sm" type="button" data-act="acc-export">Make the download</button>`}</div></div>
    ${bill && !bill.comped && bill.status !== 'closed' && !bill.closing_at ? html`<div class="srow wide"><div class="srow-t"><span class="srow-l">Close the account</span><p>${bill.status === 'trial' ? 'Ends the trial now.' : 'Your team keeps using Staffwarden until the end of what you’ve paid for.'} The data is kept ${bill.keep_days || 60} days, then deleted.</p></div><div class="srow-c"><button class="btn sm danger-t" type="button" data-act="bill-close">Close the account</button></div></div>` : ''}
  </div></section>`;
}

// ---------------- actions ----------------
const go = async (path, body) => { const r = await post(path, body); if (r && r.url) { location.href = r.url; return true; } return r; };
let lastBill = null;
const freshBill = async () => (lastBill = await get('/api/billing'));
actions['bill-checkout'] = async (el) => {
  el.disabled = true;
  try { const b = lastBill || await freshBill(); await go('/api/billing/checkout', { plan: b.plan, interval: b.interval }); }
  catch (e) { toast(errMsg(e), true); el.disabled = false; }
};
actions['bill-portal'] = async (el) => { el.disabled = true; try { await go('/api/billing/portal'); } catch (e) { toast(errMsg(e), true); el.disabled = false; } };
actions['bill-retry'] = async (el) => { el.disabled = true; try { await post('/api/billing/retry'); toast('Paid. Thank you.'); S.refresh(); } catch (e) { toast(errMsg(e), true); el.disabled = false; } };
actions['bill-reopen'] = async (el) => { el.disabled = true; try { await post('/api/billing/reopen'); toast('The account stays open'); S.me = await get('/api/me'); S.refresh(); } catch (e) { toast(errMsg(e), true); el.disabled = false; } };

actions['bill-plan'] = async () => {
  let b; try { b = await freshBill(); } catch (e) { toast(errMsg(e), true); return; }
  const people = Math.max(1, b.seats);
  let plan = b.plan, interval = b.interval, seq = 0;
  const m = openModal({
    title: 'Change plan', wide: true, submit: 'Choose', sub: `For ${plural(people, 'person', 'people')}. ${b.has_subscription && b.paid_through ? `You’re on ${planOf(b, b.plan).name}, billed ${b.interval}ly, renewing ${shortDay(b.paid_through)}.` : `You’re on ${planOf(b, b.plan).name}${b.status === 'trial' ? ' after the trial' : ''}.`}`,
    body: html`<div class="pl-tog" role="group" aria-label="Billing period"><button type="button" data-iv="month">Monthly</button><button type="button" data-iv="year">Yearly, 2 months free</button></div>
      <div class="pl-opts" role="radiogroup" aria-label="Plan">${b.plans.map((p) => html`<button type="button" class="pl-opt" role="radio" data-plan="${p.id}"><span class="tag idle pl-now" hidden><i></i>Now</span><b>${p.name}</b><span class="pl-p num" data-price="${p.id}"></span><small>a person a month. ${PLAN_ADDS[p.id]}${p.id === 'starter' ? ' Payroll and HR switch off.' : ''}</small></button>`)}</div>
      <div class="pl-sum" aria-live="polite"></div>`,
    onSubmit: async () => {
      if (plan === b.plan && interval === b.interval) return true;
      const r = await post('/api/billing/change', { plan, interval });
      toast(r.when === 'renewal' ? `${planOf(b, plan).name} from ${shortDay(b.paid_through)}` : `You’re on ${planOf(b, plan).name}`);
      S.me = await get('/api/me'); S.refresh();
      return true;
    },
  });
  const f = m.form, sum = f.querySelector('.pl-sum'), btn = f.querySelector('button[type=submit]');
  async function draw() {
    f.querySelectorAll('[data-iv]').forEach((x) => x.classList.toggle('on', x.dataset.iv === interval));
    for (const p of b.plans) {
      const o = f.querySelector(`[data-plan="${p.id}"]`);
      o.setAttribute('aria-checked', String(p.id === plan)); o.classList.toggle('on', p.id === plan);
      o.querySelector('.pl-now').hidden = !(p.id === b.plan && interval === b.interval);
      f.querySelector(`[data-price="${p.id}"]`).textContent = usd(each(p, interval));
    }
    const P = planOf(b, plan);
    if (plan === b.plan && interval === b.interval) { sum.innerHTML = '<p class="muted">This is your plan now.</p>'; btn.textContent = 'Keep this plan'; return; }
    const n = ++seq;
    sum.innerHTML = '<p class="muted">Working it out…</p>'; btn.disabled = true;
    let r; try { r = await post('/api/billing/preview', { plan, interval }); } catch (e) { if (n === seq) { sum.innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; } return; } finally { if (n === seq) btn.disabled = false; }
    if (n !== seq) return;
    const per = interval === 'year' ? 'a year' : 'a month';
    if (r.no_card) { sum.innerHTML = `<div class="pl-row"><span class="muted">${P.name}, ${interval === 'year' ? 'billed yearly' : 'billed monthly'}</span><b class="num">${usd(r.new_cents)} ${per}</b></div><p class="muted small">${b.status === 'trial' ? 'Nothing is charged until the trial ends.' : 'Charged when you add a card.'}</p>`; btn.textContent = `Choose ${P.name}`; }
    else if (r.when === 'renewal') { sum.innerHTML = `<div class="pl-row"><span class="muted">From ${shortDay(r.at || b.paid_through)}</span><b class="num">${usd(r.new_cents)} ${per}</b></div><p class="muted small">Moving down a plan takes effect at renewal, so you keep what you paid for.</p>`; btn.textContent = `Switch at renewal`; }
    else { sum.innerHTML = `<div class="pl-row"><span class="muted">${P.name} for the time left, less what you paid</span></div><div class="pl-row tot"><b>Charged today</b><b class="num">${usd2(r.charge_cents || 0)}</b></div><div class="pl-row"><span class="muted">${r.renews_at ? `From ${shortDay(r.renews_at)}` : 'Then'}</span><span class="num">${usd(r.new_cents)} ${per}</span></div>${b.card ? `<p class="muted small">Charged to the ${esc(cardWord(b.card))}.</p>` : ''}`; btn.textContent = `Switch to ${P.name}, pay ${usd2(r.charge_cents || 0)}`; }
  }
  f.addEventListener('click', (e) => {
    const iv = e.target.closest('[data-iv]'), op = e.target.closest('[data-plan]');
    if (iv) { interval = iv.dataset.iv; draw(); }
    if (op) { plan = op.dataset.plan; draw(); }
  });
  draw();
};

// the export: made in the background, then downloaded with the sign-in
async function exportReady(onTick) {
  let s = await post('/api/account/export');
  for (let i = 0; i < 600 && s.building; i++) { await new Promise((r) => setTimeout(r, 1000)); s = await get('/api/account/export'); if (onTick) onTick(i); }
  return s.ready;
}
actions['acc-export'] = async (el) => {
  const was = el.textContent; el.disabled = true; el.textContent = 'Getting it ready…';
  try { const r = await exportReady(); toast('Your download is ready'); if (r) await download('/api/account/export/file', r.file); S.refresh(); }
  catch (e) { toast(errMsg(e), true); }
  el.disabled = false; el.textContent = was;
};
actions['acc-export-dl'] = async (el) => { try { await download('/api/account/export/file', el.dataset.file); } catch (e) { toast(errMsg(e), true); } };

actions['bill-close'] = async () => {
  let b; try { b = await freshBill(); } catch (e) { toast(errMsg(e), true); return; }
  const slug = b.address.split('.')[0], trial = b.status === 'trial' || !b.has_subscription || b.status === 'paused';
  const m = openModal({
    title: `Close ${S.settings.org_name}’s account?`, wide: true, danger: true, submit: 'Close the account', cancel: 'Keep the account', sub: 'Only the owner can do this. Take your data first.',
    body: html`<ol class="cl-steps">
        <li><span class="n">1</span><div><b>Download everything</b><p>Hours, attendance, payslips, time off and HR records as spreadsheets, plus screenshots and files.</p></div><button type="button" class="btn sm" data-cl-exp>Make the download</button></li>
        <li><span class="n">2</span><div><b>What happens</b><ul class="bul">${trial ? html`<li>The account closes now and everyone is signed out, including the desktop app.</li>` : html`<li>Your team keeps using Staffwarden until ${shortDay(b.paid_through)}, the end of what you’ve paid for. No new charges after that.</li><li>Then the account closes and everyone is signed out, including the desktop app.</li>`}<li>We keep the data ${b.keep_days || 60} days in case you change your mind, then delete it for good.</li></ul></div></li></ol>
      <div class="field"><label class="f" for="cl-c">Type <b>${slug}</b> to confirm</label><input id="cl-c" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false"></div>`,
    onSubmit: async (fd) => {
      if (String(fd.get('confirm') || '').trim().toLowerCase() !== slug) throw new Error(`Type ${slug} to confirm`);
      const r = await post('/api/billing/close', { confirm: slug });
      if (r.now) { toast('The account is closed'); setTimeout(() => location.reload(), 900); }
      else { toast(`The account closes on ${shortDay(r.closes_at)}`); S.me = await get('/api/me'); S.refresh(); }
      return true;
    },
  });
  const sub = m.form.querySelector('button[type=submit]'), inp = m.form.querySelector('#cl-c');
  const upd = () => { sub.disabled = inp.value.trim().toLowerCase() !== slug; };
  inp.addEventListener('input', upd); upd();
  const ex = m.form.querySelector('[data-cl-exp]');
  ex.addEventListener('click', async () => {
    ex.disabled = true; ex.textContent = 'Getting it ready…';
    try {
      const r = await exportReady();
      ex.closest('li').querySelector('.n').classList.add('ok'); ex.closest('li').querySelector('.n').innerHTML = icon('check').toString();
      ex.closest('li').querySelector('b').textContent = 'Your download is ready';
      ex.textContent = 'Download'; ex.disabled = false;
      ex.onclick = (e) => { e.stopImmediatePropagation(); download('/api/account/export/file', r.file).catch((er) => toast(errMsg(er), true)); };
      download('/api/account/export/file', r.file).catch(() => {});
    } catch (e) { ex.disabled = false; ex.textContent = 'Try again'; toast(errMsg(e), true); }
  }, { once: true });
};

actions['acc-hand'] = async () => {
  let acc; try { acc = await get('/api/account'); } catch (e) { toast(errMsg(e), true); return; }
  openModal({
    title: 'Hand the company over', submit: 'Send the request', sub: 'They get an email and become the owner when they accept. You stay on as an admin.',
    body: html`<div class="field"><label class="f" for="ho">New owner</label><select id="ho" name="user_id">${acc.admins.map((a) => html`<option value="${a.id}">${a.name}, ${a.email}</option>`)}</select><p class="hint">Only admins can become the owner. The request works for 7 days.</p></div>`,
    onSubmit: async (fd) => { await post('/api/account/handover', { user_id: Number(fd.get('user_id')) }); toast('Request sent'); S.refresh(); },
  });
};
actions['acc-hand-cancel'] = async (el) => { el.disabled = true; try { await post('/api/account/handover/cancel'); toast('Request cancelled'); S.refresh(); } catch (e) { toast(errMsg(e), true); el.disabled = false; } };

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act-change="acc-currency"]');
  if (!el) return;
  try { await put('/api/account', { pay_currency: el.value }); setHomeCurrency(el.value); S.settings.pay_currency = el.value; toast(`People are paid in ${curName(el.value)} unless set otherwise`); }
  catch (er) { toast(errMsg(er), true); el.value = homeCurrency(); }
});
