// Demo seed (issue #22). One internal entry point rebuilds the demo from
// scratch: Alex (owner), Blake and Casey (members) as Password users, one
// workspace with brief.md v1 and an approved goal and scope, and one agent
// connection per member. proposal.md is left out: Claude creates it live.
//
//   npx convex run seed:resetDemo '{}'      (or scripts/demo-reset.mjs)
//
// Only the demo workspace is deleted and rebuilt; the demo users' other
// workspaces and every other tenant are untouched. Internal only: running it
// needs the deployment's admin key.
import {
  createAccount,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
} from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  type MutationCtx,
  internalAction,
  internalMutation,
} from "./_generated/server";
import { MIN_PASSWORD_LENGTH } from "./auth";
import { decideProposalCore } from "./context";
import { generateAgentToken, hashAgentToken, TOKEN_PATTERN } from "./lib/agent";
import { type Actor, humanActor, recordWorkspaceEvent } from "./lib/auth";
import { createDocumentCore, proposeContextChangeCore } from "./lib/ops";

export const DEMO_WORKSPACE_NAME = "Onboarding refresh";

export const DEMO_PEOPLE = [
  {
    key: "alex",
    name: "Alex",
    email: "alex@demo.tandem.test",
    role: "owner",
    client: "claude",
    connectionName: "Alex's Claude",
  },
  {
    key: "blake",
    name: "Blake",
    email: "blake@demo.tandem.test",
    role: "member",
    client: "claude",
    connectionName: "Blake's Claude",
  },
  {
    key: "casey",
    name: "Casey",
    email: "casey@demo.tandem.test",
    role: "member",
    client: "gemini",
    connectionName: "Casey's Gemini",
  },
] as const;

const personKey = v.union(
  v.literal("alex"),
  v.literal("blake"),
  v.literal("casey"),
);

export const DEMO_GOAL =
  "Cut new-customer time-to-first-value from 9 days to 3 by the end of Q1.";
export const DEMO_SCOPE =
  "In: welcome email sequence, in-app setup checklist, three short how-to guides. Out: pricing changes, a new help-center platform, localization.";

export const DEMO_BRIEF = `# Brief: customer onboarding refresh

Owner: Alex. Team: Alex, Blake, Casey.

## Problem

New customers take about 9 days to reach first value (their first shared
project). Half of all support tickets in a customer's first month are setup
questions.

## Goal

${DEMO_GOAL}

## Scope

- In: a welcome email sequence, the in-app setup checklist, and three short
  how-to guides (invite your team, create a project, connect your tools).
- Out: pricing changes, a new help-center platform, localization.

## Constraints

- No engineering work beyond the existing checklist component.
- $5k budget for design and copy.
- Launch before the January 15 billing cycle.

## Open questions

- Who owns the email sequence: Blake (lifecycle) or Casey (support)?
- Is first value "first project created" or "first teammate invited"?

## Next step

Draft proposal.md: milestones, owners, and how we measure success.
`;

const SEED_ACTOR: Actor = { type: "system", label: "Demo seed" };

const resetResult = v.object({
  workspaceId: v.id("workspaces"),
  workspaceName: v.string(),
  briefFileId: v.id("files"),
  password: v.string(),
  members: v.array(
    v.object({
      key: personKey,
      name: v.string(),
      email: v.string(),
      role: v.union(v.literal("owner"), v.literal("member")),
      userId: v.id("users"),
      client: v.string(),
      connectionId: v.id("agent_connections"),
      token: v.string(),
    }),
  ),
});

/**
 * Rebuilds the demo. `password` (all three users) and `tokens` (per person)
 * are optional; omitted ones are generated, so pass the previous values to
 * keep sign-ins and assistant configs working across resets. Existing demo
 * accounts get the password reset and their sessions signed out.
 */
