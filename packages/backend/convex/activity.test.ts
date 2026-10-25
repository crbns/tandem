/// <reference types="vite/client" />
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

const modules = import.meta.glob("./**/*.ts");
const SITE = "https://tandem-test.convex.site";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = SITE;
  process.env.SITE_URL = "https://tandem.example";
});

afterEach(() => {
  vi.useRealTimers();
});

async function errorData(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ConvexError) return err.data as Record<string, unknown>;
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

async function connect(
  as: Caller,
  args: { workspaceId: Id<"workspaces">; client: string; displayName?: string },
) {
  const created = await as.action(api.agentConnections.createAgentConnection, args);
  return { connectionId: created.connectionId, apiKey: created.token };
}

async function callTool(t: Test, bearer: string, name: string, args: Record<string, unknown> = {}) {
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).result as {
    isError?: boolean;
    structuredContent: Record<string, any>;
  };
}

async function setup() {
  const t = newTest();
  mcpTest.register(t);
  const insertUser = (name: string) =>
    t.run((ctx) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@example.com` }));
  const alexId = await insertUser("Alex");
  const samId = await insertUser("Sam");
  const jordanId = await insertUser("Jordan");
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session`, name: undefined });
  const alex = as(alexId);
  const sam = as(samId);
  const jordan = as(jordanId);
  const workspaceId = await alex.mutation(api.workspaces.createWorkspace, { name: "Demo" });
  const invite = await alex.mutation(api.workspaces.createWorkspaceInvite, { workspaceId, role: "member" });
  await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: invite.token });
  const otherWorkspaceId = await jordan.mutation(api.workspaces.createWorkspace, { name: "Other" });
  return { t, alex, sam, jordan, workspaceId, otherWorkspaceId };
}

const activityRows = (t: Test, connectionId: Id<"agent_connections">) =>
  t.run((ctx) =>
    ctx.db
      .query("agent_activity")
      .withIndex("by_connection_and_created", (q) => q.eq("agentConnectionId", connectionId))
      .collect(),
  );

const eventCount = (t: Test, workspaceId: Id<"workspaces">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", workspaceId))
        .collect()
    ).length,
  );

