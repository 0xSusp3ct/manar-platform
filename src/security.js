import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const fallbackSecret = crypto.randomBytes(32).toString('hex');

export function tokenSecret() {
  const configured = process.env.TOKEN_SECRET;
  if (process.env.NODE_ENV === 'production' && (!configured || configured.length < 32)) {
    throw new Error('TOKEN_SECRET must contain at least 32 characters in production.');
  }
  return configured || fallbackSecret;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function createAccessCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(12);
  let value = '';
  for (let index = 0; index < 12; index += 1) value += alphabet[bytes[index] % alphabet.length];
  return `MNR-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

export function hashToken(purpose, value) {
  return crypto.createHmac('sha256', tokenSecret()).update(`${purpose}:${value}`).digest('hex');
}

export function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt, expectedHex] = String(stored || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export function safePublicValue(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function safeMultilineValue(value, max = 8000) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}
