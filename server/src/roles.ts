// Three roles, checked in one place (the auth hook). Every route is covered by path and method, so a new
// route cannot forget to check a role.
//   viewer   read-only dashboard pages
//   operator viewer + anything that changes state (power, snapshots, settings, AI chat, ...)
//   admin    operator + the Data manager (databases), host journal, Loki and Prometheus queries
// Existing users and sessions without a role keep their old behaviour (admin) so nobody is locked out;
// set a lower role per user (create-user) or via OIDC_DEFAULT_ROLE to enforce least privilege.

export type Role = 'viewer' | 'operator' | 'admin';
export const ROLES: readonly Role[] = ['viewer', 'operator', 'admin'];
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
export const parseRole = (v: unknown, fallback: Role): Role => (isRole(v) ? v : fallback);
export const atLeast = (have: Role, need: Role) => RANK[have] >= RANK[need];

// Areas that expose data from other systems, not just the state of this dashboard.
const ADMIN_PREFIXES = ['/api/data', '/api/logs', '/api/loki', '/api/metrics', '/api/admin', '/api/monitoring/sources', '/api/monitoring/catalog'];
// Changing the reverse proxy or powering off the node is administration, not operation.
const ADMIN_WRITE_PREFIXES = ['/api/nginx', '/api/host', '/api/notify/routes'];

/** The lowest role allowed to call `method path` (path may be a matched route pattern or a decoded URL path). */
export function requiredRole(method: string, path: string): Role {
  if (path.startsWith('/api/auth/')) return 'viewer'; // login, logout, who am I: any signed-in user
  if (path.startsWith('/api/prefs/')) return 'viewer'; // a person's own layout and theme: harmless, so every role may save them
  if (ADMIN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return 'admin';
  const read = method === 'GET' || method === 'HEAD';
  if (!read && ADMIN_WRITE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return 'admin';
  return read ? 'viewer' : 'operator';
}

/** The role a request needs, taking the stricter of the URL path and the matched route. */
export function neededRole(method: string, path: string, routed: string): Role {
  const a = requiredRole(method, path), b = routed ? requiredRole(method, routed) : 'viewer';
  return atLeast(a, b) ? a : b;
}