describe("agent activity recording", () => {
  it("records a sync row and the context revision it handed out, without a workspace event", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });

    let network = await alex.query(api.activity.getAgentNetwork, { workspaceId });
    expect(network.agents).toEqual([
      expect.objectContaining({
        connectionId,
        label: "Sam's claude assistant",
        client: "claude",
        lastMcpActionAt: null,
        syncedContextRevision: null,
        contextVersionsBehind: null,
        lastTool: null,
      }),
    ]);

    const eventsBefore = await eventCount(t, workspaceId);
    const synced = await callTool(t, apiKey, "sync_workspace", { detail: "brief" });
    expect(synced.isError).toBeUndefined();
    expect(await eventCount(t, workspaceId)).toBe(eventsBefore);

    const rows = await activityRows(t, connectionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      tool: "sync_workspace",
      kind: "sync",
      outcome: "ok",
      contextRevision: network.contextRevision,
      actor: { type: "agent", agentConnectionId: connectionId, client: "claude" },
    });
    expect(rows[0]!.previousSyncedContextRevision).toBeUndefined();

    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.syncedContextRevision).toBe(network.contextRevision);

    network = await alex.query(api.activity.getAgentNetwork, { workspaceId });
    expect(network.agents[0]).toMatchObject({
      syncedContextRevision: network.contextRevision,
      contextVersionsBehind: 0,
      lastTool: "sync_workspace",
      lastKind: "sync",
      lastOutcome: "ok",
    });
    expect(network.agents[0]!.lastSyncAt).toBeTypeOf("number");

    // Reads record activity but never advance the synced context.
    await callTool(t, apiKey, "get_workspace_info");
    await callTool(t, apiKey, "list_files");
    expect((await activityRows(t, connectionId)).map((r) => [r.tool, r.kind])).toEqual([
      ["sync_workspace", "sync"],
      ["get_workspace_info", "read"],
      ["list_files", "read"],
    ]);
    expect(await eventCount(t, workspaceId)).toBe(eventsBefore);
  });

  it("shows another agent behind by one approved version until its next sync", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const claude = await connect(sam, { workspaceId, client: "claude" });
    const chatgpt = await connect(alex, { workspaceId, client: "chatgpt", displayName: "Alex's ChatGPT" });
    await callTool(t, claude.apiKey, "sync_workspace");
    await callTool(t, chatgpt.apiKey, "sync_workspace");
    const start = await alex.query(api.activity.getAgentNetwork, { workspaceId });
    const r0 = start.contextRevision;
    expect(start.agents.map((a) => a.contextVersionsBehind)).toEqual([0, 0]);

    const proposed = await callTool(t, claude.apiKey, "propose_context_change", {
      field: "goal",
      proposed_value: "Ship the Live view",
      rationale: "Secret reasoning that must stay out of the feed",
    });
    expect(proposed.structuredContent.proposal.status).toBe("pending");
    // Pending proposals don't change the approved context.
    expect((await alex.query(api.activity.getAgentNetwork, { workspaceId })).contextRevision).toBe(r0);

    await alex.mutation(api.context.decideContextProposal, {
      proposalId: proposed.structuredContent.proposal.id,
      decision: "approved",
    });
    let network = await alex.query(api.activity.getAgentNetwork, { workspaceId });
    expect(network.contextRevision).toBe(r0 + 1);
    const gpt = () => network.agents.find((a) => a.connectionId === chatgpt.connectionId)!;
    expect(gpt()).toMatchObject({
      label: "Alex's ChatGPT",
      syncedContextRevision: r0,
      contextVersionsBehind: 1,
    });

    await callTool(t, chatgpt.apiKey, "sync_workspace", { detail: "brief" });
    network = await alex.query(api.activity.getAgentNetwork, { workspaceId });
    expect(gpt()).toMatchObject({ syncedContextRevision: r0 + 1, contextVersionsBehind: 0 });
    // Most recent action first.
    expect(network.agents[0]!.connectionId).toBe(chatgpt.connectionId);
    const rows = await activityRows(t, chatgpt.connectionId);
    expect(rows.at(-1)).toMatchObject({
      kind: "sync",
      contextRevision: r0 + 1,
      previousSyncedContextRevision: r0,
    });

    const { items } = await sam.query(api.activity.listTimeline, { workspaceId });
    expect(items.map((i) => [i.source, i.kind])).toEqual([
      ["agent", "sync"],
      ["workspace", "approve"],
      ["agent", "propose"],
      ["agent", "sync"],
      ["agent", "sync"],
    ]);
    const approve = items[1]!;
    expect(approve).toMatchObject({
      actor: { type: "human", label: "Alex", agentConnectionId: null },
      resource: { type: "proposal", id: proposed.structuredContent.proposal.id },
      tool: null,
      outcome: "ok",
    });
    expect(items[2]).toMatchObject({
      tool: "propose_context_change",
      summary: "Proposed a goal change (pending approval)",
      actor: { type: "agent", agentConnectionId: claude.connectionId, client: "claude" },
    });
    expect(items[0]!.previousSyncedContextRevision).toBe(r0);
    expect(JSON.stringify(items)).not.toContain("Secret reasoning");
    expect(JSON.stringify(items)).not.toContain("Ship the Live view");
  });

  it("records a stale update_document as a conflict and the retry as resolving it", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const created = await callTool(t, apiKey, "create_document", { name: "brief.md", content: "v1 by agent" });
    const fileId = created.structuredContent.id as Id<"files">;
    await alex.mutation(api.files.updateDocument, { fileId, content: "v2 by human", expectedVersion: 1 });

    const stale = await callTool(t, apiKey, "update_document", {
      file_id: fileId,
      content: "stale agent edit",
      expected_version: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent.error.code).toBe("VERSION_CONFLICT");
    const file = await t.run((ctx) => ctx.db.get(fileId));
    expect(file).toMatchObject({ version: 2, content: "v2 by human" });

    let rows = await activityRows(t, connectionId);
    const conflict = rows.at(-1)!;
    expect(conflict).toMatchObject({
      tool: "update_document",
      kind: "conflict",
      outcome: "conflict",
      errorCode: "VERSION_CONFLICT",
      resource: { type: "file", id: fileId, label: "/brief.md" },
    });
    expect(conflict.summary).not.toContain("stale agent edit");

    // A read in between doesn't break the link; the retry resolves the conflict.
    await callTool(t, apiKey, "read_file", { file_id: fileId });
    const retry = await callTool(t, apiKey, "update_document", {
      file_id: fileId,
      content: "merged",
      expected_version: 2,
    });
    expect(retry.isError).toBeUndefined();
    expect(retry.structuredContent.version).toBe(3);
    rows = await activityRows(t, connectionId);
    expect(rows.map((r) => r.kind)).toEqual(["write", "conflict", "read", "write"]);
    expect(rows.at(-1)!.resolvesActivityId).toBe(conflict._id);
    // The first write had nothing to resolve.
    expect(rows[0]!.resolvesActivityId).toBeUndefined();

    // A later write is an ordinary write again.
    await callTool(t, apiKey, "update_document", { file_id: fileId, content: "again", expected_version: 3 });
    expect((await activityRows(t, connectionId)).at(-1)!.resolvesActivityId).toBeUndefined();

    const { items } = await alex.query(api.activity.listTimeline, { workspaceId });
    expect(items.map((i) => i.kind)).toEqual(["write", "resolved", "read", "conflict", "human_edit", "write"]);
    expect(items[1]!.resolvesId).toBe(`a:${conflict._id}`);
    expect(items[3]).toMatchObject({ outcome: "conflict", errorCode: "VERSION_CONFLICT" });
    // The agent's own file.created event isn't duplicated from workspace_events.
    expect(items.filter((i) => i.source === "workspace")).toHaveLength(1);
    expect(items[4]).toMatchObject({ actor: { type: "human", label: "Alex" }, resource: { type: "file", id: fileId } });

    const filtered = await alex.query(api.activity.listTimeline, { workspaceId, kinds: ["conflict", "resolved"] });
    expect(filtered.items.map((i) => i.kind)).toEqual(["resolved", "conflict"]);
    const network = await alex.query(api.activity.getAgentNetwork, { workspaceId });
    expect(network.agents[0]).toMatchObject({ lastTool: "update_document", lastKind: "write", lastOutcome: "ok" });
  });

  it("records other failures as errors, and nothing for an unknown credential", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const missing = await callTool(t, apiKey, "read_file", { file_id: "nope" });
    expect(missing.isError).toBe(true);
    const rows = await activityRows(t, connectionId);
    expect(rows).toMatchObject([
      { tool: "read_file", kind: "error", outcome: "error", errorCode: "FILE_NOT_FOUND", resource: { type: "file", id: "nope" } },
    ]);
    expect(rows[0]!.resource?.label).toBeUndefined();

    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer mcp_sk_unknown",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sync_workspace", arguments: {} } }),
    });
    expect(res.status).toBe(401);
    const all = await t.run((ctx) => ctx.db.query("agent_activity").collect());
    expect(all).toHaveLength(1);
  });

  it("records task conflicts and the claim that follows", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const samBot = await connect(sam, { workspaceId, client: "claude" });
    const alexBot = await connect(alex, { workspaceId, client: "chatgpt" });
    const created = await callTool(t, samBot.apiKey, "manage_task", { operation: "create", title: "Write the demo script" });
    const task = created.structuredContent.task;
    await callTool(t, samBot.apiKey, "manage_task", { operation: "claim", task_id: task.id, expected_version: task.version });
    const lost = await callTool(t, alexBot.apiKey, "manage_task", { operation: "claim", task_id: task.id, expected_version: task.version });
    expect(lost.isError).toBe(true);
    expect((await activityRows(t, samBot.connectionId)).map((r) => [r.kind, r.summary, r.resource?.label])).toEqual([
      ["task", "Created a task", "Write the demo script"],
      ["task", "Claimed a task", "Write the demo script"],
    ]);
    const [failed] = await activityRows(t, alexBot.connectionId);
    expect(failed).toMatchObject({ tool: "manage_task", kind: "conflict", resource: { type: "task", id: task.id, label: "Write the demo script" } });

    // Someone else won the claim; a later successful claim by the loser isn't
    // a fix of a stale write, so it isn't linked as resolving the conflict.
    const reopened = await t.run(async (ctx) => {
      const row = (await ctx.db.get(task.id as Id<"tasks">))!;
      await ctx.db.patch(row._id, { status: "open", ownerId: undefined });
      return row.version;
    });
    const claimed = await callTool(t, alexBot.apiKey, "manage_task", { operation: "claim", task_id: task.id, expected_version: reopened });
    expect(claimed.isError).toBeUndefined();
    const rows = await activityRows(t, alexBot.connectionId);
    expect(rows.map((r) => r.kind)).toEqual(["conflict", "task"]);
    expect(rows[1]!.resolvesActivityId).toBeUndefined();
  });

  it("keeps an agent up to date when its own proposal applies immediately", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    await alex.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "automatic" });
    const claude = await connect(sam, { workspaceId, client: "claude" });
    const chatgpt = await connect(alex, { workspaceId, client: "chatgpt" });
    await callTool(t, claude.apiKey, "sync_workspace");
    await callTool(t, chatgpt.apiKey, "sync_workspace");
    const r0 = (await alex.query(api.activity.getAgentNetwork, { workspaceId })).contextRevision;

    const applied = await callTool(t, claude.apiKey, "propose_context_change", {
      field: "decisions",
      proposed_value: "Use Convex for realtime",
      rationale: "Already in the stack",
    });
    expect(applied.structuredContent.proposal.status).toBe("applied");
    const network = await alex.query(api.activity.getAgentNetwork, { workspaceId });
    expect(network.contextRevision).toBe(r0 + 1);
    const byId = (id: Id<"agent_connections">) => network.agents.find((a) => a.connectionId === id)!;
    expect(byId(claude.connectionId)).toMatchObject({ syncedContextRevision: r0 + 1, contextVersionsBehind: 0 });
    expect(byId(chatgpt.connectionId)).toMatchObject({ syncedContextRevision: r0, contextVersionsBehind: 1 });
  });
});

