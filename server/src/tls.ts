// Built-in HTTPS. Point it at a certificate you already have (certbot, acme.sh, the Proxmox ACME certificate, your own CA)
// with TLS_CERT_FILE / TLS_KEY_FILE, or set TLS_SELF_SIGNED to let homedash make one for itself. A certificate file that is
// renewed on disk is picked up without a restart. homedash does not talk to Let's Encrypt itself.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import type { Server } from 'node:https';

const env = (k: string) => (process.env[k] ?? '').trim();
const on = (k: string) => ['1', 'true', 'yes', 'on'].includes(env(k).toLowerCase());

export const tlsEnabled = () => !!(env('TLS_CERT_FILE') && env('TLS_KEY_FILE')) || on('TLS_SELF_SIGNED');

/** Pure: "a.lan, 10.0.0.5" -> openssl subjectAltName "DNS:a.lan,IP:10.0.0.5". Only letters, digits, dots, dashes, colons. */
export function sanFor(names: string[]): string {
  const ok = [...new Set(names.map((n) => n.trim()).filter((n) => /^[A-Za-z0-9.:*-]{1,253}$/.test(n)))];
  return ok.map((n) => (isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',');
}
export const defaultNames = (): string[] => {
  const given = env('TLS_NAMES').split(/[\s,]+/).filter(Boolean);
  return given.length ? given : [hostname(), 'localhost', '127.0.0.1'];
};

/** Days of validity left in a PEM certificate (negative = expired), or null when it cannot be read. */
export function daysLeft(pem: Buffer | string): number | null {
  try { return Math.floor((new Date(new X509Certificate(pem).validTo).getTime() - Date.now()) / 86_400_000); } catch { return null; }
}

/** Makes (or reuses) a self-signed certificate in `dir`. Renewed when it has under 30 days left or the names changed. */
export function ensureSelfSigned(dir: string, names = defaultNames()): { cert: string; key: string; created: boolean } {
  const cert = join(dir, 'selfsigned.crt'), key = join(dir, 'selfsigned.key');
  const san = sanFor(names);
  if (!san) throw new Error('TLS_NAMES has no usable host name or address');
  if (existsSync(cert) && existsSync(key)) {
    const pem = readFileSync(cert);
    const left = daysLeft(pem);
    let same = false;
    try { same = san.split(',').every((s) => (new X509Certificate(pem).subjectAltName ?? '').includes(s.replace(/^DNS:/, 'DNS:').replace(/^IP:/, 'IP Address:'))); } catch { /* regenerate */ }
    if (left !== null && left > 30 && same) return { cert, key, created: false };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825', '-keyout', key, '-out', cert, '-subj', '/CN=homedash', '-addext', `subjectAltName=${san}`], { stdio: 'pipe', timeout: 30_000 });
  try { chmodSync(key, 0o600); } catch { /* not supported on this platform */ }
  return { cert, key, created: true };
}

function paths(dbPath: string): { cert: string; key: string } | null {
  if (env('TLS_CERT_FILE') && env('TLS_KEY_FILE')) return { cert: env('TLS_CERT_FILE'), key: env('TLS_KEY_FILE') };
  if (on('TLS_SELF_SIGNED')) { const r = ensureSelfSigned(join(dirname(dbPath), 'tls')); return { cert: r.cert, key: r.key }; }
  return null;
}

/** The options for Fastify's `https`, or null for plain HTTP. Throws a readable error when the files cannot be read. */
export function tlsOptions(dbPath: string): { key: Buffer; cert: Buffer } | null {
  const p = paths(dbPath);
  if (!p) return null;
  try { return { key: readFileSync(p.key), cert: readFileSync(p.cert) }; }
  catch (e) { throw new Error(`HTTPS: cannot read the certificate or key (${(e as Error).message})`); }
}

/** Re-reads the files every few hours so a renewed certificate is used without a restart. */
export function watchTls(server: Server, dbPath: string, log: { info: (m: string) => void; warn: (m: string) => void }) {
  const t = setInterval(() => {
    try {
      const o = tlsOptions(dbPath);
      if (!o) return;
      server.setSecureContext(o);
      const left = daysLeft(o.cert);
      if (left !== null && left < 14) log.warn(`the HTTPS certificate expires in ${left} days`);
    } catch (e) { log.warn(`HTTPS certificate reload failed: ${(e as Error).message}`); }
  }, 6 * 3_600_000);
  t.unref();
}
