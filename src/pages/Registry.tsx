import { useMemo, useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, Chips, EmptyState, Icon, Modal, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { useQuery, useToast } from '../hooks';
import type { RegistryHealth, RegistryImpact, RegistryService } from '../types';

const HEALTH: Record<RegistryHealth, { tone: Tone; label: string }> = {
  up: { tone: 'green', label: 'Healthy' }, down: { tone: 'red', label: 'Down' }, pending: { tone: 'amber', label: 'Degraded' }, maintenance: { tone: 'blue', label: 'Maintenance' },
  unknown: { tone: 'gray', label: 'Unknown' }, stale: { tone: 'amber', label: 'Stale' }, unmonitored: { tone: 'gray', label: 'Not monitored' },
};
const CRIT = ['low', 'normal', 'high', 'critical'] as const;
const critTone = (c: string): Tone => (c === 'critical' ? 'red' : c === 'high' ? 'amber' : 'gray');
const blank = { name: '', description: '', category: '', url: '', host: '', port: '', deployment: '', resource: '', monitor: '', owner: '', criticality: 'normal', tags: '' };

function Form({ svc, all, onClose, onSaved }: { svc: RegistryService | null; all: RegistryService[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const monitors = useQuery(api.registryMonitors, [], 0);
  const [v, setV] = useState({
    ...blank,
    ...(svc ? { name: svc.name, description: svc.description, category: svc.category, url: svc.url, host: svc.host, port: svc.port ? String(svc.port) : '', deployment: svc.deployment, resource: svc.resource, monitor: svc.monitor, owner: svc.owner, criticality: svc.criticality, tags: svc.tags.join(', ') } : {}),
  });
  const [deps, setDeps] = useState<string[]>(svc?.dependsOn ?? []);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const field = (k: keyof typeof blank, label: string, hint?: string, ph?: string) => (
    <label className="field"><span>{label}</span><input className="input" value={v[k]} onChange={set(k)} placeholder={ph} />{hint && <small className="muted">{hint}</small>}</label>
  );
  const others = all.filter((s) => s.id !== svc?.id);
  const missing = !!svc && !!v.monitor && !!monitors.data && !monitors.data.some((m) => m.value === v.monitor);

  async function save() {
    setBusy(true);
    try {
      const { id } = await api.registrySave(svc?.id ?? null, { ...v, port: v.port === '' ? null : Number(v.port) });
      const before = new Set(svc?.dependsOn ?? []); const now = new Set(deps);
      for (const d of deps) if (!before.has(d)) await api.registryAddDep(id, d);
      for (const d of before) if (!now.has(d)) await api.registryRemoveDep(id, d);
      toast.success(`${v.name} saved`); onSaved(); onClose();
    } catch (e) { toast.error((e as Error).message); onSaved(); } finally { setBusy(false); }
  }

  return (
    <Modal title={svc ? `Edit ${svc.name}` : 'Add a service'} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !v.name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="form-grid">
        {field('name', 'Name')}
        {field('description', 'What it does')}
        {field('category', 'Category', undefined, 'Database, proxy, media')}
        {field('url', 'Address people use', undefined, 'https://wiki.example.lan')}
        {field('host', 'Host name or IP')}
        {field('port', 'Port')}
        {field('deployment', 'Runs as', undefined, 'LXC, VM, Docker, bare metal')}
        {field('resource', 'Runs on', 'For example the guest or node it lives on.')}
        {field('owner', 'Owner')}
        {field('tags', 'Tags', 'Separate with commas.')}
        <label className="field"><span>Criticality</span>
          <select className="input" value={v.criticality} onChange={set('criticality')}>{CRIT.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label className="field"><span>Health comes from</span>
          <select className="input" value={v.monitor} onChange={set('monitor')}>
            <option value="">Nothing (shown as not monitored)</option>
            {missing && <option value={v.monitor}>Current link (no longer reported)</option>}
            {(monitors.data ?? []).map((m) => <option key={m.value} value={m.value}>{m.label} ({m.status})</option>)}
          </select>
          <small className="muted">Pick a check from a connected source. Connect more under Alerts and sources.</small>
        </label>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, marginTop: 12 }}>
        <legend>Depends on</legend>
        {others.length === 0 ? <small className="muted">Add more services to record what this one needs.</small> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            {others.map((o) => (
              <label key={o.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={deps.includes(o.id)} onChange={(e) => setDeps((d) => (e.target.checked ? [...d, o.id] : d.filter((x) => x !== o.id)))} />{o.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </Modal>
  );
}

function Impact({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery<RegistryImpact>(() => api.registryImpact(id), [id], 0);
  return (
    <Modal title={q.data ? `If ${q.data.service.name} fails` : 'Impact'} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <Async q={q}>
        {(d) => (
          <>
            <p><Badge tone={HEALTH[d.service.health].tone} dot>{HEALTH[d.service.health].label}</Badge> <span className="muted">{d.service.detail}</span></p>
            <h4>Would affect</h4>
            {d.wouldAffect.length === 0 ? <p className="muted">Nothing is recorded as depending on this service.</p> : (
              <table className="kv"><tbody>{d.wouldAffect.map((x) => <tr key={x.id}><td>{x.depth === 1 ? 'directly' : `${x.depth} steps away`}</td><td>{x.name}</td><td><Badge tone={critTone(x.criticality)}>{x.criticality}</Badge></td><td><Badge tone={HEALTH[x.health].tone}>{HEALTH[x.health].label}</Badge></td></tr>)}</tbody></table>
            )}
            <h4>Needs</h4>
            {d.dependsOn.length === 0 ? <p className="muted">No dependencies recorded.</p> : (
              <table className="kv"><tbody>{d.dependsOn.map((x) => <tr key={x.id}><td>{x.depth === 1 ? 'directly' : `${x.depth} steps away`}</td><td>{x.name}</td><td><Badge tone={HEALTH[x.health].tone}>{HEALTH[x.health].label}</Badge></td></tr>)}</tbody></table>
            )}
            <p className="muted small">Based on the dependencies recorded here. A dependency nobody recorded is not shown.</p>
          </>
        )}
      </Async>
    </Modal>
  );
}

export default function Registry({ role = 'viewer' }: { role?: string }) {
  const isAdmin = role === 'admin';
  const toast = useToast();
  const q = useQuery(api.registry, [], 15_000);
  const [form, setForm] = useState<{ svc: RegistryService | null } | null>(null);
  const [impact, setImpact] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [filter, setFilter] = useState<'all' | 'problems' | 'unmonitored'>('all');

  const rows = useMemo(() => (q.data?.services ?? []).filter((s) => filter === 'all' || (filter === 'problems' ? ['down', 'pending', 'stale', 'unknown'].includes(s.health) || s.affectedBy.length > 0 : s.health === 'unmonitored')), [q.data, filter]);

  async function remove(s: RegistryService) {
    try {
      const r = await api.registryDelete(s.id);
      toast.success(r.hadDependents ? `${s.name} removed; ${r.hadDependents} service(s) listed it as a dependency` : `${s.name} removed`);
      setConfirm(''); q.reload();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <>
      <PageHeader title="Service registry" sub="Everything you run, what each one needs, and what fails with it. Health comes from the checks your connected sources report; a service without one is shown as not monitored, never as healthy."
        actions={isAdmin ? <button className="btn btn-primary" onClick={() => setForm({ svc: null })}><Icon name="plus" size={15} />Add a service</button> : undefined} />
      <Card pad={false}>
        <div className="pad"><CardHead title="Services" right={<Chips value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All', count: q.data?.services.length }, { id: 'problems', label: 'Needs attention' }, { id: 'unmonitored', label: 'Not monitored' }]} />} /></div>
        <Async q={q} isEmpty={(d) => d.services.length === 0} empty={{ title: 'No services yet', hint: isAdmin ? 'Add the first one, then link it to a check and record what it depends on.' : 'An administrator can add services here.' }}>
          {() => rows.length === 0 ? <EmptyState title="Nothing matches" hint="Try another filter." /> : (
            <ul className="feed">
              {rows.map((s) => (
                <li key={s.id}>
                  <div className="grow">
                    <b>{s.url ? <a className="link" href={s.url} target="_blank" rel="noreferrer noopener">{s.name}</a> : s.name}</b> <span className="muted small">{[s.category, s.deployment, s.resource && `on ${s.resource}`].filter(Boolean).join(' · ')}</span>
                    <div className="chips-row">
                      <Badge tone={HEALTH[s.health].tone} dot title={s.detail}>{HEALTH[s.health].label}</Badge>
                      <Badge tone={critTone(s.criticality)}>{s.criticality}</Badge>
                      {s.affectedBy.length > 0 && <Badge tone="amber" title="A service this one depends on is down">Affected by {s.affectedBy.map((a) => a.name).join(', ')}</Badge>}
                      {s.dependentCount > 0 && <span className="muted small">{s.dependentCount} depend{s.dependentCount === 1 ? 's' : ''} on it</span>}
                      {s.tags.map((t) => <span key={t} className="muted small">#{t}</span>)}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => setImpact(s.id)}>Impact</button>
                    {isAdmin && <button className="btn btn-sm" onClick={() => setForm({ svc: s })}>Edit</button>}
                    {isAdmin && (confirm === s.id
                      ? <><button className="btn btn-sm btn-danger" onClick={() => void remove(s)}>Remove {s.name}</button><button className="btn btn-sm" onClick={() => setConfirm('')}>Keep it</button></>
                      : <button className="btn btn-sm" onClick={() => setConfirm(s.id)}>Remove</button>)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
      {form && q.data && <Form svc={form.svc} all={q.data.services} onClose={() => setForm(null)} onSaved={q.reload} />}
      {impact && <Impact id={impact} onClose={() => setImpact(null)} />}
    </>
  );
}
