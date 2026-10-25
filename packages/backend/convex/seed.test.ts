/// <reference types="vite/client" />
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { randomSecret } from "./lib/mcpConfig";
import {
  DEMO_AGENT_DECISION,
  DEMO_CONSTRAINT,
  DEMO_HELP_CENTER_CONSTRAINT,
  DEMO_DECISION,
  DEMO_GOAL,
  DEMO_OPEN_QUESTION,
  DEMO_SCOPE,
  DEMO_WORKSPACE_NAME,
} from "./seed";

declare const process: { env: Record<string, string | undefined> };

const modules = import.meta.glob("./**/*.ts");
const SITE = "https://tandem-test.convex.site";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = SITE;
});

function newTest() {
  const t = convexTest(schema, modules);
  mcpTest.register(t);
  return t;
}
type Test = ReturnType<typeof newTest>;

/** get_workspace_info over the real MCP endpoint with an API key, or the HTTP status. */
async function workspaceInfo(t: Test, apiKey: string) {
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_workspace_info", arguments: {} },
    }),
  });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { result: { structuredContent: Record<string, any> } };
  return { status: 200, info: body.result.structuredContent };
}

async function setup() {
  const t = newTest();
  const insertUser = (name: string) =>
    t.run((ctx) => ctx.db.insert("users", { name: `${name} (signed up)` }));
  const people = [
    { key: "alex" as const, userId: await insertUser("Alex") },
    { key: "blake" as const, userId: await insertUser("Blake") },
    { key: "casey" as const, userId: await insertUser("Casey") },
  ];
  const rebuild = () =>
    t.mutation(internal.seed.rebuildDemoWorkspace, {
      people: people.map((p) => ({ ...p, token: randomSecret("mcp_sk_") })),
    });
  const as = (key: "alex" | "blake" | "casey") =>
    t.withIdentity({ subject: `${people.find((p) => p.key === key)!.userId}|session` });
  return { t, rebuild, as };
}

