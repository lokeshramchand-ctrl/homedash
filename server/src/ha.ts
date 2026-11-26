// High availability: what the HA manager thinks (which node is master, which agents are alive, what each HA service is
// doing) and anything that looks like fencing or a stuck recovery. Read-only. Needs Sys.Audit on /cluster for the token.
import type { FastifyInstance } from 'fastify';
import { currentCluster } from './clusters.js';
import { pveConfigured } from './config.js';
import { pve } from './proxmox.js';

export interface HaNode { node: string; agent: 'active' | 'idle' | 'dead' | 'unknown'; manager: string; attention: boolean }
export interface HaService { sid: string; vmid: number | null; node: string; state: string; requested: string; attention: 'error' | 'warn' | null; reason: string | null }
export interface HaInfo {
  enabled: boolean; quorate: boolean | null; master: string | null; nodes: HaNode[]; services: HaService[];
  problems: { key: string; level: 'error' | 'warn'; title: string; text: string }[];
}

const BAD_STATES: Record<string, [string, 'error' | 'warn']> = {
  error: ['the HA manager gave up on it (check the HA log, then set the request state to disabled and back)', 'error'],
  fence: ['its node is being fenced (powered off by the watchdog so the service can be recovered elsewhere)', 'error'],
  recovery: ['it is being recovered after its node failed', 'warn'],
  freeze: ['it is frozen (the node is in maintenance or its HA agent restarted)', 'warn'],
  unknown: ['the HA manager cannot determine its state', 'warn'],
};

/** Pure: /cluster/ha/status/current (+ manager_status node_status) -> what the page and the alerts need. */
export function parseHa(status: any[], nodeStatus: Record<string, string> = {}): HaInfo {
  const list = Array.isArray(status) ? status : [];
  const q = list.find((r) => r?.type === 'quorum');
  const master = list.find((r) => r?.type === 'master');
  const nodes: HaNode[] = list.filter((r) => r?.type === 'lrm').map((r) => {
    const text = String(r.status ?? '');
    const agent: HaNode['agent'] = /old timestamp|dead/i.test(text) ? 'dead' : /\(active/.test(text) ? 'active' : /\(idle/.test(text) ? 'idle' : 'unknown';
    const manager = nodeStatus[String(r.node)] ?? 'online';
    return { node: String(r.node), agent, manager, attention: agent === 'dead' || manager === 'fence' || manager === 'unknown' || manager === 'gone' };
  }).sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }));
  const services: HaService[] = list.filter((r) => r?.type === 'service').map((r) => {
    const state = String(r.state ?? r.crm_state ?? 'unknown');
    const bad = BAD_STATES[state];
    const sid = String(r.sid ?? String(r.id ?? '').replace(/^service:/, ''));
    const vm = /^(?:vm|ct):(\d+)$/.exec(sid);
    return { sid, vmid: vm ? Number(vm[1]) : null, node: String(r.node ?? ''), state, requested: String(r.request_state ?? ''), attention: bad ? bad[1] : null, reason: bad ? bad[0] : null };
  }).sort((a, b) => a.sid.localeCompare(b.sid, undefined, { numeric: true }));

  const problems: HaInfo['problems'] = [];
  for (const n of nodes) {
    if (n.manager === 'fence') problems.push({ key: `ha|node|${n.node}`, level: 'error', title: `HA fencing ${n.node}`, text: `The HA manager is fencing node ${n.node}; its HA services will be restarted on other nodes.` });
    else if (n.agent === 'dead') problems.push({ key: `ha|node|${n.node}`, level: 'error', title: `HA agent dead on ${n.node}`, text: `The HA local resource manager on ${n.node} has stopped reporting (old timestamp). The node may be down or hung.` });
    else if (n.manager === 'unknown' || n.manager === 'gone') problems.push({ key: `ha|node|${n.node}`, level: 'warn', title: `HA state of ${n.node} is ${n.manager}`, text: `The HA manager lost track of ${n.node} (${n.manager}).` });
  }
  for (const s of services) if (s.attention) problems.push({ key: `ha|svc|${s.sid}`, level: s.attention, title: `HA service ${s.sid} is ${s.state}`, text: `${s.sid} on ${s.node || 'unknown node'}: ${s.reason}.` });
  if (q && q.quorate === 0 && (services.length || nodes.length)) problems.push({ key: 'ha|quorum', level: 'error', title: 'HA without quorum', text: 'The cluster has no quorum, so HA services cannot be managed or recovered.' });

  return { enabled: services.length > 0 || !!master, quorate: q ? q.quorate === 1 : null, master: master ? String(master.node ?? '') || null : null, nodes, services, problems };
}

/** Current HA state of the selected cluster; null when the cluster has no HA (stand-alone node, or no permission). */
export async function haState(): Promise<HaInfo | null> {
  const status = await pve<any[]>('GET', '/cluster/ha/status/current').catch(() => null);
  if (!status) return null;
  const mgr = await pve<any>('GET', '/cluster/ha/status/manager_status').catch(() => null);
  return parseHa(status, mgr?.node_status ?? {});
}

export function registerHa(app: FastifyInstance) {
  app.get('/api/cluster/ha', async () => {
    if (!pveConfigured()) return { available: false, cluster: null };
    const info = await haState();
    return { available: !!info, cluster: currentCluster().id, ...(info ?? {}) };
  });
}
