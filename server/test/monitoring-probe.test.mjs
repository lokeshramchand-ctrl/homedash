// Service checks against local servers: a web server, an open and a closed port, and a TLS server whose certificate is about to expire.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { createServer as createTls } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { certState, parseTargets, probeProvider } from '../build/monitoring/providers/probe.js';

const src = (targets) => ({ id: 'src-p', kind: 'probe', name: 'Checks', config: { targets }, secrets: {}, secretsSet: [], enabled: true, intervalS: 30, ttlHours: 168, createdAt: 1, createdBy: 'a' });

test('lines are parsed into checks; comments and blanks are skipped', () => {
  const t = parseTargets('# my homelab\nNAS | tcp | 192.168.1.5:445\n\nSite | http | https://example.lan/health\nCert | tls | example.lan\r\nCert2 | TLS | [::1]:8443\n');
  assert.deepEqual(t.map((x) => [x.name, x.type, x.address]), [['NAS', 'tcp', '192.168.1.5:445'], ['Site', 'http', 'https://example.lan/health'], ['Cert', 'tls', 'example.lan'], ['Cert2', 'tls', '[::1]:8443']]);
});

test('a bad line is refused with a message that names it', () => {
  assert.throws(() => parseTargets('just one thing'), /should look like: name \| type \| address/);
  assert.throws(() => parseTargets('x | ping | 1.1.1.1'), /not a type/);
  assert.throws(() => parseTargets('x | http | example.lan'), /not a web address/);
  assert.throws(() => parseTargets('x | tcp | host'), /needs a port/);
  assert.throws(() => parseTargets('x | tcp | bad host:22'), /not a host/);
  assert.throws(() => parseTargets(Array.from({ length: 51 }, (_, i) => `n${i} | tcp | h:${i + 1}`).join('\n')), /At most 50/);
  assert.deepEqual(parseTargets(''), []);
});

test('a certificate with 14 days or more is fine, under 14 is a warning, expired is down', () => {
  assert.deepEqual(certState(90), { status: 'up', detail: 'Certificate expires in 90 days' });
  assert.deepEqual(certState(14), { status: 'up', detail: 'Certificate expires in 14 days' });
  assert.deepEqual(certState(13.5), { status: 'pending', detail: 'Certificate expires in 13 days' });
  assert.deepEqual(certState(1.2), { status: 'pending', detail: 'Certificate expires in 1 day' });
  assert.deepEqual(certState(0), { status: 'down', detail: 'The certificate has expired' });
  assert.deepEqual(certState(-3), { status: 'down', detail: 'The certificate has expired' });
});

let web, openPort, tls, dir, closedPort;
before(async () => {
  web = createHttp((req, res) => { res.statusCode = req.url === '/bad' ? 500 : 200; res.end('ok'); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const tcp = createTcp((s) => s.end()); await new Promise((r) => tcp.listen(0, '127.0.0.1', r)); openPort = tcp.address().port; web.tcp = tcp;
  const tmp = createTcp(); await new Promise((r) => tmp.listen(0, '127.0.0.1', r)); closedPort = tmp.address().port; await new Promise((r) => tmp.close(r));
  dir = mkdtempSync(join(tmpdir(), 'hd-probe-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '3', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    tls = createTls({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (s) => s.end());
    await new Promise((r) => tls.listen(0, '127.0.0.1', r));
  } catch { tls = null; }
});
after(() => { web?.close(); web?.tcp?.close(); tls?.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('http, tcp and a closed port are probed for real', async () => {
  const wp = web.address().port;
  const r = await probeProvider(src(`Web | http | http://127.0.0.1:${wp}/\nBroken | http | http://127.0.0.1:${wp}/bad\nOpen | tcp | 127.0.0.1:${openPort}\nClosed | tcp | 127.0.0.1:${closedPort}\nGone | http | http://127.0.0.1:${closedPort}/`)).poll();
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.deepEqual([by.Web.status, by.Broken.status, by.Open.status, by.Closed.status, by.Gone.status], ['up', 'down', 'up', 'down', 'down']);
  assert.match(by.Web.detail, /HTTP 200 in \d+ ms/);
  assert.equal(by.Broken.detail.startsWith('HTTP 500'), true);
  assert.match(by.Closed.detail, /Cannot connect to port \d+ \(ECONNREFUSED\)/);
  assert.match(by.Gone.detail, /Cannot reach the server/);
});

test('a certificate close to expiry is a warning, and an untrusted (self-signed) one is still read', async (t) => {
  if (!tls) return t.skip('openssl is not available');
  const r = await probeProvider(src(`Cert | tls | 127.0.0.1:${tls.address().port}`)).poll();
  assert.equal(r.checks[0].status, 'pending');
  assert.match(r.checks[0].detail, /Certificate expires in [23] days/);
});

test('cloud-metadata and link-local addresses are refused even when listed', async () => {
  const r = await probeProvider(src('Meta | http | http://169.254.169.254/latest\nLL | tcp | 169.254.1.1:80')).poll();
  assert.deepEqual(r.checks.map((c) => c.status), ['down', 'down']);
  assert.ok(r.checks.every((c) => /Not allowed/.test(c.detail)));
});

test('a source with a bad line fails as a whole, loudly, instead of silently skipping it', async () => {
  await assert.rejects(probeProvider(src('Fine | tcp | 127.0.0.1:1\nbroken line')).poll(), /should look like/);
});
