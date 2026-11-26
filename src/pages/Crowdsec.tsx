import { useState } from 'react';
import { api } from '../api';
import { BarChart } from '../components/Charts';
import type { Pt, Series } from '../components/Charts';
import { Async, Badge, Card, CardHead, Chips, DocRow, EmptyState, Icon, Meter, PageHeader, Stat } from '../components/ui';
import type { Tone } from '../components/ui';
import { fmtUptime, timeAgo } from '../format';
import { useQuery, useSearch } from '../hooks';
import type { CsAlert, CsBan, CsOverview } from '../types';
import { PromCard } from '../components/PromCard';

type Tab = 'overview' | 'bans' | 'detections' | 'engines';
const TABS: Tab[] = ['overview', 'bans', 'detections', 'engines'];

// ---------- helpers ----------
const SCENARIO: Record<string, string> = {
  'crowdsecurity/ssh-bf': 'SSH brute force', 'crowdsecurity/ssh-slow-bf': 'SSH slow brute force', 'crowdsecurity/ssh-time-based-bf': 'SSH time-based brute force',
  'crowdsecurity/ssh-time-based-bf_user-enum': 'SSH user enumeration', 'crowdsecurity/ssh-cve-2024-6387': 'SSH exploit (regreSSHion)',
  'crowdsecurity/http-probing': 'Web probing', 'crowdsecurity/http-bad-user-agent': 'Bad user agent', 'crowdsecurity/http-open-proxy': 'Open proxy scan',
  'crowdsecurity/http-sensitive-files': 'Sensitive file probe', 'crowdsecurity/http-crawl-non_statics': 'Aggressive crawling', 'crowdsecurity/http-path-traversal-probing': 'Path traversal',
  'crowdsecurity/http-backdoors-attempts': 'Backdoor attempt', 'crowdsecurity/http-generic-bf': 'Web login brute force',
  'ssh:bruteforce': 'SSH brute force', 'http:scan': 'Web scanners', 'generic:scan': 'Port scanners', 'smtp:spam': 'Mail spam', 'ssh:exploit': 'SSH exploits',
};
const nice = (s: string) => SCENARIO[s] ?? s.replace(/^crowdsecurity\//, '').replace(/[-_:]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const flag = (cc: string | null) => (cc && /^[A-Za-z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const where = (cc: string | null) => (cc ? `${flag(cc)} ${cc.toUpperCase()}` : 'Unknown');
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString());
const ageTone = (a: number | null): Tone => (a == null ? 'gray' : a < 120 ? 'green' : a < 600 ? 'amber' : 'red');
const ageText = (a: number | null) => (a == null ? 'never' : a < 5 ? 'just now' : `${fmtUptime(a)} ago`);

function problemsOf(c: CsOverview): string[] {
  const out: string[] = [];
  if (!c.snapshot) out.push('The CrowdSec snapshot is missing: the crowdsec-snapshot timer on the host is not producing data');
  else if ((c.snapshot.ageSec ?? 0) > 180) out.push(`CrowdSec data is ${fmtUptime(c.snapshot.ageSec ?? 0)} old`);
  c.engines.filter((e) => !e.ok).forEach((e) => out.push(`${e.name}: ${e.detail}`));
  c.bouncers.filter((b) => !b.revoked && (b.ageSec ?? 0) > 180).forEach((b) => out.push(`Bouncer ${b.name} has not pulled for ${fmtUptime(b.ageSec ?? 0)}`));
  return out;
}

