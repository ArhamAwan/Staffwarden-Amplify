'use strict';
// Screenshot scheduling: time is cut into 10-minute blocks (as in Hubstaff). Inside each block we pick
// 1 to 3 random moments, so captures can't be predicted or dodged. Activity is counted per block too.
const DEFAULT_SLOT_MS = 10 * 60 * 1000;

const slotStart = (ms, slotMs = DEFAULT_SLOT_MS) => Math.floor(ms / slotMs) * slotMs;

// Default is exactly one capture per slot. min/max allow "1-3 per slot" for longer slots.
function pickShotTimes(slotStartMs, rng = Math.random, { slotMs = DEFAULT_SLOT_MS, min = 1, max = 1 } = {}) {
  const count = min + Math.floor(rng() * (max - min + 1));
  // keep clear of both slot edges so a capture always belongs to its own slot
  const margin = Math.min(5000, Math.floor(slotMs / 10));
  const times = [];
  for (let i = 0; i < count; i++) {
    times.push(slotStartMs + margin + Math.floor(rng() * (slotMs - 2 * margin)));
  }
  return times.sort((a, b) => a - b);
}

module.exports = { DEFAULT_SLOT_MS, slotStart, pickShotTimes };
