import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cfg, mfaConfigured } from './config.js';
import { inScope, liveAccess, scopedMayReach } from './access.js';
import type { Scope } from './access.js';
import { scopeOf } from './access.js';
import { listGuests } from './guests.js';
import {
  attemptCount, bumpAttempts, clearAttempts, deleteSession, deleteSessionById, deleteUserSessions, findSession, findToken, findUser, insertSession, touchLogin, touchSession, touchToken,
} from './db.js';
import type { MfaState, UserRow } from './db.js';
import { HttpError } from './errors.js';
import { alert } from './notify.js';
import { decodedPath } from './pathutil.js';
import { atLeast, neededRole, parseRole } from './roles.js';
import type { Role } from './roles.js';
import { mfaGate } from './totp.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: number; username: string; role: Role; sid: number; sessionCreatedAt: number; mfa: MfaState; teams: string[]; scope: Scope | null; via: 'session' | 'token'; tokenId?: number };
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const MAX_ATTEMPTS = 5;
// Failures per account across ALL addresses in the window. Past this, only the address the owner last signed in
// from may try, so a distributed guess cannot continue and a stranger cannot lock the owner out of their usual address.
const MAX_ACCOUNT_ATTEMPTS = 30;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
export const COOKIE = 'sid';
/** API tokens look like hd_<12 hex>_<secret>; anything else in Authorization is ignored. */
export const TOKEN_RE = /^hd_[0-9a-f]{12}_[A-Za-z0-9_-]{40,}$/;
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
const minRole = (a: Role, b: Role): Role => (RANK[a] <= RANK[b] ? a : b);
// Paths that need no session. Passkey sign-in is public by nature; its verification is the credential check.
const PUBLIC = ['/api/auth/login', '/api/auth/passkey/login/', '/api/auth/passkey/config'];
const isPublic = (path: string) => PUBLIC.some((p) => path === p || (p.endsWith('/') && path.startsWith(p))) || path.startsWith('/api/auth/sso/');
/** Value of the X-Requested-With header the web UI and the mobile app send on every request. */
export const CLIENT_HEADER = 'homedash';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, N, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(actual, expected);
}

// Used so unknown usernames cost the same as wrong passwords (no user enumeration by timing).
const DUMMY_HASH = hashPassword(randomBytes(8).toString('hex'));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A session waiting for its second step lives only this long. */
const PENDING_TTL_MS = 10 * 60_000;
export const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/** State of a new session after the first factor (password or SSO). Same rule for both sign-in paths. */
export function mfaStateFor(user: UserRow, ip: string): MfaState {
  if (!mfaConfigured()) return 'ok';
  if (user.mfaExempt) return isLoopback(ip) ? 'ok' : 'pending'; // exempt accounts only work from the host itself
  if (user.mfa?.enabledAt) return 'pending';
  return cfg.mfa.required ? 'enroll' : 'ok';
}

/** Records a completed sign-in (full session issued, or enrolment forced) and flags an unfamiliar address. */
export function completeSignIn(req: FastifyRequest, user: UserRow) {
  touchLogin(user.id, req.ip);
  if (user.lastLoginIp && user.lastLoginIp !== req.ip) {
    alert('auth', 'warn', 'Sign-in from a new address', `${user.username} signed in from ${req.ip} (last seen ${user.lastLoginIp})`, `auth|newip|${user.username}|${req.ip}`);
  }
}

export async function createSession(
  req: FastifyRequest, reply: FastifyReply, userId: number, username: string,
  opts: { role?: Role; mfa?: MfaState } = {},
) {
  const token = randomBytes(32).toString('hex');
  const mfa = opts.mfa ?? 'ok';
  const ttlMs = mfa === 'pending' ? PENDING_TTL_MS : cfg.sessionTtlHours * 3600_000;
  insertSession({
    tokenHash: sha256(token), userId, username, role: opts.role ?? 'admin', mfa, expiresAt: Date.now() + ttlMs,
    ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
  });
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, path: '/', maxAge: Math.floor(ttlMs / 1000),
  });
}

/**
 * Team-scoped users (access.teams) may only reach guests in their scope. They get no host-wide pages at all,
 * because those expose other teams' guests: the allow-list in access.ts is deliberately short.
 */
