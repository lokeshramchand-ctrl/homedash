// Service tiles created in the UI ("Add service"). Stored in the ui_tiles table; tokens and passwords are sealed with
// SECRETS_KEY (or DATASOURCE_KEY / MFA_KEY when that is what the install has). Tiles declared in homedash.yaml are separate
// and read-only in the UI.
import { randomBytes } from 'node:crypto';
import { cfg } from './config.js';
import type { TileCfg } from './config.js';
import { assertDestinationAllowed } from './datasources/netguard.js';
import type { ConnConfig } from './datasources/core/types.js';
import { getDb } from './db.js';
import { HttpError } from './errors.js';
import { seal, unseal } from './seal.js';
import { kindInfo, missingFields } from './tile-kinds.js';

export const sealKey = (): string => [process.env.SECRETS_KEY, process.env.DATASOURCE_KEY, process.env.MFA_KEY].map((k) => (k ?? '').trim()).find((k) => k.length >= 16) ?? '';
export const uiTilesAvailable = () => sealKey() !== '';

interface Row { id: string; name: string; kind: string; config: string; secret: string; created_at: number; created_by: string | null }
type Plain = Omit<TileCfg, 'id' | 'name' | 'kind' | 'token' | 'password'>;
const bad = (m: string) => new HttpError(400, 'BAD_REQUEST', m);

/** A UI tile as the edit form needs it: everything except the secrets, which are only reported as present or not. */
export interface UiTile { id: string; name: string; kind: string; config: Plain; hasToken: boolean; hasPassword: boolean; createdAt: number; createdBy: string | null }

function load(r: Row): { tile: TileCfg; hasToken: boolean; hasPassword: boolean; row: Row } {
  const plain = JSON.parse(r.config) as Plain;
  const sec = unseal<{ token?: string; password?: string }>(sealKey(), r.id, r.secret);
  return { tile: { id: r.id, name: r.name, kind: r.kind, ...plain, token: sec.token ?? '', password: sec.password ?? '' }, hasToken: !!sec.token, hasPassword: !!sec.password, row: r };
}

/** Every UI tile, ready to poll. A row that cannot be opened (key changed) is skipped, not fatal. */
export function loadUiTiles(warn: (m: string) => void = () => {}): TileCfg[] {
  if (!uiTilesAvailable()) return [];
  const out: TileCfg[] = [];
  for (const r of getDb().prepare('SELECT * FROM ui_tiles ORDER BY created_at').all() as unknown as Row[]) {
    try { out.push(load(r).tile); } catch { warn(`tile "${r.name}" cannot be opened (was the secret key changed?)`); }
  }
  return out;
}

export function listUiTiles(): UiTile[] {
  if (!uiTilesAvailable()) return [];
  const out: UiTile[] = [];
  for (const r of getDb().prepare('SELECT * FROM ui_tiles ORDER BY created_at').all() as unknown as Row[]) {
    try { const l = load(r); const { id, name, kind, token: _t, password: _p, ...config } = l.tile; out.push({ id, name, kind, config, hasToken: l.hasToken, hasPassword: l.hasPassword, createdAt: r.created_at, createdBy: r.created_by }); } catch { /* unreadable */ }
  }
  return out;
}

const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** Validates a form body into a TileCfg. `prev` supplies secrets the form left blank (edit). */
export async function buildTile(body: Record<string, unknown>, id: string, prev?: TileCfg): Promise<TileCfg> {
  const kind = str(body.kind, 30);
  const info = kindInfo(kind);
  if (!info) throw bad('Pick a kind of service');
  const url = str(body.url, 300).replace(/\/+$/, '');
  if (!/^(https?|tcp):\/\/[^\s/]+/.test(url)) throw bad('The address must start with http:// or https:// (tcp:// for a UPS)');
  if (kind === 'nut' ? !url.startsWith('tcp://') : url.startsWith('tcp://')) throw bad(kind === 'nut' ? 'A UPS address looks like tcp://host:3493' : 'Use an http:// or https:// address');
  // Never let this form point the server at link-local / cloud-metadata addresses.
  await assertDestinationAllowed({ uri: url } as ConnConfig, [], true);
  const name = str(body.name, 40) || info.label;
  const keep = (field: 'token' | 'password') => (typeof body[field] === 'string' && (body[field] as string) !== '' ? String(body[field]).trim() : prev?.[field] ?? '');
  const t: TileCfg = {
    id, kind, name, url, publicUrl: str(body.publicUrl ?? body.public_url, 300).replace(/\/+$/, ''), group: str(body.group, 30),
    token: keep('token'), password: keep('password'), username: str(body.username, 120), ups: str(body.ups, 60),
    insecureTls: body.insecureTls === true || body.insecure_tls === true, pollSeconds: Math.min(Math.max(Number(body.pollSeconds ?? body.poll_seconds ?? 60) || 60, 15), 3600),
    path: str(body.path, 200) || '/',
    stats: (Array.isArray(body.stats) ? (body.stats as Record<string, unknown>[]) : []).map((s) => ({ label: str(s?.label, 30), path: str(s?.path, 100) })).filter((s) => s.label && s.path).slice(0, 8),
  };
  if (t.publicUrl && !/^https?:\/\/[^\s/]+/.test(t.publicUrl)) throw bad('The link must start with http:// or https://');
  const miss = missingFields(kind, t);
  if (miss.length) throw bad(`${info.label} needs: ${miss.join(', ')}. ${info.hint}`);
  return t;
}

export function saveUiTile(t: TileCfg, user: string, create: boolean) {
  const key = sealKey();
  if (!key) throw new HttpError(503, 'NO_SECRET_KEY', 'Set SECRETS_KEY (homedash-config apply creates one) before adding services from the UI');
  const { id, name, kind, token, password, ...plain } = t;
  const secret = seal(key, id, { token, password });
  if (create) getDb().prepare('INSERT INTO ui_tiles (id, name, kind, config, secret, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, kind, JSON.stringify(plain), secret, Date.now(), user);
  else getDb().prepare('UPDATE ui_tiles SET name = ?, kind = ?, config = ?, secret = ? WHERE id = ?').run(name, kind, JSON.stringify(plain), secret, id);
}

export const deleteUiTile = (id: string): boolean => Number(getDb().prepare('DELETE FROM ui_tiles WHERE id = ?').run(id).changes) > 0;
export const getUiTile = (id: string): TileCfg | undefined => {
  const r = getDb().prepare('SELECT * FROM ui_tiles WHERE id = ?').get(id) as unknown as Row | undefined;
  if (!r || !uiTilesAvailable()) return undefined;
  try { return load(r).tile; } catch { return undefined; }
};
export const newUiId = () => `ui-${randomBytes(4).toString('hex')}`;

/** Tiles from homedash.yaml and from the UI, with ids that cannot clash. */
export const yamlTiles = (): TileCfg[] => cfg.tiles;
