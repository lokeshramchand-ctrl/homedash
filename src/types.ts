export type GuestStatus = 'running' | 'stopped' | 'paused';
export type GuestAction = 'start' | 'shutdown' | 'stop' | 'reboot' | 'reset' | 'suspend' | 'resume';
export type KumaStatus = 'up' | 'down' | 'pending' | 'maintenance';

export interface Overview {
  cluster?: { id: string; name: string; multi: boolean };
  guests: { total: number; running: number; stopped: number };
  nginx: { sites: number };
  kuma: { up: number; down: number; pending: number };
  host: { cpu: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number; uptime: number };
}

export interface Guest {
  vmid: number;
  name: string;
  type: 'lxc' | 'qemu';
  status: GuestStatus;
  cpu: number; // fraction 0..1
  memUsed: number; // bytes
  memMax: number; // bytes
  uptime: number; // seconds
  protected: boolean;
  tags: string[];
  conflicts: number[];
  featured: boolean;
  /** The Proxmox node the guest runs on, and its cluster. */
  node: string;
  cluster: string;
}

export interface Task {
  status: 'running' | 'ok' | 'error';
  message: string;
}

export interface NginxSite {
  file: string;
  serverNames: string[];
  listen: string[];
  ssl: boolean;
  upstream: string | null;
  root: string | null;
  url: string;
}

export interface NginxManage { enabled: boolean; dir: string; version: string | null }
export interface NginxDetail { file: string; managed: boolean; cert: string | null; certExpires: string | null }
export interface NginxSpec {
  serverNames: string[]; upstream: string; websocket?: boolean; tls?: 'none' | 'selfsigned' | 'existing';
  certPath?: string; keyPath?: string; redirectHttp?: boolean; hsts?: boolean; maxBody?: string; file?: string;
}
export interface NginxApplied { file: string; backup: string | null; test: string; reloaded: boolean; reloadError: string | null }

export interface GrafanaDashboard {
  uid: string;
  title: string;
  folder: string;
  tags: string[];
  url: string;
  embedUrl: string;
}

export interface GrafanaPanel {
  id: number;
  title: string;
  embedUrl: string;
}

export interface Heartbeat {
  time: string;
  status: KumaStatus;
  ping: number | null;
}

export interface KumaMonitor {
  id: number;
  name: string;
  url: string;
  type: string;
  status: KumaStatus;
  uptime24h: number; // percent 0..100
  uptime30d: number;
  avgPing: number | null;
  lastCheck: string;
  heartbeats: Heartbeat[];
}

export interface KumaIncident {
  monitorId: number;
  name: string;
  status: KumaStatus;
  since: string;
  message: string;
}

export interface PromResult {
  status: string;
  data: { resultType: string; result: { metric: Record<string, string>; values: [number, string][] }[] };
}

export interface AppConfig {
  kumaStatusUrl?: string;
  grafanaUrl?: string;
}

export type EventLevel = 'info' | 'warn' | 'error';
export interface SystemEvent {
  id: string; ts: string; level: EventLevel;
  source: 'app' | 'db' | 'host' | 'guest' | 'monitor' | 'auth'; message: string; data: Record<string, unknown> | null;
}
export interface JournalLine { ts: string; priority: number; unit: string; message: string; pid?: string }
export interface BootInfo { index: number; bootId: string; first: string; last: string; clean: boolean | null; endReason: string }
export interface LogSummary {
  boots: BootInfo[]; journalError: string | null; errors24h: number; lastHeartbeat: string | null; processUptime: number;
}
export interface SsoConfig { enabled: boolean; label: string }

