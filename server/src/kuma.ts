import type { FastifyInstance } from 'fastify';
import { cfg, kumaConfigured } from './config.js';
import { firstSampleAfter, insertSamples, lastSampleTs, recentSamples, sampleStats } from './db.js';
import type { SampleRow } from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { noteMonitors } from './events.js';

type Status = SampleRow['status'];
const STATUS: Record<string, Status> = { '0': 'down', '1': 'up', '2': 'pending', '3': 'maintenance' };
const DAY = 86_400_000;

export interface Scraped { key: string; name: string; url: string; type: string; status: Status; ping: number | null }
let snapshot: { at: number; items: Scraped[] } | null = null;

// Stable numeric id: Kuma's /metrics endpoint exposes no monitor id.
function idOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) & 0x7fffffff;
}

/** Parses Uptime Kuma's Prometheus text (monitor_status / monitor_response_time). */
export function parseMetrics(text: string): Scraped[] {
  const map = new Map<string, Scraped>();
  for (const line of text.split('\n')) {
    const m = line.match(/^(monitor_status|monitor_response_time)\{(.*)\}\s+(\S+)$/);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2].replace(/\\(.)/g, '$1');
    const name = labels.monitor_name ?? 'unknown';
    const url = labels.monitor_url && labels.monitor_url !== 'null' ? labels.monitor_url : labels.monitor_hostname && labels.monitor_hostname !== 'null' ? labels.monitor_hostname : '';
    const type = labels.monitor_type ?? 'http';
    const key = `${name}|${type}|${url}`;
    const item = map.get(key) ?? { key, name, url, type, status: 'pending' as Status, ping: null };
    const v = Number(m[3]);
    if (m[1] === 'monitor_status') item.status = STATUS[String(v)] ?? 'pending';
    else item.ping = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
    map.set(key, item);
  }
  return [...map.values()];
}

async function scrape(app: FastifyInstance) {
  try {
    const res = await fetch(`${cfg.kumaUrl}/metrics`, {
      headers: { Authorization: `Basic ${Buffer.from(`:${cfg.kumaApiKey}`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseMetrics(await res.text());
    snapshot = { at: Date.now(), items };
    noteMonitors(items);
    const now = Date.now();
    if (items.length) {
      insertSamples(items.map((i) => ({
        monitorKey: i.key, name: i.name, url: i.url, type: i.type, status: i.status,
        ping: i.status === 'down' ? null : i.ping, ts: now,
      })));
    }
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, 'kuma scrape failed');
  }
}

export function startKuma(app: FastifyInstance) {
  if (!kumaConfigured()) { app.log.warn('Uptime Kuma not configured; /api/kuma/* will return 503'); return; }
  void scrape(app);
  setInterval(() => void scrape(app), cfg.kumaPollMs).unref();
}

async function current(): Promise<Scraped[]> {
  if (!kumaConfigured()) throw notConfigured('Uptime Kuma');
  if (!snapshot) throw new HttpError(503, 'KUMA_NOT_READY', 'Waiting for the first Uptime Kuma scrape');
  return snapshot.items;
}

/** Last scraped monitors, or an empty list before the first scrape / when Kuma is not configured. */
export const kumaSnapshot = (): Scraped[] => snapshot?.items ?? [];

export async function kumaCounts(): Promise<{ up: number; down: number; pending: number }> {
  const items = await current();
  return {
    up: items.filter((i) => i.status === 'up').length,
    down: items.filter((i) => i.status === 'down').length,
    pending: items.filter((i) => i.status === 'pending').length,
  };
}

export function registerKuma(app: FastifyInstance) {
  app.get('/api/kuma/monitors', async () => {
    const items = await current();
    const stats = new Map(sampleStats(Date.now()).map((a) => [a.monitorKey, a]));
    const pct = (u: number, n: number, fallback: number) => (n ? Math.round((u / n) * 10000) / 100 : fallback);

    return items.map((i) => {
      const s = stats.get(i.key);
      const beats = recentSamples(i.key, 30).reverse();
      const fallback = i.status === 'up' ? 100 : 0;
      return {
        id: idOf(i.key), name: i.name, url: i.url, type: i.type, status: i.status,
        uptime24h: pct(s?.up24 ?? 0, s?.n24 ?? 0, fallback), uptime30d: pct(s?.up30 ?? 0, s?.n30 ?? 0, fallback),
        avgPing: s?.ping != null ? Math.round(s.ping) : i.ping,
        lastCheck: new Date(snapshot!.at).toISOString(),
        heartbeats: beats.map((b) => ({ time: new Date(b.ts).toISOString(), status: b.status, ping: b.ping })),
      };
    });
  });

  app.get('/api/kuma/incidents', async () => {
    const bad = (await current()).filter((i) => i.status !== 'up');
    return bad.map((i) => {
      const first = firstSampleAfter(i.key, lastSampleTs(i.key, 'up'));
      return {
        monitorId: idOf(i.key), name: i.name, status: i.status,
        since: new Date(first ?? snapshot!.at).toISOString(),
        message: i.status === 'down' ? 'Monitor is down' : i.status === 'pending' ? 'Monitor is retrying' : 'Under maintenance',
      };
    });
  });
}
