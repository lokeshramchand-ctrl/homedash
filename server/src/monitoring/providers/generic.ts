// The custom HTTP source: one configurable request and one of four readings of the answer. Nothing here knows any particular tool;
// well-known tools are templates (saved configuration) that fill this in.
import { mapPromText, parsePromText } from '../prometheus-text.js';
import { buildRequest } from '../request.js';
import type { HttpConfig } from '../request.js';
import type { LoadedSource } from '../store.js';
import type { Check, Polled, Provider } from '../types.js';
import { assertUsable, requestText } from './http.js';
import { mapJson, mapJsonAlerts } from './jsonpoll.js';

export const PARSE_MODES = ['json_checks', 'json_alerts', 'prometheus', 'status'] as const;

/** Pure: "200-399, 401" to a test on a status code. Defaults to 200 to 399. */
export function parseCodes(text: string | undefined): (code: number) => boolean {
  const ranges = String(text ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
    return m ? ([Number(m[1]), Number(m[2] ?? m[1])] as [number, number]) : null;
  }).filter((r): r is [number, number] => !!r);
  const use = ranges.length ? ranges : [[200, 399] as [number, number]];
  return (code) => use.some(([a, b]) => code >= a && code <= b);
}

export const genericProvider = (s: LoadedSource): Provider => ({
  kind: 'http', label: s.name, raisesChecks: true, configured: () => !!s.config.url,
  async poll(): Promise<Polled> {
    const mode = s.config.parse || 'json_checks';
    const insecure = s.config.insecure_tls === 'true';
    const built = buildRequest(s.config as HttpConfig, s.secrets.secret ?? '');
    if (mode === 'status') {
      // Reachability: the thing being unreachable is the finding, not a failure to read.
      const started = Date.now();
      let check: Check;
      try {
        const { status, text } = await requestText(built, insecure);
        const needle = (s.config.must_contain ?? '').trim();
        const okCode = parseCodes(s.config.ok_codes)(status);
        const okText = !needle || text.includes(needle);
        check = { key: s.id, name: s.name, status: okCode && okText ? 'up' : 'down', since: null, ping: Date.now() - started, url: null,
          detail: !okCode ? `HTTP ${status}` : !okText ? `The answer does not contain "${needle.slice(0, 40)}"` : `HTTP ${status}, ${Date.now() - started} ms` };
      } catch (e) {
        check = { key: s.id, name: s.name, status: 'down', since: null, detail: (e as Error).message, url: null };
      }
      return { checks: [check], alerts: [] };
    }
    const { status, text } = await requestText(built, insecure);
    assertUsable(status);
    if (mode === 'prometheus') return { checks: mapPromText(parsePromText(text), s.config), alerts: [] };
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error('The answer is not JSON'); }
    if (mode === 'json_alerts') return { checks: [], alerts: mapJsonAlerts(body, s.config) };
    if (mode === 'json_checks') return { checks: mapJson(body, s.config), alerts: [] };
    throw new Error('Unknown way of reading the answer');
  },
});