export type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year';
export type RrdPoint = { time: number } & Record<string, number | null>;
export interface NodeInfo {
  name: string; cpu: number; wait: number; cpuModel: string; cpus: number; cores: number; sockets: number; mhz: number;
  loadavg: number[]; memUsed: number; memTotal: number; swapUsed: number; swapTotal: number; rootUsed: number; rootTotal: number;
  ksmShared: number; uptime: number; kernel: string; pveVersion: string; bootMode: string; subscription: string;
  timezone: string; dns: string[]; searchDomain: string;
}
export interface NetIface { iface: string; type: string; active: boolean; autostart: boolean; method: string; cidr: string | null; gateway: string | null; cidr6: string | null; ports: string[]; vlanAware: boolean; comments: string }
export interface Disk { devpath: string; model: string; serial: string; type: string; size: number; health: string; wearout: number | null; used: string; gpt: boolean; rpm: number | null }
export interface Service { name: string; desc: string; state: string; active: string; unit: string }
export interface Storage { storage: string; type: string; content: string[]; active: boolean; enabled: boolean; shared: boolean; used: number; total: number }
export interface PveTask { upid: string; type: string; id: string; user: string; start: number; end: number | null; status: 'running' | 'ok' | 'warning' | 'error'; message: string }
export interface GuestStatusDetail extends Guest {
  cpus: number; diskUsed: number; diskMax: number; swapUsed: number; swapMax: number; netIn: number; netOut: number;
  diskRead: number; diskWrite: number; pid: number | null; lock: string | null; haManaged: boolean; agent: boolean | null;
  qmpStatus: string | null; runningMachine: string | null; runningQemu: string | null;
}
export interface ConfigRow { key: string; value: string | null; pending: string | null; delete: boolean }
export interface Snapshot { name: string; parent: string | null; description: string; time: number | null; vmstate: boolean; current: boolean }
export type AlertLevel = 'info' | 'warn' | 'error';
export interface ChannelPref { enabled: boolean; minLevel: AlertLevel }
export interface NotifyChannel { id: string; label: string; needs: string; configured: boolean; target: string; enabled: boolean; minLevel: AlertLevel; incident?: boolean }
export interface NotifySettings { enabled: boolean; recoveries: boolean; mutedUntil: string | null; categories: Record<string, boolean>; channels: Record<string, ChannelPref> }
export interface NotifyDelivery { channel: string; ok: boolean; error?: string }
export interface NotifyInfo {
  configured: boolean; channels: NotifyChannel[]; server: string; topic: string; subscribeUrl: string;
  thresholds: { cpu: number; mem: number; disk: number };
  settings: NotifySettings; categories: string[];
  sent: { ts: string; title: string; message: string; priority: number; category: string; ok: boolean; error?: string; deliveries: NotifyDelivery[]; silencedBy?: string; routedBy?: string[]; resolve?: boolean }[];
}

export type LogKind = 'start' | 'stop' | 'lifecycle' | 'start-failed' | 'crash' | 'oom' | 'gpu' | 'agent' | 'hardware' | 'error' | 'info';
export interface LogLine { ts: string; priority: number; unit: string; message: string; kind: LogKind; level: 'info' | 'warn' | 'error' }
export interface Recurring { unit: string; kind: LogKind; level: 'info' | 'warn' | 'error'; sample: string; count: number; first: string; last: string }
export interface GuestLogs {
  vmid: number; since: string; type: 'lxc' | 'qemu'; passthrough: string[]; counts: Record<'error' | 'warn' | 'info', number>;
  lastFailure: LogLine | null; reason: string | null; failedTasks: PveTask[]; timeline: LogLine[]; recurring: Recurring[]; lines: LogLine[];
}
export interface Gpu {
  addr: string; vendor: string; name: string; vendorId: string; deviceId: string; driver: string | null; mode: 'passthrough' | 'host' | 'unbound';
  iommuGroup: string | null; groupDevices: string[]; functions: { addr: string; name: string; class: string }[];
  assignedTo: { vmid: number; name: string; status: GuestStatus }[]; inUseBy: { vmid: number; name: string; status: GuestStatus } | null;
  link: { speed: string | null; width: string | null; maxSpeed: string | null; maxWidth: string | null };
  telemetry: { busyPercent: number | null; vramUsed: number | null; vramTotal: number | null; tempC: number | null; powerW: number | null; clockMHz: number | null } | null;
}
export interface GpuInfo { iommu: { enabled: boolean; cmdline: string[] }; gpus: Gpu[] }
export interface Sensor { chip: string; label: string; kind: 'temp' | 'fan' | 'power' | 'voltage'; value: number; unit: string; max: number | null; crit: number | null }
export interface Diagnostics { since: string; failedTasks: PveTask[]; byKind: Record<string, number>; guestHits: Record<string, number>; recurring: Recurring[]; lines: LogLine[] }
export interface AiInfo { configured: boolean; label: string; model: string; local: boolean }

