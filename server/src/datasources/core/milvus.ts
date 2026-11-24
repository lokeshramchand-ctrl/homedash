import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type {
  Activity, BrowseOpts, Capabilities, ConnConfig, Describe, Driver, Entity, IndexSpec, Namespace, Page, QueryOpts, QueryResult, SearchReq,
} from './types.js';
import { DriverError, unsupported } from './types.js';
import { clamp, jsonSafe } from './util.js';

// Milvus: database ─► collection ─► entity. Browse/Query use boolean filter expressions (not SQL), and
// the Search panel runs ANN similarity search. Collections must be loaded before they can be read.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const VECTOR = /Vector/i;
const isVector = (f: Any) => VECTOR.test(String(f.data_type ?? ''));
const status = (r: Any, what: string) => {
  const s = r?.status ?? r;
  if (s && s.error_code && s.error_code !== 'Success' && s.error_code !== 0) throw new DriverError(400, 'QUERY_ERROR', `${what}: ${s.reason || s.error_code}`);
  return r;
};
const lit = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? String(v) : JSON.stringify(String(v)));

export class MilvusDriver implements Driver {
  readonly kind = 'milvus';
  readonly caps: Capabilities;
  private c: MilvusClient;
  private db: string;

  constructor(private cfg: ConnConfig, private writable: boolean) {
    this.db = cfg.database || 'default';
    this.caps = {
      language: 'milvus-json', write: writable, indexes: false, activity: false, dropEntity: writable, importExport: true,
      filterHint: 'Boolean expression, e.g. id > 100 and category == "news"', entityLabel: 'collection', namespaceLabel: 'database',
      rowKey: 'pk-object',
      queryHelp: '{"collection":"docs","filter":"id > 10","limit":20,"output_fields":["id","title"]}',
      search: {
        label: 'Vector search',
        inputHint: 'Vector as a JSON array, e.g. [0.12, -0.3, ...] (must match the field dimension)',
        fields: true,
        params: [
          { name: 'metric_type', label: 'Metric', type: 'select', default: 'auto', options: ['auto', 'COSINE', 'L2', 'IP'] },
          { name: 'offset', label: 'Offset', type: 'number', default: 0 },
        ],
      },
      actions: [
        { id: 'load', label: 'Load into memory', scope: 'entity', write: true },
        { id: 'release', label: 'Release from memory', scope: 'entity', write: true },
        { id: 'flush', label: 'Flush', scope: 'entity', write: true },
        { id: 'compact', label: 'Compact', scope: 'entity', write: true },
      ],
    };
    const [host, port] = [cfg.host ?? 'localhost', cfg.port ?? 19530];
    this.c = new MilvusClient({
      address: `${host}:${port}`, ssl: !!cfg.tls, database: this.db, timeout: 20_000,
      ...(cfg.token ? { token: cfg.token } : cfg.username ? { username: cfg.username, password: cfg.password ?? '' } : {}),
      ...(cfg.tls ? { tls: { ...(cfg.ca ? { rootCert: Buffer.from(cfg.ca) } : {}), ...(cfg.tlsInsecure ? { skipCertCheck: true } : {}) } } : {}),
    } as Any);
  }

  private guardWrite(what: string) {
    if (!this.writable) throw new DriverError(403, 'DB_DENIED', `${what} needs a read-write connection`);
  }
  private dbn(ns: string) { return ns || this.db; }

  async ping() {
    const t0 = Date.now();
    const v = await this.c.getVersion();
    return { ms: Date.now() - t0, version: String((v as Any).version ?? 'unknown') };
  }

