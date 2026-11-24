// Mining guard for the GPU in a Windows VM (GPU_AGENT_URL).
//
// Idea: the only legitimate reasons for the GPU to be busy are llama-server answering a request
// or something the owner expects (desktop, browser, a game they snoozed for). A miner is busy all
// the time and never has a request. So we alert when
//     GPU utilisation stays high  AND  llama-server reports no work  AND  no allow-listed process explains it
// for several minutes in a row. That catches a miner whatever it is called.
//
// Inputs (both read-only, polled from here, nothing is trusted blindly):
//   - a tiny agent inside Windows (scripts/windows/gpu-agent.ps1) that reports GPU utilisation and
//     the busiest processes (per-process GPU engine counters). The host has no NVIDIA driver, so
//     this cannot be read from the Proxmox side.
//   - llama-server's own /slots endpoint (is_processing + task id per slot). A changed task id
//     between two polls means a request ran in between, even if it finished quickly.
// If the agent goes silent while the VM runs, that is reported too ("blind"): a miner would kill it.
import type { FastifyInstance } from 'fastify';
import { cfg, gpuWatchConfigured, pveConfigured } from './config.js';
import { getState, listGpuSamples, setState, upsertGpuSample } from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { alert } from './notify.js';
import { guestNode } from './guests.js';
import { pve } from './proxmox.js';

// ---------- types ----------
export interface GpuProc { pid: number; name: string; util: number }
export interface Reading { gpuName: string; util: number | null; memUsed: number | null; memTotal: number | null; tempC: number | null; powerW: number | null; procs: GpuProc[] }
export interface LlamaState { reachable: boolean; busy: boolean }
export interface Sample { ts: number; gpu: Reading | null; llama: LlamaState | null }
export type Verdict = 'ok' | 'suspect' | 'unknown';
export interface Judgement { verdict: Verdict; reason: string }
export interface Rules { utilPct: number; allow: string[]; snoozed: boolean }

// ---------- parsing (the agent is on a machine we are worried about: treat its output as untrusted data) ----------
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '?').slice(0, max) : '');

/** Accepts the agent's JSON and returns a clean reading, or null if it is not the expected shape. */
export function parseAgent(raw: unknown): Reading | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const gpus = Array.isArray(o.gpus) ? o.gpus.filter((g) => g && typeof g === 'object') as Record<string, unknown>[] : [];
  if (gpus.length === 0) return null;
  // Several GPUs: the busiest one matters.
  const g = [...gpus].sort((a, b) => (num(b.util) ?? -1) - (num(a.util) ?? -1))[0];
  const util = num(g.util);
  const procs: GpuProc[] = (Array.isArray(o.procs) ? o.procs : [])
    .slice(0, 40)
    .map((p) => {
      const r = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      const pid = num(r.pid);
      const u = num(r.util);
      return pid != null && u != null ? { pid: Math.trunc(pid), name: text(r.name, 80) || `pid ${Math.trunc(pid)}`, util: clamp(u, 0, 100) } : null;
    })
    .filter((p): p is GpuProc => p !== null)
    .sort((a, b) => b.util - a.util)
    .slice(0, 10);
  return {
    gpuName: text(g.name, 80) || 'GPU',
    util: util == null ? null : clamp(util, 0, 100),
    memUsed: num(g.memUsed), memTotal: num(g.memTotal), tempC: num(g.tempC), powerW: num(g.powerW),
    procs,
  };
}

/** /slots of llama-server -> busy flag. `lastTasks` carries the task ids seen last time (a new id = a request ran in between). */
export function parseSlots(raw: unknown, lastTasks: Map<number, number>): LlamaState {
  const slots = Array.isArray(raw) ? raw : [];
  let busy = false;
  for (const s of slots) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const id = num(r.id) ?? 0;
    const task = num(r.id_task);
    if (r.is_processing === true) busy = true;
    if (task != null) {
      const prev = lastTasks.get(id);
      if (prev !== undefined && prev !== task) busy = true;
      lastTasks.set(id, task);
    }
  }
  return { reachable: true, busy };
}

// ---------- the decision ----------
const norm = (n: string) => n.toLowerCase();

