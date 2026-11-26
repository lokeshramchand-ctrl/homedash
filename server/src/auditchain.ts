// Tamper-evident audit log. Every audit row stores hash = sha256(previous hash + the row's own fields), so changing
// or deleting a row in the middle of the log breaks every hash after it. Pure functions; db.ts and auditlog.ts use them.
import { createHash } from 'node:crypto';

export interface ChainFields {
  ts: number; user: string | null; ip: string | null; vmid: number; name: string | null; action: string;
  result: string; task_id: string | null; reason: string | null; cluster: string | null;
}

export const chainHash = (prev: string, f: ChainFields): string =>
  createHash('sha256').update(prev).update('\n').update(JSON.stringify([f.ts, f.user, f.ip, f.vmid, f.name, f.action, f.result, f.task_id, f.reason, f.cluster])).digest('hex');

export interface ChainRow extends ChainFields { id: number; prev_hash: string | null; hash: string | null }
export interface ChainReport { ok: boolean; checked: number; head: string | null; brokenAt?: number; problem?: string }

/** Rows must be in id order. Rows written before hashing existed (hash null) are skipped; the chain starts at the first hashed row. */
export function verifyRows(rows: Iterable<ChainRow>): ChainReport {
  let prev: string | null = null, checked = 0;
  for (const r of rows) {
    if (!r.hash) { if (checked) return { ok: false, checked, head: prev, brokenAt: r.id, problem: 'a row without a hash follows hashed rows' }; continue; }
    if (prev !== null && r.prev_hash !== prev) return { ok: false, checked, head: prev, brokenAt: r.id, problem: 'chain link does not match (a row before this one was removed or changed)' };
    if (chainHash(r.prev_hash ?? '', r) !== r.hash) return { ok: false, checked, head: prev, brokenAt: r.id, problem: 'row content does not match its hash (row was edited)' };
    prev = r.hash; checked++;
  }
  return { ok: true, checked, head: prev };
}
