# Monitoring module, Phase 1: core, with Kuma and Grafana as providers

Spec: `docs/superpowers/specs/2026-11-26-monitoring-module-design.md` (section 12, Phase 1).
Goal of this phase: one merged view of checks and alerts that Overview and the notifier read, with Kuma and Grafana as the first two providers. **No behaviour change for existing installs** and no UI to add sources yet (that is Phase 2).

## Decisions taken while planning (differences from the spec text)

1. **No database store in Phase 1.** The spec lists `store.ts` here, but with YAML/env sources only there is nothing to store. The two tables and sealing arrive in Phase 2. Phase 1 derives "implicit sources" from `cfg`.
2. **No double alerts for Kuma.** Kuma monitor transitions already alert through `noteMonitors` in `events.ts` (`logEvent` source `monitor`, key `mon|<name>`). Providers therefore declare `raisesChecks`: Kuma `false`, so its *checks* are shown but not re-raised by the new watcher; Grafana and future providers alert on their *alerts*. Source-down problems apply to every provider.
3. **Query-string webhook token is allowed** (owner decision, 2026-11-26). Affects Phase 2 only; recorded in the spec's open questions.
4. **`grafana` event source retired in use.** The new watcher writes timeline lines with source `monitor`. The `grafana` value stays in the type union so nothing breaks, but the Logs filter chip for it is removed.

## Files

Create:
- `server/src/monitoring/types.ts`: model and provider interface
- `server/src/monitoring/engine.ts`: poll, merge, stale-on-failure, problems builder
- `server/src/monitoring/sources.ts`: implicit sources from `cfg`
- `server/src/monitoring/providers/kuma.ts`, `server/src/monitoring/providers/grafana.ts`
- `server/src/monitoring/routes.ts`: `GET /api/monitoring`
- `server/test/monitoring-engine.test.mjs`, `server/test/monitoring-providers.test.mjs`

Modify:
- `server/src/kuma.ts`: export `kumaSnapshotAt()` and `kumaIncidentSince(key)` (reuse existing sample logic)
- `server/src/notify.ts`: replace `watchGrafana` with `watchMonitoring`
- `server/src/index.ts`: register routes, start engine
- `src/types.ts`, `src/api.ts`, `src/pages/Overview.tsx`, `src/pages/Logs.tsx`
- `mobile/src/types.ts`, `mobile/src/api.ts` (types only; no screen change in Phase 1)

## Task 1: types

`server/src/monitoring/types.ts`

```ts
export type Status = 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
export interface Check { key: string; name: string; status: Status; since: number | null; detail: string; url: string | null; ping?: number | null }
export interface MonAlert { key: string; name: string; level: 'info' | 'warn' | 'error'; state: 'firing' | 'pending'; since: number | null; summary: string; instances: number; url: string | null }
export interface Polled { checks: Check[]; alerts: MonAlert[] }
export interface Provider {
  kind: string; label: string;
  /** false when this provider's checks already raise alerts elsewhere (Kuma, through noteMonitors) */
  raisesChecks: boolean;
  configured(): boolean;
  /** throws on failure; never returns an empty result for an error */
  poll(): Promise<Polled>;
}
export interface SourceState { id: string; kind: string; label: string; managed: 'config'; ok: boolean; stale: boolean; error: string | null; checkedAt: number; checks: number; alerts: number }
export interface Merged {
  sources: SourceState[];
  checks: (Check & { source: string })[];
  alerts: (MonAlert & { source: string })[];
  checkedAt: number;
}
```
Verify: `cd server && npx tsc`. No commit yet.

## Task 2: engine (test first)

`server/test/monitoring-engine.test.mjs` uses `createEngine(() => instances)` with fake providers. Required cases, each its own `test(...)`:

1. **merge**: two providers' checks and alerts appear once each, tagged with `source`.
2. **stale on failure**: provider succeeds, then throws. `merged()` still returns the earlier checks and alerts, the source has `ok=false`, `stale=true`, `error` set, and `checkedAt` unchanged from the last success.
3. **one failing provider does not block another**: A throws, B returns data; B's data is present after one `pollAll()`.
4. **consecutive failure count**: `sourceDownProblems` (see below) returns nothing after one failure and one problem after two; returns nothing again after a success.
5. **problemsFrom**: firing alerts become problems (error level maps to `error`, others `warn`); pending alerts do not; `down` checks become problems only for providers with `raisesChecks: true`; a Kuma-like provider (`raisesChecks:false`) with a down check yields no problem; keys are `<source>|<key>`; titles read `<label> alert: <name>` / `<label> down: <name>`.
6. **unconfigured provider** is skipped and absent from `sources`.

