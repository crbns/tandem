# Context intelligence: autonomous, event-driven workspace context

Assistants do their work and save their documents; Tandem watches what it is
authorized to see, and a Haiku-powered context manager reads each document in
full, interprets the activity, and keeps one compacted, evidence-backed
picture of the workspace that every assistant receives through the existing
`sync_workspace` loop, and records the goal, decisions and owners that
documents state straight into project context. Assistants no longer write
progress notes, findings or "what this file shows" context changes: they
sync, read, work and save files.

```
Connected assistants ──► ingestion ──► activity_events (raw, redacted, append-only)
  MCP tool calls (mcp.ts run())                 │  significant event
  Claude Code hooks (POST /activity/claude-code)│  requestIntelRun (debounced)
  Workspace file changes (recordWorkspaceEvent) ▼
                                   intel.processWorkspace (Convex action)
                                    activity call + one digest call per
                                    changed document (full text, cached
                                    system prompt) ──► Haiku (CONTEXT_MODEL)
                                    ──► schema validation + evidence rules
                                    ──► one transactional apply mutation
                                    ──► per-section compaction over a size
                                        threshold (merge + supersede)
                                           │
              ┌────────────────────────────┼─────────────────────────────┐
              ▼                            ▼                             ▼
   context_entries (+ revisions)   structured_context (goal,          workspace_events
   observed tasks, progress,       decision and ownership findings,   "context.observed",
   blockers, knowledge, agent      via changeContextCore as the       "context.updated"
   summaries, coordination         "Context manager", applied at once) (sync feed, Live)
              │
              ▼
   sync_workspace `observed`: compacted, slim, sent only when it changed ──► every assistant
   Dashboard: Live activity feed, observed state, change history, evidence
```

## Audit of what existed (2026-10-24)

| Area | State before this work |
| --- | --- |
| MCP | `@convex-dev/mcp` in Convex HTTP actions (`mcp.ts`). Every tool goes through `run()`; each tool's internal mutation in `mcpTools.ts` calls `recordActivity` (`lib/agent.ts`), and failures are recorded by `run()` via `mcpTools.touchConnection`. Rows: `agent_activity` (summary only, no arguments; reads deduped; 14-day retention). |
| Workspace events | `workspace_events` with a gapless per-workspace `seq` (sync cursor). `recordWorkspaceEvent` also inserts `outbox_events`, which nothing consumes. |
| Context | `structured_context`: goal, scope, constraints, decisions, ownership, open questions — human-approved only, via `context_proposals`. No derived/observed state. Context updates only happened when an assistant called `propose_context_change` or `publish_work`. |
| Consumption (preserved) | `sync_workspace` (brief/full, cursor) + skill loop (`skills/tandem/SKILL.md`, `lib/mcpLoop.ts`); `agent_connections.syncedContextRevision` drives the Live page's "versions behind". |
| Anthropic | Only a semantic conflict check on context proposals (`ANTHROPIC_API_KEY`); proposals, approvals and that check have since been removed. |
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
  `context.updated`). `payload` is redacted JSON capped at
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
  `agentConnectionIds`; `fileIds`; `revision`. A goal or decision entry that
  was recorded in project context carries `contextEntryId` (the
  structured_context entry, `"goal"` for the goal); one whose recording was
  refused or already covered carries `contextSkipped` (the reason). Either
  way it is never recorded again. Legacy `proposalId` / `proposalSkipped`
  links count the same until `contextMigrations.removeProposals` turns them
  into `contextSkipped`.
- **`context_entry_revisions`** — append-only history; one row per change with
  the snapshot, `reason`, evidence and run.
- **`context_intel_runs`** — one row per batch: status, method (`llm` or
  `heuristic`), model, event ids, counts (including `contextChanges`, the
  project context changes it recorded), short error, tokens.
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
  context changes (`context.updated`) by people and assistants into
  `activity_events` with the file id and version. Events by `INTEL_ACTOR`
  are never mirrored (no feedback loop). The context manager reads the changed documents
  themselves (see Document digests).
- **Existing documents:** the first run in a workspace backfills one
  `file.backfill` event per live text file (`context_intel_state.backfilledAt`,
  200 files per mutation with a continuation; dedupe key
  `backfill:<fileId>:v<version>`), so documents that predate the context
  manager are read too. Owners/admins can re-run it from the dashboard
  ("Read existing documents", `intelligence.backfillDocuments`).

### Processing rules

1. `requestIntelRun` schedules `processWorkspace` after
   `INTEL_BATCH_WINDOW_MS` (default 5 s) unless already scheduled/running.
