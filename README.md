# homedash

A dashboard for a Proxmox homelab or a small team: start and stop guests, watch host and guest metrics, see your services and nginx sites, browse Grafana and track Uptime Kuma, from a browser or a phone. One person or many (roles, teams, single sign-on).

| Part | Path | Stack |
|---|---|---|
| Web UI | `/` | React 18, Vite, TypeScript |
| Backend | `server/` | Fastify 5, embedded SQLite (`node:sqlite`), TypeScript |
| Mobile app | `mobile/` | Expo, React Native, TypeScript |

## Install on Proxmox VE

Run on the Proxmox host. This creates an LXC, installs Node 22, builds homedash and starts it as a systemd service:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/DevScripts/main/ct/homedash.sh)"
```

> Until the script is accepted upstream, run it from this repository instead:
> `bash -c "$(curl -fsSL https://raw.githubusercontent.com/lokeshramchand-ctrl/homedash/main/ct/homedash.sh)"`

Open `http://<container-ip>:3000` and sign in with the admin login printed at the end of the install.

### Create the Proxmox API token

homedash needs an API token. On the Proxmox host:

```bash
bash tools/pve/create-token.sh        # read-only token; add --write-access for power actions
```

It grants `PVEAuditor` (read); `--write-access` also grants `PVEVMUser` (start, stop, reboot, snapshots).

### Customise the install

The standard container options work as usual (`var_cpu`, `var_ram`, `var_disk`, `var_hostname`, ...). App settings can be passed up front as environment variables, or answered when prompted. Anything left blank can be filled in later in `/opt/homedash/server/.env`.

| Variable | Default | Meaning |
|---|---|---|
| `var_homedash_port` | `3000` | web port |
| `var_homedash_admin_user` | `admin` | first user |
| `var_homedash_admin_password` | random | at least 12 characters |
| `var_homedash_pve_url` | prompt | e.g. `https://192.168.1.10:8006` |
| `var_homedash_pve_node` | host's hostname | Proxmox node name |
| `var_homedash_pve_token_id` | prompt | `user@realm!name` |
| `var_homedash_pve_token_secret` | prompt | |
| `var_homedash_grafana_url` / `_token` | empty | embed Grafana in homedash |
| `var_homedash_kuma_url` / `_api_key` | empty | Uptime Kuma monitors |
| `var_homedash_metrics` | `yes` | generate a `METRICS_TOKEN` for Prometheus/Grafana |

Unattended example:

```bash
var_cpu=2 var_ram=1024 \
var_homedash_pve_url=https://192.168.1.10:8006 \
var_homedash_pve_token_id='homedash@pve!ui' var_homedash_pve_token_secret=xxxxxxxx \
var_homedash_grafana_url=http://192.168.1.14:3000 var_homedash_grafana_token=glsa_xxx \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/lokeshramchand-ctrl/homedash/main/ct/homedash.sh)"
```

### Nginx inside the container

The installer puts nginx in the container and sets `NGINX_MANAGE=true`, so the Nginx page manages `/etc/nginx/sites-enabled` there: point DNS (or your router) for a name at the container and add the site in the UI. To manage a different nginx, set `NGINX_MANAGE=false` for a read-only view.

### Everything else in `.env`

Every option is documented in [`server/.env.example`](server/.env.example): protected guests (`PROTECTED_VMIDS`), a featured guest card (`FEATURED_VMID`), device-conflict warnings (`GUEST_CONFLICTS`), ntfy alerts, OIDC sign-in (any provider), an optional AI log helper and more. After editing: `systemctl restart homedash`.

### Update

Run the same command again inside the container, or from the host: `pct enter <ctid>` then `update`. Settings and the database (`/opt/homedash/data`) are kept.

## First steps after installing

Sign in as an administrator and open **Setup** (Settings group). It checks your install live (Proxmox reachable, HTTPS, two-step sign-in, alerts, self-backup, a second administrator) and says how to fix each gap. Below the checklist, every optional integration has the exact YAML to switch it on, with a copy button. The Overview reminds administrators until the checklist is done.

## Configuration

