import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api';
import { Async, Badge, Card, CardHead, Chips, CopyButton, EmptyState, HoldButton, Icon, Modal, PageHeader, Spinner } from '../components/ui';
import type { Tone } from '../components/ui';
import { timeAgo } from '../format';
import { useQuery, useToast } from '../hooks';
import type { AccessRole, AdminUser, ApprovalItem } from '../types';

type Tab = 'approvals' | 'tokens' | 'passkeys' | 'users' | 'identity';
const ROLES: AccessRole[] = ['viewer', 'operator', 'admin'];
const ROLE_HELP: Record<AccessRole, string> = { viewer: 'read only', operator: 'power, snapshots, scenes', admin: 'everything, incl. databases, nginx, host power' };
const STATUS_TONE: Record<string, Tone> = { pending: 'amber', approved: 'green', used: 'gray', rejected: 'red', expired: 'gray', active: 'green', revoked: 'red' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export default function Access({ role, user }: { role: string; user: string }) {
  const admin = role === 'admin';
  const [tab, setTab] = useState<Tab>('approvals');
  const pending = useQuery(api.approvals, [], 15_000);
  const waiting = pending.data?.items.filter((a) => a.status === 'pending' && (pending.data!.canDecide ? a.requestedBy !== user || pending.data!.policy.allowSelf : false)).length ?? 0;
  return (
    <>
      <PageHeader eyebrow="Settings" title="Access" sub="Who can do what: approvals for risky actions, API tokens, passkeys, people and teams." />
      <div className="toolbar">
        <Chips value={tab} onChange={setTab} options={[
          { id: 'approvals', label: 'Approvals', count: waiting || undefined },
          { id: 'tokens', label: 'API tokens' },
          { id: 'passkeys', label: 'Passkeys' },
          ...(admin ? [{ id: 'users' as Tab, label: 'People' }, { id: 'identity' as Tab, label: 'Teams and identity' }] : []),
        ]} />
      </div>
      {tab === 'approvals' && <ApprovalsTab user={user} />}
      {tab === 'tokens' && <TokensTab role={role as AccessRole} admin={admin} />}
      {tab === 'passkeys' && <PasskeysTab />}
      {tab === 'users' && admin && <UsersTab />}
      {tab === 'identity' && admin && <IdentityTab />}
    </>
  );
}

// ------------------------------------------------------------------------------------------ approvals
function ApprovalsTab({ user }: { user: string }) {
  const q = useQuery(api.approvals, [], 8_000);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast.success(ok); q.reload(); } catch (e) { toast.error((e as Error).message); q.reload(); } finally { setBusy(null); }
  }
  return (
    <Async q={q} rows={3} h={100}>
      {(d) => (
        <div className="stack">
          <Card>
            <CardHead title="Four-eyes policy" sub={d.policy.actions.length
              ? `These actions need a second administrator: ${d.policy.actions.join(', ')}. Requests expire after ${d.policy.ttlMinutes} minutes.${d.policy.allowSelf ? ' Self-approval is allowed.' : ''}`
              : 'No action needs approval yet.'} />
            {!d.policy.actions.length && <p className="muted small">Turn it on in <span className="mono">/etc/homedash/homedash.yaml</span>, for example <span className="mono">access.approvals.actions: [host.shutdown, snapshot.rollback]</span> (or <span className="mono">"*"</span>), then <span className="mono">homedash-config apply --restart</span>. Available: {d.policy.known.join(', ')}.</p>}
          </Card>
          <Card pad={false}>
            <div className="pad"><CardHead title="Requests" sub={d.canDecide ? 'You can approve or reject requests from other people.' : 'Your own requests. An administrator decides them.'} /></div>
            {d.items.length === 0 ? <EmptyState icon="check" title="Nothing waiting" hint="A risky action appears here when someone asks to run it." /> : (
              <ul className="feed">
                {d.items.map((a) => <ApprovalRow key={a.id} a={a} user={user} canDecide={d.canDecide} allowSelf={d.policy.allowSelf} busy={busy}
                  note={note[a.id] ?? ''} setNote={(v) => setNote({ ...note, [a.id]: v })}
                  onDecide={(v) => act(a.id + v, () => api.approvalDecide(a.id, v, note[a.id]), v === 'approve' ? 'Approved' : 'Rejected')}
                  onRun={() => act(a.id + 'run', () => api.approvalRun(a), 'Done: the approved action ran')} />)}
              </ul>
            )}
          </Card>
        </div>
      )}
    </Async>
  );
}

