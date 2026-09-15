export const SCHEMA_STATEMENTS = [
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    entity_name TEXT NOT NULL,
    assessor_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    status TEXT DEFAULT 'pending' NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS access_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    request_id INTEGER,
    label TEXT,
    code_hash TEXT NOT NULL,
    code_last4 TEXT NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL,
    expires_at TEXT,
    claimed_at TEXT,
    used_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE SET NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS access_codes_code_hash_unique ON access_codes (code_hash)",
  `CREATE TABLE IF NOT EXISTS assessment_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    access_code_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (access_code_id) REFERENCES access_codes(id) ON DELETE CASCADE
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS assessment_sessions_token_hash_unique ON assessment_sessions (token_hash)",
  `CREATE TABLE IF NOT EXISTS assessment_drafts (
    session_id INTEGER PRIMARY KEY NOT NULL,
    profile TEXT NOT NULL,
    entity_json TEXT DEFAULT '{}' NOT NULL,
    answers_json TEXT DEFAULT '{}' NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES assessment_sessions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY NOT NULL,
    count INTEGER DEFAULT 0 NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires_at)",
  `CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    access_code_id INTEGER NOT NULL,
    profile TEXT NOT NULL,
    entity_json TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    report_token_hash TEXT NOT NULL,
    recommendations TEXT DEFAULT '' NOT NULL,
    improvement_plan TEXT DEFAULT '' NOT NULL,
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (access_code_id) REFERENCES access_codes(id)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS results_access_code_id_unique ON results (access_code_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS results_report_token_hash_unique ON results (report_token_hash)",
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'owner' NOT NULL,
    active INTEGER DEFAULT 1 NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)",
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON sessions (token_hash)",
];
