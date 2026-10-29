import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { useQuery, useSearch } from '../hooks';
import { NewSiteModal } from './Nginx';
import type { NetSite } from '../types';

const ISSUE: Record<NetSite['issue'], { tone: Tone; label: string; hint: string }> = {
  ok: { tone: 'green', label: 'OK', hint: '' },
  'guest-stopped': { tone: 'red', label: 'Guest stopped', hint: 'This site proxies to a guest that is not running, so visitors get a 502.' },
  'unknown-target': { tone: 'amber', label: 'Unknown target', hint: 'No guest owns this address. It may be another device, or the guest moved to a new IP.' },
  hostname: { tone: 'gray', label: 'Hostname', hint: 'Upstream uses a name, so it cannot be matched to a guest.' },
  local: { tone: 'gray', label: 'Local', hint: 'Proxies to a service on the same machine.' },
};

export default function Netmap() {
  const q = useQuery(api.netmap, [], 60000);
  const manage = useQuery(api.nginxManage, []);
  const [publish, setPublish] = useState<string | null>(null);
  const { q: search } = useSearch();
  const needle = search.trim().toLowerCase();
  return (
    <>
      <PageHeader eyebrow="Insights" title="Network map" sub="Every guest address in one table, duplicate IP and MAC detection, and a check that each nginx site points at a guest that exists and is running." />
      {publish && <NewSiteModal initial={{ upstream: `http://${publish}` }} onClose={() => setPublish(null)} onDone={() => { setPublish(null); window.location.hash = '#/nginx'; }} />}
      <Async q={q} rows={6} h={60}>
        {(m) => {
          const broken = m.sites.filter((s) => s.issue === 'guest-stopped' || s.issue === 'unknown-target');
          const guests = m.guests.filter((g) => !needle || `${g.vmid} ${g.name} ${g.ips.map((i) => i.ip).join(' ')} ${g.macs.join(' ')}`.toLowerCase().includes(needle));
          return (
            <>
              <div className="stat-row">
                <div><b>{m.guests.reduce((a, g) => a + g.ips.length, 0)}</b><span>Addresses found</span></div>
                <div><b>{m.duplicates.length}</b><span>Duplicate IP / MAC</span></div>
                <div><b>{broken.length}</b><span>Sites with a broken target</span></div>
              </div>
              {m.duplicates.length > 0 && (
                <Card className="section-gap">
                  <CardHead title="Conflicts" sub="Two guests claiming the same address cause random connection drops." />
                  {m.duplicates.map((d) => (
                    <div key={`${d.kind}${d.value}`} className="list-row">
                      <div><b className="mono">{d.value}</b> <Badge tone="red">{d.kind.toUpperCase()}</Badge></div>
                      <div className="pill-list">{d.guests.map((g) => <a key={g.vmid} href={`#/guests/${g.vmid}`}><Badge>{g.name} · {g.vmid}</Badge></a>)}</div>
                    </div>
                  ))}
                </Card>
              )}
              {m.sites.length > 0 && (
                <Card pad={false} className="section-gap">
                  <div className="list-row head"><span>Nginx site → target</span><span>Guest</span><span>Status</span></div>
                  {m.sites.map((s) => (
                    <div key={s.file} className="list-row" title={ISSUE[s.issue].hint}>
                      <div><b>{s.serverName}</b><div className="muted small mono">{s.upstream}</div></div>
                      <div>{s.guest ? <a href={`#/guests/${s.guest.vmid}`}>{s.guest.name} · {s.guest.vmid}</a> : <span className="muted">–</span>}</div>
                      <div><Badge tone={ISSUE[s.issue].tone} dot>{ISSUE[s.issue].label}</Badge></div>
                    </div>
                  ))}
                </Card>
              )}
              <Card pad={false} className="section-gap">
                <div className="list-row head"><span>Guest</span><span>Addresses</span><span>MAC</span><span>Bridge</span><span /></div>
                {guests.map((g) => (
                  <div key={g.vmid} className="list-row">
                    <div><a href={`#/guests/${g.vmid}`}><b>{g.name}</b></a> <span className="muted small">#{g.vmid} · {g.type === 'qemu' ? 'VM' : 'LXC'}</span> <Badge tone={g.status === 'running' ? 'green' : 'gray'} dot>{g.status}</Badge></div>
                    <div className="mono small">{g.ips.length ? g.ips.map((i) => <div key={i.ip} title={`from ${i.source}`}>{i.ip}{i.source === 'config' ? '' : ' •'}</div>) : <span className="muted">none known</span>}</div>
                    <div className="mono small muted">{g.macs.join(', ') || '–'}</div>
                    <div className="small">{g.bridges.join(', ') || '–'}</div>
                    <div>{manage.data?.enabled && g.ips[0] && g.status === 'running' && <button className="btn btn-sm" onClick={() => setPublish(`${g.ips[0].ip}:80`)} title="Create an nginx reverse-proxy site for this guest">Publish</button>}</div>
                  </div>
                ))}
              </Card>
              <p className="muted small section-gap">Addresses marked • were read from the running guest (LXC interfaces or the QEMU guest agent); the rest come from the configuration.</p>
            </>
          );
        }}
      </Async>
    </>
  );
}
