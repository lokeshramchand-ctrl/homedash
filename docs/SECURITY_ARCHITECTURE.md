# Security architecture

Facts below are from the code unless marked **not verified**.

## Sign-in and sessions
Local passwords (scrypt), TOTP, passkeys, OIDC authorization code with PKCE, state and nonce, ID-token signature check against the provider's key set (RS256, RS384, RS512, ES256), API tokens for scripts and the phone app. SSO stays off unless allowed users or a required role are set. Sessions can be listed and revoked (`/api/admin`). Platform sign-in is separate from integration credentials, which live only in sealed storage.

## Authorisation
Three roles by route: viewer reads, operator changes state, admin administers (`roles.ts`). Teams limit which guests a person sees. Destructive actions can require a second administrator (four-eyes approvals). Per-integration or per-resource permissions do not exist yet.

## Secrets
Sealed with AES-256-GCM, row id as associated data. Never returned by the API (only "set or not"), never in logs or audit lines. Webhook receiver secrets are stored as SHA-256 and shown once.

## Outbound requests
Timeouts and size limits on every call. Redirects are not followed. Link-local and cloud-metadata addresses are always refused for addresses entered in the UI; loopback is refused for database connections unless allowed. Monitoring sources and the Identity inspector allow LAN and loopback addresses on purpose and are administrator-only. Per source, a self-signed certificate can be accepted (verification off for that source only). Trusted private CAs: supported for database connections, **not yet** for monitoring sources.

## Identity inspector
Reads the public discovery document and key set only. It sends no credential. It copies only whitelisted public fields from keys, so private key parts are never passed on; if a provider publishes private parts it reports that as an error. The client secret of homedash's own sign-in is never included in any answer.

## Service registry
Reads are for any signed-in user; writes are administrator-only and audited. A service address must start with http or https (so `javascript:` is refused).

## Audit
Hash-chained audit with JSON and CEF export, syslog and signed webhook sinks. Registry and identity actions are written to the event log.

## Not verified
Passkeys with a real authenticator, SCIM with a real provider, every alert channel against its real service, behaviour under hostile network conditions, any penetration test.
