// Node upkeep that nobody remembers to look at: pending package updates (and whether a kernel is among them), and the
// health of ZFS pools. Read through the Proxmox API (needs Sys.Audit on the node). The notifier turns `problems` into
// alerts; the Cluster page shows the same snapshot.
import type { FastifyInstance } from 'fastify';
import { currentCluster, nodePath } from './clusters.js';
import { pve } from './proxmox.js';

export interface Problem { key: string; level: 'error' | 'warn'; title: string; text: string }
export interface Upkeep {
  node: string; checkedAt: number;
  updates: { total: number; kernel: boolean; proxmox: number; sample: string[] } | null;
  pools: { name: string; health: string; size: number; free: number; frag: number | null }[] | null;
  problems: Problem[];
}

const KERNEL = /^(pve-kernel|proxmox-kernel)-/;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Pure: GET /nodes/{n}/apt/update. */
export function parseApt(list: any[]): NonNullable<Upkeep['updates']> {
  const pk = (Array.isArray(list) ? list : []).map((p) => String(p?.Package ?? '')).filter(Boolean);
  return { total: pk.length, kernel: pk.some((p) => KERNEL.test(p)), proxmox: pk.filter((p) => /^(pve-|proxmox-|libpve|qemu-server|lxc-pve)/.test(p)).length, sample: pk.slice(0, 8) };
}

/** Pure: GET /nodes/{n}/disks/zfs. */
export function parseZfs(list: any[]): NonNullable<Upkeep['pools']> {
  return (Array.isArray(list) ? list : []).map((p) => ({
    name: String(p?.name ?? '?'), health: String(p?.health ?? 'UNKNOWN').toUpperCase(), size: num(p?.size), free: num(p?.free), frag: p?.frag === undefined ? null : num(p.frag),
  }));
}

/** Pure: what deserves an alert. `limit` is the pending-update count above which a plain warning is raised. */
export function upkeepProblems(node: string, place: string, u: Upkeep['updates'], pools: Upkeep['pools'], limit: number): Problem[] {
  const out: Problem[] = [];
  for (const p of pools ?? []) {
    if (p.health !== 'ONLINE') out.push({ key: `zfs|${node}|${p.name}`, level: p.health === 'DEGRADED' ? 'warn' : 'error', title: `ZFS pool ${p.name} is ${p.health}`, text: `Pool ${p.name} on ${place} reports ${p.health}. Check "zpool status ${p.name}" and replace failing disks before a second one goes.` });
    else if (p.size > 0 && p.free / p.size < 0.1) out.push({ key: `zfsfull|${node}|${p.name}`, level: 'warn', title: `ZFS pool ${p.name} is almost full`, text: `Pool ${p.name} on ${place} has ${((p.free / p.size) * 100).toFixed(0)}% free; ZFS slows down badly above ~80-90% used.` });
  }
  if (u && (u.kernel || u.total >= limit)) {
    out.push({
      key: `apt|${node}`, level: 'warn', title: `Updates pending on ${place}`,
      text: `${u.total} package${u.total === 1 ? '' : 's'} can be upgraded${u.kernel ? ', including a new kernel (a reboot is needed afterwards)' : ''}${u.proxmox ? `, ${u.proxmox} from Proxmox` : ''}. Run: apt update && apt dist-upgrade.`,
    });
  }
  return out;
}

const cache = new Map<string, Upkeep>(); // cluster:node -> last result
const LIMIT = Math.max(1, Number(process.env.UPDATES_ALERT_COUNT) || 30);

/** Reads one node. Each part fails on its own (no permission, no ZFS): a missing part is null, not an error. */
export async function readUpkeep(clusterId: string, node: string, place: string): Promise<Upkeep> {
  const n = nodePath(node);
  const [apt, zfs] = await Promise.all([pve<any[]>('GET', `${n}/apt/update`).catch(() => null), pve<any[]>('GET', `${n}/disks/zfs`).catch(() => null)]);
  const updates = apt ? parseApt(apt) : null, pools = zfs ? parseZfs(zfs) : null;
  const u: Upkeep = { node, checkedAt: Date.now(), updates, pools, problems: upkeepProblems(node, place, updates, pools, LIMIT) };
  cache.set(`${clusterId}:${node}`, u);
  return u;
}

export const lastUpkeep = (clusterId: string, node: string): Upkeep | undefined => cache.get(`${clusterId}:${node}`);

export function registerMaintenance(app: FastifyInstance) {
  app.get('/api/cluster/upkeep', async () => {
    const id = currentCluster().id;
    return [...cache.entries()].filter(([k]) => k.startsWith(`${id}:`)).map(([, v]) => v).sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }));
  });
}
