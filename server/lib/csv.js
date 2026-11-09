'use strict';
// One CSV cell. Text that a spreadsheet would read as a formula (starting with = + - @, a tab or a return)
// gets a leading apostrophe, so a name like =HYPERLINK(...) shows as text instead of running. Plain
// numbers, negative ones included, are left as numbers.
const NUMBER = /^[-+]?\d[\d,]*(\.\d+)?$/;
function cell(v) {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const rows = (list) => list.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
module.exports = { cell, rows };
