// Several clusters and nodes, end to end: two mock Proxmox clusters behind one real server.
//   "lab"    two nodes (pve1, pve2), first API address is dead -> failover to the second
//   "office" one stand-alone node, and a guest 100 that is a different machine from lab's guest 100
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const NODE = ['--disable-warning=ExperimentalWarning'];
const PW = 'correct-horse-battery';
let dir, labPve, officePve, srv, base, admin, scoped;
const calls = { lab: [], office: [] }; // "METHOD /path" for every request each mock saw

const labGuests = [
  { vmid: 100, name: 'web', type: 'lxc', status: 'running', node: 'pve1', tags: '' },
  { vmid: 101, name: 'db', type: 'qemu', status: 'running', node: 'pve2', tags: 'prod' },
  { vmid: 102, name: 'batch', type: 'qemu', status: 'stopped', node: 'pve2', tags: '' },
];
const officeGuests = [
  { vmid: 100, name: 'printserver', type: 'lxc', status: 'running', node: 'pve', tags: '' },
  { vmid: 200, name: 'files', type: 'lxc', status: 'running', node: 'pve', tags: '' },
];

function mock(name, guests, nodes, status) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const path = req.url.replace('/api2/json', '');
      calls[name].push(`${req.method} ${path}${req.method === 'POST' && body ? ` ${body}` : ''}`);
      res.setHeader('Content-Type', 'application/json');
      const ok = (data) => res.end(JSON.stringify({ data }));
      const res_ = (g) => ({ id: `${g.type}/${g.vmid}`, vmid: g.vmid, name: g.name, type: g.type, status: g.status, node: g.node, tags: g.tags, maxmem: 1e9, mem: 5e8, cpu: 0.1, uptime: 1000, maxcpu: 2 });
      if (path.startsWith('/cluster/resources?type=vm')) return ok(guests.map(res_));
      if (path.startsWith('/cluster/resources?type=node')) return ok(nodes.map((n) => ({ type: 'node', node: n, status: n === 'pve3' ? 'offline' : 'online', cpu: 0.2, mem: 4e9, maxmem: 16e9, disk: 1e10, maxdisk: 1e11, uptime: 5000 })));
      if (path === '/cluster/status') return ok(status);
      if (path === '/version') return ok({ version: '8.2.4' });
      let m = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/migrate$/.exec(path);
      if (m && req.method === 'GET') return ok({ allowed_nodes: nodes.filter((n) => n !== m[1] && n !== 'pve3'), not_allowed_nodes: {}, local_disks: [] });
      if (m && req.method === 'POST') return ok(`UPID:${m[1]}:0000:0000:00000000:qmigrate:${m[3]}:root@pam:`);
      m = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/status\/(\w+)$/.exec(path);
      if (m && req.method === 'POST') return ok(`UPID:${m[1]}:0000:0000:00000000:${m[4]}:${m[3]}:root@pam:`);
      if (/\/tasks\/.+\/status$/.test(path)) return ok({ status: 'stopped', exitstatus: 'OK' });
      if (req.method === 'POST' && /^\/nodes\/([^/]+)\/status$/.test(path)) return ok(`UPID:${path.split('/')[2]}:0000:0000:00000000:hostshutdown::root@pam:`);
      if (/^\/nodes\/[^/]+\/status$/.test(path)) return ok({ cpu: 0.3, memory: { used: 1, total: 2 }, rootfs: { used: 1, total: 2 }, uptime: 100 });
      ok([]);
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', r));

