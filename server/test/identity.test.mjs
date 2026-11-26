// Identity inspector: the pure analysis of a discovery document and key set, and the careful reading of a provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, compareWithSetup, describeKeys, discoveryUrl, inspect } from '../build/identity.js';

const ISS = 'https://sso.example.lan/realms/home';
const GOOD = {
  issuer: ISS, authorization_endpoint: `${ISS}/auth`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/certs`, end_session_endpoint: `${ISS}/logout`,
  scopes_supported: ['openid', 'profile', 'email', 'groups'], response_types_supported: ['code', 'id_token'], code_challenge_methods_supported: ['S256', 'plain'],
  id_token_signing_alg_values_supported: ['RS256', 'ES256'], claims_supported: ['sub', 'preferred_username', 'email', 'groups'],
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
};
const KEYS = { keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', use: 'sig', n: Buffer.alloc(256, 1).toString('base64url'), e: 'AQAB' }] };
const levels = (i) => i.findings.map((f) => f.level);
const has = (i, level, re) => i.findings.some((f) => f.level === level && re.test(f.text));

test('a healthy provider has no warnings or errors', () => {
  const i = analyze(ISS, GOOD, KEYS);
  assert.ok(!levels(i).includes('error') && !levels(i).includes('warn'), JSON.stringify(i.findings));
  assert.deepEqual(i.keys, [{ kid: 'k1', kty: 'RSA', alg: 'RS256', use: 'sig', detail: '2048-bit' }]);
  assert.equal(i.discoveryUrl, `${ISS}/.well-known/openid-configuration`);
});

test('issuer problems: mismatch is an error, a trailing slash only a warning, plain http a warning', () => {
  assert.ok(has(analyze(ISS, { ...GOOD, issuer: 'https://other.lan/realms/home' }, KEYS), 'error', /not "https:\/\/sso/));
  assert.ok(has(analyze(ISS, { ...GOOD, issuer: `${ISS}/` }, KEYS), 'warn', /trailing slash/));
  assert.ok(has(analyze('http://sso.lan', { ...GOOD, issuer: 'http://sso.lan' }, KEYS), 'warn', /not HTTPS/));
  assert.equal(discoveryUrl(`${ISS}/`), `${ISS}/.well-known/openid-configuration`);
});

test('what homedash sign-in cannot work with is an error', () => {
  assert.ok(has(analyze(ISS, { ...GOOD, token_endpoint: undefined }, KEYS), 'error', /token_endpoint/));
  assert.ok(has(analyze(ISS, { ...GOOD, response_types_supported: ['token'] }, KEYS), 'error', /code/));
  assert.ok(has(analyze(ISS, { ...GOOD, code_challenge_methods_supported: ['plain'] }, KEYS), 'error', /S256/));
  assert.ok(has(analyze(ISS, { ...GOOD, id_token_signing_alg_values_supported: ['HS256'] }, KEYS), 'error', /can verify only/));
  assert.ok(has(analyze(ISS, { ...GOOD, id_token_signing_alg_values_supported: ['none'] }, KEYS), 'error', /unsigned/));
  assert.ok(has(analyze(ISS, { ...GOOD, scopes_supported: ['profile'] }, KEYS), 'error', /openid/));
});

test('keys: empty set, unreadable set, private parts and short RSA keys are called out, and private parts are never copied', () => {
  assert.ok(has(analyze(ISS, GOOD, { keys: [] }), 'error', /empty/));
  assert.ok(has(analyze(ISS, GOOD, undefined, 'HTTP 500'), 'error', /could not be read: HTTP 500/));
  const priv = analyze(ISS, GOOD, { keys: [{ kty: 'RSA', n: 'AQAB', d: 'SECRET-PRIVATE-PART' }] });
  assert.ok(has(priv, 'error', /PRIVATE/));
  assert.ok(!JSON.stringify(priv).includes('SECRET-PRIVATE-PART'));
  assert.ok(has(analyze(ISS, GOOD, { keys: [{ kty: 'RSA', n: Buffer.alloc(128).toString('base64url') }] }), 'warn', /shorter than 2048/));
  assert.equal(describeKeys({ keys: [{ kty: 'EC', crv: 'P-256', kid: 'e' }] }).keys[0].detail, 'P-256');
  assert.deepEqual(describeKeys('nonsense').keys, []);
});

test('no groups claim is an information note for role mapping', () => {
  const i = analyze(ISS, { ...GOOD, claims_supported: ['sub', 'email', 'preferred_username'] }, KEYS);
  assert.ok(has(i, 'info', /groups or roles claim/));
});

test('comparison with homedash settings: wrong issuer, unlisted scope, role claim missing', () => {
  const i = analyze(ISS, { ...GOOD, claims_supported: ['sub', 'email'] }, KEYS);
  const setup = { configured: true, issuer: 'https://elsewhere', scopes: ['openid', 'offline_access'], rolesClaims: ['realm_access.roles', 'groups'], requiredRole: 'homelab' };
  const out = compareWithSetup(i, setup);
  assert.ok(out.some((f) => f.level === 'error' && /elsewhere/.test(f.text)));
  assert.ok(out.some((f) => /offline_access/.test(f.text)));
  assert.ok(out.some((f) => /role claims/.test(f.text)));
  assert.deepEqual(compareWithSetup(i, { ...setup, configured: false }), []);
});

test('inspect reads discovery then keys, refuses redirects and non-JSON, and keeps a key failure as a finding', async () => {
  const seen = [];
  const make = (map) => async (b) => { seen.push(b.url); const r = map[b.url]; if (!r) return { status: 404, text: '' }; return { status: r.status ?? 200, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }; };
  const ok = await inspect('https://93.184.216.34/realms/home', false, make({
    'https://93.184.216.34/realms/home/.well-known/openid-configuration': { body: { ...GOOD, issuer: 'https://93.184.216.34/realms/home', jwks_uri: 'https://93.184.216.34/certs' } },
    'https://93.184.216.34/certs': { body: KEYS },
  }));
  assert.equal(ok.keys.length, 1);
  assert.deepEqual(seen, ['https://93.184.216.34/realms/home/.well-known/openid-configuration', 'https://93.184.216.34/certs']);

  await assert.rejects(inspect('https://93.184.216.34/x', false, make({ 'https://93.184.216.34/x/.well-known/openid-configuration': { status: 302, body: '' } })), /redirected/);
  await assert.rejects(inspect('https://93.184.216.34/x', false, make({ 'https://93.184.216.34/x/.well-known/openid-configuration': { body: 'not json' } })), /did not return JSON/);
  await assert.rejects(inspect('https://93.184.216.34/x', false, make({})), /HTTP 404/);
  const noKeys = await inspect('https://93.184.216.34/x', false, make({ 'https://93.184.216.34/x/.well-known/openid-configuration': { body: { ...GOOD, issuer: 'https://93.184.216.34/x', jwks_uri: 'https://93.184.216.34/missing' } } }));
  assert.ok(has(noKeys, 'error', /key set could not be read/));
});

test('bad input and forbidden destinations are refused before any request', async () => {
  const never = async () => { throw new Error('must not be called'); };
  await assert.rejects(inspect('not a url', false, never), /web address/);
  await assert.rejects(inspect('ftp://x.lan', false, never), /https:\/\/ or http/);
  await assert.rejects(inspect('https://user:pw@x.lan', false, never), /user name/);
  await assert.rejects(inspect('http://169.254.169.254/', false, never), /not allowed/);
});
