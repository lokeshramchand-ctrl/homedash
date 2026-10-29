import type { FastifyInstance } from 'fastify';
import { cfg, pveConfigured } from './config.js';
import { notConfigured } from './errors.js';
import { logEvent } from './events.js';
import { buildCapacity, buildProtection } from './insights.js';
import { pve } from './proxmox.js';

const node = () => `/nodes/${encodeURIComponent(cfg.pveNode)}`;
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export interface Check { id: string; title: string; status: CheckStatus; detail: string; hint?: string }

type Result = Omit<Check, 'id' | 'title'>;
const ok = (detail: string): Result => ({ status: 'ok', detail });

/** 100 minus 15 per failure and 5 per warning; unknown checks do not count either way. */
export function scoreOf(checks: Pick<Check, 'status'>[]): number {
  const s = 100 - checks.filter((c) => c.status === 'fail').length * 15 - checks.filter((c) => c.status === 'warn').length * 5;
  return Math.max(0, Math.min(100, s));
}

export function certStatus(daysLeft: number): CheckStatus {
  return daysLeft < 14 ? 'fail' : daysLeft < 30 ? 'warn' : 'ok';
}

const CHECKS: { id: string; title: string; run: () => Promise<Result> }[] = [
  {
    id: 'updates', title: 'Pending package updates',
    run: async () => {
      const pkgs = await pve<{ Package: string }[]>('GET', `${node()}/apt/update`);
      if (!pkgs.length) return ok('Everything is up to date');
      return { status: 'warn', detail: `${pkgs.length} package${pkgs.length === 1 ? '' : 's'} can be updated`, hint: 'Node → Updates in the Proxmox UI, or apt update && apt dist-upgrade on the host.' };
    },
  },
  {
    id: 'certificate', title: 'Proxmox web certificate',
    run: async () => {
      const certs = await pve<{ filename: string; notafter?: number }[]>('GET', `${node()}/certificates/info`);
      const soon = certs.filter((c) => c.notafter).map((c) => ({ f: c.filename, days: Math.floor((num(c.notafter) * 1000 - Date.now()) / 86_400_000) })).sort((a, b) => a.days - b.days)[0];
      if (!soon) return { status: 'unknown', detail: 'No certificate information returned' };
      return { status: certStatus(soon.days), detail: soon.days < 0 ? `${soon.f} expired ${-soon.days} days ago` : `${soon.f} expires in ${soon.days} days` };
    },
  },
  {
    id: 'smart', title: 'Disk health (SMART)',
    run: async () => {
      const disks = await pve<{ devpath: string; health?: string; wearout?: number | string; model?: string }[]>('GET', `${node()}/disks/list`);
      const failed = disks.filter((d) => d.health && !['PASSED', 'OK', 'UNKNOWN'].includes(String(d.health).toUpperCase()));
      if (failed.length) return { status: 'fail', detail: failed.map((d) => `${d.devpath} ${d.health}`).join(', '), hint: 'Replace the disk and check backups now.' };
      const worn = disks.filter((d) => typeof d.wearout === 'number' && d.wearout < 20);
      if (worn.length) return { status: 'warn', detail: worn.map((d) => `${d.devpath} ${d.wearout}% life left`).join(', ') };
      return ok(`${disks.length} disk${disks.length === 1 ? '' : 's'} report healthy`);
    },
  },
  {
    id: 'zfs', title: 'ZFS pools',
    run: async () => {
      const pools = await pve<{ name: string; health: string }[]>('GET', `${node()}/disks/zfs`);
      if (!pools.length) return ok('No ZFS pools');
      const bad = pools.filter((p) => p.health !== 'ONLINE');
      return bad.length ? { status: 'fail', detail: bad.map((p) => `${p.name} ${p.health}`).join(', '), hint: 'zpool status -v on the host.' } : ok(`${pools.length} pool${pools.length === 1 ? '' : 's'} online`);
    },
  },
  {
    id: 'services', title: 'Core Proxmox services',
    run: async () => {
      const want = new Set(['pveproxy', 'pvedaemon', 'pvestatd', 'pve-cluster']);
      const svc = await pve<{ service: string; state: string }[]>('GET', `${node()}/services`);
      const down = svc.filter((s) => want.has(s.service) && s.state !== 'running');
      return down.length ? { status: 'fail', detail: `${down.map((s) => s.service).join(', ')} not running` } : ok('pveproxy, pvedaemon, pvestatd and pve-cluster are running');
    },
  },
  {
    id: 'memory', title: 'Host memory and swap',
    run: async () => {
      const n = await pve<any>('GET', `${node()}/status`);
      const mem = num(n.memory?.used) / (num(n.memory?.total) || 1);
      const swap = n.swap?.total ? num(n.swap.used) / num(n.swap.total) : 0;
      const detail = `RAM ${Math.round(mem * 100)}% used, swap ${Math.round(swap * 100)}%`;
      if (mem > 0.95 || swap > 0.7) return { status: 'fail', detail, hint: 'Stop a guest or add memory.' };
      return mem > 0.9 || swap > 0.4 ? { status: 'warn', detail } : ok(detail);
    },
  },
  {
    id: 'tasks', title: 'Failed tasks (24 h)',
    run: async () => {
      const rows = await pve<{ starttime: number; status?: string; type: string }[]>('GET', `${node()}/tasks?errors=1&limit=100`);
      const recent = rows.filter((r) => num(r.starttime) * 1000 > Date.now() - 86_400_000);
      return recent.length ? { status: 'warn', detail: `${recent.length} failed (${[...new Set(recent.map((r) => r.type))].slice(0, 4).join(', ')})`, hint: 'See the Task log.' } : ok('No failed tasks');
    },
  },
  {
    id: 'backups', title: 'Backups',
    run: async () => {
      const p = await buildProtection();
      const { never, stale, notInJob } = p.summary;
      if (never || stale) return { status: never ? 'fail' : 'warn', detail: `${never} guest${never === 1 ? '' : 's'} never backed up, ${stale} older than ${p.maxAgeDays} days`, hint: 'Open Protection for the list.' };
      if (notInJob) return { status: 'warn', detail: `${notInJob} guest${notInJob === 1 ? ' is' : 's are'} not in any backup job`, hint: 'Datacenter → Backup.' };
      return ok(`All ${p.summary.total} guests have a backup newer than ${p.maxAgeDays} days`);
    },
  },
  {
    id: 'capacity', title: 'Storage capacity',
    run: async () => {
      const c = await buildCapacity();
      const full = c.storages.filter((s) => s.usedRatio > 0.9 || (s.daysToFull !== null && s.daysToFull < 14));
      if (full.length) return { status: full.some((s) => s.usedRatio > 0.95 || (s.daysToFull ?? 99) < 7) ? 'fail' : 'warn', detail: full.map((s) => `${s.storage} ${Math.round(s.usedRatio * 100)}%${s.daysToFull !== null ? `, full in ~${s.daysToFull} d` : ''}`).join('; '), hint: 'See Capacity.' };
      return ok(`${c.storages.length} storage${c.storages.length === 1 ? '' : 's'} with room to grow`);
    },
  },
];

