// Push alerts to every configured channel (ntfy, Gotify, Discord, Slack, Telegram, e-mail, Apprise, webhook; see
// channels.ts). Fed by logEvent() (every warn/error and recovery) plus a watcher for
// host resources, failed Proxmox tasks, disk health and stopped PVE services.
import type { FastifyInstance } from 'fastify';
import { crowdsecWatch } from './crowdsec.js';
import { registerAlertRules, routeChannels, silenceFor } from './alertrules.js';
import { CHANNELS, anyChannelConfigured, channelById } from './channels.js';
import type { Level, Msg } from './channels.js';
import { forEachCluster, multiCluster, nodePath, where } from './clusters.js';
import type { Cluster } from './clusters.js';
import { cfg, pveConfigured } from './config.js';
import { getState, setState } from './db.js';
import type { EventRow } from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { haState } from './ha.js';
import { lastUpkeep, readUpkeep } from './maintenance.js';
import type { Problem } from './maintenance.js';
import { recentHardwareErrors, remoteHardwareErrors } from './diagnostics.js';
import { logEvent } from './events.js';
import { pve } from './proxmox.js';

export const CATEGORIES = ['monitor', 'guest', 'host', 'resources', 'tasks', 'gpu', 'hardware', 'disks', 'services', 'crowdsec', 'db', 'app', 'auth'] as const;
type Category = (typeof CATEGORIES)[number];
interface ChannelPref { enabled: boolean; minLevel: Level }
interface Settings { enabled: boolean; categories: Record<Category, boolean>; recoveries: boolean; mutedUntil: string | null; channels: Record<string, ChannelPref> }
// E-mail defaults to warnings and errors, incident tools (they page someone) to errors only; everything else gets everything.
const defaultPref = (id: string): ChannelPref => ({ enabled: true, minLevel: id === 'email' ? 'warn' : CHANNELS.find((c) => c.id === id)?.incident ? 'error' : 'info' });
const DEFAULTS: Settings = {
  enabled: true, categories: Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<Category, boolean>, recoveries: true, mutedUntil: null,
  channels: Object.fromEntries(CHANNELS.map((c) => [c.id, defaultPref(c.id)])),
};
const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };
const isLevel = (v: unknown): v is Level => v === 'info' || v === 'warn' || v === 'error';

let settings: Settings = DEFAULTS;
interface Delivery { channel: string; ok: boolean; error?: string }
interface Sent { ts: string; title: string; message: string; priority: number; category: Category; ok: boolean; error?: string; deliveries: Delivery[]; silencedBy?: string; routedBy?: string[]; resolve?: boolean }
const sent: Sent[] = [];
const lastByKey = new Map<string, number>();
let hourStart = Date.now(), hourCount = 0;
const DEDUPE_MS = 10 * 60_000, MAX_PER_HOUR = 40;

async function loadSettings() {
  try {
    const v = getState('notify-settings') as Partial<Settings> | undefined;
    if (v) settings = { ...DEFAULTS, ...v, categories: { ...DEFAULTS.categories, ...(v.categories ?? {}) }, channels: { ...DEFAULTS.channels, ...(v.channels ?? {}) } };
  } catch { /* keep defaults if the database is unavailable */ }
}

/**
 * Channels that should receive this message right now. A matching route decides (its own level filter applies);
 * with no matching route each channel's own on/off and minimum level decide. Incident tools always get recoveries,
 * otherwise their incidents would stay open.
 */
function targetsFor(level: Level, route: string[] | null, resolve: boolean) {
  return CHANNELS.filter((c) => {
    if (!c.configured()) return false;
    const pref = settings.channels[c.id] ?? defaultPref(c.id);
    if (!pref.enabled) return false;
    if (route) return route.includes(c.id);
    if (resolve && c.incident) return true;
    return RANK[level] >= RANK[pref.minLevel];
  });
}

