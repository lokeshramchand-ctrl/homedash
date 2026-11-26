// Service registry: the things you run (apps, databases, proxies, network gear), kept apart from the integrations that watch them.
// A service can be linked to one check that a monitoring source reports, and can depend on other services, so a failure can be
// traced to what it takes down. A service with no link is "unmonitored", never "healthy": missing data is not good news.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDb } from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { monitoringEngine } from './monitoring/sources.js';
import type { Merged } from './monitoring/types.js';

export const CRITICALITY = ['low', 'normal', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITY)[number];
export interface Service {
  id: string; name: string; description: string; category: string; url: string; host: string; port: number | null; deployment: string;
  resource: string; monitor: string; owner: string; criticality: Criticality; tags: string[]; meta: Record<string, string>;
  createdAt: number; updatedAt: number;
}
export interface Edge { from: string; to: string; note: string }
/** up/down/pending/maintenance come from the linked check. The rest say why there is no verdict. */
export type Health = 'up' | 'down' | 'pending' | 'maintenance' | 'unknown' | 'stale' | 'unmonitored';
export interface Verdict { health: Health; detail: string; checkedAt: number | null }

// ---- pure graph and health logic ---------------------------------------------------------------

/** Services that (directly or through others) depend on `id`, nearest first. `edges` read "from depends on to". */
export function dependents(id: string, edges: Edge[]): { id: string; depth: number }[] {
  const out: { id: string; depth: number }[] = [];
  const seen = new Set([id]);
  let frontier = [id]; let depth = 0;
  while (frontier.length) {
    depth++;
    const next: string[] = [];
    for (const f of frontier) for (const e of edges) if (e.to === f && !seen.has(e.from)) { seen.add(e.from); out.push({ id: e.from, depth }); next.push(e.from); }
    frontier = next;
  }
  return out;
}
/** What `id` needs (directly or through others), nearest first. */
export function dependencies(id: string, edges: Edge[]): { id: string; depth: number }[] {
  return dependents(id, edges.map((e) => ({ ...e, from: e.to, to: e.from })));
}
/** Whether adding "from depends on to" would create a loop (including depending on itself). */
export const wouldCycle = (from: string, to: string, edges: Edge[]): boolean => from === to || dependents(from, edges).some((d) => d.id === to);

/** The linked check's state as a verdict. `monitor` is "<source id>|<check key>". */
export function verdictFor(monitor: string, m: Merged): Verdict {
  if (!monitor) return { health: 'unmonitored', detail: 'No monitor is linked to this service.', checkedAt: null };
  const [src, ...rest] = monitor.split('|');
  const key = rest.join('|');
  const source = m.sources.find((s) => s.id === src);
  if (!source) return { health: 'unknown', detail: 'The monitoring source linked to this service is not connected any more.', checkedAt: null };
  const check = m.checks.find((c) => c.source === src && c.key === key);
  if (!source.ok) return { health: 'stale', detail: `${source.label} cannot be read${check ? `; last known: ${check.status}` : ''}.`, checkedAt: source.checkedAt || null };
  if (!check) return { health: 'unknown', detail: `${source.label} no longer reports this check.`, checkedAt: source.checkedAt || null };
  return { health: check.status, detail: check.detail || `${source.label}: ${check.status}`, checkedAt: source.checkedAt || null };
}

// ---- storage -----------------------------------------------------------------------------------

interface Row { id: string; name: string; description: string; category: string; url: string; host: string; port: number | null; deployment: string; resource: string; monitor: string; owner: string; criticality: string; tags: string; meta: string; created_at: number; updated_at: number }
const parse = <T,>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
const toService = (r: Row): Service => ({
  id: r.id, name: r.name, description: r.description, category: r.category, url: r.url, host: r.host, port: r.port, deployment: r.deployment, resource: r.resource,
  monitor: r.monitor, owner: r.owner, criticality: (CRITICALITY as readonly string[]).includes(r.criticality) ? (r.criticality as Criticality) : 'normal',
  tags: parse<string[]>(r.tags, []), meta: parse<Record<string, string>>(r.meta, {}), createdAt: r.created_at, updatedAt: r.updated_at,
});
export const listServices = (): Service[] => (getDb().prepare('SELECT * FROM registry_services ORDER BY name COLLATE NOCASE').all() as unknown as Row[]).map(toService);
export const getService = (id: string): Service | null => { const r = getDb().prepare('SELECT * FROM registry_services WHERE id = ?').get(id) as unknown as Row | undefined; return r ? toService(r) : null; };
export const listEdges = (): Edge[] => (getDb().prepare('SELECT service_id, depends_on, note FROM registry_deps').all() as { service_id: string; depends_on: string; note: string }[]).map((r) => ({ from: r.service_id, to: r.depends_on, note: r.note }));

