import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { Badge, Icon, Modal, Spinner } from './ui';
import { CodeBlock } from './ui-more';
import { Logo } from './ServiceForm';
import { useToast } from '../hooks';
import type { MonSource, SourceField, SourceKind, SourceTemplate } from '../types';

/** What to give the other tool after a webhook source is created. The secret is shown here once and cannot be read back. */
export function HookDetails({ path, secret, name }: { path: string; secret: string; name: string }) {
  const url = `${location.origin}${path}`;
  return (
    <div className="stack-sm">
      <div className="callout warn" role="status"><Icon name="alert" size={16} /><span><b>Copy the secret now.</b> It is shown only once; if you lose it you can issue a new one, and the old one stops working.</span></div>
      <CodeBlock label="Address" code={url} />
      <CodeBlock label="Secret" code={secret} />
      <p className="muted small">Send it as a header (preferred): <code>Authorization: Bearer &lt;secret&gt;</code>. Try it:</p>
      <CodeBlock label="curl" code={`curl -X POST '${url}' \\\n  -H 'Authorization: Bearer ${secret}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name": "nightly-backup", "status": "down", "message": "exit code 2"}'`} />
      <p className="muted small">In Alertmanager (<code>alertmanager.yml</code>):</p>
      <CodeBlock label="alertmanager.yml" code={`receivers:\n  - name: ${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'homedash'}\n    webhook_configs:\n      - url: '${url}'\n        send_resolved: true\n        http_config:\n          authorization:\n            credentials: '${secret}'`} />
      <p className="muted small">In Grafana, add a Webhook contact point with this URL and an Authorization header (scheme Bearer, the secret as the credentials).</p>
      <div className="callout"><Icon name="info" size={16} /><span>A tool that cannot set a header can use <code>{url}?token=&lt;secret&gt;</code> instead. Web addresses end up in the logs of proxies and of the sending tool, so prefer the header. homedash itself hides the token in its own log.</span></div>
    </div>
  );
}

/** One field of the form, by type. A secret that is already saved shows a hint instead of its value. */
function FieldInput({ f, value, savedSecret, onChange, onEnter }: { f: SourceField; value: string; savedSecret: boolean; onChange: (v: string) => void; onEnter: () => void }) {
  const hint = f.hint && <span className="muted small">{f.hint}</span>;
  if (f.type === 'bool') {
    return <label className="check"><input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : '')} />{f.label}{hint}</label>;
  }
  const label = <>{f.label}{!f.required && <span className="muted small"> (optional)</span>}</>;
  if (f.type === 'select') {
    return (
      <label className="field">{label}
        <select className="input" value={value || f.options![0].value} onChange={(e) => onChange(e.target.value)}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        {hint}
      </label>
    );
  }
  if (f.type === 'textarea') {
    return <label className="field">{label}<textarea className="input mono" rows={4} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />{hint}</label>;
  }
  const example = /For example (\S+)/.exec(f.hint ?? '')?.[1];
  return (
    <label className="field">{label}
      <input className={`input ${f.type === 'url' ? 'mono' : ''}`} type={f.type === 'secret' ? 'password' : 'text'} autoComplete={f.type === 'secret' ? 'new-password' : 'off'}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={f.type === 'secret' && savedSecret ? 'Saved. Leave blank to keep it.' : example ?? (f.type === 'url' ? 'http://192.168.1.20' : '')} />
      {hint}
    </label>
  );
}

