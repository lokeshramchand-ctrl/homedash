// Who gets an alert and when:
//   - SILENCES (maintenance windows) hold alerts back, one-off or weekly, optionally only for some categories or text.
//     A silenced alert is still recorded in the history so nothing is hidden, and recoveries are never silenced for
//     incident tools (an incident must still close).
//   - ROUTES choose which channels an alert goes to by category, level, text and time of day (for example: errors page
//     PagerDuty, warnings go to Slack, nights go to a different channel). When no route matches, the normal per-channel
//     settings apply, so adding a route can never make an alert disappear.
import type { FastifyInstance } from 'fastify';
import { deleteRoute, deleteSilence, listRoutes, listSilences, saveRoute, saveSilence } from './db.js';
import type { RouteRow, SilenceRow, WeeklyWindow } from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { assertEditable } from './policy.js';

export type Level = 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = 86_400_000;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True when `now` falls inside the weekly window (server local time). Windows may run past midnight. */
export function inWeekly(w: WeeklyWindow | null, now = new Date()): boolean {
  if (!w) return true;
  const start = minutesOf(w.start);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // started today
  if (w.days.includes(now.getDay()) && nowMin >= start && nowMin < start + w.minutes) return true;
  // started yesterday and still running after midnight
  const yesterday = (now.getDay() + 6) % 7;
  return w.days.includes(yesterday) && start + w.minutes > 1440 && nowMin < start + w.minutes - 1440;
}

const textMatch = (needle: string, title: string, message: string) => !needle || `${title}\n${message}`.toLowerCase().includes(needle.toLowerCase());

/** The silence that applies right now to this alert, if any. */
export function silenceFor(category: string, title: string, message: string, now = Date.now()): SilenceRow | null {
  for (const s of listSilences()) {
    if (now < s.startsAt || now > s.endsAt) continue;
    if (s.categories.length && !s.categories.includes(category)) continue;
    if (!textMatch(s.contains, title, message)) continue;
    if (!inWeekly(s.weekly, new Date(now))) continue;
    return s;
  }
  return null;
}

/** Channel ids chosen by the matching routes (union), or null when no route matches. */
export function routeChannels(category: string, level: Level, title: string, message: string, now = Date.now()): { channels: string[]; names: string[] } | null {
  const hit = listRoutes().filter((r) =>
    r.enabled && RANK[level] >= RANK[r.minLevel] && (!r.categories.length || r.categories.includes(category)) && textMatch(r.contains, title, message) && inWeekly(r.weekly, new Date(now)));
  if (!hit.length) return null;
  return { channels: [...new Set(hit.flatMap((r) => r.channels))], names: hit.map((r) => r.name) };
}

