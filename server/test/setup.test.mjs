import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { INTEGRATIONS, buildChecks, progress } from '../build/setup-catalog.js';
import { neededGenerated, toEnv } from '../build/cli-schema.js';
const { features } = await import('../build/features.js');

const base = { proxmox: true, proxmoxReachable: true, secureConnection: true, mfa: true, alerts: true, selfBackup: true, secretsKey: true, admins: 2 };

test('every integration snippet is valid for the same code the installer runs', () => {
  for (const i of INTEGRATIONS) {
    const y = parse(i.snippet);
    const secrets = Object.fromEntries(i.secrets.map((s) => [s, 'x'.repeat(32)]));
    const r = toEnv(y, secrets, { MFA_KEY: 'k'.repeat(40), DATASOURCE_KEY: 'k'.repeat(40) });
    assert.deepEqual(r.problems, [], `${i.id}: ${r.problems.join('; ')}`);
    assert.ok(Object.keys(r.env).length > 0 || neededGenerated(y).length > 0, `${i.id} sets nothing`);
    // every ${NAME} the snippet mentions is declared in `secrets`, so the page can tell the user what to store
    const used = [...i.snippet.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
    assert.deepEqual(used.sort(), [...i.secrets].sort(), `${i.id} secrets list`);
  }
});

test('integration ids are unique and the features they depend on exist', () => {
  assert.equal(new Set(INTEGRATIONS.map((i) => i.id)).size, INTEGRATIONS.length);
  const f = features();
  for (const i of INTEGRATIONS) assert.ok(i.feature in f, `${i.id}: unknown feature ${i.feature}`);
});

test('checks: a complete install is all ticked', () => {
  const c = buildChecks(base);
  assert.ok(c.every((x) => x.status === 'ok'));
  assert.deepEqual(progress(c), { done: c.length, total: c.length });
});

test('checks: each gap says what is wrong and how to fix it', () => {
  const c = buildChecks({ proxmox: false, proxmoxReachable: null, secureConnection: false, mfa: false, alerts: false, selfBackup: false, secretsKey: false, admins: 1 });
  assert.equal(c.filter((x) => x.status === 'ok').length, 0);
  for (const x of c) assert.ok(x.fix && x.detail, `${x.id} needs detail and fix`);
});

test('checks: an unreachable Proxmox is a warning, not a to-do', () => {
  const p = buildChecks({ ...base, proxmoxReachable: false }).find((x) => x.id === 'proxmox');
  assert.equal(p.status, 'warn');
});

test('checks: the second-administrator hint only appears for a single admin', () => {
  assert.ok(buildChecks({ ...base, admins: 1 }).some((x) => x.id === 'second-admin'));
  assert.ok(!buildChecks({ ...base, admins: 2 }).some((x) => x.id === 'second-admin'));
});
