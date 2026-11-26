import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { accessFromGroups } from './access.js';
import { completeSignIn, createSession, mfaStateFor } from './auth.js';
import { cfg, oidcConfigured } from './config.js';
import { saveOidc, takeOidc, upsertSsoUser } from './db.js';
import { HttpError } from './errors.js';
import { parseRole } from './roles.js';
import { logEvent } from './events.js';

// OpenID Connect sign-in (any provider): authorization code flow with PKCE and a verified ID token (signature checked
// against the provider JWKS). The user must pass OIDC_ALLOWED_USERS and/or OIDC_REQUIRED_ROLE; with neither set SSO stays off.

const kc = cfg.oidc;
const STATE_COOKIE = 'sso_state';
const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const ALGS: Record<string, { hash: string; ec?: boolean }> = {
  RS256: { hash: 'RSA-SHA256' }, RS384: { hash: 'RSA-SHA384' }, RS512: { hash: 'RSA-SHA512' }, ES256: { hash: 'SHA256', ec: true },
};

interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }
let disco: { at: number; d: Discovery } | null = null;
let jwks: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function discovery(): Promise<Discovery> {
  if (disco && Date.now() - disco.at < 3600_000) return disco.d;
  const d = await json<Discovery>(`${kc.issuer}/.well-known/openid-configuration`);
  if (d.issuer !== kc.issuer) throw new Error('Issuer mismatch in discovery document');
  disco = { at: Date.now(), d };
  return d;
}

async function keyFor(kid: string | undefined) {
  const find = () => jwks?.keys.find((k) => k.kid === kid && (k as { use?: string }).use !== 'enc');
  if (!jwks || Date.now() - jwks.at > 3600_000 || !find()) {
    const set = await json<{ keys: (JsonWebKey & { kid?: string })[] }>((await discovery()).jwks_uri);
    jwks = { at: Date.now(), keys: set.keys };
  }
  const jwk = find();
  if (!jwk) throw new Error('Signing key not found in JWKS');
  return createPublicKey({ key: jwk as never, format: 'jwk' });
}

interface Claims {
  iss: string; aud: string | string[]; azp?: string; exp: number; nonce?: string; sub: string;
  preferred_username?: string; email?: string; email_verified?: boolean;
  [claim: string]: unknown;
}

/** Collects role/group names from every configured claim path (strings or arrays of strings). */
function rolesOf(c: Claims): Set<string> {
  const out = new Set<string>();
  for (const path of kc.rolesClaims) {
    let v: unknown = c;
    for (const part of path.replace('{client}', kc.clientId).split('.')) {
      v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    }
    for (const x of Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []) if (typeof x === 'string' && x) out.add(x);
  }
  return out;
}

async function verifyIdToken(token: string, nonce: string): Promise<Claims> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('Malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid?: string };
  const algo = ALGS[header.alg];
  if (!algo) throw new Error(`Unsupported ID token algorithm ${header.alg}`);
  const ok = verify(algo.hash, Buffer.from(`${h}.${p}`), algo.ec ? { key: await keyFor(header.kid), dsaEncoding: 'ieee-p1363' } : await keyFor(header.kid), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('ID token signature invalid');
  const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== kc.issuer) throw new Error('ID token issuer mismatch');
  if (!aud.includes(kc.clientId)) throw new Error('ID token audience mismatch');
  if (!(c.exp * 1000 > Date.now() - 30_000)) throw new Error('ID token expired');
  if (c.nonce !== nonce) throw new Error('ID token nonce mismatch');
  return c;
}

function authorize(c: Claims): string | null {
  const names = [c.preferred_username, c.email_verified === false ? undefined : c.email].filter(Boolean).map((x) => x!.toLowerCase());
  const roles = rolesOf(c);
  if (kc.allowedUsers.length && !names.some((n) => kc.allowedUsers.includes(n))) return 'USER_NOT_ALLOWED';
  if (kc.requiredRole && !roles.has(kc.requiredRole)) return 'ROLE_MISSING';
  return null;
}

