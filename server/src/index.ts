import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { registerAdmin } from './admin.js';
import { registerApprovals } from './approvals.js';
import { registerAuth } from './auth.js';
import { registerPasskeys } from './passkeys.js';
import { registerTokens } from './tokens.js';
import { registerCrowdsec } from './crowdsec.js';
import { registerFeatures } from './features.js';
import { registerGpuWatch, startGpuWatch } from './gpuwatch.js';
import { registerLlama } from './llama.js';
import { registerLoki } from './loki.js';
import { registerMfa } from './mfa.js';
import { registerRateLimit } from './ratelimit.js';
import { registerScim } from './scim.js';
import { registerQemu } from './qemu.js';
import { registerVmOps } from './vmops.js';
import { cfg, dataConfigured } from './config.js';
import { closeDb, connectDb } from './db.js';
import { HttpError } from './errors.js';
import { registerGrafana } from './grafana.js';
import { registerGuests } from './guests.js';
import { registerHost } from './host.js';
import { registerMetrics } from './metrics.js';
import { registerScenes, startScheduler } from './scenes.js';
import { registerInsights } from './insights.js';
import { registerHealth, startHealth } from './health.js';
import { registerKuma, startKuma } from './kuma.js';
import { recordCleanStop, registerLogs, startEvents } from './events.js';
import { registerNginx } from './nginx.js';
import { registerNginxManage } from './nginx-manage.js';
import { registerAi } from './ai.js';
import { registerDiagnostics } from './diagnostics.js';
import { registerNode } from './node.js';
import { registerWindows } from './windows.js';
import { registerNotify, startNotify } from './notify.js';
import { registerOidc } from './oidc.js';
import { registerOverview } from './overview.js';

const app = Fastify({
  trustProxy: cfg.trustProxy,
  bodyLimit: 64 * 1024,
  logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
});

app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) req.log.error(err);
  return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message, code: status >= 500 ? 'INTERNAL' : err.code ?? 'BAD_REQUEST' });
});

app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `No route for ${req.method} ${req.url.split('?')[0]}`, code: 'NOT_FOUND' }));

const csp = [
  "default-src 'self'",
  // The hash covers the inline theme-bootstrap in index.html (prevents a theme flash). It must
  // match that script's exact bytes; if that script changes, update this hash.
  "script-src 'self' 'sha256-PL8BUHH3EqfFPbHYkB9eG/+gE1CS5DfaL0WPuyX5x8Q='",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:", // Vite inlines small font subsets as data: URIs
  "connect-src 'self'",
  `frame-src 'self' ${[cfg.grafanaPublicUrl, ...cfg.frameSrc].filter(Boolean).join(' ')}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Content-Security-Policy', csp);
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (cfg.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
});
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
});

connectDb();
await app.register(cookie);
registerRateLimit(app);
registerAuth(app);
registerApprovals(app); // a preHandler hook: must be registered before the routes it guards
registerMfa(app);
registerTokens(app);
registerPasskeys(app);
registerAdmin(app);
registerScim(app);
registerOidc(app);
registerLogs(app);
registerOverview(app);
registerGuests(app);
registerNode(app);
registerDiagnostics(app);
registerWindows(app);
registerAi(app);
registerNotify(app);
registerHost(app);
registerNginx(app);
registerNginxManage(app);
registerGrafana(app);
registerKuma(app);
registerMetrics(app);
registerFeatures(app);
registerLoki(app);
registerCrowdsec(app);
registerQemu(app);
registerVmOps(app);
registerLlama(app);
registerGpuWatch(app);
// The Data manager pulls in the database drivers (optional dependencies), so it is only loaded when switched on.
let closeData = async () => {};
if (dataConfigured()) {
  const data = await import('./data.js');
  data.registerData(app);
  closeData = data.closeData;
}
registerInsights(app);
registerHealth(app);
registerScenes(app);
if (cfg.serveDist) await app.register(staticFiles, { root: resolve(cfg.serveDist) });
startKuma(app);
startEvents(app);
startNotify(app);
startGpuWatch(app);
startHealth();
startScheduler();

const shutdown = async () => { await recordCleanStop(); await app.close(); await closeData(); closeDb(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