export type Severity = 'critical' | 'warn' | 'info' | 'ok';
export interface Finding { id: string; severity: Severity; title: string; detail: string; advice?: string; count?: number }
export interface WinSession { start: string; end: string | null; durationSec: number | null; cpuSec: number | null; memPeak: string | null; endedBy: string }
export interface Stat { avg: number; p95: number; max: number; samples: number }
export interface WindowsReport {
  vmid: number; name: string; since: string; ostype: string; status: GuestStatus; verdict: Severity; uptime: number;
  agent: {
    state: 'ok' | 'unreachable' | 'no-permission' | 'vm-stopped'; error: string | null;
    os: { name: string; version: string; kernel: string; arch: string } | null; hostname: string | null; timezone: string | null; timeSkewSec: number | null;
    disks: { mount: string; name: string; type: string; used: number; total: number }[];
    nics: { name: string; mac: string; ips: string[] }[]; users: string[];
  };
  findings: Finding[]; health: Finding[]; sessions: WinSession[]; taskHistory: PveTask[];
  metrics: { samples: number; cpu: Stat | null; mem: Stat | null; netIn: Stat | null; netOut: Stat | null; diskRead: Stat | null; diskWrite: Stat | null; cpuSaturatedPct: number; idleSamples: number };
  metricsTimeframe: Timeframe; counts: { lines: number; problems: number }; recurring: Recurring[]; lines: LogLine[];
}

// ---- insights ----
export interface NetGuest { vmid: number; name: string; type: 'lxc' | 'qemu'; status: string; ips: { ip: string; source: 'agent' | 'runtime' | 'config' }[]; macs: string[]; bridges: string[] }
export interface NetSite { file: string; serverName: string; upstream: string; host: string; port: string; guest: { vmid: number; name: string; status: string } | null; issue: 'ok' | 'guest-stopped' | 'unknown-target' | 'hostname' | 'local' }
export interface NetMap { guests: NetGuest[]; duplicates: { kind: 'ip' | 'mac'; value: string; guests: { vmid: number; name: string }[] }[]; sites: NetSite[] }

export interface ProtectionGuest {
  vmid: number; name: string; type: 'lxc' | 'qemu'; status: string; backup: 'ok' | 'stale' | 'never'; lastBackup: string | null; backupAgeDays: number | null;
  backups: number; backupBytes: number; inJob: boolean | null; snapshots: number; oldestSnapshotDays: number | null; oldSnapshot: boolean;
}
export interface Protection {
  maxAgeDays: number; snapshotMaxAgeDays: number; unreadableStorages: string[];
  summary: { total: number; ok: number; stale: number; never: number; notInJob: number; oldSnapshots: number }; guests: ProtectionGuest[];
}

export interface Capacity {
  host: { memTotal: number; memUsed: number; reserveBytes: number; allocatedMem: number; availableMem: number; cores: number; allocatedVcpu: number; vcpuRatio: number };
  storages: { storage: string; type: string; used: number; total: number; usedRatio: number; bytesPerDay: number | null; daysToFull: number | null; trend: 'growing' | 'flat' | 'shrinking' | 'unknown' }[];
  stopped: { vmid: number; name: string; type: string; maxmem: number; maxcpu: number; fits: boolean; shortBy: number }[];
}

export interface HealthCheck { id: string; title: string; status: 'ok' | 'warn' | 'fail' | 'unknown'; detail: string; hint?: string }
export interface Health { score: number | null; checks: HealthCheck[] }

export interface SceneStep { vmid: number; action: 'start' | 'shutdown' | 'stop' | 'reboot'; waitSeconds: number; continueOnError: boolean }
export interface Scene { id: number; name: string; steps: SceneStep[] }
export interface SceneRun { id: string; scene: string; by: string; startedAt: string; finishedAt: string | null; status: 'running' | 'ok' | 'error'; steps: { vmid: number; action: string; status: string; message: string }[] }
export interface Schedule { id: number; name: string; sceneId: number | null; vmid: number | null; action: string | null; days: number[]; time: string; enabled: boolean; lastRun: number | null; lastResult: string | null }

