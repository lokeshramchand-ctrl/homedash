import { chainHash } from './auditchain.js';
import type { ChainFields } from './auditchain.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { currentCluster, multiCluster } from './clusters.js';
import { cfg } from './config.js';

// Embedded SQLite (node:sqlite, built into Node >= 22.13). One file, no service to run.
// All timestamps are epoch milliseconds.

export type Role = 'viewer' | 'operator' | 'admin';
export interface MfaData { secret: string; enabledAt: number; lastStep: number; recovery: string[] }
export interface UserRow {
  id: number; username: string; passwordHash: string; createdAt: number; lastLoginAt: number | null; lastLoginIp: string | null;
  role: Role | null; // null = created before roles existed: treated as admin
  mfa: MfaData | null; mfaSetup: { secret: string; expireAt: number } | null; mfaExempt: boolean;
  teams: string[]; // names from access.teams in homedash.yaml; empty = not scoped (the role applies everywhere)
  groups: string[]; // identity-provider groups last seen (OIDC login or SCIM)
  disabled: boolean; // deprovisioned: cannot sign in, tokens stop working
  scimId: string | null; external: boolean; // created by SCIM / an SSO login (no local password)
}
export type MfaState = 'ok' | 'pending' | 'enroll';
export interface SessionRow {
  id: number; tokenHash: string; userId: number; username: string; role: Role | null; mfa: MfaState; createdAt: number; lastSeenAt: number; expiresAt: number;
}
export interface AuditRow {
  ts: number; user: string; ip: string; vmid: number; /* 0 = the host itself */ name?: string; action: string;
  result: 'accepted' | 'refused' | 'error'; taskId?: string; reason?: string;
}
export interface SampleRow {
  monitorKey: string; name: string; url: string; type: string;
  status: 'up' | 'down' | 'pending' | 'maintenance'; ping: number | null; ts: number;
}
export interface EventRow {
  id: number; ts: number; level: 'info' | 'warn' | 'error'; source: 'app' | 'db' | 'host' | 'guest' | 'monitor' | 'auth'; message: string;
  data: Record<string, unknown> | null;
}
export interface SampleStat { monitorKey: string; up30: number; n30: number; up24: number; n24: number; ping: number | null }

const DAY = 86_400_000;
let d: DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_login_at INTEGER, sso_sub TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, username TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT, ip TEXT, vmid INTEGER NOT NULL, name TEXT,
  action TEXT NOT NULL, result TEXT NOT NULL, task_id TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS audit_vmid_ts ON audit (vmid, ts DESC);
