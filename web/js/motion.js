// Motion that explains change: a page settles in when you open it, numbers count up once,
// and a number that changes on a live update gives a short pulse so the eye catches it.
// Live refreshes never replay the entrance, and everything is skipped when the OS asks for reduced motion.

export const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

let enterTimer = null;
export function enter(view) {
  if (reduced()) return;
  view.classList.remove('enter');
  void view.offsetWidth; // restart the animation if it was mid-way
  view.classList.add('enter');
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => view.classList.remove('enter'), 1200);
  view.querySelectorAll('.kpi .v').forEach((v, i) => countUp(v, 120 + i * 60));
}

// "150h 33m" -> counts 0h 00m up to it. Only the number text moves; units stay put.
function countUp(el, delay) {
  const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.data));
  if (!node) return;
  const final = node.data;
  const parts = final.split(/(\d+)/);
  const fmt = (v, i) => { const s = parts[i]; return s[0] === '0' || /h $/.test(parts[i - 1]) ? String(v).padStart(s.length, '0') : String(v); };
  const at = (e) => parts.map((s, i) => (i % 2 ? fmt(Math.round(Number(s) * e), i) : s)).join('');
  const t0 = performance.now() + delay, len = 750;
  let last = null;
  const frame = (now) => {
    if (!node.isConnected || node.data !== last) return; // re-rendered meanwhile: leave it alone
    const p = Math.min(1, Math.max(0, (now - t0) / len));
    node.data = p >= 1 ? final : at(1 - Math.pow(1 - p, 3));
    last = node.data;
    if (p < 1) requestAnimationFrame(frame);
  };
  node.data = at(0);
  last = node.data;
  requestAnimationFrame(frame);
}

// Remember each KPI value before a live re-render, then pulse the ones that changed.
export function snapshot(view) {
  const m = new Map();
  view.querySelectorAll('.kpi[data-k]').forEach((k) => m.set(k.dataset.k, k.querySelector('.v')?.textContent));
  view.querySelectorAll('[data-k] .tag').forEach((t) => { const k = t.closest('[data-k]').dataset.k; m.set('tag:' + k, t.textContent); });
  return m;
}
export function pulseChanges(view, before) {
  if (!before || reduced() || view.classList.contains('enter')) return;
  view.querySelectorAll('.kpi[data-k]').forEach((k) => {
    const v = k.querySelector('.v');
    if (v && before.has(k.dataset.k) && before.get(k.dataset.k) !== v.textContent) replay(v, 'bump');
  });
  view.querySelectorAll('[data-k] .tag').forEach((t) => {
    const k = 'tag:' + t.closest('[data-k]').dataset.k;
    if (before.has(k) && before.get(k) !== t.textContent) replay(t, 'bump');
  });
}
function replay(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 900); }

// Dialogs leave the way they came in instead of vanishing.
export function leave(el, done) {
  if (reduced() || !el.isConnected) { el.remove(); done && done(); return; }
  el.classList.add('leaving');
  setTimeout(() => { el.remove(); done && done(); }, 160);
}
