import { BSON, MongoClient } from 'mongodb';
import type { Db, Document } from 'mongodb';
import type {
  Activity, BrowseOpts, Column, ConnConfig, Describe, Driver, Entity, IndexInfo, IndexSpec, Namespace, Page, QueryOpts, QueryResult,
} from './types.js';
import { DriverError, unsupported } from './types.js';
import { clamp, clipRow, columnsOf } from './util.js';

const { EJSON } = BSON;
const ejson = (v: unknown): unknown => JSON.parse(EJSON.stringify(v as Document, { relaxed: true }));
const fromJson = <T>(v: unknown): T => EJSON.deserialize(v as Document, { relaxed: true }) as T;
const parseJson = (s: string | undefined, what: string): Document => {
  if (!s || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('must be a JSON object');
    return fromJson<Document>(v);
  } catch (e) { throw new DriverError(400, 'BAD_QUERY', `${what}: ${(e as Error).message}`); }
};

const SAFE_COMMANDS = new Set(['ping', 'dbstats', 'collstats', 'serverstatus', 'listcollections', 'listindexes', 'listdatabases', 'buildinfo', 'hostinfo', 'connectionstatus', 'currentop', 'top', 'getcmdlinopts', 'replsetgetstatus', 'isMaster'.toLowerCase(), 'hello']);
const WRITE_OPS = new Set(['insertone', 'insertmany', 'updateone', 'updatemany', 'replaceone', 'deleteone', 'deletemany']);

/** Walks a pipeline and refuses stages that write. Applied in read-only mode and always for $out/$merge. */
function assertPipelineReadOnly(p: unknown): void {
  if (Array.isArray(p)) { p.forEach(assertPipelineReadOnly); return; }
  if (p && typeof p === 'object') {
    for (const [k, v] of Object.entries(p)) {
      if (k === '$out' || k === '$merge') throw new DriverError(403, 'READ_ONLY', `${k} writes data and is not allowed here`);
      assertPipelineReadOnly(v);
    }
  }
}

function inferColumns(docs: Document[]): Column[] {
  const f = new Map<string, { types: Map<string, number>; n: number }>();
  for (const d of docs) {
    for (const [k, v] of Object.entries(ejson(d) as Record<string, unknown>)) {
      const e = f.get(k) ?? { types: new Map(), n: 0 };
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? (Object.keys(v as object)[0]?.startsWith('$') ? Object.keys(v as object)[0].slice(1) : 'object') : typeof v;
      e.types.set(t, (e.types.get(t) ?? 0) + 1);
      e.n++;
      f.set(k, e);
    }
  }
  return [...f.entries()].sort((a, b) => (a[0] === '_id' ? -1 : b[0] === '_id' ? 1 : b[1].n - a[1].n))
    .map(([name, e]) => ({
      name, pk: name === '_id', nullable: e.n < docs.length,
      type: [...e.types.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).join(' | '),
      note: `${Math.round((e.n / Math.max(1, docs.length)) * 100)}% of ${docs.length} sampled`,
    }));
}

export class MongoDriver implements Driver {
  readonly kind = 'mongodb' as const;
  readonly caps = {
    language: 'mongo-json' as const, write: true, indexes: true, activity: true, dropEntity: true, importExport: true,
    filterHint: 'Filter as JSON, e.g. {"status":"active","age":{"$gt":30}}', entityLabel: 'collection', namespaceLabel: 'database', rowKey: '_id' as const,
  };
  private client: MongoClient;
  private dbName: string;

