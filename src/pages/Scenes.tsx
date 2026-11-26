import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, HoldButton, Icon, ManagedBadge, Modal, PageHeader, Spinner } from '../components/ui';
import type { Tone } from '../components/ui';
import { timeAgo } from '../format';
import { useQuery, useToast } from '../hooks';
import type { Guest, Scene, SceneStep, Schedule } from '../types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ACTIONS: SceneStep['action'][] = ['start', 'shutdown', 'stop', 'reboot'];
const RUN_TONE: Record<string, Tone> = { ok: 'green', error: 'red', running: 'amber', pending: 'gray', skipped: 'gray' };

function SceneEditor({ scene, guests, onClose, onDone }: { scene: Scene | null; guests: Guest[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(scene?.name ?? '');
  const [steps, setSteps] = useState<SceneStep[]>(scene?.steps ?? [{ vmid: guests[0]?.vmid ?? 100, action: 'start', waitSeconds: 0, continueOnError: false }]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const patch = (i: number, p: Partial<SceneStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => setSteps((s) => { const a = [...s]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  async function save() {
    setBusy(true); setErr('');
    try { await api.sceneSave(scene?.id ?? null, name, steps); toast.success('Scene saved'); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal wide title={scene ? `Edit ${scene.name}` : 'New scene'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>{busy ? <Spinner /> : null}Save</button></>}>
      <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Game night" autoFocus /></label>
      <div className="field">Steps, run top to bottom. Each waits for the Proxmox task to finish.</div>
      {steps.map((s, i) => (
        <div key={i} className="form-grid" style={{ gridTemplateColumns: '1.6fr 1fr 0.8fr auto', alignItems: 'end' }}>
          <label>Guest<select className="input" value={s.vmid} onChange={(e) => patch(i, { vmid: Number(e.target.value) })}>
            {guests.map((g) => <option key={g.vmid} value={g.vmid}>{g.name} ({g.vmid})</option>)}</select></label>
          <label>Action<select className="input" value={s.action} onChange={(e) => patch(i, { action: e.target.value as SceneStep['action'] })}>{ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></label>
          <label>Then wait (s)<input className="input" type="number" min={0} max={3600} value={s.waitSeconds} onChange={(e) => patch(i, { waitSeconds: Number(e.target.value) })} /></label>
          <div className="row-actions">
            <button className="btn btn-sm" onClick={() => move(i, -1)} aria-label="Move up">↑</button>
            <button className="btn btn-sm" onClick={() => move(i, 1)} aria-label="Move down">↓</button>
            <button className="btn btn-sm btn-danger" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove step">×</button>
          </div>
          <label className="check full" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={s.continueOnError} onChange={(e) => patch(i, { continueOnError: e.target.checked })} />Keep going if this step fails</label>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setSteps((s) => [...s, { vmid: guests[0]?.vmid ?? 100, action: 'start', waitSeconds: 0, continueOnError: false }])}>Add step</button>
      {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}</span></div>}
    </Modal>
  );
}

function ScheduleEditor({ sched, scenes, guests, onClose, onDone }: { sched: Schedule | null; scenes: Scene[]; guests: Guest[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(sched?.name ?? '');
  const [kind, setKind] = useState<'scene' | 'guest'>(sched?.vmid != null ? 'guest' : 'scene');
  const [sceneId, setSceneId] = useState(sched?.sceneId ?? scenes[0]?.id ?? 0);
  const [vmid, setVmid] = useState(sched?.vmid ?? guests[0]?.vmid ?? 100);
  const [action, setAction] = useState(sched?.action ?? 'shutdown');
  const [days, setDays] = useState<number[]>(sched?.days ?? [1, 2, 3, 4, 5]);
  const [time, setTime] = useState(sched?.time ?? '23:00');
  const [err, setErr] = useState('');
  async function save() {
    try {
      await api.scheduleSave(sched?.id ?? null, { name, sceneId: kind === 'scene' ? sceneId : null, vmid: kind === 'guest' ? vmid : null, action: kind === 'guest' ? action : null, days, time, enabled: sched?.enabled ?? true });
      toast.success('Schedule saved'); onDone();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <Modal title={sched ? 'Edit schedule' : 'New schedule'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
      <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly shutdown" /></label>
      <label className="field">Runs<select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'scene' | 'guest')}><option value="scene">A scene</option><option value="guest">One guest action</option></select></label>
      {kind === 'scene' ? (
        <label className="field">Scene<select className="input" value={sceneId} onChange={(e) => setSceneId(Number(e.target.value))}>{scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      ) : (<>
        <label className="field">Guest<select className="input" value={vmid} onChange={(e) => setVmid(Number(e.target.value))}>{guests.map((g) => <option key={g.vmid} value={g.vmid}>{g.name} ({g.vmid})</option>)}</select></label>
        <label className="field">Action<select className="input" value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></label>
      </>)}
      <label className="field">Time (server time zone)<input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      <div className="pill-list">{DAYS.map((d, i) => (
        <button key={d} className={`btn btn-sm ${days.includes(i) ? 'btn-primary' : ''}`} onClick={() => setDays((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i]))}>{d}</button>))}</div>
      {err && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{err}</span></div>}
    </Modal>
  );
}

export default function Scenes() {
  const scenes = useQuery(api.scenes, []);
  const scheds = useQuery(api.schedules, [], 30000);
  const guests = useQuery(api.guests, []);
  const runs = useQuery(api.sceneRuns, [], 3000);
  const toast = useToast();
  const [editScene, setEditScene] = useState<Scene | null | undefined>(undefined);
  const [editSched, setEditSched] = useState<Schedule | null | undefined>(undefined);
  const name = (vmid: number) => guests.data?.find((g) => g.vmid === vmid)?.name ?? `#${vmid}`;
  const reloadAll = () => { scenes.reload(); scheds.reload(); setEditScene(undefined); setEditSched(undefined); };

  async function run(s: Scene) {
    try { await api.sceneRun(s.id); toast.info(`Running ${s.name}`); runs.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  async function toggle(s: Schedule) {
    try { await api.scheduleSave(s.id, { name: s.name, sceneId: s.sceneId, vmid: s.vmid, action: s.action, days: s.days, time: s.time, enabled: !s.enabled }); scheds.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <>
      <PageHeader eyebrow="Automation" title="Scenes and schedules" sub="Save an ordered set of power steps, run it with one click, or put it on a weekly timer." actions={
        <button className="btn btn-primary btn-sm" onClick={() => setEditScene(null)} disabled={!guests.data}>New scene</button>} />
      {editScene !== undefined && guests.data && <SceneEditor scene={editScene} guests={guests.data} onClose={() => setEditScene(undefined)} onDone={reloadAll} />}
      {editSched !== undefined && guests.data && scenes.data && <ScheduleEditor sched={editSched} scenes={scenes.data} guests={guests.data} onClose={() => setEditSched(undefined)} onDone={reloadAll} />}

      <Async q={scenes} rows={3} h={80} isEmpty={(d) => d.length === 0} empty={{ title: 'No scenes yet', hint: 'A scene might stop the media server and then start the gaming VM, or shut everything down for the night.' }}>
        {(list) => (
          <div className="site-grid">
            {list.map((s) => (
              <Card key={s.id}>
                <CardHead title={s.name} sub={`${s.steps.length} step${s.steps.length === 1 ? '' : 's'}`} right={<div className="row-actions">
                  <button className="btn btn-sm btn-primary" onClick={() => run(s)}><Icon name="play" size={14} />Run</button>
                  {s.managed ? <ManagedBadge /> : <>
                    <button className="btn btn-sm" onClick={() => setEditScene(s)}>Edit</button>
                    <HoldButton danger onConfirm={() => api.sceneDelete(s.id).then(reloadAll)}>Hold: delete</HoldButton></>}</div>} />
                <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{s.steps.map((st, i) => <li key={i}>{st.action} <b>{name(st.vmid)}</b>{st.waitSeconds ? <span className="muted"> · wait {st.waitSeconds}s</span> : null}</li>)}</ol>
              </Card>
            ))}
          </div>
        )}
      </Async>

      <Card pad={false} className="section-gap">
        <CardHead title="Schedules" sub="Times use the server's time zone." right={<button className="btn btn-sm" onClick={() => setEditSched(null)} disabled={!guests.data || !scenes.data}>New schedule</button>} />
        {scheds.data?.length ? scheds.data.map((s) => (
          <div key={s.id} className="list-row">
            <div><b>{s.name}</b><div className="muted small">{s.sceneId != null ? `Scene: ${scenes.data?.find((x) => x.id === s.sceneId)?.name ?? '?'}` : `${s.action} ${name(s.vmid ?? 0)}`}</div></div>
            <div className="small">{s.days.map((d) => DAYS[d]).join(' ')} at <b>{s.time}</b></div>
            <div className="small muted">{s.lastRun ? `${timeAgo(new Date(s.lastRun).toISOString())}: ${s.lastResult}` : 'never run'}</div>
            <div className="row-actions">
              {s.managed ? <ManagedBadge /> : <>
                <button className="btn btn-sm" onClick={() => toggle(s)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                <button className="btn btn-sm" onClick={() => setEditSched(s)}>Edit</button>
                <HoldButton danger onConfirm={() => api.scheduleDelete(s.id).then(reloadAll)}>Hold: delete</HoldButton></>}
            </div>
          </div>
        )) : <p className="muted small" style={{ padding: 16 }}>No schedules.</p>}
      </Card>

      {!!runs.data?.length && (
        <Card pad={false} className="section-gap">
          <CardHead title="Recent runs" />
          {runs.data.slice(0, 6).map((r) => (
            <div key={r.id} className="list-row">
              <div><b>{r.scene}</b><div className="muted small">{timeAgo(r.startedAt)} by {r.by}</div></div>
              <div className="pill-list">{r.steps.map((st, i) => <Badge key={i} tone={RUN_TONE[st.status]} dot title={st.message}>{st.action} {name(st.vmid)}</Badge>)}</div>
              <div><Badge tone={RUN_TONE[r.status]}>{r.status}</Badge></div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
