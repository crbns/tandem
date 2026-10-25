# Context conflict detection and resolution

When assistants change the shared project context in conflicting ways, Tandem
detects the conflict, keeps both versions, and waits for a person to resolve
it. It never silently overwrites an approved decision.

This extends the existing proposal flow (`context_proposals`, `approvals`,
`propose_context_change`, `sync_workspace`, the Approvals page). It adds no new
infrastructure: Convex mutations for the transactional parts, one scheduled
Convex action for the LLM call, and the existing workspace-event subscription
for realtime.

## Detection

Detection runs inside `proposeContextChangeCore` (`convex/lib/ops.ts`), in the
same transaction that inserts the proposal.

| Layer | When it runs | Result |
| --- | --- | --- |
| Optimistic concurrency | `expected_version` given and the context revision moved | `VERSION_CONFLICT` with `currentVersion`; nothing is written |
| Structural: replaces | A `decisions` add with `supersedes` naming an active decision | Conflict item `replaces` targeting that decision. No LLM call |
| Structural: competing | Another **pending** proposal changes the same scalar field (`goal`/`scope`) or supersedes the same decision | Conflict item `competing` targeting that proposal. No LLM call |
| Semantic | A `decisions` or `constraints` add, and at least one candidate exists: active decisions and constraints, plus pending decision and constraint proposals (newest 30, minus the explicit `supersedes` target) | `conflict.status = "checking"`; a scheduled action asks the LLM |

A `competing` item is mirrored onto the earlier proposal, so both cards show
the conflict and whichever is decided first retargets the other (see
Resolution). The semantic check never runs for goal, scope, ownership, open questions,
resolve or remove. It also skips workspaces with no candidates, and duplicate
requests (see Idempotency). An add whose normalized text equals an active entry
is clear.

### Semantic check (`convex/conflicts.ts`)

`internal.conflicts.checkProposal` is an internal action, scheduled with
`runAfter(0)`. It:

1. Loads the proposal and a snapshot of its candidates with an internal query
   (`internal.conflicts.loadCheck`), recomputed when the action runs and
   limited to proposals made before this one. It stops if the proposal is no
   longer pending or no longer `checking`.
2. Calls the Anthropic Messages API (`fetch`, no SDK). The model is
   `CONFLICT_MODEL`, default `claude-haiku-5-5`. The key comes from
   `ANTHROPIC_API_KEY`, and the call times out after 15 s. These are read from
   `process.env` (set them with `npx convex env set`), not declared in
   `convex.config.ts`, so adding them needs no codegen. The prompt treats all
   context text as untrusted data, and the model returns JSON. For each
   candidate it gives `relation` (`contradicts`, `compatible` or `unsure`),
   `confidence` (0 to 1) and a one-sentence `explanation`.
3. Maps the verdict:
   - `contradicts` with confidence ≥ 0.7 becomes a `contradicts` item, or a `competing` item when the candidate is a pending proposal.
   - `contradicts` below 0.7, or `unsure`, becomes an item with `uncertain: true`.
   - `compatible` produces no item.
   - A candidate the model gives no verdict for becomes an `uncertain` item.
   - Overall status: `conflict` if any item is certain, else `uncertain` if any item exists, else `clear`.
4. Falls back when it can't get a usable verdict:
   - With no API key, a lexical heuristic runs. Shared 4-character stems after stopwords count as overlap. Overlap gives `uncertain` with method `heuristic`; no overlap gives `clear`.
   - When an API key is set but the call errors, times out, or returns unparseable output, the result is `uncertain`, and `reason` names the failure. A failure is never treated as compatible.
5. Records the verdict with `internal.conflicts.recordVerdict`. This is a no-op unless the proposal is still `pending` and still `checking`, so retries and duplicate runs are safe. It recomputes the candidates first: if one appeared during the call (say, a contradicting decision was approved), the verdict is stale, so it schedules the check again and records nothing; items whose target is no longer a candidate (a rival proposal was decided) are dropped. It also records a workspace event, which refreshes the dashboard: `context.recorded` when it applies the proposal, else `context.conflict_checked`.

### Automatic workspaces

A proposal applies at once only when it has no conflict field, or its conflict
status is `clear`:

