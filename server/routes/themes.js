'use strict';
const { need } = require('../lib/http');

// Colour themes. Each person picks their own (Profile › Appearance); the owner picks the one people start
// with. Only the web app's colours change: payslips, PDFs and the client portal keep the company's look.
const THEMES = ['night', 'gold', 'sapphire', 'bordeaux', 'graphite', 'company'];

module.exports = (ctx) => {
  const { db, cfg, route, audit, emit, needOwner, saveSetting } = ctx;
  const staffOnly = (u) => need(u.kind !== 'client', 403, 'Not available');
  ctx.themeDefault = () => (THEMES.includes(cfg.themeDefault) ? cfg.themeDefault : 'night');
  ctx.themeOf = (u) => (THEMES.includes(u.theme) ? u.theme : ctx.themeDefault());

  // mine: a theme, or null to follow the company's default
  route('PUT', '/api/me/theme', ({ user, body }) => {
    staffOnly(user);
    const t = body.theme == null || body.theme === '' ? null : String(body.theme);
    need(t === null || THEMES.includes(t), 400, 'Pick one of the themes');
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(t, user.id);
    emit('me', user.id);
    return { theme: t || ctx.themeDefault(), theme_own: t, theme_default: ctx.themeDefault() };
  });

  // everyone's starting theme (the owner)
  route('PUT', '/api/theme-default', ({ user, body }) => {
    needOwner(user);
    const t = String(body.theme || '');
    need(THEMES.includes(t), 400, 'Pick one of the themes');
    saveSetting('themeDefault', t);
    cfg.themeDefault = t;
    audit(user, 'settings.changed', null, `theme default: ${t}`);
    emit('settings');
    return { theme_default: t };
  });
};
