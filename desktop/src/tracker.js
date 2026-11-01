'use strict';
const { ActivityMeter } = require('./activity');
const { DEFAULT_SLOT_MS, slotStart, pickShotTimes } = require('./schedule');
const { NetworkError } = require('./client');
const { MemoryStore } = require('./store');

const MIN = 60000, DAY = 86400000;
const GAP_MS = 15000;          // no tick for this long: the computer was asleep (or the app frozen)
const RESUME_WINDOW_MS = 90000; // relaunching within this long continues the session; later ends it

const iso = (ms) => new Date(ms).toISOString();

// The tracking engine. Everything environment-specific (clock, idle timer, screen capture,
// randomness, network, storage) is injected, so it runs identically under Electron and under tests.
//
//   stopped --start--> running <--pause/resume--> paused --stop--> stopped
//
// While paused: no screenshots, no activity counting. Every pause is written to a local day ledger
// (so the end-of-day summary works offline) and queued for the server with the moment it really happened.
//
// Idle (no keyboard or mouse for the idle limit) does NOT pause the timer: the time keeps counting, is
// marked idle, and no screenshots are taken until input returns. A sleeping or restarted computer is
// recorded as "away" (not counted) and the timer carries on by itself when the computer is back, as
// long as it is still the same day.
//
// Ledger segment types: 'w' working, 'iw' idle while running (counted), 'b' break, 'o' away (not counted),
// 'i' idle pause (older versions, not counted).
class Tracker {
  constructor({
    client, queue, capture, idleSecs, now = Date.now, rng = Math.random, idleLimitSecs = 600, slotMs = DEFAULT_SLOT_MS,
    shotsPer10 = 2, store = new MemoryStore(), tzOffsetMin = 0, uploadEveryMs = 10000, pingEveryMs = 20000, onEvent = () => {},
    // (sleptAtMs, wokeAtMs) -> true when a sleep should end the session instead of carrying on (after the shift, or a long sleep)
    endOnWake = () => false,
    otherDevice = false,
  }) {
    Object.assign(this, { client, queue, capture, idleSecs, now, rng, idleLimitSecs, slotMs, shotsPer10, store, tzOffsetMin, uploadEveryMs, pingEveryMs, onEvent, endOnWake });
    this.idleSince = null;      // set while idle with the timer still running
    // Works on another device (an iPad, say): this computer's keyboard and mouse say nothing about the work,
    // so idle is not marked and activity is not measured. Screenshots follow the person's own setting.
    this.otherDevice = !!otherDevice;
    this.blockShots = 0;        // screenshots already taken in the current block
    this.meter = new ActivityMeter({ slotMs });
    this.lastError = null;
    this.mode = 'stopped';
    this.entryId = null; this.projectId = null; this.taskId = null; this.startedAt = null;
    this.cur = null;            // the open ledger segment: {t:'w'|'b'|'i', s, reason?}
    this.sessionMs = 0;
    this.log = { segs: [], days: {} };
    this.shotSlot = null; this.shotTimes = []; this.lastShotSlot = null;
    this.lastTickAt = null; this.lastUploadAt = 0; this.lastPingAt = 0; this.lastSavedAt = 0;
    this.recovered = null;
    this.restore();
  }

  // Applies server-provided settings. Never changes the schedule in the middle of a session.
  configure({ slotMs, idleLimitSecs, tzOffsetMin, shotsPer10, otherDevice } = {}) {
    if (tzOffsetMin != null) this.tzOffsetMin = tzOffsetMin;
    if (otherDevice != null && !!otherDevice !== this.otherDevice) {
      this.otherDevice = !!otherDevice;
      if (this.otherDevice && this.idleSince != null) this.endIdle(this.now());
    }
    // Screenshot frequency may change at any time (a manager changed it); it applies from the next block.
    if (shotsPer10 != null && shotsPer10 >= 0 && shotsPer10 !== this.shotsPer10) {
      this.shotsPer10 = shotsPer10;
      if (this.mode === 'running' && shotsPer10 === 0) this.shotTimes = [];
    }
    if (this.mode !== 'stopped') return;
    if (slotMs > 0) { this.slotMs = slotMs; this.meter = new ActivityMeter({ slotMs }); }
    if (idleLimitSecs > 0) this.idleLimitSecs = idleLimitSecs;
  }

  // Keyboard and mouse activity for the dashboard; not measured for someone working on another device.
  addActivity(p) { if (p && !this.otherDevice) this.queue.add({ type: 'activity', payload: { ...p, entry_id: this.entryId } }); }