- A `checking` proposal is held as `pending`. When the verdict comes back `clear`, `recordVerdict` applies it (status `applied`), provided it is still pending and the workspace is still automatic.
- A `conflict` or `uncertain` proposal stays `pending` for a human.
- An explicit `supersedes` is a `replaces` conflict, so in automatic mode it is now held. Before this change it applied immediately.

## Data model (`context_proposals`, all optional, backward compatible)

```ts
conflict?: {
  status: "checking" | "clear" | "conflict" | "uncertain";
  method: "structural" | "semantic" | "heuristic";
  checkedAt?: number;
  model?: string;
  reason?: string;            // e.g. "Semantic check unavailable: timeout"
  items: Array<{
    kind: "replaces" | "contradicts" | "competing";
    uncertain?: boolean;      // the model was unsure; human review required
    targetType: "decision" | "constraint" | "goal" | "scope" | "proposal";
    targetId: string;         // context entry id, "goal"/"scope", or proposal id
    targetText: string;       // snapshot of the original value at detection
    targetBy: Actor;          // who set or proposed the target
    targetAt: number;
    contextVersion: number;   // structured_context.revision at detection
    explanation: string;
    confidence?: number;
  }>;
};
hasConflict?: boolean;        // true once it had any item (or status conflict|uncertain); indexed
resolution?: "accepted" | "kept_both" | "retained_current" | "rejected";
decisionNote?: string;        // the resolver's rationale (≤ 2000 chars)
appliedEntryId?: string;      // the context entry it added when it applied
```

`appliedEntryId` is not in the original design. Sync needs it to say which
entry is in effect after a "keep both", where nothing else points at the new
entry.

The schema also gets a new index,
`by_workspace_and_has_conflict_and_created` on
`["workspaceId", "hasConflict", "createdAt"]`. The `approvals` table gets the
optional fields `resolution` and `note`. History is never deleted: superseded
decisions keep `status: "superseded"` and `supersededBy`, and every decision
writes an `approvals` row and workspace events.

## Resolution

`api.context.decideContextProposal` keeps its existing arguments and gains
three optional ones:

```ts
{ proposalId, decision: "approved" | "rejected",
  resolution?: "accepted" | "kept_both" | "retained_current" | "rejected",
  note?: string,               // ≤ 2000 chars
  expectedRevision?: number }  // proposal.revision the UI showed
```

| UI action | decision | resolution | Effect |
| --- | --- | --- | --- |
| Accept proposed | approved | accepted (default when approving a proposal with `hasConflict`) | Applies the proposal. Every active decision or constraint it `replaces` or `contradicts` becomes `superseded`, with `supersededBy` set to the new entry |
| Keep both (not a conflict) | approved | kept_both | Applies as a plain addition and supersedes nothing |
| Keep current | rejected | retained_current | Changes nothing in the context. Records that the current value was kept |
| Reject | rejected | rejected (default when `hasConflict`) | Changes nothing in the context |

Each resolution:

- Is serializable: it runs in one Convex mutation, and a second decide fails with `PROPOSAL_ALREADY_DECIDED`.
- Fails with `PROPOSAL_CHANGED` when `expectedRevision` doesn't match. For example, the verdict arrived while the person was looking at the card.
- Can approve a `checking` proposal. The late verdict is then a no-op. Without `hasConflict` it records no resolution unless one is passed.
- Fails with `INVALID_INPUT` when `resolution` doesn't match `decision` (approved takes accepted or kept_both; rejected takes retained_current or rejected).
- Leaves a target that is no longer active alone instead of failing.
- Updates pending proposals that list the decided proposal as a `competing` target. On approval, they retarget to the new decision entry. On rejection, the item is dropped, and the status becomes `clear` when no items remain. A proposal cleared this way still waits for a person, even in an automatic workspace.
- Records `context.approved` or `context.rejected` as before. A proposal with `hasConflict` also records `context.conflict_resolved`, with a summary such as: `Kept "Use Convex Auth" over "Switch authentication to Clerk"`.

## MCP

