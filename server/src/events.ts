import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { forEachCluster, multiCluster, where } from './clusters.js';
import { cfg, pveConfigured } from './config.js';
import { countEvents, getState, hasRecentAccepted, insertEvent, listEvents, setState } from './db.js';
import type { EventRow } from './db.js';
import { HttpError } from './errors.js';
import { listGuests } from './guests.js';
import { alertFromEvent } from './notify.js';
import { pve } from './proxmox.js';

const run = promisify(execFile);
const DAY = 86_400_000;
type Level = EventRow['level'];
type Source = EventRow['source'];

export function logEvent(level: Level, source: Source, message: string, data?: Record<string, unknown>) {
  try {
    insertEvent({ ts: Date.now(), level, source, message, data: data ?? null }, cfg.eventRetentionDays);
  } catch { /* never let logging take the dashboard down */ }
  alertFromEvent(level, source, message);
}

const fmtAgo = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

/** Called once at startup: records the start and works out whether the last run ended cleanly. */
async function recordStart() {
  const hb = getState('heartbeat');
  const stop = getState('clean-stop');
  const lastSeen = typeof hb?.ts === 'string' ? new Date(hb.ts) : null;
  const stoppedAt = typeof stop?.ts === 'string' ? new Date(stop.ts) : null;
  if (lastSeen && (!stoppedAt || stoppedAt < lastSeen)) {
    const gap = Date.now() - lastSeen.getTime();
    logEvent('error', 'app', `Dashboard did not shut down cleanly. Last heartbeat ${fmtAgo(gap)} ago (crash, kill, or host power loss)`, { lastSeen: lastSeen.toISOString() });
  }
  logEvent('info', 'app', 'Dashboard started', { pid: process.pid, node: process.version });
}

// Everything below is per cluster: state is keyed by cluster id, and messages name the cluster when there are several.
const tag = (id: string) => (multiCluster() ? ` [${id}]` : '');

async function hostWatch() {
  if (!pveConfigured()) return;
  await forEachCluster(async (c) => {
    try {
      // One call gives every node's uptime (on a stand-alone node it is just that node).
      const nodes = await pve<{ node: string; status?: string; uptime?: number }[]>('GET', '/cluster/resources?type=node');
      for (const n of nodes) {
        if (n.status !== 'online') continue;
        const key = c.id === 'default' && n.node === c.node ? 'host-boot' : `host-boot:${c.id}:${n.node}`;
        const bootedAt = Date.now() - Number(n.uptime ?? 0) * 1000;
        const prev = getState(key);
        if (typeof prev?.bootedAt === 'number' && Math.abs(bootedAt - prev.bootedAt) > 120_000 && bootedAt > prev.bootedAt) {
          logEvent('error', 'host', `Proxmox host ${where(n.node, c)} rebooted`, { previousBoot: new Date(prev.bootedAt).toISOString(), bootedAt: new Date(bootedAt).toISOString() });
        }
        if (!prev || Math.abs(bootedAt - Number(prev.bootedAt)) > 120_000) setState(key, { bootedAt });
      }
    } catch { /* the guest watcher reports Proxmox being unreachable */ }
  });
}

const guestState = new Map<string, { status: string; node: string }>(); // "<cluster>:<vmid>"
const pveDown = new Set<string>();
async function guestWatch() {
  if (!pveConfigured()) return;
  await forEachCluster(async (c) => {
    try {
      const seen = new Set<string>();
      for (const g of await listGuests()) {
        const key = `${c.id}:${g.vmid}`;
        seen.add(key);
        const was = guestState.get(key);
        guestState.set(key, { status: g.status, node: g.node });
        if (!was) continue;
        const label = `${g.name} (${g.vmid}${multiCluster() ? `, ${c.name}` : ''})`;
        if (was.node !== g.node) logEvent('info', 'guest', `${label} moved from node ${was.node} to ${g.node}`, { vmid: g.vmid, from: was.node, to: g.node });
        if (was.status !== g.status) {
          // A stop nobody asked the dashboard for is the interesting case.
          const recent = hasRecentAccepted(g.vmid, Date.now() - 5 * 60_000);
          const unexpected = g.status === 'stopped' && !recent;
          logEvent(unexpected ? 'error' : 'info', 'guest', `${label} ${was.status} → ${g.status}${unexpected ? ' (not requested via the dashboard)' : ''}`, { vmid: g.vmid, from: was.status, to: g.status });
        }
      }
      for (const k of [...guestState.keys()]) if (k.startsWith(`${c.id}:`) && !seen.has(k)) guestState.delete(k);
      if (pveDown.delete(c.id)) logEvent('info', 'host', `Proxmox API reachable again${tag(c.id)}`);
    } catch (e) {
      if (!pveDown.has(c.id)) { pveDown.add(c.id); logEvent('error', 'host', `Proxmox API unreachable${tag(c.id)}: ${(e as Error).message}`); }
    }
  });
}

