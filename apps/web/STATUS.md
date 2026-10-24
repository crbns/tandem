# Web dashboard: gate status

Person 3's checklist from the build brief. `PASS` = verified in this repo; `PENDING (live)` = blocked on Person 2's Convex functions.

> **Backend state (Oct 24):** `packages/backend/convex` ships files, workspaces/invites, context proposals/approvals and `agentConnections`, all with Convex Auth and coded `ConvexError`s. The dashboard's Convex adapter calls every one of them through `TandemApi` (see `CONTRACT_NOTES.md`); mock mode implements the same interface. Rows below marked PASS (mock / unit) were verified against the mock and adapter unit tests; live-deployment checks still need a seeded Convex deployment.

## Gate 1: shell, routing, auth

| Check | Status | Notes |
|---|---|---|
| Dev server runs; `/` redirects signed-in and signed-out (mock) | PASS | `/` → `/sign-in` signed out; → `/w/<id>` signed in |
| Sign-in/out in mock mode | PASS | bad password shows "Email or password is incorrect."; sign-out returns to `/sign-in`; `/w/*` signed out → `/sign-in?next=…` |
| Real-mode providers + proxy compile | PASS (typecheck) | Functional check is `PENDING (live)`: no Convex Auth config yet |
| Typecheck + lint | PASS | |

## Gate 2: API layer + mock adapter

| Check | Status | Notes |
|---|---|---|
| Tests pass | PASS | `pnpm --filter web test`: errors + mock API suites |
| Function mapping in `CONTRACT_NOTES.md` | PASS | rewritten Oct 24 to match the generated API (issue #12) |
| Convex adapter mapping (fixtures typed from generated API) | PASS | `convexAdapter.test.ts`, `approvalsAndConnections.test.ts` |
| Convex adapter against a live deployment | PENDING (live) | needs a seeded deployment + `.env.local` |

## Gate 3: file list

| Check | Status | Notes |
|---|---|---|
| Seeded files render with correct versions and actor badges | PASS | proposal.md v1 Agent · Claude; brief.md v2 Human · Alex; notes.txt v1 |
| Create file → v1 → opens detail | PASS | verified end-to-end after Phase 4 added the detail route |
| Refresh button + refetch on window focus | PASS | |
| Agent-created/saved files appear without reload | PASS (mock / unit) | `watchWorkspace`: one reactive `getWorkspaceInfo` subscription; refetch when the newest event changes |

## Gate 4: editor, optimistic-lock save, conflict UI

| Check | Status | Notes |
|---|---|---|
| Edit `proposal.md` → Save → version 2, toast | PASS | Ctrl/Cmd+S and button; toast "Saved as version 2" |
| Mock conflict: Simulate agent edit → type → Save → ConflictPanel, draft intact, latest shown | PASS | side-by-side with line highlights; "Version 3 by Agent · Claude" |
| Keep editing on top of latest → next save is an intentional overwrite | PASS | base moves to v3, draft kept, save → v4 |
| Discard mine & load latest (with confirmation) | PASS | |
| Never auto-retries; errors keep the draft | PASS | covered by `saveMachine.test.ts` |
| UNAUTHENTICATED → draft stashed in sessionStorage, restored after sign-in | PASS (code + reducer tests) | not exercisable in mock mode; check in Phase 6 |
| Tests pass | PASS | |

## Gate 5: revision history

| Check | Status | Notes |
|---|---|---|
| `brief.md` history: v1 agent, v2 human, labeled correctly | PASS | agent writes read "AGENT Alex via Claude", human writes "HUMAN Alex"; head marked Current |
| `toActor` uses the actor's `client`/`label`/`userName`, never `agentConnectionId` | PASS | issue #12; `approvalsAndConnections.test.ts` |
| A Phase 4 save appears with the signed-in human as author | PASS | proposal.md v2/v4 "Human · Demo Human" between Claude's v1/v3/v5 |
| View prior version read-only (rendered/raw) + compare with current | PASS | no restore in P0 |

## Gate 5b: approvals and assistant connections (P1)

| Check | Status | Notes |
|---|---|---|
| `/w/<id>/approvals`: pending proposals with what they replace, why, sources | PASS (mock) | headless-Chrome check in mock mode |
| Approve/Reject only for owner/admin; members read-only | PASS (unit + mock) | `canDecideProposals`; backend also enforces |
| Stale approval shows VERSION_CONFLICT clearly, context untouched | PASS (mock / unit) | ochre alert; adapter re-reads stale proposals because the backend returns null |
| Pending approvals listed on workspace home, linked to the screen | PASS (mock) | |
| `/w/<id>/assistants`: create API key, key shown once + copy + Claude Code command | PASS (mock), relabeled 2026-10-24 | server URL now comes from the backend (`getMcpServerUrl`), no `NEXT_PUBLIC_MCP_URL` |
| `/oauth/consent?request=`: sign-in round trip, pick workspace + assistant, Allow/Deny, refuses to render framed | PASS (mock, browser 2026-10-24) | sign-in returned to the page with `?request=` intact; Allow landed on Assistants. Framing refusal not exercised in a browser. Data layer: unit tests and e2e step 10 |
| Connections list "Last MCP action / Last sync", never "online"; revoke with confirmation | PASS (mock) | |
| Against live `agentConnections` + MCP server | PASS (e2e, local deployment) | `tests/e2e` steps 2–10 through the dashboard's data layer; claude.ai itself needs a public deployment |

## Gate 6: live Convex integration

The backend functions exist; these need a seeded deployment (dev `NEXT_PUBLIC_CONVEX_URL` and a test login, in `apps/web/.env.local` only).

| Check | Status | Notes |
|---|---|---|
| Claude-created file appears in the dashboard without reload | PENDING (live) | reactive refresh verified in mock + adapter unit test |
| Human save → v2; Claude rereads v2 | PENDING (live) | needs Person 1's MCP + Person 2's functions |
| Stale write from a second tab → ConflictPanel; Convex keeps newer | PENDING (live) | same flow verified in mock via Simulate agent edit |
| History attributes agent vs human | PENDING (live) | verified in mock |
| Signed-out `/w/*` redirects (real-mode proxy) | PASS | production standalone server: `/w/ws_demo` → 307 `/sign-in?next=%2Fw%2Fws_demo` |
| Outsider gets the FORBIDDEN UI | PENDING (live) | copy + ErrorState exist |
| UNAUTHENTICATED on save stashes and restores the draft | PENDING (live) | |

## Gate 7: deploy artifacts + demo hardening

| Check | Status | Notes |
|---|---|---|
| Production build passes | PASS | `next build` in real mode (placeholder Convex URL) and mock mode; standalone server at `.next/standalone/apps/web/server.js` |
| Docker image builds | SKIPPED | Docker isn't installed on this machine. Run the `docker build` command in `README.md` on a machine that has it |
| Compose + Caddy snippets, README deploy steps | PASS | `deploy/compose.web.yml`, `deploy/Caddyfile.web` (no root compose/Caddyfile exist yet) |
| Friendly copy for every error code | PASS | `lib/api/errorCopy.ts` |
| Dev mock controls hidden in production | PASS | the image forces `NEXT_PUBLIC_USE_MOCKS=false`; controls only render when the mock API is mounted |
| Seed-reset instructions link | PASS | `pnpm demo:reset`: [docs/demo-seed.md](../../docs/demo-seed.md). `pnpm test:demo` runs the P0 slice on the seeded workspace (6/6 on a local deployment) |
