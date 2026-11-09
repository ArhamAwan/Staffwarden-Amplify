// What a link from an email opens at the company's own address, before the app itself: an invite to join,
// a new password, taking over as owner, and the one-time code that brings a new owner over from sign-up
// to the welcome screen where they invite their team. Also the screen for an account that was closed.
import { post, get, setToken, getToken } from './api.js';
import { esc, owl, avColor, initials, copyText } from './util.js';

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const SEE = {
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  shot: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V11M16 11V8a1.5 1.5 0 0 1 3 0v6a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4.5 14a1.5 1.5 0 0 1 2.5-1.7L8 14"/>',
  off: '<path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
};
const seeIc = (k) => `<span class="lk-ic"><svg viewBox="0 0 24 24" aria-hidden="true">${SEE[k]}</svg></span>`;
const CLOSED = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';

let root, deps;
const $ = (s) => root.querySelector(s);
const showErr = (m) => { const e = root.querySelector('.lk-err'); if (e) e.textContent = m || ''; };
const errOf = (e) => (e && e.message) || 'Something went wrong';
const busy = (btn, on, label) => {
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="lk-spin" aria-hidden="true"></span>${esc(label)}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
};
let company = null;
async function companyInfo() {
  if (company) return company;
  try { company = await (await fetch('/api/auth/company', { cache: 'no-store' })).json(); } catch { company = {}; }
  return company;
}
const mark = (c) => `<span class="lk-st-mark"><span class="lk-ic">${c && c.icon ? `<img src="${esc(c.icon)}" alt="">` : owl('still')}</span><b>Staffwarden</b></span>`;
const moonArt = (tag = 'Keeping watch, so<br>you don’t have to.') => `<section class="lk-st-art" aria-hidden="true"><div class="lk-st-moon">${owl('still')}</div><p class="lk-st-tag">${tag}</p></section>`;
function render({ right = '', story, card, cardClass = '', foot = '' }) {
  root.innerHTML = `<div class="lk"><div class="lk-st-sky" aria-hidden="true"></div><div class="lk-st">
    <header class="lk-st-top">${mark(company)}<span class="lk-st-top-r">${right}</span></header>
    <main class="lk-st-main">${story}<section class="lk-st-card lk-st-in ${cardClass}">${card}</section></main>${foot ? `<p class="lk-st-foot">${foot}</p>` : ''}</div></div>`;
  const f = root.querySelector('[autofocus]');
  if (f && matchMedia('(min-width: 981px)').matches) f.focus();
}
const clearHash = () => history.replaceState(null, '', location.pathname);
const strength = (pw) => (pw.length >= 16 ? 4 : pw.length >= 12 ? 3 : pw.length >= 10 ? 2 : pw.length ? 1 : 0);
function meter(input, box, hint) {
  const upd = () => {
    const n = strength(input.value);
    box.classList.toggle('lk-weak', n < 2);
    box.querySelectorAll('i').forEach((i, k) => i.classList.toggle('lk-on', k < n));
    hint.textContent = !input.value ? 'At least 10 characters.' : n < 2 ? `${10 - input.value.length} more character${10 - input.value.length === 1 ? '' : 's'} to go.` : n < 4 ? 'Strong enough. Longer is even better.' : 'Strong.';
  };
  input.addEventListener('input', upd); upd();
}
function peek() {
  root.querySelectorAll('[data-peek]').forEach((b) => b.addEventListener('click', () => {
    const i = document.getElementById(b.getAttribute('aria-controls')), show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; i.focus();
  }));
}
const pwField = (id, label, auto = 'new-password') => `<div class="lk-field"><label for="${id}">${label}</label><div class="lk-pw"><input id="${id}" class="lk-inp" type="password" autocomplete="${auto}" required minlength="10" maxlength="200" aria-describedby="${id}-h"><button type="button" data-peek aria-controls="${id}">Show</button></div><div class="lk-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div><small id="${id}-h">At least 10 characters.</small></div>`;
function linkGone(msg) {
  render({
    story: moonArt(), cardClass: 'lk-narrow',
    card: `<div><h2>This link can’t be used</h2><p class="lk-sub">${esc(msg)}</p></div>
      <a class="lk-btn lk-pri lk-wide lk-big" href="/#signin">Go to sign in</a>
      ${company && company.forgot ? '<p class="lk-note">Lost your password? Use “Forgot password?” on the sign-in page for a new link.</p>' : '<p class="lk-note">Ask whoever runs Staffwarden at your company to send a new one.</p>'}`,
  });
}

