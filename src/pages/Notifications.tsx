import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, Chips, EmptyState, Icon, PageHeader, Spinner } from '../components/ui';
import { RoutesTab, SilencesTab } from './NotifyRules';
import { KV } from '../components/Pve';
import { timeAgo } from '../format';
import { useQuery, useToast } from '../hooks';
import type { AlertLevel, NotifyChannel, NotifyInfo, NotifySettings } from '../types';

const LABEL: Record<string, [string, string]> = {
  monitor: ['Uptime monitors', 'A Kuma monitor goes down or recovers'],
  guest: ['Guests', 'A VM or container stops without a dashboard action'],
  host: ['Proxmox host', 'API unreachable, host reboot, stopped PVE services'],
  resources: ['Resource pressure', 'CPU, RAM or root disk above threshold for 5 minutes'],
  tasks: ['Failed tasks', 'Any Proxmox task ends with an error'],
  gpu: ['GPU & passthrough', 'vfio, amdgpu or NVIDIA driver faults in the kernel log'],
  hardware: ['Hardware errors', 'PCIe AER, machine checks, disk I/O errors, process crashes'],
  disks: ['Disk health', 'S.M.A.R.T. failure or SSD wearout under 10%'],
  services: ['System services', 'An enabled PVE service is not running'],
  crowdsec: ['CrowdSec', 'A new local ban, or an engine or bouncer goes silent'],
  db: ['Database', 'Database connection lost or restored'],
  app: ['Dashboard', 'Crash, unclean shutdown, uncaught errors'],
  auth: ['Sign-in', 'Refused single sign-on attempts, new addresses, two-step changes'],
};

const LEVELS: [AlertLevel, string][] = [['info', 'Everything'], ['warn', 'Warnings and errors'], ['error', 'Errors only']];

/** What the YAML key looks like for each channel, shown for the ones that are not set up yet. */
const YAML_HINT: Record<string, string> = {
  ntfy: 'ntfy:\n  url: http://192.168.1.20\n  topic: homedash-8f3a9c',
  gotify: 'gotify:\n  url: http://192.168.1.21\n  token: ${GOTIFY_TOKEN}',
  discord: 'discord:\n  webhook_url: ${DISCORD_WEBHOOK}',
  slack: 'slack:\n  webhook_url: ${SLACK_WEBHOOK}',
  telegram: 'telegram:\n  bot_token: ${TELEGRAM_TOKEN}\n  chat_id: "-1001234567890"',
  email: 'email:\n  host: smtp.example.com\n  port: 587\n  user: alerts@example.com\n  password: ${SMTP_PASSWORD}\n  from: homedash@example.com\n  to: [me@example.com]',
  apprise: 'apprise:\n  url: http://192.168.1.22:8000\n  key: homedash        # a saved Apprise config key\n  # or: urls: ["pover://user@token", "mailto://..."]',
  webhook: 'webhook:\n  url: https://example.com/hooks/homedash\n  secret: ${WEBHOOK_SECRET}',
  pagerduty: 'pagerduty:\n  routing_key: ${PAGERDUTY_KEY}   # Events API v2 integration key',
  opsgenie: 'opsgenie:\n  api_key: ${OPSGENIE_KEY}\n  region: us   # or eu',
};

type Tab = 'channels' | 'maintenance' | 'routing';

export default function Notifications({ role = 'viewer' }: { role?: string }) {
  const [tab, setTab] = useState<Tab>('channels');
  const q = useQuery(api.notify, [], 10_000);
  const silenced = useQuery(api.silences, [], 30_000);
  const active = silenced.data?.filter((s) => s.active).length ?? 0;
  return (
    <>
      <PageHeader eyebrow="Settings" title="Notifications" sub="Get an alert on the services you already use when something goes down, and again when it recovers. Pause it for planned work, and route it by severity."
        actions={tab === 'channels' && q.data?.configured && <TestAll q={q} />} />
      <div className="toolbar">
        <Chips value={tab} onChange={setTab} options={[{ id: 'channels', label: 'Channels' }, { id: 'maintenance', label: 'Maintenance windows', count: active || undefined }, { id: 'routing', label: 'Routing' }]} />
        {active > 0 && <Badge tone="amber" dot>{active} window{active === 1 ? '' : 's'} active: alerts are held back</Badge>}
      </div>
      {tab === 'channels' && <ChannelsTab q={q} onSilenced={() => silenced.reload()} />}
      {tab === 'maintenance' && <SilencesTab categories={q.data?.categories ?? []} />}
      {tab === 'routing' && <RoutesTab categories={q.data?.categories ?? []} channels={q.data?.channels ?? []} admin={role === 'admin'} />}
    </>
  );
}

