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

test('a promotion agreement: the new job and salary, not the year, the owner or the old job', async () => {
  const { parseContract } = await load();
  const r = parseContract(`PROMOTION & AMENDED
EMPLOYMENT AGREEMENT
Effective Date: 1st August 2026
This Agreement amends the Employment Agreement originally entered into on 13th October 2025, by and between:
EMPLOYER
Amplify Media
A sole proprietorship owned by Basit Gilani
Office Address: House # 948, KRL Road, Rawalpindi, Pakistan
Muhammad Waseem Abbas
Address: Hassu Balail, District Jhang, Tehsil Ahmad Pur
Sial, Punjab, Pakistan
Email: waseem@example.com
Hereinafter referred to as the “Employee.ˮ
1. PROMOTION AND POSITION
Effective 1st August 2026, the Employer hereby promotes
the Employee from the position of Media Buyer to:
CHIEF OPERATING OFFICER (COO)
7. COMPENSATION
Effective 1st August 2026, the Employeeʼs salary shall be:
PKR 150,000 (One Hundred Fifty Thousand Rupees) per
month
18. NOTICE PERIOD
Either party shall give thirty (30) daysʼ written notice.
SIGNATURES
Name: Basit Gilani
Title: Owner & Director
EMPLOYEE
Name: Muhammad Waseem Abbas
Title: Chief Operating Officer`);
  assert.equal(r.name, 'Muhammad Waseem Abbas');
  assert.equal(r.title, 'Chief Operating Officer (COO)');
  assert.equal(r.base, 150000);
  assert.equal(r.joined_on, '2025-10-13');
  assert.equal(r.pay_from, '2026-08-01');
  assert.equal(r.kind, 'promotion');
  assert.equal(r.notice_days, 30);
  assert.equal(r.address, 'Hassu Balail, District Jhang, Tehsil Ahmad Pur Sial, Punjab, Pakistan');
});

test('a salary increment: the new salary, not the old one or the raise; joined on the original date', async () => {
  const { parseContract } = await load();
  const r = parseContract(`EMPLOYMENT CONTRACT EXTENSION &
SALARY INCREMENT AGREEMENT
1. EMPLOYER
Amplify Media
A sole proprietorship owned by Basit Gilani
Effective Date of Increment: 01-August-2026
2. EMPLOYEE
Dur-e-Shawar Nasir
D/O Nasir Ahmed
CNIC No.: 35202-2560524-4
House #695, Block D, Sher Shah Colony, Raiwind Road, Lahore
Email: diya@example.com
3. ORIGINAL EMPLOYMENT
The Employee originally joined Amplify Media on 01-January-2026.
The Employee’s existing position is:
Creative Manager & Graphic Designer
4. SALARY INCREMENT
The Employee’s previous monthly salary was:
PKR 35,000 per month
Effective 01-August-2026, the Employee’s new basic monthly salary shall be:
PKR 50,000 (Pakistani Rupees Fifty Thousand Only) per month.
This represents an increase of:
PKR 15,000 per month
Either party may terminate in accordance with the 30-day written notice requirement.
EMPLOYEE
Name: Basit Gilani
Title: Owner & Director`);
  assert.equal(r.name, 'Dur-e-Shawar Nasir');
  assert.equal(r.title, 'Creative Manager & Graphic Designer');
  assert.equal(r.base, 50000);
  assert.equal(r.joined_on, '2026-01-01');
  assert.equal(r.pay_from, '2026-08-01');
  assert.equal(r.address, 'House #695, Block D, Sher Shah Colony, Raiwind Road, Lahore');
  assert.equal(r.notice_days, 30);
});
