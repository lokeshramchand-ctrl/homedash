import { useEffect, useMemo, useRef, useState } from 'react';
import { dataApi } from '../api';
import { useQuery, useToast } from '../hooks';
import type { DbActivity, DbDescribe, DbOverview, DbQueryResult } from '../types';
import { DataGrid, download, pretty, toCsv } from './DataGrid';
import { KV } from './Pve';
import { Async, Badge, Card, CardHead, EmptyState, HoldButton, Icon, Modal, Spinner } from './ui';

export interface Ctx { id: string; ns: string; entity: string; ov: DbOverview }

const fmtBytes = (n: unknown) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${u[i]}`;
};
const fmtVal = (k: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (/bytes$/i.test(k) || /^(used|max)memory$/i.test(k)) return fmtBytes(v);
  if (/seconds$/i.test(k)) { const s = Number(v); return s > 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${s}s`; }
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------------------------------ record
/** Identifies a row to the server: _id for Mongo, the key for Redis, a {pk: value} object for SQL. */
export function rowId(rowKey: string | undefined, idFields: string[], r: Record<string, unknown>): unknown {
  if (rowKey === '_id') return r._id;
  if (rowKey === 'key') return r.key;
  return Object.fromEntries(idFields.map((f) => [f, r[f]]));
}

