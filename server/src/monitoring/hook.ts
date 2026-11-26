// Inbound webhook for monitoring: any tool that can POST JSON can report a problem or a check.
// POST /hooks/monitoring/:sourceId  with  Authorization: Bearer <secret>  (or ?token=<secret>, for tools that cannot set a header).
//
// This route is outside /api, so the session, cross-site and rate-limit hooks do not apply: everything is enforced here. It only
// records state; it never runs anything and never forwards the data anywhere.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPath, parseLevelMap, parseStatusMap, statusWord, toMillis } from './providers/jsonpoll.js';
import { deleteHookState, upsertHookState, verifyHookToken } from './store.js';

const MAX_ITEMS = 200;
const WINDOW_MS = 60_000;
const PER_SOURCE = 120; // accepted requests per source per minute
const FAILS_PER_IP = 30; // wrong or missing tokens per client address per minute

/** Hides a `token=` query value so a secret never reaches the request log. */
export const maskSecretInUrl = (url: string): string => url.replace(/([?&]token=)[^&#]*/gi, '$1***');

export interface HookItem {
  key: string; type: 'alert' | 'check'; name: string; level: 'info' | 'warn' | 'error';
  /** firing / pending / down / up; `resolved` removes an alert, `up` keeps a check as up */
  status: 'firing' | 'resolved' | 'pending' | 'down' | 'up'; detail: string; url: string | null; since?: number;
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const httpUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 500) : null);
const levelOf = (v: unknown): HookItem['level'] => {
  const s = String(v ?? '').toLowerCase();
  return /^(critical|error|page|high|disaster)$/.test(s) ? 'error' : /^(info|low|none)$/.test(s) ? 'info' : 'warn';
};
const hash = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 24);

const UP = new Set(['up', 'ok', 'resolved', 'recovered', 'healthy', 'online', 'success', 'passing']);
const DOWN = new Set(['down', 'error', 'fail', 'failed', 'failing', 'critical', 'firing', 'alerting', 'offline']);
const PENDING = new Set(['pending', 'warn', 'warning', 'degraded']);

/** One item of an Alertmanager or Grafana `alerts` array. Each item has its own status; the group's status is ignored. */
function fromAlert(a: Record<string, unknown>, top: Record<string, unknown>): HookItem | null {
  const status = String(a.status ?? '').toLowerCase();
  if (status !== 'firing' && status !== 'resolved') return null;
  const labels = asObj(a.labels), ann = asObj(a.annotations);
  const name = str(labels.alertname, 200) || str(top.title, 200) || str(ann.summary, 200) || 'Alert';
  const t = Date.parse(String(a.startsAt));
  return {
    key: str(a.fingerprint, 100) || `${name}|${hash(labels)}`, type: 'alert', name, level: levelOf(labels.severity), status,
    detail: str(ann.summary, 300) || str(ann.description, 300) || str(ann.message, 300) || str(top.message, 300),
    url: httpUrl(a.generatorURL) ?? httpUrl(a.dashboardURL) ?? httpUrl(a.panelURL) ?? httpUrl(a.silenceURL) ?? null,
    since: Number.isFinite(t) && t > 0 ? t : undefined,
  };
}

/** The plain shape: {name, status, message?, level?, url?, kind?}. */
function fromPlain(o: Record<string, unknown>): HookItem | null {
  const name = str(o.name, 200);
  const status = String(o.status ?? '').toLowerCase();
  if (!name || !status) return null;
  const asAlert = o.kind === 'alert' || o.level !== undefined;
  const detail = str(o.message, 300) || str(o.detail, 300);
  const url = httpUrl(o.url);
  if (asAlert) {
    if (UP.has(status)) return { key: name, type: 'alert', name, level: levelOf(o.level), status: 'resolved', detail, url };
    if (DOWN.has(status) || PENDING.has(status)) return { key: name, type: 'alert', name, level: levelOf(o.level), status: 'firing', detail, url };
    return null;
  }
  if (UP.has(status)) return { key: name, type: 'check', name, level: 'info', status: 'up', detail, url };
  if (DOWN.has(status)) return { key: name, type: 'check', name, level: 'error', status: 'down', detail, url };
  if (PENDING.has(status)) return { key: name, type: 'check', name, level: 'warn', status: 'pending', detail, url };
  return null;
}

export type Parsed = { items: HookItem[]; ignored: number } | { error: string };
const SHAPES = 'Send an Alertmanager or Grafana webhook, or {"name": "backup", "status": "down", "message": "optional"} (status: up, down or pending), or a list of those.';

/** Pure: a request body to the items to record. Detects the shape from the content and trusts nothing about it. */
export function parseHookPayload(body: unknown): Parsed {
  const items: HookItem[] = [];
  let ignored = 0;
  const add = (i: HookItem | null) => { if (i && items.length < MAX_ITEMS) items.push(i); else ignored++; };
  const top = asObj(body);
  if (Array.isArray(top.alerts)) {
    for (const a of top.alerts) add(fromAlert(asObj(a), top));
  } else if (Array.isArray(body)) {
    for (const o of body) add(fromPlain(asObj(o)));
  } else if (typeof top.state === 'string' && typeof top.title === 'string' && !top.name) {
    // A Grafana webhook that carries no alerts array: one item from the title and state.
    const st = top.state.toLowerCase();
    add(st === 'alerting' || st === 'ok' ? { key: `grafana|${str(top.title, 150)}`, type: 'alert', name: str(top.title, 200), level: 'warn', status: st === 'ok' ? 'resolved' : 'firing', detail: str(top.message, 300), url: null } : null);
  } else if (top.name !== undefined) {
    add(fromPlain(top));
  } else {
    return { error: `Unrecognised payload. ${SHAPES}` };
  }
  if (!items.length) return { error: `Nothing in the payload could be used. ${SHAPES}` };
  return { items, ignored };
}

