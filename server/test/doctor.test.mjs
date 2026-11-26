import assert from 'node:assert/strict';
import { test } from 'node:test';
import { softenFailover, exitCode, interpretHttp, interpretNetworkError, localFindings, summary, targetsFor } from '../build/doctor.js';

test('targets: every configured address, none for what is off, several Proxmox members', () => {
  const t = targetsFor({ PVE_URL: 'https://a:8006 https://b:8006', PVE_TOKEN_ID: 'x@pve!t', PVE_TOKEN_SECRET: 's', GRAFANA_URL: 'http://g:3000', KUMA_URL: '', LOKI_URL: 'not a url' });
  assert.deepEqual(t.map((x) => x.id), ['proxmox', 'proxmox2', 'grafana']);
  assert.ok(t[0].pveToken && t[1].pveToken);
  assert.equal(targetsFor({}).length, 0);
});

test('http answers are explained: wanting credentials is fine, refused credentials are not', () => {
  assert.equal(interpretHttp('Grafana', 200).verdict, 'ok');
  assert.equal(interpretHttp('Grafana', 401).verdict, 'ok');
  assert.equal(interpretHttp('Proxmox', 401, true).verdict, 'fail');
  assert.match(interpretHttp('Proxmox', 401, true).fix, /token/);
  assert.equal(interpretHttp('Kuma', 404).verdict, 'warn');
  assert.equal(interpretHttp('Kuma', 502).verdict, 'warn');
});

test('network failures are explained in plain words with a fix', () => {
  for (const [msg, word] of [['ENOTFOUND grafana.lan', /resolve/], ['ECONNREFUSED 127.0.0.1:1', /refused/], ['The operation was aborted due to timeout', /no answer/], ['self-signed certificate', /certificate/]]) {
    const r = interpretNetworkError('X', msg);
    assert.equal(r.verdict, 'fail');
    assert.match(r.detail, word);
    assert.ok(r.fix.length > 10);
  }
});

test('local checks: old Node, open secrets file, unwritable folders and a missing UI are flagged', () => {
  const good = localFindings({ nodeVersion: 'v22.13.0', secretsMode: 0o100600, dbDirWritable: true });
  assert.ok(good.every((f) => f.verdict === 'ok'));
  const bad = localFindings({ nodeVersion: 'v20.1.0', secretsMode: 0o100644, dbDirWritable: false, backupDir: '/b', backupDirWritable: false, distDir: '/d', distExists: false });
  assert.deepEqual(bad.map((f) => f.verdict), ['fail', 'warn', 'fail', 'fail', 'fail']);
  for (const f of bad) assert.ok(f.fix);
  assert.equal(localFindings({ nodeVersion: 'v24.0.0', dbDirWritable: true })[0].verdict, 'ok');
});

test('exit code and summary: only failures fail the run', () => {
  const f = [{ id: 'a', label: 'a', verdict: 'ok', detail: '' }, { id: 'b', label: 'b', verdict: 'warn', detail: '' }];
  assert.equal(exitCode(f), 0);
  assert.equal(exitCode([...f, { id: 'c', label: 'c', verdict: 'fail', detail: '' }]), 1);
  assert.deepEqual(summary(f), { ok: 1, warn: 1, fail: 0 });
});

test('a dead cluster member is a warning while another answers, a failure when none does', () => {
  const ok = { id: 'proxmox', label: 'P', verdict: 'ok', detail: '' }, bad = { id: 'proxmox2', label: 'P2', verdict: 'fail', detail: 'refused' };
  assert.equal(softenFailover([ok, bad]).find((x) => x.id === 'proxmox2').verdict, 'warn');
  assert.equal(softenFailover([{ ...ok, verdict: 'fail' }, bad]).filter((x) => x.verdict === 'fail').length, 2);
  assert.equal(softenFailover([bad])[0].verdict, 'fail'); // a single address has no failover
});