function ApprovalRow({ a, user, canDecide, allowSelf, busy, note, setNote, onDecide, onRun }: {
  a: ApprovalItem; user: string; canDecide: boolean; allowSelf: boolean; busy: string | null; note: string; setNote: (v: string) => void;
  onDecide: (v: 'approve' | 'reject') => void; onRun: () => void;
}) {
  const mine = a.requestedBy === user;
  const mayDecide = canDecide && a.status === 'pending' && (!mine || allowSelf);
  return (
    <li className="appr">
      <span className={`inc-dot ${a.status === 'pending' ? 'd-pending' : a.status === 'rejected' ? 'd-down' : ''}`} />
      <div className="grow">
        <b>{a.summary}</b>
        <p className="muted small">{mine ? 'You' : a.requestedBy} asked {timeAgo(a.createdAt)} · <span className="mono">{a.action}</span>
          {a.decidedBy && <> · {a.status === 'rejected' ? 'rejected' : 'approved'} by {a.decidedBy}{a.note ? `: "${a.note}"` : ''}</>}
          {a.status === 'pending' && <> · expires {timeAgo(a.expiresAt).replace(' ago', '')}</>}</p>
        {a.status === 'pending' && mine && !allowSelf && <p className="muted small">Waiting for another administrator.</p>}
        {mayDecide && (
          <div className="appr-act">
            <input className="input" placeholder="Note (optional)" aria-label="Note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => onDecide('approve')}>{busy === a.id + 'approve' ? <Spinner size={13} /> : <Icon name="check" size={14} />}Approve</button>
            <button className="btn btn-sm" disabled={busy !== null} onClick={() => onDecide('reject')}>{busy === a.id + 'reject' ? <Spinner size={13} /> : <Icon name="x" size={14} />}Reject</button>
          </div>
        )}
        {a.status === 'approved' && mine && (
          <div className="appr-act"><button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={onRun}>{busy === a.id + 'run' ? <Spinner size={13} /> : <Icon name="play" size={14} />}Run it now</button>
            <span className="muted small">It runs once, exactly as requested.</span></div>
        )}
      </div>
      <Badge tone={STATUS_TONE[a.status] ?? 'gray'} dot>{a.status}</Badge>
    </li>
  );
}