export const resetDemo = internalAction({
  args: {
    password: v.optional(v.string()),
    tokens: v.optional(
      v.object({
        alex: v.optional(v.string()),
        blake: v.optional(v.string()),
        casey: v.optional(v.string()),
      }),
    ),
  },
  returns: resetResult,
  handler: async (ctx, args) => {
    const password = args.password ?? generatePassword();
    if (password.length < MIN_PASSWORD_LENGTH)
      throw new ConvexError({ code: "WEAK_PASSWORD", field: "password" });
    const people = [];
    for (const person of DEMO_PEOPLE) {
      const token = args.tokens?.[person.key] ?? generateAgentToken();
      if (!TOKEN_PATTERN.test(token))
        throw new ConvexError({ code: "INVALID_INPUT", field: `tokens.${person.key}` });
      const userId = await upsertPasswordUser(ctx, person, password);
      people.push({ key: person.key, userId, token });
    }
    const built: Omit<typeof resetResult.type, "password"> =
      await ctx.runMutation(internal.seed.rebuildDemoWorkspace, { people });
    return { ...built, password };
  },
});

/** Deletes the demo workspace (if any) and builds it again, in one transaction. */
export const rebuildDemoWorkspace = internalMutation({
  args: {
    people: v.array(
      v.object({ key: personKey, userId: v.id("users"), token: v.string() }),
    ),
  },
  returns: resetResult.omit("password"),
  handler: async (ctx, args) => {
    const byKey = new Map(args.people.map((p) => [p.key, p]));
    const now = Date.now();
    const cast = [];
    for (const person of DEMO_PEOPLE) {
      const input = byKey.get(person.key);
      if (!input) throw new ConvexError({ code: "INVALID_INPUT", field: person.key });
      const user = await ctx.db.get(input.userId);
      if (!user) throw new ConvexError({ code: "USER_NOT_INITIALIZED" });
      await ctx.db.patch(user._id, {
        name: person.name,
        email: person.email,
        updatedBy: SEED_ACTOR,
        revision: (user.revision ?? 0) + 1,
        appCreatedAt: user.appCreatedAt ?? now,
        appUpdatedAt: now,
      });
      const patched = await ctx.db.get(user._id);
      cast.push({ person, user: patched!, token: input.token });
    }
    const alex = cast[0]!.user;
    const owner = humanActor(alex);

    const previous = await ctx.db
      .query("workspaces")
      .withIndex("by_created_by", (q) => q.eq("createdBy", alex._id))
      .take(100);
    for (const workspace of previous)
      if (workspace.name === DEMO_WORKSPACE_NAME)
        await deleteWorkspace(ctx, workspace._id);

    const workspaceId = await ctx.db.insert("workspaces", {
      name: DEMO_WORKSPACE_NAME,
      createdBy: alex._id,
      updatedBy: owner,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("structured_context", {
      workspaceId,
      constraints: [],
      decisions: [],
      ownership: [],
      openQuestions: [],
      revision: 1,
      updatedAt: now,
      updatedBy: owner,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId,
      kind: "workspace.created",
      entityType: "workspace",
      entityId: workspaceId,
      summary: `Created workspace ${DEMO_WORKSPACE_NAME}`,
      actor: owner,
    });
    for (const { person, user } of cast) {
      const actor = humanActor(user);
      const memberId = await ctx.db.insert("workspace_members", {
        workspaceId,
        userId: user._id,
        role: person.role,
        updatedBy: person.role === "owner" ? owner : actor,
        revision: 1,
        joinedAt: now,
        updatedAt: now,
      });
      if (person.role !== "owner")
        await recordWorkspaceEvent(ctx, {
          workspaceId,
          kind: "workspace.member_added",
          entityType: "workspace_member",
          entityId: memberId,
          summary: `${actor.label} joined through an invite`,
          actor,
        });
    }

    const brief = await createDocumentCore(ctx, {
      workspaceId,
      name: "brief.md",
      mimeType: "text/markdown",
      content: DEMO_BRIEF,
      actor: owner,
    });
    for (const [field, proposedValue] of [
      ["goal", DEMO_GOAL],
      ["scope", DEMO_SCOPE],
    ] as const) {
      const proposal = await proposeContextChangeCore(ctx, {
        workspaceId,
        field,
        proposedValue,
        rationale: "From the approved brief.",
        sourceFileIds: [brief._id],
        actor: owner,
      });
      await decideProposalCore(ctx, proposal, "approved", alex);
    }

    const members = [];
    for (const { person, user, token } of cast) {
      const tokenHash = await hashAgentToken(token);
      const taken = await ctx.db
        .query("agent_connections")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .first();
      if (taken)
        throw new ConvexError({ code: "INVALID_INPUT", field: `tokens.${person.key}` });
      const actor = humanActor(user);
      const connectionId = await ctx.db.insert("agent_connections", {
        workspaceId,
        userId: user._id,
        client: person.client,
        displayName: person.connectionName,
        tokenHash,
        updatedBy: actor,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await recordWorkspaceEvent(ctx, {
        workspaceId,
        kind: "agent.connected",
        entityType: "agent_connection",
        entityId: connectionId,
        summary: `${actor.label} connected a ${person.client} assistant`,
        actor,
      });
      members.push({
        key: person.key,
        name: person.name,
        email: person.email,
        role: person.role,
        userId: user._id,
        client: person.client,
        connectionId,
        token,
      });
    }
    return {
      workspaceId,
      workspaceName: DEMO_WORKSPACE_NAME,
      briefFileId: brief._id,
      members,
    };
  },
});

async function upsertPasswordUser(
  ctx: ActionCtx,
  person: (typeof DEMO_PEOPLE)[number],
  password: string,
): Promise<Id<"users">> {
  const account = { id: person.email };
  let existing: Doc<"users"> | null = null;
  try {
    ({ user: existing } = await retrieveAccount(ctx, {
      provider: "password",
      account,
    }));
  } catch (err) {
    if (!String(err).includes("InvalidAccountId")) throw err;
  }
  if (existing) {
    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { ...account, secret: password },
    });
    await invalidateSessions(ctx, { userId: existing._id });
    return existing._id;
  }
  const { user } = await createAccount(ctx, {
    provider: "password",
    account: { ...account, secret: password },
    profile: { email: person.email, name: person.name },
  });
  return user._id;
}

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `demo-${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")}`;
}

const DELETE_BATCH = 200;

/** Deletes `next()`'s rows, batch by batch, until it returns none. */
async function drain<T extends { _id: Id<any> }>(
  ctx: MutationCtx,
  next: () => Promise<T[]>,
  before?: (doc: T) => Promise<void>,
) {
  for (let batch = await next(); batch.length > 0; batch = await next()) {
    for (const doc of batch) {
      await before?.(doc);
      await ctx.db.delete(doc._id);
    }
  }
}

/** Every row scoped to `workspaceId`, its stored blobs, then the workspace. */
async function deleteWorkspace(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  await drain(
    ctx,
    () =>
      ctx.db
        .query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", workspaceId))
        .take(DELETE_BATCH),
    async (event) => {
      const outbox = await ctx.db
        .query("outbox_events")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .take(DELETE_BATCH);
      for (const row of outbox) await ctx.db.delete(row._id);
    },
  );
  await drain(
    ctx,
    () =>
      ctx.db
        .query("agent_connections")
        .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId))
        .take(DELETE_BATCH),
    async (connection) => {
      const cursors = await ctx.db
        .query("sync_cursors")
        .withIndex("by_agent_connection", (q) =>
          q.eq("agentConnectionId", connection._id),
        )
        .take(DELETE_BATCH);
      for (const row of cursors) await ctx.db.delete(row._id);
    },
  );
  const blobs = new Set<Id<"_storage">>();
  const deleteBlob = async (storageId: Id<"_storage"> | undefined) => {
    if (!storageId || blobs.has(storageId)) return;
    blobs.add(storageId);
    if (await ctx.db.system.get("_storage", storageId))
      await ctx.storage.delete(storageId);
  };
  await drain(
    ctx,
    () =>
      ctx.db
        .query("files")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .take(DELETE_BATCH),
    (file) => deleteBlob(file.storageId),
  );
  await drain(
    ctx,
    () =>
      ctx.db
        .query("storage_objects")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .take(DELETE_BATCH),
    (row) => deleteBlob(row.storageId),
  );
  // Each index here starts with workspaceId.
  const rest = [
    () => ctx.db.query("file_revisions").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("folders").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("context_proposals").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("approvals").withIndex("by_workspace_and_decided", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("published_work").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("structured_context").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("workspace_invites").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("workspace_members").withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
  ];
  for (const next of rest) await drain<{ _id: Id<any> }>(ctx, next);
  await ctx.db.delete(workspaceId);
}
