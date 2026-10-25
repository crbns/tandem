/// <reference types="vite/client" />
// sync_workspace's `observed` section (lib/observed.ts): derived context from
// the context manager, labeled as not approved, bounded, and tenant-scoped.
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { recordWorkspaceEvent } from "./lib/auth";
import { INTEL_ACTOR } from "./lib/intelQueue";
import { ALL_MCP_SCOPES } from "./lib/mcpConfig";
import { toSyncResult } from "./lib/mcpContract";
import {
  OBSERVED_BRIEF_CONTENT,
  OBSERVED_BRIEF_LIMIT,
  OBSERVED_LIMIT,
  OBSERVED_NOTE,
  OBSERVED_SUPERSEDED_LIMIT,
} from "./lib/observed";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

const modules = import.meta.glob("./**/*.ts");
const SITE = "https://tandem-test.convex.site";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = SITE;
  process.env.SITE_URL = "https://tandem.example";
  // Nothing here should schedule the context manager.
  process.env.INTEL_DISABLED = "1";
});

function newTest() {
  return convexTest(schema, modules);
}
type Test = ReturnType<typeof newTest>;
type Caller = ReturnType<Test["withIdentity"]>;

async function connect(as: Caller, workspaceId: Id<"workspaces">) {
  const created = await as.action(api.agentConnections.createAgentConnection, {
    workspaceId,
    client: "claude",
  });
  return {
    connectionId: created.connectionId,
    apiKey: created.token,
    principal: { userId: created.connectionId, scopes: ALL_MCP_SCOPES, connectionId: `grant_${created.connectionId}` },
  };
}

/** Calls a tool over the real MCP endpoint and returns its structured result. */
async function callTool(t: Test, bearer: string, name: string, args: Record<string, unknown> = {}) {
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const result = (await res.json()).result;
  expect(result.isError).toBeUndefined();
  return result.structuredContent as Record<string, any>;
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
  const samAgent = await connect(sam, workspaceId);
  const jordanAgent = await connect(jordan, otherWorkspaceId);
  return { t, workspaceId, otherWorkspaceId, samAgent, jordanAgent };
}

type EntryInput = Partial<Omit<Doc<"context_entries">, "_id" | "_creationTime">> & {
  workspaceId: Id<"workspaces">;
  key: string;
};

async function insertEntry(t: Test, e: EntryInput) {
  const now = e.updatedAt ?? Date.now();
  return await t.run((ctx) =>
    ctx.db.insert("context_entries", {
      category: "task",
      title: e.key,
      content: `About ${e.key}`,
      status: "active",
      evidence: "observed",
      confidence: 0.8,
      evidenceEventIds: [],
      agentConnectionIds: [],
      fileIds: [],
      createdBy: INTEL_ACTOR,
      updatedBy: INTEL_ACTOR,
      revision: 1,
      createdAt: now,
      ...e,
      updatedAt: now,
    }),
  );
}

async function insertActivity(t: Test, workspaceId: Id<"workspaces">, n: number) {
  return await t.run(async (ctx) => {
    const ids: Id<"activity_events">[] = [];
    for (let i = 0; i < n; i++)
      ids.push(
        await ctx.db.insert("activity_events", {
          workspaceId,
          actor: INTEL_ACTOR,
          source: "claude_code",
          type: "claude_code.tool_use",
          outcome: "ok",
          summary: `event ${i}`,
          resources: [],
          dedupeKey: `evt-${i}`,
          significant: true,
          intelStatus: "processed",
          occurredAt: Date.now(),
          createdAt: Date.now(),
        }),
      );
    return ids;
  });
}

async function setRevision(t: Test, workspaceId: Id<"workspaces">, entriesRevision: number, lastRunAt?: number) {
  await t.run((ctx) =>
    ctx.db.insert("context_intel_state", {
      workspaceId,
      status: "idle",
      consecutiveFailures: 0,
      entriesRevision,
      ...(lastRunAt !== undefined ? { lastRunAt } : {}),
      updatedAt: Date.now(),
    }),
  );
}

