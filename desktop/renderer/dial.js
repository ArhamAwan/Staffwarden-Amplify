'use strict';
// The shift dial: the ring is the person's shift (its start at the top, round to its end). Work fills it in
// green, breaks amber, idle grey; a brass marker shows where in the shift "now" is, and a brass arc outside
// the ring marks the scheduled break. Used by the main window and the menu bar / tray panel.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const R = 100, C = 2 * Math.PI * R, H = 3600000;
  let uid = 0;
  const mk = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

  function create(host, { size = 248, stroke = 13, ticks = true, label = 'Your shift so far' } = {}) {
    const id = 'whArc' + ++uid;
    const svg = mk('svg', { viewBox: '-14 -14 268 268', width: size, height: size, class: 'dial', role: 'img', 'aria-label': label });
    const defs = mk('defs');
    const g = mk('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
    g.append(mk('stop', { offset: '0', 'stop-color': '#2BD08F' }), mk('stop', { offset: '1', 'stop-color': '#0E9A63' }));
    defs.append(g);
    const track = mk('circle', { cx: 120, cy: 120, r: R, fill: 'none', class: 'd-track', 'stroke-width': stroke });
    const tickG = mk('g', { class: 'd-ticks' });
    const rs = R + stroke / 2 + 5, cs = 2 * Math.PI * rs;
    const sched = mk('circle', { cx: 120, cy: 120, r: rs, fill: 'none', class: 'd-sched', 'stroke-width': 3, 'stroke-linecap': 'round', transform: 'rotate(-90 120 120)', 'stroke-dasharray': `0 ${cs}` });
    const segG = mk('g', { class: 'd-segs' });
    const ping = mk('circle', { cx: 120, cy: 20, r: 10, fill: 'none', class: 'd-ping', 'stroke-width': 2 });
    const now = mk('circle', { cx: 120, cy: 20, r: stroke < 20 ? 9 : 13, class: 'd-now', 'stroke-width': stroke < 20 ? 4 : 6 });
    svg.append(defs, track, tickG, sched, segG, ping, now);
    host.append(svg);
    const segEls = [];
    let tickKey = '';

    function update(st, nowMs = Date.now()) {
      const segs = (st && st.segments) || [];
      let a = st && st.shift ? st.shift.startMs : null, b = st && st.shift ? st.shift.endMs : null;
      if (!a || !(b > a)) { a = segs.length ? Date.parse(segs[0].s) : nowMs; b = a + 9 * H; }
      const span = b - a, per = C / span;
      const clamp = (ms) => Math.max(a, Math.min(b, ms));
      // hour marks, brass every third hour (rebuilt only when the shift changes)
      const key = a + '|' + b + '|' + ticks;
      if (key !== tickKey) {
        tickKey = key;
        while (tickG.firstChild) tickG.firstChild.remove();
        if (ticks) for (let k = 0; k * H <= span; k++) {
          const ang = (k * H / span) * 2 * Math.PI - Math.PI / 2, major = k % 3 === 0;
          const r1 = R + stroke / 2 + 5, r2 = R + stroke / 2 + (major ? 12 : 8);
          tickG.append(mk('line', { x1: (120 + r1 * Math.cos(ang)).toFixed(1), y1: (120 + r1 * Math.sin(ang)).toFixed(1), x2: (120 + r2 * Math.cos(ang)).toFixed(1), y2: (120 + r2 * Math.sin(ang)).toFixed(1), class: major ? 'd-tick major' : 'd-tick', 'stroke-width': major ? 2 : 1.4, 'stroke-linecap': 'round' }));
        }
      }
      // the scheduled break
      const sh = st && st.shift;
      if (sh && sh.breakStartMs && sh.breakEndMs > sh.breakStartMs) {
        const s0 = ((clamp(sh.breakStartMs) - a) / span) * cs, len = ((clamp(sh.breakEndMs) - clamp(sh.breakStartMs)) / span) * cs;
        sched.setAttribute('stroke-dasharray', `${len.toFixed(1)} ${cs.toFixed(1)}`); sched.setAttribute('stroke-dashoffset', (-s0).toFixed(1));
      } else sched.setAttribute('stroke-dasharray', `0 ${cs.toFixed(1)}`);
      // work, breaks and idle, each its own arc so it can grow smoothly
      const shown = segs.map((g) => ({ t: g.t, s: clamp(Date.parse(g.s)), e: clamp(Date.parse(g.e)) })).filter((g) => g.e > g.s);
      shown.forEach((g, i) => {
        let el = segEls[i];
        if (!el) { el = mk('circle', { cx: 120, cy: 120, r: R, fill: 'none', 'stroke-width': stroke, transform: 'rotate(-90 120 120)', class: 'd-arc' }); segG.append(el); segEls[i] = el; }
        el.setAttribute('stroke', g.t === 'w' ? `url(#${id})` : g.t === 'b' ? '#F0A800' : '#827AA4');
        el.setAttribute('stroke-dasharray', `${Math.max(0.01, (g.e - g.s) * per).toFixed(2)} ${C.toFixed(1)}`);
        el.setAttribute('stroke-dashoffset', (-(g.s - a) * per).toFixed(2));
      });
      while (segEls.length > shown.length) segEls.pop().remove();
      // now
      const ang = ((clamp(nowMs) - a) / span) * 2 * Math.PI - Math.PI / 2;
      const x = (120 + R * Math.cos(ang)).toFixed(1), y = (120 + R * Math.sin(ang)).toFixed(1);
      for (const n of [now, ping]) { n.setAttribute('cx', x); n.setAttribute('cy', y); }
      svg.setAttribute('data-mode', !st ? 'off' : st.running ? 'run' : st.paused ? 'brk' : 'off');
      return { startMs: a, endMs: b };
    }
    return { svg, update };
  }
  window.WhDial = { create };
})();