const bad = (m: string) => new HttpError(400, 'BAD_REQUEST', m);
const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

/** Validates a form body. `prev` supplies the defaults for an edit. */
export function cleanInput(b: Record<string, unknown>, prev?: Service): Omit<Service, 'id' | 'createdAt' | 'updatedAt'> {
  const get = <K extends keyof Service>(k: K, fallback: Service[K]): unknown => (k in b ? b[k] : prev ? prev[k] : fallback);
  const name = str(get('name', ''), 80);
  if (!name) throw bad('Give the service a name');
  const url = str(get('url', ''), 500);
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw bad('The address must start with http:// or https://');
  const portRaw = get('port', null);
  const port = portRaw === null || portRaw === '' ? null : Number(portRaw);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw bad('The port must be a number from 1 to 65535');
  const crit = str(get('criticality', 'normal'), 10) || 'normal';
  if (!(CRITICALITY as readonly string[]).includes(crit)) throw bad(`Criticality must be one of ${CRITICALITY.join(', ')}`);
  const tagsRaw = get('tags', []);
  const tags = (Array.isArray(tagsRaw) ? tagsRaw : String(tagsRaw).split(',')).map((t) => str(t, 30)).filter(Boolean).slice(0, 10);
  const metaRaw = get('meta', {});
  const meta: Record<string, string> = {};
  if (metaRaw && typeof metaRaw === 'object') for (const [k, v] of Object.entries(metaRaw as Record<string, unknown>).slice(0, 20)) { const kk = str(k, 40); if (kk) meta[kk] = str(v, 200); }
  const monitor = str(get('monitor', ''), 300);
  return {
    name, description: str(get('description', ''), 500), category: str(get('category', ''), 40), url, host: str(get('host', ''), 255), port,
    deployment: str(get('deployment', ''), 40), resource: str(get('resource', ''), 120), monitor, owner: str(get('owner', ''), 80), criticality: crit as Criticality, tags, meta,
  };
}

