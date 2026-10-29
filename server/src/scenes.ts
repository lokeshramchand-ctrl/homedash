import type { FastifyInstance } from 'fastify';
import { deleteScene, deleteSchedule, getScene, listScenes, listSchedules, markScheduleRun, saveScene, saveSchedule } from './db.js';
import type { SceneStep, ScheduleRow } from './db.js';
import { logEvent } from './events.js';
import { HttpError } from './errors.js';
import { performGuestAction } from './guests.js';
import type { Action } from './guests.js';
import { pve } from './proxmox.js';
import { cfg, pveConfigured } from './config.js';

// A scene is an ordered list of power steps ("stop the media server, wait, start the gaming VM").
// Schedules run a scene, or one guest action, at a weekday/time in the server's time zone.

const STEP_ACTIONS = ['start', 'shutdown', 'stop', 'reboot'] as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bad = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg);

export function validateSteps(raw: unknown): SceneStep[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) throw bad('A scene needs between 1 and 30 steps');
  return raw.map((s, i) => {
    const vmid = Number(s?.vmid), action = String(s?.action), wait = Number(s?.waitSeconds ?? 0);
    if (!Number.isInteger(vmid) || vmid <= 0) throw bad(`Step ${i + 1}: invalid vmid`);
    if (!(STEP_ACTIONS as readonly string[]).includes(action)) throw bad(`Step ${i + 1}: action must be one of ${STEP_ACTIONS.join(', ')}`);
    if (!Number.isFinite(wait) || wait < 0 || wait > 3600) throw bad(`Step ${i + 1}: wait must be 0-3600 seconds`);
    return { vmid, action: action as SceneStep['action'], waitSeconds: Math.round(wait), continueOnError: !!s?.continueOnError };
  });
}

export function validateSchedule(b: any): Omit<ScheduleRow, 'id' | 'lastRun' | 'lastResult'> {
  const name = String(b?.name ?? '').trim();
  if (!name || name.length > 60) throw bad('Name is required (max 60 characters)');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b?.time ?? ''))) throw bad('Time must be HH:MM (24 hour)');
  const days = [...new Set<number>((Array.isArray(b?.days) ? (b.days as unknown[]) : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!days.length) throw bad('Pick at least one weekday');
  const sceneId = b?.sceneId == null ? null : Number(b.sceneId);
  const vmid = b?.vmid == null ? null : Number(b.vmid);
  if ((sceneId === null) === (vmid === null)) throw bad('Choose either a scene or a single guest action');
  if (sceneId !== null && !getScene(sceneId)) throw bad('Scene does not exist');
  if (vmid !== null && (!Number.isInteger(vmid) || vmid <= 0)) throw bad('Invalid vmid');
  const action = b?.action == null ? null : String(b.action);
  if (vmid !== null && !(STEP_ACTIONS as readonly string[]).includes(action ?? '')) throw bad('Invalid action');
  return { name, sceneId, vmid, action: vmid !== null ? action : null, days: days.sort(), time: String(b.time), enabled: b?.enabled !== false };
}

/** True when a schedule should fire at `now` and has not already fired in this minute. */
export function isDue(s: Pick<ScheduleRow, 'days' | 'time' | 'enabled' | 'lastRun'>, now: Date): boolean {
  if (!s.enabled || !s.days.includes(now.getDay())) return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm !== s.time) return false;
  return !s.lastRun || now.getTime() - s.lastRun > 90_000;
}

interface RunStep { vmid: number; action: string; status: 'pending' | 'running' | 'ok' | 'error' | 'skipped'; message: string }
export interface Run { id: string; scene: string; by: string; startedAt: string; finishedAt: string | null; status: 'running' | 'ok' | 'error'; steps: RunStep[] }
const runs: Run[] = [];

async function waitForTask(taskId: string, timeoutMs = 300_000): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await pve<{ status: string; exitstatus?: string }>('GET', `/nodes/${encodeURIComponent(cfg.pveNode)}/tasks/${encodeURIComponent(taskId)}/status`);
    if (t.status !== 'running') return t.exitstatus === 'OK' ? null : (t.exitstatus ?? 'task failed');
    await sleep(2000);
  }
  return 'timed out waiting for the task';
}

