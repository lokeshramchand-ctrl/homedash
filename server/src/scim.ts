// SCIM 2.0 (RFC 7643/7644) so an identity provider (Okta, Entra ID, Authentik, Keycloak with a SCIM plugin, ...) can
// provision people and groups into homedash:
//   - create/update/deactivate users (deactivating ends their sessions and revokes their API tokens at once),
//   - groups carry membership; group_roles / group_teams in homedash.yaml turn membership into a role and teams.
// Auth: `Authorization: Bearer <SCIM_TOKEN>` (24+ characters). Users sign in through OIDC; the SCIM userName must equal
// the OIDC preferred_username (or email) claim so the first sign-in adopts the provisioned account.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { accessFromGroups } from './access.js';
import { cfg, scimConfigured } from './config.js';
import {
  deleteScimGroup, deleteScimUser, findUserByScimId, findUserById, getScimGroup, listScimGroups, listUsers, saveScimGroup, scimGroupsOf, scimUpsertUser, setScimMembers,
} from './db.js';
import type { ScimGroupRow, UserRow } from './db.js';
import { logEvent } from './events.js';
import { parseRole } from './roles.js';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const ct = 'application/scim+json; charset=utf-8';

class ScimError extends Error { constructor(public status: number, message: string, public scimType?: string) { super(message); } }
const err = (reply: FastifyReply, e: ScimError) => reply.code(e.status).type(ct).send({ schemas: [ERR], status: String(e.status), detail: e.message, ...(e.scimType ? { scimType: e.scimType } : {}) });

const usernameOf = (userName: string) => `sso:${userName.trim().toLowerCase()}`.slice(0, 64);
const bareName = (u: UserRow) => u.username.replace(/^sso:/, '');
const defaultRole = () => parseRole(cfg.oidc.defaultRole, 'admin');

/** Recomputes a SCIM user's stored role/teams from their current group membership. */
function refresh(userId: number) {
  const u = findUserById(userId);
  if (!u?.scimId) return;
  const groups = scimGroupsOf(u.id);
  const a = accessFromGroups(groups, defaultRole(), false);
  scimUpsertUser({ scimId: u.scimId, username: u.username, active: !u.disabled, role: a.role, teams: a.teams, groups });
}

function userResource(u: UserRow, base: string) {
  const groups = scimGroupsOf(u.id);
  return {
    schemas: [USER], id: u.scimId, userName: bareName(u), active: !u.disabled,
    groups: listScimGroups().filter((g) => groups.includes(g.name)).map((g) => ({ value: g.id, display: g.name, $ref: `${base}/Groups/${g.id}` })),
    meta: { resourceType: 'User', created: new Date(u.createdAt).toISOString(), location: `${base}/Users/${u.scimId}` },
  };
}
function groupResource(g: ScimGroupRow, base: string) {
  return {
    schemas: [GROUP], id: g.id, displayName: g.name, ...(g.externalId ? { externalId: g.externalId } : {}),
    members: g.members.map((id) => findUserById(id)).filter((u): u is UserRow => !!u?.scimId).map((u) => ({ value: u.scimId!, display: bareName(u), $ref: `${base}/Users/${u.scimId}` })),
    meta: { resourceType: 'Group', location: `${base}/Groups/${g.id}` },
  };
}

/** Supports the filters identity providers actually send: `userName eq "x"` and `displayName eq "x"`. */
function filterEq(filter: string | undefined, attr: string): string | null {
  if (!filter) return null;
  const m = new RegExp(`^\\s*${attr}\\s+eq\\s+"([^"]*)"\\s*$`, 'i').exec(filter);
  if (!m) throw new ScimError(400, `Unsupported filter. Supported: ${attr} eq "value"`, 'invalidFilter');
  return m[1];
}
const page = <T,>(all: T[], q: { startIndex?: string; count?: string }) => {
  const start = Math.max(1, parseInt(q.startIndex ?? '1', 10) || 1);
  const count = Math.min(200, Math.max(0, parseInt(q.count ?? '100', 10) || 0));
  return { totalResults: all.length, startIndex: start, itemsPerPage: Math.min(count, Math.max(0, all.length - (start - 1))), Resources: all.slice(start - 1, start - 1 + count) };
};

interface PatchOp { op: string; path?: string; value?: unknown }
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