export function RecordModal({ ctx, id, idFields, columns, onClose, onChanged }: {
  ctx: Ctx; id: unknown | null; idFields: string[]; columns: string[]; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const redis = ctx.ov.kind === 'redis';
  const isNew = id === null;
  const q = useQuery(async () => (isNew ? null : dataApi.record(ctx.id, ctx.ns, ctx.entity, id)), [JSON.stringify(id)]);
  const [text, setText] = useState('');
  const [rType, setRType] = useState('string');
  const [rKey, setRKey] = useState('');
  const [ttl, setTtl] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const ready = useRef(false);

  useEffect(() => {
    if (ready.current) return;
    if (isNew) {
      ready.current = true;
      if (redis) { setText(''); return; }
      const t: Record<string, unknown> = {};
      for (const c of columns.filter((c) => !idFields.includes(c) || ctx.ov.kind === 'mongodb' ? c !== '_id' : true)) t[c] = null;
      setText(JSON.stringify(ctx.ov.kind === 'mongodb' ? {} : t, null, 2));
      return;
    }
    if (q.data === undefined) return;
    ready.current = true;
    if (redis) {
      const r = q.data as { key: string; type: string; ttl: number; value: unknown };
      setRKey(r.key); setRType(r.type); setTtl(r.ttl > 0 ? String(r.ttl) : '');
      setText(r.type === 'string' ? String(r.value) : JSON.stringify(r.value, null, 2));
    } else setText(JSON.stringify(q.data, null, 2));
  }, [q.data, isNew, redis, columns, idFields, ctx.ov.kind]);

  const writable = !ctx.ov.readOnly;
  async function save() {
    setBusy(true);
    try {
      if (redis) {
        const value = rType === 'string' ? text : JSON.parse(text);
        await dataApi.save(ctx.id, ctx.ns, ctx.entity, isNew ? null : id, { key: isNew ? rKey : undefined, type: rType, value, ttl: ttl === '' ? undefined : Number(ttl) });
      } else {
        const doc = JSON.parse(text);
        await dataApi.save(ctx.id, ctx.ns, ctx.entity, isNew ? null : id, doc);
      }
      toast.success(isNew ? 'Created' : 'Saved');
      onChanged(); onClose();
    } catch (e) { toast.error(e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : errText(e)); } finally { setBusy(false); }
  }
  async function del() {
    setBusy(true);
    try { await dataApi.delete(ctx.id, ctx.ns, ctx.entity, id); toast.success('Deleted'); onChanged(); onClose(); } catch (e) { toast.error(errText(e)); } finally { setBusy(false); setConfirmDel(false); }
  }

  const title = isNew ? `New ${redis ? 'key' : 'record'}` : redis ? `Key ${String(id)}` : 'Record';
  return (
    <>
      <Modal wide title={title} onClose={onClose} footer={
        <>
          {!isNew && writable && <button className="btn btn-danger" disabled={busy} onClick={() => setConfirmDel(true)}><Icon name="trash" size={15} />Delete</button>}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(text); toast.info('Copied'); }}><Icon name="copy" size={15} />Copy</button>
          <button className="btn" onClick={onClose}>Close</button>
          {writable && <button className="btn btn-primary" disabled={busy || (isNew && redis && !rKey)} onClick={save}>{busy ? <Spinner size={14} /> : <Icon name="save" size={15} />}{isNew ? 'Create' : 'Save'}</button>}
        </>
      }>
        {!isNew && q.data === undefined ? (q.error ? <p className="err-t">{q.error.message}</p> : <Spinner />) : (
          <div className="stack" style={{ gap: 10 }}>
            {!writable && <p className="muted small">This connection is read-only. Edit the connection to enable changes.</p>}
            {redis && (
              <div className="dm-form-row">
                <label>Key<input className="input mono" value={isNew ? rKey : String(id)} disabled={!isNew} onChange={(e) => setRKey(e.target.value)} /></label>
                <label>Type<select className="input" value={rType} disabled={!isNew && !writable} onChange={(e) => setRType(e.target.value)}>{['string', 'list', 'set', 'zset', 'hash'].map((t) => <option key={t}>{t}</option>)}</select></label>
                <label>TTL (s, empty = none)<input className="input" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ''))} /></label>
              </div>
            )}
            {redis && rType === 'zset' && <p className="muted small">zset: <code>[{'{'}"member":"a","score":1{'}'}]</code> · list/set: <code>["a","b"]</code> · hash: <code>{'{"field":"value"}'}</code></p>}
            <textarea className="input mono dm-editor" spellCheck={false} value={text} readOnly={!writable} onChange={(e) => setText(e.target.value)} />
            {redis && !isNew && (q.data as { truncated?: boolean })?.truncated && <p className="muted small">Large value: only the first 500 elements are loaded. Saving would replace the whole key with what is shown, so use the console for big collections.</p>}
            {!redis && !isNew && idFields.length > 0 && <p className="muted small">Identified by {idFields.join(', ')}; key fields are not changed by Save.</p>}
          </div>
        )}
      </Modal>
      {confirmDel && (
        <Modal title="Delete permanently?" onClose={() => setConfirmDel(false)} footer={<><button className="btn" onClick={() => setConfirmDel(false)}>Cancel</button><HoldButton danger onConfirm={del}>Delete</HoldButton></>}>
          <p>This cannot be undone.</p><p className="mono small">{pretty(id)}</p>
        </Modal>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------ browse
export function BrowseTab({ ctx, desc }: { ctx: Ctx; desc?: DbDescribe }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [cursors, setCursors] = useState<string[]>(['']); // redis: cursor that starts each page
  const [open, setOpen] = useState<{ id: unknown | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const redis = ctx.ov.kind === 'redis';
  const pageNo = redis ? cursors.length - 1 : Math.floor(offset / limit);

  useEffect(() => { setDraft(''); setFilter(''); setSort(undefined); setOffset(0); setCursors(['']); }, [ctx.id, ctx.ns, ctx.entity]);
  const q = useQuery(() => dataApi.browse(ctx.id, ctx.ns, ctx.entity, { limit, offset, cursor: redis ? cursors[cursors.length - 1] || undefined : undefined, filter: filter || undefined, sort, dir }),
    [ctx.id, ctx.ns, ctx.entity, limit, offset, filter, sort, dir, cursors.length]);
  const idFields = desc?.idFields ?? (redis ? ['key'] : ctx.ov.kind === 'mongodb' ? ['_id'] : []);

  const apply = () => { setFilter(draft.trim()); setOffset(0); setCursors(['']); };
  const next = () => { if (redis) q.data?.nextCursor && setCursors((c) => [...c, q.data!.nextCursor!]); else setOffset((o) => o + limit); };
  const prev = () => { if (redis) setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)); else setOffset((o) => Math.max(0, o - limit)); };

  async function onImport(f: File | undefined) {
    if (!f) return;
    setImporting(true);
    try {
      const rows = JSON.parse(await f.text());
      if (!Array.isArray(rows)) throw new Error('The file must contain a JSON array of objects');
      const r = await dataApi.importRows(ctx.id, ctx.ns, ctx.entity, rows);
      (r.failed ? toast.error : toast.success)(`Imported ${r.inserted} row${r.inserted === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed: ${r.errors[0]?.error ?? ''}` : ''}`);
      q.reload();
    } catch (e) { toast.error(errText(e)); } finally { setImporting(false); if (file.current) file.current.value = ''; }
  }

  const writable = !ctx.ov.readOnly;
  const canEditRows = ctx.ov.kind === 'mongodb' || ctx.ov.kind === 'redis' || idFields.length > 0;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="dm-bar">
        <label className="search dm-filter">
          <Icon name="filter" size={15} />
          <input className="mono" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} placeholder={ctx.ov.caps.filterHint} aria-label="Filter" />
          {draft && <button onClick={() => { setDraft(''); setFilter(''); setOffset(0); setCursors(['']); }} aria-label="Clear filter"><Icon name="x" size={14} /></button>}
        </label>
        <button className="btn" onClick={apply}>Apply</button>
        <select className="input dm-limit" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); setCursors(['']); }} aria-label="Rows per page">
          {[25, 50, 100, 250, 500].map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <button className="icon-btn" onClick={q.reload} title="Reload" aria-label="Reload"><Icon name="refresh" size={16} /></button>
        <span style={{ flex: 1 }} />
        <a className="btn" href={dataApi.exportUrl(ctx.id, ctx.ns, ctx.entity, 'csv', filter)} download><Icon name="download" size={15} />CSV</a>
        <a className="btn" href={dataApi.exportUrl(ctx.id, ctx.ns, ctx.entity, 'json', filter)} download><Icon name="download" size={15} />JSON</a>
        {writable && ctx.ov.caps.importExport && !redis && (
          <>
            <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
            <button className="btn" disabled={importing} onClick={() => file.current?.click()}>{importing ? <Spinner size={14} /> : <Icon name="upload" size={15} />}Import</button>
          </>
        )}
        {writable && <button className="btn btn-primary" onClick={() => setOpen({ id: null })}><Icon name="plus" size={15} />{redis ? 'New key' : 'Insert'}</button>}
      </div>
      <Async q={q} rows={6} h={36} isEmpty={(d) => d.rows.length === 0 && pageNo === 0} empty={{ title: filter ? 'Nothing matches that filter' : `This ${ctx.ov.caps.entityLabel} is empty`, hint: filter ? 'Clear or change the filter.' : undefined }}>
        {(p) => (
          <Card pad={false}>
            <DataGrid columns={p.columns} rows={p.rows} sort={sort} dir={dir}
              onSort={redis ? undefined : (c) => { if (sort === c) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSort(c); setDir('asc'); } setOffset(0); }}
              onRow={canEditRows ? (r) => setOpen({ id: rowId(ctx.ov.caps.rowKey, idFields, r) }) : undefined} />
            <div className="dm-pager">
              <span className="muted small">
                {redis ? `${p.rows.length} keys on this page${p.total != null ? ` · ${p.total.toLocaleString()} in db` : ''}` :
                  `${p.rows.length ? offset + 1 : 0}–${offset + p.rows.length}${p.total != null ? ` of ${p.totalApprox ? '≈' : ''}${p.total.toLocaleString()}` : ''}`}
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-sm" disabled={pageNo === 0} onClick={prev}>Previous</button>
              <button className="btn btn-sm" disabled={!p.hasMore} onClick={next}>Next</button>
            </div>
          </Card>
        )}
      </Async>
      {open && <RecordModal ctx={ctx} id={open.id} idFields={idFields} columns={q.data?.columns ?? []} onClose={() => setOpen(null)} onChanged={q.reload} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ structure
export function StructureTab({ ctx, onDropped }: { ctx: Ctx; onDropped: () => void }) {
  const toast = useToast();
  const q = useQuery(() => dataApi.describe(ctx.id, ctx.ns, ctx.entity), [ctx.id, ctx.ns, ctx.entity]);
  const [idx, setIdx] = useState({ name: '', cols: '', unique: false });
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const writable = !ctx.ov.readOnly;
  const redis = ctx.ov.kind === 'redis';

  async function addIndex() {
    const columns = idx.cols.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith('-') ? { field: s.slice(1), dir: 'desc' as const } : { field: s }));
    if (!columns.length) return;
    setBusy(true);
    try { const r = await dataApi.createIndex(ctx.id, { ns: ctx.ns, entity: ctx.entity, name: idx.name || undefined, columns, unique: idx.unique }); toast.success(`Index ${r.name} created`); setIdx({ name: '', cols: '', unique: false }); q.reload(); } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  }
  async function dropIndex(name: string) {
    try { await dataApi.dropIndex(ctx.id, ctx.ns, ctx.entity, name); toast.success('Index dropped'); q.reload(); } catch (e) { toast.error(errText(e)); }
  }
  async function dropEntity() {
    setBusy(true);
    try { await dataApi.dropEntity(ctx.id, ctx.ns, ctx.entity, typed); toast.success(`${ctx.entity} dropped`); setDrop(null); onDropped(); } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  }

  async function runAction(id: string) {
    setBusy(true);
    try { const r = await dataApi.action(ctx.id, { ns: ctx.ns, entity: ctx.entity, action: id }); toast.success(r.message ?? 'Done'); q.reload(); } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  }

  return (
    <Async q={q} rows={4} h={90}>
      {(d) => (
        <div className="settings-grid">
          <div className="stack">
            <Card pad={false}>
              <div style={{ padding: '18px 20px 0' }}><CardHead title={ctx.ov.kind === 'mongodb' ? 'Fields (sampled)' : 'Columns'} sub={ctx.ov.kind === 'mongodb' ? 'Inferred from a random sample; documents in a collection need not share a shape.' : undefined} /></div>
              <div className="dm-grid"><table>
                <thead><tr><th>Name</th><th>Type</th><th>Null</th><th>Default</th><th /></tr></thead>
                <tbody>{d.columns.map((c) => (
                  <tr key={c.name}><td>{c.pk && <Icon name="key" size={12} />} <b>{c.name}</b></td><td className="mono">{c.type}</td><td>{c.nullable ? 'yes' : c.nullable === false ? 'no' : ''}</td><td className="mono">{c.default ?? ''}</td><td className="muted small">{c.note}</td></tr>
                ))}</tbody>
              </table></div>
            </Card>
            {d.ddl && <Card><CardHead title="Definition" right={<button className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(d.ddl!); toast.info('Copied'); }}><Icon name="copy" size={13} />Copy</button>} /><pre className="dm-pre">{d.ddl}</pre></Card>}
          </div>
          <div className="stack">
            <Card><CardHead title="Statistics" /><KV rows={Object.entries(d.stats).map(([k, v]) => [k, fmtVal(k, v)])} /></Card>
            {!redis && (
              <Card pad={false}>
                <div style={{ padding: '18px 20px 0' }}><CardHead title="Indexes" /></div>
                {d.indexes.length === 0 ? <div style={{ padding: 20 }}><EmptyState icon="list" title="No indexes" /></div> : (
                  <div className="dm-grid"><table>
                    <thead><tr><th>Name</th><th>Columns</th><th /></tr></thead>
                    <tbody>{d.indexes.map((i) => (
                      <tr key={i.name}>
                        <td><b>{i.name}</b> {i.primary && <Badge tone="blue">primary</Badge>} {i.unique && !i.primary && <Badge tone="violet">unique</Badge>}</td>
                        <td className="mono">{i.columns.join(', ')}{i.detail && <small className="muted"> · {i.detail}</small>}</td>
                        <td>{writable && !i.primary && <button className="icon-btn" aria-label={`Drop ${i.name}`} onClick={() => void dropIndex(i.name)}><Icon name="trash" size={14} /></button>}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
                {writable && (
                  <div className="dm-index-form">
                    <input className="input" placeholder={ctx.ov.kind === 'mongodb' ? 'fields, e.g. email, -createdAt' : 'columns, e.g. email, -created_at'} value={idx.cols} onChange={(e) => setIdx({ ...idx, cols: e.target.value })} />
                    <input className="input" placeholder="name (optional)" value={idx.name} onChange={(e) => setIdx({ ...idx, name: e.target.value })} />
                    <label className="dm-check"><input type="checkbox" checked={idx.unique} onChange={(e) => setIdx({ ...idx, unique: e.target.checked })} />unique</label>
                    <button className="btn" disabled={busy || !idx.cols.trim()} onClick={addIndex}><Icon name="plus" size={14} />Create index</button>
                  </div>
                )}
              </Card>
            )}
            {writable && !!ctx.ov.caps.actions?.some((a) => a.scope === 'entity') && (
              <Card><CardHead title="Actions" sub={`Operations on this ${ctx.ov.caps.entityLabel}.`} />
                <div className="chips" style={{ flexWrap: 'wrap' }}>
                  {ctx.ov.caps.actions.filter((a) => a.scope === 'entity').map((a) => (
                    <button key={a.id} className={`btn ${a.danger ? 'btn-danger' : ''}`} disabled={busy} onClick={() => void runAction(a.id)}>{a.label}</button>
                  ))}
                </div>
              </Card>
            )}
            {writable && ctx.ov.caps.dropEntity && (
              <Card><CardHead title="Danger zone" sub={`Dropping a ${ctx.ov.caps.entityLabel} deletes it and all its data.`} />
                <button className="btn btn-danger" onClick={() => { setDrop(ctx.entity); setTyped(''); }}><Icon name="trash" size={15} />Drop {ctx.entity}</button>
              </Card>
            )}
          </div>
          {drop && (
            <Modal title={`Drop ${drop}?`} onClose={() => setDrop(null)} footer={<><button className="btn" onClick={() => setDrop(null)}>Cancel</button><button className="btn btn-danger" disabled={busy || typed !== drop} onClick={dropEntity}>Drop permanently</button></>}>
              <p>Type <b className="mono">{drop}</b> to confirm.</p>
              <input className="input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
            </Modal>
          )}
        </div>
      )}
    </Async>
  );
}

// ------------------------------------------------------------------------------------------ query console
const TEMPLATES: Record<string, { label: string; text: string }[]> = {
  'mongo-json': [
    { label: 'find', text: '{\n  "find": "COLLECTION",\n  "filter": {},\n  "sort": { "_id": -1 },\n  "limit": 20\n}' },
    { label: 'aggregate', text: '{\n  "aggregate": "COLLECTION",\n  "pipeline": [\n    { "$group": { "_id": "$status", "n": { "$sum": 1 } } },\n    { "$sort": { "n": -1 } }\n  ]\n}' },
    { label: 'count', text: '{ "count": "COLLECTION", "filter": {} }' },
    { label: 'distinct', text: '{ "distinct": "COLLECTION", "field": "status" }' },
    { label: 'updateMany', text: '{\n  "updateMany": "COLLECTION",\n  "filter": { "status": "old" },\n  "update": { "$set": { "status": "new" } }\n}' },
    { label: 'server stats', text: '{ "command": { "dbStats": 1 } }' },
  ],
  'redis-cli': [
    { label: 'DBSIZE', text: 'DBSIZE' }, { label: 'scan keys', text: 'KEYS user:*' }, { label: 'GET', text: 'GET mykey' }, { label: 'TTL', text: 'TTL mykey' },
    { label: 'HGETALL', text: 'HGETALL myhash' }, { label: 'SET', text: 'SET mykey "value" EX 3600' }, { label: 'slowlog', text: 'SLOWLOG GET 10' }, { label: 'memory', text: 'INFO memory' },
  ],
  sql: [
    { label: 'select', text: 'SELECT *\nFROM TABLE\nLIMIT 50;' }, { label: 'count', text: 'SELECT COUNT(*) FROM TABLE;' },
    { label: 'explain', text: 'EXPLAIN SELECT * FROM TABLE WHERE id = 1;' }, { label: 'update', text: "UPDATE TABLE SET col = 'x' WHERE id = 1;" },
  ],
  tsql: [
    { label: 'select', text: 'SELECT TOP 50 *\nFROM dbo.TABLE;' }, { label: 'count', text: 'SELECT COUNT_BIG(*) FROM dbo.TABLE;' },
    { label: 'tables', text: "SELECT s.name AS [schema], t.name, t.create_date\nFROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id\nORDER BY 1, 2;" },
    { label: 'sizes', text: 'EXEC sp_spaceused;' }, { label: 'update', text: "UPDATE dbo.TABLE SET col = 'x' WHERE Id = 1;" },
  ],
};

export function QueryTab({ ctx }: { ctx: Ctx }) {
  const toast = useToast();
  const lang = ctx.ov.caps.language;
  const hk = `dm-hist-${lang}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(`dm-last-${ctx.id}`) ?? ''; } catch { return ''; } });
  const [res, setRes] = useState<DbQueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [view, setView] = useState<'table' | 'json'>('table');
  const [hist, setHist] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(hk) ?? '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(`dm-last-${ctx.id}`, text); } catch { /* storage unavailable */ } }, [text, ctx.id]);

  const entity = ctx.entity && ctx.entity !== 'keys' ? ctx.entity : '';
  async function run() {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await dataApi.query(ctx.id, { ns: ctx.ns, text, allowWrite });
      setRes(r);
      setView(r.kind === 'rows' ? 'table' : 'json');
      const h = [text, ...hist.filter((x) => x !== text)].slice(0, 25);
      setHist(h);
      try { localStorage.setItem(hk, JSON.stringify(h)); } catch { /* storage unavailable */ }
    } catch (e) { setRes(null); setErr(errText(e)); } finally { setBusy(false); }
  }
  const tpl = (t: string) => setText(entity ? t.replace(/COLLECTION|TABLE/g, entity) : t);
  const writeBlocked = ctx.ov.readOnly;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="dm-bar">
        {(TEMPLATES[lang] ?? []).map((t) => <button key={t.label} className="btn btn-sm" onClick={() => tpl(t.text)}>{t.label}</button>)}
        <span style={{ flex: 1 }} />
        {hist.length > 0 && (
          <select className="input dm-limit" value="" onChange={(e) => e.target.value && setText(e.target.value)} aria-label="History">
            <option value="">History…</option>
            {hist.map((h, i) => <option key={i} value={h}>{h.replace(/\s+/g, ' ').slice(0, 70)}</option>)}
          </select>
        )}
      </div>
      <textarea className="input mono dm-editor dm-query" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }}
        placeholder={lang === 'sql' ? 'SELECT … (Ctrl+Enter to run)' : lang === 'redis-cli' ? 'GET key (Ctrl+Enter to run)' : lang === 'mongo-json' ? '{ "find": "collection", … } (Ctrl+Enter to run)' : `${ctx.ov.caps.queryHelp ?? ''} (Ctrl+Enter to run)`} />
      <div className="dm-bar">
        <button className="btn btn-primary" onClick={run} disabled={busy || !text.trim()}>{busy ? <Spinner size={14} /> : <Icon name="play" size={14} />}Run</button>
        <label className={`dm-check ${writeBlocked ? 'off' : ''}`} title={writeBlocked ? 'This connection is read-only' : 'Allow statements that change data'}>
          <input type="checkbox" disabled={writeBlocked} checked={allowWrite} onChange={(e) => setAllowWrite(e.target.checked)} />
          allow writes {allowWrite && <Badge tone="red">live</Badge>}
        </label>
        <span className="muted small">{writeBlocked ? 'Read-only connection: the database itself refuses changes.' : allowWrite ? 'Writes are executed and audited.' : 'Read-only mode.'}</span>
      </div>
      {err && <Card><p className="err-t mono small" style={{ whiteSpace: 'pre-wrap' }}>{err}</p></Card>}
      {res && (
        <Card pad={false}>
          <div className="dm-pager" style={{ borderTop: 0, borderBottom: '1px solid var(--border)' }}>
            <Badge tone="green" dot>{res.ms} ms</Badge>
            <span className="muted small">{res.kind === 'rows' ? `${res.rows.length} row${res.rows.length === 1 ? '' : 's'}${res.truncated ? ' (truncated)' : ''}` : res.kind === 'ok' ? `${res.affected ?? 0} affected` : 'result'}</span>
            <span style={{ flex: 1 }} />
            {res.kind === 'rows' && <div className="chips"><button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button><button className={view === 'json' ? 'on' : ''} onClick={() => setView('json')}>JSON</button></div>}
            {res.kind === 'rows' && res.rows.length > 0 && <>
              <button className="btn btn-sm" onClick={() => download('result.csv', toCsv(res.columns, res.rows), 'text/csv')}><Icon name="download" size={13} />CSV</button>
              <button className="btn btn-sm" onClick={() => download('result.json', JSON.stringify(res.rows, null, 2), 'application/json')}><Icon name="download" size={13} />JSON</button>
            </>}
            <button className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(res.kind === 'rows' ? res.rows : res.value ?? { affected: res.affected }, null, 2)); toast.info('Copied'); }}><Icon name="copy" size={13} /></button>
          </div>
          {res.kind === 'rows' && view === 'table' ? (res.rows.length ? <DataGrid columns={res.columns} rows={res.rows} /> : <div style={{ padding: 20 }}><EmptyState title="No rows" /></div>)
            : <pre className="dm-pre dm-result">{JSON.stringify(res.kind === 'rows' ? res.rows : res.kind === 'ok' ? { affected: res.affected, ...(res.value ? { result: res.value } : {}) } : res.value, null, 2)}</pre>}
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ server / activity
export function ServerTab({ id }: { id: string }) {
  const q = useQuery(() => dataApi.info(id), [id], 10_000);
  return (
    <Async q={q} rows={4} h={90}>
      {(d) => (
        <div className="stack">
          <div className="dm-tiles">
            {Object.entries(d.summary).filter(([, v]) => v !== null).map(([k, v]) => (
              <Card key={k}><p className="muted small">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</p><p className="dm-tile">{fmtVal(k, v)}</p></Card>
            ))}
          </div>
          <div className="settings-grid">
            {Object.entries(d.sections).map(([name, rows]) => (
              <Card key={name}><CardHead title={name.replace(/_/g, ' ')} /><KV rows={Object.entries(rows).map(([k, v]) => [k, fmtVal(k, v)])} /></Card>
            ))}
          </div>
        </div>
      )}
    </Async>
  );
}

