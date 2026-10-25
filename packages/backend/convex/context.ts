import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
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
  entryTargetMissing,
  normalizeContext,
  toProposal,
} from "./lib/ops";
import {
  conflictSummary,
  retargetCompeting,
  type Resolution,
} from "./lib/conflicts";
import {
  contextFieldValidator as fieldValidator,
  proposalStatusValidator,
  proposalValidator,
  contextValidator,
  publishedWorkValidator,
  resolutionValidator,
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
      key === null
        ? context[args.field as "goal" | "scope"]?.sourceFileIds
        : entryIndex !== undefined
          ? context[key][entryIndex]?.sourceFileIds
          : undefined,
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
    const proposal = await proposeContextChangeCore(ctx, {
      ...args,
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

/**
 * Conflicts for the Approvals page: pending proposals a check holds (or is
 * still checking), and the newest 50 decided proposals that had a conflict.
 */
export const listConflicts = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    pending: v.array(proposalValidator),
    resolved: v.array(proposalValidator),
  }),
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    const pending = (await listProposals(ctx, workspaceId, "pending", 100)).filter(
      (p) => p.conflict !== undefined && p.conflict.status !== "clear",
    );
    const resolved = (
      await ctx.db
        .query("context_proposals")
        .withIndex("by_workspace_and_has_conflict_and_created", (q) =>
          q.eq("workspaceId", workspaceId).eq("hasConflict", true),
        )
        .order("desc")
        .take(200)
    )
      .filter((p) => p.status === "approved" || p.status === "rejected")
      .slice(0, 50);
    return { pending: pending.map(toProposal), resolved: resolved.map(toProposal) };
  },
});

