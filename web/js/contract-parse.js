// Reads an employment contract's text (typed, or from OCR) and finds the details HR needs: who it is
// for, their job, start date, pay, probation, notice, and contact and bank details. It only suggests:
// HR checks every field before anyone is created.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, thirty: 30, sixty: 60, ninety: 90 };
const pad = (n) => String(n).padStart(2, '0');
const COMPANYISH = /\b(amplify|media|technologies|pvt|private|limited|ltd|llc|inc|company|employer|the\s+company)\b/i;

// The text of one PDF page from pdf.js's pieces. Some PDFs (Google Docs, Canva and many "Save as PDF"
// exports) give every letter as its own piece, with the spaces as pieces of their own: joining the pieces
// with spaces turned "Name: Musab" into "N a m e : M u s a b". Pieces are joined by where they sit on the
// page instead: a space only where there is a real gap, a new line where the line changes.
export function joinItems(items) {
  let text = '', last = null;
  for (const it of items || []) {
    const str = it.str || '';
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const size = Math.hypot(t[0], t[1]) || it.height || 10;
    const x = t[4], y = t[5], w = it.width || 0;
    if (str) {
      if (last) {
        if (Math.abs(y - last.y) > size * 0.5) { if (!text.endsWith('\n')) text += '\n'; }
        else if (!/\s$/.test(text) && !/^\s/.test(str) && x - last.end > size * 0.18) text += ' ';
      }
      text += str;
      last = { y, end: x + w };
    }
    if (it.hasEOL && !text.endsWith('\n')) text += '\n';
  }
  return text;
}

// one clean line per line, OCR noise tidied
export function clean(text) {
  return String(text || '').replace(/\r/g, '').replace(/[“”ˮ]/g, '"').replace(/[‘’ʼ]/g, "'").replace(/⸻/g, '').replace(/[–—]/g, '-').replace(/ /g, ' ')
    .replace(/\*+/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// a date in any common form; day-first for numbers (Pakistan writes 01/03/2025 for 1 March)
export function parseDate(s) {
  if (!s) return null;
  s = String(s).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/(\d)\s*-\s*([a-z])/g, '$1 $2').replace(/([a-z])\s*-\s*(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return +m[2] > 12 ? valid(y, +m[1], +m[2]) : valid(y, +m[2], +m[1]); }
  const mon = (w) => MONTHS.findIndex((x) => x.startsWith(w.slice(0, 3))) + 1;
  m = s.match(/\b(\d{1,2})(?: of)? ([a-z]{3,9})\.? (\d{4})\b/);
  if (m && mon(m[2])) return valid(+m[3], mon(m[2]), +m[1]);
  m = s.match(/\b([a-z]{3,9})\.? (\d{1,2}) (\d{4})\b/);
  if (m && mon(m[1])) return valid(+m[3], mon(m[1]), +m[2]);
  return null;
}
function valid(y, mo, d) {
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? `${y}-${pad(mo)}-${pad(d)}` : null;
}
const DATE_RX = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}(?:st|nd|rd|th)?-\s?[A-Za-z]{3,9}-\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?: of)? [A-Za-z]{3,9}\.?,? \d{4}|[A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4})/;

