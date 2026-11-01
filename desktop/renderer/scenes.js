// Small illustrated scenes for the welcome tour. Shared by the web dashboard and the desktop app:
// the same file is copied to desktop/renderer/scenes.js (keep them identical). Plain script, no imports,
// so it runs as an ES module side effect on the web and as a classic <script> in the sandboxed desktop app.
// Everything here is decorative (aria-hidden); the words next to each scene carry the meaning.
(function (g) {
  const row = (name, color, tags) => `<div class="sc-row"><i class="sc-av" style="background:${color}"></i><span class="sc-nm">${name}</span><span class="sc-tags">${tags.map((t, i) => `<b class="sc-tag ${t[0]}" style="animation-delay:${i ? -(9 - 3 * i) : 0}s">${t[1]}</b>`).join('')}</span></div>`;
  const lines = (n, w) => Array.from({ length: n }, (_, i) => `<i style="width:${w[i % w.length]}%"></i>`).join('');

  const SCENES = {
    // the timer: Start, a running clock, the day filling in
    timer: () => `<div class="sc sc-timer"><div class="sc-card">
      <span class="sc-chip"><i></i>Tracking</span>
      <div class="sc-digits"><span>02</span>:<span>14</span>:<span class="sc-sec">37</span></div>
      <div class="sc-rib"><i class="w" style="left:0;width:34%"></i><i class="b" style="left:34%;width:9%"></i><i class="w" style="left:43%;width:30%"></i><i class="w grow" style="left:73%;width:20%"></i></div>
      <div class="sc-btns"><span class="ghost">Pause</span><span class="stop">Stop</span></div></div></div>`,

    // every pause is recorded with its reason; idle is separate
    pauses: () => `<div class="sc sc-pauses">
      <div class="sc-strip"><i class="w s1"></i><i class="b s2"><em>Lunch</em></i><i class="w s3"></i><i class="i s4"><em>Idle</em></i><i class="w s5"></i></div>
      <div class="sc-list">
        <div class="s2"><b class="dot b"></b>Lunch<span>1:00 to 1:40 PM</span></div>
        <div class="s4"><b class="dot i"></b>Idle, still counted<span>3:12 to 3:25 PM</span></div>
        <div class="s5 sc-stop"><b class="dot w"></b>Stop? <span class="sc-ask">Keep working</span><span class="sc-ask red">Stop timer</span></div>
      </div></div>`,

    // a screenshot at a random moment, with a notification
    shots: () => `<div class="sc sc-shots"><div class="sc-screen">
      <div class="sc-win a"><div class="sc-bar"><i></i><i></i><i></i><span>Project plan</span></div><div class="sc-lines">${lines(6, [80, 62, 90, 45, 70, 55])}</div></div>
      <div class="sc-flash"></div>
      <div class="sc-note"><i></i>Screenshot taken</div></div></div>`,

    // private windows painted black before the screenshot leaves the computer
    blackout: () => `<div class="sc sc-black"><div class="sc-screen">
      <div class="sc-win a"><div class="sc-bar"><i></i><i></i><i></i><span>Code</span></div><div class="sc-lines">${lines(6, [70, 85, 50, 92, 60, 40])}</div></div>
      <div class="sc-win wa"><div class="sc-bar"><i></i><i></i><i></i><span>WhatsApp</span></div>
        <div class="sc-chat"><p class="in">Are you coming tonight?</p><p class="out">Yes, after work</p><p class="in">Call me</p></div>
        <div class="sc-mask"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>Hidden</span></div></div>
      <div class="sc-flash late"></div></div></div>`,

    // activity: how much, never what
    activity: () => `<div class="sc sc-act">
      <div class="sc-keys">${'QWERTYUIOP'.split('').map((_, i) => `<i style="animation-delay:${(i * 0.37) % 2.4}s"></i>`).join('')}</div>
      <div class="sc-meter"><span>Activity</span><b>82%</b><div><i></i></div></div>
      <div class="sc-cap">Keys and clicks are counted. What you type is never recorded.</div></div>`,

    // your screenshots, yours to see and delete
    yours: () => `<div class="sc sc-yours"><div class="sc-grid">${Array.from({ length: 6 }, (_, i) => `<div class="sc-thumb t${i}">${i === 4 ? '<div class="sc-bin"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></div>' : ''}</div>`).join('')}</div>
      <div class="sc-cap">Kept for a limited time, then deleted automatically.</div></div>`,

    // manager: everyone's state, live
    live: () => `<div class="sc sc-live"><div class="sc-panel">
      ${row('Ali', '#B45309', [['w', 'Working'], ['b', 'Lunch'], ['w', 'Working']])}
      ${row('Hina', '#7C3AED', [['b', 'Prayer'], ['w', 'Working'], ['w', 'Working']])}
      ${row('Omar', '#BE185D', [['o', 'Not started'], ['w', 'Working'], ['i', 'Idle']])}
      </div><div class="sc-live-pill"><i></i>Live</div></div>`,

    // attendance works itself out
    calendar: () => `<div class="sc sc-cal"><div class="sc-days">${[['Mon', 'p'], ['Tue', 'p'], ['Wed', 'l'], ['Thu', 'p'], ['Fri', 'v'], ['Sat', 'x'], ['Sun', 'x']].map(([d, s], i) => `<div class="sc-day ${s}" style="animation-delay:${0.25 + i * 0.18}s"><span>${d}</span><b></b></div>`).join('')}</div>
      <div class="sc-legend"><span><b class="p"></b>On time</span><span><b class="l"></b>Late</span><span><b class="v"></b>Time off</span></div></div>`,

    // set up: people, shifts, time zones
    setup: () => `<div class="sc sc-setup">${[['Karachi', 'UTC+5', '9:00 to 6:00', '#0F766E'], ['Dubai', 'UTC+4', '10:00 to 7:00', '#B45309'], ['London', 'UTC+0', '8:00 to 5:00', '#4F46E5']].map(([c, z, h, col], i) => `<div class="sc-person" style="animation-delay:${0.2 + i * 0.2}s"><i class="sc-av" style="background:${col}"></i><b>${c}</b><span>${z}</span><em>${h}</em></div>`).join('')}</div>`,

    // ---- projects and tasks guide ----
    // projects you are part of, each with a key that numbers its tasks
    spaces: () => `<div class="sc sc-spaces">${[['CSR', 'Client site', '#6B55D6', 40, 0], ['MA', 'Mobile app', '#B45309', 65, 1], ['IO', 'Internal ops', '#7C3AED', 20, 0]].map(([k, n, c, p, me], i) => `<div class="sc-pj${me ? ' me' : ''}" style="animation-delay:${0.1 + i * 0.15}s"><b class="sc-key" style="background:${c}">${k}</b><span class="sc-pn">${n}</span><span class="sc-pb"><i style="width:${p}%;animation-delay:${0.5 + i * 0.15}s"></i></span><span class="sc-pt">${k}-${[7, 12, 3][i]}</span>${me ? '<em class="sc-you">You are a member</em>' : ''}</div>`).join('')}</div>`,

    // a task travelling across the board
    flow: () => `<div class="sc sc-flow"><div class="sc-cols">${['To do', 'In progress', 'In review', 'Done'].map((c, i) => `<div class="sc-col c${i}"><span>${c}</span><i></i><i></i></div>`).join('')}
      <div class="sc-mover"><b>MA-12</b><span>Icon set</span><em></em></div></div></div>`,

    // the desktop app: pick your task, then Start
    pick: () => `<div class="sc sc-pick"><div class="sc-card sc-pk">
      <span class="sc-lbl">Task</span>
      <div class="sc-sel"><span>MA-12 Icon set for settings</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></div>
      <div class="sc-drop"><div class="sc-dh">My tasks</div><div class="sc-opt on">MA-12 Icon set for settings <em class="over">Overdue</em></div><div class="sc-opt">CSR-7 Write release notes <em class="today">Today</em></div><div class="sc-opt">MA-14 Design tokens</div></div>
      <div class="sc-go">Start timer</div>
      <div class="sc-on"><span class="sc-chip"><i></i>Tracking</span><span class="sc-wo">Working on <b>MA-12</b></span></div></div></div>`,

    // review: approved first time, or sent back with a note
    review: () => `<div class="sc sc-review">
      <div class="sc-rv a"><b>MA-12</b><span>Icon set for settings</span><em class="ok"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>Approved</em></div>
      <div class="sc-rv b"><b>CSR-7</b><span>Release notes</span><em class="back">Sent back</em></div>
      <div class="sc-note2"><i class="sc-av" style="background:#6B55D6"></i><span><b>Sana</b> Please add the Android changes too.</span></div></div>`,

    // deadlines, with a daily reminder
    deadline: () => `<div class="sc sc-dead"><div class="sc-dl">${[['MA-12', 'Icon set for settings', 'over', 'Overdue'], ['CSR-7', 'Write release notes', 'today', 'Due today'], ['MA-14', 'Design tokens', '', 'Fri, Nov 6']].map(([k, n, c, d], i) => `<div style="animation-delay:${0.1 + i * 0.15}s"><b>${k}</b><span>${n}</span><em class="${c}">${d}</em></div>`).join('')}</div>
      <div class="sc-remind"><b>Your tasks</b><span>1 overdue and 1 due today</span></div></div>`,

    // your numbers
    numbers: () => `<div class="sc sc-nums">${[['Completion', 84, 'Tasks due that you finished'], ['On time', 76, 'Finished by the deadline'], ['Accuracy', 91, 'Approved without changes']].map(([n, v, s], i) => `<div class="sc-num" style="animation-delay:${0.1 + i * 0.15}s"><span>${n}</span><b>${v}%</b><div><i style="width:${v}%;animation-delay:${0.45 + i * 0.15}s"></i></div><em>${s}</em></div>`).join('')}</div>`,

    // all set
    done: () => `<div class="sc sc-done"><svg viewBox="0 0 52 52" width="76" height="76"><circle cx="26" cy="26" r="23" fill="none" stroke="currentColor" stroke-width="3"/><path d="M15 27l7 7 15-16" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`,
  };
  g.AmpScenes = SCENES;
})(typeof window !== 'undefined' ? window : globalThis);
