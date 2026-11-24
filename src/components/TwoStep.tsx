import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { api } from '../api';
import type { MfaStatus } from '../types';
import { CopyButton, ErrorState, Icon, Sheet, Skeleton, Spinner } from './ui';

type Phase = 'view' | 'setup' | 'codes';
type Ask = '' | 'recovery' | 'disable';

/** Dark modules on white with a 4-module quiet zone, whatever the theme (scanners need the contrast). */
function Qr({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), pad = 4;
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + pad} ${r + pad}h1v1h-1z`;
    return { d: path, size: n + pad * 2 };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#17181a" />
    </svg>
  );
}

const groups4 = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/** Body shared by the settings sheet and the forced enrolment screen. */
function TwoStepBody({ user, onChanged }: { user: string; onChanged?: () => void }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loadErr, setLoadErr] = useState<Error | null>(null);
  const [phase, setPhase] = useState<Phase>('view');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [ask, setAsk] = useState<Ask>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = !user.startsWith('kc:');

  const load = useCallback(() => {
    setLoadErr(null);
    api.mfaStatus().then(setStatus).catch((e) => setLoadErr(e as Error));
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const startSetup = (e: FormEvent) => { e.preventDefault(); void run(async () => { setSetup(await api.mfaSetup(local ? password : undefined)); setPassword(''); setCode(''); setPhase('setup'); }); };
  const enable = (e: FormEvent) => { e.preventDefault(); void run(async () => { const r = await api.mfaEnable(code.trim()); setCodes(r.recoveryCodes); setSetup(null); setCode(''); setSaved(false); setPhase('codes'); }); };
  const confirmAsk = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (ask === 'recovery') { const r = await api.mfaRecovery(code.trim()); setCodes(r.recoveryCodes); setSaved(false); setPhase('codes'); }
      else { await api.mfaDisable(code.trim()); load(); onChanged?.(); }
      setAsk(''); setCode('');
    });
  };
  const finish = () => { setCodes([]); setPhase('view'); load(); onChanged?.(); };
  const download = () => {
    const blob = new Blob([`Recovery codes for ${user}\nEach works once.\n\n${codes.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'recovery-codes.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (loadErr) return <ErrorState error={loadErr} onRetry={load} />;
  if (!status) return <Skeleton rows={3} />;
  if (!status.configured) return <div className="callout warn"><Icon name="alert" size={16} /><span>Not available: <code>MFA_KEY</code> is not set on the server.</span></div>;

  const err = error && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{error}</span></div>;

  if (phase === 'codes') {
    return (
      <div className="ts-stack">
        <p>Keep these recovery codes somewhere that is not this server. Each one works once if you lose your authenticator. <b>They are shown only now.</b></p>
        <ul className="ts-codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        <div className="ts-row"><CopyButton text={codes.join('\n')} /><button className="btn btn-sm btn-ghost" onClick={download}><Icon name="download" size={15} />Download .txt</button></div>
        <label className="tgl"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /><i />I saved these</label>
        <button className="btn btn-primary" disabled={!saved} onClick={finish}>Done</button>
      </div>
    );
  }

  if (phase === 'setup' && setup) {
    return (
      <form className="ts-stack" onSubmit={enable}>
        {err}
        <p>Scan the code with an authenticator app, or enter the key by hand. Then type the 6-digit code it shows.</p>
        <Qr text={setup.uri} />
        <div className="ts-key"><span className="ts-secret">{groups4(setup.secret)}</span><CopyButton text={setup.secret} compact /></div>
        <a className="btn btn-sm btn-ghost" href={setup.uri}>Open in authenticator app</a>
        <label className="ts-field">Code from the app
          <input className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
        </label>
        <div className="ts-row">
          <button className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : null}Turn on</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setPhase('view'); setSetup(null); setError(''); }}>Cancel</button>
        </div>
      </form>
    );
  }

  if (status.enabled) {
    const low = status.recoveryLeft <= 3;
    return (
      <div className="ts-stack">
        <p><Icon name="shield" size={16} /> Two-step sign-in is <b>on</b> since {fmtDate(status.enabledAt)}.</p>
        <p className={low ? 'ts-low' : 'muted'}>{status.recoveryLeft} recovery code{status.recoveryLeft === 1 ? '' : 's'} left{low ? '. Make new ones soon.' : '.'}</p>
        {ask ? (
          <form className="ts-stack" onSubmit={confirmAsk}>
            {err}
            <label className="ts-field">{ask === 'disable' ? 'Current code or a recovery code' : 'Current 6-digit code'}
              <input className="input" inputMode={ask === 'disable' ? undefined : 'numeric'} autoComplete="one-time-code" autoFocus maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} required />
            </label>
            <div className="ts-row">
              <button className={`btn ${ask === 'disable' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || !code.trim()}>{busy ? <Spinner /> : null}{ask === 'disable' ? 'Turn off' : 'Make new codes'}</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setAsk(''); setCode(''); setError(''); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="ts-row">
            <button className="btn" onClick={() => setAsk('recovery')}>New recovery codes</button>
            <button className="btn" onClick={() => setAsk('disable')}>Turn off</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <form className="ts-stack" onSubmit={startSetup}>
      {err}
      <p>Two-step sign-in asks for a 6-digit code from an authenticator app after your password{status.required ? ' (required on this console)' : ''}. A stolen password alone then cannot open the console.</p>
      {local && <label className="ts-field">Your current password<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>}
      <button className="btn btn-primary" disabled={busy || (local && !password)}>{busy ? <Spinner /> : null}Set up</button>
    </form>
  );
}

export function TwoStepSheet({ user, onClose }: { user: string; onClose: () => void }) {
  return <Sheet title="Two-step sign-in" eyebrow="Security" onClose={onClose}><TwoStepBody user={user} /></Sheet>;
}

/** Full-screen enrolment shown instead of the console when the server requires it and this account has none. */
export function TwoStepGate({ user, onDone, onSignOut }: { user: string; onDone: () => void; onSignOut: () => void }) {
  return (
    <div className="ts-gate">
      <div className="ts-card">
        <h2>Set up two-step sign-in</h2>
        <p className="muted">This console requires it before anything else opens.</p>
        <TwoStepBody user={user} onChanged={onDone} />
        <button className="btn btn-ghost" onClick={onSignOut}><Icon name="logout" size={16} />Sign out</button>
      </div>
    </div>
  );
}
