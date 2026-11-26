// CrowdSec page: engines feed one decision list.
//   - a central engine + local API (its state is published as a JSON snapshot by the `homedash-crowdsec-snapshot`
//     root timer: this process is unprivileged and holds no CrowdSec credentials, so it cannot change a decision),
//   - optionally the Proxmox host's log processor (nginx, sshd) which reports to the central engine.
// History and per-engine counters come from Prometheus (set PROMETHEUS_URL). Everything here is read-only.
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { cfg, crowdsecConfigured } from './config.js';
import { HttpError } from './errors.js';
import { promFirst, promVector } from './prom.js';

const CENTRAL = cfg.crowdsec.centralName;
const HOST = cfg.crowdsec.hostName;
const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));

interface SnapAlert {
  id: number; createdAt: string; scenario: string; machine: string; eventsCount: number; startAt: string; stopAt: string; simulated: boolean;
  source: { ip: string; scope: string; country: string | null; asName: string | null; asNumber: string | null; range: string | null };
  decisions: { id: number; type: string; duration: string; origin: string; value: string }[];
}
interface Snapshot {
  generatedAt: string; errors: string[];
  alerts: SnapAlert[]; localDecisions: SnapAlert[];
  machines: { name: string; ip: string; version: string; validated: boolean; lastHeartbeat: string; os: string; features: string[] }[];
  bouncers: { name: string; ip: string; type: string; version: string; revoked: boolean; lastPull: string; os: string }[];
  allowlists: { name: string; description: string; items: { value: string; description: string; expiration: string | null }[] }[];
  collections: { name: string; status: string; version: string }[];
}

async function snapshot(): Promise<Snapshot | null> {
  if (!cfg.crowdsecSnapshot) return null;
  try { return JSON.parse(await readFile(cfg.crowdsecSnapshot, 'utf8')) as Snapshot; } catch { return null; }
}

