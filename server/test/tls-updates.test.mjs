import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { after, test } from 'node:test';
import { Agent } from 'undici';

const dir = mkdtempSync(join(tmpdir(), 'hd-tls-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const { sanFor, ensureSelfSigned, daysLeft, tlsOptions } = await import('../build/tls.js');
const { isNewer, checkNow, versionState } = await import('../build/updates.js');
let haveOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); } catch { haveOpenssl = false; }

test('subjectAltName: names and addresses, junk dropped', () => {
  assert.equal(sanFor(['pve.lan', '10.0.0.5', 'bad name;x', 'pve.lan', '::1']), 'DNS:pve.lan,IP:10.0.0.5,IP:::1');
  assert.equal(sanFor(['"; rm -rf']), '');
});

test('self-signed: created once, valid, private key, reused until the names change', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const a = ensureSelfSigned(join(dir, 'tls'), ['homedash.lan', '127.0.0.1']);
  assert.equal(a.created, true);
  const x = new X509Certificate(readFileSync(a.cert));
  assert.match(x.subjectAltName, /DNS:homedash\.lan/); assert.match(x.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.ok(daysLeft(readFileSync(a.cert)) > 800);
  if (process.platform !== 'win32') assert.equal(statSync(a.key).mode & 0o077, 0);
  assert.equal(ensureSelfSigned(join(dir, 'tls'), ['homedash.lan', '127.0.0.1']).created, false);
  assert.equal(ensureSelfSigned(join(dir, 'tls'), ['homedash.lan', '127.0.0.1', 'other.lan']).created, true, 'new name => new certificate');

  // a real TLS handshake with it
  process.env.TLS_SELF_SIGNED = 'true'; process.env.TLS_NAMES = 'localhost,127.0.0.1';
  const opts = tlsOptions(join(dir, 'x', 'db.sqlite'));
  const srv = createServer(opts, (_q, r) => r.end('secure'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const ca = readFileSync(join(dir, 'x', 'tls', 'selfsigned.crt'));
  const body = await (await fetch(`https://127.0.0.1:${srv.address().port}/`, { dispatcher: new Agent({ connect: { ca } }) })).text();
  assert.equal(body, 'secure');
  srv.close();
});

test('tlsOptions is null without settings and explains an unreadable file', () => {
  delete process.env.TLS_SELF_SIGNED; delete process.env.TLS_NAMES;
  assert.equal(tlsOptions(join(dir, 'd.db')), null);
  process.env.TLS_CERT_FILE = join(dir, 'nope.crt'); process.env.TLS_KEY_FILE = join(dir, 'nope.key');
  assert.throws(() => tlsOptions(join(dir, 'd.db')), /cannot read the certificate/);
  delete process.env.TLS_CERT_FILE; delete process.env.TLS_KEY_FILE;
});

test('version comparison', () => {
  assert.equal(isNewer('v1.2.0', '1.1.9'), true); assert.equal(isNewer('1.0.0', '1.0.0'), false); assert.equal(isNewer('v0.9.9', '1.0.0'), false);
  assert.equal(isNewer('2.0.0-rc1', '1.9.0'), true); assert.equal(isNewer('1.10.0', '1.9.0'), true);
});

test('update check reads the latest release; no release or an error is not an update', async () => {
  const ok = await checkNow(async () => new Response(JSON.stringify({ tag_name: 'v9.0.0', html_url: 'https://example.test/r' }), { status: 200 }));
  assert.equal(ok.latest, 'v9.0.0');
  assert.equal(versionState().available, true);
  await checkNow(async () => new Response('{}', { status: 404 }));
  assert.equal(versionState().available, false);
  const err = await checkNow(async () => new Response('x', { status: 500 }));
  assert.match(err.error, /500/); assert.equal(versionState().available, false);
});
