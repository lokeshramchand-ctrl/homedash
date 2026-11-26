// Who may do what, beyond the three global roles:
//   - groups from the identity provider (OIDC claims or SCIM) map to a role and to teams,
//   - a team limits a user to certain guests (by id range or Proxmox tag),
//   - a user with at least one team is "scoped": they only see and act on their guests and nothing host-wide.
// Users without teams behave exactly as before, so turning this on never changes existing accounts.
import { cfg } from './config.js';
import { findUserById, scimGroupsOf } from './db.js';
import type { UserRow } from './db.js';
import { atLeast, parseRole } from './roles.js';
import type { Role } from './roles.js';

const A = cfg.access;
const ROLE_ORDER: Role[] = ['viewer', 'operator', 'admin'];

/** Highest role among the groups the user holds in any role_map entry; null when no group matches. */
export function roleFromGroups(groups: string[]): Role | null {
  const have = new Set(groups.map((g) => g.toLowerCase()));
  let best: Role | null = null;
  for (const role of ROLE_ORDER) {
    if ((A.groupRoles[role] ?? []).some((g) => have.has(g.toLowerCase())) && (!best || atLeast(role, best))) best = role;
  }
  return best;
}

export function teamsFromGroups(groups: string[]): string[] {
  const out = new Set<string>();
  const have = new Set(groups.map((g) => g.toLowerCase()));
  for (const [group, teams] of Object.entries(A.groupTeams)) if (have.has(group.toLowerCase())) for (const t of teams) if (A.teams[t]) out.add(t);
  return [...out].sort();
}

/**
 * The access an identity-provider user gets. A group_roles match wins; without one the configured default applies,
 * so a person who is in no mapped group is not silently promoted. `adminUsers` (a static list) always grants admin.
 */
export function accessFromGroups(groups: string[], fallback: Role, isAdminListed: boolean): { role: Role; teams: string[] } {
  if (isAdminListed) return { role: 'admin', teams: [] };
  const hasMap = Object.values(A.groupRoles).some((l) => l.length);
  const role = hasMap ? (roleFromGroups(groups) ?? fallback) : fallback;
  return { role, teams: teamsFromGroups(groups) };
}

// ---- scope -------------------------------------------------------------------------------------
/** One team's slice of one cluster (or of every cluster when `cluster` is undefined). */
interface Rule { cluster?: string; vmids: Set<number>; ranges: [number, number][]; tags: Set<string> }
export interface Scope { rules: Rule[] }

/** Union of everything the user's teams allow. null = not scoped. Unknown team names grant nothing. */
export function scopeOf(teams: string[]): Scope | null {
  if (!teams.length) return null;
  const rules: Rule[] = [];
  for (const name of teams) {
    const t = A.teams[name];
    if (!t) continue;
    const r: Rule = { cluster: t.cluster, vmids: new Set(), ranges: [], tags: new Set(t.tags.map((x) => x.toLowerCase())) };
    for (const [lo, hi] of t.ranges) { if (lo === hi) r.vmids.add(lo); else r.ranges.push([lo, hi]); }
    rules.push(r);
  }
  return { rules };
}

/** `cluster` is part of the test because guest ids repeat across clusters: team "web" owns 100-120 on one cluster only. */
export const inScope = (s: Scope | null, g: { vmid: number; tags: string[]; cluster?: string }): boolean =>
  s === null || s.rules.some((r) => (!r.cluster || !g.cluster || r.cluster === g.cluster)
    && (r.vmids.has(g.vmid) || r.ranges.some(([lo, hi]) => g.vmid >= lo && g.vmid <= hi) || g.tags.some((t) => r.tags.has(t.toLowerCase()))));

/** Routes a scoped user may reach at all. Everything else is host-wide and refused. */
const SCOPED_ALLOWED = [
  /^\/api\/auth\//, /^\/api\/features$/, /^\/api\/clusters$/, /^\/api\/approvals/, /^\/api\/guests(\/|$)/,
];
export const scopedMayReach = (path: string) => SCOPED_ALLOWED.some((re) => re.test(path));

/** Current role and teams for a signed-in user, read live so a change in the identity provider applies immediately. */
export function liveAccess(userId: number, sessionRole: Role | null): { role: Role; teams: string[]; disabled: boolean; user: UserRow | null } {
  const u = findUserById(userId);
  if (!u) return { role: parseRole(sessionRole, 'admin'), teams: [], disabled: true, user: null };
  const role = parseRole(u.role ?? sessionRole, 'admin');
  const groups = u.scimId ? [...u.groups, ...scimGroupsOf(u.id)] : u.groups;
  // SCIM-managed users are re-evaluated from their current group membership on every request.
  if (u.scimId) {
    const a = accessFromGroups(groups, role, false);
    return { role: Object.values(A.groupRoles).some((l) => l.length) ? a.role : role, teams: a.teams.length ? a.teams : u.teams.filter((t) => A.teams[t]), disabled: u.disabled, user: u };
  }
  return { role, teams: u.teams.filter((t) => A.teams[t]), disabled: u.disabled, user: u };
}
