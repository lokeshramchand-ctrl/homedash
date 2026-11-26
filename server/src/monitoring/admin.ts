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
import { SOURCE_KINDS, kindSpec } from './catalog.js';
import { getJson, trimUrl } from './providers/http.js';
import { BOOT, isShadowed } from './runtime.js';
import { FACTORIES, monitoringEngine, reloadSources } from './sources.js';
import { createSource, deleteSource, getSource, listSources, rotateHookSecret, updateSource } from './store.js';
import type { LoadedSource, SourceInput } from './store.js';

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
  for (const f of spec.fields) {
    const raw = str(body[f.name], f.type === 'secret' ? 500 : 300);
    if (f.type === 'secret') {
      secrets[f.name] = raw;
      if (f.required && !raw && !prev?.secrets[f.name]) throw bad(`${f.label} is required.`);
      continue;
    }
    const v = f.type === 'url' ? trimUrl(raw) : raw;
    if (f.required && !v) throw bad(`${f.label} is required.`);
    if (f.type === 'url' && v) {
      if (!/^https?:\/\/[^\s/]+/.test(v)) throw bad(`${f.label} must start with http:// or https://`);
      // Never let this form point the server at link-local or cloud-metadata addresses.
      await assertDestinationAllowed({ uri: v } as ConnConfig, [], true);
    }
    if (v) config[f.name] = v;
  }
  if (kind === 'jsonpoll' && /^\s*$/.test(config.items_path ?? '')) throw bad('Path to the list is required.');
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