// ---- added with the ported pages ----
export type MfaStep = 'none' | 'required' | 'enroll';
export interface LoginResult { username: string; mfa: MfaStep }
export interface MeInfo { username: string; role?: 'viewer' | 'operator' | 'admin'; mfa?: 'enroll' }
export interface MfaStatus { configured: boolean; required: boolean; enabled: boolean; enabledAt: string | null; recoveryLeft: number }
export interface LokiStatus { configured: boolean; ready: boolean; publicUrl: string; error: string | null; labels: string[] }
export interface LokiLine { ts: string; ns: string; line: string; labels: Record<string, string> }
export interface LokiHistogram { stepSeconds: number; points: { t: string; n: number }[] }
export interface QemuDisk { key: string; bus: string; storage: string; volume: string; size: string | null; cdrom: boolean; cache: string | null; iothread: boolean; discard: boolean; ssd: boolean; backup: boolean }
export interface QemuNic { key: string; model: string; mac: string | null; bridge: string | null; vlan: string | null; firewall: boolean; rate: string | null; queues: string | null; linkDown: boolean }
export interface QemuPci { key: string; device: string; pcie: boolean; xvga: boolean; romBar: boolean; mapping: boolean }
export interface QemuDevices {
  machine: string | null; bios: string; cpu: string; sockets: number; cores: number; memoryMb: number; balloonMb: number | null; ostype: string | null; scsihw: string | null;
  efi: boolean; tpm: boolean; agent: boolean; disks: QemuDisk[]; nics: QemuNic[]; pci: QemuPci[]; usb: { key: string; value: string }[]; other: { key: string; value: string }[];
  warnings: { severity: 'warn' | 'info'; title: string; advice: string }[];
}
export interface Backup { volid: string; storage: string; size: number; time: number; format: string; notes: string; protected: boolean }
export interface BackupList { storages: string[]; backups: Backup[] }
export interface LogAnalytics {
  since: string; stepSeconds: number;
  logs: {
    total: number; errors: number; warnings: number; hosts: number;
    series: { t: string; error: number; warning: number; other: number }[];
    topHosts: { host: string; lines: number; errors: number }[];
    topUnits: { unit: string; host: string; errors: number }[];
  };
  web: {
    requests: number; serverErrors: number; clientErrors: number; errorRate: number;
    series: { t: string; ok: number; redirect: number; client: number; server: number; other: number }[];
    topVhosts: { vhost: string; requests: number; errors5xx: number; p95: number | null }[];
  };
  health: { silent: string[] };
}
export interface VmAgent {
  available: boolean; reason?: string; hostname?: string | null;
  os?: { name: string | null; version: string | null; build: string | null; arch: string | null } | null;
  interfaces?: { name: string; mac: string | null; ips: { ip: string; v6: boolean; prefix: number }[] }[];
  volumes?: { mount: string; type: string; used: number; total: number }[];
  guestTime?: number | null;
}
export interface VmIsos { isos: { volid: string; name: string; size: number; storage: string }[]; drives: { slot: string; volid: string | null }[] }
export interface VmConfigChange { cores?: number; memoryMb?: number; balloonMb?: number; onboot?: boolean; agent?: boolean; description?: string; name?: string }

