import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { Badge, Icon, Modal, Spinner } from './ui';
import { CodeBlock } from './ui-more';
import { Logo } from './ServiceForm';
import { useToast } from '../hooks';
import type { MonSource, SourceKind } from '../types';

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

/** "Connect a source" / "Edit source": pick a kind, fill what it needs, test it, save. */
export function SourceForm({ kinds, source, initialKind, onClose, onSaved }: { kinds: SourceKind[]; source?: MonSource; initialKind?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = !!source;
  const [kindId, setKindId] = useState(source?.kind ?? initialKind ?? '');
  const kind = kinds.find((k) => k.kind === kindId);
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

  const body = (force = false) => ({ ...vals, kind: kindId, id: source?.id, name: name.trim() || kind?.label, enabled, intervalS, ttlHours, ...(force ? { force: true } : {}) });
  const missing = !!kind && kind.fields.some((f) => f.required && !(vals[f.name] ?? '').trim() && !(f.type === 'secret' && saved.has(f.name)));

  async function test() {
    setBusy('test'); setErr(''); setRes(null);
    try { setRes(await api.testMonitoringSource(body())); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }
  const stillNeeded = kind ? kind.fields.filter((f) => f.required && !(vals[f.name] ?? '').trim() && !(f.type === 'secret' && saved.has(f.name))).map((f) => f.label) : [];
  async function save(force = false) {
    setBusy('save'); setErr(''); setCanForce(false); setRes(null);
    try {
      if (editing) { await api.editMonitoringSource(source!.id, body(force)); toast.success(`${name || kind?.label} saved`); onSaved(); onClose(); }
      else {
        const r = await api.addMonitoringSource(body(force));
        onSaved();
        if (r.secret && r.hookPath) setCreated({ path: r.hookPath, secret: r.secret }); else { toast.success(`${name || kind?.label} connected`); onClose(); }
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
        <p className="muted small">homedash can read these tools, or be told about problems by any tool that can send a web request.</p>
        <div className="kind-grid">
          {kinds.map((k) => (
            <button key={k.kind} className="kind-pick" onClick={() => { setKindId(k.kind); setName(k.label); }}>
              <Logo kind={k.kind} label={k.label} /><span>{k.label}<br /><small className="muted">{k.summary}</small></span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal key="form" title={`${editing ? 'Edit' : 'Connect'} ${kind.label}`} wide onClose={busy ? () => undefined : onClose} footer={
      <>
        {!editing && <button className="btn" onClick={() => { setKindId(''); setRes(null); setErr(''); }} disabled={!!busy}>Back</button>}
        <button className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {kind.mode === 'pull' && <button className="btn" onClick={test} disabled={missing || !!busy}>{busy === 'test' ? <Spinner size={14} /> : <Icon name="pulse" size={15} />}Test</button>}
        {canForce && <button className="btn" onClick={() => save(true)} disabled={!!busy}>Save anyway</button>}
        <button className="btn btn-primary" onClick={() => save()} disabled={missing || !!busy}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" size={15} />}{editing ? 'Save' : kind.mode === 'push' ? 'Create' : 'Connect'}</button>
      </>
    }>
      <div className="stack-sm">
        <p className="muted small">{kind.hint}</p>
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
        <div className="form-grid">
          {kind.fields.map((f) => (
            <label className="field" key={f.name}>
              {f.label}{!f.required && <span className="muted small"> (optional)</span>}
              <input className={`input ${f.type === 'url' ? 'mono' : ''}`} type={f.type === 'secret' ? 'password' : 'text'} autoComplete={f.type === 'secret' ? 'new-password' : 'off'}
                onKeyDown={(e) => { if (e.key === 'Enter' && !missing && !busy) { e.preventDefault(); save(); } }}
                value={vals[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}
                placeholder={f.type === 'secret' && saved.has(f.name) ? 'Saved. Leave blank to keep it.' : /For example (\S+)/.exec(f.hint ?? '')?.[1] ?? (f.type === 'url' ? 'http://192.168.1.20' : '')} />
              {f.hint && <span className="muted small">{f.hint}</span>}
            </label>
          ))}
        </div>
        {kind.mode === 'pull' && kind.kind !== 'kuma' && kind.kind !== 'grafana' && (
          <label className="field">Read every (seconds)<input className="input" type="number" min={15} max={3600} value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))} /></label>
        )}
        {kind.mode === 'push' && (
          <label className="field">Forget items that have not been refreshed for (hours)<input className="input" type="number" min={1} max={720} value={ttlHours} onChange={(e) => setTtlHours(Number(e.target.value))} />
            <span className="muted small">So a tool that stops sending cannot leave a problem open forever. Tools that send a resolved message close their own problems sooner.</span></label>
        )}
        {editing && <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Enabled</label>}
        {stillNeeded.length > 0 && <p className="muted small">Still needed: {stillNeeded.join(', ')}.</p>}
        {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}{canForce && <> <b>Save anyway</b> keeps the source; it will show as unreachable until it works.</>}</span></div>}
        {res && <div className={`callout ${res.ok ? '' : 'err'}`} role="status"><Icon name={res.ok ? 'check' : 'alert'} size={16} /><span><b>{res.ok ? 'Looks good.' : 'Could not read it.'}</b> {res.message}</span></div>}
        {editing && source?.kind === 'webhook' && <Badge tone="gray">Use New secret on the Alerts and sources page to issue a new secret.</Badge>}
      </div>
    </Modal>
  );
}
