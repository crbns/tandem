/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { generateAgentToken } from "./lib/agent";
import { DEMO_GOAL, DEMO_SCOPE, DEMO_WORKSPACE_NAME } from "./seed";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const insertUser = (name: string) =>
    t.run((ctx) => ctx.db.insert("users", { name: `${name} (signed up)` }));
  const people = [
    { key: "alex" as const, userId: await insertUser("Alex") },
    { key: "blake" as const, userId: await insertUser("Blake") },
    { key: "casey" as const, userId: await insertUser("Casey") },
  ];
  const rebuild = () =>
    t.mutation(internal.seed.rebuildDemoWorkspace, {
      people: people.map((p) => ({ ...p, token: generateAgentToken() })),
    });
  const as = (key: "alex" | "blake" | "casey") =>
    t.withIdentity({ subject: `${people.find((p) => p.key === key)!.userId}|session` });
  return { t, rebuild, as };
}

describe("seed:rebuildDemoWorkspace", () => {
  it("builds the demo: members, brief.md v1 by Alex, approved goal and scope, live tokens", async () => {
    const { t, rebuild, as } = await setup();
    const demo = await rebuild();
    expect(demo.workspaceName).toBe(DEMO_WORKSPACE_NAME);

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
    const approvals = await as("alex").query(api.context.getApprovals, {
      workspaceId: demo.workspaceId,
    });
    expect(approvals.map((p) => [p.field, p.status]).sort()).toEqual([
      ["goal", "approved"],
      ["scope", "approved"],
    ]);

    const files = await as("alex").query(api.files.listFiles, {
      workspaceId: demo.workspaceId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(files.page.map((f) => [f.name, f.version, f.updatedBy.label])).toEqual([
      ["brief.md", 1, "Alex"],
    ]);

    for (const member of demo.members) {
      const session = await t.query(api.mcp.verifyToken, { token: member.token });
      expect(session).toMatchObject({
        workspaceId: demo.workspaceId,
        userId: member.userId,
        client: member.client,
      });
    }
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

    const second = await rebuild();
    expect(second.workspaceId).not.toBe(first.workspaceId);
    const workspaces = await as("alex").query(api.workspaces.listWorkspaces, {});
    expect(workspaces.map((w) => w.id).sort()).toEqual([other, second.workspaceId].sort());
    expect(await t.run((ctx) => ctx.db.get(other))).not.toBeNull();

    await expect(
      t.query(api.mcp.verifyToken, { token: first.members[0]!.token }),
    ).rejects.toThrow(/UNAUTHENTICATED/);

    const old: Id<"workspaces"> = first.workspaceId;
    const leftovers = await t.run(async (ctx) => [
      ...(await ctx.db.query("files").withIndex("by_workspace", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("file_revisions").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("context_proposals").withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("approvals").withIndex("by_workspace_and_decided", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("structured_context").withIndex("by_workspace", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("workspace_members").withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("agent_connections").withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("workspace_events").withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", old)).collect()),
      ...(await ctx.db.query("outbox_events").withIndex("by_status_and_created", (q) => q.eq("status", "pending")).collect())
        .filter((row) => row.workspaceId === old),
    ]);
    expect(leftovers).toEqual([]);
  });
});

describe("seed:resetDemo", () => {
  it("refuses bad pins before touching any account", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Dana" }));
    const dana = t.withIdentity({ subject: `${userId}|session` });
    const workspaceId = await dana.mutation(api.workspaces.createWorkspace, { name: "Dana's" });
    const { token: danasToken } = await dana.mutation(api.agentConnections.createAgentConnection, {
      workspaceId,
      client: "claude",
    });
    const same = generateAgentToken();
    for (const [args, field] of [
      [{ password: "short" }, "password"],
      [{ tokens: { blake: "tdm_bad" } }, "tokens.blake"],
      [{ tokens: { alex: same, casey: same } }, "tokens.casey"],
      [{ tokens: { blake: danasToken } }, "tokens.blake"],
    ] as const) {
      await expect(t.action(internal.seed.resetDemo, args)).rejects.toThrow(field);
    }
    const accounts = await t.run((ctx) => ctx.db.query("authAccounts").take(10));
    expect(accounts).toEqual([]);
    expect(await t.query(api.mcp.verifyToken, { token: danasToken })).toMatchObject({ workspaceId });
  });
});
