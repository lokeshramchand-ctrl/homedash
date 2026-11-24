// In-memory fixed-window limiter covering every /api request (matched or not), per client IP:
//  1. a global bucket across all endpoints,
//  2. a bucket per endpoint (method + route pattern), stricter for state-changing calls,
//  3. a tight bucket for login and a connection-rate bucket for the SSE stream.
// A stolen session or a runaway loop therefore cannot hammer Proxmox, Mongo or any integration.
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import { isApiRequest } from './pathutil.js';

const WINDOW_MS = 60_000;
const num = (name: string, d: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : d; };
const LIMITS = {
  global: num('RATE_GLOBAL_PER_MIN', 1500),
  read: num('RATE_READ_PER_MIN', 400),
  write: num('RATE_WRITE_PER_MIN', 40),
  login: num('RATE_LOGIN_PER_MIN', 10),
  events: num('RATE_EVENTS_PER_MIN', 30),
};
const buckets = new Map<string, { n: number; reset: number }>();

/** Counts one hit; returns the bucket (and whether it is over `max`). */
function hit(key: string, max: number, now: number) {
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + WINDOW_MS }; buckets.set(key, b); }
  b.n++;
  return { b, over: b.n > max, max };
}

export function registerRateLimit(app: FastifyInstance) {
  setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k); }, WINDOW_MS).unref();
  app.addHook('onRequest', async (req, reply) => {
    // Same test as the auth hook: a percent-encoded "/%61pi/..." is routed to /api, so it must be counted too.
    if (!isApiRequest(req.url, req.routeOptions?.url)) return;
    const now = Date.now();
    const write = !(req.method === 'GET' || req.method === 'HEAD');
    // Unmatched paths share one bucket per method so scanning random URLs cannot create unbounded keys.
    const route = req.routeOptions?.url ?? '(unmatched)';
    const checks = [hit(`g|${req.ip}`, LIMITS.global, now)];
    if (route === '/api/events') checks.push(hit(`e|${req.ip}`, LIMITS.events, now));
    else checks.push(hit(`r|${req.method}|${route}|${req.ip}`, write ? LIMITS.write : LIMITS.read, now));
    if (route === '/api/auth/login' || route === '/api/auth/mfa/verify' || route === '/api/auth/passkey/login/verify') checks.push(hit(`l|${req.ip}`, LIMITS.login, now));
    const tight = checks.reduce((a, c) => (c.max - c.b.n < a.max - a.b.n ? c : a));
    reply.header('X-RateLimit-Limit', tight.max);
    reply.header('X-RateLimit-Remaining', Math.max(0, tight.max - tight.b.n));
    const blocked = checks.find((c) => c.over);
    if (blocked) {
      reply.header('Retry-After', Math.max(1, Math.ceil((blocked.b.reset - now) / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests, slow down');
    }
  });
}