/** Delivers to the given channels in parallel; one failing channel never blocks the others. */
async function deliver(channels: typeof CHANNELS, m: Msg): Promise<Delivery[]> {
  const results = await Promise.allSettled(channels.map((c) => c.send(m)));
  return results.map((r, i) => (r.status === 'fulfilled' ? { channel: channels[i].id, ok: true } : { channel: channels[i].id, ok: false, error: (r.reason as Error).message }));
}

const record = (rec: Omit<Sent, 'ok' | 'error'>) => {
  const failed = rec.deliveries.filter((d) => !d.ok);
  sent.unshift({ ...rec, ok: failed.length === 0, ...(failed.length ? { error: failed.map((d) => `${d.channel}: ${d.error}`).join(' · ') } : {}) });
  if (sent.length > 100) sent.pop();
};

/**
 * Queue one alert. Duplicate keys within 10 minutes and anything past the hourly cap are dropped.
 * By convention a recovery uses the problem's key plus "|ok": incident tools (PagerDuty, Opsgenie) close that incident.
 */
export function alert(category: Category, level: EventRow['level'], title: string, message: string, key = `${category}|${title}|${message}`) {
  if (!anyChannelConfigured() || !settings.enabled || !settings.categories[category]) return;
  if (level === 'info' && !settings.recoveries) return;
  if (settings.mutedUntil && new Date(settings.mutedUntil).getTime() > Date.now()) return;
  const resolve = key.endsWith('|ok');
  const dedupKey = resolve ? key.slice(0, -3) : key;
  const now = Date.now();
  if ((lastByKey.get(key) ?? 0) > now - DEDUPE_MS) return;
  const priority = level === 'error' ? 5 : level === 'warn' ? 4 : 2;
  const base = { ts: new Date().toISOString(), title, message, priority, category, resolve };

  // A maintenance window holds the alert back, but it stays visible in the history. Recoveries still reach incident tools.
  const sil = silenceFor(category, title, message);
  const route = routeChannels(category, level, title, message);
  let targets = targetsFor(level, route?.channels ?? null, resolve);
  if (sil) {
    targets = resolve ? targets.filter((c) => c.incident) : [];
    if (!targets.length) { lastByKey.set(key, now); record({ ...base, deliveries: [], silencedBy: sil.name }); return; }
  }
  if (!targets.length) return;
  if (now - hourStart > 3600_000) { hourStart = now; hourCount = 0; }
  if (++hourCount > MAX_PER_HOUR) return;
  lastByKey.set(key, now);
  const tags = level === 'error' ? ['rotating_light'] : level === 'warn' ? ['warning'] : ['white_check_mark'];
  const msg: Msg = { title, message, level, category, priority, tags, clickUrl: cfg.ntfy.clickUrl || undefined, dedupKey, resolve };
  void deliver(targets, msg).then((deliveries) => record({ ...base, deliveries, ...(route ? { routedBy: route.names } : {}) }));
}

const TITLES: Record<EventRow['source'], string> = { app: 'Dashboard', db: 'Database', host: 'Proxmox host', guest: 'Guest', monitor: 'Uptime monitor', auth: 'Sign-in' };
/**
 * A stable key per problem, so a recovery can close the incident its failure opened: one per monitor, one for the
 * Proxmox API. Anything else keeps the old per-message key (it de-duplicates but does not pair).
 */
function eventKey(source: EventRow['source'], level: EventRow['level'], message: string): string | undefined {
  const ok = level === 'info' ? '|ok' : '';
  if (source === 'monitor') { const m = /^(.*): \w+ → \w+$/.exec(message); if (m) return `mon|${m[1]}${ok}`; }
  const cl = /\[([^\]]+)\]/.exec(message)?.[1];
  if (source === 'host' && /^Proxmox API (unreachable|reachable again)/.test(message)) return `pve|api${cl ? `|${cl}` : ''}${ok}`;
  const node = /^Node (.+?) (went offline|is back online)/.exec(message);
  if (source === 'host' && node) return `node|${cl ?? ''}|${node[1]}${ok}`;
  if (source === 'host' && /^Cluster (lost quorum|has quorum again)/.test(message)) return `quorum|${cl ?? ''}${ok}`;
  return undefined;
}

