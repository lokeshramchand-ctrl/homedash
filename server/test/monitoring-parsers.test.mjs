// Fixtures are adapted from the official documentation pages listed in docs/research/monitoring-provider-formats.md
// (field names and sample values). They are not captured from a live server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePromRules } from '../build/monitoring/providers/prometheus.js';
import { parseAmAlerts } from '../build/monitoring/providers/alertmanager.js';
import { getPath, mapJson, parseStatusMap } from '../build/monitoring/providers/jsonpoll.js';

const prom = (rules) => ({ status: 'success', data: { groups: [{ name: 'example', file: '/rules.yaml', interval: 60, rules }] } });
const rule = (over = {}) => ({ type: 'alerting', name: 'my-alert', query: 'up == 0', duration: 600, labels: { severity: 'page' }, annotations: { summary: 'instance down' }, health: 'ok',
  alerts: [{ labels: { alertname: 'my-alert' }, annotations: {}, state: 'firing', activeAt: '2018-07-04T20:27:12.60602144+02:00', value: '1e+00' }], ...over });

test('a firing Prometheus rule becomes one alert with severity, summary, start time and key', () => {
  const [a] = parsePromRules(prom([rule()]));
  assert.deepEqual([a.key, a.name, a.level, a.state, a.summary, a.instances], ['/rules.yaml/example/my-alert', 'my-alert', 'error', 'firing', 'instance down', 1]);
  assert.equal(a.since, Date.parse('2018-07-04T20:27:12.60602144+02:00'));
});

test('pending is kept; inactive, unknown states and recording rules are ignored', () => {
  const r = parsePromRules(prom([
    rule({ name: 'soon', alerts: [{ state: 'pending', activeAt: '2026-01-01T00:00:00Z', labels: {}, annotations: {} }] }),
    rule({ name: 'quiet', alerts: [] }),
    rule({ name: 'odd', alerts: [{ state: 'something-new', labels: {}, annotations: {} }] }),
    { type: 'recording', name: 'job:up', query: 'up', health: 'ok' },
  ]));
  assert.deepEqual(r.map((x) => [x.name, x.state]), [['soon', 'pending']]);
});

test('several firing instances of one rule count as one alert; firing wins over pending', () => {
  const a = { labels: {}, annotations: {}, activeAt: '2026-01-01T00:00:00Z' };
  const [x] = parsePromRules(prom([rule({ alerts: [{ ...a, state: 'firing' }, { ...a, state: 'firing', activeAt: '2025-12-31T00:00:00Z' }, { ...a, state: 'pending' }] })]));
  assert.deepEqual([x.state, x.instances, x.since], ['firing', 2, Date.parse('2025-12-31T00:00:00Z')]);
});

test('junk Prometheus bodies give an empty list and never throw', () => {
  for (const b of [null, undefined, 5, 'x', {}, { data: {} }, { data: { groups: 'x' } }, { data: { groups: [null, { rules: [null, 3] }] } }]) assert.deepEqual(parsePromRules(b), []);
});

const am = (over = {}) => ({ receivers: [{ name: 'homedash' }], fingerprint: 'abc123', startsAt: '2026-11-26T10:00:00Z', updatedAt: '2026-11-26T10:01:00Z', endsAt: '2026-11-26T11:00:00Z',
  annotations: { summary: 'memory high' }, status: { state: 'active', silencedBy: [], inhibitedBy: [], mutedBy: [] }, labels: { alertname: 'HighMemory', severity: 'warning' }, generatorURL: 'http://prom:9090/graph', ...over });

test('active Alertmanager alerts map across; suppressed and unprocessed ones are dropped', () => {
  const r = parseAmAlerts([am(), am({ fingerprint: 'zzz', status: { state: 'suppressed' } }), am({ fingerprint: 'yyy', status: { state: 'unprocessed' } })]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].key, r[0].name, r[0].level, r[0].summary, r[0].url], ['abc123', 'HighMemory', 'warn', 'memory high', 'http://prom:9090/graph']);
  assert.equal(r[0].since, Date.parse('2026-11-26T10:00:00Z'));
});

test('an Alertmanager link that is not http(s) becomes null; junk input is tolerated', () => {
  assert.equal(parseAmAlerts([am({ generatorURL: 'javascript:alert(1)' })])[0].url, null);
  for (const b of [null, {}, 'x', [null, 1, 'a']]) assert.deepEqual(parseAmAlerts(b), []);
});

test('paths read nested values, indexes and the whole answer', () => {
  const v = { data: { items: [{ n: 'a', s: { v: 'ok' } }, { n: 'b' }] } };
  assert.equal(getPath(v, 'data.items[0].s.v'), 'ok');
  assert.equal(getPath(v, 'data.items.1.n'), 'b');
  assert.equal(getPath(v, '$'), v);
  assert.equal(getPath(v, 'data.nope.x'), undefined);
  assert.equal(getPath(v, 'data.items.x'), undefined);
  assert.equal(getPath(null, 'a'), undefined);
});

test('the status map is parsed leniently and unknown targets are dropped', () => {
  assert.deepEqual(parseStatusMap('OK=up, fail = down\nwarn=pending, odd=banana, =up'), { ok: 'up', fail: 'down', warn: 'pending' });
  assert.deepEqual(parseStatusMap(undefined), {});
});

test('a JSON list becomes checks using the map first, sensible defaults second, unknown last', () => {
  const body = { monitors: [{ n: 'web', s: 'ok' }, { n: 'db', s: 'Failed' }, { n: 'cache', s: 'fine', m: 'warm' }, { n: 7, s: 'up' }, { s: 'up' }, { n: 'custom', s: 'green' }] };
  const c = mapJson(body, { items_path: 'monitors', name_path: 'n', status_path: 's', status_map: 'green=up, fine=pending', detail_path: 'm' });
  assert.deepEqual(c.map((x) => [x.name, x.status, x.detail]), [['web', 'up', ''], ['db', 'down', ''], ['cache', 'pending', 'warm'], ['7', 'up', ''], ['custom', 'up', '']]);
});

test('a wrong list path is a clear error, and a huge list is capped', () => {
  assert.throws(() => mapJson({ a: 1 }, { items_path: 'data.items', name_path: 'n', status_path: 's' }), /does not lead to a list/);
  const big = Array.from({ length: 900 }, (_, i) => ({ n: `m${i}`, s: 'up' }));
  assert.equal(mapJson(big, { items_path: '$', name_path: 'n', status_path: 's' }).length, 500);
});