before(async () => {
  labPve = mock('lab', labGuests, ['pve1', 'pve2', 'pve3'], [
    { type: 'cluster', name: 'lab', quorate: 1, nodes: 3 },
    { type: 'node', name: 'pve1', online: 1, local: 1 }, { type: 'node', name: 'pve2', online: 1 }, { type: 'node', name: 'pve3', online: 0 },
  ]);
  officePve = mock('office', officeGuests, ['pve'], [{ type: 'node', name: 'pve', online: 1, local: 1 }]);
  await Promise.all([listen(labPve), listen(officePve)]);
  dir = mkdtempSync(join(tmpdir(), 'hd-cluster-'));
  const port = 38000 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 't.db'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent', METRICS_TOKEN: 'm'.repeat(32),
    PVE_CLUSTERS: JSON.stringify([
      { id: 'lab', name: 'Lab', urls: ['http://127.0.0.1:1', `http://127.0.0.1:${labPve.address().port}`], node: 'pve1', token_id: 'a@pve!b', token_secret: 'x', protected_vmids: [101], host_power: true },
      { id: 'office', name: 'Office', urls: [`http://127.0.0.1:${officePve.address().port}`], node: 'pve', token_id: 'a@pve!b', token_secret: 'y' },
    ]),
    ACCESS_TEAMS: JSON.stringify({ labweb: { cluster: 'lab', vmids: ['100'] } }),
  };
  for (const [u, role] of [['admin', 'admin'], ['teamuser', 'operator']]) {
    const r = spawnSync('node', [...NODE, 'build/create-user.js', u, role], { env: { ...env, NEW_PASSWORD: PW }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn('node', [...NODE, 'build/index.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/passkey/config`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  admin = await client().login('admin');
  scoped = await client().login('teamuser');
  // put teamuser in the lab-only team
  const id = (await admin.call('GET', '/api/admin/users')).body.find((u) => u.username === 'teamuser').id;
  assert.equal((await admin.call('PATCH', `/api/admin/users/${id}`, { teams: ['labweb'] })).status, 200);
});
after(() => { srv?.kill(); labPve?.close(); officePve?.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked briefly on windows */ } });

function client() {
  let cookie = '';
  const c = {
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method, headers: { 'X-Requested-With': 'homedash', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text };
    },
    async login(u) { const r = await c.call('POST', '/api/auth/login', { username: u, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.body)); return c; },
  };
  return c;
}
const lab = { 'X-Cluster': 'lab' }, office = { 'X-Cluster': 'office' };
const saw = (cluster, re) => calls[cluster].filter((c) => re.test(c));

test('failover: the first address is dead and the cluster still answers', async () => {
  const r = await admin.call('GET', '/api/guests', undefined, lab);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.length, 3);
  // later calls go straight to the address that worked
  const t0 = Date.now();
  await admin.call('GET', '/api/guests/100/status', undefined, lab);
  assert.ok(Date.now() - t0 < 3000);
});

test('guests carry their node and cluster; the default cluster is the first one', async () => {
  const none = (await admin.call('GET', '/api/guests')).body; // no header = first cluster
  assert.deepEqual(none.map((g) => [g.vmid, g.node, g.cluster]), [[100, 'pve1', 'lab'], [101, 'pve2', 'lab'], [102, 'pve2', 'lab']]);
  const off = (await admin.call('GET', '/api/guests', undefined, office)).body;
  assert.deepEqual(off.map((g) => [g.vmid, g.name, g.node, g.cluster]), [[100, 'printserver', 'pve', 'office'], [200, 'files', 'pve', 'office']]);
  assert.equal((await admin.call('GET', '/api/guests', undefined, { 'X-Cluster': 'nope' })).body.code, 'UNKNOWN_CLUSTER');
  assert.equal((await admin.call('GET', '/api/guests?cluster=office')).body.length, 2); // EventSource cannot set headers
});

test('actions go to the guest\'s own node, in the right cluster (same vmid in both)', async () => {
  calls.lab.length = 0; calls.office.length = 0;
  assert.equal((await admin.call('POST', '/api/guests/102/start', {}, lab)).status, 200);
  assert.equal(saw('lab', /^POST \/nodes\/pve2\/qemu\/102\/status\/start/).length, 1); // node pve2, not the preferred pve1
  assert.equal((await admin.call('POST', '/api/guests/100/reboot', {}, office)).status, 200);
  assert.equal(saw('office', /^POST \/nodes\/pve\/lxc\/100\/status\/reboot/).length, 1);
  assert.equal(saw('lab', /lxc\/100\/status\/reboot/).length, 0); // lab's guest 100 untouched
  // protected guests are per cluster
  assert.equal((await admin.call('POST', '/api/guests/101/stop', {}, lab)).body.code, 'PROTECTED');
});

test('task status asks the node named inside the task id', async () => {
  calls.lab.length = 0;
  const r = await admin.call('GET', '/api/tasks/UPID:pve2:0000:0000:00000000:qmstart:102:root@pam:', undefined, lab);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'ok');
  assert.equal(saw('lab', /^GET \/nodes\/pve2\/tasks\//).length, 1);
});

test('overview of every cluster: nodes, quorum, offline members, stand-alone', async () => {
  const r = (await admin.call('GET', '/api/clusters')).body;
  assert.equal(r.current, 'lab');
  const l = r.clusters.find((c) => c.id === 'lab'), o = r.clusters.find((c) => c.id === 'office');
  assert.equal(l.reachable, true); assert.equal(l.quorate, true); assert.equal(l.standalone, false); assert.equal(l.addresses, 2); assert.match(l.activeAddress, /127\.0\.0\.1:\d+/);
  assert.deepEqual(l.nodes.map((n) => [n.name, n.online, n.guests]), [['pve1', true, 1], ['pve2', true, 2], ['pve3', false, 0]]);
  assert.equal(l.nodes.find((n) => n.name === 'pve1').local, true);
  assert.equal(l.version, '8.2.4'); assert.deepEqual(l.guests, { total: 3, running: 2 });
  assert.equal(o.standalone, true); assert.equal(o.nodes.length, 1);
});

test('migration: preview, validation, live/restart modes, protected guests, audit', async () => {
  const pre = (await admin.call('GET', '/api/guests/100/migrate', undefined, lab)).body;
  assert.equal(pre.node, 'pve1'); assert.equal(pre.mode, 'restart'); // a running container is restarted, not live-migrated
  assert.deepEqual(pre.targets.map((t) => [t.name, t.allowed]), [['pve2', true], ['pve3', false]]);
  assert.equal((await admin.call('GET', '/api/guests/101/migrate', undefined, lab)).body.mode, 'live');

  assert.equal((await admin.call('POST', '/api/guests/100/migrate', { target: 'pve1' }, lab)).body.code, 'SAME_NODE');
  assert.equal((await admin.call('POST', '/api/guests/100/migrate', { target: 'pve3' }, lab)).body.code, 'NODE_OFFLINE');
  assert.equal((await admin.call('POST', '/api/guests/100/migrate', { target: 'nowhere' }, lab)).status, 404);
  assert.equal((await admin.call('POST', '/api/guests/100/migrate', { target: 'bad name!' }, lab)).status, 400);
  assert.equal((await admin.call('POST', '/api/guests/101/migrate', { target: 'pve1' }, lab)).body.code, 'PROTECTED');

  calls.lab.length = 0;
  const ok = await admin.call('POST', '/api/guests/100/migrate', { target: 'pve2' }, lab);
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.body.taskId, /^UPID:pve1:/);
  assert.deepEqual(saw('lab', /^POST \/nodes\/pve1\/lxc\/100\/migrate/), ['POST /nodes/pve1/lxc/100/migrate target=pve2&restart=1']);
});

test('host-level pages follow the selected node', async () => {
  calls.lab.length = 0;
  await admin.call('GET', '/api/overview', undefined, { ...lab, 'X-Node': 'pve2' });
  assert.equal(saw('lab', /^GET \/nodes\/pve2\/status/).length, 1);
  assert.equal(saw('lab', /^GET \/nodes\/pve1\/status/).length, 0);
  calls.lab.length = 0;
  await admin.call('GET', '/api/overview', undefined, lab); // no node selected: the cluster's preferred node
  assert.equal(saw('lab', /^GET \/nodes\/pve1\/status/).length, 1);
});

test('shutdown targets the selected node and needs its name', async () => {
  assert.equal((await admin.call('POST', '/api/host/shutdown', { confirm: 'pve1' }, { ...lab, 'X-Node': 'pve2' })).body.code, 'BAD_CONFIRM');
  calls.lab.length = 0;
  const sd = await admin.call('POST', '/api/host/shutdown', { confirm: 'pve2' }, { ...lab, 'X-Node': 'pve2' });
  assert.equal(sd.status, 200, sd.text);
  assert.equal(saw('lab', /^POST \/nodes\/pve2\/status/).length, 1);
  // the office cluster has host power switched off
  assert.equal((await admin.call('POST', '/api/host/shutdown', { confirm: 'pve' }, office)).status, 503);
});

test('scenes belong to one cluster', async () => {
  const made = await admin.call('POST', '/api/scenes', { name: 'Lab night', steps: [{ vmid: 102, action: 'shutdown', waitSeconds: 0 }] }, lab);
  assert.equal(made.status, 200);
  assert.equal((await admin.call('GET', '/api/scenes', undefined, lab)).body.length, 1);
  assert.equal((await admin.call('GET', '/api/scenes', undefined, office)).body.length, 0);
});

test('a team limited to one cluster sees nothing in the others, even for the same vmid', async () => {
  assert.deepEqual((await scoped.call('GET', '/api/guests', undefined, lab)).body.map((g) => g.vmid), [100]);
  assert.deepEqual((await scoped.call('GET', '/api/guests', undefined, office)).body, []); // office also has a guest 100: not theirs
  assert.equal((await scoped.call('GET', '/api/guests/100/status', undefined, office)).body.code, 'OUT_OF_SCOPE');
  assert.equal((await scoped.call('GET', '/api/guests/100/status', undefined, lab)).status, 200);
  const c = (await scoped.call('GET', '/api/clusters')).body.clusters;
  assert.equal(c.length, 2); assert.deepEqual(c[0].nodes, []); // they may switch clusters but see no node details
});

test('metrics carry cluster and node labels when there are several clusters', async () => {
  const r = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${'m'.repeat(32)}` } });
  const t = await r.text();
  assert.match(t, /homedash_proxmox_up\{cluster="lab"\} 1/);
  assert.match(t, /homedash_proxmox_up\{cluster="office"\} 1/);
  assert.match(t, /homedash_node_online\{node="pve3",cluster="lab"\} 0/);
  assert.match(t, /homedash_guest_running\{vmid="100",name="printserver",type="lxc",cluster="office",node="pve"\} 1/);
});
