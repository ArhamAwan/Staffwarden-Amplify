'use strict';
const { DatabaseSync } = require('node:sqlite');

// Schema v2. Fresh installs and v1 databases go through the same path: the v1 tables are created
// if missing, then migrate() adds everything v2 needs without touching existing rows.
const SCHEMA_VERSION = 33;

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function addColumn(db, table, col, def) {
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','manager','employee')),
      pw_salt TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      consented_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id),
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_te_user ON time_entries(user_id, started_at);
    CREATE TABLE IF NOT EXISTS activity_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
      slot_start TEXT NOT NULL,
      tracked_secs INTEGER NOT NULL,
      active_secs INTEGER NOT NULL,
      top_app TEXT,
      UNIQUE (user_id, slot_start)
    );
    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_start TEXT NOT NULL,
      taken_at TEXT NOT NULL,
      file TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ss_user ON screenshots(user_id, taken_at);
    CREATE TABLE IF NOT EXISTS attendance (  -- v1 table, kept so old databases open; v2 computes attendance
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      clock_in TEXT,
      clock_out TEXT,
      status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','late','leave','absent')),
      UNIQUE (user_id, day)
    );
  `);
  migrate(db);
  return db;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= SCHEMA_VERSION) return;
  if (version === 32) return migrateV33(db);
  if (version === 31) return migrateV32(db);
  if (version === 30) return migrateV31(db);
  if (version === 29) return migrateV30(db);
  if (version === 28) return migrateV29(db);
  if (version === 27) return migrateV28(db);
  if (version === 26) return migrateV27(db);
  if (version === 25) return migrateV26(db);
  if (version === 24) return migrateV25(db);
  if (version === 23) return migrateV24(db);
  if (version === 22) return migrateV23(db);
  if (version === 21) return migrateV22(db);
  if (version === 20) return migrateV21(db);
  if (version === 19) return migrateV20(db);
  if (version === 18) return migrateV19(db);
  if (version === 17) return migrateV18(db);
  if (version === 16) return migrateV17(db);
  if (version === 15) return migrateV16(db);
  if (version === 14) return migrateV15(db);
  if (version === 13) return migrateV14(db);
  if (version === 12) return migrateV13(db);
  if (version === 11) return migrateV12(db);
  if (version === 10) return migrateV11(db);
  if (version === 9) return migrateV10(db);
  if (version === 8) return migrateV9(db);
  if (version === 7) return migrateV8(db);
  if (version === 6) return migrateV7(db);
  if (version === 5) return migrateV6(db);
  if (version === 4) return migrateV5(db);
  if (version === 3) return migrateV4(db);
  if (version >= 2) return migrateV3(db);
  db.exec('BEGIN');
  try {
    // people
    addColumn(db, 'users', 'team_id', 'INTEGER');
    addColumn(db, 'users', 'title', 'TEXT');
    addColumn(db, 'users', 'tracks_time', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'users', 'active', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'users', 'tz_offset_min', 'INTEGER');
    addColumn(db, 'users', 'shift_start', 'TEXT');
    addColumn(db, 'users', 'shift_end', 'TEXT');
    addColumn(db, 'users', 'work_days', 'TEXT');
    addColumn(db, 'users', 'weekly_target_min', 'INTEGER');
    addColumn(db, 'users', 'last_seen_at', 'TEXT');
    // v1: only employees tracked time
    if (version === 0) db.exec("UPDATE users SET tracks_time = CASE WHEN role = 'employee' THEN 1 ELSE 0 END");

    db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS manager_teams (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, team_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS pauses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        reason TEXT NOT NULL DEFAULT 'break'
      );
      CREATE INDEX IF NOT EXISTS idx_pause_entry ON pauses(entry_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_pause_user ON pauses(user_id, started_at);
      CREATE TABLE IF NOT EXISTS leave_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'vacation',
        start_day TEXT NOT NULL,
        end_day TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests(user_id, start_day);
      CREATE TABLE IF NOT EXISTS holidays (day TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_id INTEGER,
        actor_name TEXT,
        action TEXT NOT NULL,
        target_user_id INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
    `);
    addColumn(db, 'projects', 'client', 'TEXT');
    addColumn(db, 'time_entries', 'task_id', 'INTEGER');
    addColumn(db, 'time_entries', 'note', 'TEXT');
    addColumn(db, 'time_entries', 'source', "TEXT NOT NULL DEFAULT 'timer'");
    addColumn(db, 'time_entries', 'stop_reason', 'TEXT');
    addColumn(db, 'time_entries', 'created_by', 'INTEGER');
    addColumn(db, 'screenshots', 'thumb', 'TEXT');
    addColumn(db, 'screenshots', 'entry_id', 'INTEGER');

    // v1 leave marks become approved one-day time off
    if (version === 0) {
      db.exec(`INSERT INTO leave_requests (user_id, kind, start_day, end_day, note, status, decided_at, created_at)
        SELECT user_id, 'vacation', day, day, 'Imported from v1', 'approved', datetime('now'), datetime('now')
        FROM attendance WHERE status = 'leave'`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV3(db);
}

// v3: screenshot frequency per team and per person (null = inherit), privacy marks on screenshots,
// and idle stretches recorded while the timer keeps running.
function migrateV3(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'shots_per_10', 'INTEGER');
    addColumn(db, 'teams', 'shots_per_10', 'INTEGER');
    addColumn(db, 'screenshots', 'privacy', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS idle_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_idle_entry ON idle_periods(entry_id, started_at);
    `);
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV4(db);
}

// v4: real task management (assignee, status, priority, deadline, review, recurrence, comments, files),
// app and website usage with productive/unproductive ratings, and a policy version for re-consent.
// The old tasks table (project_id NOT NULL, name, done) is rebuilt; existing tasks keep their ids.
function migrateV4(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE tasks_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','in_review','done')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
        due_day TEXT,
        estimate_min INTEGER,
        recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekdays','weekly','monthly')),
        recurred_from INTEGER,
        position REAL NOT NULL DEFAULT 0,
        review_rounds INTEGER NOT NULL DEFAULT 0,
        submitted_at TEXT,
        completed_at TEXT,
        approved_by INTEGER,
        first_time INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT
      );
      INSERT INTO tasks_v4 (id, title, project_id, status, completed_at, created_at, position)
        SELECT id, name, project_id, CASE WHEN done THEN 'done' ELSE 'todo' END, CASE WHEN done THEN created_at END, created_at, id FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v4 RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_task_assignee ON tasks(assignee_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_due ON tasks(due_day);
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        user_id INTEGER,
        kind TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tev_task ON task_events(task_id, at);
      CREATE TABLE IF NOT EXISTS task_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tc_task ON task_comments(task_id, created_at);
      CREATE TABLE IF NOT EXISTS task_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL,
        file TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_id INTEGER,
        slot_start TEXT NOT NULL,
        app TEXT NOT NULL,
        site TEXT NOT NULL DEFAULT '',
        secs INTEGER NOT NULL,
        UNIQUE (user_id, slot_start, app, site)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user ON app_usage(user_id, slot_start);
      CREATE TABLE IF NOT EXISTS app_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('app','site')),
        name TEXT NOT NULL,
        rating TEXT NOT NULL CHECK (rating IN ('productive','unproductive','neutral')),
        UNIQUE (kind, name)
      );
    `);
    addColumn(db, 'users', 'consent_version', 'INTEGER NOT NULL DEFAULT 1');
    const rule = db.prepare('INSERT OR IGNORE INTO app_rules (kind, name, rating) VALUES (?,?,?)');
    for (const [k, n, r] of DEFAULT_RULES) rule.run(k, n, r);
    db.exec('PRAGMA user_version = 4');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  migrateV5(db);
}

