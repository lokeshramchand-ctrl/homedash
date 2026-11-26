# Product audit

Date: 2026-11-26. Scope: the whole repository at commit `b032796` plus the changes made in this pass (listed in section 15).

How to read this: **Verified** means I ran it or read the code that does it in this session, and the way is stated. **Not verified** means I did not, and it is not claimed.

## 1. Existing architecture

| Part | What it is | Evidence |
|---|---|---|
| Server | Fastify 5, TypeScript, embedded SQLite (`node:sqlite`), about 15,300 lines in 78 top-level modules plus `monitoring/` and `datasources/` | `server/src` |
| Web | React 18 + Vite, hash router, about 8,500 lines, 30 pages, no UI framework (own components in `src/components/ui.tsx`) | `src` |
| Mobile | Expo / React Native, 14 screens, API-token sign-in, token kept in `expo-secure-store` | `mobile/src`, `session.tsx:3` |
| Deployment | Proxmox community-scripts layout (`ct/`, `install/`, `json/`), Dockerfile, `docker-compose.yml`, config templates in `infra/` | repository root |
| Config | One YAML file (`homedash.yaml`) converted to environment variables by `homedash-config`; secrets are `${NAME}` references | `server/src/cli-schema.ts`, `HANDOFF.md` |

Data flow: external tool, then a server module (poller or on-demand call), then SQLite or memory, then `/api/*` JSON, then the web page or mobile screen. Everything is **polling**: a search for WebSocket and server-sent events in `server/src` found none, so there is no push to the browser.

Three separate "connect a tool" mechanisms exist and do not share a contract:

1. **Monitoring sources** (`server/src/monitoring/`): pull or push providers (Kuma, Grafana, Prometheus, Alertmanager, JSON, custom HTTP, service checks, webhook) with data-defined templates. Admin-connectable from the UI, secrets sealed.
2. **Service tiles** (`tile-kinds.ts`, `tiles.ts`): 21 kinds for the Services page.
3. **Data sources** (`datasources/core`): 7 database engines with their own store, audit and network guard.

Plus native modules written one by one (Proxmox, Loki, CrowdSec, Nginx, GPU, LLM).

## 2. Existing features (from the code and `HANDOFF.md`, `CHANGELOG.md`)

Proxmox multi-cluster (nodes, guests, QEMU/LXC power, snapshots, tasks, HA, migration with pre-flight, backups view, capacity forecast), health score, scenes and schedules, alert pipeline (10 channels, routes, silences, de-duplication), Loki logs and analytics, CrowdSec page, database manager, Grafana embed, Kuma history, Services tiles, public status page, access control (OIDC login, SCIM, teams, API tokens, TOTP, passkeys, four-eyes approvals), hash-chained audit with SIEM export, self-backup, PWA, built-in HTTPS, config-as-code policy.

## 3. Working (verified)

- Server unit and integration tests: 290 of 290 pass (full suite, this session).
- `tsc` is clean for server, web and mobile (run in this session).
- Web production build succeeds (`vite build`).
- Browser pass: the Playwright smoke test opened every page (27 including the three added here) against a real backend with a mock Proxmox, and reported no script errors or error-boundary crashes. The new registry and identity pages were also exercised by clicking (add, depend, impact, remove).

## 4. Incomplete

- OIDC login exists but there was no way to see what the provider publishes or whether homedash's settings fit it (added: Identity page).
- CrowdSec depends on a root-owned snapshot file written by a host timer; without it the page has no data.
- Loki is read-only; no live tail.
- No InfluxDB engine in the database manager.
- Mobile has no push receiver of its own; it relies on the ntfy app.

## 5. Broken or suspicious (observed)

- In the browser pass, the Nginx page returned HTTP 500 twice in an environment with no nginx. The cause was not investigated; it may be an expected "not installed" case reported as an error.
- Pages for integrations that are not set up log HTTP 503 as browser console errors. The UI explains them, but the console noise would hide real errors.
- The axe test reported a colour-contrast finding on the Overview health ring (axe measured the score text against the ring arc). Fixed afterwards; all 15 browser tests pass.
- `HANDOFF.md` is stale: it says every UI page was never opened in a browser and 121 tests pass. Both are now different.

## 6. Missing against the product brief

| Brief item | State |
|---|---|
| Service registry with dependencies | **Added in this pass** (server, web, mobile read-only) |
| Incidents (correlated, acknowledged, with timeline) | Missing. A persisted event timeline exists; no incident entity |
| Configuration drift | Missing (policy-as-code exists, but no snapshots or diffs) |
| OPNsense page, firewall, DHCP, VPN, topology | Missing as a native module. A gateway-health template was added (section 15) |
| Integration capabilities (DISCOVER, MONITOR, METRICS, LOGS, EVENTS, CONFIG_READ/WRITE, MANAGE, EXECUTE, NOTIFY) | Missing. See `INTEGRATION_ARCHITECTURE.md` |
| Resource-level permissions | Missing. Three roles (viewer, operator, admin) plus team scoping of guests |
| Real-time updates | Missing (polling only) |
| InfluxDB, TrueNAS, Synology, Wazuh, Docker/Portainer detail | Docker and Portainer exist as tiles only; the others are missing |
| Customisable dashboards | Partial: Services layout and per-user prefs; Overview is fixed |

