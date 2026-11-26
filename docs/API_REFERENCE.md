# API reference

The complete, current list of routes with the lowest role each needs is generated from the running server: `GET /api/admin/openapi.json` (administrators). This file covers only what was added in this pass.

All routes need a signed-in session or an API token, and mutating calls need the header `X-Requested-With: homedash`.

| Method and path | Role | Purpose |
|---|---|---|
| `GET /api/registry` | viewer | Services with health, dependencies, dependents count and "affected by" |
| `GET /api/registry/:id/impact` | viewer | What would be affected if this service failed, and what it needs |
| `GET /api/admin/registry/monitors` | admin | Checks a service can be linked to |
| `POST /api/admin/registry` | admin | Add a service (`name` required; 409 on a duplicate name) |
| `PUT /api/admin/registry/:id` | admin | Change a service; fields left out are kept |
| `DELETE /api/admin/registry/:id` | admin | Remove; answers how many services depended on it |
| `POST /api/admin/registry/:id/deps` | admin | `{dependsOn, note?}`; 400 for a loop, 409 for a duplicate |
| `DELETE /api/admin/registry/:id/deps/:dep` | admin | Remove a dependency |
| `GET /api/admin/identity` | admin | homedash's own OIDC settings (no secret) plus a live reading of the configured provider |
| `POST /api/admin/identity/inspect` | admin | `{issuer, insecure_tls?}`: read any provider; 403 `DESTINATION_NOT_ALLOWED` for link-local addresses |

Errors use `{ code, message }` with the HTTP status.
