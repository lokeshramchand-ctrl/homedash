// Status tiles: small read-only integrations (Docker, Portainer, Pi-hole, Nginx Proxy Manager, Jellyfin, Home Assistant,
// or any JSON endpoint) declared under `tiles:` in homedash.yaml. Each tile is polled in the background; the Services page
// shows the last result. A tile that stays down raises one alert (category "services") and one recovery.
//
// Adding a provider: write a pure parse function (tested in test/tiles.test.mjs) and one entry in PROVIDERS.
import type { FastifyInstance } from 'fastify';
import { connect } from 'node:net';
import { Agent } from 'undici';
import { cfg } from './config.js';
import type { TileCfg } from './config.js';
import { HttpError } from './errors.js';
import { alert } from './notify.js';
import { TILE_KIND_IDS } from './tile-kinds.js';

export type Tone = 'ok' | 'warn' | 'bad';
export interface Stat { label: string; value: string | number; tone?: Tone }
export interface Probe { status: 'ok' | 'warn'; summary: string; stats: Stat[] }
export interface TileResult extends Partial<Probe> { state: 'ok' | 'warn' | 'down' | 'pending'; ms: number | null; at: number | null; error?: string }

export { TILE_KIND_IDS as TILE_KINDS } from './tile-kinds.js';

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

const kb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB/s` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} kB/s` : `${b} B/s`);

/** Sonarr / Radarr / Lidarr / Prowlarr: status, queue, health messages, and (Sonarr/Radarr) missing items or (Prowlarr) failing indexers. */
export function parseArr(kind: string, status: any, queue?: any, health?: any[], extra?: any): Probe {
  const issues = Array.isArray(health) ? health : [];
  const errors = issues.filter((h) => String(h?.type) === 'error').length, warnings = issues.length - errors;
  const stats: Stat[] = [{ label: 'Version', value: String(status?.version ?? '?') }];
  if (queue) stats.push({ label: 'Queue', value: n(queue.totalRecords) });
  if (kind === 'prowlarr') { const bad = Array.isArray(extra) ? extra.length : 0; stats.push({ label: 'Failing indexers', value: bad, tone: bad ? 'warn' : undefined }); }
  else if (extra) stats.push({ label: 'Missing', value: n(extra.totalRecords) });
  stats.push({ label: 'Health', value: issues.length ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'OK', tone: errors ? 'bad' : warnings ? 'warn' : undefined });
  const failing = kind === 'prowlarr' && Array.isArray(extra) && extra.length > 0;
  return { status: errors || warnings || failing ? 'warn' : 'ok', summary: `${queue ? n(queue.totalRecords) : 0} in queue`, stats };
}

/** qBittorrent: /api/v2/transfer/info and /api/v2/torrents/info. */
export function parseQbit(info: any, torrents: any[]): Probe {
  const list = Array.isArray(torrents) ? torrents : [];
  const st = (re: RegExp) => list.filter((t) => re.test(String(t?.state ?? ''))).length;
  const downloading = st(/^(downloading|forcedDL|metaDL|stalledDL|queuedDL|checkingDL|allocating)$/), seeding = st(/^(uploading|forcedUP|stalledUP|queuedUP|checkingUP)$/), errored = st(/^(error|missingFiles)$/);
  const offline = String(info?.connection_status ?? '') === 'disconnected';
  return {
    status: offline || errored ? 'warn' : 'ok', summary: `↓ ${kb(n(info?.dl_info_speed))} ↑ ${kb(n(info?.up_info_speed))}`,
    stats: [
      { label: 'Download', value: kb(n(info?.dl_info_speed)) }, { label: 'Upload', value: kb(n(info?.up_info_speed)) },
      { label: 'Downloading', value: downloading }, { label: 'Seeding', value: seeding }, { label: 'Errors', value: errored, tone: errored ? 'bad' : undefined },
      { label: 'Network', value: offline ? 'disconnected' : String(info?.connection_status ?? 'ok'), tone: offline ? 'bad' : undefined },
    ],
  };
}

