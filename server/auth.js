'use strict';
const crypto = require('node:crypto');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Sessions are stored only as a hash of the token, so a copy of the database cannot be used to sign in.
const tokenHash = (token) => 'h:' + crypto.createHash('sha256').update(String(token)).digest('hex');

// Spends the same time as a real check when there is no such account, so the response time does not
// reveal which email addresses exist.
const DUMMY = hashPassword('not-a-real-password');
const verifyNobody = (password) => { verifyPassword(password, DUMMY.salt, DUMMY.hash); return false; };

// Rules for new passwords: at least 10 characters and not one of the most common passwords.
const COMMON = new Set(`password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword admin123 admin1234
  administrator welcome welcome1 welcome123 letmein letmein123 qwerty qwerty123 qwertyuiop asdfghjkl zxcvbnm 1234567890 0123456789
  123456789 12345678 1234567 123123123 111111111 000000000 iloveyou iloveyou1 sunshine princess football baseball dragon monkey
  master superman batman trustno1 abc123456 abcd1234 changeme changeme123 change-me-now pakistan pakistan123 pakistan1947
  islamabad karachi lahore amplify amplify123 workhelm workhelm123 company123 office123 default secret secret123`.split(/\s+/).filter(Boolean));
function passwordProblem(pw) {
  const p = String(pw || '');
  if (p.length < 10) return 'Use at least 10 characters';
  if (p.length > 200) return 'Use at most 200 characters';
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(p) || /^(0123456789|1234567890|abcdefghij)/.test(low)) return 'That password is too common. Choose something harder to guess';
  return null;
}

module.exports = { hashPassword, verifyPassword, newToken, tokenHash, verifyNobody, passwordProblem };