describe("activity queries", () => {
  it("refuses non-members and never crosses workspaces", async () => {
    const { t, jordan, sam, workspaceId, otherWorkspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    await callTool(t, apiKey, "sync_workspace");

    expect(await errorData(jordan.query(api.activity.getAgentNetwork, { workspaceId }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await errorData(jordan.query(api.activity.listTimeline, { workspaceId }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await errorData(t.query(api.activity.getAgentNetwork, { workspaceId }))).toMatchObject({ code: "UNAUTHENTICATED" });

    const own = await jordan.query(api.activity.getAgentNetwork, { workspaceId: otherWorkspaceId });
    expect(own.agents).toEqual([]);
    const timeline = await jordan.query(api.activity.listTimeline, { workspaceId: otherWorkspaceId, connectionId });
    expect(timeline).toEqual({ items: [], nextBefore: null });
    const all = await jordan.query(api.activity.listTimeline, { workspaceId: otherWorkspaceId });
    expect(all.items.every((i) => i.actor.agentConnectionId === null)).toBe(true);
  });

  it("merges human approvals and pages by before without gaps or duplicates", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const claude = await connect(sam, { workspaceId, client: "claude" });
    const gemini = await connect(alex, { workspaceId, client: "gemini" });
    for (let i = 0; i < 3; i++) {
      const proposed = await callTool(t, claude.apiKey, "propose_context_change", {
        field: "decisions",
        proposed_value: `Decision ${i}`,
        rationale: "Because",
      });
      await alex.mutation(api.context.decideContextProposal, {
        proposalId: proposed.structuredContent.proposal.id,
        decision: i === 1 ? "rejected" : "approved",
      });
      await callTool(t, gemini.apiKey, "sync_workspace");
    }
    const full = await alex.query(api.activity.listTimeline, { workspaceId, limit: 100 });
    expect(full.nextBefore).toBeNull();
    expect(full.items.filter((i) => i.source === "workspace").map((i) => i.kind)).toEqual(["approve", "reject", "approve"]);
    for (let i = 1; i < full.items.length; i++)
      expect(full.items[i]!.createdAt).toBeLessThanOrEqual(full.items[i - 1]!.createdAt);

    const paged: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await alex.query(api.activity.listTimeline, { workspaceId, limit: 2, before });
      paged.push(...result.items.map((i) => i.id));
      if (result.nextBefore === null) break;
      expect(result.items.length).toBeGreaterThanOrEqual(2);
      before = result.nextBefore;
    }
    expect(paged).toEqual(full.items.map((i) => i.id));

    const geminiOnly = await alex.query(api.activity.listTimeline, { workspaceId, connectionId: gemini.connectionId });
    expect(geminiOnly.items.map((i) => i.kind)).toEqual(["sync", "sync", "sync"]);
    const decisions = await alex.query(api.activity.listTimeline, { workspaceId, kinds: ["approve", "reject"] });
    expect(decisions.items).toHaveLength(3);
  });

  it("pages past the per-source scan budget", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    await callTool(t, apiKey, "get_workspace_info");
    const [template] = await activityRows(t, connectionId);
    const base = 1_700_000_000_000;
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = template!;
      for (let i = 0; i < 450; i++)
        await ctx.db.insert("agent_activity", { ...row, summary: `row ${i}`, createdAt: base + i * 10 });
      // Human edits interleaved, some sharing a timestamp with an agent row.
      for (let i = 0; i < 30; i++)
        await ctx.db.insert("workspace_events", {
          workspaceId,
          kind: "file.updated",
          entityType: "file",
          entityId: `f${i}`,
          summary: `edit ${i}`,
          actor: { type: "human", label: "Alex" },
          createdAt: base + i * 150,
        });
    });
    const seen: string[] = [];
    let before: number | undefined = base + 100_000;
    for (let page = 0; page < 20 && before !== undefined; page++) {
      const result: { items: { id: string }[]; nextBefore: number | null } = await alex.query(
        api.activity.listTimeline,
        { workspaceId, limit: 100, before },
      );
      seen.push(...result.items.map((i) => i.id));
      before = result.nextBefore ?? undefined;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(480);
  });

  it("prunes activity older than 14 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t, sam, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    await callTool(t, apiKey, "sync_workspace");
    vi.setSystemTime(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await callTool(t, apiKey, "get_workspace_info");
    vi.setSystemTime(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.activity.pruneActivity, {});
    expect((await activityRows(t, connectionId)).map((r) => r.tool)).toEqual(["get_workspace_info"]);
  });
});
