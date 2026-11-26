// Connecting monitoring sources from the UI. Everything here is administrator-only (see roles.ts). Secrets are accepted and sealed,
// but never returned, logged or put in an audit line. A pull source is tested before it is saved; a failing one is refused unless
// the administrator confirms with `force`.
import type { FastifyInstance } from 'fastify';
import { fetch } from 'undici';
import { assertDestinationAllowed } from '../datasources/netguard.js';
import type { ConnConfig } from '../datasources/core/types.js';
import { HttpError } from '../errors.js';
import { logEvent } from '../events.js';
import { parseGrafanaRules } from '../grafanaalerts.js';
import { parseMetrics } from '../kuma.js';
import { sealKey } from '../tilestore.js';
import { SOURCE_KINDS, fieldVisible, kindSpec } from './catalog.js';
import { mapPromText } from './prometheus-text.js';
import { getJson, trimUrl } from './providers/http.js';
import { parseTargets } from './providers/probe.js';
import { buildRequest } from './request.js';
import type { HttpConfig } from './request.js';
import { BOOT, isShadowed } from './runtime.js';
import { FACTORIES, monitoringEngine, reloadSources } from './sources.js';
import { createSource, deleteSource, getSource, listSources, rotateHookSecret, updateSource } from './store.js';
import type { LoadedSource, SourceInput } from './store.js';

/** Kinds where the same address twice is almost certainly a mistake. Custom sources may share an address with different queries. */
const DEDUPE = new Set(['kuma', 'grafana', 'prometheus', 'alertmanager']);
const bad = (m: string) => new HttpError(400, 'BAD_REQUEST', m);
const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.min(Math.max(Number(v) || d, lo), hi);

/** Validates a form body into a SourceInput. `prev` supplies secrets the form left blank (edit). */
export async function buildInput(kind: string, body: Record<string, unknown>, prev?: LoadedSource): Promise<SourceInput> {
  const spec = kindSpec(kind);
  if (!spec) throw bad('Pick a kind of source');
  if (isShadowed(kind)) throw bad(`${spec.label} is already set in homedash.yaml or the environment; change it there.`);
  if ((kind === 'kuma' || kind === 'grafana') && listSources().some((s) => s.kind === kind && s.id !== prev?.id)) {
    throw bad(`Only one ${spec.label} source can be connected.`);
  }
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const sameAddress = (u: string) => listSources().find((s) => s.kind === kind && s.id !== prev?.id && trimUrl(s.config.url).toLowerCase() === u.toLowerCase());
  for (const f of spec.fields) {
    // A field that depends on another choice (for example the Prometheus rule fields) is read only while it applies.
    if (!fieldVisible(f, { ...body, ...config } as Record<string, string>, spec)) continue;
    if (f.type === 'secret') {
      const raw = str(body[f.name], 500);
      secrets[f.name] = raw;
      if (f.required && !raw && !prev?.secrets[f.name]) throw bad(`${f.label} is required.`);
      continue;
    }
    if (f.type === 'bool') { if (body[f.name] === true || body[f.name] === 'true') config[f.name] = 'true'; continue; }
    if (f.type === 'select') {
      const v = str(body[f.name], 40) || f.options![0].value;
      if (!f.options!.some((o) => o.value === v)) throw bad(`${f.label}: "${v.slice(0, 30)}" is not one of the choices.`);
      config[f.name] = v;
      continue;
    }
    // A text area keeps its line breaks; everything else is a single trimmed line.
    const raw = f.type === 'textarea' ? String(body[f.name] ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000) : str(body[f.name], 300);
    const v = f.type === 'url' ? trimUrl(raw) : raw;
    if (f.required && !v) throw bad(`${f.label} is required.`);
    if (f.type === 'url' && v) {
      // {{secret}} in a custom address is checked after it is filled in, below; here the shape and the destination are.
      if (!/^https?:\/\/[^\s/]+/.test(v)) throw bad(`${f.label} must start with http:// or https://`);
      // Never let this form point the server at link-local or cloud-metadata addresses.
      await assertDestinationAllowed({ uri: v.replace(/\{\{secret\}\}/g, 'x') } as ConnConfig, [], true);
    }
    if (f.name === 'url' && v && DEDUPE.has(kind)) {
      const dup = sameAddress(v);
      if (dup) throw bad(`${spec.label} at ${v} is already connected as "${dup.name}".`);
    }
    if (v) config[f.name] = v;
  }
  if (kind === 'jsonpoll' && /^\s*$/.test(config.items_path ?? '')) throw bad('Path to the list is required.');
  // Things only the whole configuration can say: refuse a request that could not be sent, a list of checks that cannot be read.
  try {
    if (kind === 'http') {
      const secret = secrets.secret || prev?.secrets.secret || '';
      if (config.parse === 'json_checks' && !config.status_path) throw new Error('Status (inside each item) is required to read checks');
      buildRequest(config as HttpConfig, secret);
      if (config.parse === 'prometheus') mapPromText([], config);
    }
    if (kind === 'probe' && !parseTargets(config.targets).length) throw new Error('Add at least one check');
    if (kind === 'webhook' && (config.items_path || config.name_path) && !(config.items_path && config.name_path)) throw new Error('A custom mapping needs both the path to the list and the name path');
  } catch (e) { throw bad((e as Error).message); }
  return {
    kind, name: str(body.name, 60) || spec.label, config, secrets,
    enabled: body.enabled !== false, intervalS: clamp(body.intervalS ?? body.interval_s, 15, 3600, 60), ttlHours: clamp(body.ttlHours ?? body.ttl_hours, 1, 720, 168),
  };
}

