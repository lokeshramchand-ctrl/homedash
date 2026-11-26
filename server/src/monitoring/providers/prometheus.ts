// Prometheus-compatible servers: alert rules and their active alerts from GET /api/v1/rules?type=alert.
// Field names are those of the Prometheus HTTP API page (docs/research/monitoring-provider-formats.md). Only `firing` is confirmed
// for an alert's state; `pending` is kept, anything else is ignored rather than guessed at.
import type { LoadedSource } from '../store.js';
import type { MonAlert, Polled, Provider } from '../types.js';
import { cap, getJson, levelOf, trimUrl } from './http.js';

const MAX_ALERTS = 500;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Pure: the body of GET /api/v1/rules. One entry per alerting rule that has firing or pending alerts. */
export function parsePromRules(body: unknown): MonAlert[] {
  const out: MonAlert[] = [];
  const groups = asObj(asObj(body).data).groups;
  for (const g of Array.isArray(groups) ? groups : []) {
    const group = asObj(g);
    for (const r of Array.isArray(group.rules) ? group.rules : []) {
      const rule = asObj(r);
      if (rule.type !== 'alerting') continue;
      const alerts = (Array.isArray(rule.alerts) ? rule.alerts : []).map(asObj);
      const firing = alerts.filter((a) => String(a.state).toLowerCase() === 'firing');
      const pending = alerts.filter((a) => String(a.state).toLowerCase() === 'pending');
      const use = firing.length ? firing : pending;
      if (!use.length) continue;
      const times = use.map((a) => Date.parse(String(a.activeAt))).filter((t) => Number.isFinite(t));
      const labels = { ...asObj(use[0].labels), ...asObj(rule.labels) };
      const ann = { ...asObj(use[0].annotations), ...asObj(rule.annotations) };
      const name = cap(rule.name, 200) || 'Unnamed alert rule';
      out.push({
        key: `${cap(group.file, 200)}/${cap(group.name, 200)}/${name}`, name, level: levelOf(labels.severity), state: firing.length ? 'firing' : 'pending',
        since: times.length ? Math.min(...times) : null, summary: (cap(ann.summary, 300) || cap(ann.description, 300)), instances: use.length, url: null,
      });
      if (out.length >= MAX_ALERTS) return out;
    }
  }
  return out;
}

export const prometheusProvider = (s: LoadedSource): Provider => ({
  kind: 'prometheus', label: s.name, raisesChecks: true, configured: () => !!s.config.url,
  async poll(): Promise<Polled> {
    const body = await getJson(`${trimUrl(s.config.url)}/api/v1/rules?type=alert`, { username: s.config.username, password: s.secrets.password, bearer: s.secrets.bearer_token });
    if ((body as { status?: unknown })?.status !== 'success') throw new Error('The server did not answer like Prometheus (no "status":"success")');
    return { checks: [], alerts: parsePromRules(body) };
  },
});
