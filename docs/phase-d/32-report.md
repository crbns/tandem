# D13 — docs cleanup and repo leftovers

Verified 2026-10-24 on this worktree. No deployment, cloud mutation, native-client login, or paid eval was run.

## Cleanup plan

Check each claim against source, update the docs and env examples, remove only unreferenced workspaces, then install and validate. Use the existing regression suite to protect behavior. Review the resulting diff separately from the edit pass. Make the requested GitHub changes after verification.

## Issue #32 tasks

| Task | Status | Evidence |
|---|---|---|
| Read #32 and #12 | DONE | `gh issue view 32`, `gh issue view 12 --comments`; included the three unchecked items in #12's follow-up comment |
| README describes deployed MCP | DONE | `convex/mcp.ts`, `http.ts`, `convex.config.ts`, `oauth.ts`, `agentConnections.ts`, `lib/mcpConfig.ts`, backend package pin: component HTTP endpoint at `<CONVEX_SITE_URL>/mcp`, OAuth and API keys. `apps/mcp/src/index.ts` constructs a mock backend |
| Integration status and prerequisite list | DONE | `docs/mvp-integration.md` now lists implemented prerequisites with code paths and remaining search/eval limitations. Reactive refresh verified in `apps/web/lib/api/convex.ts` |
| Non-Gate-6 status and contract notes | DONE | Removed claims that Convex Auth/adapter are missing; documented context revision/base-value checks from `context.ts`. API-key return includes `mcpUrl`. Gate 6 compared byte-for-byte against HEAD and unchanged |
| Hosting docs/config | DONE | README and web README describe Vercel web + Convex Cloud backend/MCP. `CLAUDE.md` imports `AGENTS.md`, so no duplicate hosting section was added. Historical auth-design fallback explicitly labeled. Three comment-only edits outside the main docs targets: `apps/web/next.config.js`, `deploy/Caddyfile.web`, `deploy/compose.web.yml` |
| Audit #12, carry open work, close #12 | DONE | See the per-item matrix and GitHub receipts below |
| Remove unused boilerplate | DONE | Only `apps/docs` imported `@repo/ui`. Manifest, Turbo, TS path, Docker and hosting-config search found no other dependency on either workspace. Removed both with `git rm -r`; `pnpm install` removed only their two lockfile importers (68 lines) |
| Every env example matches reads | PASS | Only `apps/web/.env.example` and `apps/mcp/.env.example` exist. Regex set comparison against web config/proxy and MCP entrypoint/auth passed: web has four public variables; MCP has seven variables including optional `NODE_ENV` and `TANDEM_DEV_ANON_USER`. No backend example existed |

The Turbo-managed AGENTS block was compared byte-for-byte against HEAD and preserved. No dependencies were added. Application behavior was not changed. Historical PASS labels elsewhere in STATUS are inherited evidence, not new browser measurements from this cleanup.

## Every unchecked item in #12

DONE here means implemented or superseded in the current production design, verified by source inspection and the local checks below. It does not certify native-client compatibility.