/** Plex: /identity, plus /status/sessions and /library/sections with a token. */
export function parsePlex(identity: any, sessions?: any, sections?: any): Probe {
  const mc = identity?.MediaContainer ?? {};
  const streams = sessions ? n(sessions?.MediaContainer?.size) : null;
  const libs = sections ? n(sections?.MediaContainer?.size) : null;
  return {
    status: 'ok', summary: streams === null ? 'online' : `${streams} stream${streams === 1 ? '' : 's'}`,
    stats: [{ label: 'Version', value: String(mc.version ?? '?') }, ...(streams !== null ? [{ label: 'Streams', value: streams }] : []), ...(libs !== null ? [{ label: 'Libraries', value: libs }] : [])],
  };
}

/** AdGuard Home: /control/status and /control/stats. */
export function parseAdguard(status: any, stats: any): Probe {
  const q = n(stats?.num_dns_queries), b = n(stats?.num_blocked_filtering);
  const off = status?.protection_enabled === false || status?.running === false;
  return {
    status: off ? 'warn' : 'ok', summary: `${q ? ((b / q) * 100).toFixed(1) : '0.0'}% blocked`,
    stats: [
      { label: 'Queries', value: num(q) }, { label: 'Blocked', value: num(b) }, { label: 'Avg time', value: `${(n(stats?.avg_processing_time) * 1000).toFixed(0)} ms` },
      { label: 'Protection', value: off ? 'off' : 'on', tone: off ? 'bad' : undefined }, { label: 'Version', value: String(status?.version ?? '?') },
    ],
  };
}

/** Traefik: /api/overview. */
export function parseTraefik(o: any, version?: any): Probe {
  const r = o?.http?.routers ?? {}, s = o?.http?.services ?? {};
  const err = n(r.errors) + n(s.errors), warn = n(r.warnings) + n(s.warnings);
  return {
    status: err || warn ? 'warn' : 'ok', summary: `${n(r.total)} routers`,
    stats: [
      { label: 'Routers', value: n(r.total) }, { label: 'Services', value: n(s.total) }, { label: 'Middlewares', value: n(o?.http?.middlewares?.total) },
      { label: 'Errors', value: err, tone: err ? 'bad' : undefined }, { label: 'Warnings', value: warn, tone: warn ? 'warn' : undefined },
      ...(version?.Version ? [{ label: 'Version', value: String(version.Version) }] : []),
    ],
  };
}

/** Immich: /api/server/statistics (admin key). */
export function parseImmich(stats: any, about?: any): Probe {
  const gb = (b: number) => `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB`;
  return {
    status: 'ok', summary: `${num(n(stats?.photos))} photos`,
    stats: [{ label: 'Photos', value: num(n(stats?.photos)) }, { label: 'Videos', value: num(n(stats?.videos)) }, { label: 'Storage', value: gb(n(stats?.usage)) }, ...(about?.version ? [{ label: 'Version', value: String(about.version) }] : [])],
  };
}

/** Nextcloud: serverinfo OCS answer. */
export function parseNextcloud(j: any): Probe {
  const d = j?.ocs?.data ?? {};
  const sys = d.nextcloud?.system ?? {}, store = d.nextcloud?.storage ?? {}, users = d.activeUsers ?? {};
  const free = n(sys.freespace);
  return {
    status: 'ok', summary: `${n(users.last24hours)} active today`,
    stats: [
      { label: 'Version', value: String(sys.version ?? '?') }, { label: 'Active 24 h', value: n(users.last24hours) }, { label: 'Users', value: n(store.num_users) },
      { label: 'Files', value: num(n(store.num_files)) }, ...(free ? [{ label: 'Free space', value: `${(free / 1e9).toFixed(0)} GB`, tone: (free < 5e9 ? 'warn' : undefined) as Tone | undefined }] : []),
    ],
  };
}

