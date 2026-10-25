/// <reference types="vite/client" />
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_MCP_SCOPES } from "./lib/mcpConfig";
import { toToolError } from "./lib/mcpContract";
import { proposedNextSteps, publishedNextSteps, savedNextSteps, syncNextSteps } from "./lib/mcpLoop";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

const modules = import.meta.glob("./**/*.ts");
const SITE = "https://tandem-test.convex.site";
const MCP_URL = `${SITE}/mcp`;

beforeAll(() => {
  process.env.CONVEX_SITE_URL = SITE;
  process.env.SITE_URL = "https://tandem.example";
});

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

function newTest() {
  return convexTest(schema, modules);
}
type Test = ReturnType<typeof newTest>;
type Caller = ReturnType<Test["withIdentity"]>;

/** What the MCP component passes a tool for a credential acting for `connectionId`. */
function principalFor(
  connectionId: string,
  scopes: string[] = ALL_MCP_SCOPES,
) {
  return { userId: connectionId, scopes, connectionId: `grant_${connectionId}` };
}

/**
 * Creates an API-key connection. `token` is the principal tools receive once
 * the component has verified the key; `apiKey` is the bearer secret itself.
 */
async function connect(
  as: Caller,
  args: { workspaceId: Id<"workspaces">; client: string; displayName?: string },
) {
  const created = await as.action(api.agentConnections.createAgentConnection, args);
  return {
    connectionId: created.connectionId,
    apiKey: created.token,
    mcpUrl: created.mcpUrl,
    token: principalFor(created.connectionId),
  };
}

/** One JSON-RPC request to the MCP endpoint (stateless, like claude.ai's). */
async function mcpRequest(
  t: Test,
  bearer: string | null,
  method: string,
  params: Record<string, unknown> = {},
) {
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = res.status === 200 ? await res.json() : null;
  return { status: res.status, headers: res.headers, body };
}

/** Calls a tool over HTTP and returns its MCP result. */
async function callTool(
  t: Test,
  bearer: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = await mcpRequest(t, bearer, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return res.body.result as {
    isError?: boolean;
    structuredContent: Record<string, any>;
    content: { type: string; text: string }[];
  };
}

/** Lets context proposals apply without approval, as the old working tier did. */
async function automatic(owner: Caller, workspaceId: Id<"workspaces">) {
  await owner.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "automatic" });
}

