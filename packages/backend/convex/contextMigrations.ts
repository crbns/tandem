import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { changeContextCore, normalizeContext } from "./lib/ops";
import { recordWorkspaceEvent } from "./lib/auth";

/**
 * Widen → backfill. Run with {paginationOpts:{cursor:null,numItems:50}},
 * then repeat with continueCursor until isDone. IDs intentionally stay optional
 * in storage so older snapshots/seeds remain readable; all new list writes have IDs.
 */
export const backfillEntryIds = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    migrated: v.number(),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const page = await ctx.db
      .query("structured_context")
      .paginate(paginationOpts);
    let migrated = 0;
    for (const row of page.page) {
      if (
        [
          ...row.constraints,
          ...row.decisions,
          ...row.ownership,
          ...row.openQuestions,
        ].every((e) => e.id)
      )
        continue;
      const normalized = normalizeContext(row);
      const actor = {
        type: "system" as const,
        label: "Context entry ID migration",
      };
      await ctx.db.patch(row._id, {
        constraints: normalized.constraints,
        decisions: normalized.decisions,
        ownership: normalized.ownership,
        openQuestions: normalized.openQuestions,
        revision: row.revision + 1,
        updatedBy: actor,
        updatedAt: Date.now(),
      });
      await recordWorkspaceEvent(ctx, {
        workspaceId: row.workspaceId,
        kind: "context.migrated",
        entityType: "structured_context",
        entityId: row._id,
        summary: "Assigned stable context entry IDs",
        actor,
      });
      migrated++;
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      migrated,
    };
  },
});

/**
 * Applies one legacy pending proposal as its creator, the way every context
 * change applies now. A nested mutation, so a change that no longer fits
 * (its entry or owner is gone) rolls back alone and the migration goes on.
 */
export const applyPendingProposal = internalMutation({
  args: { proposalId: v.id("context_proposals") },
  returns: v.boolean(),
  handler: async (ctx, { proposalId }) => {
    const p = await ctx.db.get(proposalId);
    if (!p || p.status !== "pending") return false;
    const result = await changeContextCore(ctx, {
      workspaceId: p.workspaceId,
      field: p.field,
      ...(p.operation
        ? { operation: p.operation, entryId: p.entryId }
        : { value: p.ownerArea ?? p.proposedValue }),
      ...(p.ownerUserId !== undefined && !p.operation ? { ownerUserId: p.ownerUserId } : {}),
      ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
      sourceFileIds: p.sourceFileIds,
      actor: p.createdBy,
    });
    return !result.deduplicated;
  },
});

/**
 * Empties what the removed proposal flow left behind, one table per call:
 * "context_proposals" rows still pending are applied first (applyPendingProposal),
 * then they and "approvals" rows are deleted, "context_entries"
 * proposal links become contextSkipped (so the context manager doesn't record
 * an already-proposed finding again), and "workspaces" lose contextApproval.
 * Run each table with {table, paginationOpts:{cursor:null,numItems:100}},
 * repeating with continueCursor until isDone; then the legacy schema can go.
 */
export const removeProposals = internalMutation({
  args: {
    table: v.union(
      v.literal("context_proposals"),
      v.literal("approvals"),
      v.literal("context_entries"),
      v.literal("workspaces"),
    ),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    migrated: v.number(),
    /** Pending proposals applied to project context before deletion. */
    applied: v.number(),
  }),
  handler: async (ctx, { table, paginationOpts }) => {
    let migrated = 0;
    let applied = 0;
    const done = (page: { continueCursor: string; isDone: boolean }) => ({
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      migrated,
      applied,
    });
    if (table === "context_proposals" || table === "approvals") {
      const page = await ctx.db.query(table).paginate(paginationOpts);
      for (const row of page.page) {
        if (table === "context_proposals" && "status" in row && row.status === "pending") {
          try {
            if (await ctx.runMutation(internal.contextMigrations.applyPendingProposal, { proposalId: row._id }))
              applied++;
          } catch {
            // No longer applicable (a removed entry, an owner who left): dropped.
          }
        }
        await ctx.db.delete(row._id);
        migrated++;
      }
      return done(page);
    }
    if (table === "context_entries") {
      const page = await ctx.db.query("context_entries").paginate(paginationOpts);
      for (const row of page.page) {
        if (row.proposalId === undefined && row.proposalSkipped === undefined) continue;
        await ctx.db.patch(row._id, {
          proposalId: undefined,
          proposalSkipped: undefined,
          ...(row.contextEntryId === undefined && row.contextSkipped === undefined
            ? { contextSkipped: row.proposalSkipped ?? "PROPOSED" }
            : {}),
        });
        migrated++;
      }
      return done(page);
    }
    const page = await ctx.db.query("workspaces").paginate(paginationOpts);
    for (const row of page.page) {
      if (row.contextApproval === undefined) continue;
      await ctx.db.patch(row._id, { contextApproval: undefined });
      migrated++;
    }
    return done(page);
  },
});
