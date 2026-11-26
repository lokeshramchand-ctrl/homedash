import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { cfg } from '../config.js';
import type { EnvDatasource } from '../config.js';
import { getDb } from '../db.js';
import { HttpError } from '../errors.js';
import type { ConnConfig, Kind } from './core/index.js';
import { getPlugin, KINDS } from './core/index.js';

// Saved connections live in the embedded SQLite database (`datasources`). Non-secret settings are stored as-is;
// password, uri, CA text and token are sealed with AES-256-GCM, bound to the row id so a ciphertext cannot be
// moved to another entry.

export interface DsDoc {
  _id: string; name: string; kind: Kind; readOnly: boolean; color?: string;
  config: Omit<ConnConfig, 'password' | 'uri' | 'ca' | 'token'>;
  secret: string; // sealed JSON {password?, uri?, ca?, token?}
  createdAt: Date; updatedAt: Date; createdBy: string;
  source?: 'env'; envId?: string; // set when the connection is declared in .env (DS_<ID>_*)
}
export interface AuditDs {
  ts: Date; user: string; ip: string; ds?: string; dsName?: string; action: string; detail?: string;
  result: 'ok' | 'refused' | 'error'; ms?: number; rows?: number;
}
export interface DsPublic {
  id: string; name: string; kind: Kind; readOnly: boolean; color?: string;
  config: DsDoc['config'] & { uriMasked?: string; hasPassword: boolean; hasCa: boolean; hasToken: boolean };
  createdAt: string; updatedAt: string;
  managed?: 'env'; envId?: string; // declared in .env: edit it there, not in the UI
}

const AUDIT_DAYS = 180;

// ---- rows --------------------------------------------------------------------------------------
const rowToDoc = (r: any): DsDoc => ({
  _id: r.id, name: r.name, kind: r.kind, readOnly: !!r.read_only, color: r.color ?? undefined,
  config: JSON.parse(r.config), secret: r.secret, createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at), createdBy: r.created_by,
  ...(r.source === 'env' ? { source: 'env' as const, envId: r.env_id } : {}),
});
const byName = (name: string): DsDoc | null => { const r = getDb().prepare('SELECT * FROM datasources WHERE name = ?').get(name); return r ? rowToDoc(r) : null; };
const byEnv = (envId: string): DsDoc | null => { const r = getDb().prepare("SELECT * FROM datasources WHERE source = 'env' AND env_id = ?").get(envId); return r ? rowToDoc(r) : null; };

