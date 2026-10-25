# Context intelligence: autonomous, event-driven workspace context

Assistants do their work; Tandem watches what it is authorized to see, and a
Haiku-powered context manager keeps a structured, evidence-backed picture of
the workspace that every assistant receives through the existing
`sync_workspace` loop.

```
Connected assistants ──► ingestion ──► activity_events (raw, redacted, append-only)
  MCP tool calls (mcp.ts run())                 │  significant event
  Claude Code hooks (POST /activity/claude-code)│  requestIntelRun (debounced)
  Workspace file changes (recordWorkspaceEvent) ▼
                                   intel.processWorkspace (Convex action)
                                    bounded batch + relevant entries
                                    ──► Haiku (CONTEXT_MODEL) structured JSON
                                    ──► schema validation + evidence rules
                                    ──► one transactional apply mutation
                                           │
              ┌────────────────────────────┼─────────────────────────────┐
              ▼                            ▼                             ▼
   context_entries (+ revisions)   context_proposals (goal/decision   workspace_events
   observed tasks, progress,       findings, via proposeContext-      "context.observed"
   blockers, knowledge, agent      ChangeCore ⇒ existing conflict     (sync feed, Live)
   summaries, coordination         detection + human approval)
              │
              ▼
   sync_workspace `observed` section (brief + full) ──► every assistant
   Dashboard: Live activity feed, observed state, change history, evidence
```

## Audit of what existed (2026-10-24)

| Area | State before this work |
| --- | --- |
| MCP | `@convex-dev/mcp` in Convex HTTP actions (`mcp.ts`). Every tool goes through `run()`; each tool's internal mutation in `mcpTools.ts` calls `recordActivity` (`lib/agent.ts`), and failures are recorded by `run()` via `mcpTools.touchConnection`. Rows: `agent_activity` (summary only, no arguments; reads deduped; 14-day retention). |
| Workspace events | `workspace_events` with a gapless per-workspace `seq` (sync cursor). `recordWorkspaceEvent` also inserts `outbox_events`, which nothing consumes. |
| Context | `structured_context`: goal, scope, constraints, decisions, ownership, open questions — human-approved only, via `context_proposals`. No derived/observed state. Context updates only happened when an assistant called `propose_context_change` or `publish_work`. |
| Consumption (preserved) | `sync_workspace` (brief/full, cursor) + skill loop (`skills/tandem/SKILL.md`, `lib/mcpLoop.ts`); `agent_connections.syncedContextRevision` drives the Live page's "versions behind". |
| Conflict detection (preserved) | `lib/conflicts.ts` (structural: replaces/competing, dedupe, ALREADY_IN_CONTEXT) + `conflicts.ts` (semantic check with Haiku, `CONFLICT_MODEL`, heuristic fallback without a key). Triggered automatically inside `proposeContextChangeCore`. Surfaced on the Approvals page and in sync `blockers.conflicts` / `resolved_conflicts`. |
| Anthropic | Only the conflict check (`fetch` to the Messages API, `ANTHROPIC_API_KEY`). |
| Claude Code | MCP API-key connections (`mcp_sk_…`); no hooks. |
| Dashboard | Next.js; Live page (`components/live`: AgentNetwork, ActivityTimeline) on Convex reactive queries (`activity.ts`), plus a mock data layer (`apps/web/lib/api`). |

Gaps: no raw activity log with arguments, no hook ingestion, nothing that
interprets activity, no derived context, no evidence/provenance, and context
quality depended entirely on assistants remembering to write it.

## Data model (schema.ts)

- **`activity_events`** — unified raw log. `source`: `mcp` | `claude_code` |
  `workspace` | `simulator`. `type` is namespaced (`mcp.tool_call`,
  `claude_code.session_start|prompt|tool_use|tool_failure|stop`,
  `file.created|file.updated|file.moved|file.renamed|file.deleted|file.restored`,
  `context.approved|context.rejected`). `payload` is redacted JSON capped at
  4 KB (`lib/redact.ts`). `dedupeKey` is unique per workspace (idempotent
  ingestion; duplicates return the existing row). `significant` decides
  whether the context manager looks at it; insignificant events (repeated
  reads, syncs, list calls) are stored `intelStatus: "skipped"` and never
  trigger a model call. Significant ones are `pending` until a run marks them
  `processed` with `intelRunId`.
