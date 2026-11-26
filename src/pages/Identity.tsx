import { useState } from 'react';
import { api } from '../api';
import { Async, Badge, Card, CardHead, EmptyState, PageHeader } from '../components/ui';
import type { Tone } from '../components/ui';
import { useQuery, useToast } from '../hooks';
import type { IdentityFinding, IdentityInspection, IdentitySetup } from '../types';

const TONE: Record<IdentityFinding['level'], Tone> = { ok: 'green', info: 'gray', warn: 'amber', error: 'red' };
const WORD: Record<IdentityFinding['level'], string> = { ok: 'OK', info: 'Note', warn: 'Warning', error: 'Problem' };

function Findings({ items }: { items: IdentityFinding[] }) {
  if (!items.length) return null;
  const order = ['error', 'warn', 'info', 'ok'];
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {[...items].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map((f, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', alignItems: 'baseline' }}>
          <Badge tone={TONE[f.level]}>{WORD[f.level]}</Badge><span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Inspection({ i, comparison }: { i: IdentityInspection; comparison: IdentityFinding[] }) {
  const sup = (k: string) => i.supports[k] ?? [];
  const rows: [string, string[]][] = [
    ['Scopes', sup('scopes_supported')], ['Claims', sup('claims_supported')], ['Flows (response types)', sup('response_types_supported')],
    ['Grant types', sup('grant_types_supported')], ['Token signing', sup('id_token_signing_alg_values_supported')], ['PKCE', sup('code_challenge_methods_supported')],
    ['Client sign-in', sup('token_endpoint_auth_methods_supported')],
  ];
  return (
    <>
      <Card><CardHead title="What this means" sub={i.discoveryUrl} /><Findings items={[...comparison, ...i.findings]} /></Card>
      <Card><CardHead title="Endpoints" />
        <table className="kv"><tbody>{Object.entries(i.endpoints).map(([k, v]) => <tr key={k}><td>{k}</td><td className="mono">{v}</td></tr>)}</tbody></table>
      </Card>
      <Card><CardHead title="Signing keys" sub={`${i.keys.length} published`} />
        {i.keys.length === 0 ? <EmptyState title="No keys" hint="No signing keys could be read." /> : (
          <table className="kv"><thead><tr><th>Key id</th><th>Type</th><th>Algorithm</th><th>Use</th><th>Size or curve</th></tr></thead>
            <tbody>{i.keys.map((k, n) => <tr key={n}><td className="mono">{k.kid ?? 'none'}</td><td>{k.kty}</td><td>{k.alg ?? 'not stated'}</td><td>{k.use ?? 'not stated'}</td><td>{k.detail}</td></tr>)}</tbody></table>
        )}
      </Card>
      <Card><CardHead title="What the provider supports" />
        <table className="kv"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.length ? v.join(', ') : 'not listed'}</td></tr>)}</tbody></table>
      </Card>
    </>
  );
}

function Setup({ s }: { s: IdentitySetup }) {
  return (
    <Card>
      <CardHead title="Sign-in settings in homedash" sub="From homedash.yaml (auth.oidc). The client secret is never shown." right={<Badge tone={s.configured ? 'green' : 'gray'} dot>{s.configured ? 'Single sign-on on' : 'Not set up'}</Badge>} />
      {s.configured && (
        <table className="kv"><tbody>
          <tr><td>Issuer</td><td className="mono">{s.issuer}</td></tr>
          <tr><td>Client id</td><td className="mono">{s.clientId}</td></tr>
          <tr><td>Client secret</td><td>{s.hasClientSecret ? 'set (hidden)' : 'none (public client with PKCE)'}</td></tr>
          <tr><td>Redirect address</td><td className="mono">{s.redirectUri}</td></tr>
          <tr><td>Scopes</td><td>{s.scopes.join(' ')}</td></tr>
          <tr><td>Role claims read</td><td className="mono">{s.rolesClaims.join(', ')}</td></tr>
          <tr><td>Who may sign in</td><td>{s.requiredRole ? `role or group "${s.requiredRole}"` : 'no required role'}; {s.allowedUsers} allowed user(s)</td></tr>
          <tr><td>Role given</td><td>{s.defaultRole} by default; {s.adminUsers} administrator(s) listed</td></tr>
          <tr><td>People</td><td>{s.people.total} total: {s.people.sso} from sign-in, {s.people.scim} from SCIM, {s.people.local} local</td></tr>
        </tbody></table>
      )}
      <Findings items={s.notes} />
    </Card>
  );
}

export default function Identity() {
  const toast = useToast();
  const mine = useQuery(api.identity, [], 0);
  const [issuer, setIssuer] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [other, setOther] = useState<{ inspection: IdentityInspection; comparison: IdentityFinding[] } | null>(null);

  async function run() {
    setBusy(true);
    try { setOther(await api.identityInspect(issuer.trim(), insecure)); }
    catch (e) { setOther(null); toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Identity" sub="Read an OpenID Connect provider's published configuration (Authentik, Keycloak, Authelia, any provider) and check it against homedash sign-in. Nothing is changed." />
      <Async q={mine}>
        {(d) => (
          <>
            <Setup s={d.setup} />
            {d.error && <Card><Badge tone="red">Could not read your provider</Badge> <span>{d.error}</span></Card>}
            {d.inspection && <Inspection i={d.inspection} comparison={d.comparison} />}
          </>
        )}
      </Async>
      <Card>
        <CardHead title="Inspect another provider" sub="For a provider you plan to use, or one used by another application." />
        <form onSubmit={(e) => { e.preventDefault(); if (issuer.trim()) void run(); }} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ flex: '1 1 320px' }} aria-label="Issuer address" placeholder="https://sso.example.lan/realms/home" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Accept a self-signed certificate</label>
          <button className="btn btn-primary" type="submit" disabled={busy || !issuer.trim()}>{busy ? 'Reading…' : 'Inspect'}</button>
        </form>
      </Card>
      {other && <Inspection i={other.inspection} comparison={other.comparison} />}
    </>
  );
}
