'use strict';
// The boost clip: when the owner boosts with his clip, he powers up in a corner of the screen for a few
// seconds with his message above him. These are the parts that decide when and where; main.js makes the
// window. It only ever shows while this person's timer is on, and never covers more than the corner.

const WIN_W = 720, WIN_H = 480;

// a notification that is a boost clip, and which boost it is
function boostIdOf(n) {
  if (!n || n.kind !== 'boost_clip') return null;
  const m = /[?&]boost=(\d+)/.exec(n.link || '');
  return m ? Number(m[1]) : null;
}

// the window sits on the bottom edge of the screen's usable area (above the Dock or taskbar), in the
// corner the person picked
function placeBoost(area, corner, w = WIN_W, h = WIN_H) {
  const ww = Math.min(w, area.width), hh = Math.min(h, area.height);
  const x = corner === 'left' ? area.x : area.x + area.width - ww;
  return { x: Math.round(x), y: Math.round(area.y + area.height - hh), width: Math.round(ww), height: Math.round(hh) };
}

// pop up only for a running (or paused) timer, and only what the server said pops up for this person
function shouldPopUp(mode, boost) {
  return !!boost && boost.popup === true && mode !== 'stopped';
}

// one at a time: a second boost waits for the first to leave
class BoostQueue {
  constructor(open) { this.open = open; this.items = []; this.busy = false; this.seen = new Set(); }
  push(b) {
    if (!b || this.seen.has(b.id)) return false;
    this.seen.add(b.id);
    if (this.busy) { this.items.push(b); return true; }
    this.busy = true; this.open(b); return true;
  }
  done() {
    const next = this.items.shift();
    if (next) { this.open(next); return next; }
    this.busy = false; return null;
  }
}

module.exports = { boostIdOf, placeBoost, shouldPopUp, BoostQueue, WIN_W, WIN_H };
