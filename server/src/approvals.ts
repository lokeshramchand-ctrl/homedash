// Four-eyes approval for risky actions. Which actions need it is policy (access.approvals.actions in homedash.yaml).
//
//   1. Someone calls a risky endpoint. It is refused with 409 APPROVAL_REQUIRED and an approval request is created.
//   2. A DIFFERENT administrator (signed in with a session, not a token) approves or rejects it on the Access page.
//   3. The requester repeats the exact same request with the header  X-Approval-Id: <id>. It runs once; the approval
//      is spent atomically, tied to the requester, to the exact method + path + body, and it expires.
//
// Nothing is executed on behalf of the approver, so the audit trail always names the person who asked.
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cfg } from './config.js';
import { consumeApproval, createApproval, decideApproval, findOpenApproval, getApproval, listApprovals } from './db.js';
import type { ApprovalRow } from './db.js';
import { HttpError } from './errors.js';
import { logEvent } from './events.js';
import { alert } from './notify.js';
import { decodedPath } from './pathutil.js';

interface Rule { action: string; method: string; route: string; when?: (req: FastifyRequest) => boolean; summary: (p: Record<string, string>) => string }

export const RULES: Rule[] = [
  { action: 'host.shutdown', method: 'POST', route: '/api/host/shutdown', summary: () => 'Power off the whole Proxmox node' },
  { action: 'snapshot.rollback', method: 'POST', route: '/api/guests/:vmid/snapshots/:name/rollback', summary: (p) => `Roll guest ${p.vmid} back to snapshot "${p.name}" (loses everything since)` },
  { action: 'snapshot.delete', method: 'DELETE', route: '/api/guests/:vmid/snapshots/:name', summary: (p) => `Delete snapshot "${p.name}" of guest ${p.vmid}` },
  { action: 'guest.stop', method: 'POST', route: '/api/guests/:vmid/:action', when: (r) => ['stop', 'reset'].includes((r.params as { action?: string }).action ?? ''), summary: (p) => `Force ${p.action} guest ${p.vmid} (no clean shutdown)` },
  { action: 'vm.clone', method: 'POST', route: '/api/guests/:vmid/vm/clone', summary: (p) => `Clone VM ${p.vmid}` },
  { action: 'nginx.delete', method: 'DELETE', route: '/api/nginx/sites/:file', summary: (p) => `Delete the nginx site ${p.file}` },
  { action: 'nginx.change', method: 'POST', route: '/api/nginx/sites', summary: () => 'Create an nginx site' },
  { action: 'nginx.change', method: 'PUT', route: '/api/nginx/sites/:file', summary: (p) => `Change the nginx site ${p.file}` },
  { action: 'nginx.change', method: 'POST', route: '/api/nginx/sites/:file/restore', summary: (p) => `Restore a backup of the nginx site ${p.file}` },
];
export const ACTIONS = [...new Set(RULES.map((r) => r.action))];

const required = (action: string) => cfg.access.approvals.actions.includes('*') || cfg.access.approvals.actions.includes(action);
const fingerprint = (method: string, path: string, body: unknown) =>
  createHash('sha256').update(`${method}\n${path}\n${JSON.stringify(body ?? null)}`).digest('hex');

const view = (a: ApprovalRow) => ({
  id: a.id, action: a.action, summary: a.summary, method: a.method, path: a.path, body: a.body ? JSON.parse(a.body) : null, requestedBy: a.requestedBy,
  createdAt: new Date(a.createdAt).toISOString(), expiresAt: new Date(a.expiresAt).toISOString(), status: a.status !== 'pending' && a.status !== 'used' && a.expiresAt < Date.now() ? 'expired' : a.status,
  decidedBy: a.decidedBy, decidedAt: a.decidedAt ? new Date(a.decidedAt).toISOString() : null, note: a.note,
});

