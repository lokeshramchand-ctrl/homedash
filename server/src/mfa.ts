// Two-step sign-in routes (TOTP + recovery codes). The session gate itself lives in auth.ts / totp.ts (mfaGate).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COOKIE, completeSignIn, createSession, verifyPassword } from './auth.js';
import { cfg, mfaConfigured } from './config.js';
import {
  attemptCount, bumpAttempts, clearAttempts, deleteSessionById, deleteUserSessions, disableMfa, enableMfa, findUserById, replaceRecovery,
  setMfaSetup, setSessionMfa, spendRecovery, spendTotpStep,
} from './db.js';
import type { UserRow } from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { logEvent } from './events.js';
import { alert } from './notify.js';
import { hashRecovery, matchStep, newRecoveryCodes, newSecret, openSecret, otpauthUri, sealSecret } from './totp.js';

const MAX_CODE_FAILS = 5;
const WINDOW_MS = 15 * 60_000;
const SETUP_TTL_MS = 10 * 60_000;
const REAUTH_MS = 15 * 60_000;

const need = () => { if (!mfaConfigured()) throw notConfigured('Two-step sign-in (MFA_KEY)'); };

function codeOf(req: FastifyRequest): string {
  const c = (req.body as { code?: unknown } | undefined)?.code;
  if (typeof c !== 'string' || !c.trim() || c.length > 16) throw new HttpError(400, 'BAD_REQUEST', 'A sign-in code is required');
  return c.trim();
}

function userOf(req: FastifyRequest): UserRow {
  const u = findUserById(req.user!.id);
  if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
  return u;
}

const failKey = (id: number) => `mfa|${id}`;
const failures = (id: number) => attemptCount(failKey(id));
const noteFailure = (id: number) => { bumpAttempts(failKey(id), WINDOW_MS); return failures(id); };
const clearFailures = (id: number) => clearAttempts(failKey(id));
const tooMany = () => new HttpError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again in a few minutes.');

/**
 * Checks a 6-digit code (or, when allowed, a recovery code) and spends it. Spending is one synchronous
 * read-check-write against SQLite, so two parallel requests cannot both win.
 */
function spendCode(user: UserRow, code: string, allowRecovery: boolean): 'totp' | 'recovery' | null {
  const m = user.mfa;
  if (!m) return null;
  if (/^\d{6}$/.test(code)) {
    let secret: string;
    try { secret = openSecret(m.secret, String(user.id)); } catch { return null; }
    const step = matchStep(secret, code, Date.now(), m.lastStep);
    if (step === null) return null;
    return spendTotpStep(user.id, step) ? 'totp' : null;
  }
  if (!allowRecovery) return null;
  return spendRecovery(user.id, hashRecovery(code)) ? 'recovery' : null;
}

