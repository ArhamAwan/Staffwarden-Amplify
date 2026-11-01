'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/privacy');

test('WhatsApp is always on the list, extras are added, case is ignored, blanks dropped', () => {
  assert.deepEqual(P.normalizeTerms([]), ['whatsapp']);
  assert.deepEqual(P.normalizeTerms(undefined), ['whatsapp']);
  assert.deepEqual(P.normalizeTerms(['Telegram', ' SIGNAL ', 'whatsapp', '']), ['whatsapp', 'telegram', 'signal']);
});

test('matches the app name or the window title, so WhatsApp Web in any browser is covered', () => {
  const t = P.normalizeTerms([]);
  assert.ok(P.isBlocked({ app: 'WhatsApp', title: '' }, t));
  assert.ok(P.isBlocked({ app: 'WhatsApp.Root', title: 'WhatsApp' }, t));
  assert.ok(P.isBlocked({ app: 'Google Chrome', title: '(3) WhatsApp Web - Google Chrome' }, t));
  assert.ok(P.isBlocked({ app: 'firefox', title: 'whatsapp' }, t));
  assert.ok(!P.isBlocked({ app: 'Code', title: 'server.js - Visual Studio Code' }, t));
  assert.ok(P.isBlocked({ app: 'Telegram', title: 'x' }, P.normalizeTerms(['telegram'])));
});

test('only matching windows with a real size become rectangles', () => {
  const rects = P.blockedRects([
    { app: 'Slack', title: 'general', x: 0, y: 0, w: 500, h: 500 },
    { app: 'WhatsApp', title: 'Ali', x: 100, y: 50, w: 400, h: 300 },
    { app: 'WhatsApp', title: 'zero', x: 0, y: 0, w: 0, h: 0 },
  ], ['whatsapp']);
  assert.deepEqual(rects, [{ x: 100, y: 50, w: 400, h: 300 }]);
});

