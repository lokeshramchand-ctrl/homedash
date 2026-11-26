import { selectedCluster, selectedNode } from './selection';
import type {
  AppConfig, SetupInfo, HaState, VersionInfo, TileAdmin, TileCatalog, TileSuggestion, TileStat, Upkeep, Tile, Guest, GuestAction, GrafanaDashboard, GrafanaPanel, KumaIncident, KumaMonitor,
  JournalLine, LogSummary, NetMap, Protection, Capacity, Health, Scene, SceneStep, SceneRun, Schedule, NginxSite, NginxManage, NginxDetail, NginxSpec, NginxApplied, Overview, PromResult, SsoConfig, SystemEvent, Task,
  AiInfo, ConfigRow, Diagnostics, Disk, GpuInfo, GuestLogs, WindowsReport, LogLine, Sensor, NotifyInfo, NotifySettings, GuestStatusDetail, NetIface, NodeInfo, PveTask, RrdPoint, Service, Snapshot, Storage, Timeframe,
} from './types';

import type {
  Backup,
  BackupList,
  CsAlert,
  CsBan,
  CsBouncer,
  CsEngine,
  CsMachine,
  CsOverview,
  DbAction,
  DbActivity,
  DbAuditRow,
  DbCaps,
  DbColumn,
  DbDescribe,
  DbEntity,
  DbIndex,
  DbInfo,
  DbInput,
  DbKind,
  DbKindInfo,
  DbNamespace,
  DbOverview,
  DbPage,
  DbQueryResult,
  DbSearchCaps,
  DbSource,
  DbStatus,
  LlamaChatResult,
  LlamaGpu,
  LlamaModel,
  LlamaPoint,
  LlamaPreset,
  LlamaSettings,
  LlamaSlot,
  LlamaState,
  LlamaStatus,
  LogAnalytics,
  SilenceItem, SilenceInput, RouteItem, RouteInput, ClustersResponse, MigrateInfo, LoginResult, Features, ChannelPref, NotifyDelivery, AccessRole, ApiTokens, Approvals, ApprovalItem, PasskeyItem, AdminUser, AdminSession, AccessInfo,
  LokiHistogram,
  LokiLine,
  LokiStatus,
  MeInfo,
  MfaStatus,
  MfaStep,
  QemuDevices,
  QemuDisk,
  QemuNic,
  QemuPci,
  VmAgent,
  VmConfigChange,
  VmIsos,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  /** Extra fields from the server's error body, e.g. the approval request behind APPROVAL_REQUIRED. */
  data: Record<string, unknown>;
  constructor(message: string, status: number, code: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function req<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'homedash', ...(selectedCluster() ? { 'X-Cluster': selectedCluster() } : {}), ...(selectedNode() ? { 'X-Node': selectedNode() } : {}), ...extra, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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
    if (data?.code === 'APPROVAL_REQUIRED' || data?.code === 'APPROVAL_GRANTED') window.dispatchEvent(new CustomEvent('approval:required', { detail: data.approval }));
    throw new ApiError(data?.error || res.statusText || 'Request failed', res.status, data?.code || 'ERROR', data ?? {});
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

const ds = (id: string) => `/data/sources/${encodeURIComponent(id)}`;
const dq = (p: Record<string, string | number | undefined>) => qs(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === undefined ? undefined : String(v)])));

