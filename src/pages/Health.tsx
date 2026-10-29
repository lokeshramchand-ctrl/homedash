import { api } from '../api';
import { Async, Badge, Card, Icon, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { useQuery } from '../hooks';
import type { HealthCheck } from '../types';

const TONE: Record<HealthCheck['status'], Tone> = { ok: 'green', warn: 'amber', fail: 'red', unknown: 'gray' };
const LABEL: Record<HealthCheck['status'], string> = { ok: 'OK', warn: 'Warning', fail: 'Problem', unknown: 'Unknown' };

export default function Health() {
  const q = useQuery(api.health, [], 60000);
  return (
    <>
      <PageHeader eyebrow="Insights" title="Health" sub="One score for the whole node: updates, certificates, disks, ZFS, services, backups and storage headroom." />
      <Async q={q} rows={6} h={64}>
        {(h) => {
          const score = h.score;
          const tone: Tone = score === null ? 'gray' : score >= 90 ? 'green' : score >= 70 ? 'amber' : 'red';
          const order = { fail: 0, warn: 1, unknown: 2, ok: 3 } as const;
          return (
            <>
              <div className="stat-row">
                <div><b>{score ?? '–'}</b><span>Health score (100 is perfect)</span></div>
                <div><b>{h.checks.filter((c) => c.status === 'fail').length}</b><span>Problems</span></div>
                <div><b>{h.checks.filter((c) => c.status === 'warn').length}</b><span>Warnings</span></div>
                <div><b>{h.checks.filter((c) => c.status === 'ok').length}</b><span>Passing</span></div>
              </div>
              <Badge tone={tone} dot>{score === null ? 'Nothing could be checked' : score >= 90 ? 'Healthy' : score >= 70 ? 'Needs attention' : 'Action required'}</Badge>
              <Card pad={false}>
                {[...h.checks].sort((a, b) => order[a.status] - order[b.status]).map((c) => (
                  <div key={c.id} className="list-row">
                    <div><b>{c.title}</b><div className="muted small">{c.detail}</div>{c.hint && c.status !== 'ok' && <div className="small"><Icon name="sparkles" size={13} /> {c.hint}</div>}</div>
                    <div><Badge tone={TONE[c.status]} dot>{LABEL[c.status]}</Badge></div>
                  </div>
                ))}
              </Card>
              <p className="muted small section-gap">Checks needing permissions the API token lacks show as Unknown. Give the token the PVEAuditor role to enable them.</p>
            </>
          );
        }}
      </Async>
    </>
  );
}