Everything is switched on from one file inside the container, `/etc/homedash/homedash.yaml`. Leave an integration out and it stays off; its page does not appear.

```bash
homedash-config validate          # which features would be on, and what is wrong
homedash-config apply --restart   # render server/.env, nginx vhosts and the add-on files, then restart
homedash-config status            # validate + is the server answering
```

Secrets are written as `${NAME}` in the YAML and kept in `/etc/homedash/secrets.env` (mode 600), so the YAML can be shared. The MFA, Data-manager and `/metrics` keys are generated once and kept in `/etc/homedash/generated.env`, so applying again never rotates them. `.env` is rewritten only between its `managed` markers; lines you added by hand are kept. Every option, commented, is in [`infra/homedash.example.yaml`](infra/homedash.example.yaml), and the raw variables are in [`server/.env.example`](server/.env.example).

| Feature | Switch it on with | Page / effect |
|---|---|---|
| Proxmox guests, node, health, backups | `proxmox:` url, node, token | Guests, Node, Health, Protection, Capacity |
| Grafana, Uptime Kuma | `grafana:`, `kuma:` | Grafana, Uptime |
| Loki logs | `loki.url` | Logs > Analytics and Loki search |
| CrowdSec | `crowdsec.snapshot` + `addons.crowdsec` | CrowdSec, ntfy ban alerts |
| Databases | `data.enabled` or `data.connections` | Data (MongoDB, Redis, PostgreSQL, MySQL, SQL Server, SQLite, Milvus) |
| LLM server and GPU guard | `llama:`, `gpu_watch:` | LLM server, GPU alerts |
| Single sign-on | `auth.oidc:` (Keycloak, Authentik, Authelia, Zitadel, Entra ID, Google, Okta...) | login button, roles from `admin_users` / `default_role` |
| Two-step sign-in | `auth.mfa.enabled` | TOTP with recovery codes |
| Passkeys | `auth.passkeys` (needs HTTPS) | passwordless sign-in that counts as both factors |
| Teams | `access.teams`, `access.group_teams` | people see and act on their own guests only |
| Group sync and SCIM | `access.group_roles`, `scim.token` | roles, teams and deactivation follow your identity provider |
| Four-eyes approvals | `access.approvals.actions` | risky actions need a second administrator |
| API tokens | always on (Access page) | scoped, expiring tokens for scripts and the mobile app |
| Alerts | `ntfy:`, `gotify:`, `discord:`, `slack:`, `telegram:`, `email:`, `apprise:`, `webhook:` (any number) | Notifications: per-channel level filter, test button, delivery history |
| Incidents | `pagerduty:`, `opsgenie:` | an incident opens per problem and closes on recovery; pages on errors by default |
| Ask AI | `ai:` | log helper |
| nginx | `nginx:` incl. `sites_dir`, `conf_dir`, `homedash`, `sites` | Nginx page; vhosts rendered for homedash and your services |

Roles are `viewer` (read), `operator` (power, snapshots, scenes) and `admin` (databases, logs, nginx changes, host power). `npm run create-user -- <name> <role>` sets one; `--reset-2fa` is the lock-out escape.

### Clusters and nodes

homedash works with a single Proxmox node, a cluster, or several of either.

- **A cluster.** Point `proxmox.url` at any member: the API token works cluster-wide and `/cluster/resources` lists every guest with its node. Give several addresses (`url: [a, b, c]`) and if one member is down the next answers; the Cluster page shows which one is in use. Actions, snapshots, backups and tasks always go to the guest's own node.
- **Several clusters or stand-alone nodes** (`proxmox.clusters:`): each has its own token, protected guests and settings, and a switcher in the top bar changes which one you are looking at. Scenes, schedules and the audit log are kept per cluster. Teams can be limited to one cluster (`access.teams.<name>.cluster`) because guest ids repeat across clusters.
- **Node pages.** Node, Health, Capacity and the Overview follow the node picked next to the cluster switcher. Powering a node off asks you to type that node's name.
- **Migration.** Guest > Migrate lists the nodes a guest can move to and why others cannot. A running VM moves live; a running container is restarted on the target; local disks need an extra tick. It can be put behind approvals with `guest.migrate`.
- **Watching.** Every node of every cluster is checked for CPU, memory, disk, failed tasks, SMART and services, plus node-offline and lost-quorum alerts (PagerDuty and Opsgenie incidents close when the node returns). With more than one cluster, `/metrics` gains `cluster` and `node` labels; a single cluster keeps exactly the series it always had.