## 7. Security review (read from code)

Good: sealed secrets (AES-256-GCM with the row id as associated data), secrets never returned by the API, uniform 401 on the webhook with hashed secret and rate limits, CSP header, role gate by route prefix, destination guard for connections made from the UI (link-local always refused), four-eyes approvals, hash-chained audit.

Weaknesses:

- Roles are coarse. Anything under `/api/admin` is all-or-nothing; there is no per-integration permission.
- `ADMIN_PREFIXES` and `ADMIN_WRITE_PREFIXES` in `roles.ts` are a hand-kept list. A new write route outside those prefixes is operator-level by default; each new route needs a deliberate check (done for the routes added here, and covered by tests).
- Trusted private CA support exists per data connection (`ca`), but not for monitoring sources, which can only "accept a self-signed certificate" (turns verification off for that source).
- The identity inspector and the monitoring sources make server-side requests to administrator-supplied addresses. They refuse link-local and cloud-metadata ranges but allow LAN and loopback, because LAN is the point; that is a deliberate trade-off and an administrator-only capability.
- Not verified: passkeys with a real authenticator, SCIM with a real identity provider, every alert channel against its real service.

## 8. UX problems

- Navigation has 27 entries in 8 groups on one list; there is no module grouping by persona.
- Every page is a different shape; there is no shared status vocabulary across pages (the registry introduces healthy, degraded, down, stale, unknown, not monitored).
- Overview is fixed, not configurable.
- Mobile is a read-mostly companion with 5 tabs and a More menu; it supports guest actions but has no security or network views.

## 9. Integration limitations

Templates were checked against each tool's documentation, not run against real installations (`docs/MONITORING.md`). Only the mock-server round trips are tested. This applies to every provider, including the ones added here.

## 10. Database and API limits

- Schema changes are applied by `CREATE TABLE IF NOT EXISTS` plus a list of `ALTER TABLE ... ADD COLUMN` calls (`db.ts: migrate()`). There is no version table, so a destructive change cannot be expressed or rolled back.
- The API is unversioned (`/api/...`). A generated reference exists (`GET /api/admin/openapi.json`).
- SQLite is a single writer. Fine at this scale; stated so the limit is known.

## 11. Performance concerns

Not measured. Known shape: every integration polls on its own timer; a large number of sources multiplies outbound requests. The monitoring engine honours a per-source interval and stops reading a source that fails twice, but there is no global budget.

## 12. Technical debt

1. Three connection frameworks (section 1) with no common capability declaration.
2. Hand-kept role prefixes.
3. No versioned migrations.
4. `HANDOFF.md` out of date.
5. Page components are large single files with local state.

## 13. Recommended architecture

Keep the modular monolith and SQLite. Put a single **integration contract** over the three mechanisms (see `INTEGRATION_ARCHITECTURE.md`): an integration declares which capabilities it has, and the catalogue, the form and the permission check read that declaration. Add the normalised entities that are missing (incident, configuration snapshot) beside the registry that now exists. Add a migration table before the next schema change that is not additive.

## 14. Roadmap

See `IMPLEMENTATION_ROADMAP.md`.

## 15. What this pass changed, and how it was checked

| Change | Checked by |
|---|---|
| Six monitoring templates: OPNsense gateways, Loki ruler alerts, Loki readiness, authentik, Keycloak, Authelia health | `server/test/monitoring-templates.test.mjs` (mock server in the documented shape; checks the request that was sent and what was read). **Not run against real installations.** |
| Identity inspector: reads an OIDC provider's discovery document and key set, explains problems, compares with homedash's own sign-in settings; never returns the client secret; refuses link-local destinations | `server/test/identity.test.mjs` (pure analysis, redirects, non-JSON, forbidden destinations); browser test for the refusal |
| Service registry: services, dependencies, loop refusal, impact, health from linked checks, "not monitored" is never "healthy"; viewers read, administrators write | `server/test/registry.test.mjs` (including role checks over HTTP), browser test `e2e/registry.spec.ts` |
| Mobile read-only Services screen | `tsc` only. **Not run on a device.** |
| All pages in the smoke test now include Alerts and sources, Service registry, Identity | `e2e/smoke.spec.ts` |

Final test numbers are in the last section of `IMPLEMENTATION_ROADMAP.md`.
