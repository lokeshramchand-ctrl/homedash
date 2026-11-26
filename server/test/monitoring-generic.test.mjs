// The generic engine: comparisons, Prometheus text, request building and its safety rules, JSON alerts, and the custom HTTP source
// end to end against local servers (including a self-signed HTTPS one). Fixtures are illustrative, not captured from any product.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { holds, parseCondition } from '../build/monitoring/conditions.js';
import { mapPromText, parseLabelFilter, parsePromText } from '../build/monitoring/prometheus-text.js';
import { buildRequest, parseHeaders } from '../build/monitoring/request.js';
import { mapJsonAlerts, parseLevelMap, toMillis } from '../build/monitoring/providers/jsonpoll.js';
import { genericProvider, parseCodes } from '../build/monitoring/providers/generic.js';

// ---- comparisons ----
test('comparisons parse and hold; anything else is not a comparison', () => {
  const c = parseCondition(' >= 90 ');
  assert.deepEqual(c, { op: '>=', n: 90 });
  assert.ok(holds(c, 90) && holds(c, 99) && !holds(c, 89));
  assert.ok(holds(parseCondition('== 1'), 1) && !holds(parseCondition('== 1'), 0));
  assert.ok(holds(parseCondition('!= 0'), 5) && holds(parseCondition('< -1.5'), -2) && holds(parseCondition('<= 1e3'), 1000));
  for (const bad of ['', 'high', '> ', '=> 3', '> 3 and < 5', '1 > 0', undefined]) assert.equal(parseCondition(bad), null, String(bad));
});

// ---- Prometheus text ----
const PAGE = `# HELP up Whether the target is up.
# TYPE up gauge
up{job="node",instance="a:9100"} 1
up{job="node",instance="b:9100"} 0
up{job="db",instance="c:5432"} 1 1700000000000
disk_used_percent{mount="/"} 83.5
disk_used_percent{mount="/data"} 97
escaped{name="a \\"quoted\\" \\\\ path\\nline"} 1
weird_nan
bad_value{x="1"} NaN
inf_metric +Inf
no_labels 42
this is not a metric line
`;

test('a metrics page is parsed: comments, timestamps, escapes, special values and junk lines', () => {
  const s = parsePromText(PAGE);
  const by = (n) => s.filter((x) => x.name === n);
  assert.equal(by('up').length, 3);
  assert.deepEqual(by('up')[2].labels, { job: 'db', instance: 'c:5432' });
  assert.equal(by('up')[2].value, 1, 'a timestamp after the value is ignored');
  assert.equal(by('escaped')[0].labels.name, 'a "quoted" \\ path\nline');
  assert.equal(by('bad_value').length, 0, 'NaN is dropped');
  assert.equal(by('inf_metric')[0].value, Infinity);
  assert.equal(by('no_labels')[0].value, 42);
  assert.equal(by('weird_nan').length, 0);
});

test('series become checks with up, warning and down from two comparisons', () => {
  const s = parsePromText(PAGE);
  const up = mapPromText(s, { metric: 'up', name_label: 'instance' });
  assert.deepEqual(up.map((c) => [c.name, c.status]), [['a:9100', 'up'], ['b:9100', 'down'], ['c:5432', 'up']]);
  assert.deepEqual(mapPromText(s, { metric: 'up', label_filter: 'job=node', name_label: 'instance' }).map((c) => c.name), ['a:9100', 'b:9100']);
  const disk = mapPromText(s, { metric: 'disk_used_percent', name_label: 'mount', up_when: '< 80', warn_when: '< 95' });
  assert.deepEqual(disk.map((c) => [c.name, c.status, c.detail]), [['/', 'pending', 'disk_used_percent = 83.5'], ['/data', 'down', 'disk_used_percent = 97']]);
  assert.equal(mapPromText(s, { metric: 'no_labels' })[0].name, 'no_labels');
  assert.equal(mapPromText(s, { metric: 'absent' }).length, 0);
});

test('bad rules are refused in plain words', () => {
  assert.throws(() => mapPromText([], {}), /Say which metric/);
  assert.throws(() => mapPromText([], { metric: 'x', up_when: 'high' }), /not a comparison/);
  assert.throws(() => mapPromText([], { metric: 'x', warn_when: '~ 3' }), /not a comparison/);
  assert.deepEqual(parseLabelFilter('job=node, env="prod"\nbad, =x'), [['job', 'node'], ['env', 'prod']]);
});

