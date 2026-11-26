import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'hd-prefs-'));
Object.assign(process.env, { DB_PATH: join(dir, 'p.db'), PVE_NODE: 'pve' });
const db = await import('../build/db.js'); db.connectDb();
const { registerPrefs } = await import('../build/prefs.js');
const { requiredRole } = await import('../build/roles.js');
const Fastify = (await import('fastify')).default;
let who = 'alice';
const app = Fastify();
app.setErrorHandler((e, _q, r) => r.code(e.status ?? e.statusCode ?? 500).send({ error: e.message }));
app.addHook('onRequest', (req, _r, done) => { req.user = { username: who }; done(); });
registerPrefs(app); await app.ready();
after(async () => { await app.close(); try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('preferences are per user, per key, and limited', async () => {
  assert.deepEqual((await app.inject('/api/prefs/tiles')).json(), { value: null });
  await app.inject({ method: 'PUT', url: '/api/prefs/tiles', payload: { value: { order: ['a', 'b'], fav: ['a'] } } });
  assert.deepEqual((await app.inject('/api/prefs/tiles')).json().value.order, ['a', 'b']);
  who = 'bob';
  assert.deepEqual((await app.inject('/api/prefs/tiles')).json(), { value: null }, 'another user does not see it');
  assert.equal((await app.inject('/api/prefs/secrets')).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/prefs/theme', payload: { value: 'x'.repeat(9000) } })).statusCode, 413);
});

test('every role may save its own layout', () => {
  assert.equal(requiredRole('PUT', '/api/prefs/tiles'), 'viewer');
  assert.equal(requiredRole('PUT', '/api/admin/tiles/x'), 'admin');
});
