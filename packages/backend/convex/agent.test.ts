/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Resolves to the thrown ConvexError's data, or fails the test. */
async function errorData(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ConvexError) return err.data as Record<string, unknown>;
    // convex-test rethrows across the function boundary; recover the payload.
    const data = (err as { data?: unknown }).data;
    if (typeof data === "string") return JSON.parse(data);
    if (data && typeof data === "object") return data as Record<string, unknown>;
    throw err;
  }
  throw new Error("expected the call to throw");
}

async function setup() {
  const t = convexTest(schema, modules);
  const insertUser = (name: string) =>
    t.run((ctx) =>
      ctx.db.insert("users", { name, email: `${name.toLowerCase()}@example.com` }),
    );
  const alexId = await insertUser("Alex");
  const samId = await insertUser("Sam");
  const jordanId = await insertUser("Jordan");
  const as = (userId: Id<"users">) =>
    t.withIdentity({ subject: `${userId}|session`, name: undefined });
  const alex = as(alexId);
  const sam = as(samId);
  const jordan = as(jordanId);

  const workspaceId = await alex.mutation(api.workspaces.createWorkspace, {
    name: "Demo",
  });
  // Sam joins as a member through an invite.
  const invite = await alex.mutation(api.workspaces.createWorkspaceInvite, {
    workspaceId,
    role: "member",
  });
  await sam.mutation(api.workspaces.acceptWorkspaceInvite, {
    token: invite.token,
  });
  const otherWorkspaceId = await jordan.mutation(
    api.workspaces.createWorkspace,
    { name: "Other" },
  );
  return {
    t,
    alex,
    sam,
    jordan,
    alexId,
    samId,
    jordanId,
    workspaceId,
    otherWorkspaceId,
  };
}