export interface TestResult { ok: boolean; message: string }

/** Reads the source once and says what was found. Never throws: a failure is `ok: false` with a secret-free message. */
export async function testSource(s: LoadedSource): Promise<TestResult> {
  try {
    if (s.kind === 'webhook') return { ok: true, message: 'Ready. homedash will show events as soon as the tool sends the first one.' };
    if (s.kind === 'kuma') {
      const res = await fetch(`${trimUrl(s.config.url)}/metrics`, { headers: { Authorization: `Basic ${Buffer.from(`:${s.secrets.api_key}`).toString('base64')}` }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) return { ok: false, message: `Uptime Kuma refused the API key (HTTP ${res.status}).` };
      if (!res.ok) return { ok: false, message: `Uptime Kuma answered HTTP ${res.status}.` };
      const n = parseMetrics(await res.text()).length;
      return n ? { ok: true, message: `Read ${n} monitor${n === 1 ? '' : 's'}.` } : { ok: false, message: 'Connected, but no monitors were found at /metrics.' };
    }
    if (s.kind === 'grafana') {
      const body = await getJson(`${trimUrl(s.config.url)}/api/prometheus/grafana/api/v1/rules`, { bearer: s.secrets.token });
      const a = parseGrafanaRules(body);
      return { ok: true, message: `Connected. ${a.filter((x) => x.state === 'firing').length} alert rule(s) firing, ${a.filter((x) => x.state === 'pending').length} pending.` };
    }
    const make = FACTORIES[s.kind];
    if (!make) return { ok: false, message: 'This kind of source cannot be tested yet.' };
    const r = await make(s).poll();
    if (s.kind === 'probe') {
      const up = r.checks.filter((c) => c.status === 'up').length;
      return { ok: true, message: `Looked at ${r.checks.length} thing${r.checks.length === 1 ? '' : 's'}: ${up} fine${r.checks.length - up ? `, ${r.checks.length - up} need attention (${r.checks.filter((c) => c.status !== 'up').slice(0, 2).map((c) => `${c.name}: ${c.detail}`).join('; ')})` : ''}.` };
    }
    if (s.kind === 'http') {
      const n = r.checks.length + r.alerts.length;
      if (s.config.parse === 'status') return { ok: true, message: `${r.checks[0].status === 'up' ? 'It answers' : 'It does not answer as expected'}: ${r.checks[0].detail}.` };
      if (!n) return { ok: s.config.parse === 'json_alerts', message: s.config.parse === 'json_alerts' ? 'Read the list: nothing is wrong right now.' : s.config.parse === 'prometheus' ? `No series named "${s.config.metric}" matched. Check the metric name and the label filter.` : 'The list is empty. Check the path to the list, the name and the status paths.' };
      return { ok: true, message: r.alerts.length ? `Read ${r.alerts.length} problem${r.alerts.length === 1 ? '' : 's'}: ${r.alerts.slice(0, 3).map((a) => a.name).join(', ')}.` : `Read ${r.checks.length} item${r.checks.length === 1 ? '' : 's'}: ${r.checks.slice(0, 3).map((c) => `${c.name} is ${c.status}`).join(', ')}.` };
    }
    if (s.kind === 'jsonpoll') {
      return r.checks.length ? { ok: true, message: `Read ${r.checks.length} item${r.checks.length === 1 ? '' : 's'}: ${r.checks.slice(0, 3).map((c) => `${c.name} is ${c.status}`).join(', ')}.` }
        : { ok: false, message: 'The list is empty. Check the path to the list, the name and the status paths.' };
    }
    return { ok: true, message: `Connected. ${r.alerts.filter((a) => a.state === 'firing').length} alert(s) firing, ${r.alerts.filter((a) => a.state === 'pending').length} pending.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 300) };
  }
}

/** A form body as a LoadedSource, with blank secrets filled from the saved source (so "Test" works on an edit form). */
function draft(kind: string, input: SourceInput, prev?: LoadedSource): LoadedSource {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.secrets)) secrets[k] = v || prev?.secrets[k] || '';
  return { id: prev?.id ?? 'src-draft', kind, name: input.name, config: input.config, secrets, secretsSet: Object.keys(secrets).filter((k) => secrets[k]), enabled: input.enabled, intervalS: input.intervalS, ttlHours: input.ttlHours, createdAt: 0, createdBy: null };
}

export function registerMonitoringAdmin(app: FastifyInstance) {
  const audit = (req: { user?: { username: string } }, what: string) => logEvent('info', 'app', `${req.user?.username ?? 'someone'} ${what}`);
  const stateOf = (id: string) => monitoringEngine.merged().sources.find((s) => s.id === id) ?? null;
  const noKey = () => { if (!sealKey()) throw new HttpError(503, 'NO_SECRET_KEY', 'Set SECRETS_KEY (homedash-config apply creates one) before connecting sources from the UI'); };

  app.get('/api/monitoring/catalog', async () => ({ kinds: SOURCE_KINDS, canEdit: sealKey() !== '' }));

  app.get('/api/monitoring/sources', async () => ({
    canEdit: sealKey() !== '',
    sources: listSources().map((s) => ({ ...s, shadowed: isShadowed(s.kind), hookPath: s.kind === 'webhook' ? `/hooks/monitoring/${s.id}` : null, state: stateOf(s.kind === 'kuma' || s.kind === 'grafana' ? s.kind : s.id) })),
    config: [...(BOOT.kuma ? [{ id: 'kuma', kind: 'kuma', label: 'Uptime Kuma' }] : []), ...(BOOT.grafana ? [{ id: 'grafana', kind: 'grafana', label: 'Grafana' }] : [])].map((c) => ({ ...c, state: stateOf(c.id) })),
  }));

  // Test unsaved form values (an edit form passes the id so blank secrets reuse the saved ones).
  app.post<{ Body: Record<string, unknown> }>('/api/monitoring/sources/test', async (req) => {
    const body = req.body ?? {};
    const prev = typeof body.id === 'string' ? getSource(body.id) : undefined;
    const input = await buildInput(prev?.kind ?? str(body.kind, 30), body, prev);
    return testSource(draft(input.kind, input, prev));
  });

  app.post<{ Params: { id: string } }>('/api/monitoring/sources/:id/test', async (req) => {
    const s = getSource(req.params.id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'No such source');
    return testSource(s);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/monitoring/sources', async (req, reply) => {
    noKey();
    const body = req.body ?? {};
    const input = await buildInput(str(body.kind, 30), body);
    const t = await testSource(draft(input.kind, input));
    if (!t.ok && body.force !== true) throw new HttpError(400, 'TEST_FAILED', `The test failed: ${t.message}`);
    const made = createSource(input, req.user!.username);
    reloadSources();
    void monitoringEngine.pollAll().catch(() => {});
    audit(req, `connected the monitoring source "${input.name}" (${input.kind})`);
    reply.code(201);
    // The webhook secret is shown here once and cannot be read back.
    return { id: made.id, test: t, ...(made.hookSecret ? { secret: made.hookSecret, hookPath: `/hooks/monitoring/${made.id}` } : {}) };
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/monitoring/sources/:id', async (req) => {
    noKey();
    const prev = getSource(req.params.id);
    if (!prev) throw new HttpError(404, 'NOT_FOUND', 'No such source');
    const body = req.body ?? {};
    const input = await buildInput(prev.kind, body, prev);
    const t = await testSource(draft(prev.kind, input, prev));
    if (input.enabled && !t.ok && body.force !== true) throw new HttpError(400, 'TEST_FAILED', `The test failed: ${t.message}`);
    updateSource(prev.id, input);
    reloadSources();
    void monitoringEngine.pollAll().catch(() => {});
    audit(req, `changed the monitoring source "${input.name}"`);
    return { id: prev.id, test: t };
  });

  app.delete<{ Params: { id: string } }>('/api/monitoring/sources/:id', async (req) => {
    const prev = getSource(req.params.id);
    if (!prev || !deleteSource(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'No such source');
    reloadSources();
    audit(req, `removed the monitoring source "${prev.name}"`);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/monitoring/sources/:id/rotate', async (req) => {
    const secret = rotateHookSecret(req.params.id);
    if (!secret) throw new HttpError(404, 'NOT_FOUND', 'No such webhook source');
    audit(req, `issued a new secret for the monitoring source ${req.params.id}`);
    return { secret, hookPath: `/hooks/monitoring/${req.params.id}` };
  });
}