CREATE TABLE IF NOT EXISTS kuma_samples (
  id INTEGER PRIMARY KEY, monitor_key TEXT NOT NULL, name TEXT, url TEXT, type TEXT,
  status TEXT NOT NULL, ping REAL, ts INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_key_ts ON kuma_samples (monitor_key, ts DESC);
CREATE INDEX IF NOT EXISTS samples_expires ON kuma_samples (expires_at);
CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL,
  data TEXT, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON system_events (ts DESC);
CREATE TABLE IF NOT EXISTS system_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scenes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, steps TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, scene_id INTEGER, vmid INTEGER, action TEXT,
  days TEXT NOT NULL, time TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run INTEGER, last_result TEXT
);
CREATE TABLE IF NOT EXISTS datasources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 1, color TEXT,
  config TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  source TEXT, env_id TEXT
);
CREATE TABLE IF NOT EXISTS datasource_audit (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT, ip TEXT, ds TEXT, ds_name TEXT, action TEXT NOT NULL, detail TEXT,
  result TEXT NOT NULL, ms INTEGER, rows INTEGER, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ds_audit_ts ON datasource_audit (ts DESC);
CREATE TABLE IF NOT EXISTS gpu_samples (minute INTEGER PRIMARY KEY, util REAL NOT NULL, busy INTEGER NOT NULL, top TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, last_ip TEXT, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens (user_id);
CREATE TABLE IF NOT EXISTS passkeys (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
  transports TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id);
CREATE TABLE IF NOT EXISTS webauthn_challenges (id TEXT PRIMARY KEY, user_id INTEGER, challenge TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, summary TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT, fingerprint TEXT NOT NULL,
  requested_by TEXT NOT NULL, requested_by_id INTEGER NOT NULL, ip TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, note TEXT, consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at DESC);
CREATE TABLE IF NOT EXISTS scim_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, external_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scim_members (group_id TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (group_id, user_id));
CREATE TABLE IF NOT EXISTS ui_tiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT
);
CREATE TABLE IF NOT EXISTS silences (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, reason TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, categories TEXT, contains TEXT,
  days TEXT, tod_start TEXT, tod_minutes INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_routes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, categories TEXT, min_level TEXT NOT NULL, contains TEXT,
  channels TEXT NOT NULL, days TEXT, tod_start TEXT, tod_minutes INTEGER, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oidc_states (id TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL);
`;

export function connectDb(): void {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  d = new DatabaseSync(cfg.dbPath);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  d.exec(SCHEMA);
  migrate();
  purgeExpired();
  setInterval(() => { purgeExpired(); purgeSilences(); purgeApprovals(); }, 3_600_000).unref();
}

/** The raw SQLite handle, for modules that own their own tables (the data manager). */
export const getDb = (): DatabaseSync => d;

/** Adds columns introduced after the first release to databases created by an older version. */
function migrate() {
  const have = (table: string) => new Set((d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const add = (table: string, col: string, def: string) => { if (!have(table).has(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  add('users', 'role', 'TEXT');
  add('users', 'last_login_ip', 'TEXT');
  add('users', 'mfa', 'TEXT');
  add('users', 'mfa_setup', 'TEXT');
  add('users', 'mfa_exempt', 'INTEGER NOT NULL DEFAULT 0');
  add('scenes', 'cluster', 'TEXT');
  add('schedules', 'cluster', 'TEXT');
  add('audit', 'cluster', 'TEXT');
  for (const t of ['scenes', 'schedules', 'silences', 'alert_routes']) add(t, 'managed', 'TEXT'); // 'config' = declared in homedash.yaml
  add('audit', 'prev_hash', 'TEXT');
  add('audit', 'hash', 'TEXT');
  add('users', 'teams', 'TEXT');
  add('users', 'groups', 'TEXT');
  add('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'scim_id', 'TEXT');
  add('sessions', 'role', 'TEXT');
  add('sessions', 'mfa', 'TEXT');
  add('sessions', 'last_seen_at', 'INTEGER');
}

export const closeDb = () => { try { d?.close(); } catch { /* already closed */ } };

/** Replaces the TTL indexes a document database would use. */
function purgeExpired() {
  const now = Date.now();
  for (const t of ['sessions', 'login_attempts', 'kuma_samples', 'system_events', 'oidc_states', 'datasource_audit', 'gpu_samples', 'webauthn_challenges']) {
    d.prepare(`DELETE FROM ${t} WHERE expires_at < ?`).run(now);
  }
}

/** Whether the database answers; used by /metrics and the health check. */
export function dbOk(): boolean {
  try { d.prepare('SELECT 1').get(); return true; } catch { return false; }
}

const json = <T>(v: unknown): T | null => { try { return v ? (JSON.parse(String(v)) as T) : null; } catch { return null; } };
const userOf = (r: any): UserRow | null => r ? ({
  id: r.id, username: r.username, passwordHash: r.password_hash, createdAt: r.created_at, lastLoginAt: r.last_login_at, lastLoginIp: r.last_login_ip ?? null,
  role: (['viewer', 'operator', 'admin'] as const).find((x) => x === r.role) ?? null,
  mfa: json<MfaData>(r.mfa), mfaSetup: json<{ secret: string; expireAt: number }>(r.mfa_setup), mfaExempt: !!r.mfa_exempt,
  teams: json<string[]>(r.teams) ?? [], groups: json<string[]>(r.groups) ?? [], disabled: !!r.disabled, scimId: r.scim_id ?? null,
  external: !!r.sso_sub || !!r.scim_id,
}) : null;

// ---- users -------------------------------------------------------------------------------------
export const findUser = (username: string) =>
  userOf(d.prepare('SELECT * FROM users WHERE username = ?').get(username));
export const findUserById = (id: number) => userOf(d.prepare('SELECT * FROM users WHERE id = ?').get(id));

/** Creates the user or resets the password (ending its sessions). The role is only changed when one is given. */
export function upsertPasswordUser(username: string, passwordHash: string, opts: { role?: Role; mfaExempt?: boolean } = {}): 'created' | 'updated' {
  const existing = d.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
  if (!existing) {
    d.prepare('INSERT INTO users (username, password_hash, created_at, role, mfa_exempt) VALUES (?, ?, ?, ?, ?)')
      .run(username, passwordHash, Date.now(), opts.role ?? 'viewer', opts.mfaExempt ? 1 : 0);
    return 'created';
  }
  d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, existing.id);
  if (opts.role) d.prepare('UPDATE users SET role = ? WHERE id = ?').run(opts.role, existing.id);
  if (opts.mfaExempt) d.prepare('UPDATE users SET mfa_exempt = 1 WHERE id = ?').run(existing.id);
  d.prepare('DELETE FROM sessions WHERE username = ?').run(username);
  return 'updated';
}

export const touchLogin = (id: number, ip: string | null = null) => {
  d.prepare('UPDATE users SET last_login_at = ?, last_login_ip = COALESCE(?, last_login_ip) WHERE id = ?').run(Date.now(), ip, id);
};

/**
 * SSO users are keyed by issuer|sub; the display username, role, teams and groups can change between logins.
 * A user pre-provisioned by SCIM (same username, no sub yet) is adopted instead of duplicated.
 */
export function upsertSsoUser(ssoSub: string, username: string, role: Role = 'admin', extra: { teams?: string[]; groups?: string[] } = {}): UserRow {
  const now = Date.now();
  const adopt = d.prepare('UPDATE users SET sso_sub = ? WHERE username = ? AND sso_sub IS NULL AND scim_id IS NOT NULL').run(ssoSub, username);
  if (!adopt.changes) {
    d.prepare(`INSERT INTO users (username, password_hash, created_at, last_login_at, sso_sub, role, teams, groups) VALUES (?, '', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (sso_sub) DO UPDATE SET username = excluded.username, last_login_at = excluded.last_login_at`)
      .run(username, now, now, ssoSub, role, JSON.stringify(extra.teams ?? []), JSON.stringify(extra.groups ?? []));
  }
  // The identity provider is the source of truth for role, teams and groups on every sign-in.
  d.prepare('UPDATE users SET role = ?, teams = ?, groups = ?, last_login_at = ? WHERE sso_sub = ?')
    .run(role, JSON.stringify(extra.teams ?? []), JSON.stringify(extra.groups ?? []), now, ssoSub);
  return userOf(d.prepare('SELECT * FROM users WHERE sso_sub = ?').get(ssoSub))!;
}

/** Lockout escape hatch: removes two-step sign-in and ends every session. Returns false for an unknown user. */
export function resetUserMfa(username: string): { found: boolean; hadMfa: boolean; sessions: number } {
  const u = findUser(username);
  if (!u) return { found: false, hadMfa: false, sessions: 0 };
  d.prepare('UPDATE users SET mfa = NULL, mfa_setup = NULL WHERE id = ?').run(u.id);
  const r = d.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return { found: true, hadMfa: !!u.mfa, sessions: Number(r.changes) };
}

export const setMfaSetup = (id: number, v: { secret: string; expireAt: number } | null) => {
  d.prepare('UPDATE users SET mfa_setup = ? WHERE id = ?').run(v ? JSON.stringify(v) : null, id);
};
export const enableMfa = (id: number, m: MfaData) => {
  d.prepare('UPDATE users SET mfa = ?, mfa_setup = NULL WHERE id = ?').run(JSON.stringify(m), id);
};
export const disableMfa = (id: number) => { d.prepare('UPDATE users SET mfa = NULL, mfa_setup = NULL WHERE id = ?').run(id); };

/** Spends a TOTP step: succeeds only if it is newer than the last one used (a code works once). */
export function spendTotpStep(id: number, step: number): boolean {
  const u = findUserById(id);
  if (!u?.mfa || !(u.mfa.lastStep < step)) return false;
  d.prepare('UPDATE users SET mfa = ? WHERE id = ?').run(JSON.stringify({ ...u.mfa, lastStep: step }), id);
  return true;
}
/** Removes one recovery code hash; succeeds only if it was present. */
export function spendRecovery(id: number, hash: string): boolean {
  const u = findUserById(id);
  if (!u?.mfa || !u.mfa.recovery.includes(hash)) return false;
  d.prepare('UPDATE users SET mfa = ? WHERE id = ?').run(JSON.stringify({ ...u.mfa, recovery: u.mfa.recovery.filter((h) => h !== hash) }), id);
  return true;
}
export function replaceRecovery(id: number, hashes: string[]) {
  const u = findUserById(id);
  if (u?.mfa) d.prepare('UPDATE users SET mfa = ? WHERE id = ?').run(JSON.stringify({ ...u.mfa, recovery: hashes }), id);
}

// ---- sessions ----------------------------------------------------------------------------------
export function insertSession(s: { tokenHash: string; userId: number; username: string; role: Role; mfa: MfaState; expiresAt: number; ip: string; userAgent: string }) {
  const now = Date.now();
  d.prepare('INSERT INTO sessions (token_hash, user_id, username, created_at, expires_at, ip, user_agent, role, mfa, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.tokenHash, s.userId, s.username, now, s.expiresAt, s.ip, s.userAgent, s.role, s.mfa, now);
}

export function findSession(tokenHash: string): SessionRow | null {
  const r = d.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now()) as any;
  return r ? {
    id: r.id, tokenHash: r.token_hash, userId: r.user_id, username: r.username,
    role: (['viewer', 'operator', 'admin'] as const).find((x) => x === r.role) ?? null,
    mfa: (['pending', 'enroll'] as const).find((x) => x === r.mfa) ?? 'ok',
    createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? r.created_at, expiresAt: r.expires_at,
  } : null;
}

export const touchSession = (id: number) => { d.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), id); };
export const setSessionMfa = (id: number, mfa: MfaState) => { d.prepare('UPDATE sessions SET mfa = ? WHERE id = ?').run(mfa === 'ok' ? null : mfa, id); };
export const deleteSession = (tokenHash: string) => { d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); };
export const deleteSessionById = (id: number) => { d.prepare('DELETE FROM sessions WHERE id = ?').run(id); };
/** Ends every session of a user, optionally keeping one. Returns how many were removed. */
export function deleteUserSessions(userId: number, exceptId?: number): number {
  return Number(d.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId ?? -1).changes);
}

// ---- login rate limit --------------------------------------------------------------------------
export function attemptCount(key: string): number {
  const r = d.prepare('SELECT count FROM login_attempts WHERE key = ? AND expires_at > ?').get(key, Date.now()) as { count: number } | undefined;
  return r?.count ?? 0;
}

export function bumpAttempts(key: string, windowMs: number) {
  const now = Date.now();
  d.prepare(`INSERT INTO login_attempts (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN expires_at > ? THEN count + 1 ELSE 1 END,
      expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE excluded.expires_at END`).run(key, now + windowMs, now, now);
}

export const clearAttempts = (key: string) => { d.prepare('DELETE FROM login_attempts WHERE key = ?').run(key); };

// ---- audit log ---------------------------------------------------------------------------------
/** Called after every audit row (SIEM sinks); set by auditlog.ts. */
let auditSink: ((row: ChainFields & { id: number; prev_hash: string; hash: string }) => void) | null = null;
export const setAuditSink = (fn: typeof auditSink) => { auditSink = fn; };

export function insertAudit(a: AuditRow) {
  const f: ChainFields = {
    ts: a.ts, user: a.user, ip: a.ip, vmid: a.vmid, name: a.name ?? null, action: a.action, result: a.result,
    task_id: a.taskId ?? null, reason: a.reason ?? null, cluster: multiCluster() ? currentCluster().id : null,
  };
  // Synchronous SQLite in one process: nothing can slip in between reading the head and writing the row.
  const prev = (d.prepare('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? '';
  const hash = chainHash(prev, f);
  const r = d.prepare('INSERT INTO audit (ts, user, ip, vmid, name, action, result, task_id, reason, cluster, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(f.ts, f.user, f.ip, f.vmid, f.name, f.action, f.result, f.task_id, f.reason, f.cluster, prev, hash);
  try { auditSink?.({ ...f, id: Number(r.lastInsertRowid), prev_hash: prev, hash }); } catch { /* a broken sink must not break the action */ }
}

/** Audit rows in id order, optionally from an id on (for verification and export). */
export function auditRows(afterId = 0, limit = 1_000_000): (ChainFields & { id: number; prev_hash: string | null; hash: string | null })[] {
  return d.prepare('SELECT id, ts, user, ip, vmid, name, action, result, task_id, reason, cluster, prev_hash, hash FROM audit WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as never;
}

export const hasRecentAccepted = (vmid: number, sinceMs: number): boolean =>
  !!d.prepare("SELECT 1 FROM audit WHERE vmid = ? AND result = 'accepted' AND ts > ? LIMIT 1").get(vmid, sinceMs);

// ---- Uptime Kuma history -----------------------------------------------------------------------
export function insertSamples(rows: SampleRow[]) {
  const st = d.prepare('INSERT INTO kuma_samples (monitor_key, name, url, type, status, ping, ts, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  d.exec('BEGIN');
  try {
    for (const r of rows) st.run(r.monitorKey, r.name, r.url, r.type, r.status, r.ping, r.ts, r.ts + 31 * DAY);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function sampleStats(now: number): SampleStat[] {
  const s30 = now - 30 * DAY, s24 = now - DAY;
  return (d.prepare(`SELECT monitor_key AS monitorKey,
      SUM(ts >= ?1 AND status = 'up') AS up30, SUM(ts >= ?1 AND status != 'maintenance') AS n30,
      SUM(ts >= ?2 AND status = 'up') AS up24, SUM(ts >= ?2 AND status != 'maintenance') AS n24,
      AVG(CASE WHEN ts >= ?2 THEN ping END) AS ping
    FROM kuma_samples WHERE ts >= ?1 GROUP BY monitor_key`).all(s30, s24) as unknown as SampleStat[]);
}

export function recentSamples(monitorKey: string, limit: number): { ts: number; status: SampleRow['status']; ping: number | null }[] {
  return d.prepare('SELECT ts, status, ping FROM kuma_samples WHERE monitor_key = ? ORDER BY ts DESC LIMIT ?').all(monitorKey, limit) as any;
}

export const lastSampleTs = (monitorKey: string, status: string): number | null =>
  ((d.prepare('SELECT MAX(ts) AS ts FROM kuma_samples WHERE monitor_key = ? AND status = ?').get(monitorKey, status) as any)?.ts) ?? null;

export const firstSampleAfter = (monitorKey: string, afterTs: number | null): number | null =>
  ((d.prepare('SELECT MIN(ts) AS ts FROM kuma_samples WHERE monitor_key = ? AND ts > ?').get(monitorKey, afterTs ?? 0) as any)?.ts) ?? null;

// ---- system events -----------------------------------------------------------------------------
export function insertEvent(e: Omit<EventRow, 'id'>, retentionDays: number) {
  d.prepare('INSERT INTO system_events (ts, level, source, message, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(e.ts, e.level, e.source, e.message, e.data ? JSON.stringify(e.data) : null, e.ts + retentionDays * DAY);
}

export function listEvents(f: { level?: string; source?: string; before?: number; q?: string; limit: number }): EventRow[] {
  const where: string[] = []; const args: (string | number)[] = [];
  if (f.level) { where.push('level = ?'); args.push(f.level); }
  if (f.source) { where.push('source = ?'); args.push(f.source); }
  if (f.before) { where.push('ts < ?'); args.push(f.before); }
  if (f.q) { where.push("message LIKE ? ESCAPE '\\'"); args.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`); }
  const sql = `SELECT * FROM system_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
  return (d.prepare(sql).all(...args, f.limit) as any[]).map((r) => ({
    id: r.id, ts: r.ts, level: r.level, source: r.source, message: r.message, data: r.data ? JSON.parse(r.data) : null,
  }));
}

export const countEvents = (level: string, sinceMs: number): number =>
  ((d.prepare('SELECT COUNT(*) AS n FROM system_events WHERE level = ? AND ts > ?').get(level, sinceMs) as any).n as number);

// ---- key/value state ---------------------------------------------------------------------------
export const getState = (id: string): Record<string, unknown> | undefined => {
  const r = d.prepare('SELECT value FROM system_state WHERE id = ?').get(id) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : undefined;
};

export const setState = (id: string, value: Record<string, unknown>) => {
  d.prepare('INSERT INTO system_state (id, value) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value').run(id, JSON.stringify(value));
};

// ---- OIDC login state --------------------------------------------------------------------------
export const saveOidc = (id: string, verifier: string, nonce: string, ttlMs: number) => {
  d.prepare('INSERT INTO oidc_states (id, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)').run(id, verifier, nonce, Date.now() + ttlMs);
};

/** Single use: returns the saved state and deletes it. */
export function takeOidc(id: string): { verifier: string; nonce: string } | null {
  const r = d.prepare('SELECT verifier, nonce FROM oidc_states WHERE id = ? AND expires_at > ?').get(id, Date.now()) as any;
  d.prepare('DELETE FROM oidc_states WHERE id = ?').run(id);
  return r ?? null;
}

// ---- scenes and schedules ----------------------------------------------------------------------
export interface SceneStep { vmid: number; action: 'start' | 'shutdown' | 'stop' | 'reboot'; waitSeconds: number; continueOnError: boolean }
/** cluster null = the first cluster (rows from before several clusters were supported). */
export interface SceneRow { id: number; name: string; steps: SceneStep[]; cluster: string | null }
export interface ScheduleRow {
  id: number; name: string; sceneId: number | null; vmid: number | null; action: string | null;
  days: number[]; time: string; enabled: boolean; lastRun: number | null; lastResult: string | null; cluster: string | null;
}

const sceneOf = (r: any): SceneRow => ({ id: r.id, name: r.name, steps: JSON.parse(r.steps), cluster: r.cluster ?? null });
export const listScenes = (): SceneRow[] => (d.prepare('SELECT * FROM scenes ORDER BY name').all() as any[]).map(sceneOf);
export const getScene = (id: number): SceneRow | null => { const r = d.prepare('SELECT * FROM scenes WHERE id = ?').get(id); return r ? sceneOf(r) : null; };
export const saveScene = (id: number | null, name: string, steps: SceneStep[], cluster: string | null = null): number => {
  if (id === null) return Number(d.prepare('INSERT INTO scenes (name, steps, created_at, cluster) VALUES (?, ?, ?, ?)').run(name, JSON.stringify(steps), Date.now(), cluster).lastInsertRowid);
  d.prepare('UPDATE scenes SET name = ?, steps = ? WHERE id = ?').run(name, JSON.stringify(steps), id);
  return id;
};
export const deleteScene = (id: number) => {
  d.prepare('DELETE FROM schedules WHERE scene_id = ?').run(id);
  d.prepare('DELETE FROM scenes WHERE id = ?').run(id);
};

const schedOf = (r: any): ScheduleRow => ({
  id: r.id, name: r.name, sceneId: r.scene_id, vmid: r.vmid, action: r.action, days: String(r.days).split(',').filter(Boolean).map(Number),
  time: r.time, enabled: !!r.enabled, lastRun: r.last_run, lastResult: r.last_result, cluster: r.cluster ?? null,
});
export const listSchedules = (): ScheduleRow[] => (d.prepare('SELECT * FROM schedules ORDER BY time, name').all() as any[]).map(schedOf);
export const saveSchedule = (id: number | null, s: Omit<ScheduleRow, 'id' | 'lastRun' | 'lastResult' | 'cluster'> & { cluster?: string | null }): number => {
  const args = [s.name, s.sceneId, s.vmid, s.action, s.days.join(','), s.time, s.enabled ? 1 : 0] as const;
  if (id === null) return Number(d.prepare('INSERT INTO schedules (name, scene_id, vmid, action, days, time, enabled, cluster) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...args, s.cluster ?? null).lastInsertRowid);
  d.prepare('UPDATE schedules SET name = ?, scene_id = ?, vmid = ?, action = ?, days = ?, time = ?, enabled = ? WHERE id = ?').run(...args, id);
  return id;
};
export const deleteSchedule = (id: number) => { d.prepare('DELETE FROM schedules WHERE id = ?').run(id); };
export const markScheduleRun = (id: number, result: string) => { d.prepare('UPDATE schedules SET last_run = ?, last_result = ? WHERE id = ?').run(Date.now(), result.slice(0, 300), id); };

// ---- GPU samples (one row per minute, peak utilisation) ----------------------------------------
export const upsertGpuSample = (minute: number, util: number, busy: number, top: string, expiresAt: number) => {
  d.prepare(`INSERT INTO gpu_samples (minute, util, busy, top, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (minute) DO UPDATE SET util = MAX(util, excluded.util), busy = MAX(busy, excluded.busy), top = excluded.top, expires_at = excluded.expires_at`)
    .run(minute, util, busy, top, expiresAt);
};
export const listGpuSamples = (fromMinute: number, limit: number): { minute: number; util: number; busy: number }[] =>
  d.prepare('SELECT minute, util, busy FROM gpu_samples WHERE minute >= ? ORDER BY minute LIMIT ?').all(fromMinute, limit) as any;

// ---- administration of users ----------------------------------------------------------------------
export const listUsers = (): UserRow[] => (d.prepare('SELECT * FROM users ORDER BY username').all() as any[]).map((r) => userOf(r)!);
export function setUserAccess(id: number, p: { role?: Role; teams?: string[]; disabled?: boolean }) {
  if (p.role) d.prepare('UPDATE users SET role = ? WHERE id = ?').run(p.role, id);
  if (p.teams) d.prepare('UPDATE users SET teams = ? WHERE id = ?').run(JSON.stringify(p.teams), id);
  if (p.disabled !== undefined) {
    d.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(p.disabled ? 1 : 0, id);
    if (p.disabled) { deleteUserSessions(id); d.prepare('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), id); }
  }
}
export const countAdmins = (): number => (d.prepare("SELECT COUNT(*) AS n FROM users WHERE (role = 'admin' OR role IS NULL) AND disabled = 0").get() as any).n;
export const listSessions = (userId?: number): { id: number; userId: number; username: string; createdAt: number; lastSeenAt: number; expiresAt: number; ip: string | null; userAgent: string | null; mfa: string | null }[] =>
  (d.prepare(`SELECT * FROM sessions WHERE expires_at > ? ${userId ? 'AND user_id = ?' : ''} ORDER BY COALESCE(last_seen_at, created_at) DESC`).all(...(userId ? [Date.now(), userId] : [Date.now()])) as any[]).map((r) => ({
    id: r.id, userId: r.user_id, username: r.username, createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? r.created_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent, mfa: r.mfa,
  }));

// ---- SCIM provisioning -------------------------------------------------------------------------------
export function scimUpsertUser(p: { scimId?: string; username: string; active: boolean; role: Role; teams: string[]; groups: string[] }): UserRow {
  const existing = d.prepare('SELECT * FROM users WHERE scim_id = ? OR username = ?').get(p.scimId ?? '', p.username) as any;
  if (existing) {
    d.prepare('UPDATE users SET scim_id = COALESCE(scim_id, ?), disabled = ?, role = ?, teams = ?, groups = ? WHERE id = ?')
      .run(p.scimId ?? null, p.active ? 0 : 1, p.role, JSON.stringify(p.teams), JSON.stringify(p.groups), existing.id);
    if (!p.active) setUserAccess(existing.id, { disabled: true });
    return userOf(d.prepare('SELECT * FROM users WHERE id = ?').get(existing.id))!;
  }
  d.prepare("INSERT INTO users (username, password_hash, created_at, role, teams, groups, scim_id, disabled) VALUES (?, '', ?, ?, ?, ?, ?, ?)")
    .run(p.username, Date.now(), p.role, JSON.stringify(p.teams), JSON.stringify(p.groups), p.scimId ?? null, p.active ? 0 : 1);
  return userOf(d.prepare('SELECT * FROM users WHERE username = ?').get(p.username))!;
}
export const findUserByScimId = (id: string): UserRow | null => userOf(d.prepare('SELECT * FROM users WHERE scim_id = ?').get(id));
export function deleteScimUser(id: number) {
  setUserAccess(id, { disabled: true });
  d.prepare('DELETE FROM scim_members WHERE user_id = ?').run(id);
}
export interface ScimGroupRow { id: string; name: string; externalId: string | null; members: number[] }
const groupOf = (r: any): ScimGroupRow => ({
  id: r.id, name: r.name, externalId: r.external_id ?? null,
  members: (d.prepare('SELECT user_id FROM scim_members WHERE group_id = ?').all(r.id) as any[]).map((m) => m.user_id),
});
export const listScimGroups = (): ScimGroupRow[] => (d.prepare('SELECT * FROM scim_groups ORDER BY name').all() as any[]).map(groupOf);
export const getScimGroup = (id: string): ScimGroupRow | null => { const r = d.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id); return r ? groupOf(r) : null; };
export const saveScimGroup = (g: { id: string; name: string; externalId?: string | null }) => {
  d.prepare('INSERT INTO scim_groups (id, name, external_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, external_id = excluded.external_id')
    .run(g.id, g.name, g.externalId ?? null, Date.now());
};
export const setScimMembers = (groupId: string, userIds: number[]) => {
  d.prepare('DELETE FROM scim_members WHERE group_id = ?').run(groupId);
  for (const u of new Set(userIds)) d.prepare('INSERT OR IGNORE INTO scim_members (group_id, user_id) VALUES (?, ?)').run(groupId, u);
};
export const deleteScimGroup = (id: string) => { d.prepare('DELETE FROM scim_members WHERE group_id = ?').run(id); d.prepare('DELETE FROM scim_groups WHERE id = ?').run(id); };
/** Names of the SCIM groups a user belongs to. */
export const scimGroupsOf = (userId: number): string[] =>
  (d.prepare('SELECT g.name FROM scim_groups g JOIN scim_members m ON m.group_id = g.id WHERE m.user_id = ?').all(userId) as any[]).map((r) => r.name);

// ---- API tokens ---------------------------------------------------------------------------------------
export interface TokenRow { id: number; userId: number; username: string; name: string; prefix: string; role: Role; createdAt: number; expiresAt: number; lastUsedAt: number | null; lastIp: string | null; revokedAt: number | null }
const tokenOf = (r: any): TokenRow => ({
  id: r.id, userId: r.user_id, username: r.username ?? '', name: r.name, prefix: r.prefix, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at, lastIp: r.last_ip, revokedAt: r.revoked_at,
});
export function insertToken(t: { userId: number; name: string; prefix: string; hash: string; role: Role; expiresAt: number }): number {
  return Number(d.prepare('INSERT INTO api_tokens (user_id, name, prefix, token_hash, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t.userId, t.name, t.prefix, t.hash, t.role, Date.now(), t.expiresAt).lastInsertRowid);
}
/** A token that is neither revoked nor expired, with its owner. */
export function findToken(hash: string): (TokenRow & { user: UserRow }) | null {
  const r = d.prepare('SELECT t.*, u.username AS username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?').get(hash, Date.now()) as any;
  if (!r) return null;
  const user = findUserById(r.user_id);
  return user ? { ...tokenOf(r), user } : null;
}
export const touchToken = (id: number, ip: string) => { d.prepare('UPDATE api_tokens SET last_used_at = ?, last_ip = ? WHERE id = ?').run(Date.now(), ip, id); };
export const listTokens = (userId?: number): TokenRow[] =>
  (d.prepare(`SELECT t.*, u.username AS username FROM api_tokens t JOIN users u ON u.id = t.user_id ${userId ? 'WHERE t.user_id = ?' : ''} ORDER BY t.created_at DESC`).all(...(userId ? [userId] : [])) as any[]).map(tokenOf);
export function revokeToken(id: number, userId?: number): boolean {
  return Number(d.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL ${userId ? 'AND user_id = ?' : ''}`).run(...(userId ? [Date.now(), id, userId] : [Date.now(), id])).changes) > 0;
}

