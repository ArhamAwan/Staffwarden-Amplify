// The plain address's own pages: start a free trial (you, the code, your company), find your company by
// email, and forgot password. Each company lives at its own address, so these pages end by sending the
// person there: the new owner signed in by a one-time code, everyone else to their company's sign-in.
import { owl } from './util.js';

const root = document.getElementById('st');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const $ = (sel) => root.querySelector(sel);
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const MAIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const MINI = owl('still');

async function call(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch { throw new Error('Can’t reach Staffwarden. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Something went wrong (${res.status})`); e.status = res.status; throw e; }
  return data;
}
const store = {
  get() { try { return JSON.parse(sessionStorage.getItem('sw-signup') || 'null'); } catch { return null; } },
  set(v) { try { if (v) sessionStorage.setItem('sw-signup', JSON.stringify(v)); else sessionStorage.removeItem('sw-signup'); } catch { /* private window */ } },
};
const busy = (btn, on, label) => {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label || 'One moment')}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
};
const showErr = (msg) => { const e = $('.err'); if (e) e.textContent = msg || ''; };

let cfg = { base_domain: 'staffwarden.com', trial_days: 14, countries: [], plans: [] };
const cfgReady = call('GET', '/api/platform/config').then((c) => { cfg = c; }).catch(() => { /* the defaults do */ });

