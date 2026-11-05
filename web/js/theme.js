// Colour themes: each person picks one in Profile › Appearance. A theme re-colours every violet in the
// app (the stylesheets read them as --v-* variables, see tools/themecss.py) to its own hue, keeping each
// colour's brightness, so every contrast stays exactly as in Night Glass. Status colours never change.
// The theme's variables are kept in this browser too, so the next visit is the right colour from the
// first frame (js/theme-boot.js puts them in before anything is drawn).
import { VIOLETS } from './theme-colors.js';

export const THEMES = [
  { id: 'night', name: 'Night Glass', desc: 'The look Staffwarden has always had', sw: ['#0C081D', '#7A5FE4', '#C9BBFF'] },
  { id: 'gold', name: 'Obsidian Gold', desc: 'Black stone and antique gold', hue: 40, k: 0.62, sw: ['#0B0A08', '#9A7A44', '#E2D3B1'] },
  { id: 'sapphire', name: 'Midnight Sapphire', desc: 'Deep navy, cold blue light', hue: 222, k: 1.05, sw: ['#060B1A', '#2F62F0', '#9DBBFF'] },
  { id: 'bordeaux', name: 'Bordeaux', desc: 'Dark wine with a plum rose', hue: 326, k: 0.78, sw: ['#12070B', '#97406F', '#EDB8D6'] },
  { id: 'graphite', name: 'Graphite', desc: 'Quiet and nearly colourless', hue: 220, k: 0.07, sw: ['#0B0C0E', '#6B6E75', '#E4E7EC'] },
  { id: 'company', name: 'Your company', desc: 'Made from your logo’s colour', sw: null },
];
export const themeIds = THEMES.map((t) => t.id);

// ---------- colour maths ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i - 1 + (h[0] === '#' ? 1 : 0), i + 1 + (h[0] === '#' ? 1 : 0)), 16));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function toRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
}
// the colour with this hue and saturation that is exactly as bright as the original
function sameBrightness(rgb, hue, sat) {
  const target = lum(rgb);
  let lo = 0, hi = 1, out = rgb;
  for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; out = toRgb(hue, sat, mid); if (lum(out) < target) lo = mid; else hi = mid; }
  return out;
}
// a company colour is moved off the status hues (green, amber, red) so it never reads as one
function awayFromStatus(h) {
  for (const [c, w] of [[150, 24], [38, 20], [8, 20], [368, 20]]) if (Math.abs(h - c) < w) return h < c ? c - w : c + w;
  return (h + 360) % 360;
}
export function companyParams(brand) {
  if (!brand || !/^#[0-9a-f]{6}$/i.test(brand)) return { hue: 186, k: 0.8 };
  const [h, s] = toHsl(hex(brand.toLowerCase()));
  return { hue: awayFromStatus(h), k: Math.max(0.35, Math.min(1, s * 1.1)) };
}

// the CSS for a theme: one variable per violet colour
export function themeCss(id, brand) {
  const t = THEMES.find((x) => x.id === id);
  if (!t || id === 'night') return '';
  const { hue, k } = id === 'company' ? companyParams(brand) : t;
  const vars = VIOLETS.map((key) => {
    const rgb = hex(key);
    const [h, s] = toHsl(rgb);
    const nh = (hue + (h - 255) * 0.35 + 360) % 360;
    const out = sameBrightness(rgb, nh, Math.min(1, s * k));
    return `--v-${key}:${out.join(' ')}`;
  });
  return `:root{${vars.join(';')}}`;
}
// one colour in a theme ("r g b"), for the small pictures on the theme cards
export function mapOne(key, id, brand) {
  const rgb = hex(key);
  const t = THEMES.find((x) => x.id === id);
  if (!t || id === 'night') return rgb.join(' ');
  const { hue, k } = id === 'company' ? companyParams(brand) : t;
  const [h, s] = toHsl(rgb);
  return sameBrightness(rgb, (hue + (h - 255) * 0.35 + 360) % 360, Math.min(1, s * k)).join(' ');
}
const PREVIEW = { bg: '0c081d', nav: '1e1640', card: '181034', ink: 'f2efff', muted: 'aba4ce', a1: '6b55d6', a2: '9b7bff', atext: 'c9bbff', sel: '8c78e8' };
export const previewStyle = (id, brand) => Object.entries(PREVIEW).map(([n, key]) => `--p-${n}:${mapOne(key, id, brand)}`).join(';');
// the three colours shown on a theme's card
export function swatches(id, brand) {
  const t = THEMES.find((x) => x.id === id);
  if (t && t.sw) return t.sw;
  const { hue, k } = companyParams(brand);
  const c = (h) => `rgb(${sameBrightness(hex(h), (hue + (toHsl(hex(h))[0] - 255) * 0.35 + 360) % 360, Math.min(1, toHsl(hex(h))[1] * k)).join(',')})`;
  return [c('0c081d'), c('7a5fe4'), c('c9bbff')];
}

// put a theme on the page (and remember it for the next visit)
export function applyTheme(id, brand) {
  const css = themeCss(id, brand);
  let el = document.getElementById('theme-vars');
  if (!css) { if (el) el.remove(); } else {
    if (!el) { el = document.createElement('style'); el.id = 'theme-vars'; document.head.appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
  }
  document.documentElement.dataset.theme = id || 'night';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', id && id !== 'night' ? `rgb(${themeCss(id, brand) ? pageOf(id, brand) : '12,8,29'})` : '#0C081D');
  try { if (css) localStorage.setItem('sw-theme-css', css); else localStorage.removeItem('sw-theme-css'); } catch { /* private window */ }
}
function pageOf(id, brand) {
  const t = THEMES.find((x) => x.id === id);
  const { hue, k } = id === 'company' ? companyParams(brand) : t;
  const [h, s] = toHsl(hex('0c081d'));
  return sameBrightness(hex('0c081d'), (hue + (h - 255) * 0.35 + 360) % 360, Math.min(1, s * k)).join(',');
}
// a client (or nobody signed in) always sees the company's own look
export function clearTheme() { applyTheme('night'); }
