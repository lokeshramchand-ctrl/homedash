#!/usr/bin/env node
// homedash-config: one YAML file (/etc/homedash/homedash.yaml) drives the server settings and the optional
// infrastructure around it (nginx vhosts, Loki, Alloy, Prometheus, CrowdSec snapshot, Grafana provisioning).
//
//   homedash-config init              write a commented homedash.yaml (and secrets.env) if there is none
//   homedash-config validate          check the YAML and show which integrations it would switch on
//   homedash-config status            same, plus what the running server reports
//   homedash-config doctor            try every address and folder the configuration uses and say what is wrong
//   homedash-config apply [--restart] [--dry-run] [--no-nginx]
//                                     render server/.env, nginx vhosts, and the host/stack config files
//   homedash-config print-env         print the .env that apply would write (secrets masked)
//
// Settings in the YAML may reference ${NAME} values from /etc/homedash/secrets.env so the YAML can be shared safely.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { render } from './cli-template.js';
import { featureRows, neededGenerated, toEnv } from './cli-schema.js';
import { Agent } from 'undici';
import { accessSync, constants as fsc, statSync } from 'node:fs';
import { exitCode, interpretHttp, interpretNetworkError, localFindings, softenFailover, summary, targetsFor } from './doctor.js';
import type { Finding } from './doctor.js';
import type { Yaml } from './cli-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(process.env.HOMEDASH_APP ?? join(here, '..', '..'));
const ETC = resolve(process.env.HOMEDASH_ETC ?? '/etc/homedash');
const YAML_FILE = process.env.HOMEDASH_CONFIG ?? join(ETC, 'homedash.yaml');
const SECRETS_FILE = join(ETC, 'secrets.env');
const GENERATED_FILE = join(ETC, 'generated.env');
const ENV_FILE = process.env.HOMEDASH_ENV_FILE ?? join(APP, 'server', '.env');
const INFRA = join(APP, 'infra');
const OUT = join(ETC, 'rendered');
// Where vhosts and http-level snippets go: nginx.sites_dir / nginx.conf_dir in homedash.yaml, else these defaults.
let NGINX_SITES = resolve(process.env.HOMEDASH_NGINX_SITES ?? '/etc/nginx/sites-enabled');
let NGINX_CONF_D = resolve(process.env.HOMEDASH_NGINX_CONF_D ?? '/etc/nginx/conf.d');
const useNginxDirs = (y: Yaml) => {
  if (y.nginx?.sites_dir) NGINX_SITES = resolve(String(y.nginx.sites_dir));
  if (y.nginx?.conf_dir) NGINX_CONF_D = resolve(String(y.nginx.conf_dir));
};
const BEGIN = '# >>> managed by homedash-config (edit /etc/homedash/homedash.yaml, then run: homedash-config apply)';
const END = '# <<< end of managed block';
const MARK = 'managed by homedash-config';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (f: string) => args.includes(f);
const say = (s = '') => console.log(s);
const fail = (s: string): never => { console.error(`homedash-config: ${s}`); process.exit(1); };

// ---- small file helpers -----------------------------------------------------------------------
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function atomicWrite(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  try { chmodSync(tmp, mode); } catch { /* not supported on this platform */ }
  renameSync(tmp, path);
}

