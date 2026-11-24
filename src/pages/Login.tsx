import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { Logo } from '../components/Brand';
import { InView, Reveal, RevealWords } from '../components/Reveal';
import { Icon, Spinner } from '../components/ui';

const SSO_ERRORS: Record<string, string> = {
  SSO_DENIED: 'Sign-in was cancelled or refused by the identity provider.',
  SSO_STATE: 'The sign-in attempt expired. Please try again.',
  SSO_FAILED: 'Single sign-on could not be verified.',
  SSO_UNAVAILABLE: 'The identity provider is unreachable right now.',
  USER_NOT_ALLOWED: 'This account is not allowed to use homedash.',
  ROLE_MISSING: 'This account lacks the required role.',
};

export default function Login({ onLogin, initialStep = 'password' }: { onLogin: (u: string) => void; initialStep?: 'password' | 'code' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'password' | 'code'>(initialStep);
  const [codeText, setCodeText] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [sso, setSso] = useState<{ enabled: boolean; label: string }>({ enabled: false, label: '' });

  useEffect(() => {
    api.ssoConfig().then(setSso).catch(() => { /* password login still works */ });
    const code = new URLSearchParams(location.search).get('sso_error');
    if (code) {
      setError(SSO_ERRORS[code] ?? 'Single sign-on failed');
      history.replaceState(null, '', location.pathname + location.hash);
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.login(username.trim(), password);
      setPassword('');
      if (r.mfa === 'required') setStep('code');
      else onLogin(username.trim()); // 'enroll': the app opens the enrolment screen
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.mfaVerify(codeText.trim());
      onLogin(r.username);
    } catch (err) {
      const ex = err as { status?: number; message: string };
      setError(ex.message);
      setCodeText('');
      if (ex.status === 401 || ex.status === 429) setStep('password'); // pending session ended: start again
    } finally {
      setBusy(false);
    }
  }
  async function back() {
    try { await api.logout(); } catch { /* the pending session may already be gone */ }
    setStep('password'); setCodeText(''); setError(''); setRecovery(false);
  }

  // Always light so the card stays readable on any theme.
  return (
    <div className="login" data-theme="light">
      <Logo />
      <InView className="login-main">
        <div>
          <h1><RevealWords text="Your homelab, at a glance." /></h1>
          <Reveal stagger={6}><p className="login-lead">One console for your guests, sites, metrics and uptime.</p></Reveal>
        </div>
        <Reveal stagger={4}>
          {step === 'code' ? (
          <form onSubmit={submitCode}>
            <h2>Enter your code</h2>
            {error && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{error}</span></div>}
            <label>{recovery ? 'Recovery code' : 'Sign-in code'}
              <input className="input" autoFocus autoComplete="one-time-code" maxLength={16} {...(recovery ? {} : { inputMode: 'numeric' as const })} value={codeText} onChange={(e) => setCodeText(e.target.value)} required />
            </label>
            <button className="btn btn-primary btn-lg" disabled={busy || !codeText.trim()}>{busy ? <Spinner /> : null}Continue</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setRecovery((r) => !r); setCodeText(''); setError(''); }}>{recovery ? 'Use an authenticator code' : 'Use a recovery code'}</button>
            <button type="button" className="btn btn-ghost" onClick={back}>Back</button>
          </form>
          ) : (
          <form onSubmit={submit}>
            <h2>Sign in</h2>
            {error && <div className="callout err" role="alert"><Icon name="alert" size={16} /><span>{error}</span></div>}
            <label>Username<input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
            <label>Password<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? <Spinner /> : null}Sign in</button>
            {sso.enabled && (
              <>
                <div className="login-or muted small"><span>or</span></div>
                <a className="btn btn-lg" href="/api/auth/sso/login"><Icon name="lock" size={16} />Sign in with {sso.label}</a>
              </>
            )}
          </form>
          )}
        </Reveal>
      </InView>
      <div className="login-foot"><span>homedash</span><span>Secured session · HTTPS</span></div>
    </div>
  );
}
