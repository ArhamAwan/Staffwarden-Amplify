'use strict';
// Screenshot scheduling: time is cut into 10-minute blocks (as in Hubstaff). Inside each block we pick
// 1 to 3 random moments, spread out across the block, so captures can't be predicted or dodged. Activity is counted per block too.
const DEFAULT_SLOT_MS = 10 * 60 * 1000;

const slotStart = (ms, slotMs = DEFAULT_SLOT_MS) => Math.floor(ms / slotMs) * slotMs;

// Default is exactly one capture per slot. min/max allow "1-3 per slot" for longer slots.
// The slot is cut into as many equal parts as there are captures, and each capture falls at a random moment
// in the middle 60% of its own part. So the times can't be predicted, but two captures are never seconds
// apart: with two per 10 minutes they are at least 2 minutes apart (also across the end of a slot) and at
// most 8 minutes.
const EDGE = 0.2;
function pickShotTimes(slotStartMs, rng = Math.random, { slotMs = DEFAULT_SLOT_MS, min = 1, max = 1 } = {}) {
  const count = Math.max(1, min + Math.floor(rng() * (max - min + 1)));
  const part = slotMs / count;
  const margin = Math.max(Math.min(5000, Math.floor(slotMs / 10)), Math.floor(part * EDGE));
  const times = [];
  for (let i = 0; i < count; i++) {
    const from = slotStartMs + i * part + margin, span = Math.max(1, part - 2 * margin);
    times.push(Math.floor(from + rng() * span));
  }
  return times.sort((a, b) => a - b);
}

module.exports = { DEFAULT_SLOT_MS, slotStart, pickShotTimes };