function TestAll({ q }: { q: ReturnType<typeof useQuery<NotifyInfo>> }) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  async function run() {
    setTesting(true);
    try {
      const r = await api.notifyTest();
      const bad = r.deliveries.filter((d) => !d.ok);
      if (!bad.length) toast.success(`Test sent to ${r.deliveries.length} channel${r.deliveries.length === 1 ? '' : 's'}`);
      else toast.error(bad.map((d) => `${d.channel}: ${d.error}`).join(' · '));
      q.reload();
    } catch (e) { toast.error(`Test failed: ${(e as Error).message}`); } finally { setTesting(false); }
  }
  return <button className="btn btn-primary" onClick={run} disabled={testing}>{testing ? <Spinner size={14} /> : <Icon name="bell" size={15} />}Test all</button>;
}

function ChannelsTab({ q, onSilenced }: { q: ReturnType<typeof useQuery<NotifyInfo>>; onSilenced: () => void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null); // channel id, 'all' or null
  const [open, setOpen] = useState<string | null>(null); // unconfigured channel whose setup hint is shown

  async function save(s: Parameters<typeof api.notifySettings>[0]) {
    setSaving(true);
    try {
      const next = await api.notifySettings(s);
      q.mutate((d) => ({ ...d, settings: next, channels: d.channels.map((c) => ({ ...c, ...(next.channels[c.id] ?? {}) })) }));
    } catch (e) { toast.error(`Couldn't save: ${(e as Error).message}`); } finally { setSaving(false); }
  }
  async function test(channel?: string) {
    setTesting(channel ?? 'all');
    try {
      const r = await api.notifyTest(channel);
      const bad = r.deliveries.filter((d) => !d.ok);
      if (!bad.length) toast.success(channel ? 'Test sent' : `Test sent to ${r.deliveries.length} channel${r.deliveries.length === 1 ? '' : 's'}`);
      else toast.error(bad.map((d) => `${d.channel}: ${d.error}`).join(' · '));
      q.reload();
    } catch (e) { toast.error(`Test failed: ${(e as Error).message}`); } finally { setTesting(null); }
  }

  const label = (id: string) => q.data?.channels.find((c) => c.id === id)?.label ?? id;
  async function silence(title: string, category: string) {
    try {
      await api.silenceSave(null, { name: `Silenced: ${title}`.slice(0, 80), reason: 'Created from an alert', categories: [category], contains: title.replace(/^(DOWN|Warning|Recovered) · /, '').slice(0, 100), startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600_000).toISOString() });
      toast.success('Similar alerts are held back for 1 hour (see Maintenance windows)');
      onSilenced();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <>
      <Async q={q} rows={3} h={120}>
        {(d) => (
          <div className="settings-grid">
            <div className="stack">
              <Card>
                <CardHead title="Channels" sub="Each one is switched on in homedash.yaml. Pick which alerts each channel receives."
                  right={d.configured ? <Toggle on={d.settings.enabled} disabled={saving} label="Alerts enabled" onChange={(v) => save({ enabled: v })} /> : undefined} />
                <ul className="channels">
                  {d.channels.map((c) => <ChannelRow key={c.id} c={c} saving={saving || !d.settings.enabled} testing={testing === c.id} open={open === c.id}
                    onToggleOpen={() => setOpen(open === c.id ? null : c.id)} onTest={() => test(c.id)}
                    onSave={(p) => save({ channels: { [c.id]: p } })} subscribeUrl={c.id === 'ntfy' ? d.subscribeUrl : ''} />)}
                </ul>
                {!d.configured && <p className="muted small chan-foot">No channel is set up yet. Add one to <span className="mono">/etc/homedash/homedash.yaml</span>, then run <span className="mono">homedash-config apply --restart</span>.</p>}
              </Card>
              {d.configured && (
                <Card>
                  <CardHead title="Delivery" sub="Applies to every channel." />
                  <KV rows={[
                    ['Status', d.settings.mutedUntil && new Date(d.settings.mutedUntil) > new Date()
                      ? <Badge tone="amber">Muted until {new Date(d.settings.mutedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Badge>
                      : <Badge tone={d.settings.enabled ? 'green' : 'gray'} dot>{d.settings.enabled ? 'Active' : 'Disabled'}</Badge>],
                    ['Active channels', <span>{d.channels.filter((c) => c.configured && c.enabled).map((c) => c.label).join(', ') || 'none'}</span>],
                  ]} />
                  <div className="btn-row">
                    <button className="btn" disabled={saving} onClick={() => save({ mutedUntil: new Date(Date.now() + 3600_000).toISOString() })}>Mute 1 hour</button>
                    <button className="btn" disabled={saving} onClick={() => save({ mutedUntil: new Date(Date.now() + 8 * 3600_000).toISOString() })}>Mute 8 hours</button>
                    {d.settings.mutedUntil && <button className="btn btn-ghost" disabled={saving} onClick={() => save({ mutedUntil: null })}>Unmute</button>}
                  </div>
                </Card>
              )}
              {d.configured && (
                <Card>
                  <CardHead title="Alert rules" sub={`Thresholds: CPU ${Math.round(d.thresholds.cpu * 100)}% · RAM ${Math.round(d.thresholds.mem * 100)}% · disk ${Math.round(d.thresholds.disk * 100)}%`} />
                  <ul className="rules">
                    {d.categories.map((c) => (
                      <li key={c}>
                        <div className="grow"><b>{LABEL[c]?.[0] ?? c}</b><p className="muted small">{LABEL[c]?.[1]}</p></div>
                        <Toggle on={d.settings.categories[c] !== false} disabled={saving || !d.settings.enabled} label={LABEL[c]?.[0] ?? c}
                          onChange={(v) => save({ categories: { ...d.settings.categories, [c]: v } })} />
                      </li>
                    ))}
                    <li>
                      <div className="grow"><b>Recovery messages</b><p className="muted small">Also notify when something comes back up</p></div>
                      <Toggle on={d.settings.recoveries} disabled={saving || !d.settings.enabled} label="Recovery messages" onChange={(v) => save({ recoveries: v })} />
                    </li>
                  </ul>
                </Card>
              )}
            </div>
            {d.configured && <NtfyInboxCard />}
            <Card pad={false}>
              <div className="pad"><CardHead title="Recently sent" sub="Since the dashboard last started" /></div>
              {d.sent.length === 0 ? <EmptyState icon="inbox" title="Nothing sent yet" hint={d.configured ? 'Alerts appear here as they go out. Use Test all to try.' : 'Set up a channel first.'} /> : (
                <ul className="feed">
                  {d.sent.map((s, i) => (
                    <li key={i}>
                      <span className={`inc-dot ${s.priority >= 5 ? 'd-down' : s.priority >= 4 ? 'd-pending' : ''}`} />
                      <div className="grow">
                        <b>{s.title}</b><p className="muted small">{s.message}</p>
                        <div className="chips-row">
                          {s.resolve && <Badge tone="green">recovery</Badge>}
                          {s.silencedBy && <Badge tone="amber" dot>held back by "{s.silencedBy}"</Badge>}
                          {s.routedBy?.length ? <Badge tone="blue" title={s.routedBy.join(', ')}>routed</Badge> : null}
                          {s.deliveries.map((x) => <Badge key={x.channel} tone={x.ok ? 'green' : 'red'}>{label(x.channel)}{x.ok ? '' : ' failed'}</Badge>)}
                          {!s.resolve && !s.silencedBy && s.priority >= 4 && <button className="btn btn-ghost btn-sm" onClick={() => silence(s.title, s.category)}>Silence for 1 hour</button>}
                        </div>
                        {!s.ok && <p className="small err-t">{s.error}</p>}
                      </div>
                      <span className="muted small nowrap">{timeAgo(s.ts)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </Async>
    </>
  );
}

/** What has been published to the alert topic, read back from ntfy, so ntfy itself never has to be opened. */
function NtfyInboxCard() {
  const q = useQuery(api.ntfyInbox, [], 30_000);
  const d = q.data;
  return (
    <Card pad={false}>
      <div className="pad"><CardHead title="ntfy inbox" sub={d ? `Topic ${d.topic}. ntfy keeps messages for about 12 hours.` : 'Reading the topic…'} /></div>
      {q.error && !d ? <EmptyState icon="inbox" title="Couldn’t read ntfy" hint={(q.error as Error).message} />
        : !d ? <div className="pad"><Spinner /></div>
        : d.error ? <EmptyState icon="inbox" title="Can’t read the inbox" hint={d.error} />
        : d.messages.length === 0 ? <EmptyState icon="inbox" title="Inbox is empty" hint="Nothing has been published to this topic recently." />
        : (
          <ul className="feed">
            {d.messages.map((m) => (
              <li key={m.id}>
                <span className={`inc-dot ${m.priority >= 5 ? 'd-down' : m.priority >= 4 ? 'd-pending' : ''}`} />
                <div className="grow">
                  <b>{m.title || m.message.slice(0, 80) || '(no text)'}</b>
                  {m.title && m.message && <p className="muted small">{m.message}</p>}
                  {(m.tags.length > 0 || m.click) && (
                    <div className="chips-row">
                      {m.tags.map((t) => <Badge key={t} tone="gray">{t}</Badge>)}
                      {m.click && <a className="link small" href={m.click} target="_blank" rel="noopener noreferrer">Open</a>}
                    </div>
                  )}
                </div>
                <span className="muted small nowrap">{timeAgo(new Date(m.time).toISOString())}</span>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

function ChannelRow({ c, saving, testing, open, onToggleOpen, onTest, onSave, subscribeUrl }: {
  c: NotifyChannel; saving: boolean; testing: boolean; open: boolean; onToggleOpen: () => void; onTest: () => void;
  onSave: (p: { enabled?: boolean; minLevel?: AlertLevel }) => void; subscribeUrl: string;
}) {
  if (!c.configured) {
    return (
      <li className="chan off">
        <div className="chan-main">
          <div className="grow"><b>{c.label}</b><p className="muted small">Not set up</p></div>
          <button className="btn btn-ghost btn-sm" onClick={onToggleOpen} aria-expanded={open}>{open ? 'Hide' : 'How to set up'}</button>
        </div>
        {open && (
          <div className="chan-setup">
            <p className="muted small">Add this to <span className="mono">/etc/homedash/homedash.yaml</span> (needs: {c.needs}), then run <span className="mono">homedash-config apply --restart</span>.</p>
            <pre className="codebox">{YAML_HINT[c.id] ?? c.needs}</pre>
          </div>
        )}
      </li>
    );
  }
  return (
    <li className={`chan ${c.enabled ? '' : 'paused'}`}>
      <div className="chan-main">
        <div className="grow">
          <b>{c.label}</b> <Badge tone={c.enabled ? 'green' : 'gray'} dot>{c.enabled ? 'On' : 'Paused'}</Badge>{c.incident && <> <Badge tone="blue" title="Opens an incident per problem and closes it when it recovers">incidents</Badge></>}
          <p className="muted small mono">{c.target}{subscribeUrl && <> · <a className="link" href={subscribeUrl} target="_blank" rel="noopener noreferrer">open topic<Icon name="external" size={12} /></a></>}</p>
        </div>
        <select className="input chan-level" aria-label={`${c.label}: which alerts`} value={c.minLevel} disabled={saving || !c.enabled}
          onChange={(e) => onSave({ minLevel: e.target.value as AlertLevel })}>
          {LEVELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        <button className="btn btn-sm" onClick={onTest} disabled={testing}>{testing ? <Spinner size={13} /> : null}Test</button>
        <Toggle on={c.enabled} disabled={saving} label={`${c.label} enabled`} onChange={(v) => onSave({ enabled: v })} />
      </div>
    </li>
  );
}

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}><i /></button>;
}
