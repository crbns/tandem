# Web dashboard: gate status

Person 3's checklist from the build brief. `PASS` = verified in this repo; `PENDING (backend)` = blocked on Person 2's Convex functions.

> **Backend state (Oct 23):** `packages/backend/convex/` contains only an empty `schema.ts`. There are no functions and no `_generated/api`. Per conflict rule 3, the whole dashboard runs in mock mode; Convex wiring is `PENDING (backend)`. See `CONTRACT_NOTES.md`.

## Gate 1: shell, routing, auth

| Check | Status | Notes |
|---|---|---|
| Dev server runs; `/` redirects signed-in and signed-out (mock) | PASS | `/` → `/sign-in` signed out; → `/w/<id>` signed in |
| Sign-in/out in mock mode | PASS | bad password shows "Email or password is incorrect."; sign-out returns to `/sign-in`; `/w/*` signed out → `/sign-in?next=…` |
| Real-mode providers + proxy compile | PASS (typecheck) | Functional check is `PENDING (backend)`: no Convex Auth config yet |
| Typecheck + lint | PASS | |

## Gate 2: API layer + mock adapter

| Check | Status | Notes |
|---|---|---|
| Tests pass | PASS | `pnpm --filter web test`: errors + mock API suites |
| Function mapping and gaps in `CONTRACT_NOTES.md` | PASS | every function is "requested from Person 2" |
| Convex adapter against a live deployment | PENDING (backend) | no functions exist yet |

## Gate 3: file list

| Check | Status | Notes |
|---|---|---|
| Seeded files render with correct versions and actor badges | PASS | proposal.md v1 Agent · Claude; brief.md v2 Human · Alex; notes.txt v1 |
| Create file → v1 → opens detail | PASS | verified end-to-end after Phase 4 added the detail route |
| Refresh button + refetch on window focus | PASS | how MCP-created files appear in P0 (no realtime) |
