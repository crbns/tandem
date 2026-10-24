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

const contextValue = v.object({
  text: v.string(),
  sourceFileIds: v.array(v.id("files")),
  updatedBy: actor,
  updatedAt: v.number(),
});

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
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    lastMcpActionAt: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
  })
    .index("by_workspace_and_user", ["workspaceId", "userId"])
    .index("by_user_and_client", ["userId", "client"]),

  folders: defineTable({
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
    createdBy: actor,
    updatedBy: actor,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_parent", ["workspaceId", "parentId"])
    .index("by_workspace", ["workspaceId"]),

  files: defineTable({
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
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
    .index("by_workspace_and_parent", ["workspaceId", "parentId"])
    .index("by_workspace", ["workspaceId"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["workspaceId", "parentId"],
    }),

  file_revisions: defineTable({
    workspaceId: v.id("workspaces"),
    fileId: v.id("files"),
    version: v.number(),
    content: v.string(),
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
    contextRevision: v.optional(v.number()),
    // Snapshot the scalar field a proposal is based on. Append-only fields do
    // not need a base value because separate proposals do not overwrite them.
    baseValue: v.optional(v.union(v.string(), v.null())),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("stale"),
    ),
    createdBy: actor,
    createdAt: v.number(),
    decidedBy: v.optional(actor),
    decidedAt: v.optional(v.number()),
    updatedBy: actor,
    revision: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_status", ["workspaceId", "status"])
    .index("by_workspace_and_created", ["workspaceId", "createdAt"]),

  approvals: defineTable({
    workspaceId: v.id("workspaces"),
    proposalId: v.id("context_proposals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    decidedBy: actor,
    decidedAt: v.number(),
  })
    .index("by_workspace_and_decided", ["workspaceId", "decidedAt"])
    .index("by_proposal", ["proposalId"]),

  workspace_events: defineTable({
    workspaceId: v.id("workspaces"),
    kind: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    summary: v.string(),
    actor,
    createdAt: v.number(),
  })
    .index("by_workspace_and_created", ["workspaceId", "createdAt"])
    .index("by_workspace_and_entity", [
      "workspaceId",
      "entityType",
      "entityId",
    ]),

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

  sync_cursors: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    client: v.string(),
    cursor: v.number(),
    updatedBy: actor,
    revision: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_user_client", ["workspaceId", "userId", "client"]),

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
