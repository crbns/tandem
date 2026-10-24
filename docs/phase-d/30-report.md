# Issue #30 — D11 live verification

Measured **2026-10-24**, source `origin/main` **5aafe3b**. The dashboard ran locally in real mode against the named backend; the agent used the real `/mcp` endpoint over Streamable HTTP with a bearer API key. No native Claude conversation was used or claimed.

## Results

| Issue task | Result | Evidence |
|---|---|---|
| Agent-created file appears without dashboard reload | PASS | Local anonymous backend and `colorful-grouse-361`: dashboard already open when MCP `create_document` created a unique file; its link appeared without navigation/reload. [Cloud screenshot](screenshots/30-cloud-reactive.png). |
| Human saves v2; agent rereads v2 | PASS | Local and cloud: browser Save produced “Saved as version 2”; MCP `read_file` returned version 2 and the exact human text. Cloud P0 step 4/5 also passed with separate members. |
| Second tab stale write shows ConflictPanel and keeps newer head | PASS | Local and cloud: both tabs started on v2; first saved v3; second submitted its stale draft and displayed “saved version 3 while you were editing.” MCP reread still returned the first tab's v3 text. [Cloud screenshot](screenshots/30-cloud-conflict.png). |
| History attributes agent and human edits | PASS | Local and cloud: recaptured the open `RevisionList` history route after review; v1 AGENT Avery via Claude and v2/v3 HUMAN Blake rows are visible. P0 step 6 checks exact identities. [Cloud history](screenshots/30-cloud-history.png), [local history](screenshots/30-local-history.png); both PNGs reopened and visually confirmed. |
| Outsider sees FORBIDDEN UI | PASS | Cloud: signed in as generated outsider C, opened A's workspace, and saw “You don't have access.” P0 step 8 separately checked coded FORBIDDEN for the outsider session and MCP credential. [Screenshot](screenshots/30-cloud-forbidden.png). |
| UNAUTHENTICATED save stashes/restores draft | PASS (fault injection) | Local and cloud: intercepted only the browser's `files:updateDocument` WebSocket mutation and returned a coded `UNAUTHENTICATED` response without forwarding that mutation. The real app signed out, redirected to sign-in, retained the file/user-specific sessionStorage draft, and restored its exact text after real password sign-in. [Restored draft](screenshots/30-cloud-restored.png). Actual JWT expiry/revocation timing was not induced. |
| Demo step 6: scope proposal → human dashboard approval → sync | PASS | Local and cloud: new P0 `7-scope` test proposes scope through real MCP, approves with the authenticated human dashboard data layer, and asserts the first subsequent MCP sync returns the exact scope. Both runs passed 17/17; correlated values below. [Earlier browser approval](screenshots/30-cloud-approved.png) is a separate fixture, not the asserted sync result. |
| P0 e2e against deployed stack | PASS | `colorful-grouse-361`: follow-up P0 run passed 17/17 with the scope-sync assertion (original run: 16/16 after authorized clean-main deployment), including all 11 tools, real OAuth registration/consent/PKCE, two members, conflicts, context proposals, presence, and malformed/revoked credential rejection. |
| Network and auth failures; update STATUS | PASS | Browser offline save reached the 15-second adapter timeout, displayed “Can't reach Tandem,” and retained the exact draft; reconnect recovered. Auth fault and real MCP 401 coverage described above. [Cloud network failure](screenshots/30-cloud-network.png). Gate 6 and its failure-test notes updated. |
| Fresh local anonymous deployment plus seed/demo run | PASS | Fresh Convex backend at `http://127.0.0.1:3212`, HTTP actions `http://127.0.0.1:3213/mcp`; auth configured locally, `pnpm demo:reset` run there only, P0 16/16 and seeded demo 6/6. |
| Backup screenshots | DONE | Local and cloud reactive list, conflict, history, approval, network failure, and restored draft; cloud outsider screen, under `docs/phase-d/screenshots/30-*.png`. |

## Commands and measured output

