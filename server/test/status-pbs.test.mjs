import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'hd-status-'));
Object.assign(process.env, {
  DB_PATH: join(dir, 's.db'), PVE_NODE: 'pve',
  STATUS_PAGE: JSON.stringify({ enabled: true, title: 'Lab <status>', message: 'Hello & welcome', tiles: ['dns'], monitors: [] }),
  TILES: JSON.stringify([{ kind: 'http', id: 'dns', name: 'DNS', url: 'http://127.0.0.1:1' }, { kind: 'http', id: 'secret', name: 'Private', url: 'http://127.0.0.1:1' }]),
});
const { parsePbs } = await import('../build/tiles.js');
const { buildStatus, renderHtml, registerStatus } = await import('../build/status.js');
const { toEnv } = await import('../build/cli-schema.js');
const Fastify = (await import('fastify')).default;
after(() => rmSync(dir, { recursive: true, force: true }));

test('pbs: datastore fullness and failed tasks drive the state', () => {
  const GB = 1e9;
  const ok = parsePbs([{ store: 'main', total: 1000 * GB, used: 400 * GB }], []);
  assert.equal(ok.status, 'ok'); assert.equal(ok.stats[0].value, '40% full');
  const bad = parsePbs([{ store: 'a', total: 100, used: 96 }, { store: 'b', total: 100, used: 10 }], [{ upid: 'x' }]);
  assert.equal(bad.status, 'warn'); assert.equal(bad.stats[0].tone, 'bad'); assert.equal(bad.stats.find((s) => s.label.startsWith('Failed')).value, 1);
  const soon = parsePbs([{ store: 'c', total: 100, used: 50, 'estimated-full-date': Math.floor(Date.now() / 1000) + 5 * 86400 }]);
  assert.match(soon.stats.at(-1).value, /c/);
});

test('status: only listed items appear, the worst one sets the banner', () => {
  const want = { tiles: ['a', 'b'], monitors: ['Web'], title: 'T', message: '' };
  const d = buildStatus(want, [{ id: 'a', name: 'A', state: 'ok' }, { id: 'b', name: 'B', state: 'warn' }, { id: 'c', name: 'C', state: 'down' }], [{ name: 'Web', status: 'up' }, { name: 'Other', status: 'down' }]);
  assert.deepEqual(d.items.map((i) => [i.name, i.status]), [['A', 'operational'], ['B', 'degraded'], ['Web', 'operational']]);
  assert.equal(d.overall, 'degraded');
  assert.equal(buildStatus({ ...want, tiles: ['*'] }, [{ id: 'c', name: 'C', state: 'down' }], []).overall, 'outage');
  assert.equal(buildStatus({ ...want, tiles: [], monitors: [] }, [{ id: 'c', name: 'C', state: 'down' }], []).overall, 'unknown');
});

test('html is escaped and carries no script', () => {
  const html = renderHtml({ title: '<img onerror=x>', message: '"q" & <b>', overall: 'operational', items: [{ name: '<script>x</script>', status: 'outage' }], updatedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(!html.includes('<script') && !html.includes('<img') && !html.includes('<b>'));
  assert.match(html, /&#60;script&#62;/);
});

test('/status serves only what is listed, with no secrets, and is rate limited', async () => {
  const app = Fastify(); registerStatus(app); await app.ready();
  const j = (await app.inject('/status.json')).json();
  assert.deepEqual(j.items.map((i) => i.name), ['DNS']); assert.equal(j.title, 'Lab <status>');
  const page = await app.inject('/status');
  assert.match(page.headers['content-type'], /text\/html/); assert.ok(!page.body.includes('Private') && !page.body.includes('127.0.0.1'));
  assert.match(page.body, /Lab &#60;status&#62;/);
  let last;
  for (let i = 0; i < 70; i++) last = await app.inject('/status.json');
  assert.equal(last.statusCode, 429);
  await app.close();
});

test('yaml: status_page validated; pbs tile needs a token', () => {
  assert.ok(toEnv({ status_page: { enabled: true } }, {}, {}).problems.some((p) => /shows nothing|lists no/.test(p) || /would show nothing/.test(p)));
  const ok = toEnv({ status_page: { enabled: true, tiles: ['*'] }, tiles: [{ kind: 'pbs', url: 'http://pbs:8007', token: 'u@pbs!t:s' }] }, {}, {});
  assert.deepEqual(ok.problems, []); assert.equal(JSON.parse(ok.env.STATUS_PAGE).enabled, true);
  assert.ok(toEnv({ tiles: [{ kind: 'pbs', url: 'http://pbs:8007' }] }, {}, {}).problems.some((p) => /pbs needs token/.test(p)));
});
