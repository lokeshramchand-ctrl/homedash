import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, EmptyState, HoldButton, Icon, ManagedBadge, Spinner } from '../components/ui';
import { useQuery, useToast } from '../hooks';
import type { AlertLevel, NotifyChannel, RouteItem, SilenceItem, WeeklyWindow } from '../types';

export const CATEGORY_LABEL: Record<string, string> = {
  monitor: 'Uptime monitors', guest: 'Guests', host: 'Proxmox host', resources: 'Resource pressure', tasks: 'Failed tasks', gpu: 'GPU', hardware: 'Hardware errors',
  disks: 'Disk health', services: 'System services', crowdsec: 'CrowdSec', db: 'Database', app: 'Dashboard', auth: 'Sign-in',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LEVELS: [AlertLevel, string][] = [['info', 'Everything'], ['warn', 'Warnings and errors'], ['error', 'Errors only']];
const dt = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
/** <input type=datetime-local> wants local time without a zone. */
const local = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

const weeklyText = (w: WeeklyWindow) => `every ${w.days.map((d) => DAYS[d]).join(', ')} from ${w.start} for ${w.minutes >= 60 ? `${Math.round(w.minutes / 6) / 10} h` : `${w.minutes} min`}`;

function Multi({ options, value, onChange, label }: { options: [string, string][]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="chips-row">
      {options.map(([id, text]) => {
        const on = value.includes(id);
        return <button type="button" key={id} className={`chip-toggle ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== id) : [...value, id])}>{text}</button>;
      })}
    </div>
  );
}

function WeeklyEditor({ value, onChange }: { value: WeeklyWindow | null; onChange: (w: WeeklyWindow | null) => void }) {
  if (!value) return <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ days: [1, 2, 3, 4, 5], start: '22:00', minutes: 120 })}>Repeat weekly instead</button>;
  return (
    <div className="stack-sm">
      <Multi label="Days" options={DAYS.map((d, i) => [String(i), d])} value={value.days.map(String)} onChange={(v) => onChange({ ...value, days: v.map(Number).sort() })} />
      <div className="form-grid">
        <label>Starts at<input className="input" type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value || '00:00' })} /></label>
        <label>Lasts (minutes)<input className="input" type="number" min={1} max={1440} value={value.minutes} onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })} /></label>
      </div>
      <p className="muted small">Server time. A window that starts at 22:00 for 180 minutes runs until 01:00 the next day.</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>Use a one-off window instead</button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ maintenance windows
export function SilencesTab({ categories }: { categories: string[] }) {
  const q = useQuery(api.silences, [], 15_000);
  const toast = useToast();
  const now = Date.now();
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [startsAt, setStartsAt] = useState(local(now));
  const [endsAt, setEndsAt] = useState(local(now + 2 * 3600_000));
  const [cats, setCats] = useState<string[]>([]);
  const [contains, setContains] = useState('');
  const [weekly, setWeekly] = useState<WeeklyWindow | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.silenceSave(null, {
        name: name.trim(), reason: reason.trim(), categories: cats, contains: contains.trim(), weekly,
        ...(weekly ? {} : { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }),
      });
      toast.success('Maintenance window created');
      setName(''); setReason(''); setCats([]); setContains(''); setWeekly(null);
      q.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const preset = (hours: number) => { setStartsAt(local(Date.now())); setEndsAt(local(Date.now() + hours * 3600_000)); };

  return (
    <div className="stack">
      <Card>
        <CardHead title="New maintenance window" sub="Hold alerts back while you work. They are still listed under Recently sent, and incident tools still close incidents when things recover." />
        <div className="form-grid">
          <label className="full">Name<input className="input" value={name} maxLength={80} placeholder="e.g. Kernel update on the host" onChange={(e) => setName(e.target.value)} /></label>
          {!weekly && (
            <>
              <label>From<input className="input" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label>
              <label>Until<input className="input" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></label>
              <div className="full chips-row" aria-label="Presets">
                {[[1, '1 hour'], [4, '4 hours'], [24, '1 day'], [72, '3 days']].map(([h, t]) => <button key={h} type="button" className="btn btn-sm" onClick={() => preset(h as number)}>{t}</button>)}
              </div>
            </>
          )}
          <div className="full"><WeeklyEditor value={weekly} onChange={setWeekly} /></div>
          <div className="full field"><span>Only silence these kinds of alerts <small>(none selected = all)</small></span>
            <Multi label="Categories" options={categories.map((c) => [c, CATEGORY_LABEL[c] ?? c])} value={cats} onChange={setCats} /></div>
          <label>Only alerts containing this text <small>(optional)</small><input className="input" value={contains} maxLength={100} placeholder="e.g. nextcloud" onChange={(e) => setContains(e.target.value)} /></label>
          <label>Reason <small>(optional)</small><input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="full"><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={create}>{busy ? <Spinner size={14} /> : <Icon name="clock" size={15} />}Create window</button></div>
        </div>
      </Card>
      <Card pad={false}>
        <div className="pad"><CardHead title="Windows" /></div>
        <Async q={q} rows={2} h={60}>
          {(list) => list.length === 0 ? <EmptyState icon="clock" title="No maintenance windows" hint="Create one above before planned work." /> : (
            <ul className="feed">
              {list.map((s) => <SilenceRow key={s.id} s={s} onDelete={async () => { try { await api.silenceDelete(s.id); q.reload(); } catch (e) { toast.error((e as Error).message); } }} />)}
            </ul>
          )}
        </Async>
      </Card>
    </div>
  );
}

function SilenceRow({ s, onDelete }: { s: SilenceItem; onDelete: () => void }) {
  const state = s.active ? ['green', 'active now'] as const : s.upcoming ? ['amber', 'scheduled'] as const : s.expired ? ['gray', 'ended'] as const : ['amber', 'waiting for its next slot'] as const;
  return (
    <li>
      <div className="grow"><b>{s.name}</b>
        <p className="muted small">{s.weekly ? weeklyText(s.weekly) : `${dt(s.startsAt)} to ${dt(s.endsAt)}`} · {s.categories.length ? s.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(', ') : 'all alerts'}{s.contains ? ` · containing "${s.contains}"` : ''}{s.reason ? ` · ${s.reason}` : ''} · by {s.createdBy}</p></div>
      <Badge tone={state[0]} dot>{state[1]}</Badge>
      {s.managed ? <ManagedBadge /> : <HoldButton danger onConfirm={onDelete}>Delete</HoldButton>}
    </li>
  );
}

// ------------------------------------------------------------------------------------------ routing
export function RoutesTab({ categories, channels, admin }: { categories: string[]; channels: NotifyChannel[]; admin: boolean }) {
  const q = useQuery(api.routes, [], 0);
  const toast = useToast();
  const usable = channels.filter((c) => c.configured);
  const [name, setName] = useState('');
  const [cats, setCats] = useState<string[]>([]);
  const [minLevel, setMinLevel] = useState<AlertLevel>('error');
  const [contains, setContains] = useState('');
  const [chs, setChs] = useState<string[]>([]);
  const [weekly, setWeekly] = useState<WeeklyWindow | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (id: string) => channels.find((c) => c.id === id)?.label ?? id;

  async function create() {
    setBusy(true);
    try {
      await api.routeSave(null, { name: name.trim(), categories: cats, minLevel, contains: contains.trim(), channels: chs, weekly });
      toast.success('Route added');
      setName(''); setCats([]); setContains(''); setChs([]); setWeekly(null);
      q.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function toggle(r: RouteItem) {
    try { await api.routeSave(r.id, { ...r, enabled: !r.enabled }); q.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <div className="stack">
      <Card>
        <CardHead title="Routing" sub="Send certain alerts to certain channels, for example errors to PagerDuty, warnings to Slack, nights to a different channel. An alert that matches no route follows the normal channel settings, so a route can never make an alert disappear." />
        {!admin ? <p className="muted small">Only administrators can change routes.</p> : usable.length === 0 ? <p className="muted small">Set up a channel first.</p> : (
          <div className="form-grid">
            <label className="full">Name<input className="input" value={name} maxLength={80} placeholder="e.g. Pages for outages" onChange={(e) => setName(e.target.value)} /></label>
            <div className="full field"><span>When the alert is about <small>(none selected = anything)</small></span>
              <Multi label="Categories" options={categories.map((c) => [c, CATEGORY_LABEL[c] ?? c])} value={cats} onChange={setCats} /></div>
            <label>At least this severe
              <select className="input" value={minLevel} onChange={(e) => setMinLevel(e.target.value as AlertLevel)}>{LEVELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
            <label>and containing <small>(optional)</small><input className="input" value={contains} maxLength={100} onChange={(e) => setContains(e.target.value)} /></label>
            <div className="full field"><span>Send it to</span>
              <Multi label="Channels" options={usable.map((c) => [c.id, c.label])} value={chs} onChange={setChs} /></div>
            <div className="full field"><span>Only at these times <small>(optional)</small></span><WeeklyEditor value={weekly} onChange={setWeekly} /></div>
            <div className="full"><button className="btn btn-primary" disabled={busy || !name.trim() || !chs.length} onClick={create}>{busy ? <Spinner size={14} /> : <Icon name="check" size={15} />}Add route</button></div>
          </div>
        )}
      </Card>
      <Card pad={false}>
        <div className="pad"><CardHead title="Routes" sub="Every matching route adds its channels." /></div>
        <Async q={q} rows={2} h={60}>
          {(list) => list.length === 0 ? <EmptyState icon="inbox" title="No routes" hint="Without routes, each channel receives what its own level filter allows." /> : (
            <ul className="feed">
              {list.map((r) => (
                <li key={r.id}>
                  <div className="grow"><b>{r.name}</b>
                    <p className="muted small">{r.categories.length ? r.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(', ') : 'anything'} · {LEVELS.find(([v]) => v === r.minLevel)?.[1].toLowerCase()}{r.contains ? ` · containing "${r.contains}"` : ''}{r.weekly ? ` · ${weeklyText(r.weekly)}` : ''}</p>
                    <div className="chips-row">{r.channels.map((c) => <Badge key={c} tone="blue">{label(c)}</Badge>)}</div></div>
                  {admin && (r.managed ? <ManagedBadge /> : <>
                    <button role="switch" aria-checked={r.enabled} aria-label={`${r.name} enabled`} className={`switch ${r.enabled ? 'on' : ''}`} onClick={() => toggle(r)}><i /></button>
                    <HoldButton danger onConfirm={async () => { try { await api.routeDelete(r.id); q.reload(); } catch (e) { toast.error((e as Error).message); } }}>Delete</HoldButton>
                  </>)}
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
    </div>
  );
}
