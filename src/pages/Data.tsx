import { useEffect, useMemo, useState } from 'react';
import { dataApi } from '../api';
import { ActivityTab, BrowseTab, QueryTab, SearchTab, ServerTab, StructureTab } from '../components/DataTabs';
import type { Ctx } from '../components/DataTabs';
import { KV } from '../components/Pve';
import { Async, Badge, Card, CardHead, Chips, EmptyState, ErrorState, HoldButton, Icon, Modal, PageHeader, Skeleton, Spinner } from '../components/ui';
import { timeAgo } from '../format';
import { useQuery, useSearch, useToast } from '../hooks';
import type { DbInput, DbKind, DbKindInfo, DbSource } from '../types';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const enc = encodeURIComponent;
const bytes = (n?: number) => {
  if (n === undefined) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${u[i]}`;
};
const KIND_TONE: Record<DbKind, 'green' | 'red' | 'blue' | 'amber' | 'violet'> = { mongodb: 'green', redis: 'red', postgres: 'blue', mysql: 'amber', sqlite: 'violet', mssql: 'red', milvus: 'blue' };

// ------------------------------------------------------------------------------------------ connection form
function ConnectionModal({ kinds, existing, onClose, onSaved }: { kinds: DbKindInfo[]; existing?: DbSource; onClose: () => void; onSaved: (s: DbSource) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<DbKind>(existing?.kind ?? 'postgres');
  const info = kinds.find((k) => k.kind === kind)!;
  const c = existing?.config;
  const [f, setF] = useState({
    name: existing?.name ?? '', host: c?.host ?? '', port: c?.port ? String(c.port) : '', database: c?.database ?? '', username: c?.username ?? '', password: '',
    uri: '', tls: c?.tls ?? false, tlsInsecure: c?.tlsInsecure ?? false, ca: '', file: c?.file ?? '', readOnly: existing?.readOnly ?? true, clearPassword: false, token: '', clearToken: false,
  });
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (p: Partial<typeof f>) => { setF((x) => ({ ...x, ...p })); setTest(null); };
  const has = (n: string) => info.fields.includes(n);

  const body = (): DbInput => {
    const b: DbInput = { name: f.name, kind, readOnly: f.readOnly, host: f.host, port: f.port, database: f.database, username: f.username, tls: f.tls, tlsInsecure: f.tlsInsecure, file: f.file };
    if (f.password) b.password = f.password;
    if (f.clearPassword) b.clearPassword = true;
    if (f.token) b.token = f.token;
    if (f.clearToken) b.clearToken = true;
    if (f.uri) b.uri = f.uri;
    if (f.ca) b.ca = f.ca;
    return b;
  };
  async function doTest() {
    setBusy(true); setTest(null);
    try { const r = await dataApi.test({ ...body(), id: existing?.id }); setTest({ ok: true, text: `${r.version} · ${r.ms} ms` }); } catch (e) { setTest({ ok: false, text: errText(e) }); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    try { onSaved(existing ? await dataApi.update(existing.id, body()) : await dataApi.create(body())); toast.success(existing ? 'Connection updated' : 'Connection added'); onClose(); } catch (e) { toast.error(errText(e)); setBusy(false); }
  }

  return (
    <Modal wide title={existing ? `Edit ${existing.name}` : 'Add connection'} onClose={onClose} footer={
      <>
        {test && <span className={`small ${test.ok ? 'ok-t' : 'err-t'}`} style={{ marginRight: 'auto', maxWidth: 380 }}>{test.ok ? '✓ ' : ''}{test.text}</span>}
        <button className="btn" onClick={doTest} disabled={busy}>{busy ? <Spinner size={14} /> : <Icon name="zap" size={14} />}Test</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !f.name.trim()}>Save</button>
      </>
    }>
      <div className="dm-form">
        <label>Name<input className="input" autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. prod-postgres" /></label>
        {!existing && (
          <div className="dm-kinds" role="radiogroup" aria-label="Database type">
            {kinds.map((k) => <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => { setKind(k.kind); setTest(null); }}>{k.label}</button>)}
          </div>
        )}
        {has('uri') && <label>Connection URI <span className="muted">(optional, replaces the fields below)</span><input className="input mono" value={f.uri} onChange={(e) => set({ uri: e.target.value })} placeholder={existing?.config.uriMasked ?? info.uriExample} autoComplete="off" /></label>}
        {has('file') ? (
          <label>Database file<input className="input mono" value={f.file} onChange={(e) => set({ file: e.target.value })} placeholder="/srv/data/app.db" /><small className="muted">Must be inside a directory the server allows (DATASOURCE_SQLITE_DIRS).</small></label>
        ) : (
          <div className="dm-form-row">
            <label style={{ flex: 3 }}>Host<input className="input mono" value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="10.10.10.x" /></label>
            <label style={{ flex: 1 }}>Port<input className="input mono" value={f.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} placeholder={String(info.defaultPort ?? '')} /></label>
          </div>
        )}
        {has('database') && <label>{info.databaseLabel ?? 'Database'}<input className="input mono" value={f.database} onChange={(e) => set({ database: e.target.value })} placeholder={info.databaseHint} /></label>}
        {has('username') && (
          <div className="dm-form-row">
            <label>Username<input className="input mono" value={f.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" /></label>
            <label>Password{existing?.config.hasPassword && <span className="muted"> (saved)</span>}<input className="input mono" type="password" value={f.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={existing?.config.hasPassword ? '•••••• leave blank to keep' : ''} /></label>
          </div>
        )}
        {existing?.config.hasPassword && has('username') && <label className="dm-check"><input type="checkbox" checked={f.clearPassword} onChange={(e) => set({ clearPassword: e.target.checked })} />Remove the saved password</label>}
        {has('token') && <label>API token{existing?.config.hasToken && <span className="muted"> (saved)</span>}<input className="input mono" type="password" value={f.token} onChange={(e) => set({ token: e.target.value })} autoComplete="new-password" placeholder={existing?.config.hasToken ? '•••••• leave blank to keep' : 'optional, replaces username/password'} /></label>}
        {existing?.config.hasToken && has('token') && <label className="dm-check"><input type="checkbox" checked={f.clearToken} onChange={(e) => set({ clearToken: e.target.checked })} />Remove the saved token</label>}
        {has('tls') && (
          <div className="dm-form">
            <div className="dm-form-row" style={{ alignItems: 'center' }}>
              <label className="dm-check"><input type="checkbox" checked={f.tls} onChange={(e) => set({ tls: e.target.checked })} />Use TLS</label>
              {f.tls && <label className="dm-check"><input type="checkbox" checked={f.tlsInsecure} onChange={(e) => set({ tlsInsecure: e.target.checked })} />Skip certificate check</label>}
            </div>
            {f.tls && <label>CA certificate (PEM) {existing?.config.hasCa && <span className="muted">(saved; paste to replace)</span>}<textarea className="input mono" rows={3} value={f.ca} onChange={(e) => set({ ca: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" /></label>}
          </div>
        )}
        <label className="dm-check dm-ro">
          <input type="checkbox" checked={f.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
          <span><b>Read-only</b> — browse and query only. SQL runs in read-only transactions, so the database refuses writes.{!f.readOnly && <Badge tone="red">writes enabled</Badge>}</span>
        </label>
        <p className="muted small">Passwords are encrypted at rest and never sent back to the browser. For least privilege, give the dashboard a database user that only has the rights you want it to use.</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ audit
function AuditPane() {
  const q = useQuery(dataApi.audit, [], 15_000);
  return (
    <Async q={q} rows={5} h={36} isEmpty={(d) => d.length === 0} empty={{ title: 'No activity yet', hint: 'Queries, writes and connection changes are recorded here for 180 days.' }}>
      {(rows) => (
        <Card pad={false}>
          <div className="dm-grid"><table>
            <thead><tr><th>When</th><th>User</th><th>Connection</th><th>Action</th><th>Detail</th><th>Result</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}><td title={new Date(r.ts).toLocaleString()}>{timeAgo(r.ts)}</td><td>{r.user}</td><td>{r.connection}</td><td className="mono">{r.action}</td><td className="mono dm-detail" title={r.detail}>{r.detail}</td>
                <td><Badge tone={r.result === 'ok' ? 'green' : r.result === 'refused' ? 'amber' : 'red'} dot>{r.result}</Badge></td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
    </Async>
  );
}

// ------------------------------------------------------------------------------------------ workspace for one connection
function Workspace({ src, tab, ns, entity, onEdit }: { src: DbSource; tab: string; ns: string; entity: string; onEdit: () => void }) {
  const ov = useQuery(() => dataApi.overview(src.id), [src.id, src.updatedAt]);
  const nsq = useQuery(() => dataApi.namespaces(src.id), [src.id, src.updatedAt]);
  const entq = useQuery(() => (ns ? dataApi.entities(src.id, ns) : Promise.resolve([])), [src.id, ns, src.updatedAt]);
  const desc = useQuery(() => (entity ? dataApi.describe(src.id, ns, entity) : Promise.resolve(undefined)), [src.id, ns, entity]);
  const { q: search } = useSearch();
  const base = `#/data/${enc(src.id)}`;

  if (ov.data === undefined) {
    if (ov.error) return (
      <Card><ErrorState error={ov.error} onRetry={ov.reload} /><div style={{ textAlign: 'center', paddingBottom: 18 }}>{src.managed ? <p className="muted small">Defined in the server .env as <span className="mono">DS_{src.envId}_*</span>. Fix it there and restart the dashboard.</p> : <button className="btn" onClick={onEdit}><Icon name="edit" size={14} />Edit connection</button>}</div></Card>
    );
    return <Skeleton rows={3} h={70} />;
  }
  const o = ov.data;
  const ctx: Ctx = { id: src.id, ns, entity, ov: o };
  const tabs = entity
    ? [['browse', 'Browse'], ['structure', 'Structure'], ...(o.caps.search ? [['search', o.caps.search.label]] : []), ['query', 'Query'], ['server', 'Server'], ['activity', 'Activity']]
    : [['overview', 'Overview'], ['query', 'Query'], ['server', 'Server'], ['activity', 'Activity']];
  const cur = tabs.some(([t]) => t === tab) ? tab : tabs[0][0];
  const tail = `${ns ? `/${enc(ns)}` : ''}${entity ? `/${enc(entity)}` : ''}`;
  const needle = search.trim().toLowerCase();

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="dm-head">
        <div>
          <h2>{src.name}{entity ? <span className="muted"> / {ns && ns !== 'main' ? `${ns} / ` : ''}{entity}</span> : ns ? <span className="muted"> / {ns}</span> : null}</h2>
          <p className="muted small">{o.version} · {o.ms} ms · {o.readOnly ? 'read-only' : 'read-write'}</p>
        </div>
        <div className="dm-head-r">
          {o.readOnly ? <Badge tone="gray">read-only</Badge> : <Badge tone="red" dot>read-write</Badge>}
          {src.managed ? <Badge tone="gray">from .env</Badge> : <button className="icon-btn" onClick={onEdit} aria-label="Edit connection" title="Edit connection"><Icon name="edit" size={16} /></button>}
        </div>
      </div>
      <Chips value={cur} onChange={(t) => { location.hash = `${base}/${t}${tail}`; }} options={tabs.map(([id, label]) => ({ id, label }))} />

      {cur === 'overview' && (
        !ns ? (
          <Async q={nsq} rows={3} h={52} isEmpty={(d) => d.length === 0} empty={{ title: `No ${o.caps.namespaceLabel}s visible`, hint: 'This user may not be allowed to list them.' }}>
            {(list) => (
              <div className="dm-cards">
                {list.filter((n) => !needle || n.name.toLowerCase().includes(needle)).map((n) => (
                  <a key={n.name} className="card pad dm-card" href={`${base}/overview/${enc(n.name)}`}>
                    <b>{o.kind === 'redis' ? `db${n.name}` : n.name}</b>
                    <span className="muted small">{[n.entities !== undefined && `${n.entities.toLocaleString()} ${o.kind === 'redis' ? 'keys' : 'items'}`, bytes(n.sizeBytes)].filter(Boolean).join(' · ') || o.caps.namespaceLabel}</span>
                    {n.note && o.kind !== 'redis' && <span className="muted small">{n.note}</span>}
                  </a>
                ))}
              </div>
            )}
          </Async>
        ) : (
          <Async q={entq} rows={4} h={44} isEmpty={(d) => d.length === 0} empty={{ title: `No ${o.caps.entityLabel === 'keys' ? 'keys' : `${o.caps.entityLabel}s`} here`, hint: 'Create one with the Query tab.' }}>
            {(list) => (
              <Card pad={false}>
                <div className="dm-grid"><table>
                  <thead><tr><th>Name</th><th>Type</th><th>Rows</th><th>Size</th></tr></thead>
                  <tbody>{list.filter((e) => !needle || e.name.toLowerCase().includes(needle)).map((e) => (
                    <tr key={e.name} className="click" onClick={() => { location.hash = `${base}/browse/${enc(ns)}/${enc(e.name)}`; }}>
                      <td><b>{e.name}</b></td><td><Badge tone={e.kind === 'view' ? 'violet' : 'gray'}>{e.kind}</Badge></td>
                      <td>{e.rows === undefined ? '—' : `${e.approx ? '≈' : ''}${e.rows.toLocaleString()}`}</td><td>{bytes(e.sizeBytes) || '—'}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </Card>
            )}
          </Async>
        )
      )}
      {cur === 'browse' && <BrowseTab ctx={ctx} desc={desc.data} />}
      {cur === 'structure' && <StructureTab ctx={ctx} onDropped={() => { location.hash = `${base}/overview/${enc(ns)}`; }} />}
      {cur === 'search' && o.caps.search && <SearchTab ctx={ctx} />}
      {cur === 'query' && <QueryTab ctx={ctx} />}
      {cur === 'server' && <ServerTab id={src.id} />}
      {cur === 'activity' && <ActivityTab id={src.id} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ sidebar
function Tree({ srcs, id, ns, entity, onAdd }: { srcs: DbSource[]; id?: string; ns: string; entity: string; onAdd: () => void }) {
  const nsq = useQuery(() => (id ? dataApi.namespaces(id) : Promise.resolve([])), [id]);
  const entq = useQuery(() => (id && ns ? dataApi.entities(id, ns) : Promise.resolve([])), [id, ns]);
  const [flt, setFlt] = useState('');
  useEffect(() => setFlt(''), [id, ns]);
  const ents = useMemo(() => (entq.data ?? []).filter((e) => !flt || e.name.toLowerCase().includes(flt.toLowerCase())), [entq.data, flt]);
  return (
    <nav className="dm-tree" aria-label="Connections">
      <div className="dm-tree-head"><b>Connections</b><button className="icon-btn" onClick={onAdd} aria-label="Add connection" title="Add connection"><Icon name="plus" size={16} /></button></div>
      {srcs.map((s) => (
        <div key={s.id}>
          <a className={`dm-node ${id === s.id ? 'on' : ''}`} href={`#/data/${enc(s.id)}/overview`}>
            <span className={`dm-dot k-${KIND_TONE[s.kind] ?? 'none'}`} />{s.name}{!s.readOnly && <em title="read-write">rw</em>}{s.managed && <em className="env" title={`From .env (DS_${s.envId}_*)`}>env</em>}
          </a>
          {id === s.id && (
            <div className="dm-sub">
              {nsq.data === undefined && !nsq.error && <p className="muted small dm-pad"><Spinner size={12} /></p>}
              {nsq.error && <p className="err-t small dm-pad">{nsq.error.message}</p>}
              {nsq.data?.map((n) => (
                <div key={n.name}>
                  <a className={`dm-node sub ${ns === n.name ? 'on' : ''}`} href={`#/data/${enc(s.id)}/overview/${enc(n.name)}`}><Icon name="layers" size={13} />{s.kind === 'redis' ? `db${n.name}` : n.name}</a>
                  {ns === n.name && (
                    <div className="dm-sub">
                      {(entq.data?.length ?? 0) > 12 && <input className="input dm-mini" placeholder="Filter…" value={flt} onChange={(e) => setFlt(e.target.value)} />}
                      {entq.data === undefined && !entq.error && <p className="muted small dm-pad"><Spinner size={12} /></p>}
                      {ents.map((e) => <a key={e.name} className={`dm-node leaf ${entity === e.name ? 'on' : ''}`} href={`#/data/${enc(s.id)}/browse/${enc(n.name)}/${enc(e.name)}`} title={e.name}><Icon name="list" size={12} />{e.name}</a>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <a className={`dm-node ${id === 'audit' ? 'on' : ''}`} href="#/data/audit" style={{ marginTop: 10 }}><Icon name="tasks" size={13} />Audit log</a>
    </nav>
  );
}

// ------------------------------------------------------------------------------------------ page
export default function Data({ parts }: { parts: string[] }) {
  const st = useQuery(dataApi.status, []);
  const srcs = useQuery(() => (st.data?.configured ? dataApi.sources() : Promise.resolve([] as DbSource[])), [st.data?.configured]);
  const toast = useToast();
  const [modal, setModal] = useState<{ edit?: DbSource } | null>(null);
  const [delSrc, setDelSrc] = useState<DbSource | null>(null);

  const [id, tab = 'overview', ns = '', entity = ''] = parts;
  const sel = srcs.data?.find((s) => s.id === id);
  // With one saved connection and nothing chosen, open it.
  useEffect(() => { if (!id && srcs.data?.length === 1) location.hash = `#/data/${enc(srcs.data[0].id)}/overview`; }, [id, srcs.data]);

  async function remove(s: DbSource) {
    try { await dataApi.remove(s.id); toast.success(`${s.name} removed`); setDelSrc(null); location.hash = '#/data'; srcs.reload(); } catch (e) { toast.error(errText(e)); }
  }

  return (
    <>
      <PageHeader eyebrow="Services" title="Data" sub={`Browse, query and maintain ${st.data?.kinds.map((k) => k.label).join(', ').replace(/, ([^,]*)$/, ' and $1') ?? 'your databases'} from one place.`}
        actions={st.data?.configured && <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" size={15} />Add connection</button>} />
      <Async q={st} rows={3} h={80}>
        {(s) => !s.configured ? (
          <Card><EmptyState icon="key" title="Set an encryption key first" hint="Add DATASOURCE_KEY to server/.env (generate one with: openssl rand -base64 32) and restart the dashboard. Saved passwords are encrypted with it." /></Card>
        ) : (
          <Async q={srcs} rows={3} h={60}>
            {(list) => (
              <div className="dm">
                <Tree srcs={list} id={id} ns={ns} entity={entity} onAdd={() => setModal({})} />
                <div className="dm-main">
                  {id === 'audit' ? <AuditPane /> : sel ? (
                    <>
                      <Workspace key={sel.id} src={sel} tab={tab} ns={ns} entity={entity} onEdit={() => setModal({ edit: sel })} />
                      {tab === 'overview' && !ns && (
                        <Card><CardHead title="Connection" right={sel.managed ? <Badge tone="gray">from .env</Badge> : <button className="btn btn-danger btn-sm" onClick={() => setDelSrc(sel)}><Icon name="trash" size={13} />Remove</button>} />
                          <KV rows={[['Type', s.kinds.find((k) => k.kind === sel.kind)?.label], ['Address', <span className="mono">{sel.config.file ?? sel.config.uriMasked ?? `${sel.config.host}${sel.config.port ? `:${sel.config.port}` : ''}`}</span>],
                            ['User', sel.config.username ?? '—'], ['TLS', sel.config.tls ? (sel.config.tlsInsecure ? 'on, certificate not verified' : 'on') : 'off'], ['Mode', sel.readOnly ? 'read-only' : 'read-write'], ['Source', sel.managed ? <span>server .env, <span className="mono">DS_{sel.envId}_*</span></span> : 'added in the UI'], ['Updated', timeAgo(sel.updatedAt)]]} /></Card>
                      )}
                    </>
                  ) : list.length === 0 ? (
                    <Card><EmptyState icon="layers" title="No connections yet" hint="Add a database to browse its data, run queries and watch what it is doing." action={<button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" size={15} />Add connection</button>} /></Card>
                  ) : <Card><EmptyState icon="layers" title="Pick a connection" hint="Choose one from the list." /></Card>}
                </div>
              </div>
            )}
          </Async>
        )}
      </Async>
      {modal && st.data && <ConnectionModal kinds={st.data.kinds} existing={modal.edit} onClose={() => setModal(null)} onSaved={(r) => { srcs.reload(); if (!modal.edit) location.hash = `#/data/${enc(r.id)}/overview`; }} />}
      {delSrc && (
        <Modal title={`Remove ${delSrc.name}?`} onClose={() => setDelSrc(null)} footer={<><button className="btn" onClick={() => setDelSrc(null)}>Cancel</button><HoldButton danger onConfirm={() => void remove(delSrc)}>Remove</HoldButton></>}>
          <p>Only the saved connection is deleted. The database itself is not touched.</p>
        </Modal>
      )}
    </>
  );
}