`server/src/monitoring/engine.ts`

```ts
export interface Instance { id: string; provider: Provider }
export function createEngine(instances: () => Instance[]) {
  const st = new Map<string, { last: Polled; state: SourceState; fails: number }>();
  async function pollOne(i: Instance) {
    const prev = st.get(i.id);
    try {
      const last = await i.provider.poll();
      st.set(i.id, { last, fails: 0, state: { id: i.id, kind: i.provider.kind, label: i.provider.label, managed: 'config', ok: true, stale: false, error: null, checkedAt: Date.now(), checks: last.checks.length, alerts: last.alerts.length } });
    } catch (e) {
      const keep = prev?.last ?? { checks: [], alerts: [] };
      const base = prev?.state ?? { id: i.id, kind: i.provider.kind, label: i.provider.label, managed: 'config' as const, checkedAt: 0, checks: 0, alerts: 0 };
      st.set(i.id, { last: keep, fails: (prev?.fails ?? 0) + 1, state: { ...base, ok: false, stale: !!prev, error: (e as Error).message.slice(0, 300) } });
    }
  }
  return {
    async pollAll() { const list = instances().filter((i) => i.provider.configured()); for (const id of [...st.keys()]) if (!list.some((i) => i.id === id)) st.delete(id); await Promise.allSettled(list.map(pollOne)); },
    merged(): Merged { /* flatten st, tag source, sort: errors first, then newest */ },
    failures(id: string) { return st.get(id)?.fails ?? 0; },
  };
}
export function problemsFrom(m: Merged, raises: (kind: string) => boolean, fails: (id: string) => number): Problem[] { /* rules in test 5 and the 2-failure source-down rule */ }
```
Source-down problem: key `src|<id>`, level `warn`, title `<label> is unreachable`, text the error. Raised only when `fails(id) >= 2` so a slow first scrape or a single timeout is silent.
Export a default singleton `engine = createEngine(() => implicitSources())`.
Run: `cd server && npm test`. Expected: new tests pass, 150 existing still pass. Commit: `feat(monitoring): engine with stale-on-failure merge`.

## Task 3: Kuma provider

`server/src/kuma.ts`: add `export const kumaSnapshotAt = () => snapshot?.at ?? 0;` and `export function kumaSinceMs(key: string): number` returning `firstSampleAfter(key, lastSampleTs(key,'up')) ?? snapshot?.at ?? Date.now()` (the exact rule `/api/kuma/incidents` uses now; change that route to call it so there is one copy).

`providers/kuma.ts`: `poll()` maps `kumaSnapshot()` to checks: status as is, `since` only for non-up (via `kumaSinceMs`), `detail` `'Monitor is down'|'retrying'|'maintenance'`, `url` the monitor url if http(s). It throws `Waiting for the first Uptime Kuma scrape` when `kumaSnapshotAt()===0`, and `No recent scrape` when older than `3 * cfg.kumaPollMs`. `raisesChecks:false`.

Test (`monitoring-providers.test.mjs`): feed `parseMetrics` output through the mapping function (export the pure mapper `mapKuma(items, sinceOf)`): up stays up with `since:null`, down/pending/maintenance get since and detail, non-http urls become `null`.

## Task 4: Grafana provider

`providers/grafana.ts`: `poll()` calls `grafanaAlerts()`; if `info.error` throw it; map `GrafanaAlert` to `MonAlert` (fields line up: key, name, level, state, since, summary, instances, url). `raisesChecks:true`, `label:'Grafana'`. Test: the mapper preserves fields, and an `info.error` throws.

Run tests; commit `feat(monitoring): Kuma and Grafana providers`.

## Task 5: sources and routes

`sources.ts`: `implicitSources(): Instance[]` returns `{id:'kuma', provider: kumaProvider}` and `{id:'grafana', provider: grafanaProvider}` (the engine filters by `configured()`).