  // ---------- ledger ----------
  dayOf(ms) { return new Date(ms + this.tzOffsetMin * MIN).toISOString().slice(0, 10); }
  today() { return this.dayOf(this.now()); }
  dayStats(ms) { const d = this.dayOf(ms); return (this.log.days[d] = this.log.days[d] || { tracked: 0, active: 0, shots: 0 }); }

  closeCur(atMs) {
    if (!this.cur) return;
    const seg = { ...this.cur, e: Math.max(atMs, this.cur.s) };
    if (seg.t === 'w' || seg.t === 'iw') this.sessionMs += seg.e - seg.s;
    this.log.segs.push(seg);
    this.cur = null;
  }
  openCur(t, s, extra = {}) { this.cur = { t, s, ...extra }; }

  // What the employee sees at the end of the day: every working stretch and every break.
  summary(day = this.today()) {
    const [ws, we] = [Date.parse(day + 'T00:00:00Z') - this.tzOffsetMin * MIN, Date.parse(day + 'T00:00:00Z') - this.tzOffsetMin * MIN + DAY];
    const now = this.now();
    const all = this.cur ? [...this.log.segs, { ...this.cur, e: now }] : this.log.segs;
    let worked = 0, brk = 0, idle = 0, away = 0, sessions = 0, first = null, last = null;
    const breaks = [], segments = [];
    for (const g of all) {
      const s = Math.max(g.s, ws), e = Math.min(g.e, we);
      if (e <= s) continue;
      if (g.t !== 'o') segments.push({ t: g.t === 'iw' ? 'i' : g.t, s: iso(s), e: iso(e) });
      if (g.t === 'w') { worked += e - s; if (g.begin && g.s >= ws) sessions++; }
      else if (g.t === 'iw') { worked += e - s; idle += e - s; }
      else if (g.t === 'i') idle += e - s;
      else if (g.t === 'o') away += e - s;
      else brk += e - s;
      if (g.t !== 'w') {
        const open = !!this.cur && g === all[all.length - 1] && this.cur.s === g.s;
        const type = g.t === 'i' || g.t === 'iw' ? 'idle' : g.t === 'o' ? 'away' : 'break';
        breaks.push({ started_at: iso(s), ended_at: open ? null : iso(e), secs: Math.round((e - s) / 1000), reason: g.t === 'iw' ? 'idle' : g.reason || 'break', type, counted: g.t === 'iw', open, auto: !!g.auto });
      }
      first = first == null ? s : Math.min(first, s);
      last = Math.max(last ?? 0, e);
    }
    const st = this.log.days[day] || { tracked: 0, active: 0, shots: 0 };
    return {
      day, worked_secs: Math.round(worked / 1000), break_secs: Math.round(brk / 1000), idle_secs: Math.round(idle / 1000), away_secs: Math.round(away / 1000),
      break_count: breaks.filter((b) => b.type === 'break').length, idle_count: breaks.filter((b) => b.type === 'idle').length,
      sessions, first_start: first == null ? null : iso(first), last_end: this.mode === 'stopped' && last != null ? iso(last) : null,
      activity_pct: st.tracked ? Math.round((100 * st.active) / st.tracked) : null, shots: st.shots, breaks, segments, tz_offset_min: this.tzOffsetMin,
    };
  }

  // ---------- persistence ----------
  persist(force = false) {
    const t = this.now();
    if (!force && t - this.lastSavedAt < 5000) return;
    this.lastSavedAt = t;
    const keepFrom = Date.parse(this.today() + 'T00:00:00Z') - this.tzOffsetMin * MIN - 2 * DAY;
    this.log.segs = this.log.segs.filter((g) => g.e >= keepFrom);
    for (const d of Object.keys(this.log.days)) if (Date.parse(d + 'T00:00:00Z') < keepFrom - DAY) delete this.log.days[d];
    this.store.save({
      mode: this.mode, entryId: this.entryId, projectId: this.projectId, taskId: this.taskId, startedAt: this.startedAt,
      cur: this.cur, sessionMs: this.sessionMs, log: this.log, lastShotSlot: this.lastShotSlot, blockShots: this.blockShots, idleSince: this.idleSince, alive: t,
    });
  }

