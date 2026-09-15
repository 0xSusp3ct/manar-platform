import 'dotenv/config';
import { openDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';

const [, , rawEmail, password] = process.argv;
const email = String(rawEmail || '').trim().toLowerCase();
if (!email || !email.includes('@') || !password || password.length < 12) {
  console.error('Usage: pnpm create-admin owner@example.com "a-password-with-12-or-more-characters"');
  process.exit(1);
}

const db = openDatabase();
const passwordHash = await hashPassword(password);
db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, 'owner', ?)
  ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'owner'`)
  .run(email, passwordHash, new Date().toISOString());
db.close();
console.log(`Owner account is ready: ${email}`);
