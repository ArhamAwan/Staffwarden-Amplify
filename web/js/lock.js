// While a dialog, side panel, viewer or the notifications list is open, the page behind it stays still.
// Anything placed in #overlay locks the page automatically; other pop-ups call lock('name') / unlock('name').
const holders = new Set();
let watching = false;

function apply() {
  const root = document.documentElement;
  const ov = document.getElementById('overlay');
  const on = holders.size > 0 || !!(ov && ov.childElementCount);
  if (on === root.classList.contains('locked')) return;
  if (on) {
    // keep the layout from jumping sideways when the scrollbar disappears
    const bar = window.innerWidth - root.clientWidth;
    root.style.setProperty('--bar', `${Math.max(0, bar)}px`);
    root.classList.add('locked');
  } else {
    root.classList.remove('locked');
    root.style.removeProperty('--bar');
  }
}

export function lock(name) { holders.add(name); apply(); }
export function unlock(name) { holders.delete(name); apply(); }

export function watchOverlay() {
  if (watching) return;
  const ov = document.getElementById('overlay');
  if (!ov) return;
  watching = true;
  new MutationObserver(apply).observe(ov, { childList: true });
  apply();
}
