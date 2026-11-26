// Alertmanager: active alerts from GET /api/v2/alerts (fields from its OpenAPI file; see docs/research/monitoring-provider-formats.md).
import type { LoadedSource } from '../store.js';
import type { MonAlert, Polled, Provider } from '../types.js';
import { cap, getJson, httpUrl, levelOf, trimUrl } from './http.js';

const MAX_ALERTS = 500;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Pure: the array GET /api/v2/alerts returns. Only alerts whose status.state is "active" (not suppressed or unprocessed). */
export function parseAmAlerts(body: unknown): MonAlert[] {
  const out: MonAlert[] = [];
  for (const item of Array.isArray(body) ? body : []) {
    const a = asObj(item);
    if (asObj(a.status).state !== 'active') continue;
    const labels = asObj(a.labels), ann = asObj(a.annotations);
    const t = Date.parse(String(a.startsAt));
    const name = cap(labels.alertname, 200) || 'Alert';
    out.push({
      key: cap(a.fingerprint, 100) || `${name}|${JSON.stringify(labels).slice(0, 200)}`, name, level: levelOf(labels.severity), state: 'firing',
      since: Number.isFinite(t) ? t : null, summary: cap(ann.summary, 300) || cap(ann.description, 300) || cap(ann.message, 300), instances: 1, url: httpUrl(a.generatorURL),
    });
    if (out.length >= MAX_ALERTS) break;
  }
  return out;
}

export const alertmanagerProvider = (s: LoadedSource): Provider => ({
  kind: 'alertmanager', label: s.name, raisesChecks: true, configured: () => !!s.config.url,
  async poll(): Promise<Polled> {
    const body = await getJson(`${trimUrl(s.config.url)}/api/v2/alerts?active=true&silenced=false&inhibited=false`, { username: s.config.username, password: s.secrets.password, bearer: s.secrets.bearer_token }, 10_000, s.config.insecure_tls === 'true');
    if (!Array.isArray(body)) throw new Error('The server did not answer like Alertmanager (expected a list of alerts)');
    return { checks: [], alerts: parseAmAlerts(body) };
  },
});
