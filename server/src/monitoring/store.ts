// Monitoring sources created in the UI, and the state pushed to webhook sources. Secrets of pull sources are sealed with
// the same key as service tiles (tilestore.sealKey); a webhook source stores only the SHA-256 of its receiver secret, so the
// secret itself exists once, at creation (or rotation), and cannot be read back.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db.js';
import { HttpError } from '../errors.js';
import { seal, unseal } from '../seal.js';
import { sealKey } from '../tilestore.js';
import { kindSpec, secretFields } from './catalog.js';

export interface SourceInput {
  kind: string; name: string; config: Record<string, string>; secrets: Record<string, string>;
  enabled: boolean; intervalS: number; ttlHours: number;
}
/** What the API may show: everything except secret values, which are only reported as set or not. */
export interface SourceView {
  id: string; kind: string; name: string; config: Record<string, string>; secretsSet: string[];
  enabled: boolean; intervalS: number; ttlHours: number; createdAt: number; createdBy: string | null;
}
export interface LoadedSource extends SourceView { secrets: Record<string, string> }

interface Row {
  id: string; kind: string; name: string; config: string; secret: string; enabled: number; interval_s: number; ttl_hours: number;
  created_at: number; created_by: string | null;
}

export const newSourceId = () => `src-${randomBytes(4).toString('hex')}`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** The receiver secret: 32 random bytes, base64url. Shown to the admin once. */
export const generateHookSecret = () => randomBytes(32).toString('base64url');

const needKey = () => {
  const key = sealKey();
  if (!key) throw new HttpError(503, 'NO_SECRET_KEY', 'Set SECRETS_KEY (homedash-config apply creates one) before connecting sources from the UI');
  return key;
};
const SECRET_SETS = (r: Row, secrets: Record<string, string>): string[] => (r.kind === 'webhook' ? [] : Object.keys(secrets).filter((k) => secrets[k]));

function open(r: Row): LoadedSource {
  const secrets = r.kind === 'webhook' ? {} : unseal<Record<string, string>>(needKey(), r.id, r.secret);
  return {
    id: r.id, kind: r.kind, name: r.name, config: JSON.parse(r.config) as Record<string, string>, secrets, secretsSet: SECRET_SETS(r, secrets),
    enabled: !!r.enabled, intervalS: r.interval_s, ttlHours: r.ttl_hours, createdAt: r.created_at, createdBy: r.created_by,
  };
}
const view = (l: LoadedSource): SourceView => { const { secrets: _s, ...v } = l; return v; };
const rows = () => getDb().prepare('SELECT * FROM monitoring_sources ORDER BY created_at').all() as unknown as Row[];

/** Only the secret fields the kind declares are kept; everything else is dropped. */
function pickSecrets(kind: string, given: Record<string, string>, prev: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of secretFields(kind)) {
    const v = typeof given[name] === 'string' ? given[name].trim() : '';
    out[name] = v !== '' ? v : prev[name] ?? '';
  }
  return out;
}

