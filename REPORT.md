# Progress report

Four workstreams. A box is ticked only when the work is done, verified and pushed.

- [x] **1. Make it trustworthy**
- [x] **2. User-friendliness**
- [ ] **3. Features**
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
