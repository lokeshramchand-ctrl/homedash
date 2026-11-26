# Implementation roadmap

Status key: **done** (built and tested), **partial**, **not started**. "Tested" means automated tests or a browser run in this repository, not a live installation of the external tool.

## Phase 0: audit: done
`docs/PRODUCT_AUDIT.md`.

## Phase 1: core foundation
| Item | Status |
|---|---|
| Authentication, OIDC login, PKCE, ID-token signature check, SCIM, MFA, passkeys | done (earlier work; real identity providers not verified) |
| RBAC | partial: three roles plus teams; no per-integration or per-resource permission |
| Audit log | done (hash chain, export) |
| Service registry with dependencies | **done in this pass** (web, API, mobile read-only) |
| OIDC configuration inspector | **done in this pass** |
| Integration capability declaration | not started (design in `INTEGRATION_ARCHITECTURE.md`) |
| Versioned migrations | not started |

## Phase 2: infrastructure: largely done earlier
Proxmox clusters, nodes, guests, snapshots, tasks, HA, storage, backups view. Missing: backup jobs and their last result (`/cluster/backup`), PBS beyond the tile.

## Phase 3: observability
Prometheus, Grafana alerts, Alertmanager, Kuma, Loki: done as read paths. Loki ruler alerts and readiness: **done in this pass** as templates. Missing: Loki live tail, jumping from an incident to logs at that time.

## Phase 4: security and networking
CrowdSec page: done (needs the host snapshot). OPNsense: gateway health template **done in this pass**; interfaces, DHCP, VPN, firewall metadata and topology are **not started** and need an OPNsense install to check field names against. Authentication events: login history exists, no unified security event model.

## Phase 5: applications and databases
PostgreSQL, MySQL/MariaDB, MongoDB, Redis: done. InfluxDB, TrueNAS, Synology: not started. Docker and Portainer: tiles only.

## Phase 6: advanced
| Item | Status |
|---|---|
| Dependency graph and impact | **partial**: recorded dependencies, impact list, "affected by" on each service. No automatic discovery, no drawn graph |
| Incident correlation | not started |
| Configuration drift | not started |
| Operations assistant | partial: an AI chat exists (`ai.ts`) that is told to use only evidence provided; no registry or incident context yet |

## Phase 7: refinement
Mobile: read-only Services screen added; still no push receiver. Accessibility: axe checks run in CI for earlier pages; not rerun for the new pages in this pass.

## Next, in order
1. Integration capability declaration, read by the catalogue and the role check.
2. Incident entity built from the event timeline and monitoring alerts, with explainable grouping (same service or same dependency, within a window).
3. OPNsense native read module, written against a real install.
4. Configuration snapshots for OIDC settings and registry entries, with before and after diffs.
5. Versioned migrations before any schema change that is not additive.

## Test results for this pass
- Server: 290 tests, 290 pass, 0 fail (`cd server && npm test`).
- Type checks clean: server, web, mobile. Web build succeeds.
- Browser (Playwright, Chromium, mock Proxmox): 15 of 15 pass, including the axe accessibility checks in both themes. The Overview health-ring contrast finding (axe measured the text against the ring's arc) was fixed by giving the score and caption an explicit background. The new pages are not in the axe page list yet.
