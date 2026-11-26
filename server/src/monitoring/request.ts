// Builds one outgoing HTTP request from what an administrator filled in, and refuses anything that could be abused.
// The only placeholder is {{secret}}; nothing else is templated or evaluated.
export interface HttpConfig {
  url?: string; method?: string; auth?: string; username?: string; header_name?: string; query_name?: string;
  extra_headers?: string; body?: string; insecure_tls?: string;
}
export interface Built { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }

const NAME = /^[A-Za-z0-9-]{1,64}$/;
const QUERY_NAME = /^[A-Za-z0-9_.-]{1,40}$/;
/** Headers that frame the request or hop between proxies: never settable here. */
const FORBIDDEN = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'expect', 'cookie']);
const MAX_HEADERS = 20, MAX_BODY = 4096;

const checkHeader = (name: string, value: string) => {
  if (!NAME.test(name)) throw new Error(`"${name.slice(0, 40)}" is not a valid header name`);
  if (FORBIDDEN.has(name.toLowerCase())) throw new Error(`The ${name} header cannot be set`);
  if (/[\r\n\0]/.test(value)) throw new Error(`The ${name} header contains a line break`);
};

/** Pure: "Name: value" lines to pairs. Blank lines are ignored. */
export function parseHeaders(text: string | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`"${line.slice(0, 40)}" is not a header line (use Name: value)`);
    out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  if (out.length > MAX_HEADERS) throw new Error(`At most ${MAX_HEADERS} extra headers`);
  return out;
}

export const wantsSecret = (c: HttpConfig): boolean => ['bearer', 'basic', 'header', 'query'].includes(c.auth ?? '') || /\{\{secret\}\}/.test(`${c.url ?? ''}${c.extra_headers ?? ''}${c.body ?? ''}`);

/** Pure: the configuration and the sealed secret to a request. Throws a plain-words message for anything not allowed. */
export function buildRequest(c: HttpConfig, secret: string): Built {
  const method = (c.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new Error('The method must be GET or POST');
  const auth = c.auth ?? 'none';
  if (['bearer', 'basic', 'header', 'query'].includes(auth) && !secret) throw new Error('This way of signing in needs the key or password');
  const withSecret = (s: string, encode = false) => {
    if (!/\{\{secret\}\}/.test(s)) return s;
    if (!secret) throw new Error('{{secret}} is used but no key or password is saved');
    return s.replace(/\{\{secret\}\}/g, encode ? encodeURIComponent(secret) : secret);
  };

  const rawUrl = withSecret(String(c.url ?? '').trim(), true); // before the try: a missing secret must say so, not "not valid"
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('The address is not valid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The address must start with http:// or https://');

  const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
  const extra = parseHeaders(c.extra_headers);
  const seen = new Set<string>();
  for (const [name, raw] of extra) {
    const value = withSecret(raw);
    checkHeader(name, value);
    if (seen.has(name.toLowerCase())) throw new Error(`The ${name} header is set twice`);
    seen.add(name.toLowerCase());
    headers[name] = value;
  }
  const set = (name: string, value: string) => {
    checkHeader(name, value);
    if (seen.has(name.toLowerCase())) throw new Error(`The ${name} header is set both in the sign-in choice and in the extra headers`);
    headers[name] = value;
  };
  if (auth === 'bearer') set('Authorization', `Bearer ${secret}`);
  else if (auth === 'basic') set('Authorization', `Basic ${Buffer.from(`${c.username ?? ''}:${secret}`).toString('base64')}`);
  else if (auth === 'header') set(String(c.header_name ?? '').trim(), secret);
  else if (auth === 'query') {
    const q = String(c.query_name ?? '').trim();
    if (!QUERY_NAME.test(q)) throw new Error('The name of the query parameter is not valid');
    url.searchParams.set(q, secret);
  } else if (auth !== 'none' && auth !== '') throw new Error('Unknown way of signing in');

  let body: string | undefined;
  if (method === 'POST' && c.body) {
    body = withSecret(c.body);
    if (body.length > MAX_BODY) throw new Error(`The request body is larger than ${MAX_BODY} characters`);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  } else if (c.body && method === 'GET') throw new Error('A request body needs the POST method');
  return { url: url.toString(), method, headers, body };
}
