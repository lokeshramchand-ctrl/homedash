// Which Proxmox cluster and node the dashboard is looking at. Kept in localStorage so a reload keeps the choice, and sent
// with every API call (X-Cluster / X-Node). An empty cluster means "the server's first cluster".
const CLUSTER = 'hd-cluster';
const nodeKey = (cluster: string) => `hd-node:${cluster}`;
const read = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const write = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage unavailable */ } };

export const selectedCluster = () => read(CLUSTER);
export const selectedNode = () => read(nodeKey(selectedCluster()));

/** Switch cluster and/or node. The node choice is remembered per cluster. */
export function select(cluster: string, node = '') {
  write(CLUSTER, cluster);
  write(nodeKey(cluster), node);
  window.dispatchEvent(new CustomEvent('cluster:changed'));
}
