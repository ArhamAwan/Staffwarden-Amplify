// The welcome tour: shown once per person per browser after their first sign-in, and any time from "Tour".
import './scenes.js';
import { esc } from './util.js';
import { S, actions, trap } from './ui.js';
import { leave } from './motion.js';

const sc = (name) => window.AmpScenes[name]();
const key = (name = 'tour') => `amp-${name}-done-${S.me && S.me.id}`;
const seen = (name) => { try { return localStorage.getItem(key(name)) === '1'; } catch { return true; } }; // no storage: don't nag every load
const markSeen = (name) => { try { localStorage.setItem(key(name), '1'); } catch { /* fine */ } };

function steps() {
  const s = S.settings || {};
  const n = S.me.shots_per_10 ?? s.shots_per_10 ?? 2;
  const every = n === 1 ? 'once every 10 minutes' : `${n} times every 10 minutes`;
  const hidden = (s.blackout_apps && s.blackout_apps.length ? s.blackout_apps : ['WhatsApp']);
  const hiddenText = hidden.length > 1 ? `${hidden.slice(0, -1).join(', ')} and ${hidden[hidden.length - 1]}` : hidden[0];
  const days = s.retention_days || 60;
  const owner = S.me.role === 'owner', mgr = owner || S.me.role === 'manager';
  if (mgr) {
    return [
      { scene: 'live', title: `Welcome, ${S.me.name.split(' ')[0]}`, text: 'This is where you see your team. Who is working, on a break, idle or has not started, right now. The page updates by itself, so there is nothing to refresh.' },
      { scene: 'pauses', title: 'Time comes from the desktop app', text: 'Each person starts, pauses and stops their timer in the Staffwarden app on their computer.',
        points: ['Every pause is recorded with its reason: break, lunch, prayer, personal.', 'With no keyboard or mouse for a while, the timer keeps running but that time is marked idle, with no screenshots.', 'If a computer sleeps or restarts, the timer carries on when it is back, and the time it was off is not counted.', 'Stopping asks for confirmation, then shows them the day they just had.'] },
      { scene: 'blackout', title: 'Screenshots, with private windows hidden', text: `By default, ${(s.shots_per_10 ?? 2) === 0 ? 'screenshots are off' : `screenshots are taken ${(s.shots_per_10 ?? 2) === 1 ? 'once' : `${s.shots_per_10 ?? 2} times`} every 10 minutes at random moments`}, only while the timer runs. Each team or person can have their own setting, including off.`,
        points: ['Messaging apps such as WhatsApp, password managers and private browser windows are painted black on the employee\'s computer before the screenshot is saved. Only the private window is blacked out; the rest of the screen stays visible. The private content never reaches you or the server.', 'No screenshots during a pause. Employees can see and delete their own.', `Screenshots are deleted after ${days} days.`] },
      { scene: 'flow', title: 'Projects, tasks and performance in one place', text: 'Organise work in projects and assign tasks with deadlines. People start their timer on a task, and finished work comes back to you or the project manager for review.',
        points: ['Performance shows hours, activity, and task results: completion, on-time delivery and accuracy (approved without changes).', 'Which apps or websites people use is not tracked.'] },
      { scene: 'calendar', title: 'Attendance works itself out', text: 'On time, late, absent and time off are worked out from each person\'s shift and time zone. Timesheets and reports come from the same numbers, so they always agree.' },
      owner
        ? { scene: 'setup', title: 'Set up your team', text: 'Add people with their own shift, working days, weekly target and time zone. Put them in teams and give managers only the teams they lead.', points: ['People: add your team and their schedules.', 'Settings: default screenshot frequency, idle limit, and which private apps and sites to hide.'], cta: ['Add people', '#/people'] }
        : { scene: 'done', title: 'You are all set', text: 'You see the people in the teams you manage. Open any person to see their day, breaks and screenshots.' },
    ];
  }
  return [
    { scene: 'timer', title: `Welcome, ${S.me.name.split(' ')[0]}`, text: 'This site shows your own time, attendance and time off. Your timer lives in the Staffwarden app on your computer.' },
    { scene: 'pauses', title: 'You decide when you are tracked', text: 'Nothing is recorded until you press Start in the app.', points: ['Pause for a break, lunch or prayer. Paused time is not counted and no screenshots are taken.', 'If you step away, your timer keeps running but that time is marked idle, with no screenshots.', 'If your computer sleeps or restarts, the timer carries on when it is back.', 'Stop asks first, then shows you a summary of your day.'] },
    { scene: 'blackout', title: 'Your private chats stay private', text: n === 0 ? 'Screenshots are turned off for you. Only your time, breaks and activity level are tracked.' : `While the timer runs, a screenshot is taken ${every} at random moments, and you get a notification each time.`,
      points: ['WhatsApp and other messaging apps, password managers and private browser windows are painted black on your computer before the screenshot is saved, so your chats are never seen.', 'Only how active you are is measured, never what you type.', `You can see every screenshot here and delete any of them. They are removed after ${days} days.`] },
    { scene: 'flow', title: 'Your tasks', text: 'Tasks assigned to you are on My tasks, with their deadlines. Pick one in the app before you start, and send it for review when it is finished.',
      points: ['Which apps or websites you use is not tracked.'] },
    { scene: 'calendar', title: 'Attendance and time off', text: 'Your attendance fills in from your timer. Request time off here and you will see when it is approved.' },
  ];
}