/** Creates a source. For a webhook returns the plain receiver secret, which is not stored and cannot be shown again. */
export function createSource(input: SourceInput, user: string): { id: string; hookSecret?: string } {
  if (!kindSpec(input.kind)) throw new HttpError(400, 'BAD_REQUEST', 'Unknown kind of source');
  const id = newSourceId();
  const hook = input.kind === 'webhook';
  const hookSecret = hook ? generateHookSecret() : undefined;
  const secret = hook ? sha256(hookSecret!) : seal(needKey(), id, pickSecrets(input.kind, input.secrets));
  getDb().prepare('INSERT INTO monitoring_sources (id, kind, name, config, secret, enabled, interval_s, ttl_hours, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.kind, input.name, JSON.stringify(input.config), secret, input.enabled ? 1 : 0, input.intervalS, input.ttlHours, Date.now(), user);
  return { id, hookSecret };
}

export function getSource(id: string): LoadedSource | undefined {
  const r = getDb().prepare('SELECT * FROM monitoring_sources WHERE id = ?').get(id) as unknown as Row | undefined;
  if (!r) return undefined;
  try { return open(r); } catch { return undefined; }
}

/** Edits a source. A secret left blank keeps its old value; the kind cannot change. */
export function updateSource(id: string, input: Omit<SourceInput, 'kind'>): boolean {
  const prev = getSource(id);
  if (!prev) return false;
  if (prev.kind === 'webhook') {
    getDb().prepare('UPDATE monitoring_sources SET name = ?, config = ?, enabled = ?, interval_s = ?, ttl_hours = ? WHERE id = ?').run(input.name, JSON.stringify(input.config), input.enabled ? 1 : 0, input.intervalS, input.ttlHours, id);
  } else {
    const secret = seal(needKey(), id, pickSecrets(prev.kind, input.secrets, prev.secrets));
    getDb().prepare('UPDATE monitoring_sources SET name = ?, config = ?, secret = ?, enabled = ?, interval_s = ?, ttl_hours = ? WHERE id = ?').run(input.name, JSON.stringify(input.config), secret, input.enabled ? 1 : 0, input.intervalS, input.ttlHours, id);
  }
  return true;
}

export function deleteSource(id: string): boolean {
  const n = Number(getDb().prepare('DELETE FROM monitoring_sources WHERE id = ?').run(id).changes);
  getDb().prepare('DELETE FROM monitoring_hook_state WHERE source_id = ?').run(id);
  return n > 0;
}

/** Issues a new receiver secret for a webhook source; the old one stops working at once. */
export function rotateHookSecret(id: string): string | undefined {
  const r = getDb().prepare('SELECT kind FROM monitoring_sources WHERE id = ?').get(id) as { kind: string } | undefined;
  if (!r || r.kind !== 'webhook') return undefined;
  const secret = generateHookSecret();
  getDb().prepare('UPDATE monitoring_sources SET secret = ? WHERE id = ?').run(sha256(secret), id);
  return secret;
}

export function listSources(): SourceView[] {
  const out: SourceView[] = [];
  for (const r of rows()) { try { out.push(view(open(r))); } catch { /* sealed with another key: not listed, not fatal */ } }
  return out;
}

/** Every enabled source with its secrets opened, ready to poll. A row that cannot be opened is skipped with a warning. */
export function loadSources(warn: (m: string) => void = () => {}): LoadedSource[] {
  const out: LoadedSource[] = [];
  for (const r of rows()) {
    try { out.push(open(r)); } catch { warn(`monitoring source "${r.name}" cannot be opened (was the secret key changed?)`); }
  }
  return out;
}

const DUMMY = Buffer.from(sha256('homedash-dummy-hook-secret'), 'hex');
/**
 * Checks a token presented to the webhook receiver. Unknown ids, disabled sources and wrong tokens all take the same path
 * (a hash and a constant-time compare), so the answer and the work done do not reveal which part was wrong.
 */
export function verifyHookToken(id: string, token: string): LoadedSource | null {
  const r = getDb().prepare("SELECT * FROM monitoring_sources WHERE id = ? AND kind = 'webhook'").get(id) as unknown as Row | undefined;
  const want = r ? Buffer.from(r.secret, 'hex') : DUMMY;
  const got = Buffer.from(sha256(token), 'hex');
  const same = want.length === got.length && timingSafeEqual(want, got);
  if (!r || !r.enabled || !same) return null;
  try { return open(r); } catch { return null; }
}

// ---- pushed state -------------------------------------------------------------------------------
export interface HookRow { sourceId: string; key: string; type: 'check' | 'alert'; name: string; status: string; level: 'info' | 'warn' | 'error'; detail: string; url: string | null; since: number; lastSeen: number }

/** Inserts or refreshes one pushed item. `since` is kept from the first time it was seen. */
export function upsertHookState(r: Omit<HookRow, 'since' | 'lastSeen'> & { since?: number }, now = Date.now()) {
  getDb().prepare(`INSERT INTO monitoring_hook_state (source_id, key, type, name, status, level, detail, url, since, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id, key) DO UPDATE SET type = excluded.type, name = excluded.name, status = excluded.status, level = excluded.level, detail = excluded.detail, url = excluded.url, last_seen = excluded.last_seen`)
    .run(r.sourceId, r.key, r.type, r.name, r.status, r.level, r.detail, r.url, r.since ?? now, now);
}
export const deleteHookState = (sourceId: string, key: string): boolean => Number(getDb().prepare('DELETE FROM monitoring_hook_state WHERE source_id = ? AND key = ?').run(sourceId, key).changes) > 0;

/** Pushed items that were refreshed within the TTL. */
export function readHookState(sourceId: string, ttlHours: number, now = Date.now()): HookRow[] {
  const cutoff = now - ttlHours * 3_600_000;
  return (getDb().prepare('SELECT * FROM monitoring_hook_state WHERE source_id = ? AND last_seen >= ? ORDER BY since').all(sourceId, cutoff) as any[]).map((r) => ({
    sourceId: r.source_id, key: r.key, type: r.type, name: r.name, status: r.status, level: r.level, detail: r.detail ?? '', url: r.url ?? null, since: r.since, lastSeen: r.last_seen,
  }));
}
export const newestHookSeen = (sourceId: string): number => ((getDb().prepare('SELECT MAX(last_seen) AS t FROM monitoring_hook_state WHERE source_id = ?').get(sourceId) as { t: number | null }).t) ?? 0;
