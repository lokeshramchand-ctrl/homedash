import { Async, Badge, Card, ListRow, Screen, SectionTitle, StateView } from '../components/ui';
import { api } from '../api';
import { useQuery } from '../useQuery';

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'gray';
const HEALTH: Record<string, { tone: Tone; label: string }> = {
  up: { tone: 'green', label: 'healthy' }, down: { tone: 'red', label: 'down' }, pending: { tone: 'amber', label: 'degraded' }, maintenance: { tone: 'blue', label: 'maintenance' },
  unknown: { tone: 'gray', label: 'unknown' }, stale: { tone: 'amber', label: 'stale' }, unmonitored: { tone: 'gray', label: 'not monitored' },
};
const RANK: Record<string, number> = { down: 0, stale: 1, pending: 2, unknown: 3, maintenance: 4, unmonitored: 5, up: 6 };

/** The service registry, read-only: what each service is doing and what a failure would take with it. Edited on the web page. */
export default function Registry({ onBack }: { onBack: () => void }) {
  const q = useQuery(api.registry, 30_000);
  return (
    <Screen title="Services" sub="What you run, and what depends on what." back={{ label: 'More', onPress: onBack }} queries={[q]}>
      <Async q={q} rows={4} h={64}>
        {(d) => {
          if (d.services.length === 0) return <StateView title="No services yet" hint="Add them on the web page under Service registry." />;
          const list = [...d.services].sort((a, b) => (RANK[a.health] ?? 9) - (RANK[b.health] ?? 9) || a.name.localeCompare(b.name));
          const hit = list.filter((s) => s.affectedBy.length > 0);
          return (
            <>
              {hit.length > 0 && (
                <>
                  <SectionTitle>Affected by something down</SectionTitle>
                  <Card style={{ paddingVertical: 0 }}>
                    {hit.map((s, i) => <ListRow key={s.id} first={i === 0} title={s.name} sub={`Needs ${s.affectedBy.map((a) => a.name).join(', ')}`} right={<Badge tone="amber">at risk</Badge>} />)}
                  </Card>
                </>
              )}
              <SectionTitle>All services</SectionTitle>
              <Card style={{ paddingVertical: 0 }}>
                {list.map((s, i) => {
                  const h = HEALTH[s.health] ?? HEALTH.unknown;
                  const bits = [s.category, s.criticality !== 'normal' ? s.criticality : '', s.dependentCount ? `${s.dependentCount} depend on it` : ''].filter(Boolean).join(' · ');
                  return <ListRow key={s.id} first={i === 0} title={s.name} sub={bits || s.detail} right={<Badge tone={h.tone}>{h.label}</Badge>} />;
                })}
              </Card>
            </>
          );
        }}
      </Async>
    </Screen>
  );
}
