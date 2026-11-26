import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { fmtBytes } from '../format';

/* One chart language for the whole console, taken from the Logs and Diagnostics views:
   flat columns with rounded tops and 2 px gaps, dot legends, no gradients. Columns grow in
   on first paint, the hovered column stays lit while the rest dim, and a readout follows the
   pointer. Tick meters use the same vocabulary for "how full is it" values. */

export type Pt = [number, number];
export interface Series { name: string; points: Pt[]; color?: string }
export type BarMode = 'stack' | 'overlay' | 'mirror' | 'group';

export const CHART_COLORS = ['var(--signal)', 'var(--green)', 'var(--peri)', 'var(--red)'];

/** One value formatter for every chart and stat, keyed by unit. */
export function fmtMetric(unit: string, v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (unit === 'B' || unit === 'B/s') return fmtBytes(v) + (unit === 'B/s' ? '/s' : '');
  if (unit === '%') return `${v.toFixed(v < 10 ? 1 : 0)}%`;
  const a = Math.abs(v);
  const n = a >= 1e9 ? `${(v / 1e9).toFixed(1)}G` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(a < 10 ? 2 : 1);
  return unit ? `${n} ${unit}` : n;
}

export function summarize(points: Pt[]) {
  const v = points.map((p) => p[1]).filter(Number.isFinite);
  if (!v.length) return null;
  return { now: v[v.length - 1], avg: v.reduce((a, b) => a + b, 0) / v.length, peak: Math.max(...v), low: Math.min(...v), first: v[0] };
}

