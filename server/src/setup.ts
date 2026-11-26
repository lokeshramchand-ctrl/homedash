// GET /api/admin/setup: what is on, what is still worth doing, and the exact YAML to switch each integration on.
import type { FastifyInstance } from 'fastify';
import { anyChannelConfigured } from './channels.js';
import { cfg, mfaConfigured, pveConfigured } from './config.js';
import { countAdmins } from './db.js';
import { features } from './features.js';
import { pve } from './proxmox.js';
import { backupsEnabled } from './selfbackup.js';
import { buildChecks, INTEGRATIONS, progress } from './setup-catalog.js';
import { sealKey } from './tilestore.js';
import { tlsEnabled } from './tls.js';

export function registerSetup(app: FastifyInstance) {
  app.get('/api/admin/setup', async () => {
    let reachable: boolean | null = null;
    if (pveConfigured()) reachable = await pve('GET', '/version').then(() => true, () => false);
    const checks = buildChecks({
      proxmox: pveConfigured(), proxmoxReachable: reachable,
      secureConnection: cfg.cookieSecure || tlsEnabled(),
      mfa: mfaConfigured(), alerts: anyChannelConfigured(), selfBackup: backupsEnabled(),
      secretsKey: !!sealKey(), admins: countAdmins(),
    });
    const f = features() as unknown as Record<string, boolean>;
    return {
      checks, progress: progress(checks),
      integrations: INTEGRATIONS.map((i) => ({ id: i.id, name: i.name, what: i.what, page: i.page ?? null, enabled: !!f[i.feature], snippet: i.snippet, secrets: i.secrets })),
    };
  });
}