- **`context_entries`** — derived state. `key` is stable per workspace;
  `category` ∈ goal, objective, decision, task, progress, blocker, knowledge,
  agent_summary, coordination; `status` ∈ active, completed, resolved,
  superseded, retracted; `evidence` ∈ requested < claimed < observed <
  verified < human_confirmed; `confidence` 0..1; `evidenceEventIds`;
  `agentConnectionIds`; `fileIds`; `revision`.
- **`context_entry_revisions`** — append-only history; one row per change with
  the snapshot, `reason`, evidence and run.
- **`context_intel_runs`** — one row per batch: status, method (`llm` or
  `heuristic`), model, event ids, counts, short error, tokens.
- **`context_intel_state`** — per-workspace scheduler row: `idle` |
  `scheduled` | `running` with a lease, failure backoff, and
  `entriesRevision` (the derived-context version, bumped on every applied
  change).

## Contracts between modules

| Module | Owns | Exposes |
| --- | --- | --- |
| `lib/intelQueue.ts` (foundation) | `INTEL_ACTOR`, `contextModel()`, `batchWindowMs()`, `intelDisabled()`, `requestIntelRun(ctx, workspaceId)` | used by ingestion and intel |
| `lib/redact.ts`, `lib/activityLog.ts`, `activityLog.ts` | ingestion | `recordActivityEvent(ctx, input) → { id, duplicate }` (calls `requestIntelRun` when significant and new); `internal.activityLog.ingestMcpCall`; `internal.activityLog.ingestHookEvent`; HTTP `POST /activity/claude-code` |
| `intel.ts`, `lib/intel.ts` | processing | `internal.intel.processWorkspace({ workspaceId })`, `parseIntelResponse`, `applyIntelResult` |
| `lib/observed.ts` | reading derived context for sync | `loadObservedContext(ctx, workspaceId, { brief })` |
| `intelligence.ts` | dashboard reads + human correction | public queries/mutations, all `requireMembership` |

### Ingestion rules

- **MCP:** centralized in `mcp.ts` `run()`: after every call (success or
  failure, including the handler's own argument errors; calls the MCP
  component rejects in schema validation never reach `run()`) it calls
  `internal.activityLog.ingestMcpCall` with the tool name, redacted args, a
  result digest (ids, versions, counts — never document bodies), outcome,
  error code, duration and a fresh `correlationId`. Wrapped in `try/catch`:
  telemetry can never change a tool result. Identity comes from the verified
  principal only; the workspace is the connection's.
