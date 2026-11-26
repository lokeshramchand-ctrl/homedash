import { fetch } from 'undici';
import { cfg } from './config.js';

const cache = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 5_000;

// ---------- Prometheus (instant queries, same server the Grafana page uses) ----------
async function prom(query: string): Promise<{ metric: Record<string, string>; v: number }[]> {
  if (!cfg.promUrl) return [];
  const hit = cache.get(`prom:${query}`);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data as { metric: Record<string, string>; v: number }[];
  try {
    const res = await fetch(`${cfg.promUrl}/api/v1/query?${new URLSearchParams({ query })}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { result?: { metric: Record<string, string>; value: [number, string] }[] } };
    const out = (j.data?.result ?? []).map((r) => ({ metric: r.metric, v: Number(r.value[1]) })).filter((r) => Number.isFinite(r.v));
    cache.set(`prom:${query}`, { at: Date.now(), data: out });
    return out;
  } catch { return []; }
}
const first = async (q: string): Promise<number | null> => (await prom(q))[0]?.v ?? null;
export { prom as promVector, first as promFirst };
