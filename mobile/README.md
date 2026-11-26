# Homelab mobile app

Expo / React Native client for the dashboard backend. It talks to the same `/api/*` contract as the web UI (see `../API_NOTES.md`) and signs in with the same cookie session. No backend changes are needed.

## Run

```sh
npm install
npm start          # scan the QR code with Expo Go, or press a / i for an emulator
npm run typecheck
```

On the login screen enter your dashboard address (for example `https://dash.home.lan`), username and password.

## Screens

| Tab | What |
|---|---|
| Overview | health summary, counts, host CPU / memory / disk, recent incidents |
| Guests | search and filter; start, shutdown, force stop, reboot with confirmation, task polling and GPU-conflict warning |
| Uptime | Kuma monitors with heartbeat bars, 24h / 30d uptime, ping |
| Sites | nginx sites matched to monitors; tap to open |
| More | account, sign out, Grafana dashboards (open in browser) |

Pull to refresh on every screen. Data auto-refreshes while the app is in the foreground. Every data panel has loading, error and empty states.

## Notes

- The session cookie is `Secure` by default, so use an `https://` address. Plain `http://` only works if the server runs with `COOKIE_SECURE=false`.
- Protected guests (`PROTECTED_VMIDS`) are shown but cannot be acted on; the server enforces this too.
- `src/types.ts` and `src/format.ts` are copies of the web UI files. Keep them in sync when the contract changes.
- Not yet verified on a device or emulator: only type-checked and bundled with `expo export`.

## Signing in with an API token

If your account uses two-step sign-in or single sign-on, the password form cannot complete the sign-in. Choose **Use an API token instead** on the login screen:

1. In the web UI open **Access > API tokens** and create a token (a viewer token is enough to look around; pick operator to start and stop guests). Copy it, it is shown once.
2. Paste it in the app with your dashboard address. It is kept in the device's secure storage.
3. To sign out everywhere, revoke the token on the Access page. Tokens expire on their own (90 days by default).

A token never carries more access than the account that made it, and it cannot change account security.
