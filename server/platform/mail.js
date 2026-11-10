'use strict';
// Every email the service sends, in one place: what it says (plain text and a simple, light HTML version
// that reads well in any mail app) and how it is sent. Without a mail server set up nothing leaves the
// machine: the message is logged and kept in `outbox` (tests and a local copy read it from there).
const smtp = require('../lib/smtp');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'usd') => `${cur.toLowerCase() === 'usd' ? '$' : `${cur.toUpperCase()} `}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDay = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const shortDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// one layout for every email: the owl and name, the words, one button, a small note at the bottom
function layout({ base, paras, button, after = [], foot }) {
  const p = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1D1638">${t}</p>`;
  const btn = button ? `<p style="margin:6px 0 18px"><a href="${esc(button.url)}" style="display:inline-block;background:${button.red ? '#C2410C' : '#6B55D6'};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">${esc(button.label)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#EEEAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#F7F5FF;border-radius:16px">
<tr><td style="padding:26px 28px 6px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td><img src="${esc(base)}/icons/icon-192.png" width="34" height="34" alt="" style="display:block;border-radius:9px;background:#2A2150"></td>
<td style="padding-left:10px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:22px;color:#1D1638">Staffwarden</td></tr></table></td></tr>
<tr><td style="padding:16px 28px 8px">${paras.map(p).join('')}${btn}${after.map(p).join('')}</td></tr>
${foot ? `<tr><td style="padding:14px 28px 22px;border-top:1px solid #E4E0F5;font-size:12.5px;line-height:1.5;color:#5B5480">${foot}</td></tr>` : ''}
</table></td></tr></table></body></html>`;
}
const strip = (h) => String(h).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// the emails; each returns { subject, paras, button, after, foot } with HTML-safe text already escaped
const T = {
  code: (d) => ({ subject: `Your Staffwarden code: ${d.code}`, paras: [`Hi ${esc(d.name)}, here’s the code to check your email:`, `<b style="font-size:26px;letter-spacing:6px">${esc(d.code)}</b>`, 'It works for 15 minutes. Type it on the page that asked for it.'], foot: 'Didn’t ask for this? Ignore this email; nothing happens without the code.' }),
  welcome: (d) => ({ subject: `${d.company}’s space is ready`, paras: [`Hi ${esc(d.name)}, ${esc(d.company)} is set up at <b>${esc(d.host)}</b>. Your free trial runs until ${esc(longDay(d.trialEnds))}.`, 'Teams that get going in the first two days invite everyone, set working hours, and check the time-off rules.'], button: { label: 'Invite your people', url: `${d.url}/#/people` }, foot: 'Questions? Reply to this email; a person reads it.' }),
  invite: (d) => ({ subject: `${d.inviter} invited you to ${d.company}`, paras: [`Hi ${esc(d.name)},`, `${esc(d.inviter)} added you to <b>${esc(d.company)}</b> on Staffwarden. It’s where the team tracks working hours, asks for time off and gets paid.`], button: { label: `Join ${d.company}`, url: d.link }, after: ['1. Choose a password. 2. Install the desktop app for Mac or Windows. 3. Press Start when your shift begins.', `<b>What ${esc(d.company)} can see:</b> your hours, how active the keyboard and mouse were${d.screenshots ? ', and screenshots while the timer runs' : ''}. Nothing when it’s stopped. Private windows are hidden${d.screenshots ? ' before a screenshot leaves your computer, and you see every one first' : ''}.`], foot: `This invite works for 7 days. Didn’t expect it? Ignore this email or ask ${esc(d.inviter)}. Staffwarden never asks for your password by email.` }),
  reset: (d) => ({ subject: `Set a new password for ${d.company}`, paras: [`Hi ${esc(d.name)}, someone asked to reset your password at ${esc(d.host)}. If it was you, use the button below.`], button: { label: 'Set a new password', url: d.link }, after: ['The link works for 30 minutes, once.'], foot: 'If you didn’t ask, ignore this email. Your password stays the same.' }),
  handover: (d) => ({ subject: `${d.from} wants to make you the owner of ${d.company}`, paras: [`Hi ${esc(d.name)}, ${esc(d.from)} asked to hand ${esc(d.company)}’s Staffwarden account over to you. As the owner you’d look after billing, and you’d be the only one who can close the account.`], button: { label: 'Accept and become the owner', url: d.link }, after: [`${esc(d.from)} stays on as an admin.`], foot: 'The link works for 7 days. If this isn’t right, ignore it and nothing changes.' }),
  trial_ending: (d) => ({ subject: `Your trial ends on ${longDay(d.trialEnds).split(',')[0]}`, paras: [`Hi ${esc(d.name)}, ${esc(d.company)}’s free trial ends on ${esc(longDay(d.trialEnds))}. ${d.hours ? `Your team tracked ${esc(d.hours)} hours so far. ` : ''}To keep going, add a card before then.`, `${esc(d.planName)}, ${d.seats} ${d.seats === 1 ? 'person' : 'people'}: <b>${esc(d.price)}</b>.`], button: { label: 'Add a card', url: `${d.url}/#/settings?tab=billing` }, after: ['No card by then? Tracking pauses, and nothing is deleted.'], foot: `You get this because you own ${esc(d.company)}’s account.` }),
  trial_ended: (d) => ({ subject: `Tracking is paused at ${d.company}`, paras: [`Hi ${esc(d.name)}, your trial ended. Your team can still sign in and look at everything, but the desktop app won’t start new time.`, 'Pick a plan and it starts again straight away, with everything as you left it.'], button: { label: 'Pick a plan', url: `${d.url}/#/settings?tab=billing` }, after: [`If nothing changes, we delete ${esc(d.company)}’s data on ${esc(shortDay(d.deleteAfter))}, after two more reminders.`], foot: `You get this because you own ${esc(d.company)}’s account.` }),
  receipt: (d) => ({ subject: `Receipt for ${d.company}, ${money(d.amount, d.currency)}`, paras: ['Thanks, your payment went through.', `${esc(d.description)}<br><b>${esc(money(d.amount, d.currency))}</b>${d.card ? ` paid with ${esc(d.card)}` : ''}.`], button: d.pdf ? { label: 'Download the PDF', url: d.pdf } : null, foot: 'Your card statement shows STAFFWARDEN. Paid securely through Stripe.' }),
  payment_failed: (d) => ({ subject: 'Your card was declined', paras: [`Hi ${esc(d.name)}, we couldn’t charge ${esc(d.company)}’s ${esc(money(d.amount, d.currency))}${d.card ? ` to the ${esc(d.card)}` : ''}.${d.reason ? ` ${esc(d.reason)}` : ''}`, `Update it by <b>${esc(longDay(d.graceEnds))}</b> and nothing changes for your team.`], button: { label: 'Update card', url: `${d.url}/#/settings?tab=billing`, red: true }, foot: 'Your team isn’t told about this. Only you get these emails.' }),
  grace_over: (d) => ({ subject: `Tracking is paused at ${d.company}`, paras: [`Hi ${esc(d.name)}, we still couldn’t take ${esc(d.company)}’s payment, so tracking is paused. Everything is kept, and your team can still look.`, 'Update the card and tracking starts again straight away.'], button: { label: 'Update card', url: `${d.url}/#/settings?tab=billing`, red: true }, after: [`If nothing changes, we delete ${esc(d.company)}’s data on ${esc(shortDay(d.deleteAfter))}.`], foot: `You get this because you own ${esc(d.company)}’s account.` }),
  deletion_warning: (d) => ({ subject: `${d.company}’s data will be deleted on ${shortDay(d.deleteAfter).replace(/, \d{4}$/, '')}`, paras: [`Hi ${esc(d.name)}, ${esc(d.company)} has been ${d.closed ? 'closed' : 'paused'} since ${esc(shortDay(d.since))}. In ${d.days} days we delete its hours, payslips, screenshots and files for good.`, 'Want to keep them? Download everything, or pick a plan to carry on.'], button: { label: 'Download everything', url: `${d.url}/#/settings?tab=company` }, after: [`<a href="${esc(d.url)}/#/settings?tab=billing" style="color:#6B55D6;font-weight:600">Or pick a plan</a>`], foot: d.days <= 7 ? `This is the last reminder. After ${esc(shortDay(d.deleteAfter))} we can’t get the data back.` : `You get this because you own ${esc(d.company)}’s account.` }),
  closing: (d) => ({ subject: `${d.company}’s account will close on ${shortDay(d.closesAt)}`, paras: [`Hi ${esc(d.name)}, as you asked, ${esc(d.company)}’s account closes on <b>${esc(shortDay(d.closesAt))}</b>. Your team keeps using Staffwarden until then, and there are no new charges.`, `We keep the data until ${esc(shortDay(d.deleteAfter))} in case you change your mind.`], button: { label: 'Keep the account', url: `${d.url}/#/settings?tab=billing` }, foot: `You get this because you own ${esc(d.company)}’s account.` }),
  access_request: (d) => ({ subject: `${d.company} asked for access`, paras: [`<b>${esc(d.company)}</b> wants to use Staffwarden.`, `${esc(d.name)} &lt;${esc(d.email)}&gt;, ${esc(d.size || 'size not given')}, ${esc(d.country || 'country not given')}.`, ...(d.note ? [`“${esc(d.note)}”`] : [])], button: { label: 'Review it in the console', url: d.url }, foot: 'You get this because you are listed as a console admin.' }),
  access_approved: (d) => ({ subject: `${d.company} is approved: set up your company`, paras: [`Hi ${esc(d.name)}, we’ve approved <b>${esc(d.company)}</b>. Your ${d.trialDays}-day free trial starts when you finish setup, and every feature is on while it runs.`, 'Setup takes about a minute: choose your company’s address and your password. Then you can invite your team or create their logins.'], button: { label: `Set up ${d.company}`, url: d.link }, after: d.message ? [`A note from us: “${esc(d.message)}”`] : [], foot: 'The link works once and for 7 days. If it runs out, reply and we’ll send a new one. You get this because you asked for access to Staffwarden.' }),
  access_declined: (d) => ({ subject: `About your Staffwarden request for ${d.company}`, paras: [`Hi ${esc(d.name)}, thanks for asking about Staffwarden for ${esc(d.company)}. We can’t open it for you right now.`, ...(d.message ? [esc(d.message)] : []), 'You’re welcome to ask again in 30 days, or reply to this email if something was wrong with the request.'], foot: 'You get this because you asked for access to Staffwarden.' }),
  console_code: (d) => ({ subject: `Your console code: ${d.code}`, paras: ['Here’s the code to open the Staffwarden owner console:', `<b style="font-size:26px;letter-spacing:6px">${esc(d.code)}</b>`, 'It works for 10 minutes.'], foot: 'Didn’t ask for this? Someone typed your email on the console sign-in. Nothing happens without the code.' }),
};