/** "3h50m29s" -> seconds. CrowdSec prints remaining ban time this way. */
function durSeconds(d: string): number {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(d || '');
  return m ? num(m[1]) * 86400 + num(m[2]) * 3600 + num(m[3]) * 60 + num(m[4]) : 0;
}
const ageSec = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null; };
const top = <T,>(items: T[], key: (x: T) => string | null | undefined, n: number) => {
  const m = new Map<string, number>();
  for (const x of items) { const k = key(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
};

const FRESH_S = 180; // a bouncer that has not pulled, or an agent that has not sent a heartbeat, for this long is a problem

async function build() {
  if (!crowdsecConfigured()) return { configured: false as const };
  const snap = await snapshot();
  const [central, upRows, capiPull, byOrigin, capi, alertsGauge, parsedOk, parsedKo] = await Promise.all([
    promFirst(`sum(cs_active_decisions{instance_name="${CENTRAL}"})`),
    promVector(`up{job="crowdsec"}`),
    promVector(`time() - cs_capi_last_pull_timestamp`),
    promVector(`sum by (origin) (cs_active_decisions{instance_name="${CENTRAL}"})`),
    promVector(`sum by (reason) (cs_active_decisions{instance_name="${CENTRAL}",origin="CAPI"})`),
    promVector(`sum by (reason) (cs_alerts{instance_name="${CENTRAL}"})`),
    promVector(`sum by (source) (cs_parser_hits_ok_total{instance_name="${HOST}"})`),
    promVector(`sum by (source) (cs_parser_hits_ko_total{instance_name="${HOST}"})`),
  ]);

  const alerts = (snap?.alerts ?? []).filter((a) => !a.simulated);
  const now = Date.now();
  const in24h = alerts.filter((a) => now - Date.parse(a.createdAt) < 86_400_000);
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const start = Math.floor(now / 3_600_000) * 3_600_000 - (23 - i) * 3_600_000;
    return { t: new Date(start).toISOString(), n: alerts.filter((a) => { const c = Date.parse(a.createdAt); return c >= start && c < start + 3_600_000; }).length };
  });
  const daily = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i));
    const start = d.getTime();
    return { t: new Date(start).toISOString(), n: alerts.filter((a) => { const c = Date.parse(a.createdAt); return c >= start && c < start + 86_400_000; }).length };
  });
  const local = (snap?.localDecisions ?? []).flatMap((a) => a.decisions.map((d) => ({
    id: d.id, ip: d.value, scenario: a.scenario, type: d.type, origin: d.origin, remainingSec: durSeconds(d.duration), country: a.source.country, asName: a.source.asName, createdAt: a.createdAt, machine: a.machine, events: a.eventsCount,
  }))).sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));

  const upBy = new Map(upRows.map((r) => [r.metric.instance_name, r.v === 1]));
  // An engine that never pulls the community list reports timestamp 0, which would read as 55 years ago: ignore those.
  const capiBy = new Map(capiPull.filter((r) => r.v > 0 && r.v < 365 * 86400).map((r) => [r.metric.instance_name, Math.round(r.v)]));
  const bouncers = (snap?.bouncers ?? []).map((b) => ({ ...b, ageSec: ageSec(b.lastPull) }));
  const machines = (snap?.machines ?? []).map((m) => ({ ...m, ageSec: ageSec(m.lastHeartbeat) }));
  const hostMachine = machines.find((m) => m.name === cfg.crowdsec.hostName);
  const snapAge = snap ? ageSec(snap.generatedAt) : null;
  const centralOk = !!snap && (snapAge ?? 9e9) < FRESH_S && upBy.get(CENTRAL) !== false;

  const engines = [
    { id: 'central', name: `Central engine (${CENTRAL})`, role: 'Local API and decision list: every engine reports here, every bouncer reads from here', ok: centralOk,
      detail: snap ? `snapshot ${snapAge}s old` : 'snapshot unavailable', version: machines.find((m) => m.features.includes('lapi'))?.version.replace(/-.*/, '') ?? '', capiPullSec: capiBy.get(CENTRAL) ?? null },
    { id: 'host', name: 'Proxmox host agent', role: 'Reads nginx and SSH logs on the host and reports attackers to the central engine; its bouncer blocks them in iptables', ok: upBy.get(cfg.crowdsec.hostName) !== false && (hostMachine?.ageSec ?? 9e9) < FRESH_S,
      detail: hostMachine?.ageSec != null ? `heartbeat ${hostMachine.ageSec}s ago` : 'no heartbeat', version: hostMachine?.version.replace(/-.*/, '') ?? '', capiPullSec: capiBy.get(cfg.crowdsec.hostName) ?? null },
  ];

  const community = capi.map((r) => ({ reason: r.metric.reason, count: Math.round(r.v) })).sort((a, b) => b.count - a.count);
  const localByOrigin = byOrigin.filter((r) => r.metric.origin !== 'CAPI').reduce((s, r) => s + r.v, 0);
  // Every line a source produced was either parsed (ok) or not understood (ko); journal and file sources both appear.
  const acq = [...new Set([...parsedOk, ...parsedKo].map((r) => r.metric.source))].map((source) => {
    const ok = Math.round(parsedOk.find((p) => p.metric.source === source)?.v ?? 0), ko = Math.round(parsedKo.find((p) => p.metric.source === source)?.v ?? 0);
    return { source, read: ok + ko, ok, ko };
  }).sort((a, b) => b.read - a.read);

  return {
    configured: true, snapshot: snap ? { ageSec: snapAge, errors: snap.errors } : null, prometheus: upRows.length > 0,
    engines,
    decisions: {
      local, localCount: local.length || Math.round(localByOrigin), community, communityTotal: community.reduce((s, c) => s + c.count, 0), total: central == null ? null : Math.round(central),
    },
    alerts: {
      total7d: alerts.length, last24h: in24h.length, hourly, daily,
      byScenario: top(alerts, (a) => a.scenario, 8).map(([scenario, count]) => ({ scenario, count })),
      byCountry: top(alerts, (a) => a.source.country, 8).map(([country, count]) => ({ country, count })),
      byMachine: top(alerts, (a) => a.machine, 4).map(([machine, count]) => ({ machine, count })),
      topSources: top(alerts, (a) => a.source.ip, 6).map(([ip, count]) => { const a = alerts.find((x) => x.source.ip === ip)!; return { ip, count, country: a.source.country, asName: a.source.asName }; }),
      gauge: alertsGauge.map((r) => ({ scenario: r.metric.reason, count: Math.round(r.v) })).sort((a, b) => b.count - a.count),
    },
    bouncers, machines, collections: snap?.collections ?? [], allowlists: snap?.allowlists ?? [],
    acquisition: acq,
    updatedAt: new Date().toISOString(),
  };
}

