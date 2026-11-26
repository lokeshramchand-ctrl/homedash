import { useState } from 'react';
import { api } from '../api';
import { SourceForm } from '../components/SourceForm';
import { Async, Badge, Card, CardHead, CodeBlock, Icon, Meter, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { useQuery } from '../hooks';
import type { SetupCheck, SetupIntegration } from '../types';

const TONE: Record<SetupCheck['status'], Tone> = { ok: 'green', todo: 'blue', warn: 'amber' };
const WORD: Record<SetupCheck['status'], string> = { ok: 'Done', todo: 'To do', warn: 'Check this' };

function Check({ c }: { c: SetupCheck }) {
  const [open, setOpen] = useState(c.status !== 'ok');
  return (
    <div className="setup-row">
      <button className="setup-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`setup-tick t-${c.status}`} aria-hidden="true">{c.status === 'ok' ? <Icon name="check" size={14} /> : null}</span>
        <span className="setup-title">{c.title}</span>
        <Badge tone={TONE[c.status]}>{WORD[c.status]}</Badge>
      </button>
      {open && (
        <div className="setup-body">
          <p>{c.detail}</p>
          {c.fix && <p className="muted small"><b>How:</b> {c.fix}</p>}
          {c.page && <a className="link" href={`#/${c.page}`}>Open {c.page === 'tiles' ? 'Services' : c.page === 'notifications' ? 'Notifications' : 'Access'}</a>}
        </div>
      )}
    </div>
  );
}

/** Integrations that can be connected from the browser instead of by editing YAML. */
const CONNECTABLE = new Set(['kuma', 'grafana']);

function Integration({ i, onConnect }: { i: SetupIntegration; onConnect: (kind: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="setup-row">
      <button className="setup-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`setup-tick t-${i.enabled ? 'ok' : 'off'}`} aria-hidden="true">{i.enabled ? <Icon name="check" size={14} /> : null}</span>
        <span className="setup-title">{i.name}</span>
        {i.enabled ? <Badge tone="green" dot>On</Badge> : <Badge tone="gray">Off</Badge>}
      </button>
      {open && (
        <div className="setup-body">
          <p>{i.what}</p>
          {i.enabled && i.page && <a className="link" href={`#/${i.page}`}>Open the page</a>}
          {!i.enabled && CONNECTABLE.has(i.id) && (
            <p><button className="btn btn-primary btn-sm" onClick={() => onConnect(i.id)}><Icon name="plus" size={14} />Connect {i.name}</button> <span className="muted small">Saves it here, no restart. Prefer a file? Use the YAML below.</span></p>
          )}
          {!i.enabled && (
            <>
              <p className="muted small">Add this to <code>/etc/homedash/homedash.yaml</code>{i.secrets.length > 0 && <>, put <b>{i.secrets.join(', ')}</b> in <code>/etc/homedash/secrets.env</code></>}, then run <code>homedash-config apply --restart</code>.</p>
              <CodeBlock code={i.snippet} label="homedash.yaml" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Setup() {
  const q = useQuery(api.setup, [], 0);
  const cat = useQuery(api.monitoringCatalog, [], 0);
  const [connect, setConnect] = useState<string | null>(null);
  return (
    <>
      <PageHeader eyebrow="Settings" title="Setup" sub="What is working, what is worth doing next, and exactly how to switch on each integration." />
      <Async q={q} rows={6} h={56}>
        {(s) => {
          const pct = s.progress.total ? s.progress.done / s.progress.total : 1;
          return (
            <>
              <Card>
                <div className="setup-sum">
                  <div><b>{s.progress.done} of {s.progress.total}</b><span> checks done</span></div>
                  <div className="setup-meter"><Meter value={pct} tone={pct === 1 ? 'green' : 'violet'} /></div>
                </div>
              </Card>
              <Card pad={false}>
                <CardHead title="Checklist" sub="Open an item for what it means and how to fix it." />
                {s.checks.map((c) => <Check key={c.id} c={c} />)}
              </Card>
              <Card pad={false}>
                <CardHead title="Integrations" sub="Everything optional. Switch on only what you use; its page appears in the menu." />
                {s.integrations.map((i) => <Integration key={i.id} i={i} onConnect={(k) => (cat.data?.canEdit ? setConnect(k) : (location.hash = '#/monitoring'))} />)}
              </Card>
            </>
          );
        }}
      </Async>
      {connect && cat.data && <SourceForm kinds={cat.data.kinds} initialKind={connect} onClose={() => setConnect(null)} onSaved={() => q.reload()} />}
    </>
  );
}

const DISMISS = 'setup-nudge-dismissed';

/** A slim card on the Overview for administrators until the checklist is done (or they dismiss it). */
export function SetupNudge() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(DISMISS) === '1'; } catch { return false; } });
  const q = useQuery(api.setup, [], 0);
  const p = q.data?.progress;
  if (hidden || !p || p.done >= p.total) return null;
  const next = q.data?.checks.find((c) => c.status !== 'ok');
  const dismiss = () => { setHidden(true); try { localStorage.setItem(DISMISS, '1'); } catch { /* storage unavailable */ } };
  return (
    <div className="callout warn" role="status" style={{ marginBottom: 16 }}>
      <Icon name="check" size={16} />
      <span><b>Finish setting up homedash:</b> {p.done} of {p.total} done{next ? <>. Next: {next.title}.</> : '.'} <a className="link" href="#/setup">Open Setup</a></span>
      <button className="link" onClick={dismiss} style={{ marginLeft: 'auto' }}>Dismiss</button>
    </div>
  );
}
