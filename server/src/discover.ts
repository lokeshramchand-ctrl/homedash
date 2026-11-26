// Finds services to add: looks at the running guests Proxmox knows about, asks each address for the well-known pages of the
// services in the catalogue (tile-kinds.ts) and suggests a tile for every one that answers like the real thing.
// Only addresses of your own guests are contacted, only plain GETs are sent, and no credentials are involved.
import type { FastifyInstance } from 'fastify';
import { Agent } from 'undici';
import { KINDS } from './tile-kinds.js';
import type { KindInfo } from './tile-kinds.js';
import { buildNetMap, pool } from './insights.js';
import type { GuestNet } from './insights.js';
import { tileCfgs } from './tiles.js';

export interface Suggestion { kind: string; label: string; category: string; url: string; port: number; guest: { vmid: number; name: string }; name: string }
export interface Target { ip: string; guest: { vmid: number; name: string } }

/** Pure: does this answer look like the service? */
export function looksLike(info: KindInfo, status: number, body: string): boolean {
  const p = info.probe;
  if (!p) return false;
  if (p.status && !p.status.includes(status)) return false;
  if (p.match) return status > 0 && status < 500 && new RegExp(p.match, 'i').test(body);
  return status >= 200 && status < 300;
}

/** Pure: one address per running guest (runtime addresses first), skipping ones that are already tiles. */
export function targetsOf(guests: GuestNet[]): Target[] {
  const out: Target[] = [];
  for (const g of guests) {
    if (g.status !== 'running') continue;
    const ips = [...g.ips].sort((a, b) => Number(b.source !== 'config') - Number(a.source !== 'config'));
    const seen = new Set<string>();
    for (const i of ips) if (!seen.has(i.ip)) { seen.add(i.ip); out.push({ ip: i.ip, guest: { vmid: g.vmid, name: g.name } }); }
  }
  return out;
}

const hostPort = (url: string): string | null => {
  try { const u = new URL(url.replace(/^tcp:/, 'http:')); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`; } catch { return null; }
};
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

async function fetchSnippet(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.5' },
      // @ts-expect-error undici dispatcher is not in the DOM fetch typings
      dispatcher: insecure });
    const reader = res.body?.getReader();
    let body = '';
    if (reader) { // never read more than 64 KB of somebody else's page
      const dec = new TextDecoder();
      while (body.length < 65536) { const { done, value } = await reader.read(); if (done) break; body += dec.decode(value, { stream: true }); }
      void reader.cancel().catch(() => {});
    }
    return { status: res.status, body };
  } catch { return { status: 0, body: '' }; }
}

/** Probes every target × every catalogued port. Returns one suggestion per (address, port) that matches a kind. */
export async function scan(targets: Target[], known: Set<string>, kinds: KindInfo[] = KINDS, timeoutMs = 2500): Promise<Suggestion[]> {
  const jobs: { t: Target; k: KindInfo; port: number }[] = [];
  for (const t of targets) for (const k of kinds) if (k.probe) for (const port of k.ports) if (!known.has(`${t.ip}:${port}`)) jobs.push({ t, k, port });
  const hits = await pool(jobs, 24, async ({ t, k, port }): Promise<Suggestion | null> => {
    const schemes = k.https || port === 443 ? ['https', 'http'] : ['http', 'https'];
    for (const scheme of schemes) {
      const { status, body } = await fetchSnippet(`${scheme}://${t.ip}:${port}${k.probe!.path}`, timeoutMs);
      if (status === 0) continue; // nothing there on this scheme
      if (looksLike(k, status, body)) return { kind: k.kind, label: k.label, category: k.category, url: `${scheme}://${t.ip}:${port}`, port, guest: t.guest, name: `${k.label} (${t.guest.name})` };
      break; // something answered but it is not this service
    }
    return null;
  });
  const out: Suggestion[] = [];
  const taken = new Set<string>();
  for (const h of hits) {
    if (!h) continue;
    const key = `${h.url}`;
    if (taken.has(key)) continue; // two kinds claiming the same port: first (catalogue order) wins
    taken.add(key); out.push(h);
  }
  return out.sort((a, b) => a.guest.vmid - b.guest.vmid || a.label.localeCompare(b.label));
}

export function registerDiscover(app: FastifyInstance) {
  // Admin only (it contacts your guests); /api/admin is covered by the role table.
  app.get('/api/admin/tiles/discover', async () => {
    const { guests } = await buildNetMap();
    const known = new Set(tileCfgs().map((t) => hostPort(t.url)).filter((x): x is string => !!x));
    const targets = targetsOf(guests);
    const found = await scan(targets, known);
    return { scanned: targets.length, found };
  });
}
