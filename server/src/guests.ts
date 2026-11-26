import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { CLUSTERS, currentCluster, forEachCluster, nodeOfTask, nodePath } from './clusters.js';
import { insertAudit } from './db.js';
import { HttpError } from './errors.js';
import { parseTimeframe, rrdRows, UPID } from './node.js';
import { pve } from './proxmox.js';

export interface Guest {
  vmid: number; name: string; type: 'lxc' | 'qemu'; status: 'running' | 'stopped' | 'paused';
  cpu: number; memUsed: number; memMax: number; uptime: number; protected: boolean; tags: string[]; conflicts: number[]; featured: boolean;
  /** The Proxmox node the guest runs on, and the cluster it belongs to. */
  node: string; cluster: string;
}
export type Action = 'start' | 'shutdown' | 'stop' | 'reboot' | 'reset' | 'suspend' | 'resume';
export const ACTIONS: Action[] = ['start', 'shutdown', 'stop', 'reboot', 'reset', 'suspend', 'resume'];
const QEMU_ONLY: Action[] = ['reset', 'suspend', 'resume'];
// Which current status each action is valid from (paused = a suspended QEMU guest).
const FROM: Record<Action, Guest['status'][]> = {
  start: ['stopped'], shutdown: ['running'], reboot: ['running'], reset: ['running'], suspend: ['running'],
  resume: ['paused'], stop: ['running', 'paused'],
};
// Config keys whose values are secrets even in an admin view. Exact keys, plus a pattern
// for anything that looks credential-bearing (tokens, passwords, keys passed via args, etc.).
const SECRET_KEYS = new Set(['cipassword']);
const SECRET_RE = /(password|passwd|secret|token|apikey|api_key|privkey|private_key|credential)/i;
const isSecretKey = (k: string) => SECRET_KEYS.has(k) || SECRET_RE.test(k);

function map(type: 'lxc' | 'qemu', r: any): Guest {
  const c = currentCluster();
  const vmid = Number(r.vmid);
  const status = r.status === 'running' ? (r.qmpstatus === 'paused' ? 'paused' : 'running') : 'stopped';
  return {
    vmid, name: r.name ?? `${type}-${vmid}`, type, status,
    cpu: Number(r.cpu ?? 0), memUsed: Number(r.mem ?? 0), memMax: Number(r.maxmem ?? 0), uptime: Number(r.uptime ?? 0),
    protected: c.protectedVmids.has(vmid),
    featured: c.featuredVmid === vmid,
    tags: r.tags ? String(r.tags).split(/[;,]/).filter(Boolean) : [],
    conflicts: c.conflicts[vmid] ?? [],
    node: String(r.node ?? c.node), cluster: c.id,
  };
}

// Short-lived cache per cluster: every guest route resolves its vmid through the list, and Proxmox is slow.
const listCache = new Map<string, { at: number; rows: Guest[] }>();
const listInflight = new Map<string, Promise<Guest[]>>();
export const invalidateGuests = () => { listCache.delete(currentCluster().id); };
export async function listGuests(): Promise<Guest[]> {
  const c = currentCluster();
  const hit = listCache.get(c.id);
  if (hit && Date.now() - hit.at < 1500) return hit.rows;
  let p = listInflight.get(c.id);
  if (!p) {
    p = fetchGuests().then((rows) => { listCache.set(c.id, { at: Date.now(), rows }); return rows; }).finally(() => { listInflight.delete(c.id); });
    listInflight.set(c.id, p);
  }
  return p;
}
async function fetchGuests(): Promise<Guest[]> {
  const c = currentCluster();
  // One call lists the guests of every node (on a stand-alone node it lists that node's guests).
  const rows = await pve<any[]>('GET', '/cluster/resources?type=vm');
  return rows
    .filter((r) => (r.type === 'lxc' || r.type === 'qemu') && !r.template)
    .map((r) => map(r.type, r))
    .filter((g) => c.allowedVmids.size === 0 || c.allowedVmids.has(g.vmid))
    .sort((a, b) => a.vmid - b.vmid);
}

/** `/nodes/<node>` for the node a guest currently runs on (falls back to the cluster's preferred node). */
export async function guestNode(vmid: number): Promise<string> {
  const g = (await listGuests().catch(() => [])).find((x) => x.vmid === vmid);
  return nodePath(g?.node ?? currentCluster().node);
}