2. The action claims the workspace (lease, 6 min), loads ≤ 40 pending events
   (oldest first), the active entries (≤ 60, newest first), the project
   context as `project_context` (goal, scope, active decisions and
   constraints, and ownership as `{ area, owner_user_id }`), and the
   workspace's `members` (≤ 100, `{ id, name }`, never emails) that an
   ownership change can name.
3. **Document digests.** Every text file the batch touched (`file.created`,
   `file.updated`, `file.restored`, `file.backfill`; deduped per file,
   current version; binaries and deleted files skipped; ≤ 12 per batch, the
   rest stay pending for the next one) gets its own call with the file's full
   text (up to 24 KB; beyond that the first 18 KB, a `[middle omitted]`
   marker and the last 4 KB), its previous digest, `project_context` and
   `members`. The result is one `knowledge:doc-<id>` entry per file (≤ 800
   characters, with a `sourceHash`: an unchanged file is never re-sent) plus
   the tasks and blockers the document states and `context_changes` for its
   goal, decisions and owners. A document that is only a proposal,
   brainstorm or list of options states no decision or owner yet; one that
   assigns work or states a plan does. A finding that cites no
   event is backed by the document's own events. Calls run 4 at a time; any
   failure fails the run, so no event is processed without its document
   being read, except that a reply that would fail the same way on every
   retry (refusal, unparseable, truncated) falls back to a plain summary of
   that document. Deleting a document retracts its digest. The activity call
   never sees document text.
4. The activity call gets the events (untrusted data inside `<data>`) and must return JSON:
   `{ summary, entries: [{ op: "upsert"|"supersede"|"complete"|"reopen"|"resolve"|"retract", key, category, title, content, status, evidence, confidence, evidence_event_ids, agent_connection_ids, file_ids, superseded_by?, severity? }], context_changes: [{ field: "goal"|"decision"|"ownership", text, owner_user_id, confidence, evidence_event_ids, supersedes }] }`.
   For ownership, `text` is the area (a short noun phrase) and
   `owner_user_id` a member id; `supersedes` is an active decision id or
   `""`.
