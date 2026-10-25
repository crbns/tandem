import { describe, expect, it } from "vitest";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import { normalizeError } from "@/lib/api/errors";
import type { Actor, ContextChange, EntryHistory, ObservedContext, Subscriber } from "@/lib/api/types";
import { describeChange, groupEntries, payloadRows } from "@/components/intelligence/describe";

const ALEX: Actor = { actorType: "human", userId: "user_alex", userName: "Alex" };

function first<T>(watch: (subscriber: Subscriber<T>) => () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = watch({
      onData: (data) => {
        stop();
        resolve(data);
      },
      onError: reject,
    });
  });
}

async function setup() {
  let actor = ALEX;
  const api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
  await api.listWorkspaces(); // makes Alex the mock workspace's owner
  return { api, as: (next: Actor) => (actor = next) };
}

describe("mock context intelligence", () => {
  it("renders a plausible observed state with every evidence level and both coordination severities", async () => {
    const { api } = await setup();
    const observed = await first<ObservedContext>((s) => api.watchObservedContext(MOCK_WORKSPACE_ID, s));
    const groups = groupEntries(observed.entries);
    for (const key of ["goals", "decisions", "in_progress", "completed", "blocked", "knowledge", "assistants", "coordination"] as const)
      expect(groups.get(key)!.length, key).toBeGreaterThan(0);
    expect(new Set(observed.entries.map((e) => e.evidence))).toEqual(new Set(["requested", "claimed", "observed", "verified", "human_confirmed"]));
    expect(new Set(observed.entries.map((e) => e.severity).filter(Boolean))).toEqual(new Set(["potential", "actual"]));
    expect(observed.entries.find((e) => e.contextEntryId)).toMatchObject({ category: "goal", contextEntryId: "goal" });

    const feed = await api.listActivityEvents(MOCK_WORKSPACE_ID, { sources: ["simulator"] });
    expect(feed.items.length).toBeGreaterThan(0);
    expect(feed.items.every((e) => e.source === "simulator")).toBe(true);
  });

  it("corrects with optimistic revisions and records a human history row", async () => {
    const { api } = await setup();
    const observed = await first<ObservedContext>((s) => api.watchObservedContext(MOCK_WORKSPACE_ID, s));
    const task = observed.entries.find((e) => e.evidence === "claimed")!;
    const { revision } = await api.correctEntry(MOCK_WORKSPACE_ID, task.id, {
      expectedRevision: task.revision,
      status: "active",
      note: "Not done yet",
    });
    expect(revision).toBe(task.revision + 1);
    const stale = await api
      .correctEntry(MOCK_WORKSPACE_ID, task.id, { expectedRevision: task.revision, title: "x", note: "stale" })
      .catch(normalizeError);
    expect(stale).toMatchObject({ code: "VERSION_CONFLICT", details: { currentRevision: revision } });

    const history = await first<EntryHistory>((s) => api.watchEntryHistory(MOCK_WORKSPACE_ID, task.id, s));
    expect(history.entry).toMatchObject({ evidence: "human_confirmed", revision });
    expect(describeChange(history.revisions[0]!)).toBe("Corrected and confirmed by Alex");
    expect(history.evidence.length).toBeGreaterThan(0);
  });

  it("keeps retry to owners and admins", async () => {
    const { api, as } = await setup();
    expect(await api.retryContextManager(MOCK_WORKSPACE_ID)).toEqual({ scheduled: true });
    as({ actorType: "human", userId: "user_stranger", userName: "Stranger" });
    expect(await api.retryContextManager(MOCK_WORKSPACE_ID).catch(normalizeError)).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("change sentences", () => {
  const base: ContextChange = {
    id: "r", entryId: "e", key: "k", category: "task", revision: 2, change: "status_changed", title: "T", content: "",
    status: "completed", evidence: "verified", confidence: 0.9, reason: "", evidenceCount: 1,
    actor: { type: "system", label: "Tandem context manager", client: null, userName: null }, run: null,
    evidenceSource: { label: "Isaac's Claude Code", source: "claude_code" }, createdAt: 0,
  };

  it("says what happened and how well it's supported", () => {
    expect(describeChange(base)).toBe("Task marked complete (verified)");
    expect(describeChange({ ...base, evidence: "claimed" })).toBe("Task reported complete (unconfirmed)");
    expect(describeChange({ ...base, category: "blocker", status: "resolved" })).toBe("Blocker resolved");
    expect(describeChange({ ...base, change: "created", category: "decision", status: "active" })).toBe(
      "Context manager identified a new decision from Isaac's Claude Code activity",
    );
    expect(describeChange({ ...base, change: "created", evidenceSource: { label: "x", source: "simulator" } })).toBe(
      "Context manager identified a new task from simulated activity",
    );
    expect(describeChange({ ...base, change: "corrected", evidence: "observed", actor: { type: "human", label: "Casey", client: null, userName: "Casey" } })).toBe(
      "Corrected by Casey",
    );
  });

  it("flattens payloads into key/value rows and tolerates non-JSON", () => {
    expect(payloadRows(JSON.stringify({ args: { file_id: "f1" }, exit_code: 0 }))).toEqual([
      ["args.file_id", "f1"],
      ["exit_code", "0"],
    ]);
    expect(payloadRows("not json")).toEqual([["payload", "not json"]]);
    expect(payloadRows(null)).toEqual([]);
  });
});