// ---- Data manager (/api/data/*) ----
export type DbKind = string;
export interface DbKindInfo { kind: DbKind; label: string; defaultPort: number | null; fields: string[]; connect: 'host' | 'uri-or-host' | 'file'; uriExample?: string; databaseHint?: string; databaseLabel?: string }
export interface DbStatus { configured: boolean; kinds: DbKindInfo[]; sqliteDirs: string[] }
export interface DbSource {
  id: string; name: string; kind: DbKind; readOnly: boolean; color?: string; createdAt: string; updatedAt: string;
  managed?: 'env'; envId?: string; // declared in server .env as DS_<envId>_*; not editable in the UI
  config: { host?: string; port?: number; database?: string; username?: string; tls?: boolean; tlsInsecure?: boolean; file?: string; uriMasked?: string; hasPassword: boolean; hasCa: boolean; hasToken?: boolean };
}
export interface DbInput {
  name?: string; kind?: DbKind; readOnly?: boolean; host?: string; port?: number | string; database?: string; username?: string; password?: string;
  uri?: string; tls?: boolean; tlsInsecure?: boolean; ca?: string; file?: string; token?: string; clearPassword?: boolean; clearToken?: boolean;
}
export interface DbSearchCaps { label: string; inputHint: string; fields: boolean; params: { name: string; label: string; type: 'number' | 'text' | 'select'; default?: string | number; options?: string[] }[] }
export interface DbAction { id: string; label: string; danger?: boolean; write: boolean; scope: 'connection' | 'namespace' | 'entity'; confirm?: boolean }
export interface DbCaps { language: string; search?: DbSearchCaps; actions?: DbAction[]; rowKey?: 'pk-object' | '_id' | 'key'; queryHelp?: string; write: boolean; indexes: boolean; activity: boolean; dropEntity: boolean; importExport: boolean; filterHint: string; entityLabel: string; namespaceLabel: string }
export interface DbOverview { caps: DbCaps; kind: DbKind; readOnly: boolean; ms: number; version: string }
export interface DbNamespace { name: string; sizeBytes?: number; entities?: number; note?: string }
export interface DbEntity { name: string; kind: 'collection' | 'table' | 'view' | 'keys'; rows?: number; sizeBytes?: number; approx?: boolean }
export interface DbColumn { name: string; type: string; nullable?: boolean; pk?: boolean; default?: string | null; note?: string }
export interface DbIndex { name: string; columns: string[]; unique?: boolean; primary?: boolean; detail?: string }
export interface DbDescribe { searchFields?: { name: string; type: string; dim?: number }[]; idFields: string[]; columns: DbColumn[]; indexes: DbIndex[]; stats: Record<string, string | number | boolean | null>; ddl?: string }
export interface DbPage { columns: string[]; rows: Record<string, unknown>[]; total: number | null; totalApprox?: boolean; nextCursor?: string; hasMore: boolean }
export interface DbQueryResult { kind: 'rows' | 'value' | 'ok'; columns: string[]; rows: Record<string, unknown>[]; value?: unknown; affected?: number; truncated?: boolean; ms: number; statement?: string }
export interface DbInfo { summary: Record<string, string | number | null>; sections: Record<string, Record<string, string | number | null>> }
export interface DbActivity { supported: boolean; sessions: Record<string, unknown>[]; slow?: Record<string, unknown>[]; note?: string }
export interface DbAuditRow { ts: string; user: string; ip: string; connection?: string; action: string; detail?: string; result: 'ok' | 'refused' | 'error'; ms?: number; rows?: number }

// ---------- llama.cpp server (Windows VM) ----------
export type LlamaState = 'running' | 'loading' | 'starting' | 'stopped' | 'vm-off' | 'agent-offline' | 'unknown' | 'error';
export interface LlamaSettings {
  ctx?: number; ngl?: number; parallel?: number; threads?: number; batch?: number; ubatch?: number;
  flashAttn?: 'auto' | 'on' | 'off'; cacheK?: string; cacheV?: string;
  alias?: string; vision?: boolean; noMmap?: boolean; jinja?: boolean; extra?: string[];
}
export interface LlamaGpu { name: string; memUsedMiB: number | null; memTotalMiB: number | null; util: number | null; tempC: number | null; powerW: number | null; powerLimitW: number | null; driver: string; fanPct: number | null; smClockMHz: number | null }
export interface LlamaSlot { id: number; nCtx: number | null; busy: boolean; task: number | null; decoded: number | null; remain: number | null; promptTokens: number | null }
export interface LlamaPoint { ts: number; gpuUtil: number | null; vramMiB: number | null; promptTotal: number | null; genTotal: number | null; busy: number | null }
export interface LlamaStatus {
  state: LlamaState;
  configured: { server: boolean; agent: boolean };
  lanUrl: string | null; publicUrl: string | null;
  vm: { vmid: number; name: string; status: string; uptime: number | null } | null;
  agent: { configured: boolean; reachable: boolean; error: string | null; version: string | null; host: string | null; bootTime: string | null; ramFreeBytes: number | null; ramTotalBytes: number | null; autostart: boolean; serverExists: boolean | null; portOwner: { pid: number; name: string } | null };
  process: { pid: number | null; started: string | null; ramBytes: number | null; commandLine: string | null; count: number | null } | null;
  launch: { modelId: string | null; modelName: string | null; modelPath: string | null; settings: LlamaSettings; started: string | null; commandLine: string | null } | null;
  gpu: { gpus: LlamaGpu[]; apps: { pid: number; name: string; memMiB: number | null }[] } | null;
  server: {
    health: 'ok' | 'loading' | 'error' | 'down' | 'unconfigured'; httpStatus: number | null;
    auth: 'ok' | 'required' | 'rejected';
    props: { nCtx: number | null; totalSlots: number | null; modelPath: string | null; modelAlias: string | null; buildInfo: string | null; vision: boolean; audio: boolean; chatTemplate: string | null; temperature: number | null; topP: number | null; topK: number | null; nPredict: number | null } | null;
    slots: LlamaSlot[] | null;
    metrics: Record<string, number> | null;
    metricsEnabled: boolean | null;
    models: string[];
  };
  history: LlamaPoint[];
}
export interface LlamaModel {
  id: string; name: string; file: string; path: string; dir: string; size: number | null; modified: string | null;
  source: 'local' | 'hf'; repo: string | null; mmproj: string | null; mmprojSize: number | null;
  quant: string | null; params: string | null; mtp: boolean;
}
export interface LlamaPreset { id: string; name: string; modelId: string; modelName?: string; settings: LlamaSettings }
export interface LlamaChatResult {
  content: string; reasoning: string | null; finish: string | null; model: string | null;
  usage: { prompt: number | null; completion: number | null };
  timings: { promptN: number | null; promptMs: number | null; promptPerSec: number | null; genN: number | null; genMs: number | null; genPerSec: number | null; draftN: number | null; draftAccepted: number | null };
  wallMs: number;
}

