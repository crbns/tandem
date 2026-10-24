import { describe, expect, it } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { api } from "@repo/backend/convex/_generated/api.js";
import type { Id } from "@repo/backend/convex/_generated/dataModel.js";
import { createConvexApi } from "@/lib/api/convex";
import { TandemApiError } from "@/lib/api/errors";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import type { Actor, Task } from "@/lib/api/types";
import { orderTasks, TASK_STATUS_LABEL } from "@/lib/tasks";

// Typed from the backend's generated function types, so a shape change fails check-types.
type BackendTask = FunctionReturnType<typeof api.tasks.listTasks>[number];

const SAM_ID = "users_sam" as Id<"users">;
const BACKEND_TASK: BackendTask = {
  id: "tasks_1" as Id<"tasks">,
  title: "Draft the pitch",
  description: "Two slides",
  status: "in_progress",
  ownerId: SAM_ID,
  ownerName: "Sam",
  version: 2,
  createdBy: { type: "human", userId: SAM_ID, label: "Sam" },
  updatedBy: {
    type: "agent",
    userId: SAM_ID,
    agentConnectionId: "agent_connections_1" as Id<"agent_connections">,
    label: "Claude",
    client: "claude",
    userName: "Sam",
  },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
  completedAt: null,
};

function fakeConvex(responses: Record<string, unknown>) {
  const calls: { name: string; args: unknown }[] = [];
  const run = async (ref: FunctionReference<"query">, args: unknown) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const res = responses[name];
    if (res === undefined) throw new Error(`no fixture for ${name}`);
    return res;
  };
  return { client: { query: run } as unknown as ConvexReactClient, calls };
}

const task = (overrides: Partial<Task>): Task => ({
  id: "t",
  title: "t",
  description: "",
  status: "open",
  ownerId: null,
  ownerName: null,
  version: 1,
  createdBy: { actorType: "human", userId: "u" },
  updatedBy: { actorType: "human", userId: "u" },
  createdAt: 0,
  updatedAt: 0,
  completedAt: null,
  ...overrides,
});

describe("tasks", () => {
  it("convex adapter calls tasks:listTasks and maps actors", async () => {
    const { client, calls } = fakeConvex({ "tasks:listTasks": [BACKEND_TASK] });
    const tasks = await createConvexApi(client).listTasks("workspaces_1");
    expect(calls).toEqual([{ name: "tasks:listTasks", args: { workspaceId: "workspaces_1" } }]);
    expect(tasks).toEqual([
      {
        id: "tasks_1",
        title: "Draft the pitch",
        description: "Two slides",
        status: "in_progress",
        ownerId: SAM_ID,
        ownerName: "Sam",
        version: 2,
        createdBy: { actorType: "human", userId: SAM_ID, userName: "Sam" },
        updatedBy: {
          actorType: "agent",
          userId: SAM_ID,
          userName: "Sam",
          agentName: "Claude",
          agentClient: "claude",
        },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_060_000,
        completedAt: null,
      } satisfies Task,
    ]);
  });

  it("mock api seeds one open, one in-progress and one done task for members", async () => {
    const human: Actor = { actorType: "human", userId: "user_demo", userName: "Demo Human" };
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const tasks = await api.listTasks(MOCK_WORKSPACE_ID);
    expect(tasks.map((t) => t.status).sort()).toEqual(["done", "in_progress", "open"]);
    expect(tasks.find((t) => t.status === "in_progress")?.ownerName).toBe("Alex");
    expect(tasks.find((t) => t.status === "open")?.ownerId).toBeNull();
    expect(tasks.find((t) => t.status === "done")?.completedAt).toBeTypeOf("number");
    // Newest update first, like the backend.
    expect([...tasks].sort((a, b) => b.updatedAt - a.updatedAt)).toEqual(tasks);
    await expect(api.listTasks("ws_unknown")).rejects.toBeInstanceOf(TandemApiError);
  });

  it("orders active tasks before done ones, newest first, with readable labels", () => {
    const ordered = orderTasks([
      task({ id: "done-new", status: "done", updatedAt: 30 }),
      task({ id: "open-old", status: "open", updatedAt: 10 }),
      task({ id: "claimed", status: "in_progress", updatedAt: 20 }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["claimed", "open-old", "done-new"]);
    expect(ordered.map((t) => TASK_STATUS_LABEL[t.status])).toEqual(["In progress", "Open", "Done"]);
  });
});
