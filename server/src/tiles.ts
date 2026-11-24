// Status tiles: small read-only integrations (Docker, Portainer, Pi-hole, Nginx Proxy Manager, Jellyfin, Home Assistant,
// or any JSON endpoint) declared under `tiles:` in homedash.yaml. Each tile is polled in the background; the Services page
// shows the last result. A tile that stays down raises one alert (category "services") and one recovery.
//
// Adding a provider: write a pure parse function (tested in test/tiles.test.mjs) and one entry in PROVIDERS.
import type { FastifyInstance } from 'fastify';
import { Agent } from 'undici';
import { cfg } from './config.js';
import type { TileCfg } from './config.js';
import { HttpError } from './errors.js';
import { alert } from './notify.js';

export type Tone = 'ok' | 'warn' | 'bad';
export interface Stat { label: string; value: string | number; tone?: Tone }
export interface Probe { status: 'ok' | 'warn'; summary: string; stats: Stat[] }
export interface TileResult extends Partial<Probe> { state: 'ok' | 'warn' | 'down' | 'pending'; ms: number | null; at: number | null; error?: string }

export const TILE_KINDS = ['docker', 'portainer', 'pihole', 'npm', 'jellyfin', 'homeassistant', 'pbs', 'http'] as const;

// ---- pure parsers (exported for the tests) ---------------------------------------------------------
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const num = (v: number) => v.toLocaleString('en-US');

/** Dot path with [index] support: "queries.total", "items[0].name". */
export function jsonPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Docker Engine GET /containers/json?all=1 */
export function parseDocker(list: any[]): Probe {
  let running = 0, stopped = 0, unhealthy = 0, restarting = 0, failed = 0;
  for (const c of Array.isArray(list) ? list : []) {
    const state = String(c?.State ?? ''), status = String(c?.Status ?? '');
    if (state === 'running') { running++; if (/unhealthy/i.test(status)) unhealthy++; }
    else if (state === 'restarting') restarting++;
    else { stopped++; const m = /^Exited \((\d+)\)/.exec(status); if (m && m[1] !== '0') failed++; }
  }
  const bad = unhealthy + restarting + failed;
  return {
    status: bad ? 'warn' : 'ok', summary: `${running} running`,
    stats: [
      { label: 'Running', value: running }, { label: 'Stopped', value: stopped },
      { label: 'Unhealthy', value: unhealthy, tone: unhealthy ? 'bad' : undefined },
      { label: 'Restarting', value: restarting, tone: restarting ? 'bad' : undefined },
      { label: 'Crashed', value: failed, tone: failed ? 'warn' : undefined },
    ],
  };
}

/** Portainer GET /api/endpoints (uses each environment's last snapshot). */
export function parsePortainer(list: any[]): Probe {
  let envs = 0, offline = 0, running = 0, stopped = 0, unhealthy = 0;
  for (const e of Array.isArray(list) ? list : []) {
    envs++;
    if (n(e?.Status) === 2) offline++;
    const s = e?.Snapshots?.[0] ?? {};
    running += n(s.RunningContainerCount); stopped += n(s.StoppedContainerCount); unhealthy += n(s.UnhealthyContainerCount);
  }
  return {
    status: offline || unhealthy ? 'warn' : 'ok', summary: `${envs} environment${envs === 1 ? '' : 's'}, ${running} running`,
    stats: [
      { label: 'Environments', value: envs }, { label: 'Offline', value: offline, tone: offline ? 'bad' : undefined },
      { label: 'Running', value: running }, { label: 'Stopped', value: stopped }, { label: 'Unhealthy', value: unhealthy, tone: unhealthy ? 'bad' : undefined },
    ],
  };
}

/** Pi-hole v6 GET /api/stats/summary, or v5 GET /admin/api.php?summaryRaw. */
export function parsePihole(j: any, blocking?: string): Probe {
  const v6 = j && typeof j.queries === 'object';
  const total = v6 ? n(j.queries.total) : n(j.dns_queries_today);
  const blocked = v6 ? n(j.queries.blocked) : n(j.ads_blocked_today);
  const pct = v6 ? n(j.queries.percent_blocked) : n(j.ads_percentage_today);
  const domains = v6 ? n(j.gravity?.domains_being_blocked) : n(j.domains_being_blocked);
  const mode = blocking ?? (v6 ? undefined : String(j.status ?? ''));
  const off = !!mode && mode !== 'enabled';
  return {
    status: off ? 'warn' : 'ok', summary: `${pct.toFixed(1)}% blocked today`,
    stats: [
      { label: 'Queries', value: num(total) }, { label: 'Blocked', value: num(blocked) }, { label: 'Blocked %', value: `${pct.toFixed(1)}%` },
      { label: 'Blocklist', value: num(domains) },
      ...(mode ? [{ label: 'Blocking', value: mode, tone: off ? ('bad' as Tone) : undefined }] : []),
    ],
  };
}