```text
CONVEX_AGENT_MODE=anonymous pnpm --filter @repo/backend exec convex dev
  Configured fresh local backend http://127.0.0.1:3212; functions ready.
(cd packages/backend && node scripts/setup-auth-env.mjs)
  Set JWT_PRIVATE_KEY, JWKS, SITE_URL (local only; key values not logged).
pnpm demo:reset
  Reset local Onboarding refresh workspace (credentials omitted).
CONVEX_URL=http://127.0.0.1:3212 pnpm test:e2e
  Test Files  1 passed | 1 skipped (2)
  Tests       16 passed | 6 skipped (22)
  Duration    2.80s
CONVEX_URL=http://127.0.0.1:3212 pnpm test:demo
  Test Files  1 passed (1)
  Tests       6 passed (6)
  Duration    1.74s
CONVEX_URL=https://colorful-grouse-361.convex.cloud \
  pnpm --filter @repo/e2e exec vitest run test/p0-slice.e2e.test.ts
  Test Files  1 passed (1)
  Tests       16 passed (16)
  Duration    35.00s
pnpm --filter @repo/e2e check-types
  tsc --noEmit: exit 0
pnpm --filter web test
  Test Files  23 passed (23)
  Tests       226 passed (226)
  Duration    786ms
pnpm --filter web check-types
  next typegen && tsc --noEmit: exit 0
```

The six skipped tests in `test:e2e` are the deliberately opt-in demo reset suite, subsequently run explicitly on local. **Do not run `test:demo` against shared cloud:** it resets the live demo and rotates its credentials.

Browser verification used temporary Playwright/Chromium tooling installed outside the repo, with no dependency or product-code changes. The initial Orca embedded-browser attempt was abandoned after repeated stale refs/default execution context failures. The Playwright runner signed in through the visible form, used independent browser pages for the conflict, a separate browser context for the outsider, and asserted server results with the MCP SDK. Network failure used `browserContext.setOffline(true)` and waited for the exact error title, not just a loading state. Auth failure injected a Convex protocol `MutationResponse` with `success:false` and `errorData:{code:"UNAUTHENTICATED"}` for the save; the remaining sign-out, form sign-in, navigation, and draft restoration used the real app/backend.

## Review follow-up: fresh history and scope-sync evidence

Measured 2026-10-24 on this branch. Only the isolated P0 suite and browser actions in its unique E2E workspaces touched cloud; no cloud deploy, env change, demo suite, or reset was run.

```text
CONVEX_AGENT_MODE=anonymous CONVEX_URL=http://127.0.0.1:3212 \
  E2E_EVIDENCE=/tmp/d11-fix-local-evidence.json \
  pnpm --filter @repo/e2e exec vitest run test/p0-slice.e2e.test.ts
  Test Files 1 passed; Tests 17 passed; Duration 2.59s
CONVEX_AGENT_MODE=anonymous CONVEX_URL=http://127.0.0.1:3212 pnpm test:e2e
  Test Files 1 passed | 1 skipped; Tests 17 passed | 6 skipped; Duration 2.66s
CONVEX_URL=https://colorful-grouse-361.convex.cloud \
  E2E_EVIDENCE=/tmp/d11-fix-cloud-evidence.json \
  pnpm --filter @repo/e2e exec vitest run test/p0-slice.e2e.test.ts
  Test Files 1 passed; Tests 17 passed; Duration 37.80s
pnpm --filter @repo/e2e check-types
  tsc --noEmit: exit 0
```

`E2E_EVIDENCE` is optional and writes private fixture credentials, so the raw temporary JSON is not committed. The reproducible `7-scope` test retains the goal test and asserts pending scope is unchanged, human approval advances context version by one, the **first** subsequent real MCP `sync_workspace` returns `NEW_SCOPE`, the proposal leaves pending, and its events are agent proposal then human approval. Redacted results from those passing runs:

