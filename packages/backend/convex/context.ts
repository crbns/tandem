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
  proposeContextChangeCore,
  ownershipText,
  requireOwnerMember,
  toProposal,
} from "./lib/ops";
import {
  contextFieldValidator as fieldValidator,
  proposalStatusValidator,
  proposalValidator,
} from "./lib/validators";

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
        return null;
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
    return null;
  },
});

async function applyApprovedProposal(
  ctx: MutationCtx,
  proposal: Doc<"context_proposals">,
  actor: ReturnType<typeof humanActor>,
  now: number,
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
            (entry) =>
              entry.ownerArea === undefined || nameKey(entry.ownerArea) !== area,
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
        openQuestions: [...context.openQuestions, value],
      });
      break;
  }
}