// ------------------------------------------------------------------------------------------ API
function weeklyFrom(v: unknown): WeeklyWindow | null {
  if (v === null || v === undefined) return null;
  const w = v as { days?: unknown; start?: unknown; minutes?: unknown };
  const days = Array.isArray(w.days) ? w.days.map(Number) : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'BAD_REQUEST', 'weekly.days must be weekdays 0 (Sunday) to 6');
  if (typeof w.start !== 'string' || !HHMM.test(w.start)) throw new HttpError(400, 'BAD_REQUEST', 'weekly.start must look like 22:00');
  const minutes = Math.floor(Number(w.minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(400, 'BAD_REQUEST', 'weekly.minutes must be 1 to 1440');
  return { days: [...new Set(days)].sort(), start: w.start, minutes };
}
const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export function registerAlertRules(app: FastifyInstance, categories: readonly string[], channelIds: readonly string[]) {
  const cats = (v: unknown): string[] => {
    const list = Array.isArray(v) ? v.map(String) : [];
    const bad = list.find((c) => !categories.includes(c));
    if (bad) throw new HttpError(400, 'BAD_REQUEST', `Unknown category "${bad}"`);
    return [...new Set(list)];
  };
  const view = <T extends { startsAt?: number; endsAt?: number }>(x: T) => x;

  // ---- silences
  app.get('/api/notify/silences', async () => {
    const now = Date.now();
    return listSilences().map((s) => ({ ...view(s), active: now >= s.startsAt && now <= s.endsAt && inWeekly(s.weekly), upcoming: s.startsAt > now, expired: s.endsAt < now && !s.weekly }));
  });

  const silenceBody = (b: Record<string, unknown>, user: string): Omit<SilenceRow, 'id' | 'createdAt'> => {
    const name = str(b.name, 80);
    if (!name) throw new HttpError(400, 'BAD_REQUEST', 'Give the window a name');
    const weekly = weeklyFrom(b.weekly);
    const now = Date.now();
    const startsAt = b.startsAt ? Date.parse(String(b.startsAt)) : now;
    // A weekly window lasts until you delete it unless an end is given; a one-off needs an end.
    const endsAt = b.endsAt ? Date.parse(String(b.endsAt)) : weekly ? now + 5 * 365 * DAY : NaN;
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw new HttpError(400, 'BAD_REQUEST', 'startsAt and endsAt must be dates');
    if (endsAt <= startsAt) throw new HttpError(400, 'BAD_REQUEST', 'The end must be after the start');
    if (!weekly && endsAt - startsAt > 30 * DAY) throw new HttpError(400, 'BAD_REQUEST', 'A one-off window is limited to 30 days; use a weekly window for something recurring');
    return { name, reason: str(b.reason, 300), startsAt, endsAt, categories: cats(b.categories), contains: str(b.contains, 100), weekly, createdBy: user };
  };
  app.post<{ Body: Record<string, unknown> }>('/api/notify/silences', async (req) => {
    const s = silenceBody(req.body ?? {}, req.user!.username);
    const id = saveSilence(null, s);
    logEvent('info', 'auth', `${req.user!.username} created the alert silence "${s.name}"`, { ip: req.ip });
    return { id };
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/notify/silences/:id', async (req) => {
    const id = Number(req.params.id);
    const cur = listSilences().find((x) => x.id === id);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'No such silence');
    assertEditable('silences', id);
    saveSilence(id, { ...silenceBody(req.body ?? {}, cur.createdBy) });
    return { id };
  });
  app.delete<{ Params: { id: string } }>('/api/notify/silences/:id', async (req) => {
    assertEditable('silences', Number(req.params.id));
    if (!deleteSilence(Number(req.params.id))) throw new HttpError(404, 'NOT_FOUND', 'No such silence');
    logEvent('info', 'auth', `${req.user!.username} removed alert silence #${req.params.id}`, { ip: req.ip });
    return { ok: true };
  });

  // ---- routes (writes are administration: the role table makes them admin-only)
  app.get('/api/notify/routes', async () => listRoutes());
  const routeBody = (b: Record<string, unknown>): Omit<RouteRow, 'id' | 'position'> => {
    const name = str(b.name, 80);
    if (!name) throw new HttpError(400, 'BAD_REQUEST', 'Give the route a name');
    const channels = Array.isArray(b.channels) ? [...new Set(b.channels.map(String))] : [];
    if (!channels.length) throw new HttpError(400, 'BAD_REQUEST', 'Pick at least one channel');
    const bad = channels.find((c) => !channelIds.includes(c));
    if (bad) throw new HttpError(400, 'BAD_REQUEST', `Unknown channel "${bad}"`);
    const minLevel = (['info', 'warn', 'error'] as const).find((l) => l === b.minLevel) ?? 'info';
    return { name, enabled: b.enabled !== false, categories: cats(b.categories), minLevel, contains: str(b.contains, 100), channels, weekly: weeklyFrom(b.weekly) };
  };
  app.post<{ Body: Record<string, unknown> }>('/api/notify/routes', async (req) => {
    const r = routeBody(req.body ?? {});
    logEvent('info', 'auth', `${req.user!.username} added the alert route "${r.name}"`, { ip: req.ip });
    return { id: saveRoute(null, r) };
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/notify/routes/:id', async (req) => {
    const id = Number(req.params.id);
    if (!listRoutes().some((x) => x.id === id)) throw new HttpError(404, 'NOT_FOUND', 'No such route');
    assertEditable('alert_routes', id);
    saveRoute(id, routeBody(req.body ?? {}));
    return { id };
  });
  app.delete<{ Params: { id: string } }>('/api/notify/routes/:id', async (req) => {
    assertEditable('alert_routes', Number(req.params.id));
    if (!deleteRoute(Number(req.params.id))) throw new HttpError(404, 'NOT_FOUND', 'No such route');
    logEvent('info', 'auth', `${req.user!.username} removed alert route #${req.params.id}`, { ip: req.ip });
    return { ok: true };
  });

  // Preview: which channels would an alert like this reach, and would it be silenced? Used by the UI form.
  app.post<{ Body: { category?: string; level?: Level; title?: string; message?: string } }>('/api/notify/preview', async (req) => {
    const b = req.body ?? {};
    const level: Level = (['info', 'warn', 'error'] as const).find((l) => l === b.level) ?? 'error';
    const category = String(b.category ?? 'host');
    const sil = silenceFor(category, str(b.title, 200), str(b.message, 500));
    const route = routeChannels(category, level, str(b.title, 200), str(b.message, 500));
    return { silencedBy: sil?.name ?? null, routedBy: route?.names ?? [], channels: route?.channels ?? null };
  });
}
