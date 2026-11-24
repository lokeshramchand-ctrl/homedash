import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

let srv, dir, tiles, db, base, mode = 'up';
await (async () => {
  srv = createServer((req, res) => {
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (mode === 'down') return json({}, 500);
    if (req.url === '/api/auth') return json({ session: { valid: true, sid: 'S1', validity: 300 } });
    if (req.url === '/api/stats/summary') return req.headers.sid === 'S1' ? json({ queries: { total: 100, blocked: 10, percent_blocked: 10 }, gravity: { domains_being_blocked: 5 } }) : json({}, 401);
    if (req.url === '/api/dns/blocking') return json({ blocking: 'enabled' });
    if (req.url.startsWith('/containers/json')) return json([{ State: 'running', Status: 'Up' }]);
    if (req.url === '/status') return json({ data: { n: 3 } });
    json({}, 404);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'hd-tiles-'));
  Object.assign(process.env, {
    DB_PATH: join(dir, 't.db'), PVE_NODE: 'pve',
    TILES: JSON.stringify([
      { kind: 'pihole', name: 'DNS', url: base, password: 'pw' }, { kind: 'docker', name: 'Docker', url: base },
      { kind: 'http', name: 'Svc', url: base, path: '/status', stats: [{ label: 'N', path: 'data.n' }] }, { kind: 'bogus', url: base },
    ]),
  });
  db = await import('../build/db.js'); db.connectDb();
})();
after(() => { srv.close(); try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });


tiles = await import('../build/tiles.js');
const { jsonPath, parseDocker, parseGeneric, parseHomeAssistant, parseJellyfin, parseNpm, parsePihole, parsePortainer } = tiles;
const { toEnv } = await import('../build/cli-schema.js');

test('jsonPath', () => {
  assert.equal(jsonPath({ a: { b: [{ c: 5 }] } }, 'a.b[0].c'), 5);
  assert.equal(jsonPath({ a: 1 }, 'a.b'), undefined);
});

test('docker: counts and flags unhealthy / crashed containers', () => {
  const p = parseDocker([
    { State: 'running', Status: 'Up 2 hours' }, { State: 'running', Status: 'Up 1 hour (unhealthy)' },
    { State: 'exited', Status: 'Exited (0) 3 days ago' }, { State: 'exited', Status: 'Exited (137) 1 hour ago' }, { State: 'restarting', Status: 'Restarting (1) 5 seconds ago' },
  ]);
  const by = Object.fromEntries(p.stats.map((s) => [s.label, s.value]));
  assert.deepEqual([by.Running, by.Stopped, by.Unhealthy, by.Restarting, by.Crashed], [2, 2, 1, 1, 1]);
  assert.equal(p.status, 'warn');
  assert.equal(parseDocker([{ State: 'running', Status: 'Up 1 hour' }]).status, 'ok');
});

test('portainer: offline environment warns', () => {
  const p = parsePortainer([{ Status: 1, Snapshots: [{ RunningContainerCount: 4, StoppedContainerCount: 1, UnhealthyContainerCount: 0 }] }, { Status: 2, Snapshots: [] }]);
  assert.equal(p.status, 'warn');
  assert.equal(p.stats.find((s) => s.label === 'Running').value, 4);
});

test('pihole: v6 and v5 shapes, blocking disabled warns', () => {
  const v6 = parsePihole({ queries: { total: 12345, blocked: 2000, percent_blocked: 16.2 }, gravity: { domains_being_blocked: 90000 } }, 'enabled');
  assert.equal(v6.status, 'ok'); assert.equal(v6.stats.find((s) => s.label === 'Queries').value, '12,345');
  const v5 = parsePihole({ dns_queries_today: 10, ads_blocked_today: 5, ads_percentage_today: 50, domains_being_blocked: 7, status: 'disabled' });
  assert.equal(v5.status, 'warn'); assert.equal(v5.summary, '50.0% blocked today');
});

