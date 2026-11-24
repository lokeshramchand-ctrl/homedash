// The real alert pipeline in-process: alert() -> silences -> routes -> channels, against mock services.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const got = [];
let http, dir, mod;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Requests received since the last call, as "service METHOD path action". */
const drain = async () => { await sleep(250); const out = got.splice(0); return out; };
const svc = (r) => r.url.startsWith('/pd') ? 'pagerduty' : r.url.startsWith('/og') ? 'opsgenie' : r.url.startsWith('/hook') ? 'webhook' : r.url.startsWith('/gotify') ? 'gotify' : 'other';

before(async () => {
  http = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: b ? JSON.parse(b) : null }); res.end('{}'); });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${http.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'hd-alerts-'));
  Object.assign(process.env, {
    DB_PATH: join(dir, 'a.db'), WEBHOOK_URL: `${base}/hook`, GOTIFY_URL: `${base}/gotify`, GOTIFY_TOKEN: 'k',
    PAGERDUTY_ROUTING_KEY: 'r'.repeat(32), PAGERDUTY_URL: `${base}/pd`, OPSGENIE_API_KEY: 'o'.repeat(32), OPSGENIE_URL: `${base}/og`, PVE_NODE: 'pve',
  });
  const db = await import('../build/db.js');
  db.connectDb();
  mod = { db, notify: await import('../build/notify.js'), rules: await import('../build/alertrules.js') };
});
after(() => { http.close(); try { mod.db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('an error opens incidents once; warnings and info do not page', async () => {
  mod.notify.alert('host', 'error', 'DOWN · Proxmox host', 'API unreachable', 'pve|api');
  const r = await drain();
  const by = (s) => r.filter((x) => svc(x) === s);
  assert.equal(by('webhook').length, 1);
  assert.equal(by('gotify').length, 1);
  const pd = by('pagerduty')[0].body;
  assert.equal(pd.event_action, 'trigger'); assert.equal(pd.dedup_key, 'pve|api'); assert.equal(pd.payload.severity, 'critical');
  const og = by('opsgenie')[0];
  assert.equal(og.url, '/og/v2/alerts'); assert.equal(og.body.alias, 'pve|api'); assert.equal(og.body.priority, 'P2');
  assert.match(og.headers.authorization, /^GenieKey /);

  mod.notify.alert('host', 'warn', 'Warning · host', 'disk filling', 'disk|warn');
  const w = await drain();
  assert.deepEqual([...new Set(w.map(svc))].sort(), ['gotify', 'webhook']); // incident tools default to errors only
});

test('a recovery closes the incident even though it is only "info"', async () => {
  mod.notify.alert('host', 'info', 'Recovered · Proxmox host', 'API reachable again', 'pve|api|ok');
  const r = await drain();
  const pd = r.find((x) => svc(x) === 'pagerduty').body;
  assert.equal(pd.event_action, 'resolve'); assert.equal(pd.dedup_key, 'pve|api');
  const og = r.find((x) => svc(x) === 'opsgenie');
  assert.equal(og.url, '/og/v2/alerts/pve%7Capi/close?identifierType=alias');
});

test('a test from the UI opens and closes a throw-away incident', async () => {
  const { CHANNELS } = await import('../build/channels.js');
  await CHANNELS.find((c) => c.id === 'pagerduty').send({ title: 't', message: 't', level: 'info', category: 'app', priority: 3, tags: [], test: true });
  const r = (await drain()).filter((x) => svc(x) === 'pagerduty').map((x) => x.body.event_action);
  assert.deepEqual(r, ['trigger', 'resolve']);
});

test('a maintenance window holds alerts back but still closes incidents', async () => {
  const id = mod.db.saveSilence(null, { name: 'Patching', reason: '', startsAt: Date.now() - 1000, endsAt: Date.now() + 3600_000, categories: ['tasks'], contains: '', weekly: null, createdBy: 'test' });
  mod.notify.alert('tasks', 'error', 'Task failed · backup', 'exit 1', 'task|1');
  assert.deepEqual(await drain(), [], 'silenced: nothing is sent');
  mod.notify.alert('host', 'error', 'DOWN · other', 'unrelated category is not silenced', 'host|x');
  assert.ok((await drain()).length > 0);
  // a recovery for an incident that opened before the window still reaches the incident tools
  mod.notify.alert('tasks', 'info', 'Recovered', 'ok', 'task|1|ok');
  assert.deepEqual([...new Set((await drain()).map(svc))].sort(), ['opsgenie', 'pagerduty']);
  mod.db.deleteSilence(id);
  mod.notify.alert('tasks', 'error', 'Task failed · again', 'exit 2', 'task|2');
  assert.ok((await drain()).length > 0, 'delivers again once the window is gone');
});

test('text matching in silences', async () => {
  const id = mod.db.saveSilence(null, { name: 'Only the nightly job', reason: '', startsAt: Date.now() - 1000, endsAt: Date.now() + 3600_000, categories: [], contains: 'nightly', weekly: null, createdBy: 'test' });
  mod.notify.alert('tasks', 'error', 'Task failed · nightly backup', 'x', 'task|n1');
  assert.deepEqual(await drain(), []);
  mod.notify.alert('tasks', 'error', 'Task failed · other backup', 'x', 'task|n2');
  assert.ok((await drain()).length > 0);
  mod.db.deleteSilence(id);
});

test('routes choose the channels; unmatched alerts keep the default behaviour', async () => {
  const id = mod.db.saveRoute(null, { name: 'Disk problems to the webhook only', enabled: true, categories: ['disks'], minLevel: 'warn', contains: '', channels: ['webhook'], weekly: null });
  mod.notify.alert('disks', 'error', 'Disk health FAILED', '/dev/sda', 'disk|sda');
  assert.deepEqual([...new Set((await drain()).map(svc))], ['webhook']);
  mod.notify.alert('services', 'error', 'Service down · pvedaemon', 'x', 'svc|pvedaemon');
  assert.deepEqual([...new Set((await drain()).map(svc))].sort(), ['gotify', 'opsgenie', 'pagerduty', 'webhook']);
  // a disabled route does nothing
  mod.db.saveRoute(id, { name: 'x', enabled: false, categories: ['disks'], minLevel: 'warn', contains: '', channels: ['webhook'], weekly: null });
  mod.notify.alert('disks', 'error', 'Disk health FAILED', '/dev/sdb', 'disk|sdb');
  assert.ok((await drain()).map(svc).includes('pagerduty'));
  mod.db.deleteRoute(id);
});

test('event alerts get stable keys, so a monitor recovery closes its own incident', async () => {
  mod.notify.alertFromEvent('error', 'monitor', 'Nextcloud: up → down');
  const open = (await drain()).find((x) => svc(x) === 'pagerduty').body;
  assert.equal(open.dedup_key, 'mon|Nextcloud');
  mod.notify.alertFromEvent('info', 'monitor', 'Nextcloud: down → up');
  const close = (await drain()).find((x) => svc(x) === 'pagerduty').body;
  assert.deepEqual([close.event_action, close.dedup_key], ['resolve', 'mon|Nextcloud']);
});

test('weekly windows, including ones that run past midnight', () => {
  const { inWeekly } = mod.rules;
  const at = (iso) => new Date(iso); // local time
  const sat2230 = { days: [6], start: '22:00', minutes: 180 }; // Saturday 22:00 -> Sunday 01:00
  assert.equal(inWeekly(sat2230, at('2026-11-21T22:30:00')), true);  // Saturday 22:30
  assert.equal(inWeekly(sat2230, at('2026-11-22T00:30:00')), true);  // Sunday 00:30, still the Saturday window
  assert.equal(inWeekly(sat2230, at('2026-11-22T01:30:00')), false);
  assert.equal(inWeekly(sat2230, at('2026-11-20T22:30:00')), false); // Friday
  assert.equal(inWeekly(null, at('2026-11-20T12:00:00')), true);
});