// How projects and tasks work, for the people doing the work. Opens by itself the first time an
// employee comes to Projects or My tasks, and any time from "How it works" there.
function projectSteps() {
  const review = !S.settings || S.settings.task_review_required !== false;
  return [
    { scene: 'spaces', title: 'Projects you are part of', text: 'Work is organised in projects, like in Jira or ClickUp. Each project has a short key, and its tasks are numbered with it: MA-12 is task 12 of Mobile app.',
      points: ['You see the projects you are a member of, plus any that are open to everyone.', 'A manager or the project manager adds you. Being given a task in a project adds you too.', 'Open a project to see its board, what is due soon and who is working on what.'] },
    { scene: 'flow', title: 'How a task moves', text: `Every task goes from To do to In progress${review ? ', then In review' : ''}, then Done.`,
      points: ['Starting your timer on a task moves it to In progress by itself.', review ? 'When you finish, send it for review, from the desktop app or by dragging it on the board.' : 'When you finish, mark it done, from the desktop app or by dragging it on the board.', review ? 'Your manager or the project manager approves it. Only then is it Done.' : 'Tasks you create for yourself you can close whenever you like.'] },
    { scene: 'pick', title: 'Track time on the task', text: 'In the Staffwarden app, pick the task before you press Start. Your own tasks are listed first, with anything overdue marked, and the project fills itself in.',
      points: ['While the timer runs, the app shows what you are working on, with a Send for review button.', 'Your time is counted against the task and its project, so everyone can see where the hours went.'] },
    ...(review ? [{ scene: 'review', title: 'Review, and getting it right first time', text: 'When a task is approved the first time, it counts towards your accuracy. If it is sent back, you get a note saying what to change. Fix it and send it for review again.',
      points: ['Open any task to read comments, attach files and see its history.', 'Ask questions in the comments; the people on the task see them.'] }] : []),
    { scene: 'deadline', title: 'Deadlines and reminders', text: 'Tasks can have a due date. Overdue ones are marked red, and the desktop app reminds you once a day about anything overdue or due today.',
      points: ['If a deadline will not work, say so early in the task\'s comments.', 'Filter My tasks by Overdue or Due today to see what comes first.'] },
    { scene: 'numbers', title: 'Your numbers', text: 'Your dashboard shows three numbers for the last 30 days: completion (tasks due that you finished), on time (finished by their deadline) and accuracy (approved without changes).',
      points: ['Your manager sees the same numbers you do.', 'Personal to-dos you create for yourself count too, and you can close them on your own.'], cta: ['See my tasks', '#/tasks'] },
  ];
}

export function openTour({ auto = false, guide = 'tour' } = {}) {
  if (document.querySelector('.wz')) return;
  const list = guide === 'projects' ? projectSteps() : steps();
  let i = 0;
  const overlay = document.getElementById('overlay');
  const opener = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'scrim top tour';
  scrim.innerHTML = '<div class="wz wz-in" role="dialog" aria-modal="true" aria-labelledby="wz-t"></div>';
  overlay.appendChild(scrim);
  const box = scrim.querySelector('.wz');

  const render = (dir) => {
    const st = list[i], last = i === list.length - 1;
    const anim = dir ? (dir > 0 ? 'fwd' : 'back') : '';
    box.innerHTML = `
      <div class="wz-art ${anim}" aria-hidden="true">${sc(st.scene)}</div>
      <div class="wz-body ${anim}">
        <div class="wz-step">${i + 1} of ${list.length}</div>
        <h2 id="wz-t">${esc(st.title)}</h2>
        <p>${esc(st.text)}</p>
        ${st.points ? `<ul class="wz-points">${st.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="wz-foot">
        <div class="wz-dots" aria-hidden="true">${list.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'done' : ''}"></i>`).join('')}</div>
        <div class="wz-btns">
          ${i === 0 ? '<button type="button" class="btn wz-skip" data-wz="close">Skip</button>' : '<button type="button" class="btn" data-wz="back">Back</button>'}
          ${last && st.cta ? `<button type="button" class="btn" data-wz="close">Later</button><a class="btn primary" href="${st.cta[1]}" data-wz="close">${esc(st.cta[0])}</a>` : `<button type="button" class="btn primary" data-wz="${last ? 'close' : 'next'}">${last ? 'Get started' : 'Next'}</button>`}
        </div>
      </div>`;
    const primary = box.querySelector('.btn.primary');
    if (primary) primary.focus({ preventScroll: true });
  };
  const close = () => { markSeen(guide); document.removeEventListener('keydown', onKey, true); leave(scrim, () => { if (opener && opener.focus && document.contains(opener)) opener.focus(); }); };
  const go = (d) => { const n = i + d; if (n < 0 || n >= list.length) return; i = n; render(d); };
  function onKey(e) {
    if (!scrim.isConnected) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight' && !e.target.closest('input,select,textarea')) go(1);
    else if (e.key === 'ArrowLeft' && !e.target.closest('input,select,textarea')) go(-1);
    else trap(box, e);
  }
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wz]');
    if (!b) return;
    const a = b.dataset.wz;
    if (a === 'next') go(1); else if (a === 'back') go(-1); else close();
  });
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey, true);
  render(0);
  if (auto) markSeen(guide); // shown once even if the tab is closed half-way
}

export function maybeTour() { if (S.me && !seen()) setTimeout(() => openTour({ auto: true }), 500); }
// The projects guide: once, the first time an employee opens Projects, a project or My tasks (after the welcome tour).
export function maybeProjectGuide(route) {
  if (!S.me || S.me.role !== 'employee' || !['projects', 'project', 'tasks'].includes(route)) return;
  if (!seen() || seen('projects')) return;
  // not on top of something already open (a task opened from a notification, a dialog)
  setTimeout(() => { if (!document.querySelector('.wz') && !document.getElementById('overlay').children.length && !/[?&]task=/.test(location.hash)) openTour({ auto: true, guide: 'projects' }); }, 600);
}
actions.tour = () => openTour();
actions['guide-projects'] = () => openTour({ guide: 'projects' });
