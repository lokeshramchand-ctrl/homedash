import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpstream, findDuplicates, forecast, parseNetConfig, protectionOf } from '../build/insights.js';
import { certStatus, scoreOf } from '../build/health.js';
import { renderSite, validateSpec } from '../build/nginx-manage.js';

test('parseNetConfig reads lxc and qemu style config', () => {
  const r = parseNetConfig({ net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.50/24,gw=192.168.1.1', net1: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr1,tag=20', ipconfig0: 'ip=10.0.0.9/24,gw=10.0.0.1', memory: '512' });
  assert.deepEqual(r.ips.sort(), ['10.0.0.9', '192.168.1.50']);
  assert.deepEqual(r.macs.sort(), ['aa:bb:cc:dd:ee:ff', 'bc:24:11:aa:bb:cc']);
  assert.deepEqual(r.bridges.sort(), ['vmbr0', 'vmbr1']);
});
test('ip=dhcp and loopback are ignored', () => {
  assert.deepEqual(parseNetConfig({ net0: 'name=eth0,ip=dhcp' }).ips, []);
});
test('duplicate ips: running vs stopped', () => {
  const g = (vmid, status, ip, source = 'config') => ({ vmid, name: `g${vmid}`, type: 'lxc', status, ips: [{ ip, source }], macs: [], bridges: [] });
  assert.equal(findDuplicates([g(1, 'running', '10.0.0.5'), g(2, 'stopped', '10.0.0.5')]).length, 1); // stopped guest's config address still conflicts
  assert.equal(findDuplicates([g(1, 'running', '10.0.0.5', 'runtime'), g(2, 'stopped', '10.0.0.5', 'runtime')]).length, 0);
  assert.equal(findDuplicates([g(1, 'running', '10.0.0.5'), g(2, 'running', '10.0.0.6')]).length, 0);
});
test('classifyUpstream', () => {
  const byIp = new Map([['10.0.0.5', { vmid: 7, name: 'app', status: 'stopped' }], ['10.0.0.6', { vmid: 8, name: 'db', status: 'running' }]]);
  assert.equal(classifyUpstream('http://10.0.0.5:80', byIp).issue, 'guest-stopped');
  assert.equal(classifyUpstream('http://10.0.0.6:5432', byIp).issue, 'ok');
  assert.equal(classifyUpstream('http://10.0.0.99:80', byIp).issue, 'unknown-target');
  assert.equal(classifyUpstream('http://127.0.0.1:3000', byIp).issue, 'local');
  assert.equal(classifyUpstream('http://backend.lan:80', byIp).issue, 'hostname');
});
test('forecast predicts days to full', () => {
  const GB = 1e9, total = 1000 * GB;
  const pts = Array.from({ length: 30 }, (_, i) => ({ time: i * 86400, used: 500 * GB + i * 5 * GB }));
  const f = forecast(pts, total);
  assert.equal(f.trend, 'growing');
  assert.ok(Math.abs(f.bytesPerDay - 5 * GB) < 1e6);
  assert.equal(f.daysToFull, Math.round((total - pts[29].used) / (5 * GB)));
  assert.equal(forecast(pts.map((p) => ({ ...p, used: 500 * GB })), total).trend, 'flat');
  assert.equal(forecast(pts.slice(0, 2), total).trend, 'unknown');
});
test('protectionOf', () => {
  const now = Date.now();
  assert.equal(protectionOf([], now, 8).status, 'never');
  assert.equal(protectionOf([{ vmid: 1, ctime: now / 1000 - 2 * 86400, size: 10 }], now, 8).status, 'ok');
  assert.equal(protectionOf([{ vmid: 1, ctime: now / 1000 - 20 * 86400, size: 10 }], now, 8).status, 'stale');
});
test('health scoring', () => {
  assert.equal(scoreOf([{ status: 'ok' }, { status: 'warn' }, { status: 'fail' }, { status: 'unknown' }]), 80);
  assert.equal(scoreOf(Array(10).fill({ status: 'fail' })), 0);
  assert.equal(certStatus(5), 'fail'); assert.equal(certStatus(20), 'warn'); assert.equal(certStatus(90), 'ok');
});
test('nginx spec validation blocks injection', () => {
  assert.throws(() => validateSpec({ serverNames: ['a.lan; evil'], upstream: 'http://10.0.0.1:80' }));
  assert.throws(() => validateSpec({ serverNames: ['a.lan'], upstream: 'http://10.0.0.1:80;}' }));
  assert.throws(() => validateSpec({ serverNames: ['a.lan'], upstream: 'http://10.0.0.1', tls: 'existing', certPath: '/etc/x;y', keyPath: '/k' }));
  assert.match(renderSite({ serverNames: ['a.lan'], upstream: 'http://10.0.0.1:80' }), /proxy_pass http:\/\/10\.0\.0\.1:80;/);
});

import { isDue, validateSteps, validateSchedule } from '../build/scenes.js';
test('schedules fire once per minute on the right weekday', () => {
  const mon = new Date(2026, 9, 26, 7, 30, 5); // Monday 07:30
  assert.equal(isDue({ days: [1], time: '07:30', enabled: true, lastRun: null }, mon), true);
  assert.equal(isDue({ days: [2], time: '07:30', enabled: true, lastRun: null }, mon), false);
  assert.equal(isDue({ days: [1], time: '07:31', enabled: true, lastRun: null }, mon), false);
  assert.equal(isDue({ days: [1], time: '07:30', enabled: false, lastRun: null }, mon), false);
  assert.equal(isDue({ days: [1], time: '07:30', enabled: true, lastRun: mon.getTime() - 20_000 }, mon), false);
});
test('scene and schedule validation', () => {
  assert.throws(() => validateSteps([]));
  assert.throws(() => validateSteps([{ vmid: 1, action: 'destroy' }]));
  assert.throws(() => validateSteps([{ vmid: 1, action: 'start', waitSeconds: 99999 }]));
  assert.equal(validateSteps([{ vmid: 100, action: 'start', waitSeconds: 5 }])[0].waitSeconds, 5);
  assert.throws(() => validateSchedule({ name: 'x', time: '25:00', days: [1], vmid: 1, action: 'start' }));
  assert.throws(() => validateSchedule({ name: 'x', time: '07:00', days: [], vmid: 1, action: 'start' }));
  assert.throws(() => validateSchedule({ name: 'x', time: '07:00', days: [1] }));
  assert.equal(validateSchedule({ name: 'x', time: '07:00', days: [1, 1, 3], vmid: 1, action: 'stop' }).days.length, 2);
});