/** Called by logEvent for every system event. */
export function alertFromEvent(level: EventRow['level'], source: EventRow['source'], message: string) {
  if (level === 'info') {
    // Only recoveries are worth a push; routine info (starts, requested guest actions) is not.
    const recovery = /reachable again|down → up$|is back online|has quorum again/.test(message);
    if (!recovery) return;
  }
  if (source === 'monitor' && level === 'warn') return; // pending = Kuma retrying; the down that may follow is what matters
  const title = `${level === 'error' ? 'DOWN' : level === 'warn' ? 'Warning' : 'Recovered'} · ${TITLES[source]}`;
  alert(source, level, title, message, eventKey(source, level, message));
}

// ---- watcher: thresholds and health Proxmox only exposes by polling ----
const over = new Map<string, number>(); // metric → first time seen over threshold
const raised = new Set<string>();
const seenTasks = new Map<string, Set<string>>(); // per cluster node
let kernelSince = new Date().toISOString();

function threshold(key: string, label: string, value: number, limit: number, text: string, place: string) {
  const now = Date.now();
  if (value >= limit) {
    if (!over.has(key)) over.set(key, now);
    if (now - over.get(key)! >= 5 * 60_000 && !raised.has(key)) {
      raised.add(key);
      logEvent('warn', 'host', `${label} high: ${text}`);
      alert('resources', 'warn', `High ${label} on ${place}`, `${text} for over 5 minutes`, `res|${key}`);
    }
  } else if (value < limit - 0.05) {
    over.delete(key);
    if (raised.delete(key)) alert('resources', 'info', `${label} back to normal on ${place}`, text, `res|${key}|ok`);
  }
}
const remoteKernelSince = new Map<string, number>();

// HA manager: fencing, dead agents, services in error / recovery. One alert per problem, one when it clears.
const haRaised = new Map<string, string>();
async function watchHa(c: Cluster) {
  const info = await haState().catch(() => null);
  if (!info) return;
  const now = new Set<string>();
  for (const p of info.problems) {
    const key = `${c.id}|${p.key}`;
    now.add(key);
    if (haRaised.has(key)) continue;
    haRaised.set(key, p.title);
    logEvent(p.level === 'error' ? 'error' : 'warn', 'host', `${p.title}: ${p.text}${multiCluster() ? ` [${c.id}]` : ''}`);
    alert('host', p.level, `${p.title}${multiCluster() ? ` (${c.name})` : ''}`, p.text, `ha|${key}`);
  }
  for (const [key, title] of [...haRaised]) {
    if (!key.startsWith(`${c.id}|`) || now.has(key)) continue;
    haRaised.delete(key);
    logEvent('info', 'host', `HA recovered: ${title}`);
    alert('host', 'info', `Recovered · ${title}`, 'The HA manager reports this is fine again', `ha|${key}|ok`);
  }
}
const CLUSTERS_FIRST = () => cfg.clusters[0] as Cluster | undefined;
const pct = (f: number) => `${(f * 100).toFixed(0)}%`;

/** Every online node of every cluster is checked; state and alert keys are per node. */
async function watch() {
  if (!pveConfigured()) return;
  await forEachCluster(async (c) => {
    const nodes = await pve<{ node: string; status?: string }[]>('GET', '/cluster/resources?type=node').catch(() => []);
    for (const nd of nodes) {
      if (nd.status !== 'online') continue;
      // Kernel errors: the journal of the machine homedash runs on, or the node's journal through the Proxmox API.
      await watchNode(c, nd.node, c === CLUSTERS_FIRST() && nd.node === c.node);
    }
    await watchHa(c);
  });
}

