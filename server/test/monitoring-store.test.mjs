import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let dir, db, st;
const input = (over = {}) => ({ kind: 'prometheus', name: 'Prom', config: { url: 'http://prom.lan:9090', username: 'ops' }, secrets: { password: 'hunter2-hunter2', bearer_token: '' }, enabled: true, intervalS: 60, ttlHours: 168, ...over });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hd-monstore-'));
  Object.assign(process.env, { DB_PATH: join(dir, 's.db'), SECRETS_KEY: 'k'.repeat(40) });
  db = await import('../build/db.js');
  db.connectDb();
  st = await import('../build/monitoring/store.js');
});
after(() => { try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('a pull source round-trips with its secrets sealed in the database', () => {
  const { id } = st.createSource(input(), 'admin');
  const raw = db.getDb().prepare('SELECT secret, config FROM monitoring_sources WHERE id = ?').get(id);
  assert.ok(!raw.secret.includes('hunter2'), 'secret column holds no plain value');
  assert.ok(!raw.config.includes('hunter2'), 'config column holds no secret');
  const s = st.getSource(id);
  assert.equal(s.secrets.password, 'hunter2-hunter2');
  assert.equal(s.config.url, 'http://prom.lan:9090');
  assert.deepEqual(s.secretsSet, ['password']);
});

test('listing never returns secret values, only which ones are set', () => {
  const v = st.listSources().find((x) => x.name === 'Prom');
  assert.ok(v);
  assert.equal(v.secrets, undefined);
  assert.ok(!JSON.stringify(v).includes('hunter2'));
  assert.deepEqual(v.secretsSet, ['password']);
});

test('only the secret fields the kind declares are stored', () => {
  const { id } = st.createSource(input({ name: 'Extra', secrets: { password: 'p1', stray: 'nope' } }), 'admin');
  assert.equal(st.getSource(id).secrets.stray, undefined);
});

test('an edit with a blank secret keeps the old one; a new value replaces it', () => {
  const { id } = st.createSource(input({ name: 'Edit' }), 'admin');
  assert.ok(st.updateSource(id, { name: 'Edited', config: { url: 'http://prom.lan:9091' }, secrets: { password: '' }, enabled: false, intervalS: 30, ttlHours: 24 }));
  let s = st.getSource(id);
  assert.deepEqual([s.name, s.enabled, s.intervalS, s.config.url, s.secrets.password], ['Edited', false, 30, 'http://prom.lan:9091', 'hunter2-hunter2']);
  st.updateSource(id, { name: 'Edited', config: s.config, secrets: { password: 'second-password' }, enabled: true, intervalS: 30, ttlHours: 24 });
  assert.equal(st.getSource(id).secrets.password, 'second-password');
  assert.equal(st.updateSource('src-nothere', { name: 'x', config: {}, secrets: {}, enabled: true, intervalS: 60, ttlHours: 1 }), false);
});

test('a webhook source stores only the hash of its secret, shown once', () => {
  const { id, hookSecret } = st.createSource({ kind: 'webhook', name: 'Hook', config: {}, secrets: {}, enabled: true, intervalS: 60, ttlHours: 168 }, 'admin');
  assert.ok(hookSecret && hookSecret.length >= 43);
  const raw = db.getDb().prepare('SELECT secret FROM monitoring_sources WHERE id = ?').get(id).secret;
  assert.equal(raw, st.sha256(hookSecret));
  assert.ok(!raw.includes(hookSecret));
  assert.deepEqual(st.getSource(id).secretsSet, []);
});

test('the receiver check accepts the right token and treats everything else the same', () => {
  const { id, hookSecret } = st.createSource({ kind: 'webhook', name: 'Hook2', config: {}, secrets: {}, enabled: true, intervalS: 60, ttlHours: 168 }, 'admin');
  assert.equal(st.verifyHookToken(id, hookSecret)?.id, id);
  assert.equal(st.verifyHookToken(id, hookSecret + 'x'), null);
  assert.equal(st.verifyHookToken(id, ''), null);
  assert.equal(st.verifyHookToken('src-unknown', hookSecret), null);
  st.updateSource(id, { name: 'Hook2', config: {}, secrets: {}, enabled: false, intervalS: 60, ttlHours: 168 });
  assert.equal(st.verifyHookToken(id, hookSecret), null, 'a disabled source refuses even the right token');
  const pull = st.createSource(input({ name: 'NotHook' }), 'admin').id;
  assert.equal(st.verifyHookToken(pull, 'anything'), null, 'only webhook sources have receivers');
});

test('rotating issues a new secret and the old one stops working', () => {
  const { id, hookSecret } = st.createSource({ kind: 'webhook', name: 'Hook3', config: {}, secrets: {}, enabled: true, intervalS: 60, ttlHours: 168 }, 'admin');
  const next = st.rotateHookSecret(id);
  assert.notEqual(next, hookSecret);
  assert.equal(st.verifyHookToken(id, hookSecret), null);
  assert.equal(st.verifyHookToken(id, next)?.id, id);
  assert.equal(st.rotateHookSecret('src-unknown'), undefined);
});

test('pushed state keeps its first-seen time, honours the TTL and goes away with its source', () => {
  const { id } = st.createSource({ kind: 'webhook', name: 'State', config: {}, secrets: {}, enabled: true, intervalS: 60, ttlHours: 1 }, 'admin');
  const row = { sourceId: id, key: 'k1', type: 'alert', name: 'Disk', status: 'firing', level: 'error', detail: 'root 93%', url: null };
  st.upsertHookState(row, 1_000_000);
  st.upsertHookState({ ...row, detail: 'root 94%' }, 2_000_000);
  const [r] = st.readHookState(id, 1, 2_000_000);
  assert.deepEqual([r.since, r.lastSeen, r.detail], [1_000_000, 2_000_000, 'root 94%']);
  assert.equal(st.readHookState(id, 1, 2_000_000 + 3_600_001).length, 0, 'older than the TTL is hidden at read time');
  assert.equal(st.newestHookSeen(id), 2_000_000);
  db.purgeHookState(2_000_000 + 3_600_001);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM monitoring_hook_state WHERE source_id = ?').get(id).n, 0, 'the hourly purge removes it');
  st.upsertHookState(row);
  assert.ok(st.deleteHookState(id, 'k1'));
  st.upsertHookState(row);
  assert.ok(st.deleteSource(id));
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM monitoring_hook_state WHERE source_id = ?').get(id).n, 0);
});

test('a source sealed with another key is skipped, not fatal', () => {
  const { id } = st.createSource(input({ name: 'OtherKey' }), 'admin');
  const before = st.loadSources().length;
  process.env.SECRETS_KEY = 'z'.repeat(40);
  const warned = [];
  const loaded = st.loadSources((m) => warned.push(m));
  process.env.SECRETS_KEY = 'k'.repeat(40);
  assert.ok(warned.some((m) => /OtherKey/.test(m)));
  assert.ok(loaded.length < before);
  assert.ok(st.getSource(id), 'readable again with the right key');
});

test('without a sealing key a pull source cannot be saved, with a clear error', () => {
  const key = process.env.SECRETS_KEY;
  delete process.env.SECRETS_KEY; delete process.env.DATASOURCE_KEY; delete process.env.MFA_KEY;
  assert.throws(() => st.createSource(input({ name: 'NoKey' }), 'admin'), (e) => e.code === 'NO_SECRET_KEY');
  process.env.SECRETS_KEY = key;
});