function dupOr(e: unknown): unknown {
  return /UNIQUE/i.test((e as Error).message ?? '') ? new HttpError(409, 'DUPLICATE', 'A connection with that name already exists') : e;
}
const insertDoc = (d: DsDoc) => {
  try {
    getDb().prepare(`INSERT INTO datasources (id, name, kind, read_only, color, config, secret, created_at, updated_at, created_by, source, env_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d._id, d.name, d.kind, d.readOnly ? 1 : 0, d.color ?? null, JSON.stringify(d.config), d.secret,
      d.createdAt.getTime(), d.updatedAt.getTime(), d.createdBy, d.source ?? null, d.envId ?? null);
  } catch (e) { throw dupOr(e); }
};
const replaceDoc = (d: DsDoc) => {
  try {
    getDb().prepare('UPDATE datasources SET name = ?, kind = ?, read_only = ?, color = ?, config = ?, secret = ?, updated_at = ?, source = ?, env_id = ? WHERE id = ?')
      .run(d.name, d.kind, d.readOnly ? 1 : 0, d.color ?? null, JSON.stringify(d.config), d.secret, d.updatedAt.getTime(), d.source ?? null, d.envId ?? null, d._id);
  } catch (e) { throw dupOr(e); }
};

// ---- audit -------------------------------------------------------------------------------------
export function addAudit(a: Omit<AuditDs, 'ts'>): void {
  const now = Date.now();
  getDb().prepare('INSERT INTO datasource_audit (ts, user, ip, ds, ds_name, action, detail, result, ms, rows, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now, a.user, a.ip, a.ds ?? null, a.dsName ?? null, a.action, a.detail ?? null, a.result, a.ms ?? null, a.rows ?? null, now + AUDIT_DAYS * 86_400_000);
}
export function listAudit(limit: number): AuditDs[] {
  return (getDb().prepare("SELECT * FROM datasource_audit WHERE action != 'connection.test' ORDER BY ts DESC LIMIT ?").all(limit) as any[]).map((r) => ({
    ts: new Date(r.ts), user: r.user, ip: r.ip, ds: r.ds ?? undefined, dsName: r.ds_name ?? undefined, action: r.action, detail: r.detail ?? undefined,
    result: r.result, ms: r.ms ?? undefined, rows: r.rows ?? undefined,
  }));
}

// ---- sealing -----------------------------------------------------------------------------------
let keyCache: Buffer | undefined;
const key = () => (keyCache ??= scryptSync(cfg.datasourceKey, 'homedash/datasources/v1', 32));

function seal(plain: object, id: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(id));
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
function open(sealed: string, id: string): { password?: string; uri?: string; ca?: string; token?: string } {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1') throw new HttpError(500, 'INTERNAL', 'Unknown secret format');
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(id));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
  } catch {
    throw new HttpError(409, 'SECRET_UNREADABLE', 'Saved secrets cannot be decrypted. DATASOURCE_KEY changed: edit the connection and enter the password again.');
  }
}

/** mongodb://user:pw@h/ -> mongodb://user:***@h/ */
export const maskUri = (u: string) => u.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1•••@');

const toPublic = (d: DsDoc): DsPublic => {
  let sec: { password?: string; uri?: string; ca?: string; token?: string } = {};
  try { sec = open(d.secret, d._id); } catch { /* shown as unreadable by hasPassword=false; use fails later with a clear error */ }
  return {
    id: d._id, name: d.name, kind: d.kind, readOnly: d.readOnly, color: d.color,
    config: { ...d.config, uriMasked: sec.uri ? maskUri(sec.uri) : undefined, hasPassword: !!sec.password, hasCa: !!sec.ca, hasToken: !!sec.token },
    createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
    ...(d.source === 'env' ? { managed: 'env' as const, envId: d.envId } : {}),
  };
};

export interface DsInput {
  name?: string; kind?: Kind; readOnly?: boolean; color?: string;
  host?: string; port?: number | string; database?: string; username?: string; password?: string; uri?: string;
  tls?: boolean; tlsInsecure?: boolean; ca?: string; file?: string; token?: string;
  clearPassword?: boolean; clearToken?: boolean;
}

/** True when the new config dials a different place or identity than the saved one. */
export function targetChanged(a: ConnConfig, b: ConnConfig): boolean {
  const eq = (x: unknown, y: unknown) => (x ?? '') === (y ?? '');
  return !(eq(a.host?.toLowerCase(), b.host?.toLowerCase()) && eq(a.port, b.port) && eq(a.uri, b.uri) && eq(!!a.tls, !!b.tls)
    && eq(!!a.tlsInsecure, !!b.tlsInsecure) && eq(a.ca, b.ca) && eq(a.file, b.file) && eq(a.username, b.username));
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

/** Validates user input into a ConnConfig, applying the SQLite directory allow-list. */
export function normalise(i: DsInput, prev?: { config: ConnConfig; kind: Kind }): { kind: Kind; config: ConnConfig } {
  const kind = (i.kind ?? prev?.kind) as Kind;
  const plugin = getPlugin(kind);
  if (!plugin) throw new HttpError(400, 'BAD_REQUEST', `kind must be one of ${KINDS.join(', ')}`);
  const p = prev?.config ?? {};
  const config: ConnConfig = {
    host: i.host !== undefined ? str(i.host, 253) : p.host,
    port: i.port !== undefined && i.port !== '' ? Number(i.port) : i.port === '' ? undefined : p.port,
    database: i.database !== undefined ? str(i.database, 128) : p.database,
    username: i.username !== undefined ? str(i.username, 128) : p.username,
    tls: i.tls ?? p.tls, tlsInsecure: i.tlsInsecure ?? p.tlsInsecure,
    file: i.file !== undefined ? str(i.file, 1024) : p.file,
    password: i.clearPassword ? undefined : i.password !== undefined && i.password !== '' ? String(i.password).slice(0, 512) : p.password,
    uri: i.uri !== undefined ? (str(i.uri, 2048) || undefined) : p.uri,
    token: i.clearToken ? undefined : i.token !== undefined && i.token !== '' ? String(i.token).slice(0, 2048) : p.token,
    ca: i.ca !== undefined ? (str(i.ca, 20000) || undefined) : p.ca,
  };
  // A saved password or token belongs to the saved destination. If the caller points the connection somewhere else
  // (host, port, URI, TLS settings, CA, file or login name; the database name alone does not count, it goes to the
  // same server) and does not type a new secret, drop the saved one so it can never be sent to a machine the caller chose.
  if (prev && targetChanged(p, config)) {
    if (!(i.password !== undefined && i.password !== '')) config.password = undefined;
    if (!(i.token !== undefined && i.token !== '')) config.token = undefined;
  }
  if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) throw new HttpError(400, 'BAD_REQUEST', 'port must be 1-65535');
  if (plugin.connect === 'file') {
    if (!config.file) throw new HttpError(400, 'BAD_REQUEST', 'A database file path is required');
    if (!cfg.sqliteDirs.length) throw new HttpError(400, 'SQLITE_DISABLED', 'SQLite is off: set DATASOURCE_SQLITE_DIRS on the server to the directories it may open');
    const norm = config.file.replace(/\/+/g, '/');
    if (norm.split('/').includes('..') || !cfg.sqliteDirs.some((d) => norm.startsWith(`${d}/`))) throw new HttpError(403, 'PATH_NOT_ALLOWED', `SQLite files must be inside: ${cfg.sqliteDirs.join(', ')}`);
  } else if (plugin.connect === 'uri-or-host') {
    if (!config.uri && !config.host) throw new HttpError(400, 'BAD_REQUEST', 'Enter a host or a connection URI');
    if (config.uri && plugin.uriScheme && !plugin.uriScheme.re.test(config.uri)) throw new HttpError(400, 'BAD_REQUEST', plugin.uriScheme.message);
  } else if (!config.host) throw new HttpError(400, 'BAD_REQUEST', 'Host is required');
  return { kind, config };
}

const split = (c: ConnConfig) => {
  const { password, uri, ca, token, ...rest } = c;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== '')) as DsDoc['config'];
  return { clean, secret: { ...(password ? { password } : {}), ...(uri ? { uri } : {}), ...(ca ? { ca } : {}), ...(token ? { token } : {}) } };
};

export const list = async (): Promise<DsPublic[]> =>
  (getDb().prepare('SELECT * FROM datasources ORDER BY name').all() as any[]).map((r) => toPublic(rowToDoc(r)));

function load(id: string): DsDoc {
  const r = getDb().prepare('SELECT * FROM datasources WHERE id = ?').get(String(id));
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'No such connection');
  return rowToDoc(r);
}

export async function get(id: string) {
  const d = load(id);
  return { doc: d, config: { ...d.config, ...open(d.secret, d._id) } as ConnConfig };
}

export async function create(i: DsInput, user: string): Promise<DsPublic> {
  const name = str(i.name, 60);
  if (!name) throw new HttpError(400, 'BAD_REQUEST', 'Name is required');
  const { kind, config } = normalise(i);
  const _id = randomUUID();
  const { clean, secret } = split(config);
  const now = new Date();
  const doc: DsDoc = { _id, name, kind, readOnly: i.readOnly !== false, color: str(i.color, 16), config: clean, secret: seal(secret, _id), createdAt: now, updatedAt: now, createdBy: user };
  insertDoc(doc);
  return toPublic(doc);
}

const envLocked = (d: DsDoc) =>
  new HttpError(409, 'ENV_MANAGED', `"${d.name}" is defined in the server .env (DS_${d.envId}_*). Change or remove it there and restart the dashboard.`);

export async function update(id: string, i: DsInput): Promise<DsPublic> {
  const { doc, config: cur } = await get(id);
  if (doc.source === 'env') throw envLocked(doc);
  const { kind, config } = normalise({ ...i, kind: doc.kind }, { config: cur, kind: doc.kind });
  const { clean, secret } = split(config);
  const name = i.name !== undefined ? str(i.name, 60) : doc.name;
  if (!name) throw new HttpError(400, 'BAD_REQUEST', 'Name is required');
  const next: DsDoc = { ...doc, name, kind, readOnly: i.readOnly ?? doc.readOnly, color: i.color !== undefined ? str(i.color, 16) : doc.color, config: clean, secret: seal(secret, doc._id), updatedAt: new Date() };
  replaceDoc(next);
  return toPublic(next);
}

export async function remove(id: string): Promise<DsDoc> {
  const d = load(id);
  if (d.source === 'env') throw envLocked(d);
  getDb().prepare('DELETE FROM datasources WHERE id = ?').run(d._id);
  return d;
}

/** Strings that must never appear in an error shown to the browser. */
export const secretsOf = (c: ConnConfig) => [c.password, c.token, c.uri && /\/\/[^:]+:([^@]*)@/.exec(c.uri)?.[1]].filter((x): x is string => !!x && x.length > 2);

export interface EnvSyncResult { added: string[]; updated: string[]; removed: string[]; skipped: { envId: string; reason: string }[] }

/** Makes the store match the DS_<ID>_* connections in .env: adds new ones, refreshes changed ones and drops
 *  env connections that are no longer declared. A saved UI connection with the same name is taken over. */
export async function syncFromEnv(list: EnvDatasource[] = cfg.envDatasources): Promise<EnvSyncResult> {
  const r: EnvSyncResult = { added: [], updated: [], removed: [], skipped: [] };
  const seen = new Set<string>();
  for (const e of list) {
    if (seen.has(e.envId)) continue;
    seen.add(e.envId);
    try {
      const name = str(e.name, 60);
      if (!name) throw new HttpError(400, 'BAD_REQUEST', 'NAME is empty');
      const { kind, config } = normalise({ ...e, kind: e.kind as Kind });
      const { clean, secret } = split(config);
      const envDoc = byEnv(e.envId);
      const nameDoc = byName(name);
      if (nameDoc && envDoc && nameDoc._id !== envDoc._id) throw new HttpError(409, 'DUPLICATE', `name "${name}" is already used by another connection`);
      if (nameDoc && !envDoc && nameDoc.source === 'env') throw new HttpError(409, 'DUPLICATE', `name "${name}" is already used by DS_${nameDoc.envId}_*`);
      const cur = envDoc ?? nameDoc;
      const color = str(e.color, 16);
      if (!cur) {
        const _id = randomUUID(), now = new Date();
        insertDoc({ _id, name, kind, readOnly: e.readOnly, color, config: clean, secret: seal(secret, _id), createdAt: now, updatedAt: now, createdBy: 'env', source: 'env', envId: e.envId });
        r.added.push(name);
        continue;
      }
      let oldSecret: object = {};
      try { oldSecret = open(cur.secret, cur._id); } catch { /* unreadable: rewrite it */ }
      const same = cur.source === 'env' && cur.envId === e.envId && cur.name === name && cur.kind === kind && cur.readOnly === e.readOnly && (cur.color ?? undefined) === color
        && JSON.stringify(cur.config) === JSON.stringify(clean) && JSON.stringify(oldSecret) === JSON.stringify(secret);
      if (same) continue;
      replaceDoc({ ...cur, name, kind, readOnly: e.readOnly, color, config: clean, secret: seal(secret, cur._id), updatedAt: new Date(), source: 'env', envId: e.envId });
      r.updated.push(name);
    } catch (err) {
      r.skipped.push({ envId: e.envId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const gone = (getDb().prepare("SELECT * FROM datasources WHERE source = 'env'").all() as any[]).map(rowToDoc).filter((d) => !seen.has(d.envId ?? ''));
  for (const d of gone) getDb().prepare('DELETE FROM datasources WHERE id = ?').run(d._id);
  r.removed = gone.map((d) => d.name);
  return r;
}
