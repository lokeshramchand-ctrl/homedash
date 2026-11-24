import mssql from 'mssql';
import type {
  Activity, BrowseOpts, Capabilities, Column, ConnConfig, Describe, Driver, Entity, IndexInfo, IndexSpec, Namespace, Page, QueryOpts, QueryResult,
} from './types.js';
import { DriverError } from './types.js';
import { clamp, clipRow, jsonSafe, singleStatement, uniqueNames } from './util.js';
import { mssqlReadOnlyViolation } from './sqlguard.js';

// SQL Server. One mental model with the other engines:
//   connection ──► database (namespace) ──► "schema.table" (entity) ──► row
// SQL Server has no read-only transaction, so read-only work runs inside a transaction that is always rolled back.
// Pair that with a login that only has read permissions (SELECT ALL USER SECURABLES) for a hard guarantee.

type Row = Record<string, unknown>;
interface Raw { columns: string[]; rows: unknown[][]; affected: number }

const q = (id: string) => `[${id.replace(/]/g, ']]')}]`;
/** "dbo.Users" → ["dbo", "Users"]; a bare name means dbo. */
const split = (entity: string): [string, string] => {
  const i = entity.indexOf('.');
  return i > 0 ? [entity.slice(0, i), entity.slice(i + 1)] : ['dbo', entity];
};
const SYSTEM_DBS = new Set(['master', 'tempdb', 'model', 'msdb']);

export class MssqlDriver implements Driver {
  readonly kind = 'mssql';
  readonly caps: Capabilities = {
    language: 'tsql', write: true, indexes: true, activity: true, dropEntity: true, importExport: true,
    filterHint: "A WHERE expression, e.g. Status = 'active' AND Age > 30", entityLabel: 'table', namespaceLabel: 'database',
    queryHelp: 'T-SQL, one statement. SELECT TOP 100 * FROM dbo.MyTable',
  };
  private pool: mssql.ConnectionPool;
  private ready: Promise<mssql.ConnectionPool>;

  constructor(private cfg: ConnConfig, private writable: boolean) {
    this.pool = new mssql.ConnectionPool({
      server: cfg.host ?? '127.0.0.1', port: cfg.port ?? 1433, user: cfg.username, password: cfg.password, database: cfg.database || 'master',
      connectionTimeout: 8000, requestTimeout: 15000, pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
      options: { encrypt: !!(cfg.tls || cfg.ca), trustServerCertificate: !!cfg.tlsInsecure || !(cfg.tls || cfg.ca), appName: 'homedash', ...(cfg.ca ? { cryptoCredentialsDetails: { ca: cfg.ca } } : {}) },
    });
    this.pool.on('error', () => { /* a pooled connection died; the pool replaces it */ });
    this.ready = this.pool.connect();
    this.ready.catch(() => undefined);
  }

  private get defaultNs() { return this.cfg.database || 'master'; }

  /** Runs one batch. `ns` switches database for this batch only. Read-only batches are always rolled back. */
  private async run(sql: string, params: unknown[], o: { readOnly: boolean; timeoutMs: number; ns?: string }): Promise<Raw> {
    if (!o.readOnly && !this.writable) throw new DriverError(403, 'READ_ONLY', 'This connection is read-only');
    const pool = await this.ready;
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    let ok = false;
    try {
      const Req = mssql.Request as unknown as new (p: mssql.Transaction, o: { requestTimeout: number }) => mssql.Request;
      const req = new Req(tx, { requestTimeout: Math.floor(o.timeoutMs) });
      req.arrayRowMode = true;
      params.forEach((v, i) => req.input(`p${i + 1}`, v));
      const body = o.ns ? `USE ${q(o.ns)};\n${sql}` : sql;
      const r = await req.query(body) as unknown as { recordsets: unknown[][][]; columns?: { name: string }[][]; rowsAffected: number[] };
      const last = (r.recordsets?.length ?? 0) - 1;
      const raw: Raw = last >= 0
        ? { columns: (r.columns?.[last] ?? []).map((c) => c.name || '(no name)'), rows: r.recordsets[last] ?? [], affected: 0 }
        : { columns: [], rows: [], affected: (r.rowsAffected ?? []).reduce((a, b) => a + b, 0) };
      ok = !o.readOnly;
      return raw;
    } finally {
      if (ok) await tx.commit(); else await tx.rollback().catch(() => undefined);
    }
  }

