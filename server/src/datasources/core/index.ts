import { MilvusDriver } from './milvus.js';
import { MongoDriver } from './mongo.js';
import { MssqlDriver } from './mssql.js';
import { RedisDriver } from './redis.js';
import type { DriverPlugin, KindInfo } from './registry.js';
import { SqlDriver } from './sql.js';
import type { ConnConfig, Driver, Kind } from './types.js';
import { DriverError } from './types.js';

export * from './types.js';
export type { DriverPlugin, FieldName, KindInfo } from './registry.js';

const sql = (kind: 'postgres' | 'mysql' | 'sqlite') => (cfg: ConnConfig, writable: boolean): Driver => new SqlDriver(kind, cfg, writable);

/** Register an engine here: one entry per service. Order is the order shown in the UI. */
export const PLUGINS: DriverPlugin[] = [
  { kind: 'mongodb', label: 'MongoDB', defaultPort: 27017, fields: ['uri', 'host', 'port', 'database', 'username', 'password', 'tls'], connect: 'uri-or-host',
    uriScheme: { re: /^mongodb(\+srv)?:\/\//, message: 'URI must start with mongodb:// or mongodb+srv://' },
    uriExample: 'mongodb://user:pass@host:27017/?tls=true', databaseHint: 'Default database / auth source', create: (c) => new MongoDriver(c) },
  { kind: 'redis', label: 'Redis / Valkey', defaultPort: 6379, fields: ['uri', 'host', 'port', 'database', 'username', 'password', 'tls'], connect: 'uri-or-host',
    uriScheme: { re: /^rediss?:\/\//, message: 'URI must start with redis:// or rediss://' },
    uriExample: 'rediss://user:pass@host:6379', databaseHint: 'Default db index (0)', databaseLabel: 'Database index', create: (c) => new RedisDriver(c) },
  { kind: 'postgres', label: 'PostgreSQL', defaultPort: 5432, fields: ['host', 'port', 'database', 'username', 'password', 'tls'], connect: 'host', databaseHint: 'Database name', create: sql('postgres') },
  { kind: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306, fields: ['host', 'port', 'database', 'username', 'password', 'tls'], connect: 'host', databaseHint: 'Default database (optional)', create: sql('mysql') },
  { kind: 'mssql', label: 'SQL Server', defaultPort: 1433, fields: ['host', 'port', 'database', 'username', 'password', 'tls'], connect: 'host',
    databaseHint: 'Default database (master)', create: (c, w) => new MssqlDriver(c, w) },
  { kind: 'sqlite', label: 'SQLite', defaultPort: null, fields: ['file'], connect: 'file', create: sql('sqlite') },
  { kind: 'milvus', label: 'Milvus', defaultPort: 19530, fields: ['host', 'port', 'database', 'username', 'password', 'token', 'tls'], connect: 'host',
    databaseHint: 'Database (default)', create: (c, w) => new MilvusDriver(c, w) },
];

const byKind = new Map(PLUGINS.map((p) => [p.kind, p]));
export const KINDS: Kind[] = PLUGINS.map((p) => p.kind);
export const getPlugin = (kind: string): DriverPlugin | undefined => byKind.get(kind);
export const KIND_INFO: KindInfo[] = PLUGINS.map(({ create: _c, uriScheme: _u, ...info }) => info);

/** The single entry point other services call. `writable=false` makes write attempts impossible, not just discouraged
 *  (read-only transactions for SQL, read-only file handle for SQLite). */
export function createDriver(kind: Kind, cfg: ConnConfig, writable: boolean): Driver {
  const p = byKind.get(kind);
  if (!p) throw new DriverError(400, 'BAD_REQUEST', `Unknown database kind "${String(kind)}"`);
  return p.create(cfg, writable);
}
