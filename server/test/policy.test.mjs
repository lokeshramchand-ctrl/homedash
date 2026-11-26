import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'hd-policy-'));
Object.assign(process.env, { DB_PATH: join(dir, 'p.db'), PVE_NODE: 'pve', PVE_URL: 'http://127.0.0.1:1', PVE_TOKEN_ID: 'a@pve!t', PVE_TOKEN_SECRET: 's' });
const db = await import('../build/db.js'); db.connectDb();
const { normalizePolicy, parseDays } = await import('../build/policy-schema.js');
const { applyPolicy, assertEditable } = await import('../build/policy.js');
const { CATEGORIES } = await import('../build/notify.js');
const { CHANNELS } = await import('../build/channels.js');
const { POLICY_CATEGORIES, POLICY_CHANNELS, toEnv } = await import('../build/cli-schema.js');
after(() => { try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const allowed = { categories: CATEGORIES, channels: CHANNELS.map((c) => c.id) };
const RAW = {
  scenes: [{ name: 'Movie night', steps: [{ vmid: 101, action: 'stop' }, { vmid: 105, action: 'start', wait_seconds: 30 }] }],
  schedules: [{ name: 'Nightly', scene: 'Movie night', days: 'weekdays', time: '23:30' }, { name: 'Morning', vmid: 101, action: 'start', days: ['sat', 'sun'], time: '08:00' }],
  alert_routes: [{ name: 'Pager', min_level: 'error', categories: ['host'], channels: ['ntfy'] }],
  maintenance: [{ name: 'Patching', weekly: { days: ['sun'], start: '22:00', minutes: 120 }, categories: ['tasks'] }],
};

test('the CLI lists match the server lists', () => {
  assert.deepEqual([...POLICY_CATEGORIES].sort(), [...CATEGORIES].sort());
  assert.deepEqual([...POLICY_CHANNELS].sort(), allowed.channels.slice().sort());
});

test('days parse names, numbers and groups', () => {
  assert.deepEqual(parseDays('weekdays'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays(['Sat', 'sunday']), [0, 6]);
  assert.deepEqual(parseDays([1, '3']), [1, 3]);
  assert.equal(parseDays(['funday']), null);
});

test('validation reports every problem with its location', () => {
  const { problems } = normalizePolicy({
    scenes: [{ name: 'A', steps: [] }, { name: 'A', steps: [{ vmid: 1, action: 'explode' }] }],
    schedules: [{ name: 'S', scene: 'Missing', days: ['x'], time: '25:00' }, { name: 'T', days: 'daily', time: '01:00' }],
    alert_routes: [{ name: 'R', channels: ['carrier-pigeon'], categories: ['nope'] }],
    maintenance: [{ name: 'M' }], extra: 1,
  }, allowed);
  const text = problems.join('\n');
  for (const frag of ['policy.extra', 'steps: between 1 and 30', 'duplicate name "A"', 'policy.schedules[0].days', 'either scene', 'unknown channel "carrier-pigeon"', 'unknown category "nope"', 'weekly: { days, start, minutes }']) assert.match(text, new RegExp(frag.replace(/[[\]{}()*+?.\\^$|]/g, '\\$&')), frag);
});

test('apply creates rows, is idempotent, and marks them managed', () => {
  const { policy, problems } = normalizePolicy(RAW, allowed);
  assert.deepEqual(problems, []);
  const a = applyPolicy(policy);
  assert.deepEqual([a.created, a.updated, a.removed, a.skipped.length], [5, 0, 0, 0]);
  const b = applyPolicy(policy);
  assert.deepEqual([b.created, b.updated, b.removed], [0, 5, 0]);
  assert.equal(db.listScenes().length, 1); assert.equal(db.listSchedules().length, 2); assert.equal(db.listRoutes().length, 1); assert.equal(db.listSilences().length, 1);
  const nightly = db.listSchedules().find((s) => s.name === 'Nightly');
  assert.equal(nightly.sceneId, db.listScenes()[0].id); assert.deepEqual(nightly.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(db.listSilences()[0].weekly, { days: [0], start: '22:00', minutes: 120 });
});

test('managed rows cannot be edited through the API; UI-made rows can', () => {
  const sc = db.listScenes()[0];
  assert.throws(() => assertEditable('scenes', sc.id), (e) => e.status === 409 && e.code === 'MANAGED');
  const mine = db.saveScene(null, 'Mine', [{ vmid: 5, action: 'start', waitSeconds: 0, continueOnError: false }], null);
  assert.doesNotThrow(() => assertEditable('scenes', mine));
  // the lists say which rows are declared in the file, so the UI can show a badge instead of buttons that would fail
  assert.equal(db.listScenes().find((x) => x.id === sc.id).managed, true);
  assert.equal(db.listScenes().find((x) => x.id === mine).managed, false);
  assert.ok(db.listSchedules().every((x) => x.managed === true));
  assert.equal(db.listRoutes()[0].managed, true);
  assert.equal(db.listSilences()[0].managed, true);
});

test('changes in the file update rows, and removed entries disappear; UI rows are never touched', () => {
  const raw = structuredClone(RAW);
  raw.scenes[0].steps = [{ vmid: 101, action: 'shutdown' }];
  raw.schedules = [raw.schedules[0]];
  raw.alert_routes = [];
  delete raw.maintenance;
  const { policy } = normalizePolicy(raw, allowed);
  const r = applyPolicy(policy);
  assert.deepEqual([r.created, r.removed], [0, 3]); // Morning schedule, route, window
  assert.equal(db.listScenes().find((s) => s.name === 'Movie night').steps[0].action, 'shutdown');
  assert.deepEqual(db.listSchedules().map((s) => s.name), ['Nightly']);
  assert.equal(db.listRoutes().length, 0);
  assert.ok(db.listScenes().some((s) => s.name === 'Mine'));
  const gone = applyPolicy({ scenes: [], schedules: [], routes: [], maintenance: [] });
  assert.equal(gone.removed, 2);
  assert.deepEqual(db.listScenes().map((s) => s.name), ['Mine']);
});

test('a name already used by a UI-made row is skipped, not overwritten', () => {
  const { policy } = normalizePolicy({ scenes: [{ name: 'Mine', steps: [{ vmid: 9, action: 'stop' }] }] }, allowed);
  const r = applyPolicy(policy);
  assert.equal(r.created, 0); assert.match(r.skipped[0], /already exists in the UI/);
  assert.equal(db.listScenes().find((s) => s.name === 'Mine').steps[0].vmid, 5);
});

test('yaml policy flows into POLICY and problems surface in the CLI check', () => {
  const ok = toEnv({ policy: RAW }, {}, {});
  assert.deepEqual(ok.problems, []);
  assert.equal(JSON.parse(ok.env.POLICY).scenes[0].steps[1].waitSeconds, 30);
  assert.ok(toEnv({ policy: { scenes: [{ name: 'x', steps: [] }] } }, {}, {}).problems.length > 0);
});
