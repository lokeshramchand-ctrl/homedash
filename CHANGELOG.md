# Changelog

## Unreleased

- Service tiles: read-only status cards for Docker, Portainer, Pi-hole (v5 and v6), Nginx Proxy Manager (with certificate expiry), Jellyfin, Home Assistant and any JSON endpoint, declared under `tiles:`. A tile that stays unreachable raises one alert and one recovery.
- Tamper-evident audit trail: every audit row is hash-chained; `GET /api/admin/audit/verify` checks it, `/api/admin/audit/export` downloads it (JSON lines or CEF), and `audit:` pushes each new row to a syslog collector (UDP/TCP, RFC 5424) or an HMAC-signed webhook.
- Config as code: scenes, schedules, alert routes and maintenance windows declared under `policy:` are created, updated and removed to match the file at every start, and are read-only in the UI.
- Clusters: HA state on the Cluster page (master, agents, fencing, services) with alerts for fencing, dead agents, failed services and lost quorum; a migration pre-flight (local disks, passthrough, target RAM) that blocks what would fail and is enforced by the API; kernel-error alerts now cover every node of a cluster, read through the Proxmox API.
- Clusters: guests from every node of a Proxmox cluster, several API addresses per cluster with failover, several clusters or stand-alone nodes with a switcher, a Cluster page (nodes, quorum, load), live/restart migration, node-offline and quorum alerts, and per-node host pages, shutdown and metrics. Single-node installs behave as before.
- Incident tools: PagerDuty (Events API v2) and Opsgenie open an incident per problem and close it when the recovery arrives. Monitors and the Proxmox API now have stable keys so their recoveries close their own incident.
- Maintenance windows (one-off or weekly, per kind or text) and alert routing rules (by kind, severity, text, time of day), with a one-click silence from any alert.
- Access control: teams (per-guest scope by id range or tag), group-to-role/team mapping from OIDC groups and SCIM 2.0 (Users and Groups), live deactivation, personal API tokens, four-eyes approvals for risky actions, passkeys (WebAuthn), and an Access page with people, sessions, tokens and approvals.
- Alert channels: Gotify, Discord, Slack, Telegram, e-mail (SMTP), Apprise and a JSON webhook next to ntfy. Alerts fan out to every channel that is set up; each channel has its own on/off, minimum level and test button on the Notifications page, and every delivery is recorded per channel.
- `homedash.yaml` and `homedash-config` (validate, apply, status): one file switches integrations on and renders `.env`, nginx vhosts and add-on files (Alloy, Loki, Prometheus, CrowdSec snapshot, Grafana provisioning). nginx directories are configurable.
- Sign-in with any OpenID Connect provider (`OIDC_*`; `KEYCLOAK_*` still works), role mapping for SSO users.
- Roles (viewer, operator, admin), TOTP two-step sign-in with recovery codes, request rate limits, idle session timeout, per-account lockout counters.
- New pages: CrowdSec, Data manager (7 database engines), LLM server, Loki log analytics; GPU mining guard and QEMU device APIs.
- Host scripts: `tools/pve/host-addons.sh` (new), `create-token.sh` now creates a privilege-separated, read-only token by default.

## Unreleased

- Initial release as homedash.
- Embedded SQLite, Proxmox helper-script installer, Prometheus `/metrics` and a Grafana dashboard.
- Nginx manager with validated writes and rollback.
- Health score, Protection, Capacity forecast, Network map, Scenes and schedules.