// A short project key from its name: "Mobile app" -> "MA", "Website" -> "WEB". Always unique.
function projectKey(name, taken) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let base = words.length >= 2 ? words.slice(0, 4).map((w) => w[0]).join('') : (words[0] || 'PRJ').slice(0, 3);
  if (!/^[A-Z]/.test(base)) base = 'P' + base;
  base = base.slice(0, 6);
  let k = base, n = 2;
  while (taken.has(k)) k = (base.slice(0, 5) + n++).slice(0, 6);
  taken.add(k);
  return k;
}

// v5: projects work like Jira / ClickUp spaces: a key (MOB) that numbers their tasks (MOB-12), a lead,
// members, a colour, a description, a deadline and a status. Existing projects stay open to everyone
// (access = 'everyone') so nothing disappears for anyone; new projects are members-only by default.
// Everyone who already has tasks or time on a project becomes a member of it.
function migrateV5(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'projects', 'key', 'TEXT');
    addColumn(db, 'projects', 'description', 'TEXT');
    addColumn(db, 'projects', 'color', 'TEXT');
    addColumn(db, 'projects', 'lead_id', 'INTEGER');
    addColumn(db, 'projects', 'due_day', 'TEXT');
    addColumn(db, 'projects', 'start_day', 'TEXT');
    addColumn(db, 'projects', 'status', "TEXT NOT NULL DEFAULT 'active'");
    addColumn(db, 'projects', 'access', "TEXT NOT NULL DEFAULT 'members'");
    addColumn(db, 'projects', 'task_seq', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'projects', 'created_at', 'TEXT');
    addColumn(db, 'tasks', 'number', 'INTEGER');
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member')),
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pm_user ON project_members(user_id);
    `);
    const COLORS = ['#0E5F88', '#B45309', '#7C3AED', '#0F766E', '#BE185D', '#4F46E5', '#15803D', '#C2410C'];
    const taken = new Set();
    const projects = db.prepare('SELECT id, name, key FROM projects ORDER BY id').all();
    for (const p of projects) if (p.key) taken.add(p.key);
    const upd = db.prepare("UPDATE projects SET key = COALESCE(key, ?), color = COALESCE(color, ?), access = 'everyone', created_at = COALESCE(created_at, datetime('now')) WHERE id = ?");
    const addM = db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')");
    const num = db.prepare('UPDATE tasks SET number = ? WHERE id = ?');
    projects.forEach((p, i) => {
      upd.run(p.key || projectKey(p.name, taken), COLORS[i % COLORS.length], p.id);
      const people = db.prepare(`SELECT assignee_id AS u FROM tasks WHERE project_id = ? AND assignee_id IS NOT NULL
        UNION SELECT user_id FROM time_entries WHERE project_id = ?`).all(p.id, p.id);
      for (const r of people) if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(r.u)) addM.run(p.id, r.u);
      const ts = db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').all(p.id);
      ts.forEach((t, k) => num.run(k + 1, t.id));
      db.prepare('UPDATE projects SET task_seq = ? WHERE id = ?').run(ts.length, p.id);
    });
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_project_key ON projects(key)');
    db.exec('PRAGMA user_version = 5');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV6(db);
}

// v6: notifications. One row per person per event, shown in the dashboard bell, as browser pop-ups
// and as desktop-app pop-ups. Each person can switch kinds off (users.notify_prefs, JSON).
function migrateV6(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'notify_prefs', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        link TEXT,
        actor_id INTEGER,
        dedupe TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(user_id, dedupe) WHERE dedupe IS NOT NULL;
    `);
    db.exec('PRAGMA user_version = 6');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV7(db);
}

