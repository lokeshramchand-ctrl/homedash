import { api } from '../api';
import { useQuery } from '../hooks';
import { BarChart, TimeChart } from './Charts';
import type { Pt, Series } from './Charts';
import { Async } from './ui';

export { Delta, fmtMetric, summarize } from './Charts';
export type { Pt, Series } from './Charts';

/**
 * How a time series is drawn, picked by what the numbers mean:
 * area = a level over time (CPU), line = rates or several comparable series, stacked = parts of a
 * whole, capacity = used (area) against a limit (dashed), mirror = in/out around a centre line,
 * grouped = two quantities side by side per interval, bars = discrete volumes.
 */
export type ChartKind = 'area' | 'line' | 'step' | 'stacked' | 'capacity' | 'mirror' | 'grouped' | 'bars';

export function LineChart({ series, unit, height = 200, max, stats = true, chart }: { series: Series[]; unit: string; height?: number; max?: number; stats?: boolean; chart?: ChartKind }) {
  const kind = chart ?? (series.length > 1 ? 'line' : 'area');
  if (kind === 'mirror' || kind === 'grouped' || kind === 'bars') {
    return <BarChart series={series} unit={unit} height={height} max={max} stats={stats} mode={kind === 'mirror' ? 'mirror' : kind === 'grouped' ? 'group' : 'stack'} />;
  }
  const typed = series.map((s, i) => ({
    ...s,
    kind: kind === 'capacity' ? (i === 0 ? 'dashed' as const : 'area' as const) : kind === 'stacked' ? 'area' as const : kind === 'step' ? 'step' as const : kind,
    color: s.color ?? (kind === 'capacity' && i === 0 ? 'var(--muted)' : undefined),
  }));
  return <TimeChart series={typed} unit={unit} height={height} max={max} stats={stats} stacked={kind === 'stacked'} />;
}

/** A chart fed by POST /api/metrics/query (PromQL proxy). */
export function MetricChart({ query, rangeSec = 3600, unit = '%', height, name = 'value' }: {
  query: string; rangeSec?: number; unit?: string; height?: number; name?: string;
}) {
  const q = useQuery(async () => {
    const end = Math.floor(Date.now() / 1000);
    const step = Math.max(15, Math.floor(rangeSec / 120));
    return api.query(query, end - rangeSec, end, step);
  }, [query, rangeSec], 30_000);

  return (
    <Async q={q} rows={1} h={height ?? 220}
      isEmpty={(d) => !d.data?.result?.length || !d.data.result[0].values.length}
      empty={{ title: 'No data points', hint: 'The query returned nothing for this range. Check the metric name or widen the range.' }}>
      {(d) => (
        <LineChart unit={unit} height={height}
          series={d.data.result.slice(0, 4).map((r, i) => ({
            name: r.metric.instance || r.metric.__name__ || (d.data.result.length > 1 ? `series ${i + 1}` : name),
            points: r.values.map(([t, v]) => [t, parseFloat(v)] as Pt).filter((p) => Number.isFinite(p[1])),
          }))} />
      )}
    </Async>
  );
}
