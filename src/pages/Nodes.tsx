import { api } from '../api';
import { Async, Badge, Card, CardHead, EmptyState, Meter, PageHeader } from '../components/ui';
import { fmtBytes, fmtPct, fmtUptime } from '../format';
import { useQuery } from '../hooks';
import { select } from '../selection';
import type { ClusterInfo } from '../types';

/** Every cluster and node at a glance: who is online, quorum, load, where guests run, which API address answers. */
export default function Nodes() {
  const q = useQuery(api.clusters, [], 15_000);
  const go = (cluster: string, node: string, page: string) => { select(cluster, node); location.hash = `#/${page}`; };
  return (
    <>
      <PageHeader eyebrow="Datacenter" title="Cluster" sub="Every Proxmox cluster and node dashboards watches. Open one to work with its guests, or a single node to see its hardware, health and capacity." />
      <Async q={q} rows={3} h={140}>
        {(d) => d.clusters.length === 0 ? <Card><EmptyState icon="server" title="No cluster configured" hint="Add one under proxmox: in homedash.yaml." /></Card> : (
          <div className="stack">
            {d.clusters.map((c) => <ClusterCard key={c.id} c={c} current={c.id === d.current} onOpen={(node, page) => go(c.id, node, page)} />)}
          </div>
        )}
      </Async>
    </>
  );
}

function ClusterCard({ c, current, onOpen }: { c: ClusterInfo; current: boolean; onOpen: (node: string, page: string) => void }) {
  const offline = c.nodes.filter((n) => !n.online);
  const state = !c.reachable ? <Badge tone="red" dot>unreachable</Badge>
    : c.quorate === false ? <Badge tone="red" dot>no quorum</Badge>
    : offline.length ? <Badge tone="amber" dot>{offline.length} node{offline.length === 1 ? '' : 's'} offline</Badge>
    : <Badge tone="green" dot>healthy</Badge>;
  return (
    <Card pad={false}>
      <div className="pad">
        <CardHead title={<>{c.name} {current && <Badge tone="blue">selected</Badge>}</>}
          sub={c.reachable
            ? `${c.standalone ? 'Stand-alone node' : `${c.nodes.length} nodes`} · ${c.guests.running} of ${c.guests.total} guests running${c.version ? ` · Proxmox ${c.version}` : ''}${c.activeAddress ? ` · API ${c.activeAddress.replace(/^https?:\/\//, '')}${c.addresses > 1 ? ` (+${c.addresses - 1} backup)` : ''}` : ''}`
            : c.error ?? 'The API does not answer'}
          right={<span className="row-actions">{state}{!current && <button className="btn btn-sm" onClick={() => onOpen('', 'overview')}>Open</button>}</span>} />
      </div>
      {c.nodes.length > 0 && (
        <ul className="feed nodes">
          {c.nodes.map((n) => (
            <li key={n.name}>
              <div className="grow">
                <b>{n.name}</b> {n.local && <Badge tone="gray" title="The cluster member homedash is talking to">API</Badge>} <Badge tone={n.online ? 'green' : 'red'} dot>{n.online ? 'online' : 'offline'}</Badge>
                <p className="muted small">{n.guests} guest{n.guests === 1 ? '' : 's'} ({n.running} running){n.online ? ` · up ${fmtUptime(n.uptime)}` : ''}</p>
              </div>
              {n.online && (
                <div className="node-meters">
                  <span><small className="muted">CPU {fmtPct(n.cpu, 0)}</small><Meter value={n.cpu} /></span>
                  <span><small className="muted">RAM {fmtBytes(n.mem, 0)} / {fmtBytes(n.maxmem, 0)}</small><Meter value={n.maxmem ? n.mem / n.maxmem : 0} /></span>
                  <span><small className="muted">Disk {fmtPct(n.maxdisk ? n.disk / n.maxdisk : 0, 0)}</small><Meter value={n.maxdisk ? n.disk / n.maxdisk : 0} /></span>
                </div>
              )}
              <span className="row-actions">
                <button className="btn btn-sm" disabled={!n.online} onClick={() => onOpen(n.name, 'node')}>Node</button>
                <button className="btn btn-sm" onClick={() => onOpen(n.name, 'guests')}>Guests</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
