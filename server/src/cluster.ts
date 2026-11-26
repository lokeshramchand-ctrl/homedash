// Cluster-level features: which cluster / node a request is about, the overview of every cluster and its nodes, and
// migrating a guest to another node.
import type { FastifyInstance } from 'fastify';
import { CLUSTERS, currentCluster, defaultCluster, enterCluster, findCluster, inCluster, nodePath } from './clusters.js';
import type { Cluster } from './clusters.js';
import { cfg } from './config.js';
import { HttpError } from './errors.js';
import { blockers, migrationChecks } from './migrate-check.js';
import type { CheckInput } from './migrate-check.js';
import { findGuest, guestPath, invalidateGuests, listGuests } from './guests.js';
import { pve } from './proxmox.js';
import { activeUrl } from './proxmox.js';
import { guard, run } from './qemu.js';
import { decodedPath } from './pathutil.js';

const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

/**
 * Picks the cluster and node for the whole request. The UI sends X-Cluster / X-Node; EventSource (which cannot set
 * headers) uses ?cluster=. No selection means the first cluster and its preferred node, exactly as before there were several.
 * This must be registered before the auth hook, so that authentication and scope checks already see the right cluster.
 */
export function registerClusterContext(app: FastifyInstance) {
  app.addHook('onRequest', (req, _reply, done) => {
    if (!decodedPath(req.url).startsWith('/api/')) return done();
    const q = req.query as { cluster?: string; node?: string };
    const id = String(req.headers['x-cluster'] ?? q?.cluster ?? '');
    const node = String(req.headers['x-node'] ?? q?.node ?? '');
    const cluster = id ? findCluster(id) : defaultCluster();
    if (!cluster) return done(new HttpError(400, 'UNKNOWN_CLUSTER', `No cluster "${id.slice(0, 40)}"`));
    if (node && !NODE_NAME.test(node)) return done(new HttpError(400, 'BAD_REQUEST', 'Invalid node name'));
    return enterCluster(cluster, node || undefined, done);
  });
}

export interface NodeInfo { name: string; online: boolean; local: boolean; cpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; guests: number; running: number }
export interface ClusterInfo {
  id: string; name: string; reachable: boolean; error: string | null; addresses: number; activeAddress: string | null;
  quorate: boolean | null; standalone: boolean; version: string | null; nodes: NodeInfo[]; guests: { total: number; running: number };
}