/** Pure: is this single sample explained or suspicious? */
export function judge(s: Sample, rules: Rules): Judgement {
  if (!s.gpu || s.gpu.util == null) return { verdict: 'unknown', reason: 'No GPU reading from the agent.' };
  const u = s.gpu.util;
  if (u < rules.utilPct) return { verdict: 'ok', reason: `GPU at ${u.toFixed(0)}%, below the ${rules.utilPct}% limit.` };
  if (rules.snoozed) return { verdict: 'ok', reason: `GPU at ${u.toFixed(0)}% but alerts are snoozed.` };
  if (s.llama?.busy) return { verdict: 'ok', reason: `GPU at ${u.toFixed(0)}% and llama-server is serving a request.` };
  const allow = new Set(rules.allow.map(norm));
  // Busiest processes first; anything over 10% GPU that is not on the allow-list is unexplained.
  const unexplained = s.gpu.procs.filter((p) => p.util >= 10 && !allow.has(norm(p.name)));
  const llamaNote = s.llama == null ? 'llama-server status is unavailable' : s.llama.reachable ? 'llama-server has no requests' : 'llama-server is not answering';
  if (s.gpu.procs.length > 0 && unexplained.length === 0) {
    return { verdict: 'ok', reason: `GPU at ${u.toFixed(0)}%, explained by allow-listed ${s.gpu.procs[0].name}.` };
  }
  const who = unexplained.length ? unexplained.slice(0, 3).map((p) => `${p.name} ${p.util.toFixed(0)}%`).join(', ') : 'no process could be identified';
  return { verdict: 'suspect', reason: `GPU at ${u.toFixed(0)}%, ${llamaNote}. Busiest: ${who}.` };
}

export type DetectorState = 'ok' | 'watching' | 'alert';
export interface DetectorEvent { kind: 'alert' | 'reminder' | 'recovered'; reason: string; since: number }

/** Turns a stream of judgements into alert/recovery events. Pure apart from the clock passed in. */
export class Detector {
  state: DetectorState = 'ok';
  suspectSince: number | null = null;
  alertSince: number | null = null;
  private okStreak = 0;
  private lastNotice = 0;
  constructor(private minutes: number, private reminderMin = 30) {}

  setMinutes(m: number) { this.minutes = m; }

  push(j: Judgement, now: number): DetectorEvent | null {
    if (j.verdict === 'unknown') return null; // no information: neither extend nor clear
    if (j.verdict === 'suspect') {
      this.okStreak = 0;
      this.suspectSince ??= now;
      if (this.state === 'alert') {
        if (now - this.lastNotice >= this.reminderMin * 60_000) { this.lastNotice = now; return { kind: 'reminder', reason: j.reason, since: this.alertSince ?? this.suspectSince }; }
        return null;
      }
      if (now - this.suspectSince >= this.minutes * 60_000) {
        this.state = 'alert'; this.alertSince = now; this.lastNotice = now;
        return { kind: 'alert', reason: j.reason, since: this.suspectSince };
      }
      this.state = 'watching';
      return null;
    }
    // ok: needs 3 calm samples in a row to leave the alert state (no flapping), clears the watch at once
    this.okStreak++;
    if (this.state === 'alert') {
      if (this.okStreak < 3) return null;
      const since = this.alertSince ?? now;
      this.state = 'ok'; this.suspectSince = null; this.alertSince = null;
      return { kind: 'recovered', reason: j.reason, since };
    }
    this.state = 'ok'; this.suspectSince = null;
    return null;
  }

  reset() { this.state = 'ok'; this.suspectSince = null; this.alertSince = null; this.okStreak = 0; }
}

// ---------- runtime ----------
export type WatchState = 'off' | 'ok' | 'watching' | 'alert' | 'blind' | 'vm-off' | 'snoozed';
interface Point { t: number; util: number; busy: boolean }

const detector = new Detector(cfg.gpuWatch.minutes);
const lastTasks = new Map<number, number>();
let latest: Sample | null = null;
let lastJudgement: Judgement | null = null;
let lastGpuAt = 0;
let blind = false;
let vmRunning: boolean | null = null;
let snoozedUntil = 0;
let running = false;
const ring: Point[] = []; // fallback for the chart while Mongo is unreachable