// ---------------- an invite ----------------
async function join(t) {
  let info;
  try { info = await get(`/api/auth/link?t=${encodeURIComponent(t)}`); } catch (e) { return linkGone(errOf(e)); }
  if (info.kind !== 'invite') return linkGone('This link is for something else. Open the newest email we sent you.');
  document.title = `Join ${info.company} · Staffwarden`;
  const co = esc(info.company), tr = info.tracked || {};
  render({
    right: esc(info.address || ''),
    story: `<section class="lk-st-story">${info.inviter ? `<span class="lk-from"><span class="lk-av" style="background:${avColor(info.inviter.length)}">${esc(initials(info.inviter))}</span><span><b>${esc(info.inviter)}</b> <span class="lk-muted">invited you</span></span></span>` : ''}
      <h1>Join ${co}.</h1>
      <p class="lk-lede">Before you start, here’s exactly what the company sees. You can check it again any time in the app.</p>
      <div class="lk-sees">
        <div class="lk-see">${seeIc('clock')}<div><b>Your hours</b><span>From when you press Start to Stop, and breaks.</span></div></div>
        ${tr.screenshots ? `<div class="lk-see">${seeIc('shot')}<div><b>Screenshots while working</b><span>${tr.shots_per_10 === 1 ? 'One' : tr.shots_per_10 === 2 ? 'Two' : 'Up to three'} every 10 minutes. You see each one. Private windows are hidden.</span></div></div>` : `<div class="lk-see lk-no">${seeIc('shot')}<div><b>No screenshots</b><span>${co} has screenshots switched off.</span></div></div>`}
        <div class="lk-see">${seeIc('hand')}<div><b>How active you were</b><span>Keyboard and mouse counts, never what you typed.</span></div></div>
        <div class="lk-see lk-no">${seeIc('off')}<div><b>Nothing when stopped</b><span>The app records nothing outside your working time.</span></div></div>
      </div></section>`,
    card: `<h2>Set up your login</h2>
      <form id="f" novalidate style="display:contents">
        <div class="lk-field"><label for="jn">Your name</label><input id="jn" class="lk-inp" autocomplete="name" required maxlength="100" value="${esc(info.name)}" aria-describedby="jn-h" autofocus><small id="jn-h">As your team will see it.</small></div>
        <div class="lk-field"><span class="lk-lab">Email</span><div class="lk-lock"><span>${esc(info.email)}</span>${LOCK}</div></div>
        ${pwField('jp', 'Password')}
        <label class="lk-agree"><input id="ja" type="checkbox">I’ve read what ${co} can see, and I agree to tracking while my timer runs.</label>
        <p class="lk-err" role="alert"></p>
        <button class="lk-btn lk-pri lk-wide lk-big" type="submit">Join ${co}</button>
      </form>
      <p class="lk-note">Next: get the desktop app for Mac or Windows.</p>`,
  });
  peek(); meter($('#jp'), root.querySelector('.lk-meter'), $('#jp-h'));
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]'), name = $('#jn').value.trim(), password = $('#jp').value;
    if (name.length < 2) { $('#jn').focus(); return showErr('Type your name.'); }
    if (password.length < 10) { $('#jp').focus(); return showErr('Use at least 10 characters for the password.'); }
    if (!$('#ja').checked) { $('#ja').focus(); return showErr('Tick the box to say you’ve read what the company can see.'); }
    showErr(''); busy(btn, true, 'Joining');
    try {
      const r = await post('/api/join', { token: t, name, password, agree: true });
      setToken(r.token); clearHash();
      joined(info, r.user);
    } catch (ex) { busy(btn, false); showErr(errOf(ex)); }
  });
}
async function joined(info, user) {
  document.title = `Welcome to ${info.company} · Staffwarden`;
  render({
    story: moonArt('You’re in.<br>Welcome aboard.'), cardClass: 'lk-narrow',
    card: `<div><h2>Welcome, ${esc((user && user.name ? user.name : info.name).split(' ')[0])}</h2><p class="lk-sub">You’ve joined ${esc(info.company)}. To track your time, install the desktop app and sign in with ${esc(info.email)}.</p></div>
      <div class="lk-dl" id="dl"><p class="lk-note" style="text-align:left">Your company hasn’t put the desktop app here yet. Ask whoever invited you for it.</p></div>
      <button class="lk-btn lk-pri lk-wide lk-big" type="button" id="open">Open Staffwarden here</button>
      <p class="lk-note">The app asks for your company’s address: <b style="color:var(--ink)">${esc(info.address || location.host)}</b></p>`,
  });
  deps.showDownloads($('#dl'), { into: 'links' });
  $('#open').addEventListener('click', () => deps.boot());
}

