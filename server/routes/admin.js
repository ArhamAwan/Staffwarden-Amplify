'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { need, str, int } = require('../lib/http');

module.exports = (ctx) => {
  const { db, cfg, route, emit, audit, needOwner, purgeOld, saveSetting, shotDir, T } = ctx;

  const B = (v, name) => { need(typeof v === 'boolean', 400, `${name} must be true or false`); return v; };
  const SPEC = {
    org_name: ['orgName', (v) => str(v, 'org_name', 80)],
    capture_interval_min: ['captureIntervalMin', (v) => int(v, 'capture_interval_min', 1, 60)], // no longer used; accepted so old clients don't fail
    shots_per_10: ['shotsPer10', (v) => int(v, 'shots_per_10', 0, 3)],
    // Banking and social media are always hidden now; the setting is accepted from older pages but cannot turn them off.
    blackout_categories: ['blackoutCategories', (v) => { need(v && typeof v === 'object' && !Array.isArray(v), 400, 'blackout_categories must be an object'); return { banking: true, social: true }; }],
    blackout_full_front: ['blackoutFullFront', (v) => B(v, 'blackout_full_front')],
    task_review_required: ['taskReviewRequired', (v) => B(v, 'task_review_required')],
    idle_limit_min: ['idleLimitMin', (v) => int(v, 'idle_limit_min', 1, 120)],
    retention_days: ['retentionDays', (v) => int(v, 'retention_days', 1, 3650)],
    grace_min: ['graceMin', (v) => int(v, 'grace_min', 0, 120)],
    shift_start: ['shiftStart', (v) => { need(T.validHhmm(v), 400, 'shift_start must look like 09:00'); return v; }],
    shift_end: ['shiftEnd', (v) => { need(T.validHhmm(v), 400, 'shift_end must look like 18:00'); return v; }],
    break_start: ['breakStart', (v) => { need(v === null || v === '' || T.validHhmm(v), 400, 'break_start must look like 13:00'); return v || null; }],
    break_end: ['breakEnd', (v) => { need(v === null || v === '' || T.validHhmm(v), 400, 'break_end must look like 14:00'); return v || null; }],
    tz_offset_min: ['tzOffsetMin', (v) => int(v, 'tz_offset_min', -720, 840)],
    tz_name: ['tzName', (v) => { need(v === null || v === '' || T.validZone(v), 400, 'tz_name must be a time zone like Asia/Karachi'); return v || null; }],
    work_days: ['workDays', (v) => { need(typeof v === 'string' && /^[0-6](,[0-6])*$/.test(v), 400, 'work_days must look like 1,2,3,4,5'); return v; }],
    weekly_target_min: ['weeklyTargetMin', (v) => int(v, 'weekly_target_min', 0, 6000)],
    leave_days_per_year: ['leaveDaysPerYear', (v) => int(v, 'leave_days_per_year', 0, 365)],
    paid_leave_per_month: ['paidLeavePerMonth', (v) => int(v, 'paid_leave_per_month', 0, 31)],
    no_sandwich_leave: ['noSandwichLeave', (v) => B(v, 'no_sandwich_leave')],
    no_signal_min: ['noSignalMin', (v) => int(v, 'no_signal_min', 1, 60)],
    stale_min: ['staleMin', (v) => int(v, 'stale_min', 5, 240)],
    employees_can_delete_shots: ['employeesCanDeleteShots', (v) => B(v, 'employees_can_delete_shots')],
    capture_screens: ['captureScreens', (v) => { need(v === 'active' || v === 'all', 400, 'capture_screens must be active or all'); return v; }],
    blur_shots: ['blurShots', (v) => B(v, 'blur_shots')],
    team_visibility: ['teamVisibility', (v) => { need(['everyone', 'team', 'off'].includes(v), 400, 'team_visibility must be everyone, team or off'); return v; }],
    require_latest_app: ['requireLatestApp', (v) => B(v, 'require_latest_app')],
    blackout_apps: ['blackoutApps', (v) => {
      need(Array.isArray(v) && v.length <= 20, 400, 'blackout_apps must be a list of up to 20 names');
      const out = ['WhatsApp']; // always hidden, cannot be removed
      for (const x of v) {
        need(typeof x === 'string' && x.trim().length <= 40, 400, 'Each app name must be 40 characters or fewer');
        const t = x.trim();
        if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
      }
      return out;
    }],
  };

  route('PUT', '/api/settings', ({ user, body }) => {
    needOwner(user);
    const changed = [];
    const next = {};
    for (const [k, v] of Object.entries(body)) {
      const spec = SPEC[k];
      need(spec, 400, `Unknown setting: ${k}`);
      next[spec[0]] = spec[1](v);
      changed.push(k);
    }
    need(changed.length > 0, 400, 'Nothing to change');
    const bs = 'breakStart' in next ? next.breakStart : cfg.breakStart, be = 'breakEnd' in next ? next.breakEnd : cfg.breakEnd;
    need(!bs === !be, 400, 'Give the break both a start and an end, or neither');
    const noSig = next.noSignalMin ?? cfg.noSignalMin, stale = next.staleMin ?? cfg.staleMin;
    need(stale > noSig, 400, 'The auto-close time must be longer than the no-signal time');
    // everyone whose tracking or schedule this changes is told what changed
    ctx.changes.track(ctx.changes.trackingPeople(), user, () => { for (const [k, v] of Object.entries(next)) saveSetting(k, v); });
    audit(user, 'settings.changed', null, changed.join(', '));
    emit('settings');
    return { ok: true, changed };
  });

  route('POST', '/api/admin/purge', ({ user }) => {
    needOwner(user);
    const n = purgeOld();
    audit(user, 'screenshots.purged', null, `${n} older than ${cfg.retentionDays} days`);
    return { purged: n };
  });

  route('GET', '/api/admin/storage', ({ user }) => {
    needOwner(user);
    let bytes = 0, files = 0;
    for (const f of fs.readdirSync(shotDir)) { try { bytes += fs.statSync(path.join(shotDir, f)).size; files++; } catch { /* gone */ } }
    return { files, bytes, screenshots: db.prepare('SELECT COUNT(*) n FROM screenshots WHERE deleted = 0').get().n };
  });
};