/** NUT: the text of `LIST VAR <ups>` ("VAR ups battery.charge "100""). */
export function parseNut(text: string): Probe {
  const v: Record<string, string> = {};
  for (const m of text.matchAll(/^VAR \S+ (\S+) "(.*)"$/gm)) v[m[1]] = m[2];
  if (!Object.keys(v).length) throw new Error(/ERR (\S+)/.exec(text)?.[1] ? `NUT: ${/ERR (\S+)/.exec(text)![1]}` : 'NUT answered without variables');
  const flags = (v['ups.status'] ?? '').split(/\s+/).filter(Boolean);
  const onBattery = flags.includes('OB'), low = flags.includes('LB'), charge = v['battery.charge'] ? Number(v['battery.charge']) : null;
  const watts = v['ups.realpower'] ? Number(v['ups.realpower']) : v['ups.power'] ? Number(v['ups.power']) : null;
  const runtime = v['battery.runtime'] ? Math.round(Number(v['battery.runtime']) / 60) : null;
  return {
    status: onBattery || low || (charge !== null && charge < 30) ? 'warn' : 'ok', summary: onBattery ? 'on battery' : flags.includes('OL') ? 'on mains' : flags.join(' ') || 'unknown',
    stats: [
      { label: 'Status', value: onBattery ? (low ? 'on battery, LOW' : 'on battery') : flags.includes('CHRG') ? 'charging' : flags.includes('OL') ? 'online' : flags.join(' ') || '?', tone: low ? 'bad' : onBattery ? 'warn' : undefined },
      ...(charge !== null ? [{ label: 'Battery', value: `${charge}%`, tone: (charge < 30 ? 'bad' : charge < 60 ? 'warn' : undefined) as Tone | undefined }] : []),
      ...(runtime !== null ? [{ label: 'Runtime', value: `${runtime} min` }] : []),
      ...(v['ups.load'] ? [{ label: 'Load', value: `${v['ups.load']}%` }] : []),
      ...(watts !== null && Number.isFinite(watts) ? [{ label: 'Power', value: `${Math.round(watts)} W` }] : []),
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

const basic = (t: TileCfg): Record<string, string> => (t.username || t.password ? { Authorization: `Basic ${Buffer.from(`${t.username}:${t.password}`).toString('base64')}` } : {});
const apiKey = (t: TileCfg): Record<string, string> => ({ 'X-Api-Key': t.token });
const API_V: Record<string, string> = { sonarr: 'v3', radarr: 'v3', lidarr: 'v1', prowlarr: 'v1' };

/** A plain fetch (cookies, form bodies) for providers that do not speak JSON login. */
async function rawCall(t: TileCfg, path: string, init: Init = {}): Promise<Response> {
  return fetch(`${t.url}${path}`, {
    method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(10_000),
    // @ts-expect-error undici dispatcher is not in the DOM fetch typings
    dispatcher: agentFor(t),
  });
}

/** One NUT conversation over TCP: send a command, read until the end marker or an error line. */
function nutAsk(host: string, port: number, cmd: string, endRe: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port });
    let buf = '';
    const done = (e?: Error) => { s.destroy(); e ? reject(e) : resolve(buf); };
    s.setTimeout(8000, () => done(new Error('timed out')));
    s.on('error', (e) => done(e));
    s.on('connect', () => s.write(`${cmd}\n`));
    s.on('data', (d) => { buf += d.toString(); if (endRe.test(buf) || /^ERR /m.test(buf)) done(); });
    s.on('close', () => done());
  });
}

const bearer = (t: TileCfg): Record<string, string> => (t.token ? { Authorization: `Bearer ${t.token}` } : {});

