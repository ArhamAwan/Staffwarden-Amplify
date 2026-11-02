'use strict';
// Reading employment contracts for HR's import: PDFs that give every letter as its own piece, markdown
// stars around labels, and the employee's own part of the contract rather than the employer's.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../web/js/contract-parse.js');

// pdf.js pieces for "Name: Musab Bin Aslam", one letter each, the space as its own piece
function letters(line, y, size = 12) {
  let x = 40; const out = [];
  for (const ch of line) { const w = ch === ' ' ? 0.3 : size * 0.6; out.push({ str: ch, transform: [size, 0, 0, size, x, y], width: w }); x += ch === ' ' ? size * 0.3 : w; }
  return out;
}

test('a PDF that gives every letter separately reads as words, not "N a m e"', async () => {
  const { joinItems } = await load();
  const t = joinItems([...letters('EMPLOYMENT AGREEMENT', 700), ...letters('Name: Musab Bin Aslam', 680)]);
  assert.equal(t, 'EMPLOYMENT AGREEMENT\nName: Musab Bin Aslam');
  // ordinary PDFs with whole words and gaps between them still get their spaces
  const words = [{ str: 'Basic', transform: [12, 0, 0, 12, 40, 600], width: 30 }, { str: 'salary', transform: [12, 0, 0, 12, 74, 600], width: 34 }];
  assert.equal(joinItems(words), 'Basic salary');
});

test('the employee’s details come from their part of the contract; labels in stars and headings with dashes', async () => {
  const { parseContract } = await load();
  const r = parseContract(`EMPLOYMENT AGREEMENT
Effective Date: 1 August 2026
1. EMPLOYER
*Amplify Media*
Office Address: House #1, Office Road, Rawalpindi
2. EMPLOYEE
*Name:* Musab Bin Aslam
*Address:* House #948, KRL Road, Rawalpindi
*Email:* [musab@example.com]
3. APPOINTMENT
The Employee is appointed as:
CHIEF TECHNICAL OFFICER (CTO)
The Employee shall receive a base salary of PKR 115,000 per month.
29. POST-TERMINATION OBLIGATIONS
Title: CEO`);
  assert.equal(r.name, 'Musab Bin Aslam');
  assert.equal(r.address, 'House #948, KRL Road, Rawalpindi');
  assert.equal(r.title, 'Chief Technical Officer (CTO)');
  assert.equal(r.joined_on, '2026-08-01');
  assert.equal(r.base, 115000);
  assert.equal(r.email, 'musab@example.com');
});
