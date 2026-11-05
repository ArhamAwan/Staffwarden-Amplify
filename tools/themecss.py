#!/usr/bin/env python3
"""Makes the web app's violet colours themeable.

Every colour in the violet family (the night-glass brand: hue 225 to 300) in the given stylesheets is
rewritten from  #6B55D6  to  rgb(var(--v-6b55d6, 107 85 214))  and from  rgba(139,92,246,.26)  to
rgb(var(--v-8b5cf6, 139 92 246) / .26). With no theme chosen nothing is set, so every colour falls back
to exactly what it was. A theme sets the --v-* variables (web/js/theme.js works them out), keeping each
colour's brightness, so every contrast in the app stays the same in every theme.
Status colours (green, amber, red) and everything else are left alone.

Writes web/js/theme-colors.js: the list of colours a theme has to provide.
Idempotent: a converted file is marked and skipped.
    python3 tools/themecss.py web/css/app.css web/css/glass.css ...
"""
import colorsys, re, sys, json, os

MARK = '/* themeable: violet colours are --v-* variables */'


def violet(r, g, b):
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    return 225 <= h * 360 <= 300 and s > 0.08 and 0.015 < l < 0.985


def rgb_of_hex(h):
    if len(h) in (3, 4):
        h = ''.join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), (round(int(h[6:8], 16) / 255, 3) if len(h) == 8 else None)


def var(r, g, b, a=None):
    key = f'{r:02x}{g:02x}{b:02x}'
    seen.add(key)
    alpha = '' if a is None else f' / {a}'
    return f'rgb(var(--v-{key}, {r} {g} {b}){alpha})'


seen = set()
HEX = re.compile(r'#([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})(?![0-9A-Fa-f\w])')
RGB = re.compile(r'rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+%?)\s*)?\)')
URL = re.compile(r'url\([^)]*\)')


def convert(text):
    # leave anything inside url(...) alone (data URIs)
    parts, last = [], 0
    for m in URL.finditer(text):
        parts.append((text[last:m.start()], True)); parts.append((m.group(0), False)); last = m.end()
    parts.append((text[last:], True))
    out = []
    for chunk, live in parts:
        if not live:
            out.append(chunk); continue
        def hx(m):
            r, g, b, a = rgb_of_hex(m.group(1))
            return var(r, g, b, a) if violet(r, g, b) else m.group(0)
        def rg(m):
            r, g, b = (int(x) for x in m.group(1, 2, 3))
            a = m.group(4)
            if not violet(r, g, b):
                return m.group(0)
            return var(r, g, b, a)
        chunk = RGB.sub(rg, chunk)
        chunk = HEX.sub(hx, chunk)
        out.append(chunk)
    return ''.join(out)


def main(paths):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    listing = os.path.join(root, 'web', 'js', 'theme-colors.js')
    if os.path.exists(listing):
        seen.update(re.findall(r"'([0-9a-f]{6})'", open(listing).read()))
    for p in paths:
        s = open(p, encoding='utf-8').read()
        if MARK in s:
            # already converted: still list its colours
            seen.update(re.findall(r'--v-([0-9a-f]{6})', s)); continue
        s2 = convert(s)
        if p.endswith('.css'):
            s2 = MARK + '\n' + s2
        open(p, 'w', encoding='utf-8').write(s2)
        print(p, s2.count('var(--v-'))
    keys = sorted(seen)
    open(listing, 'w').write('// Made by tools/themecss.py: every violet colour the app uses, which each theme maps.\n'
                             f"export const VIOLETS = {json.dumps(keys).replace(chr(34), chr(39))};\n")
    print('colours', len(keys))


if __name__ == '__main__':
    main(sys.argv[1:])
