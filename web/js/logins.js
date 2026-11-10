// Logins the owner or a manager creates for people without a work email: a username and a one-time
// password each, shown once, that the person replaces when they first sign in. Used in the new owner's
// first steps and on People. Styled with the page's own buttons (`kit`), so it fits both.
import { post } from './api.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const WARN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

// the same rule the server uses, to show the username while the name is typed
export const usernameOf = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]+/g, '.').replace(/^[._-]+|[._-]+$/g, '').replace(/\.{2,}/g, '.').slice(0, 40);

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* older browser or plain http */ }
  const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.appendChild(t); t.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove(); return ok;
}

// The rows to fill in. `teams` [{id,name}] adds a team column; `managers` lets the owner make managers.
export function loginsEditor(el, { kit, teams = [], managers = false, rows = 3, onCreated, submitLabel, cancel = false }) {
  const people = Array.from({ length: rows }, () => ({ name: '', team_id: teams.length === 1 ? teams[0].id : '', role: 'employee' }));
  const draw = () => {
    const filled = people.filter((p) => p.name.trim().length >= 2).length;
    el.innerHTML = `<div class="lg">
      <div class="lg-tw"><table class="lg-t"><thead><tr><th scope="col">Name</th><th scope="col">Username</th>${teams.length ? '<th scope="col">Team</th>' : ''}${managers ? '<th scope="col">Role</th>' : ''}<th scope="col"><span class="lg-sr">Remove</span></th></tr></thead>
      <tbody>${people.map((p, i) => `<tr>
        <td><input class="lg-in" data-i="${i}" data-k="name" value="${esc(p.name)}" maxlength="100" aria-label="Name ${i + 1}" autocomplete="off" placeholder="${i === 0 ? 'Full name' : ''}"></td>
        <td class="lg-u" data-u="${i}">${p.name.trim() ? esc(usernameOf(p.name)) : '<span class="lg-faint">from the name</span>'}</td>
        ${teams.length ? `<td><select class="lg-in" data-i="${i}" data-k="team_id" aria-label="Team ${i + 1}"><option value="">${teams.length ? 'Choose' : 'No team'}</option>${teams.map((t) => `<option value="${t.id}"${String(t.id) === String(p.team_id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>` : ''}
        ${managers ? `<td><select class="lg-in" data-i="${i}" data-k="role" aria-label="Role ${i + 1}"><option value="employee"${p.role === 'employee' ? ' selected' : ''}>Employee</option><option value="manager"${p.role === 'manager' ? ' selected' : ''}>Manager</option></select></td>` : ''}
        <td class="lg-x"><button type="button" class="lg-rm" data-rm="${i}" aria-label="Remove row ${i + 1}"${people.length === 1 ? ' disabled' : ''}>${X}</button></td></tr>`).join('')}</tbody></table></div>
      <p class="lg-hint">Paste a list of names into any name box to add them all at once.</p>
      <p class="lg-err" role="alert"></p>
      <div class="lg-row"><button type="button" class="${kit.btn}" data-add>Add a row</button><span class="lg-sp"></span>${cancel ? `<button type="button" class="${kit.btn}" data-close>Cancel</button>` : ''}<button type="button" class="${kit.btn} ${kit.pri}" data-go${filled ? '' : ' disabled'}>${filled ? `${submitLabel || 'Create'} ${filled} login${filled === 1 ? '' : 's'}` : `${submitLabel || 'Create'} logins`}</button></div>
    </div>`;
  };
  const refreshGo = () => {
    const filled = people.filter((p) => p.name.trim().length >= 2).length;
    const go = el.querySelector('[data-go]');
    go.disabled = !filled;
    go.textContent = filled ? `${submitLabel || 'Create'} ${filled} login${filled === 1 ? '' : 's'}` : `${submitLabel || 'Create'} logins`;
  };
  draw();
  el.addEventListener('input', (e) => {
    const t = e.target.closest('[data-i]'); if (!t) return;
    const i = Number(t.dataset.i);
    people[i][t.dataset.k] = t.value;
    if (t.dataset.k === 'name') { const u = el.querySelector(`[data-u="${i}"]`); u.innerHTML = t.value.trim() ? esc(usernameOf(t.value)) : '<span class="lg-faint">from the name</span>'; refreshGo(); }
  });
  el.addEventListener('change', (e) => { const t = e.target.closest('select[data-i]'); if (t) people[Number(t.dataset.i)][t.dataset.k] = t.value; });
  el.addEventListener('paste', (e) => {
    const t = e.target.closest('[data-k="name"]'); if (!t) return;
    const lines = (e.clipboardData.getData('text') || '').split(/\r?\n|\t/).map((s) => s.trim()).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    const i = Number(t.dataset.i), base = people[i];
    const extra = lines.slice(1).map((name) => ({ name, team_id: base.team_id, role: base.role }));
    people[i].name = lines[0];
    // fill the empty rows below first, then add more
    let at = i + 1;
    for (const p of extra) { while (at < people.length && people[at].name.trim()) at++; if (at < people.length) people[at] = p; else people.push(p); at++; }
    draw();
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) { people.push({ name: '', team_id: people[people.length - 1].team_id, role: 'employee' }); draw(); el.querySelector(`[data-i="${people.length - 1}"][data-k="name"]`).focus(); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm && people.length > 1) { people.splice(Number(rm.dataset.rm), 1); draw(); return; }
    const go = e.target.closest('[data-go]');
    if (!go) return;
    const list = people.filter((p) => p.name.trim());
    const err = el.querySelector('.lg-err');
    const short = list.find((p) => p.name.trim().length < 2);
    if (short) { err.textContent = 'Type each person’s full name.'; return; }
    err.textContent = ''; go.disabled = true; go.textContent = 'Creating';
    try {
      const r = await post('/api/users/logins', { people: list.map((p) => ({ name: p.name.trim(), team_id: p.team_id || null, role: p.role })) });
      onCreated(r);
    } catch (ex) { err.textContent = ex.message || 'Couldn’t create the logins'; refreshGo(); }
  });
}

// The new logins with their one-time passwords: copy, print a slip each, or download them.
export function loginsResult(el, r, { kit, company = 'your company', onDone, doneLabel = 'Done' }) {
  const address = (r.address || location.origin).replace(/^https?:\/\//, '');
  const until = r.expires_at ? new Date(r.expires_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'in 7 days';
  el.innerHTML = `<div class="lg">
    <p class="lg-warn">${WARN}<span>These passwords are shown only now. Print or download them before you leave. Lost one? Make a new one from People.</span></p>
    <div class="lg-tw"><table class="lg-t lg-res"><thead><tr><th scope="col">Name</th><th scope="col">Username</th><th scope="col">One-time password</th><th scope="col"><span class="lg-sr">Copy</span></th></tr></thead>
      <tbody>${r.people.map((p, i) => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.username)}</td><td><code class="lg-pw">${esc(p.password)}</code></td><td class="lg-x"><button type="button" class="${kit.btn} ${kit.sm || ''}" data-cp="${i}" aria-label="Copy ${esc(p.name)}’s login">Copy</button></td></tr>`).join('')}</tbody></table></div>
    <p class="lg-hint">They sign in at <b>${esc(address)}</b> with the username and password, then choose their own. Each one-time password works until ${esc(until)}.</p>
    <div class="lg-row"><button type="button" class="${kit.btn} ${kit.pri}" data-print>Print a slip for each person</button><button type="button" class="${kit.btn}" data-csv>Download as a spreadsheet</button><span class="lg-sp"></span>${onDone ? `<button type="button" class="${kit.btn}" data-done>${esc(doneLabel)}</button>` : ''}</div>
  </div>`;
  el.addEventListener('click', async (e) => {
    const cp = e.target.closest('[data-cp]');
    if (cp) { const p = r.people[Number(cp.dataset.cp)]; cp.textContent = (await copy(`${p.name}\nSign in at ${address}\nUsername: ${p.username}\nOne-time password: ${p.password}`)) ? 'Copied' : 'Copy failed'; return; }
    if (e.target.closest('[data-print]')) {
      document.querySelectorAll('.lg-print').forEach((x) => x.remove());
      const sheet = document.createElement('div');
      sheet.className = 'lg-print';
      sheet.innerHTML = r.people.map((p) => `<section class="lg-slip"><b class="lg-slip-h">Welcome to ${esc(company)} on Staffwarden</b>
        <p>Hi ${esc(p.name.split(' ')[0])}. Sign in at <b>${esc(address)}</b></p>
        <dl><dt>Username</dt><dd>${esc(p.username)}</dd><dt>One-time password</dt><dd class="lg-pw">${esc(p.password)}</dd></dl>
        <p class="lg-slip-s">You’ll choose your own password the first time you sign in. This one stops working on ${esc(until)}.</p></section>`).join('');
      document.body.appendChild(sheet);
      window.print();
      setTimeout(() => sheet.remove(), 1000);
      return;
    }
    if (e.target.closest('[data-csv]')) {
      const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
      const csv = [['Name', 'Username', 'One-time password', 'Sign in at', 'Works until'], ...r.people.map((p) => [p.name, p.username, p.password, address, until])].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `${company.replace(/[^\w-]+/g, '-').toLowerCase()}-logins.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return;
    }
    if (e.target.closest('[data-done]') && onDone) onDone();
  });
}
