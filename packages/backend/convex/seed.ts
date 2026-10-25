// Demo seed (issue #22). One internal entry point rebuilds the demo from
// scratch: Alex (owner), Blake and Casey (members) as Password users, one
// workspace with brief.md v1, a goal and scope, research and requirements
// files, working context, three tasks, one decision recorded by Casey's
// Gemini, and one agent connection per member. proposal.md is left
// out: Claude creates it live.
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
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { MIN_PASSWORD_LENGTH } from "./auth";
import { agentActor, revokeConnectionCredentials } from "./lib/agent";
import {
  ALL_MCP_SCOPES,
  API_KEY_PATTERN,
  mcpResource,
  randomSecret,
  sha256Hex,
} from "./lib/mcpConfig";
import { type Actor, humanActor, recordWorkspaceEvent } from "./lib/auth";
import { ensureFolderPathCore } from "./lib/fs";
import {
  claimTaskCore,
  completeTaskCore,
  createDocumentCore,
  createTaskCore,
  changeContextCore,
  updateDocumentCore,
} from "./lib/ops";

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
- No new help-center platform: the guides live in the existing help center or the app.

## Decided at kickoff

- Blake owns the welcome email sequence.
- First value means "first project created", not "first teammate invited".

## Open questions

- Do the how-to guides live in the app or in the existing help center?

## Next step

Draft proposal.md: milestones, owners, and how we measure success.
`;

export const DEMO_DECISION =
  'First value means "first project created", not "first teammate invited".';
export const DEMO_CONSTRAINT = "Launch before the January 15 billing cycle.";
/** The constraint Casey's Gemini's decision contradicts (the scope says it too). */
export const DEMO_HELP_CENTER_CONSTRAINT =
  "No new help-center platform: the guides live in the existing help center or the app.";
export const DEMO_OPEN_QUESTION =
  "Do the how-to guides live in the app or in the existing help center?";
/**
 * Casey's Gemini records this; it contradicts the scope and the help-center
 * constraint on purpose, so the demo has a disagreement for the team to see.
 */
export const DEMO_AGENT_DECISION =
  "Move the three how-to guides to a new help-center platform.";

const DEMO_SUPPORT_TICKETS = `# Support tickets: first 30 days

Pulled by Casey from the last quarter's new accounts (412 tickets).

## Top setup questions

1. How do I invite my team? (31%)
2. Where do I create my first project? (22%)
3. Why can't I see my teammate's work? (14%)
4. How do I connect my calendar? (9%)

## Notes

- Most tickets arrive on day 2 or 3, after the welcome email.
- Customers who invite a teammate in week one file half as many tickets.
`;

const DEMO_INTERVIEW_NOTES_V1 = `# Customer interview notes

Five interviews with accounts that signed up last month.

## What slowed them down

- The checklist hides behind the profile menu.
- Nobody read the second welcome email.
`;

const DEMO_INTERVIEW_NOTES_V2 = `# Customer interview notes

Six interviews with accounts that signed up last month.

## What slowed them down

- The checklist hides behind the profile menu.
- Nobody read the second welcome email.
- Two teams didn't know a project could be shared until a teammate asked.

## Quotes

- "I created a project on day one and then waited a week for my team."
`;

const DEMO_SETUP_CHECKLIST = `# Requirements: in-app setup checklist

Owner: Blake. Uses the existing checklist component; no new engineering.

## Steps

1. Create your first project.
2. Invite one teammate.
3. Connect one tool (calendar or Slack).

## Done when

