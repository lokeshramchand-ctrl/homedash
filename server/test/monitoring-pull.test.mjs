import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { prometheusProvider } from '../build/monitoring/providers/prometheus.js';
import { alertmanagerProvider } from '../build/monitoring/providers/alertmanager.js';
import { jsonPollProvider } from '../build/monitoring/providers/jsonpoll.js';

let http, base; const seen = [];
const ruleBody = { status: 'success', data: { groups: [{ name: 'g', file: 'f', rules: [{ type: 'alerting', name: 'Disk', labels: { severity: 'critical' }, annotations: { summary: 's' }, alerts: [{ state: 'firing', activeAt: '2026-01-01T00:00:00Z', labels: {}, annotations: {} }] }] }] } };

before(async () => {
  http = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/prom/api/v1/rules')) {
      if (req.headers.authorization !== `Basic ${Buffer.from('ops:s3cret-pass').toString('base64')}`) { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify(ruleBody));
    }
    if (req.url.startsWith('/am/api/v2/alerts')) return res.end(JSON.stringify([{ fingerprint: 'f1', startsAt: '2026-01-01T00:00:00Z', status: { state: 'active' }, labels: { alertname: 'X' }, annotations: {} }]));
    if (req.url === '/bearer') return res.end(JSON.stringify(req.headers.authorization === 'Bearer tok-123' ? [{ n: 'a', s: 'ok' }] : []));
    if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); return res.end(); }
    if (req.url === '/html') { res.setHeader('content-type', 'text/html'); return res.end('<html>login</html>'); }
    if (req.url === '/notprom') return res.end('{"hello":"world"}');
    if (req.url === '/big') return res.end(JSON.stringify({ pad: 'x'.repeat(2_200_000) }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${http.address().port}`;
});
after(() => http.close());

const src = (kind, config, secrets = {}) => ({ id: 'src-t', kind, name: 'Test', config, secrets, secretsSet: Object.keys(secrets), enabled: true, intervalS: 60, ttlHours: 168, createdAt: 1, createdBy: 'a' });

test('Prometheus: basic auth is sent, the rules are read, the source name is the label', async () => {
  const p = prometheusProvider(src('prometheus', { url: `${base}/prom/`, username: 'ops' }, { password: 's3cret-pass' }));
  assert.equal(p.label, 'Test');
  const r = await p.poll();
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].level, 'error');
  assert.ok(seen.some((s) => s.url === '/prom/api/v1/rules?type=alert'));
});

test('wrong credentials give a clear error that never contains the credential', async () => {
  const p = prometheusProvider(src('prometheus', { url: `${base}/prom`, username: 'ops' }, { password: 'WRONG-secret' }));
  await assert.rejects(p.poll(), (e) => /refused the credentials \(HTTP 401\)/.test(e.message) && !/WRONG-secret|ops/.test(e.message));
});

test('a redirect is refused, so a source cannot bounce the server to another address', async () => {
  const p = jsonPollProvider(src('jsonpoll', { url: `${base}/redirect`, items_path: '$', name_path: 'n', status_path: 's' }));
  await assert.rejects(p.poll(), /redirected to another address/);
});

test('an answer that is not JSON, not the expected kind, or too large is a clear error', async () => {
  await assert.rejects(prometheusProvider(src('prometheus', { url: `${base}/html` })).poll(), /not JSON|did not answer like Prometheus|HTTP 404/);
  await assert.rejects(prometheusProvider(src('prometheus', { url: `${base}/notprom/x` })).poll(), /HTTP 404|did not answer like Prometheus/);
  await assert.rejects(jsonPollProvider(src('jsonpoll', { url: `${base}/big`, items_path: 'pad', name_path: 'n', status_path: 's' })).poll(), /larger than 2 MB/);
});

test('Alertmanager: active alerts are read; a server that is not Alertmanager is reported', async () => {
  const r = await alertmanagerProvider(src('alertmanager', { url: `${base}/am` })).poll();
  assert.deepEqual(r.alerts.map((a) => a.key), ['f1']);
  assert.ok(seen.some((s) => s.url === '/am/api/v2/alerts?active=true&silenced=false&inhibited=false'));
  await assert.rejects(alertmanagerProvider(src('alertmanager', { url: `${base}/notprom` })).poll(), /did not answer like Alertmanager|HTTP 404/);
});

test('JSON poll sends the bearer token and maps the list; a dead address says it cannot reach the server', async () => {
  const r = await jsonPollProvider(src('jsonpoll', { url: `${base}/bearer`, items_path: '$', name_path: 'n', status_path: 's' }, { token: 'tok-123' })).poll();
  assert.deepEqual(r.checks.map((c) => [c.name, c.status]), [['a', 'up']]);
  await assert.rejects(jsonPollProvider(src('jsonpoll', { url: 'http://127.0.0.1:1/x', items_path: '$', name_path: 'n', status_path: 's' })).poll(), /Cannot reach the server/);
});