export function registerApprovals(app: FastifyInstance) {
  // Runs after the body is parsed, so the fingerprint covers exactly what will be executed.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!cfg.access.approvals.actions.length || !req.user) return;
    const route = req.routeOptions?.url ?? '';
    const rule = RULES.find((r) => r.method === req.method && r.route === route && (!r.when || r.when(req)));
    if (!rule || !required(rule.action)) return;

    const path = decodedPath(req.url);
    const fp = fingerprint(req.method, path, req.body);
    const given = String(req.headers['x-approval-id'] ?? '').trim();
    if (given) {
      const a = getApproval(given);
      const ok = !!a && a.fingerprint === fp && a.requestedById === req.user.id && a.status === 'approved' && a.expiresAt > Date.now();
      if (!ok || !consumeApproval(given)) throw new HttpError(403, 'APPROVAL_INVALID', 'That approval does not match this request, is not approved, has expired or was already used');
      logEvent('warn', 'auth', `Approved action ${rule.action} run by ${req.user.username} (approval ${given.slice(0, 8)}, approved by ${a!.decidedBy})`, { ip: req.ip });
      return;
    }

    const summary = rule.summary(req.params as Record<string, string>);
    const open = findOpenApproval(fp, req.user.id);
    const a = open ?? (() => {
      const id = randomUUID();
      createApproval({
        id, action: rule.action, summary, method: req.method, path, body: req.body === undefined ? null : JSON.stringify(req.body), fingerprint: fp,
        requestedBy: req.user!.username, requestedById: req.user!.id, ip: req.ip, expiresAt: Date.now() + cfg.access.approvals.ttlMinutes * 60_000,
      });
      logEvent('warn', 'auth', `Approval requested by ${req.user!.username}: ${summary}`, { ip: req.ip });
      alert('auth', 'warn', 'Approval needed', `${req.user!.username} wants to: ${summary}. Approve or reject it on the Access page.`, `approval|${id}`);
      return getApproval(id)!;
    })();
    reply.code(409).send({
      error: a.status === 'approved' ? 'Approved: repeat the request with the approval id' : 'This action needs a second person to approve it',
      code: a.status === 'approved' ? 'APPROVAL_GRANTED' : 'APPROVAL_REQUIRED', approval: view(a),
    });
    return reply;
  });

  app.get('/api/approvals', async (req) => {
    const all = req.user!.role === 'admin' && !req.user!.scope;
    return {
      policy: { actions: cfg.access.approvals.actions, ttlMinutes: cfg.access.approvals.ttlMinutes, allowSelf: cfg.access.approvals.allowSelf, known: ACTIONS },
      canDecide: all && req.user!.via === 'session',
      items: listApprovals(100).filter((a) => all || a.requestedById === req.user!.id).map(view),
    };
  });

  const decide = (status: 'approved' | 'rejected') => async (req: FastifyRequest<{ Params: { id: string }; Body: { note?: string } }>) => {
    if (req.user!.role !== 'admin' || req.user!.scope || req.user!.via !== 'session') throw new HttpError(403, 'FORBIDDEN', 'Only an administrator signed in with a session can decide');
    const a = getApproval(req.params.id);
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'No such approval request');
    if (a.requestedById === req.user!.id && !cfg.access.approvals.allowSelf) throw new HttpError(403, 'SELF_APPROVAL', 'You cannot decide your own request: another administrator has to');
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null;
    if (!decideApproval(a.id, status, req.user!.username, note)) throw new HttpError(409, 'NOT_PENDING', 'This request is no longer pending (decided, used or expired)');
    logEvent('warn', 'auth', `${req.user!.username} ${status} "${a.summary}" requested by ${a.requestedBy}`, { ip: req.ip });
    alert('auth', status === 'approved' ? 'warn' : 'info', `Request ${status}`, `${req.user!.username} ${status} "${a.summary}" (asked by ${a.requestedBy})`, `approval|${a.id}|${status}`);
    return view(getApproval(a.id)!);
  };
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/api/approvals/:id/approve', decide('approved'));
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/api/approvals/:id/reject', decide('rejected'));
}
