// Phase 1: the sources are the ones configured in YAML/env. Phase 2 adds sources created in the UI.
// Nothing here imports notify.ts: the notifier-facing watcher lives in watch.ts so there is no import cycle.
import type { FastifyInstance } from 'fastify';
import { createEngine } from './engine.js';
import type { Instance } from './engine.js';
import { grafanaProvider } from './providers/grafana.js';
import { kumaProvider } from './providers/kuma.js';

export const implicitSources = (): Instance[] => [
  { id: 'kuma', provider: kumaProvider },
  { id: 'grafana', provider: grafanaProvider },
];

export const monitoringEngine = createEngine(implicitSources);

/** Whether a provider's down checks should raise alerts in the notifier (false for Kuma: it has its own path). */
export const providerRaises = (kind: string): boolean => implicitSources().find((i) => i.provider.kind === kind)?.provider.raisesChecks ?? false;

export function registerMonitoring(app: FastifyInstance) {
  app.get('/api/monitoring', async () => monitoringEngine.merged());
}
