import { api } from '../api';
import { Async, Badge, Card, CardHead, Meter, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { fmtBytes, fmtPct } from '../format';
import { useQuery } from '../hooks';

export default function Capacity() {
  const q = useQuery(api.capacity, [], 120000);
  return (
    <>
      <PageHeader eyebrow="Insights" title="Capacity" sub="When each storage pool will fill up at its current growth rate, and what still fits in RAM before you press Start." />
      <Async q={q} rows={5} h={70}>
        {(c) => (
          <>
            <div className="stat-row">
              <div><b>{fmtBytes(c.host.availableMem)}</b><span>RAM free for new guests (after {fmtBytes(c.host.reserveBytes, 0)} host reserve)</span></div>
              <div><b>{fmtBytes(c.host.allocatedMem)}</b><span>Promised to running guests of {fmtBytes(c.host.memTotal, 0)}</span></div>
              <div><b>{c.host.allocatedVcpu}/{c.host.cores}</b><span>vCPUs allocated / host threads ({c.host.vcpuRatio}×)</span></div>
            </div>
            <Card pad={false}>
              <CardHead title="Storage forecast" sub="Straight-line projection from the last 30 days of usage." />
              {c.storages.map((s) => {
                const tone: Tone = s.usedRatio > 0.9 || (s.daysToFull !== null && s.daysToFull < 14) ? 'red' : s.usedRatio > 0.8 || (s.daysToFull !== null && s.daysToFull < 45) ? 'amber' : 'green';
                return (
                  <div key={s.storage} className="list-row">
                    <div><b>{s.storage}</b> <span className="muted small">{s.type}</span></div>
                    <div><Meter value={s.usedRatio} tone={tone} /><div className="small muted">{fmtBytes(s.used)} of {fmtBytes(s.total)} ({fmtPct(s.usedRatio)})</div></div>
                    <div className="small">{s.trend === 'growing' && s.bytesPerDay ? `+${fmtBytes(s.bytesPerDay)}/day` : s.trend === 'shrinking' ? 'shrinking' : s.trend === 'flat' ? 'stable' : 'no history'}</div>
                    <div>{s.daysToFull !== null ? <Badge tone={tone} dot>full in ~{s.daysToFull} d</Badge> : <Badge tone="green">no fill date</Badge>}</div>
                  </div>
                );
              })}
            </Card>
            <Card pad={false} className="section-gap">
              <CardHead title="Can I start it?" sub="Stopped guests checked against RAM not yet promised to running ones." />
              {c.stopped.length === 0 ? <p className="muted small" style={{ padding: 16 }}>Every guest is running.</p> : c.stopped.map((g) => (
                <div key={g.vmid} className="list-row">
                  <div><a href={`#/guests/${g.vmid}`}><b>{g.name}</b></a> <span className="muted small">#{g.vmid}</span></div>
                  <div className="small">{fmtBytes(g.maxmem, 0)} RAM · {g.maxcpu} vCPU</div>
                  <div>{g.fits ? <Badge tone="green" dot>Fits</Badge> : <Badge tone="red" dot>Short by {fmtBytes(g.shortBy, 0)}</Badge>}</div>
                </div>
              ))}
            </Card>
          </>
        )}
      </Async>
    </>
  );
}
