import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cfg, dataConfigured } from './config.js';
import { HttpError, notConfigured } from './errors.js';
import { createDriver, DriverError, KIND_INFO } from './datasources/core/index.js';
import type { ConnConfig, Driver, Kind } from './datasources/core/index.js';
import { clamp } from './datasources/core/util.js';
import * as store from './datasources/store.js';
import { assertDestinationAllowed } from './datasources/netguard.js';
import type { DsInput } from './datasources/store.js';

// HTTP adapter for the data manager. All engine logic lives in datasources/core (framework-free).
// Guardrails live here: auth (global session hook), per-connection read-only flag, audit of every
// query/write/config change, row and time limits, and secrets that never leave the server.

const IDLE_MS = 5 * 60_000;
const pool = new Map<string, { driver: Driver; stamp: number; secrets: string[]; timer?: NodeJS.Timeout }>();

async function driverFor(id: string): Promise<{ driver: Driver; doc: Awaited<ReturnType<typeof store.get>>['doc']; secrets: string[] }> {
  if (!dataConfigured()) throw notConfigured('The data manager (DATASOURCE_KEY)');
  const { doc, config } = await store.get(id);
  let e = pool.get(id);
  // Connections created in the UI are re-checked on every (re)connect, so a DNS name cannot be repointed later.
  if (!e || e.stamp !== doc.updatedAt.getTime()) await assertDestinationAllowed(config, cfg.datasourceAllowedNets, doc.source === 'env');
  if (e && e.stamp !== doc.updatedAt.getTime()) { await dropDriver(id); e = undefined; }
  if (!e) {
    e = { driver: createDriver(doc.kind, config, !doc.readOnly), stamp: doc.updatedAt.getTime(), secrets: store.secretsOf(config) };
    pool.set(id, e);
  }
  clearTimeout(e.timer);
  e.timer = setTimeout(() => { void dropDriver(id); }, IDLE_MS);
  e.timer.unref();
  return { driver: e.driver, doc, secrets: e.secrets };
}
async function dropDriver(id: string) {
  const e = pool.get(id);
  if (!e) return;
  pool.delete(id);
  clearTimeout(e.timer);
  await e.driver.close().catch(() => undefined);
}
export async function closeData() { await Promise.all([...pool.keys()].map(dropDriver)); }

const NET = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|ENETUNREACH|Server selection timed out|connect ETIMEDOUT|Connection terminated|Connection is closed|Client is closed|Socket closed|timeout exceeded when trying to connect/i;

/** Maps whatever an engine throws to {status, code, message} and strips secrets from the text. */
function mapError(e: unknown, secrets: string[]): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof DriverError) return new HttpError(e.status, e.code, e.message);
  let m = e instanceof Error ? e.message : String(e);
  for (const s of secrets) m = m.split(s).join('•••');
  m = m.replace(/(\/\/[^:/@\s]+:)[^@\s]*@/g, '$1•••@').slice(0, 600);
  const code = (e as { code?: string }).code ?? '';
  if (NET.test(m) || NET.test(code)) return new HttpError(502, 'DB_UNREACHABLE', `Cannot reach the database: ${m}`);
  // 502, never 401: the UI treats any 401 as an expired dashboard session.
  if (/WRONGPASS|NOAUTH|authentication failed|Access denied for user|SASL|password authentication failed/i.test(m)) return new HttpError(502, 'DB_AUTH', `Database rejected the credentials: ${m}`);
  if (/not authorized|permission denied|command denied|NOPERM|READONLY|read-only|ReadOnly/i.test(m)) return new HttpError(403, 'DB_DENIED', m);
  return new HttpError(400, 'QUERY_ERROR', m);
}

const audit = (req: FastifyRequest, d: { ds?: string; dsName?: string; action: string; detail?: string; result: 'ok' | 'refused' | 'error'; ms?: number; rows?: number }) => {
  try { store.addAudit({ user: req.user?.username ?? '?', ip: req.ip, ...d, detail: d.detail?.slice(0, 600) }); } catch (e) { req.log.warn({ err: (e as Error).message }, 'datasource audit failed'); }
};

