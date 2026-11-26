import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, after } from 'node:test';
import { looksLike, scan, targetsOf } from '../build/discover.js';
import { KINDS } from '../build/tile-kinds.js';

const web = createServer((req, res) => {
  if (req.url === '/System/Info/Public') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ProductName":"Jellyfin Server","Version":"10.9"}'); }
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Sonarr</title>'); }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const port = web.address().port;
after(() => web.close());

test('a page must look like the service, not just answer', () => {
  const jf = KINDS.find((k) => k.kind === 'jellyfin');
  assert.equal(looksLike(jf, 200, '{"ProductName":"Jellyfin Server"}'), true);
  assert.equal(looksLike(jf, 200, '<html>some other app</html>'), false);
  assert.equal(looksLike(jf, 500, 'Jellyfin'), false);
  assert.equal(looksLike(KINDS.find((k) => k.kind === 'nut'), 200, 'x'), false, 'kinds without a probe are never suggested');
});

test('targets: running guests only, runtime addresses first, no repeats', () => {
  const g = (vmid, status, ips) => ({ vmid, name: `g${vmid}`, type: 'lxc', status, ips, macs: [], bridges: [] });
  const t = targetsOf([g(1, 'running', [{ ip: '10.0.0.2', source: 'config' }, { ip: '10.0.0.3', source: 'runtime' }, { ip: '10.0.0.3', source: 'agent' }]), g(2, 'stopped', [{ ip: '10.0.0.9', source: 'config' }])]);
  assert.deepEqual(t.map((x) => x.ip), ['10.0.0.3', '10.0.0.2']);
});

test('scan suggests what answers like the service and skips what is already known', async () => {
  const kinds = [
    { ...KINDS.find((k) => k.kind === 'jellyfin'), ports: [port] },
    { ...KINDS.find((k) => k.kind === 'sonarr'), ports: [port] },
    { ...KINDS.find((k) => k.kind === 'radarr'), ports: [port] },
    { ...KINDS.find((k) => k.kind === 'plex'), ports: [port + 1] },
  ];
  const target = [{ ip: '127.0.0.1', guest: { vmid: 105, name: 'media' } }];
  const found = await scan(target, new Set(), kinds, 1500);
  assert.deepEqual(found.map((f) => f.kind).sort(), ['jellyfin'], 'the port serves jellyfin first; the first catalogue match claims it');
  assert.equal(found[0].url, `http://127.0.0.1:${port}`); assert.equal(found[0].guest.vmid, 105);
  assert.deepEqual(await scan(target, new Set([`127.0.0.1:${port}`]), kinds, 1500), []);
});
