# B6 / issue #25 implementation report

Branch: `crbns/b6-context-tiers`.

Implementation: `0fda69c` (`feat(context): record working knowledge without delaying team sync`).
Integrated reviewed changes: `71396f2` from B4 (publication cursor boundary) and `bfb6af4` from B5 (multiline editing). Their original commits are preserved; B5 merge conflict resolution keeps automatic JSX transform and textarea editing.

## Result

- Goal, scope, decision and ownership proposals remain pending until a human owner/admin approves them.
- Constraint/open-question additions apply immediately with actor attribution, a context revision increment and a workspace event. Their operation record has status `applied` and never appears among pending approvals.
- Every newly written list entry has a stable ID. Legacy reads synthesize deterministic IDs until backfill persists those same IDs.
- Open-question resolution retains the original entry and stores resolver/time. Humans can remove working entries; agents can resolve questions but cannot remove entries.
- Decision replacement proposals accept `supersedes`. The prior decision remains active while pending; approval marks it superseded and links to the new decision. Concurrent proposals against an already superseded target become stale.
- Sync exposes active/resolved/superseded entries with stable IDs and labels pending proposals with proposed text, replacement target and pending status.
- Dashboard controls remain compact, hide edits for historical entries, preserve multiline text and expose resolution/removal/replacement actions. Web and MCP mock/adapter tests cover the new shapes.

## Tool-surface decision

Extended existing `propose_context_change`; no MCP tool was added, so AGENTS.md's eleven-tool list is unchanged. New inputs are `operation` (`add` default, `resolve`, `remove`), `entry_id`, `supersedes`, and `expected_version`; resolve/remove require the current context version. Existing field/value/rationale/source inputs remain, with `open_questions` now supported over MCP. The returned proposal explicitly has `applied` or `pending` status. Skill instructions document the tiers and lifecycle operations.

## Migration

Storage entry IDs were widened to optional fields before deployment. Run the internal paginated mutation on the intended deployment:

```sh
pnpm --filter @repo/backend exec convex run contextMigrations:backfillEntryIds '{"paginationOpts":{"cursor":null,"numItems":50}}'
```

Repeat with the returned `continueCursor` until `isDone`. Backfill is idempotent, preserves IDs already exposed by legacy reads, and records a revision/actor/event for each modified context row. IDs intentionally remain optional in the stored validator to accept existing snapshots and older seed data; read outputs and all new list writes provide IDs. Backend tests backfill pre-existing rows and verify a second run makes no change. The local migration invocation passed (`isDone: true`, `migrated: 0` because its current rows already have IDs).

## Validation

| Command | Final result |
| --- | --- |
| `pnpm check-types` | PASS, six workspace tasks |
| `pnpm test` | PASS, 297 tests: backend 32, MCP 76, web 189 |
| `pnpm lint` | PASS |
| `pnpm --filter web build` | PASS |
| `pnpm --filter @repo/backend exec convex dev --once` | PASS, functions/schema pushed to this worktree's local deployment |
| `CONVEX_URL=http://127.0.0.1:3216 pnpm --filter @repo/e2e test:e2e` | PASS, 14 live tests; six opt-in demo tests skipped by the normal suite |
| `pnpm --filter @repo/backend exec convex run contextMigrations:backfillEntryIds ...` | PASS |
| `git diff --check` | PASS |

The e2e run uses this worktree's own local deployment on port 3216 (site port 3217) with locally configured Convex Auth keys. Start persistent `pnpm --filter @repo/backend exec convex dev` before future e2e runs: an anonymous deployment started by `dev --once` stops when that command exits. Initial checks run during active worker edits and before the local service stayed running failed; the integrated final checks above all pass. No push or PR was created.

The six opt-in demo e2e tests were not run; existing backend demo seed/reset tests passed. No browser interaction was performed; component rendering tests and real dashboard API plus MCP live flows passed.

## Files changed (including integrated review fixes)

- `apps/mcp/src/backend/convex.ts`
- `apps/mcp/src/backend/mock.ts`
- `apps/mcp/src/backend/types.ts`
- `apps/mcp/src/tools.ts`
- `apps/mcp/test/convex.test.ts`
- `apps/mcp/test/server.test.ts`
- `apps/web/CONTRACT_NOTES.md`
- `apps/web/app/w/[workspaceId]/approvals/page.tsx`
- `apps/web/app/w/[workspaceId]/context/page.tsx`
- `apps/web/components/approvals/ProposalCard.tsx`
- `apps/web/components/context/ContextFieldPanel.tsx`
- `apps/web/lib/api/convex.ts`
- `apps/web/lib/api/mock.ts`
- `apps/web/lib/api/tandemApi.ts`
- `apps/web/lib/api/types.ts`
- `apps/web/test/approvalsAndConnections.test.ts`
- `apps/web/test/contextFieldPanel.test.ts`
- `apps/web/test/contextLifecycle.test.ts`
- `apps/web/test/convexAdapter.test.ts`
- `apps/web/test/projectContext.test.ts`
- `apps/web/vitest.config.ts`
- `packages/backend/convex/_generated/api.d.ts`
- `packages/backend/convex/agent.test.ts`
- `packages/backend/convex/context.ts`
- `packages/backend/convex/contextMigrations.ts`
- `packages/backend/convex/lib/ops.ts`
- `packages/backend/convex/lib/validators.ts`
- `packages/backend/convex/mcp.ts`
- `packages/backend/convex/schema.ts`
- `packages/backend/convex/workspaces.ts`
- `skills/tandem/SKILL.md`
- `tests/e2e/test/p0-slice.e2e.test.ts`