describe("agent connections", () => {
  it("creates a token once, verifies it, and rejects it after revoke", async () => {
    const { t, sam, samId, workspaceId } = await setup();
    const created = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude", displayName: "Sam's Claude" },
    );
    expect(created.token).toMatch(/^tdm_[A-Za-z0-9_-]{43}$/);

    const stored = await t.run((ctx) => ctx.db.get(created.connectionId));
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const identity = await t.query(api.mcp.verifyToken, {
      token: created.token,
    });
    expect(identity).toMatchObject({
      userId: samId,
      client: "claude",
      connectionId: created.connectionId,
      workspaceId,
    });

    const listed = await sam.query(api.agentConnections.listAgentConnections, {
      workspaceId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      connectionId: created.connectionId,
      userName: "Sam",
      displayName: "Sam's Claude",
      lastMcpActionAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(listed)).not.toContain("tokenHash");

    await sam.mutation(api.agentConnections.revokeAgentConnection, {
      connectionId: created.connectionId,
    });
    expect(
      await errorData(t.query(api.mcp.verifyToken, { token: created.token })),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(
      await errorData(
        t.mutation(api.mcp.listFiles, { token: created.token }),
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects unknown and malformed tokens", async () => {
    const { t } = await setup();
    for (const token of ["", "nope", `tdm_${"A".repeat(43)}`]) {
      expect(
        await errorData(t.query(api.mcp.verifyToken, { token })),
      ).toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("lets members see only their own connections and owners see all", async () => {
    const { alex, sam, workspaceId } = await setup();
    await sam.mutation(api.agentConnections.createAgentConnection, {
      workspaceId,
      client: "claude",
    });
    const alexConn = await alex.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "chatgpt" },
    );
    expect(
      await sam.query(api.agentConnections.listAgentConnections, {
        workspaceId,
      }),
    ).toHaveLength(1);
    expect(
      await alex.query(api.agentConnections.listAgentConnections, {
        workspaceId,
      }),
    ).toHaveLength(2);
    // A member can't revoke someone else's connection.
    expect(
      await errorData(
        sam.mutation(api.agentConnections.revokeAgentConnection, {
          connectionId: alexConn.connectionId,
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses connections for a workspace the caller isn't in, and bad clients", async () => {
    const { jordan, sam, workspaceId } = await setup();
    expect(
      await errorData(
        jordan.mutation(api.agentConnections.createAgentConnection, {
          workspaceId,
          client: "claude",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(
        sam.mutation(api.agentConnections.createAgentConnection, {
          workspaceId,
          client: "copilot",
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("agent file writes", () => {
  it("rejects a stale agent write after a human edit and keeps v2 intact", async () => {
    const { t, alex, sam, samId, alexId, workspaceId } = await setup();
    const { token, connectionId } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );

    const created = await t.mutation(api.mcp.createDocument, {
      token,
      name: "brief.md",
      mimeType: "text/markdown",
      content: "v1 by agent",
    });
    expect(created.version).toBe(1);
    expect(created.updatedBy).toMatchObject({
      type: "agent",
      userId: samId,
      agentConnectionId: connectionId,
      client: "claude",
    });

    const human = await alex.mutation(api.files.updateDocument, {
      fileId: created.id,
      content: "v2 by human",
      expectedVersion: 1,
    });
    expect(human.version).toBe(2);

    expect(
      await errorData(
        t.mutation(api.mcp.updateDocument, {
          token,
          fileId: created.id,
          content: "stale agent edit",
          expectedVersion: 1,
        }),
      ),
    ).toMatchObject({
      code: "VERSION_CONFLICT",
      currentVersion: 2,
      expectedVersion: 1,
    });
    // A version from the future is a conflict too, never a write.
    expect(
      await errorData(
        t.mutation(api.mcp.updateDocument, {
          token,
          fileId: created.id,
          content: "future",
          expectedVersion: 7,
        }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2 });

    const read = await t.mutation(api.mcp.readFile, {
      token,
      fileId: created.id,
    });
    expect(read.content).toBe("v2 by human");
    expect(read.file.version).toBe(2);

    // Revision attribution: v1 agent, v2 human.
    const history = await alex.query(api.files.getFileVersions, {
      fileId: created.id,
    });
    expect(history.map((r) => [r.version, r.actor.type])).toEqual([
      [2, "human"],
      [1, "agent"],
    ]);
    expect(history[0]!.actor.userId).toBe(alexId);
    expect(history[1]!.actor).toMatchObject({
      userId: samId,
      agentConnectionId: connectionId,
    });

    const versions = await t.mutation(api.mcp.getFileVersions, {
      token,
      fileId: created.id,
      limit: 10,
    });
    expect(versions.versions.map((v) => v.sizeBytes)).toEqual([
      "v2 by human".length,
      "v1 by agent".length,
    ]);
    expect(JSON.stringify(versions)).not.toContain("v1 by agent");

    const events = await t.run((ctx) =>
      ctx.db
        .query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) =>
          q.eq("workspaceId", workspaceId),
        )
        .collect(),
    );
    const fileEvents = events.filter((e) => e.entityId === created.id);
    expect(fileEvents.map((e) => [e.kind, e.actor.type])).toEqual([
      ["file.created", "agent"],
      ["file.updated", "human"],
    ]);

    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastMcpActionAt).toBeTypeOf("number");
  });

  it("enforces name uniqueness per folder, trimmed and case-insensitive", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const first = await alex.mutation(api.files.createDocument, {
      workspaceId,
      name: "Notes.md",
      mimeType: "text/markdown",
      content: "",
    });
    expect(
      await errorData(
        t.mutation(api.mcp.createDocument, {
          token,
          name: "  notes.MD ",
          mimeType: "text/markdown",
          content: "dup",
        }),
      ),
    ).toMatchObject({ code: "NAME_EXISTS", fileId: first.id, currentVersion: 1 });
  });

  it("searches names and content case-insensitively with snippets", async () => {
    const { t, sam, workspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    await t.mutation(api.mcp.createDocument, {
      token,
      name: "plan.md",
      mimeType: "text/markdown",
      content: "We will ship the DEMO on Saturday.",
    });
    await t.mutation(api.mcp.createDocument, {
      token,
      name: "demo-notes.md",
      mimeType: "text/markdown",
      content: "nothing here",
    });
    const results = await t.mutation(api.mcp.searchFiles, {
      token,
      query: "demo",
      limit: 10,
    });
    expect(results.map((r) => [r.file.name, r.match])).toEqual([
      ["demo-notes.md", "name"],
      ["plan.md", "content"],
    ]);
    expect(results[1]!.snippet).toContain("ship the DEMO");
  });
});

describe("tenant boundaries", () => {
  it("denies another workspace's files and workspace ids to a token", async () => {
    const { t, sam, jordan, workspaceId, otherWorkspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const foreign = await jordan.mutation(api.files.createDocument, {
      workspaceId: otherWorkspaceId,
      name: "secret.md",
      mimeType: "text/markdown",
      content: "jordan only",
    });
    expect(
      await errorData(
        t.mutation(api.mcp.readFile, { token, fileId: foreign.id }),
      ),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(
      await errorData(
        t.mutation(api.mcp.updateDocument, {
          token,
          fileId: foreign.id,
          content: "x",
          expectedVersion: 1,
        }),
      ),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(
      await errorData(
        t.mutation(api.mcp.listFiles, { token, workspaceId: otherWorkspaceId }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(
        t.mutation(api.mcp.createDocument, {
          token,
          workspaceId: otherWorkspaceId,
          name: "x.md",
          mimeType: "text/markdown",
          content: "",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(
        t.mutation(api.mcp.proposeContextChange, {
          token,
          field: "goal",
          proposedValue: "steal",
          rationale: "r",
          sourceFileIds: [foreign.id],
        }),
      ),
    ).toMatchObject({ code: "INVALID_SOURCE_FILE" });
    const search = await t.mutation(api.mcp.searchFiles, {
      token,
      query: "jordan",
      limit: 10,
    });
    expect(search).toEqual([]);
  });

  it("rejects an outsider's token once they leave the workspace", async () => {
    const { t, sam, samId, workspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspace_members")
        .withIndex("by_workspace_and_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", samId),
        )
        .unique();
      await ctx.db.delete(membership!._id);
    });
    expect(
      await errorData(t.mutation(api.mcp.listFiles, { token })),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("proposals", () => {
  it("lets agents propose but never decide", async () => {
    const { t, alex, sam, samId, workspaceId } = await setup();
    const { token, connectionId } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const { proposal } = await t.mutation(api.mcp.proposeContextChange, {
      token,
      field: "goal",
      proposedValue: "Ship the demo",
      rationale: "Agreed in standup",
      sourceFileIds: [],
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.createdBy).toMatchObject({
      type: "agent",
      userId: samId,
      agentConnectionId: connectionId,
    });

    // No Convex Auth session at all (what the MCP token path has).
    expect(
      await errorData(
        t.mutation(api.context.decideContextProposal, {
          proposalId: proposal.id,
          decision: "approved",
        }),
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
    // An identity bound to an agent connection, approving or rejecting.
    const agentIdentity = t.withIdentity({
      subject: `${samId}|session`,
      agentConnectionId: connectionId,
    });
    for (const decision of ["approved", "rejected"] as const) {
      expect(
        await errorData(
          agentIdentity.mutation(api.context.decideContextProposal, {
            proposalId: proposal.id,
            decision,
          }),
        ),
      ).toMatchObject({ code: "APPROVAL_REQUIRED" });
    }

    const pending = await t.mutation(api.mcp.getApprovals, {
      token,
      status: "pending",
      limit: 10,
    });
    expect(pending.map((p) => p.proposal.id)).toEqual([proposal.id]);

    // The human owner can still approve, and the context changes.
    await alex.mutation(api.context.decideContextProposal, {
      proposalId: proposal.id,
      decision: "approved",
    });
    const context = await alex.query(api.workspaces.getWorkspaceContext, {
      workspaceId,
    });
    expect(context?.goal?.text).toBe("Ship the demo");
  });
});

describe("sync cursor", () => {
  it("returns events in order without gaps across pages", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const { token, connectionId } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const snapshot = await t.mutation(api.mcp.syncWorkspace, { token });
    const startSeq = snapshot.cursorSeq;
    expect(snapshot.events.map((e) => e.seq)).toEqual(
      Array.from({ length: startSeq }, (_, i) => i + 1),
    );

    // 60 interleaved human and agent writes: more than one sync page.
    for (let i = 0; i < 30; i++) {
      await t.mutation(api.mcp.createDocument, {
        token,
        name: `agent-${i}.md`,
        mimeType: "text/markdown",
        content: "",
      });
      await alex.mutation(api.files.createDocument, {
        workspaceId,
        name: `human-${i}.md`,
        mimeType: "text/markdown",
        content: "",
      });
    }

    const page1 = await t.mutation(api.mcp.syncWorkspace, {
      token,
      sinceSeq: startSeq,
      cursorWorkspaceId: workspaceId,
    });
    expect(page1.events).toHaveLength(50);
    expect(page1.eventsTruncated).toBe(true);
    const page2 = await t.mutation(api.mcp.syncWorkspace, {
      token,
      sinceSeq: page1.cursorSeq,
    });
    expect(page2.eventsTruncated).toBe(false);
    const seqs = [...page1.events, ...page2.events].map((e) => e.seq);
    expect(seqs).toEqual(
      Array.from({ length: 60 }, (_, i) => startSeq + i + 1),
    );
    expect(page2.cursorSeq).toBe(startSeq + 60);
    expect(page2.changedFiles.length).toBe(10);

    // Nothing new: same cursor, no events.
    const empty = await t.mutation(api.mcp.syncWorkspace, {
      token,
      sinceSeq: page2.cursorSeq,
    });
    expect(empty.events).toEqual([]);
    expect(empty.cursorSeq).toBe(page2.cursorSeq);

    // A cursor past the head, or for another workspace, is invalid.
    expect(
      await errorData(
        t.mutation(api.mcp.syncWorkspace, { token, sinceSeq: 10_000 }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR" });
    expect(
      await errorData(
        t.mutation(api.mcp.syncWorkspace, {
          token,
          sinceSeq: 1,
          cursorWorkspaceId: "other",
        }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR" });

    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastSyncAt).toBeTypeOf("number");
  });

  it("records publish_work as an event and a stored row", async () => {
    const { t, sam, workspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const before = await t.mutation(api.mcp.syncWorkspace, { token });
    const work = await t.mutation(api.mcp.publishWork, {
      token,
      kind: "finding",
      title: "Latency",
      summary: "p95 is 120ms",
      fileIds: [],
    });
    expect(work.createdBy.type).toBe("agent");
    const after = await t.mutation(api.mcp.syncWorkspace, {
      token,
      sinceSeq: before.cursorSeq,
    });
    expect(after.events.map((e) => [e.kind, e.entityId])).toEqual([
      ["work.published", work.id],
    ]);
  });
});

describe("ownership proposals (review M1)", () => {
  it("requires the proposed owner to be a current member, on propose and approve", async () => {
    const { t, alex, sam, samId, alexId, jordanId, workspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const propose = (ownerUserId: string | undefined, area = "Billing") =>
      t.mutation(api.mcp.proposeContextChange, {
        token,
        field: "ownership",
        proposedValue: area,
        rationale: "Owner needed",
        sourceFileIds: [],
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
      });

    // Garbage, another tenant's user, and no owner at all.
    for (const ownerUserId of ["not-a-real-user-id", jordanId, undefined]) {
      expect(await errorData(propose(ownerUserId))).toMatchObject({
        code: "INVALID_INPUT",
        field: "ownerUserId",
      });
    }
    // An owner on a field that isn't ownership.
    expect(
      await errorData(
        t.mutation(api.mcp.proposeContextChange, {
          token,
          field: "goal",
          proposedValue: "Ship",
          rationale: "r",
          sourceFileIds: [],
          ownerUserId: samId,
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT", field: "ownerUserId" });
    // The dashboard entry point validates the same way.
    expect(
      await errorData(
        alex.mutation(api.context.proposeContextChange, {
          workspaceId,
          field: "ownership",
          proposedValue: "Billing",
          rationale: "r",
          sourceFileIds: [],
          ownerUserId: jordanId,
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT", field: "ownerUserId" });

    // A member: stored structured, shown to approvers by name, not id.
    const { proposal } = await propose(samId);
    expect(proposal).toMatchObject({
      status: "pending",
      proposedValue: "Billing: Sam",
      ownerUserId: samId,
      ownerArea: "Billing",
    });
    const forApprovers = await alex.query(api.context.getApprovals, {
      workspaceId,
      status: "pending",
    });
    expect(forApprovers[0]?.proposedValue).toBe("Billing: Sam");
    expect(forApprovers[0]?.proposedValue).not.toContain(samId);

    // Sam leaves before approval: approving is refused and nothing changes.
    const membership = await t.run((ctx) =>
      ctx.db
        .query("workspace_members")
        .withIndex("by_workspace_and_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", samId),
        )
        .unique(),
    );
    await t.run((ctx) => ctx.db.delete(membership!._id));
    expect(
      await errorData(
        alex.mutation(api.context.decideContextProposal, {
          proposalId: proposal.id,
          decision: "approved",
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT", field: "ownerUserId" });
    const stillPending = await t.run((ctx) => ctx.db.get(proposal.id));
    expect(stillPending?.status).toBe("pending");
    const context = await alex.query(api.workspaces.getWorkspaceContext, {
      workspaceId,
    });
    expect(context?.ownership).toEqual([]);

    // Alex (still a member) is approved, and a later proposal for the same
    // area (trimmed, case-insensitive) replaces the owner instead of adding one.
    const first = await alex.mutation(api.context.proposeContextChange, {
      workspaceId,
      field: "ownership",
      proposedValue: "Payments",
      rationale: "r",
      sourceFileIds: [],
      ownerUserId: alexId,
    });
    await alex.mutation(api.context.decideContextProposal, {
      proposalId: first,
      decision: "approved",
    });
    // Sam rejoins; a fresh proposal naming them is valid again.
    const { _id, _creationTime, ...rejoined } = membership!;
    await t.run((ctx) => ctx.db.insert("workspace_members", rejoined));
    const { proposal: second } = await propose(samId, " PAYMENTS ");
    await alex.mutation(api.context.decideContextProposal, {
      proposalId: second.id,
      decision: "approved",
    });
    const synced = await t.mutation(api.mcp.syncWorkspace, { token });
    expect(
      synced.context.ownership.map((e) => [e.text, e.ownerUserId, e.ownerArea]),
    ).toEqual([["PAYMENTS: Sam", samId, "PAYMENTS"]]);
  });
});

describe("presence on failed calls (review L2)", () => {
  it("touchConnection records the action a failed call rolled back", async () => {
    const { t, sam, workspaceId } = await setup();
    const { token, connectionId } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    expect(
      await errorData(t.mutation(api.mcp.readFile, { token, fileId: "nope" })),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });
    // The failing mutation rolled back its own touch.
    let connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastMcpActionAt).toBeUndefined();

    const before = Date.now();
    await t.mutation(api.mcp.touchConnection, { token });
    connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastMcpActionAt).toBeGreaterThanOrEqual(before);
    expect(connection?.lastSyncAt).toBeUndefined();

    expect(
      await errorData(
        t.mutation(api.mcp.touchConnection, { token: `tdm_${"A".repeat(43)}` }),
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("sync cursor rows (review L3)", () => {
  it("keeps one row per agent connection", async () => {
    const { t, sam, workspaceId } = await setup();
    const laptop = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude", displayName: "Laptop" },
    );
    const work = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude", displayName: "Work" },
    );
    const a = await t.mutation(api.mcp.syncWorkspace, { token: laptop.token });
    await t.mutation(api.mcp.createDocument, {
      token: work.token,
      name: "x.md",
      mimeType: "text/markdown",
      content: "",
    });
    const b = await t.mutation(api.mcp.syncWorkspace, { token: work.token });
    await t.mutation(api.mcp.syncWorkspace, { token: laptop.token, sinceSeq: a.cursorSeq });
    const rows = await t.run((ctx) => ctx.db.query("sync_cursors").take(10));
    expect(
      rows
        .map((r) => [r.agentConnectionId, r.cursor, r.revision])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual(
      [
        [laptop.connectionId, b.cursorSeq, 2],
        [work.connectionId, b.cursorSeq, 1],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  });
});

describe("list_files query (review L4)", () => {
  it("searches every file by name, and truncated describes the matches", async () => {
    const { t, sam, samId, workspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const actor = { type: "human" as const, userId: samId, label: "Sam" };
    const insert = (name: string, updatedAt: number) =>
      t.run((ctx) =>
        ctx.db.insert("files", {
          workspaceId,
          name,
          nameKey: name.toLowerCase(),
          mimeType: "text/markdown",
          content: "",
          version: 1,
          createdBy: actor,
          updatedBy: actor,
          revision: 1,
          createdAt: updatedAt,
          updatedAt,
        }),
      );
    // The oldest file, behind 205 newer ones.
    await insert("roadmap.md", 1);
    for (let i = 0; i < 205; i++) await insert(`notes ${i}.md`, 1000 + i);

    const roadmap = await t.mutation(api.mcp.listFiles, { token, query: "roadmap" });
    expect(roadmap.files.map((f) => f.name)).toEqual(["roadmap.md"]);
    expect(roadmap.truncated).toBe(false);

    const notes = await t.mutation(api.mcp.listFiles, { token, query: "notes" });
    expect(notes.files).toHaveLength(200);
    expect(notes.truncated).toBe(true);
  });
});

describe("decideContextProposal (review L5)", () => {
  it("checks the caller before revealing whether a proposal exists", async () => {
    const { t, alex, workspaceId } = await setup();
    const proposalId = await alex.mutation(api.context.proposeContextChange, {
      workspaceId,
      field: "goal",
      proposedValue: "Ship",
      rationale: "r",
      sourceFileIds: [],
    });
    await t.run((ctx) => ctx.db.delete(proposalId));
    expect(
      await errorData(
        t.mutation(api.context.decideContextProposal, {
          proposalId,
          decision: "approved",
        }),
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(
      await errorData(
        alex.mutation(api.context.decideContextProposal, {
          proposalId,
          decision: "approved",
        }),
      ),
    ).toMatchObject({ code: "PROPOSAL_NOT_FOUND" });
  });
});

describe("workspace members for agents (T5b)", () => {
  it("lists only the token's workspace members, with ids, names and roles but no emails", async () => {
    const { t, sam, jordan, alexId, samId, jordanId, workspaceId, otherWorkspaceId } =
      await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const result = await t.mutation(api.mcp.listMembers, { token });
    expect(result.truncated).toBe(false);
    expect(
      [...result.members].sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { userId: alexId, name: "Alex", role: "owner" },
      { userId: samId, name: "Sam", role: "member" },
    ]);
    // Never another tenant's members, and never an email address.
    expect(result.members.map((m) => m.userId)).not.toContain(jordanId);
    expect(JSON.stringify(result)).not.toContain("@");
    expect(JSON.stringify(result)).not.toContain("email");

    const theirs = await jordan.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId: otherWorkspaceId, client: "claude" },
    );
    const other = await t.mutation(api.mcp.listMembers, { token: theirs.token });
    expect(other.members).toEqual([
      { userId: jordanId, name: "Jordan", role: "owner" },
    ]);

    // A member with no name is shown generically, not by email.
    await t.run((ctx) => ctx.db.patch(samId, { name: undefined }));
    const unnamed = await t.mutation(api.mcp.listMembers, { token });
    expect(unnamed.members.find((m) => m.userId === samId)?.name).toBe(
      "Workspace member",
    );
    expect(JSON.stringify(unnamed)).not.toContain("@");

    // Unknown tokens get nothing.
    expect(
      await errorData(
        t.mutation(api.mcp.listMembers, { token: `tdm_${"A".repeat(43)}` }),
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("folders and file moves", () => {
  async function folderSetup() {
    const base = await setup();
    const { token, connectionId } = await base.sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId: base.workspaceId, client: "claude" },
    );
    const events = () =>
      base.t.run((ctx) =>
        ctx.db
          .query("workspace_events")
          .withIndex("by_workspace_and_seq", (q) =>
            q.eq("workspaceId", base.workspaceId),
          )
          .collect(),
      );
    return { ...base, token, connectionId, events };
  }

  it("lets an agent create folders, unique per parent and case-insensitive", async () => {
    const { t, token, samId, connectionId, workspaceId, otherWorkspaceId, jordan, events } =
      await folderSetup();
    const specs = await t.mutation(api.mcp.createFolder, {
      token,
      name: "  Specs ",
    });
    expect(specs).toMatchObject({
      workspaceId,
      parentId: null,
      name: "Specs",
      updatedBy: { type: "agent", userId: samId, agentConnectionId: connectionId },
    });
    expect(
      await errorData(t.mutation(api.mcp.createFolder, { token, name: "SPECS" })),
    ).toMatchObject({ code: "NAME_EXISTS", folderId: specs.id, name: "Specs" });

    // Nested: the same name is fine under a different parent.
    const nested = await t.mutation(api.mcp.createFolder, {
      token,
      parentId: specs.id,
      name: "specs",
    });
    expect(nested.parentId).toBe(specs.id);
    // Folders and files are separate namespaces.
    await t.mutation(api.mcp.createDocument, {
      token,
      name: "Specs",
      mimeType: "text/markdown",
      content: "",
    });

    for (const name of ["", "   ", "x".repeat(256)]) {
      expect(
        await errorData(t.mutation(api.mcp.createFolder, { token, name })),
      ).toMatchObject({ code: "INVALID_NAME" });
    }
    // Another tenant's folder, a malformed id, and another workspace id.
    const foreignId = await jordan.mutation(api.workspaces.createFolder, {
      workspaceId: otherWorkspaceId,
      name: "Theirs",
    });
    for (const parentId of [foreignId, "not-a-folder"]) {
      expect(
        await errorData(
          t.mutation(api.mcp.createFolder, { token, parentId, name: "x" }),
        ),
      ).toMatchObject({ code: "INVALID_PARENT_FOLDER" });
    }
    expect(
      await errorData(
        t.mutation(api.mcp.createFolder, {
          token,
          workspaceId: otherWorkspaceId,
          name: "x",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });

    const created = (await events()).filter((e) => e.kind === "folder.created");
    expect(created.map((e) => [e.entityType, e.entityId, e.actor.type])).toEqual([
      ["folder", specs.id, "agent"],
      ["folder", nested.id, "agent"],
    ]);
  });

  it("matches legacy folders created before nameKey existed", async () => {
    const { t, token, samId, workspaceId } = await folderSetup();
    const actor = { type: "human" as const, userId: samId, label: "Sam" };
    const legacyId = await t.run((ctx) =>
      ctx.db.insert("folders", {
        workspaceId,
        name: "Archive",
        createdBy: actor,
        updatedBy: actor,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(
      await errorData(t.mutation(api.mcp.createFolder, { token, name: "archive" })),
    ).toMatchObject({ code: "NAME_EXISTS", folderId: legacyId });
  });

  it("lists only the caller's workspace folders", async () => {
    const { t, token, alex, jordan, workspaceId, otherWorkspaceId } =
      await folderSetup();
    const a = await t.mutation(api.mcp.createFolder, { token, name: "A" });
    await t.mutation(api.mcp.createFolder, { token, parentId: a.id, name: "B" });
    await jordan.mutation(api.workspaces.createFolder, {
      workspaceId: otherWorkspaceId,
      name: "Secret",
    });

    const listed = await t.mutation(api.mcp.listFolders, { token });
    expect(listed.truncated).toBe(false);
    expect(listed.folders.map((f) => [f.name, f.parentId])).toEqual([
      ["A", null],
      ["B", a.id],
    ]);
    expect(
      await errorData(
        t.mutation(api.mcp.listFolders, { token, workspaceId: otherWorkspaceId }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });

    // The dashboard sees the same folders and is tenant-checked too.
    const dashboard = await alex.query(api.files.listFolders, { workspaceId });
    expect(dashboard).toEqual(listed);
    expect(
      await errorData(
        jordan.query(api.files.listFolders, { workspaceId }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates a document in an agent-created folder and lists it by folder", async () => {
    const { t, token } = await folderSetup();
    const folder = await t.mutation(api.mcp.createFolder, { token, name: "Docs" });
    const doc = await t.mutation(api.mcp.createDocument, {
      token,
      parentId: folder.id,
      name: "brief.md",
      mimeType: "text/markdown",
      content: "hi",
    });
    expect(doc.parentId).toBe(folder.id);
    await t.mutation(api.mcp.createDocument, {
      token,
      name: "top.md",
      mimeType: "text/markdown",
      content: "",
    });
    const inFolder = await t.mutation(api.mcp.listFiles, {
      token,
      folderId: folder.id,
    });
    expect(inFolder.files.map((f) => f.name)).toEqual(["brief.md"]);
  });

  it("moves a file as metadata: revision+1, same version, a file.moved event", async () => {
    const { t, token, samId, connectionId, events } = await folderSetup();
    const folder = await t.mutation(api.mcp.createFolder, { token, name: "Specs" });
    const file = await t.mutation(api.mcp.createDocument, {
      token,
      name: "plan.md",
      mimeType: "text/markdown",
      content: "v1",
    });
    const before = await t.run((ctx) => ctx.db.get(file.id));

    const moved = await t.mutation(api.mcp.moveFile, {
      token,
      fileId: file.id,
      parentId: folder.id,
      expectedVersion: 1,
    });
    expect(moved).toMatchObject({
      parentId: folder.id,
      version: 1,
      updatedBy: { type: "agent", userId: samId, agentConnectionId: connectionId },
    });
    const after = await t.run((ctx) => ctx.db.get(file.id));
    expect(after?.revision).toBe(before!.revision + 1);
    const revisions = await t.run((ctx) =>
      ctx.db
        .query("file_revisions")
        .withIndex("by_file_and_version", (q) => q.eq("fileId", file.id))
        .collect(),
    );
    expect(revisions).toHaveLength(1);
    const moveEvents = (await events()).filter((e) => e.kind === "file.moved");
    expect(moveEvents.map((e) => [e.entityType, e.entityId, e.summary])).toEqual([
      ["file", file.id, "Moved plan.md to Specs"],
    ]);

    // Moving to where it already is writes nothing.
    const same = await t.mutation(api.mcp.moveFile, {
      token,
      fileId: file.id,
      parentId: folder.id,
      expectedVersion: 1,
    });
    expect(same).toEqual(moved);
    expect((await t.run((ctx) => ctx.db.get(file.id)))?.revision).toBe(
      after!.revision,
    );

    // Back to the top level.
    const top = await t.mutation(api.mcp.moveFile, {
      token,
      fileId: file.id,
      parentId: null,
      expectedVersion: 1,
    });
    expect(top.parentId).toBeNull();
    const last = (await events()).at(-1);
    expect(last).toMatchObject({
      kind: "file.moved",
      summary: "Moved plan.md to the top level",
    });
  });

  it("rejects stale, colliding, cross-tenant and malformed moves", async () => {
    const { t, token, alex, jordan, otherWorkspaceId } = await folderSetup();
    const folder = await t.mutation(api.mcp.createFolder, { token, name: "Specs" });
    const file = await t.mutation(api.mcp.createDocument, {
      token,
      name: "plan.md",
      mimeType: "text/markdown",
      content: "v1",
    });
    await alex.mutation(api.files.updateDocument, {
      fileId: file.id,
      content: "v2",
      expectedVersion: 1,
    });
    expect(
      await errorData(
        t.mutation(api.mcp.moveFile, {
          token,
          fileId: file.id,
          parentId: folder.id,
          expectedVersion: 1,
        }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2, expectedVersion: 1 });

    const clash = await t.mutation(api.mcp.createDocument, {
      token,
      parentId: folder.id,
      name: "PLAN.md",
      mimeType: "text/markdown",
      content: "",
    });
    expect(
      await errorData(
        t.mutation(api.mcp.moveFile, {
          token,
          fileId: file.id,
          parentId: folder.id,
          expectedVersion: 2,
        }),
      ),
    ).toMatchObject({ code: "NAME_EXISTS", fileId: clash.id, currentVersion: 1 });

    const foreignFolder = await jordan.mutation(api.workspaces.createFolder, {
      workspaceId: otherWorkspaceId,
      name: "Theirs",
    });
    for (const parentId of [foreignFolder, "not-a-folder"]) {
      expect(
        await errorData(
          t.mutation(api.mcp.moveFile, {
            token,
            fileId: file.id,
            parentId,
            expectedVersion: 2,
          }),
        ),
      ).toMatchObject({ code: "INVALID_PARENT_FOLDER" });
      // A stale read is reported first, even for a malformed parentId.
      expect(
        await errorData(
          t.mutation(api.mcp.moveFile, {
            token,
            fileId: file.id,
            parentId,
            expectedVersion: 1,
          }),
        ),
      ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2 });
    }

    const foreignFile = await jordan.mutation(api.files.createDocument, {
      workspaceId: otherWorkspaceId,
      name: "secret.md",
      mimeType: "text/markdown",
      content: "",
    });
    expect(
      await errorData(
        t.mutation(api.mcp.moveFile, {
          token,
          fileId: foreignFile.id,
          parentId: null,
          expectedVersion: 1,
        }),
      ),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });

    // Nothing above changed the file.
    const unchanged = await alex.query(api.files.readFile, { fileId: file.id });
    expect(unchanged.file).toMatchObject({ parentId: null, version: 2 });
  });

  it("gives the dashboard createFolder, listFolders and moveFile with human attribution", async () => {
    const { alex, alexId, jordan, workspaceId, events } = await folderSetup();
    const folderId = await alex.mutation(api.workspaces.createFolder, {
      workspaceId,
      name: "Design",
    });
    expect(
      await errorData(
        alex.mutation(api.workspaces.createFolder, { workspaceId, name: " design " }),
      ),
    ).toMatchObject({ code: "NAME_EXISTS", folderId });
    expect(
      await errorData(
        jordan.mutation(api.workspaces.createFolder, { workspaceId, name: "x" }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });

    const { folders } = await alex.query(api.files.listFolders, { workspaceId });
    expect(folders).toEqual([
      expect.objectContaining({
        id: folderId,
        name: "Design",
        parentId: null,
        updatedBy: expect.objectContaining({ type: "human", userId: alexId }),
      }),
    ]);

    const file = await alex.mutation(api.files.createDocument, {
      workspaceId,
      name: "mock.md",
      mimeType: "text/markdown",
      content: "",
    });
    const moved = await alex.mutation(api.files.moveFile, {
      fileId: file.id,
      parentId: folderId,
      expectedVersion: 1,
    });
    expect(moved).toMatchObject({
      parentId: folderId,
      version: 1,
      updatedBy: { type: "human", userId: alexId },
    });
    expect((await events()).at(-1)).toMatchObject({
      kind: "file.moved",
      actor: { type: "human", userId: alexId },
    });
    expect(
      await errorData(
        alex.mutation(api.files.moveFile, {
          fileId: file.id,
          parentId: null,
          expectedVersion: 2,
        }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 1 });
    // Another tenant can't move it, and can't tell it exists.
    expect(
      await errorData(
        jordan.mutation(api.files.moveFile, {
          fileId: file.id,
          parentId: null,
          expectedVersion: 1,
        }),
      ),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

describe("folder rename, move and paths (#28)", () => {
  async function treeSetup() {
    const base = await setup();
    const { token } = await base.sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId: base.workspaceId, client: "claude" },
    );
    const folder = async (name: string, parentId?: Id<"folders">) => {
      const id = await base.alex.mutation(api.workspaces.createFolder, {
        workspaceId: base.workspaceId,
        name,
        parentId,
      });
      const { folders } = await base.alex.query(api.files.listFolders, {
        workspaceId: base.workspaceId,
      });
      return folders.find((f) => f.id === id)!;
    };
    const lastEvent = async () =>
      (
        await base.t.run((ctx) =>
          ctx.db
            .query("workspace_events")
            .withIndex("by_workspace_and_seq", (q) =>
              q.eq("workspaceId", base.workspaceId),
            )
            .order("desc")
            .first(),
        )
      )!;
    return { ...base, token, folder, lastEvent };
  }

  it("renames a folder with a revision check and a folder.renamed event", async () => {
    const { alex, alexId, folder, lastEvent } = await treeSetup();
    const specs = await folder("specs");
    expect(specs.revision).toBe(1);
    const renamed = await alex.mutation(api.workspaces.renameFolder, {
      folderId: specs.id,
      name: " Design ",
      expectedRevision: 1,
    });
    expect(renamed).toMatchObject({
      id: specs.id,
      name: "Design",
      parentId: null,
      revision: 2,
      updatedBy: { type: "human", userId: alexId },
    });
    expect(await lastEvent()).toMatchObject({
      kind: "folder.renamed",
      entityType: "folder",
      entityId: specs.id,
      summary: "Renamed folder specs to Design",
      actor: { type: "human", userId: alexId },
    });

    // Stale revision.
    expect(
      await errorData(
        alex.mutation(api.workspaces.renameFolder, {
          folderId: specs.id,
          name: "Other",
          expectedRevision: 1,
        }),
      ),
    ).toMatchObject({
      code: "VERSION_CONFLICT",
      folderId: specs.id,
      currentRevision: 2,
      expectedRevision: 1,
    });
    expect(
      await errorData(
        alex.mutation(api.workspaces.renameFolder, {
          folderId: specs.id,
          name: "Other",
          expectedRevision: 0,
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT", folderId: specs.id });
    expect(
      await errorData(
        alex.mutation(api.workspaces.renameFolder, {
          folderId: specs.id,
          name: "   ",
          expectedRevision: 2,
        }),
      ),
    ).toMatchObject({ code: "INVALID_NAME" });

    // Case-only rename keeps the collision key and is allowed.
    const recased = await alex.mutation(api.workspaces.renameFolder, {
      folderId: specs.id,
      name: "DESIGN",
      expectedRevision: 2,
    });
    expect(recased).toMatchObject({ name: "DESIGN", revision: 3 });
    // Identical name writes nothing.
    const same = await alex.mutation(api.workspaces.renameFolder, {
      folderId: specs.id,
      name: "DESIGN",
      expectedRevision: 3,
    });
    expect(same).toEqual(recased);
  });

  it("rejects a rename onto a sibling's name, case-insensitively, but not a cousin's", async () => {
    const { alex, folder } = await treeSetup();
    const notes = await folder("Notes");
    const drafts = await folder("drafts");
    const inner = await folder("archive", notes.id);
    expect(
      await errorData(
        alex.mutation(api.workspaces.renameFolder, {
          folderId: drafts.id,
          name: "NOTES",
          expectedRevision: 1,
        }),
      ),
    ).toMatchObject({ code: "NAME_EXISTS", folderId: notes.id, name: "Notes" });
    // "archive" lives under Notes, so a top-level folder may take the name.
    const archived = await alex.mutation(api.workspaces.renameFolder, {
      folderId: drafts.id,
      name: "Archive",
      expectedRevision: 1,
    });
    expect(archived.name).toBe("Archive");
    expect(inner.parentId).toBe(notes.id);
  });

  it("hides another tenant's folder as FOLDER_NOT_FOUND for rename and move", async () => {
    const { t, alex, jordan, sam, folder } = await treeSetup();
    const specs = await folder("specs");
    expect(
      await errorData(
        jordan.mutation(api.workspaces.renameFolder, {
          folderId: specs.id,
          name: "mine",
          expectedRevision: 1,
        }),
      ),
    ).toMatchObject({ code: "FOLDER_NOT_FOUND" });
    expect(
      await errorData(
        jordan.mutation(api.workspaces.moveFolder, {
          folderId: specs.id,
          parentId: null,
          expectedRevision: 1,
        }),
      ),
    ).toMatchObject({ code: "FOLDER_NOT_FOUND" });
    // A missing folder looks the same as another tenant's.
    const gone = await folder("gone");
    await t.run((ctx) => ctx.db.delete(gone.id));
    expect(
      await errorData(
        alex.mutation(api.workspaces.renameFolder, {
          folderId: gone.id,
          name: "back",
          expectedRevision: 1,
        }),
      ),
    ).toMatchObject({ code: "FOLDER_NOT_FOUND" });
    // Any member of the workspace can rename it, and nothing above changed it.
    const renamed = await sam.mutation(api.workspaces.renameFolder, {
      folderId: specs.id,
      name: "Specs",
      expectedRevision: 1,
    });
    expect(renamed).toMatchObject({
      revision: 2,
      updatedBy: { type: "human" },
    });
  });

  it("moves a folder with its subtree, to another folder and back to the top level", async () => {
    const { alex, alexId, folder, lastEvent } = await treeSetup();
    const specs = await folder("specs");
    const api_ = await folder("api", specs.id);
    const archive = await folder("archive");

    const moved = await alex.mutation(api.workspaces.moveFolder, {
      folderId: specs.id,
      parentId: archive.id,
      expectedRevision: 1,
    });
    expect(moved).toMatchObject({
      id: specs.id,
      parentId: archive.id,
      revision: 2,
      updatedBy: { type: "human", userId: alexId },
    });
    expect(await lastEvent()).toMatchObject({
      kind: "folder.moved",
      entityType: "folder",
      entityId: specs.id,
      summary: "Moved folder specs to archive",
    });
    // The child moves with it: its own row is untouched.
    const { folders } = await alex.query(api.files.listFolders, {
      workspaceId: specs.workspaceId,
    });
    expect(folders.find((f) => f.id === api_.id)).toMatchObject({
      parentId: specs.id,
      revision: 1,
    });

    // Same parent writes nothing and records no event.
    const before = await lastEvent();
    const same = await alex.mutation(api.workspaces.moveFolder, {
      folderId: specs.id,
      parentId: archive.id,
      expectedRevision: 2,
    });
    expect(same).toEqual(moved);
    expect((await lastEvent())._id).toBe(before._id);

    const top = await alex.mutation(api.workspaces.moveFolder, {
      folderId: specs.id,
      parentId: null,
      expectedRevision: 2,
    });
    expect(top).toMatchObject({ parentId: null, revision: 3 });
    expect(await lastEvent()).toMatchObject({
      kind: "folder.moved",
      summary: "Moved folder specs to the top level",
    });
  });

  it("rejects cycles, collisions, stale revisions and foreign destinations", async () => {
    const { alex, jordan, otherWorkspaceId, folder } = await treeSetup();
    const specs = await folder("specs");
    const child = await folder("api", specs.id);
    const grandchild = await folder("v2", child.id);
    const move = (
      folderId: Id<"folders">,
      parentId: Id<"folders"> | null,
      expectedRevision = 1,
    ) =>
      errorData(
        alex.mutation(api.workspaces.moveFolder, {
          folderId,
          parentId,
          expectedRevision,
        }),
      );

    for (const target of [specs.id, child.id, grandchild.id]) {
      expect(await move(specs.id, target)).toMatchObject({
        code: "FOLDER_CYCLE",
        folderId: specs.id,
      });
    }
    expect(await move(child.id, grandchild.id)).toMatchObject({
      code: "FOLDER_CYCLE",
      folderId: child.id,
    });

    // A top-level "API" collides with the child moving up, case-insensitively.
    const clash = await folder("API");
    expect(await move(child.id, null)).toMatchObject({
      code: "NAME_EXISTS",
      folderId: clash.id,
      name: "API",
    });

    expect(await move(child.id, null, 2)).toMatchObject({
      code: "VERSION_CONFLICT",
      folderId: child.id,
      currentRevision: 1,
      expectedRevision: 2,
    });

    const foreign = await jordan.mutation(api.workspaces.createFolder, {
      workspaceId: otherWorkspaceId,
      name: "Theirs",
    });
    expect(await move(grandchild.id, foreign)).toMatchObject({
      code: "INVALID_PARENT_FOLDER",
    });

    // Nothing above changed the tree.
    const { folders } = await alex.query(api.files.listFolders, {
      workspaceId: specs.workspaceId,
    });
    expect(
      folders.map((f) => [f.name, f.parentId, f.revision]),
    ).toEqual([
      ["specs", null, 1],
      ["api", specs.id, 1],
      ["v2", child.id, 1],
      ["API", null, 1],
    ]);
  });

  it("gives agents each file's folderPath in listFiles, searchFiles and readFile", async () => {
    const { t, alex, token, workspaceId, folder } = await treeSetup();
    const specs = await folder("specs");
    const apiFolder = await folder("api", specs.id);
    const create = (name: string, parentId?: Id<"folders">) =>
      alex.mutation(api.files.createDocument, {
        workspaceId,
        parentId,
        name,
        mimeType: "text/markdown",
        content: "needle",
      });
    const top = await create("top.md");
    const mid = await create("mid.md", specs.id);
    const deep = await create("deep.md", apiFolder.id);

    const { files } = await t.mutation(api.mcp.listFiles, { token });
    const paths = Object.fromEntries(files.map((f) => [f.name, f.folderPath]));
    expect(paths).toEqual({
      "top.md": "",
      "mid.md": "specs/",
      "deep.md": "specs/api/",
    });
    const inFolder = await t.mutation(api.mcp.listFiles, {
      token,
      folderId: apiFolder.id,
    });
    expect(inFolder.files.map((f) => [f.id, f.folderPath])).toEqual([
      [deep.id, "specs/api/"],
    ]);

    const found = await t.mutation(api.mcp.searchFiles, {
      token,
      query: "needle",
      limit: 10,
    });
    expect(
      Object.fromEntries(found.map((r) => [r.file.id, r.file.folderPath])),
    ).toEqual({ [top.id]: "", [mid.id]: "specs/", [deep.id]: "specs/api/" });

    const read = await t.mutation(api.mcp.readFile, { token, fileId: deep.id });
    expect(read.file.folderPath).toBe("specs/api/");
  });

  it("issue #28 acceptance: a human files proposal.md under specs/ and an agent sees it there", async () => {
    const { t, alex, token, workspaceId } = await treeSetup();
    const specsId = await alex.mutation(api.workspaces.createFolder, {
      workspaceId,
      name: "specs",
    });
    const proposal = await alex.mutation(api.files.createDocument, {
      workspaceId,
      name: "proposal.md",
      mimeType: "text/markdown",
      content: "# Proposal",
    });
    await alex.mutation(api.files.moveFile, {
      fileId: proposal.id,
      parentId: specsId,
      expectedVersion: 1,
    });

    const listed = await t.mutation(api.mcp.listFiles, { token });
    expect(listed.files).toEqual([
      expect.objectContaining({
        id: proposal.id,
        name: "proposal.md",
        parentId: specsId,
        folderPath: "specs/",
      }),
    ]);

    const { folders } = await alex.query(api.files.listFolders, { workspaceId });
    await alex.mutation(api.workspaces.renameFolder, {
      folderId: specsId,
      name: "design",
      expectedRevision: folders[0]!.revision,
    });
    const after = await t.mutation(api.mcp.listFiles, { token });
    expect(after.files.map((f) => [f.name, f.folderPath])).toEqual([
      ["proposal.md", "design/"],
    ]);
  });
});
