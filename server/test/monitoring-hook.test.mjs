// The inbound webhook, against the real server: auth, limits, the three payload shapes, log hygiene.
// Payload fixtures are adapted from the official docs (docs/research/monitoring-provider-formats.md), not captured from live tools.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const NODE = ['--disable-warning=ExperimentalWarning'];
const PW = 'correct-horse-battery';
// The temp database must be chosen before any build module is imported: config reads DB_PATH once, when it is first loaded.
const dir = mkdtempSync(join(tmpdir(), 'hd-hook-'));
Object.assign(process.env, { DB_PATH: join(dir, 'h.db'), SECRETS_KEY: 'k'.repeat(40) });
const { maskSecretInUrl, parseHookPayload, parseMappedPayload } = await import('../build/monitoring/hook.js');
let srv, base, hookId, secret, mappedId, mappedSecret, cookie = '', log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const hook = (body, headers = { authorization: `Bearer ${secret}` }, q = '') => post(`/hooks/monitoring/${hookId}${q}`, body, headers);
const merged = async () => (await fetch(`${base}/api/monitoring`, { headers: { cookie } })).json();
async function until(fn, ms = 25_000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(500); } return v; }

const amAlert = (fp, over = {}) => ({ status: 'firing', labels: { alertname: 'HighMemory', severity: 'warning', instance: fp }, annotations: { summary: `memory high on ${fp}` }, startsAt: '2026-11-26T10:00:00Z', endsAt: '0001-01-01T00:00:00Z', generatorURL: 'http://prom:9090/graph', fingerprint: fp, ...over });
const amBody = (alerts, status = 'firing') => ({ version: '4', groupKey: '{}:{alertname="HighMemory"}', truncatedAlerts: 0, status, receiver: 'homedash', groupLabels: {}, commonLabels: {}, commonAnnotations: {}, externalURL: 'http://am:9093', alerts });

before(async () => {
  const port = 39100 + Math.floor(Math.random() * 800);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 'h.db'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'info', MONITORING_POLL_MS: '1000', SECRETS_KEY: 'k'.repeat(40), PVE_NODE: 'pve' };
  const u = spawnSync('node', [...NODE, 'build/create-user.js', 'admin', 'admin'], { env: { ...env, NEW_PASSWORD: PW }, encoding: 'utf8' });
  assert.equal(u.status, 0, u.stderr);
  const db = await import('../build/db.js');
  const st = await import('../build/monitoring/store.js');
  db.connectDb();
  const made = st.createSource({ kind: 'webhook', name: 'Alertmanager', config: {}, secrets: {}, enabled: true, intervalS: 60, ttlHours: 168 }, 'admin');
  hookId = made.id; secret = made.hookSecret;
  const mapped = st.createSource({ kind: 'webhook', name: 'Mapped tool', config: { items_path: 'events', name_path: 'service', status_path: 'state', status_map: 'good=up, bad=down', detail_path: 'msg', as: 'check' }, secrets: {}, enabled: true, intervalS: 60, ttlHours: 168 }, 'admin');
  mappedId = mapped.id; mappedSecret = mapped.hookSecret;
  db.closeDb();
  srv = spawn('node', [...NODE, 'build/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/passkey/config`); break; } catch { await sleep(100); } }
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'homedash' }, body: JSON.stringify({ username: 'admin', password: PW }) });
  assert.equal(r.status, 200);
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
});
after(() => { srv?.kill(); setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }, 300); });

// ---- pure parsing ----
test('Alertmanager items are read one by one, using each item\'s own status', () => {
  const p = parseHookPayload(amBody([amAlert('f1'), amAlert('f2', { status: 'resolved' })], 'firing'));
  assert.deepEqual(p.items.map((i) => [i.key, i.status, i.type, i.level, i.name]), [['f1', 'firing', 'alert', 'warn', 'HighMemory'], ['f2', 'resolved', 'alert', 'warn', 'HighMemory']]);
  assert.equal(p.items[0].detail, 'memory high on f1');
  assert.equal(p.items[0].url, 'http://prom:9090/graph');
  assert.equal(p.items[0].since, Date.parse('2026-11-26T10:00:00Z'));
});

test('a Grafana webhook (version 1, per-alert status, links) is understood, with or without an alerts list', () => {
  const g = parseHookPayload({ version: '1', status: 'firing', state: 'alerting', title: '[FIRING:1] Disk', message: 'details', orgId: 1, alerts: [{ status: 'firing', labels: { alertname: 'Disk', severity: 'critical' }, annotations: {}, startsAt: '2026-11-26T10:00:00Z', fingerprint: 'g1', dashboardURL: 'http://g/d/x', panelURL: 'javascript:x', silenceURL: 'http://g/s' }] });
  assert.deepEqual([g.items[0].key, g.items[0].level, g.items[0].url], ['g1', 'error', 'http://g/d/x']);
  const bare = parseHookPayload({ state: 'alerting', title: 'Backup late', message: 'm' });
  assert.deepEqual([bare.items[0].status, bare.items[0].name], ['firing', 'Backup late']);
  assert.equal(parseHookPayload({ state: 'ok', title: 'Backup late' }).items[0].status, 'resolved');
});

