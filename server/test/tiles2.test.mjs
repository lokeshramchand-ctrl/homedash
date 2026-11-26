import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const web = createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = req.url;
    if (u.startsWith('/api/v3/') && req.headers['x-api-key'] !== 'KEY') return j({}, 401);
    if (u === '/api/v3/system/status') return j({ version: '4.0.1' });
    if (u.startsWith('/api/v3/queue')) return j({ totalRecords: 3 });
    if (u === '/api/v3/health') return j([{ type: 'warning', message: 'x' }, { type: 'error', message: 'y' }]);
    if (u.startsWith('/api/v3/wanted/missing')) return j({ totalRecords: 12 });
    if (u === '/api/v2/auth/login') {
      if (b.includes('password=pw') && req.headers.referer) { res.writeHead(200, { 'set-cookie': 'SID=abc; path=/' }); return res.end('Ok.'); }
      res.writeHead(403); return res.end('Fails.');
    }
    if (u === '/api/v2/transfer/info') return req.headers.cookie === 'SID=abc' ? j({ dl_info_speed: 2_500_000, up_info_speed: 100_000, connection_status: 'connected' }) : j({}, 403);
    if (u === '/api/v2/torrents/info') return j([{ state: 'downloading' }, { state: 'stalledUP' }, { state: 'error' }]);
    if (u === '/control/status') return req.headers.authorization === `Basic ${Buffer.from('a:b').toString('base64')}` ? j({ protection_enabled: false, running: true, version: 'v0.107' }) : j({}, 401);
    if (u === '/control/stats') return j({ num_dns_queries: 1000, num_blocked_filtering: 250, avg_processing_time: 0.012 });
    if (u === '/api/overview') return j({ http: { routers: { total: 5, errors: 1, warnings: 0 }, services: { total: 4 }, middlewares: { total: 2 } } });
    if (u === '/identity') return j({ MediaContainer: { version: '1.40' } });
    if (u === '/status/sessions') return j({ MediaContainer: { size: 2 } });
    if (u === '/library/sections') return j({ MediaContainer: { size: 4 } });
    if (u === '/api/server/statistics') return req.headers['x-api-key'] === 'K' ? j({ photos: 12345, videos: 10, usage: 5e11 }) : j({}, 401);
    if (u.startsWith('/ocs/')) return req.headers['nc-token'] === 'T' ? j({ ocs: { data: { nextcloud: { system: { version: '29.0', freespace: 3e9 }, storage: { num_users: 4, num_files: 9000 } }, activeUsers: { last24hours: 2 } } } }) : j({}, 401);
    j({}, 404);
  });
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}`;
const nut = tcp((s) => s.on('data', (d) => {
  if (String(d).startsWith('LIST VAR ups')) s.write('BEGIN LIST VAR ups\nVAR ups battery.charge "42"\nVAR ups battery.runtime "1800"\nVAR ups ups.status "OB DISCHRG"\nVAR ups ups.load "35"\nVAR ups ups.realpower "210"\nEND LIST VAR ups\n');
  else s.write('ERR UNKNOWN-UPS\n');
}));
await new Promise((r) => nut.listen(0, '127.0.0.1', r));
const nutPort = nut.address().port;

const dir = mkdtempSync(join(tmpdir(), 'hd-tiles2-'));
Object.assign(process.env, {
  DB_PATH: join(dir, 't.db'), PVE_NODE: 'pve',
  TILES: JSON.stringify([
    { kind: 'sonarr', url: base, token: 'KEY' }, { kind: 'qbittorrent', url: base, username: 'u', password: 'pw' }, { kind: 'adguard', url: base, username: 'a', password: 'b' },
    { kind: 'traefik', url: base }, { kind: 'plex', url: base, token: 'x' }, { kind: 'immich', url: base, token: 'K' }, { kind: 'nextcloud', url: base, token: 'T' },
    { kind: 'nut', url: `tcp://127.0.0.1:${nutPort}`, ups: 'ups' }, { kind: 'nut', id: 'badups', url: `tcp://127.0.0.1:${nutPort}`, ups: 'nope' }, { kind: 'sonarr', id: 'badkey', url: base, token: 'WRONG' },
  ]),
});
const db = await import('../build/db.js'); db.connectDb();
const tiles = await import('../build/tiles.js');
const { cfg } = await import('../build/config.js');
const { missingFields, KINDS } = await import('../build/tile-kinds.js');
after(() => { web.close(); nut.close(); try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
const stat = (r, l) => r.stats.find((s) => s.label === l)?.value;

test('every kind in the catalogue has a provider', () => {
  for (const k of KINDS) assert.ok(tiles.PROVIDER_KINDS.includes(k.kind), k.kind);
  assert.deepEqual(missingFields('sonarr', {}), ['token']); assert.deepEqual(missingFields('sonarr', { token: 'x' }), []); assert.deepEqual(missingFields('docker', {}), []);
});

test('the arr family, qBittorrent, AdGuard, Traefik, Plex, Immich, Nextcloud and NUT read their services', async () => {
  const by = Object.fromEntries(cfg.tiles.map((t) => [t.id, t]));
  const run = (id) => tiles.pollTile(by[id]);
  const sonarr = await run('sonarr');
  assert.equal(sonarr.state, 'warn'); assert.equal(stat(sonarr, 'Queue'), 3); assert.equal(stat(sonarr, 'Missing'), 12); assert.match(stat(sonarr, 'Health'), /1 error, 1 warning/);
  const q = await run('qbittorrent'); assert.equal(q.state, 'warn'); assert.equal(stat(q, 'Download'), '2.5 MB/s'); assert.equal(stat(q, 'Errors'), 1); assert.equal(stat(q, 'Seeding'), 1);
  const ag = await run('adguard'); assert.equal(ag.state, 'warn'); assert.equal(stat(ag, 'Protection'), 'off'); assert.equal(ag.summary, '25.0% blocked');
  const tr = await run('traefik'); assert.equal(tr.state, 'warn'); assert.equal(stat(tr, 'Routers'), 5);
  const px = await run('plex'); assert.equal(px.state, 'ok'); assert.equal(stat(px, 'Streams'), 2); assert.equal(stat(px, 'Libraries'), 4);
  const im = await run('immich'); assert.equal(stat(im, 'Photos'), '12,345'); assert.equal(stat(im, 'Storage'), '500 GB');
  const nc = await run('nextcloud'); assert.equal(stat(nc, 'Version'), '29.0'); assert.equal(nc.stats.find((s) => s.label === 'Free space').tone, 'warn');
  const ups = await run('nut'); assert.equal(ups.state, 'warn'); assert.equal(stat(ups, 'Battery'), '42%'); assert.equal(stat(ups, 'Power'), '210 W'); assert.equal(stat(ups, 'Runtime'), '30 min');
});

test('wrong credentials and unknown UPS names give a clear error', async () => {
  const by = Object.fromEntries(cfg.tiles.map((t) => [t.id, t]));
  const bad = await tiles.pollTile(by.badkey); assert.equal(bad.state, 'down'); assert.match(bad.error, /sign-in rejected/);
  const nu = await tiles.pollTile(by.badups); assert.equal(nu.state, 'down'); assert.match(nu.error, /UNKNOWN-UPS/);
});