  async info() {
    const [v, h, dbs] = await Promise.all([this.c.getVersion(), this.c.checkHealth().catch(() => null), this.c.listDatabases().catch(() => null)]);
    const names: string[] = (dbs as Any)?.db_names ?? [this.db];
    const cols = await this.c.showCollections({ db_name: this.db }).catch(() => null);
    return {
      summary: { version: String((v as Any).version ?? ''), healthy: h ? String((h as Any).isHealthy) : null, databases: names.length, collections: (cols as Any)?.data?.length ?? null },
      sections: { server: { version: String((v as Any).version ?? ''), address: `${this.cfg.host}:${this.cfg.port ?? 19530}`, 'default database': this.db }, databases: Object.fromEntries(names.map((n) => [n, 'database'])) },
    };
  }

  async activity(): Promise<Activity> {
    return { supported: false, sessions: [], note: 'Milvus does not expose live sessions through the client API.' };
  }

  async namespaces(): Promise<Namespace[]> {
    try {
      const r = status(await this.c.listDatabases(), 'listDatabases') as Any;
      return (r.db_names as string[]).map((name) => ({ name }));
    } catch (e) {
      if (e instanceof DriverError) throw e;
      return [{ name: this.db, note: 'listing databases is not permitted for this user' }];
    }
  }