  restore() {
    const s = this.store.load();
    if (!s) return;
    this.log = s.log || { segs: [], days: {} };
    this.lastShotSlot = s.lastShotSlot ?? null;
    this.blockShots = s.blockShots || 0;
    if (!s.mode || s.mode === 'stopped') return;
    const t = this.now();
    const alive = s.alive || t;
    // A quick relaunch carries on. After a longer gap (a shutdown or restart) it carries on only when it
    // is still the same work day AND the computer went off during the shift and not for hours; a computer
    // shut down at the end of the shift does not pick the timer up again the next morning.
    let resume = t - alive <= RESUME_WINDOW_MS;
    if (!resume && this.dayOf(alive) === this.dayOf(t)) { let end = false; try { end = !!this.endOnWake(alive, t); } catch { end = false; } resume = !end; }
    if (resume) {
      // A quick relaunch, or a restart / shutdown earlier today: carry on from where it was.
      Object.assign(this, { mode: s.mode, entryId: s.entryId, projectId: s.projectId, taskId: s.taskId, startedAt: s.startedAt, cur: s.cur, sessionMs: s.sessionMs || 0 });
      this.idleSince = null;
      if (this.cur && this.cur.t === 'iw') this.cur = { ...this.cur, t: 'w' };   // idle ends with the restart
      this.meter.begin(t); this.meter.hold();
      if (t - alive > RESUME_WINDOW_MS && this.mode === 'running') {
        // The computer was off or restarting: that stretch is "away", not work. Then the timer runs again.
        this.closeCur(alive);
        this.log.segs.push({ t: 'o', s: alive, e: t, reason: 'away', auto: true });
        this.openCur('w', t);
        this.queue.add({ type: 'pause', reason: 'away', at: iso(alive) });
        this.queue.add({ type: 'resume', at: iso(t) });
        this.recovered = { continued: true, endedAtMs: alive, resumedAtMs: t };
      }
      if (this.mode === 'running') this.plan(t);
      this.lastTickAt = t;
      this.persist(true);
    } else {                                                 // closed yesterday or earlier: end at the last sign of life
      const at = s.alive || t;
      if (s.cur) this.log.segs.push({ ...s.cur, e: Math.max(at, s.cur.s) });
      this.queue.add({ type: 'stop', ended_at: iso(at), reason: 'quit' });
      this.recovered = { endedAtMs: at };
      this.persist(true);
    }
  }
  ackRecovered() { this.recovered = null; }

  // ---------- state changes ----------
  async start(projectId = null, taskId = null) {
    if (this.mode !== 'stopped') return;
    const r = await this.client.startTimer(projectId, taskId); // needs a connection: the server issues the entry id
    const t = this.now();
    Object.assign(this, { entryId: r.entry_id, projectId, taskId, startedAt: t, mode: 'running', sessionMs: 0 });
    this.openCur('w', t, { begin: true });
    this.meter.begin(t);
    this.plan(t);
    this.lastTickAt = t; this.lastUploadAt = t; this.lastPingAt = t;
    this.persist(true);
    this.onEvent({ type: 'started' });
  }

  // Pick this slot's random capture moment; ones already in the past are skipped, and a slot that
  // already has its screenshot (before a pause) doesn't get a second one.
  plan(t) {
    const block = slotStart(t, this.slotMs);
    if (block !== this.shotSlot) { if (this.lastShotSlot !== block) this.blockShots = 0; }
    this.shotSlot = block;
    const left = Math.max(0, this.shotsPer10 - (this.lastShotSlot === block ? this.blockShots : 0));
    this.shotTimes = left ? pickShotTimes(block, this.rng, { slotMs: this.slotMs, min: this.shotsPer10, max: this.shotsPer10 }).filter((x) => x > t).slice(0, left) : [];
  }

  // No keyboard or mouse for the idle limit: the timer keeps running, the stretch is marked idle (from
  // when input actually stopped) and anything captured since then is dropped.
  startIdle(atMs) {
    const at = Math.max(atMs, this.cur ? this.cur.s : atMs);
    const dropped = this.queue.purgeShotsSince(iso(at));
    if (dropped) { const st = this.dayStats(at); st.shots = Math.max(0, st.shots - dropped); }
    this.closeCur(at);
    this.openCur('iw', at, { reason: 'idle', auto: true });
    this.idleSince = at;
    this.shotTimes = this.shotTimes.filter((x) => x < at);
    this.queue.add({ type: 'idle', state: 'start', at: iso(at) });
    this.persist(true);
    this.onEvent({ type: 'idle-start', atMs: at, idleSecs: Math.round((this.now() - at) / 1000) });
    this.kick();
  }
  endIdle(atMs) {
    if (this.idleSince == null) return;
    const at = Math.max(atMs, this.idleSince);
    const secs = Math.round((at - this.idleSince) / 1000);
    this.closeCur(at);
    this.openCur('w', at);
    this.idleSince = null;
    this.plan(this.now());
    this.queue.add({ type: 'idle', state: 'end', at: iso(at) });
    this.persist(true);
    this.onEvent({ type: 'idle-end', idleSecs: secs });
    this.kick();
  }