test('screen coordinates map onto the captured image, scaled and clipped, per display', () => {
  // 1440x900 point screen captured as a 720x450 image (half scale)
  const b = { x: 0, y: 0, width: 1440, height: 900 };
  assert.deepEqual(P.toImageRects([{ x: 100, y: 50, w: 400, h: 300 }], b, 720, 450), [{ x: 50, y: 25, w: 200, h: 150 }]);
  // partly off the left/top edge is clipped, never negative
  assert.deepEqual(P.toImageRects([{ x: -100, y: -50, w: 300, h: 200 }], b, 1440, 900), [{ x: 0, y: 0, w: 200, h: 150 }]);
  // second monitor to the right: global coordinates are translated; a window on display 1 does not appear on display 2
  const right = { x: 1440, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(P.toImageRects([{ x: 1540, y: 100, w: 200, h: 100 }], right, 960, 540), [{ x: 50, y: 50, w: 100, h: 50 }]);
  assert.deepEqual(P.toImageRects([{ x: 100, y: 50, w: 400, h: 300 }], right, 960, 540), []);
  assert.deepEqual(P.toImageRects([{ x: 0, y: 0, w: 10, h: 10 }], null, 10, 10), []);
});

test('painting makes the area opaque black and leaves every other pixel untouched', () => {
  const W = 8, H = 6;
  const bmp = Buffer.alloc(W * H * 4, 200);
  P.fillBlack(bmp, W, H, [{ x: 2, y: 1, w: 3, h: 2 }]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, inside = x >= 2 && x < 5 && y >= 1 && y < 3;
    assert.deepEqual([...bmp.subarray(i, i + 4)], inside ? [0, 0, 0, 255] : [200, 200, 200, 200], `pixel ${x},${y}`);
  }
  // a rectangle hanging off the edge cannot write outside the image
  P.fillBlack(bmp, W, H, [{ x: 6, y: 5, w: 10, h: 10 }]);
  assert.equal(bmp.length, W * H * 4);
});

test('parses what each system reports', () => {
  const mac = JSON.stringify([{ app: 'WhatsApp', title: 'Chats', x: 10, y: 20, w: 300, h: 400 }]);
  assert.deepEqual(P.parseJsonWindows(mac), [{ app: 'WhatsApp', title: 'Chats', x: 10, y: 20, w: 300, h: 400 }]);
  // PowerShell prints a bare object when there is only one window
  assert.equal(P.parseJsonWindows('{"app":"chrome","title":"WhatsApp Web","x":0,"y":0,"w":10,"h":10}').length, 1);
  // Windows scan can mark Incognito via priv when the Win32 title has no "Incognito"
  const winPriv = P.parseJsonWindows('{"app":"chrome","title":"Security Code","x":0,"y":0,"w":100,"h":100,"priv":true,"occ":true}');
  assert.equal(winPriv[0].priv, true);
  assert.equal(winPriv[0].occ, true);
  assert.throws(() => P.parseJsonWindows(''), /empty/);
  assert.throws(() => P.parseJsonWindows('not json'), /unreadable/);

  const wm = [
    '0x04200007  0 100  200  800  600  Navigator.firefox  host (3) WhatsApp Web - Mozilla Firefox',
    '0x04400003  1 0    0    500  500  whatsapp.WhatsApp  host WhatsApp',
    '0x04600001 -1 0    0    1920 30   panel.Panel  host Top panel',
  ].join('\n');
  const cur = P.currentDesktopFrom('0  * DG: 1920x1080  VP: 0,0  WA: 0,0 1920x1050  Workspace 1\n1  - DG: 1920x1080  VP: N/A  WA: 0,0 1920x1050  Workspace 2');
  assert.equal(cur, 0);
  const wins = P.parseWmctrl(wm, cur);
  assert.deepEqual(wins.map((w) => w.title), ['(3) WhatsApp Web - Mozilla Firefox', 'Top panel'], 'windows on another workspace are ignored, sticky ones kept');
  assert.equal(P.blockedRects(wins, ['whatsapp']).length, 1);
  const f = wins[0]; assert.ok(f.x < 100 && f.y < 200 && f.w > 800 && f.h > 600, 'box also covers the title bar and border');
});

test('strict rules: messaging, password managers, private windows, banking and social media are always hidden', () => {
  const m = P.buildMatcher({});
  const cases = [
    [{ app: 'WhatsApp', title: '' }, 'messaging'], [{ app: 'Google Chrome', title: 'WhatsApp Web' }, 'messaging'],
    [{ app: 'Telegram', title: 'Telegram' }, 'messaging'], [{ app: 'Signal', title: 'Signal' }, 'messaging'],
    [{ app: 'Messages', title: 'Messages' }, 'messaging'], [{ app: 'Firefox', title: 'Messenger | Facebook' }, 'messaging'],
    [{ app: '1Password 8', title: '1Password' }, 'passwords'], [{ app: 'Bitwarden', title: 'Vault' }, 'passwords'], [{ app: 'Passwords', title: '' }, 'passwords'],
    [{ app: 'Google Chrome', title: 'New Tab - Google Chrome (Incognito)' }, 'private_browsing'], [{ app: 'msedge', title: 'Bing [InPrivate] - Microsoft Edge' }, 'private_browsing'],
    [{ app: 'Firefox', title: 'Mozilla Firefox Private Browsing' }, 'private_browsing'],
    // Windows Chrome: Win32 title has no "Incognito"; the OS scan sets priv from UI Automation
    [{ app: 'chrome', title: 'Security Code | HighLevel', priv: true }, 'private_browsing'],
    [{ app: 'chrome', title: 'Security Code | HighLevel' }, null],
    [{ app: 'Chrome', title: 'Meezan Bank - Internet Banking' }, 'banking'], [{ app: 'Chrome', title: 'JazzCash' }, 'banking'],
    [{ app: 'Code', title: 'signal.ts - project' }, null], [{ app: 'Slack', title: 'general' }, null], [{ app: 'Chrome', title: 'Instagram' }, 'social'], [{ app: 'Chrome', title: 'Docs - Google Sheets' }, null],
  ];
  for (const [w, want] of cases) assert.equal(m(w), want, `${w.app} / ${w.title}${w.priv ? ' (priv)' : ''}`);
  const strict = P.buildMatcher({ categories: { social: false, banking: false }, extra: ['Zoom'] });
  assert.equal(strict({ app: 'Chrome', title: 'Instagram' }), 'social', 'social media cannot be switched off');
  assert.equal(strict({ app: 'Chrome', title: 'Meezan Bank' }), 'banking', 'banking cannot be switched off');
  assert.equal(strict({ app: 'zoom.us', title: 'Zoom Meeting' }), 'custom');
  assert.equal(strict({ app: 'WhatsApp', title: '' }), 'messaging', 'the always-on categories cannot be switched off');
});

test('strict decision: padded boxes, two scans combined, and a private window in front hides everything', () => {
  const m = P.buildMatcher({});
  const before = [{ app: 'Code', title: 'main.ts', x: 0, y: 0, w: 800, h: 600, front: true }, { app: 'WhatsApp', title: 'Chats', x: 900, y: 100, w: 300, h: 400 }];
  const after = [{ app: 'Code', title: 'main.ts', x: 0, y: 0, w: 800, h: 600, front: true }, { app: 'WhatsApp', title: 'Chats', x: 950, y: 100, w: 300, h: 400 }]; // moved during capture
  const d = P.decide([before, after], m);
  assert.equal(d.full, false);
  assert.equal(d.rects.length, 2, 'both positions are covered');
  assert.deepEqual(d.rects[0], { x: 900 - P.PAD, y: 100 - P.PAD, w: 300 + 2 * P.PAD, h: 400 + 2 * P.PAD });
  assert.deepEqual(d.matched, ['messaging']);
  const front = P.decide([[{ app: 'WhatsApp', title: 'Chats', x: 0, y: 0, w: 300, h: 300, front: true }]], m);
  assert.equal(front.full, false, 'WhatsApp in front: only its window is painted black, the rest stays');
  assert.equal(front.rects.length, 1);
  assert.equal(P.decide([[{ app: 'Code', title: 'main.ts', x: 0, y: 0, w: 300, h: 300, front: true }]], m).rects.length, 0);
});

test('Windows Chrome Incognito is blacked out even when the Win32 title has no Incognito word', () => {
  const m = P.buildMatcher({});
  const chromeIncognito = { app: 'chrome', title: 'Security Code | HighLevel', priv: true, x: 100, y: 50, w: 1200, h: 800, front: true, occ: true };
  const d = P.decide([[chromeIncognito]], m);
  assert.deepEqual(d.matched, ['private_browsing']);
  assert.equal(d.rects.length, 1);
  assert.deepEqual(d.rects[0], { x: 100 - P.PAD, y: 50 - P.PAD, w: 1200 + 2 * P.PAD, h: 800 + 2 * P.PAD });
  // same window without priv must not be hidden (normal Chrome tab)
  assert.equal(P.decide([[{ ...chromeIncognito, priv: false }]], m).rects.length, 0);
});

test('coverage decides when a private window fills most of a screen', () => {
  const b = { x: 0, y: 0, width: 1000, height: 1000 };
  assert.equal(P.coverage([], b), 0);
  assert.ok(Math.abs(P.coverage([{ x: 0, y: 0, w: 500, h: 1000 }], b) - 0.5) < 0.03);
  assert.ok(P.coverage([{ x: -20, y: -20, w: 1040, h: 1040 }], b) === 1);
  assert.ok(Math.abs(P.coverage([{ x: 0, y: 0, w: 500, h: 1000 }, { x: 250, y: 0, w: 500, h: 1000 }], b) - 0.75) < 0.03, 'overlaps count once');
});

test('the front window is found on each system', () => {
  const wins = P.markFront([
    { app: 'Window Server', title: '', x: 0, y: 0, w: 1440, h: 900 }, { app: 'Workhelm', title: 'Workhelm', x: 0, y: 0, w: 400, h: 740 },
    { app: 'WhatsApp', title: 'Chats', x: 10, y: 10, w: 500, h: 600 }, { app: 'Code', title: 'main.ts', x: 0, y: 0, w: 900, h: 800 },
  ], ['Workhelm']);
  assert.deepEqual(wins.filter((w) => w.front).map((w) => w.app), ['WhatsApp'], 'our own window and system layers are skipped');
  assert.equal(P.activeWindowFrom('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4400003'), 0x4400003);
  assert.equal(P.activeWindowFrom(''), null);
  const lw = P.parseWmctrl('0x04400003  0 0 0 500 500  whatsapp.WhatsApp  host WhatsApp', 0);
  assert.equal(lw[0].id, 0x4400003);
});

test('Windows: private window positions are converted to screen points without the "conversion failure" error', () => {
  const { toDipRect } = require('../src/privacy');
  // like Electron: only {x, y, width, height} in whole numbers is accepted
  const electronLike = (_w, r) => {
    if (![r.x, r.y, r.width, r.height].every(Number.isInteger)) throw new TypeError('Error processing argument at index 1, conversion failure from #<Object>');
    return { x: r.x / 1.25, y: r.y / 1.25, width: r.width / 1.25, height: r.height / 1.25 };
  };
  assert.deepEqual(toDipRect({ x: 100, y: 50, w: 500, h: 250 }, electronLike), { x: 80, y: 40, w: 400, h: 200 });
  assert.deepEqual(toDipRect({ x: 100.4, y: 50, w: 500, h: 250.6 }, electronLike), { x: 80, y: 40, w: 400, h: 200.8 });
  const broken = () => { throw new Error('nope'); };
  assert.deepEqual(toDipRect({ x: 1, y: 2, w: 3, h: 4 }, broken), { x: 1, y: 2, w: 3, h: 4 }, 'kept as is if it cannot be converted');
});

test('WhatsApp behind other apps: only the parts that can be seen are blacked out, not the whole screen', () => {
  const m = P.buildMatcher({});
  const area = (rs) => rs.reduce((n, r) => n + r.w * r.h, 0);
  // front to back: Chrome maximised covers the left two thirds; WhatsApp is maximised behind it
  const chrome = { app: 'chrome', title: 'Workhelm', x: 0, y: 0, w: 1280, h: 1080, occ: true };
  const wa = { app: 'WhatsApp', title: 'WhatsApp', x: 0, y: 0, w: 1920, h: 1080 };
  let d = P.decide([[chrome, wa]], m);
  assert.ok(d.rects.length >= 1);
  assert.ok(d.rects.every((r) => r.x >= 1280 - 10 - P.PAD || r.w <= 10 + P.PAD * 2 || r.h <= 10 + P.PAD * 2), 'nothing is painted over Chrome (beyond its edges)');
  assert.ok(area(d.rects) < 0.45 * 1944 * 1104, 'only the uncovered third (plus padding) is black');
  // fully covered by another window: nothing to paint
  d = P.decide([[{ ...chrome, x: -10, y: -10, w: 1940, h: 1100 }, wa]], m);   // maximised: its box runs past the screen edge
  assert.equal(d.rects.length, 0);
  assert.deepEqual(d.matched, ['messaging'], 'still recorded as found');
  // in front of everything: the whole window, padded
  d = P.decide([[wa, chrome]], m);
  assert.equal(area(d.rects), (1920 + 2 * P.PAD) * (1080 + 2 * P.PAD));
});

test('only solid, ordinary windows can hide a private window (never overlays, hidden or faded windows)', () => {
  const m = P.buildMatcher({});
  const wa = { app: 'WhatsApp', title: 'WhatsApp', x: 0, y: 0, w: 800, h: 600 };
  const full = (w) => P.decide([[w, wa]], m).rects;
  const big = { app: 'overlay', title: 'Overlay', x: -10, y: -10, w: 1940, h: 1100 };
  assert.equal(full({ ...big, occ: false }).length, 1, 'Windows: a cloaked, tool or click-through window does not hide it');
  assert.equal(full({ ...big }).length, 1, 'no information: not trusted');
  assert.equal(full({ ...big, alpha: 0.5 }).length, 1, 'Mac: a see-through window does not hide it');
  assert.equal(full({ ...big, alpha: 1 }).length, 0, 'Mac: a solid window does');
  assert.equal(full({ ...big, occ: true, title: 'Program Manager' }).length, 1, 'the desktop never counts');
  // two scans (before and after the capture): either one showing it visible is enough to paint it
  const d = P.decide([[{ ...big, occ: true }, wa], [wa, { ...big, occ: true }]], m);
  assert.ok(d.rects.length >= 1);
});

test('rectangle subtraction leaves the uncovered parts', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(P.subtract(a, { x: 200, y: 0, w: 10, h: 10 }), [a]);
  assert.deepEqual(P.subtract(a, { x: -5, y: -5, w: 200, h: 200 }), []);
  const parts = P.subtract(a, { x: 25, y: 25, w: 50, h: 50 });
  assert.equal(parts.reduce((n, r) => n + r.w * r.h, 0), 10000 - 2500);
});

