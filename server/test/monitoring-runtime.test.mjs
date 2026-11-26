import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRuntimeConfig, isShadowed } from '../build/monitoring/runtime.js';
import { createEngine } from '../build/monitoring/engine.js';

const target = () => ({ kumaUrl: '', kumaApiKey: '', grafanaUrl: '', grafanaPublicUrl: '', grafanaToken: '', grafanaDsUid: '' });
const src = (kind, config, secrets, enabled = true) => ({ id: `src-${kind}`, kind, name: kind, config, secrets, secretsSet: Object.keys(secrets), enabled, intervalS: 60, ttlHours: 168, createdAt: 1, createdBy: 'a' });
const none = { kuma: false, grafana: false };

test('a Kuma and a Grafana source fill the live config, and removing them clears it', () => {
  const t = target();
  const sources = [src('kuma', { url: 'http://kuma.lan:3001/' }, { api_key: 'kk' }), src('grafana', { url: 'http://g.lan:3000', public_url: 'https://grafana.home', datasource_uid: 'prom' }, { token: 'gt' })];
  const first = applyRuntimeConfig(sources, t, none);
  assert.deepEqual(first, { kumaChanged: true, grafanaChanged: true });
  assert.deepEqual(t, { kumaUrl: 'http://kuma.lan:3001', kumaApiKey: 'kk', grafanaUrl: 'http://g.lan:3000', grafanaPublicUrl: 'https://grafana.home', grafanaToken: 'gt', grafanaDsUid: 'prom' });
  assert.deepEqual(applyRuntimeConfig(sources, t, none), { kumaChanged: false, grafanaChanged: false }, 'applying twice changes nothing');
  assert.deepEqual(applyRuntimeConfig([], t, none), { kumaChanged: true, grafanaChanged: true });
  assert.deepEqual(t, target());
});

test('the public address falls back to the address; a disabled source is not applied', () => {
  const t = target();
  applyRuntimeConfig([src('grafana', { url: 'http://g.lan:3000' }, { token: 'gt' })], t, none);
  assert.equal(t.grafanaPublicUrl, 'http://g.lan:3000');
  applyRuntimeConfig([src('grafana', { url: 'http://g.lan:3000' }, { token: 'gt' }, false)], t, none);
  assert.equal(t.grafanaUrl, '');
});

test('what YAML or the environment configured is never overwritten, and its UI twin is shadowed', () => {
  const t = { ...target(), kumaUrl: 'http://yaml-kuma', kumaApiKey: 'yamlkey' };
  const r = applyRuntimeConfig([src('kuma', { url: 'http://ui-kuma' }, { api_key: 'uikey' })], t, { kuma: true, grafana: false });
  assert.equal(r.kumaChanged, false);
  assert.equal(t.kumaUrl, 'http://yaml-kuma');
  assert.equal(isShadowed('kuma', { kuma: true, grafana: false }), true);
  assert.equal(isShadowed('grafana', { kuma: true, grafana: false }), false);
  assert.equal(isShadowed('prometheus', { kuma: true, grafana: true }), false);
});

const prov = (kind, polls) => ({ kind, label: kind, raisesChecks: true, configured: () => true, poll: async () => { polls.n++; return { checks: [], alerts: [] }; } });

test('a source is only read again once its interval has passed', async () => {
  let t = 1_000_000; const a = { n: 0 }, b = { n: 0 }, c = { n: 0 };
  const e = createEngine(() => [{ id: 'a', provider: prov('a', a), intervalS: 60 }, { id: 'b', provider: prov('b', b), intervalS: 15 }, { id: 'c', provider: prov('c', c) }], () => t);
  await e.pollAll();
  t += 10_000; await e.pollAll();
  assert.deepEqual([a.n, b.n, c.n], [1, 1, 2], 'after 10 s only the no-interval source ran again');
  t += 10_000; await e.pollAll();
  assert.deepEqual([a.n, b.n, c.n], [1, 2, 3], 'after 20 s the 15 s source is due');
  t += 45_000; await e.pollAll();
  assert.deepEqual([a.n, b.n, c.n], [2, 3, 4], 'after 65 s the 60 s source is due');
});

test('a person\'s own name and the managed marker reach the merged sources', async () => {
  const e = createEngine(() => [{ id: 'src-1', provider: prov('prometheus', { n: 0 }), label: 'Prod Prometheus', managed: 'ui' }]);
  await e.pollAll();
  const s = e.merged().sources[0];
  assert.deepEqual([s.label, s.managed, s.kind], ['Prod Prometheus', 'ui', 'prometheus']);
});
