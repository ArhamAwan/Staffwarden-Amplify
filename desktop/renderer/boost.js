'use strict';
// The boost clip window: he rises from the bottom edge, his message pops above him, the clip plays twice,
// then after 8 seconds (or Boost back, Later or Esc) he drops out of sight and the window closes.
// Only the message takes clicks; everywhere else they go to whatever is underneath.
(async () => {
  const API = window.tracker;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), bubble = $('bubble'), bar = $('bar');
  const b = await API.boostData();
  if (!b) { API.boostClose(); return; }
  const SHOW_MS = 8000;
  stage.classList.add(b.corner === 'left' ? 'left' : 'right');
  $('who').textContent = `BOOST FROM ${String(b.author && b.author.first || 'THE BOSS').toUpperCase()}`;
  $('line').textContent = b.line;
  // the clip is a video with a see-through background: it plays twice, then holds its last frame
  const him = $('him');
  him.setAttribute('aria-label', `${(b.author && b.author.first) || 'The owner'}, powering up`);
  him.muted = true;
  let plays = 0;
  him.addEventListener('ended', () => { if (++plays < 2) { him.currentTime = 0; him.play().catch(() => {}); } });
  him.src = 'boost-clip.webm';
  await new Promise((ok) => { if (him.readyState >= 3) return ok(); him.addEventListener('canplaythrough', ok, { once: true }); him.addEventListener('error', ok, { once: true }); setTimeout(ok, 1500); });
  him.play().catch(() => {});

  let left = SHOW_MS, last = performance.now(), paused = false, gone = false;
  const leave = (wait = 0) => {
    if (gone) return; gone = true;
    setTimeout(() => { stage.classList.remove('talk'); stage.classList.add('out'); setTimeout(() => API.boostClose(), 500); }, wait);
  };
  // the countdown stops while the mouse is on the message, so there is time to read it
  const tick = (t) => {
    if (gone) return;
    if (!paused) left -= t - last;
    last = t;
    bar.style.transform = `scaleX(${Math.max(0, left / SHOW_MS)})`;
    if (left <= 0) { leave(); return; }
    requestAnimationFrame(tick);
  };
  bubble.addEventListener('mouseenter', () => { paused = true; API.boostMouse(true); });
  bubble.addEventListener('mouseleave', () => { paused = false; API.boostMouse(false); });

  $('back').addEventListener('click', async () => {
    $('acts').hidden = true;
    const t = $('thanks'); t.hidden = false;
    const r = await API.boostAnswer(b.id, 'boosted');
    t.textContent = r && r.error ? 'Couldn’t send that. Boost back from the chat.' : `Boosted back. ${(b.author && b.author.first) || 'They'} sees it.`;
    leave(1600);
  });
  $('later').addEventListener('click', () => leave());
  addEventListener('keydown', (e) => { if (e.key === 'Escape') leave(); });

  requestAnimationFrame(() => {
    stage.classList.add('in');
    setTimeout(() => { stage.classList.add('talk'); last = performance.now(); requestAnimationFrame(tick); }, 300);
  });
})();