5. Validation is deterministic: unknown ops/categories dropped, ids must be
   from the batch / workspace, text clamped, confidence clamped, `completed`
   downgraded to `active` + `claimed` unless the evidence includes a verified
   signal (successful test/build/deploy tool result, or a human), entries
   below 0.35 confidence dropped. A context change is kept only with
   confidence ≥ 0.6, at least one batch event as evidence, text ≤ 500
   characters (an area ≤ 200), an ownership owner who is a member, a goal
   only while project context has none, and nothing project context already
   says (same decision text, or the same owner for the area); ≤ 8 per call.
   Which events count as verified is computed deterministically and handed
   to the model as `evidence_signal`, so it never has to guess. One record
   per fact: the activity call's knowledge entries about a digested
   document, and decision or goal entries that restate a context change, are
   dropped (the digest and the change's companion entry are the records).
6. One mutation applies everything, guarded by `entriesRevision` read at load
   (stale ⇒ retry the batch once against fresh state), writes revisions,
   marks the batch processed, bumps `entriesRevision`, records a
   `context.observed` workspace event, and records the context changes in
   `structured_context` through `changeContextCore`, the same core as a
   person's dashboard edit and an assistant's `update_context`, as
   `INTEL_ACTOR` (a system actor labeled "Tandem context manager"). Each
   applies at once with a `context.updated` event; nobody approves it, and
   people edit or remove it like any other entry. A run records ≤ 12 changes
   across the activity and digest calls, at most one goal and at most one
   that supersedes a decision. Each is re-checked against `structured_context`
   at apply time, since a person may have changed it during the model call:
   a goal only while none is set, and an area's owner replaced only when the
   context manager set that owner itself. Goal and decision changes are tracked by a
   companion `goal:`/`decision:` entry carrying `contextEntryId`; a refused
   change (an owner who left, a deleted source file) marks it
   `contextSkipped` and the finding stays observed. Active goal and decision
   entries with confidence ≥ 0.6 that the model never listed as changes are
   promoted the same way (≤ 3 per run).
7. **Compaction.** After an apply that changed something (model mode), every
   section whose live entries pass its threshold (goal 2, objective 2,
   decision 6, task 8, progress 6, blocker 6, knowledge 10 excluding
   digests, coordination 4) is compacted in one call: merged entries are
   upserted and folded ones superseded (`superseded_by`), in one mutation
   guarded by `entriesRevision`. A merge keeps the union of evidence and the
   weakest evidence it folds; entries a person confirmed or corrected are
   never folded. For project context, a decisions section can also return
   `decision_supersede` (`{ decision_id, text, confidence }`) when a
   decision in `context_decisions` is replaced or duplicated by a newer one:
   it is checked like any context change (confidence ≥ 0.6, a known
   decision, new text, one per run) and applied directly, but only to a
   decision the context manager recorded itself, never a person's or an
   assistant's. A merged entry
   inherits the `contextEntryId` or `contextSkipped` of what it folds.
8. **Prompt caching.** All three calls send the system prompt as a cached
   block (`cache_control: ephemeral`); cache reads count toward the run's
   input tokens.
9. Failures: provider errors/timeouts/unparseable output mark the run failed,
   leave events pending, and back off (`30s × 2^n`, max 10 min). After 5
   consecutive failures automatic retries stop; the next significant event
   or the dashboard's Run now starts a fresh attempt. A reply cut off at
   `max_tokens` is retried with half the events. A run that was scheduled
   but never claimed (disabled at fire time, or crashed first) doesn't hold
   the workspace: the next event reschedules after a 60 s grace. Without
   `ANTHROPIC_API_KEY` a deterministic heuristic run records observed
   activity entries (marked `method: "heuristic"`) so the pipeline still works.

### Consumption

`sync_workspace` gains `observed`, the compacted summary assistants read
instead of skimming recent work and events: `revision` (`entriesRevision`),
`updated_at`, a one-line note (not project context; claimed ≠ done) and slim
entries `{ key, category, title, content, status, evidence, confidence,
agents (labels), updated_at }`. Full: ≤ 30 entries, content ≤ 400, no
superseded history. Brief: ≤ 10, content ≤ 160, blockers and active work
first, document digests last. Snapshots always include it; with `since` it
is sent only when the page holds a `context.observed` or `context.corrected`
event (otherwise `observed_changed: false`). In brief mode, when the
workspace has observed context, `recent_work` shrinks to titles (no
summaries).

### Agent loop

Sync (brief first; read `observed`) → read the files the task touches → work
→ save files with `create_document` / `update_document` → reply. Removed:
`publish_work` on every request, context changes before and after the work,
and seeding empty context; the context manager does that from the saved files
and activity. `publish_work` is only for a deliverable the user wants
announced, and `update_context` only for a change the user directs.

### Measured (`syncBudget.test.ts`, realistic workspace)

| | Before this PR | PR as first reviewed | Now |
| --- | --- | --- | --- |
| Brief sync | 22.6 KB | 33.1 KB | 15.7 KB (budget 18 KB) |
| Full sync | — | 95 KB | 69 KB |
| Writes per edit request | save + publish + context changes | same | save |
| `MCP_INSTRUCTIONS` | 1285 chars | | 1189 chars |
| Sync `next_steps` | 7 lines / 1708 chars | | 4 lines / 675 chars |

A live run (local backend, real model) gave a 3–4.5 KB brief sync and a
1.3 KB `since` sync with nothing new.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Enables the Haiku context manager. |
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
   knowledge entries, and the goal (if none was set) and decisions recorded
   in project context by the context manager. Without the passing test run
   the same task stays `active` / `claimed`.
4. Ask Agent B: "What has the other assistant been working on?" Its
   `sync_workspace` returns `observed` and a `context.observed` change; it can
   say what is verified and what is only claimed.
5. Change of plan: have Agent B write a doc that decides "drop JWTs; use Redis
   sessions". The context manager records a `coordination` entry and the new
   decision in project context (superseding the JWT decision when the model
   links them); a person can
   edit or revert it on the Context page.

Repeatable without assistants: `node integrations/claude-code/replay.mjs`
replays `demo-events.jsonl` (labeled simulated everywhere).

## Limitations

- Visibility is limited to Tandem MCP calls, installed Claude Code hooks, and
  workspace file changes. Native ChatGPT/Claude.ai chats are only observed
  through their MCP calls. Tandem never sees their conversations.
- `activity_events` follows the 14-day `agent_activity` retention, so evidence
  links on old entries can dangle.
- Model output varies, and changes apply without review: the 0.6 gate keeps
  out most guesses, and people correct the rest on the dashboard. Compaction
  folds near-duplicates once a section passes its threshold; below it they
  can be retracted on the dashboard.
- The context manager runs per workspace, one batch at a time (≤ 40 events,
  ≤ 12 documents).
- Project context is compacted only one superseded decision at a time;
  nothing merges several of its entries at once.
- Documents over 24 KB are read as head and tail, not in full.
