/// <reference types="vite/client" />
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_MCP_SCOPES } from "./lib/mcpConfig";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

const modules = import.meta.glob("./**/*.ts");

beforeAll(() => {
  process.env.CONVEX_SITE_URL = "https://tandem-test.convex.site";
  process.env.SITE_URL = "https://tandem.example";
});

/** Resolves to the thrown ConvexError's data, or fails the test. */
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

function principalFor(connectionId: string, scopes: string[] = ALL_MCP_SCOPES) {
  return { userId: connectionId, scopes, connectionId: `grant_${connectionId}` };
}

async function connect(
  as: Caller,
  args: { workspaceId: Id<"workspaces">; client: string },
) {
  const created = await as.action(api.agentConnections.createAgentConnection, args);
  return {
    connectionId: created.connectionId,
    apiKey: created.token,
    principal: principalFor(created.connectionId),
  };
}

async function callTool(
  t: Test,
  bearer: string,
  name: string,
  args: Record<string, unknown> = {},
) {
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
  return ((await res.json()) as { result: unknown }).result as {
    isError?: boolean;
    structuredContent: Record<string, any>;
  };
}

/** Alex and Sam share "Demo" (each with a claude connection); Jordan owns "Other". */
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
  const workspaceId = await alex.mutation(api.workspaces.createWorkspace, { name: "Demo" });
  const invite = await alex.mutation(api.workspaces.createWorkspaceInvite, {
    workspaceId,
    role: "member",
  });
  await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: invite.token });
  const otherWorkspaceId = await jordan.mutation(api.workspaces.createWorkspace, {
    name: "Other",
  });
  const alexAgent = await connect(alex, { workspaceId, client: "claude" });
  const samAgent = await connect(sam, { workspaceId, client: "claude" });
  const jordanAgent = await connect(jordan, { workspaceId: otherWorkspaceId, client: "claude" });
  const headSeq = async (id: Id<"workspaces"> = workspaceId) =>
    (await t.run((ctx) =>
      ctx.db
        .query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", id))
        .order("desc")
        .first(),
    ))?.seq ?? 0;
  type TaskArgs = {
    taskId?: string;
    title?: string;
    description?: string;
    status?: "open" | "in_progress" | "done";
    expectedVersion?: number;
    limit?: number;
  };
  const task = (
    principal: ReturnType<typeof principalFor>,
    operation: "list" | "create" | "claim" | "update" | "complete",
    args: TaskArgs = {},
  ) => t.mutation(internal.mcpTools.manageTask, { principal, operation, ...args });
  /** A write's single task, or fails the test. */
  const write = async (...params: Parameters<typeof task>) => {
    const r = await task(...params);
    if (!("task" in r) || !r.task) throw new Error("expected a task result");
    return r.task;
  };
  const list = async (...params: Parameters<typeof task>) => {
    const r = await task(...params);
    if (!("tasks" in r) || !r.tasks) throw new Error("expected a task list");
    return r.tasks;
  };
  return {
    t, alex, sam, jordan, alexId, samId, jordanId, workspaceId, otherWorkspaceId,
    alexAgent, samAgent, jordanAgent, headSeq, task, write, list,
  };
}

