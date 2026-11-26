// Polls every configured provider, keeps the last good answer when one fails (marked stale), and merges the results.
// Providers run independently: a slow or broken source never delays or hides the others.
import type { Problem } from '../maintenance.js';
import type { Merged, Polled, Provider, SourceState } from './types.js';

export interface Instance { id: string; provider: Provider }

const STATUS_RANK: Record<string, number> = { down: 0, pending: 1, unknown: 2, maintenance: 3, up: 4 };
const LEVEL_RANK = { error: 0, warn: 1, info: 2 } as const;

export function createEngine(instances: () => Instance[]) {
  const st = new Map<string, { last: Polled; state: SourceState; fails: number }>();

  async function pollOne(i: Instance) {
    const prev = st.get(i.id);
    const base = { id: i.id, kind: i.provider.kind, label: i.provider.label, managed: 'config' as const };
    try {
      const last = await i.provider.poll();
      st.set(i.id, { last, fails: 0, state: { ...base, ok: true, stale: false, error: null, checkedAt: Date.now(), checks: last.checks.length, alerts: last.alerts.length } });
    } catch (e) {
      // Keep what we knew: a source that stops answering must not make its problems disappear.
      const keep = prev?.last ?? { checks: [], alerts: [] };
      const was = prev?.state ?? { ...base, ok: false, stale: false, error: null, checkedAt: 0, checks: 0, alerts: 0 };
      st.set(i.id, { last: keep, fails: (prev?.fails ?? 0) + 1, state: { ...was, ok: false, stale: !!prev, error: (e as Error).message.slice(0, 300) } });
    }
  }

  return {
    async pollAll() {
      const list = instances().filter((i) => i.provider.configured());
      for (const id of [...st.keys()]) if (!list.some((i) => i.id === id)) st.delete(id);
      await Promise.allSettled(list.map(pollOne));
    },
    merged(): Merged {
      const checks: Merged['checks'] = [];
      const alerts: Merged['alerts'] = [];
      const sources: SourceState[] = [];
      for (const [id, v] of st) {
        sources.push(v.state);
        for (const c of v.last.checks) checks.push({ ...c, source: id });
        for (const a of v.last.alerts) alerts.push({ ...a, source: id });
      }
      checks.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.name.localeCompare(b.name));
      alerts.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || Number(b.state === 'firing') - Number(a.state === 'firing') || (a.since ?? 0) - (b.since ?? 0));
      return { sources, checks, alerts, checkedAt: Date.now() };
    },
    failures: (id: string) => st.get(id)?.fails ?? 0,
  };
}

/**
 * What deserves an alert, as notifier problems (the same shape syncProblems already pairs with recoveries).
 * `raises(kind)` says whether a provider's down checks should alert here; `fails(id)` is the consecutive failure count.
 */
export function problemsFrom(m: Merged, raises: (kind: string) => boolean, fails: (id: string) => number): Problem[] {
  const out: Problem[] = [];
  const by = new Map(m.sources.map((s) => [s.id, s]));
  for (const a of m.alerts) {
    if (a.state !== 'firing') continue;
    const s = by.get(a.source);
    out.push({
      key: `${a.source}|${a.key}`, level: a.level === 'error' ? 'error' : 'warn', title: `${s?.label ?? a.source} alert: ${a.name}`,
      text: `${a.summary || 'Alert is firing.'}${a.instances > 1 ? ` (${a.instances} instances)` : ''}`,
    });
  }
  for (const c of m.checks) {
    const s = by.get(c.source);
    if (c.status !== 'down' || !s || !raises(s.kind)) continue;
    out.push({ key: `${c.source}|${c.key}`, level: 'error', title: `${s.label} down: ${c.name}`, text: c.detail || `${c.name} is down.` });
  }
  for (const s of m.sources) {
    if (!s.ok && fails(s.id) >= 2) out.push({ key: `src|${s.id}`, level: 'warn', title: `${s.label} is unreachable`, text: `homedash cannot read ${s.label}: ${s.error ?? 'no answer'}. Its last known problems are still shown.` });
  }
  return out;
}