// ---------- page ----------
export default function Crowdsec({ tab: initial }: { tab?: string }) {
  const [tab, setTab] = useState<Tab>((TABS as string[]).includes(initial ?? '') ? (initial as Tab) : 'overview');
  const q = useQuery(api.crowdsec, [], 10_000);
  const bad = q.data?.configured ? problemsOf(q.data).length : 0;
  return (
    <>
      <PageHeader eyebrow="Network / Security" title="CrowdSec" sub="Spots attackers in your logs and blocks them at the firewall and on the Proxmox host." />
      {q.data && !q.data.configured ? <EmptyState icon="lock" title="CrowdSec is not set up" hint="Switch it on in homedash.yaml (crowdsec.snapshot plus addons.crowdsec), run homedash-config apply --restart, and this page fills in." /> : <>
      <Chips value={tab} onChange={(t) => { setTab(t); history.replaceState(null, '', `#/crowdsec/${t}`); }} options={[
        { id: 'overview', label: 'Overview', count: bad || undefined }, { id: 'bans', label: 'Blocked', count: q.data?.decisions.localCount }, { id: 'detections', label: 'Detections' }, { id: 'engines', label: 'Engines' },
      ]} />
      {tab === 'overview' && <Overview q={q} />}
      {tab === 'bans' && <Bans q={q} />}
      {tab === 'detections' && <Detections q={q} />}
      {tab === 'engines' && <Engines q={q} />}
      </>}
    </>
  );
}

type Q = ReturnType<typeof useQuery<CsOverview>>;