interface Q { ns?: string; entity?: string; limit?: string; offset?: string; cursor?: string; filter?: string; sort?: string; dir?: string; id?: string }
const need = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || (v === '' && what !== 'ns')) throw new HttpError(400, 'BAD_REQUEST', `${what} is required`);
  if (v.length > 512) throw new HttpError(400, 'BAD_REQUEST', `${what} is too long`);
  return v;
};
const parseId = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw; // already structured (JSON body)
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'BAD_REQUEST', 'id must be JSON'); }
};

export function registerData(app: FastifyInstance) {
  const B = '/api/data/sources/:id';
  type P = { Params: { id: string } };

  /** Runs `fn` against a driver, maps errors, optionally refuses on read-only connections, and audits. */
  async function use<T>(req: FastifyRequest<P>, opts: { action?: string; write?: boolean; detail?: () => string }, fn: (d: Driver, w: { readOnly: boolean; name: string }) => Promise<T>): Promise<T> {
    const t0 = Date.now();
    const { driver, doc, secrets } = await driverFor(req.params.id);
    const ctx = { ds: req.params.id, dsName: doc.name, action: opts.action ?? '', detail: opts.detail?.() };
    if (opts.write && doc.readOnly) {
      if (opts.action) await audit(req, { ...ctx, result: 'refused', detail: `read-only · ${ctx.detail ?? ''}` });
      throw new HttpError(403, 'READ_ONLY', `"${doc.name}" is a read-only connection. Edit the connection to allow writes.`);
    }
    try {
      const r = await fn(driver, { readOnly: doc.readOnly, name: doc.name });
      if (opts.action) await audit(req, { ...ctx, result: 'ok', ms: Date.now() - t0, rows: (r as { affected?: number })?.affected });
      return r;
    } catch (e) {
      const he = mapError(e, secrets);
      if (opts.action) await audit(req, { ...ctx, result: he.status === 403 ? 'refused' : 'error', detail: `${ctx.detail ?? ''} → ${he.message}`, ms: Date.now() - t0 });
      throw he;
    }
  }

  app.addHook('onReady', async () => {
    if (!dataConfigured()) {
      if (cfg.envDatasources.length) app.log.warn('DS_* connections in .env are ignored until DATASOURCE_KEY is set');
      return;
    }
    const r = await store.syncFromEnv();
    for (const s of r.skipped) app.log.warn({ envId: s.envId }, `DS_${s.envId}_* skipped: ${s.reason}`);
    if (r.added.length || r.updated.length || r.removed.length || r.skipped.length) {
      app.log.info({ added: r.added, updated: r.updated, removed: r.removed, skipped: r.skipped.length }, 'data manager: synced connections from .env');
      try {
        store.addAudit({
          user: 'env', ip: '-', action: 'connection.env-sync', result: r.skipped.length ? 'error' : 'ok',
          detail: [r.added.length && `added ${r.added.join(', ')}`, r.updated.length && `updated ${r.updated.join(', ')}`, r.removed.length && `removed ${r.removed.join(', ')}`,
            r.skipped.length && `skipped ${r.skipped.map((x) => `DS_${x.envId}: ${x.reason}`).join('; ')}`].filter(Boolean).join(' · ').slice(0, 600),
        });
      } catch (e) { app.log.warn({ err: (e as Error).message }, 'datasource audit failed'); }
    }
  });

  app.get('/api/data/status', async () => ({
    configured: dataConfigured(), kinds: KIND_INFO, sqliteDirs: cfg.sqliteDirs,
  }));

  // ------------------------------------------------------------ connections
  app.get('/api/data/sources', async () => {
    if (!dataConfigured()) throw notConfigured('The data manager (DATASOURCE_KEY)');
    return store.list();
  });

  app.post<{ Body: DsInput }>('/api/data/sources', async (req) => {
    if (!dataConfigured()) throw notConfigured('The data manager (DATASOURCE_KEY)');
    await assertDestinationAllowed(store.normalise(req.body ?? {}).config, cfg.datasourceAllowedNets, false);
    const r = await store.create(req.body ?? {}, req.user!.username);
    await audit(req, { ds: r.id, dsName: r.name, action: 'connection.create', detail: `${r.kind} ${r.config.host ?? r.config.file ?? 'uri'} ${r.readOnly ? 'read-only' : 'READ-WRITE'}`, result: 'ok' });
    return r;
  });

  app.put<P & { Body: DsInput }>(B, async (req) => {
    if (!dataConfigured()) throw notConfigured('The data manager (DATASOURCE_KEY)');
    const cur = await store.get(req.params.id);
    if (cur.doc.source !== 'env') await assertDestinationAllowed(store.normalise({ ...(req.body ?? {}), kind: cur.doc.kind }, { config: cur.config, kind: cur.doc.kind }).config, cfg.datasourceAllowedNets, false);
    const r = await store.update(req.params.id, req.body ?? {});
    await dropDriver(req.params.id);
    await audit(req, { ds: r.id, dsName: r.name, action: 'connection.update', detail: r.readOnly ? 'read-only' : 'READ-WRITE', result: 'ok' });
    return r;
  });

  app.delete<P>(B, async (req) => {
    if (!dataConfigured()) throw notConfigured('The data manager (DATASOURCE_KEY)');
    const d = await store.remove(req.params.id);
    await dropDriver(req.params.id);
    await audit(req, { ds: req.params.id, dsName: d.name, action: 'connection.delete', result: 'ok' });
    return { ok: true };
  });

  // Test an unsaved form (body) or a saved connection with optional overrides (id).
  app.post<{ Body: DsInput & { id?: string } }>('/api/data/test', async (req) => {
    if (!dataConfigured()) throw notConfigured('The data manager (DATASOURCE_KEY)');
    const b = req.body ?? {};
    let kind: Kind, config: ConnConfig;
    let trusted = false;
    if (b.id) {
      const cur = await store.get(b.id);
      // A connection declared in .env is tested exactly as saved: no overrides, so its saved password can never
      // be sent to a host the caller typed.
      if (cur.doc.source === 'env') { kind = cur.doc.kind; config = cur.config; trusted = true; }
      else ({ kind, config } = store.normalise(b, { config: cur.config, kind: cur.doc.kind }));
    } else ({ kind, config } = store.normalise(b));
    await assertDestinationAllowed(config, cfg.datasourceAllowedNets, trusted);
    const d = createDriver(kind, config, false);
    try {
      const r = await d.ping();
      await audit(req, { dsName: String(b.name ?? ''), ds: b.id, action: 'connection.test', detail: `${kind} ok`, result: 'ok', ms: r.ms });
      return { ok: true, ...r };
    } catch (e) {
      const he = mapError(e, store.secretsOf(config));
      await audit(req, { dsName: String(b.name ?? ''), ds: b.id, action: 'connection.test', detail: he.message, result: 'error' });
      throw he;
    } finally { await d.close(); }
  });

  // ------------------------------------------------------------ introspection
  app.get<P>(`${B}/overview`, async (req) => use(req, {}, async (d, w) => ({ caps: d.caps, kind: d.kind, readOnly: w.readOnly, ...(await d.ping()) })));
  app.get<P>(`${B}/info`, async (req) => use(req, {}, (d) => d.info()));
  app.get<P>(`${B}/activity`, async (req) => use(req, {}, (d) => d.activity()));
  app.get<P>(`${B}/namespaces`, async (req) => use(req, {}, (d) => d.namespaces()));
  app.get<P & { Querystring: Q }>(`${B}/entities`, async (req) => use(req, {}, (d) => d.entities(need(req.query.ns ?? '', 'ns'))));
  app.get<P & { Querystring: Q }>(`${B}/describe`, async (req) => use(req, {}, (d) => d.describe(need(req.query.ns ?? '', 'ns'), need(req.query.entity, 'entity'))));

  const browseOpts = (q: Q) => ({
    limit: clamp(parseInt(q.limit ?? '50', 10), 1, 500), offset: clamp(parseInt(q.offset ?? '0', 10), 0, 10_000_000),
    cursor: q.cursor || undefined, filter: q.filter?.slice(0, 4000), sort: q.sort?.slice(0, 128) || undefined, dir: q.dir === 'desc' ? 'desc' as const : 'asc' as const,
  });
  app.get<P & { Querystring: Q }>(`${B}/browse`, async (req) => use(req, {}, (d) => d.browse(need(req.query.ns ?? '', 'ns'), need(req.query.entity, 'entity'), browseOpts(req.query))));

  app.get<P & { Querystring: Q }>(`${B}/record`, async (req) => use(req, {}, (d) => d.getRecord(need(req.query.ns ?? '', 'ns'), need(req.query.entity, 'entity'), parseId(req.query.id))));

  // ------------------------------------------------------------ writes (refused on read-only connections)
    app.put<P & { Body: { ns?: string; entity?: string; id?: unknown; doc?: Record<string, unknown> } }>(`${B}/record`, { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const { ns = '', entity, id = null, doc } = req.body ?? {};
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'BAD_REQUEST', 'doc must be an object');
    return use(req, { action: id === null ? 'record.insert' : 'record.update', write: true, detail: () => `${ns}.${entity} ${JSON.stringify(id).slice(0, 120)}` },
      async (d) => ({ id: await d.upsert(ns, need(entity, 'entity'), id, doc) }));
  });

  app.post<P & { Body: { ns?: string; entity?: string; id?: unknown } }>(`${B}/record/delete`, async (req) => {
    const { ns = '', entity, id } = req.body ?? {};
    if (id === undefined || id === null) throw new HttpError(400, 'BAD_REQUEST', 'id is required');
    return use(req, { action: 'record.delete', write: true, detail: () => `${ns}.${entity} ${JSON.stringify(id).slice(0, 120)}` },
      async (d) => ({ affected: await d.remove(ns, need(entity, 'entity'), id) }));
  });

  // Redis only: change or clear a key's TTL without rewriting the value.
  app.post<P & { Body: { ns?: string; key?: string; ttl?: number } }>(`${B}/redis/ttl`, async (req) => {
    const { ns = '', key, ttl = -1 } = req.body ?? {};
    return use(req, { action: 'redis.ttl', write: true, detail: () => `${ns} ${key} ${ttl}` }, async (d) => {
      const r = d as unknown as { setTtl?: (ns: string, k: string, s: number) => Promise<void> };
      if (!r.setTtl) throw new HttpError(400, 'UNSUPPORTED', 'Only Redis has TTLs');
      await r.setTtl(ns, need(key, 'key'), Number(ttl));
      return { ok: true };
    });
  });

  app.post<P & { Body: { ns?: string; entity?: string; name?: string; columns?: { field: string; dir?: 'asc' | 'desc' }[]; unique?: boolean } }>(`${B}/index`, async (req) => {
    const { ns = '', entity, name, columns = [], unique } = req.body ?? {};
    return use(req, { action: 'index.create', write: true, detail: () => `${ns}.${entity} ${columns.map((c) => c.field).join(',')}` },
      async (d) => ({ name: await d.createIndex(ns, need(entity, 'entity'), { name, columns, unique }) }));
  });
  app.post<P & { Body: { ns?: string; entity?: string; name?: string } }>(`${B}/index/drop`, async (req) => {
    const { ns = '', entity, name } = req.body ?? {};
    return use(req, { action: 'index.drop', write: true, detail: () => `${ns}.${entity} ${name}` }, async (d) => { await d.dropIndex(ns, need(entity, 'entity'), need(name, 'name')); return { ok: true }; });
  });

  app.post<P & { Body: { ns?: string; entity?: string; confirm?: string } }>(`${B}/drop`, async (req) => {
    const { ns = '', entity, confirm } = req.body ?? {};
    if (confirm !== entity) throw new HttpError(400, 'CONFIRM', 'Type the exact name to confirm');
    return use(req, { action: 'entity.drop', write: true, detail: () => `${ns}.${entity}` }, async (d) => { await d.dropEntity(ns, need(entity, 'entity')); return { ok: true }; });
  });

  // ------------------------------------------------------------ optional engine features (caps.search / caps.actions)
  app.post<P & { Body: { ns?: string; entity?: string; field?: string; query?: string; limit?: number; filter?: string; params?: Record<string, string | number> } }>(`${B}/search`, { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const { ns = '', entity, field, query = '', filter, params = {} } = req.body ?? {};
    if (typeof query !== 'string' || !query.trim()) throw new HttpError(400, 'BAD_REQUEST', 'query is required');
    return use(req, { action: 'search', detail: () => `${ns}.${entity} ${field ?? ''} ${query.slice(0, 80)}` }, (d) => {
      if (!d.search || !d.caps.search) throw new HttpError(400, 'UNSUPPORTED', 'This database has no search');
      return d.search(ns, need(entity, 'entity'), { field, query, filter: filter?.slice(0, 4000), limit: clamp(Number(req.body?.limit ?? 10), 1, 200), params });
    });
  });

  app.post<P & { Body: { ns?: string; entity?: string; action?: string; confirm?: string } }>(`${B}/action`, async (req) => {
    const { ns = '', entity = '', action, confirm } = req.body ?? {};
    const id = need(action, 'action');
    // Actions change server state, so they are refused on read-only connections.
    return use(req, { action: `action.${id}`, write: true, detail: () => `${ns}.${entity}` }, async (d) => {
      const spec = d.caps.actions?.find((a) => a.id === id);
      if (!spec || !d.runAction) throw new HttpError(400, 'UNSUPPORTED', 'Unknown action for this database');
      if (spec.confirm && confirm !== entity) throw new HttpError(400, 'CONFIRM', 'Type the exact name to confirm');
      return d.runAction(ns, entity, id);
    });
  });

  // ------------------------------------------------------------ console
  app.post<P & { Body: { ns?: string; text?: string; allowWrite?: boolean; limit?: number; timeoutSec?: number } }>(`${B}/query`, { bodyLimit: 1024 * 1024 }, async (req) => {
    const { ns = '', text = '', allowWrite = false } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'BAD_REQUEST', 'text is required');
    if (text.length > 200_000) throw new HttpError(400, 'BAD_REQUEST', 'Query is too long');
    const o = { limit: clamp(Number(req.body?.limit ?? 200), 1, 5000), timeoutMs: clamp(Number(req.body?.timeoutSec ?? 20), 1, 60) * 1000 };
    // The console is read-only unless the caller opts in AND the connection allows writes.
    return use(req, { action: allowWrite ? 'query.write' : 'query', write: allowWrite, detail: () => text.replace(/\s+/g, ' ').slice(0, 500) }, (d) => d.query(ns, text, { ...o, readOnly: !allowWrite }));
  });

  // ------------------------------------------------------------ export / import
  app.get<P & { Querystring: Q & { format?: string } }>(`${B}/export`, async (req, reply) => {
    const ns = req.query.ns ?? '';
    const entity = need(req.query.entity, 'entity');
    const csv = req.query.format === 'csv';
    const MAX = 100_000;
    const rows = await use(req, { action: 'export', detail: () => `${ns}.${entity} ${csv ? 'csv' : 'json'} ${req.query.filter ?? ''}` }, async (d) => {
      const all: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      let offset = 0;
      for (;;) {
        const p = await d.browse(ns, entity, { ...browseOpts(req.query), limit: 500, offset, cursor });
        all.push(...p.rows);
        offset += p.rows.length;
        cursor = p.nextCursor;
        if (!p.hasMore || all.length >= MAX || (!p.rows.length && !cursor)) break;
      }
      return all;
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = entity.replace(/[^\w.-]/g, '_').slice(0, 60);
    reply.header('Content-Disposition', `attachment; filename="${safe}-${stamp}.${csv ? 'csv' : 'json'}"`);
    if (!csv) return reply.type('application/json').send(JSON.stringify(rows, null, 2));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    // Leading = + - @ would be run as a formula by spreadsheets: prefix with a tab-less apostrophe.
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return reply.type('text/csv; charset=utf-8').send([cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n'));
  });

  app.post<P & { Body: { ns?: string; entity?: string; rows?: Record<string, unknown>[] } }>(`${B}/import`, { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const { ns = '', entity, rows } = req.body ?? {};
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'BAD_REQUEST', 'rows must be a non-empty array');
    if (rows.length > 5000) throw new HttpError(400, 'BAD_REQUEST', 'Import is limited to 5000 rows at a time');
    return use(req, { action: 'import', write: true, detail: () => `${ns}.${entity} ${rows.length} rows` }, async (d) => {
      let inserted = 0;
      const errors: { row: number; error: string }[] = [];
      for (const [i, r] of rows.entries()) {
        try { await d.upsert(ns, need(entity, 'entity'), null, r); inserted++; } catch (e) {
          if (errors.length < 20) errors.push({ row: i + 1, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        }
      }
      return { inserted, failed: rows.length - inserted, errors, affected: inserted };
    });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/data/audit', async (req) => {
    if (!dataConfigured()) throw notConfigured('The data manager (DATASOURCE_KEY)');
    const rows = store.listAudit(clamp(parseInt(req.query.limit ?? '100', 10), 1, 500));
    return rows.map((r) => ({ ts: r.ts.toISOString(), user: r.user, ip: r.ip, connection: r.dsName, action: r.action, detail: r.detail, result: r.result, ms: r.ms, rows: r.rows }));
  });
}