  async entities(ns: string): Promise<Entity[]> {
    const r = status(await this.c.showCollections({ db_name: this.dbn(ns) }), 'showCollections') as Any;
    const list: Any[] = r.data ?? [];
    const out: Entity[] = [];
    for (let i = 0; i < list.length; i += 8) {
      out.push(...await Promise.all(list.slice(i, i + 8).map(async (c): Promise<Entity> => {
        try {
          const s = await this.c.getCollectionStatistics({ collection_name: c.name, db_name: this.dbn(ns) }) as Any;
          return { name: c.name, kind: 'collection', rows: Number(s.data?.row_count ?? s.stats?.find?.((x: Any) => x.key === 'row_count')?.value ?? 0), approx: true };
        } catch { return { name: c.name, kind: 'collection' }; }
      })));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async schema(ns: string, entity: string): Promise<{ fields: Any[]; pk: Any; raw: Any }> {
    const raw = status(await this.c.describeCollection({ collection_name: entity, db_name: this.dbn(ns) }), 'describeCollection') as Any;
    const fields: Any[] = raw.schema?.fields ?? [];
    const pk = fields.find((f) => f.is_primary_key);
    if (!pk) throw new DriverError(400, 'QUERY_ERROR', 'Collection has no primary key field');
    return { fields, pk, raw };
  }
  private nonVector(fields: Any[]) { return fields.filter((f) => !isVector(f)).map((f) => f.name as string); }
  private dim(f: Any): number | undefined {
    const d = (f.type_params ?? []).find((p: Any) => p.key === 'dim')?.value;
    return d === undefined ? undefined : Number(d);
  }

  async describe(ns: string, entity: string): Promise<Describe> {
    const { fields, pk, raw } = await this.schema(ns, entity);
    let indexes: Describe['indexes'] = [];
    try {
      const ix = await this.c.describeIndex({ collection_name: entity, db_name: this.dbn(ns) }) as Any;
      indexes = (ix.index_descriptions ?? []).map((d: Any) => ({
        name: d.index_name, columns: [d.field_name], detail: (d.params ?? []).map((p: Any) => `${p.key}=${p.value}`).join(' '),
      }));
    } catch { /* collection has no index yet */ }
    let loaded: string | null = null;
    try { loaded = String(((await this.c.getLoadState({ collection_name: entity, db_name: this.dbn(ns) })) as Any).state); } catch { /* ignore */ }
    return {
      idFields: [pk.name],
      columns: fields.map((f) => ({
        name: f.name, type: `${f.data_type}${this.dim(f) ? `(${this.dim(f)})` : ''}`, nullable: !!f.nullable, pk: !!f.is_primary_key,
        default: f.default_value == null ? null : String(f.default_value),
        note: [f.autoID && 'autoID', f.is_partition_key && 'partition key', isVector(f) && 'vector'].filter(Boolean).join(', ') || undefined,
      })),
      indexes,
      stats: { loadState: loaded, shards: raw.shards_num ?? null, consistency: raw.consistency_level ?? null, aliases: (raw.aliases ?? []).join(', ') || null, dynamicField: !!raw.schema?.enable_dynamic_field },
      searchFields: fields.filter(isVector).map((f) => ({ name: f.name, type: f.data_type, dim: this.dim(f) })),
    };
  }

  private async rows(ns: string, entity: string, filter: string, limit: number, offset: number, fields: string[]) {
    try {
      const r = status(await this.c.query({ collection_name: entity, db_name: this.dbn(ns), filter, limit, offset, output_fields: fields }), 'query') as Any;
      return (r.data as Record<string, unknown>[]).map((x) => jsonSafe(x) as Record<string, unknown>);
    } catch (e) {
      if (/not loaded|load/i.test((e as Error).message)) throw new DriverError(400, 'NOT_LOADED', `Collection "${entity}" is not loaded. Use "Load into memory" on the Structure tab, then retry.`);
      throw e;
    }
  }

  async browse(ns: string, entity: string, o: BrowseOpts): Promise<Page> {
    const { fields, pk } = await this.schema(ns, entity);
    const cols = this.nonVector(fields);
    const filter = o.filter?.trim() || `${pk.name} ${pk.data_type === 'VarChar' ? '!= ""' : '>= -9223372036854775807'}`;
    const rows = await this.rows(ns, entity, filter, o.limit + 1, o.offset, cols);
    const hasMore = rows.length > o.limit;
    let total: number | null = null;
    try {
      const c = await this.c.query({ collection_name: entity, db_name: this.dbn(ns), filter, output_fields: ['count(*)'] }) as Any;
      total = Number(c.data?.[0]?.['count(*)'] ?? NaN);
      if (Number.isNaN(total)) total = null;
    } catch { /* count is optional */ }
    return { columns: cols, rows: rows.slice(0, o.limit), total, hasMore };
  }

  async getRecord(ns: string, entity: string, id: unknown) {
    const { fields, pk } = await this.schema(ns, entity);
    const v = (id as Record<string, unknown>)?.[pk.name] ?? id;
    const rows = await this.rows(ns, entity, `${pk.name} == ${lit(v)}`, 1, 0, fields.map((f) => f.name));
    if (!rows.length) throw new DriverError(404, 'NOT_FOUND', 'No such entity');
    return rows[0];
  }

  async upsert(ns: string, entity: string, id: unknown, doc: Record<string, unknown>) {
    this.guardWrite('Editing entities');
    const { pk } = await this.schema(ns, entity);
    const fn = id === null ? this.c.insert.bind(this.c) : this.c.upsert.bind(this.c);
    status(await fn({ collection_name: entity, db_name: this.dbn(ns), data: [doc] } as Any), id === null ? 'insert' : 'upsert');
    return doc[pk.name] ?? id;
  }

  async remove(ns: string, entity: string, id: unknown): Promise<number> {
    this.guardWrite('Deleting entities');
    const { pk } = await this.schema(ns, entity);
    const v = (id as Record<string, unknown>)?.[pk.name] ?? id;
    status(await this.c.delete({ collection_name: entity, db_name: this.dbn(ns), filter: `${pk.name} == ${lit(v)}` }), 'delete');
    return 1;
  }

  async createIndex(_ns: string, _entity: string, _spec: IndexSpec): Promise<string> { throw unsupported('Creating indexes'); }
  async dropIndex(): Promise<void> { throw unsupported('Dropping indexes'); }

  async dropEntity(ns: string, entity: string) {
    this.guardWrite('Dropping a collection');
    status(await this.c.dropCollection({ collection_name: entity, db_name: this.dbn(ns) }), 'dropCollection');
  }

  async query(ns: string, text: string, o: QueryOpts): Promise<QueryResult> {
    const t0 = Date.now();
    let q: { collection?: string; filter?: string; limit?: number; offset?: number; output_fields?: string[] };
    try { q = JSON.parse(text); } catch { throw new DriverError(400, 'BAD_REQUEST', `Query must be JSON, e.g. ${this.caps.queryHelp}`); }
    if (!q || typeof q.collection !== 'string') throw new DriverError(400, 'BAD_REQUEST', '"collection" is required');
    const { fields } = await this.schema(ns, q.collection);
    const out = q.output_fields?.length ? q.output_fields : this.nonVector(fields);
    const rows = await this.rows(ns, q.collection, q.filter ?? '', clamp(Number(q.limit ?? 100), 1, o.limit), clamp(Number(q.offset ?? 0), 0, 1_000_000), out);
    return { kind: 'rows', columns: out, rows, ms: Date.now() - t0, statement: JSON.stringify(q) };
  }

  async search(ns: string, entity: string, r: SearchReq): Promise<QueryResult> {
    const t0 = Date.now();
    const { fields } = await this.schema(ns, entity);
    const vf = fields.find((f) => f.name === r.field) ?? fields.find((f) => isVector(f) && f.data_type !== 'SparseFloatVector');
    if (!vf) throw new DriverError(400, 'BAD_REQUEST', 'This collection has no dense vector field to search');
    let vec: unknown;
    try { vec = JSON.parse(r.query.trim().startsWith('[') ? r.query : `[${r.query}]`); } catch { vec = null; }
    if (!Array.isArray(vec) || !vec.length || vec.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new DriverError(400, 'BAD_REQUEST', 'Query vector must be a JSON array of numbers');
    const d = this.dim(vf);
    if (d && vec.length !== d) throw new DriverError(400, 'BAD_REQUEST', `Vector has ${vec.length} values; field "${vf.name}" needs ${d}`);
    const metric = String(r.params.metric_type ?? 'auto');
    const cols = this.nonVector(fields);
    let res: Any;
    try {
      res = status(await this.c.search({
        collection_name: entity, db_name: this.dbn(ns), anns_field: vf.name, data: [vec as number[]], limit: clamp(r.limit, 1, 200),
        offset: clamp(Number(r.params.offset ?? 0), 0, 10_000), output_fields: cols, ...(r.filter?.trim() ? { filter: r.filter.trim() } : {}),
        ...(metric !== 'auto' ? { metric_type: metric } : {}),
      } as Any), 'search');
    } catch (e) {
      if (/not loaded|load/i.test((e as Error).message)) throw new DriverError(400, 'NOT_LOADED', `Collection "${entity}" is not loaded. Use "Load into memory" first.`);
      throw e;
    }
    const hits = ((res.results ?? []) as Any[]).flat().map((h) => jsonSafe(h) as Record<string, unknown>);
    const columns = ['score', ...cols.filter((c) => c !== 'score')];
    return { kind: 'rows', columns, rows: hits.map((h) => ({ score: h.score ?? h.distance ?? null, ...h })), ms: Date.now() - t0, statement: `search ${entity}.${vf.name} limit ${r.limit}` };
  }

  async runAction(ns: string, entity: string, id: string) {
    this.guardWrite('This action');
    const a = { collection_name: entity, db_name: this.dbn(ns) };
    switch (id) {
      case 'load': status(await this.c.loadCollection(a), 'load'); return { ok: true as const, message: 'Load requested' };
      case 'release': status(await this.c.releaseCollection(a), 'release'); return { ok: true as const, message: 'Released' };
      case 'flush': status(await this.c.flush({ collection_names: [entity], db_name: this.dbn(ns) } as Any), 'flush'); return { ok: true as const, message: 'Flushed' };
      case 'compact': status(await this.c.compact(a as Any), 'compact'); return { ok: true as const, message: 'Compaction started' };
      default: throw new DriverError(400, 'BAD_REQUEST', `Unknown action "${id}"`);
    }
  }

  async close() { try { await this.c.closeConnection(); } catch { /* already closed */ } }
}