// ---------------- a new password ----------------
async function reset(t) {
  let info;
  try { info = await get(`/api/auth/link?t=${encodeURIComponent(t)}`); } catch (e) { return linkGone(errOf(e)); }
  if (info.kind !== 'reset') return linkGone('This link is for something else. Open the newest email we sent you.');
  document.title = 'New password · Staffwarden';
  render({
    story: moonArt(), cardClass: 'lk-narrow', foot: 'Time is tracked only while you choose to, and private windows never leave your computer.',
    card: `<div><h2>New password</h2><p class="lk-sub">For ${esc(info.email)} at ${esc(info.company)}.</p></div>
      <form id="f" novalidate style="display:contents">${pwField('np', 'New password')}
        <p class="lk-err" role="alert"></p>
        <button class="lk-btn lk-pri lk-wide lk-big" type="submit">Save and sign in</button></form>
      <p class="lk-note">You’ll be signed out on your other devices, including the desktop app.</p>`,
  });
  root.querySelector('#np').autofocus = true; if (matchMedia('(min-width: 981px)').matches) $('#np').focus();
  peek(); meter($('#np'), root.querySelector('.lk-meter'), $('#np-h'));
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]'), password = $('#np').value;
    if (password.length < 10) { $('#np').focus(); return showErr('Use at least 10 characters.'); }
    showErr(''); busy(btn, true, 'Saving');
    try { const r = await post('/api/auth/reset', { token: t, password }); setToken(r.token); clearHash(); deps.boot(); }
    catch (ex) { busy(btn, false); showErr(errOf(ex)); }
  });
}

// ---------------- taking over as owner ----------------
async function handover(t) {
  let info;
  try { info = await get(`/api/auth/link?t=${encodeURIComponent(t)}`); } catch (e) { return linkGone(errOf(e)); }
  if (info.kind !== 'handover') return linkGone('This link is for something else. Open the newest email we sent you.');
  let me = null;
  if (getToken()) { try { me = await get('/api/me'); } catch { me = null; } }
  if (!me || me.email !== info.email) {
    // sign in first, as the person it was sent to; then this link opens again
    try { sessionStorage.setItem('sw-after', location.hash); } catch { /* private window */ }
    if (me) setToken(null);
    return deps.showLogin(`Sign in as ${info.email} to take over ${info.company}.`, info.email);
  }
  document.title = `Take over ${info.company} · Staffwarden`;
  render({
    story: moonArt(), cardClass: 'lk-narrow',
    card: `<div><h2>Become the owner?</h2><p class="lk-sub">${esc(info.inviter || 'The owner')} asked to hand ${esc(info.company)}’s Staffwarden account over to you.</p></div>
      <ul class="lk-checks"><li class="lk-check">${CHECK}You get billing, the plan and closing the account</li><li class="lk-check">${CHECK}${esc(info.inviter || 'The owner')} stays on as an admin</li><li class="lk-check">${CHECK}Everyone keeps working as before</li></ul>
      <p class="lk-err" role="alert"></p>
      <button class="lk-btn lk-pri lk-wide lk-big" type="button" id="yes">Become the owner</button>
      <button class="lk-plain" type="button" id="no">Not now</button>`,
  });
  $('#yes').addEventListener('click', async (e) => {
    const btn = e.currentTarget; busy(btn, true, 'Taking over');
    try { await post('/api/account/handover/accept', { token: t }); clearHash(); deps.boot(); } catch (ex) { busy(btn, false); showErr(errOf(ex)); }
  });
  $('#no').addEventListener('click', () => { clearHash(); deps.boot(); });
}

