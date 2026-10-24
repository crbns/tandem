import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { normalizeContext } from "./lib/ops";
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
