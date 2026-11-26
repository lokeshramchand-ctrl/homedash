import { useMemo, useState } from 'react';
import { api } from '../api';
import { HookDetails, SourceForm } from '../components/SourceForm';
import { Logo } from '../components/ServiceForm';
import { Async, Badge, Card, CardHead, Chips, EmptyState, Icon, Modal, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { timeAgo } from '../format';
import { useQuery, useToast } from '../hooks';
import type { MonSource, MonitoringSnapshot, MonitoringSource } from '../types';

const ago = (ms: number | null) => (ms ? timeAgo(new Date(ms).toISOString()) : '');
const DOT: Record<string, string> = { down: 'd-down', pending: 'd-pending', firing: 'd-down', up: '' };

function stateBadge(s: MonitoringSource | null, kind: string) {
  if (!s) return <Badge tone="gray">Not running</Badge>;
  if (!s.ok) return <Badge tone="red" dot>{s.stale ? 'Unreachable (showing last known)' : 'Unreachable'}</Badge>;
  if (kind === 'webhook' && s.checks + s.alerts === 0) return <Badge tone="gray" dot>Waiting for the first event</Badge>;
  return <Badge tone="green" dot>Connected</Badge>;
}

interface Row { id: string; kind: string; label: string; managed: 'config' | 'ui'; state: MonitoringSource | null; src?: MonSource }

export default function Monitoring({ role = 'viewer' }: { role?: string }) {
  const isAdmin = role === 'admin';
  const toast = useToast();
  const snap = useQuery(api.monitoring, [], 10_000);
  const admin = useQuery(async () => (isAdmin ? { s: await api.monitoringSources(), c: await api.monitoringCatalog() } : null), [isAdmin], 10_000);
  const [form, setForm] = useState<{ source?: MonSource } | null>(null);
  const [rotated, setRotated] = useState<{ path: string; secret: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [confirmRotate, setConfirmRotate] = useState('');
  const [testing, setTesting] = useState('');
  const [result, setResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [view, setView] = useState<'problems' | 'all'>('problems');
  const [only, setOnly] = useState('all');

  const rows: Row[] = useMemo(() => {
    const byId = new Map((snap.data?.sources ?? []).map((s) => [s.id, s]));
    if (admin.data) {
      const { s } = admin.data;
      return [
        ...s.config.map((c): Row => ({ id: c.id, kind: c.kind, label: c.label, managed: 'config', state: c.state })),
        ...s.sources.map((x): Row => ({ id: x.id, kind: x.kind, label: x.name, managed: 'ui', state: byId.get(x.kind === 'kuma' || x.kind === 'grafana' ? x.kind : x.id) ?? null, src: x })),
      ];
    }
    return (snap.data?.sources ?? []).map((s): Row => ({ id: s.id, kind: s.kind, label: s.label, managed: s.managed, state: s }));
  }, [snap.data, admin.data]);

  const items = useMemo(() => {
    const d: MonitoringSnapshot | undefined = snap.data;
    if (!d) return [];
    const label = (id: string) => d.sources.find((s) => s.id === id)?.label ?? id;
    const list = [
      ...d.alerts.map((a) => ({ k: `a|${a.source}|${a.key}`, source: a.source, label: label(a.source), tone: (a.level === 'error' ? 'red' : 'amber') as Tone, dot: DOT[a.state === 'firing' ? 'firing' : 'pending'], name: a.name, text: a.summary || (a.state === 'firing' ? 'Alert is firing' : 'Pending'), since: a.since, status: a.state, url: a.url, problem: true })),
      ...d.checks.map((c) => ({ k: `c|${c.source}|${c.key}`, source: c.source, label: label(c.source), tone: (c.status === 'down' ? 'red' : c.status === 'pending' ? 'amber' : c.status === 'up' ? 'green' : 'gray') as Tone, dot: DOT[c.status] ?? '', name: c.name, text: c.detail, since: c.since, status: c.status, url: c.url, problem: c.status === 'down' || c.status === 'pending' })),
    ];
    return list.filter((i) => (only === 'all' || i.source === only) && (view === 'all' || i.problem));
  }, [snap.data, view, only]);

  async function retest(r: Row) {
    setTesting(r.id);
    try { setResult((x) => ({ ...x, [r.id]: { ok: false, message: '' }, ...{} })); const t = await api.retestMonitoringSource(r.id); setResult((x) => ({ ...x, [r.id]: t })); }
    catch (e) { setResult((x) => ({ ...x, [r.id]: { ok: false, message: (e as Error).message } })); } finally { setTesting(''); }
  }
  async function remove(r: Row) {
    try { await api.deleteMonitoringSource(r.id); toast.success(`${r.label} removed`); setConfirm(''); admin.reload(); snap.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  async function rotate(r: Row) {
    try { const x = await api.rotateMonitoringSource(r.id); setRotated({ path: x.hookPath, secret: x.secret, name: r.label }); } catch (e) { toast.error((e as Error).message); }
  }
  const canEdit = !!admin.data?.s.canEdit;
  const refresh = () => { admin.reload(); snap.reload(); };

  return (
    <>
      <PageHeader title="Monitoring" sub="Every tool you connect, in one list. homedash reads them, or they tell homedash." actions={
        isAdmin ? <button className="btn btn-primary" disabled={!canEdit} title={canEdit ? undefined : 'Set a secret key first: run homedash-config apply'} onClick={() => setForm({})}><Icon name="plus" size={15} />Connect a source</button> : undefined
      } />

      <Card pad={false}>
        <div className="pad"><CardHead title="Sources" sub="What homedash is watching or listening to." /></div>
        <Async q={snap} rows={2} h={64}>
          {() => rows.length === 0 ? (
            <EmptyState icon="inbox" title="Nothing connected yet" hint={isAdmin ? 'Connect Grafana, Uptime Kuma, Prometheus, Alertmanager, a JSON endpoint, or any tool that can send a webhook.' : 'An administrator can connect sources.'}
              action={isAdmin && canEdit ? <button className="btn btn-primary" onClick={() => setForm({})}>Connect a source</button> : undefined} />
          ) : (
            <ul className="feed">
              {rows.map((r) => (
                <li key={r.id}>
                  <Logo kind={r.kind} label={r.label} size={30} />
                  <div className="grow">
                    <b>{r.label}</b> <span className="muted small">{r.kind}</span>{' '}
                    {r.managed === 'config' ? <Badge tone="blue" title="Set in homedash.yaml or the environment; change it there">In config</Badge> : null}
                    {r.src?.shadowed ? <Badge tone="amber" title="YAML sets this kind, so this one is ignored">Ignored: set in config</Badge> : null}
                    {r.src && !r.src.enabled ? <Badge tone="gray">Disabled</Badge> : null}
                    <div className="chips-row">
                      {stateBadge(r.state, r.kind)}
                      {r.state && <span className="muted small">{r.state.checks} checks, {r.state.alerts} alerts{r.state.checkedAt ? `, read ${ago(r.state.checkedAt)}` : ''}</span>}
                    </div>
                    {r.state && !r.state.ok && r.state.error && <p className="small err-t">{r.state.error}</p>}
                    {result[r.id]?.message && <p className={`small ${result[r.id].ok ? '' : 'err-t'}`}>{result[r.id].message}</p>}
                    {r.src?.hookPath && <p className="muted small mono">{location.origin}{r.src.hookPath}</p>}
                  </div>
                  {isAdmin && r.src && (
                    <div className="chips-row">
                      <button className="btn btn-sm" disabled={testing === r.id} onClick={() => retest(r)}>Test</button>
                      <button className="btn btn-sm" onClick={() => setForm({ source: r.src })}>Edit</button>
                      {r.kind === 'webhook' && (confirmRotate === r.id
                        ? <><button className="btn btn-sm btn-danger" onClick={() => { setConfirmRotate(''); rotate(r); }}>Replace the secret</button><button className="btn btn-sm" onClick={() => setConfirmRotate('')}>Keep it</button></>
                        : <button className="btn btn-sm" title="The old secret stops working at once" onClick={() => setConfirmRotate(r.id)}>New secret</button>)}
                      {confirm === r.id
                        ? <><button className="btn btn-sm btn-danger" onClick={() => remove(r)}>Really remove</button><button className="btn btn-sm" onClick={() => setConfirm('')}>Keep</button></>
                        : <button className="btn btn-sm" onClick={() => setConfirm(r.id)}>Remove</button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>

      <Card pad={false}>
        <div className="pad">
          <CardHead title="Right now" sub="Alerts and checks from every source." />
          <div className="toolbar">
            <Chips value={view} onChange={setView} options={[{ id: 'problems', label: 'Problems' }, { id: 'all', label: 'Everything' }]} />
            {rows.length > 1 && <Chips value={only} onChange={setOnly} options={[{ id: 'all', label: 'All sources' }, ...(snap.data?.sources ?? []).map((s) => ({ id: s.id, label: s.label }))]} />}
          </div>
        </div>
        <Async q={snap} rows={3} h={52} isEmpty={() => items.length === 0} empty={{ title: view === 'problems' ? 'No problems' : 'Nothing to show', hint: view === 'problems' ? 'Every connected source reports healthy.' : 'Connect a source to see its checks and alerts.' }}>
          {() => (
            <ul className="feed">
              {items.map((i) => (
                <li key={i.k}>
                  <span className={`inc-dot ${i.dot}`} />
                  <div className="grow">
                    <b>{i.name}</b> <Badge tone={i.tone}>{i.status}</Badge> <span className="muted small">{i.label}</span>
                    {i.text && <p className="muted small">{i.text}</p>}
                    {i.url && <a className="link small" href={i.url} target="_blank" rel="noopener noreferrer">Open</a>}
                  </div>
                  <span className="muted small nowrap">{ago(i.since)}</span>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>

      {form && admin.data && <SourceForm kinds={admin.data.c.kinds} templates={admin.data.c.templates} source={form.source} onClose={() => setForm(null)} onSaved={refresh} />}
      {rotated && (
        <Modal title={`New secret for ${rotated.name}`} wide onClose={() => setRotated(null)} footer={<button className="btn btn-primary" onClick={() => setRotated(null)}>Done</button>}>
          <HookDetails path={rotated.path} secret={rotated.secret} name={rotated.name} />
        </Modal>
      )}
    </>
  );
}
