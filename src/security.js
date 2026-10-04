import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const fallbackSecret = crypto.randomBytes(32).toString('hex');
const accessCodeCipherVersion = 'v1';

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

export function encryptAccessCode(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', accessCodeEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [accessCodeCipherVersion, iv.toString('base64url'), Buffer.concat([encrypted, tag]).toString('base64url')].join('.');
}

export function decryptAccessCode(value) {
  if (!value) return null;
  try {
    const [version, ivValue, encryptedValue, ...extra] = String(value).split('.');
    if (version !== accessCodeCipherVersion || !ivValue || !encryptedValue || extra.length) return null;
    const iv = decodeBase64Url(ivValue);
    const encryptedWithTag = decodeBase64Url(encryptedValue);
    if (!iv || !encryptedWithTag || iv.length !== 12 || encryptedWithTag.length < 17) return null;
    const encrypted = encryptedWithTag.subarray(0, -16);
    const tag = encryptedWithTag.subarray(-16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', accessCodeEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function accessCodeEncryptionKey() {
  return crypto.createHash('sha256').update(`manar-access-code-v1:${tokenSecret()}`, 'utf8').digest();
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
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
