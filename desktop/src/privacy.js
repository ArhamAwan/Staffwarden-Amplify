'use strict';
// Private-window blackout. Before a screenshot leaves the device, any private window (messaging apps,
// password managers, private browser windows, banking, social media, and whatever else the owner adds)
// is painted solid black. The rest of the screenshot stays as it is.
// This runs on the employee's computer, so the original pixels are never saved or uploaded.
//
// Pure logic (matching, geometry, painting, parsing) lives here and is unit-tested.
// listWindows() asks the OS for the on-screen windows and is the only platform-specific part.
const { execFile } = require('node:child_process');

// What counts as private. All five categories are always hidden and cannot be turned off; the owner
// can add any other app or site by name. A window matches when its app name or its
// title contains one of the words, or equals one of the exact names (for generic names like "Messages").
const CATEGORIES = {
  messaging: { always: true, label: 'Messaging apps',
    words: ['whatsapp', 'telegram', 'messenger', 'viber', 'wechat', 'snapchat', 'imo messenger', 'botim', 'skype'],
    exact: ['signal', 'messages', 'facetime', 'imo'] },
  passwords: { always: true, label: 'Password managers',
    words: ['1password', 'bitwarden', 'lastpass', 'dashlane', 'keepass', 'keeper', 'nordpass', 'proton pass', 'keychain access', 'enpass'],
    exact: ['passwords'] },
  private_browsing: { always: true, label: 'Private and incognito browser windows',
    words: ['incognito', 'inprivate', 'private browsing', '(private)', 'private window'], exact: [] },
  banking: { always: true, label: 'Banking and payments',
    words: ['bank', 'jazzcash', 'easypaisa', 'sadapay', 'nayapay', 'paypal', 'payoneer', 'raast', 'western union', 'remitly'], exact: [] },
  // a pop-up from WhatsApp or any other app can show a message even while the app itself is hidden, and the
  // pop-up doesn't say which app it came from, so every notification on screen is hidden
  notifications: { always: true, label: 'Notification pop-ups (they can show messages)',
    words: [], exact: ['notificationcenter', 'notification center', 'notification centre', 'usernotificationcenter', 'new notification', 'notification'] },
  social: { always: true, label: 'Social media',
    words: ['facebook', 'instagram', 'tiktok', 'twitter', 'reddit', 'pinterest', 'threads'], exact: ['x'] },
};
const ALWAYS = Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].always);
const PAD = 12;          // screen points added around every hidden window (shadows, borders, title bars)
const COVER_FULL = 0.6;  // kept for older callers; no longer used to hide whole screens

// Builds the matcher from the company settings. Returns (window) => category name, or null.
function buildMatcher({ categories = {}, extra = [] } = {}) {
  const on = Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].always || (k in categories ? !!categories[k] : k === 'banking'));
  const words = [], exact = new Set();
  for (const k of on) { for (const w of CATEGORIES[k].words) words.push([w, k]); for (const e of CATEGORIES[k].exact) exact.add(e + '\u0000' + k); }
  for (const t of Array.isArray(extra) ? extra : []) { const v = String(t).trim().toLowerCase(); if (v) words.push([v, 'custom']); }
  const exactMap = new Map([...exact].map((x) => x.split('\u0000')));
  const match = (win) => {
    // Windows Chrome does not put "Incognito" in GetWindowText; the OS scan sets priv via accessibility.
    if (win && win.priv) return 'private_browsing';
    const app = String(win.app || '').trim().toLowerCase(), title = String(win.title || '').trim().toLowerCase();
    if (exactMap.has(app)) return exactMap.get(app);
    if (exactMap.has(title)) return exactMap.get(title);
    const hay = app + '\n' + title;
    for (const [w, k] of words) if (hay.includes(w)) return k;
    return null;
  };
  match.categories = on;
  return match;
}

// Kept for older callers: WhatsApp plus extra words.
function normalizeTerms(extra) {
  const out = new Set(['whatsapp']);
  for (const t of Array.isArray(extra) ? extra : []) { const v = String(t).trim().toLowerCase(); if (v) out.add(v); }
  return [...out];
}
function isBlocked(win, termsOrMatcher) {
  if (typeof termsOrMatcher === 'function') return !!termsOrMatcher(win);
  const hay = `${win.app || ''}\n${win.title || ''}`.toLowerCase();
  return termsOrMatcher.some((t) => hay.includes(t));
}