| #12 item | Status | Evidence / disposition |
|---|---|---|
| Shared context/proposal model | DONE | `lib/mcpContract.ts` maps plural public fields to singular backend fields; proposals carry one value, stable IDs and owner IDs. `lib/ops.ts`, `context.ts` implement lifecycle and approval |
| Presence scope | DONE | Production identity is one workspace-bound `agent_connections` row; `lib/agent.ts`, `mcpTools.ts`. The mock retains its older per-user/client representation |
| Future expected_version | BLOCKED (carried) | Production `checkFileVersion` returns `VERSION_CONFLICT` on any valid integer mismatch; mock `updateDocument` calls `versionAhead`, which returns `INVALID_INPUT`. Align the harness with production |
| MCP auth bridge | DONE | Component-verified credential resolves through `requireAgent`; internal mutations never accept caller-supplied person/actor identity |
| Agent attribution and human-only decisions | DONE | `session.actor` passed to shared operations; public `decideContextProposal` calls `requireHumanSession` before reading a proposal |
| Name/content search | BLOCKED (carried) | Search exists, orders name matches before recency, limit 1–50, snippets. `searchFilesCore` scans only newest 200 plus bounded filename search-index hits; complete historical content substring search remains open |
| Ordered sync and stored cursors | DONE | `lib/auth.ts` assigns event `seq` transactionally; `syncCore` pages by seq; `mcpTools.syncWorkspace` persists per-connection `sync_cursors` |
| publishWork and storage table | DONE | `published_work` in schema; `publishWorkCore` writes record and `work.published` event atomically |
| Connection/presence functions | DONE | `agentConnections.ts`, `requireAgent` and `touchConnection`; `getWorkspaceInfo` reports timestamps |
| Workspace discovery | DONE | `mcpTools.getWorkspaceInfo` returns connection-bound workspace, member count and `isDefault: true`; omitted workspace resolves to that same connection workspace |
| Name uniqueness | DONE | `createDocumentCore` normalizes names, checks workspace/parent/name key and throws `NAME_EXISTS` |
| Optional decision notes | BLOCKED (carried, optional) | `decideContextProposal` accepts only `proposalId`, `decision`; no note storage. No public agent decision tool exists |
| Convex backend adapter in apps/mcp | DONE (superseded) | Production runs inside Convex; no Node adapter needed. `lib/mcpContract.ts` performs camelCase/ISO/code mappings, including source-file and proposal errors |
| get_file_versions mapping | DONE | `mcpTools.getFileVersions` returns metadata, UTF-8 byte sizes and file wrapper; no revision bodies. Web uses separate content-bearing revision query |
| get_approvals all + limit | DONE | `mcp.ts` maps all to omitted status; bounded 1–50 limit passed to `listProposals` |
| Binary read behavior | DONE | `mcpTools.readFile` returns `binary: view or download in the dashboard` for stored binaries |
| Web actor mapping | DONE | `apps/web/lib/api/convex.ts` `toActor` uses client/userName/label, never the connection ID as client |
| Stale CONTRACT_NOTES | DONE | Coded `ConvexError` normalization and revision/base-value approval rules documented and checked |
| Approval API/UI | DONE | `context.ts`; `apps/web/app/w/[workspaceId]/approvals` and adapter support list/approve/reject |
| External/live skill eval mode | BLOCKED (carried) | `run.mjs` usage and startup show only fresh mock process per trial; no external URL/key or live isolated seed mode |
| Committed update/conflict trial | DONE | Inspected committed `2026-10-23-claude-code-conflict-bare.json`: update_document and VERSION_CONFLICT calls present; paired Markdown records six recovery trials. Historical artifact inspection only; no new paid trial run |
| Follow-up: malformed token log | BLOCKED (carried) | Dummy-only `DevTokenResolver("d13-dummy-key:")` prints the entire malformed entry verbatim |
| Follow-up: invisible names | BLOCKED (carried) | `nameKey(storedName("\u00ad")).length` measured as 1; create validation checks nonempty key, so soft-hyphen-only name passes |
| Follow-up: old result rerender | FAIL (carried) | `node skills/tandem/eval/run.mjs --rerender skills/tandem/eval/results/2026-10-23-claude-code.json` exits 1: `Cannot read properties of undefined (reading 'map')`; no tracked artifact changed |

## Validation measured in this session

| Command/check | Status | Key output |
|---|---|---|
| `pnpm install` | PASS | All 7 workspace projects; completed in 2.2s; no packages added. Four existing deprecated subdependency warnings |
| `pnpm check-types` | PASS | 4 successful tasks, 0 cached: backend, MCP, web, e2e |
| `pnpm test` | PASS | 3 successful tasks, 0 cached: web 226 tests / 23 files; backend 68 / 4; MCP 68 / 2; total 362 |
| `NEXT_PUBLIC_CONVEX_URL=https://d13-build-check.convex.cloud NEXT_PUBLIC_USE_MOCKS=false pnpm --filter web build` | PASS | Next production build completed; static/dynamic routes and proxy generated. Placeholder URL used for compile only; no live backend operation |
| `pnpm lint` | PASS | Web ESLint with `--max-warnings 0`; 1 successful task, 0 cached |
| `git diff --check` | PASS | No whitespace errors |
| Repo hosting/stale-claim search | PASS | `rg -n -i 'vultr|railway|supabase|mock.only' --hidden -g '!**/node_modules/**' -g '!.git'`: before report creation, only legitimate `Dev (mock only)` editor control remained |
| Workspace dependency search | PASS | `rg` over manifests, Turbo, tsconfigs, Dockerfiles and hosting configuration: only deleted boilerplate referenced either removed workspace |
| Scope/template assertions | PASS | Python comparison: Gate 6 unchanged; Turbo-managed block unchanged; web and MCP env example variable sets exactly equal source reads |

Full command logs were read from `/tmp/d13-types.log`, `/tmp/d13-tests.log`, `/tmp/d13-build.log`, `/tmp/d13-lint.log` during this session. They are local execution logs, not committed artifacts.

## Remaining steps

No human action is needed to apply this docs cleanup. Open code/eval items listed above are carried to #32 for implementation by their owners; no security-hardening scope was added. Native-client and live Gate 6 checks belong to the other Phase D workers. Optional Docker examples were not built; production hosting was not deployed or inspected.

## GitHub receipts

Recorded below after verification and the requested issue writes.

- Open items carried to #32: https://github.com/crbns/tandem/issues/32#issuecomment-6385422874
- Verification summary on #12: https://github.com/crbns/tandem/issues/12#issuecomment-6385423073
- `gh issue close 12` returned `Closed issue crbns/tandem#12`; subsequent `gh issue view 12 --json state,url` confirmed `CLOSED`.