async function enforceScope(req: FastifyRequest, path: string) {
  const scope = req.user?.scope;
  if (scope === null || scope === undefined) return;
  if (!scopedMayReach(path)) throw new HttpError(403, 'OUT_OF_SCOPE', 'Your team has access to its own guests only');
  const m = /^\/api\/guests\/(\d+)(?:\/|$)/.exec(path);
  if (m) {
    const g = (await listGuests()).find((x) => x.vmid === Number(m[1]));
    if (!g || !inScope(scope, g)) throw new HttpError(403, 'OUT_OF_SCOPE', `Guest ${m[1]} is outside your team's scope`);
  }
}

export function registerAuth(app: FastifyInstance) {
  // The guest list itself is filtered, not refused.
  app.addHook('preSerialization', async (req, _reply, payload) => {
    const scope = req.user?.scope;
    if (scope && req.method === 'GET' && Array.isArray(payload) && decodedPath(req.url) === '/api/guests') {
      return (payload as { vmid: number; tags: string[] }[]).filter((g) => inScope(scope, g));
    }
    return payload;
  });

  // Everything under /api needs a valid session or API token except sign-in. Also blocks cross-site state changes.
  app.addHook('onRequest', async (req, reply) => {
    // Fastify decodes percent-escapes before routing ("/%61pi/x" reaches the /api/x handler), so the
    // guard must test the decoded path AND the route that actually matched, never the raw URL alone.
    const path = decodedPath(req.url);
    const routed = req.routeOptions?.url ?? '';
    if (!path.startsWith('/api/') && !routed.startsWith('/api/')) return;

    // A bearer token is not an ambient credential (browsers never add it on their own), so it needs no CSRF check.
    const authz = String(req.headers.authorization ?? '');
    const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    const useToken = TOKEN_RE.test(bearer);

    if (!useToken && req.method !== 'GET' && req.method !== 'HEAD') {
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite === 'cross-site') throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site request refused');
      const origin = req.headers.origin;
      if (origin) {
        const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
        let host = '';
        try { host = new URL(origin).host; } catch { /* malformed origin */ }
        if (!allowed.includes(host)) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site request refused');
      } else if (fetchSite !== 'same-origin' && req.headers['x-requested-with'] !== CLIENT_HEADER) {
        // No origin information at all: only a client that sets our custom header may change state. A browser
        // cannot add that header to a cross-site request without a CORS preflight, which this server never allows.
        throw new HttpError(403, 'BAD_ORIGIN', 'Missing origin information');
      }
    }

    if (isPublic(path)) return;

    const now = Date.now();
    if (useToken) {
      const tok = findToken(sha256(bearer));
      if (!tok || tok.user.disabled) throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid, expired or revoked API token');
      if (now - (tok.lastUsedAt ?? 0) > 60_000) touchToken(tok.id, req.ip);
      // Account actions (tokens, passkeys, two-step, sign-out-everywhere) need a real sign-in, never a token.
      if (path.startsWith('/api/auth/') && path !== '/api/auth/me') throw new HttpError(403, 'TOKEN_FORBIDDEN', 'This needs a browser session, not an API token');
      const acc = liveAccess(tok.userId, tok.role);
      const role = minRole(acc.role, tok.role);
      const need = neededRole(req.method, path, routed);
      if (!atLeast(role, need)) throw new HttpError(403, 'FORBIDDEN', `This needs the ${need} role`);
      req.user = { id: tok.userId, username: tok.user.username, role, sid: 0, sessionCreatedAt: tok.createdAt, mfa: 'ok', teams: acc.teams, scope: scopeOf(acc.teams), via: 'token', tokenId: tok.id };
      await enforceScope(req, path);
      return;
    }

    const token = req.cookies[COOKIE];
    const session = token ? findSession(sha256(token)) : null;
    if (!session) {
      reply.clearCookie(COOKIE, { path: '/' });
      throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
    }
    // Idle timeout: last_seen_at is refreshed at most once a minute to keep writes cheap.
    if (now - session.lastSeenAt > cfg.sessionIdleMinutes * 60_000) {
      deleteSessionById(session.id);
      reply.clearCookie(COOKIE, { path: '/' });
      throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired from inactivity');
    }
    if (now - session.lastSeenAt > 60_000) touchSession(session.id);
    const state = session.mfa;
    const gate = [mfaGate(state, req.method, path), routed ? mfaGate(state, req.method, routed) : 'allow'].find((g) => g !== 'allow') ?? 'allow';
    if (gate === 'MFA_REQUIRED') throw new HttpError(401, 'MFA_REQUIRED', 'Enter your sign-in code');
    if (gate === 'MFA_ENROLL_REQUIRED') throw new HttpError(403, 'MFA_ENROLL_REQUIRED', 'Set up two-step sign-in first');
    // Role, teams and "deactivated" are read live, so a change at the identity provider applies on the next request.
    const acc = liveAccess(session.userId, session.role);
    if (acc.disabled) {
      deleteSessionById(session.id);
      reply.clearCookie(COOKIE, { path: '/' });
      throw new HttpError(401, 'UNAUTHENTICATED', 'This account has been deactivated');
    }
    const need = neededRole(req.method, path, routed);
    if (!atLeast(acc.role, need)) throw new HttpError(403, 'FORBIDDEN', `This needs the ${need} role`);
    req.user = { id: session.userId, username: session.username, role: acc.role, sid: session.id, sessionCreatedAt: session.createdAt, mfa: state, teams: acc.teams, scope: scopeOf(acc.teams), via: 'session' };
    await enforceScope(req, path);
  });

  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!username || !password || username.length > 64 || password.length > 256) {
      throw new HttpError(400, 'BAD_REQUEST', 'Username and password are required');
    }

    // Three counters: per ip+username (targeted guessing), per ip (spraying many usernames), per account (distributed).
    const key = `${req.ip}|${username}`;
    const ipKey = `ip|${req.ip}`;
    const acctKey = `acct|${username}`;
    const user = findUser(username);
    if (attemptCount(key) >= MAX_ATTEMPTS || attemptCount(ipKey) >= MAX_ATTEMPTS * 4) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again in a few minutes.');
    }
    // Account-wide ceiling: beyond it only the owner's usual address may keep trying.
    if (attemptCount(acctKey) >= MAX_ACCOUNT_ATTEMPTS && !(user?.lastLoginIp && user.lastLoginIp === req.ip)) {
      req.log.warn({ username: username.slice(0, 24).replace(/[^\w.@-]/g, '?'), ip: req.ip }, 'login refused: account under distributed guessing');
      throw new HttpError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again in a few minutes.');
    }

    const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH) && !!user;
    if (!ok || !user) {
      for (const k of [key, ipKey, acctKey]) bumpAttempts(k, ATTEMPT_WINDOW_MS);
      // Only a bounded, printable slice is logged: a mistyped password in the username box must not hit the logs raw.
      req.log.warn({ username: username.slice(0, 24).replace(/[^\w.@-]/g, '?'), ip: req.ip }, 'failed login');
      throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid username or password');
    }

    if (user.disabled) {
      bumpAttempts(key, ATTEMPT_WINDOW_MS);
      throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid username or password');
    }
    clearAttempts(key);
    const state = mfaStateFor(user, req.ip);
    await createSession(req, reply, user.id, user.username, { role: parseRole(user.role, 'admin'), mfa: state });
    // lastLoginIp / the new-address alert record completed sign-ins: with a code step they move to /mfa/verify.
    if (state !== 'pending') completeSignIn(req, user);
    req.log.info({ username: user.username, ip: req.ip, mfa: state }, state === 'pending' ? 'login (password ok, code needed)' : 'login');
    return { username: user.username, mfa: state === 'ok' ? 'none' : state === 'pending' ? 'required' : 'enroll' };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) deleteSession(sha256(token));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // Sign out everywhere: drops every session of the caller (this browser included).
  app.post('/api/auth/logout-all', async (req, reply) => {
    const revoked = deleteUserSessions(req.user!.id);
    reply.clearCookie(COOKIE, { path: '/' });
    req.log.info({ username: req.user!.username, revoked }, 'sessions revoked');
    return { ok: true, revoked };
  });

  app.get('/api/auth/me', async (req) => ({ username: req.user!.username, role: req.user!.role, teams: req.user!.teams, ...(req.user!.mfa === 'enroll' ? { mfa: 'enroll' } : {}) }));
}