/** The mapping an administrator can set on a webhook source for a payload homedash does not know. */
export interface PushMapping { items_path?: string; name_path?: string; status_path?: string; status_map?: string; detail_path?: string; key_path?: string; as?: string; alert_values?: string; level_path?: string; level_map?: string; since_path?: string }

/**
 * Pure: any JSON payload to items, using the paths the administrator chose. As checks, each item is up, down or pending by its
 * status word. As alerts, an item is firing unless a status filter says otherwise, in which case it clears the alert with that key.
 */
export function parseMappedPayload(body: unknown, m: PushMapping): Parsed {
  const at = getPath(body, m.items_path || '$');
  const list = Array.isArray(at) ? at : at && typeof at === 'object' ? [at] : null;
  if (!list) return { error: `"${String(m.items_path).slice(0, 60)}" does not lead to a list or an object in what was sent` };
  const map = parseStatusMap(m.status_map);
  const levels = parseLevelMap(m.level_map);
  const only = String(m.alert_values ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const items: HookItem[] = [];
  let ignored = 0;
  for (const [i, it] of list.slice(0, MAX_ITEMS).entries()) {
    const name = getPath(it, m.name_path ?? '');
    if (typeof name !== 'string' && typeof name !== 'number') { ignored++; continue; }
    const key = String(m.key_path ? getPath(it, m.key_path) ?? name : name).slice(0, 200) || `item${i}`;
    const detail = m.detail_path ? getPath(it, m.detail_path) : '';
    const text = typeof detail === 'string' ? detail.slice(0, 300) : '';
    if (m.as === 'alert') {
      const raw = m.status_path ? String(getPath(it, m.status_path) ?? '').trim().toLowerCase() : '';
      const firing = !only.length || only.includes(raw);
      const lvl = m.level_path ? String(getPath(it, m.level_path) ?? '').trim().toLowerCase() : '';
      const since = m.since_path ? toMillis(getPath(it, m.since_path)) : null;
      items.push({ key, type: 'alert', name: String(name).slice(0, 200), level: levels[lvl] ?? levelOf(lvl), status: firing ? 'firing' : 'resolved', detail: text, url: null, ...(since ? { since } : {}) });
    } else {
      const st = statusWord(m.status_path ? getPath(it, m.status_path) : 'up', map);
      if (st === 'unknown' || st === 'maintenance') { ignored++; continue; }
      items.push({ key, type: 'check', name: String(name).slice(0, 200), level: st === 'down' ? 'error' : st === 'pending' ? 'warn' : 'info', status: st, detail: text, url: null });
    }
  }
  return items.length ? { items, ignored } : { error: 'Nothing in what was sent could be read with this mapping. Check the paths and the status values.' };
}

// ---- receiver ---------------------------------------------------------------------------------
const buckets = new Map<string, { n: number; reset: number }>();
function count(key: string, now: number) {
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + WINDOW_MS }; buckets.set(key, b); }
  b.n++;
  return b;
}
const peek = (key: string, now: number) => { const b = buckets.get(key); return b && b.reset >= now ? b.n : 0; };

function tokenOf(req: FastifyRequest): string {
  const h = String(req.headers.authorization ?? '');
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const q = (req.query as { token?: unknown } | undefined)?.token;
  return typeof q === 'string' ? q.trim() : '';
}

export function registerHooks(app: FastifyInstance) {
  setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k); }, WINDOW_MS).unref();
  // Its own scope, so the text/plain tolerance below applies to this route only and never to /api.
  void app.register(async (hooks) => {
    // Some senders do not label their JSON body as application/json.
    hooks.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
      try { done(null, JSON.parse(String(body))); } catch { const e = new Error('Invalid JSON') as Error & { statusCode: number }; e.statusCode = 400; done(e, undefined); }
    });
    hooks.post<{ Params: { sourceId: string } }>('/hooks/monitoring/:sourceId', async (req, reply) => {
      const now = Date.now();
      if (peek(`f|${req.ip}`, now) >= FAILS_PER_IP) return reply.code(429).header('Retry-After', '60').send({ error: 'Too many failed attempts' });
      const src = verifyHookToken(req.params.sourceId, tokenOf(req));
      if (!src) { count(`f|${req.ip}`, now); return reply.code(401).send({ error: 'Unauthorized' }); }
      if (count(`s|${src.id}`, now).n > PER_SOURCE) return reply.code(429).header('Retry-After', '60').send({ error: 'Too many requests for this source' });

      // A mapping set on the source wins; without one the built-in shapes (Alertmanager, Grafana, plain) are tried.
      const parsed = src.config.items_path ? parseMappedPayload(req.body, src.config as PushMapping) : parseHookPayload(req.body);
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
      for (const it of parsed.items) {
        if (it.status === 'resolved') deleteHookState(src.id, it.key);
        else upsertHookState({ sourceId: src.id, key: it.key, type: it.type, name: it.name, status: it.status, level: it.level, detail: it.detail, url: it.url, since: it.since }, now);
      }
      return { accepted: parsed.items.length, ignored: parsed.ignored };
    });
  });
}
