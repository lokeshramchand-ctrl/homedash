// Kuma and Grafana are read by older modules straight from `cfg` (embeds, the PromQL proxy, the Kuma scraper). A source saved in
// the UI therefore works by filling `cfg` at runtime, so those modules keep working without a restart. Anything set in YAML or the
// environment at start is never overwritten: it wins, and a UI source of the same kind is shown as shadowed.
import { cfg, grafanaConfigured, kumaConfigured } from '../config.js';
import type { LoadedSource } from './store.js';

/** What was configured before any UI source existed. Evaluated once, when this module is first loaded at start-up. */
export const BOOT = { kuma: kumaConfigured(), grafana: grafanaConfigured() };

const trim = (u: string | undefined) => (u ?? '').trim().replace(/\/+$/, '');

export interface RuntimeTarget {
  kumaUrl: string; kumaApiKey: string;
  grafanaUrl: string; grafanaPublicUrl: string; grafanaToken: string; grafanaDsUid: string;
}

/** True when YAML/env already provides this kind, so a UI source of that kind is ignored. */
export const isShadowed = (kind: string, boot = BOOT): boolean => (kind === 'kuma' && boot.kuma) || (kind === 'grafana' && boot.grafana);

/**
 * Applies the first enabled UI source of each kind to the target (the real `cfg` by default) and clears what a removed or
 * disabled source had set. Returns what changed so the caller can start the Kuma scraper after the first Kuma source.
 */
export function applyRuntimeConfig(sources: LoadedSource[], target: RuntimeTarget = cfg as RuntimeTarget, boot = BOOT): { kumaChanged: boolean; grafanaChanged: boolean } {
  const before = JSON.stringify(target);
  if (!boot.kuma) {
    const k = sources.find((s) => s.kind === 'kuma' && s.enabled);
    target.kumaUrl = trim(k?.config.url);
    target.kumaApiKey = k?.secrets.api_key ?? '';
  }
  if (!boot.grafana) {
    const g = sources.find((s) => s.kind === 'grafana' && s.enabled);
    target.grafanaUrl = trim(g?.config.url);
    target.grafanaPublicUrl = trim(g?.config.public_url) || target.grafanaUrl;
    target.grafanaToken = g?.secrets.token ?? '';
    target.grafanaDsUid = g?.config.datasource_uid ?? '';
  }
  const after = JSON.stringify(target);
  const pick = (t: string) => { const o = JSON.parse(t); return { k: [o.kumaUrl, o.kumaApiKey], g: [o.grafanaUrl, o.grafanaPublicUrl, o.grafanaToken, o.grafanaDsUid] }; };
  const a = pick(before), b = pick(after);
  return { kumaChanged: JSON.stringify(a.k) !== JSON.stringify(b.k), grafanaChanged: JSON.stringify(a.g) !== JSON.stringify(b.g) };
}
