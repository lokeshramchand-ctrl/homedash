import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from '../build/cli-template.js';
import { expand, featureRows, neededGenerated, toEnv } from '../build/cli-schema.js';

test('template: values, missing values and nested blocks', () => {
  const out = render('a={{x.y}} b={{missing}}\n{{#if on}}\nyes\n{{else}}\nno\n{{/if}}\n', { x: { y: 5 }, on: true });
  assert.equal(out, 'a=5 b=\nyes\n');
  assert.equal(render('{{#if on}}A{{else}}B{{/if}}', { on: [] }), 'B');
  assert.equal(render('{{#unless on}}U{{/unless}}', { on: '' }), 'U');
});

test('template: each over objects and scalars, with parent access', () => {
  const data = { list: [{ n: 'a' }, { n: 'b' }], nets: ['10.0.0.0/8', '192.168.0.0/16'], p: 'P' };
  assert.equal(render('{{#each list}}[{{.n}}{{p}}]{{/each}}', data), '[aP][bP]');
  assert.equal(render('{{#each nets}}allow {{.}};\n{{/each}}', data), 'allow 10.0.0.0/8;\nallow 192.168.0.0/16;\n');
});

test('template: tag-only lines leave no blank line behind', () => {
  assert.equal(render('one\n  {{#if on}}\ntwo\n  {{/if}}\nthree\n', { on: false }), 'one\nthree\n');
});

test('template: unbalanced blocks are reported', () => {
  assert.throws(() => render('{{#if x}}never closed', {}), /Missing/);
  assert.throws(() => render('{{/if}}', {}), /Unexpected/);
});

test('expand: uses secrets, defaults and reports unknown names', () => {
  const r = expand('a=${A} b=${B:-dflt} c=${NOPE_X}', { A: '1' });
  assert.equal(r.text, 'a=1 b=dflt c=');
  assert.deepEqual(r.missing, ['NOPE_X']);
});

test('toEnv: maps sections to server settings and quotes nothing itself', () => {
  const y = {
    server: { port: 4000, https: true },
    proxmox: { url: 'https://pve:8006', node: 'pve', token_id: 'a@pve!b', token_secret: '${S}', protected_vmids: [100, 101], conflicts: { 100: [101] } },
    auth: { oidc: { issuer: 'https://sso.example.com', client_id: 'c', redirect_uri: 'https://d/cb', allowed_users: ['Al', 'bo'], default_role: 'viewer' } },
    grafana: { url: 'http://g:3000', token: 't' },
    loki: { url: 'http://l:3100' },
  };
  const { env, problems } = toEnv(y, { S: 'sec' }, { METRICS_TOKEN: 'm'.repeat(64) });
  assert.deepEqual(problems, []);
  assert.equal(env.PORT, '4000');
  assert.equal(env.COOKIE_SECURE, 'true');
  assert.equal(env.TRUST_PROXY, '127.0.0.1');
  assert.equal(env.PVE_TOKEN_SECRET, 'sec');
  assert.equal(env.PROTECTED_VMIDS, '100,101');
  assert.equal(env.GUEST_CONFLICTS, '{"100":[101]}');
  assert.equal(env.OIDC_ALLOWED_USERS, 'Al,bo');
  assert.equal(env.METRICS_TOKEN, 'm'.repeat(64));
  const on = Object.fromEntries(featureRows(env).map((r) => [r.id, r.on]));
  assert.equal(on.proxmox, true); assert.equal(on.grafana, true); assert.equal(on.loki, true);
  assert.equal(on.sso, true); assert.equal(on.kuma, false); assert.equal(on.data, false);
});

test('toEnv: problems for typos, missing secrets, half-configured pairs and bad data connections', () => {
  const { problems } = toEnv({
    proxmoxx: {},
    proxmox: { url: 'https://pve:8006', node: 'pve', token_id: 'a@pve!b', token_secret: '${MISSING}' },
    grafana: { url: 'http://g:3000' },
    kuma: { url: 'not-a-url', api_key: 'k' },
    auth: { oidc: { default_role: 'root' } },
    data: { connections: [{ id: 'x', kind: 'oracle' }, { kind: 'redis' }] },
  }, {}, {});
  const text = problems.join('\n');
  assert.match(text, /Unknown top-level key "proxmoxx"/);
  assert.match(text, /MISSING/);
  assert.match(text, /GRAFANA_URL is set but GRAFANA_TOKEN/);
  assert.match(text, /KUMA_URL.*not an http/);
  assert.match(text, /default_role/);
  assert.match(text, /kind must be one of/);
  assert.match(text, /"id".*required/);
});

test('toEnv: data connections become DS_<ID>_* and the key is requested', () => {
  const y = { data: { enabled: true, connections: [{ id: 'main-mongo', kind: 'mongodb', name: 'Main', uri: 'mongodb://h/', readonly: false }] } };
  assert.deepEqual(neededGenerated(y).sort(), ['DATASOURCE_KEY', 'METRICS_TOKEN']);
  const { env, problems } = toEnv(y, {}, { DATASOURCE_KEY: 'k'.repeat(64), METRICS_TOKEN: 'm' });
  assert.deepEqual(problems, []);
  assert.equal(env.DS_MAIN_MONGO_KIND, 'mongodb');
  assert.equal(env.DS_MAIN_MONGO_READONLY, 'false');
  assert.equal(featureRows(env).find((r) => r.id === 'data').on, true);
});

test('toEnv: metrics.enabled false drops the token', () => {
  assert.equal(neededGenerated({ metrics: { enabled: false } }).includes('METRICS_TOKEN'), false);
  const { env } = toEnv({ metrics: { enabled: false } }, {}, { METRICS_TOKEN: 'x' });
  assert.equal(env.METRICS_TOKEN, undefined);
});
