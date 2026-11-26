// Grafana alert state: which alert rules are firing right now, read through Grafana's Prometheus-compatible rules route.
// This route comes from Grafana's source (ngalert), not a documented stable contract, and was not run against a live Grafana
// when this was written (see docs/research/one-stop-dashboard-gaps.md 2.1). The parser is therefore tolerant: anything it
// does not recognise is skipped, and a Grafana that rejects the call shows up as an `error`, never as "all clear".
import type { FastifyInstance } from 'fastify';
import { cfg, grafanaConfigured } from './config.js';
import { gf } from './grafana.js';

export type AlertState = 'firing' | 'pending';
export interface GrafanaAlert {
  key: string; name: string; state: AlertState; level: 'warn' | 'error';
  folder: string; group: string; summary: string; since: number | null; instances: number; url: string | null;
}
export interface GrafanaAlertsInfo {
  configured: boolean; alerts: GrafanaAlert[]; firing: number; pending: number; checkedAt: number; error: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const isErrorSeverity = (labels: Record<string, unknown>) => /^(critical|error|page|high)$/i.test(str(labels?.severity));

/** Pure: GET /api/prometheus/grafana/api/v1/rules. Returns firing and pending rules, one entry per rule. */
export function parseGrafanaRules(body: any, publicUrl = ''): GrafanaAlert[] {
  const out: GrafanaAlert[] = [];
  const groups = Array.isArray(body?.data?.groups) ? body.data.groups : [];
  for (const g of groups) {
    for (const r of Array.isArray(g?.rules) ? g.rules : []) {
      const state = str(r?.state).toLowerCase();
      if (state !== 'firing' && state !== 'pending' && state !== 'alerting') continue;
      const st: AlertState = state === 'pending' ? 'pending' : 'firing';
      const instances = (Array.isArray(r?.alerts) ? r.alerts : []).filter((a: any) => !a?.state || /alerting|firing|pending/i.test(str(a.state)));
      const times = instances.map((a: any) => Date.parse(str(a?.activeAt))).filter((t: number) => Number.isFinite(t));
      const labels = (r?.labels ?? {}) as Record<string, unknown>;
      const ann = (r?.annotations ?? {}) as Record<string, unknown>;
      const name = str(r?.name) || 'Unnamed alert rule';
      const uid = str(r?.uid);
      out.push({
        key: uid || `${str(g?.file)}/${str(g?.name)}/${name}`,
        name, state: st, level: isErrorSeverity(labels) ? 'error' : 'warn',
        folder: str(g?.file) || 'General', group: str(g?.name),
        summary: (str(ann.summary) || str(ann.description)).slice(0, 300),
        since: times.length ? Math.min(...times) : null,
        instances: instances.length || 1,
        url: uid && publicUrl ? `${publicUrl}/alerting/grafana/${encodeURIComponent(uid)}/view` : null,
      });
    }
  }
  // Errors first, then firing before pending, then oldest first.
  return out.sort((a, b) => Number(b.level === 'error') - Number(a.level === 'error') || Number(b.state === 'firing') - Number(a.state === 'firing') || (a.since ?? 0) - (b.since ?? 0));
}

const TTL_MS = 30_000;
let cache: { at: number; info: GrafanaAlertsInfo } | null = null;

export async function grafanaAlerts(fetcher: () => Promise<unknown> = () => gf('/api/prometheus/grafana/api/v1/rules')): Promise<GrafanaAlertsInfo> {
  if (!grafanaConfigured()) return { configured: false, alerts: [], firing: 0, pending: 0, checkedAt: Date.now(), error: null };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.info;
  let info: GrafanaAlertsInfo;
  try {
    const alerts = parseGrafanaRules(await fetcher(), cfg.grafanaPublicUrl);
    info = { configured: true, alerts, firing: alerts.filter((a) => a.state === 'firing').length, pending: alerts.filter((a) => a.state === 'pending').length, checkedAt: Date.now(), error: null };
  } catch (e) {
    // Do not cache a failure for the full TTL, and never report it as "nothing firing".
    return { configured: true, alerts: [], firing: 0, pending: 0, checkedAt: Date.now(), error: (e as Error).message };
  }
  cache = { at: Date.now(), info };
  return info;
}

export function registerGrafanaAlerts(app: FastifyInstance) {
  app.get('/api/grafana/alerts', async () => grafanaAlerts());
}
