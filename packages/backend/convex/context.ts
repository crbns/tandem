import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  humanActor,
  recordWorkspaceEvent,
  requireMembership,
} from "./lib/auth";

const fieldValidator = v.union(
  v.literal("goal"),
  v.literal("scope"),
  v.literal("constraint"),
  v.literal("decision"),
  v.literal("ownership"),
  v.literal("open_question"),
);

const proposalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

const proposalValidator = v.object({
  id: v.id("context_proposals"),
  workspaceId: v.id("workspaces"),
  field: fieldValidator,
  proposedValue: v.string(),
  rationale: v.string(),
  sourceFileIds: v.array(v.id("files")),
  status: proposalStatusValidator,
  createdBy: v.string(),
  createdAt: v.number(),
  decidedBy: v.union(v.string(), v.null()),
  decidedAt: v.union(v.number(), v.null()),
});

export const proposeContextChange = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    field: fieldValidator,
    proposedValue: v.string(),
    rationale: v.string(),
    sourceFileIds: v.array(v.id("files")),
  },
  returns: v.id("context_proposals"),
  handler: async (ctx, args) => {
    const { user } = await requireMembership(ctx, args.workspaceId);
    const actor = humanActor(user);
    for (const fileId of args.sourceFileIds) {
      const file = await ctx.db.get(fileId);
      if (!file || file.workspaceId !== args.workspaceId)
        throw new Error("INVALID_SOURCE_FILE");
    }
    const now = Date.now();
    const proposalId = await ctx.db.insert("context_proposals", {
      ...args,
      status: "pending",
      createdBy: actor,
      createdAt: now,
      updatedBy: actor,
      updatedAt: now,
      revision: 1,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: args.workspaceId,
      kind: "context.proposed",
      entityType: "context_proposal",
      entityId: proposalId,
      summary: `Proposed a change to ${args.field.replaceAll("_", " ")}`,
      actor,
    });
    return proposalId;
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
    const proposals = args.status
      ? await ctx.db
          .query("context_proposals")
          .withIndex("by_workspace_and_status", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("status", args.status!),
          )
          .order("desc")
          .take(100)
      : await ctx.db
          .query("context_proposals")
          .withIndex("by_workspace_and_created", (q) =>
            q.eq("workspaceId", args.workspaceId),
          )
          .order("desc")
          .take(100);
    return proposals.map((proposal) => ({
      id: proposal._id,
      workspaceId: proposal.workspaceId,
      field: proposal.field,
      proposedValue: proposal.proposedValue,
      rationale: proposal.rationale,
      sourceFileIds: proposal.sourceFileIds,
      status: proposal.status,
      createdBy: proposal.createdBy.label,
      createdAt: proposal.createdAt,
      decidedBy: proposal.decidedBy?.label ?? null,
      decidedAt: proposal.decidedAt ?? null,
    }));
  },
});

export const decideContextProposal = mutation({
  args: {
    proposalId: v.id("context_proposals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  returns: v.null(),
  handler: async (ctx, { proposalId, decision }) => {
    const proposal = await ctx.db.get(proposalId);
    if (!proposal) throw new Error("PROPOSAL_NOT_FOUND");
    const { user, membership } = await requireMembership(
      ctx,
      proposal.workspaceId,
    );
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new Error("FORBIDDEN");
    if (proposal.status !== "pending")
      throw new Error("PROPOSAL_ALREADY_DECIDED");
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
    return null;
  },
});

async function applyApprovedProposal(
  ctx: MutationCtx,
  proposal: {
    workspaceId: Id<"workspaces">;
    field:
      | "goal"
      | "scope"
      | "constraint"
      | "decision"
      | "ownership"
      | "open_question";
    proposedValue: string;
    sourceFileIds: Id<"files">[];
  },
  actor: ReturnType<typeof humanActor>,
  now: number,
) {
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", proposal.workspaceId))
    .unique();
  if (!context) throw new Error("CONTEXT_NOT_INITIALIZED");
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
        constraints: [...context.constraints, value],
      });
      break;
    case "decision":
      await ctx.db.patch(context._id, {
        ...next,
        decisions: [...context.decisions, value],
      });
      break;
    case "ownership":
      await ctx.db.patch(context._id, {
        ...next,
        ownership: [...context.ownership, value],
      });
      break;
    case "open_question":
      await ctx.db.patch(context._id, {
        ...next,
        openQuestions: [...context.openQuestions, value],
      });
      break;
  }
}