export interface CsProblem { key: string; title: string; text: string; level: 'error' | 'warn' }
export interface CsNewBan { id: number; ip: string; scenario: string; country: string | null; asName: string | null; remainingSec: number }

/** For the ntfy watcher: things that are broken, plus local bans that appeared since the last look. */
export async function crowdsecWatch(): Promise<{ problems: CsProblem[]; bans: CsNewBan[] } | null> {
  if (!crowdsecConfigured()) return null;
  const snap = await snapshot();
  if (!snap) return { problems: [{ key: 'snapshot', title: 'CrowdSec status unavailable', text: 'The homedash-crowdsec-snapshot timer on the host is not producing state.json', level: 'error' }], bans: [] };
  const problems: CsProblem[] = [];
  const age = ageSec(snap.generatedAt) ?? 9e9;
  if (age > FRESH_S) problems.push({ key: 'snapshot', title: 'CrowdSec status is stale', text: `state.json is ${Math.round(age / 60)} min old (homedash-crowdsec-snapshot.timer or the central engine is down)`, level: 'error' });
  for (const e of snap.errors) problems.push({ key: `snaperr|${e.split(':')[0]}`, title: 'CrowdSec query failed', text: e.slice(0, 160), level: 'warn' });
  if (age <= FRESH_S) {
    for (const b of snap.bouncers) { const a = ageSec(b.lastPull); if (!b.revoked && a != null && a > FRESH_S) problems.push({ key: `bouncer|${b.name}`, title: `CrowdSec bouncer silent · ${b.name}`, text: `${b.name} has not pulled decisions for ${Math.round(a / 60)} min, so new bans are not applied there`, level: 'error' }); }
    for (const m of snap.machines) { const a = ageSec(m.lastHeartbeat); if (a != null && a > FRESH_S) problems.push({ key: `machine|${m.name}`, title: `CrowdSec engine silent · ${m.name}`, text: `${m.name} has not sent a heartbeat for ${Math.round(a / 60)} min`, level: 'warn' }); }
  }
  const bans: CsNewBan[] = snap.localDecisions.flatMap((a) => a.decisions.filter((d) => d.type === 'ban').map((d) => ({ id: d.id, ip: d.value, scenario: a.scenario, country: a.source.country, asName: a.source.asName, remainingSec: durSeconds(d.duration) })));
  return { problems, bans };
}

const SAFE = /^[\w:/.-]{1,80}$/;

export function registerCrowdsec(app: FastifyInstance) {
  app.get('/api/crowdsec', async () => build());

  // Detections (alerts) from the last 7 days, optionally filtered; source address, country and scenario are plain strings.
  app.get<{ Querystring: { scenario?: string; country?: string; q?: string; limit?: string } }>('/api/crowdsec/alerts', async (req) => {
    const { scenario, country } = req.query;
    if (scenario && !SAFE.test(scenario)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid scenario');
    if (country && !/^[A-Za-z]{2}$/.test(country)) throw new HttpError(400, 'BAD_REQUEST', 'country must be a two-letter code');
    const needle = (req.query.q ?? '').trim().toLowerCase().slice(0, 80);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const snap = await snapshot();
    if (!snap) throw new HttpError(503, 'NOT_CONFIGURED', 'CrowdSec snapshot is not available on the server');
    return snap.alerts.filter((a) => !a.simulated && (!scenario || a.scenario === scenario) && (!country || a.source.country?.toUpperCase() === country.toUpperCase())
      && (!needle || `${a.source.ip} ${a.source.asName ?? ''} ${a.scenario} ${a.machine}`.toLowerCase().includes(needle)))
      .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)).slice(0, limit)
      .map((a) => ({ id: a.id, createdAt: a.createdAt, scenario: a.scenario, machine: a.machine, events: a.eventsCount, startAt: a.startAt, stopAt: a.stopAt,
        ip: a.source.ip, country: a.source.country, asName: a.source.asName, asNumber: a.source.asNumber, range: a.source.range,
        decision: a.decisions[0] ? { type: a.decisions[0].type, remainingSec: durSeconds(a.decisions[0].duration), origin: a.decisions[0].origin } : null }));
  });
}
