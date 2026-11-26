// Public status page: /status (HTML, no scripts) and /status.json. Off unless status_page.enabled is set.
// It shows only the tiles and Uptime Kuma monitors you list, as operational / degraded / outage. Nothing else leaves
// the server: no addresses, no error text, no numbers. Point your reverse proxy at /status* only if you expose it.
import type { FastifyInstance } from 'fastify';
import { cfg } from './config.js';
import { kumaSnapshot } from './kuma.js';
import { publicTiles } from './tiles.js';

export type Level = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown';
export interface StatusItem { name: string; status: Level }
export interface StatusDoc { title: string; message: string; overall: Level; items: StatusItem[]; updatedAt: string }

const RANK: Record<Level, number> = { operational: 0, unknown: 1, maintenance: 2, degraded: 3, outage: 4 };
const TILE: Record<string, Level> = { ok: 'operational', warn: 'degraded', down: 'outage', pending: 'unknown' };
const MON: Record<string, Level> = { up: 'operational', down: 'outage', pending: 'degraded', maintenance: 'maintenance' };

/** Pure: what the page shows for the given inputs. `want` is the allow-list; "*" means everything of that kind. */
export function buildStatus(
  want: { tiles: string[]; monitors: string[]; title: string; message: string },
  tiles: { id: string; name: string; state: string }[], monitors: { name: string; status: string }[], now = new Date(),
): StatusDoc {
  const all = (l: string[]) => l.includes('*');
  const items: StatusItem[] = [
    ...tiles.filter((t) => all(want.tiles) || want.tiles.includes(t.id)).map((t) => ({ name: t.name, status: TILE[t.state] ?? 'unknown' })),
    ...monitors.filter((m) => all(want.monitors) || want.monitors.includes(m.name)).map((m) => ({ name: m.name, status: MON[m.status] ?? 'unknown' })),
  ];
  const overall = items.reduce<Level>((a, i) => (RANK[i.status] > RANK[a] ? i.status : a), 'operational');
  return { title: want.title, message: want.message, overall: items.length ? overall : 'unknown', items, updatedAt: now.toISOString() };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LABEL: Record<Level, string> = { operational: 'Operational', degraded: 'Degraded', outage: 'Outage', maintenance: 'Maintenance', unknown: 'Unknown' };
const COLOR: Record<Level, string> = { operational: '#2e9e44', degraded: '#c27a16', outage: '#d3222a', maintenance: '#0870b9', unknown: '#7a7f87' };
const BANNER: Record<Level, string> = {
  operational: 'All systems operational', degraded: 'Some systems are degraded', outage: 'Some systems are down', maintenance: 'Maintenance in progress', unknown: 'Status unknown',
};

export function renderHtml(d: StatusDoc): string {
  const rows = d.items.map((i) => `<li><span>${esc(i.name)}</span><b style="color:${COLOR[i.status]}">${LABEL[i.status]}</b></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<meta name="robots" content="noindex"><title>${esc(d.title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1b1f24}main{max-width:640px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 16px}.banner{padding:14px 16px;border-radius:8px;color:#fff;font-weight:600;margin-bottom:8px}
p{margin:8px 0 16px;color:#4b5563}ul{list-style:none;padding:0;margin:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px}
li{display:flex;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid #e5e7eb}li:first-child{border-top:0}small{color:#6b7280}
@media(prefers-color-scheme:dark){body{background:#111418;color:#e6e8eb}ul{background:#181c21;border-color:#2a2f36}li{border-color:#2a2f36}p{color:#9aa1ab}small{color:#8a919b}}
</style></head><body><main><h1>${esc(d.title)}</h1><div class="banner" style="background:${COLOR[d.overall]}">${BANNER[d.overall]}</div>
${d.message ? `<p>${esc(d.message)}</p>` : ''}<ul>${rows || '<li><span>Nothing is listed yet.</span></li>'}</ul>
<p><small>Updated ${esc(d.updatedAt.replace('T', ' ').slice(0, 19))} UTC. Refreshes every minute.</small></p></main></body></html>`;
}

const hits = new Map<string, { n: number; reset: number }>();
let cached: { at: number; doc: StatusDoc } | null = null;

export function registerStatus(app: FastifyInstance) {
  const sp = cfg.statusPage;
  if (!sp.enabled) return;
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();
  // Public and unauthenticated, so it has its own small per-IP limit (the /api limiter does not cover it).
  const limited = (ip: string) => {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + 60_000 }; hits.set(ip, h); }
    return ++h.n > 60;
  };
  const doc = () => {
    if (cached && Date.now() - cached.at < 15_000) return cached.doc;
    cached = { at: Date.now(), doc: buildStatus(sp, publicTiles(), kumaSnapshot().map((m) => ({ name: m.name, status: m.status }))) };
    return cached.doc;
  };
  app.get('/status', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).header('Retry-After', '60').send('Too many requests');
    return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'public, max-age=15').send(renderHtml(doc()));
  });
  app.get('/status.json', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).header('Retry-After', '60').send({ error: 'Too many requests' });
    return reply.header('Cache-Control', 'public, max-age=15').send(doc());
  });
}
