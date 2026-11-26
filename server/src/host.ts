import type { FastifyInstance } from 'fastify';
import { currentCluster, currentNode, nodePath } from './clusters.js';
import { insertAudit } from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { pve } from './proxmox.js';

// Kill switch: gracefully powers off the selected Proxmox node (its guests are shut down first by Proxmox). In a cluster this
// affects only that node; the caller must type the node's name.
export function registerHost(app: FastifyInstance) {
  app.get('/api/host/power', () => ({ enabled: currentCluster().hostPower, node: currentNode() }));

  app.post<{ Body: { confirm?: string } }>('/api/host/shutdown', async (req) => {
    const user = req.user!.username;
    const node = currentNode();
    const base = { ts: Date.now(), user, ip: req.ip, vmid: 0, name: node, action: 'host-shutdown' };
    if (!currentCluster().hostPower) throw notConfigured('Host power control');
    // The caller must type the node name, so a stray or scripted request cannot power the host off.
    if (req.body?.confirm !== node) {
      insertAudit({ ...base, result: 'refused', reason: 'BAD_CONFIRM' });
      req.log.warn({ user }, 'host shutdown refused');
      throw new HttpError(400, 'BAD_CONFIRM', 'Confirmation does not match the node name');
    }
    try {
      const taskId = await pve<string>('POST', `${nodePath(node)}/status`, { command: 'shutdown' });
      insertAudit({ ...base, result: 'accepted', taskId });
      req.log.warn({ user, node }, 'host shutdown requested');
      return { ok: true };
    } catch (e) {
      insertAudit({ ...base, result: 'error', reason: (e as Error).message });
      throw e;
    }
  });
}
