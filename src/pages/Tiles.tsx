import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, Icon, Modal, PageHeader, Spinner } from '../components/ui';
import type { Tone } from '../components/ui';
import { Logo, ServiceForm, emptyDraft } from '../components/ServiceForm';
import type { Draft } from '../components/ServiceForm';
import { timeAgo } from '../format';
import { useQuery, useSearch, useToast } from '../hooks';
import { layoutFileText, parseLayoutFile } from '../layoutfile';
import type { Tile, TileAdmin, TileCatalog, TileSuggestion } from '../types';

const TONE: Record<Tile['state'], Tone> = { ok: 'green', warn: 'amber', down: 'red', pending: 'gray' };
const LABEL: Record<Tile['state'], string> = { ok: 'Healthy', warn: 'Attention', down: 'Unreachable', pending: 'Checking…' };
const KIND: Record<string, string> = {
  docker: 'Docker', portainer: 'Portainer', pihole: 'Pi-hole', adguard: 'AdGuard Home', npm: 'Nginx Proxy Manager', traefik: 'Traefik', jellyfin: 'Jellyfin', plex: 'Plex',
  sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr', prowlarr: 'Prowlarr', immich: 'Immich', qbittorrent: 'qBittorrent', homeassistant: 'Home Assistant',
  nextcloud: 'Nextcloud', pbs: 'Proxmox Backup Server', nut: 'UPS (NUT)', http: 'HTTP',
};
const ACCENTS = ['#0870b9', '#3eb850', '#ed272e', '#8a4fbf', '#c27a16', '#0b7a8c'];

interface Layout { order: string[]; fav: string[]; view: 'cards' | 'launcher'; accent: string }
const DEFAULT: Layout = { order: [], fav: [], view: 'cards', accent: ACCENTS[0] };
const LS = 'homedash.tiles.layout';

function useLayout(): [Layout, (p: Partial<Layout>) => void] {
  const [l, setL] = useState<Layout>(() => { try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(LS) ?? '{}') }; } catch { return DEFAULT; } });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // The server copy follows the person across browsers; it wins when it exists.
  useEffect(() => {
    api.pref('tiles').then((r) => { if (r.value && typeof r.value === 'object') setL((x) => ({ ...x, ...(r.value as Partial<Layout>) })); }).catch(() => undefined);
  }, []);
  const update = useCallback((p: Partial<Layout>) => {
    setL((x) => {
      const n = { ...x, ...p };
      try { localStorage.setItem(LS, JSON.stringify(n)); } catch { /* private mode */ }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void api.setPref('tiles', n).catch(() => undefined), 600);
      return n;
    });
  }, []);
  return [l, update];
}

/** The last checks as bars: height = response time, red = no answer. */
export function Spark({ points }: { points: number[] }) {
  const pts = points.slice(-48);
  if (pts.length < 2) return <div className="spark spark-empty" aria-hidden="true" />;
  const max = Math.max(50, ...pts.filter((p) => p >= 0));
  return (
    <svg className="spark" viewBox={`0 0 ${pts.length * 4} 24`} preserveAspectRatio="none" role="img" aria-label={`Response time over the last ${pts.length} checks`}>
      {pts.map((p, i) => p < 0
        ? <rect key={i} x={i * 4} y={0} width={3} height={24} className="spark-down" />
        : <rect key={i} x={i * 4} y={24 - Math.max(3, (p / max) * 22)} width={3} height={Math.max(3, (p / max) * 22)} className="spark-ok" />)}
    </svg>
  );
}

interface CardProps {
  t: Tile; compact: boolean; fav: boolean; busy: boolean; drag: { over: boolean; start: () => void; enter: () => void; drop: () => void };
  onFav: () => void; onRefresh: () => void; onEdit?: () => void; onDelete?: () => void;
}