// ---- building a request ----
test('every way of signing in produces the right request', () => {
  const base = { url: 'http://x.lan/api' };
  assert.equal(buildRequest({ ...base, auth: 'bearer' }, 'tok').headers.Authorization, 'Bearer tok');
  assert.equal(buildRequest({ ...base, auth: 'basic', username: 'ops' }, 'pw').headers.Authorization, `Basic ${Buffer.from('ops:pw').toString('base64')}`);
  assert.equal(buildRequest({ ...base, auth: 'header', header_name: 'X-Api-Key' }, 'k').headers['X-Api-Key'], 'k');
  assert.equal(buildRequest({ ...base, auth: 'query', query_name: 'api_key' }, 'a b&c').url, 'http://x.lan/api?api_key=a+b%26c');
  assert.equal(buildRequest({ ...base }, '').headers.Authorization, undefined);
});

test('{{secret}} is replaced in the address, headers and body, and nowhere else', () => {
  const r = buildRequest({ url: 'http://x.lan/{{secret}}/v1', method: 'POST', extra_headers: 'Authorization: Bearer {{secret}}\nX-Team: red', body: '{"api_key":"{{secret}}","other":"{{notsecret}}"}' }, 's e/c');
  assert.equal(r.url, 'http://x.lan/s%20e%2Fc/v1');
  assert.equal(r.headers.Authorization, 'Bearer s e/c');
  assert.equal(r.headers['X-Team'], 'red');
  assert.equal(r.body, '{"api_key":"s e/c","other":"{{notsecret}}"}');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.throws(() => buildRequest({ url: 'http://x.lan/{{secret}}' }, ''), /no key or password is saved/);
});

