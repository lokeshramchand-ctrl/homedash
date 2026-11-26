// One careful way for pull providers to read JSON from a monitoring tool: bounded time and size, no redirects to somewhere else,
// and error messages that can never contain a credential.
import { fetch } from 'undici';

const MAX_BYTES = 2 * 1024 * 1024;

export interface Auth { username?: string; password?: string; bearer?: string }

export function authHeaders(a: Auth): Record<string, string> {
  if (a.bearer) return { Authorization: `Bearer ${a.bearer}` };
  if (a.username && a.password) return { Authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` };
  return {};
}

/** GET a URL and parse the JSON answer. Throws a short, secret-free message on any failure. */
export async function getJson(url: string, auth: Auth = {}, timeoutMs = 10_000): Promise<unknown> {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...authHeaders(auth) }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const m = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    throw new Error(`Cannot reach the server (${m === 'TimeoutError' ? 'timed out' : m})`);
  }
  if (res.status >= 300 && res.status < 400) throw new Error(`The server redirected to another address (HTTP ${res.status}); use the final address`);
  if (res.status === 401 || res.status === 403) throw new Error(`The server refused the credentials (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('The answer is larger than 2 MB');
  try { return JSON.parse(text); } catch { throw new Error('The answer is not JSON'); }
}

export const trimUrl = (u: string | undefined) => (u ?? '').trim().replace(/\/+$/, '');
export const httpUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 500) : null);
export const cap = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
export const levelOf = (severity: unknown): 'warn' | 'error' => (/^(critical|error|page|high|disaster)$/i.test(String(severity ?? '')) ? 'error' : 'warn');
