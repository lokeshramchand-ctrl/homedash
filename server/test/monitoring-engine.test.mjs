import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine, problemsFrom } from '../build/monitoring/engine.js';

const provider = (kind, over = {}) => ({ kind, label: kind.toUpperCase(), raisesChecks: true, configured: () => true, poll: async () => ({ checks: [], alerts: [] }), ...over });
const alert = (name, over = {}) => ({ key: name, name, level: 'warn', state: 'firing', since: 1000, summary: `${name} summary`, instances: 1, url: null, ...over });
const check = (name, status, over = {}) => ({ key: name, name, status, since: 1000, detail: '', url: null, ...over });

test('checks and alerts from several providers are merged and tagged with their source', async () => {
  const e = createEngine(() => [
    { id: 'a', provider: provider('a', { poll: async () => ({ checks: [check('web', 'up')], alerts: [alert('disk')] }) }) },
    { id: 'b', provider: provider('b', { poll: async () => ({ checks: [check('db', 'down')], alerts: [] }) }) },
  ]);
  await e.pollAll();
  const m = e.merged();
  assert.deepEqual(m.sources.map((s) => [s.id, s.ok, s.checks, s.alerts]), [['a', true, 1, 1], ['b', true, 1, 0]]);
  assert.deepEqual(m.checks.map((c) => `${c.source}:${c.name}`).sort(), ['a:web', 'b:db']);
  assert.deepEqual(m.alerts.map((x) => x.source), ['a']);
});

test('a failing source keeps its last good data, marked stale, and never looks like an empty all-clear', async () => {
  let fail = false;
  const e = createEngine(() => [{ id: 'a', provider: provider('a', { poll: async () => { if (fail) throw new Error('boom'); return { checks: [check('web', 'down')], alerts: [alert('disk')] }; } }) }]);
  await e.pollAll();
  const ok = e.merged().sources[0];
  fail = true;
  await e.pollAll();
  const m = e.merged();
  assert.equal(m.sources[0].ok, false);
  assert.equal(m.sources[0].stale, true);
  assert.equal(m.sources[0].error, 'boom');
  assert.equal(m.sources[0].checkedAt, ok.checkedAt);
  assert.equal(m.checks.length, 1);
  assert.equal(m.alerts.length, 1);
});

test('a source that has never worked is not stale and has no data', async () => {
  const e = createEngine(() => [{ id: 'a', provider: provider('a', { poll: async () => { throw new Error('no route'); } }) }]);
  await e.pollAll();
  const s = e.merged().sources[0];
  assert.deepEqual([s.ok, s.stale, s.checks, s.alerts, s.error], [false, false, 0, 0, 'no route']);
});

test('one failing provider does not block another', async () => {
  const e = createEngine(() => [
    { id: 'a', provider: provider('a', { poll: async () => { throw new Error('x'); } }) },
    { id: 'b', provider: provider('b', { poll: async () => ({ checks: [check('ok', 'up')], alerts: [] }) }) },
  ]);
  await e.pollAll();
  assert.equal(e.merged().checks.length, 1);
  assert.equal(e.merged().sources.find((s) => s.id === 'b').ok, true);
});

test('unconfigured providers are skipped and sources that disappear are forgotten', async () => {
  let list = [{ id: 'a', provider: provider('a', { configured: () => false }) }, { id: 'b', provider: provider('b') }];
  const e = createEngine(() => list);
  await e.pollAll();
  assert.deepEqual(e.merged().sources.map((s) => s.id), ['b']);
  list = [];
  await e.pollAll();
  assert.deepEqual(e.merged().sources, []);
});

test('consecutive failures are counted and reset by a success', async () => {
  let fail = true;
  const e = createEngine(() => [{ id: 'a', provider: provider('a', { poll: async () => { if (fail) throw new Error('x'); return { checks: [], alerts: [] }; } }) }]);
  await e.pollAll(); assert.equal(e.failures('a'), 1);
  await e.pollAll(); assert.equal(e.failures('a'), 2);
  fail = false; await e.pollAll(); assert.equal(e.failures('a'), 0);
});

const merged = (over) => ({ sources: [], checks: [], alerts: [], checkedAt: 0, ...over });
const src = (id, label, ok = true, error = null) => ({ id, kind: id, label, managed: 'config', ok, stale: false, error, checkedAt: 1, checks: 0, alerts: 0 });

test('firing alerts become problems, pending ones do not; error severity maps to error', () => {
  const m = merged({ sources: [src('g', 'Grafana')], alerts: [{ ...alert('Disk', { level: 'error' }), source: 'g' }, { ...alert('Load'), source: 'g' }, { ...alert('Soon', { state: 'pending' }), source: 'g' }] });
  const p = problemsFrom(m, () => true, () => 0);
  assert.deepEqual(p.map((x) => [x.key, x.level, x.title]), [['g|Disk', 'error', 'Grafana alert: Disk'], ['g|Load', 'warn', 'Grafana alert: Load']]);
  assert.match(p[0].text, /Disk summary/);
});

test('down checks become problems only for providers that raise their checks', () => {
  const m = merged({ sources: [src('x', 'Foo'), src('kuma', 'Uptime Kuma')], checks: [{ ...check('api', 'down'), source: 'x' }, { ...check('site', 'down'), source: 'kuma' }, { ...check('ok', 'up'), source: 'x' }, { ...check('slow', 'pending'), source: 'x' }] });
  const p = problemsFrom(m, (kind) => kind === 'x', () => 0);
  assert.deepEqual(p.map((x) => [x.key, x.title]), [['x|api', 'Foo down: api']]);
});

test('an unreachable source is a problem only after two failures in a row', () => {
  const m = merged({ sources: [src('g', 'Grafana', false, 'timeout')] });
  assert.deepEqual(problemsFrom(m, () => true, () => 1), []);
  const p = problemsFrom(m, () => true, () => 2);
  assert.deepEqual(p.map((x) => [x.key, x.level, x.title]), [['src|g', 'warn', 'Grafana is unreachable']]);
  assert.match(p[0].text, /timeout/);
});
