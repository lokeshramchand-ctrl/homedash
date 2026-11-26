// "Your most used": a small per-person counter of the pages, service tiles and source kinds a person opens, so the dashboard can put
// theirs first. Only an item id is stored (never a URL, name or content), always for the signed-in user, and nobody can read
// anyone else's. The score decays with a 30 day half-life, applied on write and on read, so it needs no background job.
import type { FastifyInstance } from 'fastify';
import { getDb } from './db.js';
import { HttpError } from './errors.js';

const DAY = 86_400_000;
export const HALF_LIFE_MS = 30 * DAY;
export const MIN_GAP_MS = 30_000; // the same item counts at most once per 30 s
export const MAX_ITEMS = 200;
const FADED = 0.3; // below this a person's single, old visit no longer shows
export const ITEM_RE = /^(page|tile|kind):[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Pure: a score after `now - lastAt` has passed. */
export const decay = (score: number, lastAt: number, now: number): number => score * Math.pow(0.5, Math.max(0, now - lastAt) / HALF_LIFE_MS);

interface Row { item: string; score: number; last_at: number }

/** Counts one use. Returns false when it was ignored because the same item was counted less than 30 s ago. */
export function bump(user: string, item: string, now = Date.now()): boolean {
  const db = getDb();
  const prev = db.prepare('SELECT item, score, last_at FROM user_usage WHERE user = ? AND item = ?').get(user, item) as unknown as Row | undefined;
  if (prev && now - prev.last_at < MIN_GAP_MS) return false;
  db.prepare('INSERT INTO user_usage (user, item, score, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (user, item) DO UPDATE SET score = excluded.score, last_at = excluded.last_at')
    .run(user, item, (prev ? decay(prev.score, prev.last_at, now) : 0) + 1, now);
  const all = db.prepare('SELECT item, score, last_at FROM user_usage WHERE user = ?').all(user) as unknown as Row[];
  if (all.length > MAX_ITEMS) {
    const worst = all.map((r) => ({ item: r.item, s: decay(r.score, r.last_at, now) })).sort((a, b) => a.s - b.s).slice(0, all.length - MAX_ITEMS);
    for (const w of worst) db.prepare('DELETE FROM user_usage WHERE user = ? AND item = ?').run(user, w.item);
  }
  return true;
}

/** This person's items, highest decayed score first. Items that have faded away are left out. */
export function top(user: string, limit = 8, now = Date.now()): { item: string; score: number }[] {
  const rows = getDb().prepare('SELECT item, score, last_at FROM user_usage WHERE user = ?').all(user) as unknown as Row[];
  return rows.map((r) => ({ item: r.item, score: Math.round(decay(r.score, r.last_at, now) * 100) / 100 }))
    .filter((r) => r.score >= FADED).sort((a, b) => b.score - a.score || a.item.localeCompare(b.item)).slice(0, limit);
}

/** Clears this person's history. Returns how many items were removed. */
export const reset = (user: string): number => Number(getDb().prepare('DELETE FROM user_usage WHERE user = ?').run(user).changes);

export function registerUsage(app: FastifyInstance) {
  app.post<{ Body: { item?: unknown } }>('/api/usage', async (req) => {
    const item = typeof req.body?.item === 'string' ? req.body.item : '';
    if (!ITEM_RE.test(item)) throw new HttpError(400, 'BAD_REQUEST', 'Unknown item');
    return { counted: bump(req.user!.username, item) };
  });
  app.get<{ Querystring: { limit?: string } }>('/api/usage/top', async (req) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '8', 10) || 8, 1), 20);
    return { items: top(req.user!.username, limit) };
  });
  app.delete('/api/usage', async (req) => ({ removed: reset(req.user!.username) }));
}