// Rectangles (screen coordinates) to hide, padded. Over-masking is deliberate: a window in front of a private one is covered too.
function blockedRects(wins, termsOrMatcher, pad = 0) {
  return wins
    .filter((w) => w && w.w > 0 && w.h > 0 && isBlocked(w, termsOrMatcher))
    .map((w) => ({ x: w.x - pad, y: w.y - pad, w: w.w + 2 * pad, h: w.h + 2 * pad }));
}

// Rectangle a minus rectangle b: the parts of a that b does not cover (0 to 4 rectangles).
function subtract(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
  if (b.x >= ax2 || bx2 <= a.x || b.y >= ay2 || by2 <= a.y) return [a];
  const out = [];
  if (b.y > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: b.y - a.y });                         // above
  if (by2 < ay2) out.push({ x: a.x, y: by2, w: a.w, h: ay2 - by2 });                         // below
  const top = Math.max(a.y, b.y), bot = Math.min(ay2, by2);
  if (b.x > a.x) out.push({ x: a.x, y: top, w: b.x - a.x, h: bot - top });                   // left
  if (bx2 < ax2) out.push({ x: bx2, y: top, w: ax2 - bx2, h: bot - top });                   // right
  return out.filter((r) => r.w > 0 && r.h > 0);
}
// Can this window hide what is behind it? Only ordinary, solid app windows. Anything the system could be
// drawing see-through (overlays, tool windows, hidden "cloaked" windows on Windows, faded windows on a Mac)
// is never trusted to cover a private window, so a private window is never left visible by mistake.
function solid(w) {
  if (!w || !(w.w >= 40 && w.h >= 40)) return false;
  if (w.occ === false) return false;
  if (w.alpha != null && w.alpha < 0.98) return false;
  if (String(w.title) === 'Program Manager') return false;
  return w.occ === true || w.alpha != null;   // only lists that say so (older scans: nothing counts as covering)
}
// The parts of a private window that can actually be seen. The lists come front to back, so everything
// before a window is in front of it. A private window hidden behind other apps leaves only its visible
// edges (if any) to paint, instead of a black box the size of the whole window.
const INSET = 10;
function visibleParts(wins, i, pad) {
  const w = wins[i];
  const padded = (r) => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
  let parts = [{ x: w.x, y: w.y, w: w.w, h: w.h }];
  for (let k = 0; k < i && parts.length; k++) {
    const o = wins[k];
    if (!solid(o) || o.private) continue;
    // a window's outer box includes see-through resize borders (Windows) and rounded corners: trust only its inside
    parts = parts.flatMap((p) => subtract(p, { x: o.x + INSET, y: o.y + INSET, w: o.w - 2 * INSET, h: o.h - 2 * INSET }));
    if (parts.length > 400) return [padded(w)];   // too complex: hide it all
  }
  // each visible part is widened a little, to cover the window's border and shadow; a thin sliver left along
  // the edge of a window in front (its see-through border) is painted as it is, without widening
  return parts.map((p) => (p.w > 2 * INSET && p.h > 2 * INSET ? padded(p) : p));
}

// The strict decision for one capture, from one or more window scans (taken before and after the capture,
// so a window that moved or opened in between is still covered):
//   full    - only when asked for with fullWhenFront (off by default): a private window is in front
//   rects   - padded rectangles to paint black
//   matched - which categories were found (for the record)
function decide(scans, matcher, { fullWhenFront = false } = {}) {
  const rects = [], matched = new Set();
  let full = false;
  for (const wins of scans) {
    const list = wins.filter((w) => w && w.w > 0 && w.h > 0);
    // a cloaked window (Windows keeps hidden ones, like an empty notification pop-up) isn't on screen
    for (const w of list) w.private = !w.cloak && !!matcher(w);
    list.forEach((w, i) => {
      if (!w.private) return;
      matched.add(matcher(w));
      rects.push(...visibleParts(list, i, PAD));
      if (fullWhenFront && w.front) full = true;
    });
  }
  return { full, rects, matched: [...matched] };
}

