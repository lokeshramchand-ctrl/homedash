import type {
  AppConfig, Guest, GuestAction, GrafanaDashboard, GrafanaPanel, KumaIncident, KumaMonitor,
  JournalLine, LogSummary, NetMap, Protection, Capacity, Health, Scene, SceneStep, SceneRun, Schedule, NginxSite, NginxManage, NginxDetail, NginxSpec, NginxApplied, Overview, PromResult, SsoConfig, SystemEvent, Task,
  AiInfo, ConfigRow, Diagnostics, Disk, GpuInfo, GuestLogs, WindowsReport, LogLine, Sensor, NotifyInfo, NotifySettings, GuestStatusDetail, NetIface, NodeInfo, PveTask, RrdPoint, Service, Snapshot, Storage, Timeframe,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server', 0, 'NETWORK');
  }
  if (res.status === 401 && path !== '/auth/login') {
    window.dispatchEvent(new Event('auth:expired'));
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  }
  if (!res.ok) {
    throw new ApiError(data?.error || res.statusText || 'Request failed', res.status, data?.code || 'ERROR');
  }
  return data as T;
}

const qs = (p: Record<string, string | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
};
const get = <T,>(p: string) => req<T>('GET', p);
const post = <T,>(p: string, b?: unknown) => req<T>('POST', p, b ?? {});
const put = <T,>(p: string, b?: unknown) => req<T>('PUT', p, b ?? {});
const del = <T,>(p: string) => req<T>('DELETE', p);

