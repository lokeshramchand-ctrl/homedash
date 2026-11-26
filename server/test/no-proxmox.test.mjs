import assert from 'node:assert/strict';
import { test } from 'node:test';

// A server with no Proxmox settings at all (a first Docker run, or before the installer is finished) must still answer.
for (const k of Object.keys(process.env)) if (/^PVE_/.test(k)) delete process.env[k];
const config = await import('../build/config.js');
const { findCluster, defaultCluster, currentCluster, CLUSTERS } = await import('../build/clusters.js');

test('without Proxmox settings there is one empty default cluster, and Proxmox counts as not configured', () => {
  assert.equal(CLUSTERS.length, 1);
  assert.equal(defaultCluster().id, 'default');
  assert.equal(currentCluster().id, 'default');
  assert.equal(config.pveConfigured(), false);
  assert.equal(findCluster('nope'), undefined);
});
