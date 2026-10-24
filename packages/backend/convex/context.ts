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
import { nameKey } from "./lib/names";
import {
  checkSourceFiles,
  listProposals,
  loadContext,
  toPublishedWork,
  proposeContextChangeCore,
  ownershipText,
  requireOwnerMember,
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
    // Until entries have stable IDs, the revision guards positional edits.
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
      args.entryIndex,
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
    field: fieldValidator,
    proposedValue: v.string(),
    rationale: v.string(),
    sourceFileIds: v.array(v.id("files")),
    /** Required for ownership (proposedValue is then the area); else omitted. */
    ownerUserId: v.optional(v.id("users")),
  },
  returns: v.id("context_proposals"),
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
    return proposal._id;
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
    const stale =
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

async function applyApprovedProposal(
  ctx: MutationCtx,
  proposal: Pick<
    Doc<"context_proposals">,
    | "workspaceId"
    | "field"
    | "proposedValue"
    | "sourceFileIds"
    | "ownerUserId"
    | "ownerArea"
  >,
  actor: ReturnType<typeof humanActor>,
  now: number,
  entryIndex?: number,
) {
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", proposal.workspaceId))
    .unique();
  if (!context) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
  const value = {
    text: proposal.proposedValue,
    sourceFileIds: proposal.sourceFileIds,
    updatedBy: actor,
    updatedAt: now,
  };
  const next = {
    revision: context.revision + 1,
    updatedAt: now,
    updatedBy: actor,
  };
  const put = <T>(entries: T[], entry: T) =>
    entryIndex === undefined
      ? [...entries, entry]
      : entries.map((old, index) => (index === entryIndex ? entry : old));
  switch (proposal.field) {
    case "goal":
      await ctx.db.patch(context._id, { ...next, goal: value });
      break;
    case "scope":
      await ctx.db.patch(context._id, { ...next, scope: value });
      break;
    case "constraint":
      await ctx.db.patch(context._id, {
        ...next,
        constraints: put(context.constraints, value),
      });
      break;
    case "decision":
      await ctx.db.patch(context._id, {
        ...next,
        decisions: put(context.decisions, value),
      });
      break;
    case "ownership": {
      // Re-checked on approval: the owner may have left since the proposal.
      // Legacy free-text proposals have no owner to check and can't be approved.
      if (!proposal.ownerUserId || !proposal.ownerArea)
        throw new ConvexError({ code: "INVALID_INPUT", field: "ownerUserId" });
      const owner = await requireOwnerMember(
        ctx,
        proposal.workspaceId,
        proposal.ownerUserId,
      );
      // One owner per area: approval replaces the owner of an equal area.
      const area = nameKey(proposal.ownerArea);
      await ctx.db.patch(context._id, {
        ...next,
        ownership: [
          ...context.ownership.filter(
            (entry, index) =>
              index !== entryIndex &&
              (entry.ownerArea === undefined ||
                nameKey(entry.ownerArea) !== area),
          ),
          {
            ...value,
            text: ownershipText(proposal.ownerArea, owner),
            ownerUserId: owner._id,
            ownerArea: proposal.ownerArea,
          },
        ],
      });
      break;
    }
    case "open_question":
      await ctx.db.patch(context._id, {
        ...next,
        openQuestions: put(context.openQuestions, value),
      });
      break;
  }
}
