# Contributing

## Workflow

1. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.
2. Keep commits small and use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`, `build:`).
3. Make sure the checks below pass, then open a pull request using the template.

## Checks

```sh
npm ci && npx tsc --noEmit && npm run build        # web
cd server && npm ci && npm test                      # backend: compiles, then runs the unit and integration tests
cd mobile && npm ci && npm run typecheck             # mobile
```

Browser tests (every page loads, accessibility with axe in light and dark theme, nothing spills sideways on a phone, the main flows) need a running backend; see [`e2e/README.md`](e2e/README.md). The quickest way:

```sh
npm run build && (cd server && npm run build)
E2E_PASS=choose-a-long-password bash e2e/start-backend.sh &     # backend with a mock Proxmox on :3911
E2E_PASS=choose-a-long-password npm run e2e
```

CI runs all of it (`.github/workflows/ci.yml`), plus shellcheck on the install scripts and a build of the Docker image.

## Rules

- **Auth and audit.** Every route under `/api` needs a session or a token; the role it needs comes from `server/src/roles.ts` (anything under `/api/admin` is administrator-only). Anything that changes state is written to the audit log.
- **One source of truth for settings.** A new setting goes in `server/src/cli-schema.ts` (YAML to environment), `infra/homedash.example.yaml` (documented) and `server/.env.example`. `homedash-config validate` and the server share that code, so a test can check both.
- **Changing an API field** means updating `src/types.ts` and `mobile/src/types.ts` in the same PR, and `API_NOTES.md` when the contract changes. `GET /api/admin/openapi.json` lists the routes from the live server.
- **Every data view needs loading, error and empty states.** An integration that is switched off is "Not set up yet", not an error. Use `Async` and `EmptyState` from `src/components/ui.tsx`.
- **Accessibility.** Keep text above 4.5:1 contrast in both themes (use the `-t` colour variants for text), label icon buttons, and keep the layout inside 390 px. The browser tests fail on regressions.
- **Nothing personal in the repo:** no hostnames, addresses, domains, tokens or certificates. Secrets are `${NAME}` references into `secrets.env`.
- Never commit `.env` files or secrets.

## Releasing

1. Move the "Unreleased" notes in `CHANGELOG.md` under a version heading and bump `version` in the root and `server/` `package.json`.
2. Merge to `main`, then tag: `git tag v1.2.0 && git push origin v1.2.0`.
3. The Release workflow runs the checks, creates the GitHub release with generated notes, and publishes `ghcr.io/<owner>/homedash:1.2.0`, `:1.2` and `:latest`.