// v7: which apps and sites people use is no longer tracked. Everything recorded about it is deleted,
// and session tokens are kept only as hashes (a copied database cannot be used to sign in).
function migrateV7(db) {
  db.exec('BEGIN');
  try {
    db.exec('DROP TABLE IF EXISTS app_usage; DROP TABLE IF EXISTS app_rules;');
    addColumn(db, 'sessions', 'last_used_at', 'TEXT');
    // existing sessions: replace each token with its hash, so people stay signed in
    const crypto = require('node:crypto');
    const rows = db.prepare('SELECT token FROM sessions').all();
    const upd = db.prepare('UPDATE sessions SET token = ? WHERE token = ?');
    for (const r of rows) if (!/^h:/.test(r.token)) upd.run('h:' + crypto.createHash('sha256').update(r.token).digest('hex'), r.token);
    db.exec('PRAGMA user_version = 7');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV8(db);
}

// v8: a scheduled break per person (null = the company's), next to their shift.
function migrateV8(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'break_start', 'TEXT');
    addColumn(db, 'users', 'break_end', 'TEXT');
    db.exec('PRAGMA user_version = 8');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV9(db);
}

// v9: which version of the desktop app each person last used, so the owner can see who needs to update.
function migrateV9(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'app_version', 'TEXT');
    addColumn(db, 'users', 'app_platform', 'TEXT');
    db.exec('PRAGMA user_version = 9');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV10(db);
}

// v10: who opened each screenshot full size, so the person in it can see who looked.
function migrateV10(db) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS shot_views (
      shot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
      viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      first_at TEXT NOT NULL, last_at TEXT NOT NULL, times INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (shot_id, viewer_id)
    )`);
    db.exec('PRAGMA user_version = 10');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV11(db);
}

// v11: people who do their work on another device (an iPad, say) while the desktop app keeps their timer.
// For them the app keeps the computer awake while the timer runs, does not mark idle time and does not
// measure keyboard and mouse activity (it would only measure the unused computer).
function migrateV11(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'other_device', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('PRAGMA user_version = 11');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV12(db);
}

// v12: different hours on some days for one person (a half day on Saturday, say). JSON keyed by weekday
// (0 = Sunday): {"6": {"shift_start": "18:00", "shift_end": "23:00", "break_start": null, "break_end": null}}.
function migrateV12(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'day_hours', 'TEXT');
    db.exec('PRAGMA user_version = 12');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV13(db);
}

// v13: transparency. `changes` is every change made to a person's tracking, schedule or time, by whom and
// why (they are told about each one). `notes` are their own explanations of a late start, an idle stretch,
// a screenshot or a whole day. `time_requests` are corrections they ask a manager to approve.
// `consent_terms` is what was being captured when they last agreed, so they can see what changed since.
function migrateV13(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'consent_terms', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      area TEXT NOT NULL, title TEXT NOT NULL, lines TEXT NOT NULL DEFAULT '[]', reason TEXT,
      created_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_changes_user ON changes(user_id, created_at)');
    db.exec(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (user_id, kind, ref)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_day ON notes(user_id, day)');
    db.exec(`CREATE TABLE IF NOT EXISTS time_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT, decision_note TEXT,
      entry_id INTEGER, created_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_treq_user ON time_requests(user_id, day)');
    db.exec('PRAGMA user_version = 13');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV14(db);
}

// v14: time zones by place (America/New_York) rather than a fixed offset, so daylight saving is followed.
// `tz_name` wins over the old `tz_offset_min` when set. `seen_tz` is the zone the person's own computer
// reported when they last used Staffwarden, shown to managers as a suggestion.
function migrateV14(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'tz_name', 'TEXT');
    addColumn(db, 'users', 'seen_tz', 'TEXT');
    db.exec('PRAGMA user_version = 14');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV15(db);
}

