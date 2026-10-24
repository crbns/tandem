import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  humanActor,
  recordWorkspaceEvent,
  requireHumanSession,
  requireMembership,
} from "./lib/auth";
import {
  checkSourceFiles,
  listProposals,
  loadContext,
  toPublishedWork,
  proposeContextChangeCore,
  applyApprovedProposal,
  normalizeContext,
  toProposal,
} from "./lib/ops";
import {
  contextFieldValidator as fieldValidator,
  proposalStatusValidator,
  proposalValidator,
  contextValidator,
  publishedWorkValidator,
} from "./lib/validators";

/** Full context, including per-entry attribution and ownership metadata. */
export const getDetails = query({
  args: { workspaceId: v.id("workspaces") },
  returns: contextValidator,
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    return loadContext(ctx, workspaceId);
  },
});

export const listPublishedWork = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(publishedWorkValidator),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.workspaceId);
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      throw new ConvexError({ code: "INVALID_INPUT" });
    const result = await ctx.db
      .query("published_work")
      .withIndex("by_workspace_and_created", (q) =>
        q.eq("workspaceId", args.workspaceId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(toPublishedWork) };
  },
});

/** Human owner/admin edits are decisions; no pending proposal is created. */
export const updateContextField = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    field: fieldValidator,
    proposedValue: v.string(),
    sourceFileIds: v.array(v.id("files")),
    expectedVersion: v.number(),
    ownerUserId: v.optional(v.id("users")),
    entryId: v.optional(v.string()),
    // Kept for existing dashboard clients; revision guards positional edits.
    entryIndex: v.optional(v.number()),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    await requireHumanSession(ctx);
    const { user, membership } = await requireMembership(ctx, args.workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    const context = await ctx.db
      .query("structured_context")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (!context) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
    if (args.expectedVersion !== context.revision)
      throw new ConvexError({
        code: "VERSION_CONFLICT",
        currentVersion: context.revision,
      });
    const text = args.proposedValue.trim();
    if (
      !text ||
      text.length > 10000 ||
      (args.field === "ownership" && text.length > 200)
    )
      throw new ConvexError({ code: "INVALID_INPUT" });
    if (args.field !== "ownership" && args.ownerUserId !== undefined)
      throw new ConvexError({ code: "INVALID_INPUT", field: "ownerUserId" });
    const listKey = {
      constraint: "constraints",
      decision: "decisions",
      ownership: "ownership",
      open_question: "openQuestions",
    } as const;
    const key =
      args.field === "goal" || args.field === "scope"
        ? null
        : listKey[args.field];
    if (
      args.entryIndex !== undefined &&
      (!key ||
        !Number.isInteger(args.entryIndex) ||
        args.entryIndex < 0 ||
        args.entryIndex >= context[key].length)
    )
      throw new ConvexError({ code: "INVALID_INPUT", field: "entryIndex" });
    let entryIndex = args.entryIndex;
    if (args.entryId !== undefined) {
      if (!key || entryIndex !== undefined)
        throw new ConvexError({ code: "INVALID_INPUT", field: "entryId" });
      entryIndex = normalizeContext(context)[key].findIndex(
        (e) => e.id === args.entryId,
      );
      if (entryIndex < 0)
        throw new ConvexError({ code: "INVALID_INPUT", field: "entryId" });
    }
    if (key && entryIndex !== undefined) {
      const target = context[key][entryIndex];
      if (target?.status && target.status !== "active")
        throw new ConvexError({
          code: "INVALID_INPUT",
          field: "entryId",
          message: "Historical entries cannot be edited",
        });
    }
    const sourceFileIds = await checkSourceFiles(
      ctx,
      args.workspaceId,
      args.sourceFileIds,
    );
    const actor = humanActor(user);
    await applyApprovedProposal(
      ctx,
      {
        workspaceId: args.workspaceId,
        field: args.field,
        proposedValue: text,
        sourceFileIds,
        ...(args.field === "ownership"
          ? { ownerUserId: args.ownerUserId, ownerArea: text }
          : {}),
      },
      actor,
      Date.now(),
      entryIndex,
    );
    await recordWorkspaceEvent(ctx, {
      workspaceId: args.workspaceId,
      kind: "context.updated",
      entityType: "structured_context",
      entityId: context._id,
      summary: `Updated ${args.field.replaceAll("_", " ")}`,
      actor,
    });
    return { version: context.revision + 1 };
  },
});

