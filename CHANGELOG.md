# Changelog

## Unreleased

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