// v15: HR and payroll. `users.hr` marks people in HR (they see records and pay, never screenshots or
// activity). Amounts are whole units of the person's currency (rupees or dollars).
function migrateV15(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'hr', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS hr_records (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      contract TEXT NOT NULL DEFAULT 'full_time', joined_on TEXT, probation_end TEXT, notice_days INTEGER,
      bank_name TEXT, account_title TEXT, iban TEXT, emergency_name TEXT, emergency_phone TEXT, phone TEXT, cnic TEXT, address TEXT,
      leaving_on TEXT, leaving_reason TEXT, notes TEXT, updated_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS pay_setup (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      base INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'PKR', tax_mode TEXT NOT NULL DEFAULT 'pk',
      allowances TEXT NOT NULL DEFAULT '[]', deductions TEXT NOT NULL DEFAULT '[]', updated_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS salary_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      base INTEGER NOT NULL, currency TEXT NOT NULL, effective_from TEXT NOT NULL, note TEXT,
      by_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS pay_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'draft',
      rules TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL,
      submitted_by INTEGER, submitted_at TEXT, approved_by INTEGER, approved_at TEXT, paid_by INTEGER, paid_at TEXT, paid_ref TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS payslips (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, currency TEXT NOT NULL,
      lines TEXT NOT NULL, gross INTEGER NOT NULL, deductions INTEGER NOT NULL, tax INTEGER NOT NULL, net INTEGER NOT NULL,
      employer TEXT NOT NULL DEFAULT '[]', facts TEXT NOT NULL DEFAULT '{}', by_hand INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      UNIQUE (run_id, user_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS pay_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, label TEXT NOT NULL,
      amount INTEGER NOT NULL, reason TEXT NOT NULL, by_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS pay_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, payslip_id INTEGER NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, line TEXT, text TEXT NOT NULL,
      answer TEXT, answered_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, answered_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL, months INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending',
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT, decision_note TEXT, paid_run INTEGER, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL, currency TEXT NOT NULL, category TEXT NOT NULL, spent_on TEXT NOT NULL, note TEXT NOT NULL,
      receipt TEXT, receipt_type TEXT, status TEXT NOT NULL DEFAULT 'pending',
      manager_by INTEGER, manager_at TEXT, decided_by INTEGER, decided_at TEXT, decline_reason TEXT, run_id INTEGER, created_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_exp_user ON expenses(user_id, status)');
    db.exec(`CREATE TABLE IF NOT EXISTS hr_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other', file TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'kept', expires_on TEXT, uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS hr_steps (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, flow TEXT NOT NULL, step TEXT NOT NULL,
      done_at TEXT, done_by INTEGER REFERENCES users(id) ON DELETE SET NULL, PRIMARY KEY (user_id, flow, step)
    )`);
    db.exec('PRAGMA user_version = 15');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV16(db);
}

// v16: the client portal. Clients sign in with their own accounts (client_users, never in `users`, so they
// can never show up in staff lists, payroll or attendance). A project can belong to one client. Chat
// messages, reactions and reads name their author as staff or client (`author_kind`).
function migrateV16(db) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT, tz_name TEXT, retainer_hours INTEGER,
      settings TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS client_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, title TEXT, pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL,
      can_approve INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, joined_at TEXT, last_seen_at TEXT,
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS client_sessions (
      token TEXT PRIMARY KEY, client_user_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT
    )`);
    addColumn(db, 'projects', 'client_id', 'INTEGER REFERENCES clients(id) ON DELETE SET NULL');
    // whose chat, requests and sign-offs the project holds, so they never pass to a different client
    addColumn(db, 'projects', 'portal_client_id', 'INTEGER');
    addColumn(db, 'tasks', 'client_visible', 'INTEGER');          // null: the client's setting decides; 1 shared; 0 team only
    addColumn(db, 'task_comments', 'client_user_id', 'INTEGER REFERENCES client_users(id) ON DELETE SET NULL');
    addColumn(db, 'task_comments', 'team_only', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('group','direct')), staff_id INTEGER NOT NULL DEFAULT 0, client_user_id INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, UNIQUE (project_id, kind, staff_id, client_user_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('staff','client')), author_id INTEGER NOT NULL,
      body TEXT NOT NULL DEFAULT '', reply_to INTEGER, team_only INTEGER NOT NULL DEFAULT 0,
      file TEXT, file_name TEXT, file_type TEXT, file_size INTEGER, voice_secs INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0, edited_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread_id, id)');
    db.exec(`CREATE TABLE IF NOT EXISTS chat_reactions (
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, author_kind TEXT NOT NULL, author_id INTEGER NOT NULL,
      emoji TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (message_id, author_kind, author_id, emoji)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chat_reads (
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, author_kind TEXT NOT NULL, author_id INTEGER NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (thread_id, author_kind, author_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS client_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      client_user_id INTEGER REFERENCES client_users(id) ON DELETE SET NULL, title TEXT NOT NULL, detail TEXT,
      urgency TEXT NOT NULL DEFAULT 'month', status TEXT NOT NULL DEFAULT 'new', reply TEXT, task_id INTEGER,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'approval' CHECK (kind IN ('approval','file')), title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'waiting', due_day TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, closed_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS approval_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
      n INTEGER NOT NULL, body TEXT, changes TEXT, file TEXT, file_name TEXT, file_type TEXT, file_size INTEGER,
      by_kind TEXT NOT NULL DEFAULT 'staff', by_id INTEGER, created_at TEXT NOT NULL,
      decision TEXT, decision_note TEXT, decided_by INTEGER, decided_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, start_day TEXT, due_day TEXT, done_at TEXT, position INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS project_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL, intro TEXT NOT NULL, done TEXT NOT NULL DEFAULT '[]',
      next TEXT NOT NULL DEFAULT '[]', needed TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    )`);
    db.exec('PRAGMA user_version = 16');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV17(db);
}

// v17: requests from a client say what kind they are (a change, something new, a problem), can carry a
// file, and remember when the team first saw them, so the client knows it landed.
function migrateV17(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'client_requests', 'kind', "TEXT NOT NULL DEFAULT 'new'");
    for (const c of ['file TEXT', 'file_name TEXT', 'file_type TEXT', 'file_size INTEGER', 'seen_at TEXT', 'seen_by INTEGER']) addColumn(db, 'client_requests', c.split(' ')[0], c.split(' ')[1]);
    db.exec('PRAGMA user_version = 17');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV18(db);
}

// v18: portal v2. Clients get their own bell (client_notifications) and phone notifications (push_subs,
// for staff too). Milestones get a rating from the client and tasks can sit under a milestone, with
// steps. Calls with the client (meetings) carry an agenda and notes. Requests get a thread, an estimate
// the client answers, and can be edited or cancelled. Task comments can carry a file. Approvals get
// comments pinned to a spot on a version, and remember when the client was last reminded. Chat
// messages carry a key from the sender (so a message sent again after being offline is kept once) and
// a PDF's page count. The weekly update can be scheduled.
function migrateV18(db) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS client_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_user_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, project_id INTEGER, dedupe TEXT, created_at TEXT NOT NULL, read_at TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_cn_user ON client_notifications(client_user_id, id)');
    db.exec(`CREATE TABLE IF NOT EXISTS milestone_ratings (
      milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE, client_user_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
      stars INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL, PRIMARY KEY (milestone_id, client_user_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, starts_at TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 30, link TEXT, agenda TEXT NOT NULL DEFAULT '[]',
      notes TEXT, notes_by INTEGER REFERENCES users(id) ON DELETE SET NULL, notes_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, cancelled_at TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_meet_project ON meetings(project_id, starts_at)');
    db.exec(`CREATE TABLE IF NOT EXISTS request_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
      author_kind TEXT NOT NULL, author_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    for (const c of ['estimate_hours REAL', 'estimate_note TEXT', 'estimate_by INTEGER', 'estimate_at TEXT', 'estimate_answer TEXT', 'answered_at TEXT', 'edited_at TEXT', 'cancelled_at TEXT']) addColumn(db, 'client_requests', c.split(' ')[0], c.split(' ')[1]);
    for (const c of ['file TEXT', 'file_name TEXT', 'file_type TEXT', 'file_size INTEGER']) addColumn(db, 'task_comments', c.split(' ')[0], c.split(' ')[1]);
    db.exec(`CREATE TABLE IF NOT EXISTS task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL, done_at TEXT, position INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_steps_task ON task_steps(task_id, position)');
    addColumn(db, 'tasks', 'milestone_id', 'INTEGER');
    db.exec(`CREATE TABLE IF NOT EXISTS approval_pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL REFERENCES approval_versions(id) ON DELETE CASCADE,
      x REAL NOT NULL, y REAL NOT NULL, body TEXT NOT NULL, author_kind TEXT NOT NULL, author_id INTEGER NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
    )`);
    addColumn(db, 'approvals', 'reminded_at', 'TEXT');
    addColumn(db, 'chat_messages', 'client_key', 'TEXT');
    addColumn(db, 'chat_messages', 'file_pages', 'INTEGER');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_key ON chat_messages(thread_id, author_kind, author_id, client_key) WHERE client_key IS NOT NULL');
    db.exec(`CREATE TABLE IF NOT EXISTS link_previews (
      url TEXT PRIMARY KEY, ok INTEGER NOT NULL DEFAULT 0, title TEXT, description TEXT, site TEXT, fetched_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_kind TEXT NOT NULL CHECK (owner_kind IN ('staff','client')), owner_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT, created_at TEXT NOT NULL, last_ok_at TEXT, fails INTEGER NOT NULL DEFAULT 0
    )`);
    addColumn(db, 'client_users', 'notify_prefs', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS update_schedules (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, on_ INTEGER NOT NULL DEFAULT 1, dow INTEGER NOT NULL DEFAULT 5,
      time TEXT NOT NULL DEFAULT '16:00', author_id INTEGER REFERENCES users(id) ON DELETE SET NULL, intro TEXT,
      last_sent_day TEXT, reminded_day TEXT, updated_at TEXT
    )`);
    db.exec('PRAGMA user_version = 18');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV19(db);
}

// v19: everything in one place. The team's own chat (everyone at the company, channels, groups and direct
// messages) shares the chat tables with the client chats: a thread with no project is a team thread.
// Replies in threads, @mentions, messages made into tasks; notifications that know which device they go
// to and stay quiet outside the shift; end-of-shift check-ins, announcements with who has read them, the
// owner's boost, nudges when someone is idle or barely active, and fun modes that only change the look.
function migrateV19(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE chat_threads_v19 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, staff_id INTEGER NOT NULL DEFAULT 0, client_user_id INTEGER NOT NULL DEFAULT 0,
      name TEXT, topic TEXT, created_by INTEGER, private INTEGER NOT NULL DEFAULT 0, post_policy TEXT NOT NULL DEFAULT 'all',
      dm_key TEXT UNIQUE, archived_at TEXT, created_at TEXT NOT NULL, UNIQUE (project_id, kind, staff_id, client_user_id)
    )`);
    db.exec('INSERT INTO chat_threads_v19 (id, project_id, kind, staff_id, client_user_id, created_at) SELECT id, project_id, kind, staff_id, client_user_id, created_at FROM chat_threads');
    db.exec('DROP TABLE chat_threads');
    db.exec('ALTER TABLE chat_threads_v19 RENAME TO chat_threads');
    db.exec(`CREATE TABLE IF NOT EXISTS team_members (
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member', mute TEXT NOT NULL DEFAULT 'none', muted_until TEXT, joined_at TEXT NOT NULL, PRIMARY KEY (thread_id, user_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_team_member_user ON team_members(user_id)');
    for (const c of ['parent_id INTEGER', 'task_id INTEGER', 'kind TEXT', 'meta TEXT']) addColumn(db, 'chat_messages', c.split(' ')[0], c.split(' ')[1]);
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_parent ON chat_messages(parent_id) WHERE parent_id IS NOT NULL');
    db.exec(`CREATE TABLE IF NOT EXISTS chat_mentions (
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, PRIMARY KEY (message_id, user_id)
    )`);
    addColumn(db, 'notifications', 'desktop', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'notifications', 'in_bell', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'tasks', 'source_message_id', 'INTEGER');
    addColumn(db, 'push_subs', 'label', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      confirm INTEGER NOT NULL DEFAULT 1, remind_after_h INTEGER, audience TEXT, message_id INTEGER, reminded_at TEXT, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS announcement_reads (
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seen_at TEXT, confirmed_at TEXT, PRIMARY KEY (announcement_id, user_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
      did TEXT NOT NULL DEFAULT '', next TEXT NOT NULL DEFAULT '', blockers TEXT, mood TEXT, tracked_secs INTEGER NOT NULL DEFAULT 0, breakdown TEXT,
      created_at TEXT NOT NULL, updated_at TEXT, UNIQUE (user_id, day)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS boosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER REFERENCES users(id) ON DELETE SET NULL, vibe TEXT NOT NULL, line TEXT NOT NULL,
      message_id INTEGER, sent_to INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS boost_answers (
      boost_id INTEGER NOT NULL REFERENCES boosts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (boost_id, user_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS boost_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vibe TEXT NOT NULL, line TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS idle_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      started_at TEXT NOT NULL, idle_id INTEGER, asked_at TEXT, answer TEXT, answered_at TEXT, alerted_at TEXT, cleared_at TEXT, detail TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_idle_flags_user ON idle_flags(user_id, cleared_at)');
    for (const c of ['fun_mode TEXT', 'fun_until TEXT', 'fun_calm INTEGER', 'fun_xp2_until TEXT', 'fun_intro_seen INTEGER']) addColumn(db, 'users', c.split(' ')[0], c.split(' ')[1]);
    db.exec(`PRAGMA user_version = 19`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
  migrateV20(db);
}

// v20: double ticks (delivered to a device) and the boost clip in the corner of the desktop app.
// These run as their own step so databases already on v19 pick them up.
function migrateV20(db) {
  db.exec('BEGIN');
  try {
    // delivered: the newest message that reached one of the person's devices (web or desktop app), for double ticks
    db.exec(`CREATE TABLE IF NOT EXISTS chat_delivered (
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, author_kind TEXT NOT NULL, author_id INTEGER NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (thread_id, author_kind, author_id)
    )`);
    // the boost clip: Basit powering up in the corner of their laptop (desktop app), at most 3 a shift each
    addColumn(db, 'boosts', 'clip', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS boost_popups (
      boost_id INTEGER NOT NULL REFERENCES boosts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at TEXT NOT NULL, PRIMARY KEY (boost_id, user_id)
    )`);
    addColumn(db, 'users', 'boost_popup', "TEXT NOT NULL DEFAULT 'clip'");
    addColumn(db, 'users', 'boost_corner', "TEXT NOT NULL DEFAULT 'right'");
    db.exec('PRAGMA user_version = 20');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV21(db);
}

// v21: the owner can turn the boost show off for chosen people (no clip on their laptop, no full-screen
// show in the browser); they still get the boost as an ordinary notification and in the company chat.
function migrateV21(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'boost_quiet', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('PRAGMA user_version = 21');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV22(db);
}

// v22: developer access. The owner can give someone the developer tools (server health, desktop apps and
// releases, error reports, feature switches, test tools); never screenshots, pay, HR records or messages.
function migrateV22(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'is_dev', 'INTEGER NOT NULL DEFAULT 0');
    // what went wrong, grouped by kind of problem (never screenshots, window titles or anything typed)
    db.exec(`CREATE TABLE IF NOT EXISTS error_groups (
      sig TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, version TEXT, platform TEXT,
      count INTEGER NOT NULL DEFAULT 0, first_at TEXT NOT NULL, last_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', fixed_in TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS error_people (
      sig TEXT NOT NULL REFERENCES error_groups(sig) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      count INTEGER NOT NULL DEFAULT 0, last_at TEXT NOT NULL, PRIMARY KEY (sig, user_id)
    )`);
    // feature switches: off, a beta group, or everyone
    db.exec(`CREATE TABLE IF NOT EXISTS features (key TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'everyone', beta TEXT NOT NULL DEFAULT '[]', updated_at TEXT)`);
    db.exec('PRAGMA user_version = 22');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV23(db);
}

// v23: test boosts. A test boost a developer sends (to themselves or one person) is never counted towards
// anyone's three a shift and never shown as the last boost.
function migrateV23(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'boosts', 'test', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('PRAGMA user_version = 23');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV24(db);
}

// v24: accounts that are not employees (developer and test accounts). HR marks them, or a developer account
// whose time is not tracked counts as one until HR says otherwise. They are kept off payroll and HR's reminders.
function migrateV24(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'hr_records', 'employed', 'INTEGER');
    db.exec('PRAGMA user_version = 24');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV25(db);
}

// v25: each person is paid on their own day between the 1st and the 10th. A payslip keeps the day it was
// paid; the month is paid once everyone on it is. Months already marked paid count everyone paid that day.
function migrateV25(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'payslips', 'paid_on', 'TEXT');
    addColumn(db, 'payslips', 'paid_ref', 'TEXT');
    addColumn(db, 'payslips', 'paid_by', 'INTEGER');
    db.exec("UPDATE payslips SET paid_on = (SELECT substr(paid_at, 1, 10) FROM pay_runs r WHERE r.id = payslips.run_id), paid_ref = (SELECT paid_ref FROM pay_runs r WHERE r.id = payslips.run_id) WHERE paid_on IS NULL AND run_id IN (SELECT id FROM pay_runs WHERE status = 'paid')");
    db.exec('PRAGMA user_version = 25');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV26(db);
}

// v26: date of birth on the HR record, and HR asking someone to update their own details (which ones,
// why, who asked, when). Until HR asks, people can't change their record themselves.
function migrateV26(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'hr_records', 'dob', 'TEXT');
    addColumn(db, 'hr_records', 'upd_fields', 'TEXT');
    addColumn(db, 'hr_records', 'upd_note', 'TEXT');
    addColumn(db, 'hr_records', 'upd_by', 'INTEGER');
    addColumn(db, 'hr_records', 'upd_at', 'TEXT');
    db.exec('PRAGMA user_version = 26');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV27(db);
}

// v27: the task page. A task can say whether it needs approval (empty: the company setting decides),
// "Done when" checks the approver ticks, links handed in as work, and what kind a comment is
// (a comment, a progress update, or review feedback).
function migrateV27(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'tasks', 'needs_review', 'INTEGER');
    addColumn(db, 'task_comments', 'kind', "TEXT NOT NULL DEFAULT 'comment'");
    db.exec(`CREATE TABLE IF NOT EXISTS task_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL, position REAL NOT NULL DEFAULT 0, checked_by INTEGER, checked_at TEXT, created_by INTEGER, created_at TEXT NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_checks_task ON task_checks(task_id, position)');
    db.exec(`CREATE TABLE IF NOT EXISTS task_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER, url TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_links_task ON task_links(task_id, id)');
    db.exec('PRAGMA user_version = 27');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV28(db);
}

// Versions of a piece of work (V1, V2…), comments pinned to a spot on a picture or a PDF page,
// and a count for tasks measured in numbers ("12 of 20 called") with a note on how it went.
function migrateV28(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'task_files', 'chain_id', 'INTEGER');     // every version of one piece of work shares the first version's id
    addColumn(db, 'task_files', 'version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'task_files', 'label', 'TEXT');           // "Static 1", "Payslip"; the file name when empty
    addColumn(db, 'task_files', 'note', 'TEXT');            // what changed in this version
    addColumn(db, 'task_files', 'round', 'INTEGER');        // the review round it was handed in for
    db.exec('UPDATE task_files SET chain_id = id WHERE chain_id IS NULL');
    db.exec(`CREATE TABLE IF NOT EXISTS task_pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES task_files(id) ON DELETE CASCADE, chain_id INTEGER NOT NULL,
      page INTEGER NOT NULL DEFAULT 1, x REAL NOT NULL, y REAL NOT NULL, num INTEGER NOT NULL,
      user_id INTEGER, body TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      resolved_at TEXT, resolved_by INTEGER)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pins_task ON task_pins(task_id, chain_id, num)');
    db.exec(`CREATE TABLE IF NOT EXISTS task_pin_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pin_id INTEGER NOT NULL REFERENCES task_pins(id) ON DELETE CASCADE,
      user_id INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pinr_pin ON task_pin_replies(pin_id, id)');
    addColumn(db, 'tasks', 'count_target', 'INTEGER');
    addColumn(db, 'tasks', 'count_done', 'INTEGER');
    addColumn(db, 'tasks', 'count_unit', 'TEXT');
    addColumn(db, 'tasks', 'outcome', 'TEXT');
    db.exec('PRAGMA user_version = 28');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV29(db);
}

// Assets: everything for one client in one place (logos, colours, fonts, links, files, where logins are kept,
// notes). They belong to the client; a project with no client keeps its own until it is linked to one.
function migrateV29(db) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      section TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      url TEXT, value TEXT, note TEXT,
      file TEXT, file_name TEXT, mime TEXT, size INTEGER,
      chain_id INTEGER, version INTEGER NOT NULL DEFAULT 1,
      shared INTEGER NOT NULL DEFAULT 0,
      source_task_id INTEGER, source_file_id INTEGER, source_chain_id INTEGER,
      created_by INTEGER, client_user_id INTEGER, seen_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_client ON assets(client_id, section)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, section)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source_task_id)');
    db.exec('PRAGMA user_version = 29');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV30(db);
}

// Starting ratings. Anything not listed is neutral until a manager rates it.
const DEFAULT_RULES = [
  ...['Instagram', 'Facebook', 'TikTok', 'X (Twitter)', 'Reddit', 'Snapchat', 'Pinterest', 'Netflix', 'Twitch', 'Threads', '9GAG', 'Daraz', 'AliExpress', 'Cricbuzz', 'ESPNcricinfo']
    .map((n) => ['site', n, 'unproductive']),
  ...['GitHub', 'GitLab', 'Bitbucket', 'Stack Overflow', 'Jira', 'Trello', 'Notion', 'Figma', 'Google Docs', 'Google Sheets', 'Google Slides', 'Google Drive', 'Gmail', 'Outlook', 'Microsoft Teams', 'Slack', 'Zoom', 'Google Meet', 'ChatGPT', 'Claude', 'Canva', 'Workhelm', 'Staffwarden', 'ClickUp', 'Asana', 'Upwork']
    .map((n) => ['site', n, 'productive']),
  ...['Visual Studio Code', 'Visual Studio', 'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Android Studio', 'Xcode', 'Terminal', 'iTerm', 'Windows Terminal', 'PowerShell', 'Figma', 'Slack', 'Microsoft Teams', 'Zoom', 'Word', 'Excel', 'PowerPoint', 'Outlook', 'Mail', 'Notion', 'Photoshop', 'Illustrator', 'Premiere Pro', 'After Effects', 'Blender', 'Postman', 'Docker Desktop', 'Workhelm', 'Staffwarden', 'UiPath Studio', 'Cursor']
    .map((n) => ['app', n, 'productive']),
  ...['Steam', 'Netflix', 'Epic Games Launcher']
    .map((n) => ['app', n, 'unproductive']),
];

// Payroll: a line worked out from attendance or a rule can be taken off one person's month by HR, with a
// reason. It stays on the payslip, not counted, saying who removed it and why; undo puts it back.
function migrateV30(db) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS pay_waivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, line_key TEXT NOT NULL,
      reason TEXT NOT NULL, by_id INTEGER, created_at TEXT NOT NULL,
      UNIQUE (run_id, user_id, line_key))`);
    db.exec('PRAGMA user_version = 30');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV31(db);
}

// Company branding: when a month is approved, the company's details at that moment are kept with it, so
// payslips already sent keep the logo, address and signature they went out with.
function migrateV31(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'pay_runs', 'company', 'TEXT');
    db.exec('PRAGMA user_version = 31');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV32(db);
}

// Projects run by their manager: each project has a manager (lead_id) and a stand-in (deputy_id) who
// approves and plans when the manager is away or did the work. The manager plans each person's day
// (task_plans, and plan_sends for when that day was sent), and people are @mentioned on tasks
// (task_mentions, so editing a text never mentions the same person twice).
function migrateV32(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'projects', 'deputy_id', 'INTEGER');
    db.exec(`CREATE TABLE IF NOT EXISTS task_plans (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      day TEXT NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER,
      position REAL NOT NULL DEFAULT 0, planned_by INTEGER, planned_at TEXT NOT NULL,
      PRIMARY KEY (task_id, day))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plans_user ON task_plans(user_id, day)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plans_project ON task_plans(project_id, day)');
    db.exec(`CREATE TABLE IF NOT EXISTS plan_sends (
      project_id INTEGER NOT NULL, day TEXT NOT NULL, sent_at TEXT NOT NULL, sent_by INTEGER,
      PRIMARY KEY (project_id, day))`);
    db.exec(`CREATE TABLE IF NOT EXISTS task_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, by_id INTEGER, kind TEXT NOT NULL, ref_id INTEGER,
      created_at TEXT NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mentions_task ON task_mentions(task_id, kind, ref_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mentions_user ON task_mentions(user_id, created_at)');
    db.exec('PRAGMA user_version = 32');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  migrateV33(db);
}

// Colour themes: the one each person picked (null = the company's default, set by the owner).
function migrateV33(db) {
  db.exec('BEGIN');
  try {
    addColumn(db, 'users', 'theme', 'TEXT');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, SCHEMA_VERSION, DEFAULT_RULES, projectKey };