// How much of a display the rectangles cover (0..1), counting overlaps once (coarse grid, good enough to decide).
function coverage(rects, bounds) {
  if (!rects.length || !bounds) return 0;
  const N = 40; let hit = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = bounds.x + ((i + 0.5) * bounds.width) / N, y = bounds.y + ((j + 0.5) * bounds.height) / N;
    if (rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) hit++;
  }
  return hit / (N * N);
}

// Screen rect -> pixel rect inside one display's image, clipped to the image. Rects that miss the display are dropped.
function toImageRects(rects, bounds, imgW, imgH) {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return [];
  const sx = imgW / bounds.width, sy = imgH / bounds.height;
  const out = [];
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.x - bounds.x) * sx));
    const y0 = Math.max(0, Math.floor((r.y - bounds.y) * sy));
    const x1 = Math.min(imgW, Math.ceil((r.x + r.w - bounds.x) * sx));
    const y1 = Math.min(imgH, Math.ceil((r.y + r.h - bounds.y) * sy));
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

// Windows lists windows in physical pixels, while screens are described in points (DIPs). Electron converts
// with screen.screenToDipRect, which takes {x, y, width, height} in whole numbers; our rects are {x, y, w, h}.
// If the conversion fails, the rect is kept as it is (slightly off on a scaled screen, but still covered).
function toDipRect(r, screenToDipRect) {
  try {
    const d = screenToDipRect(null, { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.w)), height: Math.max(1, Math.round(r.h)) });
    if (d && [d.x, d.y, d.width, d.height].every(Number.isFinite)) return { x: d.x, y: d.y, w: d.width, h: d.height };
  } catch { /* fall through */ }
  return r;
}

// Paints rectangles opaque black in a 4-bytes-per-pixel bitmap (BGRA or RGBA: black is the same in both).
function fillBlack(bitmap, width, height, rects) {
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h && y < height; y++) {
      const start = (y * width + r.x) * 4;
      const end = (y * width + Math.min(width, r.x + r.w)) * 4;
      for (let i = start; i < end; i += 4) { bitmap[i] = 0; bitmap[i + 1] = 0; bitmap[i + 2] = 0; bitmap[i + 3] = 255; }
    }
  }
  return bitmap;
}

// ---------- parsing what the OS tells us ----------
// Marks the frontmost real window (the lists come front-to-back on macOS and Windows).
const NOT_APP = new Set(['window server', 'dock', 'control center', 'controlcenter', 'notification center', 'notificationcenter', 'notification centre', 'usernotificationcenter', 'systemuiserver', 'textinputhost', 'shellexperiencehost', 'searchhost', 'startmenuexperiencehost', 'electron']);
function markFront(wins, selfNames = []) {
  const skip = new Set([...NOT_APP, ...selfNames.map((n) => n.toLowerCase())]);
  const f = wins.find((w) => w.w >= 120 && w.h >= 120 && !skip.has(String(w.app).toLowerCase()) && !(String(w.title) === 'Program Manager'));
  if (f) f.front = true;
  return wins;
}
function parseJsonWindows(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('the window list came back empty');
  let v;
  try { v = JSON.parse(s); } catch { throw new Error('the window list was unreadable'); }
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((w) => w && typeof w === 'object').map((w) => ({
    app: String(w.app || ''), title: String(w.title || ''), x: +w.x || 0, y: +w.y || 0, w: +w.w || 0, h: +w.h || 0,
    ...(typeof w.occ === 'boolean' ? { occ: w.occ } : {}), ...(w.alpha != null && Number.isFinite(+w.alpha) ? { alpha: +w.alpha } : {}),
    ...(w.priv ? { priv: true } : {}), ...(w.cloak ? { cloak: true } : {}),
  }));
}

