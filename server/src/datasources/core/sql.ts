import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import type {
  Activity, BrowseOpts, Column, ConnConfig, Describe, Driver, Entity, IndexInfo, IndexSpec, Kind, Namespace, Page, QueryOpts, QueryResult,
} from './types.js';
import { DriverError } from './types.js';
import { clamp, clipRow, jsonSafe, singleStatement, uniqueNames } from './util.js';
import { hasMultipleStatements } from './sqlguard.js';

interface Raw { columns: string[]; rows: unknown[][]; affected: number; insertId?: unknown }
type Row = Record<string, unknown>;

/** What differs between SQL engines. Everything else (browse, CRUD, console) is shared below. */
interface Adapter {
  quote(id: string): string;
  ph(n: number): string;                                   // placeholder for the nth parameter (1-based)
  run(sql: string, params: unknown[], o: { readOnly: boolean; timeoutMs: number; ns?: string }): Promise<Raw>;
  close(): Promise<void>;
}

const obj = (r: Raw): Row[] => {
  const names = uniqueNames(r.columns);
  return r.rows.map((a) => Object.fromEntries(names.map((n, i) => [n, jsonSafe(a[i])])));
};

// ---------------------------------------------------------------- PostgreSQL
function pgAdapter(c: ConnConfig): Adapter {
  const pool = new pg.Pool({
    host: c.host ?? '127.0.0.1', port: c.port ?? 5432, user: c.username, password: c.password, database: c.database || undefined,
    max: 4, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000, application_name: 'homedash',
    ssl: c.tls || c.ca ? { ca: c.ca || undefined, rejectUnauthorized: !c.tlsInsecure } : undefined,
  });
  pool.on('error', () => { /* idle client died; the pool replaces it */ });
  return {
    quote: (i) => `"${i.replace(/"/g, '""')}"`,
    ph: (n) => `$${n}`,
    async run(sql, params, o) {
      const cl = await pool.connect();
      try {
        await cl.query(`SET statement_timeout = ${Math.floor(o.timeoutMs)}`);
        await cl.query(o.ns ? `SELECT set_config('search_path', $1, false)` : 'RESET search_path', o.ns ? [`"${o.ns.replace(/"/g, '""')}", public`] : []);
        // A read-only transaction only holds if the text is ONE statement: a batch could COMMIT / SET TRANSACTION READ WRITE and go on.
        if (o.readOnly && hasMultipleStatements(sql)) throw new DriverError(400, 'BAD_QUERY', 'Read-only mode runs one statement at a time');
        if (o.readOnly) await cl.query('BEGIN READ ONLY');
        try {
          const r = await cl.query({ text: sql, values: params as never[], rowMode: 'array' });
          const res = Array.isArray(r) ? r[r.length - 1] : r;
          return { columns: (res.fields ?? []).map((f: { name: string }) => f.name), rows: (res.rows ?? []) as unknown[][], affected: res.rowCount ?? 0 };
        } finally { if (o.readOnly) await cl.query('ROLLBACK').catch(() => undefined); }
      } finally { cl.release(); }
    },
    close: () => pool.end().catch(() => undefined),
  };
}

// ---------------------------------------------------------------- MySQL / MariaDB
function myAdapter(c: ConnConfig): Adapter {
  const pool = mysql.createPool({
    host: c.host ?? '127.0.0.1', port: c.port ?? 3306, user: c.username, password: c.password, database: c.database || undefined,
    connectionLimit: 4, connectTimeout: 8000, dateStrings: false, supportBigNumbers: true, bigNumberStrings: true, rowsAsArray: true, multipleStatements: false,
    ssl: c.tls || c.ca ? { ca: c.ca || undefined, rejectUnauthorized: !c.tlsInsecure } : undefined,
  });
  return {
    quote: (i) => `\`${i.replace(/`/g, '``')}\``,
    ph: () => '?',
    async run(sql, params, o) {
      const cl = await pool.getConnection();
      try {
        if (o.ns) await cl.query(`USE \`${o.ns.replace(/`/g, '``')}\``);
        if (o.readOnly) await cl.query('START TRANSACTION READ ONLY');
        try {
          const [res, fields] = await cl.query({ sql, values: params, timeout: o.timeoutMs, rowsAsArray: true } as never);
          if (Array.isArray(fields)) return { columns: (fields as { name: string }[]).map((f) => f.name), rows: res as unknown as unknown[][], affected: 0 };
          const h = res as unknown as { affectedRows: number; insertId?: number | string };
          return { columns: [], rows: [], affected: h.affectedRows ?? 0, insertId: h.insertId };
        } finally { if (o.readOnly) await cl.query('ROLLBACK').catch(() => undefined); }
      } finally { cl.release(); }
    },
    close: () => pool.end().catch(() => undefined),
  };
}

