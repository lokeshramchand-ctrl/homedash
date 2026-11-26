// Service registry: dependency maths and health verdicts in-process, roles and persistence against the real server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cleanInput, dependencies, dependents, verdictFor, wouldCycle } from '../build/registry.js';

const E = (from, to) => ({ from, to, note: '' });
// app -> db -> vm -> node ; proxy -> app ; wiki -> db
const edges = [E('app', 'db'), E('db', 'vm'), E('vm', 'node'), E('proxy', 'app'), E('wiki', 'db')];

test('dependents are everything that would be hit, nearest first; dependencies are what a service needs', () => {
  assert.deepEqual(dependents('db', edges).map((x) => [x.id, x.depth]).sort(), [['app', 1], ['proxy', 2], ['wiki', 1]]);
  assert.deepEqual(dependents('node', edges).map((x) => x.id).sort(), ['app', 'db', 'proxy', 'vm', 'wiki']);
  assert.deepEqual(dependencies('proxy', edges).map((x) => [x.id, x.depth]), [['app', 1], ['db', 2], ['vm', 3], ['node', 4]]);
  assert.deepEqual(dependents('proxy', edges), []);
});

test('loops are detected, including a service depending on itself, and a diamond is not a loop', () => {
  assert.equal(wouldCycle('x', 'x', []), true);
  assert.equal(wouldCycle('node', 'proxy', edges), true);
  assert.equal(wouldCycle('proxy', 'node', edges), false);
  assert.equal(wouldCycle('wiki', 'vm', edges), false);
  const loop = [E('a', 'b'), E('b', 'a')];
  assert.equal(dependents('a', loop).length, 1, 'a loop that already exists still terminates');
});

const M = (over = {}) => ({
  sources: [{ id: 'src-1', kind: 'http', label: 'Checks', managed: 'ui', ok: true, stale: false, error: null, checkedAt: 5, checks: 2, alerts: 0 }, ...(over.sources ?? [])],
  checks: [{ source: 'src-1', key: 'a', name: 'A', status: 'down', since: null, detail: 'HTTP 500' }, { source: 'src-1', key: 'b', name: 'B', status: 'up', since: null, detail: '' }],
  alerts: [], checkedAt: 5,
});

test('missing data is never healthy: no link, a removed source, an unreadable source and a vanished check all say so', () => {
  assert.equal(verdictFor('', M()).health, 'unmonitored');
  assert.equal(verdictFor('src-9|a', M()).health, 'unknown');
  assert.equal(verdictFor('src-1|zzz', M()).health, 'unknown');
  const broken = M(); broken.sources[0].ok = false;
  const v = verdictFor('src-1|a', broken);
  assert.equal(v.health, 'stale');
  assert.match(v.detail, /last known: down/);
  assert.deepEqual([verdictFor('src-1|a', M()).health, verdictFor('src-1|b', M()).health], ['down', 'up']);
});

test('input is validated and trimmed', () => {
  const ok = cleanInput({ name: '  Wiki ', url: 'https://wiki.lan', port: '8080', tags: 'a, b,,c', criticality: 'high', meta: { k: 'v' } });
  assert.deepEqual([ok.name, ok.port, ok.tags, ok.criticality, ok.meta], ['Wiki', 8080, ['a', 'b', 'c'], 'high', { k: 'v' }]);
  for (const b of [{}, { name: 'x', url: 'javascript:alert(1)' }, { name: 'x', port: 70000 }, { name: 'x', port: 'abc' }, { name: 'x', criticality: 'urgent' }]) assert.throws(() => cleanInput(b), JSON.stringify(b));
  assert.equal(cleanInput({ criticality: 'low' }, { ...ok, name: 'Keep' }).name, 'Keep', 'an edit keeps what the form leaves out');
});

