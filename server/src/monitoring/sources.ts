// Which sources the engine reads: Kuma and Grafana from YAML/env or from a UI source (through cfg, see runtime.ts), plus every
// other enabled source saved in the UI. Nothing here imports notify.ts: the notifier-facing watcher lives in watch.ts so there is
// no import cycle.
import type { FastifyInstance } from 'fastify';
import { ensureKuma } from '../kuma.js';
import { createEngine } from './engine.js';
import type { Instance } from './engine.js';
import { grafanaProvider } from './providers/grafana.js';
import { kumaProvider } from './providers/kuma.js';
import { BOOT, applyRuntimeConfig, isShadowed } from './runtime.js';
import { loadSources } from './store.js';
import type { LoadedSource } from './store.js';
import type { Provider } from './types.js';

/** Builds the provider for a saved source of one kind. Kinds are added here as their providers are written. */
type Factory = (s: LoadedSource) => Provider;
export const FACTORIES: Record<string, Factory> = {};

const implicit = (): Instance[] => [
  { id: 'kuma', provider: kumaProvider, managed: BOOT.kuma ? 'config' : 'ui' },
  { id: 'grafana', provider: grafanaProvider, managed: BOOT.grafana ? 'config' : 'ui' },
];

let cached: Instance[] | null = null;

/**
 * Reads the saved sources, applies Kuma and Grafana to the live config, and rebuilds the instance list. Call it after any
 * change to a source, and once at start before the Kuma scraper starts.
 */
export function reloadSources(warn: (m: string) => void = () => {}): LoadedSource[] {
  let loaded: LoadedSource[] = [];
  try { loaded = loadSources(warn); } catch { /* database not connected yet: only config sources exist */ }
  const ch = applyRuntimeConfig(loaded);
  if (ch.kumaChanged) ensureKuma();
  cached = [
    ...implicit(),
    ...loaded.filter((s) => s.enabled && s.kind !== 'kuma' && s.kind !== 'grafana' && !isShadowed(s.kind) && FACTORIES[s.kind]).map((s): Instance => ({
      id: s.id, provider: FACTORIES[s.kind](s), label: s.name, managed: 'ui', intervalS: s.intervalS,
    })),
  ];
  return loaded;
}

export const implicitSources = (): Instance[] => cached ?? (reloadSources(), cached!);

export const monitoringEngine = createEngine(implicitSources);

/** Whether a provider's down checks should raise alerts in the notifier (false for Kuma: it has its own path). */
export const providerRaises = (kind: string): boolean => kind !== 'kuma';

export function registerMonitoring(app: FastifyInstance) {
  app.get('/api/monitoring', async () => monitoringEngine.merged());
}
