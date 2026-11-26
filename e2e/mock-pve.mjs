// A tiny stand-in for the Proxmox API (one node, four guests) so the UI can be tested without a real host.
// Usage: node e2e/mock-pve.mjs   (listens on 127.0.0.1:8911)
import http from 'node:http';
const now = Math.floor(Date.now() / 1000);
const guests = [
  { id: 'qemu/100', type: 'qemu', vmid: 100, name: 'gaming-vm', node: 'pve', status: 'running', cpu: 0.12, maxcpu: 8, mem: 8e9, maxmem: 16e9, disk: 0, maxdisk: 128e9, uptime: 86400 * 3, tags: 'gpu' },
  { id: 'lxc/101', type: 'lxc', vmid: 101, name: 'media', node: 'pve', status: 'running', cpu: 0.03, maxcpu: 2, mem: 1.2e9, maxmem: 4e9, disk: 8e9, maxdisk: 32e9, uptime: 86400 * 9, tags: '' },
  { id: 'lxc/102', type: 'lxc', vmid: 102, name: 'pihole', node: 'pve', status: 'running', cpu: 0.01, maxcpu: 1, mem: 2e8, maxmem: 5e8, disk: 1e9, maxdisk: 4e9, uptime: 86400 * 20, tags: '' },
  { id: 'qemu/103', type: 'qemu', vmid: 103, name: 'win11', node: 'pve', status: 'stopped', cpu: 0, maxcpu: 4, mem: 0, maxmem: 8e9, disk: 0, maxdisk: 80e9, uptime: 0, tags: '' },
];
const rrd = Array.from({ length: 60 }, (_, i) => ({ time: now - (60 - i) * 60, cpu: 0.1 + 0.05 * Math.sin(i / 5), mem: 8e9, maxmem: 16e9, netin: 1000 * i, netout: 800 * i, diskread: 0, diskwrite: 0, memused: 6e9, memtotal: 16e9, loadavg: 0.4, iowait: 0.01, rootused: 20e9, roottotal: 100e9 }));
const nodeStatus = { cpu: 0.09, cpuinfo: { cpus: 16, model: 'Mock CPU', sockets: 1 }, memory: { used: 20e9, total: 64e9, free: 44e9 }, swap: { used: 0, total: 8e9 }, rootfs: { used: 30e9, total: 100e9, avail: 70e9 }, uptime: 86400 * 12, loadavg: ['0.4', '0.5', '0.5'], pveversion: 'pve-manager/8.2.2', kversion: 'Linux 6.8.4-2-pve' };
const storages = [{ storage: 'local', type: 'dir', content: 'iso,backup,vztmpl', active: 1, enabled: 1, shared: 0, total: 100e9, used: 30e9, avail: 70e9 }, { storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir', active: 1, enabled: 1, shared: 0, total: 400e9, used: 120e9, avail: 280e9 }];
const routes = [
  [/^\/version$/, () => ({ version: '8.2.2', release: '8.2' })],
  [/^\/cluster\/resources/, () => [...guests, { id: 'node/pve', type: 'node', node: 'pve', status: 'online', cpu: 0.09, maxcpu: 16, mem: 20e9, maxmem: 64e9, uptime: 86400 * 12 }, ...storages.map((s) => ({ id: 'storage/pve/' + s.storage, type: 'storage', node: 'pve', storage: s.storage, status: 'available', disk: s.used, maxdisk: s.total }))]],
  [/^\/cluster\/status/, () => [{ type: 'node', name: 'pve', online: 1, id: 'node/pve', local: 1, ip: '127.0.0.1' }]],
  [/^\/cluster\/backup-info\/not-backed-up/, () => [{ vmid: 103 }]],
  [/^\/nodes\/pve\/status/, () => nodeStatus],
  [/^\/nodes\/pve\/storage\/[^/]+\/rrddata/, () => rrd.map((r) => ({ time: r.time, used: 30e9 + r.time % 1000, total: 100e9 }))],
  [/^\/nodes\/pve\/storage\/[^/]+\/content/, () => []],
  [/^\/nodes\/pve\/storage/, () => storages],
  [/^\/nodes\/pve\/rrddata/, () => rrd],
  [/^\/nodes\/pve\/(qemu|lxc)\/\d+\/rrddata/, () => rrd],
  [/^\/nodes\/pve\/(qemu|lxc)\/\d+\/status\/current/, (m) => ({ status: 'running', name: 'x', cpus: 2, cpu: 0.1, mem: 1e9, maxmem: 4e9, uptime: 1000 })],
  [/^\/nodes\/pve\/qemu\/\d+\/config/, () => ({ cores: 4, memory: 8192, name: 'x', ostype: 'win11' })],
  [/^\/nodes\/pve\/(qemu|lxc)\/\d+\/snapshot/, () => [{ name: 'current' }, { name: 'before-update', snaptime: now - 86400 * 40, description: 'old' }]],
  [/^\/nodes\/pve\/tasks/, () => [{ upid: 'UPID:pve:1:1:1:qmstart:100:root@pam:', node: 'pve', type: 'qmstart', id: '100', user: 'root@pam', status: 'OK', starttime: now - 600, endtime: now - 590 }]],
  [/^\/nodes\/pve\/services/, () => [{ service: 'pveproxy', name: 'pveproxy', state: 'running', desc: 'PVE API Proxy' }, { service: 'pvedaemon', name: 'pvedaemon', state: 'running', desc: 'PVE API Daemon' }]],
  [/^\/nodes\/pve\/apt\/update/, () => [{ Package: 'pve-kernel', OldVersion: '1', Version: '2' }]],
  [/^\/nodes\/pve\/disks\/list/, () => [{ devpath: '/dev/sda', health: 'PASSED', model: 'Mock SSD', size: 5e11, type: 'ssd' }]],
  [/^\/nodes\/pve\/disks\/zfs/, () => []],
  [/^\/nodes\/pve\/certificates\/info/, () => [{ filename: 'pve-ssl.pem', notafter: now + 86400 * 200 }]],
  [/^\/nodes\/pve\/(version|time|dns|network|subscription)/, () => ({})],
  [/^\/nodes\/pve\/hardware\/pci/, () => []],
  [/^\/nodes$/, () => [{ node: 'pve', status: 'online', cpu: 0.09, maxcpu: 16, mem: 20e9, maxmem: 64e9, uptime: 1e6 }]],
];
http.createServer((req, res) => {
  const p = req.url.replace(/^\/api2\/json/, '').split('?')[0];
  res.setHeader('content-type', 'application/json');
  for (const [re, fn] of routes) { const m = re.exec(p); if (m) { res.end(JSON.stringify({ data: fn(m) })); return; } }
  if (req.method !== 'GET') { res.end(JSON.stringify({ data: 'UPID:pve:1:1:1:mock:100:root@pam:' })); return; }
  console.log('unmocked', req.method, req.url);
  res.statusCode = 404; res.end(JSON.stringify({ data: null }));
}).listen(8911, '127.0.0.1', () => console.log('mock pve on 8911'));
