# System architecture

A modular monolith. One Node process serves the API, the built web app and the public status and webhook routes. State is one SQLite file. No message bus, no microservices: the load is one household or one lab, and a second process would add failure modes for no gain.

```
Browser (React)  Mobile (Expo)  Scripts (API token)
        \            |            /
         Fastify: auth, role gate, rate limit, audit hooks
   ┌───────────┬───────────┬────────────┬─────────────┬───────────┐
 Proxmox     Monitoring   Registry    Identity     Data       Native modules
 clusters    engine       (services,  inspector    manager    (Loki, CrowdSec,
 (per        (providers,  deps)       (OIDC)       (7 DBs)     Nginx, GPU)
 cluster)    templates)
        \            |            /
                 SQLite (WAL)  +  files (self-backup, TLS)
                      |
        outbound HTTP/TCP to the tools, each under its own timeout
```

## Rules that hold across modules

- The browser and the phone call the same `/api` and get the same answers; business logic lives on the server. Mobile screens only render.
- Every outbound call has a timeout and a size cap, and an error message that cannot contain a credential.
- A failing integration shows as stale or unreachable and keeps its last known data; it is never turned into "all clear".
- Roles are decided by the route (`roles.ts`). Administration lives under `/api/admin`, `/api/monitoring/sources`, `/api/data`.
- Secrets are sealed with AES-256-GCM using the row id as associated data and a key from the environment (`SECRETS_KEY`).
- Pure logic (parsing, graph maths, analysis) is separated from I/O so it is tested without a network.

## Modules added in this pass

- `server/src/registry.ts`: services and dependencies. Pure functions `dependents`, `dependencies`, `wouldCycle`, `verdictFor`; routes `GET /api/registry`, `GET /api/registry/:id/impact` (any signed-in user), writes under `/api/admin/registry`.
- `server/src/identity.ts`: `analyze` and `compareWithSetup` are pure; `inspect` fetches through the same bounded request helper as the monitoring providers. Routes under `/api/admin/identity`.

## Known limits

Polling only (no push to the browser). Single SQLite writer. No versioned migrations yet. See `PRODUCT_AUDIT.md`.