  constructor(private cfg: ConnConfig) {
    const uri = cfg.uri || `mongodb://${cfg.host ?? '127.0.0.1'}:${cfg.port ?? 27017}`;
    this.dbName = cfg.database || '';
    this.client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, maxPoolSize: 4, appName: 'homedash',
      ...(cfg.username && !cfg.uri ? { auth: { username: cfg.username, password: cfg.password ?? '' }, authSource: cfg.database || 'admin' } : {}),
      ...(cfg.tls || cfg.ca ? { tls: true, ...(cfg.ca ? { ca: cfg.ca } : {}), ...(cfg.tlsInsecure ? { tlsAllowInvalidCertificates: true, tlsAllowInvalidHostnames: true } : {}) } : {}),
    });
  }

  private async db(ns: string): Promise<Db> { await this.client.connect(); return this.client.db(ns || this.dbName || undefined); }
  private id(raw: unknown): unknown { return fromJson<unknown>(raw); }

  async ping() {
    const t = Date.now();
    await this.client.connect();
    const bi = await this.client.db('admin').command({ buildInfo: 1 }).catch(() => ({ version: '?' }));
    await this.client.db('admin').command({ ping: 1 });
    return { ms: Date.now() - t, version: `MongoDB ${bi.version}` };
  }

  async info() {
    const admin = this.client.db('admin');
    await this.client.connect();
    const bi = await admin.command({ buildInfo: 1 }).catch(() => ({} as Document));
    const ss = await admin.command({ serverStatus: 1 }).catch(() => null);
    const summary: Record<string, string | number | null> = { version: bi.version ?? null };
    const sections: Record<string, Record<string, string | number | null>> = {};
    if (ss) {
      summary.uptimeSeconds = Math.round(ss.uptime);
      summary.connections = ss.connections?.current ?? null;
      summary.residentMB = ss.mem?.resident ?? null;
      summary.opsTotal = Object.values((ss.opcounters ?? {}) as Record<string, number>).reduce((a, b) => a + Number(b), 0);
      sections.connections = { current: ss.connections?.current, available: ss.connections?.available, totalCreated: ss.connections?.totalCreated };
      sections.opcounters = ss.opcounters ?? {};
      sections.memory = { residentMB: ss.mem?.resident, virtualMB: ss.mem?.virtual };
      sections.network = { bytesIn: ss.network?.bytesIn, bytesOut: ss.network?.bytesOut, requests: ss.network?.numRequests };
      if (ss.wiredTiger?.cache) {
        sections.cache = {
          bytesInCache: ss.wiredTiger.cache['bytes currently in the cache'], maxBytes: ss.wiredTiger.cache['maximum bytes configured'],
          dirtyBytes: ss.wiredTiger.cache['tracked dirty bytes in the cache'],
        };
      }
    } else sections.note = { serverStatus: 'denied for this user, showing build info only' };
    sections.build = { version: bi.version, gitVersion: bi.gitVersion, openssl: bi.openssl?.running ?? null, javascriptEngine: bi.javascriptEngine ?? null };
    return { summary, sections };
  }

  async activity(): Promise<Activity> {
    await this.client.connect();
    try {
      const r = await this.client.db('admin').command({ currentOp: 1, $all: false, active: true });
      const sessions = ((r.inprog ?? []) as Document[]).slice(0, 100).map((o) => ({
        opid: o.opid, ns: o.ns, op: o.op, secs: o.secs_running, client: o.client, desc: o.desc,
        command: JSON.stringify(ejson(o.command ?? o.query ?? {})).slice(0, 300),
      }));
      return { supported: true, sessions };
    } catch (e) {
      return { supported: true, sessions: [], note: `currentOp refused: ${(e as Error).message}` };
    }
  }

  async namespaces(): Promise<Namespace[]> {
    await this.client.connect();
    try {
      const r = await this.client.db('admin').command({ listDatabases: 1, nameOnly: false });
      return (r.databases as { name: string; sizeOnDisk?: number }[]).map((d) => ({ name: d.name, sizeBytes: d.sizeOnDisk })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      if (this.dbName) return [{ name: this.dbName, note: 'listDatabases not permitted; showing the configured database' }];
      throw new DriverError(403, 'DENIED', 'This user cannot list databases. Set a default database in the connection.');
    }
  }

  async entities(ns: string): Promise<Entity[]> {
    const db = await this.db(ns);
    const cols = await db.listCollections({}, { nameOnly: false }).toArray();
    const out = await Promise.all(cols.slice(0, 300).map(async (c): Promise<Entity> => {
      const e: Entity = { name: c.name, kind: c.type === 'view' ? 'view' : 'collection' };
      if (c.type !== 'view') e.rows = await db.collection(c.name).estimatedDocumentCount().catch(() => undefined);
      e.approx = true;
      return e;
    }));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describe(ns: string, entity: string): Promise<Describe> {
    const db = await this.db(ns);
    const c = db.collection(entity);
    const [idx, stats, sample] = await Promise.all([
      c.indexes().catch(() => [] as Document[]),
      db.command({ collStats: entity }).catch(() => null),
      c.aggregate([{ $sample: { size: 100 } }], { maxTimeMS: 5000 }).toArray().catch(() => [] as Document[]),
    ]);
    const indexes: IndexInfo[] = idx.map((i) => ({
      name: String(i.name), columns: Object.entries(i.key as Record<string, unknown>).map(([k, v]) => `${k} ${v === -1 ? '↓' : v === 1 ? '↑' : v}`),
      unique: !!i.unique || i.name === '_id_', primary: i.name === '_id_',
      detail: [i.sparse && 'sparse', i.expireAfterSeconds !== undefined && `ttl ${i.expireAfterSeconds}s`, i.partialFilterExpression && 'partial'].filter(Boolean).join(', ') || undefined,
    }));
    return {
      idFields: ['_id'], columns: inferColumns(sample), indexes,
      stats: stats ? {
        documents: stats.count, avgObjSizeBytes: stats.avgObjSize ?? null, dataBytes: stats.size, storageBytes: stats.storageSize,
        indexBytes: stats.totalIndexSize, indexes: stats.nindexes, capped: !!stats.capped,
      } : { note: 'collStats not permitted' },
    };
  }

  async browse(ns: string, entity: string, o: BrowseOpts): Promise<Page> {
    const c = (await this.db(ns)).collection(entity);
    const filter = parseJson(o.filter, 'filter');
    let sort: Document | undefined;
    if (o.sort) sort = { [o.sort]: o.dir === 'desc' ? -1 : 1 };
    const docs = await c.find(filter, { maxTimeMS: 15000 }).sort(sort ?? { _id: 1 }).skip(o.offset).limit(o.limit + 1).toArray();
    const hasMore = docs.length > o.limit;
    const rows = (docs.slice(0, o.limit).map((d) => ejson(d)) as Record<string, unknown>[]);
    const empty = Object.keys(filter).length === 0;
    const total = empty ? await c.estimatedDocumentCount().catch(() => null) : await c.countDocuments(filter, { maxTimeMS: 5000 }).catch(() => null);
    return { columns: columnsOf(rows, ['_id']), rows: rows.map(clipRow), total, totalApprox: empty, hasMore };
  }

  async getRecord(ns: string, entity: string, id: unknown) {
    const d = await (await this.db(ns)).collection(entity).findOne({ _id: this.id(id) as never });
    if (!d) throw new DriverError(404, 'NOT_FOUND', 'No document with that _id');
    return ejson(d);
  }

  async upsert(ns: string, entity: string, id: unknown, doc: Record<string, unknown>) {
    const c = (await this.db(ns)).collection(entity);
    const d = fromJson<Document>(doc);
    if (id === null || id === undefined) {
      const r = await c.insertOne(d);
      return (ejson({ v: r.insertedId }) as { v: unknown }).v;
    }
    const _id = this.id(id) as never;
    delete d._id;
    const r = await c.replaceOne({ _id }, d);
    if (!r.matchedCount) throw new DriverError(404, 'NOT_FOUND', 'No document with that _id');
    return id;
  }

  async remove(ns: string, entity: string, id: unknown) {
    return (await (await this.db(ns)).collection(entity).deleteOne({ _id: this.id(id) as never })).deletedCount;
  }

  async createIndex(ns: string, entity: string, spec: IndexSpec) {
    if (!spec.columns.length) throw new DriverError(400, 'BAD_REQUEST', 'At least one field is required');
    const key: Record<string, 1 | -1> = {};
    for (const c of spec.columns) key[c.field] = c.dir === 'desc' ? -1 : 1;
    return (await this.db(ns)).collection(entity).createIndex(key, { unique: !!spec.unique, ...(spec.name ? { name: spec.name } : {}), background: true });
  }
  async dropIndex(ns: string, entity: string, name: string) {
    if (name === '_id_') throw new DriverError(400, 'BAD_REQUEST', 'The _id index cannot be dropped');
    await (await this.db(ns)).collection(entity).dropIndex(name);
  }
  async dropEntity(ns: string, entity: string) { await (await this.db(ns)).collection(entity).drop(); }

  /** JSON command, e.g. {"find":"users","filter":{"age":{"$gt":3}},"sort":{"age":-1},"limit":20}
   *  or {"aggregate":"orders","pipeline":[...]} or {"insertOne":"users","document":{...}}. */
  async query(ns: string, text: string, o: QueryOpts): Promise<QueryResult> {
    const t0 = Date.now();
    let spec: Document;
    try { spec = JSON.parse(text); } catch (e) { throw new DriverError(400, 'BAD_QUERY', `Not valid JSON: ${(e as Error).message}`); }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new DriverError(400, 'BAD_QUERY', 'Query must be a JSON object');
    const db = await this.db(ns);
    const op = Object.keys(spec).find((k) => ['find', 'aggregate', 'count', 'distinct', 'command', ...[...WRITE_OPS].map((w) => w)].includes(k.toLowerCase()) || WRITE_OPS.has(k.toLowerCase()));
    if (!op) throw new DriverError(400, 'BAD_QUERY', 'Use one of: find, aggregate, count, distinct, command, insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany');
    const lop = op.toLowerCase();
    const name = String(spec[op]);
    const limit = clamp(Number(spec.limit ?? o.limit), 1, o.limit);
    const rowsResult = (docs: Document[], statement: string): QueryResult => {
      const rows = (docs.slice(0, limit).map((d) => ejson(d)) as Record<string, unknown>[]);
      return { kind: 'rows', columns: columnsOf(rows, ['_id']), rows: rows.map(clipRow), truncated: docs.length > limit, ms: Date.now() - t0, statement };
    };
    const filter = () => fromJson<Document>(spec.filter ?? {});

    if (WRITE_OPS.has(lop)) {
      if (o.readOnly) throw new DriverError(403, 'READ_ONLY', 'This connection is read-only');
      const c = db.collection(name);
      let affected = 0;
      let value: unknown;
      switch (lop) {
        case 'insertone': { const r = await c.insertOne(fromJson<Document>(spec.document ?? {})); affected = 1; value = (ejson({ v: r.insertedId }) as { v: unknown }).v; break; }
        case 'insertmany': { const r = await c.insertMany((spec.documents as unknown[] ?? []).map((x) => fromJson<Document>(x))); affected = r.insertedCount; break; }
        case 'updateone': case 'updatemany': {
          const upd = fromJson<Document>(spec.update ?? {});
          if (!Object.keys(upd).some((k) => k.startsWith('$'))) throw new DriverError(400, 'BAD_QUERY', 'update must use operators like {"$set":{...}}');
          const r = lop === 'updateone' ? await c.updateOne(filter(), upd, { upsert: !!spec.upsert }) : await c.updateMany(filter(), upd, { upsert: !!spec.upsert });
          affected = r.modifiedCount + r.upsertedCount; value = { matched: r.matchedCount, modified: r.modifiedCount, upserted: r.upsertedCount }; break;
        }
        case 'replaceone': { const r = await c.replaceOne(filter(), fromJson<Document>(spec.replacement ?? {})); affected = r.modifiedCount; break; }
        case 'deleteone': affected = (await c.deleteOne(filter())).deletedCount; break;
        case 'deletemany':
          if (!Object.keys(filter()).length && spec.all !== true) throw new DriverError(400, 'BAD_QUERY', 'deleteMany with an empty filter deletes everything. Add "all": true to confirm.');
          affected = (await c.deleteMany(filter())).deletedCount; break;
      }
      return { kind: 'ok', columns: [], rows: [], affected, value, ms: Date.now() - t0, statement: op };
    }

    switch (lop) {
      case 'find': {
        let cur = db.collection(name).find(filter(), { maxTimeMS: o.timeoutMs });
        if (spec.projection) cur = cur.project(fromJson<Document>(spec.projection));
        if (spec.sort) cur = cur.sort(fromJson<Document>(spec.sort) as never);
        if (spec.skip) cur = cur.skip(Number(spec.skip));
        return rowsResult(await cur.limit(limit + 1).toArray(), `find ${name}`);
      }
      case 'aggregate': {
        const pipeline = fromJson<Document[]>(spec.pipeline ?? []);
        if (!Array.isArray(pipeline)) throw new DriverError(400, 'BAD_QUERY', 'pipeline must be an array');
        assertPipelineReadOnly(pipeline);
        const docs = await db.collection(name).aggregate([...pipeline, { $limit: limit + 1 }], { maxTimeMS: o.timeoutMs, allowDiskUse: false }).toArray();
        return rowsResult(docs, `aggregate ${name}`);
      }
      case 'count': return { kind: 'value', columns: [], rows: [], value: await db.collection(name).countDocuments(filter(), { maxTimeMS: o.timeoutMs }), ms: Date.now() - t0, statement: `count ${name}` };
      case 'distinct': {
        const v = await db.collection(name).distinct(String(spec.field ?? ''), filter(), { maxTimeMS: o.timeoutMs });
        return { kind: 'value', columns: [], rows: [], value: (ejson({ v: v.slice(0, limit) }) as { v: unknown }).v, truncated: v.length > limit, ms: Date.now() - t0, statement: `distinct ${name}.${spec.field}` };
      }
      case 'command': {
        const cmd = fromJson<Document>(spec.command ?? spec[op]);
        const first = Object.keys(cmd)[0]?.toLowerCase() ?? '';
        if (!SAFE_COMMANDS.has(first)) throw new DriverError(403, 'DENIED', `Command "${first}" is not on the allow-list (${[...SAFE_COMMANDS].join(', ')})`);
        return { kind: 'value', columns: [], rows: [], value: ejson(await db.command(cmd)), ms: Date.now() - t0, statement: `command ${first}` };
      }
    }
    throw unsupported(op);
  }

  async close() { await this.client.close().catch(() => undefined); }
}

