import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { cfg } from './config.js';
import { insertAudit } from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { listSites } from './nginx.js';

const run = promisify(execFile);

// Writing nginx config is off unless NGINX_MANAGE=true. Every write is: backup, write, `nginx -t`,
// reload, and on a failed test the previous file is put back. Nothing user-supplied reaches a shell.

const MARK = '# managed by homedash';
const NAME_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const UPSTREAM_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SIZE_RE = /^\d{1,5}[kKmMgG]?$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const SSL_DIR = '/etc/ssl/homedash';

export interface SiteSpec {
  serverNames: string[]; upstream: string; websocket?: boolean; tls?: 'none' | 'selfsigned' | 'existing';
  certPath?: string; keyPath?: string; redirectHttp?: boolean; hsts?: boolean; maxBody?: string; file?: string;
}

const backupDir = () => join(dirname(cfg.dbPath), 'nginx-backups');
const bad = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg);

function validFile(name: string): string {
  if (!FILE_RE.test(name) || /\.(bak|old|orig|swp)$/.test(name)) throw bad('Invalid file name (letters, digits, dot, dash, underscore)');
  return name;
}

export function validateSpec(s: SiteSpec): Required<Pick<SiteSpec, 'serverNames' | 'upstream'>> & SiteSpec {
  const names = (s.serverNames ?? []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.length > 10) throw bad('Give between 1 and 10 server names');
  for (const n of names) if (!NAME_RE.test(n) || n.length > 253) throw bad(`Invalid server name: ${n.slice(0, 60)}`);
  if (!UPSTREAM_RE.test(String(s.upstream ?? ''))) throw bad('Upstream must look like http://10.0.0.5:8080 (no spaces or special characters)');
  const port = /:(\d{1,5})/.exec(s.upstream.replace(/^https?:\/\//, ''))?.[1];
  if (port && Number(port) > 65535) throw bad('Upstream port out of range');
  const tls = s.tls ?? 'none';
  if (!['none', 'selfsigned', 'existing'].includes(tls)) throw bad('Invalid tls option');
  if (tls === 'existing' && !(PATH_RE.test(s.certPath ?? '') && PATH_RE.test(s.keyPath ?? ''))) throw bad('Certificate and key must be absolute paths');
  if (s.maxBody && !SIZE_RE.test(s.maxBody)) throw bad('maxBody must look like 50m');
  return { ...s, serverNames: names, tls };
}

/** Renders a reverse-proxy site. Pure, so the UI can preview exactly what will be written. */
export function renderSite(spec: SiteSpec): string {
  const s = validateSpec(spec);
  const names = s.serverNames.join(' ');
  const tls = s.tls !== 'none';
  const cert = s.tls === 'existing' ? s.certPath! : `${SSL_DIR}/${s.serverNames[0].replace(/^\*\./, '_wildcard.')}.crt`;
  const key = s.tls === 'existing' ? s.keyPath! : cert.replace(/\.crt$/, '.key');
  const location = [
    '    location / {',
    `        proxy_pass ${s.upstream};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    ...(s.websocket ? ['        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection "upgrade";'] : []),
    '    }',
  ];
  const common = [`    server_name ${names};`, ...(s.maxBody ? [`    client_max_body_size ${s.maxBody};`] : [])];
  const out = [MARK, 'server {', '    listen 80;', '    listen [::]:80;', ...common];
  if (tls && s.redirectHttp !== false) out.push('    return 301 https://$host$request_uri;', '}');
  else out.push('', ...location, '}');
  if (tls && s.redirectHttp !== false) {
    out.push('', 'server {', '    listen 443 ssl;', '    listen [::]:443 ssl;', ...common,
      `    ssl_certificate ${cert};`, `    ssl_certificate_key ${key};`, '    ssl_protocols TLSv1.2 TLSv1.3;',
      ...(s.hsts ? ['    add_header Strict-Transport-Security "max-age=31536000" always;'] : []), '', ...location, '}');
  } else if (tls) {
    out.push('', 'server {', '    listen 443 ssl;', '    listen [::]:443 ssl;', ...common,
      `    ssl_certificate ${cert};`, `    ssl_certificate_key ${key};`, '    ssl_protocols TLSv1.2 TLSv1.3;', '', ...location, '}');
  }
  return out.join('\n') + '\n';
}

let lock: Promise<unknown> = Promise.resolve();
const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
};

async function nginx(args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await run(cfg.nginxBin, args, { timeout: 15_000 });
    return { ok: true, output: `${r.stdout}${r.stderr}`.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string; message: string };
    if (err.code === 'ENOENT') throw new HttpError(503, 'NGINX_MISSING', `nginx binary not found (${cfg.nginxBin}). Install nginx in this container.`);
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message };
  }
}

async function reload(): Promise<string | null> {
  const r = await nginx(['-s', 'reload']);
  return r.ok ? null : r.output;
}

async function backup(file: string): Promise<string | null> {
  const src = join(cfg.nginxDir, file);
  try { await stat(src); } catch { return null; }
  await mkdir(backupDir(), { recursive: true });
  const name = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(src, join(backupDir(), name));
  return name;
}

async function ensureSelfSigned(spec: SiteSpec) {
  const cn = spec.serverNames[0].replace(/^\*\./, '');
  const base = `${SSL_DIR}/${spec.serverNames[0].replace(/^\*\./, '_wildcard.')}`;
  try { await stat(`${base}.crt`); return; } catch { /* generate below */ }
  await mkdir(SSL_DIR, { recursive: true, mode: 0o700 });
  const san = spec.serverNames.map((n) => `DNS:${n}`).join(',');
  await run('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '825', '-keyout', `${base}.key`, '-out', `${base}.crt`,
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=${san}`], { timeout: 30_000 });
}

/** Backup, write, `nginx -t`, reload; restores the previous state if the test fails. */
async function apply(file: string, content: string, user: string, ip: string, mode: 'create' | 'update' | 'delete') {
  return exclusive(async () => {
    const path = join(cfg.nginxDir, file);
    let existed = true;
    try { await stat(path); } catch { existed = false; }
    if (mode === 'create' && existed) throw new HttpError(409, 'EXISTS', `${file} already exists; edit it instead`);
    if (mode !== 'create' && !existed) throw new HttpError(404, 'NOT_FOUND', `${file} does not exist`);
    const saved = await backup(file);
    const tmp = `${path}.homedash-tmp`;
    const rollback = async () => {
      if (saved) await copyFile(join(backupDir(), saved), path);
      else await rm(path, { force: true });
    };
    try {
      if (mode === 'delete') await rm(path);
      else { await writeFile(tmp, content, { mode: 0o644 }); await rename(tmp, path); }
    } catch (e) {
      await rm(tmp, { force: true });
      throw new HttpError(500, 'NGINX_WRITE', `Cannot write ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    const test = await nginx(['-t']);
    if (!test.ok) {
      await rollback();
      insertAudit({ ts: Date.now(), user, ip, vmid: 0, name: file, action: `nginx-${mode}`, result: 'refused', reason: test.output.slice(0, 300) });
      throw new HttpError(400, 'NGINX_TEST_FAILED', `nginx -t failed, nothing was changed:\n${test.output}`);
    }
    const reloadError = await reload();
    insertAudit({ ts: Date.now(), user, ip, vmid: 0, name: file, action: `nginx-${mode}`, result: 'accepted' });
    return { file, backup: saved, test: test.output, reloaded: reloadError === null, reloadError };
  });
}

async function certExpiry(content: string): Promise<{ cert: string | null; expires: string | null }> {
  const cert = /^\s*ssl_certificate\s+([^;\s]+);/m.exec(content.replace(/#.*$/gm, ''))?.[1] ?? null;
  if (!cert || !PATH_RE.test(cert)) return { cert, expires: null };
  try {
    const r = await run('openssl', ['x509', '-enddate', '-noout', '-in', cert], { timeout: 5000 });
    const d = new Date(r.stdout.replace('notAfter=', '').trim());
    return { cert, expires: Number.isNaN(d.getTime()) ? null : d.toISOString() };
  } catch { return { cert, expires: null }; }
}

const requireManage = () => { if (!cfg.nginxManage) throw notConfigured('Nginx management (set NGINX_MANAGE=true)'); };

export function registerNginxManage(app: FastifyInstance) {
  app.get('/api/nginx/manage', async () => {
    let version: string | null = null;
    if (cfg.nginxManage) {
      try { version = (await run(cfg.nginxBin, ['-v'], { timeout: 5000 }).then((r) => r.stderr || r.stdout)).trim(); } catch (e) { version = (e as { stderr?: string }).stderr?.trim() || null; }
    }
    return { enabled: cfg.nginxManage, dir: cfg.nginxDir, version };
  });

  app.get('/api/nginx/details', async () => {
    const sites = await listSites();
    return Promise.all(sites.map(async (s) => {
      let content = '';
      try { content = await readFile(join(cfg.nginxDir, s.file), 'utf8'); } catch { /* unreadable */ }
      const c = await certExpiry(content);
      return { file: s.file, managed: content.startsWith(MARK), cert: c.cert, certExpires: c.expires };
    }));
  });

  app.post<{ Body: SiteSpec }>('/api/nginx/preview', async (req) => {
    const spec = validateSpec(req.body ?? ({} as SiteSpec));
    const file = validFile(spec.file ?? `${spec.serverNames[0].replace(/^\*\./, 'wildcard.')}.conf`);
    return { file, content: renderSite(spec) };
  });

  app.get<{ Params: { file: string } }>('/api/nginx/sites/:file', async (req) => {
    const file = validFile(req.params.file);
    try { return { file, content: await readFile(join(cfg.nginxDir, file), 'utf8'), editable: cfg.nginxManage }; } catch { throw new HttpError(404, 'NOT_FOUND', `${file} does not exist`); }
  });

  app.post<{ Body: SiteSpec }>('/api/nginx/sites', async (req) => {
    requireManage();
    const spec = validateSpec(req.body ?? ({} as SiteSpec));
    const file = validFile(spec.file ?? `${spec.serverNames[0].replace(/^\*\./, 'wildcard.')}.conf`);
    if (spec.tls === 'selfsigned') {
      try { await ensureSelfSigned(spec); } catch (e) { throw new HttpError(500, 'CERT_FAILED', `Could not create the certificate: ${(e as Error).message}`); }
    } else if (spec.tls === 'existing') {
      for (const p of [spec.certPath!, spec.keyPath!]) { try { await stat(p); } catch { throw bad(`${p} does not exist`); } }
    }
    return apply(file, renderSite(spec), req.user!.username, req.ip, 'create');
  });

  app.put<{ Params: { file: string }; Body: { content?: string } }>('/api/nginx/sites/:file', async (req) => {
    requireManage();
    const file = validFile(req.params.file);
    const content = String(req.body?.content ?? '');
    if (!content.trim() || content.length > 200_000 || content.includes('\0')) throw bad('Config is empty or too large');
    return apply(file, content.endsWith('\n') ? content : `${content}\n`, req.user!.username, req.ip, 'update');
  });

  app.delete<{ Params: { file: string } }>('/api/nginx/sites/:file', async (req) => {
    requireManage();
    return apply(validFile(req.params.file), '', req.user!.username, req.ip, 'delete');
  });

  app.get<{ Params: { file: string } }>('/api/nginx/sites/:file/backups', async (req) => {
    const file = validFile(req.params.file);
    try {
      return (await readdir(backupDir())).filter((n) => n.startsWith(`${file}.`)).sort().reverse().slice(0, 20);
    } catch { return []; }
  });

  app.post<{ Params: { file: string }; Body: { backup?: string } }>('/api/nginx/sites/:file/restore', async (req) => {
    requireManage();
    const file = validFile(req.params.file);
    const name = String(req.body?.backup ?? '');
    if (!name.startsWith(`${file}.`) || name.includes('/') || name.includes('..')) throw bad('Invalid backup name');
    let content: string;
    try { content = await readFile(join(backupDir(), name), 'utf8'); } catch { throw new HttpError(404, 'NOT_FOUND', 'Backup not found'); }
    return apply(file, content, req.user!.username, req.ip, 'update');
  });

  app.post('/api/nginx/test', async () => { requireManage(); return nginx(['-t']); });
  app.post('/api/nginx/reload', async (req) => {
    requireManage();
    const test = await nginx(['-t']);
    if (!test.ok) throw new HttpError(400, 'NGINX_TEST_FAILED', `nginx -t failed, not reloading:\n${test.output}`);
    const err = await reload();
    if (err) throw new HttpError(502, 'NGINX_RELOAD', err);
    insertAudit({ ts: Date.now(), user: req.user!.username, ip: req.ip, vmid: 0, action: 'nginx-reload', result: 'accepted' });
    return { ok: true };
  });
}