export const dataApi = {
  status: () => get<DbStatus>('/data/status'),
  sources: () => get<DbSource[]>('/data/sources'),
  create: (b: DbInput) => post<DbSource>('/data/sources', b),
  update: (id: string, b: DbInput) => put<DbSource>(ds(id), b),
  remove: (id: string) => del<{ ok: boolean }>(ds(id)),
  test: (b: DbInput & { id?: string }) => post<{ ok: boolean; ms: number; version: string }>('/data/test', b),
  overview: (id: string) => get<DbOverview>(`${ds(id)}/overview`),
  info: (id: string) => get<DbInfo>(`${ds(id)}/info`),
  activity: (id: string) => get<DbActivity>(`${ds(id)}/activity`),
  namespaces: (id: string) => get<DbNamespace[]>(`${ds(id)}/namespaces`),
  entities: (id: string, ns: string) => get<DbEntity[]>(`${ds(id)}/entities${dq({ ns })}`),
  describe: (id: string, ns: string, entity: string) => get<DbDescribe>(`${ds(id)}/describe${dq({ ns, entity })}`),
  browse: (id: string, ns: string, entity: string, o: { limit: number; offset: number; cursor?: string; filter?: string; sort?: string; dir?: string }) =>
    get<DbPage>(`${ds(id)}/browse${dq({ ns, entity, ...o })}`),
  record: (id: string, ns: string, entity: string, rid: unknown) => get<unknown>(`${ds(id)}/record${dq({ ns, entity, id: JSON.stringify(rid) })}`),
  save: (id: string, ns: string, entity: string, rid: unknown, doc: unknown) => put<{ id: unknown }>(`${ds(id)}/record`, { ns, entity, id: rid, doc }),
  delete: (id: string, ns: string, entity: string, rid: unknown) => post<{ affected: number }>(`${ds(id)}/record/delete`, { ns, entity, id: rid }),
  ttl: (id: string, ns: string, key: string, ttl: number) => post<{ ok: boolean }>(`${ds(id)}/redis/ttl`, { ns, key, ttl }),
  createIndex: (id: string, b: { ns: string; entity: string; name?: string; columns: { field: string; dir?: 'asc' | 'desc' }[]; unique?: boolean }) => post<{ name: string }>(`${ds(id)}/index`, b),
  dropIndex: (id: string, ns: string, entity: string, name: string) => post<{ ok: boolean }>(`${ds(id)}/index/drop`, { ns, entity, name }),
  dropEntity: (id: string, ns: string, entity: string, confirm: string) => post<{ ok: boolean }>(`${ds(id)}/drop`, { ns, entity, confirm }),
  search: (id: string, b: { ns: string; entity: string; field?: string; query: string; limit?: number; filter?: string; params?: Record<string, string | number> }) => post<DbQueryResult>(`${ds(id)}/search`, b),
  action: (id: string, b: { ns: string; entity: string; action: string; confirm?: string }) => post<{ ok: boolean; message?: string }>(`${ds(id)}/action`, b),
  query: (id: string, b: { ns: string; text: string; allowWrite?: boolean; limit?: number; timeoutSec?: number }) => post<DbQueryResult>(`${ds(id)}/query`, b),
  importRows: (id: string, ns: string, entity: string, rows: unknown[]) => post<{ inserted: number; failed: number; errors: { row: number; error: string }[] }>(`${ds(id)}/import`, { ns, entity, rows }),
  exportUrl: (id: string, ns: string, entity: string, format: 'json' | 'csv', filter?: string) => `/api${ds(id)}/export${dq({ ns, entity, format, filter })}`,
  audit: () => get<DbAuditRow[]>('/data/audit?limit=200'),
};