  private q = (sql: string, params: unknown[] = [], ns?: string) => this.run(sql, params, { readOnly: true, timeoutMs: 15000, ns });
  private rows = async (sql: string, params: unknown[] = [], ns?: string): Promise<Row[]> => {
    const r = await this.q(sql, params, ns);
    const names = uniqueNames(r.columns);
    return r.rows.map((a) => Object.fromEntries(names.map((n, i) => [n, jsonSafe(a[i])])));
  };
  private qual(entity: string) { const [s, t] = split(entity); return `${q(s)}.${q(t)}`; }

  async ping() {
    const t = Date.now();
    const [r] = await this.rows(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS e`);
    return { ms: Date.now() - t, version: `SQL Server ${r?.v ?? '?'} ${String(r?.e ?? '').replace(/ \(64-bit\)/, '')}`.trim().slice(0, 80) };
  }

  async info() {
    const summary: Record<string, string | number | null> = { version: (await this.ping()).version };
    const [s] = await this.rows(`SELECT sqlserver_start_time AS started, cpu_count AS cpus, physical_memory_kb AS memKb, committed_kb AS committedKb,
      (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS sessions, (SELECT COUNT(*) FROM sys.databases) AS dbs FROM sys.dm_os_sys_info`);
    if (s) Object.assign(summary, { started: String(s.started), cpus: Number(s.cpus), memoryBytes: Number(s.memKb) * 1024, committedBytes: Number(s.committedKb) * 1024, sessions: Number(s.sessions), databases: Number(s.dbs) });
    const set = await this.rows(`SELECT name, CAST(value_in_use AS nvarchar(64)) AS v FROM sys.configurations WHERE name IN ('max server memory (MB)','min server memory (MB)','max degree of parallelism','cost threshold for parallelism','user connections','backup compression default')`);
    const props = await this.rows(`SELECT CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS collation, CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(32)) AS level,
      CAST(SERVERPROPERTY('ProductUpdateLevel') AS nvarchar(32)) AS cu, CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) AS machine, CAST(SERVERPROPERTY('IsHadrEnabled') AS int) AS alwaysOn`);
    return {
      summary,
      sections: {
        settings: Object.fromEntries(set.map((r) => [String(r.name), String(r.v)])),
        server: Object.fromEntries(Object.entries(props[0] ?? {}).map(([k, v]) => [k, v == null ? null : String(v)])),
      },
    };
  }

  async activity(): Promise<Activity> {
    const s = await this.rows(`SELECT TOP 100 s.session_id AS id, s.login_name AS [user], s.host_name AS host, s.program_name AS app, DB_NAME(s.database_id) AS db, s.status,
      r.command, r.wait_type AS wait, DATEDIFF(second, COALESCE(r.start_time, s.last_request_start_time), SYSDATETIME()) AS seconds, LEFT(t.text, 300) AS query
      FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
      WHERE s.is_user_process = 1 AND s.session_id <> @@SPID ORDER BY seconds DESC`);
    return { supported: true, sessions: s };
  }

  async namespaces(): Promise<Namespace[]> {
    const dbs = await this.rows(`SELECT d.name, d.state_desc AS state, CAST(SUM(CAST(f.size AS bigint)) * 8192 AS bigint) AS size FROM sys.databases d
      LEFT JOIN sys.master_files f ON f.database_id = d.database_id GROUP BY d.name, d.state_desc, d.database_id ORDER BY CASE WHEN d.database_id > 4 THEN 0 ELSE 1 END, d.name`);
    return dbs.map((r) => ({ name: String(r.name), sizeBytes: r.size == null ? undefined : Number(r.size), note: SYSTEM_DBS.has(String(r.name)) ? 'system' : r.state !== 'ONLINE' ? String(r.state).toLowerCase() : undefined }));
  }

  async entities(ns: string): Promise<Entity[]> {
    return (await this.rows(`SELECT s.name + '.' + o.name AS name, o.type AS t, SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) AS [rows],
      SUM(CAST(a.total_pages AS bigint)) * 8192 AS size FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.partitions p ON p.object_id = o.object_id LEFT JOIN sys.allocation_units a ON a.container_id = p.partition_id
      WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 GROUP BY s.name, o.name, o.type ORDER BY s.name, o.name`, [], ns))
      .map((r) => ({ name: String(r.name), kind: String(r.t).trim() === 'V' ? 'view' as const : 'table' as const, rows: r.t === 'V' ? undefined : Number(r.rows ?? 0), sizeBytes: r.size == null ? undefined : Number(r.size), approx: true }));
  }

  async describe(ns: string, entity: string): Promise<Describe> {
    const [sch, tbl] = split(entity);
    const columns: Column[] = (await this.rows(`SELECT c.name, TYPE_NAME(c.user_type_id) AS type, c.max_length AS len, c.precision AS prec, c.scale, c.is_nullable AS nullable, c.is_identity AS ident,
      CASE WHEN ic.column_id IS NULL THEN 0 ELSE 1 END AS pk, OBJECT_DEFINITION(c.default_object_id) AS def
      FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.indexes i ON i.object_id = o.object_id AND i.is_primary_key = 1
      LEFT JOIN sys.index_columns ic ON ic.object_id = o.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id
      WHERE s.name = @p1 AND o.name = @p2 ORDER BY c.column_id`, [sch, tbl], ns))
      .map((r) => {
        const t = String(r.type);
        const len = Number(r.len);
        const sized = /char|binary/.test(t) ? `${t}(${len === -1 ? 'max' : /^n/.test(t) ? len / 2 : len})` : /decimal|numeric/.test(t) ? `${t}(${r.prec},${r.scale})` : t;
        return { name: String(r.name), type: sized, nullable: !!r.nullable, pk: !!r.pk, default: r.def == null ? null : String(r.def), note: r.ident ? 'identity' : undefined };
      });
    const idx = new Map<string, IndexInfo>();
    for (const r of await this.rows(`SELECT i.name, i.is_unique AS u, i.is_primary_key AS p, i.type_desc AS t, c.name AS col, ic.is_descending_key AS d
      FROM sys.indexes i JOIN sys.objects o ON o.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
      WHERE s.name = @p1 AND o.name = @p2 AND i.name IS NOT NULL AND ic.is_included_column = 0 ORDER BY i.name, ic.key_ordinal`, [sch, tbl], ns)) {
      const n = String(r.name);
      const e = idx.get(n) ?? { name: n, columns: [], unique: !!r.u, primary: !!r.p, detail: String(r.t).toLowerCase() };
      e.columns.push(`${r.col}${r.d ? ' DESC' : ''}`);
      idx.set(n, e);
    }
    const [s] = await this.rows(`SELECT SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) AS [rows], SUM(CAST(a.total_pages AS bigint)) * 8192 AS total,
      SUM(CASE WHEN p.index_id IN (0, 1) THEN CAST(a.data_pages AS bigint) ELSE 0 END) * 8192 AS data, MAX(o.create_date) AS created, MAX(o.modify_date) AS modified
      FROM sys.objects o JOIN sys.schemas sc ON sc.schema_id = o.schema_id LEFT JOIN sys.partitions p ON p.object_id = o.object_id
      LEFT JOIN sys.allocation_units a ON a.container_id = p.partition_id WHERE sc.name = @p1 AND o.name = @p2`, [sch, tbl], ns);
    const [v] = await this.rows(`SELECT OBJECT_DEFINITION(OBJECT_ID(@p1)) AS ddl`, [`${q(sch)}.${q(tbl)}`], ns);
    return {
      idFields: columns.filter((c) => c.pk).map((c) => c.name), columns, indexes: [...idx.values()],
      stats: s ? { rowsEstimate: Number(s.rows ?? 0), totalBytes: Number(s.total ?? 0), dataBytes: Number(s.data ?? 0), created: s.created ? String(s.created) : null, modified: s.modified ? String(s.modified) : null } : {},
      ddl: v?.ddl ? String(v.ddl) : undefined,
    };
  }

  async browse(ns: string, entity: string, o: BrowseOpts): Promise<Page> {
    const t = this.qual(entity);
    const where = o.filter?.trim() ? ` WHERE ${o.filter.trim().replace(/;+\s*$/, '')}` : '';
    if (/;/.test(where.replace(/'(?:[^']|'')*'/g, ''))) throw new DriverError(400, 'BAD_QUERY', 'Filter must be a single expression');
    const order = o.sort ? `${q(o.sort)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}` : '(SELECT NULL)';
    const r = await this.q(`SELECT * FROM ${t}${where} ORDER BY ${order} OFFSET ${o.offset} ROWS FETCH NEXT ${o.limit + 1} ROWS ONLY`, [], ns || this.defaultNs);
    const names = uniqueNames(r.columns);
    const rows = r.rows.map((a) => Object.fromEntries(names.map((n, i) => [n, jsonSafe(a[i])])));
    let total: number | null = null;
    try { total = Number((await this.rows(`SELECT COUNT_BIG(*) AS n FROM ${t}${where}`, [], ns || this.defaultNs))[0].n); } catch { total = null; }
    return { columns: names, rows: rows.slice(0, o.limit).map(clipRow), total, hasMore: rows.length > o.limit };
  }

  private async pk(ns: string, entity: string) {
    const d = await this.describe(ns, entity);
    if (!d.idFields.length) throw new DriverError(400, 'NO_PRIMARY_KEY', `${entity} has no primary key, so single rows cannot be addressed. Use the query console.`);
    return d.idFields;
  }
  private where(pk: string[], id: unknown, start = 1) {
    const v = id as Row;
    if (!v || typeof v !== 'object') throw new DriverError(400, 'BAD_REQUEST', 'id must be an object of primary-key values');
    for (const k of pk) if (!(k in v)) throw new DriverError(400, 'BAD_REQUEST', `id is missing ${k}`);
    return { sql: pk.map((k, i) => `${q(k)} = @p${start + i}`).join(' AND '), params: pk.map((k) => v[k]) };
  }

  async getRecord(ns: string, entity: string, id: unknown) {
    const w = this.where(await this.pk(ns, entity), id);
    const r = await this.rows(`SELECT TOP 1 * FROM ${this.qual(entity)} WHERE ${w.sql}`, w.params, ns);
    if (!r[0]) throw new DriverError(404, 'NOT_FOUND', 'No row with that key');
    return r[0];
  }

  async upsert(ns: string, entity: string, id: unknown, doc: Row) {
    const t = this.qual(entity);
    const keys = Object.keys(doc);
    const w = { readOnly: false, timeoutMs: 15000, ns };
    const pk = await this.pk(ns, entity).catch(() => [] as string[]);
    if (id === null || id === undefined) {
      if (!keys.length) throw new DriverError(400, 'BAD_REQUEST', 'Nothing to insert');
      const out = pk.length ? ` OUTPUT ${pk.map((k) => `INSERTED.${q(k)}`).join(', ')}` : '';
      const r = await this.run(`INSERT INTO ${t} (${keys.map(q).join(', ')})${out} VALUES (${keys.map((_, i) => `@p${i + 1}`).join(', ')})`, keys.map((k) => doc[k]), w);
      return Object.fromEntries(pk.map((k, i) => [k, jsonSafe(r.rows[0]?.[i] ?? doc[k] ?? null)]));
    }
    if (!pk.length) throw new DriverError(400, 'NO_PRIMARY_KEY', `${entity} has no primary key`);
    const sets = keys.filter((k) => !pk.includes(k));
    if (!sets.length) return id;
    const wh = this.where(pk, id, sets.length + 1);
    const r = await this.run(`UPDATE ${t} SET ${sets.map((k, i) => `${q(k)} = @p${i + 1}`).join(', ')} WHERE ${wh.sql}`, [...sets.map((k) => doc[k]), ...wh.params], w);
    if (!r.affected) throw new DriverError(404, 'NOT_FOUND', 'No row with that key');
    return id;
  }

  async remove(ns: string, entity: string, id: unknown) {
    const w = this.where(await this.pk(ns, entity), id);
    return (await this.run(`DELETE FROM ${this.qual(entity)} WHERE ${w.sql}`, w.params, { readOnly: false, timeoutMs: 15000, ns })).affected;
  }

  async createIndex(ns: string, entity: string, spec: IndexSpec) {
    if (!spec.columns.length) throw new DriverError(400, 'BAD_REQUEST', 'At least one column is required');
    const name = spec.name || `IX_${split(entity)[1]}_${spec.columns.map((c) => c.field).join('_')}`.slice(0, 120);
    if (!/^[A-Za-z_][\w$]{0,127}$/.test(name)) throw new DriverError(400, 'BAD_REQUEST', 'Index name may only contain letters, digits and _');
    await this.run(`CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${this.qual(entity)} (${spec.columns.map((c) => `${q(c.field)}${c.dir === 'desc' ? ' DESC' : ''}`).join(', ')})`, [], { readOnly: false, timeoutMs: 60000, ns });
    return name;
  }
  async dropIndex(ns: string, entity: string, name: string) {
    await this.run(`DROP INDEX ${q(name)} ON ${this.qual(entity)}`, [], { readOnly: false, timeoutMs: 30000, ns });
  }
  async dropEntity(ns: string, entity: string) {
    const kind = (await this.entities(ns)).find((e) => e.name === entity)?.kind;
    if (!kind) throw new DriverError(404, 'NOT_FOUND', `${entity} does not exist`);
    await this.run(`DROP ${kind === 'view' ? 'VIEW' : 'TABLE'} ${this.qual(entity)}`, [], { readOnly: false, timeoutMs: 30000, ns });
  }

  async query(ns: string, text: string, o: QueryOpts): Promise<QueryResult> {
    const t0 = Date.now();
    const sql = text.trim();
    if (!sql) throw new DriverError(400, 'BAD_QUERY', 'Empty query');
    const single = singleStatement(sql);
    if (single === null) throw new DriverError(400, 'BAD_QUERY', 'Run one statement at a time');
    if (o.readOnly) {
      // The rollback wrapper is only a convenience: refuse anything that could end it or that SQL Server cannot roll back.
      const bad = mssqlReadOnlyViolation(single);
      if (bad) throw new DriverError(403, 'READ_ONLY', `${bad} is not allowed on a read-only connection`);
    }
    if (/^\s*(use|go)\b/i.test(single)) throw new DriverError(400, 'BAD_QUERY', 'Pick the database in the tree instead of USE');
    const limit = clamp(o.limit, 1, 5000);
    const selectLike = /^\s*(select|with)\b/i.test(single);
    // SET ROWCOUNT caps what a SELECT returns without rewriting the user's statement.
    const r = await this.run(selectLike ? `SET ROWCOUNT ${limit + 1};\n${single}` : single, [], { readOnly: o.readOnly, timeoutMs: o.timeoutMs, ns: ns || this.defaultNs });
    if (r.columns.length || selectLike) {
      const names = uniqueNames(r.columns);
      const rows = r.rows.map((a) => Object.fromEntries(names.map((n, i) => [n, jsonSafe(a[i])])));
      return { kind: 'rows', columns: names, rows: rows.slice(0, limit).map(clipRow), truncated: rows.length > limit, ms: Date.now() - t0 };
    }
    return { kind: 'ok', columns: [], rows: [], affected: r.affected, ms: Date.now() - t0 };
  }

  async close() { await this.ready.catch(() => undefined); await this.pool.close().catch(() => undefined); }
}
