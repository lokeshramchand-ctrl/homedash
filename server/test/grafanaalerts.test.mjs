import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGrafanaRules, grafanaAlerts } from '../build/grafanaalerts.js';

// Shape follows the Prometheus rules API that Grafana exposes at /api/prometheus/grafana/api/v1/rules. Not captured from a live Grafana.
const body = { status: 'success', data: { groups: [
  { name: 'host', file: 'Infra', rules: [
    { name: 'Disk almost full', uid: 'abc123', state: 'firing', labels: { severity: 'critical' }, annotations: { summary: 'root is 93% full' },
      alerts: [{ state: 'Alerting', activeAt: '2026-11-26T10:00:00Z' }, { state: 'Alerting', activeAt: '2026-11-26T09:00:00Z' }] },
    { name: 'High load', uid: 'def456', state: 'pending', labels: {}, annotations: { description: 'load above 4' }, alerts: [{ state: 'Pending', activeAt: '2026-11-26T11:00:00Z' }] },
    { name: 'Quiet rule', uid: 'zzz', state: 'inactive', labels: {}, annotations: {}, alerts: [] },
  ] },
  { name: 'net', file: 'Network', rules: [{ name: 'Link down', state: 'firing', labels: { severity: 'warning' }, annotations: {}, alerts: [] }] },
] } };

test('only firing and pending rules are kept; errors first, then firing before pending', () => {
  const a = parseGrafanaRules(body, 'https://grafana.lan');
  assert.deepEqual(a.map((x) => x.name), ['Disk almost full', 'Link down', 'High load']);
  assert.equal(a[0].level, 'error');
  assert.equal(a[1].level, 'warn');
  assert.equal(a[2].state, 'pending');
});

test('instances, start time, summary fallback and links', () => {
  const [disk, , load] = parseGrafanaRules(body, 'https://grafana.lan');
  assert.equal(disk.instances, 2);
  assert.equal(disk.since, Date.parse('2026-11-26T09:00:00Z'));
  assert.equal(disk.summary, 'root is 93% full');
  assert.equal(disk.url, 'https://grafana.lan/alerting/grafana/abc123/view');
  assert.equal(load.summary, 'load above 4');
  assert.equal(parseGrafanaRules(body, '')[0].url, null);
});

test('rules without a uid get a stable key from folder, group and name', () => {
  const link = parseGrafanaRules(body).find((x) => x.name === 'Link down');
  assert.equal(link.key, 'Network/net/Link down');
});

test('junk input is tolerated and yields nothing', () => {
  for (const b of [null, undefined, {}, { data: {} }, { data: { groups: 'x' } }, { data: { groups: [null, { rules: [null, 5] }] } }]) assert.deepEqual(parseGrafanaRules(b), []);
});

test('with Grafana not configured the answer says so, and a fetch is never made', async () => {
  let called = false;
  const info = await grafanaAlerts(async () => { called = true; return body; });
  assert.equal(info.configured, false);
  assert.equal(called, false);
});
