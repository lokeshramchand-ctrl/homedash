# Progress report

Four workstreams. A box is ticked only when the work is done, verified and pushed.

- [x] **1. Make it trustworthy**
- [ ] **2. User-friendliness**
- [ ] **3. Features**
- [ ] **4. Project support**

---

## 1. Make it trustworthy: done

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