function page({ right, story, cardClass = '', foot = '' }) {
  root.innerHTML = `<header class="st-top"><a class="st-mark" href="/welcome" aria-label="Staffwarden home"><span class="ic">${MINI}</span><b>Staffwarden</b></a><span class="st-top-r">${right || ''}</span></header>
    <main class="st-main">${story}<section class="st-card st-in ${cardClass}">${cardHtml}</section></main>${foot ? `<p class="st-foot">${foot}</p>` : ''}`;
}
let cardHtml = '';
function show(opts, card) { cardHtml = card; page(opts); const f = root.querySelector('[autofocus]'); if (f && matchMedia('(min-width: 981px)').matches) f.focus(); }
const steps = (n) => `<ol class="steps" aria-label="Step ${n} of 3">${['You', 'Your company', 'Your people'].map((s, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'on' : ''}"${i + 1 === n ? ' aria-current="step"' : ''}><i></i>${s}</li>`).join('')}</ol>`;
const haveAccount = '<span class="opt">Already have an account? </span><a href="/signin">Sign in</a>';

// ---------------- start a free trial ----------------
function signupYou(prefill = {}) {
  document.title = 'Start a free trial · Staffwarden';
  show({
    right: haveAccount,
    story: `<section class="st-story"><h1>Your team, set up before your coffee cools.</h1>
      <p class="lede">Make your company’s space, invite your people and watch the first hours come in. Everything is open for ${cfg.trial_days || 14} days.</p>
      <ul class="checks hide-sm"><li class="check">${CHECK}No card until you decide to stay</li><li class="check">${CHECK}Every feature, every plan, during the trial</li><li class="check">${CHECK}Your company’s data kept apart in its own database</li></ul></section>`,
  }, `${steps(1)}
    <div><h2>Start your free trial</h2><p class="sub">You’ll be the owner. You can add other admins later.</p></div>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="nm">Your name</label><input id="nm" class="inp" name="name" autocomplete="name" required maxlength="100" value="${esc(prefill.name || '')}" autofocus></div>
      <div class="field"><label for="em">Work email</label><input id="em" class="inp" name="email" type="email" autocomplete="email" required maxlength="200" value="${esc(prefill.email || '')}" aria-describedby="em-h"><small id="em-h">We send a 6-digit code here to check it’s yours.</small></div>
      <div class="field"><label for="pw">Password</label><div class="pw"><input id="pw" class="inp" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="200" aria-describedby="pw-h"><button type="button" data-peek aria-controls="pw">Show</button></div><small id="pw-h">At least 10 characters.</small></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Continue</button>
    </form>
    <p class="note">${cfg.trial_days || 14} days free. No card needed.</p>`);
  peek();
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]');
    const name = f.name.value.trim(), email = f.email.value.trim(), password = f.password.value;
    if (name.length < 2) { f.name.focus(); return showErr('Type your name.'); }
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { f.email.focus(); return showErr('That doesn’t look like an email address. Check the part after the @.'); }
    if (password.length < 10) { f.password.focus(); return showErr('Use at least 10 characters for the password.'); }
    showErr(''); busy(btn, true, 'Sending the code');
    try {
      const r = await call('POST', '/api/platform/signup/start', { name, email, password });
      store.set({ token: r.token, email: r.email, name, step: 'code', dev: r.dev_code || null, sentAt: Date.now() });
      signupCode();
    } catch (ex) { busy(btn, false); showErr(ex.message); }
  });
}
function peek() {
  root.querySelectorAll('[data-peek]').forEach((b) => b.addEventListener('click', () => {
    const i = document.getElementById(b.getAttribute('aria-controls'));
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; i.focus();
  }));
}

function signupCode() {
  const s = store.get();
  if (!s) return signupYou();
  document.title = 'Check your email · Staffwarden';
  show({
    right: haveAccount,
    story: `<section class="st-story"><div class="env hide-sm" aria-hidden="true">${MAIL}</div><h1>Check your inbox.</h1>
      <p class="lede">We sent a 6-digit code to <b>${esc(s.email)}</b>. It proves the email is yours, so invoices and password resets reach the right person.</p></section>`,
  }, `${steps(1)}
    <div><h2>Enter the code</h2><p class="sub">It works for 15 minutes. Pasting the whole code fills every box.</p></div>
    ${s.dev ? `<p class="devcode">No mail server is set up on this server, so here is the code: <b>${esc(s.dev)}</b></p>` : ''}
    <form id="f" novalidate style="display:contents">
      <fieldset class="code" id="code"><legend class="sr">6-digit code</legend>${[1, 2, 3, 4, 5, 6].map((i) => `<input aria-label="Digit ${i}" inputmode="numeric" autocomplete="${i === 1 ? 'one-time-code' : 'off'}" maxlength="1" pattern="[0-9]"${i === 1 ? ' autofocus' : ''}>`).join('')}</fieldset>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Continue</button>
    </form>
    <p class="muted" style="margin:0;font-size:14px;line-height:1.6;text-align:center">Nothing yet? Check spam. You can <button type="button" class="link" id="again">send it again</button>, or <button type="button" class="link" id="other">use another email</button>.</p>`);
  const boxes = [...root.querySelectorAll('.code input')];
  if (!matchMedia('(min-width: 981px)').matches) boxes[0].focus({ preventScroll: true });
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (digits, from = 0) => {
    digits.split('').forEach((d, k) => { if (boxes[from + k]) boxes[from + k].value = d; });
    const next = boxes[Math.min(5, from + digits.length)];
    next.focus();
    if (value().length === 6) submit();
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      const d = b.value.replace(/\D/g, '');
      b.value = '';
      if (d) fill(d, i);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' && i > 0) { boxes[i - 1].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' && i < 5) { boxes[i + 1].focus(); e.preventDefault(); }
    });
    b.addEventListener('paste', (e) => { const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6); if (d) { e.preventDefault(); boxes.forEach((x) => { x.value = ''; }); fill(d, 0); } });
    b.addEventListener('focus', () => b.select());
  });
  let sending = false;
  async function submit() {
    if (sending) return;
    const code = value();
    if (code.length < 6) { boxes[code.length].focus(); return showErr('The code has 6 digits.'); }
    sending = true; showErr('');
    const btn = root.querySelector('#f [type=submit]');
    busy(btn, true, 'Checking');
    try {
      await call('POST', '/api/platform/signup/verify', { token: s.token, code });
      store.set({ ...s, step: 'company', dev: null });
      signupCompany();
    } catch (ex) {
      sending = false; busy(btn, false);
      if (ex.status === 404) { store.set(null); return signupYou({ name: s.name, email: s.email }); }
      showErr(ex.message);
      const fs = $('#code'); fs.classList.remove('shake'); void fs.offsetWidth; fs.classList.add('shake');
      boxes.forEach((x) => { x.value = ''; }); boxes[0].focus();
    }
  }
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  // send again: after 45 seconds, with the wait shown
  const again = $('#again');
  const tick = () => {
    const left = Math.ceil((45000 - (Date.now() - (store.get() || s).sentAt)) / 1000);
    if (left > 0) { again.disabled = true; again.textContent = `send it again in 0:${String(left).padStart(2, '0')}`; setTimeout(tick, 500); }
    else { again.disabled = false; again.textContent = 'send it again'; }
  };
  tick();
  again.addEventListener('click', async () => {
    again.disabled = true;
    try {
      const r = await call('POST', '/api/platform/signup/resend', { token: s.token });
      store.set({ ...store.get(), sentAt: Date.now(), dev: r.dev_code || null });
      showErr('');
      if (r.dev_code) { const d = root.querySelector('.devcode b'); if (d) d.textContent = r.dev_code; }
      tick();
      again.insertAdjacentHTML('afterend', '<span class="sr" role="status">A new code is on its way.</span>');
    } catch (ex) { showErr(ex.message); again.disabled = false; if (ex.status === 404) { store.set(null); signupYou({ name: s.name, email: s.email }); } }
  });
  $('#other').addEventListener('click', () => { store.set(null); signupYou({ name: s.name }); });
}

const offsetOf = (tz) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    return p ? p.value.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC') : '';
  } catch { return ''; }
};
const cityOf = (tz) => (tz === 'UTC' ? 'UTC' : tz.split('/').pop().replace(/_/g, ' '));
function guessCountry() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const exact = cfg.countries.find((c) => c.tz === tz);
  if (exact) return exact.code;
  const alias = { 'Asia/Calcutta': 'IN', 'Asia/Dacca': 'BD', 'Asia/Saigon': 'OTHER', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'Asia/Muscat': 'AE' };
  return alias[tz] || (cfg.countries.find((c) => c.code === 'OTHER') ? 'OTHER' : 'US');
}
const SIZES = [['1-10', 'Up to 10'], ['11-50', '11 to 50'], ['51-200', '51 to 200'], ['200+', 'More']];

function signupCompany() {
  const s = store.get();
  if (!s) return signupYou();
  document.title = 'Your company · Staffwarden';
  const base = cfg.base_domain || 'staffwarden.com';
  const country = s.country || guessCountry();
  show({
    right: `<span class="pill green">${CHECK}<span>${esc(s.email)} checked</span></span>`,
    story: `<section class="st-story"><h1>This is where your team will sign in.</h1>
      <div class="bar" aria-hidden="true"><i></i><i></i><i></i><span class="u">https://<b id="pv">${esc(s.slug || 'your-company')}</b>.${esc(base)}</span></div>
      <p class="lede hide-sm" style="font-size:16px">Your people get this address in their invite and type it once in the desktop app. It can’t be changed later without everyone signing in again, so pick one you’ll keep.</p>
      <div class="hide-sm"><p class="muted" style="margin:0 0 10px;font-size:13.5px;font-weight:650">Set up from your country, change any of it in Settings</p><div class="sets" id="sets"></div></div></section>`,
  }, `${steps(2)}
    <h2>Your company</h2>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="cn">Company name</label><input id="cn" class="inp" name="company" autocomplete="organization" required maxlength="80" value="${esc(s.company || '')}" autofocus></div>
      <div class="field"><label for="ad">Address your team signs in at</label>
        <div class="addr" id="addr"><input id="ad" name="slug" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32" value="${esc(s.slug || '')}" aria-describedby="ad-h"><span>.${esc(base)}</span></div>
        <small id="ad-h">Letters, numbers and dashes.</small></div>
      <div class="field"><label for="co">Country</label><select id="co" class="sel" name="country" aria-describedby="co-h">${cfg.countries.map((c) => `<option value="${esc(c.code)}"${c.code === country ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select><small id="co-h" class="co-h"></small></div>
      <div class="field"><span class="lab" id="sz-l">About how many people?</span>
        <div class="size" role="group" aria-labelledby="sz-l">${SIZES.map(([v, l]) => `<button type="button" data-size="${v}" aria-pressed="${s.size === v}">${l}</button>`).join('')}</div>
        <small>Only to suggest a plan. You pay for the people you actually add.</small></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit" id="go">Create your company’s space</button>
    </form>
    <p class="note">${cfg.trial_days || 14} days free. No card needed.</p>`);
  const f = $('#f'), ad = $('#ad'), addr = $('#addr'), hint = $('#ad-h'), go = $('#go');
  let edited = !!s.slugEdited, timer = null, last = null, seq = 0;
  root.querySelector('#addr').addEventListener('click', () => ad.focus());
  // the address box is as wide as what's typed, so the domain sits right after it
  const meas = document.createElement('canvas').getContext('2d');
  const fitAddr = () => {
    meas.font = getComputedStyle(ad).font;
    ad.style.width = `${Math.ceil(meas.measureText(ad.value || 'abc').width) + 16}px`;
    $('#pv').textContent = ad.value || 'your-company';
  };
  fitAddr();
  const setHint = (state, text) => { hint.className = state || ''; hint.innerHTML = state === 'ok' ? `${CHECK}${esc(text)}` : esc(text); addr.classList.toggle('bad', state === 'bad'); ad.setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false'); };
  const save = () => store.set({ ...store.get(), company: f.company.value, slug: ad.value, slugEdited: edited, country: f.country.value, size: s.size || null });
  async function check(q) {
    const n = ++seq;
    try {
      const r = await call('GET', `/api/platform/signup/address?${q}`);
      if (n !== seq) return;
      last = r;
      if (!edited && r.slug) { ad.value = r.slug; fitAddr(); }
      if (!r.slug) setHint('', 'Letters, numbers and dashes.');
      else if (r.free) setHint('ok', 'Free to use. Letters, numbers and dashes.');
      else setHint('bad', `${r.why}.`.replace(/\.\.$/, '.'));
      save();
    } catch { /* checked again on submit */ }
  }
  const later = (q) => { clearTimeout(timer); timer = setTimeout(() => check(q), 260); };
  f.company.addEventListener('input', () => {
    go.textContent = f.company.value.trim() ? `Create ${f.company.value.trim().slice(0, 40)}’s space` : 'Create your company’s space';
    if (!edited) later(`name=${encodeURIComponent(f.company.value)}`); else save();
  });
  ad.addEventListener('input', () => {
    const clean = ad.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    if (clean !== ad.value) ad.value = clean;
    edited = !!clean; fitAddr();
    if (clean.length >= 3) later(`slug=${encodeURIComponent(clean)}`); else { last = null; setHint(clean ? 'bad' : '', clean ? 'Use at least 3 characters.' : 'Letters, numbers and dashes.'); if (!clean) later(`name=${encodeURIComponent(f.company.value)}`); }
  });
  const showCountry = () => {
    const c = cfg.countries.find((x) => x.code === f.country.value);
    if (!c) return;
    const zone = `${cityOf(c.tz)}${offsetOf(c.tz) && c.tz !== 'UTC' ? `, ${offsetOf(c.tz)}` : ''}`;
    $('.co-h').textContent = `Sets ${c.money}, ${zone} time${c.holidays ? ` and ${c.name}’s public holidays` : ''}. Change them later.`;
    const sets = $('#sets');
    if (sets) sets.innerHTML = `<div class="set"><small>Pay in</small><b>${esc(c.money.replace(/^\w/, (x) => x.toUpperCase()))}</b></div><div class="set"><small>Time zone</small><b>${esc(zone)}</b></div><div class="set"><small>Days off</small><b>${c.holidays ? `${esc(c.name)}’s public holidays` : 'Add your own in Time off'}</b></div>`;
    save();
  };
  f.country.addEventListener('change', showCountry);
  showCountry();
  root.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-size]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    s.size = b.dataset.size; save();
  }));
  if (f.company.value.trim()) { f.company.dispatchEvent(new Event('input')); if (edited) check(`slug=${encodeURIComponent(ad.value)}`); }
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const company = f.company.value.trim(), slug = ad.value.trim();
    if (company.length < 2) { f.company.focus(); return showErr('Type the company’s name.'); }
    if (slug.length < 3) { ad.focus(); return showErr('Choose an address of at least 3 characters.'); }
    if (last && last.slug === slug && !last.free) { ad.focus(); return showErr(`${last.why}.`); }
    showErr(''); busy(go, true, 'Making your space');
    try {
      const r = await call('POST', '/api/platform/signup/company', { token: s.token, company, slug, country: f.country.value, size: s.size || null });
      store.set(null);
      location.href = `${r.url}/#handoff?c=${encodeURIComponent(r.handoff)}`;
    } catch (ex) {
      busy(go, false); showErr(ex.message);
      if (ex.status === 409) { store.set(null); location.href = '/signin'; }
      else if (/address/i.test(ex.message)) { setHint('bad', ex.message); ad.focus(); }
    }
  });
}

