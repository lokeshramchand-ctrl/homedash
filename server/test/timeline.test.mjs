import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertFromEvent, describeDelivery } from '../build/notify.js';

test('a delivery line says where an alert went, or why it went nowhere', () => {
  assert.deepEqual(describeDelivery('Disk full', [{ channel: 'ntfy', ok: true }, { channel: 'discord', ok: true }]), { level: 'info', text: 'Alert sent to ntfy, discord: Disk full' });
  assert.deepEqual(describeDelivery('Disk full', [], 'Night maintenance'), { level: 'info', text: 'Alert held back (Night maintenance): Disk full' });
  assert.deepEqual(describeDelivery('Disk full', []), { level: 'info', text: 'Alert not sent, no channel wanted it: Disk full' });
});

test('a failed delivery is a warning and names the channel that failed and the ones that worked', () => {
  const d = describeDelivery('Node down', [{ channel: 'ntfy', ok: false, error: 'timeout' }, { channel: 'email', ok: true }]);
  assert.equal(d.level, 'warn');
  assert.equal(d.text, 'Alert delivery failed on ntfy (sent to email): Node down');
  assert.equal(describeDelivery('x', [{ channel: 'ntfy', ok: false }]).text, 'Alert delivery failed on ntfy: x');
});

test('timeline-only sources never raise an alert themselves', () => {
  for (const source of ['alert', 'grafana']) for (const level of ['info', 'warn', 'error']) assert.doesNotThrow(() => alertFromEvent(level, source, 'anything, down → up'));
});
