import { Async, Badge, Card, ListRow, Screen, SectionTitle, StateView } from '../components/ui';
import { api } from '../api';
import { timeAgo } from '../format';
import { useQuery } from '../useQuery';

/** What every connected monitoring source reports right now. Read-only: sources are connected on the web page. */
export default function Monitoring({ onBack }: { onBack: () => void }) {
  const q = useQuery(api.monitoring, 15_000);
  return (
    <Screen title="Monitoring" sub="Every connected tool in one list." back={{ label: 'More', onPress: onBack }} queries={[q]}>
      <Async q={q} rows={3} h={70}>
        {(d) => {
          const label = (id: string) => d.sources.find((s) => s.id === id)?.label ?? id;
          const problems = [
            ...d.alerts.filter((a) => a.state === 'firing').map((a) => ({ k: `a${a.source}${a.key}`, title: a.name, sub: `${label(a.source)}${a.summary ? ` · ${a.summary}` : ''}`, tone: a.level === 'error' ? 'red' as const : 'amber' as const, word: 'firing' })),
            ...d.checks.filter((c) => c.status === 'down' || c.status === 'pending').map((c) => ({ k: `c${c.source}${c.key}`, title: c.name, sub: `${label(c.source)}${c.detail ? ` · ${c.detail}` : ''}`, tone: c.status === 'down' ? 'red' as const : 'amber' as const, word: c.status })),
          ];
          return (
            <>
              <SectionTitle>Problems</SectionTitle>
              {problems.length === 0 ? <StateView title="No problems" hint={d.sources.length ? 'Every connected source reports healthy.' : 'No sources are connected yet. Connect them on the web page.'} /> : (
                <Card style={{ paddingVertical: 0 }}>
                  {problems.map((p, i) => <ListRow key={p.k} first={i === 0} title={p.title} sub={p.sub} right={<Badge tone={p.tone}>{p.word}</Badge>} />)}
                </Card>
              )}
              <SectionTitle>Sources</SectionTitle>
              {d.sources.length === 0 ? <StateView title="Nothing connected" /> : (
                <Card style={{ paddingVertical: 0 }}>
                  {d.sources.map((s, i) => (
                    <ListRow key={s.id} first={i === 0} title={s.label} sub={s.ok ? `${s.checks} checks, ${s.alerts} alerts · read ${s.checkedAt ? timeAgo(new Date(s.checkedAt).toISOString()) : 'never'}` : `Unreachable: ${s.error ?? 'no answer'}`}
                      right={<Badge tone={s.ok ? 'green' : 'red'}>{s.ok ? 'ok' : s.stale ? 'stale' : 'down'}</Badge>} />
                  ))}
                </Card>
              )}
            </>
          );
        }}
      </Async>
    </Screen>
  );
}
