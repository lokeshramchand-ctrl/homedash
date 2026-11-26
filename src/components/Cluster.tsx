import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Icon, Modal, Spinner } from './ui';
import { useToast } from '../hooks';
import { select } from '../selection';
import type { ClustersResponse, MigrateInfo } from '../types';

/** Cluster and node switchers for the top bar. Each one only appears when there is something to choose. */
export function ClusterPicker({ data, cluster, node }: { data: ClustersResponse | undefined; cluster: string; node: string }) {
  if (!data) return null;
  const current = data.clusters.find((c) => c.id === cluster) ?? data.clusters[0];
  if (!current) return null;
  const nodes = current.nodes;
  return (
    <div className="picker" role="group" aria-label="Cluster and node">
      {data.clusters.length > 1 && (
        <label className="picker-sel" title="Cluster">
          <Icon name="server" size={14} />
          <select aria-label="Cluster" value={current.id} onChange={(e) => select(e.target.value)}>
            {data.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}{c.reachable ? '' : ' (unreachable)'}</option>)}
          </select>
        </label>
      )}
      {nodes.length > 1 && (
        <label className="picker-sel" title="Node shown on the Node, Overview, Health and Capacity pages">
          <Icon name="node" size={14} />
          <select aria-label="Node" value={node || data.defaultNode} onChange={(e) => select(current.id, e.target.value)}>
            {nodes.map((n) => <option key={n.name} value={n.name}>{n.name}{n.online ? '' : ' (offline)'}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

const MODE: Record<MigrateInfo['mode'], string> = {
  live: 'The VM keeps running while it moves (live migration). Local disks and passthrough devices can block this.',
  restart: 'Containers cannot move while running: it is shut down, moved and started again on the target.',
  offline: 'The guest is stopped, so it is simply moved to the target node.',
};

/** Move a guest to another node of its cluster. */
export function MigrateModal({ vmid, name, onClose, onDone }: { vmid: number; name: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [info, setInfo] = useState<MigrateInfo | null>(null);
  const [err, setErr] = useState('');
  const [target, setTarget] = useState('');
  const [withDisks, setWithDisks] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-checked when "copy local disks" changes: it decides whether a running VM is blocked.
  useEffect(() => {
    api.migrateInfo(vmid, withDisks).then((i) => { setInfo(i); setTarget((cur) => (i.targets.some((t) => t.name === cur && t.allowed) ? cur : i.targets.find((t) => t.allowed)?.name ?? '')); }).catch((e) => setErr((e as Error).message));
  }, [vmid, withDisks]);
  const checks = info ? [...info.checks, ...(info.targets.find((t) => t.name === target)?.checks ?? [])] : [];
  const blocked = checks.some((c) => c.level === 'block');

  async function go() {
    setBusy(true);
    setErr('');
    try {
      const { taskId } = await api.migrate(vmid, target, withDisks);
      for (let i = 0; i < 600; i++) { // a migration can take a while
        await new Promise((r) => setTimeout(r, 2000));
        const t = await api.task(taskId);
        if (t.status === 'error') throw new Error(t.message || 'Migration failed');
        if (t.status === 'ok') break;
      }
      toast.success(`${name} moved to ${target}`);
      onDone();
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Migrate ${name}`} onClose={busy ? () => undefined : onClose} footer={
      <>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={go} disabled={busy || !target || !info || blocked}>{busy ? <Spinner size={14} /> : <Icon name="rotate" size={15} />}Migrate to {target || '…'}</button>
      </>
    }>
      {!info && !err && <p className="muted"><Spinner size={14} /> Checking where it can go…</p>}
      {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}</span></div>}
      {info && (
        <div className="stack-sm">
          <p>Now on <b>{info.node}</b>. {MODE[info.mode]}</p>
          <label className="field">Move to
            <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
              {info.targets.length === 0 && <option value="">No other node</option>}
              {info.targets.map((t) => <option key={t.name} value={t.name} disabled={!t.allowed}>{t.name}{t.allowed ? '' : ` (${t.reason ?? 'not possible'})`}</option>)}
            </select>
          </label>
          {info.localDisks.length > 0 && (
            <>
              <p className="muted small">This guest has disks that live only on {info.node}: {info.localDisks.map((d) => d.volid).join(', ')}.</p>
              {info.type === 'qemu' && <label className="check"><input type="checkbox" checked={withDisks} onChange={(e) => setWithDisks(e.target.checked)} />Copy local disks too (slower)</label>}
            </>
          )}
          {checks.length > 0 && (
            <ul className="stack-sm" aria-label="Pre-flight checks" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {checks.map((c) => (
                <li key={c.id + c.text} className={`callout ${c.level === 'block' ? 'err' : c.level === 'warn' ? 'warn' : ''}`}>
                  <Icon name={c.level === 'info' ? 'info' : 'alert'} size={16} /><span><b>{c.level === 'block' ? 'Blocked: ' : c.level === 'warn' ? 'Heads up: ' : ''}</b>{c.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
