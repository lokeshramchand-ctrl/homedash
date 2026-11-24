// AES-256-GCM sealing for secrets kept in the database (service tile tokens and passwords). The key is derived with scrypt
// from a server secret; the record id is bound as additional data, so a sealed value cannot be moved to another row.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const SALT = 16, IV = 12, TAG = 16;
const derive = (key: string, salt: Buffer) => scryptSync(key, salt, 32, { N: 16384, r: 8, p: 1 });

export function seal(key: string, aad: string, data: unknown): string {
  const salt = randomBytes(SALT), iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', derive(key, salt), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString('base64');
}

export function unseal<T>(key: string, aad: string, blob: string): T {
  const b = Buffer.from(blob, 'base64');
  if (b.length < SALT + IV + TAG + 2) throw new Error('sealed value is too short');
  const d = createDecipheriv('aes-256-gcm', derive(key, b.subarray(0, SALT)), b.subarray(SALT, SALT + IV));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(SALT + IV, SALT + IV + TAG));
  return JSON.parse(Buffer.concat([d.update(b.subarray(SALT + IV + TAG)), d.final()]).toString('utf8')) as T;
}
