# homedash

A single-user dashboard for a Proxmox homelab: start and stop guests, watch host and guest metrics, see your nginx sites, browse Grafana and track Uptime Kuma, from a browser or a phone.

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
bash tools/pve/create-token.sh        # asks for confirmation, then prints the token
```

It grants `PVEAuditor` (read) and `PVEVMUser` (start, stop, reboot). Edit `ROLES` in the script for a read-only dashboard.

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

### Everything else in `.env`

Every option is documented in [`server/.env.example`](server/.env.example): protected guests (`PROTECTED_VMIDS`), a featured guest card (`FEATURED_VMID`), device-conflict warnings (`GUEST_CONFLICTS`), ntfy alerts, Keycloak/OIDC sign-in, an optional AI log helper and more. After editing: `systemctl restart homedash`.

### Update

Run the same command again inside the container, or from the host: `pct enter <ctid>` then `update`. Settings and the database (`/opt/homedash/data`) are kept.

## Grafana

homedash works with Grafana in both directions: it embeds your Grafana dashboards, and it exposes `GET /metrics` (Prometheus format, bearer token) with a ready-made dashboard to import. See [`grafana/README.md`](grafana/README.md).

## Features

- **Overview**: host CPU, memory and disk, guest counts, and a "needs attention" list.
- **Guests**: start, shutdown, stop, reboot with live task status, an audit log, and optional device-conflict warnings.
- **Windows VM tab**: read-only diagnostics for QEMU guests (config health, guest agent, resource use, host log).
- **Nginx**: read-only view of sites, matched to Uptime Kuma monitors.
- **Grafana**: dashboard browser with embedded panels and a metrics explorer.
- **Uptime**: monitors, heartbeats and incidents from Kuma `/metrics`.
- Light and dark themes, responsive down to phone width, command palette (`Ctrl/Cmd + K`).

> Host-level pages (GPU and IOMMU, host journal) read the Proxmox host itself, so they only show data when homedash runs on the host, not inside an LXC. The installer sets `JOURNAL_ENABLED=false` for that reason.

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
