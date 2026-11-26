// The merged monitoring list through the real alert pipeline (alert -> channels), against a mock webhook channel.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const got = [];
let http, dir, db, watch, engineMod;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = async () => { await sleep(250); return got.splice(0).map((r) => r.body?.title ?? r.body?.message ?? JSON.stringify(r.body)); };

before(async () => {
  http = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { got.push({ url: req.url, body: b ? JSON.parse(b) : null }); res.end('{}'); });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  dir = mkdtempSync(join(tmpdir(), 'hd-mon-'));
  Object.assign(process.env, { DB_PATH: join(dir, 'm.db'), WEBHOOK_URL: `http://127.0.0.1:${http.address().port}/hook`, PVE_NODE: 'pve' });
  db = await import('../build/db.js');
  db.connectDb();
  watch = await import('../build/monitoring/watch.js');
  engineMod = await import('../build/monitoring/engine.js');
});
after(() => { http.close(); try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('alerts raise once, a failing source keeps them open, unreachable raises once, and recovery closes everything', async () => {
  let gFail = false, gAlerts = [{ key: 'u1', name: 'Disk', level: 'error', state: 'firing', since: 1, summary: 'root 93%', instances: 1, url: null }];
  const g = { kind: 'g', label: 'Grafana', raisesChecks: true, configured: () => true, poll: async () => { if (gFail) throw new Error('timeout'); return { checks: [], alerts: gAlerts }; } };
  // A Kuma-like source: its down check is shown but must not alert here (it already alerts through the event path).
  const k = { kind: 'kuma', label: 'Uptime Kuma', raisesChecks: false, configured: () => true, poll: async () => ({ checks: [{ key: 'site', name: 'site', status: 'down', since: 1, detail: 'Monitor is down', url: null }], alerts: [] }) };
  const engine = engineMod.createEngine(() => [{ id: 'g', provider: g }, { id: 'kuma', provider: k }]);
  const raises = (kind) => kind === 'g';

  await watch.watchMonitoring(engine, raises);
  assert.deepEqual(await drain(), ['Grafana alert: Disk'], 'one alert for the Grafana alert and none for the Kuma down check');

  await watch.watchMonitoring(engine, raises);
  assert.deepEqual(await drain(), [], 'the same problem on the next cycle is not sent again');

  gFail = true;
  await watch.watchMonitoring(engine, raises);
  assert.deepEqual(await drain(), [], 'one failed read changes nothing: no recovery, no unreachable yet');

  await watch.watchMonitoring(engine, raises);
  assert.deepEqual(await drain(), ['Grafana is unreachable'], 'two failures in a row raise one unreachable problem; the stale alert stays open');

  await watch.watchMonitoring(engine, raises);
  assert.deepEqual(await drain(), [], 'still failing: nothing new');

  gFail = false; gAlerts = [];
  await watch.watchMonitoring(engine, raises);
  const closed = (await drain()).sort();
  assert.deepEqual(closed, ['Recovered · Grafana alert: Disk', 'Recovered · Grafana is unreachable']);
});

test('the timeline records raise and recover lines with source "monitor", and no alert loop is created', async () => {
  const rows = db.listEvents({ source: 'monitor', limit: 20 }).map((r) => r.message);
  assert.ok(rows.some((m) => /Grafana alert: Disk/.test(m)));
  assert.ok(rows.some((m) => /Recovered: Grafana alert: Disk/.test(m)));
  assert.deepEqual(await drain(), [], 'writing timeline lines sent nothing extra');
});
