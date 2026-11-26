# Troubleshooting and FAQ

Start here: inside the container run

```bash
homedash-config doctor
```

It tries every address and folder your configuration uses and says, in plain words, what is wrong and how to fix it. Then look at the table below. The service log is `journalctl -u homedash -e`.

## What you see, what it means

| You see | Likely cause | Fix |
|---|---|---|
| **"Cannot reach Proxmox"** (`PVE_UNREACHABLE`) | Wrong address, firewall, or the container cannot reach port 8006. | `homedash-config doctor` names the problem (name not found, refused, timed out). Test by hand: `curl -k https://<host>:8006`. |
| **"Proxmox 401"** or **"Proxmox 403"** (`PVE_ERROR`) | Token id or secret is wrong, or the token lacks a permission. | Check `proxmox.token_id` and the secret in `/etc/homedash/secrets.env`. Create a fresh token with `tools/pve/create-token.sh`. Read-only pages need `PVEAuditor`; power actions need `--write-access`. |
| **TLS certificate errors** talking to Proxmox | Proxmox uses its own self-signed certificate. | Set `proxmox.insecure_tls: true`, or give the container a certificate it trusts. |
| A page says **"Not set up yet"** | That integration is off. | Open **Setup** (Settings): it shows the exact YAML to add. Then `homedash-config apply --restart`. |
| A page is **missing from the menu** | Its integration is off, or your role does not include it. | Setup page for the first; ask an administrator for the second (Setup, Backups and Access are administrator pages). |
| **"Cross-site request refused"** or **"Missing origin information"** (`BAD_ORIGIN`) | You reach homedash through a reverse proxy that does not pass the original host. | In nginx: `proxy_set_header Host $host;` and `X-Forwarded-Host $host;`. Set `server.https: true` behind an HTTPS proxy. |
| **Signed out all the time**, or sign-in works but the next page asks again | Secure cookies over plain HTTP. | Over HTTP set `server.secure_cookies: false`; better, use HTTPS. |
| **"Too many failed attempts"** (`RATE_LIMITED`) | Several wrong passwords or codes. | Wait a few minutes. Locked out of two-step? On the console: `npm run create-user -- <name> --reset-2fa`. |
| **"That code is not correct"** (`BAD_CODE`) | The phone's clock is off. | Turn on automatic time on the phone; codes are time based. |
| **"Set SECRETS_KEY ..."** (`NO_SECRET_KEY`) when adding a service | No encryption key for stored service passwords. | Run `homedash-config apply` once: it generates the key. |
| **"This item is declared in homedash.yaml"** (`MANAGED`) | The item comes from `policy:` in the YAML. | Change it in the file and run `homedash-config apply`. These show an "In config" badge. |
| **"Guest ... is protected"** (`PROTECTED`) | The guest is in `protected_vmids`. | Remove it from the list if it should be controllable. The dashboard's own container should stay protected. |
| **Migration blocked** (`PREFLIGHT`) | Local disks, passthrough devices or too little RAM on the target. | The message lists every reason; fix them or choose another node. |
| **Waiting for approval** | The action is on the four-eyes list. | A different administrator approves it under Access > Approvals; then press Run. |
| **GPU / IOMMU / host journal pages are empty** | homedash runs in a container, not on the Proxmox host. | Expected. Those pages read the host itself. |
| **Services tile "unreachable"** | Wrong address from the container's point of view, or the service wants a key. | Edit the service and press Test; the message says which. `localhost` means the container itself. |
| **No alerts arrive** | No channel set up, a maintenance window is active, or a route sends it elsewhere. | Notifications: press Test on the channel, check Maintenance windows and Routing. History shows every delivery. |

## FAQ

**Can more than one person use it?** Yes. Roles (viewer, operator, admin), teams that limit people to their own guests, single sign-on, SCIM and personal API tokens are built in.

**Where is my data?** One SQLite file (`DB_PATH`, `/opt/homedash/data/homedash.db` in the container). Turn on `server.backup_dir` for scheduled copies; restore steps are on the **Backups and audit** page.

**Does it change anything on my Proxmox host?** Only what you press: power actions, snapshots, backups, migration, all with the token's permissions. The host scripts in `tools/pve/` ask before every step and keep backups of files they replace.

**How do I update?** Inside the container run `update`. Settings and the database are kept.

**How do I reset the admin password?** In the container: `cd /opt/homedash/server && npm run create-user -- admin admin`.

**Can I script against it?** Yes: create an API token (Access) and send `Authorization: Bearer hd_...`. The full list of routes, with the role each needs, is generated from the running server at `GET /api/admin/openapi.json` (administrators; any OpenAPI viewer opens it).

**Can the phone app use my two-step or SSO account?** Yes, with an API token: choose "Use an API token instead" on its login screen.

**It does not start.** `journalctl -u homedash -e`, then `homedash-config doctor`. The usual causes are a port already in use, a data folder the service user cannot write, or Node older than 22.13.

## Still stuck

Open an issue with the output of `homedash-config doctor` and `homedash-config status` (secrets are never printed), the version (`GET /api/version`) and what you expected. Security problems: see [SECURITY.md](../SECURITY.md), not a public issue.
