import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const actor = v.object({
  type: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
  userId: v.optional(v.id("users")),
  agentConnectionId: v.optional(v.id("agent_connections")),
  label: v.string(),
  client: v.optional(v.string()),
  userName: v.optional(v.string()),
});

// Legacy: the removed proposal flow's conflict record (context_proposals).
const conflictItem = v.object({
  kind: v.union(v.literal("replaces"), v.literal("contradicts"), v.literal("competing")),
  // The model was unsure; human review required.
  uncertain: v.optional(v.boolean()),
  targetType: v.union(
    v.literal("decision"),
    v.literal("constraint"),
    v.literal("goal"),
    v.literal("scope"),
    v.literal("proposal"),
  ),
  // Context entry id, "goal"/"scope", or a proposal id.
  targetId: v.string(),
  // Snapshot of the target's value at detection.
  targetText: v.string(),
  targetBy: actor,
  targetAt: v.number(),
  contextVersion: v.number(),
  explanation: v.string(),
  confidence: v.optional(v.number()),
});

const conflict = v.object({
  status: v.union(
    v.literal("checking"),
    v.literal("clear"),
    v.literal("conflict"),
    v.literal("uncertain"),
  ),
  method: v.union(v.literal("structural"), v.literal("semantic"), v.literal("heuristic")),
  checkedAt: v.optional(v.number()),
  model: v.optional(v.string()),
  reason: v.optional(v.string()),
  items: v.array(conflictItem),
});

const resolution = v.union(
  v.literal("accepted"),
  v.literal("kept_both"),
  v.literal("retained_current"),
  v.literal("rejected"),
);

const contextValue = v.object({
  id: v.optional(v.string()),
  status: v.optional(
    v.union(
      v.literal("active"),
      v.literal("resolved"),
      v.literal("superseded"),
    ),
  ),
  resolvedBy: v.optional(actor),
  resolvedAt: v.optional(v.number()),
  supersededBy: v.optional(v.string()),
  text: v.string(),
  sourceFileIds: v.array(v.id("files")),
  updatedBy: actor,
  updatedAt: v.number(),
  // Ownership entries only: the owning member and the area they own. `text`
  // is the display form ("area: member name"). Absent on legacy entries.
  ownerUserId: v.optional(v.id("users")),
  ownerArea: v.optional(v.string()),
});

const activityKind = v.union(
  v.literal("sync"),
  v.literal("read"),
  v.literal("write"),
  v.literal("propose"),
  v.literal("publish"),
  v.literal("task"),
  v.literal("conflict"),
  v.literal("error"),
);

const activityResource = v.object({
  type: v.union(
    v.literal("file"),
    v.literal("folder"),
    v.literal("proposal"),
    v.literal("task"),
    v.literal("published_work"),
    v.literal("context"),
  ),
  id: v.string(),
  label: v.optional(v.string()),
});

// Context intelligence (docs/context-intelligence.md).
const activitySource = v.union(
  v.literal("mcp"),
  v.literal("claude_code"),
  v.literal("workspace"),
  // Development replay only; always labeled as simulated in the dashboard.
  v.literal("simulator"),
);

const contextEntryCategory = v.union(
  v.literal("goal"),
  v.literal("objective"),
  v.literal("decision"),
  v.literal("task"),
  v.literal("progress"),
  v.literal("blocker"),
  v.literal("knowledge"),
  v.literal("agent_summary"),
  v.literal("coordination"),
);

const contextEntryStatus = v.union(
  v.literal("active"),
  v.literal("completed"),
  v.literal("resolved"),
  v.literal("superseded"),
  v.literal("retracted"),
);