### Maintenance windows and routing

On the Notifications page: a **maintenance window** (one-off or weekly, optionally limited to some alert kinds or to text such as a service name) holds alerts back while you work. Held-back alerts still appear in the history, and PagerDuty or Opsgenie still close incidents when something recovers. **Routes** (admin) send alerts to chosen channels by kind, severity, text and time of day, for example errors to PagerDuty and warnings to Slack. An alert that matches no route follows the normal channel settings, so a route can never make an alert disappear. The Notifications history has a "Silence for 1 hour" button on each alert.

### Access control

- **Roles** (`viewer`, `operator`, `admin`) apply everywhere. **Teams** narrow that: a person in a team sees only the guests it lists (by id range or Proxmox tag) and gets no host-wide pages (overview, nginx, databases, logs). People without a team are unaffected.
- **Group sync.** With OIDC, `access.group_roles` and `access.group_teams` turn the provider's groups into a role and teams at every sign-in. With **SCIM** (`scim.token`, base URL `/scim/v2`) the provider also creates, updates and deactivates accounts; deactivating ends their sessions and revokes their API tokens at once. A user in no mapped group gets `auth.oidc.default_role`, and `admin_users` always wins. The SCIM `userName` must equal the user's OIDC `preferred_username` (or e-mail) so the first sign-in adopts the provisioned account.
- **API tokens** (Access page): shown once, stored as a hash, never more than their owner's role, scoped like their owner, expire (90 days by default), revoke any time. A token cannot create tokens or change account security.
- **Approvals.** For the actions you list, the first request is refused and queued; a *different* administrator approves it on the Access page; the requester then repeats the identical request (the page has a Run button) and it runs once. Approvals expire and are bound to the requester and the exact request body.
- **Passkeys** need HTTPS and `auth.passkeys.rp_id` / `origin`. A passkey is verified with the device's biometric or PIN, so it replaces both the password and the code.

### Add-ons around homedash

`addons:` in the YAML renders files into `/etc/homedash/rendered/`:

| Add-on | Renders | Where it goes |
|---|---|---|
| `alloy` | Alloy config, guest-journal generator, units, nginx JSON log format | Proxmox host |
| `crowdsec` | snapshot script and timer | Proxmox host |
| `prometheus` | `prometheus.yml` (with the homedash scrape job), node-exporter listen address | Prometheus container / host |
| `loki_server` | `loki-config.yml` (retention) | Loki container |
| `grafana.provision` | datasources, dashboard provider, CrowdSec dashboard | Grafana container |

The host ones are installed by a script that you run yourself on the Proxmox host. It asks before each step (`--yes` to skip the questions, `--dry-run` to see what would happen), backs up every file it replaces to `/var/backups/homedash`, is safe to re-run and logs to `/var/log/homedash-host.log`:

```bash
git clone https://github.com/lokeshramchand-ctrl/homedash && cd homedash
bash tools/pve/host-addons.sh <homedash-ctid>
```

### Safety notes

- The container is unprivileged. Nothing is changed on the Proxmox host unless you run the scripts in `tools/pve/`, and they read before they write: Proxmox VE check, free disk, network, confirmation, backup.
- `tools/pve/create-token.sh` creates a privilege-separated token with `PVEAuditor` only. `--write-access` adds power actions, `--path /pool/lab` limits it to one pool. An existing token is never rotated.
- Read scripts before running them; do not pipe a URL into `bash` on a production host.

## Grafana

homedash works with Grafana in both directions: it embeds your Grafana dashboards, and it exposes `GET /metrics` (Prometheus format, bearer token) with a ready-made dashboard to import. See [`grafana/README.md`](grafana/README.md).

