// Push alerts to every configured channel (ntfy, Gotify, Discord, Slack, Telegram, e-mail, Apprise, webhook; see
// channels.ts). Fed by logEvent() (every warn/error and recovery) plus a watcher for
// host resources, failed Proxmox tasks, disk health and stopped PVE services.
import type { FastifyInstance } from 'fastify';
import { crowdsecWatch } from './crowdsec.js';
import { CHANNELS, anyChannelConfigured, channelById } from './channels.js';
import type { Level, Msg } from './channels.js';
import { cfg, pveConfigured } from './config.js';
import { getState, setState } from './db.js';
import type { EventRow } from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { recentHardwareErrors } from './diagnostics.js';
import { logEvent } from './events.js';
import { pve } from './proxmox.js';

export const CATEGORIES = ['monitor', 'guest', 'host', 'resources', 'tasks', 'gpu', 'hardware', 'disks', 'services', 'crowdsec', 'db', 'app', 'auth'] as const;
type Category = (typeof CATEGORIES)[number];
interface ChannelPref { enabled: boolean; minLevel: Level }
interface Settings { enabled: boolean; categories: Record<Category, boolean>; recoveries: boolean; mutedUntil: string | null; channels: Record<string, ChannelPref> }
// E-mail defaults to warnings and errors only so recovery notices do not fill an inbox; everything else gets everything.
const defaultPref = (id: string): ChannelPref => ({ enabled: true, minLevel: id === 'email' ? 'warn' : 'info' });
const DEFAULTS: Settings = {
  enabled: true, categories: Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<Category, boolean>, recoveries: true, mutedUntil: null,
  channels: Object.fromEntries(CHANNELS.map((c) => [c.id, defaultPref(c.id)])),
};
const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };
const isLevel = (v: unknown): v is Level => v === 'info' || v === 'warn' || v === 'error';

let settings: Settings = DEFAULTS;
interface Delivery { channel: string; ok: boolean; error?: string }
interface Sent { ts: string; title: string; message: string; priority: number; category: Category; ok: boolean; error?: string; deliveries: Delivery[] }
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

/** Channels that should receive a message of this level right now. */
const targetsFor = (level: Level) => CHANNELS.filter((c) => c.configured() && (settings.channels[c.id] ?? defaultPref(c.id)).enabled && RANK[level] >= RANK[(settings.channels[c.id] ?? defaultPref(c.id)).minLevel]);

/** Delivers to the given channels in parallel; one failing channel never blocks the others. */
async function deliver(channels: typeof CHANNELS, m: Msg): Promise<Delivery[]> {
  const results = await Promise.allSettled(channels.map((c) => c.send(m)));
  return results.map((r, i) => (r.status === 'fulfilled' ? { channel: channels[i].id, ok: true } : { channel: channels[i].id, ok: false, error: (r.reason as Error).message }));
}

const record = (rec: Omit<Sent, 'ok' | 'error'> & { deliveries: Delivery[] }) => {
  const failed = rec.deliveries.filter((d) => !d.ok);
  sent.unshift({ ...rec, ok: failed.length === 0, ...(failed.length ? { error: failed.map((d) => `${d.channel}: ${d.error}`).join(' · ') } : {}) });
  if (sent.length > 100) sent.pop();
};

/** Queue one alert. Duplicate keys within 10 minutes and anything past the hourly cap are dropped. */
export function alert(category: Category, level: EventRow['level'], title: string, message: string, key = `${category}|${title}|${message}`) {
  if (!anyChannelConfigured() || !settings.enabled || !settings.categories[category]) return;
  if (level === 'info' && !settings.recoveries) return;
  if (settings.mutedUntil && new Date(settings.mutedUntil).getTime() > Date.now()) return;
  const targets = targetsFor(level);
  if (!targets.length) return;
  const now = Date.now();
  if ((lastByKey.get(key) ?? 0) > now - DEDUPE_MS) return;
  if (now - hourStart > 3600_000) { hourStart = now; hourCount = 0; }
  if (++hourCount > MAX_PER_HOUR) return;
  lastByKey.set(key, now);
  const priority = level === 'error' ? 5 : level === 'warn' ? 4 : 2;
  const tags = level === 'error' ? ['rotating_light'] : level === 'warn' ? ['warning'] : ['white_check_mark'];
  const msg: Msg = { title, message, level, category, priority, tags, clickUrl: cfg.ntfy.clickUrl || undefined };
  void deliver(targets, msg).then((deliveries) => record({ ts: new Date().toISOString(), title, message, priority, category, deliveries }));
}

const TITLES: Record<EventRow['source'], string> = { app: 'Dashboard', db: 'Database', host: 'Proxmox host', guest: 'Guest', monitor: 'Uptime monitor', auth: 'Sign-in' };
/** Called by logEvent for every system event. */
export function alertFromEvent(level: EventRow['level'], source: EventRow['source'], message: string) {
  if (level === 'info') {
    // Only recoveries are worth a push; routine info (starts, requested guest actions) is not.
    const recovery = /reachable again|down → up$/.test(message);
    if (!recovery) return;
  }
  if (source === 'monitor' && level === 'warn') return; // pending = Kuma retrying; the down that may follow is what matters
  const title = `${level === 'error' ? 'DOWN' : level === 'warn' ? 'Warning' : 'Recovered'} · ${TITLES[source]}`;
  alert(source, level, title, message);
}

