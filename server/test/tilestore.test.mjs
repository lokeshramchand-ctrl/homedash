import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const web = createServer((req, res) => {
  if (req.url.startsWith('/api/v3/') && req.headers['x-api-key'] !== 'GOOD') { res.writeHead(401); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/api/v3/system/status' ? { version: '4.1' } : req.url === '/api/v3/health' ? [] : { totalRecords: 0 }));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'hd-tilestore-'));
Object.assign(process.env, { DB_PATH: join(dir, 'ts.db'), PVE_NODE: 'pve', SECRETS_KEY: 'k'.repeat(40) });
const db = await import('../build/db.js'); db.connectDb();
const { seal, unseal } = await import('../build/seal.js');
const tiles = await import('../build/tiles.js');
const store = await import('../build/tilestore.js');
const Fastify = (await import('fastify')).default;
const app = Fastify();
app.setErrorHandler((e, _q, r) => r.code(e.status ?? e.statusCode ?? 500).send({ error: e.message, code: e.code }));
app.addHook('onRequest', (req, _r, done) => { req.user = { username: 'root' }; done(); });
tiles.registerTiles(app); tiles.startTiles({ log: { warn() {} } }); await app.ready();
after(async () => { await app.close(); web.close(); try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
const post = (url, payload, method = 'POST') => app.inject({ method, url, payload });

test('sealing round-trips, is bound to the record, and detects tampering or a wrong key', () => {
  const blob = seal('secret-key-0123456789', 'row-1', { token: 't' });
  assert.deepEqual(unseal('secret-key-0123456789', 'row-1', blob), { token: 't' });
  assert.throws(() => unseal('secret-key-0123456789', 'row-2', blob));
  assert.throws(() => unseal('another-key-0123456789', 'row-1', blob));
  const b = Buffer.from(blob, 'base64'); b[b.length - 1] ^= 1;
  assert.throws(() => unseal('secret-key-0123456789', 'row-1', b.toString('base64')));
});

test('the form is validated: kind, address, required credentials, link-local addresses', async () => {
  const bad = async (body, re) => { const r = await post('/api/admin/tiles', body); assert.equal(r.statusCode >= 400 && r.statusCode < 500, true, JSON.stringify(body)); assert.match(r.json().error, re); };
  await bad({ kind: 'nope', url: base }, /Pick a kind/);
  await bad({ kind: 'sonarr', url: 'ftp://x' }, /must start with http/);
  await bad({ kind: 'sonarr', url: base }, /needs: token/);
  await bad({ kind: 'nut', url: base, ups: 'ups' }, /tcp:\/\/host:3493/);
  await bad({ kind: 'sonarr', url: 'http://169.254.169.254', token: 'x' }, /link-local/);
});

test('test, add, list without secrets, poll, edit keeping the secret, delete', async () => {
  const wrong = (await post('/api/admin/tiles/test', { kind: 'sonarr', url: base, token: 'BAD' })).json();
  assert.equal(wrong.state, 'down'); assert.match(wrong.error, /sign-in rejected/);
  const good = (await post('/api/admin/tiles/test', { kind: 'sonarr', url: base, token: 'GOOD' })).json();
  assert.equal(good.state, 'ok'); assert.equal(good.stats[0].value, '4.1');

  const added = (await post('/api/admin/tiles', { kind: 'sonarr', name: 'TV', url: base, token: 'GOOD', group: 'Media' })).json();
  assert.match(added.id, /^ui-/);
  const admin = (await app.inject('/api/admin/tiles')).json();
  assert.equal(admin.ui.length, 1); assert.equal(admin.ui[0].hasToken, true); assert.ok(!JSON.stringify(admin).includes('GOOD'));
  // the secret is sealed at rest
  assert.ok(!db.getDb().prepare('SELECT secret, config FROM ui_tiles').all().some((r) => (r.secret + r.config).includes('GOOD')));

  await new Promise((r) => setTimeout(r, 300));
  const list = (await app.inject('/api/tiles')).json().find((t) => t.id === added.id);
  assert.equal(list.source, 'ui'); assert.equal(list.state, 'ok'); assert.equal(list.group, 'Media'); assert.ok(Array.isArray(list.history));
  assert.ok(!JSON.stringify(list).includes(base));

  const edited = await post(`/api/admin/tiles/${added.id}`, { name: 'TV shows', url: base, token: '', group: 'Media' }, 'PUT');
  assert.equal(edited.statusCode, 200);
  await new Promise((r) => setTimeout(r, 300));
  const after2 = (await app.inject('/api/tiles')).json().find((t) => t.id === added.id);
  assert.equal(after2.name, 'TV shows'); assert.equal(after2.state, 'ok', 'a blank token field keeps the stored one');

  assert.equal((await post('/api/admin/tiles/ui-nope', {}, 'PUT')).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/tiles/${added.id}` })).statusCode, 200);
  assert.equal((await app.inject('/api/tiles')).json().some((t) => t.id === added.id), false);
});

test('the catalogue is served with the editing flag', async () => {
  const c = (await app.inject('/api/tiles/catalog')).json();
  assert.equal(c.canEdit, true); assert.ok(c.kinds.some((k) => k.kind === 'sonarr' && k.needs.includes('token')));
});