## Features

- **Overview**: host CPU, memory and disk, guest counts, and a "needs attention" list.
- **Health**: one score for the node from nine checks: pending updates, web certificate expiry, SMART, ZFS, core services, memory and swap, failed tasks, backups and storage headroom. A check whose API permission is missing shows as Unknown instead of silently passing.
- **Protection**: which guests have no backup, a stale one, or no backup job at all, and which hold snapshots older than a threshold. One click to snapshot, press-and-hold to drop the oldest.
- **Capacity**: a per-storage forecast ("`local-lvm` is full in about 151 days at +2 GB/day") from the last 30 days of usage, plus a "can I start it?" check of each stopped guest against RAM not yet promised to running ones.
- **Network map**: every guest address (LXC interfaces, QEMU guest agent, or config) in one table; duplicate IP and MAC detection; and every nginx site checked against the guest it proxies to, flagging sites that point at a stopped guest or an address no guest owns.
- **Nginx manager**: create reverse-proxy sites from a form with a live preview of the exact config, edit raw config, restore earlier versions, see certificate expiry. Every change is backed up, tested with `nginx -t` and rolled back if the test fails. Running guests can be published straight from the Network map.
- **Scenes and schedules**: save an ordered set of power steps ("stop media, wait 10 s, start the gaming VM"), run it with one click, or put a scene or a single action on a weekly timer.
- **Guests**: start, shutdown, stop, reboot with live task status, an audit log, and optional device-conflict warnings.
- **Windows VM tab**: read-only diagnostics for QEMU guests (config health, guest agent, resource use, host log).
- **Nginx**: read-only view of sites, matched to Uptime Kuma monitors.
- **Grafana**: dashboard browser with embedded panels and a metrics explorer.
- **Uptime**: monitors, heartbeats and incidents from Kuma `/metrics`.
- Light and dark themes, responsive down to phone width, command palette (`Ctrl/Cmd + K`).

> Host-level pages (GPU and IOMMU, host journal) read the Proxmox host itself, so they only show data when homedash runs on the host, not inside an LXC. The installer sets `JOURNAL_ENABLED=false` for that reason.

## Test the installer

`tools/dev/test-ct.sh` creates a throwaway Debian 13 container on a Proxmox host, runs the real `install/homedash-install.sh` in it (with `tools/dev/shim.sh` standing in for the framework helpers) and removes it afterwards. It refuses to touch an ID that already exists.

```bash
bash tools/dev/test-ct.sh --keep 9999 10.10.10.199/24 10.10.10.1 vnet1
```

Unit tests for the pure logic (forecasting, duplicate detection, scheduling, validation): `cd server && npm test`.

Browser tests (Playwright: every page loads, accessibility with axe in light and dark theme, no sideways scrolling on a phone): see [`e2e/README.md`](e2e/README.md). They run in CI against a mock Proxmox.

## Develop

```sh
npm install
API_TARGET=http://127.0.0.1:3000 npm run dev   # proxies /api to a running backend
```

Backend (Node >= 22.13):

```sh
cd server
npm install && npm run build
cp .env.example .env                 # edit
npm run create-user -- admin
npm start
```

Set `SERVE_DIST=../dist` to let the backend serve the built UI.

## Run with Docker

```sh
cp server/.env.example .env      # fill in Proxmox / Grafana / Kuma values
docker compose up -d --build
docker compose run --rm app node build/create-user.js admin
```

## Mobile app

```sh
cd mobile
npm install
npm start          # scan the QR code with Expo Go
```

Enter your homedash URL on the login screen. See [`mobile/README.md`](mobile/README.md).

## Security

Auth state lives only in the SQLite file (scrypt password hashes, hashed session tokens, rate-limit counters, audit log). The cookie is `httpOnly` and `SameSite=Strict`; all `/api` routes require a session. Run behind an HTTPS reverse proxy for anything beyond a trusted LAN and set `COOKIE_SECURE=true` and `TRUST_PROXY=true`. See [`SECURITY.md`](SECURITY.md).

## License

MIT