`routes.ts`: `GET /api/monitoring` returns `engine.merged()`. Role: viewer (default for GET; no `roles.ts` change in Phase 1). `index.ts`: `registerMonitoring(app)` next to `registerGrafanaAlerts`, and start a 30 s poll timer (`.unref()`) with one immediate poll at 3 s.

API test using the pattern of `alerts.test.mjs` (in-process, temp DB): with neither Kuma nor Grafana configured `GET /api/monitoring` returns `{sources:[], checks:[], alerts:[]}`; the route exists in `buildOpenApi` output as viewer.

Commit `feat(monitoring): merged endpoint`.

## Task 6: notifier

In `notify.ts` replace `watchGrafana` with the function below. `providerRaises` is a small lookup defined next to it: `const providerRaises = (kind: string) => implicitSources().find((i) => i.provider.kind === kind)?.provider.raisesChecks ?? false;`

```ts
async function watchMonitoring() {
  await monitoringEngine.pollAll();
  const m = monitoringEngine.merged();
  syncProblems('mon', 'monitor', problemsFrom(m, (kind) => providerRaises(kind), (id) => monitoringEngine.failures(id)),
    (level, text) => persistEvent(level, 'monitor', text));
}
```
Remove the two Grafana timers and use one at 35 s and the existing 60 s interval. Keep the existing rule that a failed read leaves raised problems in place: because `merged()` keeps stale alerts, `syncProblems` sees them still present and does not report recovery.

Tests (extend `monitoring-engine.test.mjs`, in-process with the alert mock like `alerts.test.mjs`): a firing alert raises exactly one delivery; the same alert on the next cycle raises none; when it disappears one recovery is sent; a failing source after a success keeps the alert open (no recovery); two failures raise one "unreachable" problem and a later success recovers it; a Kuma-like provider's down check raises nothing.

Commit `feat(monitoring): notifier reads the merged list`.

## Task 7: web UI

- `src/types.ts`: `MonitoringSnapshot` mirroring `Merged`. `src/api.ts`: `monitoring: () => get<MonitoringSnapshot>('/monitoring')`. Mirror the types in `mobile/src`.
- `Overview.tsx`: replace the `ga` query and the `inc`-driven part of `attention` with `useQuery(api.monitoring, [], 30000)`. Attention items: each non-`up`, non-`maintenance` check (down red, pending amber, label = source label, href `#/kuma` for kuma else `#/setup`); each `firing` alert as today; each source with `ok=false` as an amber "unreachable" item. `healthScore` receives the checks mapped to `{status}`. Keep the "Recent incidents (Kuma)" card on `api.incidents` unchanged.
- `Logs.tsx`: drop the `grafana` chip.
- Type check: `npx tsc --noEmit` (root) and `npx tsc` (server).

Commit `feat(monitoring): Overview reads the merged list`.

## Task 8: verification (done before any push)

1. `cd server && npm test`: all existing 150 plus the new tests pass; run three times to look for the one unexplained failure seen earlier and keep the full output if it appears.
2. `npm run build` at the root.
3. Browser check with a scratch instance and mocks (reuse `qa/first-users/mocks.mjs` ideas, extended with a Kuma `/metrics` mock and a failing Grafana): Overview shows the Kuma down monitor and the Grafana alert; killing the Grafana mock keeps the alert and, after two polls, adds one "Grafana is unreachable" item; restarting clears it. Confirm a Kuma outage sends **one** alert, not two. Save evidence under `qa/first-users/evidence/` (gitignored).
4. Compare with the pre-change behaviour: with only YAML-style env settings, Overview and the alert counts match the main-branch behaviour recorded earlier.
5. Update `CHANGELOG.md` under an "Unreleased" heading.

## Out of scope for Phase 1

Database sources and sealing, the Monitoring page and Setup Connect buttons, Prometheus, JSON poll and webhook providers (Phase 2); usage counters (Phase 3); further providers and Logs (Phase 4).

## Risks

- **Double alerts** if a provider's checks and its existing event path both raise: covered by `raisesChecks` and the explicit Kuma test in Task 6.
- **Startup noise**: Kuma has no snapshot for the first scrape; the two-failure rule prevents a false "unreachable" alert.
- **Two sources showing the same problem** is accepted (spec section 13).
