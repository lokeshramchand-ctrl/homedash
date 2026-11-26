import { createClient } from 'redis';
import type { Activity, BrowseOpts, ConnConfig, Describe, Driver, Entity, IndexSpec, Namespace, Page, QueryOpts, QueryResult } from './types.js';
import { DriverError, unsupported } from './types.js';
import { clamp, jsonSafe, tokenize } from './util.js';

type Client = ReturnType<typeof createClient>;
type Reply = unknown;

// Commands that only read. Everything else needs a writable connection.
const READ = new Set(('get mget strlen getrange exists type ttl pttl expiretime pexpiretime object memory dbsize scan keys randomkey ' +
  'hget hgetall hmget hkeys hvals hlen hexists hstrlen hscan hrandfield lrange llen lindex lpos smembers scard sismember smismember srandmember sscan sdiff sinter sunion ' +
  'zrange zrevrange zrangebyscore zrevrangebyscore zrangebylex zcard zscore zmscore zrank zrevrank zcount zlexcount zscan zrandmember ' +
  'xrange xrevrange xlen xinfo xread pfcount bitcount bitpos getbit ' +
  'info ping time lastsave dbsize echo slowlog client config command latency role strlen ' +
  'geopos geodist geohash georadius_ro geosearch json.get ts.get ts.range').split(' '));
// Needs write access but still only inside the dashboard's guardrails.
const WRITE_SUB: Record<string, Set<string>> = { client: new Set(['list', 'info', 'getname', 'id']), config: new Set(['get']), slowlog: new Set(['get', 'len']), memory: new Set(['usage', 'stats', 'doctor']), object: new Set(['encoding', 'freq', 'idletime', 'refcount']), command: new Set(['count', 'docs', 'info', 'list']), xinfo: new Set(['stream', 'groups', 'consumers']) };
// Never allowed from the dashboard, with or without write access.
const DENY = new Set(('shutdown debug module replicaof slaveof acl migrate cluster failover monitor subscribe psubscribe ssubscribe sync psync eval evalsha eval_ro evalsha_ro fcall fcall_ro script function save bgsave bgrewriteaof ' +
  'auth hello select multi exec watch blpop brpop blmove brpoplpush bzpopmin bzpopmax wait waitaof reset quit swapdb restore dump').split(' '));
const NEEDS_CONFIRM = new Set(['flushall', 'flushdb']);
// CONFIG GET returns server settings, including requirepass, masterauth and TLS key paths. Only these harmless
// parameters may be read, by exact name (no patterns such as "*" or "re*").
export const CONFIG_GET_ALLOWED = new Set(['databases', 'maxmemory', 'maxmemory-policy', 'maxclients', 'timeout', 'tcp-keepalive', 'save', 'appendonly', 'appendfsync', 'hz', 'maxmemory-samples', 'slowlog-log-slower-than', 'slowlog-max-len', 'latency-monitor-threshold', 'notify-keyspace-events', 'lazyfree-lazy-eviction', 'lazyfree-lazy-expire', 'dbfilename', 'port']);

/** Reasons a CONFIG command is refused, or null when it is fine. Applies to read-only and writable connections alike. */
export function configRefusal(args: string[]): string | null {
  if (args[0]?.toLowerCase() !== 'config') return null;
  if (args[1]?.toLowerCase() !== 'get') return 'CONFIG is only available as CONFIG GET for a few harmless settings';
  const params = args.slice(2);
  if (!params.length || params.some((p) => !CONFIG_GET_ALLOWED.has(p.toLowerCase()))) return `CONFIG GET only reads: ${[...CONFIG_GET_ALLOWED].join(', ')}`;
  return null;
}

const str = (r: Reply) => (typeof r === 'string' ? r : Buffer.isBuffer(r) ? r.toString() : String(r));

function parseInfo(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let sec = 'misc';
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('#')) { sec = line.slice(1).trim().toLowerCase(); out[sec] = {}; continue; }
    const i = line.indexOf(':');
    if (i > 0) (out[sec] ??= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v ?? null);

