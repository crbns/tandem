import { beforeEach, describe, expect, it } from "vitest";
import { createMockApi, MOCK_WORKSPACE_ID, type MockTandemApi } from "@/lib/api/mock";
import type { Actor, AgentNetwork, NetworkAgent, TimelineItem, TimelinePage } from "@/lib/api/types";
import {
  agentStatus,
  mergeTimeline,
  networkHeadline,
  propagation,
  resourceHref,
  ringPositions,
  takeArrivals,
  arrivalLog,
} from "@/lib/live";

const MINUTE = 60_000;
const human: Actor = { actorType: "human", userId: "user_demo", userName: "Demo Human" };

function agent(overrides: Partial<NetworkAgent> = {}): NetworkAgent {
  return {
    connectionId: "c1",
    label: "Alex's Claude",
    client: "claude",
    oauthClientName: null,
    lastMcpActionAt: null,
    lastSyncAt: null,
    syncedContextRevision: null,
    syncedContextBrief: false,
    contextVersionsBehind: null,
    lastTool: null,
    lastKind: null,
    lastOutcome: null,
    ...overrides,
  };
}

function item(id: string, createdAt: number): TimelineItem {
  return {
    id,
    source: "agent",
    createdAt,
    kind: "read",
    tool: "read_file",
    outcome: "ok",
    errorCode: null,
    summary: "",
    actor: { type: "agent", label: "A", client: "claude", agentConnectionId: "c1" },
    resource: null,
    contextRevision: 1,
    previousSyncedContextRevision: null,
    resolvesId: null,
  };
}