export function registerScim(app: FastifyInstance) {
  if (!scimConfigured()) {
    if (cfg.access.scimToken) app.log.warn('SCIM_TOKEN is set but shorter than 24 characters; SCIM stays off');
    return;
  }
  app.addContentTypeParser(['application/scim+json'], { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(new ScimError(400, 'Invalid JSON', 'invalidSyntax') as never, undefined); }
  });

  const want = Buffer.from(cfg.access.scimToken);
  const guard = (req: FastifyRequest) => {
    const h = String(req.headers.authorization ?? '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ScimError(401, 'Invalid or missing SCIM bearer token');
  };
  const base = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}/scim/v2`;
  const route = (fn: (req: any, reply: FastifyReply, b: string) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      guard(req);
      reply.type(ct);
      return await fn(req, reply, base(req));
    } catch (e) {
      if (e instanceof ScimError) return err(reply, e);
      throw e;
    }
  };

  app.get('/scim/v2/ServiceProviderConfig', route(() => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'SCIM_TOKEN' }],
  })));
  app.get('/scim/v2/ResourceTypes', route(() => page([
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER },
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP },
  ], {})));

  // ---------------------------------------------------------------- Users
  const scimUsers = () => listUsers().filter((u) => u.scimId);
  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>('/scim/v2/Users', route((req, _r, b) => {
    const name = filterEq(req.query.filter, 'userName');
    const all = scimUsers().filter((u) => name === null || bareName(u).toLowerCase() === name.toLowerCase());
    const p = page(all, req.query);
    return { schemas: [LIST], ...p, Resources: p.Resources.map((u) => userResource(u, b)) };
  }));
  app.get<{ Params: { id: string } }>('/scim/v2/Users/:id', route((req, _r, b) => {
    const u = findUserByScimId(req.params.id);
    if (!u) throw new ScimError(404, 'User not found');
    return userResource(u, b);
  }));
  app.post<{ Body: { userName?: string; active?: boolean; externalId?: string } }>('/scim/v2/Users', route((req, reply, b) => {
    const userName = String(req.body?.userName ?? '').trim();
    if (!userName || userName.length > 120) throw new ScimError(400, 'userName is required', 'invalidValue');
    const username = usernameOf(userName);
    const exists = listUsers().find((u) => u.username === username);
    if (exists?.scimId) throw new ScimError(409, 'A user with that userName already exists', 'uniqueness');
    if (exists) throw new ScimError(409, `A local account named ${username} already exists`, 'uniqueness');
    const a = accessFromGroups([], defaultRole(), false);
    const u = scimUpsertUser({ scimId: randomUUID(), username, active: req.body?.active !== false, role: a.role, teams: a.teams, groups: [] });
    logEvent('info', 'auth', `SCIM: provisioned ${username}`);
    reply.code(201).header('Location', `${b}/Users/${u.scimId}`);
    return userResource(u, b);
  }));
  const applyUser = (req: FastifyRequest, u: UserRow, patch: { active?: boolean }) => {
    if (patch.active !== undefined) {
      scimUpsertUser({ scimId: u.scimId!, username: u.username, active: patch.active, role: parseRole(u.role, defaultRole()), teams: u.teams, groups: scimGroupsOf(u.id) });
      logEvent(patch.active ? 'info' : 'warn', 'auth', `SCIM: ${patch.active ? 'reactivated' : 'deactivated'} ${u.username}`, { ip: req.ip });
    }
    refresh(u.id);
    return findUserById(u.id)!;
  };
  app.put<{ Params: { id: string }; Body: { active?: boolean } }>('/scim/v2/Users/:id', route((req, _r, b) => {
    const u = findUserByScimId(req.params.id);
    if (!u) throw new ScimError(404, 'User not found');
    return userResource(applyUser(req, u, { active: req.body?.active !== false }), b);
  }));
  app.patch<{ Params: { id: string }; Body: { schemas?: string[]; Operations?: PatchOp[] } }>('/scim/v2/Users/:id', route((req, _r, b) => {
    const u = findUserByScimId(req.params.id);
    if (!u) throw new ScimError(404, 'User not found');
    if (!req.body?.schemas?.includes(PATCH)) throw new ScimError(400, 'Not a PatchOp message', 'invalidSyntax');
    let active: boolean | undefined;
    for (const op of req.body.Operations ?? []) {
      const path = (op.path ?? '').toLowerCase();
      const val = op.value as Record<string, unknown> | unknown;
      // Entra and Okta both send either {path:"active", value:false} or {value:{active:false}}
      if (path === 'active') active = String(val).toLowerCase() === 'true';
      else if (!path && val && typeof val === 'object' && 'active' in (val as object)) active = String((val as { active: unknown }).active).toLowerCase() === 'true';
    }
    return userResource(applyUser(req, u, { active }), b);
  }));
  app.delete<{ Params: { id: string } }>('/scim/v2/Users/:id', route((req, reply) => {
    const u = findUserByScimId(req.params.id);
    if (!u) throw new ScimError(404, 'User not found');
    deleteScimUser(u.id);
    logEvent('warn', 'auth', `SCIM: removed ${u.username}`, { ip: req.ip });
    reply.code(204);
    return '';
  }));

  // ---------------------------------------------------------------- Groups
  const touchMembers = (g: ScimGroupRow, before: number[]) => { for (const id of new Set([...before, ...g.members])) refresh(id); };
  const memberIds = (value: unknown): number[] => asArray(value).map((m) => findUserByScimId(String((m as { value?: unknown })?.value ?? ''))?.id).filter((x): x is number => !!x);
  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>('/scim/v2/Groups', route((req, _r, b) => {
    const name = filterEq(req.query.filter, 'displayName');
    const all = listScimGroups().filter((g) => name === null || g.name.toLowerCase() === name.toLowerCase());
    const p = page(all, req.query);
    return { schemas: [LIST], ...p, Resources: p.Resources.map((g) => groupResource(g, b)) };
  }));
  app.get<{ Params: { id: string } }>('/scim/v2/Groups/:id', route((req, _r, b) => {
    const g = getScimGroup(req.params.id);
    if (!g) throw new ScimError(404, 'Group not found');
    return groupResource(g, b);
  }));
  app.post<{ Body: { displayName?: string; externalId?: string; members?: unknown } }>('/scim/v2/Groups', route((req, reply, b) => {
    const name = String(req.body?.displayName ?? '').trim();
    if (!name || name.length > 120) throw new ScimError(400, 'displayName is required', 'invalidValue');
    if (listScimGroups().some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new ScimError(409, 'A group with that displayName exists', 'uniqueness');
    const id = randomUUID();
    saveScimGroup({ id, name, externalId: req.body?.externalId });
    setScimMembers(id, memberIds(req.body?.members));
    const g = getScimGroup(id)!;
    touchMembers(g, []);
    reply.code(201).header('Location', `${b}/Groups/${id}`);
    return groupResource(g, b);
  }));
  app.put<{ Params: { id: string }; Body: { displayName?: string; externalId?: string; members?: unknown } }>('/scim/v2/Groups/:id', route((req, _r, b) => {
    const cur = getScimGroup(req.params.id);
    if (!cur) throw new ScimError(404, 'Group not found');
    saveScimGroup({ id: cur.id, name: String(req.body?.displayName ?? cur.name).trim() || cur.name, externalId: req.body?.externalId ?? cur.externalId });
    setScimMembers(cur.id, memberIds(req.body?.members));
    const g = getScimGroup(cur.id)!;
    touchMembers(g, cur.members);
    return groupResource(g, b);
  }));
  app.patch<{ Params: { id: string }; Body: { schemas?: string[]; Operations?: PatchOp[] } }>('/scim/v2/Groups/:id', route((req, _r, b) => {
    const cur = getScimGroup(req.params.id);
    if (!cur) throw new ScimError(404, 'Group not found');
    if (!req.body?.schemas?.includes(PATCH)) throw new ScimError(400, 'Not a PatchOp message', 'invalidSyntax');
    let members = new Set(cur.members);
    let name = cur.name;
    for (const op of req.body.Operations ?? []) {
      const kind = op.op.toLowerCase();
      const path = (op.path ?? '').toLowerCase();
      if (path === 'displayname' && typeof op.value === 'string') { name = op.value; continue; }
      if (path.startsWith('members[')) { // remove a single member: members[value eq "<id>"]
        const m = /"([^"]+)"/.exec(op.path ?? '');
        const u = m ? findUserByScimId(m[1]) : null;
        if (u && kind === 'remove') members.delete(u.id);
        continue;
      }
      if (path === 'members' || path === '') {
        const vals = path === '' && op.value && typeof op.value === 'object' && 'members' in (op.value as object) ? (op.value as { members: unknown }).members : op.value;
        if (path === '' && op.value && typeof op.value === 'object' && 'displayName' in (op.value as object)) name = String((op.value as { displayName: unknown }).displayName);
        const ids = memberIds(vals);
        if (kind === 'add') ids.forEach((i) => members.add(i));
        else if (kind === 'remove') { if (ids.length) ids.forEach((i) => members.delete(i)); else members = new Set(); }
        else if (kind === 'replace') members = new Set(ids);
      }
    }
    saveScimGroup({ id: cur.id, name, externalId: cur.externalId });
    setScimMembers(cur.id, [...members]);
    const g = getScimGroup(cur.id)!;
    touchMembers(g, cur.members);
    return groupResource(g, b);
  }));
  app.delete<{ Params: { id: string } }>('/scim/v2/Groups/:id', route((req, reply) => {
    const g = getScimGroup(req.params.id);
    if (!g) throw new ScimError(404, 'Group not found');
    deleteScimGroup(g.id);
    touchMembers({ ...g, members: [] }, g.members);
    reply.code(204);
    return '';
  }));
}
