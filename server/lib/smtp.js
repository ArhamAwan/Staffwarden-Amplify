'use strict';
// A small SMTP client: enough to send one email with a PDF attached through the company's own mailbox
// (Hostinger, Gmail with an app password, Outlook, any provider). Port 465 is TLS from the start; any other
// port starts plain and must switch to TLS (STARTTLS) before the password is sent. No password ever goes
// over an unencrypted connection.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, (x) => `${x}\r\n`);
const encWord = (s) => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (a) => String(a || '').trim();
const validAddr = (a) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(addr(a));

// the whole message, ready for DATA (dot-stuffed, CRLF line ends)
function buildMessage({ from, fromName, to, subject, text, html, attachments = [], date = new Date() }) {
  const mixed = `sw-m-${crypto.randomBytes(9).toString('hex')}`, alt = `sw-a-${crypto.randomBytes(9).toString('hex')}`;
  const domain = String(from).split('@')[1] || 'staffwarden.local';
  const head = [
    `From: ${fromName ? `${encWord(fromName)} ` : ''}<${from}>`,
    `To: ${to.map((x) => `<${x}>`).join(', ')}`,
    `Subject: ${encWord(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  let body = `--${mixed}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n`;
  body += `--${alt}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(text || ''))}`;
  if (html) body += `--${alt}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(html))}`;
  body += `--${alt}--\r\n`;
  for (const a of attachments) {
    const name = String(a.filename).replace(/["\r\n]/g, '');
    body += `--${mixed}\r\nContent-Type: ${a.type || 'application/octet-stream'}; name="${name}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${name}"\r\n\r\n${wrap76(Buffer.from(a.content).toString('base64'))}`;
  }
  body += `--${mixed}--\r\n`;
  const msg = `${head.join('\r\n')}\r\n\r\n${body}`;
  return msg.replace(/^\./gm, '..');
}

// reads SMTP replies (one code per reply; "250-..." lines continue it)
function replies(sock) {
  let buf = '', waiting = null, lines = [];
  const queue = [], fail = { err: null };
  const pump = () => {
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) { const r = { code: Number(line.slice(0, 3)), lines }; lines = []; if (waiting) { const w = waiting; waiting = null; w.res(r); } else queue.push(r); }
    }
  };
  const onData = (d) => { buf += d.toString('utf8'); pump(); };
  const onErr = (e) => { fail.err = e; if (waiting) { const w = waiting; waiting = null; w.rej(e); } };
  sock.on('data', onData); sock.on('error', onErr); sock.on('close', () => onErr(new Error('The mail server closed the connection')));
  return {
    next: () => new Promise((res, rej) => { if (queue.length) return res(queue.shift()); if (fail.err) return rej(fail.err); waiting = { res, rej }; }),
    detach: () => { sock.off('data', onData); sock.off('error', onErr); sock.removeAllListeners('close'); },
  };
}

async function sendMail(opts, { timeoutMs = 25000, allowInsecure = false } = {}) {
  const { host, port = 587, user, pass } = opts;
  const from = addr(opts.from || user), to = (opts.to || []).map(addr).filter(Boolean);
  if (!host) throw new Error('No mail server set');
  if (!validAddr(from)) throw new Error('The "from" address doesn’t look like an email address');
  if (!to.length || !to.every(validAddr)) throw new Error('Add at least one valid email address to send to');
  const direct = Number(port) === 465 || opts.security === 'tls';
  let sock = direct ? tls.connect({ host, port: Number(port), servername: host }) : net.connect({ host, port: Number(port) });
  const timer = setTimeout(() => sock.destroy(new Error('The mail server didn’t answer in time')), timeoutMs);
  let rd = replies(sock);
  const expect = async (ok, what) => {
    const r = await rd.next();
    if (!(Array.isArray(ok) ? ok : [ok]).includes(r.code)) {
      const said = r.lines.map((l) => l.slice(4)).join(' ').trim();
      const e = new Error(`${what}: the mail server said ${r.code}${said ? ` ${said}` : ''}`); e.code = r.code; throw e;
    }
    return r;
  };
  const say = (line) => sock.write(`${line}\r\n`);
  try {
    if (direct) await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    await expect(220, 'Connecting');
    const name = 'staffwarden';
    say(`EHLO ${name}`);
    let ehlo = await expect(250, 'Saying hello');
    const caps = () => ehlo.lines.map((l) => l.slice(4).toUpperCase());
    if (!direct) {
      if (caps().some((c) => c.startsWith('STARTTLS'))) {
        say('STARTTLS'); await expect(220, 'Switching to a secure connection');
        rd.detach();
        sock = tls.connect({ socket: sock, servername: host });
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        rd = replies(sock);
        say(`EHLO ${name}`); ehlo = await expect(250, 'Saying hello');
      } else if (user && !allowInsecure) {
        throw new Error('This mail server doesn’t offer a secure connection on that port. Try port 465 or 587.');
      }
    }
    if (user) {
      const auth = caps().find((c) => c.startsWith('AUTH')) || '';
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) { say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass || ''}`, 'utf8').toString('base64')}`); }
      else { say('AUTH LOGIN'); await expect(334, 'Signing in'); say(b64(user)); await expect(334, 'Signing in'); say(b64(pass || '')); }
      try { await expect(235, 'Signing in'); } catch (e) { if (e.code === 535 || e.code === 534) e.message = 'The mail server didn’t accept the username or password. For Gmail, use an app password, not your normal one.'; throw e; }
    }
    say(`MAIL FROM:<${from}>`); await expect(250, 'Sender');
    for (const t of to) { say(`RCPT TO:<${t}>`); await expect([250, 251], `Recipient ${t}`); }
    say('DATA'); await expect(354, 'Sending');
    sock.write(buildMessage({ ...opts, from, to }));
    say('.'); await expect(250, 'Sending');
    say('QUIT');
    return { ok: true, to };
  } catch (e) {
    // the network errors, in words
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') e.message = `Couldn’t find the mail server “${host}”. Check its name.`;
    else if (e.code === 'ECONNREFUSED') e.message = `The mail server “${host}” refused the connection on port ${port}. Try the other port (465 or 587).`;
    else if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || /didn’t answer in time/.test(e.message)) e.message = `No answer from “${host}” on port ${port}. Try the other port (465 or 587).`;
    else if (/certificate|SSL|TLS|wrong version/i.test(e.message)) e.message = `A secure connection to “${host}” didn’t work on port ${port}. Port 465 is for SSL, 587 for STARTTLS.`;
    throw e;
  } finally {
    clearTimeout(timer);
    setTimeout(() => { try { sock.end(); } catch { /* closed */ } }, 50);
  }
}

module.exports = { sendMail, buildMessage, validAddr };