const FRAME = 6, TITLEBAR = 40;
// `wmctrl -lGx` lines: id desktop x y w h class host title...
function parseWmctrl(text, currentDesktop) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!m) continue;
    const desktop = Number(m[2]);
    if (desktop !== -1 && currentDesktop != null && desktop !== currentDesktop) continue; // on another workspace
    const id = parseInt(m[1], 16);
    // wmctrl reports the window without its title bar and border, so widen the box to cover those too
    out.push({ id, app: m[7], title: m[9], x: +m[3] - FRAME, y: +m[4] - TITLEBAR, w: +m[5] + 2 * FRAME, h: +m[6] + TITLEBAR + FRAME });
  }
  return out;
}
// `xprop -root _NET_ACTIVE_WINDOW` -> "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4200007"
function activeWindowFrom(text) {
  const m = /#\s*(0x[0-9a-f]+)/i.exec(String(text || ''));
  return m ? parseInt(m[1], 16) : null;
}
function currentDesktopFrom(text) {
  for (const line of String(text || '').split('\n')) {
    const m = /^(\d+)\s+\*/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------- asking the OS ----------
const run = (cmd, args, timeout = 8000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) return reject(err.code === 'ENOENT' ? new Error(`${cmd} is not installed`) : err);
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

// macOS: every on-screen app window with its bounds, in points. Window titles are readable because the app already has Screen Recording access.
const MAC_SCRIPT = `
ObjC.import('CoreGraphics');
var opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
var arr = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID)));
// ordinary windows, plus notification pop-ups (drawn above everything by Notification Center)
var NC = /^(notification ?cent(er|re)|usernotificationcenter)$/i;
// (macOS 27 draws every pop-up inside one Notification Center window the size of the screen, on layer 23;
// the desktop widgets belong to Notification Center too, but sit below everything and show no messages)
JSON.stringify(arr.filter(function (w) { return w.kCGWindowBounds && (w.kCGWindowLayer === 0 || (NC.test(w.kCGWindowOwnerName || '') && w.kCGWindowLayer > 0 && (w.kCGWindowAlpha == null || w.kCGWindowAlpha > 0.02) && w.kCGWindowBounds.Width > 40)); }).map(function (w) {
  var b = w.kCGWindowBounds;
  return { app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '', x: b.X, y: b.Y, w: b.Width, h: b.Height, alpha: w.kCGWindowAlpha == null ? 0 : w.kCGWindowAlpha, layer: w.kCGWindowLayer };
}));`;

// macOS 27 and later: notification pop-ups are drawn inside one Notification Center window that covers the
// whole screen, so its bounds don't say where the pop-up is. Pop-ups always stack from the top-right corner,
// so that corner is what gets hidden (wide enough for a pop-up and its shadow, tall enough for a stack),
// not the whole screen. A Notification Center window the size of a pop-up (older macOS) is hidden as it is.
// a macOS pop-up is 344 points wide and 8 from the edge; a collapsed stack of them is about 160 tall
const NOTE_W = 372, NOTE_H = 240;
// Windows 11 (build 26100 and later) draws notification pop-ups without any window of their own: nothing in
// the window list changes when one slides in, so it cannot be found. Pop-ups always appear in the corner
// above the clock on the main screen, so that corner (room for a stack of two or three) is always hidden.
// a Windows 11 pop-up is 364 wide and 12 from the edge; one or two of them are about 230 tall
const TOAST_W = 384, TOAST_H = 260;
function windowsToastZone(workArea) {
  if (!workArea || !(workArea.width > 0) || !(workArea.height > 0)) return null;
  const w = Math.min(TOAST_W, workArea.width), h = Math.min(TOAST_H, workArea.height);
  return { x: workArea.x + workArea.width - w, y: workArea.y + workArea.height - h, w, h };
}
function notificationZones(wins) {
  return wins.map((w) => {
    if (!/^(notification ?cent(er|re)|usernotificationcenter)$/i.test(String(w.app || '')) || !(w.w > 900)) return w;
    return { ...w, x: w.x + w.w - NOTE_W, w: NOTE_W, h: Math.min(w.h, NOTE_H), zone: true };
  });
}

// Windows: visible, not minimised windows with the owning process name, in physical pixels.
// Chrome does not put "Incognito" in GetWindowText (only a toolbar chip). The accessible window
// name from UI Automation does include it, so we enrich browser windows after the enum.
const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Diagnostics;
public class WinInfo { public string app { get; set; } public string title { get; set; } public int x { get; set; } public int y { get; set; } public int w { get; set; } public int h { get; set; } public bool occ { get; set; } public bool priv { get; set; } public bool cloak { get; set; } public long hwnd { get; set; } public int pid { get; set; } }
public static class WinList {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  struct RECT { public int L, T, R, B; }
  public static List<WinInfo> All() {
    var list = new List<WinInfo>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      string app = ""; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
      int cloaked = 0; try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { cloaked = 1; }
      int ex = GetWindowLong(h, -20);
      bool tool = (ex & 0x80) != 0, clickThrough = (ex & 0x20) != 0, noActivate = (ex & 0x08000000) != 0;
      bool occ = cloaked == 0 && !tool && !clickThrough && !noActivate && sb.Length > 0;
      list.Add(new WinInfo { app = app, title = sb.ToString(), x = r.L, y = r.T, w = r.R - r.L, h = r.B - r.T, occ = occ, priv = false, cloak = cloaked != 0, hwnd = h.ToInt64(), pid = (int)pid });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[void][WinList]::SetProcessDPIAware()
$wins = [WinList]::All()
$ua = $false
try { Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes -ErrorAction Stop; $ua = $true } catch { $ua = $false }
$browsers = @('chrome','msedge','brave','chromium','firefox','opera','vivaldi','microsoftedge','arc','browser','waterfox','librewolf','floorp')
$cmds = @{}
try {
  Get-CimInstance Win32_Process -Property ProcessId,Name,CommandLine -ErrorAction SilentlyContinue | ForEach-Object {
    $n = ([string]$_.Name).ToLowerInvariant()
    if ($n -match 'chrome|msedge|brave|firefox|opera|vivaldi|chromium|waterfox|librewolf|floorp') {
      $cmds[[int]$_.ProcessId] = [string]$_.CommandLine
    }
  }
} catch { }
foreach ($w in $wins) {
  $app = ([string]$w.app).ToLowerInvariant()
  $isBrowser = $false
  foreach ($b in $browsers) { if ($app -eq $b -or $app.StartsWith($b + '.') -or $app.StartsWith($b + '-')) { $isBrowser = $true; break } }
  if (-not $isBrowser) { continue }
  if ($ua) {
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.hwnd)
      if ($null -ne $el) {
        $n = [string]$el.Current.Name
        if ($n -match '(?i)incognito|inprivate|private\\s*browsing|private\\s*window') { $w.priv = $true }
        if ($n -and $n.Length -gt 0) {
          $t = [string]$w.title
          if ($t -notmatch [regex]::Escape(($n.Substring(0, [Math]::Min(24, $n.Length))))) { $w.title = ($t + ' | ' + $n).Trim() }
        }
      }
    } catch { }
  }
  if (-not $w.priv -and $cmds.ContainsKey([int]$w.pid)) {
    $c = $cmds[[int]$w.pid]
    if ($c -match '(?i)--incognito|--inprivate|-private-window|(?:^|\\s)--private(?:\\s|$)') { $w.priv = $true }
  }
}
@($wins) | ConvertTo-Json -Compress -Depth 4`;

async function listWindows(platform = process.platform, { selfNames = ['Workhelm'] } = {}) {
  if (platform === 'darwin') {
    const r = await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT]);
    return markFront(notificationZones(parseJsonWindows(r.stdout.trim() ? r.stdout : r.stderr)), selfNames); // osascript may print a JXA result on either stream
  }
  if (platform === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT], 15000);
    return markFront(parseJsonWindows(r.stdout), selfNames);
  }
  const [list, desk, act] = await Promise.all([
    run('wmctrl', ['-lGx']), run('wmctrl', ['-d']).catch(() => ({ stdout: '' })), run('xprop', ['-root', '_NET_ACTIVE_WINDOW']).catch(() => ({ stdout: '' })),
  ]);
  const wins = parseWmctrl(list.stdout, currentDesktopFrom(desk.stdout));
  const active = activeWindowFrom(act.stdout);
  const f = active != null ? wins.find((w) => w.id === active) : null;
  if (f) f.front = true;
  return wins;
}

module.exports = {
  CATEGORIES, ALWAYS, PAD, COVER_FULL, buildMatcher, decide, coverage, normalizeTerms, isBlocked, blockedRects, toImageRects, fillBlack, toDipRect, subtract, visibleParts, solid,
  markFront, notificationZones, windowsToastZone, parseJsonWindows, parseWmctrl, activeWindowFrom, currentDesktopFrom, listWindows,
};
