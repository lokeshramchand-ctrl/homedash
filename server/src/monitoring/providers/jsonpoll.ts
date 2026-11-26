// Any HTTP JSON endpoint turned into up/down checks. The admin says where the list is and which fields hold the name and the status.
// Paths: "$" is the whole answer; otherwise dot-separated names and [n] indexes, for example data.items[0].state.
import type { LoadedSource } from '../store.js';
import type { Check, MonAlert, Polled, Provider, Status } from '../types.js';
import { cap, getJson, levelOf, trimUrl } from './http.js';

const MAX_ITEMS = 500;

/** Pure: reads a path out of a JSON value. Returns undefined when any step is missing. */
export function getPath(value: unknown, path: string): unknown {
  const p = path.trim();
  if (p === '' || p === '$') return value;
  let cur: unknown = value;
  for (const tok of p.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (tok === '') continue;
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) { const i = Number(tok); if (!Number.isInteger(i)) return undefined; cur = cur[i]; }
    else { if (!Object.prototype.hasOwnProperty.call(cur, tok)) return undefined; cur = (cur as Record<string, unknown>)[tok]; }
  }
  return cur;
}

const STATUSES: Status[] = ['up', 'down', 'pending', 'maintenance', 'unknown'];
const DEFAULTS: Record<string, Status> = {
  up: 'up', ok: 'up', online: 'up', healthy: 'up', running: 'up', true: 'up', '1': 'up', success: 'up', passing: 'up', operational: 'up',
  down: 'down', error: 'down', fail: 'down', failed: 'down', failing: 'down', offline: 'down', critical: 'down', false: 'down', '0': 'down',
  pending: 'pending', warn: 'pending', warning: 'pending', degraded: 'pending',
  maintenance: 'maintenance', paused: 'maintenance',
};

/** Pure: the status word an item carries to a status, using the map first and common words second. */
export const statusWord = (raw: unknown, map: Record<string, Status>): Status => {
  const w = String(raw ?? '').trim().toLowerCase();
  return map[w] ?? DEFAULTS[w] ?? 'unknown';
};

/** Pure: "ok=up, fail=down" to a lookup table. Entries that do not name a known status are dropped. */
export function parseStatusMap(text: string | undefined): Record<string, Status> {
  const out: Record<string, Status> = {};
  for (const part of String(text ?? '').split(/[,\n]/)) {
    const [k, v] = part.split('=').map((x) => x.trim().toLowerCase());
    if (k && STATUSES.includes(v as Status)) out[k] = v as Status;
  }
  return out;
}

export interface JsonMapping { items_path?: string; name_path?: string; status_path?: string; status_map?: string; detail_path?: string }

/** Pure: the list at a path. An object whose values are the items (keyed by name, as some tools answer) counts as a list. */
export function listAt(body: unknown, path: string | undefined): unknown[] {
  const at = getPath(body, path ?? '$');
  if (Array.isArray(at)) return at;
  if (at && typeof at === 'object') return Object.values(at as Record<string, unknown>);
  throw new Error(`"${cap(path, 80)}" does not lead to a list in the answer`);
}

/** Pure: the JSON answer to checks. Throws when the list path does not lead to a list. */
export function mapJson(body: unknown, m: JsonMapping): Check[] {
  const list = listAt(body, m.items_path);
  const map = parseStatusMap(m.status_map);
  const out: Check[] = [];
  for (const item of list.slice(0, MAX_ITEMS)) {
    const name = getPath(item, m.name_path ?? '');
    if (typeof name !== 'string' && typeof name !== 'number') continue;
    const raw = String(getPath(item, m.status_path ?? '') ?? '').trim().toLowerCase();
    const detail = m.detail_path ? getPath(item, m.detail_path) : '';
    out.push({ key: String(name).slice(0, 100), name: String(name).slice(0, 100), status: map[raw] ?? DEFAULTS[raw] ?? 'unknown', since: null, detail: typeof detail === 'string' ? detail.slice(0, 300) : '', url: null });
  }
  return out;
}

export const jsonPollProvider = (s: LoadedSource): Provider => ({
  kind: 'jsonpoll', label: s.name, raisesChecks: true, configured: () => !!s.config.url,
  async poll(): Promise<Polled> {
    return { checks: mapJson(await getJson(trimUrl(s.config.url), { bearer: s.secrets.token }), s.config), alerts: [] };
  },
});

// ---- a JSON list read as alerts ----------------------------------------------------------------------------------------------
export interface AlertMapping {
  items_path?: string; name_path?: string; summary_path?: string; level_path?: string; level_map?: string; since_path?: string;
  status_path?: string; alert_values?: string; key_path?: string;
}

/** Pure: "5=error, critical=error, warning=warn" to a lookup. Only error, warn and info are meaningful targets. */
export function parseLevelMap(text: string | undefined): Record<string, 'info' | 'warn' | 'error'> {
  const out: Record<string, 'info' | 'warn' | 'error'> = {};
  for (const part of String(text ?? '').split(/[,\n]/)) {
    const [k, v] = part.split('=').map((x) => x.trim().toLowerCase());
    if (k && (v === 'info' || v === 'warn' || v === 'error')) out[k] = v;
  }
  return out;
}

/** Pure: a time as a number of seconds or milliseconds, or an ISO string, to milliseconds; null when it is none of those. */
export function toMillis(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return toMillis(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Pure: a JSON list where every item is a problem (optionally only those whose status is one of `alert_values`).
 * Throws when the list path does not lead to a list.
 */
export function mapJsonAlerts(body: unknown, m: AlertMapping): MonAlert[] {
  const list = listAt(body, m.items_path);
  const levels = parseLevelMap(m.level_map);
  const only = String(m.alert_values ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const out: MonAlert[] = [];
  for (const [i, item] of list.slice(0, MAX_ITEMS).entries()) {
    const name = getPath(item, m.name_path ?? '');
    if (typeof name !== 'string' && typeof name !== 'number') continue;
    if (only.length && !only.includes(String(getPath(item, m.status_path ?? '') ?? '').trim().toLowerCase())) continue;
    const rawLevel = m.level_path ? String(getPath(item, m.level_path) ?? '').trim().toLowerCase() : '';
    const summary = m.summary_path ? getPath(item, m.summary_path) : '';
    const key = m.key_path ? getPath(item, m.key_path) : undefined;
    out.push({
      key: String(key ?? `${name}#${i}`).slice(0, 200), name: String(name).slice(0, 200), level: levels[rawLevel] ?? levelOf(rawLevel), state: 'firing',
      since: m.since_path ? toMillis(getPath(item, m.since_path)) : null, summary: typeof summary === 'string' ? summary.slice(0, 300) : '', instances: 1, url: null,
    });
  }
  return out;
}
