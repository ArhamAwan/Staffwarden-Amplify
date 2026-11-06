// Formatting, escaping and tiny helpers shared by every page.
export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
function val(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(String(v));
}
// html`...` escapes every interpolation unless it is itself an html`...` result.
export const html = (strs, ...vals) => new Raw(strs.reduce((a, s, i) => a + s + (i < vals.length ? val(vals[i]) : ''), ''));

const p2 = (n) => String(n).padStart(2, '0');
export const dur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (!h && !m) return s ? '<1m' : '0m';
  return h ? `${h}h ${p2(m)}m` : `${m}m`;
};
export const hoursText = (s) => { const h = (s || 0) / 3600; return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10}h`; };
export const clock = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${p2(m)}:${p2(s % 60)}` : `${m}:${p2(s % 60)}`; };
export const pctText = (n) => (n == null ? '–' : `${n}%`);

// ---- dates. A "day" is a plain YYYY-MM-DD string; times are ISO instants shown in a person's own zone.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const parts = (day) => day.split('-').map(Number);
const utc = (day) => { const [y, m, d] = parts(day); return Date.UTC(y, m - 1, d); };
const fromUtc = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
export const addDays = (day, n) => fromUtc(utc(day) + n * 86400000);
export const dow = (day) => new Date(utc(day)).getUTCDay();
export const mondayOf = (day) => addDays(day, -((dow(day) + 6) % 7));
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
export const eachDay = (a, b) => { const o = []; for (let d = a; d <= b; d = addDays(d, 1)) o.push(d); return o; };
export const dayNum = (day) => parts(day)[2];
export const monthKey = (day) => day.slice(0, 7);
export const monthStart = (key) => `${key}-01`;
export const monthEnd = (key) => { const [y, m] = key.split('-').map(Number); return fromUtc(Date.UTC(y, m, 0)); };
export const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`; };
export const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return `${MONL[m - 1]} ${y}`; };
export const dayShort = (day) => { const [, m, d] = parts(day); return `${DOW[dow(day)]}, ${MON[m - 1]} ${d}`; };
export const dayLong = (day) => { const [, m, d] = parts(day); return `${DOWL[dow(day)]}, ${MONL[m - 1]} ${d}`; };
// "Jun 3, 2025": a date that may not be this year
export const dateY = (day) => { if (!day) return ''; const [y, m, d] = parts(day); return `${MON[m - 1]} ${d}, ${y}`; };
export const dayMD = (day) => { const [, m, d] = parts(day); return `${MON[m - 1]} ${d}`; };
export const dowShort = (day) => DOW[dow(day)];
// The browser's own clock may be wrong; every API reply carries the server's time and we follow that.
let skew = 0;
export const setSkew = (ms) => { skew = ms; };
export const nowMs = () => Date.now() + skew;
export const todayIn = (tzMin, at = nowMs()) => fromUtc(at + tzMin * 60000);
export const minOfDayIn = (tzMin, at = nowMs()) => { const t = Math.floor((at + tzMin * 60000) / 60000); return ((t % 1440) + 1440) % 1440; };
export const fmtMin = (m) => { m = Math.round(m); const h = Math.floor(m / 60) % 24; return `${h % 12 || 12}:${p2(m % 60)}\u00a0${h < 12 ? 'AM' : 'PM'}`; };
export const tod = (iso, tz) => { if (!iso) return '–'; return fmtMin(minOfDayIn(tz, Date.parse(iso))); };
export const hhmmText = (s) => { if (!s) return ''; const [h, m] = s.split(':').map(Number); return fmtMin(h * 60 + m); };
// Work days: a shift past midnight (18:00 to 03:30) is one day starting at dayStart (the middle of the
// hours off, as on the server); minutes in a day are counted from there. rel() turns a clock time in
// minutes into minutes since the day start.
export const hm = (s) => { if (!s) return null; const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
export const dayStartOf = (start, end) => { const s = hm(start), e = hm(end); if (s == null || e == null || e > s) return 0; return Math.floor((e + s) / 2 / 30) * 30; };
export const rel = (m, ds = 0) => (((m - ds) % 1440) + 1440) % 1440;
// [start, end] of a clock range (e.g. a shift or break) in day minutes; the end may pass 1440
export const relRange = (from, to, ds = 0) => { const a = hm(from), b = hm(to); if (a == null || b == null || a === b) return null; const s = rel(a, ds); return [s, s + (((b - a) % 1440) + 1440) % 1440]; };
// A time of day, with the weekday added when it falls on another calendar date than the work day
// (a night shift's 1:15 AM shows as "Tue 1:15 AM" on Monday's page).
export const todOn = (iso, tz, day) => {
  if (!iso) return '–';
  const local = new Date(Date.parse(iso) + tz * 60000);
  const t = tod(iso, tz);
  return day && local.toISOString().slice(0, 10) !== day ? `${DOW[local.getUTCDay()]} ${t}` : t;
};
// "6:00 PM to 3:30 AM next day" for a shift that crosses midnight
export const shiftText = (start, end) => {
  if (!start || !end) return '';
  const toMin = (v) => { const [h, m] = String(v).split(':').map(Number); return h * 60 + m; };
  return `${fmtMin(toMin(start))} to ${fmtMin(toMin(end))}${toMin(end) <= toMin(start) ? ' the next morning' : ''}`;
};
export const hourLabel = (h) => { h = ((h % 24) + 24) % 24; return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`; };
export const tzLabel = (min) => { if (min == null) return ''; const sign = min < 0 ? '-' : '+'; const a = Math.abs(min); const h = Math.floor(a / 60), m = a % 60; return `UTC${sign}${h}${m ? ':' + p2(m) : ''}`; };
// ---- time zones by place ----
// [zone, name people know it by, a city in it]
export const ZONES = [
  ['Asia/Karachi', 'Pakistan', 'Karachi'], ['America/New_York', 'US Eastern', 'New York'], ['America/Chicago', 'US Central', 'Chicago'],
  ['America/Denver', 'US Mountain', 'Denver'], ['America/Phoenix', 'Arizona', 'Phoenix'], ['America/Los_Angeles', 'US Pacific', 'Los Angeles'],
  ['America/Anchorage', 'Alaska', 'Anchorage'], ['Pacific/Honolulu', 'Hawaii', 'Honolulu'], ['America/Toronto', 'Canada Eastern', 'Toronto'],
  ['America/Vancouver', 'Canada Pacific', 'Vancouver'], ['America/Mexico_City', 'Mexico', 'Mexico City'], ['America/Sao_Paulo', 'Brazil', 'São Paulo'],
  ['Europe/London', 'UK and Ireland', 'London'], ['Europe/Berlin', 'Central Europe', 'Berlin'], ['Europe/Athens', 'Eastern Europe', 'Athens'],
  ['Europe/Istanbul', 'Turkey', 'Istanbul'], ['Africa/Cairo', 'Egypt', 'Cairo'], ['Africa/Lagos', 'West Africa', 'Lagos'], ['Africa/Nairobi', 'East Africa', 'Nairobi'],
  ['Asia/Riyadh', 'Saudi Arabia', 'Riyadh'], ['Asia/Dubai', 'UAE', 'Dubai'], ['Asia/Kolkata', 'India', 'Delhi'], ['Asia/Dhaka', 'Bangladesh', 'Dhaka'],
  ['Asia/Bangkok', 'Thailand', 'Bangkok'], ['Asia/Singapore', 'Singapore and Malaysia', 'Singapore'], ['Asia/Manila', 'Philippines', 'Manila'],
  ['Asia/Tokyo', 'Japan', 'Tokyo'], ['Australia/Perth', 'Western Australia', 'Perth'], ['Australia/Sydney', 'Eastern Australia', 'Sydney'],
  ['Pacific/Auckland', 'New Zealand', 'Auckland'], ['UTC', 'UTC', ''],
];
const zf = new Map();
export const validZone = (z) => { if (!z) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
// minutes ahead of UTC in `zone` at `ms` (follows daylight saving)
export function zoneOffset(zone, ms = nowMs()) {
  let f = zf.get(zone);
  if (!f) { try { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); } catch { return null; } zf.set(zone, f); }
  const p = {}; for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000);
}
export const zoneName = (z) => { const k = ZONES.find((x) => x[0] === z); return k ? (k[2] && k[1] !== k[2] ? `${k[1]} (${k[2]})` : k[1]) : String(z).split('/').pop().replace(/_/g, ' '); };
export const zoneShort = (z) => { const k = ZONES.find((x) => x[0] === z); return k ? (k[2] || k[1]) : String(z).split('/').pop().replace(/_/g, ' '); };
// "US Eastern (New York), UTC-4 now" or, with no place, just the offset
export const tzPlace = (zone, min) => (zone ? `${zoneName(zone)}, ${tzLabel(zoneOffset(zone) ?? min)}` : tzLabel(min));
// "New York time, UTC-4" for a page subtitle
export const tzShort = (zone, min) => (zone ? `${zoneShort(zone)} time, ${tzLabel(min)}` : tzLabel(min));
export const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
export const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 5) return 'just now'; if (s < 60) return `${s}s ago`; const m = Math.round(s / 60); if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h}h ago`; const d = Math.round(h / 24); return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : `${Math.round(d / 30)} mo ago`; };
export const relTime = (iso) => (iso ? ago(nowMs() - Date.parse(iso)) : 'never');
// what people call someone: "Muhammad Waseem" is Waseem, "Syed Ali Raza" is Ali
export const callName = (name) => { const w = String(name || '').trim().split(/\s+/); return w.length > 1 && /^(muhammad|mohammad|mohammed|muhammed|muhammed|syed|sayed|m\.?)$/i.test(w[0]) ? w[1] : w[0] || ''; };
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

export const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const AV = ['#6B55D6', '#12846A', '#B4540A', '#1D4ED8', '#C2410C', '#0E7490', '#9D174D', '#524A73'];
export const avColor = (id) => AV[Math.abs(Number(id) || 0) % AV.length];

export const REASON = { break: 'Break', dinner: 'Dinner', lunch: 'Lunch', prayer: 'Prayer', personal: 'Personal', other: 'Other', idle: 'Idle (no activity)' };
export const reasonLabel = (r) => REASON[r] || 'Break';
export const STOP = { manual: 'Stopped by them', idle: 'Stopped after idle time', quit: 'App was closed', lost: 'Lost contact; closed automatically' };
export const LEAVE_KIND = { vacation: 'Vacation', sick: 'Sick leave', personal: 'Personal', unpaid: 'Unpaid', other: 'Other' };
export const ATT = { present: 'Present', late: 'Late', absent: 'Absent', leave: 'On leave', holiday: 'Holiday', off: 'Day off', before: 'Before they joined', upcoming: 'Not started yet', not_started: 'Not started' };

// Staffwarden's mark: a ship's wheel. Drawn in currentColor so it can sit on any background.
// Warden Owl, the Staffwarden mark. mode: still (the logo), watch (blinks, glances, tilts), doze (eyes shut, for "Still there?"),
// live (sign-in: his eyes follow the cursor and he covers them for the password; see main.js)
export function owl(mode = 'still', label = '') {
  const a = label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"';
  const w = mode === 'watch', d = mode === 'doze', l = mode === 'live';
  const lids = d ? '' : ` class="ow-lids"${w || l ? '' : ' transform="translate(0 -19)"'}`;
  return `<svg class="helm owl${d ? ' ow-doze' : ''}" viewBox="0 0 64 64"${a}><g${w ? ' class="ow-head"' : ''}>`
    + '<path d="M13 42c0-14 8-22 19-22s19 8 19 22c0 13-8 20-19 20s-19-7-19-20z" fill="#8C78E8"/>'
    + '<path d="M24 50c2.5 2 5 3 8 3s5.5-1 8-3M26 55.5c2 1.3 4 2 6 2s4-.7 6-2" stroke="#C3B3FF" stroke-width="2.2" stroke-linecap="round" fill="none"/>'
    + '<circle cx="24.5" cy="37" r="8.5" fill="#E9E6F5"/><circle cx="39.5" cy="37" r="8.5" fill="#E9E6F5"/>'
    + `<g${w ? ' class="ow-eyes"' : l ? ' class="ow-look"' : ''}><circle cx="24.5" cy="37" r="4.2" fill="#1A1238"/><circle cx="39.5" cy="37" r="4.2" fill="#1A1238"/><circle cx="26" cy="35.5" r="1.3" fill="#fff"/><circle cx="41" cy="35.5" r="1.3" fill="#fff"/></g>`
    + `<g${lids} fill="#8C78E8"><rect x="15.5" y="28" width="18" height="18" rx="9"/><rect x="30.5" y="28" width="18" height="18" rx="9"/></g>`
    + (d ? '<path d="M18 38.5q6.5 3.5 13 0M33 38.5q6.5 3.5 13 0" stroke="#1A1238" stroke-width="1.8" stroke-linecap="round" fill="none"/>' : '')
    + (l ? '<g class="ow-shut" fill="#8C78E8"><rect x="15.5" y="28" width="18" height="18" rx="9"/><rect x="30.5" y="28" width="18" height="18" rx="9"/><path d="M18 38.5q6.5 3.5 13 0M33 38.5q6.5 3.5 13 0" stroke="#1A1238" stroke-width="1.8" stroke-linecap="round" fill="none"/></g>' : '')
    + '<path d="M29.5 43h5L32 47.5z" fill="#F7B544"/>'
    + '<path d="M13 30c0-12 8-20 19-20s19 8 19 20z" fill="#4A37A8"/><rect x="14" y="27" width="36" height="4" rx="1.5" fill="#35267F"/><path d="M13 30.5h38c-2 3-8.5 4-19 4s-17-1-19-4z" fill="#241A5C"/>'
    + '<circle cx="32" cy="18.5" r="4.4" fill="#C3B3FF"/><circle cx="32" cy="17.6" r="1.3" fill="#4A37A8"/><path d="M31.2 18.4h1.6l.5 2.8h-2.6z" fill="#4A37A8"/></g></svg>';
}
// the logo everywhere it appears (rail, sign-in, client portal, statements)
export const HELM = owl('still');

export const CREDIT = 'Built entirely in-house by Amplify Media Technologies';

export const ICON = {
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><path d="M12 17.2v.1"/>',
  dash: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.4c2.2.6 3.5 2.5 3.5 5.6"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  log: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  left: '<path d="M15 5l-7 7 7 7"/>', right: '<path d="M9 5l7 7-7 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', mega: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
  checkin: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>', chats: '<path d="M3.5 4.5h12.5v8.5H8.5l-5 3.5z"/><path d="M19 8.5h1.5v9.5l-3.5-2.5h-7.5V13"/>', clip: '<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l7.5-7.5"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/>', msg: '<path d="M4 5h16v11H9l-5 4z"/>', flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  tasks: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l2 2 4-4M7 15h10"/>', bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', out: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>',
};
ICON.wallet = '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><path d="M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5z"/><circle cx="16" cy="13.5" r="1.2"/>';
ICON.bank = '<path d="M3 10l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>';
ICON.client = '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18"/>';
ICON.file = '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>';
ICON.printer = '<path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2"/><rect x="7" y="14" width="10" height="6"/>';
ICON.download = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';
ICON.up = '<path d="M7 14l5-5 5 5"/>';
ICON.dn = '<path d="M7 10l5 5 5-5"/>';
ICON.trophy = '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5v1.5A3.5 3.5 0 0 0 8 11M17 6h2.5v1.5A3.5 3.5 0 0 1 16 11M12 14v3.5M8.5 20.5h7M9.5 17.5h5"/>';
ICON.code = '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>';
ICON.laptop = '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>';
ICON.alert = '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4.5M12 17.5v.1"/>';
ICON.sliders = '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>';
ICON.server = '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>';
ICON.db = '<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>';
ICON.shield = '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>';
ICON.upload = '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>';
ICON.rocket = '<path d="M14 4c3-1 5.5-1 6-.5S20 7 19 10l-6 6-5-5z"/><path d="M8 11l-3.5.5L3 14l4 1M13 16l-.5 3.5L10 21l-1-4"/><circle cx="15.5" cy="8.5" r="1.3"/>';
ICON.timer = '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>';
ICON.receipt = '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>';
// money in whole units: "Rs 120,000" or "$ 2,500"; signed adds − or +
export const money = (n, cur = 'PKR', { signed = false } = {}) => `${signed ? (n < 0 ? '− ' : n > 0 ? '+ ' : '') : n < 0 ? '− ' : ''}${cur === 'USD' ? '$' : 'Rs'} ${Math.abs(Math.round(n || 0)).toLocaleString('en-US')}`;
export const periodLabel = (p) => monthLabel(p);
export const icon = (name) => raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`);

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
