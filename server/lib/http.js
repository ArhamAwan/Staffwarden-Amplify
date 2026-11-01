'use strict';
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function need(cond, status, msg) { if (!cond) throw new HttpError(status, msg); }
function str(v, name, max = 200) {
  need(typeof v === 'string' && v.trim().length > 0 && v.length <= max, 400, `${name} is required`);
  return v.trim();
}
function optStr(v, name, max = 500) {
  if (v == null || v === '') return null;
  need(typeof v === 'string' && v.length <= max, 400, `${name} is too long`);
  return v.trim() || null;
}
function int(v, name, min, max) {
  need(Number.isInteger(v) && v >= min && v <= max, 400, `${name} must be an integer ${min}-${max}`);
  return v;
}
function isoDate(v, name) {
  need(typeof v === 'string' && !Number.isNaN(Date.parse(v)), 400, `${name} must be an ISO date`);
  return new Date(v).toISOString();
}
module.exports = { HttpError, need, str, optStr, int, isoDate };
