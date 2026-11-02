#!/usr/bin/env python3
"""Rewrites the web app's light stylesheets into the night-glass theme, by property.

Text colours become light, surfaces become see-through glass, lines become faint white, and the
:root tokens are replaced with the dark set. Run once from the repo root; it is idempotent
because it marks each converted file.  python3 tools/darkcss.py web/css/app.css ...
"""
import colorsys, re, sys

MARK = '/* night-glass: converted */'

ROOT = {
    '--ink': '#F2EFFF', '--ink-2': '#D9D3F2', '--muted': '#ABA4CE', '--faint': '#8A83AE', '--line': 'rgba(255,255,255,.09)', '--line-2': 'rgba(255,255,255,.06)',
    '--page': '#0C081D', '--card': 'rgba(255,255,255,.045)', '--blue': '#6B55D6', '--blue-dark': '#C9BBFF', '--blue-wash': 'rgba(124,100,240,.22)',
    '--brass-wash': 'rgba(247,170,60,.16)', '--work': '#2E9E6B', '--work-ink': '#7BE3B0', '--work-wash': 'rgba(46,170,120,.16)',
    '--brk': '#F7B544', '--brk-ink': '#FFCB66', '--brk-wash': 'rgba(247,170,60,.16)', '--idle': '#9C93C9', '--idle-ink': '#CFC8EC', '--idle-wash': 'rgba(255,255,255,.07)',
    '--late': '#E0602F', '--late-ink': '#FF9F7A', '--late-wash': 'rgba(224,96,47,.16)', '--leave': '#9B85FF', '--leave-ink': '#C9BBFF', '--leave-wash': 'rgba(124,100,240,.2)',
    '--bad': '#FF8A73', '--bad-wash': 'rgba(224,70,50,.16)', '--moon': '#2A2150',
}

def hexrgb(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def text(h):
    r, g, b = hexrgb(h)
    hh, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    if l >= 0.62: return h                     # already light (white text on colour etc.)
    nl = 0.9 - l * 0.35 if s < 0.35 else min(0.82, 0.62 + (0.5 - min(l, 0.5)) * 0.4)
    ns = min(1, s * (0.6 if s < 0.35 else 1.0))
    r2, g2, b2 = colorsys.hls_to_rgb(hh, nl, ns)
    return '#%02X%02X%02X' % (round(r2 * 255), round(g2 * 255), round(b2 * 255))

def surface(h, kind):
    r, g, b = hexrgb(h)
    hh, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    if l < 0.55: return h                      # dark or saturated surfaces stay (buttons, the old rail)
    if s < 0.25 or l > 0.965:                  # white and near-white greys
        a = {'bg': 0.045 + (1 - l) * 0.35, 'line': 0.09 + (1 - l) * 0.25}[kind]
        return f'rgba(255,255,255,{min(a, .16):.3f})'
    r2, g2, b2 = colorsys.hls_to_rgb(hh, 0.55, min(1, s * 1.1))   # tinted washes keep their hue
    a = 0.16 if kind == 'bg' else 0.3
    return f'rgba({round(r2 * 255)},{round(g2 * 255)},{round(b2 * 255)},{a})'

HEX = re.compile(r'#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b')

def decl(prop, val):
    p = prop.strip().lower()
    if p.startswith('--'):
        return ROOT.get(p, val)
    if p in ('color', 'caret-color', '-webkit-text-fill-color'):
        return HEX.sub(lambda m: text(m.group(0)), val)
    if p.startswith('background') or p in ('box-shadow',):
        if p == 'box-shadow':
            val = re.sub(r'rgba\((22|26),\s*(15|18),\s*(48|56),\s*([.0-9]+)\)', lambda m: f'rgba(0,0,0,{min(.7, float(m.group(4)) * 1.8):.2f})', val)
            return HEX.sub(lambda m: surface(m.group(0), 'line') if hexrgb(m.group(0)) != (255, 255, 255) else 'rgba(255,255,255,.08)', val)
        return HEX.sub(lambda m: surface(m.group(0), 'bg'), val)
    if p.startswith('border') or p.startswith('outline') or p in ('fill', 'stroke', 'accent-color', 'text-decoration-color', 'column-rule'):
        if p in ('fill', 'stroke', 'accent-color'): return val
        return HEX.sub(lambda m: surface(m.group(0), 'line'), val)
    return val

def convert(css):
    if MARK in css: return css
    out = []
    def block(m):
        body = m.group(2)
        nb = re.sub(r'(?<![\w-])([-\w]+)\s*:\s*([^;{}]+)', lambda d: f'{d.group(1)}: {decl(d.group(1), d.group(2))}', body)
        return m.group(1) + nb + '}'
    css = re.sub(r'([^{}]*\{)([^{}]*)\}', block, css)
    css = css.replace('color-scheme: light', 'color-scheme: dark')
    return MARK + '\n' + css

if __name__ == '__main__':
    for f in sys.argv[1:]:
        s = open(f).read(); open(f, 'w').write(convert(s)); print('converted', f)
