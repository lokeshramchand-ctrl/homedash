import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kumaStaleness, mapKuma } from '../build/monitoring/providers/kuma.js';
import { mapGrafana } from '../build/monitoring/providers/grafana.js';

const item = (name, status, url = 'https://x.test', ping = 12) => ({ key: `${name}|http|${url}`, name, url, type: 'http', status, ping });

test('Kuma monitors map to checks: up has no start time, the rest do', () => {
  const sinceOf = (key) => (key.startsWith('db') ? 5000 : 9000);
  const c = mapKuma([item('web', 'up'), item('db', 'down'), item('api', 'pending'), item('nas', 'maintenance')], sinceOf);
  assert.deepEqual(c.map((x) => [x.name, x.status, x.since, x.detail]), [
    ['web', 'up', null, ''], ['db', 'down', 5000, 'Monitor is down'], ['api', 'pending', 9000, 'Monitor is retrying'], ['nas', 'maintenance', 9000, 'Under maintenance'],
  ]);
});

test('only http(s) monitor links are kept; hostnames and ports are not links', () => {
  const [a, b] = mapKuma([item('a', 'up', 'https://a.test'), item('b', 'up', '192.168.1.5:22')], () => 0);
  assert.equal(a.url, 'https://a.test');
  assert.equal(b.url, null);
});

test('a Kuma snapshot is trusted only when it exists and is recent', () => {
  assert.match(kumaStaleness(0, 1_000_000, 60_000), /first Uptime Kuma scrape/);
  assert.match(kumaStaleness(1_000_000 - 200_000, 1_000_000, 60_000), /No recent/);
  assert.equal(kumaStaleness(1_000_000 - 100_000, 1_000_000, 60_000), null);
});

test('Grafana alerts map across unchanged', () => {
  const a = { key: 'u1', name: 'Disk', state: 'firing', level: 'error', folder: 'Infra', group: 'host', summary: 's', since: 5, instances: 2, url: 'http://g/x' };
  const p = mapGrafana({ configured: true, alerts: [a], firing: 1, pending: 0, checkedAt: 1, error: null });
  assert.deepEqual(p.checks, []);
  assert.deepEqual(p.alerts, [{ key: 'u1', name: 'Disk', level: 'error', state: 'firing', since: 5, summary: 's', instances: 2, url: 'http://g/x' }]);
});

test('a failed Grafana read throws, so it can never look like an empty list', () => {
  assert.throws(() => mapGrafana({ configured: true, alerts: [], firing: 0, pending: 0, checkedAt: 1, error: 'Cannot reach Grafana' }), /Cannot reach Grafana/);
});
