// Per-person popularity: the maths in-process (fake clock), the privacy and role rules against the real server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The in-process database must be chosen before any build module is imported (config reads DB_PATH once).
const dir = mkdtempSync(join(tmpdir(), 'hd-usage-'));
Object.assign(process.env, { DB_PATH: join(dir, 'unit.db') });
const db = await import('../build/db.js');
db.connectDb();
const u = await import('../build/usage.js');
const DAY = 86_400_000;

after(() => { try { db.closeDb(); } catch { /* ignore */ } });

test('the score halves every 30 days and never grows backwards in time', () => {
  assert.equal(u.decay(8, 0, 30 * DAY), 4);
  assert.equal(u.decay(8, 0, 60 * DAY), 2);
  assert.equal(u.decay(5, 1000, 1000), 5);
  assert.equal(u.decay(5, 1000, 0), 5, 'a clock that went backwards does not inflate it');
});

test('each use adds one to the decayed score; reloads within 30 s are ignored', () => {
  const t = 10 * DAY;
  assert.equal(u.bump('ann', 'page:guests', t), true);
  assert.equal(u.bump('ann', 'page:guests', t + 29_000), false, 'under 30 s: ignored');
  assert.equal(u.bump('ann', 'page:guests', t + 30_000), true);
  assert.equal(u.top('ann', 5, t + 30_000)[0].score, 2);
  assert.equal(u.bump('ann', 'page:guests', t + DAY), true);
  const expect = Math.round((u.decay(2, t + 30_000, t + DAY) + 1) * 100) / 100;
  assert.equal(u.top('ann', 5, t + DAY)[0].score, expect);
});

test('ranking follows use; a single old visit fades away', () => {
  const t = 100 * DAY;
  for (let i = 0; i < 5; i++) u.bump('bob', 'page:logs', t + i * 60_000);
  for (let i = 0; i < 2; i++) u.bump('bob', 'tile:ui-1', t + i * 60_000);
  u.bump('bob', 'page:nginx', t - 70 * DAY);
  const list = u.top('bob', 10, t + 5 * 60_000);
  assert.deepEqual(list.map((x) => x.item), ['page:logs', 'tile:ui-1'], 'the visit 70 days ago is gone, order is by score');
  assert.equal(u.top('bob', 1, t + 5 * 60_000).length, 1, 'the limit is honoured');
});

test('at most 200 items are kept per person, dropping the weakest', () => {
  const t = 200 * DAY;
  for (let i = 0; i < 205; i++) u.bump('cy', `page:p${i}`, t + i * 40_000);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM user_usage WHERE user = ?').get('cy').n, 200);
  u.bump('cy', 'page:p204', t + 205 * 40_000 + 31_000);
  assert.equal(u.top('cy', 1, t + 205 * 40_000 + 31_000)[0].item, 'page:p204');
});

test('people are separate, and a reset clears only the caller', () => {
  const t = 300 * DAY;
  u.bump('dee', 'page:health', t); u.bump('eve', 'page:health', t);
  assert.equal(u.reset('dee'), 1);
  assert.deepEqual(u.top('dee', 5, t), []);
  assert.equal(u.top('eve', 5, t).length, 1);
});

test('only known kinds of item with safe ids are accepted', () => {
  for (const ok of ['page:guests', 'tile:ui-1a2b', 'kind:webhook', 'page:gpu', 'tile:yaml_1.x']) assert.ok(u.ITEM_RE.test(ok), ok);
  for (const bad of ['', 'page:', 'page:Guests', 'page:../x', 'http://x', 'user:admin', 'page:a b', `tile:${'a'.repeat(70)}`, 'page:x\n', 'source:1']) assert.ok(!u.ITEM_RE.test(bad), JSON.stringify(bad));
});

// ---- over HTTP ----
const NODE = ['--disable-warning=ExperimentalWarning'];
const PW = 'correct-horse-battery';
let srv, base, admin, viewer, other;

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
  const port = 39500 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 'http.db'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent', PVE_NODE: 'pve' };
  for (const [name, role] of [['admin', 'admin'], ['viewer1', 'viewer'], ['other', 'viewer']]) {
    const r = spawnSync('node', [...NODE, 'build/create-user.js', name, role], { env: { ...env, NEW_PASSWORD: PW }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn('node', [...NODE, 'build/index.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/passkey/config`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  admin = await client().login('admin'); viewer = await client().login('viewer1'); other = await client().login('other');
});
after(() => { srv?.kill(); setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }, 300); });

test('every role can count its own use; the same item twice in a row is counted once', async () => {
  assert.deepEqual((await viewer.call('POST', '/api/usage', { item: 'page:logs' })).body, { counted: true });
  assert.deepEqual((await viewer.call('POST', '/api/usage', { item: 'page:logs' })).body, { counted: false });
  assert.deepEqual((await admin.call('POST', '/api/usage', { item: 'page:guests' })).body, { counted: true });
});

test('invalid items are refused', async () => {
  for (const item of ['page:../x', 'http://evil', 'page:A', '', 5, null, undefined]) assert.equal((await viewer.call('POST', '/api/usage', { item })).status, 400, JSON.stringify(item));
  assert.equal((await viewer.call('POST', '/api/usage', {})).status, 400);
});

test('a person sees only their own list: nobody else can read it, administrators included', async () => {
  const mine = (await viewer.call('GET', '/api/usage/top')).body.items;
  assert.deepEqual(mine.map((x) => x.item), ['page:logs']);
  assert.deepEqual((await admin.call('GET', '/api/usage/top')).body.items.map((x) => x.item), ['page:guests']);
  assert.deepEqual((await other.call('GET', '/api/usage/top')).body.items, []);
  for (const path of ['/api/usage/viewer1', '/api/usage/top?user=viewer1', '/api/usage?user=viewer1']) {
    const r = await admin.call('GET', path);
    assert.ok(!r.text.includes('page:logs'), `${path} must not reveal another person's use`);
  }
});

test('clearing history removes only the caller\'s own', async () => {
  await other.call('POST', '/api/usage', { item: 'page:health' });
  assert.deepEqual((await viewer.call('DELETE', '/api/usage')).body, { removed: 1 });
  assert.deepEqual((await viewer.call('GET', '/api/usage/top')).body.items, []);
  assert.equal((await other.call('GET', '/api/usage/top')).body.items.length, 1, 'someone else\'s list is untouched');
});

test('signed-out requests are refused, and the limit is clamped', async () => {
  assert.equal((await fetch(`${base}/api/usage/top`)).status, 401);
  assert.equal((await other.call('GET', '/api/usage/top?limit=9999')).status, 200);
  assert.equal((await other.call('GET', '/api/usage/top?limit=abc')).status, 200);
});

test('the API reference lists the routes as viewer-level', async () => {
  const doc = (await admin.call('GET', '/api/admin/openapi.json')).body;
  assert.equal(doc.paths['/api/usage'].post['x-required-role'], 'viewer');
  assert.equal(doc.paths['/api/usage'].delete['x-required-role'], 'viewer');
  assert.equal(doc.paths['/api/usage/top'].get['x-required-role'], 'viewer');
});
