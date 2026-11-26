// Feeds the merged monitoring list into the notifier: one alert per new problem, one recovery when it clears.
// Imports notify.ts; nothing imports this file except index.ts, so there is no cycle with the Kuma event path.
import type { FastifyInstance } from 'fastify';
import { persistEvent, syncProblems } from '../notify.js';
import { problemsFrom } from './engine.js';
import { monitoringEngine, providerRaises } from './sources.js';

type Engine = Pick<typeof monitoringEngine, 'pollAll' | 'merged' | 'failures'>;

/**
 * One cycle. `merged()` keeps the last known problems of a source that stopped answering, so a failed read leaves them raised
 * (no false recovery) and, after two failures in a row, adds one "unreachable" problem of its own.
 */
export async function watchMonitoring(engine: Engine = monitoringEngine, raises: (kind: string) => boolean = providerRaises) {
  await engine.pollAll();
  syncProblems('mon', 'monitor', problemsFrom(engine.merged(), raises, (id) => engine.failures(id)), (level, text) => persistEvent(level, 'monitor', text));
}

const POLL_MS = 10_000; // Kuma reads a local snapshot and Grafana has its own 30 s cache, so this is cheap
export function startMonitoring(app: FastifyInstance) {
  const run = () => watchMonitoring().catch((e) => app.log.warn({ err: (e as Error).message }, 'monitoring watch failed'));
  setTimeout(run, 5_000).unref();
  setInterval(run, POLL_MS).unref();
}