export function runScene(name: string, steps: SceneStep[], by: string, ip: string): Run {
  const run: Run = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, scene: name, by, startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', steps: steps.map((s) => ({ vmid: s.vmid, action: s.action, status: 'pending', message: '' })),
  };
  runs.unshift(run);
  if (runs.length > 20) runs.pop();
  logEvent('info', 'app', `Scene "${name}" started by ${by}`);
  void (async () => {
    let failed = false;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i], rs = run.steps[i];
      if (failed) { rs.status = 'skipped'; rs.message = 'an earlier step failed'; continue; }
      rs.status = 'running';
      try {
        const taskId = await performGuestAction(st.vmid, st.action as Action, by, ip);
        const err = await waitForTask(taskId);
        if (err) throw new Error(err);
        rs.status = 'ok';
        if (st.waitSeconds) { rs.message = `waited ${st.waitSeconds}s`; await sleep(st.waitSeconds * 1000); }
      } catch (e) {
        rs.status = 'error'; rs.message = (e as Error).message;
        if (!st.continueOnError) failed = true;
      }
    }
    run.status = run.steps.some((s) => s.status === 'error') ? 'error' : 'ok';
    run.finishedAt = new Date().toISOString();
    logEvent(run.status === 'ok' ? 'info' : 'warn', 'app', `Scene "${name}" ${run.status === 'ok' ? 'finished' : 'finished with errors'}`);
  })();
  return run;
}

export function startScheduler() {
  if (!pveConfigured()) return;
  setInterval(() => {
    const now = new Date();
    let list: ScheduleRow[];
    try { list = listSchedules(); } catch { return; }
    for (const s of list) {
      if (!isDue(s, now)) continue;
      const by = `schedule:${s.name}`;
      if (s.sceneId !== null) {
        const scene = getScene(s.sceneId);
        if (!scene) { markScheduleRun(s.id, 'scene no longer exists'); continue; }
        runScene(scene.name, scene.steps, by, 'schedule');
        markScheduleRun(s.id, `started scene ${scene.name}`);
      } else if (s.vmid !== null && s.action) {
        markScheduleRun(s.id, 'started');
        performGuestAction(s.vmid, s.action as Action, by, 'schedule')
          .then(() => { markScheduleRun(s.id, `${s.action} accepted`); logEvent('info', 'guest', `Schedule "${s.name}": ${s.action} guest ${s.vmid}`); })
          .catch((e) => { markScheduleRun(s.id, `failed: ${(e as Error).message}`); logEvent('warn', 'guest', `Schedule "${s.name}" failed: ${(e as Error).message}`); });
      }
    }
  }, 20_000).unref();
}

export function registerScenes(app: FastifyInstance) {
  const id = (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id'); return n; };
  const nameOf = (b: any) => { const n = String(b?.name ?? '').trim(); if (!n || n.length > 60) throw bad('Name is required (max 60 characters)'); return n; };
  const unique = (fn: () => number) => { try { return fn(); } catch (e) { if (/UNIQUE/.test((e as Error).message)) throw new HttpError(409, 'EXISTS', 'A scene with that name already exists'); throw e; } };

  app.get('/api/scenes', async () => listScenes());
  app.post<{ Body: { name?: string; steps?: unknown } }>('/api/scenes', async (req) => ({ id: unique(() => saveScene(null, nameOf(req.body), validateSteps(req.body?.steps))) }));
  app.put<{ Params: { id: string }; Body: { name?: string; steps?: unknown } }>('/api/scenes/:id', async (req) => {
    const sid = id(req.params.id);
    if (!getScene(sid)) throw new HttpError(404, 'NOT_FOUND', 'Scene not found');
    return { id: unique(() => saveScene(sid, nameOf(req.body), validateSteps(req.body?.steps))) };
  });
  app.delete<{ Params: { id: string } }>('/api/scenes/:id', async (req) => { deleteScene(id(req.params.id)); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/scenes/:id/run', async (req) => {
    if (!pveConfigured()) throw new HttpError(503, 'NOT_CONFIGURED', 'Proxmox is not configured on the server');
    const scene = getScene(id(req.params.id));
    if (!scene) throw new HttpError(404, 'NOT_FOUND', 'Scene not found');
    return runScene(scene.name, scene.steps, req.user!.username, req.ip);
  });
  app.get('/api/scenes/runs', async () => runs);

  app.get('/api/schedules', async () => listSchedules());
  app.post<{ Body: unknown }>('/api/schedules', async (req) => ({ id: saveSchedule(null, validateSchedule(req.body)) }));
  app.put<{ Params: { id: string }; Body: unknown }>('/api/schedules/:id', async (req) => ({ id: saveSchedule(id(req.params.id), validateSchedule(req.body)) }));
  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req) => { deleteSchedule(id(req.params.id)); return { ok: true }; });
}