- **`propose_context_change`:**
  - The response adds `proposal.conflict` (snake_case, see the shape below), `proposal.resolution`, `proposal.decision_note` and `deduplicated`.
  - When the status is `checking`, the handler polls the proposal for up to `CONFLICT_WAIT_MS` (default 8000 ms) so it can return the verdict inline. If the check is still running, it returns `checking`.
  - When the status is `conflict` or `uncertain`, `next_steps` names the conflicting approved entry, its text, and `context_version`. It also says the proposal is pending human resolution and NOT in effect, so the assistant keeps following the approved value and tells the user.
- **`sync_workspace`:**
  - `pending_proposals[].conflict` (full mode).
  - `brief.blockers.conflicts`, which lists unresolved conflicts: `{ proposal_id, field, proposed_value, proposed_by, status, conflicts_with: [{ type, id, text }], context_version }`.
  - `resolved_conflicts`, in both brief and full mode:
    - In a snapshot, the newest 5. With `since`, those resolved within the event page.
    - Each one is `{ proposal_id, field, proposed_value, outcome, note, resolved_by, resolved_at, in_effect: [{ id, text }], not_in_effect: [text] }`.
    - `in_effect` lists the authoritative entries after resolution.
- **`get_approvals`:** each proposal adds `conflict`, `resolution` and `decision_note`.
- **Approved vs pending:** `context` and `brief.active_decisions` stay approved-only. Anything under `pending_proposals` or `blockers` is not in effect.
- `MCP_INSTRUCTIONS` and the other `lib/mcpLoop.ts` strings are unchanged: `apps/mcp` keeps a copy that a parity test compares. Conflict guidance lives in the tool descriptions, `next_steps` (`conflictNextSteps` in `lib/mcpContract.ts`) and `skills/tandem/SKILL.md`.

Snake_case conflict shape:

```json
{ "status": "conflict", "method": "semantic", "reason": null,
  "checked_at": "2026-10-24T20:00:00.000Z",
  "items": [{ "kind": "contradicts", "uncertain": false,
    "target_type": "decision", "target_id": "…", "target_text": "Use Convex Auth",
    "target_by": { "actor_type": "agent", "...": "..." },
    "target_at": "2026-10-24T19:00:00.000Z", "context_version": 7,
    "explanation": "Both choose the auth provider; Clerk replaces Convex Auth.",
    "confidence": 0.93 }] }
```

## Idempotency

`proposeContextChangeCore` checks for a duplicate before inserting. A duplicate
has the same creator (the agent connection, or the human user), field,
operation, normalized `proposedValue`, `supersedes`, `entryId` and
`ownerUserId`, and an existing proposal that is either `pending`, or `applied`
within the last 10 minutes and still in effect (for an add, the goal or scope
still has that value, or an active entry has that text; re-adding something
since replaced, resolved or superseded is a new change). For a duplicate it returns the existing proposal
with `deduplicated: true`. It writes no new row, records no event, and makes no
LLM call.

## Dashboard API

`api.context.listConflicts({ workspaceId })` returns `{ pending, resolved }`:
pending proposals whose conflict status isn't `clear`, and the newest 50
approved or rejected proposals with `hasConflict`. Every proposal the
dashboard reads (`getApprovals`, `listConflicts`) carries `conflict`,
`resolution`, `decisionNote` (each or null) and `revision`, the value to pass
as `expectedRevision`.

## Dashboard (`apps/web`)

- On the Approvals page, a proposal whose conflict status is `checking`, `conflict` or `uncertain` renders as a conflict card:
  - **Current:** the approved value, who set it, and when. It sits beside **Proposed**: the new value, the proposing agent's badge, and the rationale.
  - The explanation, confidence, and how the conflict was found (AI check, structural, or heuristic).
  - **Actions:** Accept proposed, Keep current, Reject, and a secondary "Not a conflict, keep both", plus an optional note field.
- The status badge reads pending, accepted, or rejected. A **Conflict history** section lists resolved conflicts with the outcome, note, resolver, and both values.
- The overview's pending-approvals panel calls out conflicts.
- Realtime comes from the existing `watchWorkspace` subscription. Every verdict and resolution records a workspace event.

## Demo

See the final section of the PR description, or `docs/demo-seed.md`.