function Table({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = useMemo(() => [...new Set(rows.flatMap((r) => Object.keys(r)))], [rows]);
  return <DataGrid columns={cols} rows={rows} />;
}

export function ActivityTab({ id }: { id: string }) {
  const [live, setLive] = useState(true);
  const q = useQuery<DbActivity>(() => dataApi.activity(id), [id], live ? 5000 : 0);
  return (
    <Async q={q} rows={4} h={60}>
      {(d) => !d.supported ? <Card><EmptyState icon="activity" title="Not available" hint={d.note} /></Card> : (
        <div className="stack">
          <div className="dm-bar"><label className="dm-check"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />Live (5 s)</label>{d.note && <span className="muted small">{d.note}</span>}</div>
          <Card pad={false}><div style={{ padding: '18px 20px 0' }}><CardHead title="Sessions" sub={`${d.sessions.length} connected or running`} /></div>{d.sessions.length ? <Table rows={d.sessions} /> : <div style={{ padding: 20 }}><EmptyState icon="activity" title="Nothing running" /></div>}</Card>
          {d.slow && <Card pad={false}><div style={{ padding: '18px 20px 0' }}><CardHead title="Slow commands" /></div>{d.slow.length ? <Table rows={d.slow} /> : <div style={{ padding: 20 }}><EmptyState icon="zap" title="No slow commands logged" /></div>}</Card>}
        </div>
      )}
    </Async>
  );
}

export type { DbDescribe };


// ------------------------------------------------------------------------------------------ search (caps.search)
export function SearchTab({ ctx }: { ctx: Ctx }) {
  const toast = useToast();
  const sc = ctx.ov.caps.search!;
  const desc = useQuery(() => dataApi.describe(ctx.id, ctx.ns, ctx.entity), [ctx.id, ctx.ns, ctx.entity]);
  const fields = desc.data?.searchFields ?? [];
  const [field, setField] = useState('');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(10);
  const [params, setParams] = useState<Record<string, string | number>>(() => Object.fromEntries(sc.params.filter((p) => p.default !== undefined).map((p) => [p.name, p.default as string | number])));
  const [res, setRes] = useState<DbQueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cur = field || fields[0]?.name || '';
  const dim = fields.find((f) => f.name === cur)?.dim;

  async function run() {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try { setRes(await dataApi.search(ctx.id, { ns: ctx.ns, entity: ctx.entity, field: cur || undefined, query: text, limit, filter: filter || undefined, params })); } catch (e) { setRes(null); setErr(errText(e)); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <Card>
        <CardHead title={sc.label} sub={sc.inputHint} />
        <div className="dm-form">
          <div className="dm-form-row">
            {sc.fields && fields.length > 0 && (
              <label>Field<select className="input" value={cur} onChange={(e) => setField(e.target.value)}>{fields.map((f) => <option key={f.name} value={f.name}>{f.name} · {f.type}{f.dim ? `(${f.dim})` : ''}</option>)}</select></label>
            )}
            <label>Results<input className="input mono" type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 10)))} /></label>
            {sc.params.map((p) => (
              <label key={p.name}>{p.label}
                {p.type === 'select'
                  ? <select className="input" value={String(params[p.name] ?? '')} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}>{p.options?.map((o) => <option key={o}>{o}</option>)}</select>
                  : <input className="input mono" type={p.type === 'number' ? 'number' : 'text'} value={String(params[p.name] ?? '')} onChange={(e) => setParams({ ...params, [p.name]: p.type === 'number' ? Number(e.target.value) : e.target.value })} />}
              </label>
            ))}
          </div>
          <label>Query{dim ? <span className="muted"> ({dim} values expected)</span> : null}
            <textarea className="input mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run(); }} placeholder={sc.inputHint} spellCheck={false} />
          </label>
          <label>Filter <span className="muted">(optional, same syntax as the Browse filter)</span><input className="input mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={ctx.ov.caps.filterHint} /></label>
          <div><button className="btn btn-primary" disabled={busy || !text.trim()} onClick={run}>{busy ? <Spinner size={14} /> : <Icon name="search" size={14} />}Search</button></div>
        </div>
      </Card>
      {err && <Card><p className="err-t">{err}</p></Card>}
      {res && (
        <Card pad={false}>
          <div style={{ padding: '14px 20px' }} className="muted small">{res.rows.length} result{res.rows.length === 1 ? '' : 's'} · {res.ms} ms</div>
          {res.rows.length ? <DataGrid columns={res.columns} rows={res.rows} /> : <div style={{ padding: 20 }}><EmptyState title="No matches" /></div>}
        </Card>
      )}
    </div>
  );
}