test('npm: certificate expiry drives the warning', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const soon = parseNpm({ proxy: 3, redirection: 0, stream: 0, dead: 1 }, [{ expires_on: '2026-06-05 00:00:00' }, { expires_on: '2027-01-01 00:00:00' }], now);
  assert.equal(soon.status, 'warn'); assert.equal(soon.stats.find((s) => s.label === 'Next expiry').value, '4 d');
  assert.equal(parseNpm({ proxy: 1 }, [{ expires_on: '2027-01-01 00:00:00' }], now).status, 'ok');
  assert.equal(parseNpm({ proxy: 1 }, [], now).status, 'ok');
});

test('jellyfin and home assistant', () => {
  const j = parseJellyfin({ Version: '10.9', ServerName: 'x' }, [{ NowPlayingItem: {} }, {}], { MovieCount: 1200, SeriesCount: 3, EpisodeCount: 40 });
  assert.equal(j.summary, '1 stream'); assert.equal(j.stats.find((s) => s.label === 'Movies').value, '1,200');
  assert.equal(parseJellyfin({ Version: '10.9', ServerName: 'Home' }).summary, 'Home');
  const h = parseHomeAssistant({ version: '2026.1', state: 'RUNNING' }, [{ state: 'on' }, { state: 'unavailable' }]);
  assert.equal(h.stats.find((s) => s.label === 'Unavailable').value, 1);
  assert.equal(parseHomeAssistant({ state: 'NOT_RUNNING' }, []).status, 'warn');
});

test('generic http reads json paths', () => {
  const p = parseGeneric({ a: { b: 7 }, s: 'x' }, [{ label: 'B', path: 'a.b' }, { label: 'Missing', path: 'q' }]);
  assert.deepEqual(p.stats.map((s) => s.value), ['7', '–']);
});

test('yaml tiles render into TILES with secrets expanded, and problems are reported', () => {
  const ok = toEnv({ tiles: [{ kind: 'pihole', name: 'Pi-hole', url: 'http://10.0.0.2', password: '${PIHOLE_PW}' }, { kind: 'docker', url: 'http://10.0.0.3:2375' }] }, { PIHOLE_PW: 'pw' }, {});
  assert.deepEqual(ok.problems, []);
  const tiles = JSON.parse(ok.env.TILES);
  assert.equal(tiles[0].password, 'pw'); assert.equal(tiles[0].id, 'pi-hole'); assert.equal(tiles[1].id, 'docker');
  const bad = toEnv({ tiles: [{ kind: 'nope', url: 'x' }, { kind: 'npm', url: 'http://a' }, { kind: 'portainer', url: 'http://p', token: '${MISSING}' }] }, {}, {});
  assert.ok(bad.problems.some((p) => /kind must be one of/.test(p)));
  assert.ok(bad.problems.some((p) => /npm needs username/.test(p)));
  assert.ok(bad.problems.some((p) => /MISSING/.test(p)));
});

test('tiles are polled through their providers; the public view hides secrets; bad entries are skipped', async () => {
  const { cfg } = await import('../build/config.js');
  assert.equal(cfg.tiles.length, 3);
  for (const t of cfg.tiles) await tiles.pollTile(t);
  const list = tiles.publicTiles();
  assert.deepEqual(list.map((t) => t.state), ['ok', 'ok', 'ok']);
  assert.equal(list[0].stats.find((s) => s.label === 'Queries').value, '100');
  assert.equal(list[2].stats[0].value, '3');
  assert.ok(!JSON.stringify(list).includes('pw'));
  assert.ok(!JSON.stringify(list).includes(base));
});

test('a failing service becomes "down" with the reason', async () => {
  mode = 'down';
  const { cfg } = await import('../build/config.js');
  const r = await tiles.pollTile(cfg.tiles[1]);
  assert.equal(r.state, 'down'); assert.equal(r.error, 'HTTP 500');
  mode = 'up';
  assert.equal((await tiles.pollTile(cfg.tiles[1])).state, 'ok');
});