test('WhatsApp maximised behind a maximised app leaves at most a hairline at the screen edge', () => {
  const m = P.buildMatcher({});
  const chrome = { app: 'chrome', title: 'Docs', x: -8, y: -8, w: 1936, h: 1048, occ: true };
  const wa = { app: 'WhatsApp', title: 'WhatsApp', x: -8, y: -8, w: 1936, h: 1048 };
  const d = P.decide([[chrome, wa]], m);
  assert.ok(d.rects.every((r) => r.w <= 20 || r.h <= 20), 'only thin strips: ' + JSON.stringify(d.rects));
});

test('notification pop-ups (WhatsApp messages can show in them) are always hidden; cloaked ones are not on screen', () => {
  const { buildMatcher, decide } = require('../src/privacy');
  const m = buildMatcher({});
  const mac = [{ app: 'NotificationCenter', title: '', x: 1100, y: 40, w: 360, h: 90, alpha: 1 }, { app: 'Google Chrome', title: 'Docs', x: 0, y: 0, w: 1440, h: 900, alpha: 1 }];
  const d = decide([mac], m);
  assert.ok(d.matched.includes('notifications'));
  assert.ok(d.rects.some((r) => r.x <= 1100 && r.x + r.w >= 1460));
  const win = [{ app: 'ShellExperienceHost', title: 'New notification', x: 1500, y: 800, w: 400, h: 120, occ: false }];
  assert.ok(decide([win], m).matched.includes('notifications'));
  assert.equal(decide([[{ ...win[0], cloak: true }]], m).rects.length, 0);
  assert.equal(m({ app: 'Google Chrome', title: 'Notification settings' }), null);
});
