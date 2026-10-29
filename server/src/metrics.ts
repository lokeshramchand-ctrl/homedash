import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { cfg, pveConfigured } from './config.js';
import { countEvents, dbOk } from './db.js';
import { listGuests } from './guests.js';
import { runHealth } from './health.js';
import { buildCapacity, buildProtection } from './insights.js';
import { kumaSnapshot } from './kuma.js';
import { listSites } from './nginx.js';
import { pve } from './proxmox.js';

// Prometheus exposition for Grafana. Scrape with:  Authorization: Bearer $METRICS_TOKEN
// Outside /api on purpose: Prometheus cannot hold a browser session cookie.

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Record<string, string | number>) =>
  Object.keys(l).length ? `{${Object.entries(l).map(([k, v]) => `${k}="${esc(String(v))}"`).join(',')}}` : '';

class Registry {
  private lines: string[] = [];
  private seen = new Set<string>();
  add(name: string, help: string, type: 'gauge' | 'counter', value: number, l: Record<string, string | number> = {}) {
    if (!Number.isFinite(value)) return;
    if (!this.seen.has(name)) {
      this.seen.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    this.lines.push(`${name}${labels(l)} ${value}`);
  }
  text() { return this.lines.join('\n') + '\n'; }
}

const sameToken = (given: string) => {
  const a = Buffer.from(given), b = Buffer.from(cfg.metricsToken);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function registerMetrics(app: FastifyInstance) {
  app.get('/metrics', async (req, reply) => {
    if (!cfg.metricsToken) return reply.code(404).send({ error: 'Metrics are disabled; set METRICS_TOKEN', code: 'NOT_CONFIGURED' });
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!sameToken(bearer)) return reply.code(401).send({ error: 'Invalid metrics token', code: 'UNAUTHENTICATED' });

    const r = new Registry();
    r.add('homedash_up', 'The homedash process is serving requests.', 'gauge', 1);
    r.add('homedash_database_up', 'The SQLite database answers queries.', 'gauge', dbOk() ? 1 : 0);
    try { r.add('homedash_errors_24h', 'Error-level system events in the last 24 hours.', 'gauge', countEvents('error', Date.now() - 86_400_000)); } catch { /* db down */ }

    if (pveConfigured()) {
      const [guests, node] = await Promise.allSettled([listGuests(), pve<any>('GET', `/nodes/${encodeURIComponent(cfg.pveNode)}/status`)]);
      r.add('homedash_proxmox_up', 'The Proxmox API answers.', 'gauge', guests.status === 'fulfilled' ? 1 : 0);
      if (guests.status === 'fulfilled') {
        for (const g of guests.value) {
          const l = { vmid: g.vmid, name: g.name, type: g.type };
          r.add('homedash_guest_running', '1 when the guest is running.', 'gauge', g.status === 'running' ? 1 : 0, l);
          r.add('homedash_guest_cpu_ratio', 'Guest CPU use, 0..1.', 'gauge', g.cpu, l);
          r.add('homedash_guest_memory_used_bytes', 'Guest memory in use.', 'gauge', g.memUsed, l);
          r.add('homedash_guest_memory_max_bytes', 'Guest memory limit.', 'gauge', g.memMax, l);
          r.add('homedash_guest_uptime_seconds', 'Guest uptime.', 'gauge', g.uptime, l);
        }
      }
      if (node.status === 'fulfilled') {
        const n = node.value;
        const l = { node: cfg.pveNode };
        r.add('homedash_host_cpu_ratio', 'Proxmox host CPU use, 0..1.', 'gauge', Number(n.cpu ?? 0), l);
        r.add('homedash_host_memory_used_bytes', 'Proxmox host memory in use.', 'gauge', Number(n.memory?.used ?? 0), l);
        r.add('homedash_host_memory_total_bytes', 'Proxmox host memory installed.', 'gauge', Number(n.memory?.total ?? 0), l);
        r.add('homedash_host_disk_used_bytes', 'Proxmox host root disk used.', 'gauge', Number(n.rootfs?.used ?? 0), l);
        r.add('homedash_host_disk_total_bytes', 'Proxmox host root disk size.', 'gauge', Number(n.rootfs?.total ?? 0), l);
        r.add('homedash_host_uptime_seconds', 'Proxmox host uptime.', 'gauge', Number(n.uptime ?? 0), l);
      }
    }

    if (pveConfigured()) {
      const [health, cap, prot] = await Promise.allSettled([runHealth(), buildCapacity(), buildProtection()]);
      if (health.status === 'fulfilled') r.add('homedash_health_score', 'Overall health score, 0..100.', 'gauge', health.value.score);
      if (cap.status === 'fulfilled') {
        for (const s of cap.value.storages) {
          const l = { storage: s.storage };
          r.add('homedash_storage_used_ratio', 'Storage pool used, 0..1.', 'gauge', s.usedRatio, l);
          if (s.daysToFull !== null) r.add('homedash_storage_days_to_full', 'Forecast days until the storage is full.', 'gauge', s.daysToFull, l);
        }
        r.add('homedash_memory_available_for_guests_bytes', 'RAM not yet promised to running guests (after the host reserve).', 'gauge', cap.value.host.availableMem);
      }
      if (prot.status === 'fulfilled') {
        r.add('homedash_guests_without_backup', 'Guests with no backup at all.', 'gauge', prot.value.summary.never);
        r.add('homedash_guests_stale_backup', 'Guests whose newest backup is too old.', 'gauge', prot.value.summary.stale);
        r.add('homedash_guests_old_snapshots', 'Guests holding a snapshot older than the limit.', 'gauge', prot.value.summary.oldSnapshots);
      }
    }
    for (const m of kumaSnapshot()) {
      const l = { monitor: m.name, type: m.type };
      r.add('homedash_monitor_up', '1 when the Uptime Kuma monitor is up.', 'gauge', m.status === 'up' ? 1 : 0, l);
      if (m.ping != null) r.add('homedash_monitor_response_ms', 'Last response time of the Uptime Kuma monitor.', 'gauge', m.ping, l);
    }
    try { r.add('homedash_nginx_sites', 'nginx server_name entries found.', 'gauge', (await listSites()).length); } catch { /* nginx dir unreadable */ }

    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return r.text();
  });
}