function save(id: string, v: ReturnType<typeof cleanInput>, who: string | null, creating: boolean) {
  const now = Date.now();
  if (creating) {
    getDb().prepare('INSERT INTO registry_services (id, name, description, category, url, host, port, deployment, resource, monitor, owner, criticality, tags, meta, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, v.name, v.description, v.category, v.url, v.host, v.port, v.deployment, v.resource, v.monitor, v.owner, v.criticality, JSON.stringify(v.tags), JSON.stringify(v.meta), now, now, who);
  } else {
    getDb().prepare('UPDATE registry_services SET name=?, description=?, category=?, url=?, host=?, port=?, deployment=?, resource=?, monitor=?, owner=?, criticality=?, tags=?, meta=?, updated_at=? WHERE id=?')
      .run(v.name, v.description, v.category, v.url, v.host, v.port, v.deployment, v.resource, v.monitor, v.owner, v.criticality, JSON.stringify(v.tags), JSON.stringify(v.meta), now, id);
  }
}

// ---- API ---------------------------------------------------------------------------------------

export function registerRegistry(app: FastifyInstance) {
  const audit = (req: { user?: { username: string } }, what: string) => logEvent('info', 'app', `${req.user?.username ?? 'someone'} ${what}`);

  /** Everyone signed in can read the registry. Writes are administrator-only under /api/admin. */
  app.get('/api/registry', async () => {
    const m = monitoringEngine.merged();
    const services = listServices();
    const edges = listEdges();
    const byId = new Map(services.map((s) => [s.id, s]));
    const verdicts = new Map(services.map((s) => [s.id, verdictFor(s.monitor, m)]));
    return {
      services: services.map((s) => {
        const v = verdicts.get(s.id)!;
        const needs = dependencies(s.id, edges);
        const downNeeds = needs.filter((n) => verdicts.get(n.id)?.health === 'down').map((n) => ({ id: n.id, name: byId.get(n.id)?.name ?? n.id, depth: n.depth }));
        return { ...s, ...v, dependsOn: edges.filter((e) => e.from === s.id).map((e) => e.to), dependentCount: dependents(s.id, edges).length, affectedBy: downNeeds };
      }),
      edges,
      checkedAt: m.checkedAt,
    };
  });

  app.get<{ Params: { id: string } }>('/api/registry/:id/impact', async (req) => {
    const s = getService(req.params.id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'No such service');
    const edges = listEdges(); const m = monitoringEngine.merged();
    const name = (id: string) => getService(id);
    const shape = (l: { id: string; depth: number }[]) => l.flatMap((x) => { const t = name(x.id); return t ? [{ id: t.id, name: t.name, depth: x.depth, criticality: t.criticality, health: verdictFor(t.monitor, m).health }] : []; });
    return { service: { id: s.id, name: s.name, ...verdictFor(s.monitor, m) }, wouldAffect: shape(dependents(s.id, edges)), dependsOn: shape(dependencies(s.id, edges)) };
  });

  // Checks a service can be linked to: whatever the connected monitoring sources report right now.
  app.get('/api/admin/registry/monitors', async () => {
    const m = monitoringEngine.merged();
    return m.checks.map((c) => {
      const src = m.sources.find((s) => s.id === c.source);
      return { value: `${c.source}|${c.key}`, label: `${src?.label ?? c.source}: ${c.name}`, status: c.status };
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/admin/registry', async (req, reply) => {
    const v = cleanInput(req.body ?? {});
    if (listServices().some((s) => s.name.toLowerCase() === v.name.toLowerCase())) throw new HttpError(409, 'DUPLICATE', 'A service with this name already exists');
    const id = `svc-${randomBytes(4).toString('hex')}`;
    save(id, v, req.user?.username ?? null, true);
    audit(req, `added the service "${v.name}" to the registry`);
    reply.code(201);
    return { id };
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/admin/registry/:id', async (req) => {
    const prev = getService(req.params.id);
    if (!prev) throw new HttpError(404, 'NOT_FOUND', 'No such service');
    const v = cleanInput(req.body ?? {}, prev);
    if (listServices().some((s) => s.id !== prev.id && s.name.toLowerCase() === v.name.toLowerCase())) throw new HttpError(409, 'DUPLICATE', 'A service with this name already exists');
    save(prev.id, v, null, false);
    audit(req, `changed the service "${v.name}" in the registry`);
    return { id: prev.id };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/registry/:id', async (req) => {
    const prev = getService(req.params.id);
    if (!prev) throw new HttpError(404, 'NOT_FOUND', 'No such service');
    const affected = dependents(prev.id, listEdges()).length;
    getDb().prepare('DELETE FROM registry_services WHERE id = ?').run(prev.id);
    audit(req, `removed the service "${prev.name}" from the registry (${affected} service(s) depended on it)`);
    return { ok: true, hadDependents: affected };
  });

  app.post<{ Params: { id: string }; Body: { dependsOn?: string; note?: string } }>('/api/admin/registry/:id/deps', async (req, reply) => {
    const a = getService(req.params.id); const b = getService(String(req.body?.dependsOn ?? ''));
    if (!a || !b) throw new HttpError(404, 'NOT_FOUND', 'No such service');
    const edges = listEdges();
    if (edges.some((e) => e.from === a.id && e.to === b.id)) throw new HttpError(409, 'DUPLICATE', 'That dependency already exists');
    if (wouldCycle(a.id, b.id, edges)) throw bad(a.id === b.id ? 'A service cannot depend on itself' : `${b.name} already depends on ${a.name}, so this would make a loop`);
    getDb().prepare('INSERT INTO registry_deps (service_id, depends_on, note) VALUES (?,?,?)').run(a.id, b.id, str(req.body?.note, 200));
    audit(req, `recorded that "${a.name}" depends on "${b.name}"`);
    reply.code(201);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; dep: string } }>('/api/admin/registry/:id/deps/:dep', async (req) => {
    const r = getDb().prepare('DELETE FROM registry_deps WHERE service_id = ? AND depends_on = ?').run(req.params.id, req.params.dep);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'No such dependency');
    audit(req, `removed a dependency of the service ${req.params.id}`);
    return { ok: true };
  });
}
