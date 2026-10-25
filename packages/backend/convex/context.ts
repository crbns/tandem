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
  entryTargetMissing,
  normalizeContext,
  toProposal,
  conflictStatus,
  truncate,
  type ConflictItem,
  type Resolution,
} from "./lib/ops";
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

const MAX_NOTE_LENGTH = 2000;

/** What the resolver chose when there was a conflict (docs/conflict-resolution.md). */
function conflictSummary(
  proposal: Doc<"context_proposals">,
  resolution: Resolution,
): string {
  const quote = (text: string) => `"${truncate(text, 60)}"`;
  const proposed = quote(proposal.proposedValue);
  const target = proposal.conflict?.items[0];
  const current = target ? quote(target.targetText) : "the current value";
  switch (resolution) {
    case "accepted":
      return `Accepted ${proposed} over ${current}`;
    case "kept_both":
      return `Kept both ${proposed} and ${current}`;
    case "retained_current":
      return `Kept ${current} over ${proposed}`;
    case "rejected":
      return `Rejected ${proposed}`;
  }
}

/**
 * Pending proposals that competed with `decided`: on approval they now
 * contradict the entry it added; on rejection the item is dropped, and a
 * proposal with no items left is clear (it still waits for a person, even in
 * an automatic workspace).
 */
async function retargetCompeting(
  ctx: MutationCtx,
  decided: Doc<"context_proposals">,
  decision: "approved" | "rejected",
  approvedEntryId: string | undefined,
  actor: Doc<"context_proposals">["updatedBy"],
  now: number,
) {
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", decided.workspaceId))
    .unique();
  const pending = await listProposals(ctx, decided.workspaceId, "pending", 100);
  for (const other of pending) {
    const conflict = other.conflict;
    if (!conflict?.items.some((i) => i.kind === "competing" && i.targetId === decided._id))
      continue;
    const targetType: ConflictItem["targetType"] =
      decided.field === "goal" || decided.field === "scope"
        ? decided.field
        : decided.field === "constraint"
          ? "constraint"
          : "decision";
    const scalar = targetType === "goal" || targetType === "scope";
    const items = conflict.items.flatMap((i): ConflictItem[] => {
      if (i.kind !== "competing" || i.targetId !== decided._id) return [i];
      if (decision === "rejected" || (!scalar && approvedEntryId === undefined))
        return [];
      return [{
        ...i,
        kind: "contradicts",
        targetType,
        targetId: scalar ? targetType : approvedEntryId!,
        targetAt: now,
        contextVersion: context?.revision ?? i.contextVersion,
      }];
    });
    await ctx.db.patch(other._id, {
      conflict: {
        ...conflict,
        items,
        status: conflict.status === "checking" ? "checking" : conflictStatus(items),
      },
      updatedBy: actor,
      updatedAt: now,
      revision: other.revision + 1,
    });
  }
}

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
  options: { resolution?: Resolution; note?: string; expectedRevision?: number } = {},
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
  const resolution =
    options.resolution ??
    (proposal.hasConflict ? (decision === "approved" ? "accepted" : "rejected") : undefined);
  if (
    resolution !== undefined &&
    (decision === "approved") !== (resolution === "accepted" || resolution === "kept_both")
  )
    throw new ConvexError({ code: "INVALID_INPUT", field: "resolution" });
  const note = options.note?.trim() || undefined;
  if (note !== undefined && note.length > MAX_NOTE_LENGTH)
    throw new ConvexError({ code: "INVALID_INPUT", field: "note" });
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
  // Accepting over a conflict supersedes what it replaces or contradicts;
  // targets that are no longer active are left alone.
  const supersedeIds =
    resolution === "accepted"
      ? (proposal.conflict?.items ?? [])
          .filter(
            (i) =>
              (i.kind === "replaces" || i.kind === "contradicts") &&
              (i.targetType === "decision" || i.targetType === "constraint"),
          )
          .map((i) => i.targetId)
      : [];
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
  if (proposal.hasConflict && resolution !== undefined)
    await recordWorkspaceEvent(ctx, {
      workspaceId: proposal.workspaceId,
      kind: "context.conflict_resolved",
      entityType: "context_proposal",
      entityId: proposalId,
      summary: conflictSummary(proposal, resolution),
      actor,
    });
}
