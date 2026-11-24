// Config as code: scenes, schedules, alert routes and maintenance windows declared under `policy:` in homedash.yaml.
// This file is pure (no database, no server config) so the CLI can validate exactly what the server will apply.
export type Raw = Record<string, any>;

export interface PolicyStep { vmid: number; action: 'start' | 'shutdown' | 'stop' | 'reboot'; waitSeconds: number; continueOnError: boolean }
export interface Weekly { days: number[]; start: string; minutes: number }
export interface PolicyScene { name: string; cluster?: string; steps: PolicyStep[] }
export interface PolicySchedule { name: string; scene?: string; vmid?: number; action?: string; days: number[]; time: string; enabled: boolean; cluster?: string }
export interface PolicyRoute { name: string; enabled: boolean; categories: string[]; minLevel: 'info' | 'warn' | 'error'; contains: string; channels: string[]; weekly: Weekly | null }
export interface PolicyWindow { name: string; reason: string; categories: string[]; contains: string; weekly: Weekly | null; startsAt?: number; endsAt?: number }
export interface Policy { scenes: PolicyScene[]; schedules: PolicySchedule[]; routes: PolicyRoute[]; maintenance: PolicyWindow[] }
export interface Allowed { categories: readonly string[]; channels: readonly string[] }

export const POLICY_KEYS = ['scenes', 'schedules', 'alert_routes', 'maintenance'];
const ACTIONS = ['start', 'shutdown', 'stop', 'reboot'];
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** [mon, tue], [1, 2], "weekdays", "weekends", "daily" -> sorted weekday numbers (0 = Sunday). Null when invalid. */
export function parseDays(v: unknown): number[] | null {
  const list = Array.isArray(v) ? v : [v];
  const out = new Set<number>();
  for (const x of list) {
    const s = String(x).trim().toLowerCase();
    if (s === 'daily' || s === 'everyday') [0, 1, 2, 3, 4, 5, 6].forEach((d) => out.add(d));
    else if (s === 'weekdays') [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (s === 'weekends') [0, 6].forEach((d) => out.add(d));
    else if (/^[0-6]$/.test(s)) out.add(Number(s));
    else if (DAYS[s.slice(0, 3)] !== undefined && /^[a-z]+$/.test(s)) out.add(DAYS[s.slice(0, 3)]);
    else return null;
  }
  return out.size ? [...out].sort() : null;
}

const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export function normalizePolicy(raw: unknown, allowed: Allowed): { policy: Policy; problems: string[] } {
  const problems: string[] = [];
  const policy: Policy = { scenes: [], schedules: [], routes: [], maintenance: [] };
  if (raw === undefined || raw === null) return { policy, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { policy, problems: ['policy: must be a mapping with scenes, schedules, alert_routes and/or maintenance'] };
  const y = raw as Raw;
  for (const k of Object.keys(y)) if (!POLICY_KEYS.includes(k)) problems.push(`policy.${k}: unknown key (valid: ${POLICY_KEYS.join(', ')})`);
  const list = (k: string): Raw[] => { const v = y[k]; if (v === undefined || v === null) return []; if (!Array.isArray(v)) { problems.push(`policy.${k}: must be a list`); return []; } return v; };

  const names = (k: string) => new Set<string>();
  const seen: Record<string, Set<string>> = { scenes: names('s'), schedules: names('c'), alert_routes: names('r'), maintenance: names('m') };
  const nameOf = (k: string, item: Raw, where: string): string | null => {
    const n = str(item?.name, 80);
    if (!n) { problems.push(`${where}: name is required`); return null; }
    if (seen[k].has(n)) { problems.push(`${where}: duplicate name "${n}"`); return null; }
    seen[k].add(n);
    return n;
  };
  const weekly = (v: unknown, where: string): Weekly | null => {
    if (v === undefined || v === null) return null;
    const w = v as Raw;
    const days = parseDays(w.days);
    if (!days) { problems.push(`${where}.days: use weekday names (mon, tue, ...), numbers 0-6, weekdays, weekends or daily`); return null; }
    if (!HHMM.test(String(w.start ?? ''))) { problems.push(`${where}.start: must look like 22:00`); return null; }
    const minutes = Math.floor(Number(w.minutes ?? w.duration_minutes));
    if (!(minutes >= 1 && minutes <= 1440)) { problems.push(`${where}.minutes: 1 to 1440`); return null; }
    return { days, start: String(w.start), minutes };
  };
  const cats = (v: unknown, where: string): string[] => {
    const l = v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
    for (const c of l) if (!allowed.categories.includes(c)) problems.push(`${where}.categories: unknown category "${c}" (valid: ${allowed.categories.join(', ')})`);
    return [...new Set(l)];
  };

  list('scenes').forEach((s, i) => {
    const where = `policy.scenes[${i}]`;
    const name = nameOf('scenes', s, where);
    if (!name) return;
    const steps = Array.isArray(s.steps) ? s.steps : [];
    if (steps.length < 1 || steps.length > 30) { problems.push(`${where}.steps: between 1 and 30 steps`); return; }
    const out: PolicyStep[] = [];
    steps.forEach((st: Raw, j: number) => {
      const w = `${where}.steps[${j}]`;
      const vmid = Number(st?.vmid), wait = Number(st?.wait_seconds ?? st?.waitSeconds ?? 0), action = String(st?.action ?? '');
      if (!Number.isInteger(vmid) || vmid <= 0) return void problems.push(`${w}.vmid: invalid`);
      if (!ACTIONS.includes(action)) return void problems.push(`${w}.action: one of ${ACTIONS.join(', ')}`);
      if (!(wait >= 0 && wait <= 3600)) return void problems.push(`${w}.wait_seconds: 0 to 3600`);
      out.push({ vmid, action: action as PolicyStep['action'], waitSeconds: Math.round(wait), continueOnError: (st?.continue_on_error ?? st?.continueOnError) === true });
    });
    if (out.length === steps.length) policy.scenes.push({ name, ...(s.cluster ? { cluster: String(s.cluster) } : {}), steps: out });
  });

  list('schedules').forEach((s, i) => {
    const where = `policy.schedules[${i}]`;
    const name = nameOf('schedules', s, where);
    if (!name) return;
    const days = parseDays(s.days);
    if (!days) return void problems.push(`${where}.days: use weekday names (mon, tue, ...), numbers 0-6, weekdays, weekends or daily`);
    if (!HHMM.test(String(s.time ?? ''))) return void problems.push(`${where}.time: HH:MM, 24 hour`);
    const hasScene = s.scene !== undefined && s.scene !== null, hasVm = s.vmid !== undefined && s.vmid !== null;
    if (hasScene === hasVm) return void problems.push(`${where}: give either scene: <name> or vmid + action`);
    if (hasScene && !policy.scenes.some((x) => x.name === String(s.scene)) && !y.scenes?.some?.((x: Raw) => x?.name === s.scene)) problems.push(`${where}.scene: "${s.scene}" is not declared in policy.scenes (scenes made in the UI cannot be referenced)`);
    if (hasVm && !(Number.isInteger(Number(s.vmid)) && Number(s.vmid) > 0)) return void problems.push(`${where}.vmid: invalid`);
    if (hasVm && !ACTIONS.includes(String(s.action))) return void problems.push(`${where}.action: one of ${ACTIONS.join(', ')}`);
    policy.schedules.push({
      name, days, time: String(s.time), enabled: s.enabled !== false, ...(s.cluster ? { cluster: String(s.cluster) } : {}),
      ...(hasScene ? { scene: String(s.scene) } : { vmid: Number(s.vmid), action: String(s.action) }),
    });
  });

  list('alert_routes').forEach((r, i) => {
    const where = `policy.alert_routes[${i}]`;
    const name = nameOf('alert_routes', r, where);
    if (!name) return;
    const channels = [...new Set((Array.isArray(r.channels) ? r.channels : r.channels ? [r.channels] : []).map(String))];
    if (!channels.length) return void problems.push(`${where}.channels: pick at least one`);
    for (const c of channels) if (!allowed.channels.includes(c)) problems.push(`${where}.channels: unknown channel "${c}" (valid: ${allowed.channels.join(', ')})`);
    const lvl = String(r.min_level ?? 'info');
    if (!['info', 'warn', 'error'].includes(lvl)) problems.push(`${where}.min_level: info, warn or error`);
    policy.routes.push({ name, enabled: r.enabled !== false, categories: cats(r.categories, where), minLevel: (['info', 'warn', 'error'].includes(lvl) ? lvl : 'info') as PolicyRoute['minLevel'], contains: str(r.contains, 100), channels, weekly: weekly(r.weekly, `${where}.weekly`) });
  });

  list('maintenance').forEach((m, i) => {
    const where = `policy.maintenance[${i}]`;
    const name = nameOf('maintenance', m, where);
    if (!name) return;
    const w = weekly(m.weekly, `${where}.weekly`);
    const startsAt = m.starts_at ? Date.parse(String(m.starts_at)) : undefined, endsAt = m.ends_at ? Date.parse(String(m.ends_at)) : undefined;
    if (!w && !(startsAt && endsAt)) return void problems.push(`${where}: give weekly: { days, start, minutes } or both starts_at and ends_at`);
    if ((m.starts_at && Number.isNaN(startsAt)) || (m.ends_at && Number.isNaN(endsAt))) return void problems.push(`${where}: starts_at / ends_at must be dates like 2026-12-24T22:00:00Z`);
    if (startsAt && endsAt && endsAt <= startsAt) return void problems.push(`${where}: ends_at must be after starts_at`);
    policy.maintenance.push({ name, reason: str(m.reason, 300), categories: cats(m.categories, where), contains: str(m.contains, 100), weekly: w, ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) });
  });

  return { policy, problems };
}

export const isEmptyPolicy = (p: Policy) => !p.scenes.length && !p.schedules.length && !p.routes.length && !p.maintenance.length;
