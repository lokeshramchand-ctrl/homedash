# Testing strategy

## Layers

1. **Pure unit tests** (`server/test/*.test.mjs`, `node:test` against `server/build`): parsers, graph maths, analysers. No network.
2. **Mock-server integration tests**: each monitoring template and provider runs against a local HTTP server that answers in the shape the tool's documentation shows, and the test checks both the request that was sent and what was read. These prove homedash follows the documentation; they do **not** prove the tool behaves as documented.
3. **Server-over-HTTP tests**: the real server is started with a temporary database and users of each role; tests check status codes for each role, including denied ones (`usage`, `registry`, `access` tests).
4. **Browser tests** (`e2e/`, Playwright with Chromium): every page opens without script errors or the error boundary; feature flows (add a service, record a dependency, see the impact; refusal of a forbidden address). Axe accessibility checks in `e2e/a11y.spec.ts`.
5. **Type checks**: `tsc --noEmit` for server, web and mobile.

## Run

```sh
cd server && npm test                       # build + all server tests
npm run build                               # type-check and build the web app (repo root)
E2E_PASS=... bash e2e/start-backend.sh &    # backend with a mock Proxmox on :3911
E2E_PASS=... npx playwright test            # browser tests
cd mobile && npx tsc --noEmit
```

## For every integration, the cases to cover
Successful connection, failed connection, wrong credentials (and the secret absent from the message), missing permission, timeout, application unavailable, partial data, stale data, credential rotation, reconnection. Existing tests cover most for the monitoring engine (`monitoring-engine`, `monitoring-runtime`, `monitoring-templates`); gaps are listed in `PRODUCT_AUDIT.md`.

## What no test here covers
A real Proxmox, Grafana, Loki, OPNsense, CrowdSec, Keycloak or authentik; real push delivery; a mobile device; load; accessibility of the pages added in this pass beyond the smoke run.
