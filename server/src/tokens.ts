// Personal API tokens: scoped, expiring, revocable credentials for scripts, CI and the mobile app, so none of them has
// to borrow a browser session. A token is shown once, stored only as a SHA-256 hash, can never exceed its owner's role,
// inherits the owner's team scope, and stops working the moment the owner is deactivated.
// Tokens cannot create tokens or touch account security (see the auth hook): that needs a real sign-in.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sha256Hex } from './auth.js';
import { cfg } from './config.js';
import { insertToken, listTokens, revokeToken } from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { alert } from './notify.js';
import { atLeast, isRole } from './roles.js';
import type { Role } from './roles.js';

const DAY = 86_400_000;

export function registerTokens(app: FastifyInstance) {
  const view = (t: ReturnType<typeof listTokens>[number]) => ({
    id: t.id, name: t.name, prefix: `hd_${t.prefix}_…`, role: t.role, owner: t.username, createdAt: new Date(t.createdAt).toISOString(),
    expiresAt: new Date(t.expiresAt).toISOString(), lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null, lastIp: t.lastIp,
    status: t.revokedAt ? 'revoked' : t.expiresAt < Date.now() ? 'expired' : 'active',
  });

  app.get<{ Querystring: { all?: string } }>('/api/auth/tokens', async (req) => {
    const all = req.query.all === '1' && req.user!.role === 'admin' && !req.user!.scope;
    return { maxDays: cfg.access.tokenMaxDays, defaultDays: cfg.access.tokenDefaultDays, tokens: listTokens(all ? undefined : req.user!.id).map(view) };
  });

  app.post<{ Body: { name?: string; days?: number; role?: string } }>('/api/auth/tokens', async (req) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 60) throw new HttpError(400, 'BAD_REQUEST', 'Give the token a name (up to 60 characters)');
    const days = Math.floor(Number(req.body?.days ?? cfg.access.tokenDefaultDays));
    if (!Number.isFinite(days) || days < 1 || days > cfg.access.tokenMaxDays) throw new HttpError(400, 'BAD_REQUEST', `Lifetime must be 1 to ${cfg.access.tokenMaxDays} days`);
    const role: Role = isRole(req.body?.role) ? req.body!.role as Role : 'viewer';
    if (!atLeast(req.user!.role, role)) throw new HttpError(403, 'FORBIDDEN', `You cannot create a token with more access (${role}) than your own (${req.user!.role})`);
    const prefix = randomBytes(6).toString('hex');
    const token = `hd_${prefix}_${randomBytes(32).toString('base64url')}`;
    const id = insertToken({ userId: req.user!.id, name, prefix, hash: sha256Hex(token), role, expiresAt: Date.now() + days * DAY });
    logEvent('warn', 'auth', `API token "${name}" (${role}, ${days} d) created by ${req.user!.username}`, { ip: req.ip });
    alert('auth', 'warn', 'API token created', `${req.user!.username} created "${name}" (${role}, ${days} days) from ${req.ip}`);
    return { id, token, name, role, expiresAt: new Date(Date.now() + days * DAY).toISOString(), note: 'Copy it now: it is not shown again.' };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/tokens/:id', async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid token id');
    const mayRevokeAny = req.user!.role === 'admin' && !req.user!.scope;
    if (!revokeToken(id, mayRevokeAny ? undefined : req.user!.id)) throw new HttpError(404, 'NOT_FOUND', 'No such active token');
    logEvent('warn', 'auth', `API token #${id} revoked by ${req.user!.username}`, { ip: req.ip });
    return { ok: true };
  });
}
