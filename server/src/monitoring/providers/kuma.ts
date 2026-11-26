// Uptime Kuma as a monitoring provider: reads the snapshot the existing scraper keeps (kuma.ts); it does not scrape again.
import { cfg, kumaConfigured } from '../../config.js';
import { kumaSinceMs, kumaSnapshot, kumaSnapshotAt } from '../../kuma.js';
import type { Scraped } from '../../kuma.js';
import type { Check, Provider } from '../types.js';

const DETAIL: Record<string, string> = { down: 'Monitor is down', pending: 'Monitor is retrying', maintenance: 'Under maintenance', up: '' };

/** Pure: scraped monitors to checks. `sinceOf` says when a monitor that is not up stopped being up. */
export function mapKuma(items: Scraped[], sinceOf: (key: string) => number): Check[] {
  return items.map((i) => ({
    key: i.key, name: i.name, status: i.status, since: i.status === 'up' ? null : sinceOf(i.key),
    detail: DETAIL[i.status] ?? '', url: /^https?:\/\//i.test(i.url) ? i.url : null, ping: i.ping,
  }));
}

/** Pure: is the snapshot recent enough to trust? Returns an error message, or null when fine. */
export function kumaStaleness(snapshotAt: number, now: number, pollMs: number): string | null {
  if (!snapshotAt) return 'Waiting for the first Uptime Kuma scrape';
  if (now - snapshotAt > 3 * pollMs) return 'No recent Uptime Kuma scrape (the last one succeeded more than three poll intervals ago)';
  return null;
}

export const kumaProvider: Provider = {
  kind: 'kuma', label: 'Uptime Kuma',
  // Monitor transitions already alert through noteMonitors in events.ts; raising them here too would alert twice.
  raisesChecks: false,
  configured: kumaConfigured,
  async poll() {
    const bad = kumaStaleness(kumaSnapshotAt(), Date.now(), cfg.kumaPollMs);
    if (bad) throw new Error(bad);
    return { checks: mapKuma(kumaSnapshot(), kumaSinceMs), alerts: [] };
  },
};
