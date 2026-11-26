import { api } from '../api';
import { BrandSwirl } from '../components/Brand';
import { InView, Reveal, RevealWords } from '../components/Reveal';
import { AreaCard } from '../components/AreaCard';
import { Async, Badge, Card, CardHead, ErrorState, Icon, Meter, PageHeader, Skeleton } from '../components/ui';
import type { IconName, Tone } from '../components/ui';
import { fmtBytes, fmtPct, fmtUptime, timeAgo } from '../format';
import { useCountUp, useQuery } from '../hooks';
import type { MonitoringSnapshot, Overview as Ov } from '../types';

function Tile({ icon, label, value, sub, tone, href, na }: { icon: IconName; label: string; value: number; sub: string; tone: Tone; href: string; na?: boolean }) {
  const n = Math.round(useCountUp(value));
  return (
    <a className={`tile ic-${tone}`} href={href}>
      <div className="tile-top"><span className="tile-label">{label}</span><span className="tile-ic"><Icon name={icon} size={20} /></span></div>
      <div>
        <p className="tile-value">{na ? '—' : n}</p>
        <p className="tile-sub">{na ? 'Not connected' : sub}</p>
      </div>
    </a>
  );
}

/** One calm 0–100 number fusing host pressure and monitor state. 100 = everything nominal. */
function healthScore(o: Ov, incidents: { status: string }[]): number {
  let s = 100;
  for (const i of incidents) s -= i.status === 'down' ? 16 : i.status === 'pending' ? 4 : 0;
  const mem = o.host.memTotal ? o.host.memUsed / o.host.memTotal : 0;
  const disk = o.host.diskTotal ? o.host.diskUsed / o.host.diskTotal : 0;
  s -= o.host.cpu > 0.9 ? 20 : o.host.cpu > 0.75 ? 10 : 0;
  s -= mem > 0.92 ? 15 : mem > 0.8 ? 8 : 0;
  s -= disk > 0.9 ? 15 : disk > 0.8 ? 8 : 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}
const healthTone = (s: number): Tone => (s >= 90 ? 'green' : s >= 75 ? 'blue' : s >= 50 ? 'amber' : 'red');
const healthWord = (s: number) => (s >= 95 ? 'All systems nominal' : s >= 90 ? 'Healthy' : s >= 75 ? 'Minor attention' : s >= 50 ? 'Degraded' : 'Needs attention');

function HealthRing({ score }: { score: number }) {
  const v = useCountUp(score, 900);
  const tone = healthTone(score);
  const R = 52, C = 2 * Math.PI * R;
  const off = C * (1 - Math.max(0, Math.min(100, v)) / 100);
  return (
    <div className="health-ring" role="img" aria-label={`System health ${score} out of 100`}>
      <svg viewBox="0 0 128 128" width="128" height="128">
        <circle className="hr-track" cx="64" cy="64" r={R} fill="none" strokeWidth="9" />
        <circle className={`hr-arc m-${tone}`} cx="64" cy="64" r={R} fill="none" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 64 64)" />
      </svg>
      <div className="hr-center"><b>{Math.round(v)}</b><small>/ 100</small></div>
    </div>
  );
}

interface Attn { key: string; tone: 'red' | 'amber'; label: string; value: string; text: string; href: string }

/** Everything that needs attention, from the host and from every connected monitoring source. */
function attention(o: Ov, mon?: MonitoringSnapshot | null, monFailed = false): Attn[] {
  const out: Attn[] = [];
  const m = o.host.memUsed / o.host.memTotal, d = o.host.diskUsed / o.host.diskTotal;
  if (o.host.cpu > 0.75) out.push({ key: 'cpu', tone: 'red', label: 'CPU', value: fmtPct(o.host.cpu), text: 'High CPU on the Proxmox host', href: '#/grafana' });
  if (m > 0.8) out.push({ key: 'mem', tone: 'red', label: 'Memory', value: fmtPct(m), text: 'Memory pressure on the Proxmox host', href: '#/grafana' });
  if (d > 0.8) out.push({ key: 'disk', tone: 'red', label: 'Disk', value: fmtPct(d), text: 'Disk usage warning on the Proxmox host', href: '#/grafana' });
  const label = (id: string) => mon?.sources.find((s) => s.id === id)?.label ?? id;
  for (const c of mon?.checks ?? []) {
    if (c.status !== 'down' && c.status !== 'pending') continue;
    out.push({ key: `c${c.source}|${c.key}`, tone: c.status === 'down' ? 'red' : 'amber', label: c.source === 'kuma' ? 'Monitor' : label(c.source), value: c.status, text: `${c.name} is ${c.status}`, href: c.source === 'kuma' ? '#/kuma' : '#/setup' });
  }
  for (const a of mon?.alerts ?? []) {
    if (a.state !== 'firing') continue;
    out.push({ key: `a${a.source}|${a.key}`, tone: a.level === 'error' ? 'red' : 'amber', label: label(a.source), value: 'firing', text: `${a.name}${a.summary ? `: ${a.summary}` : ''}`, href: a.url ?? '#/setup' });
  }
  // A source that stops answering is a finding of its own, never an empty "all clear". Its last known problems stay listed above.
  for (const s of mon?.sources ?? []) {
    if (!s.ok) out.push({ key: `s${s.id}`, tone: 'amber', label: s.label, value: 'unreachable', text: `Can't read ${s.label}: ${(s.error ?? 'no answer').slice(0, 120)}`, href: '#/setup' });
  }
  if (monFailed) out.push({ key: 'monfail', tone: 'amber', label: 'Monitoring', value: 'unavailable', text: "Can't read monitoring status from the server", href: '#/setup' });
  return out;
}

