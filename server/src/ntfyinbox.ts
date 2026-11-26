// ntfy inbox: what has been published to the alert topic, read back from ntfy so it can be seen without opening ntfy.
// Uses the documented poll mode (GET /<topic>/json?poll=1&since=all, newline-delimited JSON). ntfy keeps messages only for
// its cache duration (12 h by default), so this is a recent-history view, not an archive.
// Reading needs a token or user that may READ the topic. A write-only token is fine for sending alerts but is refused here;
// that shows up as `error`, never as an empty inbox.
import type { FastifyInstance } from 'fastify';
import { fetch } from 'undici';
import { cfg, ntfyConfigured } from './config.js';

export interface NtfyMessage { id: string; time: number; title: string; message: string; priority: number; tags: string[]; click: string | null }
export interface NtfyInbox { configured: boolean; topic: string; messages: NtfyMessage[]; checkedAt: number; error: string | null }

const MAX = 100;
const safeUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 500) : null);

/** Pure: the body of a poll response. Keeps real messages only (not open/keepalive events), newest first, at most 100. */
export function parseNtfyLines(text: string): NtfyMessage[] {
  const out: NtfyMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j?.event !== 'message' || typeof j.id !== 'string') continue;
    const prio = Number(j.priority);
    out.push({
      id: j.id, time: Number(j.time) * 1000 || 0,
      title: typeof j.title === 'string' ? j.title.slice(0, 200) : '',
      message: typeof j.message === 'string' ? j.message.slice(0, 1000) : '',
      priority: prio >= 1 && prio <= 5 ? prio : 3,
      tags: Array.isArray(j.tags) ? j.tags.filter((t: unknown) => typeof t === 'string').slice(0, 8) : [],
      click: safeUrl(j.click),
    });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, MAX);
}

const TTL_MS = 15_000;
let cache: { at: number; inbox: NtfyInbox } | null = null;

export async function ntfyInbox(): Promise<NtfyInbox> {
  const base = { topic: cfg.ntfy.topic, checkedAt: Date.now() };
  if (!ntfyConfigured()) return { configured: false, messages: [], error: null, ...base };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.inbox;
  try {
    const res = await fetch(`${cfg.ntfy.url}/${encodeURIComponent(cfg.ntfy.topic)}/json?poll=1&since=all`, {
      headers: cfg.ntfy.token ? { Authorization: `Bearer ${cfg.ntfy.token}` } : {}, signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { configured: true, messages: [], error: 'ntfy refused to let homedash read this topic. Sending alerts works with a write-only token, but the inbox needs one that can also read the topic.', ...base };
    if (!res.ok) return { configured: true, messages: [], error: `ntfy answered ${res.status}`, ...base };
    const inbox: NtfyInbox = { configured: true, messages: parseNtfyLines(await res.text()), error: null, ...base };
    cache = { at: Date.now(), inbox };
    return inbox;
  } catch (e) {
    return { configured: true, messages: [], error: `Cannot reach ntfy: ${(e as Error).message}`, ...base };
  }
}

export function registerNtfyInbox(app: FastifyInstance) {
  app.get('/api/ntfy/inbox', async () => ntfyInbox());
}
