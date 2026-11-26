// Export and import of the Services layout (order, pins, view, accent) as a small JSON file.
// An imported file is untrusted input: only known fields survive, with strict limits.
export interface LayoutFile { order: string[]; fav: string[]; view: 'cards' | 'launcher'; accent: string }

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100).slice(0, 500) : []);

/** Returns a clean layout, or null when the text is not a homedash layout file. */
export function parseLayoutFile(text: string): LayoutFile | null {
  if (text.length > 64 * 1024) return null;
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (o.homedash !== 'services-layout') return null;
  return {
    order: ids(o.order), fav: ids(o.fav),
    view: o.view === 'launcher' ? 'launcher' : 'cards',
    accent: typeof o.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.accent) ? o.accent : '#0870b9',
  };
}

export const layoutFileText = (l: LayoutFile): string => JSON.stringify({ homedash: 'services-layout', version: 1, ...l }, null, 2) + '\n';