// ---- CrowdSec ----
export interface CsEngine { id: 'central' | 'host'; name: string; role: string; ok: boolean; detail: string; version: string; capiPullSec: number | null }
export interface CsBan { id: number; ip: string; scenario: string; type: string; origin: string; remainingSec: number; country: string | null; asName: string | null; createdAt: string; machine: string; events: number }
export interface CsBouncer { name: string; ip: string; type: string; version: string; revoked: boolean; lastPull: string; os: string; ageSec: number | null }
export interface CsMachine { name: string; ip: string; version: string; validated: boolean; lastHeartbeat: string; os: string; features: string[]; ageSec: number | null }
export interface CsOverview {
  configured: boolean; snapshot: { ageSec: number | null; errors: string[] } | null; prometheus: boolean;
  engines: CsEngine[];
  decisions: { local: CsBan[]; localCount: number; community: { reason: string; count: number }[]; communityTotal: number; total: number | null };
  alerts: {
    total7d: number; last24h: number; hourly: { t: string; n: number }[]; daily: { t: string; n: number }[];
    byScenario: { scenario: string; count: number }[]; byCountry: { country: string; count: number }[]; byMachine: { machine: string; count: number }[];
    topSources: { ip: string; count: number; country: string | null; asName: string | null }[]; gauge: { scenario: string; count: number }[];
  };
  bouncers: CsBouncer[]; machines: CsMachine[]; collections: { name: string; status: string; version: string }[];
  allowlists: { name: string; description: string; items: { value: string; description: string; expiration: string | null }[] }[];
  acquisition: { source: string; read: number; ok: number; ko: number }[];
  updatedAt: string;
}
export interface CsAlert {
  id: number; createdAt: string; scenario: string; machine: string; events: number; startAt: string; stopAt: string;
  ip: string; country: string | null; asName: string | null; asNumber: string | null; range: string | null;
  decision: { type: string; remainingSec: number; origin: string } | null;
}

/** Which optional integrations the server has switched on (GET /api/features). */
export interface Features {
  proxmox: boolean; grafana: boolean; kuma: boolean; loki: boolean; crowdsec: boolean; data: boolean; llama: boolean; gpuWatch: boolean;
  ntfy: boolean; alerts: boolean; clusters?: boolean; passkeys: boolean; scim: boolean; teams: boolean; approvals: boolean; ai: boolean; sso: boolean; mfa: boolean; nginxManage: boolean; metrics: boolean; tiles?: boolean;
}

