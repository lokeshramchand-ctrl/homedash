import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'hd-upkeep-'));
Object.assign(process.env, { DB_PATH: join(dir, 'u.db'), PVE_NODE: 'pve', BACKUP_KEEP: '3' });
const { parseApt, parseZfs, upkeepProblems } = await import('../build/maintenance.js');
const { pruneList, runBackup, listBackups, stamp } = await import('../build/selfbackup.js');
const db = await import('../build/db.js'); db.connectDb();
after(() => { try { db.closeDb(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('apt: counts, kernel and Proxmox packages', () => {
  const u = parseApt([{ Package: 'curl' }, { Package: 'proxmox-kernel-6.8.12-2-pve' }, { Package: 'pve-manager' }, { Package: 'libpve-common-perl' }]);
  assert.deepEqual([u.total, u.kernel, u.proxmox], [4, true, 3]);
  assert.deepEqual(parseApt([]), { total: 0, kernel: false, proxmox: 0, sample: [] });
});

test('problems: degraded and failed pools, full pools, kernel or many updates; healthy is quiet', () => {
  const pools = parseZfs([{ name: 'tank', health: 'DEGRADED', size: 100, free: 50 }, { name: 'bad', health: 'faulted', size: 100, free: 50 }, { name: 'fat', health: 'ONLINE', size: 100, free: 5 }, { name: 'ok', health: 'ONLINE', size: 100, free: 60 }]);
  const p = upkeepProblems('pve', 'pve', null, pools, 30);
  assert.deepEqual(p.map((x) => [x.key, x.level]), [['zfs|pve|tank', 'warn'], ['zfs|pve|bad', 'error'], ['zfsfull|pve|fat', 'warn']]);
  assert.equal(upkeepProblems('pve', 'pve', { total: 3, kernel: false, proxmox: 0, sample: [] }, [], 30).length, 0);
  assert.equal(upkeepProblems('pve', 'pve', { total: 3, kernel: true, proxmox: 1, sample: [] }, [], 30)[0].key, 'apt|pve');
  assert.equal(upkeepProblems('pve', 'pve', { total: 31, kernel: false, proxmox: 0, sample: [] }, null, 30).length, 1);
});

test('prune keeps the newest N and ignores other files', () => {
  const names = ['homedash-20260101-000000.db', 'homedash-20260103-000000.db', 'homedash-20260102-000000.db', 'notes.txt', 'homedash-20260104-000000.db'];
  assert.deepEqual(pruneList(names, 2), ['homedash-20260101-000000.db', 'homedash-20260102-000000.db']);
  assert.deepEqual(pruneList(names, 10), []);
});

test('a backup is a consistent, private, readable copy and old ones are pruned', async () => {
  const out = join(dir, 'bk');
  const names = [];
  for (let i = 0; i < 5; i++) { names.push(runBackup(out, 3)); await new Promise((r) => setTimeout(r, 1100)); }
  assert.equal(readdirSync(out).length, 3); assert.equal(listBackups(out)[0].name, names[4]);
  const copy = new DatabaseSync(join(out, names[4]), { readOnly: true });
  assert.ok(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get());
  copy.close();
  if (process.platform !== 'win32') assert.equal(statSync(join(out, names[4])).mode & 0o077, 0);
  assert.match(stamp(new Date('2026-03-04T05:06:07Z')), /^20260304-050607$/);
  assert.throws(() => runBackup('', 3), (e) => e.status === 503);
  assert.ok(!existsSync(join(out, names[0])));
});
