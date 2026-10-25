import { v } from "convex/values";

export const actorValidator = v.object({
  type: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
  userId: v.optional(v.id("users")),
  agentConnectionId: v.optional(v.id("agent_connections")),
  label: v.string(),
  client: v.optional(v.string()),
  userName: v.optional(v.string()),
});

export const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);

export const fileMetadataValidator = v.object({
  id: v.id("files"),
  workspaceId: v.id("workspaces"),
  parentId: v.union(v.id("folders"), v.null()),
  name: v.string(),
  mimeType: v.string(),
  version: v.number(),
  updatedAt: v.number(),
  updatedBy: actorValidator,
});

export const contextFieldValidator = v.union(
  v.literal("goal"),
  v.literal("scope"),
  v.literal("constraint"),
  v.literal("decision"),
  v.literal("ownership"),
  v.literal("open_question"),
);

export const contextApprovalValidator = v.union(
  v.literal("manual"),
  v.literal("automatic"),
);

export const proposalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("applied"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("stale"),
);

export const resolutionValidator = v.union(
  v.literal("accepted"),
  v.literal("kept_both"),
  v.literal("retained_current"),
  v.literal("rejected"),
);

/** context_proposals.conflict (docs/conflict-resolution.md). */
export const conflictValidator = v.object({
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
  items: v.array(
    v.object({
      kind: v.union(v.literal("replaces"), v.literal("contradicts"), v.literal("competing")),
      uncertain: v.optional(v.boolean()),
      targetType: v.union(
        v.literal("decision"),
        v.literal("constraint"),
        v.literal("goal"),
        v.literal("scope"),
        v.literal("proposal"),
      ),
      targetId: v.string(),
      targetText: v.string(),
      targetBy: actorValidator,
      targetAt: v.number(),
      contextVersion: v.number(),
      explanation: v.string(),
      confidence: v.optional(v.number()),
    }),
  ),
});

export const proposalValidator = v.object({
  id: v.id("context_proposals"),
  workspaceId: v.id("workspaces"),
  field: contextFieldValidator,
  operation: v.union(v.literal("add"), v.literal("resolve"), v.literal("remove")),
  proposedValue: v.string(),
  supersedes: v.union(v.string(), v.null()),
  rationale: v.string(),
  sourceFileIds: v.array(v.id("files")),
  status: proposalStatusValidator,
  createdBy: actorValidator,
  createdAt: v.number(),
  decidedBy: v.union(actorValidator, v.null()),
  decidedAt: v.union(v.number(), v.null()),
  /** Ownership proposals: the proposed owner (a workspace member) and area. */
  ownerUserId: v.union(v.id("users"), v.null()),
  ownerArea: v.union(v.string(), v.null()),
  /** Null when no conflict check ran (goal/scope without rivals, questions, resolves). */
  conflict: v.union(conflictValidator, v.null()),
  resolution: v.union(resolutionValidator, v.null()),
  decisionNote: v.union(v.string(), v.null()),
  /** Pass as expectedRevision to decideContextProposal. */
  revision: v.number(),
});

const contextEntryValidator = v.object({
  id: v.string(),
  status: v.union(
    v.literal("active"),
    v.literal("resolved"),
    v.literal("superseded"),
  ),
  resolvedBy: v.union(actorValidator, v.null()),
  resolvedAt: v.union(v.number(), v.null()),
  supersededBy: v.union(v.string(), v.null()),
  text: v.string(),
  sourceFileIds: v.array(v.id("files")),
  updatedAt: v.number(),
  updatedBy: actorValidator,
});

/** Null owner fields only on ownership entries approved before owners were structured. */
const ownershipEntryValidator = contextEntryValidator.extend({
  ownerUserId: v.union(v.id("users"), v.null()),
  ownerArea: v.union(v.string(), v.null()),
});

export const contextValidator = v.object({
  goal: v.union(contextEntryValidator, v.null()),
  scope: v.union(contextEntryValidator, v.null()),
  constraints: v.array(contextEntryValidator),
  decisions: v.array(contextEntryValidator),
  ownership: v.array(ownershipEntryValidator),
  openQuestions: v.array(contextEntryValidator),
  revision: v.number(),
  updatedAt: v.number(),
  updatedBy: actorValidator,
});

export const eventValidator = v.object({
  id: v.id("workspace_events"),
  seq: v.number(),
  kind: v.string(),
  entityType: v.string(),
  entityId: v.string(),
  summary: v.string(),
  actor: actorValidator,
  createdAt: v.number(),
});

export const taskStatusValidator = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("done"),
);

/** lib/ops.ts toTask; also the dashboard's tasks:listTasks row. */
export const taskValidator = v.object({
  id: v.id("tasks"),
  title: v.string(),
  description: v.string(),
  status: taskStatusValidator,
  ownerId: v.union(v.id("users"), v.null()),
  ownerName: v.union(v.string(), v.null()),
  version: v.number(),
  createdBy: actorValidator,
  updatedBy: actorValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.union(v.number(), v.null()),
});

export const publishedWorkValidator = v.object({
  id: v.id("published_work"),
  workspaceId: v.id("workspaces"),
  kind: v.union(v.literal("deliverable"), v.literal("finding")),
  title: v.string(),
  summary: v.string(),
  fileIds: v.array(v.id("files")),
  createdBy: actorValidator,
  createdAt: v.number(),
});