// ---- access: teams, tokens, approvals, passkeys, users ----
export type AccessRole = 'viewer' | 'operator' | 'admin';
export interface ApiTokenRow { id: number; name: string; prefix: string; role: AccessRole; owner: string; createdAt: string; expiresAt: string; lastUsedAt: string | null; lastIp: string | null; status: 'active' | 'expired' | 'revoked' }
export interface ApiTokens { maxDays: number; defaultDays: number; tokens: ApiTokenRow[] }
export interface ApprovalItem {
  id: string; action: string; summary: string; method: string; path: string; body: unknown; requestedBy: string; createdAt: string; expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'used' | 'expired'; decidedBy: string | null; decidedAt: string | null; note: string | null;
}
export interface Approvals { policy: { actions: string[]; ttlMinutes: number; allowSelf: boolean; known: string[] }; canDecide: boolean; items: ApprovalItem[] }
export interface PasskeyItem { id: number; name: string; createdAt: string; lastUsedAt: string | null }
export interface AdminUser {
  id: number; username: string; role: AccessRole; teams: string[]; groups: string[]; disabled: boolean; source: 'local' | 'sso' | 'scim'; managed: boolean;
  mfa: boolean; passkeys: number; lastLoginAt: string | null; lastLoginIp: string | null; sessions: number; tokens: number;
}
export interface AdminSession { id: number; username: string; createdAt: string; lastSeenAt: string; expiresAt: string; ip: string | null; userAgent: string | null; pending: boolean; current: boolean }
export interface AccessInfo {
  teams: { name: string; vmids: string[]; tags: string[] }[]; groupRoles: Record<string, string[]>; groupTeams: Record<string, string[]>;
  oidc: { configured: boolean; defaultRole: string; adminUsers: number };
  scim: { enabled: boolean; endpoint: string; groups: { name: string; members: number }[] };
  passkeys: { enabled: boolean; rpId: string };
  approvals: { actions: string[]; ttlMinutes: number; allowSelf: boolean }; tokens: { maxDays: number; defaultDays: number };
}

export interface WeeklyWindow { days: number[]; start: string; minutes: number }
export interface SilenceItem { id: number; name: string; reason: string; startsAt: number; endsAt: number; categories: string[]; contains: string; weekly: WeeklyWindow | null; createdBy: string; createdAt: number; active: boolean; upcoming: boolean; expired: boolean }
export interface SilenceInput { name: string; reason?: string; startsAt?: string; endsAt?: string; categories: string[]; contains?: string; weekly?: WeeklyWindow | null }
export interface RouteItem { id: number; name: string; enabled: boolean; categories: string[]; minLevel: AlertLevel; contains: string; channels: string[]; weekly: WeeklyWindow | null; position: number }
export interface RouteInput { name: string; enabled?: boolean; categories: string[]; minLevel: AlertLevel; contains?: string; channels: string[]; weekly?: WeeklyWindow | null }

// ---- clusters and nodes ----
export interface ClusterNode { name: string; online: boolean; local: boolean; cpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; guests: number; running: number }
export interface ClusterInfo {
  id: string; name: string; reachable: boolean; error: string | null; addresses: number; activeAddress: string | null; quorate: boolean | null; standalone: boolean;
  version: string | null; nodes: ClusterNode[]; guests: { total: number; running: number };
}
export interface ClustersResponse { current: string; defaultNode: string; clusters: ClusterInfo[] }
export interface MigrateInfo {
  vmid: number; name: string; node: string; type: 'lxc' | 'qemu'; running: boolean; mode: 'live' | 'restart' | 'offline';
  localDisks: { volid: string; size: number }[]; localResources: string[];
  checks: MigrateCheck[]; targets: { name: string; online: boolean; allowed: boolean; reason: string | null; checks: MigrateCheck[] }[];
}
export interface MigrateCheck { id: string; level: 'block' | 'warn' | 'info'; text: string }

// ---- high availability ----
export interface HaState {
  available: boolean; cluster: string | null; enabled?: boolean; quorate?: boolean | null; master?: string | null;
  nodes?: { node: string; agent: 'active' | 'idle' | 'dead' | 'unknown'; manager: string; attention: boolean }[];
  services?: { sid: string; vmid: number | null; node: string; state: string; requested: string; attention: 'error' | 'warn' | null; reason: string | null }[];
  problems?: { key: string; level: 'error' | 'warn'; title: string; text: string }[];
}

// ---- service tiles (Docker, Pi-hole, Jellyfin, ...) ----
export interface TileStat { label: string; value: string | number; tone?: 'ok' | 'warn' | 'bad' }
export interface Tile {
  id: string; kind: string; name: string; link?: string; group?: string;
  state: 'ok' | 'warn' | 'down' | 'pending'; summary?: string; stats?: TileStat[]; ms: number | null; at: number | null; error?: string;
}

// ---- node upkeep (updates, ZFS) ----
export interface Upkeep {
  node: string; checkedAt: number;
  updates: { total: number; kernel: boolean; proxmox: number; sample: string[] } | null;
  pools: { name: string; health: string; size: number; free: number; frag: number | null }[] | null;
  problems: { key: string; level: 'error' | 'warn'; title: string; text: string }[];
}
