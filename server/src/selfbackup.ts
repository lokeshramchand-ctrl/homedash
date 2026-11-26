// Backups of homedash's own SQLite database (users, tokens, scenes, audit trail, settings). Off unless BACKUP_DIR is set.
// A consistent copy is made with VACUUM INTO while the server keeps running, written 0600, and old copies are pruned.
// Restoring is a file copy with the service stopped; the files are never served over HTTP (they hold password hashes).
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getDb } from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { alert } from './notify.js';

const DIR = (process.env.BACKUP_DIR ?? '').trim();
const KEEP = Math.min(Math.max(Number(process.env.BACKUP_KEEP) || 14, 1), 365);
const EVERY_H = Math.min(Math.max(Number(process.env.BACKUP_EVERY_HOURS) || 24, 1), 24 * 30);
const NAME = /^homedash-\d{8}-\d{6}\.db$/;

export const backupsEnabled = () => !!DIR;
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/** Pure: which files to delete so only the newest `keep` remain (names sort by time). */
export const pruneList = (names: string[], keep: number): string[] => names.filter((n) => NAME.test(n)).sort().slice(0, Math.max(0, names.filter((n) => NAME.test(n)).length - keep));

export function listBackups(dir = DIR): { name: string; size: number; at: string }[] {
  try {
    return readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse().map((n) => { const s = statSync(join(dir, n)); return { name: n, size: s.size, at: s.mtime.toISOString() }; });
  } catch { return []; }
}

/** Writes one backup and prunes old ones. Returns the new file's name. */
export function runBackup(dir = DIR, keep = KEEP): string {
  if (!dir) throw new HttpError(503, 'NOT_CONFIGURED', 'Backups are off (set server.backup_dir in homedash.yaml)');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `homedash-${stamp()}.db`;
  const path = resolve(join(dir, name));
  getDb().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  try { chmodSync(path, 0o600); } catch { /* not supported on this platform */ }
  for (const old of pruneList(readdirSync(dir), keep)) rmSync(join(dir, old), { force: true });
  return name;
}

export function startSelfBackup(app: FastifyInstance) {
  if (!DIR) return;
  const tick = () => {
    try { const n = runBackup(); app.log.info({ file: n }, 'database backup written'); }
    catch (e) {
      logEvent('error', 'app', `Database backup failed: ${(e as Error).message}`);
      alert('app', 'error', 'homedash backup failed', (e as Error).message.slice(0, 300), 'selfbackup');
    }
  };
  setTimeout(tick, 60_000).unref(); // a minute after start, then on the interval
  setInterval(tick, EVERY_H * 3_600_000).unref();
}

export function registerSelfBackup(app: FastifyInstance) {
  // /api/admin/* is admin-only (roles.ts).
  app.get('/api/admin/backups', async () => ({ enabled: backupsEnabled(), keep: KEEP, everyHours: EVERY_H, files: listBackups() }));
  app.post('/api/admin/backups', async (req) => {
    const name = runBackup();
    logEvent('info', 'app', `${req.user?.username ?? 'someone'} ran a database backup (${name})`);
    return { name };
  });
}
