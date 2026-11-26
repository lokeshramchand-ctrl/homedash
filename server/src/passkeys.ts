// Passkeys (WebAuthn): sign in with a device or security key instead of a password, phishing-resistant by design.
// A passkey is verified with user verification (biometric or PIN) on the device, so it counts as both factors and
// the session it creates skips the TOTP step. Credentials are discoverable, so the login page needs no username.
//
// Needs two settings, because the browser binds a passkey to a site: WEBAUTHN_RP_ID (the domain, e.g. dash.example.com)
// and WEBAUTHN_ORIGIN (https://dash.example.com). Passkeys only work over HTTPS (or http://localhost).
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { completeSignIn, createSession } from './auth.js';
import { cfg, passkeysConfigured } from './config.js';
import {
  addPasskey, bumpPasskey, deletePasskey, findPasskey, findUserById, listPasskeys, saveChallenge, takeChallenge,
} from './db.js';
import { HttpError, notConfigured } from './errors.js';
import { logEvent } from './events.js';
import { alert } from './notify.js';
import { parseRole } from './roles.js';

const W = cfg.access.webauthn;
const TTL = 5 * 60_000;
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const need = () => { if (!passkeysConfigured()) throw notConfigured('Passkeys (WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN)'); };

export function registerPasskeys(app: FastifyInstance) {
  // Public: lets the login page decide whether to show the button.
  app.get('/api/auth/passkey/config', async () => ({ enabled: passkeysConfigured() }));

  app.get('/api/auth/passkeys', async (req) => listPasskeys(req.user!.id).map((p) => ({
    id: p.id, name: p.name, createdAt: new Date(p.createdAt).toISOString(), lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt).toISOString() : null,
  })));

  app.post('/api/auth/passkeys/register/options', async (req) => {
    need();
    const u = findUserById(req.user!.id);
    if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
    const options = await generateRegistrationOptions({
      rpName: W.rpName, rpID: W.rpId, userName: u.username, userDisplayName: u.username.replace(/^sso:/, ''),
      userID: new TextEncoder().encode(String(u.id)), attestationType: 'none', timeout: TTL,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: listPasskeys(u.id).map((p) => ({ id: p.credentialId, transports: p.transports as never })),
    });
    const challengeId = randomBytes(18).toString('base64url');
    saveChallenge(challengeId, u.id, options.challenge, 'register', TTL);
    return { challengeId, options };
  });

  app.post<{ Body: { challengeId?: string; response?: RegistrationResponseJSON; name?: string } }>('/api/auth/passkeys/register/verify', async (req) => {
    need();
    const ch = takeChallenge(String(req.body?.challengeId ?? ''), 'register');
    if (!ch || ch.userId !== req.user!.id || !req.body?.response) throw new HttpError(400, 'BAD_REQUEST', 'The registration expired. Start again.');
    let v;
    try {
      v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: ch.challenge, expectedOrigin: W.origin, expectedRPID: W.rpId, requireUserVerification: true });
    } catch (e) {
      throw new HttpError(400, 'PASSKEY_REJECTED', `The passkey could not be verified: ${(e as Error).message}`);
    }
    if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'PASSKEY_REJECTED', 'The passkey could not be verified');
    const c = v.registrationInfo.credential;
    if (findPasskey(c.id)) throw new HttpError(409, 'DUPLICATE', 'This passkey is already registered');
    const name = String(req.body.name ?? '').trim().slice(0, 60) || 'Passkey';
    addPasskey({ userId: req.user!.id, credentialId: c.id, publicKey: b64u(c.publicKey), counter: c.counter, transports: (c.transports ?? []) as string[], name });
    logEvent('warn', 'auth', `Passkey "${name}" added for ${req.user!.username}`, { ip: req.ip });
    alert('auth', 'warn', 'Passkey added', `${req.user!.username} added "${name}" from ${req.ip}`);
    return { ok: true, name };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', async (req) => {
    if (!deletePasskey(Number(req.params.id), req.user!.id)) throw new HttpError(404, 'NOT_FOUND', 'No such passkey');
    logEvent('warn', 'auth', `Passkey #${req.params.id} removed for ${req.user!.username}`, { ip: req.ip });
    alert('auth', 'warn', 'Passkey removed', `${req.user!.username} removed a passkey from ${req.ip}`);
    return { ok: true };
  });

  // ---- sign in (public) ----
  app.post('/api/auth/passkey/login/options', async () => {
    need();
    const options = await generateAuthenticationOptions({ rpID: W.rpId, userVerification: 'required', timeout: TTL });
    const challengeId = randomBytes(18).toString('base64url');
    saveChallenge(challengeId, null, options.challenge, 'login', TTL);
    return { challengeId, options };
  });

  app.post<{ Body: { challengeId?: string; response?: AuthenticationResponseJSON } }>('/api/auth/passkey/login/verify', async (req, reply) => {
    need();
    const fail = () => new HttpError(401, 'BAD_CREDENTIALS', 'That passkey could not be verified');
    const ch = takeChallenge(String(req.body?.challengeId ?? ''), 'login');
    const resp = req.body?.response;
    if (!ch || !resp?.id) throw fail();
    const pk = findPasskey(resp.id);
    const user = pk ? findUserById(pk.userId) : null;
    if (!pk || !user || user.disabled) throw fail();
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: resp, expectedChallenge: ch.challenge, expectedOrigin: W.origin, expectedRPID: W.rpId, requireUserVerification: true,
        credential: { id: pk.credentialId, publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')), counter: pk.counter, transports: pk.transports as never },
      });
    } catch (e) {
      req.log.warn({ ip: req.ip, err: (e as Error).message }, 'passkey rejected');
      throw fail();
    }
    if (!v.verified) throw fail();
    bumpPasskey(pk.id, v.authenticationInfo.newCounter);
    // Passkey with user verification = two factors in one: the session is complete, no TOTP step.
    await createSession(req, reply, user.id, user.username, { role: parseRole(user.role, 'admin'), mfa: 'ok' });
    completeSignIn(req, user);
    req.log.info({ username: user.username, ip: req.ip }, 'login (passkey)');
    return { username: user.username, mfa: 'none' };
  });
}