async function setup() {
  const t = newTest();
  mcpTest.register(t);
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
  it("creates an API key once, stores only its hash, and 401s it after revoke", async () => {
    const { t, sam, samId, workspaceId } = await setup();
    const created = await connect(sam, { workspaceId, client: "claude", displayName: "Sam's Claude" });
    expect(created.apiKey).toMatch(/^mcp_sk_[A-Za-z0-9_-]{43}$/);
    expect(created.mcpUrl).toBe(MCP_URL);
    expect(await t.query(api.agentConnections.getMcpServerUrl, {})).toBe(MCP_URL);

    const stored = await t.run((ctx) => ctx.db.get(created.connectionId));
    expect(stored).toMatchObject({ authKind: "api_key", userId: samId, client: "claude" });
    expect(stored?.tokenHash).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(created.apiKey);

    // The key works against the real endpoint and sees all 12 tools.
    const list = await mcpRequest(t, created.apiKey, "tools/list");
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "create_document",
      "create_folder",
      "get_approvals",
      "get_file_versions",
      "get_workspace_info",
      "list_files",
      "manage_task",
      "move_file",
      "move_folder",
      "propose_context_change",
      "publish_work",
      "read_file",
      "search_files",
      "sync_workspace",
      "update_document",
    ]);

    const listed = await sam.query(api.agentConnections.listAgentConnections, {
      workspaceId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      connectionId: created.connectionId,
      userName: "Sam",
      displayName: "Sam's Claude",
      authKind: "api_key",
      lastMcpActionAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(listed)).not.toContain("tokenHash");

    await sam.mutation(api.agentConnections.revokeAgentConnection, {
      connectionId: created.connectionId,
    });
    const after = await mcpRequest(t, created.apiKey, "tools/list");
    expect(after.status).toBe(401);
    expect(after.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`,
    );
    // The connection row itself is refused too, should a credential survive.
    expect(
      await errorData(
        t.mutation(internal.mcpTools.listFiles, { principal: created.token }),
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("answers unknown, malformed and missing credentials with 401", async () => {
    const { t } = await setup();
    for (const bearer of [null, "nope", `mcp_sk_${"A".repeat(43)}`, `tdm_${"A".repeat(43)}`]) {
      const res = await mcpRequest(t, bearer, "tools/list");
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer resource_metadata=/);
    }
  });

  it("lets members see only their own connections and owners see all", async () => {
    const { alex, sam, workspaceId } = await setup();
    await connect(sam, { workspaceId, client: "claude" });
    const alexConn = await connect(alex, { workspaceId, client: "chatgpt" });
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
    // Every member sees the workspace-wide activity, without people or auth.
    const activity = await sam.query(api.agentConnections.listAgentActivity, {
      workspaceId,
    });
    expect(activity.map((a) => a.client).sort()).toEqual(["chatgpt", "claude"]);
    expect(Object.keys(activity[0]!).sort()).toEqual([
      "client",
      "lastMcpActionAt",
      "lastSyncAt",
    ]);
    // A member can't revoke someone else's connection.
    expect(
      await errorData(
        sam.mutation(api.agentConnections.revokeAgentConnection, {
          connectionId: alexConn.connectionId,
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    // A revoked connection drops out of the activity for everyone.
    await alex.mutation(api.agentConnections.revokeAgentConnection, {
      connectionId: alexConn.connectionId,
    });
    for (const member of [sam, alex]) {
      const live = await member.query(api.agentConnections.listAgentActivity, {
        workspaceId,
      });
      expect(live.map((a) => a.client)).toEqual(["claude"]);
    }
  });

  it("refuses connections for a workspace the caller isn't in, and bad clients", async () => {
    const { t, jordan, sam, workspaceId } = await setup();
    expect(
      await errorData(
        jordan.action(api.agentConnections.createAgentConnection, {
          workspaceId,
          client: "claude",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(
        sam.action(api.agentConnections.createAgentConnection, {
          workspaceId,
          client: "copilot",
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    // Nothing was half-created: no rows and no orphaned keys.
    expect(await t.run((ctx) => ctx.db.query("agent_connections").take(10))).toEqual([]);
  });

  it("refuses writes from a read-only connection inside the transaction", async () => {
    const { t, sam, workspaceId } = await setup();
    const { connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const readOnly = principalFor(connectionId, ["tandem:read"]);
    expect(
      await errorData(
        t.mutation(internal.mcpTools.createDocument, {
          principal: readOnly,
          name: "x.md",
          mimeType: "text/markdown",
          content: "",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", scope: "tandem:write" });
    // Reads still work.
    const files = await t.mutation(internal.mcpTools.listFiles, { principal: readOnly });
    expect(files.files).toEqual([]);
  });
});

describe("agent file writes", () => {
  it("rejects a stale agent write after a human edit and keeps v2 intact", async () => {
    const { t, alex, sam, samId, alexId, workspaceId } = await setup();
    const { token, connectionId } = await connect(sam, { workspaceId, client: "claude" });

    const created = await t.mutation(internal.mcpTools.createDocument, {
      principal: token,
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
        t.mutation(internal.mcpTools.updateDocument, {
          principal: token,
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
        t.mutation(internal.mcpTools.updateDocument, {
          principal: token,
          fileId: created.id,
          content: "future",
          expectedVersion: 7,
        }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2 });

    const read = await t.mutation(internal.mcpTools.readFile, {
      principal: token,
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

    const versions = await t.mutation(internal.mcpTools.getFileVersions, {
      principal: token,
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
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const first = await alex.mutation(api.files.createDocument, {
      workspaceId,
      name: "Notes.md",
      mimeType: "text/markdown",
      content: "",
    });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.createDocument, {
          principal: token,
          name: "  notes.MD ",
          mimeType: "text/markdown",
          content: "dup",
        }),
      ),
    ).toMatchObject({ code: "NAME_EXISTS", fileId: first.id, currentVersion: 1 });
  });

  it("searches names and content case-insensitively with snippets", async () => {
    const { t, sam, workspaceId } = await setup();
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    await t.mutation(internal.mcpTools.createDocument, {
      principal: token,
      name: "plan.md",
      mimeType: "text/markdown",
      content: "We will ship the DEMO on Saturday.",
    });
    await t.mutation(internal.mcpTools.createDocument, {
      principal: token,
      name: "demo-notes.md",
      mimeType: "text/markdown",
      content: "nothing here",
    });
    const results = await t.mutation(internal.mcpTools.searchFiles, {
      principal: token,
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
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const foreign = await jordan.mutation(api.files.createDocument, {
      workspaceId: otherWorkspaceId,
      name: "secret.md",
      mimeType: "text/markdown",
      content: "jordan only",
    });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.readFile, { principal: token, fileId: foreign.id }),
      ),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.updateDocument, {
          principal: token,
          fileId: foreign.id,
          content: "x",
          expectedVersion: 1,
        }),
      ),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.listFiles, { principal: token, workspaceId: otherWorkspaceId }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.createDocument, {
          principal: token,
          workspaceId: otherWorkspaceId,
          name: "x.md",
          mimeType: "text/markdown",
          content: "",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.proposeContextChange, {
          principal: token,
          field: "goal",
          proposedValue: "steal",
          rationale: "r",
          sourceFileIds: [foreign.id],
        }),
      ),
    ).toMatchObject({ code: "INVALID_SOURCE_FILE" });
    const search = await t.mutation(internal.mcpTools.searchFiles, {
      principal: token,
      query: "jordan",
      limit: 10,
    });
    expect(search).toEqual([]);
  });

  it("rejects an outsider's token once they leave the workspace", async () => {
    const { t, sam, samId, workspaceId } = await setup();
    const { token } = await connect(sam, { workspaceId, client: "claude" });
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
      await errorData(t.mutation(internal.mcpTools.listFiles, { principal: token })),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("proposals", () => {
  it("lets agents propose but never decide", async () => {
    const { t, alex, sam, samId, workspaceId } = await setup();
    const { token, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const { proposal } = await t.mutation(internal.mcpTools.proposeContextChange, {
      principal: token,
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

    const pending = await t.mutation(internal.mcpTools.getApprovals, {
      principal: token,
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
    const { token, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const snapshot = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    const startSeq = snapshot.cursorSeq;
    expect(snapshot.events.map((e) => e.seq)).toEqual(
      Array.from({ length: startSeq }, (_, i) => i + 1),
    );

    // 60 interleaved human and agent writes: more than one sync page.
    for (let i = 0; i < 30; i++) {
      await t.mutation(internal.mcpTools.createDocument, {
        principal: token,
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

    const page1 = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token,
      sinceSeq: startSeq,
      cursorWorkspaceId: workspaceId,
    });
    expect(page1.events).toHaveLength(50);
    expect(page1.eventsTruncated).toBe(true);
    const page2 = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token,
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
    const empty = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token,
      sinceSeq: page2.cursorSeq,
    });
    expect(empty.events).toEqual([]);
    expect(empty.cursorSeq).toBe(page2.cursorSeq);

    // A cursor past the head, or for another workspace, is invalid.
    expect(
      await errorData(
        t.mutation(internal.mcpTools.syncWorkspace, { principal: token, sinceSeq: 10_000 }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR" });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.syncWorkspace, {
          principal: token,
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
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const before = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    const work = await t.mutation(internal.mcpTools.publishWork, {
      principal: token,
      kind: "finding",
      title: "Latency",
      summary: "p95 is 120ms",
      fileIds: [],
    });
    expect(work.createdBy.type).toBe("agent");
    const after = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token,
      sinceSeq: before.cursorSeq,
    });
    expect(after.events.map((e) => [e.kind, e.entityId])).toEqual([
      ["work.published", work.id],
    ]);
  });
});

describe("sync published work", () => {
  it("maps full publications, attribution, caps and continuation cursors over the MCP endpoint", async () => {
    const { t, alex, sam, jordan, workspaceId, otherWorkspaceId } = await setup();
    const publisher = await connect(alex, { workspaceId, client: "claude" });
    const reader = await connect(sam, { workspaceId, client: "chatgpt" });
    const outsider = await connect(jordan, { workspaceId: otherWorkspaceId, client: "gemini" });
    const tool = async (key: string, name: string, args: Record<string, unknown> = {}) => {
      const result = await callTool(t, key, name, args);
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
      return result.structuredContent;
    };
    const file = await tool(publisher.apiKey, "create_document", { name: "finding.md", content: "Evidence" });
    const before = await tool(reader.apiKey, "sync_workspace");
    const { published } = await tool(publisher.apiKey, "publish_work", {
      kind: "finding", title: "Latency", summary: "Full finding: p95 is 120ms; cache misses dominate.", file_ids: [file.id],
    });
    const after = await tool(reader.apiKey, "sync_workspace", { since: before.cursor });
    expect(after.recent_work).toEqual([published]);
    expect(after.work_truncated).toBe(false);
    expect(published).toMatchObject({
      workspace_id: workspaceId, kind: "finding", title: "Latency",
      summary: "Full finding: p95 is 120ms; cache misses dominate.", file_ids: [file.id],
      published_by: { actor_type: "agent", client: "claude", agent_connection_id: publisher.connectionId },
      created_at: expect.any(String),
    });
    expect(new Date(published.created_at).toISOString()).toBe(published.created_at);
    expect((await tool(outsider.apiKey, "sync_workspace")).recent_work).toEqual([]);
    const forbidden = await callTool(t, outsider.apiKey, "sync_workspace", { workspace_id: workspaceId });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.structuredContent.error.code).toBe("FORBIDDEN");

    // A publication beyond this event page must wait for the continuation cursor.
    for (let version = 1; version <= 50; version++) {
      await t.mutation(internal.mcpTools.updateDocument, {
        principal: publisher.token, fileId: file.id, expectedVersion: version, content: `Update ${version}`,
      });
    }
    const backlogWork = (await tool(publisher.apiKey, "publish_work", {
      kind: "deliverable", title: "After backlog", summary: "Full deliverable", file_ids: [file.id],
    })).published;
    const first = await tool(reader.apiKey, "sync_workspace", { since: after.cursor });
    expect(first.events).toHaveLength(50);
    expect(first.events_truncated).toBe(true);
    expect(first.recent_work).toEqual([]);
    const second = await tool(reader.apiKey, "sync_workspace", { since: first.cursor });
    expect(second.events_truncated).toBe(false);
    expect(second.recent_work).toEqual([backlogWork]);
    const empty = await tool(reader.apiKey, "sync_workspace", { since: second.cursor });
    expect(empty.recent_work).toEqual([]);
    expect(empty.work_truncated).toBe(false);

    const works = [];
    for (let i = 0; i < 21; i++) {
      works.push((await tool(publisher.apiKey, "publish_work", {
        kind: "finding", title: `Finding ${i}`, summary: `Full summary ${i}`, file_ids: [file.id],
      })).published);
    }
    const capped = await tool(reader.apiKey, "sync_workspace", { since: second.cursor });
    expect(capped.recent_work).toEqual(works.slice(-20).reverse());
    expect(capped.work_truncated).toBe(true);
    const snapshot = await tool(reader.apiKey, "sync_workspace");
    expect(snapshot.recent_work).toEqual(capped.recent_work);
    expect(snapshot.work_truncated).toBe(true);
  });

  it("returns full findings since a teammate's cursor and isolates tenants", async () => {
    const { t, alex, sam, jordan, workspaceId, otherWorkspaceId } = await setup();
    const publisher = await connect(alex, {
      workspaceId, client: "claude",
    });
    const reader = await connect(sam, {
      workspaceId, client: "chatgpt",
    });
    const outsider = await connect(jordan, {
      workspaceId: otherWorkspaceId, client: "claude",
    });
    const file = await t.mutation(internal.mcpTools.createDocument, {
      principal: publisher.token, name: "latency.md", mimeType: "text/markdown", content: "p95",
    });
    const publish = (token: ReturnType<typeof principalFor>, title: string, fileIds: Id<"files">[] = []) =>
      t.mutation(internal.mcpTools.publishWork, {
        principal: token, kind: "finding", title, summary: "Full result: p95 is 120ms; cache misses dominate.", fileIds,
      });
    const old = await publish(publisher.token, "Before cursor");
    const before = await t.mutation(internal.mcpTools.syncWorkspace, { principal: reader.token });
    expect(before.recentWork).toEqual([old]);
    expect(before.workTruncated).toBe(false);
    await publish(outsider.token, "Private finding");
    const work = await publish(publisher.token, "Latency", [file.id]);
    const after = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: reader.token, sinceSeq: before.cursorSeq,
    });
    expect(after.recentWork).toEqual([work]);
    expect(after.recentWork[0]).toMatchObject({
      kind: "finding", title: "Latency", fileIds: [file.id],
      summary: "Full result: p95 is 120ms; cache misses dominate.",
      createdBy: { type: "agent", agentConnectionId: publisher.connectionId },
      createdAt: expect.any(Number),
    });
    expect(after.workTruncated).toBe(false);
    const empty = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: reader.token, sinceSeq: after.cursorSeq,
    });
    expect(empty.recentWork).toEqual([]);
    expect(empty.workTruncated).toBe(false);
    const snapshot = await t.mutation(internal.mcpTools.syncWorkspace, { principal: reader.token });
    expect(snapshot.recentWork).toEqual([work, old]);
    const other = await t.mutation(internal.mcpTools.syncWorkspace, { principal: outsider.token });
    expect(other.recentWork.map((w) => w.title)).toEqual(["Private finding"]);
    expect(await errorData(t.mutation(internal.mcpTools.syncWorkspace, {
      principal: outsider.token, workspaceId,
    }))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("delivers work exactly once while draining event pages without gaps", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const publisher = await connect(alex, {
      workspaceId, client: "claude",
    });
    const reader = await connect(sam, {
      workspaceId, client: "chatgpt",
    });
    const file = await t.mutation(internal.mcpTools.createDocument, {
      principal: publisher.token, name: "backlog.md", mimeType: "text/markdown", content: "",
    });
    const before = await t.mutation(internal.mcpTools.syncWorkspace, { principal: reader.token });
    for (let version = 1; version <= 50; version++) {
      await t.mutation(internal.mcpTools.updateDocument, {
        principal: publisher.token, fileId: file.id, expectedVersion: version, content: `Update ${version}`,
      });
    }
    const published = await t.mutation(internal.mcpTools.publishWork, {
      principal: publisher.token, kind: "finding", title: "After the backlog",
      summary: "Full finding after 50 updates", fileIds: [file.id],
    });
    const first = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: reader.token, sinceSeq: before.cursorSeq,
    });
    expect(first.events).toHaveLength(50);
    expect(first.eventsTruncated).toBe(true);
    expect(first.cursorSeq).toBe(before.cursorSeq + 50);
    expect(first.recentWork).toEqual([]);
    expect(first.workTruncated).toBe(false);
    const second = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: reader.token, sinceSeq: first.cursorSeq,
    });
    expect(second.eventsTruncated).toBe(false);
    expect(second.recentWork).toEqual([published]);
    expect(second.workTruncated).toBe(false);
    expect([...first.events, ...second.events].map((e) => e.seq)).toEqual(
      Array.from({ length: 51 }, (_, i) => before.cursorSeq + i + 1),
    );
    expect([...first.recentWork, ...second.recentWork]).toEqual([published]);
    const empty = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: reader.token, sinceSeq: second.cursorSeq,
    });
    expect(empty.events).toEqual([]);
    expect(empty.recentWork).toEqual([]);
  });

  it("caps snapshots and each incremental event page at the newest 20", async () => {
    const { t, sam, workspaceId } = await setup();
    const { token } = await connect(sam, {
      workspaceId, client: "claude",
    });
    const before = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(before.recentWork).toEqual([]);
    expect(before.workTruncated).toBe(false);
    const published = [];
    for (let i = 0; i < 55; i++) {
      published.push(await t.mutation(internal.mcpTools.publishWork, {
        principal: token, kind: i % 2 ? "finding" : "deliverable", title: `Work ${i}`, summary: `Full summary ${i}`, fileIds: [],
      }));
      if (i === 19) {
        const exact = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
        expect(exact.recentWork).toHaveLength(20);
        expect(exact.workTruncated).toBe(false);
      }
    }
    const expected = published.slice(-20).reverse();
    const snapshot = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(snapshot.recentWork).toEqual(expected);
    expect(snapshot.workTruncated).toBe(true);
    const incremental = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token, sinceSeq: before.cursorSeq });
    expect(incremental.eventsTruncated).toBe(true);
    expect(incremental.recentWork).toEqual(published.slice(30, 50).reverse());
    expect(incremental.workTruncated).toBe(true);
    const continuation = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token, sinceSeq: incremental.cursorSeq,
    });
    expect(continuation.recentWork).toEqual(published.slice(50).reverse());
    expect(continuation.eventsTruncated).toBe(false);
    expect(continuation.workTruncated).toBe(false);
  });
});

describe("ownership proposals (review M1)", () => {
  it("requires the proposed owner to be a current member, on propose and approve", async () => {
    const { t, alex, sam, samId, alexId, jordanId, workspaceId } = await setup();
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const propose = (ownerUserId: string | undefined, area = "Billing") =>
      t.mutation(internal.mcpTools.proposeContextChange, {
        principal: token,
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
        t.mutation(internal.mcpTools.proposeContextChange, {
          principal: token,
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
    const { id: first } = await alex.mutation(api.context.proposeContextChange, {
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
    const synced = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(
      synced.context.ownership.map((e) => [e.text, e.ownerUserId, e.ownerArea]),
    ).toEqual([["PAYMENTS: Sam", samId, "PAYMENTS"]]);
  });
});

describe("presence on failed calls (review L2)", () => {
  it("touchConnection records the action a failed call rolled back", async () => {
    const { t, sam, workspaceId } = await setup();
    const { token, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    expect(
      await errorData(t.mutation(internal.mcpTools.readFile, { principal: token, fileId: "nope" })),
    ).toMatchObject({ code: "FILE_NOT_FOUND" });
    // The failing mutation rolled back its own touch.
    let connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastMcpActionAt).toBeUndefined();

    const before = Date.now();
    await t.mutation(internal.mcpTools.touchConnection, { principal: token });
    connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastMcpActionAt).toBeGreaterThanOrEqual(before);
    expect(connection?.lastSyncAt).toBeUndefined();

    expect(
      await errorData(
        t.mutation(internal.mcpTools.touchConnection, { principal: principalFor("not-a-connection") }),
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("sync cursor rows (review L3)", () => {
  it("keeps one row per agent connection", async () => {
    const { t, sam, workspaceId } = await setup();
    const laptop = await connect(sam, { workspaceId, client: "claude", displayName: "Laptop" });
    const work = await connect(sam, { workspaceId, client: "claude", displayName: "Work" });
    const a = await t.mutation(internal.mcpTools.syncWorkspace, { principal: laptop.token });
    await t.mutation(internal.mcpTools.createDocument, {
      principal: work.token,
      name: "x.md",
      mimeType: "text/markdown",
      content: "",
    });
    const b = await t.mutation(internal.mcpTools.syncWorkspace, { principal: work.token });
    await t.mutation(internal.mcpTools.syncWorkspace, { principal: laptop.token, sinceSeq: a.cursorSeq });
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
    const { token } = await connect(sam, { workspaceId, client: "claude" });
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
    // The oldest file, behind 505 newer ones.
    await insert("roadmap.md", 1);
    for (let i = 0; i < 505; i++) await insert(`notes ${i}.md`, 1000 + i);

    const roadmap = await t.mutation(internal.mcpTools.listFiles, { principal: token, query: "roadmap" });
    expect(roadmap.files.map((f) => f.name)).toEqual(["roadmap.md"]);
    expect(roadmap.truncated).toBe(false);

    const notes = await t.mutation(internal.mcpTools.listFiles, { principal: token, query: "notes" });
    expect(notes.files).toHaveLength(500);
    expect(notes.truncated).toBe(true);
  });
});

describe("decideContextProposal (review L5)", () => {
  it("checks the caller before revealing whether a proposal exists", async () => {
    const { t, alex, workspaceId } = await setup();
    const { id: proposalId } = await alex.mutation(api.context.proposeContextChange, {
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
  it("lists only the connection's workspace members, with ids, names and roles but no emails", async () => {
    const { t, sam, jordan, alexId, samId, jordanId, workspaceId, otherWorkspaceId } =
      await setup();
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const result = await t.mutation(internal.mcpTools.getWorkspaceInfo, { principal: token });
    expect(result.membersTruncated).toBe(false);
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

    const theirs = await connect(jordan, { workspaceId: otherWorkspaceId, client: "claude" });
    const other = await t.mutation(internal.mcpTools.getWorkspaceInfo, { principal: theirs.token });
    expect(other.members).toEqual([
      { userId: jordanId, name: "Jordan", role: "owner" },
    ]);

    // A member with no name is shown generically, not by email.
    await t.run((ctx) => ctx.db.patch(samId, { name: undefined }));
    const unnamed = await t.mutation(internal.mcpTools.getWorkspaceInfo, { principal: token });
    expect(unnamed.members.find((m) => m.userId === samId)?.name).toBe(
      "Workspace member",
    );
    expect(JSON.stringify(unnamed)).not.toContain("@");

    // Unknown connections get nothing.
    expect(
      await errorData(
        t.mutation(internal.mcpTools.getWorkspaceInfo, { principal: principalFor("not-a-connection") }),
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
      const { token, apiKey } = await connect(sam, { workspaceId, client: "claude" });
      const before = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
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
      const after = await t.mutation(internal.mcpTools.syncWorkspace, {
        principal: token,
        sinceSeq: before.cursorSeq,
      });
      const sync = await callTool(t, apiKey, "sync_workspace");
      expect(sync.isError).not.toBe(true);
      expect(sync.structuredContent.context.goal).toBe("Ship the demo");
      expect(sync.structuredContent.context_version).toBe(result.version);
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
    const { id } = await sam.mutation(api.context.proposeContextChange, {
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
    const { connectionId } = await connect(alex, { workspaceId, client: "claude" });
    // API-key and OAuth MCP principals have no dashboard Convex Auth session.
    expect(
      await errorData(t.mutation(api.context.updateContextField, input)),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
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
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const work = await t.mutation(internal.mcpTools.publishWork, {
        principal: token,
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

describe("MCP endpoint", () => {
  it("serves the snake_case tool contract and coded errors over HTTP", async () => {
    const { t, alex, sam, samId, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });

    const info = await callTool(t, apiKey, "get_workspace_info");
    expect(info.isError).toBeUndefined();
    expect(info.structuredContent).toMatchObject({
      user: { id: samId },
      client: "claude",
      workspaces: [{ id: workspaceId, name: "Demo", role: "member", member_count: 2, is_default: true }],
      members_truncated: false,
      connection: { client: "claude", last_synced_at: null, last_action_at: null },
    });
    expect(JSON.parse(info.content[0]!.text)).toEqual(info.structuredContent);

    const created = await callTool(t, apiKey, "create_document", { name: "brief.md", content: "v1" });
    expect(created.structuredContent).toMatchObject({
      name: "brief.md",
      mime_type: "text/markdown",
      version: 1,
      updated_by: {
        actor_type: "agent",
        user_id: samId,
        client: "claude",
        agent_connection_id: connectionId,
        label: "Sam's claude assistant",
      },
    });
    const fileId = created.structuredContent.id as Id<"files">;
    await alex.mutation(api.files.updateDocument, { fileId, content: "v2", expectedVersion: 1 });

    const stale = await callTool(t, apiKey, "update_document", {
      file_id: fileId,
      content: "stale",
      expected_version: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent.error).toMatchObject({
      code: "VERSION_CONFLICT",
      file_id: fileId,
      current_version: 2,
      expected_version: 1,
    });
    expect(stale.content[0]!.text).toMatch(/^VERSION_CONFLICT: /);

    // The failed call still counts as an MCP action (presence), but not a sync.
    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastMcpActionAt).toBeTypeOf("number");
    expect(connection?.lastSyncAt).toBeUndefined();

    const sync = await callTool(t, apiKey, "sync_workspace");
    const cursor = sync.structuredContent.cursor as string;
    expect(sync.structuredContent.changed_files.map((f: { name: string }) => f.name)).toEqual(["brief.md"]);
    const again = await callTool(t, apiKey, "sync_workspace", { since: cursor });
    expect(again.structuredContent.events).toEqual([]);
    const badCursor = await callTool(t, apiKey, "sync_workspace", { since: "not-a-cursor" });
    expect(badCursor.structuredContent.error.code).toBe("INVALID_INPUT");

    // Arguments the old zod schemas rejected are coded INVALID_INPUT errors.
    const blank = await callTool(t, apiKey, "create_document", { name: "   ", content: "" });
    expect(blank.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", field: "name" });
    // Invalid names are INVALID_INPUT on MCP too, saying why.
    const slash = await callTool(t, apiKey, "create_document", { name: "bad/name.md", content: "" });
    expect(slash.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", field: "name" });
    expect(slash.structuredContent.error.message).toMatch(/contains "\/"[\s\S]*folder_path/);
    const dots = await callTool(t, apiKey, "create_folder", { path: "/ok" });
    expect(dots.isError).toBeFalsy();
    const dotMove = await callTool(t, apiKey, "move_folder", {
      folder_id: dots.structuredContent.folder.id,
      expected_revision: 1,
      to_folder_path: "/",
      new_name: "..",
    });
    expect(dotMove.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", field: "name" });
    expect(dotMove.structuredContent.error.message).toMatch(/is "\." or "\.\."/);
    // An empty path segment is INVALID_PATH, not the root.
    const slashes = await callTool(t, apiKey, "list_files", { path: "//" });
    expect(slashes.structuredContent.error).toMatchObject({ code: "INVALID_PATH", path: "//" });
    const tooMany = await callTool(t, apiKey, "search_files", { query: "v", limit: 51 });
    expect(tooMany.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", field: "limit" });

    // Another workspace's id is FORBIDDEN, named in the error.
    const foreign = await callTool(t, apiKey, "list_files", { workspace_id: "elsewhere" });
    expect(foreign.structuredContent.error).toMatchObject({ code: "FORBIDDEN", workspace_id: "elsewhere" });

    // There is no tool that decides or applies a context change.
    const list = await mcpRequest(t, apiKey, "tools/list");
    const names = list.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names.filter((n: string) => /approve|decide|apply/.test(n))).toEqual([]);
  });

  it("has scopes and annotations on every tool (mcp.lint)", async () => {
    const { mcp } = await import("./mcp");
    expect(mcp.lint()).toEqual([]);
  });
});

/** RFC 7636 S256 challenge for a verifier. */
async function pkceChallenge(verifier: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** What claude.ai does before the consent page: register, then start an authorization. */
async function startOAuth(t: Test) {
  const registered = await t.fetch("/mcp/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = "v".repeat(20) + crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state: "state-123",
    resource: MCP_URL,
  });
  const authorize = await t.fetch(`/mcp/oauth/authorize?${query}`, { method: "GET" });
  expect(authorize.status).toBe(302);
  const consent = new URL(authorize.headers.get("Location")!);
  expect(`${consent.origin}${consent.pathname}`).toBe("https://tandem.example/oauth/consent");
  return { clientId, verifier, requestId: consent.searchParams.get("request")! };
}

async function exchangeCode(t: Test, clientId: string, verifier: string, code: string) {
  const res = await t.fetch("/mcp/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    }).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

describe("OAuth consent", () => {
  it("binds claude.ai's grant to one workspace connection, attributes writes, and revokes it", async () => {
    const { t, alex, alexId, workspaceId, otherWorkspaceId } = await setup();
    const { clientId, verifier, requestId } = await startOAuth(t);

    // Signed out: nothing is revealed.
    expect(
      await errorData(t.query(api.oauth.getConsentRequest, { requestId })),
    ).toMatchObject({ code: "UNAUTHENTICATED" });

    const request = await alex.query(api.oauth.getConsentRequest, { requestId });
    expect(request).toMatchObject({
      status: "pending",
      clientName: "Claude",
      redirectHost: "claude.ai",
      suggestedClient: "claude",
      workspaces: [{ id: workspaceId, name: "Demo", role: "owner" }],
    });
    expect(request?.scopes.map((s) => s.name)).toEqual(["tandem:read", "tandem:write"]);

    // A workspace Alex isn't in is refused, and the request stays usable.
    expect(
      await errorData(
        alex.action(api.oauth.decideConsent, {
          requestId,
          approve: true,
          workspaceId: otherWorkspaceId,
          client: "claude",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await t.run((ctx) => ctx.db.query("agent_connections").take(10))).toEqual([]);

    const { redirectUrl } = await alex.action(api.oauth.decideConsent, {
      requestId,
      approve: true,
      workspaceId,
      client: "claude",
    });
    const back = new URL(redirectUrl);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("iss")).toBe(SITE);
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // The request is spent: a second decision can't mint another connection.
    expect(
      await errorData(
        alex.action(api.oauth.decideConsent, { requestId, approve: true, workspaceId, client: "claude" }),
      ),
    ).toMatchObject({ code: "REQUEST_EXPIRED" });

    const [connection] = await t.run((ctx) => ctx.db.query("agent_connections").take(10));
    expect(connection).toMatchObject({
      workspaceId,
      userId: alexId,
      client: "claude",
      authKind: "oauth",
      oauthClientName: "Claude",
    });

    const tokens = await exchangeCode(t, clientId, verifier, code);
    expect(tokens.status).toBe(200);
    expect(tokens.body.access_token).toMatch(/^mcp_at_/);
    expect(tokens.body.refresh_token).toMatch(/^mcp_rt_/);
    // Codes are single use.
    expect((await exchangeCode(t, clientId, verifier, code)).status).toBe(400);

    // The write shows as "Alex via Claude": the person plus the client.
    const created = await callTool(t, tokens.body.access_token!, "create_document", {
      name: "from-claude.md",
      content: "hello",
    });
    expect(created.structuredContent.updated_by).toMatchObject({
      actor_type: "agent",
      user_id: alexId,
      client: "claude",
      agent_connection_id: connection!._id,
    });
    const history = await alex.query(api.files.getFileVersions, {
      fileId: created.structuredContent.id,
    });
    expect(history[0]!.actor).toMatchObject({
      type: "agent",
      userId: alexId,
      userName: "Alex",
      client: "claude",
      agentConnectionId: connection!._id,
    });

    const listed = await alex.query(api.agentConnections.listAgentConnections, { workspaceId });
    expect(listed[0]).toMatchObject({ authKind: "oauth", oauthClientName: "Claude" });
    expect(listed[0]!.lastMcpActionAt).toBeTypeOf("number");

    // Revoking on the Assistants page kills the access and refresh tokens.
    await alex.mutation(api.agentConnections.revokeAgentConnection, {
      connectionId: connection!._id,
    });
    expect((await mcpRequest(t, tokens.body.access_token!, "tools/list")).status).toBe(401);
    const refreshed = await t.fetch("/mcp/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.body.refresh_token!,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshed.status).toBe(400);
  });

  it("sends a denial back to the assistant without creating a connection", async () => {
    const { t, sam } = await setup();
    const { requestId } = await startOAuth(t);
    const { redirectUrl } = await sam.action(api.oauth.decideConsent, { requestId, approve: false });
    const back = new URL(redirectUrl);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(await t.run((ctx) => ctx.db.query("agent_connections").take(10))).toEqual([]);
    // Signed-out callers can't decide.
    const { requestId: second } = await startOAuth(t);
    expect(
      await errorData(t.action(api.oauth.decideConsent, { requestId: second, approve: false })),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("refuses an approval without a workspace or with an unknown client", async () => {
    const { t, sam, workspaceId } = await setup();
    const { requestId } = await startOAuth(t);
    expect(
      await errorData(sam.action(api.oauth.decideConsent, { requestId, approve: true })),
    ).toMatchObject({ code: "INVALID_INPUT", field: "workspaceId" });
    expect(
      await errorData(
        sam.action(api.oauth.decideConsent, { requestId, approve: true, workspaceId, client: "copilot" }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT", field: "client" });
    expect(await t.run((ctx) => ctx.db.query("agent_connections").take(10))).toEqual([]);
  });

  it("publishes discovery metadata on the convex.site origin", async () => {
    const { t } = await setup();
    const prm = await (await t.fetch("/.well-known/oauth-protected-resource/mcp", { method: "GET" })).json();
    expect(prm).toMatchObject({ resource: MCP_URL, authorization_servers: [SITE] });
    const asm = await (await t.fetch("/.well-known/oauth-authorization-server", { method: "GET" })).json();
    expect(asm).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${MCP_URL}/oauth/authorize`,
      token_endpoint: `${MCP_URL}/oauth/token`,
      registration_endpoint: `${MCP_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["tandem:read", "tandem:write"],
    });
    expect(asm.device_authorization_endpoint).toBeUndefined();
  });
});

describe("context tiers (#25)", () => {
  it("records working context immediately and retains resolved questions with attribution", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    await automatic(alex, workspaceId);
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const before = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    const { proposal } = await t.mutation(internal.mcpTools.proposeContextChange, {
      principal: token,
      field: "open_question",
      proposedValue: "Who reviews the demo?",
      rationale: "Needs an answer",
      sourceFileIds: [],
    });
    expect(proposal.status).toBe("applied");
    const added = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token,
      sinceSeq: before.cursorSeq,
    });
    const question = added.context.openQuestions[0]!;
    expect(question).toMatchObject({
      text: "Who reviews the demo?",
      status: "active",
      updatedBy: { type: "agent" },
    });
    expect(question.id).toBeTruthy();
    expect(added.context.revision).toBe(before.context.revision + 1);
    expect(added.pendingProposals).toEqual([]);
    expect(added.events.some((e) => e.kind === "context.recorded")).toBe(true);
    const resolve = {
      principal: token,
      field: "open_question" as const,
      operation: "resolve" as const,
      entryId: question.id,
      proposedValue: "Resolved",
      rationale: "Alex reviews",
      sourceFileIds: [],
      expectedVersion: added.context.revision,
    };
    expect(
      (await t.mutation(internal.mcpTools.proposeContextChange, resolve)).proposal.status,
    ).toBe("applied");
    const resolved = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(resolved.context.openQuestions).toHaveLength(1);
    expect(resolved.context.openQuestions[0]).toMatchObject({
      id: question.id,
      status: "resolved",
      resolvedBy: { type: "agent" },
      resolvedAt: expect.any(Number),
    });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.proposeContextChange, {
          ...resolve,
          operation: "remove",
          expectedVersion: resolved.context.revision,
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    await alex.mutation(api.context.proposeContextChange, {
      workspaceId,
      field: "open_question",
      operation: "remove",
      entryId: question.id,
      proposedValue: "Remove",
      rationale: "Cleanup",
      sourceFileIds: [],
      expectedVersion: resolved.context.revision,
    });
    expect(
      (await alex.query(api.context.getDetails, { workspaceId })).openQuestions,
    ).toEqual([]);
  });

  it("keeps a superseding decision pending until approval and marks the previous entry as history", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    await alex.mutation(api.context.updateContextField, {
      workspaceId,
      field: "decision",
      proposedValue: "D1",
      sourceFileIds: [],
      expectedVersion: 1,
    });
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const initial = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    const d1 = initial.context.decisions[0]!;
    const { proposal } = await t.mutation(internal.mcpTools.proposeContextChange, {
      principal: token,
      field: "decision",
      proposedValue: "D2",
      rationale: "New evidence",
      sourceFileIds: [],
      supersedes: d1.id,
    });
    expect(proposal.status).toBe("pending");
    const pending = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(pending.context.decisions).toMatchObject([
      { id: d1.id, status: "active" },
    ]);
    expect(pending.pendingProposals).toMatchObject([
      { status: "pending", proposedValue: "D2", supersedes: d1.id },
    ]);
    await alex.mutation(api.context.decideContextProposal, {
      proposalId: proposal.id,
      decision: "approved",
    });
    const approved = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(approved.context.decisions).toHaveLength(2);
    expect(approved.context.decisions[0]).toMatchObject({
      id: d1.id,
      status: "superseded",
      supersededBy: approved.context.decisions[1]!.id,
    });
    expect(approved.context.decisions[1]).toMatchObject({
      text: "D2",
      status: "active",
    });
    expect(approved.pendingProposals).toEqual([]);
    // A second proposal based on the same old decision becomes stale on approval.
    const stale = await t.run(async (ctx) => {
      const id = await ctx.db.insert("context_proposals", {
        workspaceId,
        field: "decision",
        proposedValue: "D3",
        rationale: "old",
        sourceFileIds: [],
        supersedes: d1.id,
        contextRevision: 2,
        status: "pending",
        createdBy: d1.updatedBy,
        updatedBy: d1.updatedBy,
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      });
      return id;
    });
    await alex.mutation(api.context.decideContextProposal, {
      proposalId: stale,
      decision: "approved",
    });
    expect((await t.run((ctx) => ctx.db.get(stale)))?.status).toBe("stale");
  });

  it("backfills legacy IDs in pages, preserves read IDs and is idempotent", async () => {
    const { t, alex, workspaceId } = await setup();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("structured_context")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, {
        constraints: [
          {
            text: "Legacy",
            sourceFileIds: [],
            updatedBy: row!.updatedBy,
            updatedAt: 1,
          },
        ],
        decisions: [
          {
            text: "Old decision",
            sourceFileIds: [],
            updatedBy: row!.updatedBy,
            updatedAt: 1,
          },
        ],
      });
    });
    const before = await alex.query(api.context.getDetails, { workspaceId });
    const { internal } = await import("./_generated/api");
    const result = await t.mutation(
      internal.contextMigrations.backfillEntryIds,
      { paginationOpts: { numItems: 50, cursor: null } },
    );
    expect(result.migrated).toBe(1);
    const after = await alex.query(api.context.getDetails, { workspaceId });
    expect(after.constraints[0]!.id).toBe(before.constraints[0]!.id);
    expect(after.decisions[0]!.id).toBe(before.decisions[0]!.id);
    expect(after.revision).toBe(before.revision + 1);
    expect(
      (
        await t.mutation(internal.contextMigrations.backfillEntryIds, {
          paginationOpts: { numItems: 50, cursor: null },
        })
      ).migrated,
    ).toBe(0);
    expect(
      (await alex.query(api.context.getDetails, { workspaceId })).revision,
    ).toBe(after.revision);
  });
});

describe("context approval setting", () => {
  it("holds every proposal for approval by default, including findings and resolves", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const { apiKey, token } = await connect(sam, { workspaceId, client: "claude" });
    const info = (await callTool(t, apiKey, "get_workspace_info")).structuredContent;
    expect(info.workspaces[0].context_approval).toBe("manual");
    await alex.mutation(api.context.updateContextField, {
      workspaceId, field: "open_question", proposedValue: "Who reviews?", sourceFileIds: [], expectedVersion: 1,
    });
    const before = await alex.query(api.context.getDetails, { workspaceId });
    const added = await t.mutation(internal.mcpTools.proposeContextChange, {
      principal: token, field: "constraint", proposedValue: "Ship by Sunday", rationale: "Deadline", sourceFileIds: [],
    });
    expect(added.proposal).toMatchObject({ status: "pending", operation: "add" });
    const resolve = await t.mutation(internal.mcpTools.proposeContextChange, {
      principal: token, field: "open_question", operation: "resolve", entryId: before.openQuestions[0]!.id,
      expectedVersion: before.revision, rationale: "Answered", sourceFileIds: [],
    });
    expect(resolve.proposal).toMatchObject({ status: "pending", operation: "resolve", proposedValue: "Who reviews?" });
    const synced = (await callTool(t, apiKey, "sync_workspace")).structuredContent;
    expect(synced.pending_proposals.map((p: { operation: string }) => p.operation).sort()).toEqual(["add", "resolve"]);
    const unchanged = await alex.query(api.context.getDetails, { workspaceId });
    expect(unchanged.revision).toBe(before.revision);
    expect(unchanged.constraints).toEqual([]);
    expect(unchanged.openQuestions[0]).toMatchObject({ status: "active" });

    await alex.mutation(api.context.decideContextProposal, { proposalId: resolve.proposal.id, decision: "approved" });
    await alex.mutation(api.context.decideContextProposal, { proposalId: added.proposal.id, decision: "approved" });
    const approved = await alex.query(api.context.getDetails, { workspaceId });
    expect(approved.openQuestions[0]).toMatchObject({ status: "resolved" });
    expect(approved.constraints).toMatchObject([{ text: "Ship by Sunday", status: "active" }]);
  });

  it("marks a pending remove stale when its entry is already gone", async () => {
    const { alex, sam, workspaceId } = await setup();
    await alex.mutation(api.context.updateContextField, {
      workspaceId, field: "constraint", proposedValue: "No new deps", sourceFileIds: [], expectedVersion: 1,
    });
    const context = await alex.query(api.context.getDetails, { workspaceId });
    const input = {
      workspaceId, field: "constraint" as const, operation: "remove" as const, entryId: context.constraints[0]!.id,
      expectedVersion: context.revision, rationale: "Obsolete", sourceFileIds: [],
    };
    const first = await sam.mutation(api.context.proposeContextChange, input);
    const second = await sam.mutation(api.context.proposeContextChange, input);
    expect([first.status, second.status]).toEqual(["pending", "pending"]);
    await alex.mutation(api.context.decideContextProposal, { proposalId: first.id, decision: "approved" });
    expect((await alex.query(api.context.getDetails, { workspaceId })).constraints).toEqual([]);
    await alex.mutation(api.context.decideContextProposal, { proposalId: second.id, decision: "approved" });
    const proposals = await alex.query(api.context.getApprovals, { workspaceId });
    expect(proposals.find((p) => p.id === second.id)?.status).toBe("stale");
  });

  it("applies every proposal at once when automatic, and only owners or admins choose", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    expect(await errorData(sam.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "automatic" })))
      .toMatchObject({ code: "FORBIDDEN" });
    await automatic(alex, workspaceId);
    expect((await alex.query(api.workspaces.getWorkspaceInfo, { workspaceId })).contextApproval).toBe("automatic");
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const goal = await callTool(t, apiKey, "propose_context_change", {
      field: "goal", proposed_value: "Win Cal Hacks", rationale: "Kickoff",
    });
    expect(goal.structuredContent.proposal).toMatchObject({ status: "applied", field: "goal" });
    expect((await alex.query(api.context.getDetails, { workspaceId })).goal?.text).toBe("Win Cal Hacks");
    const events = await t.run((ctx) => ctx.db.query("workspace_events").collect());
    expect(events.map((e) => e.kind)).toContain("workspace.context_approval_changed");
  });
});

describe("context lifecycle review regressions", () => {
  it("preserves ownership identity when editing by ID or legacy index", async () => {
    const { alex, samId, workspaceId } = await setup();
    await alex.mutation(api.context.updateContextField, {
      workspaceId,
      field: "ownership",
      proposedValue: "Original area",
      ownerUserId: samId,
      sourceFileIds: [],
      expectedVersion: 1,
    });
    let context = await alex.query(api.context.getDetails, { workspaceId });
    const id = context.ownership[0]!.id;
    for (const target of [{ entryId: id }, { entryIndex: 0 }]) {
      await alex.mutation(api.context.updateContextField, {
        workspaceId,
        field: "ownership",
        proposedValue: `Renamed ${context.revision}`,
        ownerUserId: samId,
        sourceFileIds: [],
        expectedVersion: context.revision,
        ...target,
      });
      context = await alex.query(api.context.getDetails, { workspaceId });
      expect(context.ownership).toMatchObject([{ id, ownerUserId: samId }]);
      expect(context.ownership).toHaveLength(1);
    }
  });

  it.each([undefined, "Ignored".repeat(500)])(
    "resolves a dashboard-created long question without depending on the supplied value (%#)",
    async (proposedValue) => {
      const { t, alex, sam, workspaceId } = await setup();
      await automatic(alex, workspaceId);
      const text = "Q".repeat(3000);
      await alex.mutation(api.context.updateContextField, {
        workspaceId,
        field: "open_question",
        proposedValue: text,
        sourceFileIds: [],
        expectedVersion: 1,
      });
      const { token } = await connect(sam, { workspaceId, client: "claude" });
      const before = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
      const entry = before.context.openQuestions[0]!;
      const result = await t.mutation(internal.mcpTools.proposeContextChange, {
        principal: token,
        field: "open_question",
        operation: "resolve",
        entryId: entry.id,
        expectedVersion: before.context.revision,
        ...(proposedValue === undefined ? {} : { proposedValue }),
        rationale: "Answered",
        sourceFileIds: [],
      });
      expect(result.proposal).toMatchObject({
        status: "applied",
        proposedValue: text,
      });
      const after = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
      expect(after.context.openQuestions[0]).toMatchObject({
        id: entry.id,
        text,
        status: "resolved",
        resolvedBy: { type: "agent" },
        resolvedAt: expect.any(Number),
      });
      await alex.mutation(api.context.proposeContextChange, {
        workspaceId,
        field: "open_question",
        operation: "remove",
        entryId: entry.id,
        expectedVersion: after.context.revision,
        rationale: "Cleanup",
        sourceFileIds: [],
      });
      expect(
        (await alex.query(api.context.getDetails, { workspaceId }))
          .openQuestions,
      ).toEqual([]);
    },
  );
});

describe("context tiers over the hosted MCP contract", () => {
  it("maps stable IDs, lifecycle attribution and pending supersession through real tool handlers", async () => {
    const { t, alex, sam, samId, workspaceId } = await setup();
    await automatic(alex, workspaceId);
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const added = await callTool(t, apiKey, "propose_context_change", {
      field: "open_questions", proposed_value: "Who reviews?", rationale: "Planning",
    });
    expect(added.isError).toBeUndefined();
    expect(added.structuredContent.proposal).toMatchObject({ status: "applied", field: "open_questions", supersedes: null });
    const sync = (await callTool(t, apiKey, "sync_workspace")).structuredContent;
    const question = sync.context.open_questions[0];
    expect(question).toMatchObject({ id: expect.any(String), status: "active", resolved_at: null, resolved_by: null,
      updated_by: { actor_type: "agent", user_id: samId, agent_connection_id: connectionId }, source_ids: [] });
    expect(sync.pending_proposals).toEqual([]);
    const resolved = await callTool(t, apiKey, "propose_context_change", {
      field: "open_questions", operation: "resolve", entry_id: question.id, expected_version: sync.context_version,
      rationale: "Answered", proposed_value: "Ignored".repeat(500),
    });
    expect(resolved.structuredContent.proposal).toMatchObject({ status: "applied", proposed_value: "Who reviews?" });
    const after = (await callTool(t, apiKey, "sync_workspace")).structuredContent;
    expect(after.context.open_questions[0]).toMatchObject({ id: question.id, status: "resolved", resolved_at: expect.any(Number),
      resolved_by: { actor_type: "agent", agent_connection_id: connectionId } });
    await alex.mutation(api.context.updateContextField, { workspaceId, field: "decision", proposedValue: "D1", sourceFileIds: [], expectedVersion: after.context_version });
    await alex.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "manual" });
    const initial = (await callTool(t, apiKey, "sync_workspace")).structuredContent;
    const d1 = initial.context.decisions[0];
    const replacement = (await callTool(t, apiKey, "propose_context_change", {
      field: "decisions", proposed_value: "D2", rationale: "New evidence", supersedes: d1.id,
    })).structuredContent.proposal;
    expect(replacement).toMatchObject({ status: "pending", supersedes: d1.id });
    const pending = (await callTool(t, apiKey, "sync_workspace")).structuredContent;
    expect(pending.context.decisions).toMatchObject([{ id: d1.id, status: "active" }]);
    expect(pending.pending_proposals).toMatchObject([{ id: replacement.id, status: "pending", proposed_value: "D2", supersedes: d1.id }]);
    await alex.mutation(api.context.decideContextProposal, { proposalId: replacement.id, decision: "approved" });
    const approved = (await callTool(t, apiKey, "sync_workspace")).structuredContent;
    expect(approved.context.decisions[0]).toMatchObject({ id: d1.id, status: "superseded", superseded_by: approved.context.decisions[1].id });
    expect(approved.context.decisions[1]).toMatchObject({ text: "D2", status: "active" });
    const recorded = await callTool(t, apiKey, "get_approvals", { status: "applied" });
    expect(recorded.structuredContent.proposals.map((p: { status: string }) => p.status)).toEqual(["applied", "applied"]);
    const missing = await callTool(t, apiKey, "propose_context_change", { field: "goal", rationale: "Missing addition value" });
    expect(missing.structuredContent.error.code).toBe("INVALID_INPUT");
  });
});

describe("context references after source deletion (#27)", () => {
  async function sourcedContext(field: "open_question" | "goal" = "open_question") {
    const state = await setup();
    const { alex, workspaceId } = state;
    const file = await alex.mutation(api.files.createDocument, {
      workspaceId, name: "source.md", mimeType: "text/markdown", content: "Evidence",
    });
    await alex.mutation(api.context.updateContextField, {
      workspaceId, field, proposedValue: "Original", sourceFileIds: [file.id], expectedVersion: 1,
    });
    await alex.mutation(api.files.deleteFile, { fileId: file.id, expectedVersion: file.version });
    const context = await alex.query(api.context.getDetails, { workspaceId });
    return { ...state, file, context };
  }

  it.each(["id", "index"])("edits an existing question with a deleted source by %s", async (target) => {
    const { alex, workspaceId, file, context } = await sourcedContext();
    const question = context.openQuestions[0]!;
    await alex.mutation(api.context.updateContextField, {
      workspaceId, field: "open_question", proposedValue: "Edited", sourceFileIds: [file.id],
      expectedVersion: context.revision, ...(target === "id" ? { entryId: question.id } : { entryIndex: 0 }),
    });
    expect((await alex.query(api.context.getDetails, { workspaceId })).openQuestions[0])
      .toMatchObject({ id: question.id, text: "Edited", sourceFileIds: [file.id] });
  });

  it.each(["dashboard", "MCP"])("resolves a question with a deleted source through %s, then removes it", async (caller) => {
    const { t, alex, sam, workspaceId, file, context } = await sourcedContext();
    await automatic(alex, workspaceId);
    const input = {
      field: "open_question" as const, operation: "resolve" as const,
      entryId: context.openQuestions[0]!.id, rationale: "Answered", sourceFileIds: [file.id],
      expectedVersion: context.revision,
    };
    if (caller === "MCP") {
      const { token } = await connect(sam, { workspaceId, client: "claude" });
      await t.mutation(internal.mcpTools.proposeContextChange, { ...input, principal: token });
    } else await alex.mutation(api.context.proposeContextChange, { ...input, workspaceId });
    const resolved = await alex.query(api.context.getDetails, { workspaceId });
    expect(resolved.openQuestions[0]).toMatchObject({ status: "resolved", sourceFileIds: [file.id] });
    await alex.mutation(api.context.proposeContextChange, {
      ...input, workspaceId, operation: "remove", expectedVersion: resolved.revision,
    });
    expect((await alex.query(api.context.getDetails, { workspaceId })).openQuestions).toEqual([]);
  });

  it("edits and proposes an existing goal with a deleted source, then approves it", async () => {
    const { t, alex, sam, workspaceId, file, context } = await sourcedContext("goal");
    await alex.mutation(api.context.updateContextField, {
      workspaceId, field: "goal", proposedValue: "Edited goal", sourceFileIds: [file.id], expectedVersion: context.revision,
    });
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    const { proposal } = await t.mutation(internal.mcpTools.proposeContextChange, {
      principal: token, field: "goal", proposedValue: "Proposed goal", rationale: "Updated", sourceFileIds: [file.id],
    });
    expect(proposal.status).toBe("pending");
    await alex.mutation(api.context.decideContextProposal, { proposalId: proposal.id, decision: "approved" });
    expect((await alex.query(api.context.getDetails, { workspaceId })).goal)
      .toMatchObject({ text: "Proposed goal", sourceFileIds: [file.id] });
  });

  it("rejects adding an unrelated deleted source during edit or resolve", async () => {
    const { alex, workspaceId, file, context } = await sourcedContext();
    await alex.mutation(api.context.updateContextField, {
      workspaceId, field: "open_question", proposedValue: "Unsourced", sourceFileIds: [], expectedVersion: context.revision,
    });
    const current = await alex.query(api.context.getDetails, { workspaceId });
    const entryId = current.openQuestions[1]!.id;
    await expect(alex.mutation(api.context.updateContextField, {
      workspaceId, field: "open_question", proposedValue: "Edited", sourceFileIds: [file.id], entryId, expectedVersion: current.revision,
    })).rejects.toThrow("INVALID_SOURCE_FILE");
    await expect(alex.mutation(api.context.proposeContextChange, {
      workspaceId, field: "open_question", operation: "resolve", entryId, rationale: "Answered", sourceFileIds: [file.id], expectedVersion: current.revision,
    })).rejects.toThrow("INVALID_SOURCE_FILE");
  });

  it("approves a pending proposal whose source was deleted after submission", async () => {
    const { alex, workspaceId } = await setup();
    const file = await alex.mutation(api.files.createDocument, {
      workspaceId, name: "source.md", mimeType: "text/markdown", content: "Evidence",
    });
    const proposal = await alex.mutation(api.context.proposeContextChange, {
      workspaceId, field: "decision", proposedValue: "Approved decision", rationale: "Evidence", sourceFileIds: [file.id],
    });
    await alex.mutation(api.files.deleteFile, { fileId: file.id, expectedVersion: file.version });
    await alex.mutation(api.context.decideContextProposal, { proposalId: proposal.id, decision: "approved" });
    expect((await alex.query(api.context.getDetails, { workspaceId })).decisions[0])
      .toMatchObject({ text: "Approved decision", sourceFileIds: [file.id] });
  });

  it("rejects new deleted or nonexistent sources even when another entry already links them", async () => {
    const { t, alex, workspaceId, file, context } = await sourcedContext();
    const missing = await alex.mutation(api.files.createDocument, {
      workspaceId, name: "missing.md", mimeType: "text/markdown", content: "",
    });
    await t.run((ctx) => ctx.db.delete(missing.id));
    for (const sourceFileIds of [[file.id], [missing.id]]) {
      await expect(alex.mutation(api.context.updateContextField, {
        workspaceId, field: "open_question", proposedValue: "New", sourceFileIds, expectedVersion: context.revision,
      })).rejects.toThrow("INVALID_SOURCE_FILE");
      await expect(alex.mutation(api.context.proposeContextChange, {
        workspaceId, field: "decision", proposedValue: "New", rationale: "New", sourceFileIds,
      })).rejects.toThrow("INVALID_SOURCE_FILE");
      await expect(alex.mutation(api.context.updateContextField, {
        workspaceId, field: "goal", proposedValue: "Unrelated goal", sourceFileIds, expectedVersion: context.revision,
      })).rejects.toThrow("INVALID_SOURCE_FILE");
    }
  });
});

describe("restore revision (#26)", () => {
  it("appends v1 of a v3 file as human-authored v4, preserves history and serves it to MCP", async () => {
    const { t, alex, sam, alexId, workspaceId } = await setup();
    const file = await alex.mutation(api.files.createDocument, {
      workspaceId, name: "restore.md", mimeType: "text/markdown", content: "original",
    });
    await alex.mutation(api.files.updateDocument, { fileId: file.id, expectedVersion: 1, content: "second" });
    await sam.mutation(api.files.updateDocument, { fileId: file.id, expectedVersion: 2, content: "third" });
    const before = await alex.query(api.files.getFileVersions, { fileId: file.id });
    const restored = await alex.mutation(api.files.restoreRevision, { fileId: file.id, version: 1, expectedVersion: 3 });
    expect(restored).toMatchObject({ version: 4, updatedBy: { type: "human", userId: alexId } });
    const after = await alex.query(api.files.getFileVersions, { fileId: file.id });
    expect(after.map((r) => r.version)).toEqual([4, 3, 2, 1]);
    expect(after.slice(1)).toEqual(before);
    const events = await t.run((ctx) => ctx.db.query("workspace_events")
      .withIndex("by_workspace_and_entity", (q) => q.eq("workspaceId", workspaceId).eq("entityType", "file").eq("entityId", file.id)).take(10));
    expect(events).toHaveLength(4);
    expect(events[3]).toMatchObject({ kind: "file.updated", summary: "Restored v1 as v4 for restore.md", actor: { type: "human", userId: alexId } });
    const { token } = await connect(sam, { workspaceId, client: "claude" });
    expect(await t.mutation(internal.mcpTools.readFile, { principal: token, fileId: file.id }))
      .toMatchObject({ file: { version: 4, updatedBy: { type: "human", userId: alexId } }, content: "original" });
    expect(await alex.query(api.files.getFileRevision, { fileId: file.id, version: 4 }))
      .toMatchObject({ content: "original", actor: { type: "human", userId: alexId } });
  });

  it("rejects stale restores without changing content, history or events", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const file = await alex.mutation(api.files.createDocument, { workspaceId, name: "race.txt", mimeType: "text/plain", content: "original" });
    await sam.mutation(api.files.updateDocument, { fileId: file.id, expectedVersion: 1, content: "newer" });
    expect(await errorData(alex.mutation(api.files.restoreRevision, { fileId: file.id, version: 1, expectedVersion: 1 })))
      .toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2, currentContent: "newer" });
    expect(await alex.query(api.files.readFile, { fileId: file.id })).toMatchObject({ file: { version: 2 }, content: "newer" });
    expect(await alex.query(api.files.getFileVersions, { fileId: file.id })).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("workspace_events").withIndex("by_workspace_and_entity", (q) => q.eq("workspaceId", workspaceId).eq("entityType", "file").eq("entityId", file.id)).take(10))).toHaveLength(2);
  });

  it("requires membership and rejects missing or invalid versions", async () => {
    const { t, alex, jordan, workspaceId } = await setup();
    const file = await alex.mutation(api.files.createDocument, { workspaceId, name: "member.txt", mimeType: "text/plain", content: "" });
    const args = { fileId: file.id, version: 1, expectedVersion: 1 };
    expect(await errorData(t.mutation(api.files.restoreRevision, args))).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await errorData(jordan.mutation(api.files.restoreRevision, args))).toMatchObject({ code: "FILE_NOT_FOUND" });
    for (const version of [0, 1.5, 99]) {
      expect(await errorData(alex.mutation(api.files.restoreRevision, { ...args, version }))).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await errorData(alex.mutation(api.files.restoreRevision, { ...args, expectedVersion: 0 }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await alex.query(api.files.getFileVersions, { fileId: file.id })).toHaveLength(1);
  });
});

describe("file system tools (docs/filesystem.md)", () => {
  async function fsSetup() {
    const base = await setup();
    const { token, connectionId, apiKey } = await connect(base.sam, {
      workspaceId: base.workspaceId,
      client: "claude",
    });
    return { ...base, token, connectionId, apiKey };
  }

  it("create_folder is mkdir -p, idempotent and attributed to the agent", async () => {
    const { t, token, connectionId, samId, workspaceId } = await fsSetup();
    const first = await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/specs/api" });
    expect(first.created).toBe(true);
    expect(first.folder).toMatchObject({ name: "api", path: "/specs/api", revision: 1 });
    expect(first.folder.updatedBy).toMatchObject({ type: "agent", userId: samId, agentConnectionId: connectionId });

    // Same path, different case and slashes: the existing folder, nothing written.
    const again = await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "SPECS/Api/" });
    expect(again).toMatchObject({ created: false, folder: { id: first.folder.id, path: "/specs/api" } });
    const folders = await t.run((ctx) =>
      ctx.db.query("folders").withIndex("by_workspace_and_parent_and_name_key", (q) => q.eq("workspaceId", workspaceId)).collect(),
    );
    expect(folders).toHaveLength(2);
    const events = await t.run((ctx) => ctx.db.query("workspace_events").collect());
    expect(events.filter((e) => e.kind === "folder.created")).toHaveLength(2);
    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.lastMcpActionAt).toBeTypeOf("number");

    // A deeper path reuses the prefix.
    const deeper = await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/specs/api/v2" });
    expect(deeper).toMatchObject({ created: true, folder: { parentId: first.folder.id, path: "/specs/api/v2" } });

    expect(await errorData(t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/" }))).toMatchObject({
      code: "INVALID_PATH",
    });
    expect(await errorData(t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/a/../b" }))).toMatchObject({
      code: "INVALID_PATH",
    });
    await t.mutation(internal.mcpTools.createDocument, {
      principal: token,
      folderPath: "/specs",
      name: "notes.md",
      mimeType: "text/markdown",
      content: "",
    });
    expect(
      await errorData(t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/specs/notes.md/x" })),
    ).toMatchObject({ code: "NAME_EXISTS", kind: "file", name: "notes.md" });

    // Read-only connections can't create folders.
    const readOnly = { ...token, scopes: ["tandem:read"] };
    expect(await errorData(t.mutation(internal.mcpTools.createFolder, { principal: readOnly, path: "/x" }))).toMatchObject({
      code: "FORBIDDEN",
      scope: "tandem:write",
    });
  });

  it("create_document places files by folder_path or parent_id, and read_file reads by path", async () => {
    const { t, token, jordan, otherWorkspaceId } = await fsSetup();
    const { folder } = await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/Specs/API" });
    const doc = (args: { parentId?: string; folderPath?: string; name: string }) =>
      t.mutation(internal.mcpTools.createDocument, {
        principal: token,
        mimeType: "text/markdown",
        content: `# ${args.name}`,
        ...args,
      });

    const byPath = await doc({ folderPath: "specs/api", name: "endpoints.md" });
    expect(byPath).toMatchObject({ parentId: folder.id, path: "/Specs/API/endpoints.md", version: 1 });
    const byId = await doc({ parentId: folder.id, name: "auth.md" });
    expect(byId).toMatchObject({ parentId: folder.id, path: "/Specs/API/auth.md" });
    const atRoot = await doc({ name: "readme.md" });
    expect(atRoot).toMatchObject({ parentId: null, path: "/readme.md" });

    expect(await errorData(doc({ folderPath: "/specs/missing", name: "x.md" }))).toMatchObject({
      code: "PATH_NOT_FOUND",
      path: "/specs/missing",
    });
    expect(await errorData(doc({ folderPath: "/readme.md", name: "x.md" }))).toMatchObject({
      code: "PATH_NOT_FOUND",
      found: "file",
    });
    expect(await errorData(doc({ parentId: folder.id, folderPath: "/specs", name: "x.md" }))).toMatchObject({
      code: "INVALID_INPUT",
    });
    // Files and folders share one namespace per folder.
    expect(await errorData(doc({ folderPath: "/specs", name: "api" }))).toMatchObject({
      code: "NAME_EXISTS",
      kind: "folder",
      folderId: folder.id,
    });
    expect(await errorData(doc({ name: "a/b.md" }))).toMatchObject({ code: "INVALID_NAME" });
    // Another workspace's folder looks missing.
    const foreign = await jordan.mutation(api.folders.createFolder, { workspaceId: otherWorkspaceId, name: "theirs" });
    expect(await errorData(doc({ parentId: foreign.id, name: "x.md" }))).toMatchObject({ code: "FOLDER_NOT_FOUND" });

    const read = await t.mutation(internal.mcpTools.readFile, { principal: token, path: "/SPECS/api/ENDPOINTS.md" });
    expect(read).toMatchObject({ file: { id: byPath.id, path: "/Specs/API/endpoints.md" }, content: "# endpoints.md" });
    const readById = await t.mutation(internal.mcpTools.readFile, { principal: token, fileId: byPath.id });
    expect(readById.file.path).toBe("/Specs/API/endpoints.md");
    expect(await errorData(t.mutation(internal.mcpTools.readFile, { principal: token, path: "/specs/api" }))).toMatchObject({
      code: "PATH_NOT_FOUND",
      found: "folder",
    });
    expect(await errorData(t.mutation(internal.mcpTools.readFile, { principal: token, path: "/nope.md" }))).toMatchObject({
      code: "PATH_NOT_FOUND",
      expected: "file",
    });
    expect(await errorData(t.mutation(internal.mcpTools.readFile, { principal: token }))).toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("list_files lists the root, a folder, a subtree and name matches with paths", async () => {
    const { t, token } = await fsSetup();
    const mk = (path: string) => t.mutation(internal.mcpTools.createFolder, { principal: token, path });
    const doc = (folderPath: string | undefined, name: string) =>
      t.mutation(internal.mcpTools.createDocument, {
        principal: token,
        folderPath,
        name,
        mimeType: "text/markdown",
        content: "",
      });
    const specs = (await mk("/specs")).folder;
    const api = (await mk("/specs/api")).folder;
    await mk("/archive");
    await doc(undefined, "readme.md");
    await doc("/specs", "overview.md");
    await doc("/specs/api", "endpoints.md");
    await doc("/archive", "old endpoints.md");
    const list = (args: { folderId?: string; path?: string; recursive?: boolean; query?: string }) =>
      t.mutation(internal.mcpTools.listFiles, { principal: token, ...args });

    const root = await list({});
    expect(root.folder).toEqual({ id: null, path: "/" });
    expect(root.folders.map((f) => f.path)).toEqual(["/archive", "/specs"]);
    expect(root.files.map((f) => f.path)).toEqual(["/readme.md"]);
    expect(root.truncated).toBe(false);

    const byPath = await list({ path: "/SPECS" });
    expect(byPath.folder).toEqual({ id: specs.id, path: "/specs" });
    expect(byPath.folders.map((f) => [f.path, f.revision])).toEqual([["/specs/api", 1]]);
    expect(byPath.files.map((f) => f.path)).toEqual(["/specs/overview.md"]);
    const byId = await list({ folderId: api.id });
    expect(byId.files.map((f) => f.path)).toEqual(["/specs/api/endpoints.md"]);

    const everything = await list({ recursive: true });
    expect(everything.folders.map((f) => f.path)).toEqual(["/archive", "/specs", "/specs/api"]);
    expect(everything.files.map((f) => f.path)).toEqual([
      "/archive/old endpoints.md",
      "/readme.md",
      "/specs/api/endpoints.md",
      "/specs/overview.md",
    ]);
    const subtree = await list({ path: "/specs", recursive: true });
    expect(subtree.folders.map((f) => f.path)).toEqual(["/specs/api"]);
    expect(subtree.files.map((f) => f.path)).toEqual(["/specs/api/endpoints.md", "/specs/overview.md"]);

    const matches = await list({ query: "endpoints" });
    expect(matches.files.map((f) => f.path)).toEqual(["/archive/old endpoints.md", "/specs/api/endpoints.md"]);
    const scoped = await list({ path: "/specs", query: "endpoints" });
    expect(scoped.files.map((f) => f.path)).toEqual(["/specs/api/endpoints.md"]);
    // Folder names match too.
    expect((await list({ query: "api" })).folders.map((f) => f.path)).toEqual(["/specs/api"]);

    expect(await errorData(list({ path: "/missing" }))).toMatchObject({ code: "PATH_NOT_FOUND" });
    expect(await errorData(list({ folderId: "not-a-folder" }))).toMatchObject({ code: "FOLDER_NOT_FOUND" });
  });

  it("move_file writes version N+1 with the same content and rejects stale versions", async () => {
    const { t, token, alex } = await fsSetup();
    const { folder: archive } = await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/archive" });
    const file = await t.mutation(internal.mcpTools.createDocument, {
      principal: token,
      name: "plan.md",
      mimeType: "text/markdown",
      content: "the plan",
    });

    const moved = await t.mutation(internal.mcpTools.moveFile, {
      principal: token,
      fileId: file.id,
      expectedVersion: 1,
      toFolderPath: "/Archive",
    });
    expect(moved).toMatchObject({ version: 2, parentId: archive.id, path: "/archive/plan.md" });
    const revisions = await t.run((ctx) =>
      ctx.db.query("file_revisions").withIndex("by_file_and_version", (q) => q.eq("fileId", file.id)).collect(),
    );
    expect(revisions.map((r) => [r.version, r.content])).toEqual([[1, "the plan"], [2, "the plan"]]);
    const events = await t.run((ctx) => ctx.db.query("workspace_events").collect());
    expect(events.at(-1)).toMatchObject({ kind: "file.moved", entityId: file.id, summary: "Moved plan.md to /archive" });

    expect(
      await errorData(
        t.mutation(internal.mcpTools.moveFile, { principal: token, fileId: file.id, expectedVersion: 1, toFolderPath: "/" }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2, expectedVersion: 1 });

    // A human edit makes the agent's version stale.
    await alex.mutation(api.files.updateDocument, { fileId: file.id, content: "edited", expectedVersion: 2 });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.moveFile, { principal: token, fileId: file.id, expectedVersion: 2, toFolderPath: "/" }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 3 });

    const back = await t.mutation(internal.mcpTools.moveFile, {
      principal: token,
      fileId: file.id,
      expectedVersion: 3,
      toFolderPath: "/",
      newName: "Plan v2.md",
    });
    expect(back).toMatchObject({ version: 4, parentId: null, name: "Plan v2.md", path: "/Plan v2.md" });
    expect((await t.mutation(internal.mcpTools.readFile, { principal: token, path: "/plan v2.md" })).content).toBe("edited");

    expect(
      await errorData(t.mutation(internal.mcpTools.moveFile, { principal: token, fileId: file.id, expectedVersion: 4 })),
    ).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("move_folder moves a subtree, rejects cycles and stale revisions", async () => {
    const { t, token } = await fsSetup();
    const mk = (path: string) => t.mutation(internal.mcpTools.createFolder, { principal: token, path });
    const a = (await mk("/a")).folder;
    const c = (await mk("/a/b/c")).folder;
    await mk("/z");
    await t.mutation(internal.mcpTools.createDocument, {
      principal: token,
      folderPath: "/a/b/c",
      name: "deep.md",
      mimeType: "text/markdown",
      content: "",
    });

    expect(
      await errorData(
        t.mutation(internal.mcpTools.moveFolder, { principal: token, folderId: a.id, expectedRevision: 1, toFolderId: c.id }),
      ),
    ).toMatchObject({ code: "INVALID_MOVE", folderId: a.id });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.moveFolder, { principal: token, folderId: a.id, expectedRevision: 1, toFolderPath: "/a" }),
      ),
    ).toMatchObject({ code: "INVALID_MOVE" });

    const moved = await t.mutation(internal.mcpTools.moveFolder, {
      principal: token,
      folderId: a.id,
      expectedRevision: 1,
      toFolderPath: "/z",
      newName: "alpha",
    });
    expect(moved).toMatchObject({ id: a.id, path: "/z/alpha", revision: 2 });
    const read = await t.mutation(internal.mcpTools.readFile, { principal: token, path: "/z/alpha/b/c/deep.md" });
    expect(read.file.path).toBe("/z/alpha/b/c/deep.md");

    expect(
      await errorData(
        t.mutation(internal.mcpTools.moveFolder, { principal: token, folderId: a.id, expectedRevision: 1, toFolderPath: "/" }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentRevision: 2, expectedRevision: 1 });
    // Moving to where it already is changes nothing (review L2).
    const same = await t.mutation(internal.mcpTools.moveFolder, {
      principal: token,
      folderId: a.id,
      expectedRevision: 2,
      toFolderPath: "/z",
    });
    expect(same.revision).toBe(2);
  });

  it("sync_workspace lists folders and paths, and folder events after since", async () => {
    const { t, token } = await fsSetup();
    await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/specs/api" });
    await t.mutation(internal.mcpTools.createDocument, {
      principal: token,
      folderPath: "/specs/api",
      name: "endpoints.md",
      mimeType: "text/markdown",
      content: "",
    });
    const snapshot = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(snapshot.folders.map((f) => f.path)).toEqual(["/specs", "/specs/api"]);
    expect(snapshot.foldersTruncated).toBe(false);
    expect(snapshot.changedFiles.map((f) => f.path)).toEqual(["/specs/api/endpoints.md"]);

    const { folder: archive } = await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/archive" });
    const specs = snapshot.folders.find((f) => f.path === "/specs")!;
    await t.mutation(internal.mcpTools.moveFolder, {
      principal: token,
      folderId: specs.id,
      expectedRevision: specs.revision,
      toFolderId: archive.id,
    });
    const delta = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token,
      sinceSeq: snapshot.cursorSeq,
      cursorWorkspaceId: snapshot.workspace.id,
    });
    expect(delta.events.map((e) => [e.kind, e.entityType])).toEqual([
      ["folder.created", "folder"],
      ["folder.moved", "folder"],
    ]);
    expect(delta.events[1]!.summary).toBe("Moved folder specs to /archive");
    // Folders are listed on every sync, with current paths.
    expect(delta.folders.map((f) => f.path)).toEqual(["/archive", "/archive/specs", "/archive/specs/api"]);
  });

  it("serves the folder tools' snake_case contract and coded errors over HTTP", async () => {
    const { t, apiKey } = await fsSetup();
    const created = await callTool(t, apiKey, "create_folder", { path: "/specs/api" });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({
      created: true,
      folder: { name: "api", path: "/specs/api", revision: 1, parent_id: expect.any(String) },
    });
    expect(created.structuredContent.folder.updated_at).toMatch(/Z$/);
    const again = await callTool(t, apiKey, "create_folder", { path: "/specs/api" });
    expect(again.structuredContent.created).toBe(false);

    const doc = await callTool(t, apiKey, "create_document", { name: "a.md", content: "x", folder_path: "/specs" });
    expect(doc.structuredContent).toMatchObject({ name: "a.md", path: "/specs/a.md", version: 1 });
    const fileId = doc.structuredContent.id as string;

    const listed = await callTool(t, apiKey, "list_files", { path: "/specs" });
    expect(listed.structuredContent).toMatchObject({
      folder: { path: "/specs" },
      folders: [{ name: "api", path: "/specs/api", revision: 1 }],
      files: [{ id: fileId, path: "/specs/a.md" }],
      truncated: false,
    });
    const read = await callTool(t, apiKey, "read_file", { path: "/specs/A.md" });
    expect(read.structuredContent).toMatchObject({ file: { id: fileId, path: "/specs/a.md" }, content: "x" });
    const searched = await callTool(t, apiKey, "search_files", { query: "a.md" });
    expect(searched.structuredContent.results[0].file.path).toBe("/specs/a.md");

    const moved = await callTool(t, apiKey, "move_file", { file_id: fileId, expected_version: 1, to_folder_path: "/specs/api" });
    expect(moved.structuredContent).toMatchObject({ id: fileId, version: 2, path: "/specs/api/a.md" });
    const stale = await callTool(t, apiKey, "move_file", { file_id: fileId, expected_version: 1, to_folder_path: "/" });
    expect(stale.structuredContent.error).toMatchObject({
      code: "VERSION_CONFLICT",
      file_id: fileId,
      current_version: 2,
      expected_version: 1,
    });
    expect(stale.structuredContent.error.message).toMatch(/retry move_file with expected_version=2/);

    const specsId = created.structuredContent.folder.parent_id as string;
    const cycle = await callTool(t, apiKey, "move_folder", {
      folder_id: specsId,
      expected_revision: 1,
      to_folder_path: "/specs/api",
    });
    expect(cycle.structuredContent.error).toMatchObject({ code: "INVALID_MOVE", folder_id: specsId });
    const staleFolder = await callTool(t, apiKey, "move_folder", {
      folder_id: specsId,
      expected_revision: 5,
      to_folder_path: "/",
    });
    expect(staleFolder.structuredContent.error).toMatchObject({
      code: "VERSION_CONFLICT",
      folder_id: specsId,
      current_revision: 1,
      expected_revision: 5,
    });

    const missing = await callTool(t, apiKey, "create_document", { name: "b.md", content: "", folder_path: "/nope" });
    expect(missing.structuredContent.error).toMatchObject({ code: "PATH_NOT_FOUND", path: "/nope" });
    expect(missing.structuredContent.error.message).toMatch(/create_folder/);
    const clash = await callTool(t, apiKey, "create_document", { name: "API", content: "", folder_path: "/specs" });
    expect(clash.structuredContent.error).toMatchObject({ code: "NAME_EXISTS", kind: "folder", name: "api" });
    const badPath = await callTool(t, apiKey, "list_files", { path: "/specs//api" });
    expect(badPath.structuredContent.error).toMatchObject({ code: "INVALID_PATH", path: "/specs//api" });
    const noFolder = await callTool(t, apiKey, "list_files", { folder_id: "nope" });
    expect(noFolder.structuredContent.error).toMatchObject({ code: "FOLDER_NOT_FOUND", folder_id: "nope" });
    const both = await callTool(t, apiKey, "read_file", { file_id: fileId, path: "/specs/api/a.md" });
    expect(both.structuredContent.error.code).toBe("INVALID_INPUT");
    const noDest = await callTool(t, apiKey, "move_file", { file_id: fileId, expected_version: 2 });
    expect(noDest.structuredContent.error.code).toBe("INVALID_INPUT");

    const sync = await callTool(t, apiKey, "sync_workspace");
    expect(sync.structuredContent.folders.map((f: { path: string }) => f.path)).toEqual(["/specs", "/specs/api"]);
    expect(sync.structuredContent.folders_truncated).toBe(false);
    expect(sync.structuredContent.changed_files[0].path).toBe("/specs/api/a.md");
  });
});