describe("sync_workspace observed", () => {
  it("reports an empty observed state, labeled, before the context manager has run", async () => {
    const { t, samAgent } = await setup();
    const full = await callTool(t, samAgent.apiKey, "sync_workspace");
    expect(full.observed).toEqual({
      note: OBSERVED_NOTE,
      revision: 0,
      updated_at: null,
      last_run_at: null,
      entries: [],
      truncated: false,
    });
    expect(full.brief.observed).toEqual(full.observed);
    const brief = await callTool(t, samAgent.apiKey, "sync_workspace", { detail: "brief" });
    expect(brief.brief.observed.revision).toBe(0);
    // Brief keeps observed inside brief only.
    expect(brief).not.toHaveProperty("observed");
  });

  it("includes entries with evidence, agents and revision in snapshot and since-mode syncs", async () => {
    const { t, workspaceId, samAgent } = await setup();
    const doc = await callTool(t, samAgent.apiKey, "create_document", { name: "auth.md", content: "# Auth" });
    const first = await callTool(t, samAgent.apiKey, "sync_workspace");
    const events = await insertActivity(t, workspaceId, 2);
    const lastRunAt = Date.now();
    await setRevision(t, workspaceId, 7, lastRunAt);
    await insertEntry(t, {
      workspaceId,
      key: "task:jwt-auth",
      title: "Implement JWT auth",
      content: "Sam's assistant edited auth.ts and ran the tests; they pass.",
      evidence: "verified",
      confidence: 0.8333,
      evidenceEventIds: events,
      agentConnectionIds: [samAgent.connectionId],
      fileIds: [doc.id],
      updatedAt: lastRunAt - 10,
    });
    await insertEntry(t, { workspaceId, key: "task:old", status: "superseded", supersededBy: "task:jwt-auth", updatedAt: lastRunAt - 20 });
    await insertEntry(t, { workspaceId, key: "task:wrong", status: "retracted", updatedAt: lastRunAt - 5 });

    const full = await callTool(t, samAgent.apiKey, "sync_workspace");
    expect(full.observed.note).toBe(OBSERVED_NOTE);
    expect(full.observed.revision).toBe(7);
    expect(full.observed.last_run_at).toBe(new Date(lastRunAt).toISOString());
    // The newest row is the retracted one: it moves updated_at but never appears.
    expect(full.observed.updated_at).toBe(new Date(lastRunAt - 5).toISOString());
    expect(full.observed.entries.map((e: { key: string }) => e.key)).toEqual(["task:jwt-auth", "task:old"]);
    expect(full.observed.entries[0]).toEqual({
      key: "task:jwt-auth",
      category: "task",
      title: "Implement JWT auth",
      content: "Sam's assistant edited auth.ts and ran the tests; they pass.",
      status: "active",
      evidence: "verified",
      confidence: 0.83,
      agents: [{ agent_connection_id: samAgent.connectionId, label: "Sam's claude assistant", client: "claude", user_name: "Sam" }],
      file_ids: [doc.id],
      evidence_count: 2,
      updated_at: new Date(lastRunAt - 10).toISOString(),
      superseded_by: null,
      proposal_id: null,
    });
    expect(full.observed.entries[1]).toMatchObject({ status: "superseded", superseded_by: "task:jwt-auth" });
    // The brief drops superseded entries.
    expect(full.brief.observed.entries.map((e: { key: string }) => e.key)).toEqual(["task:jwt-auth"]);

    const since = await callTool(t, samAgent.apiKey, "sync_workspace", { since: first.cursor });
    expect(since.events).toEqual([]);
    expect(since.observed).toEqual(full.observed);
    const briefSince = await callTool(t, samAgent.apiKey, "sync_workspace", { since: first.cursor, detail: "brief" });
    expect(briefSince.brief.observed).toEqual(full.brief.observed);

    // syncedContextRevision stays tied to the approved context, not entriesRevision.
    const row = await t.run((ctx) => ctx.db.get(samAgent.connectionId));
    expect(row?.syncedContextRevision).toBe(full.context_version);
    expect(full.context_version).not.toBe(7);
    // Existing fields keep their meaning.
    expect(full.changed_files.map((f: { id: string }) => f.id)).toEqual([doc.id]);
    expect(full.brief.changed_file_count).toBe(1);
    expect(full.brief.goal).toBe("");
  });

  it("caps full and brief results and puts blockers and active tasks first in the brief", async () => {
    const { t, workspaceId, samAgent } = await setup();
    const base = Date.now() - 1_000_000;
    let at = base;
    // Oldest first, so the high-priority entries below are the oldest rows.
    await insertEntry(t, { workspaceId, key: "blocker:ci", category: "blocker", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "blocker:fixed", category: "blocker", status: "resolved", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "task:active", category: "task", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "summary:sam", category: "agent_summary", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "task:done", category: "task", status: "completed", evidence: "verified", updatedAt: at++ });
    for (let i = 0; i < OBSERVED_LIMIT + 5; i++)
      await insertEntry(t, {
        workspaceId,
        key: `knowledge:${i}`,
        category: "knowledge",
        content: "x".repeat(500),
        updatedAt: at++,
      });
    for (let i = 0; i < OBSERVED_SUPERSEDED_LIMIT + 5; i++)
      await insertEntry(t, { workspaceId, key: `old:${i}`, status: "superseded", updatedAt: at++ });

    const full = await callTool(t, samAgent.apiKey, "sync_workspace");
    const entries = full.observed.entries as { key: string; status: string; content: string }[];
    expect(entries.filter((e) => e.status !== "superseded")).toHaveLength(OBSERVED_LIMIT);
    expect(entries.filter((e) => e.status === "superseded")).toHaveLength(OBSERVED_SUPERSEDED_LIMIT);
    expect(full.observed.truncated).toBe(true);
    // Newest first, so the oldest (non-knowledge) rows fall outside the full cap.
    expect(entries[0]!.key).toBe(`old:${OBSERVED_SUPERSEDED_LIMIT + 4}`);
    // Full content is not clipped.
    expect(entries.find((e) => e.key.startsWith("knowledge"))!.content).toHaveLength(500);

    const brief = full.brief.observed;
    expect(brief.entries).toHaveLength(OBSERVED_BRIEF_LIMIT);
    expect(brief.truncated).toBe(true);
    expect(brief.note).toBe(OBSERVED_NOTE);
    for (const e of brief.entries) {
      expect(e.status).not.toBe("superseded");
      expect(e.content.length).toBeLessThanOrEqual(OBSERVED_BRIEF_CONTENT);
    }
    // The prioritized rows were pushed out of the full cap by 65 newer knowledge rows,
    // so the brief is knowledge only, newest first.
    expect(brief.entries[0].key).toBe(`knowledge:${OBSERVED_LIMIT + 4}`);
  });

  it("orders the brief by priority within the loaded entries", async () => {
    const { t, workspaceId, samAgent } = await setup();
    let at = Date.now() - 1_000;
    // Lowest priority newest, so ordering can't be an accident of recency.
    await insertEntry(t, { workspaceId, key: "blocker:ci", category: "blocker", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "task:active", category: "task", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "progress:api", category: "progress", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "summary:sam", category: "agent_summary", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "coord:overlap", category: "coordination", severity: "potential", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "decision:jwt", category: "decision", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "knowledge:stack", category: "knowledge", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "task:done", category: "task", status: "completed", updatedAt: at++ });
    await insertEntry(t, { workspaceId, key: "blocker:fixed", category: "blocker", status: "resolved", updatedAt: at++ });

    const sync = await callTool(t, samAgent.apiKey, "sync_workspace", { detail: "brief" });
    expect(sync.brief.observed.entries.map((e: { key: string }) => e.key)).toEqual([
      "blocker:ci",
      "progress:api",
      "task:active",
      "summary:sam",
      "coord:overlap",
      "decision:jwt",
      "knowledge:stack",
      "task:done",
      "blocker:fixed",
    ]);
    expect(sync.brief.observed.truncated).toBe(false);
  });

  it("never shows another workspace's entries or labels its assistants", async () => {
    const { t, workspaceId, otherWorkspaceId, samAgent, jordanAgent } = await setup();
    await setRevision(t, otherWorkspaceId, 3);
    await insertEntry(t, { workspaceId: otherWorkspaceId, key: "task:secret", agentConnectionIds: [jordanAgent.connectionId] });
    // A malformed row in A that names B's assistant gets no label from B.
    await insertEntry(t, { workspaceId, key: "task:mine", agentConnectionIds: [jordanAgent.connectionId, samAgent.connectionId] });

    const mine = await callTool(t, samAgent.apiKey, "sync_workspace");
    expect(mine.observed.revision).toBe(0);
    expect(mine.observed.entries.map((e: { key: string }) => e.key)).toEqual(["task:mine"]);
    expect(mine.observed.entries[0].agents.map((a: { label: string }) => a.label)).toEqual(["Sam's claude assistant"]);
    expect(JSON.stringify(mine)).not.toContain("task:secret");

    const theirs = await callTool(t, jordanAgent.apiKey, "sync_workspace");
    expect(theirs.observed.revision).toBe(3);
    expect(theirs.observed.entries.map((e: { key: string }) => e.key)).toEqual(["task:secret"]);
  });

  it("surfaces the context manager's context.observed event to since-mode syncs", async () => {
    const { t, workspaceId, samAgent } = await setup();
    const first = await callTool(t, samAgent.apiKey, "sync_workspace");
    await t.run((ctx) =>
      recordWorkspaceEvent(ctx, {
        workspaceId,
        kind: "context.observed",
        entityType: "context",
        entityId: workspaceId,
        summary: "Observed context updated: 2 entries changed",
        actor: INTEL_ACTOR,
      }),
    );
    const since = await callTool(t, samAgent.apiKey, "sync_workspace", { since: first.cursor });
    expect(since.events).toHaveLength(1);
    expect(since.events[0]).toMatchObject({
      type: "context.observed",
      subject_id: workspaceId,
      summary: "Observed context updated: 2 entries changed",
      actor: { label: "Tandem context manager", client: "system" },
    });
    expect(since.brief.recent_changes).toEqual([
      expect.objectContaining({ type: "context.observed", actor: "Tandem context manager", summary: "Observed context updated: 2 entries changed" }),
    ]);
    // It touches no file or task, so nothing else shows up as changed.
    expect(since.changed_files).toEqual([]);
    expect(since.tasks).toEqual([]);

    // The raw internal result carries the same observed state toSyncResult shapes.
    const raw = await t.mutation(internal.mcpTools.syncWorkspace, { principal: samAgent.principal });
    expect(toSyncResult(raw).observed).toEqual(since.observed);
  });
});
