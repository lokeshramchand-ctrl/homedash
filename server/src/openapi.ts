// A generated API reference: every /api route that is registered, with the lowest role that may call it.
// It is built from the live route table, so it can never drift from the code. It lists what exists, not request bodies:
// those are documented in API_NOTES.md and by the web UI's own calls.
import type { FastifyInstance } from 'fastify';
import { requiredRole } from './roles.js';
import { currentVersion } from './updates.js';

export interface RouteInfo { method: string; url: string }

const seen: RouteInfo[] = [];

/** Must be registered before the routes it should see. */
export function collectRoutes(app: FastifyInstance) {
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== 'HEAD' && m !== 'OPTIONS') seen.push({ method: m, url: r.url });
  });
}

const PUBLIC = (url: string) => ['/api/auth/login', '/api/auth/config', '/api/auth/sso/', '/api/auth/passkey/login/', '/api/auth/passkey/config'].some((p) => url === p || (p.endsWith('/') && url.startsWith(p)));

/** Pure: the OpenAPI 3.0 document for a list of routes. */
export function buildOpenApi(routes: RouteInfo[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of [...routes].filter((x) => x.url.startsWith('/api/')).sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
    const oaPath = r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/\*$/, '/{path}');
    const params = [...oaPath.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const role = requiredRole(r.method, r.url);
    (paths[oaPath] ??= {})[r.method.toLowerCase()] = {
      tags: [r.url.split('/')[2] ?? 'api'],
      summary: `${r.method} ${r.url}`,
      'x-required-role': role,
      ...(PUBLIC(r.url) ? { security: [] } : {}),
      ...(params.length ? { parameters: params } : {}),
      responses: { '200': { description: 'OK' }, '401': { description: 'Not signed in' }, '403': { description: `Needs the ${role} role or a permitted action` } },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'homedash API', version, description: 'Generated from the running server. Sign in with a session cookie, or send an API token as "Authorization: Bearer hd_...". Every non-GET request from a browser-like client must carry "X-Requested-With: homedash". Roles: viewer (read), operator (power, snapshots, scenes), admin (everything else).' },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'API token from Access > API tokens' }, cookie: { type: 'apiKey', in: 'cookie', name: 'session' } } },
    security: [{ bearer: [] }, { cookie: [] }],
    paths,
  };
}

export function registerOpenApi(app: FastifyInstance) {
  app.get('/api/admin/openapi.json', async () => buildOpenApi(seen, currentVersion()));
}
