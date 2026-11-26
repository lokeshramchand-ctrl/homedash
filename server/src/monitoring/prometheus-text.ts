// The Prometheus text exposition format ("/metrics" pages): `name{label="value",...} number [timestamp]`, with `#` comment lines.
// Most self-hosted tools expose one. This reads it and turns chosen series into checks. Nothing is evaluated beyond a comparison.
import { holds, parseCondition } from './conditions.js';
import type { Check } from './types.js';

export interface Series { name: string; labels: Record<string, string>; value: number }

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+(\S+)(?:[ \t]+\S+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const MAX_SERIES = 20_000;

const unescape = (s: string) => s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c));

/** Pure: a whole metrics page to its series. Comments, blank lines and unparsable lines are skipped; NaN values are dropped. */
export function parsePromText(text: string): Series[] {
  const out: Series[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const v = m[3] === '+Inf' || m[3] === 'Inf' ? Infinity : m[3] === '-Inf' ? -Infinity : Number(m[3]);
    if (Number.isNaN(v)) continue;
    const labels: Record<string, string> = {};
    if (m[2]) for (const l of m[2].matchAll(LABEL)) labels[l[1]] = unescape(l[2]);
    out.push({ name: m[1], labels, value: v });
    if (out.length >= MAX_SERIES) break;
  }
  return out;
}

export interface PromRule { metric?: string; label_filter?: string; name_label?: string; up_when?: string; warn_when?: string }

/** Pure: "job=node, env=prod" to exact-match filters. */
export function parseLabelFilter(text: string | undefined): [string, string][] {
  return String(text ?? '').split(/[,\n]/).map((p) => p.split('=')).filter((p) => p.length === 2 && p[0].trim()).map((p) => [p[0].trim(), p[1].trim().replace(/^"|"$/g, '')] as [string, string]);
}

/**
 * Pure: series of one metric to checks. `up_when` (default "== 1") makes a series up; if it does not hold, `warn_when` makes it
 * pending; otherwise it is down. The check is named by `name_label` when the series has it, else by the metric and its labels.
 */
export function mapPromText(series: Series[], rule: PromRule): Check[] {
  const metric = (rule.metric ?? '').trim();
  if (!metric) throw new Error('Say which metric to read');
  const up = parseCondition(rule.up_when ?? '== 1');
  if (!up) throw new Error(`"${rule.up_when}" is not a comparison like == 1 or < 90`);
  const warn = rule.warn_when ? parseCondition(rule.warn_when) : null;
  if (rule.warn_when && !warn) throw new Error(`"${rule.warn_when}" is not a comparison like == 1 or < 90`);
  const filters = parseLabelFilter(rule.label_filter);
  const out: Check[] = [];
  for (const s of series) {
    if (s.name !== metric || !filters.every(([k, v]) => s.labels[k] === v)) continue;
    const pairs = Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(', ');
    const name = ((rule.name_label && s.labels[rule.name_label]) || (pairs ? `${metric} (${pairs})` : metric)).slice(0, 100);
    const status = holds(up, s.value) ? 'up' : warn && holds(warn, s.value) ? 'pending' : 'down';
    out.push({ key: `${name}|${pairs}`.slice(0, 200), name, status, since: null, detail: `${metric} = ${s.value}`, url: null });
    if (out.length >= 500) break;
  }
  return out;
}
