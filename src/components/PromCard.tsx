import { api } from '../api';
import { LineChart } from './MetricChart';
import type { ChartKind } from './MetricChart';
import type { Pt, Series } from './Charts';
import { Async, Card, CardHead } from './ui';
import { useQuery } from '../hooks';

// PromQL range helper: one query per named line, returned as chart series.
interface PromLine { name: string; expr: string; scale?: number }
export function usePromRange(lines: PromLine[], rangeSec: number, interval = 30_000) {
  return useQuery(async () => {
    const end = Math.floor(Date.now() / 1000);
    const step = Math.max(15, Math.floor(rangeSec / 120));
    const rs = await Promise.all(lines.map((l) => api.query(l.expr, end - rangeSec, end, step)));
    return lines.map((l, i): Series => ({
      name: l.name,
      points: (rs[i].data.result[0]?.values ?? []).map(([t, v]) => [t, parseFloat(v) * (l.scale ?? 1)] as Pt).filter((p) => Number.isFinite(p[1])),
    }));
  }, [rangeSec, JSON.stringify(lines)], interval);
}

export function PromCard({ title, sub, lines, range, unit, chart, max }: { title: string; sub?: string; lines: PromLine[]; range: number; unit: string; chart?: ChartKind; max?: number }) {
  const q = usePromRange(lines, range);
  return (
    <Card className="rrd-card">
      <CardHead title={title} sub={sub} />
      <Async q={q} rows={1} h={200} isEmpty={(d) => d.every((s) => s.points.length < 2)} empty={{ title: 'No data yet', hint: 'Prometheus has not stored this range yet.' }}>
        {(series) => <LineChart unit={unit} height={180} max={max} chart={chart} series={series.filter((s) => s.points.length > 1)} />}
      </Async>
    </Card>
  );
}
