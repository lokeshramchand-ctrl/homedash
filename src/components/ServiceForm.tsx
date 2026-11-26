import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Icon, Modal, Spinner } from './ui';
import { useToast } from '../hooks';
import type { TileCatalog, TileKind, TileStat } from '../types';

export interface Draft {
  id?: string; kind: string; name: string; url: string; publicUrl: string; group: string;
  token: string; username: string; password: string; ups: string; insecureTls: boolean;
  hasToken?: boolean; hasPassword?: boolean;
}
export const emptyDraft = (kind = '', url = ''): Draft => ({ kind, name: '', url, publicUrl: '', group: '', token: '', username: '', password: '', ups: '', insecureTls: false });

const FIELD_LABEL: Record<string, string> = { token: 'API key / token', username: 'User name', password: 'Password', ups: 'UPS name' };
const urlFor = (k: TileKind) => `${k.kind === 'nut' ? 'tcp' : k.https ? 'https' : 'http'}://`;

interface TestResult { state: string; summary?: string; stats?: TileStat[]; ms: number | null; error?: string }

/** "Add service" / "Edit service": pick a kind, fill what it needs, test it, save. */
export function ServiceForm({ catalog, draft, onClose, onSaved }: { catalog: TileCatalog; draft: Draft; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(draft);
  const [pick, setPick] = useState(d.kind === '');
  const [res, setRes] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [err, setErr] = useState('');
  const kind = catalog.kinds.find((k) => k.kind === d.kind);
  const editing = !!d.id;
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setRes(null); };

  const groups = useMemo(() => {
    const m = new Map<string, TileKind[]>();
    for (const k of catalog.kinds) m.set(k.category, [...(m.get(k.category) ?? []), k]);
    return [...m];
  }, [catalog]);

  useEffect(() => { setErr(''); }, [d.kind]);

  const body = () => ({ ...d, kind: d.kind });
  async function test() {
    setBusy('test'); setErr(''); setRes(null);
    try { setRes(await api.testTile(body())); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }
  async function save() {
    setBusy('save'); setErr('');
    try {
      if (editing) await api.editTile(d.id!, body()); else await api.addTile(body());
      toast.success(`${d.name || kind?.label} saved`);
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  if (pick || !kind) {
    return (
      <Modal title="Add a service" wide onClose={onClose} footer={<button className="btn" onClick={onClose}>Cancel</button>}>
        <p className="muted small">Pick what you want to watch. You will need its address and, for most, an API key or login.</p>
        {groups.map(([cat, list]) => (
          <section key={cat}>
            <h4 className="svc-group">{cat}</h4>
            <div className="kind-grid">
              {list.map((k) => (
                <button key={k.kind} className="kind-pick" onClick={() => { setD((x) => ({ ...x, kind: k.kind, name: x.name || k.label, url: x.url || (k.ports[0] ? `${urlFor(k)}host:${k.ports[0]}` : urlFor(k)) })); setPick(false); }}>
                  <Logo kind={k.kind} label={k.label} /><span>{k.label}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </Modal>
    );
  }

  const optional = kind.optional;
  const show = (f: string) => kind.needs.includes(f as never) || optional.includes(f as never);
  const required = (f: string) => kind.needs.includes(f as never);
  const missing = kind.needs.some((f) => !(d as unknown as Record<string, string>)[f] && !((f === 'token' && d.hasToken) || (f === 'password' && d.hasPassword)));
  const canSave = !!d.url && !missing && !busy;

  return (
    <Modal title={`${editing ? 'Edit' : 'Add'} ${kind.label}`} wide onClose={busy ? () => undefined : onClose} footer={
      <>
        {!editing && <button className="btn" onClick={() => setPick(true)} disabled={!!busy}>Back</button>}
        <button className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        <button className="btn" onClick={test} disabled={!canSave}>{busy === 'test' ? <Spinner size={14} /> : <Icon name="pulse" size={15} />}Test</button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" size={15} />}Save</button>
      </>
    }>
      <div className="stack-sm">
        <p className="muted small">{kind.hint}</p>
        <div className="form-grid">
          <label className="field">Name<input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={40} /></label>
          <label className="field">Group <span className="muted small">(optional)</span><input className="input" value={d.group} onChange={(e) => set({ group: e.target.value })} maxLength={30} placeholder="Media, Network…" /></label>
        </div>
        <label className="field">Address (as homedash reaches it)<input className="input mono" value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder={`${urlFor(kind)}192.168.1.20${kind.ports[0] ? `:${kind.ports[0]}` : ''}`} /></label>
        <div className="form-grid">
          {show('username') && <label className="field">{FIELD_LABEL.username}{!required('username') && <span className="muted small"> (optional)</span>}<input className="input" value={d.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" /></label>}
          {show('password') && <label className="field">{FIELD_LABEL.password}{!required('password') && <span className="muted small"> (optional)</span>}<input className="input" type="password" value={d.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={d.hasPassword ? '•••••• (kept unless you type a new one)' : ''} /></label>}
          {show('token') && <label className="field">{FIELD_LABEL.token}{!required('token') && <span className="muted small"> (optional)</span>}<input className="input" type="password" value={d.token} onChange={(e) => set({ token: e.target.value })} autoComplete="new-password" placeholder={d.hasToken ? '•••••• (kept unless you type a new one)' : ''} /></label>}
          {show('ups') && <label className="field">{FIELD_LABEL.ups}<input className="input" value={d.ups} onChange={(e) => set({ ups: e.target.value })} placeholder="ups" /></label>}
        </div>
        <label className="field">Link people click <span className="muted small">(optional, the address in your browser)</span><input className="input mono" value={d.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} placeholder="https://jellyfin.example.lan" /></label>
        {d.url.startsWith('https://') && <label className="check"><input type="checkbox" checked={d.insecureTls} onChange={(e) => set({ insecureTls: e.target.checked })} />Accept a self-signed certificate</label>}
        {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}</span></div>}
        {res && (
          <div className={`callout ${res.state === 'down' ? 'err' : res.state === 'warn' ? 'warn' : ''}`} role="status">
            <Icon name={res.state === 'down' ? 'alert' : 'check'} size={16} />
            <span>
              {res.state === 'down' ? <><b>Could not connect.</b> {res.error}</> : <><b>Connected{res.ms != null ? ` in ${res.ms} ms` : ''}.</b> {res.summary}</>}
              {res.stats && res.stats.length > 0 && <span className="test-stats">{res.stats.slice(0, 6).map((s) => <Badge key={s.label} tone={s.tone === 'bad' ? 'red' : s.tone === 'warn' ? 'amber' : 'gray'}>{s.label}: {s.value}</Badge>)}</span>}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

const PALETTE = ['#ed272e', '#0870b9', '#3eb850', '#5a6fc9', '#0b7a8c', '#c27a16', '#8a4fbf', '#d1457f'];
/** A flat coloured monogram: no image files, no third-party requests, works under the strict CSP. */
export function Logo({ kind, label, size = 34 }: { kind: string; label: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  const initials = label.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  return <span className="svc-logo" style={{ width: size, height: size, background: PALETTE[h % PALETTE.length], fontSize: size * 0.4 }} aria-hidden="true">{initials}</span>;
}
