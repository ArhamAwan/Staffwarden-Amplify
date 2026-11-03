// Updates the page in place instead of replacing it, so scroll position, focus, open menus
// and half-typed text survive a live refresh.
const isEl = (n) => n.nodeType === 1;
const keyOf = (n) => (isEl(n) ? n.getAttribute('data-k') : null);
// a self-running part (the live chat) for a different thread is a different element, never reused
const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && (a.nodeType !== 1 || (a.getAttribute('data-own') || '') === (b.getAttribute('data-own') || ''));

document.addEventListener('input', (e) => { if (e.target && e.target.dataset) e.target.dataset.dirty = '1'; }, true);
// a <details> the reader opened or closed keeps that state through live refreshes
document.addEventListener('toggle', (e) => { if (e.target && e.target.nodeName === 'DETAILS') e.target.dataset.touched = '1'; }, true);
document.addEventListener('change', (e) => {
  const t = e.target; if (!t || !t.dataset) return;
  t.dataset.dirty = '1';
  // choosing one radio un-chooses the others in its group: they are all the reader's choice now, so a
  // live refresh must not put the first one back
  if (t.type === 'radio' && t.name) for (const r of (t.form || document).querySelectorAll(`input[type="radio"][name="${CSS.escape(t.name)}"]`)) r.dataset.dirty = '1';
}, true);

function syncAttrs(a, b) {
  for (const at of Array.from(a.attributes)) {
    if (!b.hasAttribute(at.name)) {
      if (at.name === 'src' && a.hasAttribute('data-shot')) continue;       // set by the image loader
      if (at.name === 'data-dirty' || at.name === 'data-touched' || at.name === 'data-loading') continue;
      if (at.name === 'open' && a.nodeName === 'DETAILS') continue;   // the reader opened it; a refresh keeps it open
      a.removeAttribute(at.name);
    }
  }
  for (const at of Array.from(b.attributes)) {
    if (a.getAttribute(at.name) !== at.value) {
      if (at.name === 'src' && a.hasAttribute('data-shot')) continue;
      if ((at.name === 'value' || at.name === 'checked' || at.name === 'selected') && isFormField(a)) continue;
      if (at.name === 'open' && a.nodeName === 'DETAILS' && a.dataset.touched) continue;   // nor closes what they closed
      a.setAttribute(at.name, at.value);
    }
  }
}
const isFormField = (el) => /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.nodeName);

function syncField(a, b) {
  const busy = document.activeElement === a || a.dataset.dirty === '1';
  if (busy) return;
  if (a.nodeName === 'INPUT' && (a.type === 'checkbox' || a.type === 'radio')) { a.checked = b.hasAttribute('checked'); return; }
  if (a.nodeName === 'INPUT' || a.nodeName === 'TEXTAREA') { const v = a.nodeName === 'TEXTAREA' ? b.textContent : b.getAttribute('value') || ''; if (a.value !== v) a.value = v; return; }
  if (a.nodeName === 'SELECT') {
    const opts = Array.from(b.querySelectorAll('option'));
    const sel = opts.find((o) => o.hasAttribute('selected')) || opts[0];
    if (sel && a.value !== sel.getAttribute('value')) a.value = sel.getAttribute('value');
  }
}

function patch(a, b) {
  if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  // a part that runs itself (the live chat): left alone as long as it is still the same one
  if (a.hasAttribute('data-own') && a.getAttribute('data-own') === b.getAttribute('data-own')) return;
  syncAttrs(a, b);
  // a <select> takes its value after its options are in place: setting a value its old option list
  // does not have yet would leave it showing nothing
  if (isFormField(a) && a.nodeName !== 'OPTION' && a.nodeName !== 'SELECT') syncField(a, b);
  if (a.nodeName === 'TEXTAREA') return;
  if (a.hasAttribute('data-since')) return;      // filled in by the clock
  patchChildren(a, b);
  if (a.nodeName === 'SELECT') syncField(a, b);
}

function patchChildren(a, b) {
  const old = Array.from(a.childNodes);
  const keyed = new Map();
  const loose = [];
  for (const n of old) { const k = keyOf(n); if (k != null) keyed.set(k, n); else loose.push(n); }
  let li = 0;
  const next = [];
  for (const bn of Array.from(b.childNodes)) {
    const k = keyOf(bn);
    let an = null;
    if (k != null) { an = keyed.get(k) || null; if (an) keyed.delete(k); }
    else if (li < loose.length && same(loose[li], bn)) an = loose[li++];
    if (an && same(an, bn)) patch(an, bn); else an = bn;
    next.push(an);
  }
  const keep = new Set(next);
  for (const n of old) if (!keep.has(n)) a.removeChild(n);
  let ref = a.firstChild;
  for (const n of next) {
    if (n === ref) ref = ref.nextSibling;
    else a.insertBefore(n, ref);
  }
}

export function morph(root, htmlString) {
  const t = document.createElement('template');
  t.innerHTML = htmlString;
  patchChildren(root, t.content);
}
