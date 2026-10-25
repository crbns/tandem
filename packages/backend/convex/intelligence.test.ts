/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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

const SYSTEM = { type: "system" as const, label: "Tandem context manager" };

async function setup() {
  const t = convexTest(schema, modules);
  const insertUser = (name: string) =>
    t.run((ctx) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@example.com` }));
  const alexId = await insertUser("Alex");
  const samId = await insertUser("Sam");
  const jordanId = await insertUser("Jordan");
  const outsiderId = await insertUser("Outsider");
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session` });
  const alex = as(alexId);
  const sam = as(samId);
  const jordan = as(jordanId);
  const outsider = as(outsiderId);
  const workspaceId = await alex.mutation(api.workspaces.createWorkspace, { name: "Demo" });
  const invite = await alex.mutation(api.workspaces.createWorkspaceInvite, { workspaceId, role: "member" });
  await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: invite.token });
  const otherWorkspaceId = await jordan.mutation(api.workspaces.createWorkspace, { name: "Other" });
  return { t, alex, sam, jordan, outsider, alexId, samId, jordanId, workspaceId, otherWorkspaceId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A connection, one event, one entry with a revision and a run, in `workspaceId`. */
async function seedIntel(
  { t }: Setup,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  label: string,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const human = { type: "human" as const, userId, label };
    const connectionId = await ctx.db.insert("agent_connections", {
      workspaceId,
      userId,
      client: "claude",
      authKind: "api_key",
      updatedBy: human,
      revision: 1,
      createdAt: now,
    });
    const agent = {
      type: "agent" as const,
      userId,
      agentConnectionId: connectionId,
      client: "claude",
      label: `${label}'s claude assistant`,
      userName: label,
    };
    const fileId = await ctx.db.insert("files", {
      workspaceId,
      name: `${label}-notes.md`,
      mimeType: "text/markdown",
      content: "notes",
      version: 1,
      createdBy: human,
      updatedBy: human,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("activity_events", {
      workspaceId,
      agentConnectionId: connectionId,
      actor: agent,
      source: "claude_code",
      type: "claude_code.tool_use",
      tool: "Bash",
      outcome: "ok",
      summary: `${label} ran the tests`,
      payload: JSON.stringify({ command: "pnpm test", exit_code: 0 }),
      resources: [],
      sessionId: "session-1",
      dedupeKey: `hook:${label}:1`,
      significant: true,
      intelStatus: "processed",
      occurredAt: now,
      createdAt: now,
    });
    const pendingId = await ctx.db.insert("activity_events", {
      workspaceId,
      agentConnectionId: connectionId,
      actor: agent,
      source: "mcp",
      type: "mcp.tool_call",
      tool: "update_document",
      outcome: "conflict",
      errorCode: "VERSION_CONFLICT",
      summary: `${label} hit a version conflict`,
      resources: [{ type: "file", id: fileId, label: `${label}-notes.md` }],
      dedupeKey: `mcp:${label}:2`,
      significant: true,
      intelStatus: "pending",
      occurredAt: now + 1,
      createdAt: now + 1,
    });
    const runId = await ctx.db.insert("context_intel_runs", {
      workspaceId,
      status: "succeeded",
      method: "heuristic",
      eventIds: [eventId],
      attempt: 1,
      summary: "Observed a test run",
      created: 1,
      updated: 0,
      contextChanges: 0,
      entriesRevision: 1,
      startedAt: now,
      finishedAt: now,
    });
    const entryId = await ctx.db.insert("context_entries", {
      workspaceId,
      key: "task:tests",
      category: "task",
      title: `${label}: make tests pass`,
      content: "The test suite is green.",
      status: "completed",
      evidence: "verified",
      confidence: 0.9,
      evidenceEventIds: [eventId],
      agentConnectionIds: [connectionId],
      fileIds: [fileId],
      lastRunId: runId,
      createdBy: SYSTEM,
      updatedBy: SYSTEM,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("context_entry_revisions", {
      workspaceId,
      entryId,
      key: "task:tests",
      revision: 1,
      change: "created",
      category: "task",
      title: `${label}: make tests pass`,
      content: "The test suite is green.",
      status: "completed",
      evidence: "verified",
      confidence: 0.9,
      reason: "Tests passed",
      evidenceEventIds: [eventId],
      runId,
      actor: SYSTEM,
      createdAt: now,
    });
    await ctx.db.insert("context_intel_state", {
      workspaceId,
      status: "idle",
      consecutiveFailures: 2,
      nextRetryAt: now + 60_000,
      lastRunId: runId,
      lastRunAt: now,
      entriesRevision: 1,
      updatedAt: now,
    });
    return { connectionId, fileId, eventId, pendingId, runId, entryId };
  });
}

const intelState = (t: Setup["t"], workspaceId: Id<"workspaces">) =>
  t.run((ctx) =>
    ctx.db
      .query("context_intel_state")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );

describe("intelligence reads", () => {
  it("rejects non-members and signed-out callers", async () => {
    const s = await setup();
    const { workspaceId } = s;
    for (const call of [
      s.outsider.query(api.intelligence.getObservedContext, { workspaceId }),
      s.outsider.query(api.intelligence.listActivityEvents, { workspaceId }),
      s.outsider.query(api.intelligence.listContextChanges, { workspaceId }),
      s.jordan.query(api.intelligence.getObservedContext, { workspaceId }),
    ])
      expect(await errorData(call)).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(s.t.query(api.intelligence.getObservedContext, { workspaceId })),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("returns the observed state with labels, files, run and pending count", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    const observed = await s.sam.query(api.intelligence.getObservedContext, { workspaceId: s.workspaceId });
    expect(observed).toMatchObject({
      revision: 1,
      status: "idle",
      consecutiveFailures: 2,
      pendingEvents: 1,
      lastRun: { status: "succeeded", method: "heuristic", summary: "Observed a test run" },
    });
    expect(observed.entries).toEqual([
      expect.objectContaining({
        id: a.entryId,
        category: "task",
        evidence: "verified",
        agents: [{ connectionId: a.connectionId, label: "Sam's claude assistant", client: "claude" }],
        files: [{ id: a.fileId, name: "Sam-notes.md", deleted: false }],
        contextEntryId: null,
      }),
    ]);
  });

  it("keeps workspaces apart", async () => {
    const s = await setup();
    await seedIntel(s, s.workspaceId, s.samId, "Sam");
    const b = await seedIntel(s, s.otherWorkspaceId, s.jordanId, "Jordan");

    const observed = await s.alex.query(api.intelligence.getObservedContext, { workspaceId: s.workspaceId });
    expect(observed.entries.map((e) => e.title)).toEqual(["Sam: make tests pass"]);
    const feed = await s.alex.query(api.intelligence.listActivityEvents, { workspaceId: s.workspaceId });
    expect(feed.items).toHaveLength(2);
    expect(feed.items.every((e) => e.summary.startsWith("Sam"))).toBe(true);
    // Another workspace's connection reads as empty.
    const viaOther = await s.alex.query(api.intelligence.listActivityEvents, {
      workspaceId: s.workspaceId,
      connectionId: b.connectionId,
    });
    expect(viaOther.items).toEqual([]);
    const changes = await s.alex.query(api.intelligence.listContextChanges, { workspaceId: s.workspaceId });
    expect(changes.changes.map((c) => c.title)).toEqual(["Sam: make tests pass"]);
    expect(changes.runs).toHaveLength(1);

    expect(
      await errorData(
        s.alex.query(api.intelligence.getEntryHistory, { workspaceId: s.workspaceId, entryId: b.entryId }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await errorData(
        s.alex.mutation(api.intelligence.correctEntry, {
          workspaceId: s.workspaceId,
          entryId: b.entryId,
          expectedRevision: 1,
          note: "not ours",
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("lists activity newest first, filtered by source, with payload and paging", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    const all = await s.alex.query(api.intelligence.listActivityEvents, { workspaceId: s.workspaceId });
    expect(all.items.map((e) => e.id)).toEqual([a.pendingId, a.eventId]);
    expect(all.items[0]).toMatchObject({
      source: "mcp",
      outcome: "conflict",
      errorCode: "VERSION_CONFLICT",
      intelStatus: "pending",
    });
    expect(all.items[1]!.payload).toContain("pnpm test");
    expect(all.nextBefore).toBeNull();

    const hooks = await s.alex.query(api.intelligence.listActivityEvents, {
      workspaceId: s.workspaceId,
      sources: ["claude_code"],
    });
    expect(hooks.items.map((e) => e.id)).toEqual([a.eventId]);

    const first = await s.alex.query(api.intelligence.listActivityEvents, { workspaceId: s.workspaceId, limit: 1 });
    expect(first.items.map((e) => e.id)).toEqual([a.pendingId]);
    expect(first.nextBefore).not.toBeNull();
    const second = await s.alex.query(api.intelligence.listActivityEvents, {
      workspaceId: s.workspaceId,
      limit: 1,
      before: first.nextBefore!,
    });
    expect(second.items.map((e) => e.id)).toEqual([a.eventId]);

    const byConnection = await s.alex.query(api.intelligence.listActivityEvents, {
      workspaceId: s.workspaceId,
      connectionId: a.connectionId,
    });
    expect(byConnection.items).toHaveLength(2);
  });

  it("returns an entry's history with its evidence events", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    const history = await s.sam.query(api.intelligence.getEntryHistory, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
    });
    expect(history.entry.id).toBe(a.entryId);
    expect(history.revisions).toEqual([
      expect.objectContaining({
        revision: 1,
        change: "created",
        run: expect.objectContaining({ id: a.runId, method: "heuristic" }),
        evidenceSource: { label: "Sam's claude assistant", source: "claude_code" },
      }),
    ]);
    expect(history.evidence.map((e) => e.id)).toEqual([a.eventId]);
  });

  it("drops evidence ids that point into another workspace", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    const b = await seedIntel(s, s.otherWorkspaceId, s.jordanId, "Jordan");
    await s.t.run((ctx) => ctx.db.patch(a.entryId, { evidenceEventIds: [b.eventId, a.eventId] }));
    const history = await s.sam.query(api.intelligence.getEntryHistory, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
    });
    expect(history.evidence.map((e) => e.id)).toEqual([a.eventId]);
  });
});

describe("human correction", () => {
  it("writes a corrected revision, bumps entriesRevision and records an event", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    const result = await s.sam.mutation(api.intelligence.correctEntry, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
      expectedRevision: 1,
      content: "Only the unit tests pass; e2e still red.",
      status: "active",
      note: "e2e is still failing",
    });
    expect(result).toEqual({ revision: 2, entriesRevision: 2 });
    expect((await intelState(s.t, s.workspaceId))!.entriesRevision).toBe(2);

    const history = await s.alex.query(api.intelligence.getEntryHistory, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
    });
    expect(history.entry).toMatchObject({
      revision: 2,
      status: "active",
      evidence: "human_confirmed",
      confidence: 1,
      content: "Only the unit tests pass; e2e still red.",
      updatedBy: expect.objectContaining({ type: "human", label: "Sam" }),
    });
    expect(history.revisions[0]).toMatchObject({
      revision: 2,
      change: "corrected",
      reason: "e2e is still failing",
      actor: expect.objectContaining({ type: "human", label: "Sam" }),
      run: null,
    });
    const events = await s.t.run((ctx) =>
      ctx.db
        .query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", s.workspaceId))
        .order("desc")
        .first(),
    );
    expect(events).toMatchObject({ kind: "context.corrected", entityId: a.entryId });

    expect(
      await errorData(
        s.alex.mutation(api.intelligence.correctEntry, {
          workspaceId: s.workspaceId,
          entryId: a.entryId,
          expectedRevision: 1,
          title: "stale",
          note: "stale edit",
        }),
      ),
    ).toMatchObject({ code: "VERSION_CONFLICT", currentRevision: 2 });
  });

  it("keeps evidence when only the text changes, and needs a note", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    expect(
      await errorData(
        s.sam.mutation(api.intelligence.correctEntry, {
          workspaceId: s.workspaceId,
          entryId: a.entryId,
          expectedRevision: 1,
          title: "Typo fix",
          note: "   ",
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT", field: "note" });
    await s.sam.mutation(api.intelligence.correctEntry, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
      expectedRevision: 1,
      title: "Make the tests pass",
      note: "Clearer title",
    });
    const observed = await s.sam.query(api.intelligence.getObservedContext, { workspaceId: s.workspaceId });
    expect(observed.entries[0]).toMatchObject({ title: "Make the tests pass", evidence: "verified", revision: 2 });
  });

  it("creates the scheduler row when a correction comes first", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    await s.t.run(async (ctx) => {
      const state = await ctx.db
        .query("context_intel_state")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", s.workspaceId))
        .unique();
      await ctx.db.delete(state!._id);
    });
    const result = await s.sam.mutation(api.intelligence.retractEntry, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
      expectedRevision: 1,
    });
    expect(result).toEqual({ revision: 2, entriesRevision: 1 });
    expect(await intelState(s.t, s.workspaceId)).toMatchObject({ status: "idle", entriesRevision: 1 });
  });

  it("retracts an entry", async () => {
    const s = await setup();
    const a = await seedIntel(s, s.workspaceId, s.samId, "Sam");
    await s.alex.mutation(api.intelligence.retractEntry, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
      expectedRevision: 1,
      note: "This never happened",
    });
    const history = await s.alex.query(api.intelligence.getEntryHistory, {
      workspaceId: s.workspaceId,
      entryId: a.entryId,
    });
    expect(history.entry).toMatchObject({ status: "retracted", revision: 2 });
    expect(history.revisions[0]).toMatchObject({ change: "corrected", reason: "This never happened" });
    expect(
      await errorData(
        s.outsider.mutation(api.intelligence.retractEntry, {
          workspaceId: s.workspaceId,
          entryId: a.entryId,
          expectedRevision: 2,
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("retryContextManager", () => {
  it("is for owners and admins only", async () => {
    const s = await setup();
    await seedIntel(s, s.workspaceId, s.samId, "Sam");
    expect(
      await errorData(s.sam.mutation(api.intelligence.retryContextManager, { workspaceId: s.workspaceId })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await errorData(s.jordan.mutation(api.intelligence.retryContextManager, { workspaceId: s.workspaceId })),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("clears the backoff and schedules a batch that runs", async () => {
    vi.useFakeTimers();
    const s = await setup();
    await seedIntel(s, s.workspaceId, s.samId, "Sam");
    const result = await s.alex.mutation(api.intelligence.retryContextManager, { workspaceId: s.workspaceId });
    expect(result).toEqual({ scheduled: true });
    const state = await intelState(s.t, s.workspaceId);
    expect(state).toMatchObject({ status: "scheduled", consecutiveFailures: 0 });
    expect(state!.nextRetryAt).toBeUndefined();

    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const jobs = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: "intel:processWorkspace", state: { kind: "success" } });
  });

  it("creates the scheduler row for a workspace that has none", async () => {
    const s = await setup();
    await s.alex.mutation(api.intelligence.retryContextManager, { workspaceId: s.workspaceId });
    expect(await intelState(s.t, s.workspaceId)).toMatchObject({
      status: "scheduled",
      consecutiveFailures: 0,
      entriesRevision: 0,
    });
  });
});