describe("file system review fixes (PR #47)", () => {
  async function fsSetup() {
    const base = await setup();
    const { token, apiKey } = await connect(base.sam, { workspaceId: base.workspaceId, client: "claude" });
    const mk = (path: string) => base.t.mutation(internal.mcpTools.createFolder, { principal: token, path });
    const doc = (folderPath: string | undefined, name: string) =>
      base.t.mutation(internal.mcpTools.createDocument, {
        principal: token,
        folderPath,
        name,
        mimeType: "text/markdown",
        content: name,
      });
    const list = (args: { path?: string; recursive?: boolean; query?: string }) =>
      base.t.mutation(internal.mcpTools.listFiles, { principal: token, ...args });
    const eventCount = () => base.t.run(async (ctx) => (await ctx.db.query("workspace_events").collect()).length);
    return { ...base, token, apiKey, mk, doc, list, eventCount };
  }

  it("list_files query matches files and folders by one substring rule (M1)", async () => {
    const { mk, doc, list } = await fsSetup();
    await mk("/myspecs-dir");
    await mk("/archive/Spec Notes");
    await doc(undefined, "myspecs.md");
    await doc(undefined, "specs-v2.md");
    await doc("/archive", "readme.md");
    const paths = async (args: { path?: string; query?: string; recursive?: boolean }) => {
      const r = await list(args);
      return { folders: r.folders.map((f) => f.path), files: r.files.map((f) => f.path) };
    };

    // "spec" is a word prefix of neither "myspecs" name; both still match.
    expect(await paths({ query: "spec" })).toEqual({
      folders: ["/archive/Spec Notes", "/myspecs-dir"],
      files: ["/myspecs.md", "/specs-v2.md"],
    });
    expect(await paths({ query: "SPECS" })).toEqual({
      folders: ["/myspecs-dir"],
      files: ["/myspecs.md", "/specs-v2.md"],
    });
    // Every whitespace-separated term must appear, in any order.
    expect(await paths({ query: "  v2   specs " })).toEqual({ folders: [], files: ["/specs-v2.md"] });
    expect(await paths({ query: "notes spec" })).toEqual({ folders: ["/archive/Spec Notes"], files: [] });
    // Scoped to a folder's subtree.
    expect(await paths({ path: "/archive", query: "e" })).toEqual({
      folders: ["/archive/Spec Notes"],
      files: ["/archive/readme.md"],
    });
    // A blank query is no query: the plain root listing, or the subtree when recursive.
    const root = { folders: ["/archive", "/myspecs-dir"], files: ["/myspecs.md", "/specs-v2.md"] };
    expect(await paths({ query: "" })).toEqual(root);
    expect(await paths({ query: "   " })).toEqual(root);
    expect((await paths({ query: " ", recursive: true })).files).toHaveLength(3);
  });

  it("sync since a folder rename or move lists the files whose paths changed (M2)", async () => {
    const { t, sam, token, mk, doc } = await fsSetup();
    const { folder: specs } = await mk("/specs/api");
    await doc("/specs/api", "endpoints.md");
    await doc("/specs", "overview.md");
    const outside = await doc(undefined, "readme.md");
    const snapshot = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    const cursor = { sinceSeq: snapshot.cursorSeq, cursorWorkspaceId: snapshot.workspace.id };
    const specsRow = snapshot.folders.find((f) => f.path === "/specs")!;

    // A dashboard rename (folder.renamed).
    await sam.mutation(api.folders.renameFolder, { folderId: specsRow.id, name: "design", expectedRevision: 1 });
    const renamed = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token, ...cursor });
    expect(renamed.events.map((e) => e.kind)).toEqual(["folder.renamed"]);
    expect(renamed.changedFiles.map((f) => f.path).sort()).toEqual(["/design/api/endpoints.md", "/design/overview.md"]);
    expect(renamed.changedFiles.map((f) => f.id)).not.toContain(outside.id);
    expect(renamed.filesTruncated).toBe(false);

    // An MCP move of a subfolder (folder.moved), over HTTP.
    const { apiKey } = await connect(sam, { workspaceId: snapshot.workspace.id, client: "chatgpt" });
    const before = await callTool(t, apiKey, "sync_workspace");
    await callTool(t, apiKey, "move_folder", { folder_id: specs.id, expected_revision: 1, to_folder_path: "/" });
    const moved = await callTool(t, apiKey, "sync_workspace", { since: before.structuredContent.cursor });
    expect(moved.structuredContent.events.map((e: { type: string }) => e.type)).toEqual(["folder.moved"]);
    expect(moved.structuredContent.changed_files.map((f: { path: string }) => f.path)).toEqual(["/api/endpoints.md"]);
  });

  it("caps folder-move changed_files at 50 with files_truncated", async () => {
    const { t, token, mk, doc } = await fsSetup();
    const { folder } = await mk("/bulk");
    for (let i = 0; i < 52; i++) await doc("/bulk", `f${i}.md`);
    const snapshot = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    await t.mutation(internal.mcpTools.moveFolder, {
      principal: token,
      folderId: folder.id,
      expectedRevision: 1,
      toFolderPath: "/",
      newName: "moved",
    });
    const delta = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: token,
      sinceSeq: snapshot.cursorSeq,
      cursorWorkspaceId: snapshot.workspace.id,
    });
    expect(delta.changedFiles).toHaveLength(50);
    expect(delta.changedFiles.every((f) => f.path.startsWith("/moved/"))).toBe(true);
    expect(delta.filesTruncated).toBe(true);
  });

  it("finds legacy files without a nameKey by path and in collision checks (L1)", async () => {
    const { t, sam, samId, workspaceId, token } = await fsSetup();
    const actor = { type: "human" as const, userId: samId, label: "Sam" };
    const legacyId = await t.run((ctx) =>
      ctx.db.insert("files", {
        workspaceId,
        name: "Notes.md",
        mimeType: "text/markdown",
        content: "legacy",
        version: 1,
        createdBy: actor,
        updatedBy: actor,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const read = await t.mutation(internal.mcpTools.readFile, { principal: token, path: "/notes.md" });
    expect(read).toMatchObject({ file: { id: legacyId, path: "/Notes.md" }, content: "legacy" });
    expect(await errorData(sam.mutation(api.folders.createFolder, { workspaceId, name: "notes.md" }))).toMatchObject({
      code: "NAME_EXISTS",
      kind: "file",
      fileId: legacyId,
    });
    expect(
      await errorData(
        t.mutation(internal.mcpTools.createDocument, {
          principal: token,
          name: "NOTES.md",
          mimeType: "text/markdown",
          content: "",
        }),
      ),
    ).toMatchObject({ code: "NAME_EXISTS", kind: "file", fileId: legacyId });
    // Moving it keeps working and stores its key.
    const { folder } = await t.mutation(internal.mcpTools.createFolder, { principal: token, path: "/old" });
    await t.mutation(internal.mcpTools.moveFile, { principal: token, fileId: legacyId, expectedVersion: 1, toFolderId: folder.id });
    expect(await t.run(async (ctx) => (await ctx.db.get(legacyId))?.nameKey)).toBe("notes.md");
  });

  it("no-op moves return the file or folder unchanged, without a revision or event (L2)", async () => {
    const { t, sam, token, mk, doc, eventCount } = await fsSetup();
    const { folder: specs } = await mk("/specs");
    await mk("/specs/api");
    const file = await doc("/specs", "plan.md");
    const events = await eventCount();
    const revisions = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("file_revisions").withIndex("by_file_and_version", (q) => q.eq("fileId", file.id)).collect()).length,
      );

    const same = await t.mutation(internal.mcpTools.moveFile, {
      principal: token,
      fileId: file.id,
      expectedVersion: 1,
      toFolderPath: "/specs",
    });
    expect(same).toMatchObject({ version: 1, path: "/specs/plan.md" });
    const sameName = await t.mutation(internal.mcpTools.moveFile, {
      principal: token,
      fileId: file.id,
      expectedVersion: 1,
      toFolderId: specs.id,
      newName: " plan.md ",
    });
    expect(sameName.version).toBe(1);
    // The dashboard path is the same core.
    expect(await sam.mutation(api.files.moveFile, { fileId: file.id, parentId: specs.id, expectedVersion: 1 })).toEqual({
      version: 1,
    });
    const folderSame = await t.mutation(internal.mcpTools.moveFolder, {
      principal: token,
      folderId: specs.id,
      expectedRevision: 1,
      toFolderPath: "/",
      newName: "specs",
    });
    expect(folderSame.revision).toBe(1);
    expect(await eventCount()).toBe(events);
    expect(await revisions()).toBe(1);
    // A stale version is still a conflict, and a case-only rename is a real move.
    expect(
      await errorData(
        t.mutation(internal.mcpTools.moveFile, { principal: token, fileId: file.id, expectedVersion: 2, toFolderPath: "/specs" }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 1 });
    const recased = await t.mutation(internal.mcpTools.moveFile, {
      principal: token,
      fileId: file.id,
      expectedVersion: 1,
      toFolderPath: "/specs",
      newName: "Plan.md",
    });
    expect(recased).toMatchObject({ version: 2, name: "Plan.md" });
  });

  it("gives each tool a recovery hint that fits it (L3)", async () => {
    const { t, apiKey } = await fsSetup();
    await callTool(t, apiKey, "create_folder", { path: "/specs" });
    const doc = await callTool(t, apiKey, "create_document", { name: "e.md", content: "", folder_path: "/specs" });
    const fileId = doc.structuredContent.id as string;
    await callTool(t, apiKey, "create_document", { name: "taken.md", content: "", folder_path: "/specs" });

    const mkdir = await callTool(t, apiKey, "create_folder", { path: "/specs/e.md/sub" });
    expect(mkdir.structuredContent.error).toMatchObject({ code: "NAME_EXISTS", kind: "file", name: "e.md" });
    expect(mkdir.structuredContent.error.message).not.toMatch(/update_document/);
    expect(mkdir.structuredContent.error.message).toMatch(/folder path/);

    const clash = await callTool(t, apiKey, "move_file", {
      file_id: fileId,
      expected_version: 1,
      to_folder_path: "/specs",
      new_name: "TAKEN.md",
    });
    expect(clash.structuredContent.error).toMatchObject({ code: "NAME_EXISTS", kind: "file" });
    expect(clash.structuredContent.error.message).not.toMatch(/update_document/);
    expect(clash.structuredContent.error.message).toMatch(/new_name/);

    const slash = await callTool(t, apiKey, "move_file", {
      file_id: fileId,
      expected_version: 1,
      to_folder_path: "/",
      new_name: "a/b.md",
    });
    expect(slash.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", field: "name" });
    expect(slash.structuredContent.error.message).toMatch(/to_folder_path/);
    expect(slash.structuredContent.error.message).not.toMatch(/pass folder_path/);

    const created = await callTool(t, apiKey, "create_document", { name: "a/b.md", content: "" });
    expect(created.structuredContent.error.message).toMatch(/pass folder_path/);

    const tooLarge = toToolError(new ConvexError({ code: "FOLDER_TOO_LARGE", limit: 2000 }), { tool: "move_folder" });
    expect(tooLarge).toMatchObject({ code: "FOLDER_TOO_LARGE", details: { limit: 2000 } });
    expect((tooLarge as Error).message).toMatch(/2000 folders/);
    expect((tooLarge as Error).message).not.toMatch(/dashboard/);
  });

  it("uses one error code per path problem in every tool (L4)", async () => {
    const { t, apiKey } = await fsSetup();
    const doc = await callTool(t, apiKey, "create_document", { name: "a.md", content: "" });
    const fileId = doc.structuredContent.id as string;
    const folder = await callTool(t, apiKey, "create_folder", { path: "/f" });
    const folderId = folder.structuredContent.folder.id as string;
    const code = async (name: string, args: Record<string, unknown>) =>
      (await callTool(t, apiKey, name, args)).structuredContent.error?.code;

    for (const path of ["", "/a/​./b", "/a//b"]) {
      expect(await code("read_file", { path })).toBe("INVALID_PATH");
      expect(await code("create_folder", { path })).toBe("INVALID_PATH");
      expect(await code("list_files", { path })).toBe("INVALID_PATH");
      expect(await code("create_document", { name: "x.md", content: "", folder_path: path })).toBe("INVALID_PATH");
      expect(await code("move_file", { file_id: fileId, expected_version: 1, to_folder_path: path })).toBe("INVALID_PATH");
      expect(await code("move_folder", { folder_id: folderId, expected_revision: 1, to_folder_path: path })).toBe(
        "INVALID_PATH",
      );
    }
    const deep = (n: number) => "/" + Array.from({ length: n }, (_, i) => `d${i}`).join("/");
    expect(await code("create_folder", { path: deep(33) })).toBe("FOLDER_TOO_DEEP");
    expect(await code("create_folder", { path: deep(34) })).toBe("FOLDER_TOO_DEEP");
    expect(await code("read_file", { path: deep(34) })).toBe("FOLDER_TOO_DEEP");
    expect(await code("list_files", { path: deep(40) })).toBe("FOLDER_TOO_DEEP");
    expect(await code("read_file", { path: deep(33) })).toBe("PATH_NOT_FOUND");

    // An expected version or revision ahead of the current one is a conflict, not bad input.
    expect(await code("move_file", { file_id: fileId, expected_version: 9, to_folder_path: "/f" })).toBe("VERSION_CONFLICT");
    expect(await code("update_document", { file_id: fileId, expected_version: 9, content: "x" })).toBe("VERSION_CONFLICT");
    expect(await code("move_folder", { folder_id: folderId, expected_revision: 9, to_folder_path: "/" })).toBe(
      "VERSION_CONFLICT",
    );
    // A missing destination is reported before a stale version (Convex order).
    expect(await code("move_file", { file_id: fileId, expected_version: 9, to_folder_path: "/nope" })).toBe("PATH_NOT_FOUND");

    const blank = await callTool(t, apiKey, "search_files", { query: "   " });
    expect(blank.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", field: "query" });
  });
});

describe("sync brief and server instructions", () => {
  /** A workspace with an active and a superseded decision, an open and a resolved question, and a pending goal. */
  async function seeded() {
    const s = await setup();
    const { t, alex, sam, workspaceId } = s;
    const { apiKey, token } = await connect(sam, { workspaceId, client: "claude" });
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await callTool(t, apiKey, name, args);
      expect(result.isError).toBeUndefined();
      return result.structuredContent;
    };
    const decide = async (text: string) => {
      const { context_version } = await tool("sync_workspace");
      await alex.mutation(api.context.updateContextField, { workspaceId, field: "decision", proposedValue: text, sourceFileIds: [], expectedVersion: context_version });
    };
    await decide("Old pricing");
    const old = (await tool("sync_workspace")).context.decisions[0];
    const replacement = (await tool("propose_context_change", {
      field: "decisions", proposed_value: "Usage pricing", rationale: "Research", supersedes: old.id,
    })).proposal;
    await alex.mutation(api.context.decideContextProposal, { proposalId: replacement.id, decision: "approved" });
    // Working entries apply at once; the goal below stays pending.
    await automatic(alex, workspaceId);
    const blocker = (await tool("propose_context_change", {
      field: "open_questions", proposed_value: "Who signs off on launch?", rationale: "Blocks launch",
    })).proposal;
    await tool("propose_context_change", { field: "open_questions", proposed_value: "Logo color?", rationale: "Design" });
    const answered = (await tool("sync_workspace")).context;
    const logo = answered.open_questions.find((q: { text: string }) => q.text === "Logo color?");
    await tool("propose_context_change", {
      field: "open_questions", operation: "resolve", entry_id: logo.id,
      expected_version: (await tool("sync_workspace")).context_version, rationale: "Blue",
    });
    await alex.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "manual" });
    const goal = (await tool("propose_context_change", {
      field: "goal", proposed_value: "Ship the beta", rationale: "Kickoff",
    })).proposal;
    const doc = await tool("create_document", { name: "plan.md", content: "# Plan" });
    const { published } = await tool("publish_work", { kind: "finding", title: "Pricing research", summary: "Long details ".repeat(20), file_ids: [doc.id] });
    return { ...s, apiKey, token, tool, old, blocker, goal, doc, published };
  }

  it("puts a brief of decisions, blockers and recent changes first in the full result", async () => {
    const { t, token, tool, old, blocker, goal, doc, published, workspaceId } = await seeded();
    const sync = await tool("sync_workspace");
    expect(Object.keys(sync)[0]).toBe("brief");
    // Everything between the brief and next_steps is the pre-brief contract, key for key and value for value.
    const { brief, next_steps, ...rest } = sync;
    expect(Object.keys(sync).at(-1)).toBe("next_steps");
    expect(next_steps).toEqual(syncNextSteps({ contextEmpty: false }));
    expect(Object.keys(rest)).toEqual(["workspace", "context", "context_version", "pending_proposals", "changed_files", "files_truncated", "folders", "folders_truncated",
      "recent_work", "work_truncated", "tasks", "tasks_truncated", "events", "events_truncated", "cursor"]);
    const raw = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    expect(rest.workspace).toEqual({ id: workspaceId, name: "Demo" });
    expect(rest.context_version).toBe(raw.context.revision);
    expect(rest.context.goal).toBe("");
    expect(rest.context.decisions.map((e: { id: string; text: string; status: string }) => [e.id, e.text, e.status]))
      .toEqual(raw.context.decisions.map((e) => [e.id, e.text, e.status]));
    expect(rest.context.open_questions.map((e: { id: string; text: string; status: string }) => [e.id, e.text, e.status]))
      .toEqual(raw.context.openQuestions.map((e) => [e.id, e.text, e.status]));
    const { source_ids: _sourceIds, base_context_version: _base, workspace_id: _workspace, ...pendingGoal } = goal;
    expect(rest.pending_proposals).toEqual([pendingGoal]);
    expect(rest.changed_files).toEqual((await tool("list_files")).files);
    expect(rest.files_truncated).toBe(false);
    expect(rest.recent_work).toEqual([published]);
    expect(rest.work_truncated).toBe(false);
    expect(rest.events.map(({ actor: _actor, ...e }: { actor: unknown }) => e)).toEqual(raw.events.map((e) => ({
      seq: e.seq, workspace_id: workspaceId, type: e.kind, subject_id: e.entityId, at: new Date(e.createdAt).toISOString(), summary: e.summary,
    })));
    expect(rest.events.at(-1).actor).toEqual(published.published_by);
    expect(rest.events_truncated).toBe(false);
    expect((await tool("sync_workspace", { since: rest.cursor })).events).toEqual([]);
    expect(brief.active_decisions).toEqual([{ id: expect.any(String), text: "Usage pricing" }]);
    expect(brief.active_decisions[0].id).not.toBe(old.id);
    expect(brief.blockers).toEqual({
      open_questions: [{ id: expect.any(String), text: "Who signs off on launch?" }],
      pending_approvals: [{ id: goal.id, field: "goal", proposed_value: "Ship the beta" }],
    });
    expect(blocker.status).toBe("applied");
    expect(brief.goal).toBe("");
    expect(brief.changed_file_count).toBe(1);
    // Newest first, at most BRIEF_LIMIT, with actor labels.
    expect(brief.recent_changes.length).toBeLessThanOrEqual(10);
    expect(brief.recent_changes[0]).toMatchObject({ type: "work.published", actor: "Sam's claude assistant", at: expect.any(String) });
    expect(brief.recent_changes[1]).toMatchObject({ type: "file.created", subject_id: doc.id });
    // recent_changes mirror the newest events, newest first.
    expect(brief.recent_changes.map(({ actor: _actor, ...c }: { actor: string }) => c)).toEqual(
      rest.events.slice(-10).reverse().map((e: { type: string; subject_id: string; summary: string; at: string }) =>
        ({ type: e.type, subject_id: e.subject_id, summary: e.summary, at: e.at })),
    );
    // The seed's snapshot has more than ten events, so recent_changes is capped and flagged.
    expect(rest.events.length).toBeGreaterThan(10);
    expect(brief.recent_changes).toHaveLength(10);
    expect(brief.truncated).toBe(true);
  });

  it("returns a compact payload for detail brief whose cursor continues incrementally", async () => {
    const { t, alex, tool, doc, workspaceId } = await seeded();
    const compact = await tool("sync_workspace", { detail: "brief" });
    const full = await tool("sync_workspace");
    expect(Object.keys(compact)).toEqual(["brief", "workspace", "context_version", "changed_files", "deleted_file_ids", "files_truncated",
      "recent_work", "work_truncated", "tasks", "tasks_truncated", "events_truncated", "cursor", "next_steps"]);
    expect(compact).not.toHaveProperty("context");
    expect(compact).not.toHaveProperty("events");
    expect(compact).not.toHaveProperty("pending_proposals");
    expect(compact.changed_files).toEqual([{ id: doc.id, name: "plan.md", path: "/plan.md", version: 1 }]);
    expect(compact.recent_work).toEqual(full.recent_work);
    expect(compact.tasks).toEqual(full.tasks);
    expect(compact.brief.blockers.pending_approvals).toHaveLength(1);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);

    await alex.mutation(api.files.updateDocument, { fileId: doc.id, content: "# Plan v2", expectedVersion: 1 });
    const next = await tool("sync_workspace", { since: compact.cursor, detail: "brief" });
    expect(next.changed_files).toEqual([{ id: doc.id, name: "plan.md", path: "/plan.md", version: 2 }]);
    expect(next.brief.recent_changes).toMatchObject([{ type: "file.updated", subject_id: doc.id, actor: expect.any(String) }]);
    expect(next.brief.changed_file_count).toBe(1);
    expect(next.recent_work).toEqual([]);
    // The compact cursor is an ordinary cursor: a full incremental sync sees nothing newer.
    const after = await tool("sync_workspace", { since: next.cursor });
    expect(after.events).toEqual([]);
    expect(after.brief.recent_changes).toEqual([]);
    const bad = await callTool(t, (await connect(alex, { workspaceId, client: "chatgpt" })).apiKey, "sync_workspace", { detail: "everything" });
    expect(bad.isError).toBe(true);
  });

  it("restates the read-before / write-back loop in next_steps on the results that open and close work", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await callTool(t, apiKey, name, args);
      expect(result.isError).toBeUndefined();
      return result.structuredContent;
    };

    // A fresh workspace has no approved context, so sync asks to seed it from the files.
    const empty = (await tool("sync_workspace", { detail: "brief" })).next_steps;
    expect(empty).toEqual(syncNextSteps({ contextEmpty: true }));
    expect(empty[0]).toMatch(/context is empty.*files you read or save.*propose_context_change.*source_ids.*no pending proposal/);
    expect(syncNextSteps({ contextEmpty: false })).toEqual(empty.slice(1));
    const at = (prefix: string) => syncNextSteps({ contextEmpty: false }).findIndex((step) => step.startsWith(prefix));
    expect(at("Record before working")).toBeGreaterThan(at("Read before working"));
    expect(at("Record before working")).toBeLessThan(at("Write back after working"));
    expect(empty.join(" ")).toMatch(/publish_work, even if no file changed/);

    const created = await tool("create_document", { name: "loop.md", content: "v1" });
    expect(created.next_steps).toEqual(savedNextSteps(created as { id: string; version: number }));
    expect(created.next_steps.join(" ")).toMatch(/expected_version=1.*publish_work.*propose_context_change/s);
    const { next_steps: savedSteps, ...file } = created;
    expect(file).toEqual(expect.objectContaining({ id: expect.any(String), path: "/loop.md", version: 1 }));
    expect(savedSteps[1]).toContain(`["${created.id}"]`);
    expect(savedSteps[2]).toMatch(/propose_context_change.*approved context lacks and no pending proposal/);
    expect(savedSteps[2]).toContain(`source_ids ["${created.id}"]`);

    const updated = await tool("update_document", { file_id: created.id, content: "v2", expected_version: 1 });
    expect(updated.next_steps[0]).toBe("Saved as version 2; pass expected_version=2 for your next edit of this file.");
    expect(updated.next_steps.join(" ")).not.toContain("loop.md");

    const { next_steps: publishedSteps } = await tool("publish_work", { kind: "deliverable", title: "Loop", summary: "Done", file_ids: [created.id] });
    expect(publishedSteps).toEqual(publishedNextSteps());

    const pending = await tool("propose_context_change", { field: "goal", proposed_value: "Ship", rationale: "Kickoff" });
    expect(pending.proposal.status).toBe("pending");
    expect(pending.next_steps).toEqual(proposedNextSteps("pending"));
    expect(pending.next_steps.join(" ")).toMatch(/human owner or admin/);
    // A pending goal isn't approved context yet; once approved, the seeding step goes away.
    expect((await tool("sync_workspace")).next_steps).toEqual(syncNextSteps({ contextEmpty: true }));
    await alex.mutation(api.context.decideContextProposal, { proposalId: pending.proposal.id, decision: "approved" });
    expect((await tool("sync_workspace")).next_steps).toEqual(syncNextSteps({ contextEmpty: false }));

    await automatic(alex, workspaceId);
    const applied = await tool("propose_context_change", { field: "constraints", proposed_value: "No mobile", rationale: "Budget" });
    expect(applied.proposal.status).toBe("applied");
    expect(applied.next_steps).toEqual(proposedNextSteps("applied"));
  });

  it("treats a context whose only entry was resolved as empty again", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    await automatic(alex, workspaceId);
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await callTool(t, apiKey, name, args);
      expect(result.isError).toBeUndefined();
      return result.structuredContent;
    };
    await tool("propose_context_change", { field: "open_questions", proposed_value: "Who reviews?", rationale: "Planning" });
    const active = await tool("sync_workspace");
    expect(active.next_steps).toEqual(syncNextSteps({ contextEmpty: false }));
    const resolved = await tool("propose_context_change", {
      field: "open_questions", operation: "resolve", entry_id: active.context.open_questions[0].id,
      expected_version: active.context_version, rationale: "Answered",
    });
    expect(resolved.proposal.status).toBe("applied");
    // Retained history isn't current context: only the resolved question is left.
    const after = await tool("sync_workspace");
    expect(after.context.open_questions).toMatchObject([{ status: "resolved" }]);
    expect(after.next_steps).toEqual(syncNextSteps({ contextEmpty: true }));
  });

  it("keeps next_steps off read results and error results", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const created = (await callTool(t, apiKey, "create_document", { name: "r.md", content: "x" })).structuredContent;
    const read = await callTool(t, apiKey, "read_file", { file_id: created.id });
    expect(read.structuredContent).not.toHaveProperty("next_steps");
    const stale = await callTool(t, apiKey, "update_document", { file_id: created.id, content: "y", expected_version: 7 });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).not.toHaveProperty("next_steps");
  });

  it("tells assistants when to sync and how to share work back, in a short instructions string", async () => {
    const { MCP_INSTRUCTIONS } = await import("./mcp");
    for (const term of ["sync_workspace", "since", "cursor", "read_file", "update_document", "publish_work", "propose_context_change",
      "expected_version", "open_questions", "best effort", "without waiting to be asked", "private conversation history", "untrusted",
      "even if no file changed", "create or edit", "that context lacks", "no pending proposal covers", "read brief first",
      "Record before the work", "manage_task", "Record after"])
      expect(MCP_INSTRUCTIONS).toContain(term);
    expect(MCP_INSTRUCTIONS).not.toMatch(/real[- ]time|push notification|guarantee/i);
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(1300);

    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const init = await mcpRequest(t, apiKey, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result.instructions).toBe(MCP_INSTRUCTIONS);
    const listed = await mcpRequest(t, apiKey, "tools/list");
    const syncTool = listed.body.result.tools.find((entry: { name: string }) => entry.name === "sync_workspace");
    expect(syncTool.inputSchema.properties.detail.enum).toEqual(["brief", "full"]);
  });

  it("keeps full publication summaries in brief since syncs, whose cursor acknowledges them", async () => {
    const { alex, tool, doc } = await seeded();
    const before = await tool("sync_workspace", { detail: "brief" });
    const summary = "Annual plans churn three times less than monthly plans. ".repeat(40).trim();
    const { published } = await tool("publish_work", { kind: "finding", title: "Churn analysis", summary, file_ids: [doc.id] });
    await alex.mutation(api.files.updateDocument, { fileId: doc.id, content: "# Plan v2", expectedVersion: 1 });
    const page = await tool("sync_workspace", { since: before.cursor, detail: "brief" });
    expect(page.recent_work).toEqual([published]);
    expect(page.recent_work[0].summary).toBe(summary);
    expect(page.recent_work[0]).toMatchObject({ file_ids: [doc.id], published_by: published.published_by, created_at: expect.any(String) });
    // Nothing is left to recover later: the next page no longer carries it.
    expect((await tool("sync_workspace", { since: page.cursor })).recent_work).toEqual([]);
  });

  it("carries tasks changed in the page in brief since syncs, whose cursor acknowledges them", async () => {
    const { tool } = await seeded();
    const before = await tool("sync_workspace", { detail: "brief" });
    const { task } = await tool("manage_task", { operation: "create", title: "Draft welcome email" });
    const { task: claimed } = await tool("manage_task", { operation: "claim", task_id: task.id, expected_version: task.version });
    const page = await tool("sync_workspace", { since: before.cursor, detail: "brief" });
    expect(page.tasks).toEqual([claimed]);
    expect(page.tasks[0]).toMatchObject({ status: "in_progress", owner: { user_id: expect.any(String) } });
    expect((await tool("sync_workspace", { since: page.cursor, detail: "brief" })).tasks).toEqual([]);
  });

  it("preserves deletion tombstones outside the ten newest changes before advancing the brief cursor", async () => {
    const { alex, tool, doc } = await seeded();
    const before = await tool("sync_workspace", { detail: "brief" });
    await alex.mutation(api.files.deleteFile, { fileId: doc.id, expectedVersion: 1 });
    for (let i = 0; i < 11; i++)
      await tool("create_document", { name: `later-${i}.md`, content: "Later work" });
    const page = await tool("sync_workspace", { since: before.cursor, detail: "brief" });
    expect(page.brief.recent_changes).toHaveLength(10);
    expect(page.brief.recent_changes.some((event: { type: string }) => event.type === "file.deleted")).toBe(false);
    expect(page.deleted_file_ids).toEqual([doc.id]);
    expect(page.changed_files.some((file: { id: string }) => file.id === doc.id)).toBe(false);
    expect(page).not.toHaveProperty("events");
    const next = await tool("sync_workspace", { since: page.cursor, detail: "brief" });
    expect(next.deleted_file_ids).toEqual([]);
    expect(next.brief.recent_changes).toEqual([]);
  });

  it("caps each brief list after active filtering and flags exactly when a list exceeds ten", async () => {
    const { t, alex, workspaceId } = await seeded();
    const { token } = await connect(alex, { workspaceId, client: "chatgpt" });
    const raw = await t.mutation(internal.mcpTools.syncWorkspace, { principal: token });
    const { toSyncResult } = await import("./lib/mcpContract");
    const decision = raw.context.decisions.find((entry) => entry.status === "active")!;
    const question = raw.context.openQuestions.find((entry) => entry.status === "active")!;
    const entry = (base: typeof decision, index: number) => ({ ...base, id: String(index) });
    const base = {
      ...raw,
      context: { ...raw.context, decisions: [], openQuestions: [] },
      pendingProposals: [], events: [],
    };
    for (const count of [10, 11]) {
      const decisions = Array.from({ length: count }, (_, i) => entry(decision, i));
      const questions = Array.from({ length: count }, (_, i) => entry(question, i));
      const pendingProposals = Array.from({ length: count }, (_, i) => ({ ...raw.pendingProposals[0]!, id: String(i) }));
      const events = Array.from({ length: count }, (_, i) => ({ ...raw.events[0]!, seq: i, createdAt: i }));
      for (const input of [
        { ...base, context: { ...base.context, decisions } },
        { ...base, context: { ...base.context, openQuestions: questions } },
        { ...base, pendingProposals },
        { ...base, events },
      ]) expect(toSyncResult(input).brief.truncated).toBe(count > 10);
      const brief = toSyncResult({ ...base, context: { ...base.context, decisions, openQuestions: questions }, pendingProposals, events }).brief;
      expect(brief.active_decisions.map((item) => item.id)).toEqual(decisions.slice(-10).map((item) => item.id));
      // Questions are stored newest last (keep the tail); pending proposals arrive newest first (keep the head).
      expect(brief.blockers.open_questions.map((item) => item.id)).toEqual(questions.slice(-10).map((item) => item.id));
      expect(brief.blockers.pending_approvals.map((item) => item.id)).toEqual(pendingProposals.slice(0, 10).map((item) => item.id));
      expect(brief.recent_changes.map((item) => item.at)).toEqual(events.slice(-10).reverse().map((event) => new Date(event.createdAt).toISOString()));
    }
    const inactive = toSyncResult({
      ...base,
      context: { ...base.context,
        decisions: Array.from({ length: 11 }, (_, i) => ({ ...entry(decision, i), status: "superseded" as const })),
        openQuestions: Array.from({ length: 11 }, (_, i) => ({ ...entry(question, i), status: "resolved" as const })),
      },
    }).brief;
    expect(inactive.active_decisions).toEqual([]);
    expect(inactive.blockers.open_questions).toEqual([]);
    expect(inactive.truncated).toBe(false);
  });
});