function createMailer({ smtpConfig, base, store, now = Date.now, log = console }) {
  const outbox = [];
  async function send(kind, to, data, slug = null) {
    const t = T[kind](data);
    const html = layout({ base, ...t });
    const text = [...t.paras, t.button ? `${t.button.label}: ${t.button.url}` : null, ...(t.after || []), t.foot || null].filter(Boolean).map(strip).join('\n\n');
    const at = new Date(now()).toISOString();
    const rec = { kind, to, subject: t.subject, text, html, data, slug, at };
    outbox.push(rec); if (outbox.length > 200) outbox.shift();
    let ok = 1, error = null;
    if (smtpConfig && smtpConfig.host) {
      try { await smtp.sendMail({ ...smtpConfig, from: smtpConfig.from, fromName: data.fromName || 'Staffwarden', to: [to], subject: t.subject, text, html }); }
      catch (e) { ok = 0; error = String(e.message || e).slice(0, 300); log.error(`mail ${kind} to ${to} failed: ${error}`); }
    } else { error = 'No mail server set up: not sent'; }
    try { store.prepare('INSERT INTO mail_log (at, slug, kind, to_addr, subject, ok, error) VALUES (?,?,?,?,?,?,?)').run(at, slug, kind, to, t.subject, ok, error); } catch { /* the log is best effort */ }
    return { ok: !!ok, error, sent: !!(smtpConfig && smtpConfig.host) && !!ok };
  }
  return { send, outbox, configured: !!(smtpConfig && smtpConfig.host) };
}

module.exports = { createMailer, money, longDay, shortDay, TEMPLATES: T };