// "Label: value" on one line, or the label alone with the value on the next line
function labelled(lines, labels, { maxLen = 80 } = {}) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const lab of labels) {
      const rx = new RegExp(`^(?:\\d+[.)]\\s*)?${lab}\\s*(?::|\\s[-–|]\\s|\\s{2,}|\\s+is\\s+)\\s*(.+)$`, 'i');
      const m = l.match(rx);
      if (m && m[1].trim()) return cut(m[1], maxLen);
      if (new RegExp(`^(?:\\d+[.)]\\s*)?${lab}\\s*:?$`, 'i').test(l) && lines[i + 1]) return cut(lines[i + 1], maxLen);
    }
  }
  // several labels on one line ("Bank: HBL   Account Title: Noor Fatima"): the label needs its colon here
  for (const l of lines) {
    for (const lab of labels) {
      if (/^[a-z]+$/.test(lab)) continue;   // "title" alone would also match "Account Title:"
      const m = l.match(new RegExp(`(?:^|\\s)${lab}\\s*:\\s*(.+)$`, 'i'));
      if (m && m[1].trim()) return cut(m[1], maxLen);
    }
  }
  return null;
}
// a value stops where the next "Label:" on the same line starts
const NEXT_LABEL = /\s+(?:account\s+title|title\s+of\s+account|account\s+(?:no|number|name)\.?|iban|bank(?:\s+name)?|cnic(?:\s+no\.?)?|e-?mail|phone|mobile|cell|contact|address|designation|position|date\s+of\s+\w+|salary|employee\s+name|name)\s*:.*$/i;
const cut = (v, maxLen) => v.replace(NEXT_LABEL, '').trim().slice(0, maxLen) || null;
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bBin\b/g, 'bin').replace(/\bUl\b/g, 'ul').replace(/\(([A-Za-z]{2,6})\)/g, (m, a) => `(${a.toUpperCase()})`);
function tidyName(s) {
  if (!s) return null;
  s = s.replace(/^(mr|mrs|ms|miss|dr|mst)\.?\s+/i, '').replace(/\s*[,(].*$/, '').replace(/\s+(s\/o|d\/o|w\/o|son of|daughter of|wife of|holding|bearing|residing|cnic|having)\b.*$/i, '').replace(/["'.]+$/, '').trim();
  if (!/^[A-Za-z][A-Za-z.' -]{2,60}$/.test(s) || COMPANYISH.test(s) || s.split(/\s+/).length > 5) return null;
  return s === s.toUpperCase() ? titleCase(s) : s;
}
function money(s) {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ');
  const m = t.match(/(PKR|Rs\.?|Rupees|USD|US\$|\$)?\s*([\d][\d,]{2,}(?:\.\d{1,2})?)\s*(\/-|PKR|Rs|rupees|USD|dollars)?/i);
  if (!m) return null;
  const n = Math.round(Number(m[2].replace(/,/g, '')));
  if (!(n >= 100)) return null;
  const cur = /usd|\$|dollar/i.test(`${m[1] || ''} ${m[3] || ''}`) || (/\b(usd|dollars?)\b/i.test(t) && !/\b(pkr|rs\.?|rupees)\b/i.test(t)) ? 'USD' : 'PKR';
  return { amount: n, currency: cur };
}
const numWord = (s) => (/^\d+$/.test(s) ? Number(s) : WORDNUM[String(s).toLowerCase()] || null);
const addMonthsDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + n, d)); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; };

// the employer's people who sign or own it: never the employee
const BOSSY = /\b(owner|proprietor|director|ceo|chief executive|managing partner|authori[sz]ed (?:signatory|person)|hr manager|human resources|witness|founder|partner)\b/i;
// a line that reads like an address
const ADDRESSY = /\b(apt|suite|ste|blvd|boulevard|drive|avenue|ave|house|h\.?\s?no|street|st\.|road|rd\.|block|colony|sector|phase|town|village|mohalla|district|tehsil|city|lane|avenue|apartment|flat|plot|near|chowk|scheme|society|cantt|bazar|bazaar)\b|#\s?\d/i;
const LABEL_LINE = /^[A-Za-z][A-Za-z /.'()-]{1,30}:/;

// every amount of money in the text with the words around it
const AMOUNT = /(?:(PKR|Rs\.?|Rupees|USD|US\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{1,2})?\s*(\/-|PKR|Rs\.?|rupees|USD|dollars))/gi;
function salaryOf(flat) {
  let best = null;
  for (const m of flat.matchAll(AMOUNT)) {
    const n = Math.round(Number((m[2] || m[3]).replace(/,/g, '')));
    const cur = /usd|\$|dollar/i.test(`${m[1] || ''} ${m[4] || ''}`) ? 'USD' : 'PKR';
    if (!(n >= (cur === 'USD' ? 100 : 1000)) || n > 50000000) continue;
    const before = flat.slice(Math.max(0, m.index - 140), m.index), near = before.slice(-70), after = flat.slice(m.index + m[0].length, m.index + m[0].length + 70);
    if (!/\b(salary|remunerat\w*|compensation|stipend|pay|wages?|fee|package)\b/i.test(before)) continue;
    // not the raise, a bonus, a fine or a commission
    if (/\b(increase|increment|raise|bonus|deduct\w*|fine|penalt\w*|allowance|commission|advance|loan|damages|reimburse\w*|incentive|per (?:lead|sale|project)|of up to)\b[^.]{0,30}$/i.test(near)) continue;
    let score = 1;
    if (/\b(previous|old|earlier|former|prior|existing|current)\b[^.]{0,50}$/i.test(near) || /\bwas\s*:?\s*$/i.test(near)) score -= 3;
    if (/\b(new|revised|increased|enhanced|updated|amended)\b[^.]{0,50}$/i.test(near)) score += 2;
    if (/\b(shall be|will be|accepts?|receive|is|of)\s*:?\s*$/i.test(near)) score += 1;
    if (/^[^.]{0,40}\b(per month|monthly|a month|\/month|p\.m\.?)\b/i.test(after)) score += 1;
    const yearly = /^[^.]{0,40}\b(per annum|annual(?:ly)?|a year|per year|yearly|p\.a\.?)\b/i.test(after);
    if (!best || score > best.score) best = { score, amount: yearly ? Math.round(n / 12) : n, currency: cur };
  }
  return best;
}

export function parseContract(raw) {
  const text = clean(raw);
  const lines = text.split('\n');
  const flat = lines.join(' ');
  const out = { name: null, email: null, phone: null, cnic: null, title: null, joined_on: null, base: null, currency: 'PKR', probation_end: null, probation_months: null, notice_days: null, contract: 'full_time', bank_name: null, iban: null, account_title: null, address: null, kind: 'new', pay_from: null, found: [] };
  const got = (k, v) => { if (v != null && v !== '' && out[k] == null) { out[k] = v; out.found.push(k); } };

  // what sort of document: a first contract, or a promotion, raise or extension of one
  const head = lines.slice(0, 8).join(' ');
  if (/\bpromotion\b/i.test(head)) out.kind = 'promotion';
  else if (/\b(increment|salary revision|revised salary|pay rise)\b/i.test(head)) out.kind = 'increment';
  else if (/\b(extension|renewal|amend\w*|addendum)\b/i.test(head)) out.kind = 'amendment';

  // the employer's owner and signatory: their name is never the employee's
  const bosses = new Set();
  const ow = flat.match(/\b(?:owned by|proprietor|through its (?:owner|ceo|director))\s*:?\s*(?:Mr\.?\s*)?([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/);
  if (ow) bosses.add(ow[1].toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const nm = lines[i].match(/^name\s*:\s*(.+)$/i), tl = lines[i + 1] && lines[i + 1].match(/^(?:title|designation|position)\s*:\s*(.+)$/i);
    if (nm && tl && BOSSY.test(tl[1])) bosses.add(nm[1].trim().toLowerCase());
  }
  const person = (s) => { const n = tidyName(s); return n && !bosses.has(n.toLowerCase()) ? n : null; };

  // the employee's own part of the contract, when it has one ("2. EMPLOYEE" then Name, Address...):
  // their name and address come from there, not the employer's. Only near the top: the signatures at the
  // end have an "EMPLOYEE" heading too.
  const top = Math.max(60, Math.round(lines.length * 0.3));
  const at = lines.slice(0, top).findIndex((l) => /^(?:\d+[.)]\s*)?(?:the\s+)?(?:employee|sales closer|closer|contractor|consultant|freelancer|intern|trainee)(?:\s+(?:details|information|particulars))?\s*:?$/i.test(l));
  const mine = at >= 0 ? lines.slice(at + 1, at + 25) : lines;
  // who: a "Name:" label, or the first line of their part when it is just their name
  got('name', person(labelled(mine, ['employee(?:\'s)? name', 'name of (?:the )?employee', 'full name', 'employee', 'name'])));
  if (!out.name && at >= 0 && !LABEL_LINE.test(mine[0] || '')) got('name', person(mine[0]));
  if (!out.name) {
    const m = flat.match(/\bbetween\b.{0,160}?\band\s+(?:Mr\.?|Ms\.?|Mrs\.?|Miss)?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})/);
    if (m) got('name', person(m[1]));
  }
  if (!out.name) { const m = flat.match(/\bDear\s+(?:Mr\.?|Ms\.?|Mrs\.?|Miss)?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4})\s*[,:]/i); if (m) got('name', person(m[1])); }
  // the signatures: "Name: X" that is not the employer's
  if (!out.name) for (const l of lines) { const m = l.match(/^name\s*:\s*(.+)$/i); if (m && person(m[1])) { got('name', person(m[1])); break; } }
  // a name alone on a line just before "Hereinafter referred to as the Employee" or their Address/Email lines
  if (!out.name) {
    const hi = lines.findIndex((l) => /referred to as the "?employee/i.test(l));
    for (let i = Math.max(0, hi - 6); hi > 0 && i < hi; i++) if (!LABEL_LINE.test(lines[i]) && person(lines[i]) && /^(address|e-?mail|cnic|phone|s\/o|d\/o)\b/i.test(lines[i + 1] || '')) { got('name', person(lines[i])); break; }
  }
  // OCR often puts a space after a dot or around the @: "hamza. tariq @ yahoo.com"
  const emails = flat.replace(/(^|\s)([\w+-]+)\.\s+(?=[\w.+-]+\s?@)/g, '$1$2.').replace(/([\w.+-])\s?@\s?([\w-]+\.)/g, '$1@$2').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  const bossMail = (e) => [...bosses].some((b) => b.split(/\s+/).some((w) => w.length > 2 && e.toLowerCase().startsWith(w)));
  got('email', (emails.find((e) => !/^(hr|info|admin|careers?|jobs|contracts?|legal|support|no-?reply|hello|contact|office)@/i.test(e) && !bossMail(e)) || null));
  if (out.email) out.email = out.email.toLowerCase().replace(/[.,;]+$/, '');
  const ph = flat.match(/(?:\+92[\s-]?|0)3\d{2}[\s-]?\d{7}\b/);
  got('phone', ph ? ph[0].replace(/\s+/g, ' ') : null);
  if (!out.phone) for (const l of lines) { const m = l.match(/\b(?:phone|mobile|cell|contact(?: no\.?)?)\s*:\s*(\+?\d[\d ().-]{6,20}\d)\s*$/i); if (m) { got('phone', m[1].replace(/\s+/g, ' ')); break; } }
  const cn = flat.match(/\b(\d{5})[\s-]?(\d{7})[\s-]?(\d)\b/);
  got('cnic', cn ? `${cn[1]}-${cn[2]}-${cn[3]}` : null);

  // where they live: the Address line after their name (with the next line when it wraps), never an
  // office or registered address
  const windows = [];
  if (at >= 0) windows.push(mine.slice(0, 12));
  if (out.name) { const i = lines.slice(0, top).findIndex((l) => l.toLowerCase().includes(out.name.toLowerCase())); if (i >= 0) windows.push(lines.slice(i, i + 10)); }
  for (const near of windows) {
    if (out.address) break;
    for (let i = 0; i < near.length; i++) {
      const l = near[i];
      if (/^(?:hereinafter|\d+[.)]\s)/i.test(l)) break;
      const lab = l.match(/^(?:(?:residential|home|permanent|postal|current)\s+)?address\s*:\s*(.*)$/i);
      if (lab || (!LABEL_LINE.test(l) && ADDRESSY.test(l) && !/@/.test(l))) {
        let a = lab ? lab[1] : l;
        if (!a && near[i + 1]) { a = near[++i]; }
        // a wrapped address carries on to the next lines: the city, state, postcode or country
        const PLACE = /\b(pakistan|punjab|sindh|kpk|khyber|balochistan|islamabad|lahore|karachi|rawalpindi|peshawar|multan|faisalabad|united states|usa|united kingdom|uk|canada|uae|dubai|australia)\b|\b[A-Z]{2}\s+\d{5}\b/i;
        for (let k = 0; k < 2; k++) {
          const nx = near[i + 1];
          if (!nx || LABEL_LINE.test(nx) || /^hereinafter|@|^\d+[.)]\s/i.test(nx) || nx.length >= 70 || !PLACE.test(nx) || PLACE.test(a.split(',').slice(-1)[0]) && /pakistan|united states|usa|united kingdom|canada|uae|australia/i.test(a)) break;
          a += `${/,\s*$/.test(a) ? ' ' : /\d$/.test(a) ? ', ' : ' '}${nx}`; i++;
        }
        got('address', cut(a, 200));
        break;
      }
    }
  }
  if (!out.address) got('address', labelled(mine, ['(?:residential |home |permanent )?address'], { maxLen: 200 }));

  // the job. Strongest first: what they are promoted to, then "appointed as:" or "serving as:" with the
  // job on the next line, then their own Title in the signatures, then labels and sentences.
  let title = null;
  const nextIsTitle = (i) => { const n = lines[i + 1]; return n && n.length <= 60 && !/[.;]$/.test(n) && !/^(?:the|this|his|her|their|effective|\*)\b/i.test(n) && !LABEL_LINE.test(n) ? n : null; };
  for (let i = 0; i < lines.length && !title; i++) if (/\bpromot\w*\b.*\bto\s*:?\s*$/i.test(`${lines[i - 1] || ''} ${lines[i]}`) && /\bto\s*:?\s*$/i.test(lines[i])) title = nextIsTitle(i);
  if (!title) { const m = flat.match(/\bpromot\w*\s+(?:him|her|the employee|you)?\s*(?:from\s+(?:the\s+)?(?:position|post|role)\s+of\s+[A-Za-z&/ -]{2,40}?\s+)?to\s+(?:the\s+(?:position|post|role)\s+of\s+)?(?:an?\s+|the\s+)?([A-Z][A-Za-z&/ ()-]{2,50}?)(?=\s+(?:with|at|in|on|from|for|effective|w\.e\.f)\b|[,.;:]|$)/); if (m) title = m[1]; }
  for (let i = 0; i < lines.length && !title; i++) if (/\b(?:appointed|employed|hired|engaged|serv(?:e|ing)|continue\w* (?:to serve |serving )?|designated)\s+(?:to the position of|in the position of|as)\s*:?\s*$|\b(?:position|designation|post|role)\s+(?:is|shall be|will be)\s*:?\s*$/i.test(lines[i])) title = nextIsTitle(i);
  if (!title && out.name) {
    const i = lines.findIndex((l) => new RegExp(`^name\\s*:\\s*${out.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(l));
    const tl = i >= 0 && lines[i + 1] && lines[i + 1].match(/^(?:title|designation|position)\s*:\s*(.+)$/i);
    if (tl && !BOSSY.test(tl[1])) title = tl[1];
  }
  if (!title) { const t = labelled(mine === lines ? lines : [...mine, ...lines], ['designation', 'position', 'job title', 'post', 'role', 'title']); if (t && !BOSSY.test(t) && t.split(/\s+/).length <= 7 && !/^(?:the|this|his|her|their|a|an)\b|[.;]$/i.test(t)) title = t; }
  if (!title) { const m = flat.match(/\b(?:appoint\w*|employ\w*|hire\w*|engag\w*|join\w*)\s+(?:you|[Tt]he [Ee]mployee|him|her|[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4})?\s*as\s+(?:an?\s+|the\s+)?([A-Za-z][A-Za-z&/ -]{2,60}?)(?=\s+(?:with|at|in|on|from|for|effective|starting|reporting|w\.e\.f)\b|[,.;(]|$)/); if (m) title = m[1]; }
  if (!title) { const m = flat.match(/\bposition of\s+(?:an?\s+|the\s+)?([A-Z][A-Za-z&/ -]{2,50}?)(?=\s+(?:with|at|in|on|from|for|effective)\b|[,.;(]|$)/); if (m) title = m[1]; }
  if (title) { title = title.replace(/^(?:full|part)[- ]time\s+/i, '').replace(/["'.:]+$/, '').replace(/\s+(?:with|at)\s+.*$/i, '').trim().slice(0, 80); got('title', title === title.toUpperCase() ? titleCase(title) : title); }

  // when they joined. A promotion or raise names the date they first joined (or the first agreement's
  // date) and the date the change takes effect: the first is when they joined, the second is when the
  // new pay starts.
  const dateAfter = (rx) => { const m = flat.match(new RegExp(`${rx}\\s*:?\\s*(?:on|from|of|dated|w\\.?e\\.?f\\.?)?\\s*(?:the\\s+)?${DATE_RX.source}`, 'i')); return m ? parseDate(m[m.length - 1]) : null; };
  let effective = parseDate(labelled(lines, ['effective date(?: of [a-z ]+)?', 'date of effect'])) || dateAfter('(?:made |entered into )?effective');
  let joined = null;
  if (out.kind !== 'new') joined = dateAfter('(?:originally |first )?joined(?: [A-Z][A-Za-z ]{2,40}?)?') || dateAfter('original (?:joining|start) date') || dateAfter('(?:originally )?entered into') || dateAfter('original employment agreement(?: dated)?');
  if (!joined) joined = parseDate(labelled(lines, ['date of joining', 'joining date', 'date of commencement', 'commencement date', 'start(?:ing)? date', 'effective date', 'date of appointment', 'appointment date', 'joining']));
  if (!joined) { const m = flat.match(new RegExp(`(?:commenc\\w*|start\\w*|join\\w*|effective|with effect from|w\\.?e\\.?f\\.?)\\s+(?:on|from|date)?\\s*(?:the\\s+)?${DATE_RX.source}`, 'i')); if (m) joined = parseDate(m[1]); }
  if (!joined) joined = dateAfter('(?:made (?:and entered )?|entered )into') || effective;
  got('joined_on', joined);
  if (out.kind !== 'new' && effective && effective !== joined) got('pay_from', effective);

  // pay: the salary the contract sets, not a year, the old salary, the raise or a bonus
  const sal = salaryOf(flat);
  if (sal) { got('base', sal.amount); out.currency = sal.currency; }
  else {
    // "Salary: 85,000" with no currency
    const m = money(labelled(lines, ['(?:gross |monthly |basic |net )?(?:salary|remuneration|pay)(?: per month)?']));
    if (m && !(m.amount >= 1900 && m.amount <= 2100 && !/,/.test(String(m.amount)))) { got('base', m.amount); out.currency = m.currency; }
  }

  // probation and notice
  const pr = flat.match(/probation(?:ary)?(?: period)?(?: of| for| shall be| will be| is)?\s+(\w+)\s*(?:\((\d+)\))?[\s-]*(months?|weeks?)/i);
  const pr2 = !pr && flat.match(/\b(\w+)\s*(?:\((\d+)\))?[\s-]+(months?|weeks?)['’]?\s+(?:initial\s+)?probation/i);
  const pp = pr || (pr2 && [pr2[0], pr2[1], pr2[2], pr2[3]]);
  let probWeeks = null;
  if (pp) { const n = numWord(pp[2] || pp[1]); if (n) { if (/week/i.test(pp[3])) { probWeeks = n; if (n >= 4) out.probation_months = Math.round(n / 4); } else out.probation_months = n; out.found.push('probation'); } }
  if (out.probation_months && out.joined_on) out.probation_end = addMonthsDay(out.joined_on, out.probation_months);
  else if (probWeeks && out.joined_on) { const [y, m, d] = out.joined_on.split('-').map(Number); out.probation_end = new Date(Date.UTC(y, m - 1, d + probWeeks * 7)).toISOString().slice(0, 10); }
  const nt = flat.match(/(\w+)\s*(?:\((\d+)\))?[\s-]*(days?|months?|weeks?)(?:['’]s?)?\s*(?:prior\s+|advance\s+)?(?:written\s+)?notice/i) || flat.match(/notice(?: period)?(?: of)?[:\s-]+(\w+)\s*(?:\((\d+)\))?[\s-]*(days?|months?|weeks?)/i);
  if (nt) { const n = numWord(nt[2] || nt[1]); if (n) got('notice_days', /month/i.test(nt[3]) ? n * 30 : /week/i.test(nt[3]) ? n * 7 : n); }

  // kind of contract
  if (/\b(independent contractor|contractor agreement|consultancy agreement|consultant)\b/i.test(flat)) out.contract = 'contractor';
  else if (/\b(internship|intern)\b/i.test(flat)) out.contract = 'intern';
  else if (/\bpart[- ]time\b/i.test(flat)) out.contract = 'part_time';
  else if (out.probation_end && out.probation_end >= new Date().toISOString().slice(0, 10)) out.contract = 'probation';

  // bank
  const ib = flat.replace(/(?<=[A-Z0-9])\s(?=[A-Z0-9]{4}\b)/g, '').match(/\b([A-Z]{2}\d{2}[A-Z]{4}\d{10,20})\b/);
  got('iban', ib ? ib[1] : null);
  got('bank_name', labelled(lines, ['bank name', 'name of bank', 'bank']));
  got('account_title', labelled(lines, ['account title', 'title of account', 'account name']));
  return out;
}
