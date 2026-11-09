'use strict';
// Writes a .zip file entry by entry, straight to disk, so a company's whole export (spreadsheets plus
// every screenshot and file) never has to fit in memory. Files are stored as they are (pictures and PDFs
// are already compressed); text is deflated. Up to 4 GB and 65,535 entries.
const fs = require('node:fs');
const zlib = require('node:zlib');

function createZip(file) {
  const fd = fs.openSync(file, 'w');
  const central = [];
  let off = 0, count = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  function add(name, data, { deflate = false } = {}) {
    if (count >= 65535) throw new Error('Too many files for one zip');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0, nm = Buffer.from(name, 'utf8');
    if (off + 30 + nm.length + body.length > 0xFFFFFFFF) throw new Error('The export is larger than 4 GB');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(nm.length, 26); h.writeUInt16LE(0, 28);
    fs.writeSync(fd, h); fs.writeSync(fd, nm); fs.writeSync(fd, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm);
    off += 30 + nm.length + body.length; count++;
  }
  function close() {
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    fs.writeSync(fd, cd); fs.writeSync(fd, end); fs.closeSync(fd);
    return { files: count, bytes: off + cd.length + 22 };
  }
  return { add, close };
}
module.exports = { createZip };