export function ssoEnabled(): boolean {
  return oidcConfigured() && (kc.allowedUsers.length > 0 || !!kc.requiredRole);
}

export function registerOidc(app: FastifyInstance) {
  if (oidcConfigured() && !ssoEnabled()) {
    app.log.warn('OIDC is configured but neither OIDC_ALLOWED_USERS nor OIDC_REQUIRED_ROLE is set; SSO stays disabled');
  }

  app.get('/api/auth/sso/config', async () => ({ enabled: ssoEnabled(), label: kc.label }));

  app.get('/api/auth/sso/login', async (req, reply) => {
    if (!ssoEnabled()) throw new HttpError(404, 'NOT_FOUND', 'SSO is not enabled');
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    saveOidc(sha256(state), verifier, nonce, 10 * 60_000);
    let d: Discovery;
    try { d = await discovery(); } catch (e) {
      req.log.error({ err: (e as Error).message }, 'oidc discovery failed');
      return reply.redirect('/?sso_error=SSO_UNAVAILABLE');
    }
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: kc.clientId, response_type: 'code', scope: kc.scopes, redirect_uri: kc.redirectUri,
      state, nonce, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    }).toString();
    // Lax: the callback is a cross-site top-level redirect, which a Strict cookie would not survive.
    reply.setCookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, path: '/api/auth/sso', maxAge: 600 });
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/sso/callback', async (req, reply) => {
    const fail = (code: string, why?: string) => {
      req.log.warn({ code, why, ip: req.ip }, 'sso login failed');
      logEvent('warn', 'auth', `SSO sign-in refused (${code})${why ? `: ${why}` : ''}`, { ip: req.ip });
      reply.clearCookie(STATE_COOKIE, { path: '/api/auth/sso' });
      return reply.redirect(`/?sso_error=${code}`);
    };
    if (!ssoEnabled()) throw new HttpError(404, 'NOT_FOUND', 'SSO is not enabled');
    const { code, state, error } = req.query;
    if (error) return fail('SSO_DENIED', error);
    if (!code || !state || state !== req.cookies[STATE_COOKIE]) return fail('SSO_STATE');
    const saved = takeOidc(sha256(state));
    if (!saved) return fail('SSO_STATE');

    let claims: Claims;
    try {
      const d = await discovery();
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: kc.redirectUri, client_id: kc.clientId, code_verifier: saved.verifier,
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (kc.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(kc.clientId)}:${encodeURIComponent(kc.clientSecret)}`).toString('base64')}`;
      const tok = await json<{ id_token?: string }>(d.token_endpoint, { method: 'POST', headers, body });
      if (!tok.id_token) throw new Error('No id_token in token response');
      claims = await verifyIdToken(tok.id_token, saved.nonce);
    } catch (e) {
      return fail('SSO_FAILED', (e as Error).message);
    }

    const denied = authorize(claims);
    const display = claims.preferred_username ?? claims.email ?? claims.sub;
    if (denied) return fail(denied, display);

    const username = `sso:${display}`.toLowerCase().slice(0, 64);
    const names = [claims.preferred_username, claims.email].filter(Boolean).map((x) => String(x).toLowerCase());
    // Role and teams come from the provider's groups (access.group_roles / group_teams); admin_users always wins.
    const groups = [...rolesOf(claims)];
    const acc = accessFromGroups(groups, parseRole(kc.defaultRole, 'admin'), names.some((n) => kc.adminUsers.includes(n)));
    const role = acc.role;
    const user = upsertSsoUser(`${kc.issuer}|${claims.sub}`, username, role, { teams: acc.teams, groups });
    if (user.disabled) return fail('ACCOUNT_DISABLED', display);
    const mfa = mfaStateFor(user, req.ip);
    await createSession(req, reply, user.id, user.username, { role, mfa });
    if (mfa !== 'pending') completeSignIn(req, user);
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth/sso' });
    req.log.info({ username: user.username, ip: req.ip }, 'login (oidc)');
    return reply.redirect('/');
  });
}