/** Nginx Proxy Manager: /api/reports/hosts plus /api/nginx/certificates. */
export function parseNpm(hosts: any, certs: any[], now = Date.now()): Probe {
  const days = (Array.isArray(certs) ? certs : [])
    .map((c) => (c?.expires_on ? Math.floor((Date.parse(String(c.expires_on).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(c.expires_on)) ? '' : 'Z')) - now) / 86_400_000) : NaN))
    .filter((d) => Number.isFinite(d));
  const soonest = days.length ? Math.min(...days) : null;
  const tone: Tone | undefined = soonest === null ? undefined : soonest < 3 ? 'bad' : soonest < 14 ? 'warn' : undefined;
  return {
    status: tone ? 'warn' : 'ok', summary: `${n(hosts?.proxy)} proxy hosts`,
    stats: [
      { label: 'Proxy hosts', value: n(hosts?.proxy) }, { label: 'Redirections', value: n(hosts?.redirection) }, { label: 'Streams', value: n(hosts?.stream) },
      { label: '404 hosts', value: n(hosts?.dead) }, { label: 'Certificates', value: days.length },
      ...(soonest !== null ? [{ label: 'Next expiry', value: soonest < 0 ? 'expired' : `${soonest} d`, tone }] : []),
    ],
  };
}

/** Jellyfin: /System/Info/Public, optionally /Sessions and /Items/Counts when a key is set. */
export function parseJellyfin(info: any, sessions?: any[], counts?: any): Probe {
  const streams = (Array.isArray(sessions) ? sessions : []).filter((s) => s?.NowPlayingItem).length;
  const stats: Stat[] = [{ label: 'Version', value: String(info?.Version ?? '?') }];
  if (sessions) stats.push({ label: 'Streams', value: streams });
  if (counts) stats.push({ label: 'Movies', value: num(n(counts.MovieCount)) }, { label: 'Series', value: num(n(counts.SeriesCount)) }, { label: 'Episodes', value: num(n(counts.EpisodeCount)) });
  return { status: 'ok', summary: sessions ? `${streams} stream${streams === 1 ? '' : 's'}` : String(info?.ServerName ?? 'online'), stats };
}

/** Home Assistant: /api/config plus /api/states. */
export function parseHomeAssistant(config: any, states: any[]): Probe {
  const list = Array.isArray(states) ? states : [];
  const unavailable = list.filter((s) => s?.state === 'unavailable').length;
  const running = !config?.state || config.state === 'RUNNING';
  return {
    status: !running ? 'warn' : 'ok', summary: `${list.length} entities`,
    stats: [
      { label: 'Version', value: String(config?.version ?? '?') }, { label: 'State', value: String(config?.state ?? 'RUNNING'), tone: running ? undefined : 'warn' },
      { label: 'Entities', value: num(list.length) }, { label: 'Unavailable', value: unavailable, tone: unavailable ? 'warn' : undefined },
    ],
  };
}

/** Proxmox Backup Server: /status/datastore-usage plus failed tasks of the last 24 h. */
export function parsePbs(usage: any[], failed: any[] = []): Probe {
  const stores = (Array.isArray(usage) ? usage : []).map((u) => {
    const total = n(u?.total), used = n(u?.used);
    const full = u?.['estimated-full-date'] ? new Date(n(u['estimated-full-date']) * 1000) : null;
    return { name: String(u?.store ?? '?'), pct: total ? used / total : 0, full };
  });
  const worst = stores.reduce((a, s) => (s.pct > a ? s.pct : a), 0);
  const failures = (Array.isArray(failed) ? failed : []).length;
  const soon = stores.filter((s) => s.full && s.full.getTime() - Date.now() < 30 * 86_400_000);
  const dsTone: Tone | undefined = worst >= 0.95 ? 'bad' : worst >= 0.85 ? 'warn' : undefined;
  return {
    status: dsTone || failures ? 'warn' : 'ok', summary: `${stores.length} datastore${stores.length === 1 ? '' : 's'}, ${failures} failed task${failures === 1 ? '' : 's'}`,
    stats: [
      ...stores.slice(0, 4).map((s) => ({ label: s.name, value: `${(s.pct * 100).toFixed(0)}% full`, tone: (s.pct >= 0.95 ? 'bad' : s.pct >= 0.85 ? 'warn' : undefined) as Tone | undefined })),
      { label: 'Failed tasks (24 h)', value: failures, tone: failures ? ('bad' as Tone) : undefined },
      ...(soon.length ? [{ label: 'Full within 30 d', value: soon.map((s) => s.name).join(', '), tone: 'warn' as Tone }] : []),
    ],
  };
}