// ------------------------------------------------------------------------------------------ API tokens
function TokensTab({ role, admin }: { role: AccessRole; admin: boolean }) {
  const [all, setAll] = useState(false);
  const q = useQuery(() => api.tokens(all), [all], 0);
  const toast = useToast();
  const [name, setName] = useState('');
  const [tokRole, setTokRole] = useState<AccessRole>('viewer');
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ token: string; name: string; expiresAt: string } | null>(null);
  const allowed = ROLES.slice(0, ROLES.indexOf(role) + 1);

  async function create() {
    setBusy(true);
    try {
      const r = await api.tokenCreate({ name: name.trim(), days, role: tokRole });
      setShown({ token: r.token, name: r.name, expiresAt: r.expiresAt });
      setName('');
      q.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function revoke(id: number) {
    try { await api.tokenRevoke(id); toast.success('Token revoked'); q.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <div className="stack">
      <Card>
        <CardHead title="Create a token" sub="For scripts, CI and the mobile app. A token never has more access than you, follows your team scope, and stops working if your account is deactivated." />
        <div className="form-grid">
          <label>Name<input className="input" value={name} maxLength={60} placeholder="e.g. backup-script" onChange={(e) => setName(e.target.value)} /></label>
          <label>Access
            <select className="input" value={tokRole} onChange={(e) => setTokRole(e.target.value as AccessRole)}>
              {allowed.map((r) => <option key={r} value={r}>{r}: {ROLE_HELP[r]}</option>)}
            </select>
          </label>
          <label>Valid for (days)<input className="input" type="number" min={1} max={q.data?.maxDays ?? 365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={create}>{busy ? <Spinner size={14} /> : <Icon name="lock" size={15} />}Create token</button>
          </div>
        </div>
      </Card>
      <Card pad={false}>
        <div className="pad"><CardHead title="Tokens" sub="Use as  Authorization: Bearer <token>  on any /api request."
          right={admin ? <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Everyone's tokens</label> : undefined} /></div>
        <Async q={q} rows={2} h={60}>
          {(d) => d.tokens.length === 0 ? <EmptyState icon="lock" title="No tokens yet" hint="Create one above." /> : (
            <ul className="feed">
              {d.tokens.map((t) => (
                <li key={t.id}>
                  <div className="grow"><b>{t.name}</b> <span className="mono muted small">{t.prefix}</span>
                    <p className="muted small">{t.role}{all ? ` · ${t.owner}` : ''} · created {timeAgo(t.createdAt)} · {t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}${t.lastIp ? ` from ${t.lastIp}` : ''}` : 'never used'} · expires {when(t.expiresAt)}</p></div>
                  <Badge tone={STATUS_TONE[t.status]} dot>{t.status}</Badge>
                  {t.status === 'active' && <HoldButton danger onConfirm={() => revoke(t.id)}>Revoke</HoldButton>}
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
      {shown && (
        <Modal title="Copy your token now" onClose={() => setShown(null)} footer={<button className="btn btn-primary" onClick={() => setShown(null)}>I have copied it</button>}>
          <p className="muted small">"{shown.name}" is shown once and cannot be recovered; only a hash is stored. It expires {when(shown.expiresAt)}.</p>
          <pre className="codebox" style={{ minHeight: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{shown.token}</pre>
          <CopyButton text={shown.token} />
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ passkeys
function PasskeysTab() {
  const cfg = useQuery(api.passkeyConfig, [], 0);
  const q = useQuery(api.passkeys, [], 0);
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && !!window.PublicKeyCredential;

  async function add() {
    setBusy(true);
    try {
      const { challengeId, options } = await api.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options as never });
      await api.passkeyRegisterVerify({ challengeId, response, name: name.trim() || 'Passkey' });
      toast.success('Passkey added');
      setName('');
      q.reload();
    } catch (e) {
      const x = e as { name?: string; message: string };
      if (x.name !== 'NotAllowedError' && x.name !== 'AbortError') toast.error(x.message);
    } finally { setBusy(false); }
  }
  async function remove(id: number) {
    try { await api.passkeyDelete(id); toast.success('Passkey removed'); q.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Async q={cfg} rows={2} h={80}>
      {(c) => !c.enabled ? (
        <Card><EmptyState icon="lock" title="Passkeys are not switched on" hint="Set auth.passkeys.rp_id and auth.passkeys.origin (https://your-dashboard) in homedash.yaml, then run homedash-config apply --restart. Passkeys need HTTPS." /></Card>
      ) : (
        <div className="stack">
          <Card>
            <CardHead title="Add a passkey" sub="Sign in with your fingerprint, face, device PIN or a security key. A passkey counts as both factors, so it skips the code step." />
            {!supported && <p className="callout err small">This browser does not support passkeys.</p>}
            <div className="form-grid">
              <label>Name this passkey<input className="input" value={name} maxLength={60} placeholder="e.g. Laptop, YubiKey" onChange={(e) => setName(e.target.value)} /></label>
              <div className="field" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" disabled={busy || !supported} onClick={add}>{busy ? <Spinner size={14} /> : <Icon name="lock" size={15} />}Add passkey</button>
              </div>
            </div>
          </Card>
          <Card pad={false}>
            <div className="pad"><CardHead title="Your passkeys" /></div>
            <Async q={q} rows={2} h={60}>
              {(list) => list.length === 0 ? <EmptyState icon="lock" title="No passkeys yet" /> : (
                <ul className="feed">
                  {list.map((p) => (
                    <li key={p.id}><div className="grow"><b>{p.name}</b><p className="muted small">added {timeAgo(p.createdAt)} · {p.lastUsedAt ? `last used ${timeAgo(p.lastUsedAt)}` : 'not used yet'}</p></div>
                      <HoldButton danger onConfirm={() => remove(p.id)}>Remove</HoldButton></li>
                  ))}
                </ul>
              )}
            </Async>
          </Card>
        </div>
      )}
    </Async>
  );
}

// ------------------------------------------------------------------------------------------ people
function UsersTab() {
  const users = useQuery(api.adminUsers, [], 15_000);
  const info = useQuery(api.adminAccess, [], 0);
  const sessions = useQuery(api.adminSessions, [], 15_000);
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  async function patch(u: AdminUser, b: { role?: AccessRole; teams?: string[]; disabled?: boolean }) {
    setBusy(u.id);
    try { await api.adminUserPatch(u.id, b); users.reload(); } catch (e) { toast.error((e as Error).message); users.reload(); } finally { setBusy(null); }
  }
  const teams = info.data?.teams ?? [];
  return (
    <div className="stack">
      <Card pad={false}>
        <div className="pad"><CardHead title="People" sub="Accounts managed by your identity provider (SSO or SCIM) take their role and teams from its groups, so they are read-only here." /></div>
        <Async q={users} rows={3} h={60}>
          {(list) => (
            <ul className="feed">
              {list.map((u) => (
                <li key={u.id} className="person">
                  <div className="grow">
                    <b>{u.username.replace(/^sso:/, '')}</b> <Badge tone={u.source === 'local' ? 'gray' : 'blue'}>{u.source}</Badge>{' '}
                    {u.disabled && <Badge tone="red" dot>deactivated</Badge>} {u.mfa && <Badge tone="green">2-step</Badge>} {u.passkeys > 0 && <Badge tone="green">{u.passkeys} passkey{u.passkeys === 1 ? '' : 's'}</Badge>}
                    <p className="muted small">last sign-in {u.lastLoginAt ? `${timeAgo(u.lastLoginAt)}${u.lastLoginIp ? ` from ${u.lastLoginIp}` : ''}` : 'never'} · {u.sessions} session{u.sessions === 1 ? '' : 's'} · {u.tokens} token{u.tokens === 1 ? '' : 's'}{u.groups.length ? ` · groups: ${u.groups.join(', ')}` : ''}</p>
                    {teams.length > 0 && (
                      <div className="chips-row">
                        {teams.map((t) => {
                          const on = u.teams.includes(t.name);
                          return <button key={t.name} className={`chip-toggle ${on ? 'on' : ''}`} disabled={u.managed || busy === u.id} aria-pressed={on}
                            title={`${t.vmids.join(', ')}${t.tags.length ? ` + tag ${t.tags.join(', ')}` : ''}`}
                            onClick={() => patch(u, { teams: on ? u.teams.filter((x) => x !== t.name) : [...u.teams, t.name] })}>{t.name}</button>;
                        })}
                        {u.teams.length > 0 && <span className="muted small">limited to their teams' guests</span>}
                      </div>
                    )}
                  </div>
                  <select className="input chan-level" aria-label={`Role of ${u.username}`} value={u.role} disabled={u.managed || busy === u.id} onChange={(e) => patch(u, { role: e.target.value as AccessRole })}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {!u.managed || u.source === 'sso'
                    ? (u.source === 'scim' ? null : <button className="btn btn-sm" disabled={busy === u.id} onClick={() => patch(u, { disabled: !u.disabled })}>{u.disabled ? 'Reactivate' : 'Deactivate'}</button>)
                    : null}
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
      <Card pad={false}>
        <div className="pad"><CardHead title="Active sessions" sub="End a session to sign that browser out immediately." /></div>
        <Async q={sessions} rows={2} h={50}>
          {(list) => list.length === 0 ? <EmptyState icon="inbox" title="No sessions" /> : (
            <ul className="feed">
              {list.map((s) => (
                <li key={s.id}><div className="grow"><b>{s.username.replace(/^sso:/, '')}</b> {s.current && <Badge tone="green">this session</Badge>} {s.pending && <Badge tone="amber">waiting for code</Badge>}
                  <p className="muted small">{s.ip ?? 'unknown address'} · signed in {timeAgo(s.createdAt)} · active {timeAgo(s.lastSeenAt)} · <span title={s.userAgent ?? ''}>{(s.userAgent ?? '').replace(/\(.*?\)/g, '').trim().slice(0, 48) || 'unknown client'}</span></p></div>
                  {!s.current && <HoldButton danger onConfirm={async () => { try { await api.adminSessionEnd(s.id); sessions.reload(); users.reload(); } catch (e) { toast.error((e as Error).message); } }}>End</HoldButton>}
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ teams and identity
function IdentityTab() {
  const q = useQuery(api.adminAccess, [], 0);
  return (
    <Async q={q} rows={3} h={100}>
      {(d) => (
        <div className="stack">
          <Card>
            <CardHead title="Teams" sub="Defined in homedash.yaml under access.teams. A person in a team sees and acts on those guests only, and gets no host-wide pages." />
            {d.teams.length === 0 ? <p className="muted small">No teams yet. Example: <span className="mono">access.teams.web.vmids: ["100-120"]</span> and <span className="mono">tags: [lab]</span>.</p> : (
              <ul className="rules">
                {d.teams.map((t) => <li key={t.name}><div className="grow"><b>{t.name}</b><p className="muted small">guests {t.vmids.join(', ') || 'none by id'}{t.tags.length ? ` · tagged ${t.tags.join(', ')}` : ''}</p></div></li>)}
              </ul>
            )}
          </Card>
          <Card>
            <CardHead title="Sign-in groups" sub="How groups from your identity provider become a role and teams." />
            <ul className="rules">
              {(['admin', 'operator', 'viewer'] as const).map((r) => <li key={r}><div className="grow"><b>{r}</b><p className="muted small">{d.groupRoles[r]?.length ? d.groupRoles[r].join(', ') : 'no group mapped'}</p></div></li>)}
              {Object.entries(d.groupTeams).map(([g, t]) => <li key={g}><div className="grow"><b>{g}</b><p className="muted small">joins team {t.join(', ')}</p></div></li>)}
              <li><div className="grow"><b>Everyone else</b><p className="muted small">gets the default role: {d.oidc.defaultRole}{d.oidc.adminUsers ? ` · ${d.oidc.adminUsers} user(s) always admin` : ''}</p></div></li>
            </ul>
          </Card>
          <Card>
            <CardHead title="Provisioning (SCIM)" sub="Let your identity provider create, update and deactivate accounts and groups."
              right={<Badge tone={d.scim.enabled ? 'green' : 'gray'} dot>{d.scim.enabled ? 'on' : 'off'}</Badge>} />
            {d.scim.enabled ? (
              <>
                <p className="muted small">Base URL <span className="mono">{location.origin}{d.scim.endpoint}</span> with the bearer token from <span className="mono">scim.token</span>. The SCIM userName must match the user's OIDC preferred_username or e-mail.</p>
                {d.scim.groups.length > 0 && <div className="chips-row">{d.scim.groups.map((g) => <Badge key={g.name}>{g.name} · {g.members}</Badge>)}</div>}
              </>
            ) : <p className="muted small">Set <span className="mono">scim.token</span> (24+ characters, <span className="mono">openssl rand -hex 24</span>) in homedash.yaml.</p>}
          </Card>
          <Card>
            <CardHead title="Other protections" />
            <ul className="rules">
              <li><div className="grow"><b>Passkeys</b><p className="muted small">{d.passkeys.enabled ? `on for ${d.passkeys.rpId}` : 'off (auth.passkeys)'}</p></div></li>
              <li><div className="grow"><b>Approvals</b><p className="muted small">{d.approvals.actions.length ? `${d.approvals.actions.join(', ')} · expire after ${d.approvals.ttlMinutes} min` : 'off (access.approvals.actions)'}</p></div></li>
              <li><div className="grow"><b>API tokens</b><p className="muted small">default {d.tokens.defaultDays} days, at most {d.tokens.maxDays}</p></div></li>
            </ul>
          </Card>
        </div>
      )}
    </Async>
  );
}