/** "Connect a source" / "Edit source": pick a ready-made tool or a kind, fill what it needs, test it, save. */
export function SourceForm({ kinds, templates = [], source, initialKind, onClose, onSaved }: { kinds: SourceKind[]; templates?: SourceTemplate[]; source?: MonSource; initialKind?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = !!source;
  const [kindId, setKindId] = useState(source?.kind ?? initialKind ?? '');
  const [tplId, setTplId] = useState(source?.config.template ?? '');
  const kind = kinds.find((k) => k.kind === kindId);
  const tpl = templates.find((t) => t.id === tplId);
  const [name, setName] = useState(source?.name ?? '');
  const [vals, setVals] = useState<Record<string, string>>(source?.config ?? {});
  const [intervalS, setIntervalS] = useState(source?.intervalS ?? 60);
  const [ttlHours, setTtlHours] = useState(source?.ttlHours ?? 168);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [err, setErr] = useState('');
  const [canForce, setCanForce] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  const [created, setCreated] = useState<{ path: string; secret: string } | null>(null);
  const set = (k: string, v: string) => { setVals((x) => ({ ...x, [k]: v })); setRes(null); setErr(''); setCanForce(false); };
  const saved = useMemo(() => new Set(source?.secretsSet ?? []), [source]);
  // The kinds and tools this person has connected before come first (their own history; the default order breaks ties).
  const [rank, setRank] = useState<Record<string, number>>({});
  useEffect(() => { void api.usageTop(20).then((r) => setRank(Object.fromEntries(r.items.filter((i) => i.item.startsWith('kind:')).map((i) => [i.item.slice(5), i.score])))).catch(() => undefined); }, []);
  const orderedKinds = useMemo(() => [...kinds].sort((a, b) => (rank[b.kind] ?? 0) - (rank[a.kind] ?? 0)), [kinds, rank]);
  const orderedTemplates = useMemo(() => [...templates].sort((a, b) => (rank[b.id] ?? 0) - (rank[a.id] ?? 0)), [templates, rank]);

  // A template asks only for what it needs; a kind shows all its fields. A field that depends on another choice shows only while it applies.
  const fields: SourceField[] = tpl ? tpl.ask : kind?.fields ?? [];
  const shown = fields.filter((f) => !f.showWhen || f.showWhen.in.includes(vals[f.showWhen.field] || fields.find((x) => x.name === f.showWhen!.field)?.options?.[0]?.value || ''));
  const need = shown.filter((f) => f.required && !(vals[f.name] ?? '').trim() && !(f.type === 'secret' && saved.has(f.name)));
  const missing = need.length > 0;
  const title = tpl?.label ?? kind?.label ?? '';

  const body = (force = false) => ({ ...vals, kind: kindId, template: tplId || undefined, id: source?.id, name: name.trim() || title, enabled, intervalS, ttlHours, ...(force ? { force: true } : {}) });

  async function test() {
    setBusy('test'); setErr(''); setRes(null);
    try { setRes(await api.testMonitoringSource(body())); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }
  async function save(force = false) {
    setBusy('save'); setErr(''); setCanForce(false); setRes(null);
    try {
      if (editing) { await api.editMonitoringSource(source!.id, body(force)); toast.success(`${name || title} saved`); onSaved(); onClose(); }
      else {
        const r = await api.addMonitoringSource(body(force));
        void api.usageCount(`kind:${tplId || kindId}`);
        onSaved();
        if (r.secret && r.hookPath) setCreated({ path: r.hookPath, secret: r.secret }); else { toast.success(`${name || title} connected`); onClose(); }
      }
    } catch (e) {
      setErr((e as Error).message);
      if (e instanceof ApiError && e.code === 'TEST_FAILED') setCanForce(true);
    } finally { setBusy(''); }
  }

  if (created) {
    return (
      // Escape and a click outside do not close this one: the secret is shown only here. Done does.
      <Modal key="done" title={`${name || 'Webhook'} is ready`} wide onClose={() => undefined} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <HookDetails path={created.path} secret={created.secret} name={name || 'homedash'} />
      </Modal>
    );
  }

  if (!kind) {
    return (
      <Modal key="pick" title="Connect a source" wide onClose={onClose} footer={<button className="btn" onClick={onClose}>Cancel</button>}>
        <p className="muted small">Pick a tool, or describe any tool yourself. If it has a web address, a metrics page, a port or can send a web request, homedash can watch it.</p>
        {orderedTemplates.length > 0 && (
          <section>
            <h4 className="svc-group">Ready-made</h4>
            <div className="kind-grid">
              {orderedTemplates.map((t) => (
                <button key={t.id} className="kind-pick" onClick={() => { setKindId('http'); setTplId(t.id); setName(t.label); }}>
                  <Logo kind={t.id} label={t.label} /><span>{t.label}<br /><small className="muted">{t.summary}</small></span>
                </button>
              ))}
            </div>
          </section>
        )}
        <section>
          <h4 className="svc-group">Any other tool</h4>
          <div className="kind-grid">
            {orderedKinds.map((k) => (
              <button key={k.kind} className="kind-pick" onClick={() => { setKindId(k.kind); setTplId(''); setName(k.label); }}>
                <Logo kind={k.kind} label={k.label} /><span>{k.label}<br /><small className="muted">{k.summary}</small></span>
              </button>
            ))}
          </div>
        </section>
      </Modal>
    );
  }

  const row = (f: SourceField) => (
    <FieldInput key={f.name} f={f} value={vals[f.name] ?? ''} savedSecret={saved.has(f.name)} onChange={(v) => set(f.name, v)} onEnter={() => { if (!missing && !busy) void save(); }} />
  );
  const plain = shown.filter((f) => !f.advanced), advanced = shown.filter((f) => f.advanced);

  return (
    <Modal key="form" title={`${editing ? 'Edit' : 'Connect'} ${title}`} wide onClose={busy ? () => undefined : onClose} footer={
      <>
        {!editing && <button className="btn" onClick={() => { setKindId(''); setTplId(''); setRes(null); setErr(''); setVals({}); }} disabled={!!busy}>Back</button>}
        <button className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {kind.mode === 'pull' && <button className="btn" onClick={test} disabled={missing || !!busy}>{busy === 'test' ? <Spinner size={14} /> : <Icon name="pulse" size={15} />}Test</button>}
        {canForce && <button className="btn" onClick={() => save(true)} disabled={!!busy}>Save anyway</button>}
        <button className="btn btn-primary" onClick={() => save()} disabled={missing || !!busy}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" size={15} />}{editing ? 'Save' : kind.mode === 'push' ? 'Create' : 'Connect'}</button>
      </>
    }>
      <div className="stack-sm">
        <p className="muted small">{tpl?.hint ?? kind.hint}</p>
        {tpl && <p className="muted small">Checked against: {tpl.verified}.</p>}
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
        <div className="form-grid">{plain.map(row)}</div>
        {advanced.length > 0 && (
          <details className="adv"><summary>Advanced</summary><div className="form-grid">{advanced.map(row)}</div></details>
        )}
        {kind.mode === 'pull' && kind.kind !== 'kuma' && kind.kind !== 'grafana' && (
          <label className="field">Read every (seconds)<input className="input" type="number" min={15} max={3600} value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))} /></label>
        )}
        {kind.mode === 'push' && (
          <label className="field">Forget items that have not been refreshed for (hours)<input className="input" type="number" min={1} max={720} value={ttlHours} onChange={(e) => setTtlHours(Number(e.target.value))} />
            <span className="muted small">So a tool that stops sending cannot leave a problem open forever. Tools that send a resolved message close their own problems sooner.</span></label>
        )}
        {editing && <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Enabled</label>}
        {need.length > 0 && <p className="muted small">Still needed: {need.map((f) => f.label).join(', ')}.</p>}
        {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}{canForce && <> <b>Save anyway</b> keeps the source; it will show as unreachable until it works.</>}</span></div>}
        {res && <div className={`callout ${res.ok ? '' : 'err'}`} role="status"><Icon name={res.ok ? 'check' : 'alert'} size={16} /><span><b>{res.ok ? 'Looks good.' : 'Could not read it.'}</b> {res.message}</span></div>}
        {editing && source?.kind === 'webhook' && <Badge tone="gray">Use New secret on the Alerts and sources page to issue a new secret.</Badge>}
      </div>
    </Modal>
  );
}
