'use strict';
// A small Excel (.xlsx) writer: enough for neat payroll sheets (a title, bold headers, money with thousands
// separators, totals, column widths, frozen headers and filters). No dependencies: the zip is built here.
const zlib = require('node:zlib');

// ---- styles: one list, referred to by name ----
// fonts: 0 normal, 1 bold, 2 title, 3 muted, 4 bold white
// fills: 0 none, 1 gray125 (required), 2 header, 3 total, 4 note
// borders: 0 none, 1 bottom, 2 top
const XF = [
  // [name, font, fill, border, numFmt, alignment attributes]
  ['text', 0, 0, 0, 0],
  ['title', 2, 0, 0, 0],
  ['sub', 3, 0, 0, 0],
  ['head', 4, 2, 1, 0, 'vertical="center" wrapText="1"'],
  ['headR', 4, 2, 1, 0, 'horizontal="right" vertical="center" wrapText="1"'],
  ['money', 0, 0, 0, 164],
  ['total', 1, 3, 2, 0],
  ['totalMoney', 1, 3, 2, 164],
  ['mono', 0, 0, 0, 0],
  ['muted', 3, 0, 0, 0],
  ['mutedMoney', 3, 0, 0, 164],
  ['bold', 1, 0, 0, 0],
  ['note', 3, 4, 0, 0],
  ['boldMoney', 1, 0, 0, 164],
  ['wrap', 0, 0, 0, 0, 'wrapText="1" vertical="top"'],
  ['center', 0, 0, 0, 0, 'horizontal="center"'],
  ['headC', 4, 2, 1, 0, 'horizontal="center" vertical="center" wrapText="1"'],
  ['net', 1, 3, 1, 0],
  ['netMoney', 1, 3, 1, 164],
  ['netC', 1, 3, 1, 0, 'horizontal="center"'],
  ['totalC', 1, 3, 2, 0, 'horizontal="center"'],
  ['mutedC', 3, 0, 0, 0, 'horizontal="center"'],
];
const XI = Object.fromEntries(XF.map((x, i) => [x[0], i]));

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0;\-#,##0;&quot;–&quot;"/></numFmts>
<fonts count="5">
<font><sz val="11"/><color rgb="FF1F1A33"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF1F1A33"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF2E1F6B"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF6B6585"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF4B3A9C"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDE9FB"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6DD"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF4B3A9C"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF4B3A9C"/></top><bottom style="double"><color rgb="FF4B3A9C"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${XF.length}">
${XF.map(([, font, fill, border, num, al]) => `<xf numFmtId="${num}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${num ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${al ? ` applyAlignment="1"><alignment ${al}/></xf>` : '/>'}`).join('\n')}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
const colName = (i) => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// a cell is a value, or { v, s: style name }
function cellXml(c, ref) {
  if (c == null || c === '') return '';
  const o = typeof c === 'object' && !(c instanceof Date) ? c : { v: c };
  if (o.v == null || o.v === '') return o.s ? `<c r="${ref}" s="${XI[o.s] || 0}"/>` : '';
  const s = o.s ? ` s="${XI[o.s] || 0}"` : '';
  if (typeof o.v === 'number' && Number.isFinite(o.v)) return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
}

// sheet: { name, cols: [width...], rows: [[cell...]], freeze: rows above the scroll, filter: { row, from, to },
//          merges: ['A1:F1'], heights: { rowIndex: pt }, landscape }
function sheetXml(sh) {
  const rows = sh.rows.map((r, i) => {
    const cells = (r || []).map((c, j) => cellXml(c, `${colName(j)}${i + 1}`)).join('');
    const ht = sh.heights && sh.heights[i] ? ` ht="${sh.heights[i]}" customHeight="1"` : '';
    return cells || ht ? `<row r="${i + 1}"${ht}>${cells}</row>` : '';
  }).join('');
  const pane = sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sh.freeze + 1}" sqref="A${sh.freeze + 1}"/>` : '';
  const cols = sh.cols ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const filter = sh.filter ? `<autoFilter ref="${colName(sh.filter.from)}${sh.filter.row + 1}:${colName(sh.filter.to)}${sh.filter.last + 1}"/>` : '';
  const merges = sh.merges && sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rows}</sheetData>${filter}${merges}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup orientation="${sh.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

// ---- zip (stored as deflate) ----
function zip(files) {
  const local = [], central = [];
  let off = 0;
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0, nm = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, nm, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm);
    off += h.length + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}

function workbook(sheets, { title = '', author = 'Staffwarden' } = {}) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const safe = (n) => String(n).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(safe(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.some((s) => s.filter) ? `<definedNames>${sheets.map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(safe(s.name))}'!$${colName(s.filter.from)}$${s.filter.row + 1}:$${colName(s.filter.to)}$${s.filter.last + 1}</definedName>` : '')).join('')}</definedNames>` : ''}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files);
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
module.exports = { workbook, colName, XLSX_TYPE };