describe("seed:rebuildDemoWorkspace", () => {
  it("builds the demo: members, brief.md v1 by Alex, goal and scope, live API keys", async () => {
    const { t, rebuild, as } = await setup();
    const demo = await rebuild();
    expect(demo.workspaceName).toBe(DEMO_WORKSPACE_NAME);
    expect(demo.mcpUrl).toBe(`${SITE}/mcp`);

    const info = await as("blake").query(api.workspaces.getWorkspaceInfo, {
      workspaceId: demo.workspaceId,
    });
    expect(info.members.map((m) => [m.name, m.role])).toEqual([
      ["Alex", "owner"],
      ["Blake", "member"],
      ["Casey", "member"],
    ]);
    const context = await as("casey").query(api.workspaces.getWorkspaceContext, {
      workspaceId: demo.workspaceId,
    });
    expect(context?.goal).toMatchObject({
      text: DEMO_GOAL,
      sourceFileIds: [demo.briefFileId],
      updatedBy: { type: "human", label: "Alex" },
    });
    expect(context?.scope?.text).toBe(DEMO_SCOPE);
    const files = await as("alex").query(api.files.listFiles, {
      workspaceId: demo.workspaceId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(
      files.page.filter((f) => f.name === "brief.md").map((f) => [f.version, f.updatedBy.label]),
    ).toEqual([[1, "Alex"]]);

    for (const member of demo.members) {
      expect(member.token).toMatch(/^mcp_sk_/);
      const { status, info } = await workspaceInfo(t, member.token);
      expect(status).toBe(200);
      expect(info).toMatchObject({
        user: { id: member.userId },
        client: member.client,
        workspaces: [{ id: demo.workspaceId, is_default: true }],
      });
    }
  });

  it("seeds the story: folders, history, context, tasks and one decision from an agent", async () => {
    const { t, rebuild, as } = await setup();
    const demo = await rebuild();

    const files = await t.run(async (ctx) => {
      const rows = await ctx.db.query("files")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", demo.workspaceId)).collect();
      return Promise.all(rows.map(async (f) => {
        const folder = f.parentId ? await ctx.db.get(f.parentId) : null;
        return [`${folder ? `${folder.name}/` : ""}${f.name}`, f.version, f.updatedBy.label];
      }));
    });
    expect(files.sort()).toEqual([
      ["brief.md", 1, "Alex"],
      ["requirements/setup-checklist.md", 1, "Blake"],
      ["research/interview-notes.md", 2, "Blake"],
      ["research/support-tickets.md", 1, "Casey"],
    ]);
    // interview-notes v1 is dated a day before v2, so "when did it change?" reads true.
    const { notes, revisions: [v2, v1], created } = await t.run(async (ctx) => {
      const notes = (await ctx.db.query("files")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", demo.workspaceId)).collect())
        .find((f) => f.name === "interview-notes.md")!;
      const revisions = await ctx.db.query("file_revisions")
        .withIndex("by_file_and_version", (q) => q.eq("fileId", notes._id)).order("desc").collect();
      const created = (await ctx.db.query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", demo.workspaceId)).collect())
        .find((e) => e.entityId === notes._id && e.kind === "file.created")!;
      return { notes, revisions, created };
    });
    expect(v2!.createdAt - v1!.createdAt).toBeGreaterThan(24 * 60 * 60 * 1000);
    // The file and its creation event move with v1.
    expect(notes.createdAt).toBe(v1!.createdAt);
    expect(created.createdAt).toBe(v1!.createdAt);
    // brief.md agrees with the approved context: its only open question is the
    // seeded one, so an assistant drafting from it doesn't re-propose decisions.
    const brief = await t.run(async (ctx) => ctx.db.get(demo.briefFileId));
    const openQuestions = brief!.content!.split("## Open questions")[1]!.split("\n## ")[0]!;
    expect(openQuestions.trim()).toBe(`- ${DEMO_OPEN_QUESTION}`);
    // proposal.md is created live in the demo.
    expect(files.some(([name]) => String(name).includes("proposal"))).toBe(false);

    const context = await as("alex").query(api.workspaces.getWorkspaceContext, {
      workspaceId: demo.workspaceId,
    });
    expect(context?.decisions.map((d) => d.text)).toEqual([DEMO_DECISION, DEMO_AGENT_DECISION]);
    expect(context?.decisions[1]).toMatchObject({
      updatedBy: { type: "agent", label: "Casey's Gemini", userName: "Casey" },
    });
    expect(context?.constraints.map((c) => c.text)).toEqual([DEMO_CONSTRAINT, DEMO_HELP_CENTER_CONSTRAINT]);
    expect(context?.openQuestions.map((q) => q.text)).toEqual([DEMO_OPEN_QUESTION]);
    expect(context?.ownership).toHaveLength(1);

    const tasks = await as("blake").query(api.tasks.listTasks, { workspaceId: demo.workspaceId });
    expect(tasks.map((task) => task.status).sort()).toEqual(["done", "in_progress", "open"]);

  });

  it("a rebuild replaces only the demo workspace and revokes its old tokens", async () => {
    const { t, rebuild, as } = await setup();
    const first = await rebuild();
    // Alex's own non-demo workspace, and an edit to the demo, both from before the reset.
    // Named like the demo on purpose: only the seeded workspace is replaced.
    const other = await as("alex").mutation(api.workspaces.createWorkspace, { name: DEMO_WORKSPACE_NAME });
    await as("blake").mutation(api.files.createDocument, {
      workspaceId: first.workspaceId,
      name: "proposal.md",
      mimeType: "text/markdown",
      content: "draft",
    });
    await t.run(async (ctx) => {
      const actor = { type: "system" as const, label: "test" };
      const workspaceId = first.workspaceId;
      await ctx.db.insert("tasks", {
        workspaceId,
        title: "Leftover",
        description: "",
        status: "open",
        version: 1,
        createdBy: actor,
        updatedBy: actor,
        revision: 1,
        createdAt: 0,
        updatedAt: 0,
      });
      // Context intelligence rows (Blake's save above also logged an activity event).
      const runId = await ctx.db.insert("context_intel_runs", {
        workspaceId,
        status: "succeeded",
        method: "heuristic",
        eventIds: [],
        attempt: 1,
        created: 1,
        updated: 0,
        contextChanges: 0,
        startedAt: 0,
      });
      const entry = {
        workspaceId,
        key: "task:leftover",
        category: "task" as const,
        title: "Leftover",
        content: "",
        status: "active" as const,
        evidence: "observed" as const,
        confidence: 0.5,
        evidenceEventIds: [],
      };
      const entryId = await ctx.db.insert("context_entries", {
        ...entry,
        agentConnectionIds: [],
        fileIds: [],
        createdBy: actor,
        updatedBy: actor,
        revision: 1,
        createdAt: 0,
        updatedAt: 0,
      });
      await ctx.db.insert("context_entry_revisions", {
        ...entry,
        entryId,
        revision: 1,
        change: "created",
        reason: "test",
        runId,
        actor,
        createdAt: 0,
      });
    });

    const intelRows = await t.run(async (ctx) => ({
      events: (await ctx.db.query("activity_events").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", first.workspaceId)).collect()).length,
      state: await ctx.db.query("context_intel_state").withIndex("by_workspace", (q) => q.eq("workspaceId", first.workspaceId)).unique(),
    }));
    expect(intelRows.events).toBeGreaterThan(0);
    expect(intelRows.state).not.toBeNull();

    const second = await rebuild();
    expect(second.workspaceId).not.toBe(first.workspaceId);
    const workspaces = await as("alex").query(api.workspaces.listWorkspaces, {});
    expect(workspaces.map((w) => w.id).sort()).toEqual([other, second.workspaceId].sort());
    expect(await t.run((ctx) => ctx.db.get(other))).not.toBeNull();

    expect((await workspaceInfo(t, first.members[0]!.token)).status).toBe(401);
    expect((await workspaceInfo(t, second.members[0]!.token)).status).toBe(200);

    const old: Id<"workspaces"> = first.workspaceId;
    const leftovers = await t.run(async (ctx) => [
      ...(await ctx.db.query("files").withIndex("by_workspace", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("folders").withIndex("by_workspace", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("file_revisions").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("context_proposals").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("approvals").withIndex("by_workspace_and_decided", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("structured_context").withIndex("by_workspace", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("workspace_members").withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("agent_connections").withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("workspace_events").withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("tasks").withIndex("by_workspace_and_updated_at", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("activity_events").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("context_entries").withIndex("by_workspace_and_key", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("context_entry_revisions").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("context_intel_runs").withIndex("by_workspace_and_started_at", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("context_intel_state").withIndex("by_workspace", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("outbox_events").withIndex("by_status_and_created", (q) => q.eq("status", "pending")).collect())
        .filter((row) => row.workspaceId === old),
    ]);
    expect(leftovers).toEqual([]);
  });
});

describe("seed:resetDemo", () => {
  it("refuses bad pins before touching any account", async () => {
    const t = newTest();
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Dana" }));
    const dana = t.withIdentity({ subject: `${userId}|session` });
    const workspaceId = await dana.mutation(api.workspaces.createWorkspace, { name: "Dana's" });
    const { token: danasToken } = await dana.action(api.agentConnections.createAgentConnection, {
      workspaceId,
      client: "claude",
    });
    const same = randomSecret("mcp_sk_");
    for (const [args, field] of [
      [{ password: "short" }, "password"],
      [{ tokens: { blake: "mcp_sk_bad" } }, "tokens.blake"],
      [{ tokens: { alex: same, casey: same } }, "tokens.casey"],
      [{ tokens: { blake: danasToken } }, "tokens.blake"],
    ] as const) {
      await expect(t.action(internal.seed.resetDemo, args)).rejects.toThrow(field);
    }
    const accounts = await t.run((ctx) => ctx.db.query("authAccounts").take(10));
    expect(accounts).toEqual([]);
    expect((await workspaceInfo(t, danasToken)).info).toMatchObject({ workspaces: [{ id: workspaceId }] });
  });
});