// ---- over HTTP ----
const NODE = ['--disable-warning=ExperimentalWarning'];
const PW = 'correct-horse-battery';
const dir = mkdtempSync(join(tmpdir(), 'hd-reg-'));
let srv, base, admin, viewer;
function client() {
  let cookie = '';
  return {
    async call(method, path, body) {
      const res = await fetch(base + path, { method, headers: { 'x-requested-with': 'homedash', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text };
    },
    async login(name) { const r = await this.call('POST', '/api/auth/login', { username: name, password: PW }); assert.equal(r.status, 200); return this; },
  };
}
before(async () => {
  const port = 39800 + Math.floor(Math.random() * 150);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 'http.db'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent', PVE_NODE: 'pve' };
  for (const [name, role] of [['admin', 'admin'], ['viewer1', 'viewer']]) {
    const r = spawnSync('node', [...NODE, 'build/create-user.js', name, role], { env: { ...env, NEW_PASSWORD: PW }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn('node', [...NODE, 'build/index.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/passkey/config`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  admin = await client().login('admin'); viewer = await client().login('viewer1');
});
after(() => { srv?.kill(); setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }, 300); });

let ids = {};
test('an administrator adds services; each starts as unmonitored, not healthy', async () => {
  for (const name of ['Postgres', 'Wiki', 'Proxy']) {
    const r = await admin.call('POST', '/api/admin/registry', { name, criticality: name === 'Postgres' ? 'critical' : 'normal' });
    assert.equal(r.status, 201, r.text); ids[name] = r.body.id;
  }
  assert.equal((await admin.call('POST', '/api/admin/registry', { name: 'postgres' })).status, 409, 'names are unique, ignoring case');
  const list = (await viewer.call('GET', '/api/registry')).body.services;
  assert.deepEqual(list.map((s) => [s.name, s.health]), [['Postgres', 'unmonitored'], ['Proxy', 'unmonitored'], ['Wiki', 'unmonitored']]);
});

test('viewers can read but not change, and signed-out requests are refused', async () => {
  assert.equal((await viewer.call('POST', '/api/admin/registry', { name: 'Nope' })).status, 403);
  assert.equal((await viewer.call('PUT', `/api/admin/registry/${ids.Wiki}`, { name: 'Hacked' })).status, 403);
  assert.equal((await viewer.call('DELETE', `/api/admin/registry/${ids.Wiki}`)).status, 403);
  assert.equal((await viewer.call('POST', `/api/admin/registry/${ids.Wiki}/deps`, { dependsOn: ids.Proxy })).status, 403);
  assert.equal((await fetch(`${base}/api/registry`)).status, 401);
  assert.equal((await viewer.call('GET', '/api/registry')).status, 200);
});

test('dependencies: recorded, listed, loops and duplicates refused, impact computed', async () => {
  assert.equal((await admin.call('POST', `/api/admin/registry/${ids.Wiki}/deps`, { dependsOn: ids.Postgres })).status, 201);
  assert.equal((await admin.call('POST', `/api/admin/registry/${ids.Proxy}/deps`, { dependsOn: ids.Wiki })).status, 201);
  assert.equal((await admin.call('POST', `/api/admin/registry/${ids.Wiki}/deps`, { dependsOn: ids.Postgres })).status, 409);
  assert.equal((await admin.call('POST', `/api/admin/registry/${ids.Postgres}/deps`, { dependsOn: ids.Proxy })).status, 400, 'a loop');
  assert.equal((await admin.call('POST', `/api/admin/registry/${ids.Wiki}/deps`, { dependsOn: ids.Wiki })).status, 400, 'itself');
  assert.equal((await admin.call('POST', `/api/admin/registry/${ids.Wiki}/deps`, { dependsOn: 'svc-nothing' })).status, 404);
  const impact = (await viewer.call('GET', `/api/registry/${ids.Postgres}/impact`)).body;
  assert.deepEqual(impact.wouldAffect.map((x) => [x.name, x.depth, x.health]), [['Wiki', 1, 'unmonitored'], ['Proxy', 2, 'unmonitored']]);
  assert.equal((await viewer.call('GET', '/api/registry/svc-nothing/impact')).status, 404);
  const pg = (await viewer.call('GET', '/api/registry')).body.services.find((s) => s.name === 'Postgres');
  assert.equal(pg.dependentCount, 2);
});

test('removing a dependency, editing, and deleting a service (which drops its edges)', async () => {
  assert.equal((await admin.call('PUT', `/api/admin/registry/${ids.Wiki}`, { description: 'Docs', port: 3000 })).status, 200);
  const wiki = (await viewer.call('GET', '/api/registry')).body.services.find((s) => s.name === 'Wiki');
  assert.deepEqual([wiki.name, wiki.description, wiki.port], ['Wiki', 'Docs', 3000]);
  assert.equal((await admin.call('PUT', `/api/admin/registry/${ids.Wiki}`, { port: 99999 })).status, 400);
  const d = await admin.call('DELETE', `/api/admin/registry/${ids.Wiki}`);
  assert.deepEqual(d.body, { ok: true, hadDependents: 1 });
  const left = (await viewer.call('GET', '/api/registry')).body;
  assert.deepEqual(left.edges, [], 'edges to and from the deleted service are gone');
  assert.equal((await admin.call('DELETE', `/api/admin/registry/${ids.Wiki}`)).status, 404);
  assert.equal((await admin.call('DELETE', `/api/admin/registry/${ids.Proxy}/deps/${ids.Postgres}`)).status, 404);
});

test('the checks a service can be linked to are listed for administrators only', async () => {
  assert.equal((await admin.call('GET', '/api/admin/registry/monitors')).status, 200);
  assert.equal((await viewer.call('GET', '/api/admin/registry/monitors')).status, 403);
});