// ---------------- a new owner, arriving from sign-up ----------------
async function handoff(code) {
  root.innerHTML = '<div class="boot" aria-label="Opening your company"><img src="/icons/icon-192.png" alt="" width="96" height="96"></div>';
  try {
    const r = await post('/api/auth/handoff', { code });
    setToken(r.token); clearHash();
    await ready();
  } catch (e) { clearHash(); deps.showLogin(errOf(e)); }
}
const DOMAIN_OK = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const nameFrom = (email) => email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 100) || email;
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
async function ready() {
  const [me, co] = await Promise.all([get('/api/me'), companyInfo()]);
  const acc = me.account || {};
  let billing = null;
  try { billing = await get('/api/billing'); } catch { /* a server without billing */ }
  const name = co.name || 'Your company';
  document.title = `${name} is ready · Staffwarden`;
  const ends = acc.trial_ends_at ? new Date(acc.trial_ends_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : null;
  const plan = billing ? billing.plans.find((p) => p.id === billing.plan) : null;
  render({
    right: esc(co.address || location.host),
    story: `<section class="lk-st-story"><h1>${esc(name)}’s space is ready.</h1>
      <p class="lk-lede">${ends ? `Your trial runs to <b>${esc(ends)}</b>. ` : ''}Four things and your team is tracking:</p>
      <ol class="lk-todo lk-hide-sm">
        <li><div><span class="lk-n lk-ok">${CHECK}</span><span><b>Make the company’s space</b><span class="lk-s">Done</span></span></div></li>
        <li><div><span class="lk-n">2</span><span><b>Invite your people</b><span class="lk-s">They get an email with the address and the app</span></span></div></li>
        <li><div><span class="lk-n">3</span><span><b>Set working hours and shifts</b><span class="lk-s">So late starts and overtime are counted right</span></span></div></li>
        <li><div><span class="lk-n">4</span><span><b>Check the time-off rules</b><span class="lk-s">Paid days a month, who approves, holidays</span></span></div></li>
      </ol></section>`,
    card: `<ol class="lk-steps" aria-label="Step 3 of 3"><li class="lk-done"><i></i>You</li><li class="lk-done"><i></i>Your company</li><li class="lk-on" aria-current="step"><i></i>Your people</li></ol>
      <h2>Invite your people</h2>
      <div class="lk-field"><label for="em-in">Their work emails</label>
        <div class="lk-box" id="box"><input id="em-in" type="email" inputmode="email" autocomplete="off" placeholder="name@company.com" aria-describedby="em-h" autofocus></div>
        <small id="em-h">Paste a list from a spreadsheet or type them, one after another.</small></div>
      <div class="lk-glass" id="sum" hidden></div>
      <p class="lk-err" role="alert"></p>
      <button class="lk-btn lk-pri lk-wide lk-big" type="button" id="send" disabled>Send invites</button>
      <div id="out"></div>
      <button class="lk-plain" type="button" id="later">I’ll invite them later</button>`,
  });
  const box = $('#box'), inp = $('#em-in'), hint = $('#em-h'), send = $('#send'), sum = $('#sum');
  const list = [];  // { email, ok, sent }
  const each = plan ? (billing.interval === 'month' ? plan.month_cents : plan.year_cents / 12) : 0;
  function draw() {
    box.querySelectorAll('.lk-chip').forEach((c) => c.remove());
    for (const it of list) {
      const c = document.createElement('span');
      c.className = `lk-chip${it.ok ? '' : ' lk-bad'}${it.sent ? ' lk-sent' : ''}`;
      c.innerHTML = `<span>${esc(it.email)}</span>${it.sent ? '' : `<button type="button" aria-label="Remove ${esc(it.email)}">${X}</button>`}`;
      const b = c.querySelector('button');
      if (b) b.addEventListener('click', (e) => { e.stopPropagation(); list.splice(list.indexOf(it), 1); draw(); inp.focus(); });
      box.insertBefore(c, inp);
    }
    const good = list.filter((x) => x.ok && !x.sent).length, bad = list.find((x) => !x.ok);
    hint.innerHTML = bad ? `<span style="color:#FFB4A6">${esc(bad.email)} doesn’t look complete. Check the part after the @.</span>` : 'Paste a list from a spreadsheet or type them, one after another.';
    send.disabled = !good;
    send.textContent = good ? `Send ${good} invite${good === 1 ? '' : 's'}` : 'Send invites';
    const people = list.filter((x) => x.ok).length;
    if (people && plan) { sum.hidden = false; sum.innerHTML = `<span class="lk-muted">${people} ${people === 1 ? 'person' : 'people'} plus you, after the trial</span><b>${money(Math.round(people * each))} a month <span class="lk-muted" style="font-weight:500">on ${esc(plan.name)}</span></b>`; }
    else sum.hidden = true;
  }
  function add(text) {
    const parts = String(text).split(/[\s,;<>"()]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const p of parts) if (!list.find((x) => x.email === p) && p !== me.email) list.push({ email: p, ok: DOMAIN_OK.test(p) });
    draw();
  }
  box.addEventListener('click', () => inp.focus());
  inp.addEventListener('keydown', (e) => {
    if (['Enter', ',', ' ', ';', 'Tab'].includes(e.key) && inp.value.trim()) { e.preventDefault(); add(inp.value); inp.value = ''; }
    else if (e.key === 'Backspace' && !inp.value && list.length && !list[list.length - 1].sent) { list.pop(); draw(); }
  });
  inp.addEventListener('blur', () => { if (inp.value.trim()) { add(inp.value); inp.value = ''; } });
  inp.addEventListener('paste', (e) => { const t = e.clipboardData.getData('text'); if (/[\s,;]/.test(t.trim())) { e.preventDefault(); add(t); } });
  const go = () => { clearHash(); history.replaceState(null, '', '#/people'); deps.boot(); };
  $('#later').addEventListener('click', () => { clearHash(); deps.boot(); });
  send.addEventListener('click', async () => {
    if (inp.value.trim()) { add(inp.value); inp.value = ''; }
    const todo = list.filter((x) => x.ok && !x.sent);
    if (!todo.length) return;
    showErr(''); busy(send, true, `Sending ${todo.length}`);
    const links = [], failed = [];
    for (const it of todo) {
      try {
        const r = await post('/api/users', { email: it.email, name: nameFrom(it.email), role: 'employee', invite: true });
        it.sent = true;
        if (r.invite_link) links.push({ email: it.email, link: r.invite_link });
      } catch (ex) { failed.push(`${it.email}: ${errOf(ex)}`); }
      draw();
    }
    busy(send, false); draw();
    if (failed.length) showErr(failed.join(' '));
    const out = $('#out');
    if (links.length) {
      out.innerHTML = `<p class="lk-note" style="text-align:left;margin-bottom:8px">Email isn’t set up on this server, so send each person their link yourself. Each works once, for 7 days.</p>
        <ul class="lk-links">${links.map((l, i) => `<li><span>${esc(l.email)}</span><button class="lk-btn lk-sm" type="button" data-copy="${i}">Copy link</button></li>`).join('')}</ul>`;
      out.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
        b.textContent = (await copyText(links[Number(b.dataset.copy)].link)) ? 'Copied' : 'Copy failed';
      }));
    }
    if (!failed.length) {
      send.textContent = 'Go to your team';
      send.disabled = false;
      send.replaceWith(send.cloneNode(true));
      $('#send').addEventListener('click', go);
      $('#later').textContent = 'Invite more later';
    }
  });
}