async function arr(t: TileCfg): Promise<Probe> {
  const v = API_V[t.kind], h = apiKey(t);
  const status = await call(t, `/api/${v}/system/status`, { headers: h });
  const [queue, health, extra] = await Promise.all([
    t.kind === 'prowlarr' ? Promise.resolve(undefined) : call(t, `/api/${v}/queue?pageSize=1`, { headers: h }).catch(() => undefined),
    call(t, `/api/${v}/health`, { headers: h }).catch(() => []),
    t.kind === 'prowlarr' ? call(t, `/api/${v}/indexerstatus`, { headers: h }).catch(() => []) : t.kind === 'lidarr' ? Promise.resolve(undefined) : call(t, `/api/${v}/wanted/missing?pageSize=1`, { headers: h }).catch(() => undefined),
  ]);
  return parseArr(t.kind, status, queue, health, extra);
}

const PROVIDERS: Record<string, (t: TileCfg) => Promise<Probe>> = {
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
  sonarr: (t) => arr(t), radarr: (t) => arr(t), lidarr: (t) => arr(t), prowlarr: (t) => arr(t),
  qbittorrent: async (t) => {
    const login = async () => {
      const res = await rawCall(t, '/api/v2/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: t.url }, body: new URLSearchParams({ username: t.username, password: t.password }).toString() });
      const sid = /SID=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
      if (!res.ok || !sid) throw new Error('sign-in rejected (wrong user name or password)');
      return { value: sid, ttlMs: 20 * 60_000 };
    };
    return withSession(t, login, async (sid) => {
      const h = { Cookie: `SID=${sid}`, Referer: t.url };
      const get = async (p: string) => { const r = await rawCall(t, p, { headers: h }); if (r.status === 403) throw new Error('sign-in rejected (HTTP 403)'); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
      const [info, torrents] = await Promise.all([get('/api/v2/transfer/info'), get('/api/v2/torrents/info')]);
      return parseQbit(info, torrents);
    });
  },
  plex: async (t) => {
    const h = { 'X-Plex-Token': t.token };
    const [id, ses, sec] = await Promise.all([call(t, '/identity'), call(t, '/status/sessions', { headers: h }).catch(() => undefined), call(t, '/library/sections', { headers: h }).catch(() => undefined)]);
    return parsePlex(id, ses, sec);
  },
  adguard: async (t) => {
    const h = basic(t);
    const [st, stats] = await Promise.all([call(t, '/control/status', { headers: h }), call(t, '/control/stats', { headers: h })]);
    return parseAdguard(st, stats);
  },
  traefik: async (t) => {
    const h = basic(t);
    const [o, v] = await Promise.all([call(t, '/api/overview', { headers: h }), call(t, '/api/version', { headers: h }).catch(() => undefined)]);
    return parseTraefik(o, v);
  },
  immich: async (t) => {
    const h = { 'x-api-key': t.token };
    const [st, about] = await Promise.all([call(t, '/api/server/statistics', { headers: h }), call(t, '/api/server/about', { headers: h }).catch(() => undefined)]);
    return parseImmich(st, about);
  },
  nextcloud: async (t) => parseNextcloud(await call(t, '/ocs/v2.php/apps/serverinfo/api/v1/info?format=json', { headers: { 'NC-Token': t.token, 'OCS-APIRequest': 'true' } })),
  nut: async (t) => {
    const u = new URL(t.url.replace(/^tcp:/, 'http:'));
    return parseNut(await nutAsk(u.hostname, Number(u.port) || 3493, `LIST VAR ${t.ups || 'ups'}`, /^END LIST VAR/m));
  },
  http: async (t) => {
    if (!t.stats.length) { await call(t, t.path, { headers: bearer(t) }, true); return { status: 'ok', summary: 'responding', stats: [] }; }
    return parseGeneric(await call(t, t.path, { headers: bearer(t) }), t.stats);
  },
};

/** Kinds that have a provider (the tests check this against the catalogue). */
export const PROVIDER_KINDS = Object.keys(PROVIDERS);

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
