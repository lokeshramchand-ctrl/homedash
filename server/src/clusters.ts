// One or more Proxmox clusters (or stand-alone nodes) behind one dashboard.
//
//   - Each cluster has its own API address(es), token, default node and per-cluster settings (protected guests, ...).
//     Several addresses mean failover: if the first cluster member is down, the next one answers (any member of a
//     Proxmox cluster serves the whole cluster API).
//   - Inside a request the selected cluster and node (X-Cluster / X-Node headers, or ?cluster= / ?node=) are held in an
//     AsyncLocalStorage, so existing code that just calls pve() keeps working unchanged against the right cluster.
//   - Background work (watchers, schedules) has no request, so it runs against the first cluster by default and uses
//     forEachCluster() when it must cover all of them.
//
// With nothing configured beyond PVE_URL / PVE_NODE / PVE_TOKEN_* there is exactly one cluster called "default".
import { AsyncLocalStorage } from 'node:async_hooks';
import { cfg } from './config.js';
import type { ClusterCfg } from './config.js';

export type Cluster = ClusterCfg;
export const CLUSTERS: Cluster[] = cfg.clusters;
export const multiCluster = () => CLUSTERS.length > 1;

interface Ctx { cluster: Cluster; node?: string }
const store = new AsyncLocalStorage<Ctx>();

export const findCluster = (id: string | undefined | null): Cluster | undefined => (id ? CLUSTERS.find((c) => c.id === id) : undefined);
export const defaultCluster = (): Cluster => CLUSTERS[0];
export const currentCluster = (): Cluster => store.getStore()?.cluster ?? CLUSTERS[0];
/** The node host-level pages talk to: the one selected in the UI, else the cluster's preferred node. */
export const currentNode = (): string => store.getStore()?.node ?? currentCluster().node;
/** `/nodes/<node>` for the selected node. */
export const hostPath = () => `/nodes/${encodeURIComponent(currentNode())}`;
export const nodePath = (node: string) => `/nodes/${encodeURIComponent(node)}`;

/** Run `fn` with this cluster (and optionally node) as the context. */
export const inCluster = <T,>(c: Cluster, fn: () => T, node?: string): T => store.run({ cluster: c, node }, fn);
/** Start a context for the rest of a request: Fastify hooks pass `done`, so everything after runs inside it. */
export const enterCluster = (c: Cluster, node: string | undefined, done: () => void) => store.run({ cluster: c, node }, done);

/** Run `fn` once per cluster, one after the other; one failing cluster never stops the others. */
export async function forEachCluster(fn: (c: Cluster) => Promise<void>): Promise<void> {
  for (const c of CLUSTERS) {
    try { await store.run({ cluster: c }, () => fn(c)); } catch { /* each caller reports its own failures */ }
  }
}

/** A short label for messages: "node" for one cluster, "cluster/node" when there are several. */
export const where = (node: string, c: Cluster = currentCluster()) => (multiCluster() ? `${c.name}/${node}` : node);

/** The node a Proxmox task ran on: UPID:<node>:<pid>:... */
export const nodeOfTask = (upid: string): string | null => /^UPID:([A-Za-z0-9-]+):/.exec(upid)?.[1] ?? null;
