// llama.cpp server on a Windows VM (set LLAMA_VMID to its Proxmox guest id).
//
// Two sources, both on the LAN:
//   - llama-server itself (LLAMA_URL): /health, /props, /slots, /metrics, /v1/models, read-only, plus
//     the playground's /v1/chat/completions.
//   - the control agent inside Windows (LLAMA_AGENT_URL, scripts/windows/llama-agent.ps1): process,
//     GPU, model files, start/stop, log. It only accepts a fixed set of actions; model ids come from
//     its own folder scan, so the dashboard never sends a file path.
// Every start/stop/autostart attempt is written to `audit` (vmid = LLAMA_VMID, action llama.*).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cfg, llamaConfigured, pveConfigured } from './config.js';
import { getState, insertAudit, setState } from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { logEvent } from './events.js';
import { pve } from './proxmox.js';

// ---------- launch settings (validated here and again by the agent) ----------
const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;
const FLASH = ['auto', 'on', 'off'] as const;
const FORBIDDEN = /^(--host|--port|--path|--log-file|--api-key|--api-key-file|--ssl-key-file|--ssl-cert-file|-m|--model|-mu|--model-url|--mmproj|--mmproj-url|-hf|-hfr|-hff|-hft|-hfv|--hf-[a-z-]+|--lora|--lora-scaled|--control-vector[a-z-]*|--grammar-file|-mm|--slot-save-path|--chat-template-file|--models-dir|--models-preset|-o|--output)(=|$)/;
const EXTRA_TOKEN = /^[A-Za-z0-9._:=,+-]{1,128}$/;

export interface LaunchSettings {
  ctx?: number; ngl?: number; parallel?: number; threads?: number; batch?: number; ubatch?: number;
  flashAttn?: (typeof FLASH)[number]; cacheK?: (typeof CACHE_TYPES)[number]; cacheV?: (typeof CACHE_TYPES)[number];
  alias?: string; vision?: boolean; noMmap?: boolean; jinja?: boolean; extra?: string[];
}

const bad = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg);

function intIn(v: unknown, lo: number, hi: number, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
}

/** Cleans settings from the browser. Unknown keys are dropped. */
export function parseSettings(raw: unknown): LaunchSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s: LaunchSettings = {
    ctx: intIn(o.ctx, 0, 1_048_576, 'Context size'),
    ngl: intIn(o.ngl, 0, 999, 'GPU layers'),
    parallel: intIn(o.parallel, 1, 64, 'Parallel slots'),
    threads: intIn(o.threads, 1, 256, 'Threads'),
    batch: intIn(o.batch, 32, 65536, 'Batch size'),
    ubatch: intIn(o.ubatch, 32, 65536, 'Micro-batch size'),
  };
  if (o.flashAttn !== undefined && o.flashAttn !== '') {
    if (!FLASH.includes(o.flashAttn as never)) throw bad('Flash attention must be auto, on or off');
    s.flashAttn = o.flashAttn as LaunchSettings['flashAttn'];
  }
  for (const k of ['cacheK', 'cacheV'] as const) {
    if (o[k] === undefined || o[k] === '') continue;
    if (!CACHE_TYPES.includes(o[k] as never)) throw bad(`${k} must be one of ${CACHE_TYPES.join(', ')}`);
    s[k] = o[k] as LaunchSettings['cacheK'];
  }
  if (o.alias !== undefined && o.alias !== '') {
    if (typeof o.alias !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(o.alias)) throw bad('Alias: letters, digits and . _ : - only, at most 64');
    s.alias = o.alias;
  }
  for (const k of ['vision', 'noMmap', 'jinja'] as const) if (o[k] !== undefined) s[k] = o[k] === true;
  if (o.extra !== undefined) {
    const list = Array.isArray(o.extra) ? o.extra : typeof o.extra === 'string' ? o.extra.split(/\s+/) : [];
    const extra = list.map((x) => String(x).trim()).filter(Boolean);
    if (extra.length > 32) throw bad('At most 32 extra arguments');
    for (const t of extra) {
      if (!EXTRA_TOKEN.test(t)) throw bad(`Extra argument "${t.slice(0, 40)}" has characters that are not allowed (no spaces, slashes or quotes)`);
      if (FORBIDDEN.test(t)) throw bad(`Extra argument "${t}" is managed by the dashboard or not allowed`);
    }
    if (extra.length) s.extra = extra;
  }
  for (const k of Object.keys(s) as (keyof LaunchSettings)[]) if (s[k] === undefined) delete s[k];
  return s;
}

// ---------- helpers ----------
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 400): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

