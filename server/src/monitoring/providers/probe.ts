// Service checks: homedash itself looks at a list of addresses, so anything can be watched without the tool's own API.
// One line per check: `name | type | address`, where type is http (a web address), tcp (host:port) or tls (host[:port], certificate expiry).
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { assertDestinationAllowed } from '../../datasources/netguard.js';
import type { ConnConfig } from '../../datasources/core/types.js';
import type { LoadedSource } from '../store.js';
import type { Check, Polled, Provider } from '../types.js';
import { requestText } from './http.js';

export interface Target { name: string; type: 'http' | 'tcp' | 'tls'; address: string }
export const MAX_TARGETS = 50;
const TIMEOUT_MS = 5000;
const WARN_DAYS = 14;

/** Pure: the targets text to targets. Blank lines and lines starting with # are skipped; a bad line is an error naming it. */
export function parseTargets(text: string | undefined): Target[] {
  const out: Target[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length !== 3 || !parts[0] || !parts[2]) throw new Error(`"${line.slice(0, 50)}" should look like: name | type | address`);
    const type = parts[1].toLowerCase();
    if (type !== 'http' && type !== 'tcp' && type !== 'tls') throw new Error(`"${parts[1].slice(0, 20)}" is not a type (use http, tcp or tls)`);
    if (type === 'http' && !/^https?:\/\/[^\s/]+/.test(parts[2])) throw new Error(`"${parts[2].slice(0, 40)}" is not a web address (start with http:// or https://)`);
    if (type !== 'http' && !/^[A-Za-z0-9._-]+(:\d{1,5})?$/.test(parts[2]) && !/^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(parts[2])) throw new Error(`"${parts[2].slice(0, 40)}" is not a host${type === 'tcp' ? ':port' : '[:port]'}`);
    if (type === 'tcp' && !/:\d{1,5}$/.test(parts[2])) throw new Error(`"${parts[2].slice(0, 40)}" needs a port, for example ${parts[2]}:22`);
    out.push({ name: parts[0].slice(0, 100), type, address: parts[2] });
  }
  if (out.length > MAX_TARGETS) throw new Error(`At most ${MAX_TARGETS} checks per source`);
  return out;
}

/** Pure: a certificate's days left to a status and a sentence. */
export function certState(daysLeft: number): { status: 'up' | 'pending' | 'down'; detail: string } {
  if (daysLeft <= 0) return { status: 'down', detail: 'The certificate has expired' };
  const d = Math.floor(daysLeft);
  return { status: daysLeft < WARN_DAYS ? 'pending' : 'up', detail: `Certificate expires in ${d} day${d === 1 ? '' : 's'}` };
}

const splitHost = (a: string): { host: string; port: number } => {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(a)!;
  return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2] ?? 443) };
};

const down = (t: Target, detail: string): Check => ({ key: `${t.name}|${t.address}`, name: t.name, status: 'down', since: null, detail, url: null });

function probeTcp(t: Target): Promise<Check> {
  const { host, port } = splitHost(t.address);
  const started = Date.now();
  return new Promise((resolve) => {
    const sock = tcpConnect({ host, port, timeout: TIMEOUT_MS });
    const done = (c: Check) => { sock.destroy(); resolve(c); };
    sock.once('connect', () => done({ key: `${t.name}|${t.address}`, name: t.name, status: 'up', since: null, detail: `Port ${port} answers in ${Date.now() - started} ms`, url: null, ping: Date.now() - started }));
    sock.once('timeout', () => done(down(t, `No answer from port ${port} within ${TIMEOUT_MS / 1000} s`)));
    sock.once('error', (e: NodeJS.ErrnoException) => done(down(t, `Cannot connect to port ${port} (${e.code ?? e.message})`)));
  });
}

function probeTls(t: Target): Promise<Check> {
  const { host, port } = splitHost(t.address);
  return new Promise((resolve) => {
    // Read the certificate even if it is not trusted: whether it is about to expire is the question, not who signed it.
    const sock = tlsConnect({ host, port, servername: /^[\d.]+$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: TIMEOUT_MS });
    const done = (c: Check) => { sock.destroy(); resolve(c); };
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      const end = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
      if (!Number.isFinite(end)) return done(down(t, 'The server sent no certificate'));
      const st = certState((end - Date.now()) / 86_400_000);
      done({ key: `${t.name}|${t.address}`, name: t.name, status: st.status, since: null, detail: st.detail, url: null });
    });
    sock.once('timeout', () => done(down(t, `No TLS answer from port ${port} within ${TIMEOUT_MS / 1000} s`)));
    sock.once('error', (e: NodeJS.ErrnoException) => done(down(t, `Cannot make a TLS connection to port ${port} (${e.code ?? e.message})`)));
  });
}

async function probeHttp(t: Target): Promise<Check> {
  const started = Date.now();
  try {
    const { status } = await requestText({ url: t.address, method: 'GET', headers: { Accept: '*/*' } }, true, TIMEOUT_MS);
    const ms = Date.now() - started;
    return { key: `${t.name}|${t.address}`, name: t.name, status: status < 400 ? 'up' : 'down', since: null, detail: `HTTP ${status} in ${ms} ms`, url: t.address, ping: ms };
  } catch (e) { return down(t, (e as Error).message); }
}

/** The address must not be a link-local or metadata address; LAN addresses are the point and are allowed. */
async function allowed(t: Target): Promise<string | null> {
  try {
    await assertDestinationAllowed(t.type === 'http' ? ({ uri: t.address } as ConnConfig) : ({ host: splitHost(t.address).host } as ConnConfig), [], true);
    return null;
  } catch (e) { return `Not allowed: ${(e as Error).message}`; }
}

export const probeProvider = (s: LoadedSource): Provider => ({
  kind: 'probe', label: s.name, raisesChecks: true, configured: () => !!s.config.targets,
  async poll(): Promise<Polled> {
    const targets = parseTargets(s.config.targets);
    const checks = await Promise.all(targets.map(async (t) => {
      const refused = await allowed(t);
      if (refused) return down(t, refused);
      return t.type === 'tcp' ? probeTcp(t) : t.type === 'tls' ? probeTls(t) : probeHttp(t);
    }));
    return { checks, alerts: [] };
  },
});
