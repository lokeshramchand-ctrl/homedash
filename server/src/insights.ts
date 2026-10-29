import type { FastifyInstance } from 'fastify';
import { cfg, pveConfigured } from './config.js';
import { notConfigured } from './errors.js';
import { listGuests } from './guests.js';
import type { Guest } from './guests.js';
import { listSites } from './nginx.js';
import { pve } from './proxmox.js';

const node = () => `/nodes/${encodeURIComponent(cfg.pveNode)}`;
const DAY = 86_400_000;
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

/** Maps over items with a small concurrency limit so a 50-guest node does not fire 50 API calls at once. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Network map: every guest's addresses, duplicate IP/MAC detection and nginx upstream cross-check
// ---------------------------------------------------------------------------------------------

export type IpSource = 'agent' | 'runtime' | 'config';
export interface GuestNet { vmid: number; name: string; type: 'lxc' | 'qemu'; status: Guest['status']; ips: { ip: string; source: IpSource }[]; macs: string[]; bridges: string[] }

const isUsableIp = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.');

/** Pulls static addresses, MACs and bridges out of a guest config (net0/ipconfig0 lines). */
export function parseNetConfig(conf: Record<string, unknown>): { ips: string[]; macs: string[]; bridges: string[] } {
  const ips = new Set<string>(), macs = new Set<string>(), bridges = new Set<string>();
  for (const [k, v] of Object.entries(conf)) {
    if (!/^(net|ipconfig)\d+$/.test(k)) continue;
    for (const part of String(v).split(',')) {
      const [key, val] = part.split('=');
      if (!val) continue;
      if (key === 'ip') { const ip = val.split('/')[0]; if (isUsableIp(ip)) ips.add(ip); }
      else if (key === 'hwaddr' || /^(virtio|e1000|rtl8139|vmxnet3|e1000e)$/.test(key)) macs.add(val.toLowerCase());
      else if (key === 'bridge') bridges.add(val);
    }
  }
  return { ips: [...ips], macs: [...macs], bridges: [...bridges] };
}

export function findDuplicates(guests: GuestNet[]): { kind: 'ip' | 'mac'; value: string; guests: { vmid: number; name: string }[] }[] {
  const out: { kind: 'ip' | 'mac'; value: string; guests: { vmid: number; name: string }[] }[] = [];
  for (const kind of ['ip', 'mac'] as const) {
    const seen = new Map<string, Map<number, string>>();
    for (const g of guests) {
      // A stopped guest only counts by its configured address; runtime addresses are what is on the wire now.
      const values = kind === 'ip' ? g.ips.filter((i) => g.status === 'running' || i.source === 'config').map((i) => i.ip) : g.macs;
      for (const v of new Set(values)) {
        if (!seen.has(v)) seen.set(v, new Map());
        seen.get(v)!.set(g.vmid, g.name);
      }
    }
    for (const [value, m] of seen) if (m.size > 1) out.push({ kind, value, guests: [...m].map(([vmid, name]) => ({ vmid, name })) });
  }
  return out;
}

async function guestNet(g: Guest): Promise<GuestNet> {
  const base = `${node()}/${g.type}/${g.vmid}`;
  const ips = new Map<string, IpSource>();
  let macs: string[] = [], bridges: string[] = [];
  try {
    const parsed = parseNetConfig(await pve<Record<string, unknown>>('GET', `${base}/config`));
    macs = parsed.macs; bridges = parsed.bridges;
    parsed.ips.forEach((ip) => ips.set(ip, 'config'));
  } catch { /* config unreadable: runtime addresses may still work */ }
  if (g.status === 'running') {
    try {
      if (g.type === 'lxc') {
        const rows = await pve<{ name: string; inet?: string; hwaddr?: string }[]>('GET', `${base}/interfaces`);
        for (const r of rows) { const ip = r.inet?.split('/')[0]; if (ip && isUsableIp(ip)) ips.set(ip, 'runtime'); if (r.hwaddr) macs.push(r.hwaddr.toLowerCase()); }
      } else {
        const r = await pve<{ result?: { name: string; 'ip-addresses'?: { 'ip-address': string; 'ip-address-type': string }[] }[] }>('GET', `${base}/agent/network-get-interfaces`);
        for (const i of r.result ?? []) for (const a of i['ip-addresses'] ?? []) if (a['ip-address-type'] === 'ipv4' && isUsableIp(a['ip-address'])) ips.set(a['ip-address'], 'agent');
      }
    } catch { /* no agent / not permitted: the config addresses remain */ }
  }
  return { vmid: g.vmid, name: g.name, type: g.type, status: g.status, ips: [...ips].map(([ip, source]) => ({ ip, source })), macs: [...new Set(macs)], bridges };
}

