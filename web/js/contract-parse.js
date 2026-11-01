// Reads an employment contract's text (typed, or from OCR) and finds the details HR needs: who it is
// for, their job, start date, pay, probation, notice, and contact and bank details. It only suggests:
// HR checks every field before anyone is created.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, thirty: 30, sixty: 60, ninety: 90 };
const pad = (n) => String(n).padStart(2, '0');
const COMPANYISH = /\b(amplify|media|technologies|pvt|private|limited|ltd|llc|inc|company|employer|the\s+company)\b/i;

// one clean line per line, OCR noise tidied
export function clean(text) {
  return String(text || '').replace(/\r/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/ /g, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// a date in any common form; day-first for numbers (Pakistan writes 01/03/2025 for 1 March)
export function parseDate(s) {
  if (!s) return null;
  s = String(s).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
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
const DATE_RX = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?: of)? [A-Za-z]{3,9}\.?,? \d{4}|[A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4})/;

// "Label: value" on one line, or the label alone with the value on the next line
function labelled(lines, labels, { maxLen = 80 } = {}) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const lab of labels) {
      const rx = new RegExp(`^(?:\\d+[.)]\\s*)?${lab}\\s*(?:[:\\-–|]|\\s{2,}|\\s+is\\s+)\\s*(.+)$`, 'i');
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
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bBin\b/g, 'bin').replace(/\bUl\b/g, 'ul');
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

export function parseContract(raw) {
  const text = clean(raw);
  const lines = text.split('\n');
  const flat = lines.join(' ');
  const out = { name: null, email: null, phone: null, cnic: null, title: null, joined_on: null, base: null, currency: 'PKR', probation_end: null, probation_months: null, notice_days: null, contract: 'full_time', bank_name: null, iban: null, account_title: null, address: null, found: [] };
  const got = (k, v) => { if (v != null && v !== '' && out[k] == null) { out[k] = v; out.found.push(k); } };

  // who
  got('name', tidyName(labelled(lines, ['employee(?:\'s)? name', 'name of (?:the )?employee', 'full name', 'employee', 'name'])));
  if (!out.name) {
    const m = flat.match(/\bbetween\b.{0,160}?\band\s+(?:Mr\.?|Ms\.?|Mrs\.?|Miss)?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})/);
    if (m) got('name', tidyName(m[1]));
  }
  if (!out.name) { const m = flat.match(/\bDear\s+(?:Mr\.?|Ms\.?|Mrs\.?|Miss)?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4})\s*[,:]/i); if (m) got('name', tidyName(m[1])); }
  // OCR often puts a space after a dot or around the @: "hamza. tariq @ yahoo.com"
  const emails = flat.replace(/(^|\s)([\w+-]+)\.\s+(?=[\w.+-]+\s?@)/g, '$1$2.').replace(/([\w.+-])\s?@\s?([\w-]+\.)/g, '$1@$2').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  got('email', (emails.find((e) => !/^(hr|info|admin|careers?|jobs|contracts?|legal|support|no-?reply)@/i.test(e)) || null));
  if (out.email) out.email = out.email.toLowerCase().replace(/[.,;]+$/, '');
  const ph = flat.match(/(?:\+92[\s-]?|0)3\d{2}[\s-]?\d{7}\b/);
  got('phone', ph ? ph[0].replace(/\s+/g, ' ') : null);
  const cn = flat.match(/\b(\d{5})[\s-]?(\d{7})[\s-]?(\d)\b/);
  got('cnic', cn ? `${cn[1]}-${cn[2]}-${cn[3]}` : null);
  got('address', labelled(lines, ['(?:residential |home |permanent )?address'], { maxLen: 200 }));

  // the job
  let title = labelled(lines, ['designation', 'position', 'job title', 'post', 'role', 'title']);
  if (!title) { const m = flat.match(/\b(?:appoint\w*|employ\w*|hire\w*|engag\w*|join\w*)\s+(?:you|the employee|him|her)?\s*as\s+(?:an?\s+|the\s+)?([A-Za-z][A-Za-z&/ -]{2,50}?)(?=\s+(?:with|at|in|on|from|for|effective|starting|reporting|w\.e\.f)\b|[,.;(]|$)/i); if (m) title = m[1]; }
  if (!title) { const m = flat.match(/\bposition of\s+(?:an?\s+|the\s+)?([A-Z][A-Za-z&/ -]{2,50}?)(?=\s+(?:with|at|in|on|from|for|effective)\b|[,.;(]|$)/); if (m) title = m[1]; }
  if (title) { title = title.replace(/["'.]+$/, '').replace(/\s+(?:with|at)\s+.*$/i, '').trim().slice(0, 80); got('title', title === title.toUpperCase() ? titleCase(title) : title); }

  // when
  let jd = labelled(lines, ['date of joining', 'joining date', 'date of commencement', 'commencement date', 'start(?:ing)? date', 'effective date', 'date of appointment', 'appointment date', 'joining']);
  let joined = parseDate(jd);
  if (!joined) { const m = flat.match(new RegExp(`(?:commenc\\w*|start\\w*|join\\w*|effective|with effect from|w\\.?e\\.?f\\.?)\\s+(?:on|from|date)?\\s*(?:the\\s+)?${DATE_RX.source}`, 'i')); if (m) joined = parseDate(m[1]); }
  got('joined_on', joined);

  // pay
  let sal = labelled(lines, ['(?:gross |monthly |basic |net )?(?:salary|remuneration|compensation|pay|stipend|fee)(?: per month)?(?: \\(?(?:pkr|rs\\.?|usd)\\)?)?']);
  let m$ = money(sal);
  if (!m$) { const m = flat.match(/(?:salary|remuneration|compensation|stipend|fee)[^.]{0,80}?((?:PKR|Rs\.?|USD|US\$|\$)\s*[\d][\d,]{2,}(?:\.\d{1,2})?|[\d][\d,]{3,}\s*(?:\/-|PKR|Rs|rupees|USD|dollars))/i); if (m) m$ = money(m[1]); }
  if (m$) { got('base', m$.amount); out.currency = m$.currency; }
  // a yearly figure is turned into a monthly one
  if (out.base && /\b(per annum|annual(?:ly)?|a year|per year|yearly)\b/i.test(sal || flat.slice(0, 2000)) && !/\b(per month|monthly|a month)\b/i.test(sal || '')) out.base = Math.round(out.base / 12);

  // probation and notice
  const pr = flat.match(/probation(?:ary)?(?: period)?(?: of| for| shall be| will be| is)?\s+(\w+)\s*(?:\((\d+)\))?\s*(months?|weeks?)/i);
  if (pr) { const n = numWord(pr[2] || pr[1]); if (n) { out.probation_months = /week/i.test(pr[3]) ? Math.round(n / 4) : n; out.found.push('probation'); } }
  if (out.probation_months && out.joined_on) out.probation_end = addMonthsDay(out.joined_on, out.probation_months);
  const nt = flat.match(/(\w+)\s*(?:\((\d+)\))?\s*(days?|months?|weeks?)(?:['’]s?)?\s*(?:prior\s+|advance\s+)?(?:written\s+)?notice/i) || flat.match(/notice(?: period)?(?: of)?[:\s-]+(\w+)\s*(?:\((\d+)\))?\s*(days?|months?|weeks?)/i);
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