let cache: { at: number; value: { score: number; checks: Check[] } } | null = null;
const last = new Map<string, CheckStatus>();
const ANNOUNCE = new Set(['certificate', 'backups', 'capacity', 'updates']); // the other checks already alert via the notifier

export async function runHealth(force = false) {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.value;
  const checks: Check[] = await Promise.all(CHECKS.map(async (c) => {
    try { return { id: c.id, title: c.title, ...(await c.run()) }; } catch (e) {
      const msg = (e as Error).message;
      return { id: c.id, title: c.title, status: 'unknown' as const, detail: /403|permission/i.test(msg) ? 'The API token lacks permission for this check' : msg.slice(0, 160) };
    }
  }));
  for (const c of checks) {
    const prev = last.get(c.id);
    last.set(c.id, c.status);
    if (!ANNOUNCE.has(c.id) || prev === undefined || prev === c.status) continue;
    if (c.status === 'fail' || (c.status === 'warn' && prev === 'ok' && c.id !== 'updates')) logEvent(c.status === 'fail' ? 'error' : 'warn', 'host', `Health: ${c.title}: ${c.detail}`);
    else if (c.status === 'ok') logEvent('info', 'host', `Health recovered: ${c.title}`);
  }
  const value = { score: scoreOf(checks), checks };
  cache = { at: Date.now(), value };
  return value;
}

export function startHealth() {
  if (!pveConfigured()) return;
  setTimeout(() => void runHealth(true).catch(() => {}), 20_000).unref();
  setInterval(() => void runHealth(true).catch(() => {}), 10 * 60_000).unref();
}

export function registerHealth(app: FastifyInstance) {
  app.get('/api/health', async () => {
    if (!pveConfigured()) throw notConfigured('Proxmox');
    return runHealth();
  });
}
