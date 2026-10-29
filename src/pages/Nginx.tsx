import { useEffect, useState } from 'react';
import { api } from '../api';
import { Async, Badge, Chips, HoldButton, Icon, Modal, PageHeader, Spinner } from '../components/ui';
import type { Tone } from '../components/ui';
import { hostOf } from '../format';
import { useQuery, useSearch, useToast } from '../hooks';
import type { KumaMonitor, NginxDetail, NginxSite, NginxSpec } from '../types';

type Filter = 'all' | 'ssl' | 'nossl' | 'proxy' | 'static';

function monitorFor(site: NginxSite, monitors: KumaMonitor[] | undefined): KumaMonitor | undefined {
  if (!monitors) return undefined;
  const names = site.serverNames.map((n) => n.toLowerCase());
  return monitors.find((m) => names.includes(hostOf(m.url)) || names.some((n) => m.name.toLowerCase() === n.split('.')[0]));
}
const TONE: Record<string, Tone> = { up: 'green', down: 'red', pending: 'amber', maintenance: 'blue' };

function certBadge(d: NginxDetail | undefined) {
  if (!d?.certExpires) return null;
  const days = Math.floor((Date.parse(d.certExpires) - Date.now()) / 86_400_000);
  const tone: Tone = days < 0 ? 'red' : days < 14 ? 'red' : days < 30 ? 'amber' : 'green';
  return <Badge tone={tone} title={`Certificate ${d.cert}`}>{days < 0 ? 'cert expired' : `cert ${days}d`}</Badge>;
}

const EMPTY: NginxSpec = { serverNames: [], upstream: '', websocket: true, tls: 'none', redirectHttp: true, hsts: false, maxBody: '' };

