// End-to-end: boots the real server (temp database, mock Proxmox API) and drives it over HTTP.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const NODE = ['--disable-warning=ExperimentalWarning'];
const PW = 'correct-horse-battery';
let dir, pve, srv, base, env;
const posted = []; // POSTs the mock Proxmox received: proves an approved action really ran

const GUESTS = [
  { vmid: 100, name: 'web1', status: 'running', tags: 'web', type: 'lxc' },
  { vmid: 150, name: 'db1', status: 'running', tags: '', type: 'lxc' },
  { vmid: 300, name: 'labvm', status: 'stopped', tags: 'lab', type: 'lxc' },
];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hd-access-'));
  pve = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') posted.push(req.url);
    if (req.url.includes('/cluster/resources') && req.url.includes('type=vm')) return res.end(JSON.stringify({ data: GUESTS.map((g) => ({ vmid: g.vmid, name: g.name, status: g.status, tags: g.tags, type: g.type, node: 'pve', maxmem: 1, mem: 0, cpu: 0, uptime: 0, maxcpu: 1 })) }));
    if (req.url.endsWith('/lxc')) return res.end(JSON.stringify({ data: GUESTS.map((g) => ({ vmid: g.vmid, name: g.name, status: g.status, tags: g.tags, maxmem: 1, mem: 0, cpu: 0, uptime: 0, maxcpu: 1 })) }));
    if (req.url.endsWith('/qemu')) return res.end(JSON.stringify({ data: [] }));
    res.end(JSON.stringify({ data: 'UPID:pve:00000001:test' }));
  });
  await new Promise((r) => pve.listen(0, '127.0.0.1', r));
  const port = 39000 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 't.db'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent',
    PVE_URL: `http://127.0.0.1:${pve.address().port}`, PVE_NODE: 'pve', PVE_TOKEN_ID: 'a@pve!b', PVE_TOKEN_SECRET: 'x', HOST_POWER_ENABLED: 'true',
    ACCESS_TEAMS: JSON.stringify({ web: { vmids: ['100-120'], tags: ['lab'] } }),
    ACCESS_GROUP_ROLES: JSON.stringify({ admin: ['homedash-admins'], operator: ['ops'] }),
    ACCESS_GROUP_TEAMS: JSON.stringify({ 'web-team': ['web'] }),
    ACCESS_APPROVALS: JSON.stringify({ actions: ['host.shutdown'], ttl_minutes: 30 }),
    SCIM_TOKEN: 'scim-token-scim-token-1234', OIDC_DEFAULT_ROLE: 'viewer',
    WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost',
  };
  for (const [u, role] of [['admin', 'admin'], ['admin2', 'admin'], ['ops', 'operator'], ['viewer1', 'viewer']]) {
    const r = spawnSync('node', [...NODE, 'build/create-user.js', u, role], { env: { ...env, NEW_PASSWORD: PW }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn('node', [...NODE, 'build/index.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/passkey/config`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { srv?.kill(); pve?.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps the db locked briefly */ } });

/** A tiny client: keeps a session cookie, or sends a bearer token. */
function client() {
  let cookie = '', bearer = '';
  const c = {
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method, headers: { 'X-Requested-With': 'homedash', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json };
    },
    async login(u) { const r = await c.call('POST', '/api/auth/login', { username: u, password: PW }); assert.equal(r.status, 200, `${u}: ${JSON.stringify(r.body)}`); return c; },
    useToken(t) { bearer = t; cookie = ''; return c; },
  };
  return c;
}

let admin, admin2, ops, viewer, opsId;
const SHUT = { confirm: 'pve' };

test('local users sign in; roles are enforced', async () => {
  admin = await client().login('admin'); admin2 = await client().login('admin2'); ops = await client().login('ops'); viewer = await client().login('viewer1');
  assert.equal((await viewer.call('GET', '/api/features')).status, 200);
  assert.equal((await viewer.call('GET', '/api/admin/users')).body.code, 'FORBIDDEN');
  assert.equal((await admin.call('GET', '/api/admin/users')).status, 200);
});

test('teams: a scoped user sees and reaches only their guests, and nothing host-wide', async () => {
  const users = (await admin.call('GET', '/api/admin/users')).body;
  opsId = users.find((u) => u.username === 'ops').id;
  const bad = await admin.call('PATCH', `/api/admin/users/${opsId}`, { teams: ['nope'] });
  assert.equal(bad.status, 400);
  assert.equal((await admin.call('PATCH', `/api/admin/users/${opsId}`, { teams: ['web'] })).status, 200);

  const list = await ops.call('GET', '/api/guests');
  assert.deepEqual(list.body.map((g) => g.vmid).sort(), [100, 300]); // 100 by range, 300 by tag, 150 hidden
  assert.equal((await ops.call('GET', '/api/guests/150/snapshots')).body.code, 'OUT_OF_SCOPE');
  assert.notEqual((await ops.call('GET', '/api/guests/100/snapshots')).body?.code, 'OUT_OF_SCOPE');
  assert.equal((await ops.call('GET', '/api/nginx/sites')).body.code, 'OUT_OF_SCOPE');
  assert.equal((await ops.call('GET', '/api/overview')).body.code, 'OUT_OF_SCOPE');
  assert.equal((await ops.call('POST', '/api/host/shutdown', { confirm: 'pve' })).status, 403); // refused by role before scope is even asked
  // an unscoped admin still sees all three
  assert.equal((await admin.call('GET', '/api/guests')).body.length, 3);
});

test('a local account whose role is edited keeps the safety rails', async () => {
  const adminId = (await admin.call('GET', '/api/admin/users')).body.find((u) => u.username === 'admin').id;
  assert.equal((await admin.call('PATCH', `/api/admin/users/${adminId}`, { disabled: true })).body.code, 'SELF');
  const a2 = (await admin.call('GET', '/api/admin/users')).body.find((u) => u.username === 'admin2').id;
  assert.equal((await admin.call('PATCH', `/api/admin/users/${a2}`, { role: 'viewer' })).status, 200);
  assert.equal((await admin.call('PATCH', `/api/admin/users/${a2}`, { role: 'admin' })).status, 200);
});

test('API tokens: shown once, capped by role, scoped like their owner, revocable, no token-created tokens', async () => {
  const made = await admin.call('POST', '/api/auth/tokens', { name: 'ci', days: 7, role: 'viewer' });
  assert.equal(made.status, 200);
  assert.match(made.body.token, /^hd_[0-9a-f]{12}_[A-Za-z0-9_-]{40,}$/);
  const t = client().useToken(made.body.token);
  assert.equal((await t.call('GET', '/api/features')).status, 200);
  assert.equal((await t.call('POST', '/api/scenes', {})).body.code, 'FORBIDDEN'); // viewer token cannot write although its owner can
  assert.equal((await t.call('POST', '/api/auth/tokens', { name: 'x' })).body.code, 'TOKEN_FORBIDDEN');
  assert.equal((await t.call('GET', '/api/auth/tokens')).body.code, 'TOKEN_FORBIDDEN');
  // a plain GET with a bogus bearer is rejected, not treated as anonymous
  assert.equal((await client().useToken('hd_000000000000_' + 'x'.repeat(43)).call('GET', '/api/features')).status, 401);
  // cannot ask for more than you have
  assert.equal((await ops.call('POST', '/api/auth/tokens', { name: 'big', role: 'admin' })).status, 403);
  // list never reveals the secret
  const list = (await admin.call('GET', '/api/auth/tokens')).body.tokens;
  assert.ok(!JSON.stringify(list).includes(made.body.token.slice(-20)));
  // a scoped user's token is scoped too
  const ot = (await ops.call('POST', '/api/auth/tokens', { name: 'opsci', role: 'operator' })).body.token;
  const o = client().useToken(ot);
  assert.deepEqual((await o.call('GET', '/api/guests')).body.map((g) => g.vmid).sort(), [100, 300]);
  assert.equal((await o.call('GET', '/api/guests/150/snapshots')).body.code, 'OUT_OF_SCOPE');
  // revoke
  assert.equal((await admin.call('DELETE', `/api/auth/tokens/${made.body.id}`)).status, 200);
  assert.equal((await t.call('GET', '/api/features')).status, 401);
});

test('four-eyes approvals: ask, a different admin approves, the exact request runs once', async () => {
  posted.length = 0;
  const first = await admin.call('POST', '/api/host/shutdown', SHUT);
  assert.equal(first.status, 409); assert.equal(first.body.code, 'APPROVAL_REQUIRED');
  assert.equal(posted.length, 0, 'nothing runs before approval');
  const id = first.body.approval.id;
  // asking again does not create a second request
  assert.equal((await admin.call('POST', '/api/host/shutdown', SHUT)).body.approval.id, id);
  // the requester cannot approve their own request; a viewer cannot decide at all
  assert.equal((await admin.call('POST', `/api/approvals/${id}/approve`, {})).body.code, 'SELF_APPROVAL');
  assert.equal((await viewer.call('POST', `/api/approvals/${id}/approve`, {})).status, 403);
  // an unapproved id is refused
  assert.equal((await admin.call('POST', '/api/host/shutdown', SHUT, { 'X-Approval-Id': id })).body.code, 'APPROVAL_INVALID');
  // the second admin approves
  const ok = await admin2.call('POST', `/api/approvals/${id}/approve`, { note: 'maintenance' });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'approved');
  // someone else cannot use it; a different request cannot use it
  assert.equal((await admin2.call('POST', '/api/host/shutdown', SHUT, { 'X-Approval-Id': id })).body.code, 'APPROVAL_INVALID');
  assert.equal((await admin.call('POST', '/api/host/shutdown', { ...SHUT, extra: 1 }, { 'X-Approval-Id': id })).body.code, 'APPROVAL_INVALID');
  assert.equal(posted.length, 0);
  // the requester runs it, exactly once
  const run = await admin.call('POST', '/api/host/shutdown', SHUT, { 'X-Approval-Id': id });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(posted.some((u) => u.includes('/status')), 'the action reached Proxmox');
  assert.equal((await admin.call('POST', '/api/host/shutdown', SHUT, { 'X-Approval-Id': id })).body.code, 'APPROVAL_INVALID');
  // history shows who asked, who approved
  const hist = (await admin2.call('GET', '/api/approvals')).body;
  const row = hist.items.find((a) => a.id === id);
  assert.equal(row.status, 'used'); assert.equal(row.requestedBy, 'admin'); assert.equal(row.decidedBy, 'admin2');
  assert.equal(hist.canDecide, true);
});

test('rejected requests cannot be run', async () => {
  const id = (await admin.call('POST', '/api/host/shutdown', { ...SHUT, why: 'reject me' })).body.approval.id;
  assert.equal((await admin2.call('POST', `/api/approvals/${id}/reject`, {})).body.status, 'rejected');
  assert.equal((await admin.call('POST', '/api/host/shutdown', { ...SHUT, why: 'reject me' }, { 'X-Approval-Id': id })).body.code, 'APPROVAL_INVALID');
});

test('SCIM: bearer auth, provisioning, group-driven role, deactivation', async () => {
  const scim = (method, path, body, token = 'scim-token-scim-token-1234') => fetch(`${base}/scim/v2${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }));

  assert.equal((await scim('GET', '/Users', undefined, 'wrong-token-wrong-token-12')).status, 401);
  assert.equal((await scim('GET', '/ServiceProviderConfig')).body.patch.supported, true);

  const u = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Alice@Example.com', active: true });
  assert.equal(u.status, 201);
  assert.equal(u.body.userName, 'alice@example.com');
  assert.equal((await scim('POST', '/Users', { userName: 'alice@example.com' })).status, 409);
  assert.equal((await scim('GET', '/Users?filter=userName eq "alice@example.com"')).body.totalResults, 1);

  // joins a mapped group -> role and teams follow, live
  const g = await scim('POST', '/Groups', { displayName: 'web-team', members: [{ value: u.body.id }] });
  assert.equal(g.status, 201);
  let row = (await admin.call('GET', '/api/admin/users')).body.find((x) => x.username === 'sso:alice@example.com');
  assert.deepEqual(row.teams, ['web']); assert.equal(row.role, 'viewer'); assert.equal(row.source, 'scim');
  const adm = await scim('POST', '/Groups', { displayName: 'homedash-admins', members: [{ value: u.body.id }] });
  row = (await admin.call('GET', '/api/admin/users')).body.find((x) => x.username === 'sso:alice@example.com');
  assert.equal(row.role, 'admin');
  // leaving the group via PATCH removes it again
  await scim('PATCH', `/Groups/${adm.body.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: `members[value eq "${u.body.id}"]` }] });
  row = (await admin.call('GET', '/api/admin/users')).body.find((x) => x.username === 'sso:alice@example.com');
  assert.equal(row.role, 'viewer');
  // SCIM-managed accounts cannot be edited by hand
  assert.equal((await admin.call('PATCH', `/api/admin/users/${row.id}`, { role: 'admin' })).body.code, 'MANAGED');
  // deactivate
  const off = await scim('PATCH', `/Users/${u.body.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] });
  assert.equal(off.body.active, false);
  assert.equal((await scim('DELETE', `/Users/${u.body.id}`)).status, 204);
});

test('deactivating a local account ends its session and blocks sign-in', async () => {
  assert.equal((await ops.call('GET', '/api/features')).status, 200);
  assert.equal((await admin.call('PATCH', `/api/admin/users/${opsId}`, { disabled: true })).status, 200);
  assert.equal((await ops.call('GET', '/api/features')).status, 401);
  const again = await client().call('POST', '/api/auth/login', { username: 'ops', password: PW });
  assert.equal(again.status, 401);
});

test('group mapping: role from groups, admin_users always wins, unmapped users get the default', async () => {
  Object.assign(process.env, { ACCESS_GROUP_ROLES: env.ACCESS_GROUP_ROLES, ACCESS_GROUP_TEAMS: env.ACCESS_GROUP_TEAMS, ACCESS_TEAMS: env.ACCESS_TEAMS });
  const { accessFromGroups, inScope, scopeOf } = await import('../build/access.js');
  assert.equal(accessFromGroups(['homedash-admins'], 'viewer', false).role, 'admin');
  assert.equal(accessFromGroups(['OPS'], 'viewer', false).role, 'operator'); // case-insensitive
  assert.equal(accessFromGroups(['homedash-admins', 'ops'], 'viewer', false).role, 'admin'); // highest wins
  assert.equal(accessFromGroups(['random'], 'viewer', false).role, 'viewer');
  assert.equal(accessFromGroups([], 'viewer', true).role, 'admin');
  assert.deepEqual(accessFromGroups(['web-team'], 'viewer', false).teams, ['web']);
  const s = scopeOf(['web']);
  assert.equal(inScope(s, { vmid: 110, tags: [] }), true);
  assert.equal(inScope(s, { vmid: 121, tags: [] }), false);
  assert.equal(inScope(s, { vmid: 400, tags: ['LAB'] }), true);
  assert.equal(inScope(null, { vmid: 1, tags: [] }), true);
  assert.equal(scopeOf(['unknown-team']).rules.length, 0); // an unknown team grants nothing, it does not unscope the user
});

test('passkeys: config is public, sign-in options are issued, a forged response is refused', async () => {
  const anon = client();
  assert.equal((await anon.call('GET', '/api/auth/passkey/config')).body.enabled, true);
  const o = await anon.call('POST', '/api/auth/passkey/login/options', {});
  assert.equal(o.status, 200);
  assert.ok(o.body.options.challenge.length > 20);
  assert.equal(o.body.options.rpId, 'localhost');
  assert.equal(o.body.options.userVerification, 'required');
  const forged = await anon.call('POST', '/api/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: { id: 'nope', rawId: 'nope', type: 'public-key', response: {}, clientExtensionResults: {} } });
  assert.equal(forged.status, 401);
  // the challenge is single use
  assert.equal((await anon.call('POST', '/api/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: { id: 'x' } })).status, 401);
  // registering needs a session
  assert.equal((await anon.call('POST', '/api/auth/passkeys/register/options', {})).status, 401);
  const reg = await admin.call('POST', '/api/auth/passkeys/register/options', {});
  assert.equal(reg.status, 200);
  assert.equal(reg.body.options.authenticatorSelection.residentKey, 'required');
});

test('silences and routes: permissions and validation', async () => {
  const when = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  assert.equal((await viewer.call('POST', '/api/notify/silences', { name: 'x', startsAt: when(0), endsAt: when(1) })).status, 403);
  assert.equal((await admin.call('POST', '/api/notify/silences', { name: '', endsAt: when(1) })).status, 400);
  assert.equal((await admin.call('POST', '/api/notify/silences', { name: 'bad', startsAt: when(2), endsAt: when(1) })).status, 400);
  assert.equal((await admin.call('POST', '/api/notify/silences', { name: 'long', startsAt: when(0), endsAt: when(24 * 40) })).status, 400);
  assert.equal((await admin.call('POST', '/api/notify/silences', { name: 'c', startsAt: when(0), endsAt: when(1), categories: ['nope'] })).status, 400);
  assert.equal((await admin.call('POST', '/api/notify/silences', { name: 'w', weekly: { days: [9], start: '22:00', minutes: 60 } })).status, 400);
  const ok = await admin.call('POST', '/api/notify/silences', { name: 'Patch night', startsAt: when(-1), endsAt: when(2), categories: ['host'] });
  assert.equal(ok.status, 200);
  const list = (await viewer.call('GET', '/api/notify/silences')).body; // anyone can see what is held back
  assert.equal(list.find((s) => s.name === 'Patch night').active, true);
  const weekly = await admin.call('POST', '/api/notify/silences', { name: 'Weekend', weekly: { days: [6, 0], start: '22:00', minutes: 600 } });
  assert.equal(weekly.status, 200);
  assert.equal((await admin.call('DELETE', `/api/notify/silences/${ok.body.id}`)).status, 200);
  assert.equal((await admin.call('DELETE', `/api/notify/silences/${weekly.body.id}`)).status, 200);
  assert.equal((await admin.call('DELETE', `/api/notify/silences/${weekly.body.id}`)).status, 404);

  // routes are administration: viewers cannot, and channel ids are validated
  assert.equal((await viewer.call('POST', '/api/notify/routes', { name: 'r', channels: ['webhook'] })).status, 403);
  assert.equal((await admin.call('POST', '/api/notify/routes', { name: 'r', channels: ['carrier-pigeon'] })).status, 400);
  assert.equal((await admin.call('POST', '/api/notify/routes', { name: 'r', channels: [] })).status, 400);
  const r = await admin.call('POST', '/api/notify/routes', { name: 'Outages page', categories: ['host'], minLevel: 'error', channels: ['pagerduty'] });
  assert.equal(r.status, 200);
  const prev = (await admin.call('POST', '/api/notify/preview', { category: 'host', level: 'error', title: 'DOWN', message: 'x' })).body;
  assert.deepEqual(prev.channels, ['pagerduty']); assert.deepEqual(prev.routedBy, ['Outages page']);
  assert.equal((await admin.call('POST', '/api/notify/preview', { category: 'tasks', level: 'error', title: 'x', message: 'x' })).body.channels, null);
  assert.equal((await admin.call('DELETE', `/api/notify/routes/${r.body.id}`)).status, 200);
});
