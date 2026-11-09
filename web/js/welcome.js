// The landing page's motion: the sky and the nav clock follow the scroll through one night, the owl
// watches the pointer and blinks, and the sticky sections play forward as you scroll through them.
(() => {
  'use strict';
  const root = document.documentElement;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- the headline comes in word by word ----------
  const h1 = $('.hero h1.words');
  if (h1) {
    let i = 0;
    h1.innerHTML = h1.innerHTML.split(/(\s+)/).map((t) => (/^\s+$/.test(t) ? t : `<span class="w" style="--i:${i++}">${t}</span>`)).join('');
    const go = () => requestAnimationFrame(() => h1.classList.add('go'));
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(go);
    setTimeout(go, 900);   // never wait long for a font
  }

  // ---------- things rise into view ----------
  const io = new IntersectionObserver((list) => { for (const e of list) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }, { rootMargin: '0px 0px -8% 0px', threshold: .12 });
  $$('.r').forEach((el) => io.observe(el));
  // a row of things comes in one after another
  for (const group of $$('.bento, .rules, .two, .faq .narrow')) $$('.r', group).forEach((el, n) => el.style.setProperty('--d', `${(n % 4) * 0.08}s`));

  // ---------- stars, at three depths ----------
  const cv = $('.stars'), ctx = cv && cv.getContext('2d');
  let stars = [], W = 0, H = 0, dpr = 1;
  function seed() {
    dpr = Math.min(2, window.devicePixelRatio || 1); W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((W * H) / 5200);
    stars = Array.from({ length: n }, () => { const z = Math.random(); return { x: Math.random() * W, y: Math.random() * H * 3, z, r: .4 + z * 1.3, t: Math.random() * 6.28, s: .6 + Math.random() * 1.6 }; });
  }
  function drawStars(time) {
    ctx.clearRect(0, 0, W, H);
    const sy = scrollY;
    for (const s of stars) {
      const y = ((s.y - sy * (.04 + s.z * .16)) % (H * 3) + H * 3) % (H * 3);
      if (y > H) continue;
      const a = still ? .7 : .35 + .55 * (0.5 + 0.5 * Math.sin(s.t + time * .001 * s.s));
      ctx.globalAlpha = a * (.5 + s.z * .5);
      ctx.fillStyle = s.z > .85 ? '#FFE9C2' : '#E6E0FF';
      ctx.beginPath(); ctx.arc(s.x, y, s.r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- the scroll drives the night ----------
  const clockEls = $$('[data-clock]'), heroArt = $('.hero-art');
  const rise = $('.rise'), app = $('[data-rise]'), riseStage = $('.rise-stage');
  const merge = $('.merge'), tools = $('.tools');
  const shift = $('.shift'), shiftStage = $('.shift-stage'), shiftClock = $('[data-shift-clock]'), events = $$('.events li');
  const desk = $('[data-wipe] .desk');
  const fmt = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440, h = Math.floor(m / 60), mm = m % 60; return `${(h % 12) || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const prog = (el) => { const r = el.getBoundingClientRect(); return { r, sp: clamp(-r.top / Math.max(1, r.height - innerHeight)) }; };
  // the clock in the top bar is the visitor's own time
  const tick = () => { const d = new Date(), t = fmt(d.getHours() * 60 + d.getMinutes()); for (const c of clockEls) if (c.textContent !== t) c.textContent = t; };
  tick(); setInterval(tick, 15000);
  let lastNow = -1;
  // the clock keeps pace with the story: it reads each event's time as that event comes up
  const KEYS = [[0, 540], [.12, 542], [.26, 600], [.42, 780], [.56, 920], [.74, 1075], [.86, 1080]];
  const shiftAt = (x) => { for (let i = 1; i < KEYS.length; i++) { const [a, ma] = KEYS[i - 1], [b, mb] = KEYS[i]; if (x <= b) return ma + ((x - a) / (b - a)) * (mb - ma); } return 1080; };
  // the dashboard is shrunk to fit short screens: the bar on top, the dashboard and its sentence all in view
  function fitApp() {
    if (!app) return;
    app.style.setProperty('--fit', 1); app.style.setProperty('--lift', '0px');
    const say = $('[data-rise-say]'), room = innerHeight - 92 - 20 - (say ? say.offsetHeight : 0) - 24, h = app.offsetHeight;
    const f = Math.min(1, room / h);
    app.style.setProperty('--fit', f.toFixed(3)); app.style.setProperty('--lift', `${Math.round(h * (1 - f))}px`);
  }
  function onScroll() {
    const vh = innerHeight, max = Math.max(1, root.scrollHeight - vh), page = clamp(scrollY / max);
    root.style.setProperty('--page', page.toFixed(4));
    if (heroArt) heroArt.style.setProperty('--hy', clamp(scrollY / vh).toFixed(3));
    if (rise) {
      const { r, sp } = prog(rise);
      app.style.setProperty('--p', clamp((vh - r.top) / (vh * 1.7)).toFixed(4));
      riseStage.style.setProperty('--sp', sp.toFixed(4));
    }
    if (merge) tools.style.setProperty('--q', clamp(prog(merge).sp * 1.5).toFixed(4));
    if (shift) {
      const { r, sp } = prog(shift);
      shiftStage.style.setProperty('--sp', sp.toFixed(4));
      shiftStage.style.setProperty('--vis', r.top < vh * .5 && r.bottom > vh * .5 ? '1' : '0');
      shiftClock.textContent = sp >= .88 ? 'Pay day' : fmt(shiftAt(sp));
      let now = 0; events.forEach((li, n) => { if (sp >= Number(li.dataset.at)) now = n; });
      if (now !== lastNow) { lastNow = now; events.forEach((li, n) => { li.classList.toggle('now', n === now); li.classList.toggle('past', n < now); li.classList.toggle('prev', n === now - 1); }); }
    }
    if (desk) { const r = desk.getBoundingClientRect(); desk.style.setProperty('--wipe', clamp((vh * .8 - r.top) / (vh * .45)).toFixed(3)); }
  }

  // ---------- the owl watches the pointer ----------
  const owl = $('.owl-wrap');
  addEventListener('pointermove', (e) => {
    if (heroArt) { heroArt.style.setProperty('--mx', ((e.clientX / innerWidth) * 2 - 1).toFixed(3)); heroArt.style.setProperty('--my', ((e.clientY / innerHeight) * 2 - 1).toFixed(3)); }
    if (owl) {
      const b = owl.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height * .48;
      const dx = e.clientX - cx, dy = e.clientY - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 260);
      owl.style.setProperty('--ex', ((dx / d) * k).toFixed(3)); owl.style.setProperty('--ey', ((dy / d) * k).toFixed(3));
    }
  }, { passive: true });
  if (owl) owl.addEventListener('click', () => { owl.classList.remove('hoot'); void owl.offsetWidth; owl.classList.add('hoot'); });

  // a soft light follows the pointer across the tiles
  for (const el of $$('[data-hover]')) el.addEventListener('pointermove', (e) => { const b = el.getBoundingClientRect(); el.style.setProperty('--hx', `${e.clientX - b.left}px`); el.style.setProperty('--hy2', `${e.clientY - b.top}px`); });

  // ---------- one loop for everything ----------
  let ticking = false;
  const kick = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; onScroll(); if (still && ctx) drawStars(0); }); } };
  addEventListener('scroll', kick, { passive: true });
  addEventListener('resize', () => { if (ctx) seed(); fitApp(); kick(); });
  if (ctx) seed();
  fitApp(); if (document.fonts) document.fonts.ready.then(fitApp);
  onScroll();
  if (ctx) {
    if (still) drawStars(0);
    else { const loop = (t) => { if (!document.hidden) drawStars(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
  }
})();

// the price calculator: people on the team, monthly or yearly, a total for each plan
(() => {
  const range = document.getElementById('ppl'), out = document.getElementById('ppl-n');
  if (!range) return;
  let yearly = true;
  const fmt = (v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(v) ? 0 : 2 })}`;
  const draw = () => {
    const n = Number(range.value);
    out.textContent = n;
    for (const p of document.querySelectorAll('.plan[data-year]')) {
      const y = Number(p.dataset.year), each = yearly ? y : Math.round(y * 1.2 * 100) / 100;
      p.querySelector('[data-each]').textContent = fmt(each);
      p.querySelector('[data-ppl]').textContent = `${n} people`;
      p.querySelector('[data-total]').textContent = fmt(Math.round((yearly ? y * 12 * n : each * n) * 100) / 100);
      p.querySelector('[data-per]').textContent = yearly ? 'a year' : 'a month';
    }
  };
  range.addEventListener('input', draw);
  for (const b of document.querySelectorAll('.pl-tog [data-iv]')) b.addEventListener('click', () => { yearly = b.dataset.iv === 'year'; document.querySelectorAll('.pl-tog [data-iv]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); });
  draw();
})();
