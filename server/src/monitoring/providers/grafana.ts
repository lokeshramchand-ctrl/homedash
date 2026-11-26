// Grafana as a monitoring provider: alert rules that are firing or pending (see grafanaalerts.ts for the route and its caveats).
import { grafanaConfigured } from '../../config.js';
import { grafanaAlerts } from '../../grafanaalerts.js';
import type { GrafanaAlertsInfo } from '../../grafanaalerts.js';
import type { MonAlert, Polled, Provider } from '../types.js';

/** Pure: a Grafana answer to a poll result. A failed read throws; it must never become an empty list. */
export function mapGrafana(info: GrafanaAlertsInfo): Polled {
  if (info.error) throw new Error(info.error);
  const alerts: MonAlert[] = info.alerts.map((a) => ({
    key: a.key, name: a.name, level: a.level, state: a.state, since: a.since, summary: a.summary, instances: a.instances, url: a.url,
  }));
  return { checks: [], alerts };
}

export const grafanaProvider: Provider = {
  kind: 'grafana', label: 'Grafana', raisesChecks: true,
  configured: grafanaConfigured,
  poll: async () => mapGrafana(await grafanaAlerts()),
};