describe("manage_task", () => {
  it("creates an open, unowned task at version 1 and lists it newest first", async () => {
    const { samAgent, write, list, samId } = await setup();
    const first = await write(samAgent.principal, "create", { title: "  Draft brief  " });
    expect(first).toMatchObject({
      title: "Draft brief",
      description: "",
      status: "open",
      ownerId: null,
      ownerName: null,
      version: 1,
      completedAt: null,
      createdBy: { type: "agent", userId: samId, agentConnectionId: samAgent.connectionId },
    });
    const second = await write(samAgent.principal, "create", {
      title: "Review brief",
      description: "Check the numbers",
    });
    expect((await list(samAgent.principal, "list")).map((t) => t.id)).toEqual([second.id, first.id]);
    expect(await list(samAgent.principal, "list", { status: "done" })).toEqual([]);
    expect(await list(samAgent.principal, "list", { limit: 1 })).toHaveLength(1);
  });

  it("claims for the caller's person; a second claim with the same version is TASK_ALREADY_CLAIMED", async () => {
    const { t, sam, samAgent, alexAgent, samId, workspaceId, write, task } = await setup();
    const created = await write(alexAgent.principal, "create", { title: "Write tests" });
    const claimed = await write(samAgent.principal, "claim", { taskId: created.id, expectedVersion: 1 });
    expect(claimed).toMatchObject({
      status: "in_progress",
      ownerId: samId,
      ownerName: "Sam",
      version: 2,
      updatedBy: { userId: samId, agentConnectionId: samAgent.connectionId },
    });
    // Convex serializes the two claims; the loser sees the winner's write.
    expect(
      await errorData(task(alexAgent.principal, "claim", { taskId: created.id, expectedVersion: 1 })),
    ).toMatchObject({
      code: "TASK_ALREADY_CLAIMED",
      taskId: created.id,
      ownerUserId: samId,
      ownerName: "Sam",
      currentVersion: 2,
    });
    // Ownership is by person: Sam's second assistant may work the task.
    const samOther = await connect(sam, { workspaceId, client: "chatgpt" });
    const renamed = await write(samOther.principal, "update", {
      taskId: created.id,
      expectedVersion: 2,
      title: "Write task tests",
    });
    expect(renamed).toMatchObject({ title: "Write task tests", ownerId: samId, version: 3 });
    const row = await t.run((ctx) => ctx.db.get(created.id));
    expect(row).toMatchObject({ version: 3, revision: 3 });
  });

  it("lets exactly one of two concurrent claims win, with one task.claimed event", async () => {
    const { samAgent, alexAgent, samId, alexId, write, task, headSeq } = await setup();
    const created = await write(alexAgent.principal, "create", { title: "Race me" });
    const seq = await headSeq();
    const results = await Promise.allSettled([
      task(samAgent.principal, "claim", { taskId: created.id, expectedVersion: 1 }),
      task(alexAgent.principal, "claim", { taskId: created.id, expectedVersion: 1 }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<{ task?: { ownerId: string | null; version: number } }>)
      .value.task;
    expect(winner?.version).toBe(2);
    expect([samId, alexId]).toContain(winner?.ownerId);
    expect(
      await errorData(Promise.reject((lost[0] as PromiseRejectedResult).reason)),
    ).toMatchObject({ code: "TASK_ALREADY_CLAIMED", ownerUserId: winner?.ownerId, currentVersion: 2 });
    expect(await headSeq()).toBe(seq + 1);
  });

  it("rejects a stale expected_version with VERSION_CONFLICT", async () => {
    const { samAgent, alexAgent, write, task } = await setup();
    const created = await write(alexAgent.principal, "create", { title: "Plan launch" });
    await write(alexAgent.principal, "update", {
      taskId: created.id,
      expectedVersion: 1,
      description: "Dates and owners",
    });
    expect(
      await errorData(task(samAgent.principal, "claim", { taskId: created.id, expectedVersion: 1 })),
    ).toMatchObject({ code: "VERSION_CONFLICT", taskId: created.id, currentVersion: 2, expectedVersion: 1 });
    expect(
      await errorData(task(alexAgent.principal, "update", { taskId: created.id, expectedVersion: 1, title: "x" })),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2 });
  });

  it("lets only the owner update or complete, releases with status open, and keeps done tasks final", async () => {
    const { samAgent, alexAgent, samId, alexId, write, task } = await setup();
    const created = await write(alexAgent.principal, "create", { title: "Ship it" });
    await write(samAgent.principal, "claim", { taskId: created.id, expectedVersion: 1 });
    expect(
      await errorData(task(alexAgent.principal, "update", { taskId: created.id, expectedVersion: 2, title: "Mine" })),
    ).toMatchObject({ code: "TASK_NOT_OWNER", ownerUserId: samId, currentVersion: 2 });
    expect(
      await errorData(task(alexAgent.principal, "complete", { taskId: created.id, expectedVersion: 2 })),
    ).toMatchObject({ code: "TASK_NOT_OWNER", ownerUserId: samId });
    // A no-op update and status done through update are both INVALID_INPUT.
    expect(
      await errorData(task(samAgent.principal, "update", { taskId: created.id, expectedVersion: 2, title: "Ship it" })),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await errorData(task(samAgent.principal, "update", { taskId: created.id, expectedVersion: 2, status: "done" })),
    ).toMatchObject({ code: "INVALID_INPUT", field: "status" });

    const released = await write(samAgent.principal, "update", { taskId: created.id, expectedVersion: 2, status: "open" });
    expect(released).toMatchObject({ status: "open", ownerId: null, ownerName: null, version: 3 });

    // An unowned open task may be completed by any member, who becomes its owner.
    const done = await write(alexAgent.principal, "complete", { taskId: created.id, expectedVersion: 3 });
    expect(done).toMatchObject({ status: "done", ownerId: alexId, version: 4 });
    expect(done.completedAt).toBeTypeOf("number");
    expect(
      await errorData(task(alexAgent.principal, "complete", { taskId: created.id, expectedVersion: 4 })),
    ).toMatchObject({ code: "TASK_DONE", taskId: created.id, currentVersion: 4 });
    expect(
      await errorData(task(alexAgent.principal, "update", { taskId: created.id, expectedVersion: 4, title: "Again" })),
    ).toMatchObject({ code: "TASK_DONE" });
    expect(
      await errorData(task(samAgent.principal, "claim", { taskId: created.id, expectedVersion: 4 })),
    ).toMatchObject({ code: "TASK_ALREADY_CLAIMED", ownerUserId: alexId });
  });

  it("raises headSeq by exactly 1 per write with a task.* event, and not on list or failed writes", async () => {
    const { t, samAgent, alexAgent, workspaceId, write, task, headSeq, list } = await setup();
    const lastEvent = () =>
      t.run((ctx) =>
        ctx.db
          .query("workspace_events")
          .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", workspaceId))
          .order("desc")
          .first(),
      );
    let seq = await headSeq();
    const step = async (kind: string, fn: () => Promise<{ id: Id<"tasks"> }>) => {
      const result = await fn();
      expect(await headSeq()).toBe(seq + 1);
      seq += 1;
      expect(await lastEvent()).toMatchObject({ kind, entityType: "task", entityId: result.id, seq });
      return result;
    };
    const created = await step("task.created", () =>
      write(samAgent.principal, "create", { title: "A fairly long task title" }),
    );
    await list(samAgent.principal, "list");
    expect(await headSeq()).toBe(seq);
    await step("task.claimed", () => write(samAgent.principal, "claim", { taskId: created.id, expectedVersion: 1 }));
    await errorData(task(alexAgent.principal, "claim", { taskId: created.id, expectedVersion: 2 }));
    expect(await headSeq()).toBe(seq);
    await step("task.updated", () =>
      write(samAgent.principal, "update", { taskId: created.id, expectedVersion: 2, description: "More" }),
    );
    await step("task.completed", () => write(samAgent.principal, "complete", { taskId: created.id, expectedVersion: 3 }));
    expect((await lastEvent())?.summary).toBe("Completed task: A fairly long task title");
  });

  it("is TASK_NOT_FOUND for another workspace's task and for malformed ids", async () => {
    const { samAgent, jordanAgent, write, task } = await setup();
    const foreign = await write(jordanAgent.principal, "create", { title: "Secret" });
    for (const operation of ["claim", "update", "complete"] as const)
      expect(
        await errorData(task(samAgent.principal, operation, { taskId: foreign.id, expectedVersion: 1, title: "x" })),
      ).toMatchObject({ code: "TASK_NOT_FOUND", taskId: foreign.id });
    expect(
      await errorData(task(samAgent.principal, "claim", { taskId: "nope", expectedVersion: 1 })),
    ).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("lets a read-only connection list but not write", async () => {
    const { samAgent, write, list, task } = await setup();
    await write(samAgent.principal, "create", { title: "Visible" });
    const readOnly = principalFor(samAgent.connectionId, ["tandem:read"]);
    expect((await list(readOnly, "list")).map((t) => t.title)).toEqual(["Visible"]);
    expect(await errorData(task(readOnly, "create", { title: "Nope" }))).toMatchObject({
      code: "FORBIDDEN",
      scope: "tandem:write",
    });
  });
});

describe("tasks in sync_workspace", () => {
  it("snapshots active tasks with owner and status, and returns changed tasks since a cursor", async () => {
    const { t, samAgent, alexAgent, samId, write } = await setup();
    const open = await write(alexAgent.principal, "create", { title: "Open one" });
    const claimed = await write(alexAgent.principal, "create", { title: "Claimed one" });
    await write(samAgent.principal, "claim", { taskId: claimed.id, expectedVersion: 1 });
    const finished = await write(alexAgent.principal, "create", { title: "Finished one" });
    await write(alexAgent.principal, "complete", { taskId: finished.id, expectedVersion: 1 });

    const snapshot = await t.mutation(internal.mcpTools.syncWorkspace, { principal: samAgent.principal });
    expect(snapshot.tasksTruncated).toBe(false);
    // Newest first, but writes in one millisecond tie, so compare as sets.
    const rows = (r: { tasks: { title: string; status: string; ownerId: string | null }[] }) =>
      r.tasks.map((task) => [task.title, task.status, task.ownerId]).sort();
    expect(rows(snapshot)).toEqual([
      ["Claimed one", "in_progress", samId],
      ["Open one", "open", null],
    ]);

    await write(samAgent.principal, "complete", { taskId: claimed.id, expectedVersion: 2 });
    await write(alexAgent.principal, "update", { taskId: open.id, expectedVersion: 1, title: "Open one, renamed" });
    const since = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: samAgent.principal,
      sinceSeq: snapshot.cursorSeq,
    });
    expect(since.events.map((e) => e.kind)).toEqual(["task.completed", "task.updated"]);
    expect(rows(since)).toEqual([
      ["Claimed one", "done", samId],
      ["Open one, renamed", "open", null],
    ]);
    expect(since.tasksTruncated).toBe(false);

    const quiet = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal: samAgent.principal,
      sinceSeq: since.cursorSeq,
    });
    expect(quiet.tasks).toEqual([]);
  });
});

