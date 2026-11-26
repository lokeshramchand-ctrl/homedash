# DRAFT for owner review: licence, data use and token permissions

Status: draft, not wired into the UI. Closes audit findings FUA-004 (no licence/data-use statement) and FUA-005 (token permissions only explained for Grafana). Every statement below is taken from the repo; anything not verified is marked **[CHECK]** and should be confirmed or removed before it is shown to users.

## 1. What to show users (proposed "About" panel text)

**Licence.** homedash is open-source software under the MIT licence (`LICENSE`). Security reports go to the contact in `SECURITY.md`.

**Where your data lives.** Everything homedash stores is in one SQLite file on the machine it runs on (`DB_PATH`, default `./data/homedash.db`): users, sessions, the audit log, settings and uptime history. Optional self-backups go to `BACKUP_DIR` on the same machine. [source: server/.env.example, server/src/db.ts]

**What leaves your network.** homedash only talks to the services you configure (Proxmox, Grafana, Loki, Uptime Kuma, ntfy and the other alert channels you switch on). It has no analytics or telemetry (no such code found in `server/src`). One optional exception: if `UPDATE_CHECK` is set, it asks `api.github.com` for the latest release number. It is off by default. [source: server/src/updates.ts lines 1-2 and 8]

**How secrets are kept.**
- Integration secrets are written as `${NAME}` in `homedash.yaml` and stored in `/etc/homedash/secrets.env`, mode 600. [source: README.md "Configuration"]
- Service-tile tokens and passwords saved in the database are sealed with AES-256-GCM, with a key derived by scrypt from `SECRETS_KEY`, bound to the record they belong to. [source: server/src/seal.ts]
- Passwords are hashed, not stored. [CHECK: confirm algorithm in server/src/auth.ts before stating it]

**Network note.** Over plain `http://` the login travels unencrypted. homedash now says so on the sign-in page (audit fix FUA-001); put it behind HTTPS (nginx is built in) for anything beyond a first look.

## 2. Token permissions (proposed text for each Setup row)

| Integration | What to create | Minimum permission | Source |
|---|---|---|---|
| Proxmox | API token (`tools/pve/create-token.sh`) | `PVEAuditor` for read-only. Add `PVEVMUser` only with `--write-access`, to allow start, stop, reboot and snapshots | tools/pve/create-token.sh lines 8-9 |
| Grafana | Service account token | Read-only service account (already stated in Setup) | server/src/setup-catalog.ts |
| Uptime Kuma | API key | homedash only reads monitor status. **[CHECK]** whether Kuma API keys can be scoped; if not, say "the key grants whatever your Kuma account can do, so keep it private" | needs verification against Kuma docs |
| ntfy | Access token for the alert topic | **[CHECK]** the least-privilege setup is a token with write-only access to one topic (an ntfy ACL); confirm against ntfy's access-control docs before publishing this | needs verification |
| Loki | none required by homedash | read-only queries; no token field in the catalog | server/src/setup-catalog.ts |

## 3. Owner decisions

1. Approve or edit the About text, then I wire it into a small "About" section on the Setup page and the login footer (a link to `LICENSE`).
2. Confirm the **[CHECK]** items, or tell me to drop those rows.
3. Decide whether `UPDATE_CHECK` should stay off by default.
