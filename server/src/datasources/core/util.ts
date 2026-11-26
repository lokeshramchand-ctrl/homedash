// Value normalisation shared by every driver: whatever an engine returns must survive JSON.stringify
// and stay readable in a grid.

const CELL_MAX = 2000;

export function jsonSafe(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'bigint': return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    case 'number': return Number.isFinite(v) ? v : String(v);
    case 'string': case 'boolean': return v;
    case 'object': break;
    default: return String(v);
  }
  if (depth > 12) return '[nested too deep]';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return { $binary: b.subarray(0, 64).toString('hex') + (b.length > 64 ? '…' : ''), bytes: b.length };
  }
  if (Array.isArray(v)) return v.map((x) => jsonSafe(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafe(x, depth + 1);
  return out;
}

/** Shortens very long strings so a grid page stays small; full values come from getRecord. */
export function clip(v: unknown): unknown {
  if (typeof v === 'string' && v.length > CELL_MAX) return `${v.slice(0, CELL_MAX)}… [+${v.length - CELL_MAX} chars]`;
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    if (s.length > CELL_MAX * 2) return `${s.slice(0, CELL_MAX)}… [+${s.length - CELL_MAX} chars]`;
  }
  return v;
}

export const clipRow = (r: Record<string, unknown>): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) o[k] = clip(v);
  return o;
};

/** Column names in first-seen order across rows, `lead` fields first. */
export function columnsOf(rows: Record<string, unknown>[], lead: string[] = []): string[] {
  const seen = new Set<string>(lead);
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen].filter((k) => rows.length === 0 || rows.some((r) => k in r) || lead.includes(k));
}

/** Duplicate column names (SELECT a.id, b.id) would collapse in an object row: suffix them. */
export function uniqueNames(names: string[]): string[] {
  const n = new Map<string, number>();
  return names.map((x) => {
    const c = (n.get(x) ?? 0) + 1;
    n.set(x, c);
    return c === 1 ? x : `${x}_${c}`;
  });
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Splits a command line into arguments, honouring "double", 'single' quotes and backslash escapes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < line.length) {
        const n = line[++i];
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
      } else if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (q) throw new Error('Unbalanced quote in command');
  if (has || cur) out.push(cur);
  return out;
}

/** Strips one trailing semicolon; returns null when more statements follow (cannot be wrapped safely). */
export function singleStatement(sql: string): string | null {
  const t = sql.trim().replace(/;+\s*$/, '');
  if (/;/.test(t.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g, ''))) return null;
  return t;
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
