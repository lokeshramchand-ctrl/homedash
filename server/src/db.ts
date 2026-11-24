import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cfg } from './config.js';

// Embedded SQLite (node:sqlite, built into Node >= 22.13). One file, no service to run.
// All timestamps are epoch milliseconds.

export interface UserRow { id: number; username: string; passwordHash: string; createdAt: number; lastLoginAt: number | null }
export interface SessionRow { id: number; tokenHash: string; userId: number; username: string; expiresAt: number }
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
CREATE TABLE IF NOT EXISTS oidc_states (id TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL);
`;

export function connectDb(): void {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  d = new DatabaseSync(cfg.dbPath);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  d.exec(SCHEMA);
  purgeExpired();
  setInterval(purgeExpired, 3_600_000).unref();
}

/** The raw SQLite handle, for modules that own their own tables (the data manager). */
export const getDb = (): DatabaseSync => d;

export const closeDb = () => { try { d?.close(); } catch { /* already closed */ } };

/** Replaces the TTL indexes a document database would use. */
function purgeExpired() {
  const now = Date.now();
  for (const t of ['sessions', 'login_attempts', 'kuma_samples', 'system_events', 'oidc_states', 'datasource_audit', 'gpu_samples']) {
    d.prepare(`DELETE FROM ${t} WHERE expires_at < ?`).run(now);
  }
}

/** Whether the database answers; used by /metrics and the health check. */
export function dbOk(): boolean {
  try { d.prepare('SELECT 1').get(); return true; } catch { return false; }
}

const userOf = (r: any): UserRow | null => r ? ({
  id: r.id, username: r.username, passwordHash: r.password_hash, createdAt: r.created_at, lastLoginAt: r.last_login_at,
}) : null;

// ---- users -------------------------------------------------------------------------------------
export const findUser = (username: string) =>
  userOf(d.prepare('SELECT * FROM users WHERE username = ?').get(username));

/** Creates the user or resets the password (ending its sessions). Returns which one happened. */
export function upsertPasswordUser(username: string, passwordHash: string): 'created' | 'updated' {
  const existing = d.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
  if (!existing) {
    d.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(username, passwordHash, Date.now());
    return 'created';
  }
  d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, existing.id);
  d.prepare('DELETE FROM sessions WHERE username = ?').run(username);
  return 'updated';
}

export const touchLogin = (id: number) => { d.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id); };

/** SSO users are keyed by issuer|sub; the display username can change between logins. */
export function upsertSsoUser(ssoSub: string, username: string): UserRow {
  const now = Date.now();
  d.prepare(`INSERT INTO users (username, password_hash, created_at, last_login_at, sso_sub) VALUES (?, '', ?, ?, ?)
    ON CONFLICT (sso_sub) DO UPDATE SET username = excluded.username, last_login_at = excluded.last_login_at`).run(username, now, now, ssoSub);
  return userOf(d.prepare('SELECT * FROM users WHERE sso_sub = ?').get(ssoSub))!;
}

// ---- sessions ----------------------------------------------------------------------------------
export function insertSession(s: { tokenHash: string; userId: number; username: string; expiresAt: number; ip: string; userAgent: string }) {
  d.prepare('INSERT INTO sessions (token_hash, user_id, username, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(s.tokenHash, s.userId, s.username, Date.now(), s.expiresAt, s.ip, s.userAgent);
}

export function findSession(tokenHash: string): SessionRow | null {
  const r = d.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now()) as any;
  return r ? { id: r.id, tokenHash: r.token_hash, userId: r.user_id, username: r.username, expiresAt: r.expires_at } : null;
}

export const deleteSession = (tokenHash: string) => { d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); };

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
export function insertAudit(a: AuditRow) {
  d.prepare('INSERT INTO audit (ts, user, ip, vmid, name, action, result, task_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.ts, a.user, a.ip, a.vmid, a.name ?? null, a.action, a.result, a.taskId ?? null, a.reason ?? null);
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
export interface SceneRow { id: number; name: string; steps: SceneStep[] }
export interface ScheduleRow {
  id: number; name: string; sceneId: number | null; vmid: number | null; action: string | null;
  days: number[]; time: string; enabled: boolean; lastRun: number | null; lastResult: string | null;
}

const sceneOf = (r: any): SceneRow => ({ id: r.id, name: r.name, steps: JSON.parse(r.steps) });
export const listScenes = (): SceneRow[] => (d.prepare('SELECT * FROM scenes ORDER BY name').all() as any[]).map(sceneOf);
export const getScene = (id: number): SceneRow | null => { const r = d.prepare('SELECT * FROM scenes WHERE id = ?').get(id); return r ? sceneOf(r) : null; };
export const saveScene = (id: number | null, name: string, steps: SceneStep[]): number => {
  if (id === null) return Number(d.prepare('INSERT INTO scenes (name, steps, created_at) VALUES (?, ?, ?)').run(name, JSON.stringify(steps), Date.now()).lastInsertRowid);
  d.prepare('UPDATE scenes SET name = ?, steps = ? WHERE id = ?').run(name, JSON.stringify(steps), id);
  return id;
};
export const deleteScene = (id: number) => {
  d.prepare('DELETE FROM schedules WHERE scene_id = ?').run(id);
  d.prepare('DELETE FROM scenes WHERE id = ?').run(id);
};

const schedOf = (r: any): ScheduleRow => ({
  id: r.id, name: r.name, sceneId: r.scene_id, vmid: r.vmid, action: r.action, days: String(r.days).split(',').filter(Boolean).map(Number),
  time: r.time, enabled: !!r.enabled, lastRun: r.last_run, lastResult: r.last_result,
});
export const listSchedules = (): ScheduleRow[] => (d.prepare('SELECT * FROM schedules ORDER BY time, name').all() as any[]).map(schedOf);
export const saveSchedule = (id: number | null, s: Omit<ScheduleRow, 'id' | 'lastRun' | 'lastResult'>): number => {
  const args = [s.name, s.sceneId, s.vmid, s.action, s.days.join(','), s.time, s.enabled ? 1 : 0] as const;
  if (id === null) return Number(d.prepare('INSERT INTO schedules (name, scene_id, vmid, action, days, time, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...args).lastInsertRowid);
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