  async pause({ reason = 'break', atMs, auto = false, discardSecs = 0 } = {}) {
    if (this.mode !== 'running') return false;
    const t = this.now();
    const at = Math.min(t, Math.max(atMs ?? t, this.cur.s));
    if (at < t - 2000) {                                     // time is being taken back: nothing may remain from it
      const dropped = this.queue.purgeShotsSince(iso(at));
      if (dropped) { const st = this.dayStats(at); st.shots = Math.max(0, st.shots - dropped); }
    }
    this.closeCur(at);
    this.idleSince = null;
    this.openCur(reason === 'idle' ? 'i' : reason === 'away' ? 'o' : 'b', at, { reason, auto });
    if (discardSecs > 0) { this.meter.discard(discardSecs); const st = this.dayStats(t); st.tracked = Math.max(st.active, st.tracked - Math.round(discardSecs)); }
    const snap = this.meter.snapshot();
    if (snap) this.addActivity(snap);
    this.meter.hold();
    this.shotTimes = [];
    this.queue.add({ type: 'pause', reason, at: iso(at) });
    this.mode = 'paused';
    this.persist(true);
    this.onEvent({ type: 'paused', reason, auto, atMs: at });
    this.kick();
    return true;
  }

  async resume() {
    if (this.mode !== 'paused') return false;
    const t = this.now();
    this.closeCur(t);
    this.openCur('w', t);
    this.mode = 'running';
    this.meter.hold();
    this.plan(t);
    this.lastTickAt = t;
    this.queue.add({ type: 'resume', at: iso(t) });
    this.persist(true);
    this.onEvent({ type: 'resumed' });
    this.kick();
    return true;
  }

  async stop({ atMs, reason = 'manual' } = {}) {
    if (this.mode === 'stopped') return null;
    const t = this.now();
    const at = Math.min(t, Math.max(atMs ?? t, this.cur ? this.cur.s : 0));
    this.closeCur(at);
    this.idleSince = null;
    const last = this.meter.flush();
    if (last) this.addActivity(last);
    this.queue.add({ type: 'stop', ended_at: iso(at), reason });
    this.mode = 'stopped'; this.entryId = null; this.shotTimes = [];
    this.persist(true);
    const summary = this.summary(this.dayOf(at));
    this.onEvent({ type: 'stopped', summary, reason });
    await this.sync();
    return summary;
  }

  // ---------- the clock ----------
  // Called once a second while the app is open.
  async tick() {
    if (this.mode === 'stopped') return;
    const t = this.now();
    const prev = this.lastTickAt;
    this.lastTickAt = t;

    if (prev != null && t - prev > GAP_MS) {
      // The computer slept (or the app froze). That stretch is "away" and not counted; then the timer
      // simply carries on. On a break, the break just continues.
      let why = null;
      if (this.dayOf(prev) !== this.dayOf(t)) why = 'next-day';
      else { try { why = this.endOnWake(prev, t) || null; } catch { why = null; } }
      if (why) {
        // Slept into another work day, went to sleep after the shift, or slept for hours: the work was
        // over when the computer went to sleep, so the session ends then (not at every brief wake-up).
        await this.stop({ atMs: prev, reason: 'quit' });
        this.onEvent({ type: 'away-stopped', atMs: prev, why: why === true ? 'off-shift' : why });
        return;
      }
      if (this.mode === 'running') {
        await this.pause({ reason: 'away', atMs: prev, auto: true });
        await this.resume();
        this.onEvent({ type: 'away-resumed', gapSecs: Math.round((t - prev) / 1000), fromMs: prev });
      }
      return;
    }

    if (this.mode === 'running') {
      const idle = this.idleSecs();
      const dt = prev == null ? 0 : Math.min(5, Math.max(0, Math.round((t - prev) / 1000)));
      const finished = this.meter.tick(t, idle);
      if (dt > 0 && !this.otherDevice) { const st = this.dayStats(t); st.tracked += dt; if (idle < 2) st.active += dt; }
      if (finished) this.addActivity(finished);
      if (slotStart(t, this.slotMs) !== this.shotSlot) this.plan(t);

      if (this.otherDevice) { /* nobody types on this computer: never idle */ }
      else if (this.idleSince == null && idle >= this.idleLimitSecs) this.startIdle(t - idle * 1000);
      else if (this.idleSince != null && idle < 2) this.endIdle(t - idle * 1000);

      const due = this.shotTimes.filter((x) => x <= t);
      if (due.length) {
        this.shotTimes = this.shotTimes.filter((x) => x > t);
        // no screenshots while idle, and none in the last seconds before idle is noticed
        if (this.otherDevice || (this.idleSince == null && idle < this.idleLimitSecs)) for (let i = 0; i < due.length; i++) await this.shoot(t);
      }

      if (t - this.lastUploadAt >= this.uploadEveryMs) {      // keep the dashboard current without waiting for the slot to end
        this.lastUploadAt = t;
        const snap = this.meter.snapshot();
        if (snap) this.addActivity(snap);
        this.kick();
      }
    }

    if (t - this.lastPingAt >= this.pingEveryMs) { this.lastPingAt = t; this.heartbeat().catch(() => {}); }
    this.persist();
  }