export const api = {
  login: (username: string, password: string) => post<LoginResult>('/auth/login', { username, password }),
  logout: () => post<unknown>('/auth/logout'),
  ssoConfig: () => get<SsoConfig>('/auth/sso/config'),
  me: () => get<{ username: string; role?: string; mfa?: string }>('/auth/me'),
  features: () => get<Features>('/features'),
  setup: () => get<SetupInfo>('/admin/setup'),
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
  notifySettings: (s: Partial<Omit<NotifySettings, 'channels'>> & { channels?: Record<string, Partial<ChannelPref>> }) => post<NotifySettings>('/notify/settings', s),
  notifyTest: (channel?: string) => post<{ ok: boolean; deliveries: NotifyDelivery[] }>('/notify/test', channel ? { channel } : {}),
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
  tiles: () => get<Tile[]>('/tiles'),
  version: () => get<VersionInfo>('/version'),
  pref: (key: string) => get<{ value: unknown }>(`/prefs/${key}`),
  setPref: (key: string, value: unknown) => put<{ ok: boolean }>(`/prefs/${key}`, { value }),
  tileCatalog: () => get<TileCatalog>('/tiles/catalog'),
  discoverTiles: () => get<{ scanned: number; found: TileSuggestion[] }>('/admin/tiles/discover'),
  tileAdmin: () => get<TileAdmin>('/admin/tiles'),
  testTile: (b: unknown) => post<{ state: string; summary?: string; stats?: TileStat[]; ms: number | null; error?: string }>('/admin/tiles/test', b),
  addTile: (b: unknown) => post<{ id: string }>('/admin/tiles', b),
  editTile: (id: string, b: unknown) => put<{ id: string }>(`/admin/tiles/${encodeURIComponent(id)}`, b),
  deleteTile: (id: string) => del<{ ok: boolean }>(`/admin/tiles/${encodeURIComponent(id)}`),
  refreshTile: (id: string) => post<Tile>(`/tiles/${encodeURIComponent(id)}/refresh`),
  monitors: () => get<KumaMonitor[]>('/kuma/monitors'),
  incidents: () => get<KumaIncident[]>('/kuma/incidents'),
  logSummary: () => get<LogSummary>('/logs/summary'),
  events: (p: { level?: string; source?: string; q?: string }) => get<SystemEvent[]>('/logs/events' + qs({ ...p, limit: '300' })),
  journal: (p: { priority?: string; unit?: string; since?: string; boot?: string; q?: string; kernel?: string }) =>
    get<JournalLine[]>('/logs/journal' + qs({ ...p, limit: '300' })),
  logoutAll: () => post<unknown>('/auth/logout-all'),
  mfaStatus: () => get<MfaStatus>('/auth/mfa'),
  mfaSetup: (password?: string) => post<{ secret: string; uri: string }>('/auth/mfa/setup', password ? { password } : {}),
  mfaEnable: (code: string) => post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
  mfaVerify: (code: string) => post<{ username: string; recoveryLeft: number }>('/auth/mfa/verify', { code }),
  mfaRecovery: (code: string) => post<{ recoveryCodes: string[] }>('/auth/mfa/recovery', { code }),
  mfaDisable: (code: string) => post<{ ok: boolean }>('/auth/mfa/disable', { code }),
  snapshotRollback: (vmid: number, name: string) => post<{ taskId: string }>(`/guests/${vmid}/snapshots/${encodeURIComponent(name)}/rollback`, { confirm: name }),
  qemuDevices: (vmid: number) => get<QemuDevices>(`/guests/${vmid}/qemu/devices`),
  qemuSendKey: (vmid: number, key: string) => post<{ taskId: null }>(`/guests/${vmid}/qemu/sendkey`, { key }),
  backups: (vmid: number) => get<BackupList>(`/guests/${vmid}/backups`),
  backupNow: (vmid: number, storage: string, mode = 'snapshot') => post<{ taskId: string }>(`/guests/${vmid}/backup`, { storage, mode }),
  vmAgent: (vmid: number) => get<VmAgent>(`/guests/${vmid}/vm/agent`),
  vmIsos: (vmid: number) => get<VmIsos>(`/guests/${vmid}/vm/isos`),
  vmMedia: (vmid: number, slot: string, iso: string | null) => post<{ taskId: null }>(`/guests/${vmid}/vm/media`, { slot, iso }),
  vmConfig: (vmid: number, c: VmConfigChange) => post<{ taskId: null }>(`/guests/${vmid}/vm/config`, c),
  vmNic: (vmid: number, key: string, linkDown: boolean) => post<{ taskId: null }>(`/guests/${vmid}/vm/nic`, { key, linkDown }),
  vmClone: (vmid: number, name: string) => post<{ taskId: string }>(`/guests/${vmid}/vm/clone`, { name }),
  llama: () => get<LlamaStatus>('/llama'),
  llamaModels: () => get<{ dirs: string[]; models: LlamaModel[] }>('/llama/models'),
  llamaStart: (modelId: string, settings: LlamaSettings, restart: boolean) => post<{ started: boolean; pid: number | null; modelName: string | null; commandLine: string | null }>('/llama/start', { modelId, settings, restart }),
  llamaStop: () => post<{ stopped: number }>('/llama/stop'),
  llamaAutostart: (enabled: boolean) => post<{ autostart: boolean }>('/llama/autostart', { enabled }),
  llamaLog: (lines: number, prev: boolean) => get<{ file: string | null; lines: string[] }>(`/llama/log?lines=${lines}${prev ? '&prev=1' : ''}`),
  llamaPresets: () => get<LlamaPreset[]>('/llama/presets'),
  llamaSavePresets: (list: LlamaPreset[]) => put<LlamaPreset[]>('/llama/presets', list),
  llamaChat: (b: { messages: { role: 'user' | 'assistant'; content: string }[]; system?: string; maxTokens?: number; temperature?: number }) => post<LlamaChatResult>('/llama/chat', b),
  crowdsec: () => get<CsOverview>('/crowdsec'),
  crowdsecAlerts: (p: { scenario?: string; country?: string; q?: string; limit?: number } = {}) => get<CsAlert[]>('/crowdsec/alerts' + qs({ scenario: p.scenario, country: p.country, q: p.q, limit: String(p.limit ?? 100) })),
  lokiAnalytics: (since: string) => get<LogAnalytics>('/loki/analytics' + qs({ since })),
  lokiStatus: () => get<LokiStatus>('/loki/status'),
  lokiLabelValues: (name: string) => get<string[]>(`/loki/labels/${encodeURIComponent(name)}/values`),
  lokiQuery: (query: string, since: string) => get<LokiLine[]>('/loki/query' + qs({ query, since, limit: '500' })),
  lokiHistogram: (query: string, since: string) => get<LokiHistogram>('/loki/histogram' + qs({ query, since })),
  // access
  tokens: (all = false) => get<ApiTokens>('/auth/tokens' + (all ? '?all=1' : '')),
  tokenCreate: (b: { name: string; days: number; role: AccessRole }) => post<{ id: number; token: string; name: string; role: AccessRole; expiresAt: string }>('/auth/tokens', b),
  tokenRevoke: (id: number) => del<{ ok: boolean }>(`/auth/tokens/${id}`),
  approvals: () => get<Approvals>('/approvals'),
  approvalDecide: (id: string, verdict: 'approve' | 'reject', note?: string) => post<ApprovalItem>(`/approvals/${id}/${verdict}`, note ? { note } : {}),
  /** Repeats the original request of an approved action, with the approval attached. */
  approvalRun: (a: ApprovalItem) => req<unknown>(a.method, a.path.replace(/^\/api/, ''), a.body === null ? undefined : a.body, { 'X-Approval-Id': a.id }),
  passkeys: () => get<PasskeyItem[]>('/auth/passkeys'),
  passkeyRegisterOptions: () => post<{ challengeId: string; options: unknown }>('/auth/passkeys/register/options'),
  passkeyRegisterVerify: (b: { challengeId: string; response: unknown; name: string }) => post<{ ok: boolean }>('/auth/passkeys/register/verify', b),
  passkeyDelete: (id: number) => del<{ ok: boolean }>(`/auth/passkeys/${id}`),
  passkeyConfig: () => get<{ enabled: boolean }>('/auth/passkey/config'),
  passkeyLoginOptions: () => post<{ challengeId: string; options: unknown }>('/auth/passkey/login/options'),
  passkeyLoginVerify: (b: { challengeId: string; response: unknown }) => post<{ username: string }>('/auth/passkey/login/verify', b),
  adminUsers: () => get<AdminUser[]>('/admin/users'),
  adminUserPatch: (id: number, b: { role?: AccessRole; teams?: string[]; disabled?: boolean }) => req<{ ok: boolean }>('PATCH', `/admin/users/${id}`, b),
  adminSessions: () => get<AdminSession[]>('/admin/sessions'),
  adminSessionEnd: (id: number) => del<{ ok: boolean }>(`/admin/sessions/${id}`),
  adminAccess: () => get<AccessInfo>('/admin/access'),
  silences: () => get<SilenceItem[]>('/notify/silences'),
  silenceSave: (id: number | null, b: SilenceInput) => (id === null ? post<{ id: number }>('/notify/silences', b) : put<{ id: number }>(`/notify/silences/${id}`, b)),
  silenceDelete: (id: number) => del<{ ok: boolean }>(`/notify/silences/${id}`),
  routes: () => get<RouteItem[]>('/notify/routes'),
  routeSave: (id: number | null, b: RouteInput) => (id === null ? post<{ id: number }>('/notify/routes', b) : put<{ id: number }>(`/notify/routes/${id}`, b)),
  routeDelete: (id: number) => del<{ ok: boolean }>(`/notify/routes/${id}`),
  clusters: () => get<ClustersResponse>('/clusters'),
  migrateInfo: (vmid: number, withLocalDisks = false) => get<MigrateInfo>(`/guests/${vmid}/migrate${withLocalDisks ? '?withLocalDisks=1' : ''}`),
  ha: () => get<HaState>('/cluster/ha'),
  upkeep: () => get<Upkeep[]>('/cluster/upkeep'),
  migrate: (vmid: number, target: string, withLocalDisks = false) => post<{ taskId: string }>(`/guests/${vmid}/migrate`, { target, withLocalDisks }),
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
