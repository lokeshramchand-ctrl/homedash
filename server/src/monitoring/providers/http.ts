// One careful way for pull providers to read JSON from a monitoring tool: bounded time and size, no redirects to somewhere else,
// and error messages that can never contain a credential.
import { Agent, fetch } from 'undici';
import type { Built } from '../request.js';

const MAX_BYTES = 2 * 1024 * 1024;
// For servers with a self-signed certificate, when an administrator has said to accept it for that source only.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export interface Auth { username?: string; password?: string; bearer?: string }

export function authHeaders(a: Auth): Record<string, string> {
  if (a.bearer) return { Authorization: `Bearer ${a.bearer}` };
  if (a.username && a.password) return { Authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` };
  return {};
}

/** One request. Throws a short, secret-free message when the server cannot be reached or the answer is too large; HTTP statuses are returned. */
export async function requestText(b: Built, insecure = false, timeoutMs = 10_000): Promise<{ status: number; text: string }> {
  let res;
  try {
    res = await fetch(b.url, { method: b.method, headers: b.headers, body: b.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...(insecure ? { dispatcher: insecureAgent } : {}) });
  } catch (e) {
    const m = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    throw new Error(`Cannot reach the server (${m === 'TimeoutError' ? 'timed out' : m})`);
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('The answer is larger than 2 MB');
  return { status: res.status, text };
}

/** Turns an HTTP status that means "not usable" into a plain-words error; returns normally for a success. */
export function assertUsable(status: number) {
  if (status >= 300 && status < 400) throw new Error(`The server redirected to another address (HTTP ${status}); use the final address`);
  if (status === 401 || status === 403) throw new Error(`The server refused the credentials (HTTP ${status})`);
  if (status < 200 || status >= 300) throw new Error(`The server answered HTTP ${status}`);
}

/** GET a URL and parse the JSON answer. Throws a short, secret-free message on any failure. */
export async function getJson(url: string, auth: Auth = {}, timeoutMs = 10_000, insecure = false): Promise<unknown> {
  const { status, text } = await requestText({ url, method: 'GET', headers: { Accept: 'application/json', ...authHeaders(auth) } }, insecure, timeoutMs);
  assertUsable(status);
  try { return JSON.parse(text); } catch { throw new Error('The answer is not JSON'); }
}

export const trimUrl = (u: string | undefined) => (u ?? '').trim().replace(/\/+$/, '');
export const httpUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 500) : null);
export const cap = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
export const levelOf = (severity: unknown): 'warn' | 'error' => (/^(critical|error|page|high|disaster)$/i.test(String(severity ?? '')) ? 'error' : 'warn');