async function watchNode(c: Cluster, node: string, local: boolean) {
  const n = nodePath(node);
  const P = `${c.id}:${node}:`;
  const place = where(node, c);
  const [status, tasks, disks, services] = await Promise.allSettled([
    pve<any>('GET', `${n}/status`),
    pve<any[]>('GET', `${n}/tasks?errors=1&limit=20&source=all`),
    pve<any[]>('GET', `${n}/disks/list`),
    pve<any[]>('GET', `${n}/services`),
  ]);
  if (status.status === 'fulfilled') {
    const s = status.value;
    const mem = s.memory?.total ? s.memory.used / s.memory.total : 0;
    const root = s.rootfs?.total ? s.rootfs.used / s.rootfs.total : 0;
    threshold(`${P}cpu`, 'CPU', Number(s.cpu ?? 0), cfg.ntfy.cpuLimit, `CPU at ${pct(Number(s.cpu ?? 0))}`, place);
    threshold(`${P}mem`, 'memory', mem, cfg.ntfy.memLimit, `RAM at ${pct(mem)}`, place);
    threshold(`${P}disk`, 'disk usage', root, cfg.ntfy.diskLimit, `root filesystem at ${pct(root)}`, place);
  }
  if (tasks.status === 'fulfilled') {
    const ids = new Set(tasks.value.map((t) => String(t.upid)));
    const before = seenTasks.get(P); // undefined on the first look: remember what exists, do not replay history
    for (const t of tasks.value) {
      if (!before || before.has(t.upid) || !t.endtime || t.status === 'OK') continue;
      const what = `${t.type}${t.id ? ` ${t.id}` : ''}`;
      logEvent('error', 'host', `Proxmox task failed: ${what}: ${t.status}`, { upid: t.upid });
      alert('tasks', 'error', `Task failed · ${what}`, `${t.status} (by ${t.user})`, `task|${t.upid}`);
    }
    seenTasks.set(P, ids);
  }
  if (disks.status === 'fulfilled') {
    for (const d of disks.value) {
      const h = String(d.health ?? 'UNKNOWN');
      if (h !== 'PASSED' && h !== 'OK' && h !== 'UNKNOWN') alert('disks', 'error', `Disk health ${h}`, `${d.devpath} (${d.model ?? 'disk'}) on ${place} reports S.M.A.R.T. ${h}`, `disk|${P}${d.devpath}|${h}`);
      if (typeof d.wearout === 'number' && d.wearout <= 10) alert('disks', 'warn', 'SSD nearly worn out', `${d.devpath} has ${d.wearout}% life left on ${place}`, `wear|${P}${d.devpath}`);
    }
  }
  // Kernel lines since the previous poll: GPU passthrough faults, PCIe AER, MCE, I/O errors, OOM kills.
  const from = kernelSince;
  if (local) kernelSince = new Date().toISOString();
  // Other nodes are read through the Proxmox API; the first look only sets the marker so a restart does not replay history.
  let found = local ? await recentHardwareErrors(from) : [];
  if (!local) {
    const last = remoteKernelSince.get(P), now = Date.now();
    remoteKernelSince.set(P, now);
    if (last) found = await remoteHardwareErrors(node, last - 5_000).catch(() => []);
  }
  for (const l of found) {
    const cat: Category = l.kind === 'gpu' ? 'gpu' : l.kind === 'oom' ? 'guest' : 'hardware';
    const title = l.kind === 'gpu' ? 'GPU / passthrough error' : l.kind === 'oom' ? 'Out-of-memory kill' : l.kind === 'crash' ? 'Process crash' : 'Hardware error';
    // Key on the message minus numbers so a burst of near-identical lines is one alert.
    alert(cat, 'error', `${title} on ${place}`, l.message.slice(0, 400), `k|${l.kind}|${l.message.replace(/\d+/g, '#').slice(0, 120)}`);
  }
  if (services.status === 'fulfilled') {
    for (const s of services.value) {
      const name = String(s.name ?? s.service);
      const key = `svc|${P}${name}`;
      const down = s['unit-state'] === 'enabled' && s.state !== 'running';
      if (down && !raised.has(key)) { raised.add(key); logEvent('error', 'host', `Service ${name} is ${s.state} on ${place}`); alert('services', 'error', `Service down · ${name}`, `${s.desc ?? name} is ${s.state} on ${place}`, key); }
      else if (!down && raised.delete(key)) { logEvent('info', 'host', `Service ${name} running again`); alert('services', 'info', `Service recovered · ${name}`, `${name} is running again`, `${key}|ok`); }
    }
  }
  // Pending updates and ZFS pool health: read at most once an hour per node.
  const prev = lastUpkeep(c.id, node);
  if (!prev || Date.now() - prev.checkedAt > 3_600_000) syncProblems(`up|${P}`, 'host', (await readUpkeep(c.id, node, place)).problems);
}