// ---- passkeys -----------------------------------------------------------------------------------------
export interface PasskeyRow { id: number; userId: number; credentialId: string; publicKey: string; counter: number; transports: string[]; name: string; createdAt: number; lastUsedAt: number | null }
const passkeyOf = (r: any): PasskeyRow => ({
  id: r.id, userId: r.user_id, credentialId: r.credential_id, publicKey: r.public_key, counter: r.counter, transports: json<string[]>(r.transports) ?? [],
  name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});
export const addPasskey = (p: { userId: number; credentialId: string; publicKey: string; counter: number; transports: string[]; name: string }) => {
  d.prepare('INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.userId, p.credentialId, p.publicKey, p.counter, JSON.stringify(p.transports), p.name, Date.now());
};
export const listPasskeys = (userId: number): PasskeyRow[] => (d.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as any[]).map(passkeyOf);
export const findPasskey = (credentialId: string): PasskeyRow | null => { const r = d.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId); return r ? passkeyOf(r) : null; };
export const bumpPasskey = (id: number, counter: number) => { d.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, Date.now(), id); };
export const deletePasskey = (id: number, userId: number): boolean => Number(d.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
export const saveChallenge = (id: string, userId: number | null, challenge: string, kind: 'register' | 'login', ttlMs: number) => {
  d.prepare('INSERT INTO webauthn_challenges (id, user_id, challenge, kind, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, challenge, kind, Date.now() + ttlMs);
};
/** Single use: returns the stored challenge and deletes it. */
export function takeChallenge(id: string, kind: 'register' | 'login'): { userId: number | null; challenge: string } | null {
  const r = d.prepare('SELECT user_id, challenge FROM webauthn_challenges WHERE id = ? AND kind = ? AND expires_at > ?').get(id, kind, Date.now()) as any;
  d.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
  return r ? { userId: r.user_id, challenge: r.challenge } : null;
}

// ---- approvals (four-eyes) ------------------------------------------------------------------------------
export interface ApprovalRow {
  id: string; action: string; summary: string; method: string; path: string; body: string | null; fingerprint: string; requestedBy: string; requestedById: number;
  ip: string | null; createdAt: number; expiresAt: number; status: 'pending' | 'approved' | 'rejected' | 'used'; decidedBy: string | null; decidedAt: number | null; note: string | null;
}
const approvalOf = (r: any): ApprovalRow => ({
  id: r.id, action: r.action, summary: r.summary, method: r.method, path: r.path, body: r.body, fingerprint: r.fingerprint, requestedBy: r.requested_by, requestedById: r.requested_by_id,
  ip: r.ip, createdAt: r.created_at, expiresAt: r.expires_at, decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note,
  status: r.consumed_at ? 'used' : r.status,
});
export function createApproval(a: Omit<ApprovalRow, 'status' | 'decidedBy' | 'decidedAt' | 'note' | 'createdAt'>): void {
  d.prepare(`INSERT INTO approvals (id, action, summary, method, path, body, fingerprint, requested_by, requested_by_id, ip, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(a.id, a.action, a.summary, a.method, a.path, a.body, a.fingerprint, a.requestedBy, a.requestedById, a.ip, Date.now(), a.expiresAt);
}
export const getApproval = (id: string): ApprovalRow | null => { const r = d.prepare('SELECT * FROM approvals WHERE id = ?').get(id); return r ? approvalOf(r) : null; };
export const listApprovals = (limit = 100): ApprovalRow[] => (d.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(approvalOf);
export const findOpenApproval = (fingerprint: string, userId: number): ApprovalRow | null => {
  const r = d.prepare("SELECT * FROM approvals WHERE fingerprint = ? AND requested_by_id = ? AND status IN ('pending','approved') AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(fingerprint, userId, Date.now());
  return r ? approvalOf(r) : null;
};
/** Approve or reject a pending, unexpired request. Returns false if it was no longer pending. */
export function decideApproval(id: string, status: 'approved' | 'rejected', by: string, note: string | null): boolean {
  return Number(d.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending' AND expires_at > ?").run(status, by, Date.now(), note, id, Date.now()).changes) > 0;
}
/** Atomically spends an approved request: exactly one caller can win. */
export function consumeApproval(id: string): boolean {
  return Number(d.prepare("UPDATE approvals SET consumed_at = ? WHERE id = ? AND status = 'approved' AND consumed_at IS NULL AND expires_at > ?").run(Date.now(), id, Date.now()).changes) > 0;
}
export const purgeApprovals = () => { d.prepare('DELETE FROM approvals WHERE created_at < ?').run(Date.now() - 90 * 86_400_000); };

// ---- alert silences (maintenance windows) and routing rules ---------------------------------------------
export interface WeeklyWindow { days: number[]; start: string; minutes: number } // days 0=Sunday, start "HH:MM" server time
export interface SilenceRow { id: number; name: string; reason: string; startsAt: number; endsAt: number; categories: string[]; contains: string; weekly: WeeklyWindow | null; createdBy: string; createdAt: number }
const weeklyOf = (days: unknown, start: unknown, minutes: unknown): WeeklyWindow | null =>
  days && start ? { days: String(days).split(',').filter(Boolean).map(Number), start: String(start), minutes: Number(minutes ?? 60) } : null;
const silenceOf = (r: any): SilenceRow => ({
  id: r.id, name: r.name, reason: r.reason ?? '', startsAt: r.starts_at, endsAt: r.ends_at, categories: json<string[]>(r.categories) ?? [], contains: r.contains ?? '',
  weekly: weeklyOf(r.days, r.tod_start, r.tod_minutes), createdBy: r.created_by, createdAt: r.created_at,
});
export const listSilences = (): SilenceRow[] => (d.prepare('SELECT * FROM silences ORDER BY ends_at DESC').all() as any[]).map(silenceOf);
export function saveSilence(id: number | null, s: Omit<SilenceRow, 'id' | 'createdAt'>): number {
  const a = [s.name, s.reason, s.startsAt, s.endsAt, JSON.stringify(s.categories), s.contains || null, s.weekly ? s.weekly.days.join(',') : null, s.weekly?.start ?? null, s.weekly?.minutes ?? null] as const;
  if (id === null) return Number(d.prepare('INSERT INTO silences (name, reason, starts_at, ends_at, categories, contains, days, tod_start, tod_minutes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...a, s.createdBy, Date.now()).lastInsertRowid);
  d.prepare('UPDATE silences SET name = ?, reason = ?, starts_at = ?, ends_at = ?, categories = ?, contains = ?, days = ?, tod_start = ?, tod_minutes = ? WHERE id = ?').run(...a, id);
  return id;
}
export const deleteSilence = (id: number): boolean => Number(d.prepare('DELETE FROM silences WHERE id = ?').run(id).changes) > 0;
export const purgeSilences = () => { d.prepare('DELETE FROM silences WHERE ends_at < ? AND days IS NULL').run(Date.now() - 7 * 86_400_000); };

export interface RouteRow { id: number; name: string; enabled: boolean; categories: string[]; minLevel: 'info' | 'warn' | 'error'; contains: string; channels: string[]; weekly: WeeklyWindow | null; position: number }
const routeOf = (r: any): RouteRow => ({
  id: r.id, name: r.name, enabled: !!r.enabled, categories: json<string[]>(r.categories) ?? [], minLevel: r.min_level, contains: r.contains ?? '',
  channels: json<string[]>(r.channels) ?? [], weekly: weeklyOf(r.days, r.tod_start, r.tod_minutes), position: r.position,
});
export const listRoutes = (): RouteRow[] => (d.prepare('SELECT * FROM alert_routes ORDER BY position, id').all() as any[]).map(routeOf);
export function saveRoute(id: number | null, r: Omit<RouteRow, 'id' | 'position'>): number {
  const a = [r.name, r.enabled ? 1 : 0, JSON.stringify(r.categories), r.minLevel, r.contains || null, JSON.stringify(r.channels), r.weekly ? r.weekly.days.join(',') : null, r.weekly?.start ?? null, r.weekly?.minutes ?? null] as const;
  if (id === null) {
    const pos = ((d.prepare('SELECT MAX(position) AS p FROM alert_routes').get() as any)?.p ?? 0) + 1;
    return Number(d.prepare('INSERT INTO alert_routes (name, enabled, categories, min_level, contains, channels, days, tod_start, tod_minutes, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...a, pos).lastInsertRowid);
  }
  d.prepare('UPDATE alert_routes SET name = ?, enabled = ?, categories = ?, min_level = ?, contains = ?, channels = ?, days = ?, tod_start = ?, tod_minutes = ? WHERE id = ?').run(...a, id);
  return id;
}
export const deleteRoute = (id: number): boolean => Number(d.prepare('DELETE FROM alert_routes WHERE id = ?').run(id).changes) > 0;

// ---- config as code (policy.ts): rows declared in homedash.yaml are marked managed = 'config' ------------------
export type ManagedTable = 'scenes' | 'schedules' | 'silences' | 'alert_routes';
export const managedRows = (t: ManagedTable): { id: number; name: string }[] => d.prepare(`SELECT id, name FROM ${t} WHERE managed = 'config'`).all() as never;
export const unmanagedNameTaken = (t: ManagedTable, name: string): boolean => !!d.prepare(`SELECT 1 FROM ${t} WHERE name = ? AND managed IS NULL`).get(name);
export const markManaged = (t: ManagedTable, id: number) => { d.prepare(`UPDATE ${t} SET managed = 'config' WHERE id = ?`).run(id); };
export const isManaged = (t: ManagedTable, id: number): boolean => !!d.prepare(`SELECT 1 FROM ${t} WHERE id = ? AND managed = 'config'`).get(id);
export const setSceneCluster = (id: number, cluster: string | null) => { d.prepare('UPDATE scenes SET cluster = ? WHERE id = ?').run(cluster, id); };
export const setScheduleCluster = (id: number, cluster: string | null) => { d.prepare('UPDATE schedules SET cluster = ? WHERE id = ?').run(cluster, id); };
