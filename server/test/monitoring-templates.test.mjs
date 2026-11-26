// Each template is the custom HTTP source with a tool's request and reading filled in. These tests run the real provider against a
// local server that answers in the shape the tool's own documentation shows (adapted examples from docs/research/monitoring-templates-formats.md,
// not captured from the products) and check both the request that was sent and what was read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { SOURCE_TEMPLATES, applyTemplate, templateSpec } from '../build/monitoring/catalog.js';
import { genericProvider } from '../build/monitoring/providers/generic.js';

let server, base; const seen = [];
const T = (id) => templateSpec(id);
const run = async (id, ask, secret, tweak = {}) => {
  const t = T(id);
  const body = applyTemplate(t, ask);
  const { secret: _s, ...config } = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
  const cfg = { ...config, ...tweak };
  return genericProvider({ id: 'src-t', kind: 'http', name: t.label, config: cfg, secrets: secret ? { secret } : {}, secretsSet: [], enabled: true, intervalS: 60, ttlHours: 168, createdAt: 1, createdBy: 'a' }).poll();
};

before(async () => {
  server = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v3/checks/') return res.end(JSON.stringify({ checks: [
        { name: 'Filesystem Backup', slug: 'fs', status: 'up' }, { name: 'Database Backup', slug: 'db', status: 'down' }, { name: 'Late job', status: 'grace' }, { name: 'Paused one', status: 'paused' }, { name: 'Fresh', status: 'new' }] }));
      if (req.url === '/zabbix/api_jsonrpc.php') return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [
        { eventid: '1245463', objectid: '15112', clock: '1472457242', name: 'Zabbix agent on localhost is unreachable for 5 minutes', acknowledged: '0', severity: '3', suppressed: '0' },
        { eventid: '1245470', clock: '1472457999', name: 'Disk full on db1', severity: '5' }] }));
      if (req.url === '/v2/getMonitors') return res.end(JSON.stringify({ stat: 'ok', pagination: { offset: 0, limit: 50, total: 3 }, monitors: [
        { id: 777749809, friendly_name: 'Google', url: 'http://www.google.com', type: 1, interval: 900, status: 2 }, { id: 2, friendly_name: 'Blog', status: 9 }, { id: 3, friendly_name: 'Flaky', status: 8 }] }));
      if (req.url === '/api/v1/alarms') return res.end(JSON.stringify({ hostname: 'myhost', status: true, now: 1700000000, alarms: {
        'system.cpu.10min_cpu_usage': { id: 1, name: '10min_cpu_usage', chart: 'system.cpu', status: 'WARNING', info: 'average cpu utilization for the last 10 minutes', last_status_change: 1699999000, value: 82.1 },
        'disk_space._.used': { id: 2, name: 'disk_space_usage', chart: 'disk_space._', status: 'CRITICAL', info: 'disk space used', last_status_change: 1699999500, value: 97 },
        'system.ram.ram_in_use': { id: 3, name: 'ram_in_use', chart: 'system.ram', status: 'CLEAR', info: 'ram', last_status_change: 1699990000, value: 30 } } }));
      if (req.url === '/mysite/check_mk/api/1.0/domain-types/service/collections/all') return res.end(JSON.stringify({ id: 'service', domainType: 'service', value: [
        { domainType: 'service', id: 'web1:Disk /', title: 'Disk / on web1', extensions: { host_name: 'web1', description: 'Disk /', state: 2, plugin_output: 'CRIT - 96% used' } },
        { domainType: 'service', id: 'db1:Backup age', title: 'Backup age on db1', extensions: { host_name: 'db1', description: 'Backup age', state: 1, plugin_output: 'WARN - 31 h' } }] }));
      if (req.url === '/api/routes/gateway/status') return res.end(JSON.stringify({ dirty: false, status: 'ok', items: [
        { name: 'WAN_DHCP', address: '203.0.113.1', status: 'none', status_translated: 'Online', delay: '5.1 ms', loss: '0.0 %' },
        { name: 'WAN2', address: '198.51.100.1', status: 'down', status_translated: 'Offline', delay: '~', loss: '100.0 %' },
        { name: 'WAN3', status: 'loss', status_translated: 'Packetloss', delay: '9 ms' }] }));
      if (req.url === '/prometheus/api/v1/alerts') return res.end(JSON.stringify({ status: 'success', data: { alerts: [
        { labels: { alertname: 'ErrorBurst', severity: 'critical' }, annotations: { summary: 'Too many errors in nginx' }, state: 'firing', activeAt: '2026-11-26T10:00:00Z', value: '12' },
        { labels: { alertname: 'SlowLogs', severity: 'warning' }, annotations: {}, state: 'pending', activeAt: '2026-11-26T10:05:00Z' }] } }));
      if (req.url === '/ready') { res.setHeader('content-type', 'text/plain'); return res.end('ready'); }
      if (req.url === '/-/health/ready/') { res.statusCode = 204; return res.end(); }
      if (req.url === '/health/ready') return res.end(JSON.stringify({ status: 'UP', checks: [] }));
      if (req.url === '/api/health') return res.end(JSON.stringify({ status: 'OK' }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const last = (path) => seen.filter((s) => s.url === path).pop();

test('every template is well formed: it fixes a custom-HTTP reading and asks only for what it needs', () => {
  assert.deepEqual(SOURCE_TEMPLATES.map((t) => t.id), ['healthchecks', 'zabbix', 'uptimerobot', 'netdata', 'checkmk', 'opnsense', 'loki-alerts', 'loki-ready', 'authentik', 'keycloak', 'authelia']);
  for (const t of SOURCE_TEMPLATES) {
    assert.ok(t.label && t.summary && t.hint && t.verified, `${t.id} says what it was checked against`);
    assert.ok(['json_checks', 'json_alerts', 'prometheus', 'status'].includes(t.fixed.parse), t.id);
    assert.ok(t.ask.length >= 1 && t.ask.every((f) => !(f.name in t.fixed) || f.name === 'auth'), `${t.id}: nothing is both asked and fixed except a choice the person makes`);
    assert.ok(t.fixedUrl || t.ask.some((f) => f.name === 'url'), `${t.id} has an address`);
  }
});

test('the address is built from the base once, even when an edit gives the full address back', () => {
  const hc = T('healthchecks');
  assert.equal(applyTemplate(hc, { url: 'https://hc.lan/' }).url, 'https://hc.lan/api/v3/checks/');
  assert.equal(applyTemplate(hc, { url: 'https://hc.lan/api/v3/checks/' }).url, 'https://hc.lan/api/v3/checks/');
  assert.equal(applyTemplate(hc, { url: 'https://hc.lan/api/v3/checks' }).url, 'https://hc.lan/api/v3/checks/');
  assert.equal(applyTemplate(T('zabbix'), { url: 'http://z.lan/zabbix' }).url, 'http://z.lan/zabbix/api_jsonrpc.php');
  assert.equal(applyTemplate(T('zabbix'), { url: 'http://z.lan/zabbix/api_jsonrpc.php' }).url, 'http://z.lan/zabbix/api_jsonrpc.php');
  assert.equal(applyTemplate(T('uptimerobot'), { url: 'http://evil.lan' }).url, 'https://api.uptimerobot.com/v2/getMonitors', 'a fixed address cannot be changed');
  assert.equal(applyTemplate(hc, {}).url, '');
});

test('what a template fixes cannot be overridden from the form', () => {
  const b = applyTemplate(T('zabbix'), { url: 'http://z.lan', parse: 'status', method: 'GET', auth: 'none', body: 'x', items_path: 'evil', template: 'other' });
  assert.deepEqual([b.parse, b.method, b.auth, b.items_path, b.template], ['json_alerts', 'POST', 'bearer', 'result', 'zabbix']);
});

test('Healthchecks.io: the key goes in X-Api-Key, statuses map to up, down, warning, ignored and unknown', async () => {
  const r = await run('healthchecks', { url: base }, 'hc-key');
  assert.equal(last('/api/v3/checks/').headers['x-api-key'], 'hc-key');
  assert.equal(last('/api/v3/checks/').method, 'GET');
  assert.deepEqual(r.checks.map((c) => [c.name, c.status]), [['Filesystem Backup', 'up'], ['Database Backup', 'down'], ['Late job', 'pending'], ['Paused one', 'maintenance'], ['Fresh', 'unknown']]);
});

test('Zabbix: a JSON-RPC problem.get with the token as a Bearer header; severities become levels and clock becomes the start time', async () => {
  const r = await run('zabbix', { url: `${base}/zabbix` }, 'zbx-token');
  const q = last('/zabbix/api_jsonrpc.php');
  assert.equal(q.method, 'POST');
  assert.equal(q.headers.authorization, 'Bearer zbx-token');
  assert.equal(q.headers['content-type'], 'application/json-rpc');
  assert.deepEqual([JSON.parse(q.body).method, JSON.parse(q.body).params.recent], ['problem.get', false]);
  assert.deepEqual(r.alerts.map((a) => [a.key, a.name, a.level]), [['1245463', 'Zabbix agent on localhost is unreachable for 5 minutes', 'warn'], ['1245470', 'Disk full on db1', 'error']]);
  assert.equal(r.alerts[0].since, 1472457242 * 1000);
});

test('Uptime Robot: the key goes in the form body, status numbers map to up, down and warning', async () => {
  const r = await run('uptimerobot', {}, 'ur-key', { url: `${base}/v2/getMonitors` });
  const q = last('/v2/getMonitors');
  assert.equal(q.method, 'POST');
  assert.equal(q.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(q.body, 'api_key=ur-key&format=json&limit=50');
  assert.deepEqual(r.checks.map((c) => [c.name, c.status]), [['Google', 'up'], ['Blog', 'down'], ['Flaky', 'pending']]);
});

test('Netdata: an object of alarms keyed by name is read, only raised ones count, and a token is sent only when chosen', async () => {
  const r = await run('netdata', { url: base, auth: 'none' }, '');
  assert.equal(last('/api/v1/alarms').headers.authorization, undefined);
  assert.deepEqual(r.alerts.map((a) => [a.name, a.level, a.summary]), [['10min_cpu_usage', 'warn', 'average cpu utilization for the last 10 minutes'], ['disk_space_usage', 'error', 'disk space used']], 'the CLEAR alarm is not a problem');
  assert.equal(r.alerts[1].since, 1699999500 * 1000);
  await run('netdata', { url: base, auth: 'bearer' }, 'nd-token');
  assert.equal(last('/api/v1/alarms').headers.authorization, 'Bearer nd-token');
});

test('Checkmk: a POST asking only for services that are not OK, the user and secret in the Bearer header, states become levels', async () => {
  const r = await run('checkmk', { url: `${base}/mysite` }, 'automation S3CRET');
  const q = last('/mysite/check_mk/api/1.0/domain-types/service/collections/all');
  assert.equal(q.method, 'POST');
  assert.equal(q.headers.authorization, 'Bearer automation S3CRET');
  assert.deepEqual(JSON.parse(q.body), { columns: ['host_name', 'description', 'state', 'plugin_output'], query: { op: '!=', left: 'state', right: '0' } });
  assert.deepEqual(r.alerts.map((a) => [a.key, a.name, a.level, a.summary]), [['web1:Disk /', 'Disk / on web1', 'error', 'CRIT - 96% used'], ['db1:Backup age', 'Backup age on db1', 'warn', 'WARN - 31 h']]);
});

test('a wrong key gives the usual plain refusal and never shows the key', async () => {
  const strict = createServer((_q, res) => { res.statusCode = 401; res.end('{}'); });
  await new Promise((r) => strict.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(run('healthchecks', { url: `http://127.0.0.1:${strict.address().port}` }, 'SECRET-KEY-123'), (e) => /refused the credentials \(HTTP 401\)/.test(e.message) && !/SECRET-KEY-123/.test(e.message));
  } finally { strict.close(); }
});

test('OPNsense: basic auth with the key and secret, gateway states become up, down and warning', async () => {
  const r = await run('opnsense', { url: base, username: 'APIKEY' }, 'APISECRET');
  assert.equal(last('/api/routes/gateway/status').headers.authorization, `Basic ${Buffer.from('APIKEY:APISECRET').toString('base64')}`);
  assert.deepEqual(r.checks.map((c) => [c.name, c.status]), [['WAN_DHCP', 'up'], ['WAN2', 'down'], ['WAN3', 'pending']]);
});

test('Loki ruler: only firing alerts count, severity maps to a level, and extra headers (tenant) are sent', async () => {
  const r = await run('loki-alerts', { url: base, extra_headers: 'X-Scope-OrgID: tenant1' }, '');
  assert.equal(last('/prometheus/api/v1/alerts').headers['x-scope-orgid'], 'tenant1');
  assert.deepEqual(r.alerts.map((a) => [a.name, a.level, a.summary]), [['ErrorBurst', 'error', 'Too many errors in nginx']], 'the pending one is not raised');
});

test('Loki, authentik, Keycloak and Authelia: reachability checks that fail on a wrong answer', async () => {
  for (const [id, path] of [['loki-ready', '/ready'], ['authentik', '/-/health/ready/'], ['keycloak', '/health/ready'], ['authelia', '/api/health']]) {
    const up = await run(id, { url: base }, '');
    assert.equal(up.checks[0].status, 'up', id);
    assert.ok(last(path), id);
    const down = await run(id, { url: `${base}/nothing-here` }, '');
    assert.equal(down.checks[0].status, 'down', `${id}: a 404 is down`);
  }
});
