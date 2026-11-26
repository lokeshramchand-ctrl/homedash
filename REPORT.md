# Progress report

Four workstreams. A box is ticked only when the work is done, verified and pushed.

- [x] **1. Make it trustworthy**
- [x] **2. User-friendliness**
- [x] **3. Features**
- [ ] **4. Project support**

---

## 1. Make it trustworthy: done (CI green on PR #1)

| Task | Result |
|---|---|
| Open the PR so CI runs | PR #1 opened; CI ran for the first time. build, server tests and config validation passed. |
| Fix what CI found | The `scripts` job (shellcheck) failed. Fixed unguarded `cd` calls, missing shell directives and a masked return value; framework-only warnings are silenced in `.shellcheckrc`. |
| Browser pass over every page | Done in real Chrome with Playwright against the built UI and a mock Proxmox. All 22 pages visited. |
| Browser smoke tests | `e2e/` (Playwright): every page loads without script errors, Services is reachable, Add service opens. Runs in CI as the `browser` job. |

### Bugs the browser pass found (all fixed)

1. **CrowdSec page crashed** when CrowdSec was not set up (`Cannot read properties of undefined (reading 'filter')`). It now shows a "not set up" state.
2. **Services was missing from the menu on a fresh install**, so the first service could not be added from the UI. The page is now always available.
3. **Pages could stack on top of each other** when the address pointed at a hidden page. The page shown now always matches the highlighted menu entry.
4. **"Couldn't load this panel / Try again"** was shown for integrations that were simply not switched on. They now say "Not set up yet" and how to enable them; permission errors say "You don't have access".

### Verified
- Server tests: 121 pass. Typecheck clean (root, server).
- Browser tests: 3 pass locally in Chrome.

### Still not verified (needs your hardware)
Installer in a real container, `host-addons.sh`, real Proxmox/PBS/HA, passkeys with a real authenticator, SCIM with a real IdP, real alert channels, drag-and-drop and PWA install by hand.

---

## 2. User-friendliness: done

| Task | Result |
|---|---|
| First-run guidance | New **Setup** page (Settings, administrators only): a live checklist (Proxmox reachable, HTTPS, two-step sign-in, alerts, self-backup, service-password encryption, a second administrator) with what each gap means and how to fix it. The Overview shows a dismissible reminder until it is done. |
| Integrations in one place | The same page lists 11 optional integrations with On/Off and, for the ones that are off, the exact YAML and the secret names to store, with a copy button. A test checks every snippet against the same code the installer runs. |
| Calm empty and error states | An integration that is not switched on now says "Not set up yet" and how to enable it; missing permission says "You don't have access". "Couldn't load this panel / Try again" is kept for real failures only. |
| Read-only badges | Scenes, schedules, alert routes and maintenance windows declared in `homedash.yaml` show an "In config" badge instead of buttons that would fail with an error. The API now reports `managed` (tested). |
| Accessibility | Measured with axe on 10 pages in light and dark theme: no serious or critical findings. Fixed avatar colours and callout links (contrast), added a skip-to-content link (keyboard test). |
| Phone layout | Every page checked at 390 px wide. Protection spilled sideways (stat cards and table rows); fixed, and a test now guards all 19 pages. |
| README | Removed the stale "single-user" claim, added "First steps after installing". |

### Verified
- Server tests: 127 pass (6 new for Setup, 1 extended for managed rows).
- Browser tests: 9 pass in Chrome (page sweep, Services, Setup, reminder, axe light and dark, skip link, phone overflow).

### Deliberately not done in this item
- **Editing `homedash.yaml` from the browser.** The Setup page shows the exact YAML instead. Writing the config from the web UI would let the web app rewrite its own configuration and restart itself; that is a security decision to make on purpose, not as a side effect. Say so if you want it.
- **Translations (i18n).** Every string is English and inline. Doing it properly means extracting about 1,500 strings; it is better done once there is a target language.

---

## 3. Features: done