export const api = {
  login: (username: string, password: string) => post<unknown>('/auth/login', { username, password }),
  logout: () => post<unknown>('/auth/logout'),
  ssoConfig: () => get<SsoConfig>('/auth/sso/config'),
  me: () => get<{ username: string }>('/auth/me'),
  overview: () => get<Overview>('/overview'),
  guests: () => get<Guest[]>('/guests'),
  guestAction: (vmid: number, action: GuestAction) => post<{ taskId: string }>(`/guests/${vmid}/${action}`),
  hostPower: () => get<{ enabled: boolean; node: string }>('/host/power'),
  hostShutdown: (confirm: string) => post<{ ok: boolean }>('/host/shutdown', { confirm }),
  task: (id: string) => get<Task>(`/tasks/${encodeURIComponent(id)}`),
  guestStatus: (vmid: number) => get<GuestStatusDetail>(`/guests/${vmid}/status`),
  guestConfig: (vmid: number) => get<ConfigRow[]>(`/guests/${vmid}/config`),
  guestRrd: (vmid: number, tf: Timeframe) => get<RrdPoint[]>(`/guests/${vmid}/rrd?timeframe=${tf}`),
  snapshots: (vmid: number) => get<Snapshot[]>(`/guests/${vmid}/snapshots`),
  node: () => get<NodeInfo>('/node'),
  nodeRrd: (tf: Timeframe) => get<RrdPoint[]>(`/node/rrd?timeframe=${tf}`),
  network: () => get<NetIface[]>('/node/network'),
  disks: () => get<Disk[]>('/node/disks'),
  services: () => get<Service[]>('/node/services'),
  storage: () => get<Storage[]>('/node/storage'),
  tasks: (p: { vmid?: number; errors?: boolean; type?: string; limit?: number } = {}) =>
    get<PveTask[]>('/tasks' + qs({ vmid: p.vmid?.toString(), errors: p.errors ? '1' : undefined, type: p.type, limit: String(p.limit ?? 100) })),
  taskLog: (id: string) => get<string[]>(`/tasks/${encodeURIComponent(id)}/log`),
  guestLogs: (vmid: number, since: string) => get<GuestLogs>(`/guests/${vmid}/logs?since=${since}`),
  windows: (vmid: number, since: string) => get<WindowsReport>(`/guests/${vmid}/windows?since=${since}`),
  gpu: () => get<GpuInfo>('/gpu'),
  gpuLogs: (since: string) => get<LogLine[]>(`/gpu/logs?since=${since}`),
  sensors: () => get<Sensor[]>('/node/sensors'),
  diagnostics: (since: string) => get<Diagnostics>(`/diagnostics?since=${since}`),
  ai: () => get<AiInfo>('/ai'),
  aiAsk: (context: string, question: string) => post<{ answer: string; model: string }>('/ai/ask', { context, question }),
  notify: () => get<NotifyInfo>('/notify'),
  notifySettings: (s: Partial<NotifySettings>) => post<NotifySettings>('/notify/settings', s),
  notifyTest: () => post<{ ok: true }>('/notify/test'),
  netmap: () => get<NetMap>('/netmap'),
  protection: () => get<Protection>('/protection'),
  capacity: () => get<Capacity>('/capacity'),
  health: () => get<Health>('/health'),
  snapshotCreate: (vmid: number, name?: string) => post<{ taskId: string; name: string }>(`/guests/${vmid}/snapshots`, { name }),
  snapshotDelete: (vmid: number, name: string) => del<{ taskId: string }>(`/guests/${vmid}/snapshots/${encodeURIComponent(name)}`),
  scenes: () => get<Scene[]>('/scenes'),
  sceneSave: (id: number | null, name: string, steps: SceneStep[]) => (id === null ? post<{ id: number }>('/scenes', { name, steps }) : put<{ id: number }>(`/scenes/${id}`, { name, steps })),
  sceneDelete: (id: number) => del<{ ok: boolean }>(`/scenes/${id}`),
  sceneRun: (id: number) => post<SceneRun>(`/scenes/${id}/run`),
  sceneRuns: () => get<SceneRun[]>('/scenes/runs'),
  schedules: () => get<Schedule[]>('/schedules'),
  scheduleSave: (id: number | null, s: Omit<Schedule, 'id' | 'lastRun' | 'lastResult'>) => (id === null ? post<{ id: number }>('/schedules', s) : put<{ id: number }>(`/schedules/${id}`, s)),
  scheduleDelete: (id: number) => del<{ ok: boolean }>(`/schedules/${id}`),
  nginx: () => get<NginxSite[]>('/nginx/sites'),
  nginxManage: () => get<NginxManage>('/nginx/manage'),
  nginxDetails: () => get<NginxDetail[]>('/nginx/details'),
  nginxPreview: (s: NginxSpec) => post<{ file: string; content: string }>('/nginx/preview', s),
  nginxCreate: (s: NginxSpec) => post<NginxApplied>('/nginx/sites', s),
  nginxFile: (file: string) => get<{ file: string; content: string; editable: boolean }>(`/nginx/sites/${encodeURIComponent(file)}`),
  nginxSave: (file: string, content: string) => put<NginxApplied>(`/nginx/sites/${encodeURIComponent(file)}`, { content }),
  nginxDelete: (file: string) => del<NginxApplied>(`/nginx/sites/${encodeURIComponent(file)}`),
  nginxBackups: (file: string) => get<string[]>(`/nginx/sites/${encodeURIComponent(file)}/backups`),
  nginxRestore: (file: string, backup: string) => post<NginxApplied>(`/nginx/sites/${encodeURIComponent(file)}/restore`, { backup }),
  nginxTest: () => post<{ ok: boolean; output: string }>('/nginx/test'),
  nginxReload: () => post<{ ok: boolean }>('/nginx/reload'),
  dashboards: () => get<GrafanaDashboard[]>('/grafana/dashboards'),
  panels: (uid: string) => get<GrafanaPanel[]>(`/grafana/panels/${encodeURIComponent(uid)}`),
  query: (query: string, start: number, end: number, step: number) =>
    post<PromResult>('/metrics/query', { query, start, end, step }),
  monitors: () => get<KumaMonitor[]>('/kuma/monitors'),
  incidents: () => get<KumaIncident[]>('/kuma/incidents'),
  logSummary: () => get<LogSummary>('/logs/summary'),
  events: (p: { level?: string; source?: string; q?: string }) => get<SystemEvent[]>('/logs/events' + qs({ ...p, limit: '300' })),
  journal: (p: { priority?: string; unit?: string; since?: string; boot?: string; q?: string; kernel?: string }) =>
    get<JournalLine[]>('/logs/journal' + qs({ ...p, limit: '300' })),
};

/** Optional runtime config shipped next to index.html (see API_NOTES.md). */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const r = await fetch('config.json', { cache: 'no-store' });
    if (!r.ok) return {};
    return await r.json();
  } catch {
    return {};
  }
}