// ---------------- an account that was closed ----------------
export function showClosed(app, data) {
  root = app;
  const name = (data && data.company) || 'This company';
  document.title = 'Account closed · Staffwarden';
  render({
    story: moonArt(), cardClass: 'lk-narrow lk-closed',
    card: `<span class="lk-ic" aria-hidden="true">${CLOSED}</span>
      <div><h2>${esc(name)}’s account is closed</h2><p class="lk-sub">The owner closed ${esc(name)}’s Staffwarden account, so it can’t be used any more. Your hours and payslips were kept for the owner to download.</p></div>
      <p class="lk-note" style="text-align:left">Questions about your time or pay? Ask whoever runs ${esc(name)}.</p>
      <button class="lk-btn lk-wide" type="button" id="out">Sign out</button>`,
  });
  root.querySelector('#out').addEventListener('click', () => { setToken(null); history.replaceState(null, '', '/#signin'); location.reload(); });
}

// The link in the address, if there is one: true when this module took over the page.
export async function handleLink(app, d) {
  root = app; deps = d;
  const m = /^#(join|reset|handover|handoff)\?(?:t|c)=([^&]+)/.exec(location.hash);
  if (!m) return false;
  await companyInfo();
  const [, kind, raw] = m, t = decodeURIComponent(raw);
  if (kind === 'join') { await join(t); return true; }
  if (kind === 'reset') { await reset(t); return true; }
  if (kind === 'handover') { await handover(t); return true; }
  if (kind === 'handoff') { await handoff(t); return true; }
  return false;
}
export { companyInfo };
