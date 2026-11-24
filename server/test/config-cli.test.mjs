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
  assert.deepEqual(neededGenerated(y).sort(), ['DATASOURCE_KEY', 'METRICS_TOKEN', 'SECRETS_KEY']);
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

test('toEnv: alert channels map to their variables and are validated', () => {
  const ok = toEnv({
    gotify: { url: 'http://g', token: 'k' }, discord: { webhook_url: 'https://discord.com/api/webhooks/1/x' }, slack: { webhook_url: 'https://hooks.slack.com/services/T/B/x' },
    telegram: { bot_token: '1:a', chat_id: '-100' }, email: { host: 'smtp.example.com', port: 465, secure: true, from: 'a@x.io', to: ['b@x.io', 'c@x.io'] },
    apprise: { url: 'http://a:8000', urls: ['pover://u@t', 'mailto://x'] }, webhook: { url: 'https://e.io/h', secret: 's' },
  }, {}, {});
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.env.SMTP_TO, 'b@x.io,c@x.io');
  assert.equal(ok.env.SMTP_SECURE, 'true');
  assert.equal(ok.env.APPRISE_URLS, 'pover://u@t mailto://x');
  const on = Object.fromEntries(featureRows(ok.env).map((r) => [r.id, r.on]));
  for (const id of ['gotify', 'discord', 'slack', 'telegram', 'email', 'apprise', 'webhook']) assert.equal(on[id], true, id);
  assert.equal(on.ntfy, false);

  const bad = toEnv({
    gotify: { url: 'http://g' }, discord: { webhook_url: 'https://evil.example/hook' }, slack: { webhook_url: 'https://evil.example/x' },
    telegram: { bot_token: '1:a' }, email: { host: 'smtp.example.com' }, apprise: { url: 'http://a:8000' },
  }, {}, {}).problems.join(' | ');
  assert.match(bad, /GOTIFY_URL is set but GOTIFY_TOKEN|GOTIFY_TOKEN is missing|GOTIFY_URL.*GOTIFY_TOKEN/);
  assert.match(bad, /DISCORD_WEBHOOK_URL: must be/);
  assert.match(bad, /SLACK_WEBHOOK_URL: must be/);
  assert.match(bad, /TELEGRAM_BOT_TOKEN is set but TELEGRAM_CHAT_ID/);
  assert.match(bad, /SMTP_HOST is set but SMTP_FROM/);
  assert.match(bad, /SMTP_HOST is set but SMTP_TO/);
  assert.match(bad, /neither key nor urls/);
});

test('toEnv: access settings (teams, group mapping, approvals, SCIM, passkeys) are mapped and validated', async () => {
  const good = toEnv({
    access: { teams: { web: { vmids: ['100-120', 205], tags: ['lab'] } }, group_roles: { admin: ['admins'] }, group_teams: { 'web-team': ['web'] }, approvals: { actions: ['host.shutdown', 'nginx.delete'], ttl_minutes: 15 } },
    scim: { token: 'x'.repeat(30) }, auth: { passkeys: { rp_id: 'example.com', origin: 'https://dash.example.com' } },
  }, {}, {});
  assert.deepEqual(good.problems, []);
  assert.equal(JSON.parse(good.env.ACCESS_TEAMS).web.vmids[0], '100-120');
  assert.equal(good.env.WEBAUTHN_RP_ID, 'example.com');
  const on = Object.fromEntries(featureRows(good.env).map((r) => [r.id, r.on]));
  assert.deepEqual([on.teams, on.approvals, on.scim, on.passkeys], [true, true, true, true]);

  const bad = toEnv({
    access: { teams: { 'bad name!': { vmids: ['10-x'] }, empty: {} }, group_teams: { g: ['ghost'] }, group_roles: { boss: ['x'] }, approvals: { actions: ['launch.missiles'] } },
    scim: { token: 'short' }, auth: { passkeys: { rp_id: 'other.org', origin: 'http://dash.example.com' } },
  }, {}, {}).problems.join(' | ');
  for (const re of [/team names use/, /not an id or a range/, /needs vmids and\/or tags/, /unknown team "ghost"/, /roles are viewer/, /unknown action "launch.missiles"/, /at least 24/, /must be https/, /must be the origin's host/]) assert.match(bad, re);
});

test('approval action names in the schema match the server rules', async () => {
  const { APPROVAL_ACTIONS } = await import('../build/cli-schema.js');
  const { ACTIONS } = await import('../build/approvals.js');
  assert.deepEqual([...APPROVAL_ACTIONS].sort(), [...ACTIONS].sort());
});

test('toEnv: incident tools', () => {
  const ok = toEnv({ pagerduty: { routing_key: 'k'.repeat(32) }, opsgenie: { api_key: 'o'.repeat(32), region: 'EU' } }, {}, {});
  assert.deepEqual(ok.problems, []);
  const on = Object.fromEntries(featureRows(ok.env).map((r) => [r.id, r.on]));
  assert.deepEqual([on.pagerduty, on.opsgenie], [true, true]);
  const bad = toEnv({ pagerduty: { routing_key: 'short' }, opsgenie: { api_key: 'o'.repeat(32), region: 'mars' } }, {}, {}).problems.join(' | ');
  assert.match(bad, /32-character/); assert.match(bad, /us or eu/);
});

test('toEnv: several clusters, failover addresses, and the single-cluster form still works', () => {
  const multi = toEnv({
    proxmox: { clusters: [
      { id: 'lab', name: 'Lab', url: ['https://10.0.0.1:8006', 'https://10.0.0.2:8006'], node: 'pve1', token_id: 'a@pve!b', token_secret: '${LAB}', protected_vmids: [100], allow_host_power: true },
      { name: 'Office', url: 'https://10.1.0.1:8006', node: 'pve', token_id: 'a@pve!b', token_secret: 'plain' },
    ] },
    access: { teams: { web: { cluster: 'lab', vmids: [100] } } },
  }, { LAB: 'sekret' }, {});
  assert.deepEqual(multi.problems, []);
  const cl = JSON.parse(multi.env.PVE_CLUSTERS);
  assert.deepEqual(cl.map((c) => c.id), ['lab', 'office']);
  assert.deepEqual(cl[0].urls, ['https://10.0.0.1:8006', 'https://10.0.0.2:8006']);
  assert.equal(cl[0].token_secret, 'sekret'); assert.equal(cl[0].host_power, true);
  const on = Object.fromEntries(featureRows(multi.env).map((r) => [r.id, r.on]));
  assert.deepEqual([on.proxmox, on.clusters], [true, true]);

  const single = toEnv({ proxmox: { url: ['https://a:8006', 'https://b:8006'], node: 'pve', token_id: 'a@pve!b', token_secret: 'x' } }, {}, {});
  assert.deepEqual(single.problems, []);
  assert.equal(single.env.PVE_URL, 'https://a:8006 https://b:8006');
  assert.equal(featureRows(single.env).find((r) => r.id === 'clusters').on, false);

  const bad = toEnv({
    proxmox: { url: 'https://x:8006', clusters: [{ id: 'a', node: 'n', token_id: 't' }, { id: 'a', url: 'ftp://x', node: 'n', token_id: 't', token_secret: 's' }] },
    access: { teams: { t: { cluster: 'ghost', vmids: [1] } } },
  }, {}, {}).problems.join(' | ');
  for (const re of [/either url.*or clusters/, /duplicate cluster id/, /url .* is required/, /not an http/, /token_secret is required/, /no cluster with id "ghost"/]) assert.match(bad, re);
});