export type SiteIssue = 'ok' | 'guest-stopped' | 'unknown-target' | 'hostname' | 'local';

export function classifyUpstream(upstream: string, byIp: Map<string, GuestNet>): { host: string; port: string; guest: { vmid: number; name: string; status: string } | null; issue: SiteIssue } {
  let host = '', port = '';
  try { const u = new URL(upstream.includes('://') ? upstream : `http://${upstream}`); host = u.hostname; port = u.port; } catch { /* unix socket or variable */ }
  if (!host) return { host: upstream, port, guest: null, issue: 'hostname' };
  if (host === 'localhost' || host.startsWith('127.')) return { host, port, guest: null, issue: 'local' };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { host, port, guest: null, issue: 'hostname' };
  const g = byIp.get(host);
  if (!g) return { host, port, guest: null, issue: 'unknown-target' };
  return { host, port, guest: { vmid: g.vmid, name: g.name, status: g.status }, issue: g.status === 'running' ? 'ok' : 'guest-stopped' };
}

export async function buildNetMap() {
  const guests = await pool(await listGuests(), 6, guestNet);
  const byIp = new Map<string, GuestNet>();
  for (const g of guests) for (const i of g.ips) if (!byIp.has(i.ip) || g.status === 'running') byIp.set(i.ip, g);
  const sites = (await listSites().catch(() => [])).filter((s) => s.upstream).map((s) => ({
    file: s.file, serverName: s.serverNames[0] ?? s.file, upstream: s.upstream!, ...classifyUpstream(s.upstream!, byIp),
  }));
  return { guests, duplicates: findDuplicates(guests), sites };
}

// ---------------------------------------------------------------------------------------------
// Protection: which guests have a recent backup, which have none, and which snapshots are stale
// ---------------------------------------------------------------------------------------------

export interface BackupFile { vmid: number; ctime: number; size: number }
export type Protection = 'ok' | 'stale' | 'never';

export function protectionOf(files: BackupFile[], now: number, maxAgeDays: number): { last: number | null; count: number; bytes: number; status: Protection; ageDays: number | null } {
  if (!files.length) return { last: null, count: 0, bytes: 0, status: 'never', ageDays: null };
  const last = Math.max(...files.map((f) => f.ctime));
  const ageDays = (now - last * 1000) / DAY;
  return { last: last * 1000, count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), status: ageDays > maxAgeDays ? 'stale' : 'ok', ageDays: Math.round(ageDays * 10) / 10 };
}

export async function buildProtection() {
  const now = Date.now();
  const guests = await listGuests();
  const [stores, notBacked] = await Promise.all([
    pve<{ storage: string; active?: number; enabled?: number }[]>('GET', `${node()}/storage?content=backup`).catch(() => []),
    pve<{ vmid: number }[]>('GET', '/cluster/backup-info/not-backed-up').catch(() => null),
  ]);
  const files: BackupFile[] = [];
  const unreadable: string[] = [];
  await pool(stores.filter((s) => s.active !== 0 && s.enabled !== 0), 3, async (s) => {
    try {
      const rows = await pve<{ vmid?: number; ctime?: number; size?: number }[]>('GET', `${node()}/storage/${encodeURIComponent(s.storage)}/content?content=backup`);
      for (const r of rows) if (r.vmid) files.push({ vmid: Number(r.vmid), ctime: num(r.ctime), size: num(r.size) });
    } catch { unreadable.push(s.storage); }
  });
  const notIn = notBacked ? new Set(notBacked.map((n) => Number(n.vmid))) : null;
  const rows = await pool(guests, 6, async (g) => {
    const p = protectionOf(files.filter((f) => f.vmid === g.vmid), now, cfg.backupMaxAgeDays);
    let snaps: { name: string; snaptime?: number }[] = [];
    try { snaps = (await pve<{ name: string; snaptime?: number }[]>('GET', `${node()}/${g.type}/${g.vmid}/snapshot`)).filter((s) => s.name !== 'current'); } catch { /* not permitted */ }
    const times = snaps.map((s) => num(s.snaptime)).filter(Boolean);
    const oldest = times.length ? Math.round(((now - Math.min(...times) * 1000) / DAY) * 10) / 10 : null;
    return {
      vmid: g.vmid, name: g.name, type: g.type, status: g.status,
      backup: p.status, lastBackup: p.last ? new Date(p.last).toISOString() : null, backupAgeDays: p.ageDays, backups: p.count, backupBytes: p.bytes,
      inJob: notIn ? !notIn.has(g.vmid) : null,
      snapshots: snaps.length, oldestSnapshotDays: oldest, oldSnapshot: oldest !== null && oldest > cfg.snapshotMaxAgeDays,
    };
  });
  return {
    maxAgeDays: cfg.backupMaxAgeDays, snapshotMaxAgeDays: cfg.snapshotMaxAgeDays, unreadableStorages: unreadable,
    summary: {
      total: rows.length, ok: rows.filter((r) => r.backup === 'ok').length, stale: rows.filter((r) => r.backup === 'stale').length,
      never: rows.filter((r) => r.backup === 'never').length, notInJob: rows.filter((r) => r.inJob === false).length, oldSnapshots: rows.filter((r) => r.oldSnapshot).length,
    },
    guests: rows,
  };
}