const bearer = (t: string) => (t ? { Authorization: `Bearer ${t}` } : undefined);

async function fetchAgent(): Promise<Reading | null> {
  try {
    const res = await fetch(`${cfg.gpuWatch.agentUrl}/gpu`, { headers: bearer(cfg.gpuWatch.agentToken), signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    return parseAgent(await res.json());
  } catch { return null; }
}

async function fetchLlama(): Promise<LlamaState | null> {
  if (!cfg.gpuWatch.llamaUrl) return null;
  try {
    const res = await fetch(`${cfg.gpuWatch.llamaUrl}/slots`, { headers: bearer(cfg.gpuWatch.llamaKey), signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return { reachable: res.status === 401 || res.status === 403 ? true : false, busy: false };
    return parseSlots(await res.json(), lastTasks);
  } catch { return { reachable: false, busy: false }; }
}

async function vmIsRunning(): Promise<boolean | null> {
  if (!pveConfigured()) return null;
  try {
    const s = await pve<{ status?: string }>('GET', `${await guestNode(cfg.gpuWatch.vmid)}/qemu/${cfg.gpuWatch.vmid}/status/current`);
    return s.status === 'running';
  } catch { return null; }
}

const title = (s: string) => `${s} · GPU on ${cfg.pveNode || 'host'}`;

async function persist(s: Sample) {
  if (!s.gpu || s.gpu.util == null) return;
  const minute = Math.floor(s.ts / 60_000);
  try {
    upsertGpuSample(minute, s.gpu.util, s.llama?.busy ? 1 : 0, s.gpu.procs[0]?.name ?? '', s.ts + 3 * 86_400_000);
  } catch { /* chart falls back to memory */ }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const [gpu, llama] = await Promise.all([fetchAgent(), fetchLlama()]);
    const sample: Sample = { ts: now, gpu, llama };
    latest = sample;
    if (gpu) { lastGpuAt = now; ring.push({ t: now, util: gpu.util ?? 0, busy: !!llama?.busy }); if (ring.length > 1500) ring.shift(); void persist(sample); }

    // Is the monitor itself blind? (agent silent while the VM runs)
    vmRunning = await vmIsRunning();
    // Silent since the last good reading, or since startup if there never was one.
    const shouldBeBlind = vmRunning === true && !gpu && now - (lastGpuAt || startedAt) >= cfg.gpuWatch.blindMinutes * 60_000;
    if (shouldBeBlind && !blind) {
      blind = true;
      const msg = `The GPU agent in VM ${cfg.gpuWatch.vmid} has not answered for ${cfg.gpuWatch.blindMinutes}+ minutes while the VM is running, so GPU use cannot be checked. A miner may have stopped it.`;
      logEvent('warn', 'host', `GPU watch is blind: ${msg}`);
      alert('gpu', 'warn', title('Mining guard blind'), msg, 'gpuwatch|blind');
    } else if (blind && gpu) {
      blind = false;
      logEvent('info', 'host', 'GPU watch can see the agent again');
      alert('gpu', 'info', title('Mining guard back'), 'The GPU agent answers again.', 'gpuwatch|blind|ok');
    }

    const snoozed = snoozedUntil > now;
    const j = judge(sample, { utilPct: cfg.gpuWatch.utilPct, allow: cfg.gpuWatch.allow, snoozed });
    lastJudgement = j;
    if (snoozed && detector.state !== 'ok') detector.reset();
    const ev = detector.push(j, now);
    if (!ev) return;
    const mins = Math.max(1, Math.round((now - ev.since) / 60_000));
    if (ev.kind === 'recovered') {
      logEvent('info', 'host', `GPU use is explained again: ${ev.reason}`);
      alert('gpu', 'info', title('GPU activity explained'), `${ev.reason} The GPU use that raised the alert has ended.`, 'gpuwatch|alert|ok');
    } else {
      const msg = `${ev.reason} Busy for about ${mins} min with no llama requests. If this is not you, check VM ${cfg.gpuWatch.vmid} for a miner.`;
      logEvent('error', 'host', `Possible GPU abuse: ${msg}`, { reason: ev.reason, minutes: mins });
      alert('gpu', 'error', title(ev.kind === 'reminder' ? 'Still unexplained GPU load' : 'Unexplained GPU load'), msg, `gpuwatch|alert|${ev.kind === 'reminder' ? now : 'first'}`);
    }
  } finally { running = false; }
}

const startedAt = Date.now();

function stateNow(): WatchState {
  if (!gpuWatchConfigured()) return 'off';
  if (snoozedUntil > Date.now()) return 'snoozed';
  if (vmRunning === false) return 'vm-off';
  if (blind) return 'blind';
  return detector.state;
}

async function history(hours: number): Promise<Point[]> {
  const from = Math.floor((Date.now() - hours * 3_600_000) / 60_000);
  try {
    return listGpuSamples(from, 1500).map((r) => ({ t: r.minute * 60_000, util: r.util, busy: r.busy === 1 }));
  } catch { return ring.filter((p) => p.t >= from * 60_000); }
}

export async function loadSnooze() {
  try {
    const v = getState('gpuwatch-snooze') as { until?: number } | undefined;
    if (v?.until && v.until > Date.now()) snoozedUntil = v.until;
  } catch { /* none */ }
}

export function startGpuWatch(app: FastifyInstance) {
  if (!gpuWatchConfigured()) { app.log.warn('GPU_AGENT_URL not set; GPU mining guard disabled'); return; }
  void loadSnooze();
  const t = setInterval(() => { tick().catch((e) => app.log.warn({ err: (e as Error).message }, 'gpu watch failed')); }, cfg.gpuWatch.pollMs);
  t.unref();
  setTimeout(() => void tick().catch(() => {}), 3_000).unref();
}

export function registerGpuWatch(app: FastifyInstance) {
  app.get('/api/gpuwatch', async () => {
    const configured = gpuWatchConfigured();
    const g = latest?.gpu ?? null;
    return {
      configured,
      llamaConfigured: !!cfg.gpuWatch.llamaUrl,
      state: stateNow(),
      thresholds: { utilPct: cfg.gpuWatch.utilPct, minutes: cfg.gpuWatch.minutes, blindMinutes: cfg.gpuWatch.blindMinutes, allow: cfg.gpuWatch.allow },
      latest: g ? { ts: latest!.ts, gpuName: g.gpuName, util: g.util, memUsed: g.memUsed, memTotal: g.memTotal, tempC: g.tempC, powerW: g.powerW, procs: g.procs } : null,
      llama: latest?.llama ?? null,
      verdict: lastJudgement?.verdict ?? null,
      reason: lastJudgement?.reason ?? '',
      suspectSince: detector.suspectSince ? new Date(detector.suspectSince).toISOString() : null,
      alertSince: detector.alertSince ? new Date(detector.alertSince).toISOString() : null,
      snoozedUntil: snoozedUntil > Date.now() ? new Date(snoozedUntil).toISOString() : null,
      lastSampleAt: lastGpuAt ? new Date(lastGpuAt).toISOString() : null,
      vmRunning,
      history: configured ? await history(6) : [],
    };
  });

  // "I am gaming / rendering": suppress the alert for a while. 0 clears. Max 24 h so it cannot be left on by accident.
  app.post<{ Body: { minutes?: number } }>('/api/gpuwatch/snooze', async (req) => {
    const m = Number(req.body?.minutes);
    if (!Number.isFinite(m) || m < 0 || m > 1440) throw new HttpError(400, 'BAD_REQUEST', 'minutes must be between 0 and 1440');
    snoozedUntil = m > 0 ? Date.now() + m * 60_000 : 0;
    setState('gpuwatch-snooze', { until: snoozedUntil });
    if (m === 0) detector.reset();
    logEvent('info', 'host', m > 0 ? `GPU mining guard snoozed for ${m} min by ${req.user?.username ?? 'admin'}` : `GPU mining guard resumed by ${req.user?.username ?? 'admin'}`);
    return { snoozedUntil: snoozedUntil ? new Date(snoozedUntil).toISOString() : null };
  });
}
