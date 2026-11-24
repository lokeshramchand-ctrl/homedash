import type { FastifyInstance } from 'fastify';
import { anyChannelConfigured } from './channels.js';
import { aiConfigured, cfg, crowdsecConfigured, dataConfigured, gpuWatchConfigured, llamaConfigured, grafanaConfigured, kumaConfigured, lokiConfigured, ntfyConfigured, mfaConfigured, passkeysConfigured, scimConfigured, oidcConfigured, pveConfigured } from './config.js';

/** Which optional integrations are switched on, so the UI can hide pages for the ones that are not. */
export function features() {
  return {
    proxmox: pveConfigured(),
    grafana: grafanaConfigured(),
    kuma: kumaConfigured(),
    loki: lokiConfigured(),
    crowdsec: crowdsecConfigured(),
    data: dataConfigured(),
    llama: llamaConfigured(),
    gpuWatch: gpuWatchConfigured(),
    ntfy: ntfyConfigured(),
    alerts: anyChannelConfigured(),
    ai: aiConfigured(),
    sso: oidcConfigured(),
    mfa: mfaConfigured(),
    passkeys: passkeysConfigured(),
    scim: scimConfigured(),
    teams: Object.keys(cfg.access.teams).length > 0,
    approvals: cfg.access.approvals.actions.length > 0,
    nginxManage: cfg.nginxManage,
    metrics: !!cfg.metricsToken,
  };
}

export function registerFeatures(app: FastifyInstance) {
  app.get('/api/features', async () => features());
}
