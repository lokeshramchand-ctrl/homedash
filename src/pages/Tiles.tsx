import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, Icon, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { timeAgo } from '../format';
import { useQuery, useSearch, useToast } from '../hooks';
import { ServiceForm, emptyDraft } from '../components/ServiceForm';
import type { Draft } from '../components/ServiceForm';
import type { Tile, TileCatalog, TileAdmin } from '../types';

const TONE: Record<Tile['state'], Tone> = { ok: 'green', warn: 'amber', down: 'red', pending: 'gray' };
const LABEL: Record<Tile['state'], string> = { ok: 'Healthy', warn: 'Attention', down: 'Unreachable', pending: 'Checking…' };
const KIND: Record<string, string> = {
  docker: 'Docker', portainer: 'Portainer', pihole: 'Pi-hole', npm: 'Nginx Proxy Manager', jellyfin: 'Jellyfin', homeassistant: 'Home Assistant', pbs: 'Proxmox Backup Server', http: 'HTTP',
};

function TileCard({ t, onRefresh, busy, onEdit, onDelete }: { t: Tile; onRefresh: () => void; busy: boolean; onEdit?: () => void; onDelete?: () => void }) {
  return (
    <Card className={`svc svc-${t.state}`}>
      <div className="svc-head">
        <div className="svc-title">
          <b>{t.link ? <a className="link" href={t.link} target="_blank" rel="noopener noreferrer">{t.name}</a> : t.name}</b>
          <small className="muted">{KIND[t.kind] ?? t.kind}{t.summary && t.state !== 'down' ? ` · ${t.summary}` : ''}</small>
        </div>
        <Badge tone={TONE[t.state]} dot>{LABEL[t.state]}</Badge>
      </div>
      {t.state === 'down' && <p className="svc-err small">{t.error ?? 'No answer'}</p>}
      {t.stats && t.stats.length > 0 && t.state !== 'down' && (
        <dl className="svc-stats">
          {t.stats.map((s) => (
            <div key={s.label} className={s.tone ? `tone-${s.tone}` : undefined}><dt>{s.label}</dt><dd>{s.value}</dd></div>
          ))}
        </dl>
      )}
      <div className="svc-foot muted small">
        <span>{t.at ? `${timeAgo(new Date(t.at).toISOString())}${t.ms != null ? ` · ${t.ms} ms` : ''}` : 'waiting for first check'}</span>
        <span className="row-actions">
          {onEdit && <button className="icon-btn" onClick={onEdit} aria-label={`Edit ${t.name}`} title="Edit"><Icon name="edit" size={15} /></button>}
          {onDelete && <button className="icon-btn" onClick={onDelete} aria-label={`Remove ${t.name}`} title="Remove"><Icon name="trash" size={15} /></button>}
          <button className="icon-btn" onClick={onRefresh} disabled={busy} aria-label={`Refresh ${t.name}`} title="Check now"><Icon name="refresh" size={15} /></button>
        </span>
      </div>
    </Card>
  );
}

export default function Tiles({ role }: { role: string }) {
  const q = useQuery(api.tiles, [], 15000);
  const isAdmin = role === 'admin';
  const cat = useQuery<TileCatalog>(api.tileCatalog, [], 0);
  const adm = useQuery<TileAdmin | null>(() => (isAdmin ? api.tileAdmin() : Promise.resolve(null)), [isAdmin], 0);
  const [form, setForm] = useState<Draft | null>(null);
  const { q: search } = useSearch();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async (t: Tile) => {
    setBusy(t.id);
    try { await api.refreshTile(t.id); q.reload?.(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
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

  return (
    <>
      <PageHeader title="Service tiles" sub="Status of the other services in your lab." actions={isAdmin ? (
        <button className="btn btn-primary" disabled={!canEdit} title={canEdit ? undefined : 'Set a secret key first: run homedash-config apply'} onClick={() => setForm(emptyDraft())}><Icon name="plus" size={15} />Add service</button>
      ) : undefined} />
      {form && cat.data && <ServiceForm catalog={cat.data} draft={form} onClose={() => setForm(null)} onSaved={() => { q.reload(); adm.reload(); }} />}
      <Async q={q} rows={4} h={140} isEmpty={(d) => d.length === 0} empty={{ title: 'No services yet', hint: isAdmin ? 'Use Add service to watch Pi-hole, Jellyfin, Docker and more.' : 'An administrator can add services here.' }}>
        {(list) => {
          const s = search.trim().toLowerCase();
          const shown = list.filter((t) => !s || `${t.name} ${t.kind} ${t.group ?? ''}`.toLowerCase().includes(s));
          const groups = [...new Set(shown.map((t) => t.group ?? ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
          const bad = list.filter((t) => t.state === 'down').length, warn = list.filter((t) => t.state === 'warn').length;
          return (
            <>
              <div className="stat-row">
                <div><b>{list.length - bad - warn}</b><span>healthy</span></div>
                <div><b>{warn}</b><span>need attention</span></div>
                <div><b>{bad}</b><span>unreachable</span></div>
              </div>
              {groups.map((g) => (
                <section key={g || 'other'}>
                  {(groups.length > 1) && <h3 className="svc-group">{g || 'Other'}</h3>}
                  <div className="svc-grid">
                    {shown.filter((t) => (t.group ?? '') === g).map((t) => <TileCard key={t.id} t={t} busy={busy === t.id} onRefresh={() => void refresh(t)} onEdit={canEdit && t.source === 'ui' ? () => edit(t) : undefined} onDelete={canEdit && t.source === 'ui' ? () => void remove(t) : undefined} />)}
                  </div>
                </section>
              ))}
            </>
          );
        }}
      </Async>
    </>
  );
}