- The checklist shows on first sign-in, not behind the profile menu.
- Each step links to its how-to guide.
`;

const SEED_ACTOR: Actor = { type: "system", label: "Demo seed" };

const resetResult = v.object({
  workspaceId: v.id("workspaces"),
  /** The MCP server URL the members' API keys work against. */
  mcpUrl: v.string(),
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
 * Rebuilds the demo. `password` (all three users) and `tokens` (per person,
 * `mcp_sk_` API keys for the Convex MCP endpoint) are optional; omitted ones are generated, so pass the previous values to
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
    // Every check runs before the first account change, so a refused reset
    // leaves passwords and sessions as they were.
    const password = args.password ?? generatePassword();
    if (password.length < MIN_PASSWORD_LENGTH)
      throw new ConvexError({ code: "WEAK_PASSWORD", field: "password" });
    const tokens = DEMO_PEOPLE.map(
      (person) => args.tokens?.[person.key] ?? randomSecret("mcp_sk_"),
    );
    DEMO_PEOPLE.forEach((person, i) => {
      if (!API_KEY_PATTERN.test(tokens[i]!) || tokens.indexOf(tokens[i]!) !== i)
        throw new ConvexError({ code: "INVALID_INPUT", field: `tokens.${person.key}` });
    });
    const taken: number[] = await ctx.runQuery(internal.seed.tokensInUse, {
      tokens,
      now: Date.now(),
    });
    if (taken.length > 0)
      throw new ConvexError({
        code: "INVALID_INPUT",
        field: `tokens.${DEMO_PEOPLE[taken[0]!]!.key}`,
      });
    const people = [];
    for (const [i, person] of DEMO_PEOPLE.entries()) {
      const userId = await upsertPasswordUser(ctx, person, password);
      people.push({ key: person.key, userId, token: tokens[i]! });
    }
    const built: Omit<typeof resetResult.type, "password"> =
      await ctx.runMutation(internal.seed.rebuildDemoWorkspace, { people });
    return { ...built, password };
  },
});

/** Indexes of `tokens` held by a credential outside a demo workspace. */
export const tokensInUse = internalQuery({
  args: { tokens: v.array(v.string()), now: v.number() },
  returns: v.array(v.number()),
  handler: async (ctx, { tokens, now }) => {
    const taken = [];
    for (const [i, token] of tokens.entries()) {
      const owner = await keyOwner(ctx, token, now);
      if (owner === null) continue;
      const workspace = owner === "unknown" ? null : await ctx.db.get(owner.workspaceId);
      if (workspace?.demoSeed !== true) taken.push(i);
    }
    return taken;
  },
});

/** The connection an API key acts for: null when unused, "unknown" when it isn't a connection. */
async function keyOwner(
  ctx: QueryCtx,
  token: string,
  now: number,
): Promise<Doc<"agent_connections"> | "unknown" | null> {
  const info = await ctx.runQuery(components.mcp.tokens.verify, {
    hash: await sha256Hex(token),
    now,
  });
  if (!info) return null;
  const connectionId = ctx.db.normalizeId("agent_connections", info.userId);
  const connection = connectionId ? await ctx.db.get(connectionId) : null;
  return connection ?? "unknown";
}

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
    // Marked by demoSeed, not by name: a workspace Alex names the same survives.
    for (const workspace of previous)
      if (workspace.demoSeed === true) await deleteWorkspace(ctx, workspace._id);

    const workspaceId = await ctx.db.insert("workspaces", {
      name: DEMO_WORKSPACE_NAME,
      demoSeed: true,
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
          summary: `Added ${actor.label} as a member`,
          actor: owner,
        });
    }

    const brief = await createDocumentCore(ctx, {
      workspaceId,
      name: "brief.md",
      mimeType: "text/markdown",
      content: DEMO_BRIEF,
      actor: owner,
    });
    for (const [field, value] of [
      ["goal", DEMO_GOAL],
      ["scope", DEMO_SCOPE],
    ] as const)
      await changeContextCore(ctx, {
        workspaceId,
        field,
        value,
        sourceFileIds: [brief._id],
        actor: owner,
      });

    const members = [];
    for (const { person, user, token } of cast) {
      // The old demo connections' keys were revoked with their workspace above.
      if ((await keyOwner(ctx, token, now)) !== null)
        throw new ConvexError({ code: "INVALID_INPUT", field: `tokens.${person.key}` });
      const actor = humanActor(user);
      const connectionId = await ctx.db.insert("agent_connections", {
        workspaceId,
        userId: user._id,
        client: person.client,
        displayName: person.connectionName,
        authKind: "api_key",
        updatedBy: actor,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      // The key's grant acts for this connection (see convex/mcp.ts).
      await ctx.runMutation(components.mcp.grants.createApiKey, {
        userId: connectionId,
        name: person.connectionName,
        scopes: ALL_MCP_SCOPES,
        resource: mcpResource(),
        hash: await sha256Hex(token),
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
    await seedStory(ctx, workspaceId, brief._id, cast, members);
    return {
      workspaceId,
      mcpUrl: mcpResource(),
      workspaceName: DEMO_WORKSPACE_NAME,
      briefFileId: brief._id,
      members,
    };
  },
});

/**
 * Everything after the goal and scope: research and requirements in folders
 * (one file with history to diff), a decision, an owner, a constraint, an
 * open question, three tasks in each state, and one decision from Casey's
 * Gemini that contradicts the scope.
 */
async function seedStory(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  briefId: Id<"files">,
  cast: { person: (typeof DEMO_PEOPLE)[number]; user: Doc<"users"> }[],
  members: { key: string; connectionId: Id<"agent_connections"> }[],
) {
  const user = (key: string) => cast.find((c) => c.person.key === key)!.user;
  const alex = user("alex");
  const blake = humanActor(user("blake"));
  const casey = humanActor(user("casey"));
  const owner = humanActor(alex);

  const research = await ensureFolderPathCore(ctx, { workspaceId, path: "research", actor: casey });
  const requirements = await ensureFolderPathCore(ctx, { workspaceId, path: "requirements", actor: blake });
  const tickets = await createDocumentCore(ctx, {
    workspaceId, parentId: research.folder._id, name: "support-tickets.md",
    mimeType: "text/markdown", content: DEMO_SUPPORT_TICKETS, actor: casey,
  });
  const notes = await createDocumentCore(ctx, {
    workspaceId, parentId: research.folder._id, name: "interview-notes.md",
    mimeType: "text/markdown", content: DEMO_INTERVIEW_NOTES_V1, actor: blake,
  });
  await backdateFirstVersion(ctx, notes, 26 * 60 * 60 * 1000);
  await updateDocumentCore(ctx, {
    file: notes, content: DEMO_INTERVIEW_NOTES_V2, expectedVersion: 1, actor: blake,
  });
  await createDocumentCore(ctx, {
    workspaceId, parentId: requirements.folder._id, name: "setup-checklist.md",
    mimeType: "text/markdown", content: DEMO_SETUP_CHECKLIST, actor: blake,
  });

  const kickoff = [
    { field: "decision", value: DEMO_DECISION, sourceFileIds: [tickets._id] },
    { field: "ownership", value: "Welcome email sequence", ownerUserId: user("blake")._id, sourceFileIds: [briefId] },
    { field: "constraint", value: DEMO_CONSTRAINT, sourceFileIds: [briefId] },
    { field: "constraint", value: DEMO_HELP_CENTER_CONSTRAINT, sourceFileIds: [briefId] },
    { field: "open_question", value: DEMO_OPEN_QUESTION, sourceFileIds: [briefId] },
  ] as const;
  for (const change of kickoff)
    await changeContextCore(ctx, {
      workspaceId, ...change, sourceFileIds: [...change.sourceFileIds], actor: owner,
    });

  const emails = await createTaskCore(ctx, {
    workspaceId, title: "Draft the welcome email sequence",
    description: "Three emails over the first week, each pointing at one checklist step.", actor: owner,
  });
  await claimTaskCore(ctx, { task: emails, expectedVersion: emails.version, userId: user("blake")._id, actor: blake });
  await createTaskCore(ctx, {
    workspaceId, title: "Write the three how-to guides",
    description: "Invite your team, create a project, connect your tools.", actor: owner,
  });
  const pull = await createTaskCore(ctx, {
    workspaceId, title: "Pull the top setup questions from support",
    description: "Summarize in research/support-tickets.md.", actor: owner,
  });
  const claimed = await claimTaskCore(ctx, { task: pull, expectedVersion: pull.version, userId: user("casey")._id, actor: casey });
  await completeTaskCore(ctx, { task: claimed, expectedVersion: claimed.version, userId: user("casey")._id, actor: casey });

  const caseyConnection = await ctx.db.get(members.find((m) => m.key === "casey")!.connectionId);
  if (!caseyConnection) throw new ConvexError({ code: "INVALID_INPUT" });
  await changeContextCore(ctx, {
    workspaceId, field: "decision", value: DEMO_AGENT_DECISION,
    sourceFileIds: [tickets._id], actor: agentActor(caseyConnection, user("casey")),
  });
}

/**
 * One mutation shares one clock, so every seeded record would read "just now".
 * Moves a file's v1 (its revision, creation event and createdAt) `ms` into the
 * past so "what changed, and when?" has a believable answer on stage.
 */
async function backdateFirstVersion(ctx: MutationCtx, file: Doc<"files">, ms: number) {
  const at = file.createdAt - ms;
  const revision = await ctx.db
    .query("file_revisions")
    .withIndex("by_file_and_version", (q) => q.eq("fileId", file._id).eq("version", 1))
    .unique();
  if (revision) await ctx.db.patch(revision._id, { createdAt: at });
  const events = await ctx.db
    .query("workspace_events")
    .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", file.workspaceId))
    .order("desc")
    .take(5);
  for (const event of events)
    if (event.entityId === file._id && event.kind === "file.created")
      await ctx.db.patch(event._id, { createdAt: at });
  await ctx.db.patch(file._id, { createdAt: at });
}

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
      await revokeConnectionCredentials(ctx, connection._id);
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
    () => ctx.db.query("agent_activity").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("activity_events").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("context_entry_revisions").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("context_entries").withIndex("by_workspace_and_key", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("context_intel_runs").withIndex("by_workspace_and_started_at", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("context_intel_state").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("file_revisions").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("folders").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("context_proposals").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("approvals").withIndex("by_workspace_and_decided", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("published_work").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("tasks").withIndex("by_workspace_and_updated_at", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("structured_context").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("workspace_invites").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
    () => ctx.db.query("workspace_members").withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId)).take(DELETE_BATCH),
  ];
  for (const next of rest) await drain<{ _id: Id<any> }>(ctx, next);
  await ctx.db.delete(workspaceId);
}
