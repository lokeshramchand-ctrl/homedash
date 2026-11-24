// Audit trail: integrity check, export, and push to a syslog collector or webhook. See auditchain.ts for the hashing.
import { createHmac } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { hostname } from 'node:os';
import { connect } from 'node:net';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { verifyRows } from './auditchain.js';
import type { ChainFields } from './auditchain.js';
import { cfg } from './config.js';
import { auditRows, setAuditSink } from './db.js';
import { HttpError } from './errors.js';

type Row = ChainFields & { id: number; prev_hash: string | null; hash: string | null };

const sev = (r: string) => (r === 'accepted' ? 6 : r === 'refused' ? 4 : 3);
const cefEsc = (v: unknown, header = false) => String(v ?? '').replace(/\\/g, '\\\\').replace(header ? /\|/g : /=/g, (m) => `\\${m}`).replace(/\r?\n/g, ' ');

/** One audit row as ArcSight CEF. */
export function toCef(r: Row): string {
  const ext = [`rt=${r.ts}`, `suser=${cefEsc(r.user)}`, `src=${cefEsc(r.ip)}`, `outcome=${cefEsc(r.result)}`, `cs1Label=vmid cs1=${r.vmid}`, `cs2Label=chainHash cs2=${r.hash ?? ''}`, `msg=${cefEsc(r.reason)}`, `cs3Label=guest cs3=${cefEsc(r.name)}`];
  return `CEF:0|homedash|homedash|1|${cefEsc(r.action, true)}|${cefEsc(r.action, true)}|${r.result === 'accepted' ? 3 : r.result === 'refused' ? 5 : 7}|${ext.join(' ')}`;
}
export const toJson = (r: Row) => JSON.stringify({ id: r.id, time: new Date(r.ts).toISOString(), user: r.user, ip: r.ip, vmid: r.vmid, guest: r.name, action: r.action, result: r.result, task: r.task_id, reason: r.reason, cluster: r.cluster, prevHash: r.prev_hash, hash: r.hash });
const line = (r: Row, fmt: 'json' | 'cef') => (fmt === 'cef' ? toCef(r) : toJson(r));

/** RFC 5424 frame: facility authpriv (10). */
export const syslogFrame = (r: Row, fmt: 'json' | 'cef', host = hostname()) =>
  `<${10 * 8 + sev(r.result)}>1 ${new Date(r.ts).toISOString()} ${host.replace(/\s/g, '-') || '-'} homedash - AUDIT - ${line(r, fmt)}`;

function startSinks() {
  const x = cfg.auditExport;
  let udp: ReturnType<typeof createSocket> | null = null;
  const send = (r: Row) => {
    if (x.syslog) {
      try {
        const u = new URL(x.syslog), frame = syslogFrame(r, x.format), port = Number(u.port) || 514;
        if (u.protocol === 'tcp:') { const s = connect(port, u.hostname, () => s.end(`${frame}\n`)); s.setTimeout(5000, () => s.destroy()); s.on('error', () => {}); }
        else { if (!udp) { udp = createSocket(u.hostname.includes(':') ? 'udp6' : 'udp4'); udp.unref(); } udp.send(frame, port, u.hostname, () => {}); }
      } catch { /* bad AUDIT_SYSLOG: nothing to do per row */ }
    }
    if (x.webhookUrl) {
      const body = toJson(r);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (x.webhookSecret) headers['X-Homedash-Signature'] = `sha256=${createHmac('sha256', x.webhookSecret).update(body).digest('hex')}`;
      void fetch(x.webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) }).catch(() => {});
    }
  };
  if (x.syslog || x.webhookUrl) setAuditSink((r) => send(r));
}

export function registerAuditLog(app: FastifyInstance) {
  startSinks();
  // /api/admin/* is admin-only (roles.ts), which is who may read the whole trail.
  app.get('/api/admin/audit/verify', async () => verifyRows(auditRows()));
  app.get<{ Querystring: { after?: string; limit?: string; format?: string } }>('/api/admin/audit/export', async (req, reply: FastifyReply) => {
    const after = Number(req.query.after ?? 0) || 0, limit = Math.min(Math.max(Number(req.query.limit ?? 10000) || 10000, 1), 100000);
    const fmt = req.query.format === 'cef' ? 'cef' : req.query.format === 'json' || !req.query.format ? 'json' : null;
    if (!fmt) throw new HttpError(400, 'BAD_REQUEST', 'format must be json or cef');
    const rows = auditRows(after, limit);
    reply.header('Content-Type', 'application/x-ndjson; charset=utf-8').header('X-Last-Id', String(rows.at(-1)?.id ?? after));
    return rows.map((r) => line(r, fmt)).join('\n') + (rows.length ? '\n' : '');
  });
}