function TileCard({ t, compact, fav, busy, drag, onFav, onRefresh, onEdit, onDelete }: CardProps) {
  const label = KIND[t.kind] ?? t.kind;
  const dragProps = { draggable: true, onDragStart: drag.start, onDragEnter: drag.enter, onDragOver: (e: React.DragEvent) => e.preventDefault(), onDrop: drag.drop };
  if (compact) {
    const inner = <><Logo kind={t.kind} label={label} size={40} /><span className="lau-name">{t.name}</span><span className={`dot dot-${t.state}`} title={LABEL[t.state]} /></>;
    return (
      <div className={`lau ${drag.over ? 'drag-over' : ''}`} {...dragProps}>
        {t.link ? <a href={t.link} target="_blank" rel="noopener noreferrer" className="lau-link">{inner}</a> : <div className="lau-link">{inner}</div>}
      </div>
    );
  }
  return (
    <div className={drag.over ? 'drag-over' : ''} {...dragProps}>
      <Card className={`svc svc-${t.state}`}>
        <div className="svc-head">
          <Logo kind={t.kind} label={label} />
          <div className="svc-title">
            <b>{t.link ? <a className="link" href={t.link} target="_blank" rel="noopener noreferrer">{t.name}</a> : t.name}</b>
            <small className="muted">{label}{t.summary && t.state !== 'down' ? ` · ${t.summary}` : ''}</small>
          </div>
          <button className={`icon-btn fav ${fav ? 'on' : ''}`} onClick={onFav} aria-pressed={fav} aria-label={fav ? `Unpin ${t.name}` : `Pin ${t.name}`} title={fav ? 'Unpin' : 'Pin to the top'}><Icon name="star" size={15} /></button>
        </div>
        <div className="svc-state"><Badge tone={TONE[t.state]} dot>{LABEL[t.state]}</Badge><Spark points={t.history ?? []} /></div>
        {t.state === 'down' && <p className="svc-err small">{t.error ?? 'No answer'}</p>}
        {t.stats && t.stats.length > 0 && t.state !== 'down' && (
          <dl className="svc-stats">
            {t.stats.map((s) => <div key={s.label} className={s.tone ? `tone-${s.tone}` : undefined}><dt>{s.label}</dt><dd>{s.value}</dd></div>)}
          </dl>
        )}
        <div className="svc-foot muted small">
          <span>{t.at ? `${timeAgo(new Date(t.at).toISOString())}${t.ms != null ? ` · ${t.ms} ms` : ''}` : 'waiting for first check'}</span>
          <span className="row-actions">
            {onEdit && <button className="icon-btn" onClick={onEdit} aria-label={`Edit ${t.name}`} title="Edit"><Icon name="edit" size={15} /></button>}
            {onDelete && <button className="icon-btn" onClick={onDelete} aria-label={`Remove ${t.name}`} title="Remove"><Icon name="trash" size={15} /></button>}
            <button className="icon-btn" onClick={onRefresh} disabled={busy} aria-label={`Refresh ${t.name}`} title="Check now"><Icon name="refresh" size={15} /></button>
            <span className="drag-handle" title="Drag to reorder" aria-hidden="true"><Icon name="drag" size={15} /></span>
          </span>
        </div>
      </Card>
    </div>
  );
}

/** Sorts by the saved order; anything new goes last, in the server's order. */
export function ordered<T extends { id: string }>(list: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}
/** Moves `id` to where `before` is. */
export function moveBefore(ids: string[], id: string, before: string): string[] {
  if (id === before) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(before);
  return at < 0 ? ids : [...rest.slice(0, at), id, ...rest.slice(at)];
}