describe("file history for 'what changed?'", () => {
  it("read_file reads an older version by number and keeps file.version at the latest", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const created = (await callTool(t, apiKey, "create_document", { name: "plan.md", content: "a\nb\n" })).structuredContent;
    await callTool(t, apiKey, "update_document", { file_id: created.id, content: "a\nc\nd\n", expected_version: 1 });

    const old = await callTool(t, apiKey, "read_file", { file_id: created.id, version: 1 });
    expect(old.isError).toBeUndefined();
    // content_version, not version: only file.version goes in expected_version.
    expect(old.structuredContent).toMatchObject({ content: "a\nb\n", content_version: 1, file: { version: 2 } });
    expect(old.structuredContent).not.toHaveProperty("version");
    const latest = await callTool(t, apiKey, "read_file", { file_id: created.id });
    expect(latest.structuredContent).toMatchObject({ content: "a\nc\nd\n", content_version: 2 });

    const missing = await callTool(t, apiKey, "read_file", { file_id: created.id, version: 9 });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe("INVALID_INPUT");
  });

  it("get_file_versions says how many lines each version added and removed", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const created = (await callTool(t, apiKey, "create_document", { name: "plan.md", content: "a\nb\n" })).structuredContent;
    await callTool(t, apiKey, "update_document", { file_id: created.id, content: "a\nc\nd\n", expected_version: 1 });

    const all = (await callTool(t, apiKey, "get_file_versions", { file_id: created.id })).structuredContent;
    expect(all.versions.map((v: any) => [v.version, v.change])).toEqual([
      [2, { lines_added: 2, lines_removed: 1 }],
      [1, { lines_added: 2, lines_removed: 0 }],
    ]);
    // The oldest listed version still compares against the one before it.
    const newest = (await callTool(t, apiKey, "get_file_versions", { file_id: created.id, limit: 1 })).structuredContent;
    expect(newest.versions[0].change).toEqual({ lines_added: 2, lines_removed: 1 });
  });
});
