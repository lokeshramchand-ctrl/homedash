import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockers, migrationChecks } from '../build/migrate-check.js';
import { parseHa } from '../build/ha.js';
import { kernelErrorsIn } from '../build/diagnostics.js';

const GB = 1e9;
const base = { type: 'qemu', running: true, withLocalDisks: false, memMax: 8 * GB, reserveBytes: 1 * GB, localDisks: [], localResources: [] };
const ids = (c) => c.map((x) => `${x.level}:${x.id}`);

test('a running VM with local disks is blocked until "copy local disks" is on', () => {
  const disks = [{ volid: 'local-lvm:vm-100-disk-0', size: 32 * GB }];
  assert.deepEqual(ids(migrationChecks({ ...base, localDisks: disks })), ['block:local-disks']);
  const withCopy = migrationChecks({ ...base, localDisks: disks, withLocalDisks: true });
  assert.deepEqual(ids(withCopy), ['warn:local-copy']); assert.match(withCopy[0].text, /32 GB/);
  assert.equal(blockers(withCopy).length, 0);
});

test('passthrough blocks a live migration but only warns when the VM is stopped', () => {
  assert.deepEqual(ids(migrationChecks({ ...base, localResources: ['hostpci0'] })), ['block:passthrough-live']);
  assert.deepEqual(ids(migrationChecks({ ...base, running: false, localResources: ['hostpci0', 'usb1'] })), ['warn:passthrough']);
  assert.deepEqual(ids(migrationChecks({ ...base, localResources: ['something-else'] })), []);
});

test('containers: restart notice, never blocked by passthrough rules', () => {
  assert.deepEqual(ids(migrationChecks({ ...base, type: 'lxc' })), ['info:lxc-restart']);
  assert.deepEqual(ids(migrationChecks({ ...base, type: 'lxc', running: false, localDisks: [{ volid: 'local:subvol-1', size: 4 * GB }] })), ['warn:lxc-local']);
});

test('target checks: offline, refused, RAM that can never fit, RAM that is tight', () => {
  const t = (o) => ({ name: 'pve2', online: true, allowed: true, reason: null, maxmem: 32 * GB, mem: 4 * GB, ...o });
  assert.deepEqual(ids(migrationChecks({ ...base, target: t({}) })), []);
  assert.deepEqual(ids(migrationChecks({ ...base, target: t({ online: false }) })), ['block:target-offline']);
  const refused = migrationChecks({ ...base, target: t({ allowed: false, reason: 'storage' }) });
  assert.deepEqual(ids(refused), ['block:target-refused']); assert.match(refused[0].text, /storage/);
  assert.deepEqual(ids(migrationChecks({ ...base, target: t({ maxmem: 4 * GB }) })), ['block:ram-never']);
  assert.deepEqual(ids(migrationChecks({ ...base, target: t({ mem: 28 * GB }) })), ['warn:ram-tight']);
});

const HA = [
  { id: 'quorum', type: 'quorum', node: 'pve1', status: 'OK', quorate: 1 },
  { id: 'master', type: 'master', node: 'pve1', status: 'pve1 (active, Mon Nov 24 10:00:00 2026)' },
  { id: 'lrm:pve1', type: 'lrm', node: 'pve1', status: 'pve1 (active, Mon Nov 24 10:00:00 2026)' },
  { id: 'lrm:pve2', type: 'lrm', node: 'pve2', status: 'pve2 (idle, Mon Nov 24 10:00:00 2026)' },
  { id: 'lrm:pve3', type: 'lrm', node: 'pve3', status: 'pve3 (old timestamp - dead?, Mon Nov 24 09:00:00 2026)' },
  { id: 'service:vm:100', type: 'service', sid: 'vm:100', state: 'started', node: 'pve1', request_state: 'started' },
  { id: 'service:vm:101', type: 'service', sid: 'vm:101', state: 'fence', node: 'pve3', request_state: 'started' },
  { id: 'service:ct:102', type: 'service', sid: 'ct:102', state: 'error', node: 'pve2', request_state: 'started' },
];
test('HA: agents, fencing and failed services become attention items and problems', () => {
  const h = parseHa(HA, { pve1: 'online', pve2: 'online', pve3: 'fence' });
  assert.deepEqual([h.enabled, h.quorate, h.master], [true, true, 'pve1']);
  assert.deepEqual(h.nodes.map((n) => [n.node, n.agent, n.attention]), [['pve1', 'active', false], ['pve2', 'idle', false], ['pve3', 'dead', true]]);
  assert.deepEqual(h.services.map((s) => [s.sid, s.vmid, s.attention]), [['ct:102', 102, 'error'], ['vm:100', 100, null], ['vm:101', 101, 'error']]);
  assert.deepEqual(h.problems.map((p) => p.key).sort(), ['ha|node|pve3', 'ha|svc|ct:102', 'ha|svc|vm:101']);
  assert.match(h.problems.find((p) => p.key === 'ha|node|pve3').title, /fencing pve3/);
});
test('HA: a healthy cluster has no problems; lost quorum is one', () => {
  assert.deepEqual(parseHa(HA.slice(0, 4).concat(HA[5])).problems, []);
  const q = parseHa([{ type: 'quorum', quorate: 0 }, HA[2], HA[5]]);
  assert.deepEqual(q.problems.map((p) => p.key), ['ha|quorum']);
  assert.equal(parseHa([]).enabled, false);
});

test('kernel errors from a remote node journal', () => {
  const found = kernelErrorsIn([
    'Nov 24 10:12:03 pve2 kernel: nvme nvme0: I/O 5 QID 3 timeout, aborting',
    'Nov 24 10:12:04 pve2 kernel: eth0: link up',
    'Nov 24 10:12:05 pve2 sshd[1]: I/O error in a userland process',
    'Nov 24 10:12:06 pve2 kernel: Out of memory: Killed process 4242 (qemu-system-x86)',
    'Nov 24 10:12:07 pve2 kernel: vfio-pci 0000:01:00.0: timeout waiting for reset',
  ]);
  assert.deepEqual(found.map((l) => l.kind).sort(), ['gpu', 'hardware', 'oom']);
});