const quote = (v: string) => (/[\s#'"$\\]/.test(v) ? (v.includes('"') ? `'${v}'` : `"${v}"`) : v);

// ---- config loading ---------------------------------------------------------------------------
function loadYaml(): Yaml {
  if (!existsSync(YAML_FILE)) fail(`${YAML_FILE} does not exist. Run: homedash-config init`);
  try {
    const y = parse(readFileSync(YAML_FILE, 'utf8')) as Yaml | null;
    if (y === null || y === undefined) return {};
    if (typeof y !== 'object' || Array.isArray(y)) fail(`${YAML_FILE} must contain a mapping at the top level`);
    return y;
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /flow|[{}]/.test(msg) ? '\nHint: inside { } or [ ] write ${NAME} values in quotes, e.g. token: "${GRAFANA_TOKEN}"' : '';
    return fail(`${YAML_FILE}: ${msg}${hint}`);
  }
}

/** Secrets the tool creates once and keeps, so re-applying never rotates them. */
function ensureGenerated(y: Yaml, write: boolean): Record<string, string> {
  const g = readEnvFile(GENERATED_FILE);
  let changed = false;
  for (const name of neededGenerated(y)) {
    if (!g[name]) { g[name] = randomBytes(32).toString('hex'); changed = true; }
  }
  if (changed && write) atomicWrite(GENERATED_FILE, `# Generated by homedash-config; kept so applying never rotates these. Do not delete: DATASOURCE_KEY seals saved passwords.\n${Object.entries(g).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, 0o600);
  return g;
}

const DEFAULTS: Yaml = {
  addons: {
    alloy: { enabled: false, host_label: 'pve', environment: 'homelab', timezone: 'UTC', nginx_logs: true, guests: true, app_logs: [] },
    crowdsec: { enabled: false, container: 0, interval_seconds: 30 },
    prometheus: { enabled: false, scrape_interval: '15s', node_exporter_listen: '0.0.0.0:9100', targets: [] },
    loki_server: { enabled: false, port: 3100, retention_days: 31, nginx_retention_days: 14 },
    grafana: { provision: false },
  },
};
const merge = (a: any, b: any): any => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
  ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b);

function templateData(y: Yaml, env: Record<string, string>, generated: Record<string, string>): Yaml {
  const full = merge(DEFAULTS, y);
  const loki = (env.LOKI_URL ?? '').replace(/\/+$/, '');
  full.addons.prometheus.targets = (Array.isArray(full.addons.prometheus.targets) ? full.addons.prometheus.targets : []).map((t: Yaml) => ({
    ...t, target_list: (Array.isArray(t.targets) ? t.targets : []).map((x: unknown) => `"${x}"`).join(', '),
  }));
  return {
    ...full, env, hostname: hostname(), port: env.PORT ?? '3000',
    metrics_token: generated.METRICS_TOKEN ?? '',
    loki_push_url: full.addons.alloy.loki_push_url || (loki ? `${loki}/loki/api/v1/push` : ''),
    loki_listen_port: full.addons.loki_server.port,
    loki_retention_hours: Number(full.addons.loki_server.retention_days) * 24,
    loki_nginx_retention_hours: Number(full.addons.loki_server.nginx_retention_days) * 24,
    prometheus_url: env.PROMETHEUS_URL ?? '',
    prometheus_homedash_target: full.addons.prometheus.homedash_target || `localhost:${env.PORT ?? '3000'}`,
  };
}

// ---- rendering --------------------------------------------------------------------------------
interface Target { tmpl: string; out: string; when: boolean; mode?: number; each?: { list: string; name: (item: any) => string } }

/** Files copied verbatim: Grafana JSON uses {{...}} legends that the template engine must not touch. */
const RAW = (tmpl: string) => tmpl.endsWith('.json');

function targets(d: Yaml): Target[] {
  const a = d.addons;
  const t: Target[] = [];
  const stack = (f: string) => join(OUT, 'stack', f);
  const host = (f: string) => join(OUT, 'host', f);
  const sites = Array.isArray(d.nginx?.sites) ? d.nginx.sites : [];
  t.push({ tmpl: 'nginx/homedash.conf.tmpl', out: join(NGINX_SITES, 'homedash-app.conf'), when: !!d.nginx?.homedash?.domain });
  for (const s of sites) {
    const name = String(s.name ?? s.domain ?? '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
    t.push({ tmpl: 'nginx/site.conf.tmpl', out: join(NGINX_SITES, `homedash-site-${name}.conf`), when: true, each: { list: 'site', name: () => name } });
  }
  t.push({ tmpl: 'nginx/default-deny.conf.tmpl', out: join(NGINX_CONF_D, 'homedash-default-deny.conf'), when: d.nginx?.default_deny === true });
  t.push({ tmpl: 'nginx/json-log.conf.tmpl', out: join(NGINX_CONF_D, 'homedash-json-log.conf'), when: a.alloy.enabled && a.alloy.nginx_logs });

  t.push({ tmpl: 'alloy/config.alloy.tmpl', out: host('alloy/config.alloy'), when: a.alloy.enabled });
  t.push({ tmpl: 'alloy/alloy-guest-sources.tmpl', out: host('alloy/alloy-guest-sources'), when: a.alloy.enabled && a.alloy.guests, mode: 0o755 });
  t.push({ tmpl: 'alloy/alloy-guest-sources.service', out: host('alloy/alloy-guest-sources.service'), when: a.alloy.enabled && a.alloy.guests });
  t.push({ tmpl: 'alloy/alloy-guest-sources.timer', out: host('alloy/alloy-guest-sources.timer'), when: a.alloy.enabled && a.alloy.guests });
  t.push({ tmpl: 'alloy/alloy-override.conf', out: host('alloy/alloy-override.conf'), when: a.alloy.enabled });

  t.push({ tmpl: 'crowdsec/crowdsec-snapshot.tmpl', out: host('crowdsec/crowdsec-snapshot'), when: a.crowdsec.enabled, mode: 0o755 });
  t.push({ tmpl: 'crowdsec/crowdsec-snapshot.service.tmpl', out: host('crowdsec/crowdsec-snapshot.service'), when: a.crowdsec.enabled });
  t.push({ tmpl: 'crowdsec/crowdsec-snapshot.timer.tmpl', out: host('crowdsec/crowdsec-snapshot.timer'), when: a.crowdsec.enabled });
  t.push({ tmpl: 'crowdsec/grafana-crowdsec-dashboard.json', out: stack('grafana/dashboards/crowdsec.json'), when: a.crowdsec.enabled && a.grafana.provision });

  t.push({ tmpl: 'prometheus/node-exporter.default.tmpl', out: host('prometheus/prometheus-node-exporter'), when: a.prometheus.enabled });
  t.push({ tmpl: 'prometheus/prometheus.yml.tmpl', out: stack('prometheus/prometheus.yml'), when: a.prometheus.enabled, mode: 0o600 });
  t.push({ tmpl: 'loki/loki-config.yml.tmpl', out: stack('loki/loki-config.yml'), when: a.loki_server.enabled });
  t.push({ tmpl: 'grafana/datasource-loki.yaml.tmpl', out: stack('grafana/provisioning/datasources/loki.yaml'), when: a.grafana.provision && !!d.env.LOKI_URL });
  t.push({ tmpl: 'grafana/datasource-prometheus.yaml.tmpl', out: stack('grafana/provisioning/datasources/prometheus.yaml'), when: a.grafana.provision && !!d.env.PROMETHEUS_URL });
  t.push({ tmpl: 'grafana/dashboards.yaml.tmpl', out: stack('grafana/provisioning/dashboards/homedash.yaml'), when: a.grafana.provision });
  return t;
}

function maskedEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${/SECRET|TOKEN|KEY|PASSWORD|API/.test(k) && v ? '********' : v}`).join('\n');
}

function envBlock(env: Record<string, string>): string {
  return [BEGIN, ...Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`), END].join('\n');
}

/** Replaces the managed block, keeps everything outside it, and neutralises outside lines the block overrides. */
function mergeEnvFile(existing: string, env: Record<string, string>): string {
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('# >>> managed by homedash-config')) { inside = true; continue; }
    if (inside) { if (line.startsWith('# <<< end of managed block')) inside = false; continue; }
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && m[1] in env && !line.trim().startsWith('#')) out.push(`# overridden by homedash.yaml: ${line}`);
    else out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return `${out.join('\n')}${out.length ? '\n\n' : ''}${envBlock(env)}\n`;
}

// ---- commands ---------------------------------------------------------------------------------
function check(): { y: Yaml; env: Record<string, string>; generated: Record<string, string>; problems: string[] } {
  const y = loadYaml();
  const secrets = readEnvFile(SECRETS_FILE);
  const generated = ensureGenerated(y, false);
  const mapped = toEnv(y, secrets, generated);
  const problems = [...mapped.problems];
  for (const n of neededGenerated(y)) if (!generated[n]) generated[n] = '(generated on apply)';
  for (const n of mapped.notes) say(`note: ${n}`);
  return { y, env: toEnv(y, secrets, generated).env, generated, problems };
}

function showFeatures(env: Record<string, string>) {
  const rows = featureRows(env);
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) say(`  ${r.on ? 'ON ' : 'off'}  ${r.label.padEnd(w)}${r.on ? '' : `   (set: ${r.hint})`}`);
}

function cmdInit() {
  if (existsSync(YAML_FILE) && !flag('--force')) return say(`${YAML_FILE} already exists (use --force to overwrite).`);
  const example = join(INFRA, 'homedash.example.yaml');
  if (!existsSync(example)) fail(`${example} not found`);
  mkdirSync(ETC, { recursive: true });
  copyFileSync(example, YAML_FILE);
  if (!existsSync(SECRETS_FILE)) atomicWrite(SECRETS_FILE, '# Secrets referenced from homedash.yaml as ${NAME}. Keep this file private (mode 600).\n# PVE_TOKEN_SECRET=\n# GRAFANA_TOKEN=\n# KUMA_API_KEY=\n', 0o600);
  say(`Wrote ${YAML_FILE} and ${SECRETS_FILE}.`);
  say('Edit them, then run: homedash-config validate && homedash-config apply --restart');
}

function cmdValidate(): boolean {
  const { env, problems } = check();
  showFeatures(env);
  if (problems.length) { say(); for (const p of problems) say(`problem: ${p}`); say(`\n${problems.length} problem(s). Nothing was changed.`); return false; }
  say('\nConfiguration is valid.');
  return true;
}

async function cmdStatus() {
  const ok = cmdValidate();
  const { env } = check();
  const port = env.PORT ?? '3000';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/sso/config`, { signal: AbortSignal.timeout(3000) });
    say(`\nServer on port ${port}: ${res.ok ? 'running' : `answered HTTP ${res.status}`}`);
  } catch { say(`\nServer on port ${port}: not reachable (systemctl status homedash)`); }
  if (!ok) process.exitCode = 1;
}

async function cmdDoctor() {
  const { env, problems } = check();
  const out: Finding[] = [];
  if (problems.length) out.push({ id: 'config', label: 'Configuration', verdict: 'fail', detail: `${problems.length} problem(s): ${problems[0]}${problems.length > 1 ? ' (and more)' : ''}`, fix: 'Run: homedash-config validate' });
  const writable = (p: string) => { try { accessSync(p, fsc.W_OK); return true; } catch { return false; } };
  const dbPath = resolve(env.DB_PATH ?? join(APP, 'server', 'data', 'homedash.db'));
  out.push(...localFindings({
    nodeVersion: process.version,
    secretsMode: existsSync(SECRETS_FILE) && process.platform !== 'win32' ? statSync(SECRETS_FILE).mode : undefined,
    dbDirWritable: writable(dirname(dbPath)) || !existsSync(dirname(dbPath)),
    backupDir: env.BACKUP_DIR || undefined, backupDirWritable: env.BACKUP_DIR ? writable(env.BACKUP_DIR) : undefined,
    distDir: env.SERVE_DIST || undefined, distExists: env.SERVE_DIST ? existsSync(env.SERVE_DIST) : undefined,
  }));
  const insecure = new Agent({ connect: { rejectUnauthorized: false } });
  for (const t of targetsFor(env)) {
    const isPve = t.id.startsWith('proxmox');
    const url = isPve ? `${t.url.replace(/\/+$/, '')}/api2/json/version` : t.url;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000), redirect: 'manual',
        headers: t.pveToken ? { Authorization: `PVEAPIToken=${t.pveToken.id}=${t.pveToken.secret}` } : undefined,
        // @ts-expect-error undici dispatcher is not in the DOM fetch typings
        dispatcher: isPve && env.PVE_INSECURE_TLS === 'true' ? insecure : undefined,
      });
      out.push({ id: t.id, label: t.label, ...interpretHttp(t.label, res.status === 0 ? 302 : res.status, !!t.pveToken) });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      out.push({ id: t.id, label: t.label, ...interpretNetworkError(t.label, `${cause?.code ?? ''} ${cause?.message ?? (e as Error).message}`) });
    }
  }
  const mark = { ok: ' ok ', warn: 'warn', fail: 'FAIL' } as const;
  out.splice(0, out.length, ...softenFailover(out));
  for (const f of out) { say(`[${mark[f.verdict]}] ${f.label}: ${f.detail}`); if (f.fix && f.verdict !== 'ok') say(`       -> ${f.fix}`); }
  const n = summary(out);
  say(`
${n.ok} ok, ${n.warn} to look at, ${n.fail} failing.`);
  process.exitCode = exitCode(out);
}

function templateFor(tmpl: string, d: Yaml, item?: unknown): string {
  const file = join(INFRA, tmpl);
  if (!existsSync(file)) throw new Error(`template ${tmpl} not found in ${INFRA}`);
  const text = readFileSync(file, 'utf8');
  return RAW(tmpl) ? text : render(text, item === undefined ? d : { ...d, site: item });
}

function cmdApply() {
  const dry = flag('--dry-run');
  const y = loadYaml();
  useNginxDirs(y);
  const secrets = readEnvFile(SECRETS_FILE);
  const generated = ensureGenerated(y, !dry);
  const { env, problems, notes } = toEnv(y, secrets, generated);
  for (const n of notes) say(`note: ${n}`);
  if (problems.length) { for (const p of problems) console.error(`problem: ${p}`); fail(`${problems.length} problem(s) in ${YAML_FILE}; nothing was changed.`); }
  if (dry) for (const n of neededGenerated(y)) if (!generated[n]) env[n] = '(generated on apply)';

  const data = templateData(y, env, generated);
  const sites = Array.isArray(y.nginx?.sites) ? (y.nginx.sites as Yaml[]) : [];
  const wrote: string[] = [];

  // 1. server environment
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const nextEnv = mergeEnvFile(existing, env);
  if (nextEnv !== existing) {
    if (!dry) { if (existing) copyFileSync(ENV_FILE, `${ENV_FILE}.bak`); atomicWrite(ENV_FILE, nextEnv, 0o600); }
    wrote.push(ENV_FILE);
  }

  // 2. rendered files
  const nginxTouched: string[] = [];
  const plan = targets(data);
  const keepNginx = new Set<string>();
  for (const t of plan) {
    const isNginx = t.out.startsWith(NGINX_SITES) || t.out.startsWith(NGINX_CONF_D);
    if (isNginx && flag('--no-nginx')) continue;
    if (!t.when) continue;
    const site = t.each ? sites.find((s) => String(s.name ?? s.domain ?? '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-') === t.each!.name(null)) : undefined;
    let text: string;
    const item = site ? { ...site, id: String(site.name ?? site.domain).toLowerCase().replace(/[^a-z0-9]+/g, '_') } : undefined;
    try { text = templateFor(t.tmpl, data, item); } catch (e) { return fail((e as Error).message); }
    if (isNginx) keepNginx.add(t.out);
    const prev = existsSync(t.out) ? readFileSync(t.out, 'utf8') : null;
    if (prev === text) continue;
    if (!dry) {
      if (prev !== null && isNginx) copyFileSync(t.out, `${t.out}.bak`);
      atomicWrite(t.out, text, t.mode ?? 0o644);
    }
    wrote.push(t.out);
    if (isNginx) nginxTouched.push(t.out);
  }

  // 3. remove nginx vhosts for sites that are no longer declared (only files this tool wrote)
  if (!flag('--no-nginx') && existsSync(NGINX_SITES)) {
    for (const f of readdirSync(NGINX_SITES)) {
      const p = join(NGINX_SITES, f);
      if (!/^homedash-(site|app)/.test(f) || keepNginx.has(p) || f.endsWith('.bak')) continue;
      if (!readFileSync(p, 'utf8').includes(MARK)) continue;
      if (!dry) rmSync(p);
      wrote.push(`${p} (removed)`);
      nginxTouched.push(p);
    }
  }

  say(dry ? 'Dry run: nothing written. Would change:' : 'Applied:');
  for (const w of wrote) say(`  ${w}`);
  if (!wrote.length) say('  (already up to date)');

  // 4. nginx: validate, reload, roll back on failure
  if (!dry && nginxTouched.length) {
    try {
      execFileSync(String(y.nginx?.binary ?? 'nginx'), ['-t'], { stdio: 'pipe' });
      try { execFileSync('systemctl', ['reload', 'nginx'], { stdio: 'pipe' }); say('nginx: configuration valid, reloaded'); } catch { say('nginx: valid, but could not reload (is it running?)'); }
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        say('nginx: not installed here, so the new files were written but not validated');
      } else {
        for (const p of nginxTouched) {
          const bak = `${p}.bak`;
          if (existsSync(bak)) renameSync(bak, p); else rmSync(p, { force: true });
        }
        const msg = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? (e as Error).message;
        fail(`nginx rejected the new configuration, previous files restored:\n${msg}`);
      }
    }
  }

  if (!dry && wrote.some((w) => w.startsWith(OUT))) say(`\nHost and stack files are in ${OUT}. Install the host ones with tools/pve/host-addons.sh on the Proxmox host; copy stack/ to your Loki/Prometheus/Grafana containers.`);
  if (flag('--restart') && !dry) {
    try { execFileSync('systemctl', ['restart', 'homedash'], { stdio: 'pipe' }); say('homedash restarted'); } catch (e) { say(`could not restart homedash: ${(e as Error).message}`); }
  } else if (!dry && wrote.includes(ENV_FILE)) say('\nRestart to use the new settings: systemctl restart homedash   (or re-run with --restart)');
}

function cmdPrintEnv() {
  const { env, problems } = check();
  if (problems.length) { for (const p of problems) console.error(`problem: ${p}`); process.exitCode = 1; }
  say(maskedEnv(env));
}

const HELP = `homedash-config <command>

  init [--force]                  write ${YAML_FILE} and ${SECRETS_FILE}
  validate                        check the YAML and list which integrations are on
  status                          validate + ask the running server
  doctor                          try every address and folder in use; say what is wrong and how to fix it
  apply [--restart] [--dry-run] [--no-nginx]
                                  render ${ENV_FILE}, nginx vhosts and host/stack files
  print-env                       show the .env that apply would write (secrets masked)

Files: ${YAML_FILE}, ${SECRETS_FILE}, ${GENERATED_FILE}`;

switch (cmd) {
  case 'init': cmdInit(); break;
  case 'validate': if (!cmdValidate()) process.exitCode = 1; break;
  case 'status': await cmdStatus(); break;
  case 'doctor': await cmdDoctor(); break;
  case 'apply': cmdApply(); break;
  case 'print-env': cmdPrintEnv(); break;
  case 'help': case '--help': case '-h': say(HELP); break;
  default: say(HELP); process.exitCode = 1;
}