export function registerMfa(app: FastifyInstance) {
  if (cfg.mfa.required && !mfaConfigured()) app.log.warn('MFA_REQUIRED is set but MFA_KEY is empty (needs 32+ characters); two-step sign-in stays off');

  app.get('/api/auth/mfa', async (req) => {
    const u = userOf(req);
    return {
      configured: mfaConfigured(), required: cfg.mfa.required && mfaConfigured(),
      enabled: !!u.mfa?.enabledAt, enabledAt: u.mfa?.enabledAt ? new Date(u.mfa.enabledAt).toISOString() : null, recoveryLeft: u.mfa?.recovery.length ?? 0,
    };
  });

  app.post<{ Body: { password?: string } }>('/api/auth/mfa/setup', async (req) => {
    need();
    const u = userOf(req);
    if (u.mfa?.enabledAt) throw new HttpError(409, 'MFA_ENABLED', 'Two-step sign-in is already on');
    if (failures(u.id) >= MAX_CODE_FAILS) throw tooMany();
    if (u.passwordHash) {
      const pw = req.body?.password;
      if (typeof pw !== 'string' || !pw || pw.length > 256) throw new HttpError(400, 'BAD_REQUEST', 'Your current password is required');
      if (!verifyPassword(pw, u.passwordHash)) {
        noteFailure(u.id);
        throw new HttpError(403, 'BAD_CREDENTIALS', 'Password is not correct');
      }
    } else if (Date.now() - req.user!.sessionCreatedAt > REAUTH_MS) {
      throw new HttpError(403, 'REAUTH_REQUIRED', 'Sign out and in again, then retry');
    }
    const secret = newSecret();
    setMfaSetup(u.id, { secret: sealSecret(secret, String(u.id)), expireAt: Date.now() + SETUP_TTL_MS });
    return { secret, uri: otpauthUri(cfg.mfa.issuer, u.username, secret) };
  });

  app.post('/api/auth/mfa/enable', async (req) => {
    need();
    const code = codeOf(req);
    const u = userOf(req);
    if (u.mfa?.enabledAt) throw new HttpError(409, 'MFA_ENABLED', 'Two-step sign-in is already on');
    if (!u.mfaSetup || u.mfaSetup.expireAt < Date.now()) throw new HttpError(409, 'MFA_SETUP_EXPIRED', 'Setup expired. Start again.');
    if (failures(u.id) >= MAX_CODE_FAILS) throw tooMany();
    let secret: string;
    try { secret = openSecret(u.mfaSetup.secret, String(u.id)); } catch { throw new HttpError(409, 'MFA_SETUP_EXPIRED', 'Setup expired. Start again.'); }
    const step = matchStep(secret, code, Date.now(), 0);
    if (step === null) {
      noteFailure(u.id);
      throw new HttpError(403, 'BAD_CODE', 'That code is not correct. Check the clock on your phone and try again.');
    }
    const recoveryCodes = newRecoveryCodes(10);
    enableMfa(u.id, { secret: u.mfaSetup.secret, enabledAt: Date.now(), lastStep: step, recovery: recoveryCodes.map(hashRecovery) });
    setSessionMfa(req.user!.sid, 'ok'); // an enrolment session becomes a full one
    deleteUserSessions(u.id, req.user!.sid);
    clearFailures(u.id);
    logEvent('warn', 'auth', `Two-step sign-in turned on for ${u.username}`, { ip: req.ip });
    alert('auth', 'warn', 'Two-step sign-in turned on', `${u.username} from ${req.ip}`);
    return { recoveryCodes };
  });

  app.post('/api/auth/mfa/verify', async (req, reply) => {
    need();
    const code = codeOf(req);
    if (req.user!.mfa !== 'pending') throw new HttpError(409, 'NOT_PENDING', 'No sign-in code is needed');
    const u = userOf(req);
    const kill = () => {
      deleteSessionById(req.user!.sid);
      reply.clearCookie(COOKIE, { path: '/' });
      return new HttpError(429, 'RATE_LIMITED', 'Too many wrong codes. Sign in again in a few minutes.');
    };
    if (failures(u.id) >= MAX_CODE_FAILS) throw kill();
    const kind = spendCode(u, code, true);
    if (!kind) {
      const n = noteFailure(u.id);
      req.log.warn({ username: u.username, ip: req.ip }, 'wrong sign-in code');
      if (n >= MAX_CODE_FAILS) throw kill();
      throw new HttpError(403, 'BAD_CODE', 'That code is not correct');
    }
    clearFailures(u.id);
    deleteSessionById(req.user!.sid);
    await createSession(req, reply, u.id, u.username, { role: req.user!.role }); // new token: the pending one is gone
    completeSignIn(req, u);
    const recoveryLeft = (u.mfa?.recovery.length ?? 0) - (kind === 'recovery' ? 1 : 0);
    if (kind === 'recovery') alert('auth', 'warn', 'Recovery code used', `${u.username} signed in with a recovery code from ${req.ip}. ${recoveryLeft} left.`);
    req.log.info({ username: u.username, ip: req.ip, recovery: kind === 'recovery' }, 'login (second step)');
    return { username: u.username, recoveryLeft };
  });

  app.post('/api/auth/mfa/recovery', async (req) => {
    need();
    const code = codeOf(req);
    const u = userOf(req);
    if (!u.mfa) throw new HttpError(409, 'MFA_NOT_ENABLED', 'Two-step sign-in is off');
    if (failures(u.id) >= MAX_CODE_FAILS) throw tooMany();
    if (!spendCode(u, code, false)) {
      noteFailure(u.id);
      throw new HttpError(403, 'BAD_CODE', 'That code is not correct');
    }
    clearFailures(u.id);
    const recoveryCodes = newRecoveryCodes(10);
    replaceRecovery(u.id, recoveryCodes.map(hashRecovery));
    logEvent('warn', 'auth', `Recovery codes replaced for ${u.username}`, { ip: req.ip });
    alert('auth', 'warn', 'Recovery codes replaced', `${u.username} from ${req.ip}`);
    return { recoveryCodes };
  });

  app.post('/api/auth/mfa/disable', async (req) => {
    need();
    const code = codeOf(req);
    const u = userOf(req);
    if (!u.mfa) throw new HttpError(409, 'MFA_NOT_ENABLED', 'Two-step sign-in is off');
    if (failures(u.id) >= MAX_CODE_FAILS) throw tooMany();
    if (!spendCode(u, code, true)) {
      noteFailure(u.id);
      throw new HttpError(403, 'BAD_CODE', 'That code is not correct');
    }
    clearFailures(u.id);
    disableMfa(u.id);
    deleteUserSessions(u.id, req.user!.sid);
    if (cfg.mfa.required) setSessionMfa(req.user!.sid, 'enroll');
    logEvent('warn', 'auth', `Two-step sign-in turned off for ${u.username}`, { ip: req.ip });
    alert('auth', 'warn', 'Two-step sign-in turned off', `${u.username} from ${req.ip}`);
    return { ok: true };
  });
}