/** Change from the start of the window, as a small pill. `good` says which direction is healthy. */
export function Delta({ now, since: base, good = 'down' }: { now: number; since: number; good?: 'up' | 'down' }) {
  if (!Number.isFinite(now) || !Number.isFinite(base) || Math.abs(base) < 1e-9) return null;
  const pct = ((now - base) / Math.abs(base)) * 100;
  if (Math.abs(pct) < 0.5) return <span className="delta flat">Steady</span>;
  const up = pct > 0;
  const ok = (good === 'up') === up;
  return <span className={`delta ${ok ? 'ok' : 'bad'}`}>{up ? '▲' : '▼'} {Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%</span>;
}

function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
/** Round an axis maximum up to a readable value; bytes round in powers of 1024 so labels read 40 GB, not 46.6 GB. */
const niceCeil = (v: number, unit = '') => {
  if (!(v > 0)) return 1;
  const k = unit === 'B' || unit === 'B/s' ? Math.max(0, Math.floor(Math.log(v) / Math.log(1024))) : 0;
  const base = Math.pow(1024, k), x = v / base;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  return (STEPS.find((st) => x / p <= st) ?? 10) * p * base;
};

/** Average the points of every series into `cols` equal time buckets on a shared axis. */
function bucketize(series: Series[], cols: number) {
  const all = series.flatMap((s) => s.points);
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  const span = Math.max(1e-9, t1 - t0);
  const n = Math.max(1, Math.min(cols, Math.max(...series.map((s) => s.points.length))));
  const vals = series.map((s) => {
    const sum = new Array<number>(n).fill(0), cnt = new Array<number>(n).fill(0);
    for (const [t, v] of s.points) {
      if (!Number.isFinite(v)) continue;
      const i = Math.min(n - 1, Math.floor(((t - t0) / span) * n));
      sum[i] += v; cnt[i]++;
    }
    return sum.map((x, i) => (cnt[i] ? x / cnt[i] : null));
  });
  const times = Array.from({ length: n }, (_, i) => t0 + ((i + 0.5) / n) * span);
  return { vals, times, t0, t1 };
}

/**
 * Column chart over time. `stack` piles series (parts of a whole), `overlay` draws the first
 * series as a pale capacity track behind the others, `mirror` puts series 1 above and series 2
 * below a centre line (in / out), `group` sets series side by side.
 */
export function BarChart({ series, unit = '', fmt, height = 180, max, mode = 'stack', stats = true, legend = true, axis = true, label }: {
  series: Series[]; unit?: string; fmt?: (v: number) => string; height?: number; max?: number; mode?: BarMode;
  stats?: boolean; legend?: boolean; axis?: boolean; label?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const f = fmt ?? ((v: number) => fmtMetric(unit, v));
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? CHART_COLORS[i % CHART_COLORS.length] }));
  const shown = colored.filter((s) => s.points.length && !off.has(s.name));
  const k = mode === 'group' ? Math.max(1, shown.length) : 1;
  const cols = Math.max(6, Math.min(120, Math.floor(w / (mode === 'group' ? 5 * k + 4 : 8))));
  const b = shown.length ? bucketize(shown, cols) : null;
  if (!b) return <div ref={ref} className="bc-empty muted small">No data points.</div>;

  const n = b.times.length;
  const rawTop = mode === 'stack'
    ? Math.max(...b.times.map((_, i) => b.vals.reduce((a, v) => a + (v[i] ?? 0), 0)))
    : Math.max(...b.vals.flat().map((v) => v ?? 0));
  const top = max ?? niceCeil(rawTop * 1.05, unit);
  const pc = (v: number | null) => `${Math.max(0, Math.min(100, ((v ?? 0) / top) * 100))}%`;
  const long = b.t1 - b.t0 > 36 * 3600;
  const fmtT = (t: number) => new Date(t * 1000).toLocaleString([], long ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });
  const toggle = (name: string) => setOff((o) => { const s = new Set(o); if (s.has(name)) s.delete(name); else if (colored.length - s.size > 1) s.add(name); return s; });
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
  };
  const cx = hover == null ? 0 : ((hover + 0.5) / n) * 100;

  return (
    <div className={`bc mode-${mode}`} ref={ref}>
      {legend && colored.length > 1 && (
        <div className="bc-legend">
          {colored.map((s) => {
            const sm = summarize(s.points);
            const v = hover != null && !off.has(s.name) ? b.vals[shown.indexOf(s as typeof shown[number])]?.[hover] ?? null : sm?.now ?? null;
            return (
              <button key={s.name} type="button" className={off.has(s.name) ? 'off' : ''} onClick={() => toggle(s.name)} aria-pressed={!off.has(s.name)}>
                <i style={{ background: s.color }} />{s.name}{v != null && <b>{f(v)}</b>}
              </button>
            );
          })}
        </div>
      )}
      <div className={`bc-plot ${hover != null ? 'hovering' : ''}`} style={{ height }} role="img" aria-label={label ?? `Chart of ${shown.map((s) => s.name).join(', ')}`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {axis && <span className="bc-grid" style={{ bottom: '100%' }}><em>{f(top)}</em></span>}
        {axis && <span className={`bc-grid ${mode === 'mirror' ? 'mid' : ''}`} style={{ bottom: '50%' }} />}
        <div className="bc-cols">
          {b.times.map((_, i) => (
            <span key={i} className={`bc-col ${hover === i ? 'on' : ''}`} style={{ '--i': i } as CSSProperties}>
              {mode === 'stack' && (
                <span className="bc-stack" style={{ height: pc(b.vals.reduce((a, v) => a + (v[i] ?? 0), 0)) }}>
                  {shown.map((s, j) => <i key={s.name} style={{ flexGrow: b.vals[j][i] ?? 0, background: s.color }} />)}
                </span>
              )}
              {mode === 'overlay' && shown.map((s, j) => (
                <i key={s.name} className={j === 0 && shown.length > 1 ? 'track' : ''} style={{ height: pc(b.vals[j][i]), background: s.color }} />
              ))}
              {mode === 'mirror' && shown.slice(0, 2).map((s, j) => (
                <i key={s.name} className={j === 0 ? 'up' : 'down'} style={{ height: `calc(${pc(b.vals[j][i])} / 2)`, background: s.color }} />
              ))}
              {mode === 'group' && shown.map((s, j) => <i key={s.name} style={{ height: pc(b.vals[j][i]), background: s.color }} />)}
            </span>
          ))}
        </div>
        {hover != null && (
          <div className={`tip bc-tip ${cx > 62 ? 'flip' : ''}`} style={cx > 62 ? { right: `${100 - cx}%` } : { left: `${cx}%` }}>
            <b>{new Date(b.times[hover] * 1000).toLocaleString([], long ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'short' })}</b>
            {shown.map((s, j) => <span key={s.name}><i style={{ background: s.color }} />{s.name}<em>{b.vals[j][hover] == null ? '-' : f(b.vals[j][hover]!)}</em></span>)}
          </div>
        )}
      </div>
      {axis && <div className="bc-x"><span>{fmtT(b.t0)}</span><span>{fmtT((b.t0 + b.t1) / 2)}</span><span>{fmtT(b.t1)}</span></div>}
      {stats && (
        <div className="mc-stats">
          {shown.map((s) => {
            const sm = summarize(s.points);
            if (!sm) return null;
            return (
              <div key={s.name} className="mc-stat-row">
                {shown.length > 1 && <span className="mc-stat-name"><i style={{ background: s.color }} />{s.name}</span>}
                <span><small>Now</small><b>{f(sm.now)}</b></span>
                <span><small>Average</small><b>{f(sm.avg)}</b></span>
                <span><small>Peak</small><b>{f(sm.peak)}</b></span>
                <span><small>Low</small><b>{f(sm.low)}</b></span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Tiny columns for stat tiles: the last values, newest on the right and lit. */
export function SparkBars({ values, n = 12, color }: { values: number[]; n?: number; color?: string }) {
  const v = values.slice(-n);
  if (v.length < 2) return null;
  const top = Math.max(...v, 1e-9);
  return (
    <span className="spark-bars" aria-hidden="true" style={color ? { '--sb': color } as CSSProperties : undefined}>
      {v.map((x, i) => <i key={v.length - i} style={{ height: `${Math.max(8, (x / top) * 100)}%` }} className={i === v.length - 1 ? 'now' : ''} />)}
    </span>
  );
}

export type MeterTone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'gray';

/** Compact tick meter: a row of short bars, filled left to right. Replaces the plain progress bar. */
export function Ticks({ value, tone, n = 24 }: { value: number; tone?: MeterTone; n?: number }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const t = tone ?? (v > 0.9 ? 'red' : v > 0.75 ? 'amber' : 'blue');
  const lit = v > 0 ? Math.max(1, Math.round(v * n)) : 0;
  return (
    <span className={`ticks t-${t}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      {Array.from({ length: n }, (_, i) => <i key={i} className={i < lit ? 'on' : ''} style={{ '--i': i } as CSSProperties} />)}
    </span>
  );
}

export interface MeterPart { label: string; value: number; color?: string; hint?: string }

/**
 * Context meter: how much of a budget is used, and by what. A header with the total and a
 * percentage pill, a row of ticks coloured by part, and a breakdown underneath. Hovering a
 * part (tick or row) isolates it and the header reads it out.
 */
export function ContextMeter({ label, sub, total, parts, fmt, ticks = 48, legend = true, right }: {
  label: ReactNode; sub?: ReactNode; total: number; parts: MeterPart[]; fmt: (v: number) => string;
  ticks?: number; legend?: boolean; right?: ReactNode;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const colored = parts.map((p, i) => ({ ...p, color: p.color ?? CHART_COLORS[i % CHART_COLORS.length] }));
  const used = colored.reduce((a, p) => a + Math.max(0, p.value), 0);
  const cap = Math.max(total, 1e-9);
  const pct = used / cap;
  const tone = pct > 0.9 ? 'red' : pct > 0.75 ? 'amber' : 'green';
  // Each tick belongs to the part whose cumulative range covers the tick's centre.
  const owner: (number | null)[] = [];
  for (let i = 0; i < ticks; i++) {
    const at = ((i + 0.5) / ticks) * cap;
    let acc = 0, who: number | null = null;
    for (let j = 0; j < colored.length; j++) { acc += Math.max(0, colored[j].value); if (at <= acc) { who = j; break; } }
    owner.push(who);
  }
  const fp = focus != null ? colored[focus] : null;
  return (
    <div className={`cm ${focus != null ? 'focusing' : ''}`} onPointerLeave={() => setFocus(null)}>
      <div className="cm-head">
        <div className="cm-title"><span>{label}</span>{sub && <small className="muted">{sub}</small>}</div>
        <div className="cm-read" aria-live="polite">
          {fp
            ? <><i style={{ background: fp.color }} /><span>{fp.label}</span><b>{fmt(fp.value)}</b><em className="cm-pct">{Math.round((fp.value / cap) * 100)}%</em></>
            : <><b>{fmt(used)}</b><span className="muted">/ {fmt(total)}</span><em className={`cm-pct ${tone}`}>{Math.round(pct * 100)}%</em></>}
          {right}
        </div>
      </div>
      <div className="cm-ticks" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label={typeof label === 'string' ? label : undefined}>
        {owner.map((o, i) => (
          <i key={i} className={`${o == null ? '' : 'on'} ${o != null && o === focus ? 'hl' : ''}`} style={{ '--i': i, ...(o != null ? { background: colored[o].color } : {}) } as CSSProperties}
            onPointerEnter={() => setFocus(o)} />
        ))}
      </div>
      {legend && colored.length > 1 && (
        <div className="cm-legend">
          {colored.map((p, j) => (
            <button key={p.label} type="button" className={focus === j ? 'on' : ''} onPointerEnter={() => setFocus(j)} onFocus={() => setFocus(j)} onBlur={() => setFocus(null)} title={p.hint}>
              <i style={{ background: p.color }} /><span>{p.label}</span><b>{fmt(p.value)}</b><em>{Math.round((p.value / cap) * 100)}%</em>
            </button>
          ))}
          {total > used && <span className="cm-free"><i /><span>Free</span><b>{fmt(total - used)}</b><em>{Math.round(((total - used) / cap) * 100)}%</em></span>}
        </div>
      )}
    </div>
  );
}

/* ---------- Line / area charts (shadcn-style: monotone curves, flat fills, cursor + active dots) ---------- */

export type SeriesKind = 'area' | 'line' | 'step' | 'dashed';
export interface TSeries extends Series { kind?: SeriesKind }

/** Monotone cubic interpolation (Fritsch–Carlson): smooth, never overshoots the data. */
export function monotone(p: [number, number][]): string {
  const n = p.length;
  if (n < 2) return '';
  if (n === 2) return `M${p[0][0]},${p[0][1]}L${p[1][0]},${p[1][1]}`;
  const dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = dx[i] ? (p[i + 1][1] - p[i][1]) / dx[i] : 0; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(p[i][0] + h).toFixed(1)},${(p[i][1] + h * t[i]).toFixed(1)} ${(p[i + 1][0] - h).toFixed(1)},${(p[i + 1][1] - h * t[i + 1]).toFixed(1)} ${p[i + 1][0].toFixed(1)},${p[i + 1][1].toFixed(1)}`;
  }
  return d;
}
export const stepPath = (p: [number, number][]) => p.map(([x, y], i) => (i ? `H${x.toFixed(1)}V${y.toFixed(1)}` : `M${x.toFixed(1)},${y.toFixed(1)}`)).join('');
const linear = (p: [number, number][]) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

function ChartLegend({ series, off, onToggle, values, f }: { series: { name: string; color: string; kind?: SeriesKind }[]; off: Set<string>; onToggle: (n: string) => void; values: (number | null)[]; f: (v: number) => string }) {
  if (series.length < 2) return null;
  return (
    <div className="bc-legend">
      {series.map((s, i) => (
        <button key={s.name} type="button" className={off.has(s.name) ? 'off' : ''} onClick={() => onToggle(s.name)} aria-pressed={!off.has(s.name)}>
          <i className={s.kind === 'dashed' ? 'ind-dash' : ''} style={{ background: s.color }} />{s.name}{values[i] != null && <b>{f(values[i]!)}</b>}
        </button>
      ))}
    </div>
  );
}

function ChartStats({ series, f }: { series: { name: string; color: string; points: Pt[] }[]; f: (v: number) => string }) {
  return (
    <div className="mc-stats">
      {series.map((s) => {
        const sm = summarize(s.points);
        if (!sm) return null;
        return (
          <div key={s.name} className="mc-stat-row">
            {series.length > 1 && <span className="mc-stat-name"><i style={{ background: s.color }} />{s.name}</span>}
            <span><small>Now</small><b>{f(sm.now)}</b></span>
            <span><small>Average</small><b>{f(sm.avg)}</b></span>
            <span><small>Peak</small><b>{f(sm.peak)}</b></span>
            <span><small>Low</small><b>{f(sm.low)}</b></span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Time series as lines and areas. `kind` per series: `area` (filled, for levels such as CPU),
 * `line` (rates), `step` (values that move in steps, such as memory), `dashed` (a limit or capacity).
 * `stacked` piles area series on top of each other (parts of a whole).
 */
export function TimeChart({ series, unit = '', fmt, height = 180, max, stacked = false, stats = true, legend = true, axis = true, label }: {
  series: TSeries[]; unit?: string; fmt?: (v: number) => string; height?: number; max?: number; stacked?: boolean;
  stats?: boolean; legend?: boolean; axis?: boolean; label?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const f = fmt ?? ((v: number) => fmtMetric(unit, v));
  const colored = series.map((s, i) => ({ ...s, kind: s.kind ?? 'line', color: s.color ?? CHART_COLORS[i % CHART_COLORS.length], points: s.points.filter((p) => Number.isFinite(p[1])) }));
  const shown = colored.filter((s) => s.points.length > 1 && !off.has(s.name));
  if (!shown.length) return <div ref={ref} className="bc-empty muted small">No data points.</div>;

  const ref0 = shown.reduce((a, s) => (s.points.length > a.points.length ? s : a), shown[0]).points;
  const t0 = Math.min(...shown.map((s) => s.points[0][0]));
  const t1 = Math.max(...shown.map((s) => s.points[s.points.length - 1][0]));
  // Stacked: each series sits on the running total of the ones before it (aligned by index).
  const base = shown.map(() => [] as number[]);
  const tops = shown.map((s, j) => s.points.map((p, i) => {
    const below = stacked && j > 0 ? base[j - 1][i] ?? 0 : 0;
    const v = (stacked ? below : 0) + p[1];
    base[j][i] = stacked ? v : 0;
    return v;
  }));
  const rawTop = Math.max(...tops.flat(), 1e-9);
  const top = max ?? niceCeil(rawTop * 1.05, unit);
  const H = height, W = w;
  const X = (t: number) => ((t - t0) / Math.max(1e-9, t1 - t0)) * W;
  const Y = (v: number) => H - 2 - (Math.min(v, top) / top) * (H - 6);
  const long = t1 - t0 > 36 * 3600;
  const fmtT = (t: number) => new Date(t * 1000).toLocaleString([], long ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });
  const toggle = (name: string) => setOff((o) => { const s = new Set(o); if (s.has(name)) s.delete(name); else if (colored.length - s.size > 1) s.add(name); return s; });
  const nearestIdx = (pts: Pt[], t: number) => { let b = 0, bd = Infinity; for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i][0] - t); if (d < bd) { bd = d; b = i; } } return b; };
  const at = hover == null ? null : ref0[hover]?.[0] ?? null;
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearestIdx(ref0, t0 + ((e.clientX - r.left) / r.width) * (t1 - t0)));
  };
  const cx = at == null ? 0 : (X(at) / W) * 100;

  return (
    <div className="bc tc" ref={ref}>
      {legend && <ChartLegend series={colored} off={off} onToggle={toggle} f={f}
        values={colored.map((s) => { const j = shown.indexOf(s); if (j < 0) return null; return at != null ? s.points[nearestIdx(s.points, at)][1] : s.points[s.points.length - 1][1]; })} />}
      <div className={`bc-plot ${at != null ? 'hovering' : ''}`} style={{ height }} role="img" aria-label={label ?? `Chart of ${shown.map((s) => s.name).join(', ')}`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {axis && <span className="bc-grid" style={{ bottom: '100%' }}><em>{f(top)}</em></span>}
        {axis && <span className="bc-grid" style={{ bottom: '50%' }} />}
        <svg width={W} height={H} className="tc-svg" aria-hidden="true">
          {shown.map((s, j) => {
            const pts = s.points.map((p, i) => [X(p[0]), Y(tops[j][i])] as [number, number]);
            const path = s.kind === 'step' || s.kind === 'dashed' ? stepPath : s.kind === 'line' && pts.length > 400 ? linear : monotone;
            const d = path(pts);
            const lower = stacked && j > 0 ? s.points.map((p, i) => [X(p[0]), Y(tops[j - 1][i] ?? 0)] as [number, number]).reverse() : null;
            const fill = s.kind === 'area' || (stacked && s.kind !== 'dashed');
            const areaD = fill ? (lower ? `${d}L${lower.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z` : `${d}L${pts[pts.length - 1][0].toFixed(1)},${H}L${pts[0][0].toFixed(1)},${H}Z`) : null;
            return (
              <g key={s.name} className={`tc-s is-${s.kind}`} style={{ '--c': s.color, '--j': j } as CSSProperties}>
                {areaD && <path className="tc-area" d={areaD} />}
                <path className="tc-line" d={d} pathLength={s.kind === 'dashed' ? undefined : 1} />
              </g>
            );
          })}
          {at != null && (
            <g className="tc-cursor">
              <line x1={X(at)} x2={X(at)} y1={0} y2={H} />
              {shown.map((s, j) => {
                const i = nearestIdx(s.points, at);
                return <circle key={s.name} cx={X(s.points[i][0])} cy={Y(tops[j][i])} r={4} style={{ fill: s.color }} />;
              })}
            </g>
          )}
        </svg>
        {at != null && (
          <div className={`tip bc-tip ${cx > 62 ? 'flip' : ''}`} style={cx > 62 ? { right: `${100 - cx}%` } : { left: `${cx}%` }}>
            <b>{new Date(at * 1000).toLocaleString([], long ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'short' })}</b>
            {shown.map((s) => <span key={s.name}><i className={s.kind === 'dashed' ? 'ind-dash' : ''} style={{ background: s.color }} />{s.name}<em>{f(s.points[nearestIdx(s.points, at)][1])}</em></span>)}
          </div>
        )}
      </div>
      {axis && <div className="bc-x"><span>{fmtT(t0)}</span><span>{fmtT((t0 + t1) / 2)}</span><span>{fmtT(t1)}</span></div>}
      {stats && <ChartStats series={shown} f={f} />}
    </div>
  );
}

/** Tiny line for stat tiles (rates and levels); counts use SparkBars. */
export function SparkLine({ values, n = 30, color }: { values: number[]; n?: number; color?: string }) {
  const v = values.slice(-n).filter(Number.isFinite);
  if (v.length < 2) return null;
  const W = 88, H = 30;
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo || 1;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * W, H - 3 - ((x - lo) / span) * (H - 8)] as [number, number]);
  const d = monotone(pts);
  const last = pts[pts.length - 1];
  return (
    <svg className="spark-line" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={color ? { '--sb': color } as CSSProperties : undefined}>
      <path className="sl-area" d={`${d}L${W},${H}L0,${H}Z`} />
      <path className="sl-line" d={d} />
      <circle className="sl-dot" cx={last[0]} cy={last[1]} r={2.75} />
    </svg>
  );
}

/**
 * Radial gauge (a 270° arc with the value in the middle) for single bounded readings such as
 * utilisation, power against its limit, or temperature. Colour follows the thresholds.
 */
export function Gauge({ label, value, max = 100, display, unit, sub, warn = 0.75, crit = 0.9, size = 112 }: {
  label: string; value: number | null; max?: number; display?: string; unit?: string; sub?: ReactNode; warn?: number; crit?: number; size?: number;
}) {
  const r = 42, C = 2 * Math.PI * r, arc = C * 0.75;
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value / (max || 1)));
  const tone = value == null ? 'gray' : pct >= crit ? 'red' : pct >= warn ? 'amber' : 'green';
  return (
    <div className={`gauge g-${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined}>
      <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
        <circle className="g-track" cx="50" cy="50" r={r} strokeDasharray={`${arc} ${C}`} transform="rotate(135 50 50)" />
        <circle className="g-val" cx="50" cy="50" r={r} strokeDasharray={`${arc} ${C}`} strokeDashoffset={arc * (1 - pct)} transform="rotate(135 50 50)" />
      </svg>
      <div className="g-center">
        <b className="num-in" key={display ?? String(value)}>{display ?? (value == null ? '-' : Math.round(value))}</b>
        {unit && <small>{unit}</small>}
      </div>
      <div className="g-label"><span>{label}</span>{sub && <small className="muted">{sub}</small>}</div>
    </div>
  );
}