test('the plain shape: checks by default, alerts when a level or kind says so, lists allowed', () => {
  const p = parseHookPayload([{ name: 'backup', status: 'DOWN', message: 'failed at 02:00' }, { name: 'site', status: 'ok' }, { name: 'disk', status: 'firing', level: 'critical' }, { name: 'slow', status: 'warning' }, { name: 'bad' }, { name: 'odd', status: 'banana' }]);
  assert.deepEqual(p.items.map((i) => [i.name, i.type, i.status, i.level]), [['backup', 'check', 'down', 'error'], ['site', 'check', 'up', 'info'], ['disk', 'alert', 'firing', 'error'], ['slow', 'check', 'pending', 'warn']]);
  assert.equal(p.ignored, 2);
});

test('unknown shapes and empty results are clear errors; hostile text is capped and links restricted', () => {
  assert.match(parseHookPayload({ hello: 'world' }).error, /Unrecognised payload/);
  assert.match(parseHookPayload({ alerts: [] }).error, /Nothing in the payload/);
  const long = parseHookPayload({ name: 'x'.repeat(5000), status: 'down', message: 'm'.repeat(5000), url: 'javascript:alert(1)' }).items[0];
  assert.deepEqual([long.name.length, long.detail.length, long.url], [200, 300, null]);
  assert.equal(parseHookPayload(Array.from({ length: 500 }, (_, i) => ({ name: `n${i}`, status: 'down' }))).items.length, 200);
});

test('a token in a URL is hidden for the log', () => {
  assert.equal(maskSecretInUrl('/hooks/monitoring/src-1?token=abc123&x=1'), '/hooks/monitoring/src-1?token=***&x=1');
  assert.equal(maskSecretInUrl('/hooks/monitoring/src-1?a=1&Token=zzz'), '/hooks/monitoring/src-1?a=1&Token=***');
  assert.equal(maskSecretInUrl('/api/x'), '/api/x');
});

test('any JSON can be mapped: checks by status word, alerts that clear, a single object, and unreadable payloads', () => {
  const chk = parseMappedPayload({ events: [{ service: 'db', state: 'bad', msg: 'no route' }, { service: 'web', state: 'good' }, { service: 'x', state: 'weird' }, { state: 'bad' }] }, { items_path: 'events', name_path: 'service', status_path: 'state', status_map: 'good=up, bad=down', detail_path: 'msg' });
  assert.deepEqual(chk.items.map((i) => [i.name, i.type, i.status, i.level, i.detail]), [['db', 'check', 'down', 'error', 'no route'], ['web', 'check', 'up', 'info', '']]);
  assert.equal(chk.ignored, 2, 'an unknown status word and a nameless item are ignored');
  const al = parseMappedPayload({ id: 'a1', title: 'Disk', sev: 'critical', phase: 'open' }, { name_path: 'title', key_path: 'id', status_path: 'phase', alert_values: 'open, firing', level_path: 'sev', as: 'alert' });
  assert.deepEqual([al.items[0].key, al.items[0].status, al.items[0].level], ['a1', 'firing', 'error']);
  assert.equal(parseMappedPayload({ id: 'a1', title: 'Disk', phase: 'closed' }, { name_path: 'title', key_path: 'id', status_path: 'phase', alert_values: 'open', as: 'alert' }).items[0].status, 'resolved');
  assert.match(parseMappedPayload({ a: 1 }, { items_path: 'events', name_path: 'n' }).error, /does not lead to a list/);
  assert.match(parseMappedPayload({ events: [{ n: 'x', s: 'zzz' }] }, { items_path: 'events', name_path: 'n', status_path: 's' }).error, /Nothing in what was sent/);
});