export const decideContextProposal = mutation({
  args: {
    proposalId: v.id("context_proposals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    /** How a conflict was settled; defaults to accepted or rejected. */
    resolution: v.optional(resolutionValidator),
    note: v.optional(v.string()),
    /** The proposal revision the person saw; PROPOSAL_CHANGED if it moved. */
    expectedRevision: v.optional(v.number()),
    /**
     * Accepted only: the conflict targets to supersede. Defaults to those the
     * check is sure about, never ones it was unsure about.
     */
    supersede: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, { proposalId, decision, ...options }) => {
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
    await decideProposalCore(ctx, proposal, decision, user, options);
    return null;
  },
});

/**
 * Runs the conflict check again for a proposal still "checking", for when
 * the scheduled check failed. A no-op once the verdict is in, and safe to
 * repeat: the first verdict recorded wins.
 */
export const recheckConflict = mutation({
  args: { proposalId: v.id("context_proposals") },
  returns: v.null(),
  handler: async (ctx, { proposalId }) => {
    await requireHumanSession(ctx);
    const proposal = await ctx.db.get(proposalId);
    if (!proposal) throw new ConvexError({ code: "PROPOSAL_NOT_FOUND" });
    const { membership } = await requireMembership(ctx, proposal.workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    if (proposal.status === "pending" && proposal.conflict?.status === "checking")
      await ctx.scheduler.runAfter(0, internal.conflicts.checkProposal, { proposalId });
    return null;
  },
});

const MAX_NOTE_LENGTH = 2000;

/**
 * Records a decision by `user`, who the caller has verified is a human owner
 * or admin of the proposal's workspace. A stale approval marks the proposal
 * stale instead of applying it. For a conflict, `resolution` says how it was
 * settled: accepted supersedes the entries it replaces or contradicts,
 * kept_both adds it alongside them, and retained_current or rejected change
 * nothing.
 */
export async function decideProposalCore(
  ctx: MutationCtx,
  proposal: Doc<"context_proposals">,
  decision: "approved" | "rejected",
  user: Doc<"users">,
  options: {
    resolution?: Resolution;
    note?: string;
    expectedRevision?: number;
    supersede?: string[];
  } = {},
): Promise<void> {
  const proposalId = proposal._id;
  if (proposal.status !== "pending")
    throw new ConvexError({ code: "PROPOSAL_ALREADY_DECIDED" });
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== proposal.revision
  )
    throw new ConvexError({
      code: "PROPOSAL_CHANGED",
      currentRevision: proposal.revision,
      expectedRevision: options.expectedRevision,
    });
  // Approving before the verdict would decide without the conflict in view
  // (and drop the verdict). Rejecting changes nothing, so it can go ahead.
  if (decision === "approved" && proposal.conflict?.status === "checking")
    throw new ConvexError({ code: "CONFLICT_CHECK_PENDING" });
  // A conflict whose items were all cleared (its rival was rejected) is
  // decided like any other proposal.
  const items = proposal.conflict?.items ?? [];
  const scalar = proposal.field === "goal" || proposal.field === "scope";
  let resolution =
    options.resolution ??
    (items.length > 0 ? (decision === "approved" ? "accepted" : "rejected") : undefined);
  if (
    (resolution !== undefined &&
      (decision === "approved") !== (resolution === "accepted" || resolution === "kept_both")) ||
    // A goal or scope has one value: approving replaces it.
    (resolution === "kept_both" && scalar)
  )
    throw new ConvexError({ code: "INVALID_INPUT", field: "resolution" });
  const note = options.note?.trim() || undefined;
  if (note !== undefined && note.length > MAX_NOTE_LENGTH)
    throw new ConvexError({ code: "INVALID_INPUT", field: "note" });
  // Accepting supersedes the entries the conflict is sure about, or the ones
  // the person picked; never one the check was only unsure about by default.
  const targets = items.filter(
    (i) =>
      (i.kind === "replaces" || i.kind === "contradicts") &&
      (i.targetType === "decision" || i.targetType === "constraint"),
  );
  if (
    options.supersede !== undefined &&
    (resolution !== "accepted" ||
      options.supersede.some((id) => !targets.some((i) => i.targetId === id)))
  )
    throw new ConvexError({ code: "INVALID_INPUT", field: "supersede" });
  const supersedeIds =
    resolution !== "accepted"
      ? []
      : (options.supersede ?? targets.filter((i) => !i.uncertain).map((i) => i.targetId));
  // Accepting over entries it supersedes none of is keeping both.
  if (
    resolution === "accepted" && targets.length > 0 &&
    supersedeIds.length === 0 && proposal.supersedes === undefined
  )
    resolution = "kept_both";
  // Keeping both is a plain addition, so it supersedes nothing.
  const applied =
    resolution === "kept_both" ? { ...proposal, supersedes: undefined } : proposal;
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
    const supersededTarget = applied.supersedes
      ? normalizeContext(context).decisions.find(
          (e) => e.id === applied.supersedes,
        )
      : null;
    const stale =
      entryTargetMissing(context, proposal) ||
      (applied.supersedes !== undefined &&
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
  const appliedEntryId =
    decision === "approved"
      ? await applyApprovedProposal(ctx, applied, actor, now, undefined, supersedeIds)
      : undefined;
  await ctx.db.patch(proposalId, {
    status: decision,
    decidedBy: actor,
    decidedAt: now,
    updatedBy: actor,
    updatedAt: now,
    revision: proposal.revision + 1,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(note !== undefined ? { decisionNote: note } : {}),
    ...(appliedEntryId !== undefined ? { appliedEntryId } : {}),
  });
  await ctx.db.insert("approvals", {
    workspaceId: proposal.workspaceId,
    proposalId,
    decision,
    decidedBy: actor,
    decidedAt: now,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  await retargetCompeting(
    ctx,
    proposal,
    decision,
    appliedEntryId,
    actor,
    now,
  );
  await recordWorkspaceEvent(ctx, {
    workspaceId: proposal.workspaceId,
    kind: `context.${decision}`,
    entityType: "context_proposal",
    entityId: proposalId,
    summary: `${decision === "approved" ? "Approved" : "Rejected"} ${proposal.field.replaceAll("_", " ")} change`,
    actor,
  });
  if (items.length > 0 && resolution !== undefined)
    await recordWorkspaceEvent(ctx, {
      workspaceId: proposal.workspaceId,
      kind: "context.conflict_resolved",
      entityType: "context_proposal",
      entityId: proposalId,
      summary: conflictSummary(proposal, resolution),
      actor,
    });
}