export function NewSiteModal({ initial, onClose, onDone }: { initial?: Partial<NginxSpec>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [spec, setSpec] = useState<NginxSpec>({ ...EMPTY, ...initial });
  const [names, setNames] = useState((initial?.serverNames ?? []).join(' '));
  const [preview, setPreview] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const full: NginxSpec = { ...spec, serverNames: names.split(/[\s,]+/).filter(Boolean), maxBody: spec.maxBody || undefined };

  useEffect(() => {
    if (!full.serverNames.length || !full.upstream) { setPreview(''); setErr(''); return; }
    const t = setTimeout(() => api.nginxPreview(full).then((r) => { setPreview(r.content); setErr(''); }).catch((e: Error) => { setPreview(''); setErr(e.message); }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(full)]);

  async function create() {
    setBusy(true);
    try {
      const r = await api.nginxCreate(full);
      toast.success(`${r.file} created${r.reloaded ? ' and nginx reloaded' : ''}`);
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const set = <K extends keyof NginxSpec>(k: K, v: NginxSpec[K]) => setSpec((x) => ({ ...x, [k]: v }));

  return (
    <Modal wide title="New reverse-proxy site" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !preview} onClick={create}>{busy ? <Spinner /> : null}Test and apply</button>
      </>}>
      <div className="form-grid">
        <label className="full">Domain name(s)<small>Space separated, e.g. app.home.lan</small>
          <input className="input" value={names} onChange={(e) => setNames(e.target.value)} placeholder="app.home.lan" autoFocus /></label>
        <label className="full">Upstream<small>Where the app listens, e.g. http://192.168.1.50:8080</small>
          <input className="input mono" value={spec.upstream} onChange={(e) => set('upstream', e.target.value.trim())} placeholder="http://192.168.1.50:8080" /></label>
        <label>HTTPS
          <select className="input" value={spec.tls} onChange={(e) => set('tls', e.target.value as NginxSpec['tls'])}>
            <option value="none">Off (HTTP only)</option><option value="selfsigned">Self-signed certificate</option><option value="existing">Existing certificate files</option>
          </select></label>
        <label>Max upload size<small>Optional, e.g. 50m</small><input className="input" value={spec.maxBody ?? ''} onChange={(e) => set('maxBody', e.target.value.trim())} placeholder="1m" /></label>
        {spec.tls === 'existing' && (<>
          <label>Certificate path<input className="input mono" value={spec.certPath ?? ''} onChange={(e) => set('certPath', e.target.value.trim())} placeholder="/etc/ssl/certs/app.crt" /></label>
          <label>Key path<input className="input mono" value={spec.keyPath ?? ''} onChange={(e) => set('keyPath', e.target.value.trim())} placeholder="/etc/ssl/private/app.key" /></label>
        </>)}
        <label className="check"><input type="checkbox" checked={!!spec.websocket} onChange={(e) => set('websocket', e.target.checked)} />WebSocket support</label>
        {spec.tls !== 'none' && <label className="check"><input type="checkbox" checked={spec.redirectHttp !== false} onChange={(e) => set('redirectHttp', e.target.checked)} />Redirect HTTP to HTTPS</label>}
        {spec.tls !== 'none' && <label className="check"><input type="checkbox" checked={!!spec.hsts} onChange={(e) => set('hsts', e.target.checked)} />Send HSTS header</label>}
        <div className="full field">Generated config<small>This is exactly what will be written. It is tested with <code>nginx -t</code> first and rolled back if the test fails.</small>
          <pre className="codebox">{preview || '# fill in a domain and an upstream to preview'}</pre></div>
        {err && <div className="callout err full" role="alert"><Icon name="alert" size={16} /><span style={{ whiteSpace: 'pre-wrap' }}>{err}</span></div>}
      </div>
    </Modal>
  );
}

function ConfigModal({ file, canEdit, onClose, onDone }: { file: string; canEdit: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery(() => api.nginxFile(file), [file]);
  const backups = useQuery(() => api.nginxBackups(file), [file]);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const body = text ?? q.data?.content ?? '';

  async function run(fn: () => Promise<{ reloaded: boolean }>, ok: string) {
    setBusy(true); setErr('');
    try { const r = await fn(); toast.success(`${ok}${r.reloaded ? ', nginx reloaded' : ''}`); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal wide title={file} onClose={onClose} footer={
      <>
        {canEdit && <HoldButton danger onConfirm={() => run(() => api.nginxDelete(file), `${file} deleted`)}>Hold to delete</HoldButton>}
        <button className="btn" onClick={onClose}>Close</button>
        {canEdit && <button className="btn btn-primary" disabled={busy || text === null} onClick={() => run(() => api.nginxSave(file, body), `${file} saved`)}>{busy ? <Spinner /> : null}Test and save</button>}
      </>}>
      {q.loading && !q.data ? <Spinner /> : (
        <>
          <textarea className="codebox" spellCheck={false} readOnly={!canEdit} value={body} onChange={(e) => setText(e.target.value)} aria-label={`Contents of ${file}`} />
          {!canEdit && <p className="muted small">Read-only. Set <code>NGINX_MANAGE=true</code> in the .env to edit sites here.</p>}
          {canEdit && !!backups.data?.length && (
            <label className="field">Restore a previous version
              <select className="input" defaultValue="" onChange={(e) => e.target.value && run(() => api.nginxRestore(file, e.target.value), 'Restored')}>
                <option value="">Choose a backup…</option>{backups.data.map((b) => <option key={b} value={b}>{b.slice(file.length + 1).replace('T', ' ').slice(0, 19)}</option>)}
              </select></label>
          )}
          {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span style={{ whiteSpace: 'pre-wrap' }}>{err}</span></div>}
        </>
      )}
    </Modal>
  );
}

export default function Nginx() {
  const q = useQuery(api.nginx, [], 0);
  const kuma = useQuery(api.monitors, [], 15000);
  const manage = useQuery(api.nginxManage, []);
  const details = useQuery(api.nginxDetails, [], 60000);
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const canEdit = !!manage.data?.enabled;
  const detail = (f: string) => details.data?.find((d) => d.file === f);
  const refresh = () => { q.reload(); details.reload(); setCreating(false); setOpen(null); };
  async function reloadNginx() {
    try { await api.nginxReload(); toast.success('nginx reloaded'); } catch (e) { toast.error((e as Error).message); }
  }
  const { q: search } = useSearch();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  return (
    <>
      <PageHeader title="Nginx sites" sub={canEdit ? `Manage reverse proxies in ${manage.data?.dir}. ${manage.data?.version ?? ''}` : 'Read-only view of sites-enabled. Set NGINX_MANAGE=true to create and edit sites here.'} actions={
        <>
        {canEdit && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="check" size={15} />New site</button>}
        {canEdit && <button className="btn btn-sm" onClick={reloadNginx}><Icon name="refresh" size={15} />Test and reload</button>}
        <div className="seg">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-label="Card view"><Icon name="grid" size={16} /></button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label="Table view"><Icon name="list" size={16} /></button>
        </div>
        </>
      } />
      {creating && <NewSiteModal onClose={() => setCreating(false)} onDone={refresh} />}
      {open && <ConfigModal file={open} canEdit={canEdit} onClose={() => setOpen(null)} onDone={refresh} />}
      <Async q={q} rows={4} h={120} isEmpty={(d) => d.length === 0} empty={{ title: 'No sites enabled', hint: 'sites-enabled is empty or not mounted.' }}>
        {(sites) => {
          const s = search.trim().toLowerCase();
          const rows = sites.filter((x) => {
            if (filter === 'ssl' && !x.ssl) return false;
            if (filter === 'nossl' && x.ssl) return false;
            if (filter === 'proxy' && !x.upstream) return false;
            if (filter === 'static' && x.upstream) return false;
            return !s || `${x.file} ${x.serverNames.join(' ')} ${x.upstream ?? ''} ${x.root ?? ''}`.toLowerCase().includes(s);
          });
          return (
            <>
              <div className="toolbar">
                <Chips value={filter} onChange={setFilter} options={[
                  { id: 'all', label: 'All', count: sites.length }, { id: 'ssl', label: 'SSL', count: sites.filter((x) => x.ssl).length },
                  { id: 'nossl', label: 'No SSL', count: sites.filter((x) => !x.ssl).length },
                  { id: 'proxy', label: 'Proxy', count: sites.filter((x) => x.upstream).length }, { id: 'static', label: 'Static', count: sites.filter((x) => !x.upstream).length },
                ]} />
              </div>
              {rows.length === 0 ? (
                <div className="card pad"><div className="empty"><div className="empty-ic"><Icon name="search" size={22} /></div><strong>No sites match</strong><p className="muted small">Try a different search or filter.</p></div></div>
              ) : view === 'grid' ? (
                <div className="site-grid">
                  {rows.map((x) => {
                    const m = monitorFor(x, kuma.data);
                    return (
                      <a key={x.file} className="site" href={x.url} target="_blank" rel="noopener noreferrer">
                        <div className="site-top">
                          <div className={`site-ic ${x.ssl ? 'ssl' : ''}`}><Icon name={x.ssl ? 'lock' : 'unlock'} size={18} /></div>
                          <div className="grow">
                            <b>{x.serverNames[0]}</b>
                            {x.serverNames.length > 1 && <small className="muted">+ {x.serverNames.slice(1).join(', ')}</small>}
                          </div>
                          <Icon name="external" size={15} />
                        </div>
                        <div className="site-badges">
                          <Badge tone={x.ssl ? 'green' : 'amber'}>{x.ssl ? 'SSL on' : 'SSL off'}</Badge>
                          {m && <Badge tone={TONE[m.status]} dot title={`Uptime Kuma: ${m.name}`}>{m.status}</Badge>}
                          {certBadge(detail(x.file))}
                          {detail(x.file)?.managed && <Badge tone="blue">managed</Badge>}
                          <button className="btn btn-sm btn-ghost" onClick={(e) => { e.preventDefault(); setOpen(x.file); }}>Config</button>
                        </div>
                        <dl>
                          <div><dt>Listen</dt><dd>{x.listen.join(', ')}</dd></div>
                          <div><dt>{x.upstream ? 'Upstream' : 'Root'}</dt><dd className="mono">{x.upstream ?? x.root ?? '–'}</dd></div>
                          <div><dt>File</dt><dd className="mono">{x.file}</dd></div>
                        </dl>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <div className="card table">
                  <div className="n-row g-head"><span>Site</span><span>SSL</span><span>Monitor</span><span>Listen</span><span>Upstream / root</span><span>File</span></div>
                  {rows.map((x) => {
                    const m = monitorFor(x, kuma.data);
                    return (
                      <a key={x.file} className="n-row" href={x.url} target="_blank" rel="noopener noreferrer">
                        <span><b>{x.serverNames.join(', ')}</b></span>
                        <span><Badge tone={x.ssl ? 'green' : 'amber'}>{x.ssl ? 'On' : 'Off'}</Badge></span>
                        <span>{m ? <Badge tone={TONE[m.status]} dot>{m.status}</Badge> : <span className="muted">–</span>}</span>
                        <span className="muted">{x.listen[0]}</span>
                        <span className="mono">{x.upstream ?? x.root ?? '–'}</span>
                        <span className="mono muted">{x.file} {certBadge(detail(x.file))} <button className="btn btn-sm btn-ghost" onClick={(e) => { e.preventDefault(); setOpen(x.file); }}>Config</button></span>
                      </a>
                    );
                  })}
                </div>
              )}
            </>
          );
        }}
      </Async>
    </>
  );
}