// ---------- overview ----------
function Overview({ q }: { q: Q }) {
  const [span, setSpan] = useState<'24h' | '7d'>('24h');
  return (
    <Async q={q} rows={3} h={170}>
      {(c) => {
        const issues = problemsOf(c);
        const series: Series[] = [{ name: 'Detections', points: (span === '24h' ? c.alerts.hourly : c.alerts.daily).map((p) => [Date.parse(p.t) / 1000, p.n] as Pt) }];
        const healthy = c.engines.filter((e) => e.ok).length;
        const maxC = c.alerts.byCountry[0]?.count ?? 1, maxS = c.alerts.byScenario[0]?.count ?? 1;
        return (
          <>
            {issues.length ? (
              <div className="callout warn"><Icon name="alert" size={16} /><span><b>{issues.length === 1 ? '1 thing needs attention' : `${issues.length} things need attention`}:</b> {issues.join(' · ')}</span></div>
            ) : (
              <div className="callout ok"><Icon name="check" size={16} /><span><b>CrowdSec is protecting the lab.</b> All {c.engines.length} engines are reporting and every bouncer is pulling fresh decisions.</span></div>
            )}
            <div className="stats">
              <Stat icon="shield" label="Blocked right now" value={c.decisions.localCount} tone={c.decisions.localCount ? 'amber' : undefined} sub="addresses banned after attacking you" />
              <Stat icon="globe" label="Community blocklist" value={compact(c.decisions.communityTotal)} sub="known bad IPs blocked in advance" />
              <Stat icon="alert" label="Detections" value={c.alerts.last24h} sub={`${c.alerts.total7d} in the last 7 days`} tone={c.alerts.last24h ? 'amber' : undefined} />
              <Stat icon="server" label="Engines" value={`${healthy}/${c.engines.length}`} tone={healthy === c.engines.length ? 'green' : 'red'} sub="reporting normally" />
              <Stat icon="lock" label="Allowlisted" value={c.allowlists.reduce((n, l) => n + l.items.length, 0)} sub="addresses never banned" />
            </div>

            <Card>
              <CardHead title="Detections over time" sub="Attack attempts CrowdSec recognised in your logs" right={<Chips value={span} onChange={setSpan} options={[{ id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' }]} />} />
              {c.alerts.total7d === 0 ? <EmptyState icon="shield" title="No detections in the last 7 days" hint="Nothing has tried to brute-force SSH or probe your sites." /> : <BarChart series={series} unit="" height={170} mode="stack" />}
            </Card>

            <div className="grid-2">
              <Card>
                <CardHead title="Where attacks come from" sub="Detections by country, last 7 days" />
                {c.alerts.byCountry.length ? (
                  <div className="res">{c.alerts.byCountry.map((x, i) => (
                    <div key={x.country} className="res-row"><div className="res-top"><span>{where(x.country)}</span><b>{x.count}</b></div><Meter value={x.count / maxC} tone={i === 0 ? 'amber' : 'gray'} /></div>
                  ))}</div>
                ) : <EmptyState icon="globe" title="No data yet" />}
              </Card>
              <Card>
                <CardHead title="What they try" sub="Detections by attack type, last 7 days" />
                {c.alerts.byScenario.length ? (
                  <div className="res">{c.alerts.byScenario.map((x, i) => (
                    <div key={x.scenario} className="res-row"><div className="res-top"><span>{nice(x.scenario)}</span><b>{x.count}</b></div><Meter value={x.count / maxS} tone={i === 0 ? 'amber' : 'gray'} /></div>
                  ))}</div>
                ) : <EmptyState icon="shield" title="No data yet" />}
              </Card>
            </div>

            <Card>
              <CardHead title="Most persistent attackers" sub="Addresses that triggered the most detections" />
              {c.alerts.topSources.length === 0 ? <p className="muted small pad">No repeat offenders.</p> : (
                <div className="table flat">
                  <div className="dt-row dt-cs3 g-head"><span>Address</span><span>Country</span><span>Network</span><span>Detections</span></div>
                  {c.alerts.topSources.map((s) => (
                    <div key={s.ip} className="dt-row dt-cs3"><span><b>{s.ip}</b></span><span>{where(s.country)}</span><span className="muted">{s.asName ?? '-'}</span><span>{s.count}</span></div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHead title="How CrowdSec protects the lab" sub="Logs in, bans out. Each engine reads logs; one central list feeds every bouncer." />
              <div className="opn-flow cs-flow">
                <div className="opn-node"><p className="eyebrow">1 · Read logs</p><b>Two engines</b><small className="muted">Host: nginx and SSH · central engine: hub</small></div>
                <div className="opn-link"><span>attacks</span><i /></div>
                <div className="opn-node opn-core"><p className="eyebrow">2 · Decide</p><b>Central decision list</b><small className="muted">{c.decisions.localCount} local bans + {compact(c.decisions.communityTotal)} community addresses</small></div>
                <div className="opn-link"><span>bans</span><i /></div>
                <div className="opn-node"><p className="eyebrow">3 · Block</p><b>Host bouncer</b><small className="muted">Host iptables protects the Proxmox host</small></div>
              </div>
            </Card>
          </>
        );
      }}
    </Async>
  );
}

// ---------- blocked ----------
function Bans({ q }: { q: Q }) {
  const { q: s } = useSearch();
  return (
    <Async q={q} rows={3} h={120}>
      {(c) => {
        const needle = s.trim().toLowerCase();
        const rows: CsBan[] = c.decisions.local.filter((b) => !needle || `${b.ip} ${b.scenario} ${b.country ?? ''} ${b.asName ?? ''}`.toLowerCase().includes(needle));
        return (
          <>
            <Card>
              <CardHead title="Banned after attacking you" sub="Local bans: temporary, applied by both bouncers" />
              {rows.length === 0 ? <EmptyState icon="shield" title="No active local bans" hint="Bans appear here the moment CrowdSec catches a brute-force or probing attempt, and disappear when they expire." /> : (
                <div className="table flat">
                  <div className="dt-row dt-cs g-head"><span>Address</span><span>Country</span><span>Reason</span><span>Time left</span><span>Detected</span><span>Seen by</span></div>
                  {rows.map((b) => (
                    <div key={b.id} className="dt-row dt-cs">
                      <span><b>{b.ip}</b>{b.asName && <small className="muted block">{b.asName}</small>}</span>
                      <span>{where(b.country)}</span>
                      <span>{nice(b.scenario)}<small className="muted block">{b.events} events</small></span>
                      <span><Badge tone="red" dot>{b.remainingSec > 0 ? fmtUptime(b.remainingSec) : 'expiring'}</Badge></span>
                      <span className="muted">{timeAgo(b.createdAt)}</span>
                      <span className="muted">{b.machine.length > 20 ? 'central engine' : b.machine}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <CardHead title="Community blocklist" sub={`${c.decisions.communityTotal.toLocaleString()} known bad addresses, blocked before they reach you`} />
              {c.decisions.community.length === 0 ? <EmptyState icon="globe" title="No community list" hint="CrowdSec has not pulled the community blocklist yet." /> : (
                <div className="res">{c.decisions.community.map((x, i) => (
                  <div key={x.reason} className="res-row"><div className="res-top"><span>{nice(x.reason)}</span><b>{x.count.toLocaleString()} <small className="muted">{Math.round((x.count / c.decisions.communityTotal) * 100)}%</small></b></div><Meter value={x.count / c.decisions.community[0].count} tone={i === 0 ? 'blue' : 'gray'} /></div>
                ))}</div>
              )}
              <p className="muted small opn-note">The list is refreshed by CrowdSec every few hours. Blocks from it show up in the host's iptables counters.</p>
            </Card>
          </>
        );
      }}
    </Async>
  );
}

// ---------- detections ----------
function Detections({ q }: { q: Q }) {
  const { q: s } = useSearch();
  const [scenario, setScenario] = useState('all');
  const list = useQuery(() => api.crowdsecAlerts({ scenario: scenario === 'all' ? undefined : scenario, q: s.trim() || undefined, limit: 150 }), [scenario, s], 15_000);
  const scenarios = q.data?.alerts.byScenario ?? [];
  return (
    <>
      <div className="toolbar">
        <Chips value={scenario} onChange={setScenario} options={[{ id: 'all', label: 'All' }, ...scenarios.slice(0, 5).map((x) => ({ id: x.scenario, label: nice(x.scenario), count: x.count }))]} />
      </div>
      <Async q={list} rows={6} h={46} isEmpty={(d) => d.length === 0} empty={{ title: 'No detections', hint: 'Nothing matched this filter in the last 7 days.' }}>
        {(rows: CsAlert[]) => (
          <div className="card table">
            <div className="dt-row dt-cd g-head"><span>When</span><span>Source</span><span>Country</span><span>Attack</span><span>Events</span><span>Outcome</span></div>
            {rows.map((a) => (
              <div key={a.id} className="dt-row dt-cd">
                <span className="muted" title={new Date(a.createdAt).toLocaleString()}>{timeAgo(a.createdAt)}</span>
                <span><b>{a.ip}</b>{a.asName && <small className="muted block">{a.asName}</small>}</span>
                <span>{where(a.country)}</span>
                <span>{nice(a.scenario)}<small className="muted block">{'seen by ' + (a.machine.length > 20 ? 'the central engine' : a.machine)}</small></span>
                <span>{a.events}</span>
                <span>{a.decision ? (a.decision.remainingSec > 0 ? <Badge tone="red" dot>banned · {fmtUptime(a.decision.remainingSec)} left</Badge> : <Badge tone="gray">ban expired</Badge>) : <Badge tone="gray">no ban</Badge>}</span>
              </div>
            ))}
          </div>
        )}
      </Async>
      <p className="muted small">Detections are kept for 7 days here. Each one was reported by an engine to the central decision list.</p>
    </>
  );
}

// ---------- engines ----------
function Engines({ q }: { q: Q }) {
  return (
    <Async q={q} rows={3} h={160}>
      {(c) => (
        <>
          <div className="grid-3">
            {c.engines.map((e) => (
              <Card key={e.id}>
                <CardHead title={e.name} sub={e.role} right={<Badge tone={e.ok ? 'green' : 'red'} dot>{e.ok ? 'ok' : 'problem'}</Badge>} />
                <div className="opn-facts">
                  <p>{e.version ? `Version ${e.version}` : 'Version unknown'}</p>
                  <p className="muted">{e.detail}</p>
                  <p className="muted">{e.capiPullSec != null ? `Community list refreshed ${ageText(e.capiPullSec)}` : 'Does not pull the community list itself'}</p>
                </div>
              </Card>
            ))}
          </div>

          <div className="grid-2">
            <Card>
              <CardHead title="Bouncers" sub="They fetch the ban list and enforce it" />
              <div className="table flat">
                <div className="dt-row dt-cb g-head"><span>Bouncer</span><span>Where</span><span>Last pull</span></div>
                {c.bouncers.map((b) => (
                  <div key={b.name} className="dt-row dt-cb"><span><b>{b.name}</b><small className="muted block">{b.type}</small></span><span className="muted">{b.ip === '127.0.0.1' ? 'local to the engine' : b.ip}</span><span><Badge tone={b.revoked ? 'gray' : ageTone(b.ageSec)} dot>{b.revoked ? 'revoked' : ageText(b.ageSec)}</Badge></span></div>
                ))}
              </div>
            </Card>
            <Card>
              <CardHead title="Engines reporting to the central list" sub="Agents that send detections to the central list" />
              <div className="table flat">
                <div className="dt-row dt-cb g-head"><span>Engine</span><span>Address</span><span>Heartbeat</span></div>
                {c.machines.map((m) => (
                  <div key={m.name} className="dt-row dt-cb"><span><b>{m.name.length > 20 ? 'central engine' : m.name}</b><small className="muted block">{m.version.replace(/-.*/, '')}{m.features.length ? ` · ${m.features.join(', ')}` : ''}</small></span><span className="muted">{m.ip}</span><span><Badge tone={ageTone(m.ageSec)} dot>{ageText(m.ageSec)}</Badge></span></div>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid-2">
            <Card>
              <CardHead title="What the host engine reads" sub="Log sources on the Proxmox host (since CrowdSec last started)" />
              {c.acquisition.length === 0 ? <EmptyState icon="file" title="No log source data" hint="Prometheus has no CrowdSec metrics for the host yet." /> : (
                <div className="table flat">
                  <div className="dt-row dt-ca g-head"><span>Source</span><span>Lines read</span><span>Parsed</span><span>Ignored</span></div>
                  {c.acquisition.map((a) => (
                    <div key={a.source} className="dt-row dt-ca"><span><b>{a.source.startsWith('journalctl') ? a.source.replace('journalctl-_SYSTEMD_UNIT=', 'journal: ') : a.source.split('/').slice(-2).join('/')}</b></span><span>{a.read.toLocaleString()}</span><span>{a.ok.toLocaleString()}</span><span className="muted">{a.ko.toLocaleString()}</span></div>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <CardHead title="Allowlist and detection packs" sub="Who is never banned, and what CrowdSec knows how to spot" />
              <div className="doc-list opn-list">
                {c.allowlists.flatMap((l) => l.items.map((i) => <DocRow key={`${l.name}-${i.value}`} k={<span>{i.value}<small className="muted block">{l.name}</small></span>} v={i.description || l.description} mono={false} />))}
                {c.allowlists.every((l) => l.items.length === 0) && <p className="muted small pad">No addresses are allowlisted.</p>}
              </div>
              <div className="svc-chips">{c.collections.map((x) => <span key={x.name} title={`version ${x.version}`}><Badge tone={x.status === 'enabled' ? 'green' : 'gray'} dot>{x.name.replace('crowdsecurity/', '')}</Badge></span>)}</div>
            </Card>
          </div>

          <div className="rrd-grid">
            <PromCard title="Local bans over time" sub="Addresses banned after attacking you (central list)" range={86400} unit="" chart="step" lines={[{ name: 'Local bans', expr: 'sum(cs_active_decisions{instance_name="crowdsec-ct126",origin!="CAPI"}) or vector(0)' }]} />
            <PromCard title="Community blocklist size" sub="Known bad addresses held in the list" range={86400} unit="" chart="step" lines={[{ name: 'Community addresses', expr: 'sum(cs_active_decisions{instance_name="crowdsec-ct126",origin="CAPI"})' }]} />
          </div>
        </>
      )}
    </Async>
  );
}