export const proposeContextChange = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    operation: v.optional(
      v.union(v.literal("add"), v.literal("resolve"), v.literal("remove")),
    ),
    entryId: v.optional(v.string()),
    supersedes: v.optional(v.string()),
    expectedVersion: v.optional(v.number()),
    field: fieldValidator,
    proposedValue: v.optional(v.string()),
    rationale: v.string(),
    sourceFileIds: v.array(v.id("files")),
    /** Required for ownership (proposedValue is then the area); else omitted. */
    ownerUserId: v.optional(v.id("users")),
  },
  returns: v.object({
    id: v.id("context_proposals"),
    status: v.union(v.literal("applied"), v.literal("pending")),
  }),
  handler: async (ctx, args) => {
    const { user } = await requireMembership(ctx, args.workspaceId);
    const sourceFileIds = await checkSourceFiles(
      ctx,
      args.workspaceId,
      args.sourceFileIds,
    );
    const proposal = await proposeContextChangeCore(ctx, {
      ...args,
      sourceFileIds,
      actor: humanActor(user),
    });
    return {
      id: proposal._id,
      status: proposal.status as "applied" | "pending",
    };
  },
});

export const getApprovals = query({
  args: {
    workspaceId: v.id("workspaces"),
    status: v.optional(proposalStatusValidator),
  },
  returns: v.array(proposalValidator),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.workspaceId);
    const proposals = await listProposals(
      ctx,
      args.workspaceId,
      args.status,
      100,
    );
    return proposals.map(toProposal);
  },
});

export const decideContextProposal = mutation({
  args: {
    proposalId: v.id("context_proposals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  returns: v.null(),
  handler: async (ctx, { proposalId, decision }) => {
    // Human-only, whichever way the decision goes: agent-bound identities
    // are rejected here, not just left out of the MCP tool list. Checked
    // before the load so callers can't probe which proposal ids exist.
    await requireHumanSession(ctx);
    const proposal = await ctx.db.get(proposalId);
    if (!proposal) throw new ConvexError({ code: "PROPOSAL_NOT_FOUND" });
    const { user, membership } = await requireMembership(
      ctx,
      proposal.workspaceId,
    );
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    await decideProposalCore(ctx, proposal, decision, user);
    return null;
  },
});

/**
 * Records a decision by `user`, who the caller has verified is a human owner
 * or admin of the proposal's workspace. A stale approval marks the proposal
 * stale instead of applying it.
 */
export async function decideProposalCore(
  ctx: MutationCtx,
  proposal: Doc<"context_proposals">,
  decision: "approved" | "rejected",
  user: Doc<"users">,
): Promise<void> {
  const proposalId = proposal._id;
  if (proposal.status !== "pending")
    throw new ConvexError({ code: "PROPOSAL_ALREADY_DECIDED" });
  if (decision === "approved") {
    const context = await ctx.db
      .query("structured_context")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", proposal.workspaceId),
      )
      .unique();
    if (!context) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
    const currentField =
      proposal.field === "goal"
        ? (context.goal?.text ?? null)
        : proposal.field === "scope"
          ? (context.scope?.text ?? null)
          : undefined;
    const supersededTarget = proposal.supersedes
      ? normalizeContext(context).decisions.find(
          (e) => e.id === proposal.supersedes,
        )
      : null;
    const stale =
      (proposal.supersedes !== undefined &&
        (!supersededTarget ||
          (supersededTarget.status !== undefined &&
            supersededTarget.status !== "active"))) ||
      proposal.contextRevision === undefined ||
      (currentField !== undefined &&
        (proposal.baseValue === undefined
          ? context.revision !== proposal.contextRevision
          : currentField !== proposal.baseValue));
    if (stale) {
      const now = Date.now();
      await ctx.db.patch(proposalId, {
        status: "stale",
        updatedBy: humanActor(user),
        updatedAt: now,
        revision: proposal.revision + 1,
      });
      await recordWorkspaceEvent(ctx, {
        workspaceId: proposal.workspaceId,
        kind: "context.stale",
        entityType: "context_proposal",
        entityId: proposalId,
        summary: `Marked ${proposal.field.replaceAll("_", " ")} proposal stale`,
        actor: humanActor(user),
      });
      return;
    }
  }
  const actor = humanActor(user);
  const now = Date.now();
  await ctx.db.patch(proposalId, {
    status: decision,
    decidedBy: actor,
    decidedAt: now,
    updatedBy: actor,
    updatedAt: now,
    revision: proposal.revision + 1,
  });
  await ctx.db.insert("approvals", {
    workspaceId: proposal.workspaceId,
    proposalId,
    decision,
    decidedBy: actor,
    decidedAt: now,
  });
  if (decision === "approved")
    await applyApprovedProposal(ctx, proposal, actor, now);
  await recordWorkspaceEvent(ctx, {
    workspaceId: proposal.workspaceId,
    kind: `context.${decision}`,
    entityType: "context_proposal",
    entityId: proposalId,
    summary: `${decision === "approved" ? "Approved" : "Rejected"} ${proposal.field.replaceAll("_", " ")} change`,
    actor,
  });
}
