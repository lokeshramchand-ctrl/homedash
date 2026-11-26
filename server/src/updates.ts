// "A new version is out": compares the running version with the latest GitHub release. Off unless UPDATE_CHECK is set, because
// it makes an outbound request to api.github.com. It never installs anything: updating is `update` in the container console.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const ON = ['1', 'true', 'yes', 'on'].includes((process.env.UPDATE_CHECK ?? '').trim().toLowerCase());
const REPO = (process.env.UPDATE_REPO ?? 'lokeshramchand-ctrl/homedash').trim();

export function currentVersion(): string {
  try { return String(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version ?? '0.0.0'); } catch { return '0.0.0'; }
}

const parts = (v: string) => v.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
/** Pure: is `latest` a higher version than `current`? Pre-release suffixes are ignored. */
export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return false;
}

interface Info { latest: string | null; url: string | null; checkedAt: number | null; error: string | null }
let info: Info = { latest: null, url: null, checkedAt: null, error: null };

export async function checkNow(fetcher: typeof fetch = fetch): Promise<Info> {
  try {
    const res = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'homedash-update-check' }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) info = { latest: null, url: null, checkedAt: Date.now(), error: null }; // no release yet
    else if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    else { const j = (await res.json()) as { tag_name?: string; html_url?: string }; info = { latest: j.tag_name ?? null, url: j.html_url ?? null, checkedAt: Date.now(), error: null }; }
  } catch (e) { info = { ...info, checkedAt: Date.now(), error: (e as Error).message }; }
  return info;
}

export const versionState = () => {
  const current = currentVersion();
  return { enabled: ON, current, latest: info.latest, url: info.url, available: !!info.latest && isNewer(info.latest, current), checkedAt: info.checkedAt, error: info.error };
};

export function startUpdateCheck() {
  if (!ON) return;
  setTimeout(() => void checkNow(), 30_000).unref();
  setInterval(() => void checkNow(), 12 * 3_600_000).unref();
}

export function registerUpdates(app: FastifyInstance) {
  app.get('/api/version', async () => versionState());
}
