import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConvexTokenResolver, credentialHeader, withDevAnon } from "../src/auth.js";
import { encodeCursor } from "../src/backend/cursor.js";
import { ConvexBackend } from "../src/backend/convex.js";
import { createApp } from "../src/server.js";

const TOKEN = `tdm_${"a".repeat(43)}`;
const FILE = {
  id: "file1",
  workspaceId: "ws1",
  parentId: null,
  name: "brief.md",
  mimeType: "text/markdown",
  version: 2,
  updatedAt: Date.UTC(2026, 9, 24),
  updatedBy: {
    type: "agent",
    userId: "user1",
    agentConnectionId: "conn1",
    client: "claude",
    label: "Sam's Claude",
  },
};

type Handler = (args: Record<string, unknown>) => unknown;

/** Stands in for ConvexHttpClient: records calls and answers per function name. */
function fakeConvex(handlers: Record<string, Handler>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const run = async (ref: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(ref as never);
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected call ${name}`);
    return handler(args);
  };
  return { calls, client: { query: run, mutation: run } as never };
}

const verifyToken: Handler = ({ token }) => {
  if (token !== TOKEN) throw new ConvexError({ code: "UNAUTHENTICATED" });
  return {
    userId: "user1",
    userName: "Sam",
    client: "claude",
    connectionId: "conn1",
    workspaceId: "ws1",
  };
};

describe("credentialHeader", () => {
  it("reads only api-key when bearer is off", () => {
    expect(credentialHeader({ authorization: "Bearer x" }, false)).toBeUndefined();
    expect(credentialHeader({ "api-key": "k" }, false)).toBe("k");
  });

  it("accepts Bearer or api-key, and rejects malformed or conflicting ones", () => {
    expect(credentialHeader({ authorization: "Bearer tok" }, true)).toBe("tok");
    expect(credentialHeader({ authorization: "bearer  tok " }, true)).toBe("tok");
    expect(credentialHeader({ "api-key": "tok" }, true)).toBe("tok");
    expect(credentialHeader({}, true)).toBeUndefined();
    expect(credentialHeader({ authorization: "Basic abc" }, true)).toBe("");
    expect(credentialHeader({ authorization: "Bearer a b" }, true)).toBe("");
    expect(
      credentialHeader({ authorization: "Bearer a", "api-key": "b" }, true),
    ).toBe("");
    expect(
      credentialHeader({ authorization: "Bearer a", "api-key": "a" }, true),
    ).toBe("a");
  });
});

describe("Convex-backed server", () => {
  let server: Server;
  let url: URL;
  let fake: ReturnType<typeof fakeConvex>;

  beforeEach(async () => {
    fake = fakeConvex({
      "mcp:verifyToken": verifyToken,
      "mcp:readFile": () => ({ file: FILE, content: "hello" }),
      "mcp:updateDocument": () => {
        throw new ConvexError({
          code: "VERSION_CONFLICT",
          fileId: "file1",
          currentVersion: 3,
          expectedVersion: 2,
          currentContent: "secret head content",
        });
      },
      "mcp:createDocument": () => {
        throw new ConvexError({
          code: "NAME_EXISTS",
          fileId: "file1",
          name: "brief.md",
          currentVersion: 2,
        });
      },
      "mcp:proposeContextChange": (args) => ({
        proposal: {
          id: "prop1",
          workspaceId: "ws1",
          field: args.field,
          // Convex stores the display form; the owner is structured.
          proposedValue:
            args.field === "ownership" ? `${args.proposedValue}: Sam` : args.proposedValue,
          rationale: args.rationale,
          sourceFileIds: [],
          status: "pending",
          createdBy: FILE.updatedBy,
          createdAt: FILE.updatedAt,
          decidedBy: null,
          decidedAt: null,
          ownerUserId: args.ownerUserId ?? null,
          ownerArea: args.field === "ownership" ? args.proposedValue : null,
        },
        contextRevision: 4,
      }),
      "mcp:syncWorkspace": () => ({
        workspace: { id: "ws1", name: "Demo" },
        context: {
          goal: null, scope: null, constraints: [], decisions: [], ownership: [], openQuestions: [],
          revision: 1, updatedAt: FILE.updatedAt, updatedBy: FILE.updatedBy,
        },
        pendingProposals: [], changedFiles: [], filesTruncated: false,
        recentWork: [{
          id: "work1", workspaceId: "ws1", kind: "finding", title: "Latency",
          summary: "Full finding: p95 is 120ms; cache misses dominate.", fileIds: [FILE.id],
          createdBy: FILE.updatedBy, createdAt: FILE.updatedAt,
        }],
        workTruncated: true, events: [], eventsTruncated: false, headSeq: 8, cursorSeq: 8,
      }),
      "mcp:touchConnection": () => null,
      "mcp:listWorkspaces": () => [
        { id: "ws1", name: "Demo", role: "owner", memberCount: 2, isDefault: true },
      ],
      "mcp:listMembers": () => ({
        members: [
          { userId: "user1", name: "Sam", role: "owner" },
          { userId: "user2", name: "Alex", role: "member" },
        ],
        truncated: false,
      }),
      "mcp:getConnection": () => ({
        client: "claude",
        lastMcpActionAt: null,
        lastSyncAt: Date.UTC(2026, 9, 24),
      }),
      "mcp:getApprovals": (args) => [
        {
          proposal: {
            id: "prop2",
            workspaceId: "ws1",
            field: "goal",
            proposedValue: "Older goal",
            rationale: "r",
            sourceFileIds: [],
            status: args.status ?? "pending",
            createdBy: FILE.updatedBy,
            createdAt: FILE.updatedAt,
            decidedBy: null,
            decidedAt: null,
            ownerUserId: null,
            ownerArea: null,
          },
          contextRevision: 3,
        },
      ],
      "mcp:listFiles": () => {
        throw new ConvexError({ code: "FORBIDDEN", workspaceId: "ws2" });
      },
    });
    const backend = new ConvexBackend(fake.client);
    server = createApp({
      backend,
      identity: new ConvexTokenResolver(backend),
      acceptBearer: true,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function connect(headers: Record<string, string>) {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    );
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  it("challenges with Bearer and rejects tokens Convex rejects", async () => {
    for (const headers of [{}, { Authorization: "Bearer tdm_wrong" }]) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="tandem"');
    }
  });

  it("forwards the token on every call and converts shapes", async () => {
    const client = await connect({ Authorization: `Bearer ${TOKEN}` });
    const result = await call(client, "read_file", { file_id: "file1" });
    expect(result.structuredContent).toEqual({
      file: {
        id: "file1",
        workspace_id: "ws1",
        parent_id: null,
        name: "brief.md",
        mime_type: "text/markdown",
        version: 2,
        updated_at: "2026-10-24T00:00:00.000Z",
        updated_by: {
          actor_type: "agent",
          user_id: "user1",
          client: "claude",
          agent_connection_id: "conn1",
          label: "Sam's Claude",
        },
      },
      content: "hello",
    });
    const read = fake.calls.find((c) => c.name === "mcp:readFile");
    expect(read?.args).toEqual({ token: TOKEN, fileId: "file1" });
    // A successful call records presence itself: no separate touch.
    expect(fake.calls.some((c) => c.name === "mcp:touchConnection")).toBe(false);
  });

  it("maps sync recent_work, attribution, file references and work_truncated", async () => {
    const client = await connect({ Authorization: `Bearer ${TOKEN}` });
    const result = await call(client, "sync_workspace", { since: encodeCursor("ws1", 7) });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      recent_work: [{
        id: "work1", workspace_id: "ws1", kind: "finding", title: "Latency",
        summary: "Full finding: p95 is 120ms; cache misses dominate.", file_ids: ["file1"],
        published_by: {
          actor_type: "agent", user_id: "user1", client: "claude",
          agent_connection_id: "conn1", label: "Sam's Claude",
        },
        created_at: "2026-10-24T00:00:00.000Z",
      }],
      work_truncated: true,
      cursor: encodeCursor("ws1", 8),
    });
    expect(fake.calls.find((c) => c.name === "mcp:syncWorkspace")?.args).toEqual({
      token: TOKEN, workspaceId: undefined, sinceSeq: 7, cursorWorkspaceId: "ws1",
    });
    await client.close();
  });

  it("get_workspace_info lists the connection's workspace members as snake_case", async () => {
    const client = await connect({ Authorization: `Bearer ${TOKEN}` });
    const info = await call(client, "get_workspace_info", {});
    expect(info.isError).toBeFalsy();
    expect(info.structuredContent).toEqual({
      user: { id: "user1" },
      client: "claude",
      workspaces: [
        { id: "ws1", name: "Demo", role: "owner", member_count: 2, is_default: true },
      ],
      members: [
        { user_id: "user1", name: "Sam", role: "owner" },
        { user_id: "user2", name: "Alex", role: "member" },
      ],
      members_truncated: false,
      connection: {
        client: "claude",
        last_synced_at: "2026-10-24T00:00:00.000Z",
        last_action_at: null,
      },
    });
    const listMembers = fake.calls.find((c) => c.name === "mcp:listMembers");
    expect(listMembers?.args).toEqual({ token: TOKEN });
  });

  it("maps Convex error codes to tool errors", async () => {
    const client = await connect({ "api-key": TOKEN });
    const conflict = await call(client, "update_document", {
      file_id: "file1",
      content: "x",
      expected_version: 2,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({
      error: { code: "VERSION_CONFLICT", current_version: 3, expected_version: 2 },
    });
    expect(JSON.stringify(conflict)).not.toContain("secret head content");

    const dup = await call(client, "create_document", { name: "Brief.md", content: "" });
    expect(dup.structuredContent).toMatchObject({
      error: { code: "NAME_EXISTS", file_id: "file1", current_version: 2 },
    });

    const forbidden = await call(client, "list_files", { workspace_id: "ws2" });
    expect(forbidden.structuredContent).toMatchObject({
      error: { code: "FORBIDDEN", workspace_id: "ws2" },
    });

    // Each failed call rolled back its own presence touch in Convex, so the
    // server records "last MCP action" once per failure, with the same token.
    const touches = fake.calls.filter((c) => c.name === "mcp:touchConnection");
    expect(touches.map((c) => c.args)).toEqual([
      { token: TOKEN },
      { token: TOKEN },
      { token: TOKEN },
    ]);
  });

  it("lists stale proposals when asked for status stale", async () => {
    const client = await connect({ "api-key": TOKEN });
    const stale = await call(client, "get_approvals", { status: "stale" });
    expect(stale.isError).toBeFalsy();
    expect(stale.structuredContent).toMatchObject({
      proposals: [{ id: "prop2", status: "stale" }],
    });
    const all = await call(client, "get_approvals", { status: "all" });
    expect(all.isError).toBeFalsy();
    expect(
      fake.calls.filter((c) => c.name === "mcp:getApprovals").map((c) => c.args.status),
    ).toEqual(["stale", undefined]);
  });

  it("translates proposals to Convex's one-value-per-proposal model", async () => {
    const client = await connect({ "api-key": TOKEN });
    const decision = await call(client, "propose_context_change", {
      field: "decisions",
      proposed_value: "Use Convex",
      rationale: "r",
    });
    expect(decision.structuredContent).toMatchObject({
      proposal: { field: "decisions", base_context_version: 4, status: "pending" },
    });
    await call(client, "propose_context_change", {
      field: "constraints",
      proposed_value: "Due Sunday",
      rationale: "r",
    });
    const ownership = await call(client, "propose_context_change", {
      field: "ownership",
      proposed_value: { area: "MCP", owner_user_id: "user1" },
      rationale: "r",
    });
    // The owner travels as an id for Convex to check membership, and comes back structured.
    expect(ownership.structuredContent).toMatchObject({
      proposal: { proposed_value: { area: "MCP", owner_user_id: "user1" } },
    });
    const sent = fake.calls
      .filter((c) => c.name === "mcp:proposeContextChange")
      .map((c) => [c.args.field, c.args.proposedValue, c.args.ownerUserId]);
    expect(sent).toEqual([
      ["decision", "Use Convex", undefined],
      ["constraint", "Due Sunday", undefined],
      ["ownership", "MCP", "user1"],
    ]);

    // The contract is one constraint per proposal: lists are rejected before Convex.
    for (const proposed_value of [["a", "b"], ["a"]]) {
      const list = await call(client, "propose_context_change", {
        field: "constraints",
        proposed_value,
        rationale: "r",
      });
      expect(list.isError).toBe(true);
    }
    const freeTextOwner = await call(client, "propose_context_change", {
      field: "ownership",
      proposed_value: "Sam owns MCP",
      rationale: "r",
    });
    expect(freeTextOwner.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(fake.calls.filter((c) => c.name === "mcp:proposeContextChange")).toHaveLength(3);
  });
});

describe("withDevAnon", () => {
  it("refuses the Convex backend", () => {
    const backend = new ConvexBackend(fakeConvex({}).client);
    expect(() =>
      withDevAnon(
        new ConvexTokenResolver(backend),
        { TANDEM_DEV_ANON_USER: "user1", NODE_ENV: "development" },
        backend,
      ),
    ).toThrow(/only allowed with the mock backend/);
  });
});