async function describe(c: Cluster): Promise<ClusterInfo> {
  const base: ClusterInfo = {
    id: c.id, name: c.name, reachable: false, error: null, addresses: c.urls.length, activeAddress: null, quorate: null, standalone: true, version: null, nodes: [], guests: { total: 0, running: 0 },
  };
  try {
    const [status, nodes, version, guests] = await Promise.all([
      pve<any[]>('GET', '/cluster/status').catch(() => [] as any[]),
      pve<any[]>('GET', '/cluster/resources?type=node'),
      pve<any>('GET', '/version').catch(() => null),
      listGuests().catch(() => []),
    ]);
    const clusterRow = status.find((r) => r.type === 'cluster');
    const local = new Set(status.filter((r) => r.type === 'node' && r.local === 1).map((r) => String(r.name)));
    const online = new Map(status.filter((r) => r.type === 'node').map((r) => [String(r.name), r.online === 1]));
    return {
      ...base, reachable: true, activeAddress: activeUrl(c),
      quorate: clusterRow ? clusterRow.quorate === 1 : null, standalone: !clusterRow,
      version: version?.version ? String(version.version) : null,
      nodes: nodes.map((n) => {
        const mine = guests.filter((g) => g.node === n.node);
        return {
          name: String(n.node), online: online.has(String(n.node)) ? !!online.get(String(n.node)) : n.status === 'online', local: local.has(String(n.node)),
          cpu: num(n.cpu), mem: num(n.mem), maxmem: num(n.maxmem), disk: num(n.disk), maxdisk: num(n.maxdisk), uptime: num(n.uptime),
          guests: mine.length, running: mine.filter((g) => g.status === 'running').length,
        };
      }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      guests: { total: guests.length, running: guests.filter((g) => g.status === 'running').length },
    };
  } catch (e) {
    return { ...base, error: (e as Error).message.replace(/^Cannot reach Proxmox[^:]*: /, '').slice(0, 200) };
  }
}


/** Disks, passthrough devices and RAM facts for a guest, as the pre-flight check needs them. */
async function migrationFacts(g: { node: string; type: 'qemu' | 'lxc'; vmid: number; status: string; memMax: number }, withLocalDisks: boolean) {
  const [pre, conf] = await Promise.all([
    pve<any>('GET', `${nodePath(g.node)}/${g.type}/${g.vmid}/migrate`).catch((e: Error) => { throw new HttpError(502, 'PVE_ERROR', e.message); }),
    g.type === 'qemu' ? pve<Record<string, unknown>>('GET', `${nodePath(g.node)}/qemu/${g.vmid}/config`).catch(() => ({} as Record<string, unknown>)) : Promise.resolve({} as Record<string, unknown>),
  ]);
  // hostpciN and usbN (except SPICE redirection) pin a VM to hardware; Proxmox also reports them as local resources.
  const fromConfig = Object.entries(conf).filter(([k, v]) => /^(hostpci|usb)\d+$/.test(k) && !/^spice/.test(String(v))).map(([k]) => k);
  const input: Omit<CheckInput, 'target'> = {
    type: g.type, running: g.status === 'running', withLocalDisks, memMax: g.memMax, reserveBytes: cfg.memoryReserveMb * 1024 * 1024,
    localDisks: (pre?.local_disks ?? []).map((d: any) => ({ volid: String(d.volid), size: num(d.size) })),
    localResources: [...new Set([...(pre?.local_resources ?? []).map(String), ...fromConfig])],
  };
  return { pre, input };
}

export function registerCluster(app: FastifyInstance) {
  // Every cluster at a glance (each queried in parallel, one slow cluster does not hold the others up).
  app.get('/api/clusters', async (req) => {
    const infos = await Promise.all(CLUSTERS.map((c) => inCluster(c, () => describe(c))));
    // A team-scoped person only needs to know which clusters exist, not their nodes.
    const scoped = !!req.user?.scope;
    return { current: currentCluster().id, defaultNode: currentCluster().node, clusters: infos.map((i) => (scoped ? { ...i, nodes: [], activeAddress: null, quorate: null } : i)) };
  });

  // ---- migration ----
  const migratePath = (g: { node: string; type: string; vmid: number }) => `${nodePath(g.node)}/${g.type}/${g.vmid}/migrate`;

  // What a migration would involve: where it may go, and what blocks the other nodes.
  app.get<{ Params: { vmid: string }; Querystring: { withLocalDisks?: string } }>('/api/guests/:vmid/migrate', async (req) => {
    const g = await findGuest(req.params.vmid);
    const withDisks = req.query.withLocalDisks === '1' || req.query.withLocalDisks === 'true';
    const [{ pre, input }, nodes] = await Promise.all([migrationFacts(g, withDisks), pve<any[]>('GET', '/cluster/resources?type=node')]);
    const blocked: Record<string, unknown> = pre?.not_allowed_nodes ?? {};
    return {
      vmid: g.vmid, name: g.name, node: g.node, type: g.type, running: g.status === 'running',
      // lxc containers cannot be live-migrated: a running one is restarted on the target
      mode: g.type === 'qemu' ? (g.status === 'running' ? 'live' : 'offline') : (g.status === 'running' ? 'restart' : 'offline'),
      localDisks: (pre?.local_disks ?? []).map((d: any) => ({ volid: String(d.volid), size: num(d.size) })),
      localResources: (pre?.local_resources ?? []).map(String),
      checks: migrationChecks(input),
      targets: nodes.filter((n) => n.node !== g.node).map((n) => {
        const t = {
          name: String(n.node), online: n.status === 'online', allowed: (pre?.allowed_nodes ?? []).includes(n.node) && n.status === 'online',
          reason: blocked[n.node] ? JSON.stringify(blocked[n.node]).slice(0, 200) : n.status !== 'online' ? 'offline' : null,
        };
        // Target-specific findings only (the guest-level ones are in `checks`).
        const own = migrationChecks({ ...input, localDisks: [], localResources: [], type: 'lxc', running: false, target: { ...t, maxmem: num(n.maxmem), mem: num(n.mem) } }).filter((c) => c.id !== 'lxc-restart');
        return { ...t, checks: own };
      }),
    };
  });

  app.post<{ Params: { vmid: string }; Body: { target?: string; withLocalDisks?: boolean } }>('/api/guests/:vmid/migrate', async (req) => {
    const g = await findGuest(req.params.vmid);
    const target = String(req.body?.target ?? '');
    if (!NODE_NAME.test(target)) throw new HttpError(400, 'BAD_REQUEST', 'Pick a target node');
    if (target === g.node) throw new HttpError(409, 'SAME_NODE', `${g.name} already runs on ${target}`);
    const nodes = await pve<any[]>('GET', '/cluster/resources?type=node');
    const t = nodes.find((n) => n.node === target);
    if (!t) throw new HttpError(404, 'NOT_FOUND', `No node "${target}" in this cluster`);
    if (t.status !== 'online') throw new HttpError(409, 'NODE_OFFLINE', `${target} is offline`);
    // The same pre-flight the dialog showed, enforced here so the API cannot be used to skip it.
    const { pre, input } = await migrationFacts(g, !!req.body?.withLocalDisks);
    const allowed = (pre?.allowed_nodes ?? []).includes(target);
    const found = migrationChecks({ ...input, target: { name: target, online: true, allowed, reason: (pre?.not_allowed_nodes ?? {})[target] ? JSON.stringify(pre.not_allowed_nodes[target]).slice(0, 200) : null, maxmem: num(t.maxmem), mem: num(t.mem) } });
    const stop = blockers(found);
    if (stop.length) throw new HttpError(409, 'PREFLIGHT', stop.map((c) => c.text).join(' '));
    const done = await guard(req, g, 'migrate', { target }); // refuses protected guests and writes the audit row
    const form: Record<string, string> = { target };
    if (g.status === 'running') form[g.type === 'qemu' ? 'online' : 'restart'] = '1';
    if (g.type === 'qemu' && req.body?.withLocalDisks) form['with-local-disks'] = '1';
    return run(done, async () => {
      const taskId = await pve<string>('POST', migratePath(g), form);
      invalidateGuests();
      return taskId;
    });
  });
  void guestPath;
}