// ---- watcher: thresholds and health Proxmox only exposes by polling ----
const over = new Map<string, number>(); // metric → first time seen over threshold
const raised = new Set<string>();
let seenTasks = new Set<string>();
let kernelSince = new Date().toISOString();
let firstTaskPoll = true;

function threshold(key: string, label: string, value: number, limit: number, text: string) {
  const now = Date.now();
  if (value >= limit) {
    if (!over.has(key)) over.set(key, now);
    if (now - over.get(key)! >= 5 * 60_000 && !raised.has(key)) {
      raised.add(key);
      logEvent('warn', 'host', `${label} high: ${text}`);
      alert('resources', 'warn', `High ${label} on ${cfg.pveNode}`, `${text} for over 5 minutes`, `res|${key}`);
    }
  } else if (value < limit - 0.05) {
    over.delete(key);
    if (raised.delete(key)) alert('resources', 'info', `${label} back to normal on ${cfg.pveNode}`, text, `res|${key}|ok`);
  }
}
const pct = (f: number) => `${(f * 100).toFixed(0)}%`;

async function watch() {
  if (!pveConfigured()) return;
  const n = `/nodes/${encodeURIComponent(cfg.pveNode)}`;
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
    threshold('cpu', 'CPU', Number(s.cpu ?? 0), cfg.ntfy.cpuLimit, `CPU at ${pct(Number(s.cpu ?? 0))}`);
    threshold('mem', 'memory', mem, cfg.ntfy.memLimit, `RAM at ${pct(mem)}`);
    threshold('disk', 'disk usage', root, cfg.ntfy.diskLimit, `root filesystem at ${pct(root)}`);
  }
  if (tasks.status === 'fulfilled') {
    const ids = new Set(tasks.value.map((t) => String(t.upid)));
    for (const t of tasks.value) {
      if (firstTaskPoll || seenTasks.has(t.upid) || !t.endtime || t.status === 'OK') continue;
      const what = `${t.type}${t.id ? ` ${t.id}` : ''}`;
      logEvent('error', 'host', `Proxmox task failed: ${what}: ${t.status}`, { upid: t.upid });
      alert('tasks', 'error', `Task failed · ${what}`, `${t.status} (by ${t.user})`, `task|${t.upid}`);
    }
    seenTasks = ids;
    firstTaskPoll = false;
  }
  if (disks.status === 'fulfilled') {
    for (const d of disks.value) {
      const h = String(d.health ?? 'UNKNOWN');
      if (h !== 'PASSED' && h !== 'OK' && h !== 'UNKNOWN') alert('disks', 'error', `Disk health ${h}`, `${d.devpath} (${d.model ?? 'disk'}) reports S.M.A.R.T. ${h}`, `disk|${d.devpath}|${h}`);
      if (typeof d.wearout === 'number' && d.wearout <= 10) alert('disks', 'warn', 'SSD nearly worn out', `${d.devpath} has ${d.wearout}% life left`, `wear|${d.devpath}`);
    }
  }
  // Kernel lines since the previous poll: GPU passthrough faults, PCIe AER, MCE, I/O errors, OOM kills.
  const from = kernelSince;
  kernelSince = new Date().toISOString();
  for (const l of await recentHardwareErrors(from)) {
    const cat: Category = l.kind === 'gpu' ? 'gpu' : l.kind === 'oom' ? 'guest' : 'hardware';
    const title = l.kind === 'gpu' ? 'GPU / passthrough error' : l.kind === 'oom' ? 'Out-of-memory kill' : l.kind === 'crash' ? 'Process crash' : 'Hardware error';
    // Key on the message minus numbers so a burst of near-identical lines is one alert.
    alert(cat, 'error', `${title} on ${cfg.pveNode}`, l.message.slice(0, 400), `k|${l.kind}|${l.message.replace(/\d+/g, '#').slice(0, 120)}`);
  }
  if (services.status === 'fulfilled') {
    for (const s of services.value) {
      const name = String(s.name ?? s.service);
      const key = `svc|${name}`;
      const down = s['unit-state'] === 'enabled' && s.state !== 'running';
      if (down && !raised.has(key)) { raised.add(key); logEvent('error', 'host', `Service ${name} is ${s.state}`); alert('services', 'error', `Service down · ${name}`, `${s.desc ?? name} is ${s.state} on ${cfg.pveNode}`, key); }
      else if (!down && raised.delete(key)) { logEvent('info', 'host', `Service ${name} running again`); alert('services', 'info', `Service recovered · ${name}`, `${name} is running again`, `${key}|ok`); }
    }
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
  const channelInfo = () => CHANNELS.map((c) => {
    const pref = settings.channels[c.id] ?? defaultPref(c.id);
    const configured = c.configured();
    return { id: c.id, label: c.label, needs: c.needs, configured, target: configured ? c.target() : '', enabled: pref.enabled, minLevel: pref.minLevel };
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
    const msg: Msg = { title: 'homedash test', message: `Test notification sent by ${who}. If you can read this, alerts reach this channel.`, level: 'info', category: 'app', priority: 3, tags: ['bell'], clickUrl: cfg.ntfy.clickUrl || undefined };
    const deliveries = await deliver(targets, msg);
    record({ ts: new Date().toISOString(), title: 'homedash test', message: 'Test notification', priority: 3, category: 'app', deliveries });
    req.log.info({ user: who, channels: deliveries.map((d) => `${d.channel}:${d.ok ? 'ok' : 'fail'}`) }, 'notify test');
    return { ok: deliveries.every((d) => d.ok), deliveries };
  });
}
