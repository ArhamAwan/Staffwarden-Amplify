'use strict';
const { DEFAULT_SLOT_MS, slotStart } = require('./schedule');

// Counts how many seconds of each slot the user was active.
// Input is only "seconds since last keyboard/mouse input" from the OS idle timer, so
// there is no key hook and no way to learn what was typed.
class ActivityMeter {
  constructor({ activeIdleSecs = 2, maxStepSecs = 5, slotMs = DEFAULT_SLOT_MS } = {}) {
    this.slotMs = slotMs;
    this.activeIdleSecs = activeIdleSecs;
    this.maxStepSecs = maxStepSecs; // a sleep/suspend gap is not counted as tracked time
    this.reset();
  }

  reset() {
    this.slot = null;
    this.tracked = 0;
    this.active = 0;
    this.last = null;
  }

  begin(nowMs) {
    this.reset();
    this.last = nowMs;
    this.slot = slotStart(nowMs, this.slotMs);
  }

  // Stop counting (timer paused). The slot's totals are kept, so pausing and resuming inside one
  // slot adds up instead of overwriting.
  hold() { this.last = null; }

  // Returns the finished slot's totals when the clock rolls into a new slot, else null.
  tick(nowMs, idleSecs) {
    const slot = slotStart(nowMs, this.slotMs);
    let finished = null;
    if (this.slot !== null && slot !== this.slot) {
      finished = this.snapshot();
      this.tracked = 0; this.active = 0;
    }
    this.slot = slot;
    const prev = this.last;
    this.last = nowMs;
    if (prev == null) return finished;
    const dt = Math.min(this.maxStepSecs, Math.max(0, Math.round((nowMs - prev) / 1000)));
    if (dt === 0) return finished;
    this.tracked += dt;
    if (idleSecs < this.activeIdleSecs) this.active += dt;
    return finished;
  }

  // Idle time that was counted before the idle was noticed is taken back out of the current slot.
  discard(secs) {
    this.tracked = Math.max(this.active, this.tracked - Math.max(0, Math.round(secs)));
  }

  snapshot() {
    if (this.slot == null || this.tracked === 0) return null;
    return { slot_start: new Date(this.slot).toISOString(), tracked_secs: this.tracked, active_secs: this.active };
  }

  // Current slot's running activity, for the UI.
  currentPct() {
    return this.tracked ? Math.round((100 * this.active) / this.tracked) : 0;
  }

  flush() {
    const s = this.snapshot();
    this.reset();
    return s;
  }
}

module.exports = { ActivityMeter };
