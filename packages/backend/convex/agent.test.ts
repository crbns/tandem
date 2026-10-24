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

describe("sync published work", () => {
  it("returns full findings since a teammate's cursor and isolates tenants", async () => {
    const { t, alex, sam, jordan, workspaceId, otherWorkspaceId } = await setup();
    const publisher = await alex.mutation(api.agentConnections.createAgentConnection, {
      workspaceId, client: "claude",
    });
    const reader = await sam.mutation(api.agentConnections.createAgentConnection, {
      workspaceId, client: "chatgpt",
    });
    const outsider = await jordan.mutation(api.agentConnections.createAgentConnection, {
      workspaceId: otherWorkspaceId, client: "claude",
    });
    const file = await t.mutation(api.mcp.createDocument, {
      token: publisher.token, name: "latency.md", mimeType: "text/markdown", content: "p95",
    });
    const publish = (token: string, title: string, fileIds: Id<"files">[] = []) =>
      t.mutation(api.mcp.publishWork, {
        token, kind: "finding", title, summary: "Full result: p95 is 120ms; cache misses dominate.", fileIds,
      });
    const old = await publish(publisher.token, "Before cursor");
    const before = await t.mutation(api.mcp.syncWorkspace, { token: reader.token });
    expect(before.recentWork).toEqual([old]);
    expect(before.workTruncated).toBe(false);
    await publish(outsider.token, "Private finding");
    const work = await publish(publisher.token, "Latency", [file.id]);
    const after = await t.mutation(api.mcp.syncWorkspace, {
      token: reader.token, sinceSeq: before.cursorSeq,
    });
    expect(after.recentWork).toEqual([work]);
    expect(after.recentWork[0]).toMatchObject({
      kind: "finding", title: "Latency", fileIds: [file.id],
      summary: "Full result: p95 is 120ms; cache misses dominate.",
      createdBy: { type: "agent", agentConnectionId: publisher.connectionId },
      createdAt: expect.any(Number),
    });
    expect(after.workTruncated).toBe(false);
    const empty = await t.mutation(api.mcp.syncWorkspace, {
      token: reader.token, sinceSeq: after.cursorSeq,
    });
    expect(empty.recentWork).toEqual([]);
    expect(empty.workTruncated).toBe(false);
    const snapshot = await t.mutation(api.mcp.syncWorkspace, { token: reader.token });
    expect(snapshot.recentWork).toEqual([work, old]);
    const other = await t.mutation(api.mcp.syncWorkspace, { token: outsider.token });
    expect(other.recentWork.map((w) => w.title)).toEqual(["Private finding"]);
    expect(await errorData(t.mutation(api.mcp.syncWorkspace, {
      token: outsider.token, workspaceId,
    }))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("caps snapshots and incremental work at the newest 20 independently of event pages", async () => {
    const { t, sam, workspaceId } = await setup();
    const { token } = await sam.mutation(api.agentConnections.createAgentConnection, {
      workspaceId, client: "claude",
    });
    const before = await t.mutation(api.mcp.syncWorkspace, { token });
    expect(before.recentWork).toEqual([]);
    expect(before.workTruncated).toBe(false);
    const published = [];
    for (let i = 0; i < 55; i++) {
      published.push(await t.mutation(api.mcp.publishWork, {
        token, kind: i % 2 ? "finding" : "deliverable", title: `Work ${i}`, summary: `Full summary ${i}`, fileIds: [],
      }));
      if (i === 19) {
        const exact = await t.mutation(api.mcp.syncWorkspace, { token });
        expect(exact.recentWork).toHaveLength(20);
        expect(exact.workTruncated).toBe(false);
      }
    }
    const expected = published.slice(-20).reverse();
    const snapshot = await t.mutation(api.mcp.syncWorkspace, { token });
    expect(snapshot.recentWork).toEqual(expected);
    expect(snapshot.workTruncated).toBe(true);
    const incremental = await t.mutation(api.mcp.syncWorkspace, { token, sinceSeq: before.cursorSeq });
    expect(incremental.eventsTruncated).toBe(true);
    expect(incremental.recentWork).toEqual(expected);
    expect(incremental.workTruncated).toBe(true);
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

describe("dashboard project context (#24)", () => {
  it.each(["owner", "admin"] as const)(
    "lets a human %s edit with revision, attribution, event, and next-sync visibility",
    async (role) => {
      const { t, alex, sam, alexId, workspaceId } = await setup();
      if (role === "admin")
        await t.run(async (ctx) => {
          const member = await ctx.db
            .query("workspace_members")
            .withIndex("by_workspace_and_user", (q) =>
              q.eq("workspaceId", workspaceId).eq("userId", alexId),
            )
            .unique();
          await ctx.db.patch(member!._id, { role: "admin" });
        });
      const { token } = await sam.mutation(
        api.agentConnections.createAgentConnection,
        { workspaceId, client: "claude" },
      );
      const before = await t.mutation(api.mcp.syncWorkspace, { token });
      const file = await alex.mutation(api.files.createDocument, {
        workspaceId,
        name: "plan.md",
        mimeType: "text/markdown",
        content: "Ship",
      });
      const result = await alex.mutation(api.context.updateContextField, {
        workspaceId,
        field: "goal",
        proposedValue: "Ship the demo",
        sourceFileIds: [file.id],
        expectedVersion: before.context.revision,
      });
      const after = await t.mutation(api.mcp.syncWorkspace, {
        token,
        sinceSeq: before.cursorSeq,
      });
      expect(result.version).toBe(before.context.revision + 1);
      expect(after.context.goal).toMatchObject({
        text: "Ship the demo",
        sourceFileIds: [file.id],
        updatedBy: { type: "human", userId: alexId },
      });
      expect(
        after.events.find((event) => event.kind === "context.updated"),
      ).toMatchObject({
        actor: { type: "human", userId: alexId },
        entityType: "structured_context",
      });
      expect(
        await alex.query(api.context.getApprovals, { workspaceId }),
      ).toEqual([]);
      expect(
        await errorData(
          alex.mutation(api.context.updateContextField, {
            workspaceId,
            field: "goal",
            proposedValue: "Old edit",
            sourceFileIds: [],
            expectedVersion: before.context.revision,
          }),
        ),
      ).toMatchObject({ code: "VERSION_CONFLICT" });
      expect(
        (await alex.query(api.context.getDetails, { workspaceId })).goal?.text,
      ).toBe("Ship the demo");
    },
  );

  it("rejects member edits but lists their proposals for approval, and rejects agent-bound direct edits", async () => {
    const { t, alex, sam, alexId, workspaceId } = await setup();
    const input = {
      workspaceId,
      field: "goal" as const,
      proposedValue: "Team goal",
      sourceFileIds: [],
      expectedVersion: 1,
    };
    expect(
      await errorData(sam.mutation(api.context.updateContextField, input)),
    ).toMatchObject({ code: "FORBIDDEN" });
    const { expectedVersion: _, ...proposalInput } = input;
    const id = await sam.mutation(api.context.proposeContextChange, {
      ...proposalInput,
      rationale: "Agreed in standup",
    });
    expect(
      await alex.query(api.context.getApprovals, {
        workspaceId,
        status: "pending",
      }),
    ).toMatchObject([
      { id, proposedValue: "Team goal", createdBy: { type: "human" } },
    ]);
    const { connectionId } = await alex.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    for (const claims of [
      { agentConnectionId: connectionId },
      { agent_connection_id: connectionId },
    ]) {
      const agent = t.withIdentity({ subject: `${alexId}|session`, ...claims });
      expect(
        await errorData(agent.mutation(api.context.updateContextField, input)),
      ).toMatchObject({ code: "APPROVAL_REQUIRED" });
    }
    expect(
      (await alex.query(api.context.getDetails, { workspaceId })).revision,
    ).toBe(1);
  });

  it("edits each context section, guards positional edits with revisions, and validates owners and sources", async () => {
    const {
      alex,
      sam,
      jordan,
      samId,
      jordanId,
      workspaceId,
      otherWorkspaceId,
    } = await setup();
    let expectedVersion = 1;
    for (const field of [
      "scope",
      "constraint",
      "decision",
      "open_question",
      "ownership",
    ] as const) {
      await alex.mutation(api.context.updateContextField, {
        workspaceId,
        field,
        proposedValue: `${field} value`,
        sourceFileIds: [],
        expectedVersion: expectedVersion++,
        ...(field === "ownership" ? { ownerUserId: samId } : {}),
      });
    }
    await alex.mutation(api.context.updateContextField, {
      workspaceId,
      field: "decision",
      proposedValue: "Revised decision",
      sourceFileIds: [],
      expectedVersion: expectedVersion++,
      entryIndex: 0,
    });
    const details = await sam.query(api.context.getDetails, { workspaceId });
    expect(details.decisions.map((e) => e.text)).toEqual(["Revised decision"]);
    expect(details.ownership[0]).toMatchObject({
      ownerUserId: samId,
      ownerArea: "ownership value",
      text: "ownership value: Sam",
    });
    const foreign = await jordan.mutation(api.files.createDocument, {
      workspaceId: otherWorkspaceId,
      name: "secret.md",
      mimeType: "text/markdown",
      content: "secret",
    });
    expect(
      await errorData(
        alex.mutation(api.context.updateContextField, {
          workspaceId,
          field: "scope",
          proposedValue: "Bad source",
          sourceFileIds: [foreign.id],
          expectedVersion,
        }),
      ),
    ).toMatchObject({ code: "INVALID_SOURCE_FILE" });
    expect(
      await errorData(
        alex.mutation(api.context.updateContextField, {
          workspaceId,
          field: "ownership",
          proposedValue: "Area",
          ownerUserId: jordanId,
          sourceFileIds: [],
          expectedVersion,
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await errorData(
        alex.mutation(api.context.updateContextField, {
          workspaceId,
          field: "decision",
          proposedValue: "Bad index",
          sourceFileIds: [],
          expectedVersion,
          entryIndex: 99,
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      (await alex.query(api.context.getDetails, { workspaceId })).revision,
    ).toBe(expectedVersion);
  });

  it("paginates published work newest first and checks membership on every page", async () => {
    const { t, alex, sam, jordan, workspaceId } = await setup();
    const { token } = await sam.mutation(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const work = await t.mutation(api.mcp.publishWork, {
        token,
        kind: "finding",
        title: `Finding ${i}`,
        summary: `Result ${i}`,
        fileIds: [],
      });
      ids.push(work.id);
    }
    const first = await alex.query(api.context.listPublishedWork, {
      workspaceId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    const last = await sam.query(api.context.listPublishedWork, {
      workspaceId,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(first.isDone).toBe(false);
    expect(last.isDone).toBe(true);
    expect([...first.page, ...last.page].map((work) => work.id)).toEqual(
      ids.reverse(),
    );
    expect(first.page[0]?.createdBy).toMatchObject({
      type: "agent",
      userName: "Sam",
      client: "claude",
    });
    expect(
      await errorData(
        jordan.query(api.context.listPublishedWork, {
          workspaceId,
          paginationOpts: { numItems: 2, cursor: first.continueCursor },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(jordan.query(api.context.getDetails, { workspaceId })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(
        alex.query(api.context.listPublishedWork, {
          workspaceId,
          paginationOpts: { numItems: 101, cursor: null },
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
  });
});
