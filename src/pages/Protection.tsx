import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, HoldButton, PageHeader, Spinner } from '../components/ui';
import type { Tone } from '../components/ui';
import { fmtBytes } from '../format';
import { useQuery, useSearch, useToast } from '../hooks';
import type { ProtectionGuest } from '../types';

const TONE: Record<ProtectionGuest['backup'], Tone> = { ok: 'green', stale: 'amber', never: 'red' };

export default function Protection() {
  const q = useQuery(api.protection, [], 120000);
  const toast = useToast();
  const { q: search } = useSearch();
  const [busy, setBusy] = useState<number | null>(null);
  const needle = search.trim().toLowerCase();

  async function snap(g: ProtectionGuest) {
    setBusy(g.vmid);
    try { await api.snapshotCreate(g.vmid); toast.success(`Snapshot of ${g.name} started`); setTimeout(q.reload, 3000); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function prune(g: ProtectionGuest) {
    try {
      const list = (await api.snapshots(g.vmid)).filter((s) => !s.current).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      if (!list.length) return;
      await api.snapshotDelete(g.vmid, list[0].name);
      toast.success(`Deleting snapshot ${list[0].name}`);
      setTimeout(q.reload, 3000);
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <>
      <PageHeader eyebrow="Insights" title="Protection" sub="Which guests have a recent backup, which have none, and which hold stale snapshots." />
      <Async q={q} rows={6} h={60}>
        {(p) => {
          const rows = p.guests.filter((g) => !needle || `${g.vmid} ${g.name}`.toLowerCase().includes(needle))
            .sort((a, b) => ({ never: 0, stale: 1, ok: 2 })[a.backup] - ({ never: 0, stale: 1, ok: 2 })[b.backup] || a.vmid - b.vmid);
          return (
            <>
              <div className="stat-row">
                <div><b>{p.summary.ok}/{p.summary.total}</b><span>Backed up in the last {p.maxAgeDays} days</span></div>
                <div><b>{p.summary.never}</b><span>Never backed up</span></div>
                <div><b>{p.summary.stale}</b><span>Backup too old</span></div>
                <div><b>{p.summary.notInJob}</b><span>Not in any backup job</span></div>
                <div><b>{p.summary.oldSnapshots}</b><span>Snapshots older than {p.snapshotMaxAgeDays} d</span></div>
              </div>
              {p.unreadableStorages.length > 0 && <div className="callout warn"><span>Could not read backups on: {p.unreadableStorages.join(', ')}. Give the API token Datastore.Audit on them.</span></div>}
              <Card pad={false}>
                <div className="list-row head"><span>Guest</span><span>Backup</span><span>Last backup</span><span>Snapshots</span><span /></div>
                {rows.map((g) => (
                  <div key={g.vmid} className="list-row">
                    <div><a href={`#/guests/${g.vmid}`}><b>{g.name}</b></a> <span className="muted small">#{g.vmid}</span>{g.inJob === false && <> <Badge tone="amber" title="Not part of any scheduled backup job">no job</Badge></>}</div>
                    <div><Badge tone={TONE[g.backup]} dot>{g.backup === 'ok' ? 'Protected' : g.backup === 'stale' ? 'Stale' : 'Never'}</Badge></div>
                    <div className="small">{g.lastBackup ? `${g.backupAgeDays} d ago · ${g.backups} kept · ${fmtBytes(g.backupBytes)}` : <span className="muted">–</span>}</div>
                    <div className="small">{g.snapshots ? <>{g.snapshots} · oldest {g.oldestSnapshotDays} d {g.oldSnapshot && <Badge tone="amber">old</Badge>}</> : <span className="muted">none</span>}</div>
                    <div className="row-actions">
                      <button className="btn btn-sm" disabled={busy === g.vmid} onClick={() => snap(g)}>{busy === g.vmid ? <Spinner size={13} /> : null}Snapshot now</button>
                      {g.oldSnapshot && <HoldButton danger onConfirm={() => prune(g)}>Hold: drop oldest</HoldButton>}
                    </div>
                  </div>
                ))}
              </Card>
            </>
          );
        }}
      </Async>
    </>
  );
}