// ---------------------------------------------------------------------------------------------
// Capacity: when each storage fills up, and what still fits in RAM
// ---------------------------------------------------------------------------------------------

/** Least-squares slope of used bytes per day, and the days until the pool is full. */
export function forecast(points: { time: number; used: number }[], total: number): { bytesPerDay: number | null; daysToFull: number | null; trend: 'growing' | 'flat' | 'shrinking' | 'unknown' } {
  if (points.length < 4) return { bytesPerDay: null, daysToFull: null, trend: 'unknown' };
  const n = points.length;
  const t0 = points[0].time;
  const xs = points.map((p) => (p.time - t0) / 86_400), ys = points.map((p) => p.used);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (!den) return { bytesPerDay: null, daysToFull: null, trend: 'unknown' };
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den;
  const noise = total * 0.0005; // under 0.05% of the pool per day is flat
  if (Math.abs(slope) < noise) return { bytesPerDay: Math.round(slope), daysToFull: null, trend: 'flat' };
  if (slope < 0) return { bytesPerDay: Math.round(slope), daysToFull: null, trend: 'shrinking' };
  const free = total - points[n - 1].used;
  return { bytesPerDay: Math.round(slope), daysToFull: free > 0 ? Math.round(free / slope) : 0, trend: 'growing' };
}

export async function buildCapacity() {
  const [stores, status, vms] = await Promise.all([
    pve<any[]>('GET', `${node()}/storage`),
    pve<any>('GET', `${node()}/status`),
    pve<any[]>('GET', '/cluster/resources?type=vm'),
  ]);
  const storages = await pool(stores.filter((s) => num(s.total) > 0 && s.active !== 0), 3, async (s) => {
    let f: ReturnType<typeof forecast> = { bytesPerDay: null, daysToFull: null, trend: 'unknown' };
    try {
      const rows = await pve<any[]>('GET', `${node()}/storage/${encodeURIComponent(s.storage)}/rrddata?timeframe=month&cf=AVERAGE`);
      f = forecast(rows.filter((r) => r.used != null && r.time).map((r) => ({ time: Number(r.time), used: Number(r.used) })), num(s.total));
    } catch { /* no history for this storage */ }
    const total = num(s.total), used = num(s.used);
    return { storage: String(s.storage), type: String(s.type ?? ''), used, total, usedRatio: total ? used / total : 0, ...f };
  });
  const mine = vms.filter((v) => v.node === cfg.pveNode && !v.template && (cfg.allowedVmids.size === 0 || cfg.allowedVmids.has(Number(v.vmid))));
  const memTotal = num(status.memory?.total), memUsed = num(status.memory?.used);
  const cores = num(status.cpuinfo?.cpus);
  const reserve = cfg.memoryReserveMb * 1024 * 1024;
  const running = mine.filter((v) => v.status === 'running');
  const allocMem = running.reduce((a, v) => a + num(v.maxmem), 0);
  const allocCpu = running.reduce((a, v) => a + num(v.maxcpu), 0);
  const available = Math.max(0, memTotal - reserve - allocMem);
  return {
    host: { memTotal, memUsed, reserveBytes: reserve, allocatedMem: allocMem, availableMem: available, cores, allocatedVcpu: allocCpu, vcpuRatio: cores ? Math.round((allocCpu / cores) * 100) / 100 : 0 },
    storages: storages.sort((a, b) => (a.daysToFull ?? 1e9) - (b.daysToFull ?? 1e9)),
    stopped: mine.filter((v) => v.status !== 'running').map((v) => ({
      vmid: Number(v.vmid), name: String(v.name ?? v.vmid), type: String(v.type), maxmem: num(v.maxmem), maxcpu: num(v.maxcpu),
      fits: num(v.maxmem) <= available, shortBy: Math.max(0, num(v.maxmem) - available),
    })).sort((a, b) => a.vmid - b.vmid),
  };
}

export function registerInsights(app: FastifyInstance) {
  const guard = () => { if (!pveConfigured()) throw notConfigured('Proxmox'); };
  app.get('/api/netmap', async () => { guard(); return buildNetMap(); });
  app.get('/api/protection', async () => { guard(); return buildProtection(); });
  app.get('/api/capacity', async () => { guard(); return buildCapacity(); });
}