// ---------------------------------------------------------------- SQLite (node:sqlite, no dependency)
function liteAdapter(c: ConnConfig, writable: boolean): Adapter {
  if (!c.file) throw new DriverError(400, 'BAD_REQUEST', 'A database file path is required');
  let ro: DatabaseSync | undefined;
  let rw: DatabaseSync | undefined;
  const open = (readOnly: boolean) => {
    if (readOnly) return (ro ??= new DatabaseSync(c.file!, { readOnly: true }));
    if (!writable) throw new DriverError(403, 'READ_ONLY', 'This connection is read-only');
    return (rw ??= new DatabaseSync(c.file!));
  };
  return {
    quote: (i) => `"${i.replace(/"/g, '""')}"`,
    ph: () => '?',
    async run(sql, params, o) {
      const db = open(o.readOnly);
      const st = db.prepare(sql);
      st.setReadBigInts(true);
      const cols = st.columns().map((x) => x.name);
      if (cols.length) {
        st.setReturnArrays?.(true);
        const rows = st.all(...(params as never[])) as unknown as unknown[][];
        return { columns: cols, rows: rows.map((r) => (Array.isArray(r) ? r : cols.map((k) => (r as Row)[k]))), affected: 0 };
      }
      const r = st.run(...(params as never[]));
      return { columns: [], rows: [], affected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
    },
    async close() { ro?.close(); rw?.close(); },
  };
}

// ---------------------------------------------------------------- shared driver
export class SqlDriver implements Driver {
  readonly caps;
  private a: Adapter;

  constructor(readonly kind: 'postgres' | 'mysql' | 'sqlite', private cfg: ConnConfig, private writable: boolean) {
    this.a = kind === 'postgres' ? pgAdapter(cfg) : kind === 'mysql' ? myAdapter(cfg) : liteAdapter(cfg, writable);
    this.caps = {
      language: 'sql' as const, write: true, indexes: true, activity: kind !== 'sqlite', dropEntity: true, importExport: true,
      filterHint: 'A WHERE expression, e.g. status = \'active\' AND age > 30', entityLabel: 'table',
      namespaceLabel: kind === 'postgres' ? 'schema' : kind === 'mysql' ? 'database' : 'database',
    };
  }

  private q = (sql: string, params: unknown[] = [], o: Partial<{ readOnly: boolean; timeoutMs: number }> = {}) =>
    this.a.run(sql, params, { readOnly: o.readOnly ?? true, timeoutMs: o.timeoutMs ?? 15000 });
  private rows = async (sql: string, params: unknown[] = []) => obj(await this.q(sql, params));
  private qual(ns: string, entity: string) {
    return this.kind === 'sqlite' ? this.a.quote(entity) : `${this.a.quote(ns)}.${this.a.quote(entity)}`;
  }
  private get defaultNs() { return this.kind === 'postgres' ? 'public' : this.kind === 'mysql' ? this.cfg.database ?? '' : 'main'; }

  async ping() {
    const t = Date.now();
    const sql = this.kind === 'sqlite' ? 'SELECT sqlite_version() AS v' : this.kind === 'postgres' ? 'SELECT version() AS v' : 'SELECT VERSION() AS v';
    const [r] = await this.rows(sql);
    return { ms: Date.now() - t, version: String(r?.v ?? '?').slice(0, 80) };
  }

  async info() {
    const summary: Record<string, string | number | null> = {};
    const sections: Record<string, Record<string, string | number | null>> = {};
    const v = (await this.ping()).version;
    summary.version = v;
    if (this.kind === 'postgres') {
      const [d] = await this.rows(`SELECT current_database() AS db, pg_database_size(current_database()) AS size, pg_postmaster_start_time() AS started,
        (SELECT count(*) FROM pg_stat_activity) AS conns, current_setting('max_connections') AS maxc`);
      const [s] = await this.rows(`SELECT xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, deadlocks, temp_files FROM pg_stat_database WHERE datname = current_database()`);
      Object.assign(summary, { database: d.db as string, sizeBytes: Number(d.size), connections: Number(d.conns), maxConnections: Number(d.maxc), started: String(d.started) });
      const hit = Number(s?.blks_hit ?? 0), rd = Number(s?.blks_read ?? 0);
      summary.cacheHitRate = hit + rd ? Math.round((hit / (hit + rd)) * 1000) / 10 : null;
      sections.activity = Object.fromEntries(Object.entries(s ?? {}).map(([k, x]) => [k, Number(x)]));
      const set = await this.rows(`SELECT name, setting FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_connections','wal_level','synchronous_commit','autovacuum')`);
      sections.settings = Object.fromEntries(set.map((r) => [String(r.name), String(r.setting)]));
    } else if (this.kind === 'mysql') {
      const st = Object.fromEntries((await this.rows(`SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries','Connections','Aborted_connects','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Bytes_received','Bytes_sent','Com_select','Com_insert','Com_update','Com_delete')`)).map((r) => [String(r.Variable_name), Number(r.Value)]));
      Object.assign(summary, { uptimeSeconds: st.Uptime, connections: st.Threads_connected, running: st.Threads_running, queries: st.Questions, slowQueries: st.Slow_queries });
      sections.status = st;
      const set = await this.rows(`SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','innodb_buffer_pool_size','character_set_server','sql_mode','read_only','version_comment')`);
      sections.settings = Object.fromEntries(set.map((r) => [String(r.Variable_name), String(r.Value)]));
    } else {
      const pr = async (p: string) => Number(Object.values((await this.rows(`PRAGMA ${p}`))[0] ?? {})[0]);
      const pages = await pr('page_count'), size = await pr('page_size');
      Object.assign(summary, { file: this.cfg.file ?? null, sizeBytes: pages * size });
      sections.pragma = { page_count: pages, page_size: size, freelist_count: await pr('freelist_count'), journal_mode: String(Object.values((await this.rows('PRAGMA journal_mode'))[0])[0]), foreign_keys: await pr('foreign_keys') };
    }
    return { summary, sections };
  }

  async activity(): Promise<Activity> {
    if (this.kind === 'postgres') {
      const s = await this.rows(`SELECT pid, usename AS user, application_name AS app, client_addr::text AS client, state, wait_event_type AS wait,
        EXTRACT(EPOCH FROM now() - query_start)::int AS seconds, left(query, 300) AS query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start NULLS LAST LIMIT 100`);
      return { supported: true, sessions: s };
    }
    if (this.kind === 'mysql') {
      const s = await this.rows('SHOW FULL PROCESSLIST');
      return { supported: true, sessions: s.slice(0, 100).map((r) => ({ id: r.Id, user: r.User, host: r.Host, db: r.db, command: r.Command, seconds: r.Time, state: r.State, query: String(r.Info ?? '').slice(0, 300) })) };
    }
    return { supported: false, sessions: [], note: 'SQLite is an embedded file; there are no sessions' };
  }

  async namespaces(): Promise<Namespace[]> {
    if (this.kind === 'sqlite') return [{ name: 'main' }];
    if (this.kind === 'postgres') {
      return (await this.rows(`SELECT n.nspname AS name, count(c.oid) FILTER (WHERE c.relkind IN ('r','v','m','p')) AS n FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid
        WHERE n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' AND n.nspname <> 'information_schema' GROUP BY n.nspname ORDER BY (n.nspname = 'public') DESC, n.nspname`))
        .map((r) => ({ name: String(r.name), entities: Number(r.n) }));
    }
    return (await this.rows(`SELECT s.schema_name AS name, COUNT(t.table_name) AS n, COALESCE(SUM(t.data_length + t.index_length), 0) AS size FROM information_schema.schemata s
      LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name GROUP BY s.schema_name ORDER BY s.schema_name`))
      .map((r) => ({ name: String(r.name), entities: Number(r.n), sizeBytes: Number(r.size) }));
  }

  async entities(ns: string): Promise<Entity[]> {
    if (this.kind === 'sqlite') {
      return (await this.rows(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`))
        .map((r) => ({ name: String(r.name), kind: r.type === 'view' ? 'view' : 'table' }));
    }
    if (this.kind === 'postgres') {
      return (await this.rows(`SELECT c.relname AS name, c.relkind AS k, c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS size FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p') ORDER BY c.relname`, [ns]))
        .map((r) => ({ name: String(r.name), kind: r.k === 'v' || r.k === 'm' ? 'view' as const : 'table' as const, rows: Math.max(0, Number(r.rows)), sizeBytes: Number(r.size), approx: true }));
    }
    return (await this.rows(`SELECT table_name AS name, table_type AS t, table_rows AS \`rows\`, data_length + index_length AS size FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [ns]))
      .map((r) => ({ name: String(r.name), kind: String(r.t).includes('VIEW') ? 'view' as const : 'table' as const, rows: r.rows == null ? undefined : Number(r.rows), sizeBytes: r.size == null ? undefined : Number(r.size), approx: true }));
  }

  async describe(ns: string, entity: string): Promise<Describe> {
    let columns: Column[] = [];
    let indexes: IndexInfo[] = [];
    let ddl: string | undefined;
    const stats: Record<string, string | number | boolean | null> = {};
    if (this.kind === 'sqlite') {
      columns = (await this.rows(`PRAGMA table_info(${this.a.quote(entity)})`)).map((r) => ({ name: String(r.name), type: String(r.type || 'any'), nullable: !r.notnull && !r.pk, pk: Number(r.pk) > 0, default: r.dflt_value == null ? null : String(r.dflt_value) }));
      for (const i of await this.rows(`PRAGMA index_list(${this.a.quote(entity)})`)) {
        const cols = (await this.rows(`PRAGMA index_info(${this.a.quote(String(i.name))})`)).map((c) => String(c.name));
        indexes.push({ name: String(i.name), columns: cols, unique: !!Number(i.unique), primary: i.origin === 'pk' });
      }
      ddl = String((await this.rows(`SELECT sql FROM sqlite_master WHERE name = ?`, [entity]))[0]?.sql ?? '') || undefined;
      stats.rows = Number((await this.rows(`SELECT COUNT(*) AS n FROM ${this.qual(ns, entity)}`))[0].n);
    } else if (this.kind === 'postgres') {
      columns = (await this.rows(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, COALESCE(i.indisprimary, false) AS pk, pg_get_expr(d.adbin, d.adrelid) AS def
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [ns, entity]))
        .map((r) => ({ name: String(r.name), type: String(r.type), nullable: !!r.nullable, pk: !!r.pk, default: r.def == null ? null : String(r.def) }));
      indexes = (await this.rows(`SELECT i.relname AS name, ix.indisunique AS u, ix.indisprimary AS p, pg_get_indexdef(ix.indexrelid) AS def,
        ARRAY(SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = ANY(ix.indkey) ORDER BY array_position(ix.indkey::int[], a.attnum::int)) AS cols
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 ORDER BY i.relname`, [ns, entity]))
        .map((r) => ({ name: String(r.name), columns: (r.cols as string[]) ?? [], unique: !!r.u, primary: !!r.p, detail: String(r.def).replace(/^.* USING /, 'USING ') }));
      const [s] = await this.rows(`SELECT c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS tbl, pg_indexes_size(c.oid) AS idx,
        st.n_live_tup, st.n_dead_tup, st.last_autovacuum, st.last_autoanalyze FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid WHERE n.nspname = $1 AND c.relname = $2`, [ns, entity]);
      if (s) Object.assign(stats, { rowsEstimate: Number(s.rows), liveTuples: s.n_live_tup == null ? null : Number(s.n_live_tup), deadTuples: s.n_dead_tup == null ? null : Number(s.n_dead_tup), totalBytes: Number(s.total), tableBytes: Number(s.tbl), indexBytes: Number(s.idx), lastAutovacuum: s.last_autovacuum ? String(s.last_autovacuum) : null });
    } else {
      columns = (await this.rows(`SELECT column_name AS name, column_type AS type, is_nullable = 'YES' AS nullable, column_key = 'PRI' AS pk, column_default AS def, extra FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [ns, entity]))
        .map((r) => ({ name: String(r.name), type: String(r.type), nullable: !!Number(r.nullable), pk: !!Number(r.pk), default: r.def == null ? null : String(r.def), note: r.extra ? String(r.extra) : undefined }));
      const idx = new Map<string, IndexInfo>();
      for (const r of await this.rows(`SELECT index_name AS name, column_name AS col, non_unique AS nu, index_type AS t FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index`, [ns, entity])) {
        const n = String(r.name);
        const e = idx.get(n) ?? { name: n, columns: [], unique: !Number(r.nu), primary: n === 'PRIMARY', detail: String(r.t) };
        e.columns.push(String(r.col));
        idx.set(n, e);
      }
      indexes = [...idx.values()];
      ddl = String(Object.values((await this.rows(`SHOW CREATE TABLE ${this.qual(ns, entity)}`))[0] ?? {})[1] ?? '') || undefined;
      const [s] = await this.rows(`SELECT table_rows AS r, data_length AS d, index_length AS i, engine, auto_increment AS ai FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, [ns, entity]);
      if (s) Object.assign(stats, { rowsEstimate: s.r == null ? null : Number(s.r), dataBytes: Number(s.d), indexBytes: Number(s.i), engine: s.engine ? String(s.engine) : null, nextAutoIncrement: s.ai == null ? null : Number(s.ai) });
    }
    return { idFields: columns.filter((c) => c.pk).map((c) => c.name), columns, indexes, stats, ddl };
  }

  async browse(ns: string, entity: string, o: BrowseOpts): Promise<Page> {
    const t = this.qual(ns, entity);
    const where = o.filter?.trim() ? ` WHERE ${o.filter.trim().replace(/;+\s*$/, '')}` : '';
    if (/;/.test(where.replace(/'(?:[^']|'')*'/g, ''))) throw new DriverError(400, 'BAD_QUERY', 'Filter must be a single expression');
    const order = o.sort ? ` ORDER BY ${this.a.quote(o.sort)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
    const r = await this.q(`SELECT * FROM ${t}${where}${order} LIMIT ${o.limit + 1} OFFSET ${o.offset}`);
    const rows = obj(r);
    const hasMore = rows.length > o.limit;
    let total: number | null = null;
    let approx = false;
    try {
      if (!where && this.kind === 'postgres') {
        total = Number((await this.rows(`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = $1::regclass`, [t]))[0].n);
        approx = true;
        if (total < 0) total = null;
      }
      if (total === null) total = Number((await this.rows(`SELECT COUNT(*) AS n FROM ${t}${where}`))[0].n);
    } catch { total = null; }
    return { columns: uniqueNames(r.columns), rows: rows.slice(0, o.limit).map(clipRow), total, totalApprox: approx, hasMore };
  }

  private async pk(ns: string, entity: string): Promise<string[]> {
    const d = await this.describe(ns, entity);
    if (!d.idFields.length) throw new DriverError(400, 'NO_PRIMARY_KEY', `${entity} has no primary key, so single rows cannot be addressed. Use the query console.`);
    return d.idFields;
  }
  private where(pk: string[], id: unknown, start = 1) {
    const idv = id as Row;
    if (!idv || typeof idv !== 'object') throw new DriverError(400, 'BAD_REQUEST', 'id must be an object of primary-key values');
    for (const k of pk) if (!(k in idv)) throw new DriverError(400, 'BAD_REQUEST', `id is missing ${k}`);
    return { sql: pk.map((k, i) => `${this.a.quote(k)} = ${this.a.ph(start + i)}`).join(' AND '), params: pk.map((k) => idv[k]) };
  }

  async getRecord(ns: string, entity: string, id: unknown) {
    const pk = await this.pk(ns, entity);
    const w = this.where(pk, id);
    const r = obj(await this.q(`SELECT * FROM ${this.qual(ns, entity)} WHERE ${w.sql} LIMIT 1`, w.params));
    if (!r[0]) throw new DriverError(404, 'NOT_FOUND', 'No row with that key');
    return r[0];
  }

  async upsert(ns: string, entity: string, id: unknown, doc: Row) {
    const t = this.qual(ns, entity);
    const keys = Object.keys(doc);
    const w = { readOnly: false, timeoutMs: 15000 };
    if (id === null || id === undefined) {
      if (!keys.length) throw new DriverError(400, 'BAD_REQUEST', 'Nothing to insert');
      const sql = `INSERT INTO ${t} (${keys.map((k) => this.a.quote(k)).join(', ')}) VALUES (${keys.map((_, i) => this.a.ph(i + 1)).join(', ')})${this.kind === 'mysql' ? '' : ' RETURNING *'}`;
      const r = await this.a.run(sql, keys.map((k) => doc[k]), w);
      const pk = await this.pk(ns, entity).catch(() => [] as string[]);
      const back = obj(r)[0] ?? {};
      return Object.fromEntries(pk.map((k) => [k, back[k] ?? doc[k] ?? (pk.length === 1 ? r.insertId : null) ?? null]));
    }
    const pk = await this.pk(ns, entity);
    const sets = keys.filter((k) => !pk.includes(k));
    if (!sets.length) return id;
    const wh = this.where(pk, id, sets.length + 1);
    const r = await this.a.run(`UPDATE ${t} SET ${sets.map((k, i) => `${this.a.quote(k)} = ${this.a.ph(i + 1)}`).join(', ')} WHERE ${wh.sql}`, [...sets.map((k) => doc[k]), ...wh.params], w);
    if (!r.affected && this.kind !== 'mysql') throw new DriverError(404, 'NOT_FOUND', 'No row with that key');
    return id;
  }

  async remove(ns: string, entity: string, id: unknown) {
    const pk = await this.pk(ns, entity);
    const w = this.where(pk, id);
    return (await this.a.run(`DELETE FROM ${this.qual(ns, entity)} WHERE ${w.sql}`, w.params, { readOnly: false, timeoutMs: 15000 })).affected;
  }

  async createIndex(ns: string, entity: string, spec: IndexSpec) {
    if (!spec.columns.length) throw new DriverError(400, 'BAD_REQUEST', 'At least one column is required');
    const name = spec.name || `idx_${entity}_${spec.columns.map((c) => c.field).join('_')}`.slice(0, 60);
    if (!/^[A-Za-z_][\w$]{0,62}$/.test(name)) throw new DriverError(400, 'BAD_REQUEST', 'Index name may only contain letters, digits and _');
    const cols = spec.columns.map((c) => `${this.a.quote(c.field)}${c.dir === 'desc' ? ' DESC' : ''}`).join(', ');
    const on = this.kind === 'sqlite' ? this.a.quote(entity) : this.qual(ns, entity);
    const nm = this.a.quote(name);
    await this.a.run(`CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${nm} ON ${on} (${cols})`, [], { readOnly: false, timeoutMs: 60000 });
    return name;
  }
  async dropIndex(ns: string, entity: string, name: string) {
    const sql = this.kind === 'mysql' ? `DROP INDEX ${this.a.quote(name)} ON ${this.qual(ns, entity)}`
      : this.kind === 'postgres' ? `DROP INDEX ${this.a.quote(ns)}.${this.a.quote(name)}` : `DROP INDEX ${this.a.quote(name)}`;
    await this.a.run(sql, [], { readOnly: false, timeoutMs: 30000 });
  }
  async dropEntity(ns: string, entity: string) {
    const kind = (await this.entities(ns)).find((e) => e.name === entity)?.kind;
    if (!kind) throw new DriverError(404, 'NOT_FOUND', `${entity} does not exist`);
    await this.a.run(`DROP ${kind === 'view' ? 'VIEW' : 'TABLE'} ${this.qual(ns, entity)}`, [], { readOnly: false, timeoutMs: 30000 });
  }

  async query(ns: string, text: string, o: QueryOpts): Promise<QueryResult> {
    const t0 = Date.now();
    const sql = text.trim();
    if (!sql) throw new DriverError(400, 'BAD_QUERY', 'Empty query');
    const limit = clamp(o.limit, 1, 5000);
    const single = singleStatement(sql);
    if (single === null && this.kind !== 'postgres') throw new DriverError(400, 'BAD_QUERY', 'Run one statement at a time');
    const selectLike = single !== null && /^\s*(select|with|values|show|explain|describe|pragma|table)\b/i.test(single);
    const wrap = single !== null && /^\s*(select|with)\b/i.test(single);
    const final = wrap ? `SELECT * FROM (${single}) AS _spl LIMIT ${limit + 1}` : sql;
    const nsOpt = this.kind === 'sqlite' ? undefined : ns || undefined;
    const run = async (readOnly: boolean) => this.a.run(final, [], { readOnly, timeoutMs: o.timeoutMs, ns: nsOpt });
    let r: Raw;
    if (o.readOnly) r = await run(true);
    else r = await run(false);
    if (r.columns.length || selectLike) {
      const rows = obj(r);
      return { kind: 'rows', columns: uniqueNames(r.columns), rows: rows.slice(0, limit).map(clipRow), truncated: rows.length > limit, ms: Date.now() - t0 };
    }
    return { kind: 'ok', columns: [], rows: [], affected: r.affected, ms: Date.now() - t0 };
  }

  close() { return this.a.close(); }
}