test('anything that could be abused is refused', () => {
  const ok = { url: 'http://x.lan/a' };
  assert.throws(() => buildRequest({ url: 'ftp://x.lan' }, ''), /http:\/\/ or https:\/\//);
  assert.throws(() => buildRequest({ url: 'not a url' }, ''), /not valid/);
  assert.throws(() => buildRequest({ ...ok, method: 'DELETE' }, ''), /GET or POST/);
  assert.throws(() => buildRequest({ ...ok, body: 'x' }, ''), /needs the POST method/);
  assert.throws(() => buildRequest({ ...ok, method: 'POST', body: 'x'.repeat(5000) }, ''), /larger than/);
  for (const h of ['Host: evil', 'Content-Length: 5', 'Transfer-Encoding: chunked', 'Connection: upgrade', 'Cookie: a=b', 'Bad Name: x', 'X: a\u0000b']) assert.throws(() => buildRequest({ ...ok, extra_headers: h }, ''), /cannot be set|not a valid header|line break/, h);
  assert.throws(() => buildRequest({ ...ok, extra_headers: 'X-A: 1\nx-a: 2' }, ''), /set twice/);
  assert.throws(() => buildRequest({ ...ok, auth: 'bearer', extra_headers: 'Authorization: x' }, 's'), /both/);
  assert.throws(() => buildRequest({ ...ok, auth: 'bearer' }, ''), /needs the key or password/);
  assert.throws(() => buildRequest({ ...ok, auth: 'query', query_name: 'a b' }, 's'), /query parameter/);
  assert.throws(() => buildRequest({ ...ok, auth: 'header', header_name: 'Host' }, 's'), /cannot be set/);
  assert.throws(() => buildRequest({ ...ok, auth: 'magic' }, 's'), /Unknown way/);
  assert.throws(() => buildRequest({ ...ok, extra_headers: 'X-Inject: {{secret}}' }, 'a\r\nEvil: 1'), /line break/);
  assert.throws(() => parseHeaders(Array.from({ length: 25 }, (_, i) => `X-${i}: v`).join('\n')), /At most 20/);
  assert.throws(() => parseHeaders('no colon here'), /not a header line/);
});

// ---- JSON as alerts ----
const ZLIKE = { result: [
  { eventid: '11', name: 'Disk full on web1', severity: '5', clock: '1790000000', status: 'problem', detail: { text: 'root 99%' } },
  { eventid: '12', name: 'High load on db1', severity: '3', clock: 1790000500, status: 'problem' },
  { eventid: '13', name: 'Old resolved thing', severity: '4', clock: '1700000000', status: 'resolved' },
  { name: 5, severity: '1' }, { severity: '2' },
] };

test('a JSON list becomes alerts with levels, start times, summaries and an optional status filter', () => {
  const m = { items_path: 'result', name_path: 'name', level_path: 'severity', level_map: '5=error, 4=error, 3=warn, 1=info', since_path: 'clock', summary_path: 'detail.text', key_path: 'eventid', status_path: 'status', alert_values: 'problem' };
  const a = mapJsonAlerts(ZLIKE, m);
  assert.deepEqual(a.map((x) => [x.key, x.name, x.level, x.summary]), [['11', 'Disk full on web1', 'error', 'root 99%'], ['12', 'High load on db1', 'warn', '']]);
  assert.equal(a[0].since, 1790000000 * 1000, 'seconds become milliseconds');
  assert.equal(a[1].since, 1790000500 * 1000);
  const all = mapJsonAlerts(ZLIKE, { items_path: 'result', name_path: 'name', level_path: 'severity', level_map: '5=error' });
  assert.deepEqual(all.map((x) => x.name), ['Disk full on web1', 'High load on db1', 'Old resolved thing', '5']);
  assert.throws(() => mapJsonAlerts({ a: 1 }, { items_path: 'result', name_path: 'name' }), /does not lead to a list/);
});

test('level maps and times are read leniently', () => {
  assert.deepEqual(parseLevelMap('Critical=error, warning = warn\nok=info, odd=banana, =error'), { critical: 'error', warning: 'warn', ok: 'info' });
  assert.equal(toMillis(1700000000), 1700000000000);
  assert.equal(toMillis(1700000000000), 1700000000000);
  assert.equal(toMillis('1700000000'), 1700000000000);
  assert.equal(toMillis('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
  for (const bad of [0, -5, '', 'soon', null, {}]) assert.equal(toMillis(bad), null, String(bad));
});

test('status codes: defaults to 200-399, ranges and single codes accepted', () => {
  const d = parseCodes(undefined); assert.ok(d(200) && d(302) && !d(404) && !d(500));
  const c = parseCodes('200-204, 401'); assert.ok(c(204) && c(401) && !c(301) && !c(403));
});

// ---- the custom HTTP source against real servers ----
let plain, tls, dir, plainBase, tlsBase;
const src = (config, secrets = {}) => ({ id: 'src-gen', kind: 'http', name: 'Generic', config, secrets, secretsSet: Object.keys(secrets), enabled: true, intervalS: 60, ttlHours: 168, createdAt: 1, createdBy: 'a' });
const seen = [];

before(async () => {
  plain = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'], ct: req.headers['content-type'], body: b });
      if (req.url.startsWith('/metrics')) { res.setHeader('content-type', 'text/plain'); return res.end(PAGE); }
      if (req.url.startsWith('/problems')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(ZLIKE)); }
      if (req.url === '/rpc') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ result: [{ name: JSON.parse(b || '{}').method ?? 'none', severity: '4' }] })); }
      if (req.url === '/needs-key') { if (req.headers['x-api-key'] !== 'secret-key') { res.statusCode = 401; return res.end('{}'); } res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ items: [{ n: 'svc', s: 'ok' }] })); }
      if (req.url === '/page') return res.end('<html>Welcome to Grafana</html>');
      if (req.url === '/broken') { res.statusCode = 503; return res.end('down'); }
      if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); return res.end(); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  plainBase = `http://127.0.0.1:${plain.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'hd-gen-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    tls = createHttps({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ items: [{ n: 'tls-svc', s: 'ok' }] })); });
    await new Promise((r) => tls.listen(0, '127.0.0.1', r));
    tlsBase = `https://127.0.0.1:${tls.address().port}`;
  } catch { tls = null; }
});
after(() => { plain?.close(); tls?.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('Prometheus text mode reads a /metrics page and applies the rule', async () => {
  const r = await genericProvider(src({ url: `${plainBase}/metrics`, parse: 'prometheus', metric: 'up', name_label: 'instance', label_filter: 'job=node' })).poll();
  assert.deepEqual(r.checks.map((c) => [c.name, c.status]), [['a:9100', 'up'], ['b:9100', 'down']]);
});

test('JSON alerts mode with a POST body and a secret substituted into the body, as JSON-RPC style tools need', async () => {
  const r = await genericProvider(src({ url: `${plainBase}/rpc`, method: 'POST', body: '{"jsonrpc":"2.0","method":"problem.get","auth":"{{secret}}"}', parse: 'json_alerts', items_path: 'result', name_path: 'name', level_path: 'severity', level_map: '4=error' }, { secret: 's3cr3t' })).poll();
  assert.deepEqual(r.alerts.map((a) => [a.name, a.level]), [['problem.get', 'error']]);
  const call = seen.filter((s) => s.url === '/rpc').pop();
  assert.equal(call.method, 'POST'); assert.equal(call.ct, 'application/json'); assert.match(call.body, /"auth":"s3cr3t"/);
});

test('a custom header carries the key; a missing or wrong key is a clear error that never shows the key', async () => {
  const good = await genericProvider(src({ url: `${plainBase}/needs-key`, auth: 'header', header_name: 'X-Api-Key', parse: 'json_checks', items_path: 'items', name_path: 'n', status_path: 's' }, { secret: 'secret-key' })).poll();
  assert.deepEqual(good.checks.map((c) => [c.name, c.status]), [['svc', 'up']]);
  await assert.rejects(genericProvider(src({ url: `${plainBase}/needs-key`, auth: 'header', header_name: 'X-Api-Key', parse: 'json_checks', items_path: 'items', name_path: 'n', status_path: 's' }, { secret: 'WRONG-KEY' })).poll(), (e) => /refused the credentials \(HTTP 401\)/.test(e.message) && !/WRONG-KEY/.test(e.message));
});

test('reachability mode: up on a good code and matching text; down on a bad code, missing text, or an unreachable server', async () => {
  const run = (config) => genericProvider(src({ parse: 'status', ...config })).poll().then((r) => r.checks[0]);
  assert.equal((await run({ url: `${plainBase}/page` })).status, 'up');
  assert.equal((await run({ url: `${plainBase}/page`, must_contain: 'Grafana' })).status, 'up');
  const noText = await run({ url: `${plainBase}/page`, must_contain: 'Nagios' });
  assert.deepEqual([noText.status, noText.detail], ['down', 'The answer does not contain "Nagios"']);
  assert.equal((await run({ url: `${plainBase}/broken` })).detail, 'HTTP 503');
  assert.equal((await run({ url: `${plainBase}/broken`, ok_codes: '503' })).status, 'up');
  const dead = await run({ url: 'http://127.0.0.1:1/' });
  assert.deepEqual([dead.status, /Cannot reach/.test(dead.detail)], ['down', true]);
});

test('a redirect is never followed, in any mode except reachability, where it is just a status', async () => {
  await assert.rejects(genericProvider(src({ url: `${plainBase}/redirect`, parse: 'json_checks', items_path: '$', name_path: 'n', status_path: 's' })).poll(), /redirected to another address/);
  assert.equal((await genericProvider(src({ url: `${plainBase}/redirect`, parse: 'status', ok_codes: '302' })).poll()).checks[0].status, 'up');
});

test('self-signed HTTPS is refused by default and accepted only when the source says so', async (t) => {
  if (!tls) return t.skip('openssl is not available');
  const cfg = { url: `${tlsBase}/`, parse: 'json_checks', items_path: 'items', name_path: 'n', status_path: 's' };
  await assert.rejects(genericProvider(src(cfg)).poll(), /Cannot reach the server/);
  const r = await genericProvider(src({ ...cfg, insecure_tls: 'true' })).poll();
  assert.deepEqual(r.checks.map((c) => c.name), ['tls-svc']);
  assert.equal((await genericProvider(src({ url: `${tlsBase}/`, parse: 'status' })).poll()).checks[0].status, 'down', 'reachability reports the certificate problem as down');
  assert.equal((await genericProvider(src({ url: `${tlsBase}/`, parse: 'status', insecure_tls: 'true' })).poll()).checks[0].status, 'up');
});
