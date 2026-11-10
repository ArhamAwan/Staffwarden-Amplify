'use strict';
// The platform's own database: the companies on the service, their accounts and payments, sign-ups in
// progress, your console's sign-ins, and a log of every email sent. Each company's working data (people,
// hours, pay) is in its own database, never here.
const { DatabaseSync } = require('node:sqlite');

const VERSION = 2;
function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        country TEXT,
        size TEXT,
        owner_email TEXT NOT NULL,
        owner_name TEXT,
        data_dir TEXT,                       -- set for a company kept outside the companies folder (the first one)
        status TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','paused','closed','deleted')),
        plan TEXT NOT NULL DEFAULT 'business',
        interval TEXT NOT NULL DEFAULT 'year',
        pending_plan TEXT, pending_interval TEXT, -- a move down a plan, made at renewal
        trial_ends_at TEXT,
        grace_ends_at TEXT,
        paused_at TEXT,
        closing_at TEXT,                     -- asked to close: the date it closes (end of what was paid)
        closed_at TEXT,
        delete_after TEXT,
        paid_through TEXT,
        seats INTEGER NOT NULL DEFAULT 0,
        billed_seats INTEGER,
        stripe_customer TEXT, stripe_subscription TEXT, stripe_item TEXT, stripe_status TEXT,
        card_brand TEXT, card_last4 TEXT, card_exp TEXT,
        manual_billing INTEGER NOT NULL DEFAULT 0, -- paid by bank transfer: never paused for an unpaid trial
        comped INTEGER NOT NULL DEFAULT 0,          -- free (your own company): never billed or paused
        reminders TEXT NOT NULL DEFAULT '{}',       -- which lifecycle emails went out
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, at TEXT NOT NULL, amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL, description TEXT, seats INTEGER,
        period_start TEXT, period_end TEXT, stripe_invoice TEXT UNIQUE, receipt_url TEXT, pdf_url TEXT, next_try_at TEXT, failure TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payments_slug ON payments(slug, at);
      CREATE TABLE IF NOT EXISTS company_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_slug ON company_events(slug, at);
      CREATE TABLE IF NOT EXISTS signups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, email TEXT NOT NULL, name TEXT NOT NULL,
        pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, code_hash TEXT, code_sent_at TEXT, code_expires_at TEXT,
        tries INTEGER NOT NULL DEFAULT 0, verified_at TEXT, slug TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS console_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS console_sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, slug TEXT, kind TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT, ok INTEGER NOT NULL, error TEXT
      );
    `);
  }
  // 2: wrong sign-up codes counted over the sign-up's whole life, not just per code sent
  if (v < 2) {
    const cols = db.prepare('PRAGMA table_info(signups)').all().map((c) => c.name);
    if (!cols.includes('wrong_total')) db.exec('ALTER TABLE signups ADD COLUMN wrong_total INTEGER NOT NULL DEFAULT 0');
  }
  if (v < VERSION) db.exec(`PRAGMA user_version = ${VERSION}`);
  return db;
}
module.exports = { openStore };
