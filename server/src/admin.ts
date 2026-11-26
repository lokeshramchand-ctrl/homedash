// Administration of people and access: users, teams, sessions, identity-provider state. Admin role only, and never
// for team-scoped users (the role table puts /api/admin under admin; the scope allow-list excludes it).
import type { FastifyInstance } from 'fastify';
import { cfg, passkeysConfigured, scimConfigured } from './config.js';
import {
  countAdmins, deleteSessionById, findUserById, listPasskeys, listScimGroups, listSessions, listTokens, listUsers, setUserAccess,
} from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { alert } from './notify.js';
import { isRole } from './roles.js';
import type { Role } from './roles.js';

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export function registerAdmin(app: FastifyInstance) {
  app.get('/api/admin/users', async () => {
    const sessions = listSessions();
    const tokens = listTokens();
    return listUsers().map((u) => ({
      id: u.id, username: u.username, role: u.role ?? 'admin', teams: u.teams, groups: u.groups, disabled: u.disabled,
      source: u.scimId ? 'scim' : u.external ? 'sso' : 'local', managed: u.external,
      mfa: !!u.mfa?.enabledAt, passkeys: listPasskeys(u.id).length, lastLoginAt: iso(u.lastLoginAt), lastLoginIp: u.lastLoginIp,
      sessions: sessions.filter((s) => s.userId === u.id).length, tokens: tokens.filter((t) => t.userId === u.id && !t.revokedAt && t.expiresAt > Date.now()).length,
    }));
  });

  app.patch<{ Params: { id: string }; Body: { role?: string; teams?: string[]; disabled?: boolean } }>('/api/admin/users/:id', async (req) => {
    const u = findUserById(Number(req.params.id));
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'No such user');
    const b = req.body ?? {};
    const patch: { role?: Role; teams?: string[]; disabled?: boolean } = {};
    if (b.role !== undefined || b.teams !== undefined) {
      if (u.external) throw new HttpError(409, 'MANAGED', 'This account is managed by your identity provider: change its groups there (access.group_roles / group_teams)');
      if (b.role !== undefined) { if (!isRole(b.role)) throw new HttpError(400, 'BAD_REQUEST', 'role must be viewer, operator or admin'); patch.role = b.role; }
      if (b.teams !== undefined) {
        if (!Array.isArray(b.teams) || b.teams.some((t) => !cfg.access.teams[t])) throw new HttpError(400, 'BAD_REQUEST', `teams must be names from access.teams: ${Object.keys(cfg.access.teams).join(', ') || '(none defined)'}`);
        patch.teams = [...new Set(b.teams)];
      }
    }
    if (b.disabled !== undefined) {
      if (u.id === req.user!.id && b.disabled) throw new HttpError(409, 'SELF', 'You cannot deactivate your own account');
      if (u.scimId) throw new HttpError(409, 'MANAGED', 'Deactivate this account in your identity provider (SCIM)');
      patch.disabled = !!b.disabled;
    }
    // Never leave the dashboard without an administrator.
    const losesAdmin = (u.role ?? 'admin') === 'admin' && !u.disabled && ((patch.role && patch.role !== 'admin') || patch.disabled === true);
    if (losesAdmin && countAdmins() <= 1) throw new HttpError(409, 'LAST_ADMIN', 'This is the only administrator');
    setUserAccess(u.id, patch);
    logEvent('warn', 'auth', `${req.user!.username} changed access of ${u.username}: ${JSON.stringify(patch)}`, { ip: req.ip });
    alert('auth', 'warn', 'Account access changed', `${req.user!.username} changed ${u.username}: ${Object.entries(patch).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') || 'none' : v}`).join(', ')}`);
    return { ok: true };
  });

  app.get('/api/admin/sessions', async (req) => listSessions().map((s) => ({
    id: s.id, username: s.username, createdAt: iso(s.createdAt), lastSeenAt: iso(s.lastSeenAt), expiresAt: iso(s.expiresAt), ip: s.ip,
    userAgent: s.userAgent, pending: s.mfa === 'pending', current: s.id === req.user!.sid,
  })));

  app.delete<{ Params: { id: string } }>('/api/admin/sessions/:id', async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid session id');
    if (id === req.user!.sid) throw new HttpError(409, 'SELF', 'Use Sign out for your own session');
    deleteSessionById(id);
    logEvent('warn', 'auth', `${req.user!.username} ended session #${id}`, { ip: req.ip });
    return { ok: true };
  });

  // Read-only view of what homedash.yaml defines, so admins can see why a person has the access they have.
  app.get('/api/admin/access', async () => ({
    teams: Object.entries(cfg.access.teams).map(([name, t]) => ({ name, cluster: t.cluster ?? null, vmids: t.ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)), tags: t.tags })),
    groupRoles: cfg.access.groupRoles, groupTeams: cfg.access.groupTeams,
    oidc: { configured: !!cfg.oidc.issuer, defaultRole: cfg.oidc.defaultRole, adminUsers: cfg.oidc.adminUsers.length },
    scim: { enabled: scimConfigured(), endpoint: '/scim/v2', groups: listScimGroups().map((g) => ({ name: g.name, members: g.members.length })) },
    passkeys: { enabled: passkeysConfigured(), rpId: cfg.access.webauthn.rpId },
    approvals: { actions: cfg.access.approvals.actions, ttlMinutes: cfg.access.approvals.ttlMinutes, allowSelf: cfg.access.approvals.allowSelf },
    tokens: { maxDays: cfg.access.tokenMaxDays, defaultDays: cfg.access.tokenDefaultDays },
  }));
}
