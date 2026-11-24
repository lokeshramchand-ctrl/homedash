import type { FastifyInstance } from 'fastify';
import { aiConfigured, cfg, crowdsecConfigured, dataConfigured, gpuWatchConfigured, llamaConfigured, grafanaConfigured, kumaConfigured, lokiConfigured, ntfyConfigured, oidcConfigured, pveConfigured } from './config.js';

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
    ai: aiConfigured(),
    sso: oidcConfigured(),
    nginxManage: cfg.nginxManage,
    metrics: !!cfg.metricsToken,
  };
}

export function registerFeatures(app: FastifyInstance) {
  app.get('/api/features', async () => features());
}
