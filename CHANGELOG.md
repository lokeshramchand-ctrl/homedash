# Changelog

## Unreleased

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