| Backend / run | Workspace | Scope proposal | Asserted `sync.context.scope` | Context version |
|---|---|---|---|---|
| Local `mvmiauvesdrq` | `ms71yya2pj3c2mzq13ym2jq9x18gxmtg` | `k57321x3bkxb0a9jfgxar9bybn8gxs4s` | `Shared text documents and human-approved context (mvmiauvesdrq)` | 4 |
| Cloud `mvmiaj1qj6s6` | `ms73ecjvvh665gmkm0jyn18bmn8gxpp6` | `k573ypphdxr5393j0p2y3pr9rd8gw26h` | `Shared text documents and human-approved context (mvmiaj1qj6s6)` | 4 |

History recapture used the same runs' `proposal.md`: local file `kd7aevbts87w2n7t1stda2t57n8gx8hj`, cloud file `kd7ca5wcmqr6ge2rt5vqd97bfx8gw2b0`. P0 creates v1 through real MCP with Claude attribution and saves v2 through Blake's dashboard adapter; temporary Playwright signed in as that same Blake and saved v3 through the visible dashboard Save button. It clicked History, **waited for `/history` and the `Versions, newest first` list**, asserted all three revision rows and `via Claude`, and captured the PNGs at their original paths. Both PNGs were then opened in the image viewer and confirmed to show v1 AGENT via Claude and v2/v3 HUMAN; the cloud capture also waited for the revision detail pane to finish loading. The prior approval screenshots remain unchanged because the scope-sync assertion now has its own reproducible test and correlated result above.

These unique E2E fixtures intentionally remain for review, including the cloud outsider workspace created by the suite. The additional local full-suite run also created its usual isolated fixtures. Naturally expired browser auth and native Claude UI compatibility remain unmeasured; the earlier UNAUTHENTICATED browser evidence remains **fault-injected**.

## Cloud discrepancy and authorized recovery

The first cloud run **failed: 4 passed, 12 failed (9.26s)**. `context:proposeContextChange` returned the old response shape; the current adapter passed no `proposalId` to `context:decideContextProposal`, which rejected `{decision:"approved"}` with `ArgumentValidationError: Object is missing the required field proposalId`. Missing approved context then caused dependent scenario failures. This was deployed/source drift, not a source fix.

The coordinator explicitly authorized isolated cloud test mutations, then relayed user approval to deploy clean main. A detached scratch worktree at `/tmp/tandem-d11-cloud-deploy` checked out `origin/main` @ `5aafe3b`, installed the lockfile dependencies, selected `dev:colorful-grouse-361` using the existing local configuration, and ran `pnpm --filter @repo/backend exec convex dev --once`. Existing data passed schema validation and functions were ready in 2.69s. Index changes were accepted; there were no environment changes, data wipes, demo resets, or Vercel/production deploys. The scratch worktree was removed. The rerun passed all 16 cloud tests.

The coordinator separately authorized dashboard/MCP browser writes only within the successful run's unique E2E workspace. The existing cloud **Onboarding refresh** workspace and native connector were not used for these verification mutations.

## Cleanup inventory and limits

Cloud artifacts intentionally remain for review; cleanup is a separate authorized action:

- Initial failed run: generated users `a-`, `b-`, `c-` with suffix `mvmhtp98p7zu@e2e.tandem.test`; workspace **E2E mvmhtp98p7zu** (created before the failure). No outsider workspace was reached.
- Successful cloud run: **E2E mvmhvqtkep8n**, ID `ms7caag1y66e257tpm7xpxrn3h8gxxmp`; **Outsider mvmhvqtkep8n**, ID `ms79jjc9zr90bdpn80aztnt2x58gwck4`. Generated users use suffix `mvmhvqtkep8n@e2e.tandem.test`. Browser files and the D11 scope proposal/connection belong only to this E2E workspace.

No product bug required a code fix. No production deployment or native claude.ai UI compatibility result is claimed. UNAUTHENTICATED save recovery is measured with a targeted server-response fault; naturally expiring a live browser session remains an optional additional rehearsal. Local `.env.local` files, passwords, API keys, private signing keys, and unredacted e2e evidence remain uncommitted.