/** Raises one alert per new problem and one recovery when it disappears. `scope` keeps different sources apart. */
const syncRaised = new Map<string, string>();
function syncProblems(scope: string, category: Category, problems: Problem[]) {
  const now = new Set<string>();
  for (const p of problems) {
    const key = `${scope}|${p.key}`;
    now.add(key);
    if (syncRaised.has(key)) continue;
    syncRaised.set(key, p.title);
    logEvent(p.level === 'error' ? 'error' : 'warn', 'host', `${p.title}: ${p.text}`);
    alert(category, p.level, p.title, p.text, key);
  }
  for (const [key, title] of [...syncRaised]) {
    if (!key.startsWith(`${scope}|`) || now.has(key)) continue;
    syncRaised.delete(key);
    logEvent('info', 'host', `Recovered: ${title}`);
    alert(category, 'info', `Recovered · ${title}`, 'No longer reported', `${key}|ok`);
  }
}

// CrowdSec: broken pieces (bouncer or engine silent, snapshot stale) and every new local ban.
const csRaised = new Map<string, string>();
const csSeenBans = new Set<number>();
let csFirst = true;
async function watchCrowdsec() {
  const w = await crowdsecWatch();
  if (w === null) return;
  const now = new Set(w.problems.map((p) => p.key));
  for (const p of w.problems) {
    if (csRaised.has(p.key)) continue;
    csRaised.set(p.key, p.title);
    logEvent(p.level === 'error' ? 'error' : 'warn', 'host', `${p.title}: ${p.text}`);
    alert('crowdsec', p.level, p.title, p.text, `cs|${p.key}`);
  }
  for (const [key, title] of [...csRaised]) {
    if (now.has(key)) continue;
    csRaised.delete(key);
    logEvent('info', 'host', `CrowdSec recovered: ${title}`);
    alert('crowdsec', 'info', `Recovered · ${title}`, 'CrowdSec reports this is fine again', `cs|${key}|ok`);
  }
  // The first look only remembers the bans that already exist, so a restart does not replay them.
  for (const b of w.bans) {
    if (csSeenBans.has(b.id)) continue;
    csSeenBans.add(b.id);
    if (csFirst) continue;
    const mins = Math.round(b.remainingSec / 60);
    alert('crowdsec', 'warn', `CrowdSec banned ${b.ip}`, `${b.scenario.replace('crowdsecurity/', '')}${b.country ? ` from ${b.country}` : ''}${b.asName ? ` (${b.asName})` : ''}, blocked for ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}`, `csban|${b.id}`);
  }
  csFirst = false;
}

export function startNotify(app: FastifyInstance) {
  void loadSettings();
  if (!anyChannelConfigured()) { app.log.warn('no alert channel configured; push alerts disabled'); return; }
  const t = setInterval(() => {
    watch().catch((e) => app.log.warn({ err: (e as Error).message }, 'notify watch failed'));
    watchCrowdsec().catch((e) => app.log.warn({ err: (e as Error).message }, 'crowdsec watch failed'));
  }, 60_000);
  t.unref();
  setTimeout(() => void watch().catch(() => {}), 5_000).unref();
  setTimeout(() => void watchCrowdsec().catch(() => {}), 25_000).unref();
}