// ---------------- find your company ----------------
const COLORS = ['#1D4ED8', '#0F766E', '#B45309', '#7C3AED', '#BE185D', '#15803D', '#C2410C', '#4338CA'];
const colorOf = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const when = (iso) => {
  if (!iso) return 'not used yet';
  const t = Date.parse(String(iso).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'used today'; if (days === 1) return 'used yesterday';
  return `used ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
};
const moonArt = `<section class="st-art" aria-hidden="true"><div class="st-moon">${owl('still')}</div><p class="st-tag">Keeping watch, so<br>you don’t have to.</p></section>`;
const trustLine = 'Time is tracked only while you choose to, and private windows never leave your computer.';
const goTo = (c, email) => { location.href = `${c.url}/#signin?email=${encodeURIComponent(email)}`; };

function signin(prefill = '') {
  document.title = 'Sign in · Staffwarden';
  show({ right: '<a class="btn sm" href="/signup" style="color:var(--ink)">Start a free trial</a>', story: moonArt, cardClass: 'narrow', foot: trustLine },
    `<div><h2>Welcome back</h2><p class="sub">Start with your work email. We’ll find your company.</p></div>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="em">Email</label><input id="em" class="inp" name="email" type="email" autocomplete="username" required value="${esc(prefill)}" autofocus></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Continue</button>
    </form>
    <p class="muted" style="margin:0;font-size:14px;text-align:center">Forgot your password? <a href="/forgot">Reset it</a></p>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]'), email = e.target.email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { e.target.email.focus(); return showErr('That doesn’t look like an email address.'); }
    showErr(''); busy(btn, true, 'Looking');
    try {
      const r = await call('POST', '/api/platform/find', { email });
      if (r.companies.length === 1) { goTo(r.companies[0], email); return; }
      busy(btn, false);
      pick(email, r.companies);
    } catch (ex) { busy(btn, false); showErr(ex.message); }
  });
}
function pick(email, list) {
  document.title = list.length ? 'Which company? · Staffwarden' : 'Sign in · Staffwarden';
  show({ right: '<a class="btn sm" href="/signup" style="color:var(--ink)">Start a free trial</a>', story: moonArt, cardClass: 'narrow', foot: trustLine },
    list.length ? `<div><h2>Which company?</h2><p class="sub">This email is in ${list.length === 2 ? 'two' : list.length} companies. Each has its own password.</p></div>
      <div class="fake"><span>${esc(email)}</span><button type="button" id="chg">Change</button></div>
      <ul class="cos">${list.map((c, i) => `<li><a href="${esc(c.url)}/#signin?email=${encodeURIComponent(email)}"${i === 0 ? ' autofocus' : ''}><span class="lg" style="background:${colorOf(c.slug)}">${esc((c.name.trim()[0] || '?').toUpperCase())}</span><span class="t"><b>${esc(c.name)}</b><span class="s">${esc(c.address)} · ${c.kind === 'client' ? 'client portal' : 'team'}</span></span>${CHEV}</a></li>`).join('')}</ul>
      <p class="faint" style="margin:0;font-size:13px;line-height:1.5">Missing one? Its owner may have removed you, or invited a different email.</p>`
      : `<div><h2>No company found</h2><p class="sub">We couldn’t find a company with this email.</p></div>
      <div class="fake"><span>${esc(email)}</span><button type="button" id="chg">Change</button></div>
      <div class="none">Check the email in your invite. It may be a different address, or the invite hasn’t been sent yet. Ask whoever runs Staffwarden at your company.</div>
      <a class="btn wide" href="/signup">Start a free trial for your own company</a>`);
  $('#chg').addEventListener('click', () => signin(email));
}

function forgot(prefill = '') {
  document.title = 'Forgot your password · Staffwarden';
  show({ right: '<a href="/signin">Back to sign in</a>', story: moonArt, cardClass: 'narrow', foot: trustLine },
    `<div><h2>Forgot your password?</h2><p class="sub">Type your work email. If it belongs to a company here, we’ll send a link to set a new one.</p></div>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="em">Email</label><input id="em" class="inp" name="email" type="email" autocomplete="username" required value="${esc(prefill)}" autofocus></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Email me a link</button>
    </form>
    <p class="faint" style="margin:0;font-size:13px;line-height:1.5">Forgot which email? Ask whoever runs Staffwarden at your company; they can reset it from People.</p>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]'), email = e.target.email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { e.target.email.focus(); return showErr('That doesn’t look like an email address.'); }
    showErr(''); busy(btn, true, 'Sending');
    try {
      await call('POST', '/api/platform/forgot', { email });
      show({ right: '<a href="/signin">Back to sign in</a>', story: moonArt, cardClass: 'narrow', foot: trustLine },
        `<div><h2>Check your email</h2></div>
        <div class="sent" role="status">${MAIL}<span>If <b>${esc(email)}</b> belongs to a company here, a link is on its way. It works for 30 minutes, once.</span></div>
        <p class="muted" style="margin:0;font-size:14px;line-height:1.55">Nothing after a few minutes? Check spam, or <button type="button" class="link" id="retry">try another email</button>.</p>
        <a class="btn wide" href="/signin">Back to sign in</a>`);
      $('#retry').addEventListener('click', () => forgot(email));
    } catch (ex) { busy(btn, false); showErr(ex.message); }
  });
}

// ---------------- which page ----------------
cfgReady.then(() => {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const email = new URLSearchParams(location.search).get('email') || '';
  if (p === '/signin') return signin(email);
  if (p === '/forgot') return forgot(email);
  const s = store.get();
  if (s && s.step === 'company') return signupCompany();
  if (s && s.step === 'code') return signupCode();
  return signupYou();
});