export class RedisDriver implements Driver {
  readonly kind = 'redis' as const;
  readonly caps = {
    language: 'redis-cli' as const, write: true, indexes: false, activity: true, dropEntity: false, importExport: true,
    filterHint: 'Key pattern (SCAN MATCH), e.g. user:* or session:??', entityLabel: 'keys', namespaceLabel: 'db index', rowKey: 'key' as const,
  };
  private clients = new Map<number, Promise<Client>>();
  private defaultDb: number;

  constructor(private cfg: ConnConfig) {
    const d = Number(cfg.database ?? 0);
    this.defaultDb = Number.isInteger(d) && d >= 0 ? d : 0;
  }

  private client(db: number): Promise<Client> {
    let p = this.clients.get(db);
    if (!p) {
      const c = this.cfg;
      const useTls = c.tls || c.uri?.startsWith('rediss://');
      const base = c.uri ? { url: c.uri } : { username: c.username || undefined, password: c.password || undefined };
      const socket = c.uri && !useTls ? { connectTimeout: 8000 } : {
        ...(c.uri ? {} : { host: c.host ?? '127.0.0.1', port: c.port ?? 6379 }),
        connectTimeout: 8000, ...(useTls ? { tls: true as const, ...(c.ca ? { ca: c.ca } : {}), ...(c.tlsInsecure ? { rejectUnauthorized: false } : {}) } : {}),
      };
      const cl = createClient({ ...base, database: db, socket: { ...socket, reconnectStrategy: false } } as never);
      cl.on('error', () => { /* surfaced by the failing command */ });
      p = cl.connect().then(() => cl).catch((e) => { this.clients.delete(db); throw e; });
      this.clients.set(db, p);
    }
    return p;
  }
  private db(ns: string) { const n = ns === '' ? this.defaultDb : Number(ns); if (!Number.isInteger(n) || n < 0 || n > 1023) throw new DriverError(400, 'BAD_REQUEST', 'db index must be a number'); return n; }
  private async send(db: number, args: string[]): Promise<Reply> { return (await this.client(db)).sendCommand(args as never); }

  async ping() {
    const t = Date.now();
    await this.send(this.defaultDb, ['PING']);
    const v = parseInfo(str(await this.send(this.defaultDb, ['INFO', 'server'])));
    return { ms: Date.now() - t, version: `Redis ${v.server?.redis_version ?? '?'}` };
  }

