import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  humanActor,
  recordWorkspaceEvent,
  requireHumanSession,
  requireMembership,
} from "./lib/auth";
import {
  applyContextChange,
  changeContextCore,
  checkSourceFiles,
  loadContext,
  normalizeContext,
  toPublishedWork,
} from "./lib/ops";
import {
  contextFieldValidator as fieldValidator,
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

/**
 * A member's dashboard edit, applied at once: a new value, or (entryId or
 * entryIndex) a replacement for one active list entry.
 */
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
    const { user } = await requireMembership(ctx, args.workspaceId);
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
    await applyContextChange(
      ctx,
      {
        workspaceId: args.workspaceId,
        field: args.field,
        value: text,
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

/**
 * Adds to project context, or resolves/removes a constraint or open
 * question, as the signed-in member. Applies at once (changeContextCore).
 */
export const changeContext = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    operation: v.optional(
      v.union(v.literal("add"), v.literal("resolve"), v.literal("remove")),
    ),
    entryId: v.optional(v.string()),
    supersedes: v.optional(v.string()),
    expectedVersion: v.optional(v.number()),
    field: fieldValidator,
    /** For ownership, the area; omitted for resolve and remove. */
    value: v.optional(v.string()),
    sourceFileIds: v.array(v.id("files")),
    /** Required for ownership; else omitted. */
    ownerUserId: v.optional(v.id("users")),
  },
  returns: v.object({
    version: v.number(),
    entryId: v.union(v.string(), v.null()),
    deduplicated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireHumanSession(ctx);
    const { user } = await requireMembership(ctx, args.workspaceId);
    return await changeContextCore(ctx, { ...args, actor: humanActor(user) });
  },
});
