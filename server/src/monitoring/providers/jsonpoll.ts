// Any HTTP JSON endpoint turned into up/down checks. The admin says where the list is and which fields hold the name and the status.
// Paths: "$" is the whole answer; otherwise dot-separated names and [n] indexes, for example data.items[0].state.
import type { LoadedSource } from '../store.js';
import type { Check, Polled, Provider, Status } from '../types.js';
import { cap, getJson, trimUrl } from './http.js';

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

/** Pure: the JSON answer to checks. Throws when the list path does not lead to a list. */
export function mapJson(body: unknown, m: JsonMapping): Check[] {
  const list = getPath(body, m.items_path ?? '$');
  if (!Array.isArray(list)) throw new Error(`"${cap(m.items_path, 80)}" does not lead to a list in the answer`);
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