// Cluster health: a node dropping out, and quorum (without it a cluster refuses to change anything).
const nodeOnline = new Map<string, boolean>();
const quorum = new Map<string, boolean>();
async function nodeWatch() {
  if (!pveConfigured()) return;
  await forEachCluster(async (c) => {
    try {
      const rows = await pve<{ type: string; name: string; online?: number; quorate?: number }[]>('GET', '/cluster/status');
      for (const r of rows) {
        if (r.type === 'node') {
          const key = `${c.id}:${r.name}`;
          const on = r.online === 1;
          const was = nodeOnline.get(key);
          nodeOnline.set(key, on);
          if (was === true && !on) logEvent('error', 'host', `Node ${r.name} went offline${tag(c.id)}`);
          else if (was === false && on) logEvent('info', 'host', `Node ${r.name} is back online${tag(c.id)}`);
        } else if (r.type === 'cluster' && r.quorate !== undefined) {
          const q = r.quorate === 1;
          const was = quorum.get(c.id);
          quorum.set(c.id, q);
          if (was === true && !q) logEvent('error', 'host', `Cluster lost quorum${tag(c.id)}`);
          else if (was === false && q) logEvent('info', 'host', `Cluster has quorum again${tag(c.id)}`);
        }
      }
    } catch { /* unreachable clusters are reported by the guest watcher */ }
  });
}

/** Kuma status transitions, fed from the scraper. */
const monitorState = new Map<string, string>();
export function noteMonitors(items: { key: string; name: string; status: string }[]) {
  for (const i of items) {
    const was = monitorState.get(i.key);
    monitorState.set(i.key, i.status);
    if (!was || was === i.status) continue;
    const bad = i.status === 'down';
    logEvent(bad ? 'error' : i.status === 'up' ? 'info' : 'warn', 'monitor', `${i.name}: ${was} → ${i.status}`, { monitor: i.name, from: was, to: i.status });
  }
}

export function startEvents(app: FastifyInstance) {
  process.on('uncaughtException', (e) => { app.log.fatal(e, 'uncaughtException'); logEvent('error', 'app', `Uncaught exception: ${e.message}`); });
  process.on('unhandledRejection', (e) => { app.log.error(e, 'unhandledRejection'); logEvent('error', 'app', `Unhandled rejection: ${(e as Error)?.message ?? e}`); });

  void recordStart();
  const beat = () => { try { setState('heartbeat', { ts: new Date().toISOString() }); } catch { /* retried on the next beat */ } };
  beat();
  setInterval(beat, 30_000).unref();
  setInterval(() => void guestWatch(), 15_000).unref();
  setInterval(() => void hostWatch(), 60_000).unref();
  setInterval(() => void nodeWatch(), 30_000).unref();
  void guestWatch();
  void hostWatch();
  void nodeWatch();
}

/** Marks a deliberate stop so the next start is not reported as a crash. */
export async function recordCleanStop() {
  logEvent('info', 'app', 'Dashboard stopping (signal)');
  try { setState('clean-stop', { ts: new Date().toISOString() }); } catch { /* db already gone */ }
}

// ---------- host journal (read-only, journalctl via execFile: no shell) ----------

const PRIORITIES = new Set(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']);
const UNIT = /^[\w@.:\\-]{1,100}$/;
const SINCE = /^(\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?|-?\d+(s|m|h|d|min|hour|day|week)s?( ago)?|today|yesterday)$/i;

interface JournalLine { ts: string; priority: number; unit: string; message: string; pid?: string }

export async function journal(args: string[]): Promise<JournalLine[]> {
  if (!cfg.journalEnabled) throw new HttpError(503, 'NOT_CONFIGURED', 'Host journal access is disabled (JOURNAL_ENABLED=false)');
  let stdout: string;
  try {
    ({ stdout } = await run('journalctl', ['--no-pager', '-q', '-o', 'json', ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }));
  } catch (e) {
    const err = e as Error & { code?: string | number; stdout?: string; stderr?: string };
    if (err.code === 'ENOENT') throw new HttpError(503, 'NOT_CONFIGURED', 'journalctl is not available on this host');
    // systemd >= 255 exits 1 with no output when -g matches nothing; that is an empty result, not a failure.
    if (err.code === 1 && !err.stderr?.trim()) stdout = err.stdout ?? '';
    else throw new HttpError(502, 'JOURNAL_ERROR', `journalctl failed: ${err.message.split('\n')[0]}`);
  }
  const lines: JournalLine[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const msg = j.MESSAGE;
      lines.push({
        ts: new Date(Number(j.__REALTIME_TIMESTAMP) / 1000).toISOString(),
        priority: Number(j.PRIORITY ?? 6),
        unit: String(j._SYSTEMD_UNIT ?? j.SYSLOG_IDENTIFIER ?? (j._TRANSPORT === 'kernel' ? 'kernel' : '')),
        message: typeof msg === 'string' ? msg.slice(0, 2000) : Array.isArray(msg) ? '[binary message]' : String(msg ?? ''),
        pid: j._PID ? String(j._PID) : undefined,
      });
    } catch { /* skip a malformed line */ }
  }
  return lines;
}