export default function Overview() {
  const ov = useQuery(api.overview, [], 8000);
  const inc = useQuery(api.incidents, [], 10000);
  const mon = useQuery(api.monitoring, [], 10000);
  const pct = (v: number) => `${v.toFixed(0)}%`;

  // Every source is optional: one that is not set up, or fails, must not blank the list.
  const items = ov.data ? attention(ov.data, mon.data, !!mon.error && !mon.data) : null;
  const notUp = (mon.data?.checks ?? []).filter((c) => c.status !== 'up');
  // Zeros from an integration that was never set up look like real, healthy data; say "not connected" instead.
  const cf = ov.data?.configured;
  const noPve = !!cf && !cf.proxmox, noKuma = !!cf && !cf.kuma, noMetrics = !!cf && !cf.metrics;
  const nothingConnected = noPve && noKuma && noMetrics;

  return (
    <>
      <Hero items={items} ov={ov.data} noPve={noPve} nothingConnected={nothingConnected} />

      <Card className="health-card">
        {noPve && ov.data && items ? (
          <div className="health-row">
            <div className="health-main">
              <div className="health-text">
                <p className="eyebrow">System health</p>
                <h3 className={`attn-title ${items.length || nothingConnected ? '' : 'ok'}`}>{nothingConnected ? 'Nothing connected yet' : items.length ? `${items.length} ${items.length === 1 ? 'item needs' : 'items need'} attention` : 'Nothing needs attention'}</h3>
                <p className="muted small">{nothingConnected ? 'Connect Proxmox to see guests, host health and alerts here.' : 'Proxmox is not connected, so host health is not shown.'}</p>
              </div>
            </div>
            {items.length > 0 ? (
              <div className="attn-grid">
                {items.map((a) => (
                  <a key={a.key} href={a.href} className={`attn ${a.tone}`}>
                    <span className="attn-top"><span>{a.label}</span><b>{a.value}</b></span>
                    <span>{a.text}</span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="health-ok"><Icon name="info" size={18} /><span><a className="link" href="#/setup">Open Setup</a> to connect {nothingConnected ? 'Proxmox, Grafana, Uptime Kuma and alerts' : 'Proxmox'}.</span></div>
            )}
          </div>
        ) : items === null || !ov.data ? (
          ov.error || inc.error
            ? <ErrorState error={(ov.error ?? inc.error) as Error} onRetry={() => { ov.reload(); inc.reload(); }} />
            : <Skeleton rows={2} h={88} />
        ) : (
          <div className="health-row">
            <div className="health-main">
              <HealthRing score={healthScore(ov.data, notUp)} />
              <div className="health-text">
                <p className="eyebrow">System health</p>
                <h3 className={`attn-title ${items.length ? '' : 'ok'}`}>{healthWord(healthScore(ov.data, notUp))}</h3>
                <p className="muted small">{items.length ? `${items.length} ${items.length === 1 ? 'item needs' : 'items need'} attention` : 'Everything is running normally.'}</p>
              </div>
            </div>
            {items.length > 0 ? (
              <div className="attn-grid">
                {items.map((a) => (
                  <a key={a.key} href={a.href} className={`attn ${a.tone}`}>
                    <span className="attn-top"><span>{a.label}</span><b>{a.value}</b></span>
                    <span>{a.text}</span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="health-ok"><Icon name="check" size={18} /><span>No incidents, no resource pressure, every monitor up.</span></div>
            )}
          </div>
        )}
      </Card>

      <div className="grid-3">
        <AreaCard icon="cpu" title="CPU Usage" notConnected={noMetrics} sub="Processor utilization over time" color="var(--blue)" format={pct}
          query={'100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100'} />
        <AreaCard icon="pulse" title="Memory Usage" notConnected={noMetrics} sub="RAM consumption trends" color="var(--green)" format={pct}
          query={'(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100'} />
        <AreaCard icon="network" title="Network Traffic" notConnected={noMetrics} sub="Network bandwidth utilization" color="var(--peri)" format={(v) => `${(v / 1e6).toFixed(0)} MB/s`}
          query={'rate(node_network_receive_bytes_total{device="vmbr0"}[5m])'} />
      </div>

      <Async q={ov} rows={1} h={110}>
        {(o) => (
          <>
            <div className="tiles">
              <Tile href="#/guests" icon="server" tone="gray" label="Guests" value={o.guests.total} sub={`${o.guests.running} running · ${o.guests.stopped} stopped`} na={noPve} />
              <Tile href="#/guests" icon="power" tone="green" label="Running" value={o.guests.running} sub={`${o.guests.stopped} stopped`} na={noPve} />
              <Tile href="#/nginx" icon="globe" tone="blue" label="Nginx sites" value={o.nginx.sites} sub="sites-enabled" />
              <Tile href="#/kuma" icon="pulse" tone="green" label="Monitors up" value={o.kuma.up} sub={`${o.kuma.pending} pending`} na={noKuma} />
              <Tile href="#/kuma" icon="alert" tone={o.kuma.down ? 'red' : 'gray'} label="Monitors down" value={o.kuma.down} sub={o.kuma.down ? 'Needs attention' : 'All clear'} na={noKuma} />
            </div>
            <div className="grid-3">
              <Card>
                <CardHead title="Host resources" sub={noPve ? 'Proxmox host' : `Uptime ${fmtUptime(o.host.uptime)}`} />
                {noPve ? <p className="muted small" style={{ padding: '24px 0' }}>Not connected. <a className="link" href="#/setup">Connect Proxmox in Setup</a></p> : <div className="res">
                  <Res icon="cpu" label="CPU" pct={o.host.cpu} text={fmtPct(o.host.cpu)} />
                  <Res icon="memory" label="Memory" pct={o.host.memUsed / o.host.memTotal} text={`${fmtBytes(o.host.memUsed)} / ${fmtBytes(o.host.memTotal, 0)}`} />
                  <Res icon="disk" label="Disk" pct={o.host.diskUsed / o.host.diskTotal} text={`${fmtBytes(o.host.diskUsed, 0)} / ${fmtBytes(o.host.diskTotal, 0)}`} />
                </div>}
              </Card>
              <Card className="span-2">
                <CardHead title="Recent incidents" sub="From Uptime Kuma" right={<a className="link" href="#/kuma">All monitors</a>} />
                <Async q={inc} rows={3} h={56} isEmpty={(d) => d.length === 0} empty={{ title: 'No incidents', hint: 'Every monitor is healthy.' }}>
                  {(list) => (
                    <ul className="incidents">
                      {list.map((i) => (
                        <li key={i.monitorId}>
                          <span className={`inc-dot d-${i.status}`} />
                          <div className="grow">
                            <strong>{i.name}</strong>
                            <p className="muted small">{i.message}</p>
                          </div>
                          <Badge tone={i.status === 'down' ? 'red' : i.status === 'pending' ? 'amber' : 'blue'}>{i.status}</Badge>
                          <span className="muted small nowrap">{timeAgo(i.since)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Async>
              </Card>
            </div>
          </>
        )}
      </Async>
    </>
  );
}

function Res({ icon, label, pct, text }: { icon: IconName; label: string; pct: number; text: string }) {
  return (
    <div className="res-row">
      <div className="res-top"><span><Icon name={icon} size={15} />{label}</span><b>{text}</b></div>
      <Meter value={pct} />
    </div>
  );
}

function Hero({ items, ov, noPve, nothingConnected }: { items: Attn[] | null; ov?: Ov; noPve?: boolean; nothingConnected?: boolean }) {
  const bad = !!items?.length;
  return (
    <InView>
      <section className="hero">
        <BrandSwirl />
        <div className="hero-meta">
          <span>homedash</span>
          <span>{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        </div>
        <h1><RevealWords text="Everything, at a glance." /></h1>
        <Reveal stagger={5} className="hero-sub">
          <i className={`hero-dot ${bad ? 'bad' : ''}`} />
          <span>{nothingConnected ? 'Nothing connected yet' : items === null ? 'Checking systems…' : bad ? `${items.length} ${items.length === 1 ? 'item needs' : 'items need'} attention` : noPve ? 'Proxmox not connected' : 'All systems healthy'}</span>
          {ov && !noPve && <><span className="sep" /><span>{ov.guests.running} of {ov.guests.total} guests running</span></>}
        </Reveal>
      </section>
    </InView>
  );
}