| Feature | What it does | Verified by |
|---|---|---|
| **Backups and audit page** (Settings, administrators) | Run a backup of homedash's own data from the UI, see the list, restore steps; verify the audit chain in one click; download the trail as JSON lines or CEF (the download now has a proper file name). When backups are off it shows the exact YAML to switch them on. | Browser test: back up, see it listed, verify, download link |
| **Services layout export / import** | Save order, pins, view and colour to a file; load it elsewhere. Imported files are untrusted: only known fields survive, with size and length limits; anything else is refused with a message. | Browser test: export, change, import, refuse a bad file |
| **Mobile app: API-token sign-in** | Accounts with two-step sign-in or single sign-on could not use the app at all (it only had a password form). It now offers "Use an API token instead"; the token is kept in secure storage and sent as a Bearer header; sign-out forgets it. | Mobile typecheck; browser test of the server contract the app relies on (token works with no cookie, logout is refused for tokens) |

Also fixed on the way: error text on an unreachable service card failed colour contrast (found by the accessibility test, which now covers that state on purpose).

### Verified
- Server tests 127 pass, browser tests 12 pass (Chrome), mobile typecheck clean.

### Considered and deliberately not built
| Idea | Why not |
|---|---|
| Built-in ACME (Let's Encrypt) | Needs a real certificate authority and public DNS or an open port 80. I cannot exercise it here, and a certificate client that has never issued a certificate is a liability. Use a reverse proxy with ACME (Caddy, nginx + certbot) and point `server.tls` at the files; homedash already picks up renewals. |
| Web Push | Needs a browser push service and signing keys; cannot be proven without real devices. ntfy, Gotify, Telegram and the other 6 channels already push to phones. |
| Docker image update notices | Needs a real Docker host and registry to test against. |
| Real brand logos | Needs bundling third-party artwork and a licence decision. The monogram logos work and meet contrast. |

---

## 4. Project support: done (pending the first CI run of the Docker job, see below)

| Item | Result |
|---|---|
| **`homedash-config doctor`** | Tries every address and folder in use: Proxmox (with the token, so a refused token is told apart from an unreachable host), Grafana, Prometheus, Kuma, Loki, alert services, LLM and GPU agents, the database and backup folders, the UI files, Node version and the secrets file mode. Each failure is explained in plain words with the fix; a dead cluster member is only a warning while another answers; exit code 1 on failures. Run against the mock Proxmox with a good token, a dead address and an unresolvable name, and unit tested. |
| **API reference** | `GET /api/admin/openapi.json`, generated from the live route table (so it cannot drift): about every route, its path parameters and the lowest role that may call it, from the same rules the server enforces. Lists routes and roles, not request bodies. |
| **Troubleshooting guide and FAQ** | `docs/TROUBLESHOOTING.md`: 17 symptoms mapped to cause and fix, using the real error codes and messages from the code (each checked against the source), plus FAQ. Linked from the README. |
| **Issue and PR templates, Dependabot** | Bug report (asks for the `doctor` output), feature request, PR checklist, weekly or monthly dependency updates for the web app, backend, mobile, Actions and Docker. |
| **Release workflow** | Pushing a `v*` tag runs the checks, creates a GitHub release with generated notes and publishes `ghcr.io/<owner>/homedash` (`1.2.0`, `1.2`, `latest`). Documented in CONTRIBUTING. YAML validated; **not yet exercised** (needs a real tag). |
| **Docker image in CI** | New `docker` job builds the image and runs it with the same non-root, read-only, no-capabilities settings as compose, checks the UI and API answer and that `/api` refuses anonymous requests, and creates a user inside. |
| **Contributing guide fixed** | It named a `master` branch, an `AGENTS.md` and a PR template that did not exist, and a test command that skipped the tests. Rewritten with the real checks, rules and release steps. |
| **Community-scripts readiness** | `docs/SUBMISSION.md`. Finding: new scripts go to the **ProxmoxVED** testing repository first and PRs for new scripts against ProxmoxVE are closed. The README's headline install command pointed at a community-scripts path that does not exist yet (a 404 for a new user); it now points at this repository. Installer metadata no longer says "single-user". |

### Not verified, and why
- **Docker image:** the Docker daemon is not running on this machine and I did not start it. CI builds and runs it; see the PR checks.
- **Release workflow:** only a real tag proves it.
- **Community-scripts:** the installer has still never run in a real container. `tools/dev/test-ct.sh` on your Proxmox host is the next step; `docs/SUBMISSION.md` lists the rest.
