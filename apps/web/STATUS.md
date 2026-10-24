# Web dashboard: gate status

Person 3's checklist from the build brief. `PASS` = verified in this repo; `PENDING (live)` = a live check still needs recorded evidence; backend functions already exist.

> **Backend state (Oct 24):** `packages/backend/convex` ships files, workspaces/invites, context proposals/approvals and `agentConnections`, all with Convex Auth and coded `ConvexError`s. The dashboard's Convex adapter calls every one of them through `TandemApi` (see `CONTRACT_NOTES.md`); mock mode implements the same interface. Rows below marked PASS (mock / unit) were verified against the mock and adapter unit tests; live-deployment checks still need a seeded Convex deployment.

## Gate 1: shell, routing, auth

| Check | Status | Notes |
|---|---|---|
| Dev server runs; `/` redirects signed-in and signed-out (mock) | PASS | `/` → `/sign-in` signed out; → `/w/<id>` signed in |
| Sign-in/out in mock mode | PASS | bad password shows "Email or password is incorrect."; sign-out returns to `/sign-in`; `/w/*` signed out → `/sign-in?next=…` |
| Real-mode providers + proxy compile | PASS (typecheck) | Convex Auth config exists (`convex/auth.ts`, `auth.config.ts`); browser sign-in still needs live evidence |
| Typecheck + lint | PASS | |

## Gate 2: API layer + mock adapter

| Check | Status | Notes |
|---|---|---|
| Tests pass | PASS | `pnpm --filter web test`: errors + mock API suites |
| Function mapping in `CONTRACT_NOTES.md` | PASS | rewritten Oct 24 to match the generated API (issue #12) |
| Convex adapter mapping (fixtures typed from generated API) | PASS | `convexAdapter.test.ts`, `approvalsAndConnections.test.ts` |
| Convex adapter against a live deployment | PENDING (live) | Adapter exists; live verification needs a seeded deployment + `.env.local` |

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
| Against live `agentConnections` + MCP server | PASS (e2e, local deployment) | `tests/e2e` steps 2–10 through the dashboard's data layer; claude.ai itself: test on the Convex dev deployment + Vercel dashboard |

## Gate 6: live Convex integration

Measured 2026-10-24 against `colorful-grouse-361` after the authorized deployment of clean `origin/main` @ `5aafe3b`. The local Next.js dashboard used this cloud backend; the agent used the real Streamable HTTP MCP endpoint with a bearer API key. Local anonymous Convex was also measured. See [D11 report](../../docs/phase-d/30-report.md) for commands, limitations, and screenshots. “Claude” below identifies the MCP connection's client attribution; no native Claude conversation is claimed.

| Check | Status | Notes |
|---|---|---|
| Claude-created file appears in the dashboard without reload | PASS | `colorful-grouse-361` + local, 2026-10-24: MCP create while browser list open; reactive file link appeared. Screenshot `30-cloud-reactive.png`. |
| Human save → v2; Claude rereads v2 | PASS | `colorful-grouse-361` + local, 2026-10-24: browser saved v2; MCP read returned v2 with exact human content. |
| Stale write from a second tab → ConflictPanel; Convex keeps newer | PASS | `colorful-grouse-361` + local, 2026-10-24: first tab saved v3, second tab's stale v2 save showed conflict; MCP confirmed newer v3 content intact. Screenshot `30-cloud-conflict.png`. |
| History attributes agent vs human | PASS | `colorful-grouse-361` + local, 2026-10-24: recaptured open History route with visible v1 AGENT Avery via Claude and v2/v3 HUMAN Blake; both `30-cloud-history.png` and `30-local-history.png` reopened and visually confirmed. P0 step 6 checks identities. |
| Signed-out `/w/*` redirects (real-mode proxy) | PASS | `colorful-grouse-361` + local, 2026-10-24: fresh browser context opening workspace redirected to sign-in and returned after authentication. |
| Outsider gets the FORBIDDEN UI | PASS | `colorful-grouse-361`, 2026-10-24: generated outsider C saw “You don't have access” on A's workspace. Screenshot `30-cloud-forbidden.png`; e2e also verified FORBIDDEN. |
| UNAUTHENTICATED on save stashes and restores the draft | PASS (fault injection) | `colorful-grouse-361` + local, 2026-10-24: injected coded UNAUTHENTICATED save response; real sign-out/sign-in preserved sessionStorage draft and restored exact text. Natural JWT expiry not induced. Screenshot `30-cloud-restored.png`. |
| Agent proposes scope → human approves in dashboard → next sync | PASS | `colorful-grouse-361` + local, 2026-10-24: P0 `7-scope` now asserts real MCP scope proposal → authenticated human dashboard data-layer approval → first MCP sync returns exact scope; local/cloud **17/17 passed**. Correlated workspace/proposal IDs and scope values in D11 report; `30-cloud-approved.png` is earlier separate browser approval evidence. |

### Network/auth failure tests

Measured 2026-10-24 on `colorful-grouse-361` and local anonymous Convex. Browser offline Save reached the 15-second timeout, showed “Can't reach Tandem,” and retained the exact draft; reconnect recovered (`30-cloud-network.png`). A targeted UNAUTHENTICATED response exercised save recovery as described above. Cloud P0 tests also measured HTTP 401 for revoked/malformed MCP credentials and revoked OAuth refresh rejection. No automatic cloud demo reset was run.

`CONVEX_AGENT_MODE=anonymous CONVEX_URL=http://127.0.0.1:3212 pnpm test:e2e`: **17 passed, 6 opt-in demo tests skipped** (2.66s). `CONVEX_URL=https://colorful-grouse-361.convex.cloud pnpm --filter @repo/e2e exec vitest run test/p0-slice.e2e.test.ts`: **17 passed** (37.80s), including new scope-sync test. `pnpm --filter @repo/e2e check-types`: exit 0. Earlier local `pnpm test:demo`: **6 passed**; earlier web unit tests: **226 passed**, web typecheck passed. Initial stale cloud deployment: 4 passed, 12 failed; follow-up made no cloud deployment/env/reset changes. Full evidence and cloud cleanup inventory: [D11 report](../../docs/phase-d/30-report.md).

## Gate 7: deploy artifacts + demo hardening

| Check | Status | Notes |
|---|---|---|
| Production build passes | PASS | `next build` in real mode (placeholder Convex URL) and mock mode; standalone server at `.next/standalone/apps/web/server.js` |
| Docker image builds | SKIPPED | Docker isn't installed on this machine. Optional self-hosted artifact; Vercel is the dashboard host |
| Hosting documentation | DONE (code review) | Vercel for web; Convex Cloud for backend + MCP. `deploy/` contains optional container examples |
| Friendly copy for every error code | PASS | `lib/api/errorCopy.ts` |
| Dev mock controls hidden in production | PASS | the image forces `NEXT_PUBLIC_USE_MOCKS=false`; controls only render when the mock API is mounted |
| Seed-reset instructions link | PASS | `pnpm demo:reset`: [docs/demo-seed.md](../../docs/demo-seed.md). `pnpm test:demo` runs the P0 slice on the seeded workspace (6/6 on a local deployment) |
