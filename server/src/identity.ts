// Identity: read an OpenID Connect provider's configuration and say, in plain words, what is right and what will not work.
// Administrators only (under /api/admin). It reads the provider's public discovery document and key set; it never sends a
// credential and never returns homedash's own client secret.
import type { FastifyInstance } from 'fastify';
import { cfg, oidcConfigured } from './config.js';
import { assertDestinationAllowed } from './datasources/netguard.js';
import { listUsers } from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { requestText } from './monitoring/providers/http.js';

export type Level = 'ok' | 'info' | 'warn' | 'error';
export interface Finding { level: Level; text: string }
export interface KeyInfo { kid: string | null; kty: string; alg: string | null; use: string | null; detail: string }
export interface Inspection {
  issuer: string; discoveryUrl: string; discoveryIssuer: string | null;
  endpoints: Record<string, string>;
  supports: Record<string, string[]>;
  keys: KeyInfo[];
  findings: Finding[];
}

/** What homedash's own sign-in can verify (oidc.ts). */
const VERIFIABLE = ['RS256', 'RS384', 'RS512', 'ES256'];
const ENDPOINTS = ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri', 'end_session_endpoint', 'introspection_endpoint', 'revocation_endpoint', 'device_authorization_endpoint', 'registration_endpoint'];
const LISTS = ['scopes_supported', 'claims_supported', 'response_types_supported', 'grant_types_supported', 'id_token_signing_alg_values_supported', 'code_challenge_methods_supported', 'token_endpoint_auth_methods_supported'];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200).map((x) => x.slice(0, 120)) : []);
const text = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');

export const discoveryUrl = (issuer: string) => `${issuer.trim().replace(/\/+$/, '')}/.well-known/openid-configuration`;

/** Pure: the public parts of a key set. Only whitelisted fields are copied, so nothing secret can be passed on. */
export function describeKeys(jwks: unknown): { keys: KeyInfo[]; hasPrivate: boolean } {
  const list = Array.isArray((jwks as { keys?: unknown })?.keys) ? ((jwks as { keys: Record<string, unknown>[] }).keys) : [];
  let hasPrivate = false;
  const keys = list.slice(0, 50).map((k): KeyInfo => {
    if (['d', 'p', 'q', 'dp', 'dq', 'qi'].some((f) => f in k)) hasPrivate = true;
    const kty = text(k.kty, 10);
    let detail = '';
    if (kty === 'RSA' && typeof k.n === 'string') detail = `${Math.round((Buffer.from(k.n, 'base64url').length * 8) / 256) * 256}-bit`;
    else if (kty === 'EC') detail = text(k.crv, 12);
    else if (kty === 'OKP') detail = text(k.crv, 12);
    return { kid: text(k.kid, 80) || null, kty, alg: text(k.alg, 12) || null, use: text(k.use, 8) || null, detail };
  });
  return { keys, hasPrivate };
}

