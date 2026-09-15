import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.join(__dirname, '..', 'data', 'manar.db');

export function openDatabase(databasePath = process.env.DATABASE_PATH || defaultPath) {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','supervisor')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_name TEXT NOT NULL,
      assessor_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS access_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      label TEXT,
      code_hash TEXT NOT NULL UNIQUE,
      code_last4 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','used','stopped')),
      expires_at TEXT,
      claimed_at TEXT,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_code_id INTEGER NOT NULL REFERENCES access_codes(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_drafts (
      session_id INTEGER PRIMARY KEY REFERENCES assessment_sessions(id) ON DELETE CASCADE,
      profile TEXT NOT NULL,
      entity_json TEXT NOT NULL DEFAULT '{}',
      answers_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_code_id INTEGER NOT NULL UNIQUE REFERENCES access_codes(id),
      profile TEXT NOT NULL,
      entity_json TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      report_token_hash TEXT NOT NULL UNIQUE,
      recommendations TEXT NOT NULL DEFAULT '',
      improvement_plan TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_assessment_sessions_token ON assessment_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_codes_hash ON access_codes(code_hash);
    CREATE INDEX IF NOT EXISTS idx_reports_token ON results(report_token_hash);
  `);
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  if (!userColumns.includes('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  return db;
}

export async function seedOwner(db) {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) return false;
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return false;
  const passwordHash = await hashPassword(password);
  db.prepare('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(email, passwordHash, 'owner', new Date().toISOString());
  return true;
}