// Evidence ladder, weakest first. "completed" needs verified or
// human_confirmed; an assistant saying it's done is only "claimed".
const contextEvidence = v.union(
  v.literal("requested"),
  v.literal("claimed"),
  v.literal("observed"),
  v.literal("verified"),
  v.literal("human_confirmed"),
);

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    updatedBy: v.optional(actor),
    revision: v.optional(v.number()),
    appCreatedAt: v.optional(v.number()),
    appUpdatedAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  workspaces: defineTable({
    name: v.string(),
    // Set only on the workspace seed:resetDemo builds, which a reset deletes.
    demoSeed: v.optional(v.boolean()),
    // Legacy: the removed approval setting. Context changes always apply at
    // once; contextMigrations.removeProposals clears it.
    contextApproval: v.optional(
      v.union(v.literal("manual"), v.literal("automatic")),
    ),
    createdBy: v.id("users"),
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_created_by", ["createdBy"]),

  workspace_members: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    updatedBy: actor,
    revision: v.number(),
    joinedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_user", ["workspaceId", "userId"])
    .index("by_user_and_workspace", ["userId", "workspaceId"]),

  workspace_invites: defineTable({
    workspaceId: v.id("workspaces"),
    tokenHash: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.number(),
    acceptedBy: v.optional(v.id("users")),
    acceptedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    updatedBy: actor,
    revision: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_workspace", ["workspaceId"]),

  agent_connections: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    client: v.string(),
    displayName: v.optional(v.string()),
    // Legacy `tdm_` token hash from the retired Node MCP server. No longer
    // verified anywhere; kept so existing rows still validate.
    tokenHash: v.optional(v.string()),
    // How the assistant authenticates to the Convex MCP endpoint. The
    // @convex-dev/mcp component holds the credentials (hashed), as grants
    // whose userId is this row's id. Absent on legacy token rows.
    authKind: v.optional(v.union(v.literal("api_key"), v.literal("oauth"))),
    // OAuth only: the name the client registered itself with. Unverified.
    oauthClientName: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    lastMcpActionAt: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    // structured_context.revision handed out by this connection's last
    // successful sync_workspace.
    syncedContextRevision: v.optional(v.number()),
    // True when that version only arrived as a brief sync (goal, scope,
    // recent decisions and blockers; no constraints or ownership).
    syncedContextBrief: v.optional(v.boolean()),
  })
    .index("by_workspace_and_user", ["workspaceId", "userId"])
    // Live (unrevoked) connections have no revokedAt, so they sort first.
    .index("by_workspace_and_revoked_at", ["workspaceId", "revokedAt"])
    .index("by_user_and_client", ["userId", "client"])
    .index("by_token_hash", ["tokenHash"]),

  folders: defineTable({
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
    // Collision key shared with files (lib/names.ts). Absent on legacy rows,
    // which are keyed by nameKey(name) on read, and on soft-deleted folders.
    nameKey: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(actor),
    createdBy: actor,
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_parent", ["workspaceId", "parentId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_and_parent_and_name_key", [
      "workspaceId",
      "parentId",
      "nameKey",
    ])
    // Live legacy rows (no nameKey) without the tombstones that also lack one.
    .index("by_workspace_and_parent_and_name_key_and_deleted_at", [
      "workspaceId",
      "parentId",
      "nameKey",
      "deletedAt",
    ])
    .index("by_workspace_and_deleted_at_and_parent", [
      "workspaceId",
      "deletedAt",
      "parentId",
    ]),

  files: defineTable({
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
    // Collision key for NAME_EXISTS (lib/names.ts). Optional only for rows
    // created before uniqueness was enforced, or soft-deleted files.
    nameKey: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(actor),
    mimeType: v.string(),
    content: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    version: v.number(),
    createdBy: actor,
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_deleted_at_and_updated_at", ["workspaceId", "deletedAt", "updatedAt"])
    .index("by_workspace_and_deleted_at_and_parent", ["workspaceId", "deletedAt", "parentId"])
    .index("by_workspace_and_parent", ["workspaceId", "parentId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_and_updated_at", ["workspaceId", "updatedAt"])
    .index("by_workspace_and_parent_and_name_key", [
      "workspaceId",
      "parentId",
      "nameKey",
    ])
    // Live legacy rows (no nameKey) without the tombstones that also lack one.
    .index("by_workspace_and_parent_and_name_key_and_deleted_at", [
      "workspaceId",
      "parentId",
      "nameKey",
      "deletedAt",
    ])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["workspaceId", "parentId", "deletedAt"],
    }),

  file_revisions: defineTable({
    workspaceId: v.id("workspaces"),
    fileId: v.id("files"),
    version: v.number(),
    content: v.string(),
    storageId: v.optional(v.id("_storage")),
    mimeType: v.optional(v.string()),
    size: v.optional(v.number()),
    actor,
    createdAt: v.number(),
  })
    .index("by_file_and_version", ["fileId", "version"])
    .index("by_workspace_and_created", ["workspaceId", "createdAt"]),

  structured_context: defineTable({
    workspaceId: v.id("workspaces"),
    goal: v.optional(contextValue),
    scope: v.optional(contextValue),
    constraints: v.array(contextValue),
    decisions: v.array(contextValue),
    ownership: v.array(contextValue),
    openQuestions: v.array(contextValue),
    revision: v.number(),
    updatedAt: v.number(),
    updatedBy: actor,
  }).index("by_workspace", ["workspaceId"]),

  // Legacy: the removed proposal flow. Nothing reads or writes these tables;
  // contextMigrations.removeProposals empties them so they can be dropped.
  context_proposals: defineTable({
    workspaceId: v.id("workspaces"),
    field: v.union(
      v.literal("goal"),
      v.literal("scope"),
      v.literal("constraint"),
      v.literal("decision"),
      v.literal("ownership"),
      v.literal("open_question"),
    ),
    proposedValue: v.string(),
    rationale: v.string(),
    sourceFileIds: v.array(v.id("files")),
    supersedes: v.optional(v.string()),
    contextRevision: v.optional(v.number()),
    // Snapshot the scalar field a proposal is based on. Append-only fields do
    // not need a base value because separate proposals do not overwrite them.
    baseValue: v.optional(v.union(v.string(), v.null())),
    // Ownership proposals only: a member of the workspace when proposed, and
    // re-checked on approval. proposedValue is the display form.
    ownerUserId: v.optional(v.id("users")),
    ownerArea: v.optional(v.string()),
    // Resolve/remove proposals only: the constraint or open question entry
    // they act on. Absent means an addition.
    operation: v.optional(v.union(v.literal("resolve"), v.literal("remove"))),
    entryId: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("applied"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("stale"),
    ),
    createdBy: actor,
    createdAt: v.number(),
    decidedBy: v.optional(actor),
    decidedAt: v.optional(v.number()),
    // Conflict detection and resolution (removed with the proposal flow).
    conflict: v.optional(conflict),
    // True once the conflict status was conflict or uncertain; indexed for history.
    hasConflict: v.optional(v.boolean()),
    resolution: v.optional(resolution),
    decisionNote: v.optional(v.string()),
    // The context entry this proposal added when it applied.
    appliedEntryId: v.optional(v.string()),
    updatedBy: actor,
    revision: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_status", ["workspaceId", "status"])
    .index("by_workspace_and_created", ["workspaceId", "createdAt"])
    .index("by_workspace_and_has_conflict_and_created", [
      "workspaceId",
      "hasConflict",
      "createdAt",
    ]),

  approvals: defineTable({
    workspaceId: v.id("workspaces"),
    proposalId: v.id("context_proposals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    decidedBy: actor,
    decidedAt: v.number(),
    resolution: v.optional(resolution),
    note: v.optional(v.string()),
  })
    .index("by_workspace_and_decided", ["workspaceId", "decidedAt"])
    .index("by_proposal", ["proposalId"]),

  published_work: defineTable({
    workspaceId: v.id("workspaces"),
    kind: v.union(v.literal("deliverable"), v.literal("finding")),
    title: v.string(),
    summary: v.string(),
    fileIds: v.array(v.id("files")),
    createdBy: actor,
    createdAt: v.number(),
    updatedBy: actor,
    revision: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_and_created", ["workspaceId", "createdAt"]),

  // Lightweight work coordination for assistants (manage_task). The owner is
  // the person doing the task, not the approval-gated context ownership.
  // History is the task.* rows in workspace_events.
  tasks: defineTable({
    workspaceId: v.id("workspaces"),
    title: v.string(),
    description: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("done"),
    ),
    ownerId: v.optional(v.id("users")),
    version: v.number(),
    createdBy: actor,
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_workspace_and_status_and_updated_at", [
      "workspaceId",
      "status",
      "updatedAt",
    ])
    .index("by_workspace_and_updated_at", ["workspaceId", "updatedAt"]),

  workspace_events: defineTable({
    workspaceId: v.id("workspaces"),
    // Per-workspace, gapless, assigned in the same transaction as the write
    // (lib/auth.ts recordWorkspaceEvent). Optional only for legacy rows.
    seq: v.optional(v.number()),
    kind: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    summary: v.string(),
    actor,
    createdAt: v.number(),
  })
    .index("by_workspace_and_created", ["workspaceId", "createdAt"])
    .index("by_workspace_and_seq", ["workspaceId", "seq"])
    .index("by_workspace_and_kind_and_seq", ["workspaceId", "kind", "seq"])
    .index("by_workspace_and_entity", [
      "workspaceId",
      "entityType",
      "entityId",
    ]),

  // One row per MCP tool call, for the dashboard's Live view (activity.ts).
  // Separate from workspace_events on purpose: reads, syncs and failed calls
  // must never reach agents' sync feeds or the outbox. Pruned after 14 days.
  agent_activity: defineTable({
    workspaceId: v.id("workspaces"),
    agentConnectionId: v.id("agent_connections"),
    actor,
    tool: v.string(),
    kind: activityKind,
    outcome: v.union(v.literal("ok"), v.literal("conflict"), v.literal("error")),
    // ConvexError code only, never a raw message.
    errorCode: v.optional(v.string()),
    // Short and generated: never file content, prompt text or rationale.
    summary: v.string(),
    resource: v.optional(activityResource),
    contextRevision: v.number(),
    // sync_workspace only: the connection's syncedContextRevision before it.
    previousSyncedContextRevision: v.optional(v.number()),
    // A successful write that follows this connection's own conflict on the
    // same resource (lib/agent.ts recordActivity).
    resolvesActivityId: v.optional(v.id("agent_activity")),
    createdAt: v.number(),
  })
    .index("by_workspace_and_created", ["workspaceId", "createdAt"])
    .index("by_connection_and_created", ["agentConnectionId", "createdAt"]),

  // Context intelligence (docs/context-intelligence.md). The unified, raw
  // activity log the context manager reads: MCP tool calls (with redacted,
  // bounded arguments), Claude Code hook events, and workspace file changes.
  // Raw evidence only; nothing here is derived by a model. Pruned with
  // agent_activity's retention.
  activity_events: defineTable({
    workspaceId: v.id("workspaces"),
    agentConnectionId: v.optional(v.id("agent_connections")),
    actor,
    source: activitySource,
    // Namespaced: "mcp.tool_call", "claude_code.prompt", "file.updated", ...
    type: v.string(),
    tool: v.optional(v.string()),
    outcome: v.union(v.literal("ok"), v.literal("conflict"), v.literal("error")),
    errorCode: v.optional(v.string()),
    // Short and generated; never a credential.
    summary: v.string(),
    // Redacted, size-capped JSON (lib/redact.ts). Untrusted text.
    payload: v.optional(v.string()),
    resources: v.array(activityResource),
    // Claude Code session_id, or the MCP connection's id for MCP calls.
    sessionId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    // Idempotency: a second event with the same key in a workspace is dropped.
    dedupeKey: v.string(),
    // Whether the context manager should look at it at all.
    significant: v.boolean(),
    intelStatus: v.union(
      v.literal("pending"),
      v.literal("processed"),
      v.literal("skipped"),
    ),
    intelRunId: v.optional(v.id("context_intel_runs")),
    // When the source says it happened (hooks may arrive late); createdAt is
    // when Tandem stored it.
    occurredAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_workspace_and_created", ["workspaceId", "createdAt"])
    .index("by_workspace_and_dedupe_key", ["workspaceId", "dedupeKey"])
    .index("by_workspace_and_intel_status_and_created", [
      "workspaceId",
      "intelStatus",
      "createdAt",
    ])
    .index("by_connection_and_created", ["agentConnectionId", "createdAt"]),

  // Derived, model-maintained workspace state: what the team is observed to be
  // doing. Separate from structured_context (project context); goal, decision
  // and ownership findings are also recorded there directly.
  context_entries: defineTable({
    workspaceId: v.id("workspaces"),
    // Stable per workspace, chosen by the context manager ("task:jwt-auth").
    key: v.string(),
    category: contextEntryCategory,
    title: v.string(),
    content: v.string(),
    status: contextEntryStatus,
    evidence: contextEvidence,
    // 0..1, the model's own estimate, clamped.
    confidence: v.number(),
    // Newest first, at most 20.
    evidenceEventIds: v.array(v.id("activity_events")),
    // The assistants the entry is about.
    agentConnectionIds: v.array(v.id("agent_connections")),
    fileIds: v.array(v.id("files")),
    // Coordination entries only.
    severity: v.optional(v.union(v.literal("potential"), v.literal("actual"))),
    supersededBy: v.optional(v.string()),
    // A goal, decision or ownership finding recorded in project context: the
    // structured_context entry id ("goal" for the goal).
    contextEntryId: v.optional(v.string()),
    // Why recording it in project context was refused (an error code); it
    // isn't tried again.
    contextSkipped: v.optional(v.string()),
    // Legacy (the removed proposal flow); contextMigrations.removeProposals clears them.
    proposalId: v.optional(v.id("context_proposals")),
    proposalSkipped: v.optional(v.string()),
    // Document digests (knowledge:doc-*) only: hash of the content the digest
    // was made from; an unchanged hash skips the model call.
    sourceHash: v.optional(v.string()),
    model: v.optional(v.string()),
    lastRunId: v.optional(v.id("context_intel_runs")),
    createdBy: actor,
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_key", ["workspaceId", "key"])
    .index("by_workspace_and_updated_at", ["workspaceId", "updatedAt"])
    .index("by_workspace_and_category_and_updated_at", [
      "workspaceId",
      "category",
      "updatedAt",
    ]),

  // Append-only history of context_entries: one row per revision.
  context_entry_revisions: defineTable({
    workspaceId: v.id("workspaces"),
    entryId: v.id("context_entries"),
    key: v.string(),
    revision: v.number(),
    change: v.union(
      v.literal("created"),
      v.literal("updated"),
      v.literal("status_changed"),
      v.literal("superseded"),
      v.literal("reopened"),
      v.literal("corrected"),
    ),
    category: contextEntryCategory,
    title: v.string(),
    content: v.string(),
    status: contextEntryStatus,
    evidence: contextEvidence,
    confidence: v.number(),
    // Why it changed: the model's one-line rationale, or a person's note.
    reason: v.string(),
    evidenceEventIds: v.array(v.id("activity_events")),
    runId: v.optional(v.id("context_intel_runs")),
    actor,
    createdAt: v.number(),
  })
    .index("by_entry_and_revision", ["entryId", "revision"])
    .index("by_workspace_and_created", ["workspaceId", "createdAt"]),

  // One row per context-manager batch, for history, provenance and recovery.
  context_intel_runs: defineTable({
    workspaceId: v.id("workspaces"),
    status: v.union(
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    method: v.union(v.literal("llm"), v.literal("heuristic")),
    model: v.optional(v.string()),
    eventIds: v.array(v.id("activity_events")),
    attempt: v.number(),
    // One line from the model about the batch, or why it was skipped.
    summary: v.optional(v.string()),
    // Short reason only, never a raw provider body.
    error: v.optional(v.string()),
    created: v.number(),
    updated: v.number(),
    // Project context changes the run recorded (goal, decisions, ownership).
    contextChanges: v.optional(v.number()),
    // Legacy: proposals the removed proposal flow raised.
    proposals: v.optional(v.number()),
    // Derived-context revision (context_intel_state.entriesRevision) after it.
    entriesRevision: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_workspace_and_started_at", ["workspaceId", "startedAt"]),

  // Per-workspace scheduler state for the context manager (one row each).
  context_intel_state: defineTable({
    workspaceId: v.id("workspaces"),
    status: v.union(v.literal("idle"), v.literal("scheduled"), v.literal("running")),
    scheduledFor: v.optional(v.number()),
    // A run that crashed without finishing is taken over after this.
    leaseExpiresAt: v.optional(v.number()),
    consecutiveFailures: v.number(),
    nextRetryAt: v.optional(v.number()),
    lastRunId: v.optional(v.id("context_intel_runs")),
    lastRunAt: v.optional(v.number()),
    // Bumped by every applied change to context_entries; sync reports it.
    entriesRevision: v.number(),
    // When the one-time read of the workspace's existing documents was queued.
    backfilledAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  outbox_events: defineTable({
    workspaceId: v.id("workspaces"),
    eventId: v.id("workspace_events"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_and_created", ["status", "createdAt"])
    .index("by_event", ["eventId"]),

  // Last cursor handed to each agent connection by sync_workspace. Clients
  // send their own cursor (`since`); this row is a server-side record of it.
  // Optional only for rows written before cursors were per connection.
  sync_cursors: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    client: v.string(),
    agentConnectionId: v.optional(v.id("agent_connections")),
    cursor: v.number(),
    updatedBy: actor,
    revision: v.number(),
    updatedAt: v.number(),
  }).index("by_agent_connection", ["agentConnectionId"]),

  storage_objects: defineTable({
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    fileId: v.optional(v.id("files")),
    fileName: v.string(),
    mimeType: v.string(),
    size: v.number(),
    uploadedBy: actor,
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_storage_id", ["storageId"]),
});
