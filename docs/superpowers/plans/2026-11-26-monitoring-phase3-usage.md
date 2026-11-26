# Phase 3: per-user popularity ("Your most used")

Spec: `docs/superpowers/specs/2026-11-26-monitoring-module-design.md` section 10. Phases 1 and 2 are done.

Goal: homedash learns, per person, which pages and services they open most, and puts those first: a **Your most used** row on Overview, and the connect-a-source gallery ordered by what that person has connected before. The data stays on the server, belongs to one person, can be cleared by them, and cannot be read by anyone else, administrators included.

## Decisions

1. **What is counted:** opening a page (after the person has stayed on it for 3 seconds, so flicking through the menu does not count), opening a service tile's link, and connecting a source of a kind. Overview itself is never counted (it would always win). Items are `page:<id>`, `tile:<id>`, `kind:<kind>`; nothing else is accepted, and nothing about content, URLs or names is stored.
2. **Score:** `score = score * 0.5^(days since last / 30) + 1` on each count, with the same decay applied when reading. A single visit fades out after about seven weeks; regular use stays on top. No background job.
3. **Anti-inflation:** the same item counts at most once per 30 seconds, so reloading or bouncing between tabs cannot pump a page.
4. **Bounds:** at most 200 items per person (the lowest decayed score is dropped), item ids at most 64 characters.
5. **Privacy:** every route works on the signed-in user only. There is no route that reads another person's usage. `DELETE /api/usage` clears the caller's own data. Rows of deleted users are purged by the existing hourly job.
6. **Roles:** viewer for all three routes, like `/api/prefs/` (own data only).
7. **Web only.** The mobile app keeps its fixed order; a most-used row there is a later, separate change.

## Tasks

1. **Server (tests first):** `user_usage` table in `db.ts` SCHEMA plus orphan purge; `server/src/usage.ts` with pure `decay`, `bump`, `top`, `reset`; routes `POST /api/usage`, `GET /api/usage/top`, `DELETE /api/usage`; `roles.ts` rule. Tests: decay maths, 30 s gap, score accumulation, eviction at 200, invalid item rejected, per-user isolation, reset only touches the caller, viewer allowed, no cross-user read through any route, API reference lists the routes.
2. **Web:** `api` methods; a `useUsage` hook in `App.tsx` that sends `page:<id>` after 3 s on a page (not Overview); `tile:<id>` on a tile link click; Overview "Your most used" card (up to 6 items with the page's menu name or the tile's name, link, and "Clear my history"); connect gallery ordered by `kind:` score, and `kind:` counted when a source is saved.
3. **Verify:** full suite three times, build, browser check (visit pages, reload, see the row, ordering follows use, a second user does not see it, clearing works), changelog and a short note in `docs/MONITORING.md`.