/** Generic JSON/HTTP check: the stats come from the tile's own `stats: [{label, path}]`. */
export function parseGeneric(body: unknown, stats: { label: string; path: string }[] = []): Probe {
  return {
    status: 'ok', summary: 'responding',
    stats: stats.map((s) => { const v = jsonPath(body, s.path); return { label: s.label, value: v === undefined || v === null ? '–' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60) }; }),
  };
}

// ---- fetching ------------------------------------------------------------------------------------
const agents = new Map<string, Agent | undefined>();
const agentFor = (t: TileCfg) => {
  if (!agents.has(t.id)) agents.set(t.id, t.insecureTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined);
  return agents.get(t.id);
};

interface Init { method?: string; headers?: Record<string, string>; body?: string }
async function call(t: TileCfg, path: string, init: Init = {}, raw = false): Promise<any> {
  const res = await fetch(`${t.url}${path}`, {
    method: init.method ?? 'GET', headers: { Accept: 'application/json', ...init.headers }, body: init.body,
    signal: AbortSignal.timeout(10_000),
    // @ts-expect-error undici dispatcher is not in the DOM fetch typings
    dispatcher: agentFor(t),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`sign-in rejected (HTTP ${res.status}); check the token or credentials`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (raw) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('answer is not JSON'); }
}

// Session tokens kept between polls (Pi-hole v6, Nginx Proxy Manager).
const sessions = new Map<string, { value: string; until: number }>();
async function session(t: TileCfg, login: () => Promise<{ value: string; ttlMs: number }>, force = false): Promise<string> {
  const s = sessions.get(t.id);
  if (!force && s && s.until > Date.now() + 30_000) return s.value;
  const r = await login();
  sessions.set(t.id, { value: r.value, until: Date.now() + r.ttlMs });
  return r.value;
}
/** Runs `fn` with a session token; one retry with a fresh login when the token was rejected. */
async function withSession<T>(t: TileCfg, login: () => Promise<{ value: string; ttlMs: number }>, fn: (tok: string) => Promise<T>): Promise<T> {
  try { return await fn(await session(t, login)); }
  catch (e) {
    if (!/sign-in rejected/.test((e as Error).message)) throw e;
    return fn(await session(t, login, true));
  }
}

const bearer = (t: TileCfg): Record<string, string> => (t.token ? { Authorization: `Bearer ${t.token}` } : {});

const PROVIDERS: Record<(typeof TILE_KINDS)[number], (t: TileCfg) => Promise<Probe>> = {
  docker: async (t) => parseDocker(await call(t, '/containers/json?all=1', { headers: bearer(t) })),
  portainer: async (t) => parsePortainer(await call(t, '/api/endpoints', { headers: { 'X-API-Key': t.token } })),
  pihole: async (t) => {
    if (!t.password) { // v5: API token
      return parsePihole(await call(t, `/admin/api.php?summaryRaw${t.token ? `&auth=${encodeURIComponent(t.token)}` : ''}`));
    }
    const login = async () => {
      const j = await call(t, '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: t.password }) });
      if (!j?.session?.valid) throw new Error('sign-in rejected (wrong password)');
      return { value: String(j.session.sid), ttlMs: Math.max(60, n(j.session.validity) || 300) * 1000 };
    };
    return withSession(t, login, async (sid) => {
      const h = { sid };
      const sum = await call(t, '/api/stats/summary', { headers: h });
      const blocking = await call(t, '/api/dns/blocking', { headers: h }).then((b) => String(b?.blocking ?? ''), () => '');
      return parsePihole(sum, blocking || undefined);
    });
  },
  npm: async (t) => {
    const login = async () => {
      const j = await call(t, '/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: t.username, secret: t.password }) });
      if (!j?.token) throw new Error('sign-in rejected (wrong e-mail or password)');
      return { value: String(j.token), ttlMs: 3_600_000 };
    };
    return withSession(t, login, async (tok) => {
      const h = { Authorization: `Bearer ${tok}` };
      const [hosts, certs] = await Promise.all([call(t, '/api/reports/hosts', { headers: h }), call(t, '/api/nginx/certificates', { headers: h }).catch(() => [])]);
      return parseNpm(hosts, certs);
    });
  },
  jellyfin: async (t) => {
    const info = await call(t, '/System/Info/Public');
    if (!t.token) return parseJellyfin(info);
    const h = { 'X-Emby-Token': t.token };
    const [ses, counts] = await Promise.all([call(t, '/Sessions', { headers: h }).catch(() => undefined), call(t, '/Items/Counts', { headers: h }).catch(() => undefined)]);
    return parseJellyfin(info, ses, counts);
  },
  homeassistant: async (t) => {
    const h = bearer(t);
    const [config, states] = await Promise.all([call(t, '/api/config', { headers: h }), call(t, '/api/states', { headers: h })]);
    return parseHomeAssistant(config, states);
  },
  pbs: async (t) => {
    const h = { Authorization: `PBSAPIToken=${t.token}` };
    const [usage, tasks] = await Promise.all([
      call(t, '/api2/json/status/datastore-usage', { headers: h }),
      call(t, `/api2/json/nodes/localhost/tasks?errors=1&limit=50&since=${Math.floor(Date.now() / 1000) - 86_400}`, { headers: h }).catch(() => ({ data: [] })),
    ]);
    return parsePbs(usage?.data ?? [], tasks?.data ?? []);
  },
  http: async (t) => {
    if (!t.stats.length) { await call(t, t.path, { headers: bearer(t) }, true); return { status: 'ok', summary: 'responding', stats: [] }; }
    return parseGeneric(await call(t, t.path, { headers: bearer(t) }), t.stats);
  },
};

// ---- polling -------------------------------------------------------------------------------------
const results = new Map<string, TileResult>();
const fails = new Map<string, number>();
const alerted = new Set<string>();
const FAILS_BEFORE_ALERT = 2;

export async function pollTile(t: TileCfg): Promise<TileResult> {
  const t0 = Date.now();
  let r: TileResult;
  try {
    const p = await PROVIDERS[t.kind](t);
    r = { ...p, state: p.status, ms: Date.now() - t0, at: Date.now() };
    fails.set(t.id, 0);
    if (alerted.delete(t.id)) alert('services', 'info', `Recovered · ${t.name}`, `${t.name} is reachable again`, `tile|${t.id}|ok`);
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message;
    r = { state: 'down', ms: null, at: Date.now(), error: msg };
    const f = (fails.get(t.id) ?? 0) + 1;
    fails.set(t.id, f);
    if (f >= FAILS_BEFORE_ALERT && !alerted.has(t.id)) { alerted.add(t.id); alert('services', 'error', `DOWN · ${t.name}`, `${t.name}: ${msg}`, `tile|${t.id}`); }
  }
  results.set(t.id, r);
  return r;
}

export function startTiles(app: FastifyInstance) {
  for (const t of cfg.tiles) {
    const run = () => void pollTile(t).catch((e) => app.log.warn({ err: (e as Error).message, tile: t.id }, 'tile poll failed'));
    run();
    setInterval(run, t.pollSeconds * 1000).unref();
  }
}

/** What the UI may see: never the token, password or internal URL. */
export function publicTiles() {
  return cfg.tiles.map((t) => ({
    id: t.id, kind: t.kind, name: t.name, link: t.publicUrl || undefined, group: t.group || undefined,
    ...(results.get(t.id) ?? { state: 'pending', ms: null, at: null }),
  }));
}

export function registerTiles(app: FastifyInstance) {
  app.get('/api/tiles', async () => publicTiles());
  app.post<{ Params: { id: string } }>('/api/tiles/:id/refresh', async (req) => {
    const t = cfg.tiles.find((x) => x.id === req.params.id);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'No such tile');
    await pollTile(t);
    return publicTiles().find((x) => x.id === t.id);
  });
}