export default function Tiles({ role }: { role: string }) {
  const q = useQuery(api.tiles, [], 15000);
  const isAdmin = role === 'admin';
  const cat = useQuery<TileCatalog>(api.tileCatalog, [], 0);
  const adm = useQuery<TileAdmin | null>(() => (isAdmin ? api.tileAdmin() : Promise.resolve(null)), [isAdmin], 0);
  const { q: search } = useSearch();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Draft | null>(null);
  const [finder, setFinder] = useState(false);
  const [layout, setLayout] = useLayout();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [wall, setWall] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('wall', wall);
    const onFs = () => { if (!document.fullscreenElement) setWall(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => { document.body.classList.remove('wall'); document.removeEventListener('fullscreenchange', onFs); };
  }, [wall]);
  const toggleWall = () => {
    if (!wall) { setWall(true); void document.documentElement.requestFullscreen?.().catch(() => undefined); }
    else { setWall(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); }
  };

  const refresh = async (t: Tile) => {
    setBusy(t.id);
    try { await api.refreshTile(t.id); q.reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  const edit = (t: Tile) => {
    const u = adm.data?.ui.find((x) => x.id === t.id);
    if (!u) return;
    setForm({ ...emptyDraft(u.kind, u.config.url), id: u.id, name: u.name, publicUrl: u.config.publicUrl, group: u.config.group, username: u.config.username, ups: u.config.ups, insecureTls: u.config.insecureTls, hasToken: u.hasToken, hasPassword: u.hasPassword });
  };
  const remove = async (t: Tile) => {
    if (!window.confirm(`Remove "${t.name}" from the dashboard?`)) return;
    try { await api.deleteTile(t.id); toast.success('Removed'); q.reload(); adm.reload(); } catch (e) { toast.error((e as Error).message); }
  };
  const canEdit = isAdmin && !!cat.data?.canEdit;
  const favs = useMemo(() => new Set(layout.fav), [layout.fav]);
  const toggleFav = (id: string) => setLayout({ fav: favs.has(id) ? layout.fav.filter((x) => x !== id) : [...layout.fav, id] });

  const dragFor = (all: Tile[], t: Tile) => ({
    over: overId === t.id && dragId !== null && dragId !== t.id,
    start: () => setDragId(t.id),
    enter: () => setOverId(t.id),
    drop: () => {
      if (dragId) setLayout({ order: moveBefore(ordered(all, layout.order).map((x) => x.id), dragId, t.id) });
      setDragId(null); setOverId(null);
    },
  });

  return (
    <div className="svc-page" style={{ ['--svc-accent' as string]: layout.accent }}>
      <PageHeader title="Services" sub="Everything you run, at a glance. Drag to arrange, star to pin." actions={
        <>
          <button className="btn" onClick={toggleWall} title="Full screen for a wall display"><Icon name="monitor" size={15} />{wall ? 'Exit wall mode' : 'Wall mode'}</button>
          {isAdmin && <button className="btn" disabled={!canEdit} onClick={() => setFinder(true)}><Icon name="search" size={15} />Find services</button>}
          {isAdmin && <button className="btn btn-primary" disabled={!canEdit} title={canEdit ? undefined : 'Set a secret key first: run homedash-config apply'} onClick={() => setForm(emptyDraft())}><Icon name="plus" size={15} />Add service</button>}
        </>
      } />
      {finder && <Finder onClose={() => setFinder(false)} onPick={(s) => { setFinder(false); setForm({ ...emptyDraft(s.kind, s.url), name: s.name }); }} />}
      {form && cat.data && <ServiceForm catalog={cat.data} draft={form} onClose={() => setForm(null)} onSaved={() => { q.reload(); adm.reload(); }} />}
      <Async q={q} rows={4} h={140} isEmpty={(d) => d.length === 0} empty={{ title: 'No services yet', hint: isAdmin ? 'Use Find services to detect what your guests run, or Add service to enter one by hand.' : 'An administrator can add services here.' }}>
        {(list) => {
          const s = search.trim().toLowerCase();
          const shown = ordered(list.filter((t) => !s || `${t.name} ${KIND[t.kind] ?? t.kind} ${t.group ?? ''}`.toLowerCase().includes(s)), layout.order);
          const pinned = shown.filter((t) => favs.has(t.id));
          const rest = shown.filter((t) => !favs.has(t.id));
          const groups = [...new Set(rest.map((t) => t.group ?? ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
          const bad = list.filter((t) => t.state === 'down').length, warn = list.filter((t) => t.state === 'warn').length;
          const compact = layout.view === 'launcher';
          const grid = (items: Tile[]) => (
            <div className={compact ? 'lau-grid' : 'svc-grid'}>
              {items.map((t) => (
                <TileCard key={t.id} t={t} compact={compact} fav={favs.has(t.id)} busy={busy === t.id} drag={dragFor(shown, t)} onFav={() => toggleFav(t.id)} onRefresh={() => void refresh(t)}
                  onEdit={canEdit && t.source === 'ui' ? () => edit(t) : undefined} onDelete={canEdit && t.source === 'ui' ? () => void remove(t) : undefined} />
              ))}
            </div>
          );
          return (
            <>
              <div className="svc-bar">
                <div className="stat-row svc-sum">
                  <div><b>{list.length - bad - warn}</b><span>healthy</span></div>
                  <div><b>{warn}</b><span>need attention</span></div>
                  <div><b>{bad}</b><span>unreachable</span></div>
                </div>
                <div className="svc-tools">
                  <div className="seg" role="group" aria-label="View">
                    <button className={compact ? '' : 'on'} onClick={() => setLayout({ view: 'cards' })} aria-pressed={!compact}>Cards</button>
                    <button className={compact ? 'on' : ''} onClick={() => setLayout({ view: 'launcher' })} aria-pressed={compact}>Launcher</button>
                  </div>
                  <button className="btn btn-sm" onClick={() => exportLayout(layout)} title="Save your order, pins and colours to a file"><Icon name="download" size={14} />Export layout</button>
                  <label className="btn btn-sm" title="Load a layout file saved earlier">
                    <Icon name="upload" size={14} />Import layout
                    <input type="file" accept="application/json,.json" hidden aria-label="Import layout file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importLayout(f, setLayout, toast); }} />
                  </label>
                  <div className="swatches" role="group" aria-label="Accent colour">
                    {ACCENTS.map((c) => <button key={c} className={`swatch ${layout.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setLayout({ accent: c })} aria-label={`Accent ${c}`} aria-pressed={layout.accent === c} />)}
                  </div>
                </div>
              </div>
              {pinned.length > 0 && <section><h3 className="svc-group">Pinned</h3>{grid(pinned)}</section>}
              {groups.map((g) => (
                <section key={g || 'other'}>
                  {(groups.length > 1 || pinned.length > 0) && <h3 className="svc-group">{g || 'Other'}</h3>}
                  {grid(rest.filter((t) => (t.group ?? '') === g))}
                </section>
              ))}
            </>
          );
        }}
      </Async>
    </div>
  );
}

/** Scans the running guests for services homedash knows how to watch. */
function Finder({ onClose, onPick }: { onClose: () => void; onPick: (s: TileSuggestion) => void }) {
  const [res, setRes] = useState<{ scanned: number; found: TileSuggestion[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.discoverTiles().then(setRes).catch((e) => setErr((e as Error).message)); }, []);
  return (
    <Modal title="Find services" wide onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {!res && !err && <p className="muted"><Spinner size={14} /> Asking your running guests what they host…</p>}
      {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}</span></div>}
      {res && res.found.length === 0 && <p className="muted">Looked at {res.scanned} address{res.scanned === 1 ? '' : 'es'} and found nothing new. Services on unusual ports can be added by hand.</p>}
      {res && res.found.length > 0 && (
        <>
          <p className="muted small">Found on {res.scanned} address{res.scanned === 1 ? '' : 'es'}. Pick one to add it; you will be asked for any API key it needs.</p>
          <div className="stack-sm">
            {res.found.map((f) => (
              <button key={f.url} className="kind-pick" style={{ width: '100%' }} onClick={() => onPick(f)}>
                <Logo kind={f.kind} label={f.label} /><span style={{ flex: 1 }}><b>{f.label}</b><br /><small className="muted">on {f.guest.name} (#{f.guest.vmid}) · {f.url.replace(/^https?:\/\//, '')}</small></span><Icon name="plus" size={15} />
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function exportLayout(l: Layout) {
  const url = URL.createObjectURL(new Blob([layoutFileText(l)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'homedash-services-layout.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importLayout(file: File, set: (p: Partial<Layout>) => void, toast: { success: (m: string) => void; error: (m: string) => void }) {
  const parsed = parseLayoutFile(await file.text());
  if (!parsed) { toast.error('That file is not a homedash Services layout'); return; }
  set(parsed);
  toast.success('Layout imported');
}
