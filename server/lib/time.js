'use strict';
// Time helpers. Day maths works in minutes from UTC. A person's zone is a place (America/New_York), and
// zoneOffset turns it into the offset that applies at a given moment, so daylight saving is followed.
const MIN = 60000;
const DAY = 86400000;

const iso = (ms) => new Date(ms).toISOString();
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const dayStartMs = (day, tz) => Date.parse(day + 'T00:00:00Z') - tz * MIN;
const dayWindow = (day, tz) => { const s = dayStartMs(day, tz); return [s, s + DAY]; };
const localDay = (ms, tz) => new Date(ms + tz * MIN).toISOString().slice(0, 10);
const localMinOfDay = (ms, tz) => { const d = new Date(ms + tz * MIN); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const dow = (day) => new Date(day + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
const mondayOf = (day) => addDays(day, -((dow(day) + 6) % 7));
const hhmm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const validHhmm = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
const eachDay = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Where a person's work day begins, in minutes after local midnight. A day shift (09:00 to 18:00) uses
// midnight. A shift past midnight (18:00 to 03:30) would otherwise be cut in two, so its work day
// starts halfway through the hours off (10:30 here): the whole shift then belongs to the day it began.
const dayStartMin = (start, end) => { const s = hhmm(start), e = hhmm(end); if (e > s) return 0; return Math.floor((e + s) / 2 / 30) * 30; };
// "Wed, Oct 28" for people to read
const human = (day) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---- time zones by place ----
const fmts = new Map();
function validZone(z) {
  if (typeof z !== 'string' || !z || z.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}
// minutes ahead of UTC in `zone` at `ms`
function zoneOffset(zone, ms) {
  let f = fmts.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); fmts.set(zone, f); }
  const p = {}; for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((asUtc - Math.floor(ms / MIN) * MIN) / MIN);
}
// the moment used for "the offset on this day": midday UTC, well clear of the night-time switch
const middayOf = (day) => Date.parse(day + 'T12:00:00Z');

module.exports = { validZone, zoneOffset, middayOf, MIN, DAY, iso, isDay, dayStartMs, dayWindow, localDay, localMinOfDay, addDays, dow, mondayOf, hhmm, validHhmm, daysBetween, eachDay, clamp, human, dayStartMin };
