import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

type ReadCtx = QueryCtx | MutationCtx;

export async function requireUser(ctx: ReadCtx): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
  const user = await ctx.db.get(userId as Id<"users">);
  if (!user) throw new ConvexError({ code: "UNAUTHENTICATED" });
  return user;
}

export async function ensureUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED" });
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
  const existing = await ctx.db.get(userId as Id<"users">);
  if (!existing) throw new ConvexError({ code: "UNAUTHENTICATED" });
  const now = Date.now();
  const label = identity.name ?? identity.email ?? "Workspace member";
  await ctx.db.patch(existing._id, {
    name: identity.name ?? existing.name,
    email: identity.email?.toLocaleLowerCase() ?? existing.email,
    updatedBy: {
      type: "human",
      userId: existing._id,
      label,
    },
    revision: (existing.revision ?? 0) + 1,
    appCreatedAt: existing.appCreatedAt ?? now,
    appUpdatedAt: now,
  });
  return existing._id;
}

export async function requireMembership(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ user: Doc<"users">; membership: Doc<"workspace_members"> }> {
  const user = await requireUser(ctx);
  const membership = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", user._id),
    )
    .unique();
  if (!membership) throw new ConvexError({ code: "FORBIDDEN" });
  return { user, membership };
}

export function humanActor(user: Doc<"users">) {
  const userName = user.name ?? user.email ?? "Workspace member";
  return {
    type: "human" as const,
    userId: user._id,
    label: userName,
    userName,
  };
}

export async function recordWorkspaceEvent(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    kind: string;
    entityType: string;
    entityId: string;
    summary: string;
    actor: ReturnType<typeof humanActor>;
  },
) {
  const now = Date.now();
  const eventId = await ctx.db.insert("workspace_events", {
    ...args,
    createdAt: now,
  });
  await ctx.db.insert("outbox_events", {
    workspaceId: args.workspaceId,
    eventId,
    status: "pending",
    attempts: 0,
    updatedBy: args.actor,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  return eventId;
}