// ---- over HTTP ----
test('a bearer token works; the state shows up in the merged list as a down check', async () => {
  const r = await hook({ name: 'nightly-backup', status: 'down', message: 'exit code 2' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { accepted: 1, ignored: 0 });
  const m = await until(async () => { const x = await merged(); return x.checks.find((c) => c.name === 'nightly-backup') ? x : null; });
  const c = m.checks.find((x) => x.name === 'nightly-backup');
  assert.deepEqual([c.status, c.detail, c.source], ['down', 'exit code 2', hookId]);
  assert.equal(m.sources.find((s) => s.id === hookId).label, 'Alertmanager');
});

test('the query-string token works too, and text/plain bodies are read as JSON here', async () => {
  const r = await post(`/hooks/monitoring/${hookId}?token=${encodeURIComponent(secret)}`, JSON.stringify({ name: 'cron-job', status: 'up' }), { 'content-type': 'text/plain' });
  assert.equal(r.status, 200);
});

test('the webhook JSON-from-text/plain tolerance does not spread: the login route still refuses a text/plain body', async () => {
  const r = await post('/api/auth/login', JSON.stringify({ username: 'admin', password: PW }), { 'content-type': 'text/plain', 'x-requested-with': 'homedash' });
  assert.notEqual(r.status, 200, 'a text/plain body must not sign anyone in');
  assert.equal(r.status, 400);
});

test('Alertmanager alerts become alerts; resolving one removes only that one; repeating keeps the first start time', async () => {
  assert.equal((await hook(amBody([amAlert('fa'), amAlert('fb')]))).status, 200);
  let m = await until(async () => { const x = await merged(); return x.alerts.filter((a) => a.source === hookId).length === 2 ? x : null; });
  assert.ok(m, 'both alerts listed: ' + JSON.stringify(await merged()).slice(0, 700));
  const first = m.alerts.find((a) => a.key === 'fa').since;
  await hook(amBody([amAlert('fa', { startsAt: '2026-11-27T10:00:00Z' })]));
  await hook(amBody([amAlert('fb', { status: 'resolved' })], 'firing'));
  m = await until(async () => { const x = await merged(); return x.alerts.filter((a) => a.source === hookId).length === 1 ? x : null; });
  assert.deepEqual(m.alerts.filter((a) => a.source === hookId).map((a) => a.key), ['fa']);
  assert.equal(m.alerts.find((a) => a.key === 'fa').since, first, 'a repeat does not move the start time');
});

test('bad requests: unknown shape and broken JSON are 400, an oversized body is 413', async () => {
  assert.equal((await hook({ hello: 'world' })).status, 400);
  assert.equal((await hook('{not json')).status, 400);
  assert.equal((await hook({ name: 'x', status: 'down', message: 'm'.repeat(70_000) })).status, 413);
});

test('a source with a mapping reads a payload no built-in shape would understand', async () => {
  const send = (body, token = mappedSecret) => post(`/hooks/monitoring/${mappedId}`, body, { authorization: `Bearer ${token}` });
  assert.equal((await send({ events: [{ service: 'billing-api', state: 'bad', msg: 'queue stuck' }] })).status, 200);
  const m = await until(async () => { const x = await merged(); return x.checks.find((c) => c.name === 'billing-api') ? x : null; });
  const c = m.checks.find((x) => x.name === 'billing-api');
  assert.deepEqual([c.status, c.detail, c.source], ['down', 'queue stuck', mappedId]);
  assert.equal((await send({ hello: 'world' })).status, 400, 'a payload that does not fit the mapping is a clear 400');
  assert.equal((await send({ events: [] }, 'wrong')).status, 401);
});

// Keep the limiter tests last: they block this client address for a minute.
test('a missing, wrong, or unknown credential gets the same answer, and nothing is recorded', async () => {
  const a = await hook({ name: 'evil', status: 'down' }, {});
  const b = await hook({ name: 'evil', status: 'down' }, { authorization: 'Bearer wrong-secret' });
  const c = await post('/hooks/monitoring/src-doesnotexist', { name: 'evil', status: 'down' }, { authorization: `Bearer ${secret}` });
  const d = await hook({ name: 'evil', status: 'down' }, {}, '?token=nope');
  const bodies = await Promise.all([a, b, c, d].map(async (r) => [r.status, await r.text()]));
  for (const x of bodies) assert.deepEqual(x, [401, '{"error":"Unauthorized"}']);
  await sleep(1500);
  assert.ok(!(await merged()).checks.some((x) => x.name === 'evil'));
});

test('repeated failures are rate limited, and the secret never reached the log', async () => {
  let last = 0;
  for (let i = 0; i < 35; i++) last = (await hook({ name: 'x', status: 'down' }, { authorization: 'Bearer nope' })).status;
  assert.equal(last, 429);
  assert.ok(log.length > 0, 'the server logged requests');
  await post(`/hooks/monitoring/${hookId}?token=${encodeURIComponent(secret)}`, { name: 'a', status: 'up' });
  await sleep(300);
  assert.ok(!log.includes(secret), 'the receiver secret is not in the log');
  assert.ok(!log.includes('Bearer'), 'no authorization header in the log');
});