  async info() {
    const i = parseInfo(str(await this.send(this.defaultDb, ['INFO', 'everything']).catch(() => this.send(this.defaultDb, ['INFO']))));
    const hits = Number(i.stats?.keyspace_hits ?? 0), miss = Number(i.stats?.keyspace_misses ?? 0);
    const summary = {
      version: i.server?.redis_version ?? null, mode: i.server?.redis_mode ?? null, uptimeSeconds: num(i.server?.uptime_in_seconds),
      clients: num(i.clients?.connected_clients), usedMemory: num(i.memory?.used_memory), maxMemory: num(i.memory?.maxmemory),
      opsPerSec: num(i.stats?.instantaneous_ops_per_sec), hitRate: hits + miss ? Math.round((hits / (hits + miss)) * 1000) / 10 : null,
      role: i.replication?.role ?? null,
    };
    const sections: Record<string, Record<string, string | number | null>> = {};
    for (const [k, v] of Object.entries(i)) {
      if (k === 'commandstats' || k === 'latencystats' || k === 'errorstats') continue;
      sections[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, num(b)]));
    }
    if (i.commandstats) {
      sections.top_commands = Object.fromEntries(Object.entries(i.commandstats).map(([c, s]) => [c.replace('cmdstat_', ''), Number(/calls=(\d+)/.exec(s)?.[1] ?? 0)]).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 15));
    }
    return { summary, sections };
  }

  async activity(): Promise<Activity> {
    const sessions: Record<string, unknown>[] = [];
    let note: string | undefined;
    try {
      const raw = str(await this.send(this.defaultDb, ['CLIENT', 'LIST']));
      for (const line of raw.split('\n').filter(Boolean).slice(0, 100)) {
        const o: Record<string, string> = {};
        for (const part of line.split(' ')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i)] = part.slice(i + 1); }
        sessions.push({ id: o.id, addr: o.addr, name: o.name, db: o.db, ageSeconds: Number(o.age), idleSeconds: Number(o.idle), cmd: o.cmd, user: o.user });
      }
    } catch (e) { note = `CLIENT LIST refused: ${(e as Error).message}`; }
    let slow: Record<string, unknown>[] | undefined;
    try {
      const r = (await this.send(this.defaultDb, ['SLOWLOG', 'GET', '20'])) as unknown[][];
      slow = r.map((e) => ({ id: e[0], at: new Date(Number(e[1]) * 1000).toISOString(), micros: e[2], command: (e[3] as unknown[]).map(str).join(' ').slice(0, 300), client: e[4] ? str(e[4]) : undefined }));
    } catch { /* slowlog not permitted */ }
    return { supported: true, sessions, slow, note };
  }

  async namespaces(): Promise<Namespace[]> {
    let n = 16;
    try { n = Number(((await this.send(this.defaultDb, ['CONFIG', 'GET', 'databases'])) as unknown[])?.[1] ?? 16) || 16; } catch { /* config denied: assume 16 */ }
    const ks = parseInfo(str(await this.send(this.defaultDb, ['INFO', 'keyspace']))).keyspace ?? {};
    const out: Namespace[] = [];
    for (let i = 0; i < Math.min(n, 64); i++) {
      const m = /keys=(\d+)/.exec(ks[`db${i}`] ?? '');
      if (m || i === this.defaultDb) out.push({ name: String(i), entities: m ? Number(m[1]) : 0, note: `db${i}` });
    }
    return out;
  }

  async entities(ns: string): Promise<Entity[]> {
    return [{ name: 'keys', kind: 'keys', rows: Number(await this.send(this.db(ns), ['DBSIZE'])) }];
  }

  async describe(ns: string): Promise<Describe> {
    const db = this.db(ns);
    const size = Number(await this.send(db, ['DBSIZE']));
    // Sample type distribution without blocking the server: one SCAN page.
    const [, keys] = (await this.send(db, ['SCAN', '0', 'COUNT', '300'])) as [unknown, string[]];
    const types: Record<string, number> = {};
    const cl = await this.client(db);
    const t = await Promise.all(keys.map((k) => cl.sendCommand(['TYPE', k] as never)));
    for (const x of t) types[str(x)] = (types[str(x)] ?? 0) + 1;
    return {
      idFields: ['key'],
      columns: [{ name: 'key', type: 'string', pk: true }, { name: 'type', type: 'string | list | set | zset | hash | stream' }, { name: 'ttl', type: 'seconds, -1 = none' }, { name: 'size', type: 'bytes (MEMORY USAGE)' }],
      indexes: [],
      stats: { keys: size, sampled: keys.length, ...Object.fromEntries(Object.entries(types).map(([k, v]) => [`type_${k}`, v])) },
    };
  }

  async browse(ns: string, _entity: string, o: BrowseOpts): Promise<Page> {
    const db = this.db(ns);
    const cl = await this.client(db);
    const match = o.filter?.trim() || '*';
    let cursor = o.cursor ?? '0';
    const keys: string[] = [];
    // SCAN returns variable page sizes: keep going until we have a page or the keyspace is exhausted.
    let rounds = 0;
    do {
      const r = (await cl.sendCommand(['SCAN', cursor, 'MATCH', match, 'COUNT', String(Math.max(o.limit, 200))] as never)) as [unknown, string[]];
      cursor = str(r[0]);
      keys.push(...r[1]);
    } while (cursor !== '0' && keys.length < o.limit && ++rounds < 200);
    const uniq = [...new Set(keys)];
    const page = uniq.slice(0, o.limit);
    // keys beyond the page would be lost with this cursor, so rewind: only advance when the page holds all of them
    const rows = await Promise.all(page.map(async (key) => {
      const [type, pttl, size] = await Promise.all([
        cl.sendCommand(['TYPE', key] as never), cl.sendCommand(['PTTL', key] as never),
        cl.sendCommand(['MEMORY', 'USAGE', key, 'SAMPLES', '0'] as never).catch(() => null),
      ]);
      const ms = Number(pttl);
      return { key, type: str(type), ttl: ms < 0 ? ms : Math.round(ms / 1000), size: size === null ? null : Number(size) };
    }));
    const complete = uniq.length <= o.limit;
    const total = match === '*' ? Number(await cl.sendCommand(['DBSIZE'] as never)) : null;
    return { columns: ['key', 'type', 'ttl', 'size'], rows, total, hasMore: !complete || cursor !== '0', nextCursor: complete && cursor !== '0' ? cursor : undefined };
  }

  async getRecord(ns: string, _e: string, id: unknown) {
    const key = String(id);
    const cl = await this.client(this.db(ns));
    const type = str(await cl.sendCommand(['TYPE', key] as never));
    if (type === 'none') throw new DriverError(404, 'NOT_FOUND', 'Key does not exist');
    const pttl = Number(await cl.sendCommand(['PTTL', key] as never));
    const N = 500;
    let value: unknown;
    let length: number | null = null;
    switch (type) {
      case 'string': value = str(await cl.sendCommand(['GET', key] as never)); length = (value as string).length; break;
      case 'list': length = Number(await cl.sendCommand(['LLEN', key] as never)); value = ((await cl.sendCommand(['LRANGE', key, '0', String(N - 1)] as never)) as unknown[]).map(str); break;
      case 'set': { length = Number(await cl.sendCommand(['SCARD', key] as never)); const r = (await cl.sendCommand(['SSCAN', key, '0', 'COUNT', String(N)] as never)) as [unknown, unknown[]]; value = r[1].map(str).slice(0, N); break; }
      case 'zset': {
        length = Number(await cl.sendCommand(['ZCARD', key] as never));
        const r = (await cl.sendCommand(['ZRANGE', key, '0', String(N - 1), 'WITHSCORES'] as never)) as unknown[];
        const flat = r.flat(); const o: { member: string; score: number }[] = [];
        if (Array.isArray(r[0])) for (const [m, s] of r as unknown[][]) o.push({ member: str(m), score: Number(s) });
        else for (let i = 0; i < flat.length; i += 2) o.push({ member: str(flat[i]), score: Number(flat[i + 1]) });
        value = o; break;
      }
      case 'hash': {
        length = Number(await cl.sendCommand(['HLEN', key] as never));
        const r = (await cl.sendCommand(['HSCAN', key, '0', 'COUNT', String(N)] as never)) as [unknown, unknown];
        const arr = r[1]; const o: Record<string, string> = {};
        if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[str(arr[i])] = str(arr[i + 1]);
        else if (arr && typeof arr === 'object') for (const e of arr as unknown as { field: string; value: string }[]) o[str(e.field)] = str(e.value);
        value = o; break;
      }
      case 'stream': length = Number(await cl.sendCommand(['XLEN', key] as never)); value = jsonSafe(await cl.sendCommand(['XREVRANGE', key, '+', '-', 'COUNT', '100'] as never)); break;
      default: value = `(unsupported type ${type})`;
    }
    return { key, type, ttl: pttl < 0 ? pttl : Math.round(pttl / 1000), length, truncated: length !== null && type !== 'string' && length > N, value };
  }

  /** doc = { type, value, ttl? }. Replaces the key atomically. id null = new key named by doc.key. */
  async upsert(ns: string, _e: string, id: unknown, doc: Record<string, unknown>) {
    const key = String(id ?? doc.key ?? '');
    if (!key) throw new DriverError(400, 'BAD_REQUEST', 'key is required');
    const type = String(doc.type ?? 'string');
    const v = doc.value;
    const cl = await this.client(this.db(ns));
    const tmp = `${key}:__spl_tmp_${Date.now()}`;
    const m = cl.multi();
    const put = (k: string) => {
      switch (type) {
        case 'string': m.set(k, String(v ?? '')); break;
        case 'list': if (!Array.isArray(v) || !v.length) throw new DriverError(400, 'BAD_REQUEST', 'list value must be a non-empty array'); m.rPush(k, v.map(String)); break;
        case 'set': if (!Array.isArray(v) || !v.length) throw new DriverError(400, 'BAD_REQUEST', 'set value must be a non-empty array'); m.sAdd(k, v.map(String)); break;
        case 'zset': if (!Array.isArray(v) || !v.length) throw new DriverError(400, 'BAD_REQUEST', 'zset value must be [{member,score}]'); m.zAdd(k, (v as { member: string; score: number }[]).map((x) => ({ value: String(x.member), score: Number(x.score) }))); break;
        case 'hash': if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length) throw new DriverError(400, 'BAD_REQUEST', 'hash value must be a non-empty object'); m.hSet(k, Object.fromEntries(Object.entries(v as object).map(([a, b]) => [a, String(b)]))); break;
        default: throw new DriverError(400, 'BAD_REQUEST', `Cannot write type ${type} from here`);
      }
    };
    put(tmp);
    const ttl = doc.ttl === undefined || doc.ttl === null || doc.ttl === '' ? undefined : Number(doc.ttl);
    if (ttl !== undefined && ttl > 0) m.expire(tmp, Math.floor(ttl));
    m.rename(tmp, key); // RENAME keeps the TTL of tmp and replaces any existing value in one step
    if (ttl === undefined) { /* keep whatever TTL the new key got: none */ }
    await m.exec();
    return key;
  }

  async remove(ns: string, _e: string, id: unknown) { return Number(await this.send(this.db(ns), ['DEL', String(id)])); }
  async createIndex(): Promise<string> { throw unsupported('Indexes'); }
  async dropIndex(): Promise<void> { throw unsupported('Indexes'); }
  async dropEntity(): Promise<void> { throw unsupported('Dropping'); }
  setTtl = async (ns: string, key: string, seconds: number) => { await this.send(this.db(ns), seconds > 0 ? ['EXPIRE', key, String(Math.floor(seconds))] : ['PERSIST', key]); };

  async query(ns: string, text: string, o: QueryOpts): Promise<QueryResult> {
    const t0 = Date.now();
    let args: string[];
    try { args = tokenize(text); } catch (e) { throw new DriverError(400, 'BAD_QUERY', (e as Error).message); }
    if (!args.length) throw new DriverError(400, 'BAD_QUERY', 'Empty command');
    const cmd = args[0].toLowerCase();
    const sub = args[1]?.toLowerCase() ?? '';
    if (DENY.has(cmd)) throw new DriverError(403, 'DENIED', `${cmd.toUpperCase()} is not allowed from the dashboard`);
    const cfgRefusal = configRefusal(args);
    if (cfgRefusal) throw new DriverError(403, 'DENIED', cfgRefusal);
    const isRead = READ.has(cmd) && (!(cmd in WRITE_SUB) || WRITE_SUB[cmd].has(sub) || cmd === 'info' || cmd === 'command' && !sub);
    if (!isRead && o.readOnly) throw new DriverError(403, 'READ_ONLY', `${cmd.toUpperCase()} changes data and this connection is read-only`);
    if (cmd in WRITE_SUB && !WRITE_SUB[cmd].has(sub) && cmd !== 'info') throw new DriverError(403, 'DENIED', `${cmd.toUpperCase()} ${sub.toUpperCase()} is not allowed from the dashboard`);
    if (NEEDS_CONFIRM.has(cmd) && args[args.length - 1].toLowerCase() !== 'confirm') throw new DriverError(400, 'CONFIRM', `${cmd.toUpperCase()} wipes data. Run it again as "${cmd.toUpperCase()} CONFIRM" to proceed.`);
    if (NEEDS_CONFIRM.has(cmd)) args.pop();
    if (cmd === 'keys') args = ['SCAN', '0', 'MATCH', args[1] ?? '*', 'COUNT', '1000']; // never block the server with KEYS
    const raw = await Promise.race([
      this.send(this.db(ns), args),
      new Promise<never>((_, rej) => setTimeout(() => rej(new DriverError(504, 'TIMEOUT', 'Command timed out')), o.timeoutMs)),
    ]);
    let value = jsonSafe(typeof raw === 'string' || typeof raw === 'number' || raw === null ? raw : Buffer.isBuffer(raw) ? raw.toString() : raw);
    let truncated = false;
    if (Array.isArray(value) && value.length > o.limit) { value = value.slice(0, clamp(o.limit, 1, 5000)); truncated = true; }
    return { kind: isRead ? 'value' : 'ok', columns: [], rows: [], value, truncated, ms: Date.now() - t0, statement: args.slice(0, 3).join(' ') };
  }

  async close() {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((p) => p.then((c) => c.quit()).catch(() => undefined)));
  }
}
