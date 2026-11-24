// Applies the `policy:` section of homedash.yaml (config as code) to the database at start-up.
// Declared rows are marked managed = 'config': they are created, updated and removed to match the file, and the UI/API
// refuses to edit them (the next start would undo the edit). Rows made in the UI are never touched.
import { CHANNELS } from './channels.js';
import { defaultCluster, findCluster } from './clusters.js';
import { deleteRoute, deleteScene, deleteSchedule, deleteSilence, isManaged, listScenes, managedRows, markManaged, saveRoute, saveScene, saveSchedule, saveSilence, setSceneCluster, setScheduleCluster, unmanagedNameTaken } from './db.js';
import type { ManagedTable } from './db.js';
import { HttpError } from './errors.js';
import { CATEGORIES } from './notify.js';
import { normalizePolicy } from './policy-schema.js';
import type { Policy } from './policy-schema.js';

const DAY = 86_400_000;

/** Refuses edits to rows that homedash.yaml owns. */
export function assertEditable(table: ManagedTable, id: number) {
  if (isManaged(table, id)) throw new HttpError(409, 'MANAGED', 'This item is declared in homedash.yaml (policy:). Change it there and run homedash-config apply.');
}

export interface PolicyReport { created: number; updated: number; removed: number; skipped: string[] }

/** Idempotent: applying the same policy twice changes nothing the second time. */
export function applyPolicy(policy: Policy, log: (m: string) => void = () => {}): PolicyReport {
  const rep: PolicyReport = { created: 0, updated: 0, removed: 0, skipped: [] };
  const clusterId = (c?: string) => {
    const f = c ? findCluster(c) : undefined;
    if (c && !f) rep.skipped.push(`cluster "${c}" does not exist, using the first cluster`);
    return (f ?? defaultCluster()).id;
  };

  /** Create or update the managed row called `name`; returns its id, or null when a UI-made row owns the name. */
  const upsert = (table: ManagedTable, name: string, save: (id: number | null) => number): number | null => {
    const mine = managedRows(table).find((r) => r.name === name);
    if (!mine && unmanagedNameTaken(table, name)) { rep.skipped.push(`${table} "${name}": a row with this name already exists in the UI; rename or delete it`); return null; }
    const id = save(mine?.id ?? null);
    if (!mine) { markManaged(table, id); rep.created++; } else rep.updated++;
    return id;
  };
  const prune = (table: ManagedTable, keep: Set<string>, del: (id: number) => unknown) => {
    for (const r of managedRows(table)) if (!keep.has(r.name)) { del(r.id); rep.removed++; }
  };

  // Schedules go first on the way out (they point at scenes), scenes first on the way in.
  prune('schedules', new Set(policy.schedules.map((s) => s.name)), deleteSchedule);
  const sceneIds = new Map<string, number>();
  for (const s of policy.scenes) {
    const cl = clusterId(s.cluster);
    const id = upsert('scenes', s.name, (cur) => { const n = saveScene(cur, s.name, s.steps, cl); setSceneCluster(n, cl); return n; });
    if (id !== null) sceneIds.set(s.name, id);
  }
  prune('scenes', new Set(policy.scenes.map((s) => s.name)), deleteScene);

  for (const s of policy.schedules) {
    let sceneId: number | null = null;
    let cl = clusterId(s.cluster);
    if (s.scene !== undefined) {
      sceneId = sceneIds.get(s.scene) ?? null;
      if (sceneId === null) { rep.skipped.push(`schedule "${s.name}": scene "${s.scene}" was not applied`); continue; }
      if (!s.cluster) cl = listScenes().find((x) => x.id === sceneId)?.cluster ?? cl;
    }
    upsert('schedules', s.name, (cur) => {
      const n = saveSchedule(cur, { name: s.name, sceneId, vmid: s.vmid ?? null, action: s.action ?? null, days: s.days, time: s.time, enabled: s.enabled, cluster: cl });
      setScheduleCluster(n, cl);
      return n;
    });
  }

  for (const r of policy.routes) {
    upsert('alert_routes', r.name, (cur) => saveRoute(cur, { name: r.name, enabled: r.enabled, categories: r.categories, minLevel: r.minLevel, contains: r.contains, channels: r.channels, weekly: r.weekly }));
  }
  prune('alert_routes', new Set(policy.routes.map((r) => r.name)), deleteRoute);

  const now = Date.now();
  for (const m of policy.maintenance) {
    upsert('silences', m.name, (cur) => saveSilence(cur, {
      name: m.name, reason: m.reason, categories: m.categories, contains: m.contains, weekly: m.weekly,
      startsAt: m.startsAt ?? now, endsAt: m.endsAt ?? now + 5 * 365 * DAY, createdBy: 'homedash.yaml',
    }));
  }
  prune('silences', new Set(policy.maintenance.map((m) => m.name)), deleteSilence);

  if (rep.created || rep.updated || rep.removed) log(`policy: ${rep.created} created, ${rep.updated} updated, ${rep.removed} removed`);
  return rep;
}

/** Reads POLICY (JSON, written by homedash-config apply) and applies it. Called once at start-up. */
export function applyConfiguredPolicy(log: { info: (m: string) => void; warn: (m: string) => void }) {
  const raw = process.env.POLICY?.trim();
  // No policy: only what an earlier policy created is removed.
  const parsed: unknown = raw ? safeJson(raw) : {};
  if (parsed === undefined) { log.warn('POLICY is not valid JSON; config as code was not applied'); return; }
  const { policy, problems } = normalizePolicy(parsed, { categories: CATEGORIES, channels: CHANNELS.map((c) => c.id) });
  for (const p of problems) log.warn(`policy: ${p}`);
  if (problems.length) { log.warn('policy: not applied because of the problems above (nothing was changed)'); return; }
  const rep = applyPolicy(policy, (m) => log.info(m));
  for (const s of rep.skipped) log.warn(`policy: ${s}`);
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
