// Two-step sign-in primitives: RFC 6238 TOTP, sealed secrets, recovery codes and the pending-session gate.
// Pure (no database or config import) so tests can load it without MongoDB. The key is read lazily from MFA_KEY.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = (): string => base32Encode(randomBytes(20));

const STEP_MS = 30_000;
const stepOf = (unixMs: number) => Math.floor(unixMs / STEP_MS);

function codeForStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const totpAt = (secretBase32: string, unixMs: number): string => codeForStep(secretBase32, stepOf(unixMs));

/** The step a 6-digit code matches (now-1 .. now+1), or null. A step <= lastStep never matches (replay). */
export function matchStep(secretBase32: string, code: string, unixMs: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = stepOf(unixMs);
  let found: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    const ok = timingSafeEqual(Buffer.from(codeForStep(secretBase32, step)), given);
    if (ok && step > lastStep && found === null) found = step;
  }
  return found;
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}

let keyCache: Buffer | undefined;
let keyFor = '';
function key(): Buffer {
  const k = process.env.MFA_KEY ?? '';
  if (k.length < 32) throw new Error('MFA_KEY is not set');
  if (!keyCache || keyFor !== k) { keyCache = scryptSync(k, 'homedash/mfa/v1', 32); keyFor = k; }
  return keyCache;
}

export function sealSecret(secretBase32: string, userId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(secretBase32, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function openSecret(sealed: string, userId: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(userId));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRecoveryCodes(n = 10): string[] {
  const one = () => Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  const out = new Set<string>();
  while (out.size < n) { const c = one(); out.add(`${c.slice(0, 5)}-${c.slice(5)}`); }
  return [...out];
}
export const hashRecovery = (code: string): string =>
  createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

export type MfaState = 'ok' | 'pending' | 'enroll';
export type MfaVerdict = 'allow' | 'MFA_REQUIRED' | 'MFA_ENROLL_REQUIRED';

const PENDING_OK = new Set(['POST /api/auth/mfa/verify', 'POST /api/auth/logout']);
const ENROLL_OK = new Set([
  'GET /api/auth/me', 'GET /api/auth/mfa', 'POST /api/auth/mfa/setup', 'POST /api/auth/mfa/enable', 'POST /api/auth/logout',
]);

/** What a session in `state` may do. `path` must already be decoded; exact matches only. */
export function mfaGate(state: MfaState, method: string, path: string): MfaVerdict {
  if (state === 'ok') return 'allow';
  const k = `${method} ${path}`;
  if (state === 'pending') return PENDING_OK.has(k) ? 'allow' : 'MFA_REQUIRED';
  return ENROLL_OK.has(k) ? 'allow' : 'MFA_ENROLL_REQUIRED';
}