/** Validates and performs one power action; shared by the guest routes, scenes and schedules. Returns the Proxmox task id. */
export async function performGuestAction(vmid: number, action: Action, user: string, ip: string): Promise<string> {
  const base = { ts: Date.now(), user, ip, vmid, action };
  const refuse = (status: number, code: string, msg: string, name?: string): never => {
    insertAudit({ ...base, name, result: 'refused', reason: code });
    throw new HttpError(status, code, msg);
  };
  const g = (await listGuests()).find((x) => x.vmid === vmid);
  if (!g) return refuse(404, 'NOT_FOUND', `Guest ${vmid} does not exist or is not allowed`);
  if (g.protected) return refuse(403, 'PROTECTED', `Guest ${vmid} (${g.name}) is protected`, g.name);
  if (QEMU_ONLY.includes(action) && g.type !== 'qemu') return refuse(400, 'UNSUPPORTED', `${action} is only available for virtual machines`, g.name);
  if (!FROM[action].includes(g.status)) {
    if (action === 'start') return refuse(409, g.status === 'paused' ? 'PAUSED' : 'ALREADY_RUNNING', g.status === 'paused' ? `${g.name} is suspended; resume it instead` : `${g.name} is already running`, g.name);
    if (action === 'resume') return refuse(409, 'NOT_PAUSED', `${g.name} is not suspended`, g.name);
    return refuse(409, 'NOT_RUNNING', `${g.name} is not running`, g.name);
  }
  try {
    const taskId = await pve<string>('POST', `${nodePath(g.node)}/${g.type}/${vmid}/status/${action}`);
    invalidateGuests();
    insertAudit({ ...base, name: g.name, result: 'accepted', taskId });
    return taskId;
  } catch (e) {
    insertAudit({ ...base, name: g.name, result: 'error', reason: (e as Error).message });
    throw e;
  }
}

const parseVmid = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'BAD_REQUEST', 'Invalid vmid');
  return n;
};

export async function findGuest(v: string): Promise<Guest> {
  const vmid = parseVmid(v);
  const g = (await listGuests()).find((x) => x.vmid === vmid);
  if (!g) throw new HttpError(404, 'NOT_FOUND', `Guest ${vmid} does not exist or is not allowed`);
  return g;
}
export const guestPath = (g: Guest) => `${nodePath(g.node)}/${g.type}/${g.vmid}`;
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

