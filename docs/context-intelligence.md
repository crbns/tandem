# Context intelligence

Tandem separates authoritative project context from compact observations.

## Active project context

Every `sync_workspace` result, including `detail: "brief"` and incremental
syncs, contains `active_context`: the complete active goal, scope,
constraints, decisions, ownership and open questions. Each entry includes
its source file IDs. The `brief` lists remain capped at ten for orientation;
`active_context` is never capped by that limit. Full sync also includes
resolved and superseded context history, folders and richer events.
`context_version` identifies the authoritative context revision. A brief
sync counts as receiving that revision on the Live page.

A person can edit project context in the dashboard or direct their
assistant to call `update_context` with the current expected version.
Document text and model inferences do not change authoritative context.

## Existing Haiku manager

The existing `intel.processWorkspace` action batches significant
`activity_events` and changed text documents. With
`ANTHROPIC_API_KEY`, it sends redacted event data and document excerpts
to Anthropic's API. The document digest call includes up to 24 KB of text
per document and processes at most 12 changed documents in one batch.
This implementation uses the same outbound calls; it adds no second
extractor or new external data flow. Without the key, the heuristic path
records observations.

Haiku writes `context_entries`, with categories such as task, progress,
blocker, knowledge, decision, goal and coordination. These entries carry
evidence levels, confidence, event references, source file IDs, revision
history and status. A stated goal, decision or owner assignment is an
**observed candidate**, never an approved project rule. Legacy
`context_changes` model output is converted to observations, and a
compaction suggestion cannot supersede an authoritative decision.
Automatic promotion from observed entries into `structured_context`
has been removed.

Validation checks categories, IDs, confidence and evidence before one
mutation applies the batch with an `entriesRevision` guard. Claimed
completion cannot become verified without a successful test, build or
deploy signal, or human confirmation. Compaction merges redundant
observations; human corrections are protected. Runs back off after provider
errors, leaving events pending.

## Sync and agent workflow

`observed` is a compact, unapproved summary: at most 10 entries in brief
and 30 in full, ordered so active blockers and work appear first.
Entries include `id`, `revision`, `source_file_ids`, evidence and
confidence. Incremental sync omits it when the event page has no observed
change. Evidence rises from `requested` to `claimed`, `observed`,
`verified` and `human_confirmed`; claimed work must not be presented
as done.

Agents sync, read `active_context`, inspect relevant observations, and
read the linked current files before acting. They fix verified routine
issues within the user's task and save changed files with version checks.
They create a shared task for unrelated work. A major goal, scope,
decision or ownership change needs human direction. After fixing an issue
or disproving a stale lead, an agent may call `resolve_observation` with
its ID, `expected_revision` and a short note. The mutation checks
workspace access and revision, preserves the evidence level, records
agent attribution and emits `context.corrected`. It does not change
`structured_context`. The call is a significant event for the context
manager, and a later batch only reopens the lead when it cites an event
recorded after the resolution.

Tandem cannot wake native chats. Assistants receive this context when
they next call `sync_workspace`.

## Example

Agent A saves an auth design and runs tests. Haiku produces a task
observation linked to the file and activity evidence. Agent B's next sync
returns the complete active project context and the compact observation.
If Agent B's current task touches auth, it reads the source and test
result, fixes a routine issue if needed, then resolves the observation when
the issue is closed. A verified observation that is still useful stays active.
If the design document claims the team chose Redis, that claim remains
observed until a person directs a context update.

## Main modules

- `convex/intel.ts` and `convex/lib/intel.ts`: existing batching,
  Haiku calls, validation and compaction.
- `convex/lib/observed.ts` and `convex/lib/mcpContract.ts`: sync views.
- `convex/mcp.ts` and `convex/mcpTools.ts`: MCP tools and versioned writes.
- `skills/tandem/SKILL.md` and `convex/lib/mcpLoop.ts`: agent workflow.
- `convex/intelligence.ts`: dashboard corrections and status.

Visibility is limited to Tandem MCP calls, installed Claude Code hooks and
workspace changes. Native chats are observed only through their MCP calls.
