// Per-user UI preferences (tile order, favourites, view mode, accent colour). A small JSON value per user and key.
import type { FastifyInstance } from 'fastify';
import { getDb } from './db.js';
import { HttpError } from './errors.js';

const KEYS = ['tiles', 'theme'];
const MAX = 8 * 1024;

export function getPref(user: string, key: string): unknown {
  const r = getDb().prepare('SELECT value FROM user_prefs WHERE user = ? AND key = ?').get(user, key) as { value: string } | undefined;
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}
export function setPref(user: string, key: string, value: unknown) {
  const text = JSON.stringify(value);
  if (text.length > MAX) throw new HttpError(413, 'TOO_LARGE', 'That preference is too large');
  getDb().prepare('INSERT INTO user_prefs (user, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(user, key, text, Date.now());
}

export function registerPrefs(app: FastifyInstance) {
  const key = (k: string) => { if (!KEYS.includes(k)) throw new HttpError(404, 'NOT_FOUND', 'Unknown preference'); return k; };
  app.get<{ Params: { key: string } }>('/api/prefs/:key', async (req) => ({ value: getPref(req.user!.username, key(req.params.key)) }));
  app.put<{ Params: { key: string }; Body: { value?: unknown } }>('/api/prefs/:key', async (req) => {
    setPref(req.user!.username, key(req.params.key), req.body?.value ?? null);
    return { ok: true };
  });
}