- **Claude Code hooks:** `POST <CONVEX_SITE_URL>/activity/claude-code`,
  `Authorization: Bearer mcp_sk_…` (the same key the Claude Code MCP
  connection uses, verified with `components.mcp.tokens.verify`). The body
  never chooses the workspace. Prompts are only accepted when the hook
  script was configured with `TANDEM_CAPTURE_PROMPTS=1` (explicit opt-in on
  the user's machine). Tool calls to Tandem's own MCP tools are skipped by the
  hook (already logged server-side), so there is no reporting loop.
- **Workspace changes:** `recordWorkspaceEvent` mirrors `file.*` events and
  human context decisions into `activity_events` with the file id and
  version. Events by `INTEL_ACTOR` or the conflict check are never mirrored
  (no feedback loop). The context manager computes bounded line diffs between
  versions (`lib/diff.ts`) instead of re-reading whole documents.

### Processing rules

1. `requestIntelRun` schedules `processWorkspace` after
   `INTEL_BATCH_WINDOW_MS` (default 5 s) unless already scheduled/running.
2. The action claims the workspace (lease), loads ≤ 40 pending events
   (oldest first), the active entries (≤ 60, newest first), approved
   goal/decisions and pending proposals, and bounded diffs for changed files.
3. Haiku is called with untrusted data inside `<data>` and must return JSON:
   `{ summary, entries: [{ op: "upsert"|"supersede"|"complete"|"reopen"|"resolve"|"retract", key, category, title, content, status, evidence, confidence, evidence_event_ids, agent_connection_ids, file_ids, superseded_by?, severity? }], proposals: [{ field: "goal"|"decision", text, rationale, evidence_event_ids, supersedes? }] }`.
4. Validation is deterministic: unknown ops/categories dropped, ids must be
   from the batch / workspace, text clamped, confidence clamped, `completed`
   downgraded to `active` + `claimed` unless the evidence includes a verified
   signal (successful test/build/deploy tool result, or a human), entries
   below 0.35 confidence dropped, proposals below 0.5 dropped. Which events
   count as verified is computed deterministically and handed to the model
   as `evidence_signal`, so it never has to guess.
5. One mutation applies everything, guarded by `entriesRevision` read at load
   (stale ⇒ retry the batch once against fresh state), writes revisions,
   marks the batch processed, bumps `entriesRevision`, records a
   `context.observed` workspace event, and raises goal/decision findings via
   `proposeContextChangeCore` with `INTEL_ACTOR` (≤ 2 per run, each tracked
   by a companion `goal:`/`decision:` entry carrying `proposalId`; dedupe and
   `ALREADY_IN_CONTEXT` are swallowed). Those proposals go through the
   existing structural + semantic conflict detection and stay pending for a
   person (or apply at once in automatic workspaces, exactly like an
   assistant's proposal).
6. Failures: provider errors/timeouts/unparseable output mark the run failed,
   leave events pending, and back off (`30s × 2^n`, max 10 min). After 5
   consecutive failures automatic retries stop; the next significant event
   or the dashboard's Run now starts a fresh attempt. A reply cut off at
   `max_tokens` is retried with half the events. A run that was scheduled
   but never claimed (disabled at fire time, or crashed first) doesn't hold
   the workspace: the next event reschedules after a 60 s grace. Without
   `ANTHROPIC_API_KEY` a deterministic heuristic run records observed
   activity entries (marked `method: "heuristic"`) so the pipeline still works.

### Consumption

`sync_workspace` gains `observed` (both details): `revision`
(`entriesRevision`), `updated_at`, and entries grouped by category with
`evidence`, `confidence`, `status`, the assistants involved and
`evidence_count`. It is labeled as *observed, not approved*: only `context`
is authoritative. Brief mode caps it. A `context.observed` event appears in
`recent_changes`/`events` so assistants syncing with `since` notice it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Enables the Haiku context manager (and the existing conflict check). |
| `CONTEXT_MODEL` | `claude-haiku-5-5` | Model for the context manager. |
| `INTEL_BATCH_WINDOW_MS` | `5000` | Debounce window before a batch runs. |
| `INTEL_DISABLED` | unset | `1` logs events but never runs the context manager. |

The Claude Code hook script and its setup are in `docs/claude-code-hooks.md`.

## Dashboard

The Live page shows **What the team is doing** (observed entries by category,
with evidence chips, the assistants involved, confirm/correct/retract), the
context manager's status (idle/scheduled/running, last run, model, pending
events, failures, Run now/Retry), **Context change history** (each revision
with its evidence events), and an **All activity** feed of `activity_events`
(MCP, Claude Code, Workspace, and dashed **Simulated** rows). The Overview has
a compact card. Corrections bump `entriesRevision`, so an in-flight model
batch goes stale instead of overwriting a person's edit.

## Demo (verified locally on 2026-10-24 with the real model)

1. Two connections in one workspace: Agent A (Claude Code with the MCP key and
   hooks installed), Agent B (any MCP client).
2. Ask Agent A: "Implement JWT authentication for the API: 15-minute access
   tokens signed with jose, rotating refresh tokens in an httpOnly cookie,
   plus middleware and tests." It edits files, writes `auth-design.md`
   through MCP, runs the tests (a failure, then a pass) and stops.
3. Within ~10 s (batch window + one Haiku call) the Live page shows the task
   **completed · verified** (because a test command exited 0), progress and
   knowledge entries, and goal and decision **proposals** on Approvals.
   Without the passing test run the same task stays `active` / `claimed`.
4. Ask Agent B: "What has the other assistant been working on?" Its
   `sync_workspace` returns `observed` and a `context.observed` change; it can
   say what is verified, what is only claimed, and what is pending approval.
5. Conflict: have Agent B write a doc that decides "drop JWTs; use Redis
   sessions". The context manager records a `coordination` entry and a
   decision proposal; the existing semantic conflict check marks both
   decision proposals `conflict` (competing) on Approvals.

Repeatable without assistants: `node integrations/claude-code/replay.mjs`
replays `demo-events.jsonl` (labeled simulated everywhere).

## Limitations

- Visibility is limited to Tandem MCP calls, installed Claude Code hooks, and
  workspace file changes. Native ChatGPT/Claude.ai chats are only observed
  through their MCP calls. Tandem never sees their conversations.
- `activity_events` follows the 14-day `agent_activity` retention, so evidence
  links on old entries can dangle.
- Model output varies: confidence on contradicting decisions is ~0.6, which
  is why the proposal gate is 0.5. Duplicate-ish entries can still appear and
  can be retracted on the dashboard.
- The context manager runs per workspace, one batch at a time (≤ 40 events).
