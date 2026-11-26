// The sources API against the real server: roles, test-before-save, secrets, the address guard, the webhook secret lifecycle.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const NODE = ['--disable-warning=ExperimentalWarning'];
const PW = 'correct-horse-battery';
const PROM_PASS = 'prom-pass-do-not-leak';
const dir = mkdtempSync(join(tmpdir(), 'hd-madmin-'));
let srv, base, prom, log = '', admin, viewer;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); } return v; }

function client() {
  let cookie = '';
  return {
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, { method, headers: { 'x-requested-with': 'homedash', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text };
    },
    async login(u) { const r = await this.call('POST', '/api/auth/login', { username: u, password: PW }); assert.equal(r.status, 200); return this; },
  };
}

before(async () => {
  // A mock Prometheus: basic auth, one firing rule.
  prom = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/rules')) {
      if (req.headers.authorization !== `Basic ${Buffer.from(`ops:${PROM_PASS}`).toString('base64')}`) { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify({ status: 'success', data: { groups: [{ name: 'g', file: 'f', rules: [{ type: 'alerting', name: 'DiskFull', labels: { severity: 'critical' }, annotations: { summary: 'root 93%' }, alerts: [{ state: 'firing', activeAt: '2026-01-01T00:00:00Z', labels: {}, annotations: {} }] }] }] } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => prom.listen(0, '127.0.0.1', r));
  const port = 39900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 'a.db'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'info', MONITORING_POLL_MS: '1000', SECRETS_KEY: 'k'.repeat(40), PVE_NODE: 'pve' };
  for (const [u, role] of [['admin', 'admin'], ['viewer1', 'viewer']]) {
    const r = spawnSync('node', [...NODE, 'build/create-user.js', u, role], { env: { ...env, NEW_PASSWORD: PW }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn('node', [...NODE, 'build/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/passkey/config`); break; } catch { await sleep(100); } }
  admin = await client().login('admin'); viewer = await client().login('viewer1');
});
after(() => { srv?.kill(); prom?.close(); setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }, 300); });

const promBody = (over = {}) => ({ kind: 'prometheus', name: 'Prod Prometheus', url: `http://127.0.0.1:${prom.address().port}`, username: 'ops', password: PROM_PASS, ...over });
let promId, hookId, hookSecret;

test('every sources route is administrator-only, while the merged list stays readable by a viewer', async () => {
  const calls = [['GET', '/api/monitoring/catalog'], ['GET', '/api/monitoring/sources'], ['POST', '/api/monitoring/sources', promBody()], ['POST', '/api/monitoring/sources/test', promBody()],
    ['POST', '/api/monitoring/sources/src-x/test', {}], ['PUT', '/api/monitoring/sources/src-x', promBody()], ['DELETE', '/api/monitoring/sources/src-x'], ['POST', '/api/monitoring/sources/src-x/rotate', {}]];
  for (const [m, p, b] of calls) assert.equal((await viewer.call(m, p, b)).status, 403, `${m} ${p}`);
  assert.equal((await viewer.call('GET', '/api/monitoring')).status, 200);
});

test('the catalog lists the kinds and says whether sources can be saved', async () => {
  const r = await admin.call('GET', '/api/monitoring/catalog');
  assert.deepEqual(r.body.kinds.map((k) => k.kind), ['kuma', 'grafana', 'prometheus', 'alertmanager', 'jsonpoll', 'webhook']);
  assert.equal(r.body.canEdit, true);
});

test('a source whose test fails is refused and nothing is saved; the password is never echoed', async () => {
  const r = await admin.call('POST', '/api/monitoring/sources', promBody({ password: 'WRONG-password' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'TEST_FAILED');
  assert.ok(!r.text.includes('WRONG-password') && !r.text.includes(PROM_PASS));
  assert.equal((await admin.call('GET', '/api/monitoring/sources')).body.sources.length, 0);
});

test('a link-local or malformed address is refused before anything is contacted', async () => {
  const meta = await admin.call('POST', '/api/monitoring/sources', promBody({ url: 'http://169.254.169.254/latest' }));
  assert.equal(meta.status, 403, 'cloud-metadata addresses are refused by the shared destination guard');
  assert.equal((await admin.call('GET', '/api/monitoring/sources')).body.sources.length, 0);
  assert.equal((await admin.call('POST', '/api/monitoring/sources', promBody({ url: 'ftp://x.lan' }))).status, 400);
  assert.equal((await admin.call('POST', '/api/monitoring/sources', promBody({ url: '' }))).status, 400);
});

test('a good source is saved, shown without its secret, and its alerts reach the merged list under its own name', async () => {
  const r = await admin.call('POST', '/api/monitoring/sources', promBody());
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.test.message, /1 alert\(s\) firing/);
  promId = r.body.id;
  const list = await admin.call('GET', '/api/monitoring/sources');
  assert.equal(list.body.sources.length, 1);
  assert.deepEqual(list.body.sources[0].secretsSet, ['password']);
  assert.ok(!list.text.includes(PROM_PASS), 'no secret value in the list');
  const m = await until(async () => { const x = (await viewer.call('GET', '/api/monitoring')).body; return x.alerts.some((a) => a.name === 'DiskFull') ? x : null; });
  assert.ok(m, 'the alert appears');
  assert.equal(m.sources.find((s) => s.id === promId).label, 'Prod Prometheus');
  assert.equal(m.sources.find((s) => s.id === promId).managed, 'ui');
});

test('an edit with a blank password keeps the saved one; a wrong new password is refused', async () => {
  assert.equal((await admin.call('PUT', `/api/monitoring/sources/${promId}`, promBody({ password: '', name: 'Renamed' }))).status, 200);
  assert.equal((await admin.call('POST', '/api/monitoring/sources/test', { ...promBody({ password: '' }), id: promId })).body.ok, true, 'test reuses the saved secret');
  const bad = await admin.call('PUT', `/api/monitoring/sources/${promId}`, promBody({ password: 'nope' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'TEST_FAILED');
  assert.equal((await admin.call('GET', '/api/monitoring/sources')).body.sources[0].name, 'Renamed');
});

test('force saves a source that cannot be reached yet, and it shows as unreachable', async () => {
  const body = promBody({ name: 'Down one', url: 'http://127.0.0.1:1' });
  assert.equal((await admin.call('POST', '/api/monitoring/sources', body)).status, 400);
  const r = await admin.call('POST', '/api/monitoring/sources', { ...body, force: true });
  assert.equal(r.status, 201);
  const m = await until(async () => { const x = (await admin.call('GET', '/api/monitoring')).body; const s = x.sources.find((y) => y.id === r.body.id); return s && !s.ok ? s : null; });
  assert.ok(m && /Cannot reach/.test(m.error));
  assert.equal((await admin.call('DELETE', `/api/monitoring/sources/${r.body.id}`)).status, 200);
});

test('a webhook source: the secret is shown once, never listed, and rotating invalidates the old one', async () => {
  const r = await admin.call('POST', '/api/monitoring/sources', { kind: 'webhook', name: 'Alertmanager' });
  assert.equal(r.status, 201);
  hookId = r.body.id; hookSecret = r.body.secret;
  assert.ok(hookSecret && r.body.hookPath === `/hooks/monitoring/${hookId}`);
  const list = await admin.call('GET', '/api/monitoring/sources');
  assert.ok(!list.text.includes(hookSecret));
  assert.equal(list.body.sources.find((s) => s.id === hookId).hookPath, `/hooks/monitoring/${hookId}`);
  const post = (secret) => fetch(`${base}/hooks/monitoring/${hookId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ name: 'x', status: 'up' }) });
  assert.equal((await post(hookSecret)).status, 200);
  const rot = await admin.call('POST', `/api/monitoring/sources/${hookId}/rotate`, {});
  assert.notEqual(rot.body.secret, hookSecret);
  assert.equal((await post(hookSecret)).status, 401);
  assert.equal((await post(rot.body.secret)).status, 200);
  assert.equal((await admin.call('POST', `/api/monitoring/sources/${promId}/rotate`, {})).status, 404, 'only webhook sources rotate');
});

test('only one Uptime Kuma and one Grafana source can be connected', async () => {
  const body = { kind: 'kuma', name: 'Kuma', url: 'http://127.0.0.1:1', api_key: 'k', force: true };
  assert.equal((await admin.call('POST', '/api/monitoring/sources', body)).status, 201);
  const again = await admin.call('POST', '/api/monitoring/sources', body);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /Only one Uptime Kuma/);
});

test('deleting a source removes it from the list and the merged view', async () => {
  assert.equal((await admin.call('DELETE', `/api/monitoring/sources/${promId}`)).status, 200);
  assert.equal((await admin.call('DELETE', `/api/monitoring/sources/${promId}`)).status, 404);
  const gone = await until(async () => { const x = (await admin.call('GET', '/api/monitoring')).body; return !x.sources.some((s) => s.id === promId) && !x.alerts.some((a) => a.name === 'DiskFull') ? x : null; });
  assert.ok(gone);
});

test('the audit trail names what changed and never contains a secret; the log has none either', async () => {
  const ev = (await admin.call('GET', '/api/logs/events?source=app&limit=100')).body.map((e) => e.message).join('\n');
  assert.match(ev, /connected the monitoring source "Prod Prometheus" \(prometheus\)/);
  assert.match(ev, /removed the monitoring source/);
  for (const secret of [PROM_PASS, hookSecret, 'WRONG-password']) { assert.ok(!ev.includes(secret)); assert.ok(!log.includes(secret)); }
});

test('the generated API reference lists the new routes with the right roles', async () => {
  const doc = (await admin.call('GET', '/api/admin/openapi.json')).body;
  assert.equal(doc.paths['/api/monitoring'].get['x-required-role'], 'viewer');
  assert.equal(doc.paths['/api/monitoring/sources'].get['x-required-role'], 'admin');
  assert.equal(doc.paths['/api/monitoring/sources'].post['x-required-role'], 'admin');
  assert.equal(doc.paths['/api/monitoring/sources/{id}'].delete['x-required-role'], 'admin');
  assert.equal(doc.paths['/hooks/monitoring/{sourceId}'], undefined, 'the webhook is not an /api route');
});
