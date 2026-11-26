import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, Icon, PageHeader, Spinner } from '../components/ui';
import { fmtBytes, timeAgo } from '../format';
import { useQuery, useToast } from '../hooks';
import type { AuditReport } from '../types';

function BackupCard() {
  const q = useQuery(api.selfBackups, [], 0);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try { const r = await api.selfBackupRun(); toast.success(`Backup written: ${r.name}`); q.reload(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Card pad={false}>
      <CardHead title="Backups of homedash's own data" sub="Users, API tokens, scenes, schedules, settings and the audit trail, in one consistent copy." right={
        <button className="btn btn-primary btn-sm" disabled={busy || !q.data?.enabled} onClick={run} title={q.data?.enabled ? undefined : 'Switch backups on first (see below)'}>
          {busy ? <Spinner size={13} /> : <Icon name="download" size={14} />}Back up now
        </button>} />
      <Async q={q} rows={3} h={48}>
        {(b) => !b.enabled ? (
          <div className="pad">
            <p>Backups are off. Add this to <code>/etc/homedash/homedash.yaml</code>, then run <code>homedash-config apply --restart</code>:</p>
            <pre className="code-snippet">{'server:\n  backup_dir: /var/backups/homedash'}</pre>
          </div>
        ) : (
          <>
            <div className="pad muted small">A copy is written every {b.everyHours} hours and the newest {b.keep} are kept. Files are readable only by the service account and are never served over the web.</div>
            {b.files.length === 0 ? <div className="pad">No backup yet. Press <b>Back up now</b>.</div> : b.files.map((f, i) => (
              <div key={f.name} className="list-row">
                <div><span className="mono">{f.name}</span></div>
                <div className="small">{fmtBytes(f.size)}</div>
                <div className="small muted">{timeAgo(f.at)}</div>
                <div>{i === 0 && <Badge tone="green">newest</Badge>}</div>
              </div>
            ))}
            <div className="pad muted small"><b>To restore:</b> stop the service (<code>systemctl stop homedash</code>), copy the file over <code>data/homedash.db</code> (and delete any <code>homedash.db-wal</code> and <code>-shm</code> next to it), then start it again.</div>
          </>
        )}
      </Async>
    </Card>
  );
}

function AuditCard() {
  const [rep, setRep] = useState<AuditReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function verify() {
    setBusy(true); setErr('');
    try { setRep(await api.auditVerify()); } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Card pad={false}>
      <CardHead title="Audit trail" sub="Every action is recorded and chained to the one before it, so edits or removed rows can be detected." right={
        <button className="btn btn-sm" disabled={busy} onClick={verify}>{busy ? <Spinner size={13} /> : <Icon name="check" size={14} />}Verify now</button>} />
      <div className="pad">
        {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}</span></div>}
        {rep && rep.ok && <div className="callout ok" role="status"><Icon name="check" size={16} /><span><b>The trail is intact.</b> {rep.checked.toLocaleString()} entries checked, none changed or removed.</span></div>}
        {rep && !rep.ok && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span><b>The trail does not verify.</b> Entry {rep.brokenAt}: {rep.problem}. {rep.checked.toLocaleString()} entries before it are fine.</span></div>}
        {!rep && !err && <p className="muted small">Press <b>Verify now</b> to check the whole chain.</p>}
        <p className="small" style={{ marginTop: 14 }}>
          <b>Download:</b>{' '}
          <a className="link" href="/api/admin/audit/export?format=json" download>JSON lines</a>{' · '}
          <a className="link" href="/api/admin/audit/export?format=cef" download>CEF (for SIEM tools)</a>
        </p>
        <p className="muted small">Truncating the very last rows cannot be detected from inside homedash. To cover that, send the trail to a log collector with <code>audit.syslog</code> or <code>audit.webhook</code>.</p>
      </div>
    </Card>
  );
}

export default function Backups() {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Backups and audit" sub="Keep a copy of homedash's own data, and prove the record of who did what has not been tampered with." />
      <BackupCard />
      <AuditCard />
    </>
  );
}