interface Boot { index: number; bootId: string; first: string; last: string; clean: boolean | null; endReason: string }

const CLEAN_END = /(Reached target (Power-Off|Reboot|System Power Off|System Reboot|Final Step)|systemd-shutdown|Journal stopped|Shutting down|Stopped target)/i;

async function boots(): Promise<Boot[]> {
  const { stdout } = await run('journalctl', ['--list-boots', '-o', 'json', '--no-pager', '-q'], { timeout: 15_000 });
  const list = JSON.parse(stdout) as { index: number; boot_id: string; first_entry: number; last_entry: number }[];
  const recent = list.slice(-8).reverse();
  return Promise.all(recent.map(async (b): Promise<Boot> => {
    const base = { index: b.index, bootId: b.boot_id, first: new Date(b.first_entry / 1000).toISOString(), last: new Date(b.last_entry / 1000).toISOString() };
    if (b.index === 0) return { ...base, clean: null, endReason: 'current boot' };
    try {
      const tail = await journal(['-b', String(b.index), '-n', '25', '-r']);
      const ended = tail.find((l) => CLEAN_END.test(l.message));
      return ended
        ? { ...base, clean: true, endReason: `clean shutdown (${ended.message.slice(0, 80)})` }
        : { ...base, clean: false, endReason: `log stops with no shutdown sequence: power loss, hard reset, crash or hang${tail.some((l) => /Power key pressed/i.test(l.message)) ? ' (power button was pressed just before)' : ''}` };
    } catch {
      return { ...base, clean: null, endReason: 'unknown' };
    }
  }));
}

export function registerLogs(app: FastifyInstance) {
  app.get<{ Querystring: { level?: string; source?: string; before?: string; q?: string; limit?: string } }>('/api/logs/events', async (req) => {
    const { level, source, before, q } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '100', 10) || 100, 1), 500);
    return listEvents({
      level: level && ['info', 'warn', 'error'].includes(level) ? level : undefined,
      source: source && /^[a-z]{2,10}$/.test(source) ? source : undefined,
      before: before && !Number.isNaN(Date.parse(before)) ? Date.parse(before) : undefined,
      q: q?.slice(0, 80), limit,
    }).map((r) => ({ id: String(r.id), ts: new Date(r.ts).toISOString(), level: r.level, source: r.source, message: r.message, data: r.data }));
  });

  app.get<{ Querystring: { priority?: string; unit?: string; since?: string; boot?: string; q?: string; kernel?: string; limit?: string } }>('/api/logs/journal', async (req) => {
    const { priority, unit, since, boot, q, kernel } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '200', 10) || 200, 1), 1000);
    const args = ['-n', String(limit), '-r'];
    if (priority) {
      if (!PRIORITIES.has(priority)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid priority');
      args.push('-p', priority);
    }
    if (unit) {
      if (!UNIT.test(unit)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid unit name');
      args.push('-u', unit);
    }
    if (since) {
      if (!SINCE.test(since)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid since value');
      args.push('--since', since);
    }
    if (boot !== undefined && boot !== '') {
      const n = Number(boot);
      if (!Number.isInteger(n) || n > 0 || n < -50) throw new HttpError(400, 'BAD_REQUEST', 'boot must be 0 or a negative offset');
      args.push('-b', String(n));
    }
    if (kernel === 'true') args.push('-k');
    if (q) args.push(`--grep=${q.slice(0, 100)}`, '--case-sensitive=false');
    return journal(args);
  });

  // One-call answer to "why did it go offline": boot history + what the last boots ended with + current watch state.
  app.get('/api/logs/summary', async () => {
    const bootList = await boots().catch((e) => ({ error: (e as Error).message }));
    const errs24h = countEvents('error', Date.now() - DAY);
    const hb = getState('heartbeat');
    return {
      boots: Array.isArray(bootList) ? bootList : [],
      journalError: Array.isArray(bootList) ? null : bootList.error,
      errors24h: errs24h,
      lastHeartbeat: typeof hb?.ts === 'string' ? hb.ts : null,
      processUptime: Math.round(process.uptime()),
    };
  });
}