  async shoot(t) {
    try {
      const shots = await this.capture();
      if (this.mode !== 'running' || this.idleSince != null) return; // paused, stopped or idle while the capture was in flight: discard it
      for (const s of shots) {
        this.queue.addScreenshot({ slot_start: iso(slotStart(t, this.slotMs)), taken_at: iso(t), buf: s.buf, thumb: s.thumb, privacy: s.privacy || null });
      }
      const block = slotStart(t, this.slotMs);
      this.blockShots = this.lastShotSlot === block ? this.blockShots + 1 : 1;
      this.lastShotSlot = block;
      this.dayStats(t).shots += shots.length;
      this.lastError = null;
      this.onEvent({ type: 'screenshot', count: shots.length });
      this.kick();                                            // upload right away
    } catch (e) {
      this.lastError = e.message;
      this.onEvent({ type: 'capture-error', message: e.message });
    }
  }

  // Tells the server we're alive, and notices if it closed our session (e.g. after a long outage).
  async heartbeat() {
    if (this.mode === 'stopped') return;
    let r;
    try { r = await this.client.ping(); } catch (e) { if (e instanceof NetworkError) return; throw e; }
    if (r.shots_per_10 != null) this.configure({ shotsPer10: r.shots_per_10 });
    if (r.active || this.mode === 'stopped' || this.queue.size > 0) return;
    // The server closed our session while we were cut off. Open a fresh one and carry on.
    const wasPaused = this.mode === 'paused';
    const n = await this.client.startTimer(this.projectId, this.taskId);
    this.entryId = n.entry_id;
    if (wasPaused) this.queue.add({ type: 'pause', reason: this.cur.reason || 'break', at: iso(this.now()) });
    this.onEvent({ type: 'reconnected', note: 'The server lost contact for a while and closed the earlier session. A new session was opened.' });
  }

  kick() { this.sync().catch(() => {}); }

  async sync() {
    try {
      const r = await this.queue.flush(this.client);
      this.onEvent({ type: 'synced', ...r });
      return r;
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      return { sent: 0, remaining: this.queue.size, blocked: 'offline' };
    }
  }

  status() {
    const t = this.now();
    const sum = this.summary();
    const live = this.cur && (this.cur.t === 'w' || this.cur.t === 'iw') ? t - this.cur.s : 0;
    const pauseOpen = this.mode === 'paused' && this.cur ? this.cur : null;
    return {
      mode: this.mode, running: this.mode === 'running', paused: this.mode === 'paused', active: this.mode !== 'stopped',
      sessionSecs: Math.floor((this.sessionMs + live) / 1000), startedAt: this.startedAt, projectId: this.projectId, taskId: this.taskId,
      todayWorkedSecs: sum.worked_secs, todayBreakSecs: sum.break_secs, todayIdleSecs: sum.idle_secs, todayBreakCount: sum.break_count, todayShots: sum.shots, segments: sum.segments,
      idle: this.idleSince != null, idleSinceMs: this.idleSince, shotsPer10: this.shotsPer10,
      pause: pauseOpen ? { reason: pauseOpen.reason, auto: !!pauseOpen.auto, sinceMs: pauseOpen.s, secs: Math.floor((t - pauseOpen.s) / 1000) } : null,
      // legacy name used by older UI code
      elapsedSecs: Math.floor((this.sessionMs + live) / 1000),
      activityPct: this.otherDevice ? null : this.meter.currentPct(), otherDevice: this.otherDevice, queued: this.queue.size, lastError: this.lastError, recovered: this.recovered,
    };
  }
}

module.exports = { Tracker, GAP_MS, RESUME_WINDOW_MS };