async function agent<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 8_000): Promise<{ status: number; data: T }> {
  if (!cfg.llama.agentUrl) throw notConfigured('llama control agent (LLAMA_AGENT_URL)');
  let res: Response;
  try {
    res = await fetch(cfg.llama.agentUrl + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.llama.agentToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HttpError(502, 'AGENT_UNREACHABLE', `The llama agent on the VM did not answer (${(e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message})`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 401) throw new HttpError(502, 'AGENT_AUTH', 'The llama agent refused the token (check LLAMA_AGENT_TOKEN)');
  return { status: res.status, data: data as T };
}

async function server(path: string, timeoutMs = 3_000): Promise<{ status: number; body: string } | null> {
  if (!cfg.llama.url) return null;
  try {
    const res = await fetch(cfg.llama.url + path, { headers: cfg.llama.apiKey ? { Authorization: `Bearer ${cfg.llama.apiKey}` } : undefined, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch { return null; }
}
const json = (r: { status: number; body: string } | null): any => {
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
};

/** Prometheus text -> { 'prompt_tokens_total': 123, ... } (llamacpp: prefix dropped). */
export function parseMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^llamacpp:([a-zA-Z0-9_]+)(?:\{[^}]*\})?\s+([-+0-9.eE]+|NaN)/.exec(line.trim());
    if (m) { const v = Number(m[2]); if (Number.isFinite(v)) out[m[1]] = v; }
  }
  return out;
}

/** Guesses quantisation and parameter count from a GGUF file name. */
export function describeModel(file: string) {
  const quant = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32|MXFP4)(?=[-_.]|$)/i.exec(file)?.[1]?.toUpperCase() ?? null;
  const params = /(?:^|[-_.])(\d+(?:\.\d+)?)[bB](?=[-_.]|$)/.exec(file)?.[1] ?? null;
  const moe = /(\d+x\d+(?:\.\d+)?[bB])|-A\d+(?:\.\d+)?B/i.exec(file)?.[0] ?? null;
  return { quant, params: params ? `${params}B` : moe, mtp: /mtp/i.test(file) };
}

// Short history for the throughput/VRAM charts (in memory, filled while somebody looks at the page).
interface Point { ts: number; gpuUtil: number | null; vramMiB: number | null; promptTotal: number | null; genTotal: number | null; busy: number | null }
const history: Point[] = [];
const HISTORY_MAX = 360;

function pickProps(p: any) {
  if (!p || typeof p !== 'object') return null;
  const g = p.default_generation_settings ?? {};
  return {
    nCtx: num(g.n_ctx) ?? num(p.n_ctx),
    totalSlots: num(p.total_slots),
    modelPath: str(p.model_path, 500),
    modelAlias: str(p.model_alias, 120),
    buildInfo: str(p.build_info, 200),
    vision: !!p.modalities?.vision,
    audio: !!p.modalities?.audio,
    chatTemplate: str(p.chat_template, 6000),
    temperature: num(g.params?.temperature),
    topP: num(g.params?.top_p),
    topK: num(g.params?.top_k),
    nPredict: num(g.params?.n_predict) ?? num(g.n_predict),
  };
}

function pickSlots(s: any) {
  if (!Array.isArray(s)) return null;
  return s.slice(0, 64).map((x: any) => ({
    id: num(x?.id) ?? 0,
    nCtx: num(x?.n_ctx),
    busy: x?.is_processing === true,
    task: num(x?.id_task),
    decoded: num(x?.next_token?.[0]?.n_decoded) ?? num(x?.n_decoded),
    remain: num(x?.next_token?.[0]?.n_remain),
    promptTokens: num(x?.n_prompt_tokens) ?? num(x?.n_past),
  }));
}

async function vmStatus() {
  if (!pveConfigured()) return null;
  try {
    const s = await pve<any>('GET', `/nodes/${encodeURIComponent(cfg.pveNode)}/qemu/${cfg.llama.vmid}/status/current`);
    return { vmid: cfg.llama.vmid, name: String(s.name ?? ''), status: String(s.status ?? 'unknown'), uptime: num(s.uptime) };
  } catch { return { vmid: cfg.llama.vmid, name: '', status: 'unknown', uptime: null }; }
}

async function agentStatus() {
  if (!cfg.llama.agentUrl) return { configured: false, reachable: false, error: null, data: null };
  try {
    const r = await agent<any>('GET', '/status', undefined, 6_000);
    if (r.status !== 200) return { configured: true, reachable: true, error: r.data?.error ?? `HTTP ${r.status}`, data: null };
    return { configured: true, reachable: true, error: null, data: r.data };
  } catch (e) { return { configured: true, reachable: false, error: (e as Error).message, data: null }; }
}

export type LlamaState = 'running' | 'loading' | 'starting' | 'stopped' | 'vm-off' | 'agent-offline' | 'unknown' | 'error';

async function status() {
  const [vm, ag, health, props, slots, metrics, models] = await Promise.all([
    vmStatus(), agentStatus(), server('/health'), server('/props'), server('/slots'), server('/metrics'), server('/v1/models'),
  ]);
  const a = ag.data;
  const proc = a?.process ?? null;
  const healthState = !cfg.llama.url ? 'unconfigured' : !health ? 'down' : health.status === 200 ? 'ok' : health.status === 503 ? 'loading' : 'error';
  let state: LlamaState;
  if (vm && vm.status !== 'running' && vm.status !== 'unknown') state = 'vm-off';
  else if (healthState === 'ok') state = 'running';
  else if (healthState === 'loading') state = 'loading';
  else if (proc) state = 'starting';
  else if (ag.configured && !ag.reachable) state = healthState === 'down' ? 'agent-offline' : 'unknown';
  else if (ag.reachable) state = 'stopped';
  else state = healthState === 'down' ? 'stopped' : 'unknown';

  const m = metrics && metrics.status === 200 ? parseMetrics(metrics.body) : null;
  const gpu0 = a?.gpu?.gpus?.[0] ?? null;
  const now = Date.now();
  if (!history.length || now - history[history.length - 1].ts > 4_000) {
    const sl = pickSlots(json(slots));
    history.push({
      ts: now, gpuUtil: num(gpu0?.util), vramMiB: num(gpu0?.memUsedMiB),
      promptTotal: m ? m.prompt_tokens_total ?? null : null, genTotal: m ? m.tokens_predicted_total ?? null : null,
      busy: sl ? sl.filter((x) => x.busy).length : null,
    });
    if (history.length > HISTORY_MAX) history.shift();
  }
  const mj = json(models);
  return {
    state,
    configured: { server: !!cfg.llama.url, agent: !!cfg.llama.agentUrl },
    lanUrl: cfg.llama.url || null,
    publicUrl: cfg.llama.publicUrl || null,
    vm,
    agent: { configured: ag.configured, reachable: ag.reachable, error: ag.error, version: str(a?.agent, 20), host: str(a?.host, 60), bootTime: str(a?.bootTime, 40), ramFreeBytes: num(a?.ramFreeBytes), ramTotalBytes: num(a?.ramTotalBytes), autostart: !!a?.autostart, serverExists: a ? !!a.serverExists : null, portOwner: a?.portOwner ?? null },
    process: proc ? { pid: num(proc.pid), started: str(proc.started, 40), ramBytes: num(proc.ramBytes), commandLine: str(proc.commandLine, 4000), count: num(proc.count) } : null,
    launch: a?.launch ? { modelId: str(a.launch.modelId, 20), modelName: str(a.launch.modelName, 200), modelPath: str(a.launch.modelPath, 500), settings: a.launch.settings ?? {}, started: str(a.launch.started, 40), commandLine: str(a.launch.commandLine, 4000) } : null,
    gpu: a?.gpu ? { gpus: Array.isArray(a.gpu.gpus) ? a.gpu.gpus : [], apps: Array.isArray(a.gpu.apps) ? a.gpu.apps : [] } : null,
    server: {
      health: healthState, httpStatus: health?.status ?? null,
      // /health is open even with --api-key; the other endpoints answer 401 when LLAMA_API_KEY is missing or wrong.
      auth: [props, slots, models].some((r) => r?.status === 401) ? (cfg.llama.apiKey ? 'rejected' : 'required') : 'ok',
      props: pickProps(json(props)),
      slots: pickSlots(json(slots)),
      metrics: m,
      metricsEnabled: metrics ? metrics.status === 200 : null,
      models: Array.isArray(mj?.data) ? mj.data.map((x: any) => str(x?.id, 200)).filter(Boolean) : [],
    },
    history,
  };
}

async function audit(req: FastifyRequest, action: string, result: 'accepted' | 'refused' | 'error', reason?: string, name?: string) {
  try { insertAudit({ ts: Date.now(), user: req.user!.username, ip: req.ip, vmid: cfg.llama.vmid, action, result, reason, name }); } catch { /* audit must not break the action */ }
}

const PRESET_KEY = 'llama-presets';
interface Preset { id: string; name: string; modelId: string; modelName?: string; settings: LaunchSettings }

// ---------- routes ----------
export function registerLlama(app: FastifyInstance) {
  app.get('/api/llama', async () => {
    if (!llamaConfigured()) throw notConfigured('llama.cpp (LLAMA_URL / LLAMA_AGENT_URL)');
    return status();
  });

  app.get('/api/llama/models', async () => {
    const r = await agent<any>('GET', '/models', undefined, 20_000);
    if (r.status !== 200) throw new HttpError(502, 'AGENT_ERROR', r.data?.error ?? `Agent returned ${r.status}`);
    const list = Array.isArray(r.data?.models) ? r.data.models : [];
    return {
      dirs: Array.isArray(r.data?.dirs) ? r.data.dirs.map((d: unknown) => str(d, 300)) : [],
      models: list.slice(0, 500).map((m: any) => ({
        id: str(m.id, 20), name: str(m.name, 200), file: str(m.file, 200), path: str(m.path, 500), dir: str(m.dir, 300),
        size: num(m.size), modified: str(m.modified, 40), source: m.source === 'hf' ? 'hf' : 'local', repo: str(m.repo, 200),
        mmproj: str(m.mmproj, 500), mmprojSize: num(m.mmprojSize), ...describeModel(String(m.file ?? '')),
      })),
    };
  });

  app.post<{ Body: { modelId?: string; settings?: unknown; restart?: boolean } }>('/api/llama/start', async (req, reply) => {
    const modelId = String(req.body?.modelId ?? '');
    const action = req.body?.restart ? 'llama.switch' : 'llama.start';
    if (!/^[0-9a-f]{12}$/.test(modelId)) { await audit(req, action, 'refused', 'BAD_MODEL'); throw bad('Pick a model from the list'); }
    let settings: LaunchSettings;
    try { settings = parseSettings(req.body?.settings); } catch (e) { await audit(req, action, 'refused', 'BAD_SETTINGS'); throw e; }
    const vm = await vmStatus();
    if (vm && vm.status !== 'running' && vm.status !== 'unknown') { await audit(req, action, 'refused', 'VM_OFF'); throw new HttpError(409, 'VM_OFF', `VM ${vm.vmid} is ${vm.status}; start it first`); }
    try {
      const r = await agent<any>('POST', '/start', { modelId, ...settings, restart: !!req.body?.restart }, 45_000);
      if (r.status >= 400) {
        await audit(req, action, 'refused', r.data?.code ?? `HTTP ${r.status}`);
        throw new HttpError(r.status === 409 || r.status === 404 || r.status === 400 ? r.status : 502, r.data?.code ?? 'AGENT_ERROR', r.data?.error ?? 'The agent refused the start');
      }
      await audit(req, action, 'accepted', undefined, str(r.data?.modelName, 200) ?? modelId);
      logEvent('info', 'guest', `llama-server ${req.body?.restart ? 'switched to' : 'started with'} ${r.data?.modelName ?? modelId}`, { vmid: cfg.llama.vmid, user: req.user!.username });
      reply.code(202);
      return { started: true, pid: num(r.data?.pid), modelName: str(r.data?.modelName, 200), commandLine: str(r.data?.commandLine, 4000) };
    } catch (e) {
      if (e instanceof HttpError && e.code !== 'AGENT_UNREACHABLE' && e.code !== 'AGENT_AUTH') throw e;
      await audit(req, action, 'error', (e as Error).message);
      throw e;
    }
  });

  app.post('/api/llama/stop', async (req) => {
    try {
      const r = await agent<any>('POST', '/stop', undefined, 30_000);
      if (r.status !== 200) throw new HttpError(502, 'AGENT_ERROR', r.data?.error ?? `Agent returned ${r.status}`);
      await audit(req, 'llama.stop', 'accepted', undefined, `${num(r.data?.stopped) ?? 0} process(es)`);
      logEvent('info', 'guest', 'llama-server stopped', { vmid: cfg.llama.vmid, user: req.user!.username });
      return { stopped: num(r.data?.stopped) ?? 0 };
    } catch (e) { await audit(req, 'llama.stop', 'error', (e as Error).message); throw e; }
  });

  app.post<{ Body: { enabled?: boolean } }>('/api/llama/autostart', async (req) => {
    const enabled = req.body?.enabled === true;
    try {
      const r = await agent<any>('POST', '/autostart', { enabled });
      if (r.status !== 200) throw new HttpError(502, 'AGENT_ERROR', r.data?.error ?? `Agent returned ${r.status}`);
      await audit(req, 'llama.autostart', 'accepted', undefined, enabled ? 'on' : 'off');
      return { autostart: !!r.data?.autostart };
    } catch (e) { await audit(req, 'llama.autostart', 'error', (e as Error).message); throw e; }
  });

  app.get<{ Querystring: { lines?: string; prev?: string } }>('/api/llama/log', async (req) => {
    const lines = Math.min(2000, Math.max(1, Number(req.query.lines) || 300));
    const r = await agent<any>('GET', `/log?lines=${lines}${req.query.prev === '1' ? '&prev=1' : ''}`, undefined, 10_000);
    if (r.status !== 200) throw new HttpError(502, 'AGENT_ERROR', r.data?.error ?? `Agent returned ${r.status}`);
    return { file: str(r.data?.file, 300), lines: (Array.isArray(r.data?.lines) ? r.data.lines : []).map((l: unknown) => String(l).slice(0, 2000)) };
  });

  app.get('/api/llama/presets', async () => {
    const v = getState(PRESET_KEY) as { list?: Preset[] } | undefined;
    return v?.list ?? [];
  });

  app.put<{ Body: unknown }>('/api/llama/presets', async (req) => {
    const raw = Array.isArray(req.body) ? req.body : [];
    if (raw.length > 50) throw bad('At most 50 presets');
    const list: Preset[] = raw.map((p: any, i: number) => {
      const name = String(p?.name ?? '').trim().slice(0, 60);
      if (!name) throw bad(`Preset ${i + 1} needs a name`);
      const modelId = String(p?.modelId ?? '');
      if (!/^[0-9a-f]{12}$/.test(modelId)) throw bad(`Preset "${name}" has no model`);
      const id = typeof p?.id === 'string' && /^[a-z0-9]{1,24}$/.test(p.id) ? p.id : Math.random().toString(36).slice(2, 12);
      return { id, name, modelId, modelName: String(p?.modelName ?? '').slice(0, 200), settings: parseSettings(p?.settings) };
    });
    setState(PRESET_KEY, { list });
    return list;
  });

  // Playground: one non-streaming chat completion, returns text + llama.cpp timings.
  app.post<{ Body: { messages?: unknown; maxTokens?: number; temperature?: number; system?: string } }>('/api/llama/chat', async (req) => {
    if (!cfg.llama.url) throw notConfigured('llama-server (LLAMA_URL)');
    const msgs = (Array.isArray(req.body?.messages) ? req.body!.messages : []).slice(-20).map((m: any) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content ?? '').slice(0, 16_000),
    })).filter((m) => m.content.trim());
    if (!msgs.length) throw bad('Type a message first');
    const system = String(req.body?.system ?? '').slice(0, 4000).trim();
    const maxTokens = Math.min(4096, Math.max(1, Number(req.body?.maxTokens) || 512));
    const temperature = Math.min(2, Math.max(0, Number(req.body?.temperature ?? 0.7)));
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${cfg.llama.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.llama.apiKey ? { Authorization: `Bearer ${cfg.llama.apiKey}` } : {}) },
        body: JSON.stringify({ messages: system ? [{ role: 'system', content: system }, ...msgs] : msgs, max_tokens: maxTokens, temperature, stream: false }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) { throw new HttpError(502, 'LLAMA_UNREACHABLE', `llama-server did not answer (${(e as Error).message})`); }
    const data: any = await res.json().catch(() => null);
    if (res.status === 401) throw new HttpError(502, 'LLAMA_AUTH', cfg.llama.apiKey ? 'llama-server rejected LLAMA_API_KEY' : 'llama-server needs an API key: set LLAMA_API_KEY in server/.env');
    if (!res.ok) throw new HttpError(res.status === 503 ? 503 : 502, res.status === 503 ? 'LOADING' : 'LLAMA_ERROR', data?.error?.message ?? `llama-server returned ${res.status}`);
    const msg = data?.choices?.[0]?.message ?? {};
    const t = data?.timings ?? {};
    return {
      content: String(msg.content ?? ''), reasoning: msg.reasoning_content ? String(msg.reasoning_content) : null,
      finish: str(data?.choices?.[0]?.finish_reason, 40), model: str(data?.model, 200),
      usage: { prompt: num(data?.usage?.prompt_tokens), completion: num(data?.usage?.completion_tokens) },
      timings: { promptN: num(t.prompt_n), promptMs: num(t.prompt_ms), promptPerSec: num(t.prompt_per_second), genN: num(t.predicted_n), genMs: num(t.predicted_ms), genPerSec: num(t.predicted_per_second), draftN: num(t.draft_n), draftAccepted: num(t.draft_n_accepted) },
      wallMs: Date.now() - t0,
    };
  });
}
