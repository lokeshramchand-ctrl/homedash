// A webhook source has nothing to poll: the tool pushes to /hooks/monitoring/:id and the receiver (hook.ts) keeps the state.
// This provider only turns that state into checks and alerts. Items nobody refreshed within the source's TTL are not shown.
import { readHookState } from '../store.js';
import type { LoadedSource } from '../store.js';
import type { Check, MonAlert, Polled, Provider, Status } from '../types.js';

const CHECK_STATUS: Record<string, Status> = { up: 'up', down: 'down', pending: 'pending' };

export const webhookProvider = (s: LoadedSource): Provider => ({
  kind: 'webhook', label: s.name, raisesChecks: true, configured: () => true,
  async poll(): Promise<Polled> {
    const checks: Check[] = [], alerts: MonAlert[] = [];
    for (const r of readHookState(s.id, s.ttlHours)) {
      if (r.type === 'alert') alerts.push({ key: r.key, name: r.name, level: r.level, state: 'firing', since: r.since, summary: r.detail, instances: 1, url: r.url });
      else checks.push({ key: r.key, name: r.name, status: CHECK_STATUS[r.status] ?? 'unknown', since: r.status === 'up' ? null : r.since, detail: r.detail, url: r.url });
    }
    return { checks, alerts };
  },
});