export function registerGuests(app: FastifyInstance) {
  app.get('/api/guests', () => listGuests());

  app.get<{ Params: { vmid: string } }>('/api/guests/:vmid', (req) => findGuest(req.params.vmid));

  app.get<{ Params: { vmid: string } }>('/api/guests/:vmid/status', async (req) => {
    const g = await findGuest(req.params.vmid);
    const s = await pve<any>('GET', `${guestPath(g)}/status/current`);
    return {
      ...g,
      cpus: num(s.cpus), diskUsed: num(s.disk), diskMax: num(s.maxdisk), swapUsed: num(s.swap), swapMax: num(s.maxswap),
      netIn: num(s.netin), netOut: num(s.netout), diskRead: num(s.diskread), diskWrite: num(s.diskwrite),
      pid: s.pid ? num(s.pid) : null, lock: s.lock ? String(s.lock) : null, haManaged: !!s.ha?.managed,
      agent: g.type === 'qemu' ? !!s.agent : null, qmpStatus: s.qmpstatus ? String(s.qmpstatus) : null,
      runningMachine: s['running-machine'] ? String(s['running-machine']) : null, runningQemu: s['running-qemu'] ? String(s['running-qemu']) : null,
    };
  });

  // /pending returns the current config plus any change that applies on the next restart.
  app.get<{ Params: { vmid: string } }>('/api/guests/:vmid/config', async (req) => {
    const g = await findGuest(req.params.vmid);
    const rows = await pve<{ key: string; value?: unknown; pending?: unknown; delete?: number }[]>('GET', `${guestPath(g)}/pending`);
    const show = (k: string, v: unknown) => (v === undefined ? null : isSecretKey(k) ? '••••••' : String(v));
    return rows
      .filter((r) => r.key !== 'digest')
      .map((r) => ({ key: r.key, value: show(r.key, r.value), pending: show(r.key, r.pending), delete: !!r.delete }))
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  });

  app.get<{ Params: { vmid: string }; Querystring: { timeframe?: string } }>('/api/guests/:vmid/rrd', async (req) => {
    const tf = parseTimeframe(req.query.timeframe);
    const g = await findGuest(req.params.vmid);
    const rows = await pve<any[]>('GET', `${guestPath(g)}/rrddata?timeframe=${tf}&cf=AVERAGE`);
    return rrdRows(rows, ['cpu', 'maxcpu', 'mem', 'maxmem', 'disk', 'maxdisk', 'netin', 'netout', 'diskread', 'diskwrite']);
  });

  app.get<{ Params: { vmid: string } }>('/api/guests/:vmid/snapshots', async (req) => {
    const g = await findGuest(req.params.vmid);
    const rows = await pve<any[]>('GET', `${guestPath(g)}/snapshot`);
    return rows.map((r) => ({
      name: String(r.name), parent: r.parent ? String(r.parent) : null, description: String(r.description ?? '').trim(),
      time: r.snaptime ? num(r.snaptime) : null, vmstate: !!r.vmstate, current: r.name === 'current',
    }));
  });

  app.post<{ Params: { vmid: string; action: string } }>('/api/guests/:vmid/:action', async (req) => {
    const action = req.params.action as Action;
    if (!ACTIONS.includes(action)) throw new HttpError(404, 'NOT_FOUND', `Unknown action ${req.params.action}`);
    return { taskId: await performGuestAction(parseVmid(req.params.vmid), action, req.user!.username, req.ip) };
  });

  const SNAP_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,38}$/;
  app.post<{ Params: { vmid: string }; Body: { name?: string; description?: string } }>('/api/guests/:vmid/snapshots', async (req) => {
    const g = await findGuest(req.params.vmid);
    const name = String(req.body?.name ?? `homedash-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
    if (!SNAP_NAME.test(name)) throw new HttpError(400, 'BAD_REQUEST', 'Snapshot name: letters, digits, dash, underscore; must start with a letter');
    const user = req.user!.username;
    const base = { ts: Date.now(), user, ip: req.ip, vmid: g.vmid, name: g.name, action: 'snapshot' };
    try {
      const taskId = await pve<string>('POST', `${guestPath(g)}/snapshot`, { snapname: name, description: String(req.body?.description ?? 'Created by homedash').slice(0, 200) });
      insertAudit({ ...base, result: 'accepted', taskId });
      return { taskId, name };
    } catch (e) { insertAudit({ ...base, result: 'error', reason: (e as Error).message }); throw e; }
  });

  app.delete<{ Params: { vmid: string; name: string } }>('/api/guests/:vmid/snapshots/:name', async (req) => {
    const g = await findGuest(req.params.vmid);
    if (!SNAP_NAME.test(req.params.name)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid snapshot name');
    const user = req.user!.username;
    const base = { ts: Date.now(), user, ip: req.ip, vmid: g.vmid, name: g.name, action: `snapshot-delete:${req.params.name}` };
    if (g.protected) { insertAudit({ ...base, result: 'refused', reason: 'PROTECTED' }); throw new HttpError(403, 'PROTECTED', `Guest ${g.vmid} (${g.name}) is protected`); }
    try {
      const taskId = await pve<string>('DELETE', `${guestPath(g)}/snapshot/${encodeURIComponent(req.params.name)}`);
      insertAudit({ ...base, result: 'accepted', taskId });
      return { taskId };
    } catch (e) { insertAudit({ ...base, result: 'error', reason: (e as Error).message }); throw e; }
  });

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (req) => {
    const id = req.params.taskId;
    if (!UPID.test(id)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid task id');
    // The task id names the node it ran on, which is not necessarily the selected one in a cluster.
    const t = await pve<{ status: string; exitstatus?: string }>('GET', `${nodePath(nodeOfTask(id) ?? currentCluster().node)}/tasks/${encodeURIComponent(id)}/status`);
    if (t.status === 'running') return { status: 'running', message: '' };
    return t.exitstatus === 'OK'
      ? { status: 'ok', message: 'TASK OK' }
      : { status: 'error', message: t.exitstatus ? `TASK ERROR: ${t.exitstatus}` : 'Task failed' };
  });

  // --- SSE: server-side poll of Proxmox, pushed to every open browser tab (every cluster, each event tagged with its cluster) ---
  const clients = new Set<ServerResponse>();
  let last = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const next = new Map<string, string>();
      await forEachCluster(async (c) => {
        for (const g of await listGuests()) {
          const key = `${c.id}:${g.vmid}`;
          next.set(key, g.status);
          if (last.size && last.get(key) !== g.status) {
            const msg = `data: ${JSON.stringify({ type: 'guest', cluster: c.id, vmid: g.vmid, status: g.status })}\n\n`;
            clients.forEach((cl) => cl.write(msg));
          }
        }
      });
      last = next;
      clients.forEach((c) => c.write(': ping\n\n'));
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 'events poll failed');
    } finally {
      busy = false;
    }
  };

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    clients.add(res);
    if (!timer) { last = new Map(); timer = setInterval(() => void tick(), 3000); void tick(); }
    req.raw.on('close', () => {
      clients.delete(res);
      if (!clients.size && timer) { clearInterval(timer); timer = undefined; }
    });
  });
}
