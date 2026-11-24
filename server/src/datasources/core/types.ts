// Framework-free contract for "a database the dashboard can manage".
// Nothing in core/ imports Fastify, Mongo auth state or the dashboard config, so this folder can be
// lifted into any other service: implement `Driver` once per engine, call `createDriver(kind, cfg)`.
//
// One mental model for every engine:
//   connection ──► namespace ──► entity ──► record
//   MongoDB         database      collection  document
//   PostgreSQL      schema        table/view  row
//   MySQL           database      table/view  row
//   SQLite          "main"        table/view  row
//   Redis           db index      "keys"      key
//   Milvus          database      collection  entity (vector + scalar fields)

/** Engine identifier. A plain string: engines register themselves in registry.ts, so adding one needs no type edits. */
export type Kind = string;

/** Connection settings. Secrets (password, uri) are kept apart by the store and never sent to the browser. */
export interface ConnConfig {
  uri?: string;            // overrides host/port/user/password for mongodb and redis
  host?: string;
  port?: number;
  database?: string;       // default db: mongo db name, pg/mysql database, redis db index, unused for sqlite
  username?: string;
  password?: string;
  tls?: boolean;
  tlsInsecure?: boolean;   // skip certificate verification (self-signed)
  ca?: string;             // PEM text of a private CA
  file?: string;           // sqlite database path
  token?: string;          // API token (Milvus/Zilliz); secret, sealed like password
}

/** Editor hint for the Query tab. Unknown values fall back to plain text. */
export type QueryLanguage = 'mongo-json' | 'redis-cli' | 'sql' | 'tsql' | (string & {});

export interface Capabilities {
  language: QueryLanguage;
  write: boolean;          // record-level insert/update/delete
  indexes: boolean;        // create/drop secondary indexes
  activity: boolean;       // live sessions / slow commands
  dropEntity: boolean;
  importExport: boolean;
  filterHint: string;      // what the browse filter box accepts
  entityLabel: string;     // "collection" | "table" | "keys"
  namespaceLabel: string;  // "database" | "schema" | "db index"
  /** Optional features. Absent = the UI hides the matching tab/button. */
  search?: SearchCaps;     // similarity / full-text search panel
  actions?: ActionSpec[];  // named operations beyond CRUD (flush, load, compact, ...)
  /** How the UI addresses one row: the whole primary-key object (default), the `_id` column or the `key` column. */
  rowKey?: 'pk-object' | '_id' | 'key';
  queryHelp?: string;      // placeholder / examples shown in the Query tab
}

export interface SearchCaps {
  label: string;           // "Vector search"
  inputHint: string;       // what the query box accepts
  fields: boolean;         // entity must expose searchable fields (describe().searchFields)
  params: { name: string; label: string; type: 'number' | 'text' | 'select'; default?: string | number; options?: string[] }[];
}
export interface ActionSpec {
  id: string; label: string; danger?: boolean; write: boolean;
  scope: 'connection' | 'namespace' | 'entity';
  confirm?: boolean;       // ask the user to type the entity name first
}
export interface SearchReq { field?: string; query: string; limit: number; params: Record<string, string | number>; filter?: string }

export interface Namespace { name: string; sizeBytes?: number; entities?: number; note?: string }
export interface Entity { name: string; kind: 'collection' | 'table' | 'view' | 'keys'; rows?: number; sizeBytes?: number; approx?: boolean }
export interface Column { name: string; type: string; nullable?: boolean; pk?: boolean; default?: string | null; note?: string }
export interface IndexInfo { name: string; columns: string[]; unique?: boolean; primary?: boolean; detail?: string }
export interface Describe {
  idFields: string[];                 // what identifies a record: ["_id"], ["id"], ["key"]
  columns: Column[];                  // sql columns, or fields inferred from a sample for mongo
  indexes: IndexInfo[];
  stats: Record<string, string | number | boolean | null>;
  ddl?: string;
  searchFields?: { name: string; type: string; dim?: number }[];
}

export interface BrowseOpts { limit: number; offset: number; cursor?: string; filter?: string; sort?: string; dir?: 'asc' | 'desc' }
export interface Page {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number | null;
  totalApprox?: boolean;
  nextCursor?: string;                // redis SCAN cursor; absent when finished
  hasMore: boolean;
}

export interface QueryOpts { readOnly: boolean; limit: number; timeoutMs: number }
export interface QueryResult {
  kind: 'rows' | 'value' | 'ok';
  columns: string[];
  rows: Record<string, unknown>[];
  value?: unknown;
  affected?: number;
  truncated?: boolean;
  ms: number;
  statement?: string;
}

export interface IndexSpec { name?: string; columns: { field: string; dir?: 'asc' | 'desc' }[]; unique?: boolean }

export interface Activity {
  supported: boolean;
  sessions: Record<string, unknown>[];
  slow?: Record<string, unknown>[];
  note?: string;
}

export interface Driver {
  readonly kind: Kind;
  readonly caps: Capabilities;
  ping(): Promise<{ ms: number; version: string }>;
  info(): Promise<{ summary: Record<string, string | number | null>; sections: Record<string, Record<string, string | number | null>> }>;
  activity(): Promise<Activity>;
  namespaces(): Promise<Namespace[]>;
  entities(ns: string): Promise<Entity[]>;
  describe(ns: string, entity: string): Promise<Describe>;
  browse(ns: string, entity: string, o: BrowseOpts): Promise<Page>;
  getRecord(ns: string, entity: string, id: unknown): Promise<unknown>;
  /** id === null inserts; otherwise replaces/updates the record with that id. Returns the stored id. */
  upsert(ns: string, entity: string, id: unknown, doc: Record<string, unknown>): Promise<unknown>;
  remove(ns: string, entity: string, id: unknown): Promise<number>;
  createIndex(ns: string, entity: string, spec: IndexSpec): Promise<string>;
  dropIndex(ns: string, entity: string, name: string): Promise<void>;
  dropEntity(ns: string, entity: string): Promise<void>;
  query(ns: string, text: string, o: QueryOpts): Promise<QueryResult>;
  /** Present only when caps.search is set. */
  search?(ns: string, entity: string, r: SearchReq): Promise<QueryResult>;
  /** Present only when caps.actions is set. entity is '' for namespace/connection scope. */
  runAction?(ns: string, entity: string, id: string): Promise<{ ok: true; message?: string }>;
  close(): Promise<void>;
}

/** Thrown for user-facing problems that are neither a bad query nor a dead connection. */
export class DriverError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const unsupported = (what: string) => new DriverError(400, 'UNSUPPORTED', `${what} is not supported by this database`);
