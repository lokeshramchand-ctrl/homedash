import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, Chips, CodeBlock, CopyButton, DocRow, EmptyState, Icon, Meter, PageHeader, Sheet, Spinner, Stat } from '../components/ui';
import type { SheetSection, Tone } from '../components/ui';
import { ContextMeter, Gauge, TimeChart } from '../components/Charts';
import { fmtBytes, fmtUptime, timeAgo } from '../format';
import { useQuery, useToast } from '../hooks';
import type { Query } from '../hooks';
import type { LlamaModel, LlamaPoint, LlamaPreset, LlamaSettings, LlamaState, LlamaStatus } from '../types';

type Tab = 'overview' | 'models' | 'chat' | 'log';
type Panel = null | 'docs' | 'details';
const DEFAULTS: LlamaSettings = { ngl: 99, ctx: 32768, parallel: 1, flashAttn: 'auto', jinja: true };
const CACHE = ['', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl', 'f32'];
const MIB = 1024 * 1024;

const STATE: Record<LlamaState, { label: string; tone: Tone; hint: string }> = {
  running: { label: 'Running', tone: 'green', hint: 'Model loaded and answering requests.' },
  loading: { label: 'Loading model', tone: 'amber', hint: 'llama-server is up and loading weights into VRAM.' },
  starting: { label: 'Starting', tone: 'amber', hint: 'The process exists but the HTTP server is not answering yet.' },
  stopped: { label: 'Stopped', tone: 'gray', hint: 'No llama-server process on the VM.' },
  'vm-off': { label: 'VM off', tone: 'gray', hint: 'The Windows VM is not running. Start it from Guests first.' },
  'agent-offline': { label: 'Agent offline', tone: 'red', hint: 'The control agent on the VM does not answer, so start and stop are unavailable.' },
  unknown: { label: 'Unknown', tone: 'amber', hint: 'The status could not be determined.' },
  error: { label: 'Error', tone: 'red', hint: 'llama-server answered with an error.' },
};

export default function Llama() {
  const q = useQuery(api.llama, [], 3000);
  const [tab, setTab] = useState<Tab>('overview');
  const [pending, setPending] = useState<null | 'start' | 'stop' | 'switch'>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const toast = useToast();
  const models = useQuery(() => (q.data?.agent.reachable ? api.llamaModels() : Promise.resolve({ dirs: [], models: [] as LlamaModel[] })), [q.data?.agent.reachable]);

  // A pending action clears once the state it aims for is reached (or after 3 minutes).
  useEffect(() => {
    if (!pending || !q.data) return;
    const s = q.data.state;
    if ((pending === 'stop' && (s === 'stopped' || s === 'vm-off')) || (pending !== 'stop' && (s === 'running' || s === 'error'))) setPending(null);
  }, [pending, q.data]);
  useEffect(() => { if (!pending) return; const t = setTimeout(() => setPending(null), 180_000); return () => clearTimeout(t); }, [pending]);

  const start = async (m: LlamaModel | { id: string; name: string }, settings: LlamaSettings, restart: boolean) => {
    setPending(restart ? 'switch' : 'start');
    try {
      const r = await api.llamaStart(m.id, settings, restart);
      toast.success(`${restart ? 'Switching to' : 'Starting'} ${r.modelName ?? m.name}…`);
      q.reload();
    } catch (e) { setPending(null); toast.error((e as Error).message); }
  };
  const stop = async () => {
    setPending('stop');
    try { const r = await api.llamaStop(); toast.success(r.stopped ? 'llama-server stopped' : 'llama-server was not running'); q.reload(); } catch (e) { setPending(null); toast.error((e as Error).message); }
  };
  const close = () => setPanel(null);

  return (
    <>
      <PageHeader eyebrow="Services" title="LLM server" sub="Run local models on the VM's GPU. Start, switch and test them here."
        actions={<>
          <button className="btn btn-ghost" onClick={() => setPanel('docs')}><Icon name="book" size={16} />Developer docs</button>
          {q.data?.publicUrl && <a className="btn btn-ghost" href={q.data.publicUrl} target="_blank" rel="noreferrer"><Icon name="external" size={16} />Web UI</a>}
        </>} />
      <Async q={q} rows={2} h={140}>
        {(s) => (
          <>
            <Status s={s} pending={pending} onDetails={() => setPanel('details')} onStart={() => {
              const last = s.launch;
              if (last?.modelId) start({ id: last.modelId, name: last.modelName ?? 'model' }, last.settings ?? DEFAULTS, false);
              else setTab('models');
            }} onStop={stop} onRestart={() => s.launch?.modelId && start({ id: s.launch.modelId, name: s.launch.modelName ?? 'model' }, s.launch.settings ?? DEFAULTS, true)} />
            <Setup s={s} onDocs={() => setPanel('docs')} />
            <div className="ll-tabs">
              <Chips value={tab} onChange={setTab} options={[
                { id: 'overview', label: 'Overview' },
                { id: 'models', label: 'Models', count: models.data?.models.length || undefined },
                { id: 'chat', label: 'Playground' },
                { id: 'log', label: 'Log' },
              ]} />
              {q.refreshing && <Spinner size={14} />}
            </div>
            {tab === 'overview' && <Overview s={s} onDetails={() => setPanel('details')} />}
            {tab === 'models' && <Models s={s} q={models} pending={pending} onStart={start} />}
            {tab === 'chat' && <Playground s={s} onDocs={() => setPanel('docs')} />}
            {tab === 'log' && <Log s={s} />}
            {panel === 'docs' && <DevDocs s={s} dirs={models.data?.dirs ?? []} onClose={close} />}
            {panel === 'details' && <Details s={s} onClose={close} />}
          </>
        )}
      </Async>
    </>
  );
}

// ---------- status ----------
function Status({ s, pending, onStart, onStop, onRestart, onDetails }: { s: LlamaStatus; pending: string | null; onStart: () => void; onStop: () => void; onRestart: () => void; onDetails: () => void }) {
  const st = STATE[s.state];
  const live = s.state === 'running' || s.state === 'loading' || s.state === 'starting';
  const canControl = s.agent.reachable && s.state !== 'vm-off';
  const name = modelName(s);
  const upSince = s.process?.started ?? s.launch?.started;
  const facts = [
    s.vm?.vmid != null ? `VM ${s.vm.vmid}` : null,
    live && upSince ? `Up ${fmtUptime((Date.now() - new Date(upSince).getTime()) / 1000)}` : null,
    s.server.props?.nCtx != null ? `${fmtCtx(s.server.props.nCtx)} context` : null,
    s.server.props?.totalSlots != null ? `${s.server.props.totalSlots} slot${s.server.props.totalSlots === 1 ? '' : 's'}` : null,
    s.server.props?.vision ? 'Vision' : null,
  ].filter(Boolean) as string[];
  return (
    <section className={`ll-status tone-${pending ? 'amber' : st.tone}`}>
      <div className="ll-status-main">
        <div className="ll-status-top">
          {pending
            ? <Badge tone="amber"><Spinner size={11} />{pending === 'stop' ? 'Stopping' : pending === 'switch' ? 'Switching model' : 'Starting'}</Badge>
            : <Badge tone={st.tone} dot>{st.label}</Badge>}
          <span className="ll-hint muted small">{pending ? 'Large models can take up to a minute to load.' : st.hint}</span>
        </div>
        <h2>{live && name ? name : 'No model running'}</h2>
        {facts.length > 0 && <p className="ll-facts">{facts.map((f) => <span key={f}>{f}</span>)}</p>}
        {!live && s.launch?.modelName && <p className="ll-facts"><span>Last run: {s.launch.modelName}</span></p>}
        {s.agent.portOwner && !s.process && <div className="callout warn"><Icon name="alert" size={16} /><span>The server port is in use by {s.agent.portOwner.name} (pid {s.agent.portOwner.pid}).</span></div>}
      </div>
      <div className="ll-status-btns">
        {live ? (
          <>
            <button className="btn btn-ghost" disabled={!!pending || !canControl || !s.launch?.modelId} onClick={onRestart}><Icon name="rotate" size={16} />Restart</button>
            <button className="btn btn-primary" disabled={!!pending || !canControl} onClick={onStop}>{pending === 'stop' ? <Spinner size={14} /> : <Icon name="power" size={16} />}{pending === 'stop' ? 'Stopping…' : 'Stop'}</button>
          </>
        ) : (
          <button className="btn btn-primary" disabled={!!pending || !canControl} onClick={onStart} title={s.launch?.modelName ? `Start ${s.launch.modelName}` : 'Pick a model first'}>
            {pending ? <Spinner size={14} /> : <Icon name="play" size={16} />}
            {pending ? 'Starting…' : s.launch?.modelName ? 'Start server' : 'Choose a model'}
          </button>
        )}
        <button className="icon-btn bordered" onClick={onDetails} aria-label="Server details" title="Server details"><Icon name="info" size={17} /></button>
      </div>
    </section>
  );
}

function Setup({ s, onDocs }: { s: LlamaStatus; onDocs: () => void }) {
  const more = <button className="btn btn-sm btn-ghost" onClick={onDocs}><Icon name="book" size={14} />Setup guide</button>;
  if (s.server.auth === 'required') return <div className="callout warn"><Icon name="key" size={16} /><span>llama-server needs an API key. Set <code>LLAMA_API_KEY</code> in <code>server/.env</code> and restart the dashboard.</span></div>;
  if (s.server.auth === 'rejected') return <div className="callout err"><Icon name="key" size={16} /><span>llama-server rejected the API key. Check that <code>LLAMA_API_KEY</code> matches the key it was started with.</span></div>;
  if (!s.configured.agent) return <div className="callout warn"><Icon name="info" size={16} /><span>Start, stop and model switching need the control agent on the VM.</span>{more}</div>;
  if (!s.agent.reachable && s.state !== 'vm-off') return <div className="callout err"><Icon name="alert" size={16} /><span>The control agent is not answering{s.agent.error ? `: ${s.agent.error}` : ''}.</span>{more}</div>;
  if (s.agent.reachable && s.agent.serverExists === false) return <div className="callout err"><Icon name="alert" size={16} /><span>llama-server was not found on the VM.</span>{more}</div>;
  return null;
}

// ---------- developer docs: every path, URL and command lives here ----------
function DevDocs({ s, dirs, onClose }: { s: LlamaStatus; dirs: string[]; onClose: () => void }) {
  const base = s.lanUrl ?? '';
  const model = s.server.models[0] ?? 'model';
  const curl = `curl ${base || 'http://<server>'}/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`;
  const py = `from openai import OpenAI\n\nclient = OpenAI(base_url="${base || 'http://<server>'}/v1", api_key="none")\nr = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(r.choices[0].message.content)`;
  const sections: SheetSection[] = [
    { id: 'connect', title: 'Connect', icon: 'link', body: (
      <>
        <p className="muted small">The server speaks the OpenAI API. Point any compatible client at these.</p>
        <div className="doc-list">
          {base && <DocRow k="LAN base URL" v={`${base}/v1`} copy={`${base}/v1`} />}
          {s.publicUrl && <DocRow k="Public URL" v={`${s.publicUrl}/v1`} copy={`${s.publicUrl}/v1`} />}
          <DocRow k="Model id" v={model} copy={model} />
        </div>
      </>
    ) },
    { id: 'endpoints', title: 'Endpoints', icon: 'list', body: (
      <div className="doc-list">
        {([['GET', '/health', 'Liveness and load state'], ['GET', '/v1/models', 'Loaded model id'], ['POST', '/v1/chat/completions', 'Chat, OpenAI format'], ['POST', '/v1/completions', 'Raw completion'], ['GET', '/slots', 'Per-slot state'], ['GET', '/metrics', 'Prometheus metrics']] as const).map(([m, p, d]) => (
          <div key={p} className="doc-ep"><span className={`doc-method ${m.toLowerCase()}`}>{m}</span><code>{p}</code><span className="muted small">{d}</span></div>
        ))}
      </div>
    ) },
    { id: 'examples', title: 'Examples', icon: 'code', body: (
      <>
        <CodeBlock label="curl" code={curl} />
        <CodeBlock label="python · openai" code={py} />
      </>
    ) },
    ...(s.launch?.commandLine ? [{ id: 'launch', title: 'Launch command', icon: 'terminal' as const, body: (
      <>
        <p className="muted small">Started {s.launch.started ? timeAgo(s.launch.started) : ''} from this page.</p>
        <CodeBlock label="powershell" code={s.launch.commandLine} />
      </>
    ) }] : []),
    { id: 'vm', title: 'On the VM', icon: 'folder', body: (
      <div className="doc-list">
        {dirs.length > 0 && <DocRow k="Model folders" v={dirs.join('  ·  ')} />}
        <DocRow k="Add models" v="Drop .gguf files into a model folder, or download them with the Hugging Face app." mono={false} />
        <DocRow k="Server log" v="agent\server.log (also under Log)" />
        <DocRow k="Agent log" v="agent\agent.log" />
        <DocRow k="Agent task" v="LlamaAgent (Windows scheduled task)" />
      </div>
    ) },
    { id: 'agent', title: 'Control agent setup', icon: 'plug', body: (
      <ol className="doc-steps">
        <li>Copy <code>llama-agent.ps1</code> and <code>install-llama-agent.ps1</code> from <code>scripts/windows</code> to the VM.</li>
        <li>Run the installer as Administrator.</li>
        <li>Put the two lines it prints (<code>LLAMA_AGENT_URL</code>, <code>LLAMA_AGENT_TOKEN</code>) in <code>server/.env</code>.</li>
        <li>Restart the backend.</li>
      </ol>
    ) },
  ];
  return <Sheet size="lg" eyebrow="LLM server" title="Developer docs" sub="Endpoints, examples and setup for the OpenAI-compatible server." onClose={onClose} sections={sections} />;
}

// ---------- server details: the reference data that used to crowd the overview ----------
function Details({ s, onClose }: { s: LlamaStatus; onClose: () => void }) {
  const p = s.server.props;
  const gpu = s.gpu?.gpus[0];
  const sections: SheetSection[] = [
    { id: 'server', title: 'Server', icon: 'server', body: (
      <div className="doc-list">
        <DocRow k="Health" v={<Badge tone={s.server.health === 'ok' ? 'green' : s.server.health === 'loading' ? 'amber' : 'gray'} dot>/health {s.server.httpStatus ?? 'down'}</Badge>} mono={false} />
        <DocRow k="Model" v={p?.modelPath ? baseName(p.modelPath) : s.launch?.modelName ?? '-'} />
        {p?.modelAlias && <DocRow k="API alias" v={p.modelAlias} copy={p.modelAlias} />}
        <DocRow k="Context" v={p?.nCtx != null ? `${p.nCtx.toLocaleString()} tokens total` : '-'} />
        <DocRow k="Slots" v={p?.totalSlots != null ? String(p.totalSlots) : '-'} />
        <DocRow k="Sampling" v={p ? `temp ${p.temperature ?? '?'} · top-p ${p.topP ?? '?'} · top-k ${p.topK ?? '?'}` : '-'} />
        <DocRow k="Metrics" v={s.server.metricsEnabled ? 'On' : s.server.metricsEnabled === false ? 'Off' : '-'} />
        {p?.buildInfo && <DocRow k="Build" v={p.buildInfo} />}
      </div>
    ) },
    { id: 'process', title: 'Process', icon: 'cpu', body: (
      <div className="doc-list">
        <DocRow k="PID" v={s.process?.pid != null ? String(s.process.pid) : 'not running'} />
        <DocRow k="RAM" v={s.process?.ramBytes != null ? fmtBytes(s.process.ramBytes) : '-'} />
        {(s.process?.count ?? 1) > 1 && <DocRow k="Processes" v={`${s.process!.count} running (expected 1)`} />}
        <DocRow k="Started" v={s.process?.started ? timeAgo(s.process.started) : '-'} />
      </div>
    ) },
    { id: 'gpu', title: 'GPU', icon: 'gpu', body: gpu ? (
      <>
        <div className="doc-list">
          <DocRow k="Card" v={gpu.name} />
          <DocRow k="Driver" v={gpu.driver} />
          <DocRow k="Core clock" v={gpu.smClockMHz != null ? `${gpu.smClockMHz} MHz` : '-'} />
          <DocRow k="Fan" v={gpu.fanPct != null ? `${gpu.fanPct}%` : '-'} />
          <DocRow k="Power limit" v={gpu.powerLimitW != null ? `${Math.round(gpu.powerLimitW)} W` : '-'} />
        </div>
        {(s.gpu?.apps.length ?? 0) > 0 && (
          <>
            <p className="sheet-sub">GPU processes</p>
            <div className="doc-list">{s.gpu!.apps.map((a) => <DocRow key={a.pid} k={`pid ${a.pid}`} v={`${a.name}${a.memMiB ? ` · ${fmtMiB(a.memMiB)}` : ''}`} />)}</div>
          </>
        )}
      </>
    ) : <p className="muted small">No GPU data. GPU stats come from the control agent.</p> },
    { id: 'agent', title: 'Control agent', icon: 'plug', body: (
      <div className="doc-list">
        <DocRow k="Status" v={<Badge tone={s.agent.reachable ? 'green' : s.agent.configured ? 'red' : 'gray'} dot>{s.agent.reachable ? 'reachable' : s.agent.configured ? 'not answering' : 'not configured'}</Badge>} mono={false} />
        {s.agent.version && <DocRow k="Version" v={s.agent.version} />}
        {s.agent.host && <DocRow k="Host" v={s.agent.host} />}
        {s.agent.bootTime && <DocRow k="VM booted" v={timeAgo(s.agent.bootTime)} />}
        {s.agent.ramTotalBytes != null && <DocRow k="VM RAM free" v={`${fmtBytes(s.agent.ramFreeBytes ?? 0)} of ${fmtBytes(s.agent.ramTotalBytes)}`} />}
        <DocRow k="Autostart" v={s.agent.autostart ? 'On, relaunches the last model' : 'Off'} />
        {s.agent.error && <DocRow k="Last error" v={s.agent.error} />}
      </div>
    ) },
  ];
  return <Sheet eyebrow="LLM server" title="Server details" sub={modelName(s) ?? STATE[s.state].label} onClose={onClose} sections={sections} />;
}

// ---------- overview ----------
function Overview({ s, onDetails }: { s: LlamaStatus; onDetails: () => void }) {
  const m = s.server.metrics;
  const gpu = s.gpu?.gpus[0];
  const slots = s.server.slots ?? [];
  const busy = slots.filter((x) => x.busy).length;
  const rates = useMemo(() => rateSeries(s.history), [s.history]);
  const lastGen = s.state === 'running' ? [...rates].reverse().find((r) => r.gen > 0)?.gen ?? null : null;
  const hist = s.history;
  const apps = (s.gpu?.apps ?? []).filter((a) => a.memMiB);
  const appsMiB = apps.reduce((a, x) => a + (x.memMiB ?? 0), 0);
  return (
    <>
      <div className="stats">
        <Stat icon="zap" label="Generation" value={m?.predicted_tokens_seconds ? fmtRate(m.predicted_tokens_seconds) : '-'} unit="tok/s" sub={lastGen ? `${fmtRate(lastGen)} tok/s just now` : 'Average since start'} spark={rates.map((r) => r.gen)} sparkKind="line" trend="up" />
        <Stat icon="activity" label="Prompt processing" value={m?.prompt_tokens_seconds ? fmtRate(m.prompt_tokens_seconds) : '-'} unit="tok/s" sub="Average since start" spark={rates.map((r) => r.prompt)} sparkKind="line" />
        <Stat icon="layers" label="Busy slots" value={s.server.slots ? `${busy}/${slots.length}` : '-'} sub={m?.requests_deferred ? `${m.requests_deferred} queued` : m ? `${fmtK(m.tokens_predicted_total ?? 0)} tokens generated` : 'Idle'} spark={hist.map((p) => p.busy ?? 0)} />
        <Stat icon="memory" label="VRAM" value={gpu?.memUsedMiB != null ? fmtMiB(gpu.memUsedMiB, false) : '-'} unit={gpu?.memUsedMiB != null ? 'GB' : undefined} sub={gpu?.memTotalMiB ? `of ${fmtMiB(gpu.memTotalMiB)}` : 'No GPU data'} spark={hist.map((p) => p.vramMiB ?? 0)} sparkKind="line"
          tone={gpu?.memUsedMiB != null && gpu.memTotalMiB && gpu.memUsedMiB / gpu.memTotalMiB > 0.95 ? 'red' : undefined} />
        <Stat icon="gpu" label="GPU" value={gpu?.util != null ? `${gpu.util}` : '-'} unit={gpu?.util != null ? '%' : undefined} sub={gpu ? `${gpu.tempC ?? '?'}°C · ${gpu.powerW != null ? Math.round(gpu.powerW) : '?'} W` : 'No GPU data'} spark={hist.map((p) => p.gpuUtil ?? 0)} sparkKind="line" />
      </div>

      <div className="grid-2 llama-charts">
        <Card>
          <CardHead title="Tokens per second" sub="Generated tokens, while this page is open" />
          {rates.length < 2 ? <EmptyState icon="activity" title="Collecting samples" hint="The chart fills in while this page stays open." /> : (
            <TimeChart height={150} label="Generated tokens per second" fmt={(v) => `${fmtRate(v)} tok/s`}
              series={[{ name: 'Generation', kind: 'line', points: rates.map((r) => [r.ts / 1000, r.gen]), color: 'var(--signal)' }]} />
          )}
        </Card>
        <Card>
          <CardHead title="GPU load" sub="Utilisation, sampled every few seconds" />
          {hist.length < 2 ? <EmptyState icon="activity" title="Collecting samples" hint="The chart fills in while this page stays open." /> : (
            <TimeChart height={150} max={100} label="GPU utilisation" fmt={(v) => `${Math.round(v)}%`}
              series={[{ name: 'Utilisation', kind: 'area', points: hist.map((p) => [p.ts / 1000, p.gpuUtil ?? 0]), color: 'var(--green)' }]} />
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card>
          <CardHead title="GPU" sub={gpu ? gpu.name : 'Live from the VM'} right={<button className="btn btn-sm btn-ghost" onClick={onDetails}>Details<Icon name="chevron" size={14} /></button>} />
          {gpu ? (
            <div className="res">
              {gpu.memTotalMiB != null && gpu.memUsedMiB != null && (
                <ContextMeter label="VRAM" sub="By process" total={gpu.memTotalMiB} fmt={(v) => fmtMiB(v)} parts={[
                  ...apps.map((a, i) => ({ label: a.name.replace(/\.exe$/i, ''), value: a.memMiB ?? 0, color: i === 0 ? 'var(--signal)' : i === 1 ? 'var(--peri)' : 'var(--green)', hint: `pid ${a.pid}` })),
                  ...(gpu.memUsedMiB - appsMiB > 64 ? [{ label: 'System', value: gpu.memUsedMiB - appsMiB, color: 'var(--muted)', hint: 'Driver, desktop and processes nvidia-smi does not list' }] : []),
                  ...(apps.length === 0 && gpu.memUsedMiB <= 64 ? [{ label: 'Used', value: gpu.memUsedMiB }] : []),
                ]} />
              )}
              <div className="gauges">
                <Gauge label="Utilisation" value={gpu.util} unit="%" sub={gpu.smClockMHz != null ? `${gpu.smClockMHz} MHz` : undefined} />
                <Gauge label="Power" value={gpu.powerW != null ? Math.round(gpu.powerW) : null} max={gpu.powerLimitW || 180} unit="W" sub={`limit ${gpu.powerLimitW != null ? Math.round(gpu.powerLimitW) : '?'} W`} />
                <Gauge label="Temperature" value={gpu.tempC} max={90} unit="°C" warn={0.8} crit={0.92} sub={gpu.fanPct != null ? `fan ${gpu.fanPct}%` : undefined} />
              </div>
            </div>
          ) : <EmptyState icon="gpu" title="No GPU data" hint={s.agent.reachable ? 'nvidia-smi gave no output on the VM.' : 'GPU stats come from the control agent.'} />}
        </Card>

        <Card>
          <CardHead title="Slots" sub="Context used per parallel conversation" right={s.server.metrics?.kv_cache_usage_ratio != null ? <Badge tone="blue">KV {Math.round(s.server.metrics.kv_cache_usage_ratio * 100)}%</Badge> : undefined} />
          {slots.length === 0 ? <EmptyState icon="layers" title="No slots" hint={s.state === 'running' ? 'This build does not expose /slots.' : 'Start the server to see its slots.'} /> : (
            <div className="res">
              {slots.map((x) => (
                <ContextMeter key={x.id} ticks={40} label={<>Slot {x.id} {x.busy ? <Badge tone="green" dot>busy</Badge> : <Badge>idle</Badge>}</>}
                  total={x.nCtx ?? 0} fmt={fmtTok} legend={x.busy || (x.promptTokens ?? 0) > 0}
                  parts={[{ label: 'Prompt', value: x.promptTokens ?? 0, color: 'var(--signal)' }, { label: 'Generated', value: x.decoded ?? 0, color: 'var(--green)' }]} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------- models & launch ----------
function Models({ s, q, pending, onStart }: { s: LlamaStatus; q: Query<{ dirs: string[]; models: LlamaModel[] }>; pending: string | null; onStart: (m: LlamaModel, st: LlamaSettings, restart: boolean) => void }) {
  const toast = useToast();
  const presetsQ = useQuery(api.llamaPresets, []);
  const [selId, setSelId] = useState<string | null>(null);
  const [st, setSt] = useState<LlamaSettings>(s.launch?.settings && Object.keys(s.launch.settings).length ? clean(s.launch.settings) : DEFAULTS);
  const [filter, setFilter] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const loadedId = s.state === 'running' || s.state === 'loading' || s.state === 'starting' ? s.launch?.modelId ?? null : null;
  const live = !!s.process || s.state === 'running' || s.state === 'loading';
  const vramMiB = s.gpu?.gpus[0]?.memTotalMiB ?? 16384;

  if (!s.agent.reachable) return <Card><EmptyState icon="plug" title="Model list needs the control agent" hint="The control agent lists the models on the VM. Setup steps are in Developer docs." /></Card>;

  return (
    <Async q={q} rows={4} h={64} isEmpty={(d) => d.models.length === 0} empty={{ title: 'No .gguf models found', hint: 'Add .gguf files to a model folder on the VM. Folder locations are in Developer docs.' }}>
      {(d) => {
        const sel = d.models.find((m) => m.id === (selId ?? loadedId ?? s.launch?.modelId)) ?? d.models[0];
        const list = d.models.filter((m) => !filter || `${m.name} ${m.repo ?? ''} ${m.quant ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
        const presets = presetsQ.data ?? [];
        const savePresets = async (next: LlamaPreset[]) => {
          try { const r = await api.llamaSavePresets(next); presetsQ.mutate(() => r); toast.success('Presets saved'); } catch (e) { toast.error((e as Error).message); }
        };
        const est = estimate(sel, st, vramMiB);
        const extras = advancedSummary(st);
        return (
          <div className="llama-models">
            <Card className="table" pad={false}>
              <div className="llama-mhead">
                <div><h3>Models</h3><p className="muted small">{d.models.length} on the VM</p></div>
                <label className="search mini"><Icon name="search" size={14} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models…" aria-label="Filter models" /></label>
              </div>
              {list.map((m) => {
                const fit = estimate(m, { ...st, vision: !!m.mmproj && st.vision !== false }, vramMiB);
                const isLoaded = m.id === loadedId;
                return (
                  <div key={m.id} className={`llama-mrow ${sel?.id === m.id ? 'sel' : ''}`} onClick={() => setSelId(m.id)} role="button" tabIndex={0} aria-pressed={sel?.id === m.id} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelId(m.id); } }}>
                    <div className="ll-name">
                      <b>{m.name}</b>
                      <span className="muted small">{m.source === 'hf' ? `Hugging Face · ${m.repo}` : 'Local'} · {m.size ? fmtBytes(m.size) : '-'}</span>
                    </div>
                    <div className="chipline ll-chips">
                      {m.params && <Badge>{m.params}</Badge>}
                      {m.quant && <Badge tone="blue">{m.quant}</Badge>}
                      {m.mmproj && <Badge tone="violet">vision</Badge>}
                      {m.mtp && <Badge tone="violet">MTP</Badge>}
                      <span title="Rough estimate: weights + KV cache at the current context"><Badge tone={fit.tone}>{fit.label}</Badge></span>
                    </div>
                    <div className="ll-act" onClick={(e) => e.stopPropagation()}>
                      {isLoaded ? <Badge tone="green" dot>{s.state === 'running' ? 'loaded' : 'loading'}</Badge> : (
                        <button className="btn btn-sm" disabled={!!pending} onClick={() => { setSelId(m.id); onStart(m, { ...st, vision: !!m.mmproj && st.vision !== false }, live); }}>
                          <Icon name={live ? 'rotate' : 'play'} size={14} />{live ? 'Switch' : 'Load'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {list.length === 0 && <EmptyState title="Nothing matches" hint="Clear the filter." />}
            </Card>

            <div className="llama-side">
              <Card className="llama-launch">
                <CardHead title="Launch" sub={sel ? sel.name : 'Pick a model'} right={<Badge tone={est.tone}>{est.label}</Badge>} />
                {sel && (
                  <>
                    <div className="ll-budget">
                      <ContextMeter label="VRAM estimate" sub="Rough: weights, KV cache and CUDA buffers" total={vramMiB} fmt={(v) => fmtMiB(v)} ticks={40} parts={[
                        { label: 'Weights', value: est.weightsMiB, color: 'var(--signal)' },
                        ...(est.projMiB ? [{ label: 'Projector', value: est.projMiB, color: 'var(--peri)' }] : []),
                        { label: 'KV cache', value: est.kvUsedMiB, color: 'var(--green)', hint: `${st.ctx || 32768} tokens, ${st.cacheK || 'f16'} / ${st.cacheV || 'f16'}` },
                        { label: 'Buffers', value: 500, color: 'var(--muted)', hint: 'Compute buffers and CUDA context' },
                      ]} />
                      {est.tone === 'red' && <p className="muted small">If loading fails, lower the context or use a q8_0 KV cache.</p>}
                    </div>
                    <div className="form-grid ll-basic">
                      <Field label="Context (tokens)" title="0 = the model's trained maximum"><input className="input" type="number" min={0} step={1024} value={st.ctx ?? ''} onChange={(e) => setSt({ ...st, ctx: numOr(e.target.value) })} /></Field>
                      <Field label="GPU layers" title="-ngl; 99 = everything on the GPU"><input className="input" type="number" min={0} max={999} value={st.ngl ?? ''} onChange={(e) => setSt({ ...st, ngl: numOr(e.target.value) })} /></Field>
                      <Field label="Parallel slots" title="-np; the context is split between slots"><input className="input" type="number" min={1} max={64} value={st.parallel ?? ''} onChange={(e) => setSt({ ...st, parallel: numOr(e.target.value) })} /></Field>
                    </div>
                    <Toggle on={!!st.vision && !!sel.mmproj} disabled={!sel.mmproj} onChange={(v) => setSt({ ...st, vision: v })} label="Vision (image input)" hint={sel.mmproj ? 'Image projector found' : 'This model has no image projector'} />
                    <button type="button" className="ll-adv" onClick={() => setAdvanced(true)}>
                      <span className="stat-ic"><Icon name="sliders" size={16} /></span>
                      <span className="grow"><b>Advanced settings</b><small className="muted">{extras.length ? extras.join(' · ') : 'Flash attention, KV cache, threads, alias, extra args'}</small></span>
                      <Icon name="chevron" size={16} />
                    </button>
                    <div className="btn-row">
                      <button className="btn btn-primary" disabled={!!pending} onClick={() => onStart(sel, st, live)}>
                        {pending && pending !== 'stop' ? <Spinner size={14} /> : <Icon name={live ? 'rotate' : 'play'} size={16} />}
                        {sel.id === loadedId ? 'Restart with these settings' : live ? `Switch to ${short(sel.name)}` : `Start ${short(sel.name)}`}
                      </button>
                      <button className="btn btn-ghost" onClick={() => {
                        const name = window.prompt('Preset name', `${short(sel.name)} · ${st.ctx ? fmtCtx(st.ctx) : 'max'} ctx`);
                        if (name) savePresets([...presets, { id: Math.random().toString(36).slice(2, 12), name, modelId: sel.id, modelName: sel.name, settings: st }]);
                      }}><Icon name="save" size={16} />Save preset</button>
                    </div>
                  </>
                )}
              </Card>

              <Card className="llama-presets">
                <CardHead title="Presets" sub="Model + settings, one click to switch" />
                {presets.length === 0 ? <p className="muted small">Nothing saved yet. Use Save preset on the launch card.</p> : presets.map((p) => {
                  const m = d.models.find((x) => x.id === p.modelId);
                  return (
                    <div key={p.id} className="llama-preset">
                      <div className="grow ll-pname"><b>{p.name}</b><p className="muted small">{m ? m.name : 'model no longer on disk'} · ctx {p.settings.ctx ? fmtCtx(p.settings.ctx) : 'max'} · {p.settings.parallel ?? 1} slot(s)</p></div>
                      <button className="icon-btn sm" aria-label={`Edit preset ${p.name}`} title="Load into the launch card" onClick={() => { setSelId(p.modelId); setSt(clean(p.settings)); }}><Icon name="edit" size={15} /></button>
                      <button className="icon-btn sm" aria-label={`Delete preset ${p.name}`} title="Delete" onClick={() => savePresets(presets.filter((x) => x.id !== p.id))}><Icon name="trash" size={15} /></button>
                      <button className="btn btn-sm" disabled={!m || !!pending} onClick={() => m && onStart(m, p.settings, live)}><Icon name="play" size={14} />{live ? 'Switch' : 'Start'}</button>
                    </div>
                  );
                })}
              </Card>
            </div>

            {advanced && sel && (
              <Sheet eyebrow={sel.name} title="Advanced settings" sub="Applied the next time you start or switch a model." onClose={() => setAdvanced(false)}
                footer={<>
                  <button className="btn btn-ghost" onClick={() => setSt({ ...DEFAULTS, ctx: st.ctx, ngl: st.ngl, parallel: st.parallel, vision: st.vision })}>Reset to defaults</button>
                  <button className="btn btn-primary" onClick={() => setAdvanced(false)}>Done</button>
                </>}
                sections={[
                  { id: 'runtime', title: 'Runtime', icon: 'cpu', body: (
                    <div className="form-grid">
                      <Field label="Flash attention">
                        <select className="input" value={st.flashAttn ?? 'auto'} onChange={(e) => setSt({ ...st, flashAttn: e.target.value as LlamaSettings['flashAttn'] })}>
                          <option value="auto">auto</option><option value="on">on</option><option value="off">off</option>
                        </select>
                      </Field>
                      <Field label="CPU threads" title="-t; blank = auto"><input className="input" type="number" min={1} max={256} value={st.threads ?? ''} placeholder="auto" onChange={(e) => setSt({ ...st, threads: numOr(e.target.value) })} /></Field>
                      <Field label="KV cache K"><select className="input" value={st.cacheK ?? ''} onChange={(e) => setSt({ ...st, cacheK: e.target.value || undefined })}>{CACHE.map((c) => <option key={c} value={c}>{c || 'default (f16)'}</option>)}</select></Field>
                      <Field label="KV cache V"><select className="input" value={st.cacheV ?? ''} onChange={(e) => setSt({ ...st, cacheV: e.target.value || undefined })}>{CACHE.map((c) => <option key={c} value={c}>{c || 'default (f16)'}</option>)}</select></Field>
                    </div>
                  ) },
                  { id: 'api', title: 'API', icon: 'code', body: (
                    <div className="form-grid">
                      <Field label="API alias" title="The model id clients see in /v1/models" span><input className="input" value={st.alias ?? ''} placeholder={sel.name.toLowerCase().slice(0, 40)} onChange={(e) => setSt({ ...st, alias: e.target.value || undefined })} /></Field>
                      <Field label="Extra arguments" span><input className="input mono" value={(st.extra ?? []).join(' ')} placeholder="e.g. --temp 0.6 --top-k 20 --reasoning-budget 0" onChange={(e) => setSt({ ...st, extra: e.target.value.split(/\s+/).filter(Boolean) })} /></Field>
                    </div>
                  ) },
                  { id: 'behaviour', title: 'Behaviour', icon: 'settings', body: (
                    <div className="ll-toggles">
                      <Toggle on={st.jinja !== false} onChange={(v) => setSt({ ...st, jinja: v })} label="Chat template" hint="Needed for tool calling" />
                      <Toggle on={!!st.noMmap} onChange={(v) => setSt({ ...st, noMmap: v })} label="Load into RAM first" hint="Disables memory mapping" />
                      <Toggle on={s.agent.autostart} onChange={async (v) => { try { await api.llamaAutostart(v); toast.success(v ? 'Starts with Windows (last launch)' : 'Autostart off'); } catch (e) { toast.error((e as Error).message); } }} label="Start with the VM" hint="Relaunches the last model. Saved right away." />
                    </div>
                  ) },
                ]} />
            )}
          </div>
        );
      }}
    </Async>
  );
}

// ---------- playground ----------
function Playground({ s, onDocs }: { s: LlamaStatus; onDocs: () => void }) {
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; content: string; meta?: string }[]>([]);
  const [text, setText] = useState('');
  const [system, setSystem] = useState('');
  const [maxTokens, setMaxTokens] = useState(512);
  const [temp, setTemp] = useState(0.7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opts, setOpts] = useState(false);
  const ready = s.state === 'running';
  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    const next = [...msgs, { role: 'user' as const, content: t }];
    setMsgs(next); setText(''); setBusy(true); setErr(null);
    try {
      const r = await api.llamaChat({ messages: next.map(({ role, content }) => ({ role, content })), system: system || undefined, maxTokens, temperature: temp });
      const tm = r.timings;
      const meta = [tm.genPerSec != null ? `${fmtRate(tm.genPerSec)} tok/s gen` : null, tm.promptPerSec != null ? `${fmtRate(tm.promptPerSec)} tok/s prompt` : null, tm.genN != null ? `${tm.genN} tokens` : null, `${(r.wallMs / 1000).toFixed(1)} s`, tm.draftN ? `draft ${tm.draftAccepted}/${tm.draftN} accepted` : null, r.finish === 'length' ? 'cut at max tokens' : null].filter(Boolean).join(' · ');
      setMsgs([...next, { role: 'assistant', content: r.content || (r.reasoning ? `(reasoning only)\n${r.reasoning}` : '(empty reply)'), meta }]);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card className="llama-chat">
      <div className="llama-chat-head">
        <div className="grow">
          <h3>Playground</h3>
          <p className="muted small">{ready ? `Chatting with ${s.server.models[0] ?? 'the loaded model'}` : 'Start the server to chat.'}</p>
        </div>
        <div className="ll-optline" aria-label="Request options">
          <span>{maxTokens} max tokens</span><span>temp {temp.toFixed(2)}</span>{system && <span>system prompt</span>}
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpts(true)}><Icon name="sliders" size={15} />Options</button>
        {msgs.length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setMsgs([])}><Icon name="trash" size={15} />Clear</button>}
      </div>
      <div className="llama-msgs">
        {msgs.length === 0 && <EmptyState icon="chat" title="Send a test prompt" hint="See the reply and real tokens per second." />}
        {msgs.map((m, i) => (
          <div key={i} className={`llama-msg ${m.role}`}>
            <span className="muted small">{m.role === 'user' ? 'You' : 'Model'}</span>
            <div className="llama-bubble">{m.content}</div>
            {m.meta && <span className="muted small mono">{m.meta}</span>}
          </div>
        ))}
        {busy && <div className="llama-msg assistant"><span className="muted small">Model</span><div className="llama-bubble"><Spinner size={14} /> thinking…</div></div>}
      </div>
      {err && <div className="callout err"><Icon name="alert" size={16} /><span>{err}</span></div>}
      <div className="llama-compose">
        <textarea className="input" rows={2} value={text} disabled={!ready} placeholder={ready ? 'Ask something… (Ctrl+Enter to send)' : 'Server not running'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={!ready || busy || !text.trim()} onClick={send}>{busy ? <Spinner size={14} /> : <Icon name="send" size={16} />}Send</button>
      </div>
      {opts && (
        <Sheet eyebrow="Playground" title="Request options" sub="Sent with every message in this chat. Replies arrive in one piece, not streamed." onClose={() => setOpts(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setSystem(''); setMaxTokens(512); setTemp(0.7); }}>Reset</button>
            <button className="btn btn-primary" onClick={() => setOpts(false)}>Done</button>
          </>}>
          <div className="form-grid llama-opts">
            <Field label="System prompt" span><textarea className="input" rows={5} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="Optional" /></Field>
            <Field label={`Max tokens: ${maxTokens}`} span><input type="range" min={16} max={4096} step={16} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} /></Field>
            <Field label={`Temperature: ${temp.toFixed(2)}`} span><input type="range" min={0} max={2} step={0.05} value={temp} onChange={(e) => setTemp(Number(e.target.value))} /></Field>
          </div>
          <button className="ll-adv" onClick={() => { setOpts(false); onDocs(); }}>
            <span className="stat-ic"><Icon name="book" size={16} /></span>
            <span className="grow"><b>Use this model from your own apps</b><small className="muted">Base URL, endpoints and code examples</small></span>
            <Icon name="chevron" size={16} />
          </button>
        </Sheet>
      )}
    </Card>
  );
}

// ---------- log ----------
function Log({ s }: { s: LlamaStatus }) {
  const [prev, setPrev] = useState(false);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const q = useQuery(() => (s.agent.reachable ? api.llamaLog(500, prev) : Promise.reject(new Error('The log is read through the control agent.'))), [prev, s.agent.reachable], live ? 4000 : 0);
  const isProblem = (l: string) => /error|fail|warn|out of memory|cuda.*err|abort/i.test(l);
  const isKey = (l: string) => /offloaded|CUDA0|model loaded|listening|n_ctx|load_tensors|slot.*(release|launch)|eval time|prompt eval/i.test(l);
  return (
    <Card className="table" pad={false}>
      <div className="log-tools">
        <Chips value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All lines', count: q.data?.lines.length }, { id: 'problems', label: 'Problems', count: q.data?.lines.filter(isProblem).length }]} />
        <div className="chipline">
          <Toggle on={prev} onChange={setPrev} label="Previous run" />
          <Toggle on={live} onChange={setLive} label="Live" />
          {q.data?.lines.length ? <CopyButton text={q.data.lines.join('\n')} /> : null}
        </div>
      </div>
      <Async q={q} rows={8} h={22} isEmpty={(d) => d.lines.length === 0} empty={{ title: 'Log is empty', hint: prev ? 'No log from the previous run.' : 'Start the server to see its output.' }}>
        {(d) => {
          const rows = d.lines.filter((l) => filter === 'all' || isProblem(l));
          return (
            <div className="log-list llama-log">
              {rows.map((l, i) => <div key={i} className={`llama-line ${isProblem(l) ? 'err' : isKey(l) ? 'key' : ''}`}>{l}</div>)}
              {rows.length === 0 && <EmptyState icon="check" title="No problems found" hint="No error or warning lines in this log." />}
            </div>
          );
        }}
      </Async>
    </Card>
  );
}

// ---------- small pieces ----------
function Res({ label, pct, text }: { label: ReactNode; pct: number; text: string }) {
  return <div className="res-row"><div className="res-top"><span>{label}</span><b>{text}</b></div><Meter value={pct} /></div>;
}

function Field({ label, children, span, title }: { label: string; children: ReactNode; span?: boolean; title?: string }) {
  return <label className={span ? 'span-2' : ''} title={title}>{label}{children}</label>;
}

function Toggle({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className={`llama-toggle ${disabled ? 'off' : ''}`}>
      <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}><i /></button>
      <div><b>{label}</b>{hint && <p className="muted small">{hint}</p>}</div>
    </div>
  );
}

// ---------- maths / formatting ----------
function rateSeries(h: LlamaPoint[]) {
  const out: { ts: number; gen: number; prompt: number }[] = [];
  for (let i = 1; i < h.length; i++) {
    const a = h[i - 1], b = h[i];
    if (a.genTotal == null || b.genTotal == null) continue;
    const dt = (b.ts - a.ts) / 1000;
    const d = b.genTotal - a.genTotal;
    const dp = a.promptTotal != null && b.promptTotal != null ? b.promptTotal - a.promptTotal : 0;
    out.push({ ts: b.ts, gen: dt > 0 && d >= 0 ? d / dt : 0, prompt: dt > 0 && dp >= 0 ? dp / dt : 0 });
  }
  return out;
}

/** Rough VRAM need: weights (+ projector) + f16 KV cache sized from the model size. Good enough for a fits / tight / too big hint. */
function estimate(m: LlamaModel | undefined, st: LlamaSettings, vramMiB: number) {
  if (!m) return { tone: 'gray' as Tone, label: '-', kvMiB: 0, totalMiB: 0, weightsMiB: 0, projMiB: 0, kvUsedMiB: 0 };
  const proj = st.vision && m.mmproj ? (m.mmprojSize ?? 0) / MIB : 0;
  const weights = (m.size ?? 0) / MIB + proj;
  const params = parseFloat(m.params ?? '') || Math.max(1, (m.size ?? 0) / 1e9 / 0.6);
  const ctx = st.ctx || 32768;
  // ~0.08 MiB per token per 10B params at f16 for GQA models; halves for q8_0, quarter for q4.
  const kvFactor = (t?: string) => (t?.startsWith('q4') || t === 'iq4_nl' ? 0.28 : t?.startsWith('q5') ? 0.34 : t === 'q8_0' ? 0.53 : 1);
  const kv = ctx * 0.08 * (params / 10) * ((kvFactor(st.cacheK) + kvFactor(st.cacheV)) / 2);
  const offload = st.ngl === undefined || st.ngl >= 99 ? 1 : Math.min(1, st.ngl / 64);
  const total = (weights + kv) * offload + 500; // compute buffers + CUDA context
  const r = total / vramMiB;
  return { tone: (r < 0.85 ? 'green' : r <= 1 ? 'amber' : 'red') as Tone, label: r < 0.85 ? 'fits' : r <= 1 ? 'tight' : 'may not fit', kvMiB: kv, totalMiB: total,
    weightsMiB: (weights - proj) * offload, projMiB: proj * offload, kvUsedMiB: kv * offload };
}

/** Non-default advanced settings, so the launch card shows what the dialog changed. */
function advancedSummary(st: LlamaSettings): string[] {
  return [
    st.flashAttn && st.flashAttn !== 'auto' ? `flash ${st.flashAttn}` : null,
    st.cacheK || st.cacheV ? `KV ${st.cacheK || 'f16'}/${st.cacheV || 'f16'}` : null,
    st.threads ? `${st.threads} threads` : null,
    st.alias ? `alias ${st.alias}` : null,
    st.extra?.length ? `${st.extra.length} extra arg${st.extra.length === 1 ? '' : 's'}` : null,
    st.jinja === false ? 'no chat template' : null,
    st.noMmap ? 'no mmap' : null,
  ].filter(Boolean) as string[];
}

function modelName(s: LlamaStatus): string | null {
  return s.server.props?.modelAlias || s.launch?.modelName || (s.server.props?.modelPath ? baseName(s.server.props.modelPath) : null);
}
function clean(s: LlamaSettings): LlamaSettings {
  const o = { ...s } as Record<string, unknown>;
  delete o.restart; delete o.modelId;
  return o as LlamaSettings;
}
const numOr = (v: string) => (v === '' ? undefined : Number(v));
const fmtMiB = (m: number | null | undefined, unit = true) => (m == null ? '?' : `${(m / 1024).toFixed(m >= 10240 ? 1 : 2)}${unit ? ' GB' : ''}`);
const fmtTok = (n: number) => `${fmtK(Math.round(n))} tok`;
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
/** Context sizes are powers of two: 32768 -> 32k. */
const fmtCtx = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));
const fmtRate = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const baseName = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '');
const short = (n: string) => (n.length > 28 ? `${n.slice(0, 26)}…` : n);
