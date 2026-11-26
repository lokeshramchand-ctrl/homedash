import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const hooks = [];
const web = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hooks.push({ headers: req.headers, body: b }); res.end('{}'); }); });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const udp = createSocket('udp4');
const datagrams = [];
udp.on('message', (m) => datagrams.push(m.toString()));
await new Promise((r) => udp.bind(0, '127.0.0.1', r));
const dir = mkdtempSync(join(tmpdir(), 'hd-audit-'));
Object.assign(process.env, {
  DB_PATH: join(dir, 'a.db'), PVE_NODE: 'pve', AUDIT_FORMAT: 'cef', AUDIT_SYSLOG: `udp://127.0.0.1:${udp.address().port}`,
  AUDIT_WEBHOOK_URL: `http://127.0.0.1:${web.address().port}/h`, AUDIT_WEBHOOK_SECRET: 's3cret',
});
const db = await import('../build/db.js'); db.connectDb();
const { verifyRows, chainHash } = await import('../build/auditchain.js');
const { registerAuditLog, toCef, syslogFrame } = await import('../build/auditlog.js');
const Fastify = (await import('fastify')).default;
const app = Fastify(); registerAuditLog(app); await app.ready();
after(async () => { await app.close(); web.close(); udp.close(); try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const add = (n) => db.insertAudit({ ts: 1_700_000_000_000 + n, user: 'alice', ip: '10.0.0.1', vmid: 100 + n, name: `g${n}`, action: 'guest.stop', result: n === 2 ? 'refused' : 'accepted', reason: n === 1 ? 'a|b=c\nd' : undefined });

test('rows are hash-chained and verification passes', () => {
  for (let i = 0; i < 4; i++) add(i);
  const rows = db.auditRows();
  assert.equal(rows[0].prev_hash, ''); assert.equal(rows[1].prev_hash, rows[0].hash);
  assert.equal(rows[0].hash, chainHash('', rows[0]));
  const v = verifyRows(rows);
  assert.deepEqual([v.ok, v.checked, v.head], [true, 4, rows[3].hash]);
});

test('editing, deleting or reordering a row is detected', () => {
  const rows = db.auditRows().map((r) => ({ ...r }));
  const edited = rows.map((r) => ({ ...r })); edited[1].user = 'mallory';
  assert.deepEqual([verifyRows(edited).ok, verifyRows(edited).brokenAt], [false, rows[1].id]);
  const removed = rows.filter((_, i) => i !== 1);
  assert.equal(verifyRows(removed).ok, false); assert.equal(verifyRows(removed).brokenAt, rows[2].id);
  assert.equal(verifyRows([rows[0], rows[2], rows[1], rows[3]]).ok, false);
});

test('rows from before hashing are skipped; the chain starts at the first hashed row', () => {
  const rows = db.auditRows().map((r) => ({ ...r }));
  const legacy = [{ ...rows[0], id: 0, hash: null, prev_hash: null }, ...rows];
  assert.equal(verifyRows(legacy).ok, true);
});

test('CEF escapes separators and syslog frames are RFC 5424', () => {
  const r = db.auditRows()[1];
  const cef = toCef(r);
  assert.match(cef, /^CEF:0\|homedash\|homedash\|1\|guest\.stop\|guest\.stop\|3\|/);
  assert.match(cef, /msg=a\|b\\=c d/); assert.ok(!cef.includes('\n'));
  assert.match(syslogFrame(r, 'json', 'pve host'), /^<86>1 2023-11-14T22:13:20\.001Z pve-host homedash - AUDIT - \{/);
  assert.match(syslogFrame(db.auditRows()[2], 'cef'), /^<84>1 /); // refused = warning
});

test('new rows are pushed to syslog (CEF) and the webhook (signed JSON)', async () => {
  await sleep(300); datagrams.length = 0; hooks.length = 0;
  add(9);
  await sleep(300);
  assert.equal(datagrams.length, 1); assert.match(datagrams[0], /AUDIT - CEF:0\|homedash/);
  assert.equal(hooks.length, 1);
  const sig = `sha256=${createHmac('sha256', 's3cret').update(hooks[0].body).digest('hex')}`;
  assert.equal(hooks[0].headers['x-homedash-signature'], sig);
  assert.equal(JSON.parse(hooks[0].body).action, 'guest.stop');
});

test('verify and export endpoints', async () => {
  const v = (await app.inject('/api/admin/audit/verify')).json();
  assert.deepEqual([v.ok, v.checked], [true, 5]);
  const ex = await app.inject('/api/admin/audit/export?after=3&format=json');
  const lines = ex.body.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), [4, 5]); assert.equal(ex.headers['x-last-id'], '5');
  assert.equal((await app.inject('/api/admin/audit/export?format=xml')).statusCode, 400);
});