/** Pure: the findings for a discovery document and key set. `requested` is the issuer the person typed. */
export function analyze(requested: string, doc: Record<string, unknown>, jwks: unknown, jwksError?: string): Inspection {
  const findings: Finding[] = [];
  const add = (level: Level, t: string) => findings.push({ level, text: t });
  const want = requested.trim();
  const issuer = text(doc.issuer, 500) || null;
  const endpoints: Record<string, string> = {};
  for (const e of ENDPOINTS) if (typeof doc[e] === 'string') endpoints[e] = text(doc[e], 500);
  const supports: Record<string, string[]> = {};
  for (const l of LISTS) supports[l] = strs(doc[l]);

  if (!issuer) add('error', 'The document has no issuer, so tokens cannot be tied to this provider.');
  else if (issuer === want) add('ok', 'The issuer in the document matches the address you gave exactly.');
  else if (issuer.replace(/\/+$/, '') === want.replace(/\/+$/, '')) add('warn', `The issuer is "${issuer}", which differs from "${want}" only by a trailing slash. homedash compares the issuer exactly, so set it as "${issuer}".`);
  else add('error', `The issuer in the document is "${issuer}", not "${want}". Sign-in checks this and will refuse the provider.`);
  if (!/^https:\/\//i.test(want)) add('warn', 'The issuer is not HTTPS. Tokens and codes would travel unencrypted; most providers require HTTPS for real use.');

  for (const e of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!endpoints[e]) add('error', `The document has no ${e}; sign-in cannot work without it.`);
  if (!endpoints.end_session_endpoint) add('info', 'No end_session_endpoint: signing out of homedash will not sign the person out of the provider.');

  const scopes = supports.scopes_supported;
  if (scopes.length && !scopes.includes('openid')) add('error', 'The provider does not list the "openid" scope.');
  const types = supports.response_types_supported;
  if (types.length && !types.includes('code')) add('error', 'The provider does not support the authorization code flow (response type "code"), which homedash uses.');
  const pkce = supports.code_challenge_methods_supported;
  if (!pkce.length) add('info', 'The document does not list PKCE methods. homedash always sends PKCE (S256); most providers accept it without listing it.');
  else if (!pkce.includes('S256')) add('error', `The provider supports PKCE only with ${pkce.join(', ')}; homedash needs S256.`);
  else add('ok', 'PKCE with S256 is supported.');

  const algs = supports.id_token_signing_alg_values_supported;
  if (algs.includes('none') && algs.length === 1) add('error', 'Tokens are unsigned ("none" is the only algorithm). They cannot be trusted.');
  else if (algs.length && !algs.some((a) => VERIFIABLE.includes(a))) add('error', `Tokens are signed with ${algs.join(', ')}; homedash can verify only ${VERIFIABLE.join(', ')}.`);
  else if (algs.includes('none')) add('warn', 'The provider can issue unsigned tokens ("none"). homedash ignores these, but other apps using this provider may not.');
  else if (algs.length) add('ok', `Tokens are signed with ${algs.join(', ')}.`);
  const authMethods = supports.token_endpoint_auth_methods_supported;
  if (authMethods.length && !authMethods.some((m) => ['client_secret_basic', 'client_secret_post', 'none'].includes(m))) add('warn', `Client sign-in methods are ${authMethods.join(', ')}; homedash uses a secret in the request, or none for a public client.`);

  const { keys, hasPrivate } = describeKeys(jwks);
  if (jwksError) add('error', `The key set could not be read: ${jwksError}`);
  else if (!keys.length) add('error', 'The key set is empty, so no token can be verified.');
  else {
    add('ok', `${keys.length} signing key${keys.length === 1 ? '' : 's'} published.`);
    if (hasPrivate) add('error', 'The key set contains PRIVATE key parts. Anyone can forge tokens: rotate the keys at once.');
    const weak = keys.filter((k) => k.kty === 'RSA' && /^(512|768|1024)-bit$/.test(k.detail));
    if (weak.length) add('warn', `${weak.length} RSA key${weak.length === 1 ? ' is' : 's are'} shorter than 2048 bits.`);
    if (!keys.some((k) => k.kty === 'RSA' || (k.kty === 'EC' && k.detail === 'P-256'))) add('warn', 'No RSA or P-256 key is published; homedash can verify only those.');
  }

  const claims = supports.claims_supported;
  if (claims.length) {
    for (const c of ['sub', 'preferred_username', 'email']) if (!claims.includes(c)) add('info', `The claim "${c}" is not listed as supported.`);
    const roleish = ['groups', 'roles', 'realm_access', 'resource_access'].filter((c) => claims.includes(c));
    if (!roleish.length) add('info', 'No groups or roles claim is listed. Mapping groups to homedash roles needs one (often a scope must be requested, or a mapper added at the provider).');
  }
  return { issuer: want, discoveryUrl: discoveryUrl(want), discoveryIssuer: issuer, endpoints, supports, keys, findings };
}

/** Reads the provider and returns what it publishes. Throws HttpError with plain words. */
export async function inspect(issuerIn: string, insecure: boolean, fetchText = requestText): Promise<Inspection> {
  const issuer = issuerIn.trim();
  let u: URL;
  try { u = new URL(issuer); } catch { throw new HttpError(400, 'BAD_REQUEST', 'Give the issuer as a web address, for example https://sso.example.lan/realms/home'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'BAD_REQUEST', 'The issuer must start with https:// or http://');
  if (u.username || u.password) throw new HttpError(400, 'BAD_REQUEST', 'Do not put a user name or password in the address');
  await assertDestinationAllowed({ host: u.hostname.replace(/^\[|\]$/g, '') }, cfg.datasourceAllowedNets, true);
  const get = async (url: string) => {
    const { status, text: body } = await fetchText({ url, method: 'GET', headers: { Accept: 'application/json' } }, insecure, 8000);
    if (status >= 300 && status < 400) throw new HttpError(502, 'UPSTREAM', `The server redirected ${url} elsewhere (HTTP ${status}). Use the final address.`);
    if (status !== 200) throw new HttpError(502, 'UPSTREAM', `${url} answered HTTP ${status}`);
    try { return JSON.parse(body) as unknown; } catch { throw new HttpError(502, 'UPSTREAM', `${url} did not return JSON`); }
  };
  let doc: unknown;
  try { doc = await get(discoveryUrl(issuer)); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(502, 'UPSTREAM', (e as Error).message); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(502, 'UPSTREAM', 'The discovery document is not a JSON object');
  const jwksUri = typeof (doc as Record<string, unknown>).jwks_uri === 'string' ? String((doc as Record<string, unknown>).jwks_uri) : '';
  let jwks: unknown; let jwksError: string | undefined;
  if (jwksUri) {
    try {
      const ju = new URL(jwksUri);
      // The key set is on the provider's own host by convention; a different host is shown, but is fetched only if it is allowed.
      await assertDestinationAllowed({ host: ju.hostname.replace(/^\[|\]$/g, '') }, cfg.datasourceAllowedNets, true);
      jwks = await get(jwksUri);
    } catch (e) { jwksError = (e as Error).message.slice(0, 200); }
  }
  return analyze(issuer, doc as Record<string, unknown>, jwks, jwksError);
}

/** What homedash's own sign-in is set to. Never includes the client secret. */
export function localSetup() {
  const o = cfg.oidc;
  const users = listUsers();
  const redirect = o.redirectUri;
  const notes: Finding[] = [];
  if (!oidcConfigured()) notes.push({ level: 'info', text: 'Single sign-on is not set up. Set auth.oidc in homedash.yaml (see Setup).' });
  else {
    if (!o.allowedUsers.length && !o.requiredRole) notes.push({ level: 'error', text: 'Neither allowed users nor a required role is set, so the server keeps single sign-on switched off.' });
    if (redirect && !/^https:\/\//i.test(redirect)) notes.push({ level: 'warn', text: 'The redirect address is not HTTPS; most providers refuse that outside localhost.' });
    if (redirect && !/\/api\/auth\/sso\/callback$/.test(redirect)) notes.push({ level: 'warn', text: 'The redirect address does not end in /api/auth/sso/callback, which is where homedash receives the sign-in.' });
    if (!o.clientSecret) notes.push({ level: 'info', text: 'No client secret: this is a public client using PKCE only. That is fine if the provider is set up that way.' });
    if (o.defaultRole === 'admin' && !o.adminUsers.length) notes.push({ level: 'warn', text: 'Everyone who signs in through SSO becomes an administrator. Set auth.oidc.default_role to viewer and list admins in admin_users.' });
  }
  return {
    configured: oidcConfigured(), issuer: o.issuer || null, clientId: o.clientId || null, hasClientSecret: !!o.clientSecret, redirectUri: redirect || null,
    scopes: o.scopes.split(/\s+/).filter(Boolean), rolesClaims: o.rolesClaims, requiredRole: o.requiredRole || null, allowedUsers: o.allowedUsers.length, adminUsers: o.adminUsers.length,
    defaultRole: o.defaultRole, label: o.label,
    people: { total: users.length, sso: users.filter((u) => u.external && !u.scimId).length, scim: users.filter((u) => !!u.scimId).length, local: users.filter((u) => !u.external).length },
    notes,
  };
}

/** Pure: checks that homedash's own settings are compatible with what the provider publishes. */
export function compareWithSetup(i: Inspection, s: ReturnType<typeof localSetup>): Finding[] {
  const out: Finding[] = [];
  if (!s.configured) return out;
  if (i.discoveryIssuer && s.issuer && i.discoveryIssuer !== s.issuer) out.push({ level: 'error', text: `homedash is set to issuer "${s.issuer}", but this provider says "${i.discoveryIssuer}".` });
  const listed = i.supports.scopes_supported;
  if (listed.length) for (const sc of s.scopes) if (!listed.includes(sc)) out.push({ level: 'warn', text: `homedash asks for the scope "${sc}", which the provider does not list.` });
  const claims = i.supports.claims_supported;
  if (claims.length && s.requiredRole) {
    const firstSegments = s.rolesClaims.map((c) => c.split('.')[0]);
    if (!firstSegments.some((c) => claims.includes(c))) out.push({ level: 'warn', text: `A required role is set, but none of the role claims (${s.rolesClaims.join(', ')}) is listed by the provider. Roles may not arrive in the token; check a mapper or scope.` });
  }
  return out;
}

export function registerIdentity(app: FastifyInstance) {
  app.get('/api/admin/identity', async () => {
    const setup = localSetup();
    if (!setup.configured || !setup.issuer) return { setup, inspection: null, comparison: [] as Finding[], error: null };
    try {
      const inspection = await inspect(setup.issuer, false);
      return { setup, inspection, comparison: compareWithSetup(inspection, setup), error: null };
    } catch (e) {
      return { setup, inspection: null, comparison: [] as Finding[], error: (e as Error).message };
    }
  });

  app.post<{ Body: { issuer?: string; insecure_tls?: boolean } }>('/api/admin/identity/inspect', async (req) => {
    const b = req.body ?? {};
    const issuer = String(b.issuer ?? '').trim().slice(0, 500);
    if (!issuer) throw new HttpError(400, 'BAD_REQUEST', 'Give the issuer address');
    const inspection = await inspect(issuer, b.insecure_tls === true);
    logEvent('info', 'app', `${req.user?.username ?? 'someone'} inspected the OpenID Connect provider ${new URL(issuer).origin}`);
    return { inspection, comparison: compareWithSetup(inspection, localSetup()) };
  });
}