export function registerNotify(app: FastifyInstance) {
  registerAlertRules(app, CATEGORIES, CHANNELS.map((c) => c.id));
  const channelInfo = () => CHANNELS.map((c) => {
    const pref = settings.channels[c.id] ?? defaultPref(c.id);
    const configured = c.configured();
    return { id: c.id, label: c.label, needs: c.needs, configured, target: configured ? c.target() : '', enabled: pref.enabled, minLevel: pref.minLevel, incident: !!c.incident };
  });

  app.get('/api/notify', async () => ({
    configured: anyChannelConfigured(),
    channels: channelInfo(),
    server: cfg.ntfy.publicUrl || cfg.ntfy.url,
    topic: cfg.ntfy.topic,
    subscribeUrl: cfg.ntfy.url && cfg.ntfy.topic ? `${cfg.ntfy.publicUrl || cfg.ntfy.url}/${cfg.ntfy.topic}` : '',
    thresholds: { cpu: cfg.ntfy.cpuLimit, mem: cfg.ntfy.memLimit, disk: cfg.ntfy.diskLimit },
    settings, categories: CATEGORIES, sent,
  }));

  app.post<{ Body: Partial<Omit<Settings, 'channels'>> & { channels?: Record<string, Partial<ChannelPref>> } }>('/api/notify/settings', async (req) => {
    const b = req.body ?? {};
    const next: Settings = { ...settings, channels: { ...settings.channels } };
    if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
    if (typeof b.recoveries === 'boolean') next.recoveries = b.recoveries;
    if (b.mutedUntil === null || (typeof b.mutedUntil === 'string' && !Number.isNaN(Date.parse(b.mutedUntil)))) next.mutedUntil = b.mutedUntil;
    if (b.categories && typeof b.categories === 'object') {
      next.categories = { ...next.categories };
      for (const c of CATEGORIES) if (typeof b.categories[c] === 'boolean') next.categories[c] = b.categories[c];
    }
    if (b.channels && typeof b.channels === 'object') {
      for (const [id, p] of Object.entries(b.channels)) {
        if (!channelById(id) || !p || typeof p !== 'object') continue;
        const cur = next.channels[id] ?? defaultPref(id);
        next.channels[id] = { enabled: typeof p.enabled === 'boolean' ? p.enabled : cur.enabled, minLevel: isLevel(p.minLevel) ? p.minLevel : cur.minLevel };
      }
    }
    setState('notify-settings', next as unknown as Record<string, unknown>);
    settings = next;
    req.log.info({ user: req.user?.username }, 'notify settings changed');
    return next;
  });

  // Test one channel (even if muted or filtered out, so you can check credentials) or every enabled one.
  app.post<{ Body: { channel?: string } }>('/api/notify/test', async (req) => {
    const id = req.body?.channel;
    let targets: typeof CHANNELS;
    if (id) {
      const c = channelById(id);
      if (!c) throw new HttpError(404, 'NOT_FOUND', `Unknown channel "${id}"`);
      if (!c.configured()) throw notConfigured(c.label);
      targets = [c];
    } else {
      targets = CHANNELS.filter((c) => c.configured() && (settings.channels[c.id] ?? defaultPref(c.id)).enabled);
      if (!targets.length) throw notConfigured('An alert channel');
    }
    const who = req.user?.username ?? 'admin';
    const msg: Msg = { title: 'homedash test', message: `Test notification sent by ${who}. If you can read this, alerts reach this channel.`, level: 'info', category: 'app', priority: 3, tags: ['bell'], clickUrl: cfg.ntfy.clickUrl || undefined, test: true };
    const deliveries = await deliver(targets, msg);
    record({ ts: new Date().toISOString(), title: 'homedash test', message: 'Test notification', priority: 3, category: 'app', deliveries });
    req.log.info({ user: who, channels: deliveries.map((d) => `${d.channel}:${d.ok ? 'ok' : 'fail'}`) }, 'notify test');
    return { ok: deliveries.every((d) => d.ok), deliveries };
  });
}