describe("Live helpers", () => {
  it("derives status from the last call only, never 'online'", () => {
    const now = 100 * MINUTE;
    expect(agentStatus(agent(), now)).toBe("none");
    expect(agentStatus(agent({ lastMcpActionAt: now - MINUTE }), now)).toBe("active");
    expect(agentStatus(agent({ lastSyncAt: now - 10 * MINUTE }), now)).toBe("recent");
    expect(agentStatus(agent({ lastMcpActionAt: now - 45 * MINUTE }), now)).toBe("idle");
  });

  it("labels propagation from the synced context revision", () => {
    expect(propagation(agent()).label).toBe("Never synchronized");
    expect(propagation(agent({ syncedContextRevision: 3, contextVersionsBehind: 0 })).state).toBe("current");
    expect(propagation(agent({ syncedContextRevision: 2, contextVersionsBehind: 1 })).label).toBe("Behind by 1 version");
    expect(propagation(agent({ syncedContextRevision: 1, contextVersionsBehind: 2 })).label).toBe("Behind by 2 versions");
  });

  it("says how many assistants have received the context", () => {
    const network = (agents: NetworkAgent[]): AgentNetwork => ({ contextRevision: 3, contextUpdatedAt: 0, agents });
    expect(networkHeadline(network([]))).toMatch(/No assistants/);
    const current = agent({ syncedContextRevision: 3, contextVersionsBehind: 0 });
    const behind = agent({ connectionId: "c2", syncedContextRevision: 2, contextVersionsBehind: 1 });
    expect(networkHeadline(network([current, behind]))).toBe("1 of 2 assistants have received context v3.");
    expect(networkHeadline(network([current, { ...current, connectionId: "c3" }]))).toBe("All 2 assistants have received context v3.");
  });

  it("only counts unseen items as arrivals, oldest first", () => {
    const seen = arrivalLog([item("a", 1)]);
    const fresh = takeArrivals(seen, [item("c", 3), item("b", 2), item("a", 1)]);
    expect(fresh.map((i) => i.id)).toEqual(["b", "c"]);
    expect(takeArrivals(seen, [item("c", 3)])).toEqual([]);
  });

  it("doesn't pulse for an old item re-entering the head page", () => {
    const seen = arrivalLog([item("new", 60_000)]);
    expect(takeArrivals(seen, [item("new", 60_000), item("old", 1_000)])).toEqual([]);
  });

  it("marks an up-to-date brief sync", () => {
    expect(propagation(agent({ syncedContextRevision: 3, syncedContextBrief: true, contextVersionsBehind: 0 }))).toMatchObject({
      state: "current",
      label: "Up to date (brief)",
      brief: true,
    });
  });

  it("keeps items that scrolled off the head page", () => {
    const merged = mergeTimeline([item("b", 2), item("a", 1)], [item("c", 3), item("b", 2)]);
    expect(merged.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("links resources to their dashboard pages", () => {
    expect(resourceHref("ws", { type: "file", id: "f1", label: "a.md" })).toBe("/w/ws/files/f1");
    // Older history links proposals; they now open the project context.
    expect(resourceHref("ws", { type: "proposal", id: "p", label: null })).toBe("/w/ws/context");
    expect(resourceHref("ws", { type: "context", id: "ws", label: null })).toBe("/w/ws/context");
    expect(resourceHref("ws", { type: "task", id: "t", label: null })).toBeNull();
  });

  it("spaces ring positions evenly from the top", () => {
    const [top, right] = ringPositions(4, 100, 50);
    expect(top!.x).toBeCloseTo(0);
    expect(top!.y).toBeCloseTo(-50);
    expect(right!.x).toBeCloseTo(100);
  });
});

describe("mock Live queries", () => {
  let api: MockTandemApi;
  beforeEach(() => {
    api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
  });

  function next<T>(watch: (onData: (data: T) => void) => () => void, skip = 0): Promise<T> {
    return new Promise((resolve) => {
      let n = 0;
      const stop = watch((data) => {
        if (n++ < skip) return;
        stop();
        resolve(data);
      });
    });
  }
  const network = (skip = 0) =>
    next<AgentNetwork>((onData) => api.watchAgentNetwork(MOCK_WORKSPACE_ID, { onData, onError: () => {} }), skip);
  const timeline = () => api.listTimeline(MOCK_WORKSPACE_ID, {});

  it("lists only real connections, derived from the seed", async () => {
    const { agents, contextRevision } = await network();
    expect(agents.map((a) => a.connectionId)).toEqual(["conn_alex_claude"]);
    expect(agents[0]!.contextVersionsBehind).toBe(0);
    expect(contextRevision).toBe(2);
    const page: TimelinePage = await timeline();
    expect(page.items.some((i) => i.kind === "sync")).toBe(true);
    expect(page.items.some((i) => i.kind === "write" && i.tool === "update_context")).toBe(true);
  });

  it("puts an assistant behind after a context change, and back after its sync", async () => {
    await api.listWorkspaces();
    await api.changeContext(MOCK_WORKSPACE_ID, { field: "decision", value: "Demo ChatGPT as the second client, read-only", sourceFileIds: [] });
    expect((await timeline()).items[0]).toMatchObject({ kind: "context", summary: "Updated decision", actor: { type: "human" } });
    let agents = (await network()).agents;
    expect(agents[0]!.contextVersionsBehind).toBe(1);
    api.__simulateAgentCall("conn_alex_claude", "sync");
    agents = (await network()).agents;
    expect(agents[0]!.contextVersionsBehind).toBe(0);
    const sync = (await timeline()).items[0]!;
    expect(sync).toMatchObject({ kind: "sync", contextRevision: 3, previousSyncedContextRevision: 2 });
  });

  it("records a stale write as a conflict, then the retry as resolved", async () => {
    const before = await api.listFiles(MOCK_WORKSPACE_ID);
    api.__simulateAgentCall("conn_alex_claude", "stale_write");
    expect(await api.listFiles(MOCK_WORKSPACE_ID)).toEqual(before);
    const conflict = (await timeline()).items[0]!;
    expect(conflict).toMatchObject({ kind: "conflict", outcome: "conflict", errorCode: "VERSION_CONFLICT" });
    api.__simulateAgentCall("conn_alex_claude", "write");
    const resolved = (await timeline()).items[0]!;
    expect(resolved).toMatchObject({ kind: "resolved", resolvesId: conflict.id });
  });

  it("filters by kind and paginates with nextBefore", async () => {
    for (let i = 0; i < 3; i++) api.__simulateAgentCall("conn_alex_claude", "read");
    const reads = await api.listTimeline(MOCK_WORKSPACE_ID, { kinds: ["read"], limit: 2 });
    expect(reads.items.every((i) => i.kind === "read")).toBe(true);
    expect(reads.items).toHaveLength(2);
    expect(reads.nextBefore).not.toBeNull();
  });

  it("pushes read-only calls to a watching network", async () => {
    const updated = network(1);
    await new Promise((r) => setTimeout(r, 0));
    api.__simulateAgentCall("conn_alex_claude", "read");
    expect((await updated).agents[0]!.lastTool).toBe("read_file");
  });
});