describe("manage_task over the MCP endpoint", () => {
  it("serves the snake_case task contract, coded errors and tasks in sync", async () => {
    const { t, samAgent, alexAgent, samId } = await setup();
    const created = await callTool(t, alexAgent.apiKey, "manage_task", {
      operation: "create",
      title: "Shared task",
      description: "Do the thing",
    });
    expect(created.isError).toBeUndefined();
    const task = created.structuredContent.task;
    expect(task).toMatchObject({
      title: "Shared task",
      description: "Do the thing",
      status: "open",
      owner: null,
      version: 1,
      completed_at: null,
      created_by: { actor_type: "agent", agent_connection_id: alexAgent.connectionId },
    });
    expect(task.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);

    const claimed = await callTool(t, samAgent.apiKey, "manage_task", {
      operation: "claim",
      task_id: task.id,
      expected_version: 1,
    });
    expect(claimed.structuredContent.task).toMatchObject({
      status: "in_progress",
      owner: { user_id: samId, name: "Sam" },
      version: 2,
    });

    const lost = await callTool(t, alexAgent.apiKey, "manage_task", {
      operation: "claim",
      task_id: task.id,
      expected_version: 1,
    });
    expect(lost.isError).toBe(true);
    expect(lost.structuredContent.error).toMatchObject({
      code: "TASK_ALREADY_CLAIMED",
      task_id: task.id,
      owner: { user_id: samId, name: "Sam" },
      current_version: 2,
    });

    const notOwner = await callTool(t, alexAgent.apiKey, "manage_task", {
      operation: "complete",
      task_id: task.id,
      expected_version: 2,
    });
    expect(notOwner.structuredContent.error).toMatchObject({ code: "TASK_NOT_OWNER", task_id: task.id });

    const stale = await callTool(t, samAgent.apiKey, "manage_task", {
      operation: "complete",
      task_id: task.id,
      expected_version: 1,
    });
    expect(stale.structuredContent.error).toMatchObject({
      code: "VERSION_CONFLICT",
      task_id: task.id,
      current_version: 2,
      expected_version: 1,
    });

    const missing = await callTool(t, samAgent.apiKey, "manage_task", {
      operation: "claim",
      task_id: "missing",
      expected_version: 1,
    });
    expect(missing.structuredContent.error).toMatchObject({ code: "TASK_NOT_FOUND", task_id: "missing" });

    const noVersion = await callTool(t, samAgent.apiKey, "manage_task", { operation: "claim", task_id: task.id });
    expect(noVersion.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", field: "expected_version" });

    const listed = await callTool(t, samAgent.apiKey, "manage_task", { operation: "list", status: "in_progress" });
    expect(listed.structuredContent.tasks.map((x: { id: string }) => x.id)).toEqual([task.id]);

    const sync = await callTool(t, samAgent.apiKey, "sync_workspace");
    expect(sync.structuredContent.tasks_truncated).toBe(false);
    expect(sync.structuredContent.tasks).toEqual([claimed.structuredContent.task]);
  });
});

describe("tasks:listTasks (dashboard)", () => {
  it("lists the workspace's tasks for members and rejects non-members", async () => {
    const { alex, jordan, samAgent, workspaceId, write } = await setup();
    const created = await write(samAgent.principal, "create", { title: "Dashboard task" });
    const rows = await alex.query(api.tasks.listTasks, { workspaceId });
    expect(rows).toEqual([
      expect.objectContaining({
        id: created.id,
        title: "Dashboard task",
        status: "open",
        ownerId: null,
        ownerName: null,
        version: 1,
        completedAt: null,
      }),
    ]);
    expect(await errorData(jordan.query(api.tasks.listTasks, { workspaceId }))).toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
