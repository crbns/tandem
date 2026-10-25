import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { api } from "@repo/backend/convex/_generated/api.js";
import type { Id } from "@repo/backend/convex/_generated/dataModel.js";
import { createConvexApi, toActor } from "@/lib/api/convex";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import { normalizeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/api/types";
import { claudeCodeCommand, mcpEndpoint, sortConnections } from "@/lib/assistants";

type BackendActor = Parameters<typeof toActor>[0];
type BackendConnection = FunctionReturnType<typeof api.agentConnections.listAgentConnections>[number];
type BackendNewConnection = FunctionReturnType<typeof api.agentConnections.createAgentConnection>;

const ALEX_ID = "users_alex" as Id<"users">;
const CONNECTION_ID = "agent_connections_1" as Id<"agent_connections">;
const ALEX: BackendActor = { type: "human", userId: ALEX_ID, label: "Alex" };
const ALEXS_CLAUDE: BackendActor = {
  type: "agent",
  userId: ALEX_ID,
  agentConnectionId: CONNECTION_ID,
  label: "Claude",
  client: "claude",
  userName: "Alex",
};

/** Answers by function name, records calls, and serves one controllable watch. */
function fakeConvex(responses: Record<string, unknown | ((args: unknown) => unknown)>) {
  const calls: { name: string; args: unknown }[] = [];
  const run = async (ref: FunctionReference<"query" | "mutation" | "action">, args: unknown) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const fixture = responses[name];
    const res = typeof fixture === "function" ? (fixture as (a: unknown) => unknown)(args) : fixture;
    if (res instanceof Error) throw res;
    if (res === undefined) throw new Error(`no fixture for ${name}`);
    return res;
  };
  let watched: { name: string; args: unknown } | null = null;
  let result: unknown;
  let listener: (() => void) | null = null;
  const watchQuery = (ref: FunctionReference<"query">, args: unknown) => {
    watched = { name: getFunctionName(ref), args };
    return {
      onUpdate(cb: () => void) {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      localQueryResult: () => {
        if (result instanceof Error) throw result;
        return result;
      },
    };
  };
  const client = { query: run, mutation: run, action: run, watchQuery } as unknown as ConvexReactClient;
  const push = (next: unknown) => {
    result = next;
    listener?.();
  };
  return { client, calls, push, watched: () => watched, subscribed: () => listener !== null };
}

const info = (...eventIds: string[]) => ({
  recentEvents: eventIds.map((id) => ({ id, kind: "file.updated", summary: "", actorLabel: "Claude", createdAt: 1 })),
});

describe("toActor (issue #12)", () => {
  it("names the person and the client on an agent write, never the connection id", () => {
    expect(toActor(ALEXS_CLAUDE)).toEqual({
      actorType: "agent",
      userId: "users_alex",
      userName: "Alex",
      agentName: "Claude",
      agentClient: "claude",
    });
    expect(JSON.stringify(toActor(ALEXS_CLAUDE))).not.toContain(CONNECTION_ID);
  });

  it("leaves the client out when the backend doesn't record one", () => {
    const actor = toActor({ type: "agent", userId: ALEX_ID, agentConnectionId: CONNECTION_ID, label: "Work laptop" });
    expect(actor).toEqual({ actorType: "agent", userId: "users_alex", agentName: "Work laptop" });
  });

  it("names a human by userName, falling back to the label", () => {
    expect(toActor(ALEX)).toEqual({ actorType: "human", userId: "users_alex", userName: "Alex" });
    expect(toActor({ type: "human", userId: ALEX_ID, label: "alex@x", userName: "Alex R" }).userName).toBe("Alex R");
  });
});

describe("Convex adapter: agent connections", () => {
  it("creates with the pinned args, trimming or omitting the display name", async () => {
    const created: BackendNewConnection = {
      connectionId: "agent_connections_2" as Id<"agent_connections">,
      token: "mcp_sk_abc",
      createdAt: 5,
      mcpUrl: "https://demo.convex.site/mcp",
    };
    const { client, calls } = fakeConvex({ "agentConnections:createAgentConnection": created });
    const tandem = createConvexApi(client);
    expect(await tandem.createAgentConnection("workspaces_1", { client: "claude", displayName: "  Laptop " })).toEqual(
      created,
    );
    await tandem.createAgentConnection("workspaces_1", { client: "gemini", displayName: "   " });
    expect(calls.map((c) => c.args)).toEqual([
      { workspaceId: "workspaces_1", client: "claude", displayName: "Laptop" },
      { workspaceId: "workspaces_1", client: "gemini" },
    ]);
  });

  it("lists connections, dropping nulls, and revokes by id", async () => {
    const listed: BackendConnection[] = [
      {
        connectionId: CONNECTION_ID,
        userId: ALEX_ID,
        userName: "Alex",
        client: "claude",
        displayName: null,
        authKind: "oauth",
        oauthClientName: "Claude",
        createdAt: 1,
        lastMcpActionAt: 3,
        lastSyncAt: null,
        revokedAt: null,
      },
    ];
    const { client, calls } = fakeConvex({
      "agentConnections:listAgentConnections": listed,
      "agentConnections:revokeAgentConnection": null,
    });
    const tandem = createConvexApi(client);
    const [connection] = await tandem.listAgentConnections("workspaces_1");
    expect(connection).toEqual({
      id: "agent_connections_1",
      userId: "users_alex",
      userName: "Alex",
      client: "claude",
      authKind: "oauth",
      oauthClientName: "Claude",
      createdAt: 1,
      lastMcpActionAt: 3,
    });
    expect(connection).not.toHaveProperty("token");
    await tandem.revokeAgentConnection("agent_connections_1");
    expect(calls).toEqual([
      { name: "agentConnections:listAgentConnections", args: { workspaceId: "workspaces_1" } },
      { name: "agentConnections:revokeAgentConnection", args: { connectionId: "agent_connections_1" } },
    ]);
  });
});

describe("Convex adapter: watchWorkspace", () => {
  it("signals only when a newer event lands, not on the first result", () => {
    const fake = fakeConvex({});
    let changes = 0;
    const stop = createConvexApi(fake.client).watchWorkspace("workspaces_1", () => changes++);
    expect(fake.watched()).toEqual({ name: "workspaces:getWorkspaceInfo", args: { workspaceId: "workspaces_1" } });

    fake.push(info("e1"));
    expect(changes).toBe(0);
    fake.push(info("e1")); // e.g. a member list change: same newest event
    expect(changes).toBe(0);
    fake.push(info("e2", "e1"));
    expect(changes).toBe(1);
    fake.push(new Error("Server Error")); // errors are the page loads' to report
    expect(changes).toBe(1);

    stop();
    expect(fake.subscribed()).toBe(false);
  });

  it("treats the first event in an empty workspace as a change", () => {
    const fake = fakeConvex({});
    let changes = 0;
    createConvexApi(fake.client).watchWorkspace("workspaces_1", () => changes++);
    fake.push(info());
    fake.push(info("e1"));
    expect(changes).toBe(1);
  });
});

describe("mock agent connections", () => {
  const owner: Actor = { actorType: "human", userId: "user_owner", userName: "Owner" };
  const member: Actor = { actorType: "human", userId: "user_member", userName: "Member" };
  const setup = async () => {
    let actor = owner;
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
    await api.listWorkspaces();
    const { token } = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    actor = member;
    await api.acceptInvite(token);
    actor = owner;
    return { api, as: (next: Actor) => (actor = next) };
  };

  it("returns a 256-bit API key once and never lists it", async () => {
    const { api } = await setup();
    const created = await api.createAgentConnection(MOCK_WORKSPACE_ID, { client: "claude", displayName: " Laptop " });
    expect(created.token).toMatch(/^mcp_sk_[0-9a-f]{64}$/);
    expect(created.mcpUrl).toBe(await api.getMcpServerUrl());
    const listed = (await api.listAgentConnections(MOCK_WORKSPACE_ID)).find((c) => c.id === created.connectionId);
    expect(listed).toMatchObject({
      userId: "user_owner",
      userName: "Owner",
      client: "claude",
      displayName: "Laptop",
      authKind: "api_key",
    });
    expect(JSON.stringify(await api.listAgentConnections(MOCK_WORKSPACE_ID))).not.toContain(created.token);
  });

  it("members see only their own; owners see everyone's", async () => {
    const { api, as } = await setup();
    as(member);
    const mine = await api.createAgentConnection(MOCK_WORKSPACE_ID, { client: "chatgpt" });
    expect((await api.listAgentConnections(MOCK_WORKSPACE_ID)).map((c) => c.id)).toEqual([mine.connectionId]);
    as(owner);
    const all = (await api.listAgentConnections(MOCK_WORKSPACE_ID)).map((c) => c.id);
    expect(all).toContain(mine.connectionId);
    expect(all).toContain("conn_alex_claude");
  });

  it("revokes: own connection or as admin; a member can't revoke someone else's", async () => {
    const { api, as } = await setup();
    as(member);
    await expect(api.revokeAgentConnection("conn_alex_claude")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const mine = await api.createAgentConnection(MOCK_WORKSPACE_ID, { client: "gemini" });
    await api.revokeAgentConnection(mine.connectionId);
    expect((await api.listAgentConnections(MOCK_WORKSPACE_ID))[0]?.revokedAt).toBeTypeOf("number");
    as(owner);
    await api.revokeAgentConnection("conn_alex_claude");
  });

  it("rejects an unknown client", async () => {
    const { api } = await setup();
    await expect(
      api.createAgentConnection(MOCK_WORKSPACE_ID, { client: "copilot" as "other" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("answers a consent request once, binding an OAuth connection to the chosen workspace", async () => {
    const { api } = await setup();
    const request = await api.getConsentRequest("mock_req_1");
    expect(request).toMatchObject({ status: "pending", suggestedClient: "claude", redirectHost: "claude.ai" });
    expect(request?.workspaces.map((w) => w.id)).toContain(MOCK_WORKSPACE_ID);
    const { redirectUrl } = await api.decideConsent("mock_req_1", {
      approve: true,
      workspaceId: MOCK_WORKSPACE_ID,
      client: "claude",
    });
    expect(redirectUrl).toBe(`/w/${MOCK_WORKSPACE_ID}/assistants`);
    expect(await api.getConsentRequest("mock_req_1")).toBeNull();
    await expect(api.decideConsent("mock_req_1", { approve: false })).rejects.toMatchObject({
      code: "REQUEST_EXPIRED",
    });
    const oauth = (await api.listAgentConnections(MOCK_WORKSPACE_ID)).filter((c) => c.authKind === "oauth");
    expect(oauth.map((c) => c.userId)).toContain("user_owner");
  });
});

describe("Convex adapter: OAuth consent", () => {
  it("passes only the decision's fields and returns the redirect", async () => {
    const { client, calls } = fakeConvex({
      "oauth:decideConsent": { redirectUrl: "https://claude.ai/api/mcp/auth_callback?code=x" },
      "oauth:getConsentRequest": null,
    });
    const tandem = createConvexApi(client);
    expect(await tandem.getConsentRequest("req_1")).toBeNull();
    await tandem.decideConsent("req_1", { approve: true, workspaceId: "workspaces_1", client: "claude" });
    await tandem.decideConsent("req_2", { approve: false });
    expect(calls.map((c) => c.args)).toEqual([
      { requestId: "req_1" },
      { requestId: "req_1", approve: true, workspaceId: "workspaces_1", client: "claude" },
      { requestId: "req_2", approve: false },
    ]);
  });

  it("maps REQUEST_EXPIRED", () => {
    expect(normalizeError(new ConvexError({ code: "REQUEST_EXPIRED" })).code).toBe("REQUEST_EXPIRED");
  });
});

describe("mock watchWorkspace", () => {
  it("notifies after a file is created or saved, and stops after unsubscribe", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => ({ actorType: "human", userId: "u" }) });
    let changes = 0;
    const stop = api.watchWorkspace(MOCK_WORKSPACE_ID, () => changes++);
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown", content: "" });
    await Promise.resolve();
    expect(changes).toBe(1);
    api.__simulateExternalEdit(id, "# agent", { actorType: "agent", userId: "u", agentClient: "claude" });
    await Promise.resolve();
    expect(changes).toBe(2);
    stop();
    await api.updateFileContent(id, { expectedVersion: 2, content: "x" });
    await Promise.resolve();
    expect(changes).toBe(2);
  });
});

describe("assistant setup", () => {
  it("builds the Claude Code command against /mcp exactly once", () => {
    expect(claudeCodeCommand("https://demo.convex.site/", "mcp_sk_x")).toBe(
      'claude mcp add --transport http tandem https://demo.convex.site/mcp --header "Authorization: Bearer mcp_sk_x"',
    );
    expect(mcpEndpoint("https://mcp.example.com/mcp")).toBe("https://mcp.example.com/mcp");
    expect(mcpEndpoint("")).toBe("<MCP_URL>/mcp");
  });

  it("sorts revoked connections last, newest first otherwise", () => {
    const c = (id: string, createdAt: number, revokedAt?: number) => ({
      id, userId: "u", client: "claude", createdAt, ...(revokedAt ? { revokedAt } : {}),
    });
    expect(sortConnections([c("old", 1), c("revoked", 9, 10), c("new", 5)]).map((x) => x.id)).toEqual([
      "new",
      "old",
      "revoked",
    ]);
  });
});
