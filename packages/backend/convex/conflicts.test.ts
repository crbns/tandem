/// <reference types="vite/client" />
// Context conflict detection and resolution (docs/conflict-resolution.md).
// The LLM is a stubbed global fetch; scheduled checks run under fake timers.
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_MCP_SCOPES } from "./lib/mcpConfig";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

const modules = import.meta.glob("./**/*.ts");
const SITE = "https://tandem-test.convex.site";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = SITE;
  process.env.SITE_URL = "https://tandem.example";
});

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CONFLICT_WAIT_MS = "0";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CONFLICT_WAIT_MS;
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

async function connect(as: Caller, workspaceId: Id<"workspaces">, client: string) {
  const created = await as.action(api.agentConnections.createAgentConnection, { workspaceId, client });
  return {
    apiKey: created.token,
    token: { userId: created.connectionId, scopes: ALL_MCP_SCOPES, connectionId: `grant_${created.connectionId}` },
  };
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const result = (await res.json()).result as { isError?: boolean; structuredContent: Record<string, any> };
  expect(result.isError).toBeUndefined();
  return result.structuredContent;
}

/** Alex owns the workspace; Sam is a member. Each has an assistant connected. */
async function setup() {
  const t = newTest();
  mcpTest.register(t);
  const insertUser = (name: string) =>
    t.run((ctx) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@example.com` }));
  const alexId = await insertUser("Alex");
  const samId = await insertUser("Sam");
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session` });
  const alex = as(alexId);
  const sam = as(samId);
  const workspaceId = await alex.mutation(api.workspaces.createWorkspace, { name: "Demo" });
  const invite = await alex.mutation(api.workspaces.createWorkspaceInvite, { workspaceId, role: "member" });
  await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: invite.token });
  const claude = await connect(sam, workspaceId, "claude");
  const chatgpt = await connect(alex, workspaceId, "chatgpt");
  const propose = (
    agent: { token: unknown },
    change: { field: "decision" | "constraint" | "goal" | "scope" | "open_question"; proposedValue: string; supersedes?: string; expectedVersion?: number },
  ) =>
    t.mutation(internal.mcpTools.proposeContextChange, {
      principal: agent.token as never,
      rationale: "From the spec",
      sourceFileIds: [],
      ...change,
    });
  /** A human owner's direct edit: approved context with no proposal. */
  const approve = async (field: "decision" | "constraint", text: string) => {
    const before = await alex.query(api.context.getDetails, { workspaceId });
    await alex.mutation(api.context.updateContextField, {
      workspaceId, field, proposedValue: text, sourceFileIds: [], expectedVersion: before.revision,
    });
    const after = await alex.query(api.context.getDetails, { workspaceId });
    return after[field === "decision" ? "decisions" : "constraints"].at(-1)!;
  };
  const proposal = (id: Id<"context_proposals">) => t.run((ctx) => ctx.db.get(id));
  const settle = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, alex, sam, alexId, workspaceId, claude, chatgpt, propose, approve, proposal, settle };
}

type Judgement = { relation: string; confidence: number; explanation?: string };

/** Stubs the Messages API: one verdict per candidate from `judge`. */
function stubModel(judge: (proposed: string, candidate: string) => Judgement) {
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    const content = JSON.parse(init.body).messages[0].content as string;
    const data = JSON.parse(content.slice("<data>".length, -"</data>".length));
    const verdicts = data.candidates.map((c: { id: string; text: string }) => ({
      id: c.id,
      explanation: "Both choose the auth provider.",
      ...judge(data.proposed.text, c.text),
    }));
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ verdicts }) }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const contradicts = (): Judgement => ({ relation: "contradicts", confidence: 0.93 });
const compatible = (): Judgement => ({ relation: "compatible", confidence: 0.9 });

describe("simultaneous conflicting updates", () => {
  it("holds the second of two contradictory proposals with a competing item on the first", async () => {
    const { claude, chatgpt, propose, proposal, settle } = await setup();
    const fetch = stubModel(contradicts);
    const first = await propose(claude, { field: "decision", proposedValue: "Use Convex Auth" });
    // Nothing to compare against yet.
    expect(first.proposal).toMatchObject({ status: "pending", conflict: null });
    const second = await propose(chatgpt, { field: "decision", proposedValue: "Switch authentication to Clerk" });
    expect(second.proposal.conflict).toMatchObject({ status: "checking", items: [] });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    const held = await proposal(second.proposal.id);
    expect(held).toMatchObject({
      status: "pending",
      hasConflict: true,
      conflict: {
        status: "conflict",
        method: "semantic",
        model: "claude-haiku-5-5",
        items: [{ kind: "competing", targetType: "proposal", targetId: first.proposal.id, targetText: "Use Convex Auth", confidence: 0.93 }],
      },
    });
    expect(held!.conflict!.items[0]!.uncertain).toBeUndefined();
    // The first proposal shows the conflict too.
    expect(await proposal(first.proposal.id)).toMatchObject({
      status: "pending",
      hasConflict: true,
      conflict: { status: "conflict", items: [{ kind: "competing", targetId: second.proposal.id, targetText: "Switch authentication to Clerk" }] },
    });
  });

  it("finds two proposals superseding the same decision structurally, without the LLM", async () => {
    const { claude, chatgpt, propose, approve, proposal, settle } = await setup();
    const fetch = stubModel(contradicts);
    const d1 = await approve("decision", "Use Convex Auth");
    const a = await propose(claude, { field: "decision", proposedValue: "Use Clerk", supersedes: d1.id });
    const b = await propose(chatgpt, { field: "decision", proposedValue: "Use Auth0", supersedes: d1.id });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(a.proposal.conflict).toMatchObject({
      status: "conflict", method: "structural",
      items: [{ kind: "replaces", targetType: "decision", targetId: d1.id, targetText: "Use Convex Auth" }],
    });
    expect(b.proposal.conflict).toMatchObject({
      status: "conflict", method: "structural",
      items: [
        { kind: "replaces", targetId: d1.id },
        { kind: "competing", targetType: "proposal", targetId: a.proposal.id, targetText: "Use Clerk" },
      ],
    });
    expect((await proposal(a.proposal.id))!.conflict!.items).toMatchObject([
      { kind: "replaces", targetId: d1.id },
      { kind: "competing", targetId: b.proposal.id, targetText: "Use Auth0" },
    ]);
  });
});

describe("competing goals", () => {
  it("marks rival goal proposals on each other, and retargets the rival once one is approved", async () => {
    const { alex, workspaceId, claude, chatgpt, propose, proposal } = await setup();
    const fetch = stubModel(contradicts);
    const a = await propose(claude, { field: "goal", proposedValue: "Ship the beta" });
    const b = await propose(chatgpt, { field: "goal", proposedValue: "Win Cal Hacks" });
    expect(fetch).not.toHaveBeenCalled();
    expect(b.proposal.conflict).toMatchObject({ status: "conflict", items: [{ kind: "competing", targetId: a.proposal.id }] });
    expect((await alex.query(api.context.listConflicts, { workspaceId })).pending.map((p) => p.id).sort())
      .toEqual([a.proposal.id, b.proposal.id].sort());
    await alex.mutation(api.context.decideContextProposal, { proposalId: a.proposal.id, decision: "approved" });
    expect((await proposal(b.proposal.id))!.conflict!.items).toMatchObject([
      { kind: "contradicts", targetType: "goal", targetId: "goal", targetText: "Ship the beta" },
    ]);
    // Rejecting a rival instead drops the item, leaving the other clear.
    const c = await propose(claude, { field: "scope", proposedValue: "Web only" });
    const d = await propose(chatgpt, { field: "scope", proposedValue: "Web and mobile" });
    await alex.mutation(api.context.decideContextProposal, { proposalId: d.proposal.id, decision: "rejected" });
    expect(await proposal(c.proposal.id)).toMatchObject({ status: "pending", conflict: { status: "clear", items: [] } });
  });
});

describe("stale writes", () => {
  it("rejects a stale expected_version with VERSION_CONFLICT and writes no proposal", async () => {
    const { t, claude, propose, approve } = await setup();
    stubModel(contradicts);
    await approve("decision", "Use Convex Auth");
    expect(await errorData(propose(claude, { field: "decision", proposedValue: "Use Clerk", expectedVersion: 1 })))
      .toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 2 });
    expect(await t.run((ctx) => ctx.db.query("context_proposals").collect())).toEqual([]);
  });

  it("marks a superseding proposal stale once its target was superseded, after retargeting it", async () => {
    const { alex, workspaceId, claude, chatgpt, propose, approve, proposal } = await setup();
    stubModel(contradicts);
    const d1 = await approve("decision", "Use Convex Auth");
    const a = await propose(claude, { field: "decision", proposedValue: "Use Clerk", supersedes: d1.id });
    const b = await propose(chatgpt, { field: "decision", proposedValue: "Use Auth0", supersedes: d1.id });
    await alex.mutation(api.context.decideContextProposal, { proposalId: b.proposal.id, decision: "approved" });
    const context = await alex.query(api.context.getDetails, { workspaceId });
    const auth0 = context.decisions.find((e) => e.text === "Use Auth0")!;
    expect(context.decisions.find((e) => e.id === d1.id)).toMatchObject({ status: "superseded", supersededBy: auth0.id });
    // a's rival is now an approved decision.
    expect((await proposal(a.proposal.id))!.conflict!.items).toMatchObject([
      { kind: "replaces", targetId: d1.id },
      { kind: "contradicts", targetType: "decision", targetId: auth0.id, targetText: "Use Auth0", contextVersion: context.revision },
    ]);
    await alex.mutation(api.context.decideContextProposal, { proposalId: a.proposal.id, decision: "approved" });
    expect((await proposal(a.proposal.id))!.status).toBe("stale");
    expect((await alex.query(api.context.getDetails, { workspaceId })).decisions.filter((e) => e.status === "active"))
      .toMatchObject([{ id: auth0.id }]);
  });
});

describe("compatible changes", () => {
  it("clears a compatible addition and applies it after the verdict in an automatic workspace", async () => {
    const { alex, workspaceId, claude, propose, approve, proposal, settle } = await setup();
    const fetch = stubModel(compatible);
    await approve("decision", "Use Convex for the backend");
    await alex.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "automatic" });
    const r = await propose(claude, { field: "constraint", proposedValue: "Ship by Sunday" });
    // Held while checking, even in an automatic workspace.
    expect(r.proposal).toMatchObject({ status: "pending", conflict: { status: "checking" } });
    expect((await alex.query(api.context.getDetails, { workspaceId })).constraints).toEqual([]);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    const applied = await proposal(r.proposal.id);
    expect(applied).toMatchObject({ status: "applied", conflict: { status: "clear", items: [] } });
    expect(applied!.hasConflict).toBeUndefined();
    const context = await alex.query(api.context.getDetails, { workspaceId });
    expect(context.constraints).toMatchObject([{ id: applied!.appliedEntryId, text: "Ship by Sunday", status: "active", updatedBy: { type: "agent" } }]);
    expect(applied!.contextRevision).toBe(context.revision);
  });

  it("makes no LLM call for open questions, goals or a decision with nothing to compare", async () => {
    const { claude, propose, settle } = await setup();
    const fetch = stubModel(contradicts);
    const question = await propose(claude, { field: "open_question", proposedValue: "Who reviews auth?" });
    const goal = await propose(claude, { field: "goal", proposedValue: "Ship the beta" });
    const decision = await propose(claude, { field: "decision", proposedValue: "Use Convex Auth" });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    for (const r of [question, goal, decision]) expect(r.proposal.conflict).toBeNull();
  });
});

describe("duplicate requests", () => {
  it("returns the existing proposal for a repeat, with one row, one event and at most one LLM call", async () => {
    const { t, claude, approve, settle } = await setup();
    const fetch = stubModel(compatible);
    await approve("decision", "Use Convex Auth");
    const args = { field: "decisions", proposed_value: "Use Convex for file storage", rationale: "Spec" };
    const first = await callTool(t, claude.apiKey, "propose_context_change", args);
    const again = await callTool(t, claude.apiKey, "propose_context_change", { ...args, proposed_value: "  use convex for FILE storage " });
    expect(first.deduplicated).toBe(false);
    expect(again.deduplicated).toBe(true);
    expect(again.proposal.id).toBe(first.proposal.id);
    expect(again.next_steps[0]).toMatch(/already proposed/);
    await settle();
    const rows = await t.run((ctx) => ctx.db.query("context_proposals").collect());
    expect(rows).toHaveLength(1);
    const events = await t.run((ctx) => ctx.db.query("workspace_events").collect());
    expect(events.filter((e) => e.kind === "context.proposed")).toHaveLength(1);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("concurrent resolutions", () => {
  it("lets only one of two decisions through, with exactly one approvals row", async () => {
    const { t, alex, claude, chatgpt, propose, approve } = await setup();
    stubModel(contradicts);
    const d1 = await approve("decision", "Use Convex Auth");
    const r = await propose(claude, { field: "decision", proposedValue: "Use Clerk", supersedes: d1.id });
    void chatgpt;
    const results = await Promise.allSettled([
      alex.mutation(api.context.decideContextProposal, { proposalId: r.proposal.id, decision: "approved" }),
      alex.mutation(api.context.decideContextProposal, { proposalId: r.proposal.id, decision: "rejected", resolution: "retained_current" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(await errorData(Promise.reject(failed.reason))).toMatchObject({ code: "PROPOSAL_ALREADY_DECIDED" });
    const approvals = await t.run((ctx) =>
      ctx.db.query("approvals").withIndex("by_proposal", (q) => q.eq("proposalId", r.proposal.id)).collect(),
    );
    expect(approvals).toHaveLength(1);
  });

  it("rejects a decision on a revision the person didn't see with PROPOSAL_CHANGED", async () => {
    const { alex, chatgpt, propose, approve, proposal, settle } = await setup();
    stubModel(contradicts);
    await approve("decision", "Use Convex Auth");
    const r = await propose(chatgpt, { field: "decision", proposedValue: "Switch authentication to Clerk" });
    const seen = r.proposal.revision;
    await settle();
    expect((await proposal(r.proposal.id))!.revision).toBe(seen + 1);
    expect(await errorData(alex.mutation(api.context.decideContextProposal, {
      proposalId: r.proposal.id, decision: "approved", expectedRevision: seen,
    }))).toMatchObject({ code: "PROPOSAL_CHANGED", currentRevision: seen + 1 });
    expect((await proposal(r.proposal.id))!.status).toBe("pending");
  });

  it("ignores a verdict that arrives after a person decided", async () => {
    const { t, alex, workspaceId, chatgpt, propose, approve, proposal, settle } = await setup();
    const fetch = stubModel(contradicts);
    await approve("decision", "Use Convex Auth");
    const r = await propose(chatgpt, { field: "decision", proposedValue: "Switch authentication to Clerk" });
    await alex.mutation(api.context.decideContextProposal, { proposalId: r.proposal.id, decision: "approved", resolution: "kept_both" });
    await settle();
    // A late record is a no-op too.
    await t.mutation(internal.conflicts.recordVerdict, { proposalId: r.proposal.id, method: "semantic", items: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(await proposal(r.proposal.id)).toMatchObject({ status: "approved", resolution: "kept_both", conflict: { status: "checking" } });
    const events = await t.run((ctx) => ctx.db.query("workspace_events").collect());
    expect(events.some((e) => e.kind === "context.conflict_checked")).toBe(false);
    expect((await alex.query(api.context.getDetails, { workspaceId })).decisions.map((e) => e.status)).toEqual(["active", "active"]);
  });
});

describe("uncertain verdicts", () => {
  async function heldInAutomatic(stub: () => unknown) {
    const s = await setup();
    await s.approve("decision", "Use Convex Auth");
    await s.alex.mutation(api.workspaces.setContextApproval, { workspaceId: s.workspaceId, mode: "automatic" });
    stub();
    const r = await s.propose(s.chatgpt, { field: "decision", proposedValue: "Switch authentication to Clerk" });
    await s.settle();
    const held = await s.proposal(r.proposal.id);
    expect(held).toMatchObject({ status: "pending", hasConflict: true, conflict: { status: "uncertain" } });
    expect(held!.conflict!.items).toMatchObject([{ kind: "contradicts", uncertain: true, targetText: "Use Convex Auth" }]);
    expect((await s.alex.query(api.context.getDetails, { workspaceId: s.workspaceId })).decisions).toHaveLength(1);
    return held!.conflict!;
  }

  it("holds a low-confidence contradiction for a person, even when automatic", async () => {
    const conflict = await heldInAutomatic(() => stubModel(() => ({ relation: "contradicts", confidence: 0.5 })));
    expect(conflict).toMatchObject({ method: "semantic", items: [{ confidence: 0.5 }] });
  });

  it("holds an unsure verdict", async () => {
    await heldInAutomatic(() => stubModel(() => ({ relation: "unsure", confidence: 0.9 })));
  });

  it("treats a failed call as uncertain, never as compatible", async () => {
    const conflict = await heldInAutomatic(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); })));
    expect(conflict.reason).toBe("Semantic check unavailable: request failed");
  });

  it("treats an HTTP error or unparseable output as uncertain", async () => {
    const http = await heldInAutomatic(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("overloaded", { status: 529 }))));
    expect(http.reason).toBe("Semantic check unavailable: HTTP 529");
    const garbage = await heldInAutomatic(() => vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "Sure! They conflict." }] }), { status: 200 }))));
    expect(garbage.reason).toBe("Semantic check unavailable: unparseable response");
  });

  it("falls back to a word-overlap heuristic without an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetch = vi.fn();
    const conflict = await heldInAutomatic(() => vi.stubGlobal("fetch", fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(conflict).toMatchObject({ method: "heuristic", reason: expect.stringMatching(/no ANTHROPIC_API_KEY/) });
    expect(conflict.items[0]!.explanation).toContain('"auth…"');
    // No shared words: clear, and it applies.
    const { alex, workspaceId, claude, propose, proposal, settle } = await setup();
    await alex.mutation(api.context.updateContextField, { workspaceId, field: "decision", proposedValue: "Use Convex Auth", sourceFileIds: [], expectedVersion: 1 });
    await alex.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "automatic" });
    const r = await propose(claude, { field: "constraint", proposedValue: "Ship by Sunday" });
    await settle();
    expect(await proposal(r.proposal.id)).toMatchObject({ status: "applied", conflict: { status: "clear", method: "heuristic" } });
  });
});

describe("resolution outcomes", () => {
  async function conflicted() {
    const s = await setup();
    stubModel(contradicts);
    const current = await s.approve("decision", "Use Convex Auth");
    const r = await s.propose(s.chatgpt, { field: "decision", proposedValue: "Switch authentication to Clerk" });
    await s.settle();
    const held = await s.proposal(r.proposal.id);
    expect(held!.conflict).toMatchObject({ status: "conflict", items: [{ kind: "contradicts", targetId: current.id }] });
    return { ...s, current, id: r.proposal.id, revision: held!.revision };
  }

  it("accepts the proposal, supersedes the old decision, and both assistants see the resolution", async () => {
    const { t, alex, alexId, workspaceId, claude, chatgpt, current, id, revision, proposal } = await conflicted();
    const before = await callTool(t, claude.apiKey, "sync_workspace", { detail: "brief" });
    expect(before.brief.blockers.conflicts).toMatchObject([{
      proposal_id: id, field: "decisions", status: "conflict", proposed_value: "Switch authentication to Clerk",
      conflicts_with: [{ type: "decision", id: current.id, text: "Use Convex Auth" }],
    }]);
    expect(before.brief.active_decisions).toMatchObject([{ text: "Use Convex Auth" }]);

    await alex.mutation(api.context.decideContextProposal, {
      proposalId: id, decision: "approved", resolution: "accepted", note: "Clerk gives us SSO", expectedRevision: revision,
    });
    const context = await alex.query(api.context.getDetails, { workspaceId });
    const clerk = context.decisions.find((e) => e.text === "Switch authentication to Clerk")!;
    // History is retained: the old decision is superseded, not deleted.
    expect(context.decisions).toMatchObject([
      { id: current.id, text: "Use Convex Auth", status: "superseded", supersededBy: clerk.id },
      { id: clerk.id, status: "active" },
    ]);
    expect(await proposal(id)).toMatchObject({
      status: "approved", resolution: "accepted", decisionNote: "Clerk gives us SSO", appliedEntryId: clerk.id,
      decidedBy: { type: "human", userId: alexId },
    });
    const [approval] = await t.run((ctx) => ctx.db.query("approvals").collect());
    expect(approval).toMatchObject({ resolution: "accepted", note: "Clerk gives us SSO", decidedBy: { userId: alexId } });
    const conflicts = await alex.query(api.context.listConflicts, { workspaceId });
    expect(conflicts.pending).toEqual([]);
    expect(conflicts.resolved).toMatchObject([{ id, resolution: "accepted", decisionNote: "Clerk gives us SSO" }]);

    const resolved = {
      proposal_id: id, field: "decisions", outcome: "accepted", note: "Clerk gives us SSO",
      resolved_by: { actor_type: "human", user_id: alexId },
      in_effect: [{ id: clerk.id, text: "Switch authentication to Clerk" }],
      not_in_effect: ["Use Convex Auth"],
    };
    // Incremental for the assistant that synced before, snapshot for the other.
    const since = await callTool(t, claude.apiKey, "sync_workspace", { since: before.cursor });
    expect(since.resolved_conflicts).toMatchObject([resolved]);
    expect(since.brief.blockers.conflicts).toEqual([]);
    expect(since.brief.active_decisions).toEqual([{ id: clerk.id, text: "Switch authentication to Clerk" }]);
    expect(since.events.map((e: { type: string }) => e.type)).toContain("context.conflict_resolved");
    const snapshot = await callTool(t, chatgpt.apiKey, "sync_workspace", { detail: "brief" });
    expect(snapshot.resolved_conflicts).toMatchObject([resolved]);
    expect(snapshot.brief.active_decisions).toEqual([{ id: clerk.id, text: "Switch authentication to Clerk" }]);
    // The cursor acknowledged it.
    expect((await callTool(t, claude.apiKey, "sync_workspace", { since: since.cursor })).resolved_conflicts).toEqual([]);
    const approvals = await callTool(t, chatgpt.apiKey, "get_approvals", { status: "approved" });
    expect(approvals.proposals).toMatchObject([{ id, resolution: "accepted", decision_note: "Clerk gives us SSO", conflict: { status: "conflict" } }]);
  });

  it("keeps the current decision without changing the context", async () => {
    const { t, alex, workspaceId, claude, current, id } = await conflicted();
    const before = await alex.query(api.context.getDetails, { workspaceId });
    await alex.mutation(api.context.decideContextProposal, { proposalId: id, decision: "rejected", resolution: "retained_current", note: "Not now" });
    expect(await alex.query(api.context.getDetails, { workspaceId })).toEqual(before);
    const events = await t.run((ctx) => ctx.db.query("workspace_events").collect());
    expect(events.find((e) => e.kind === "context.conflict_resolved")?.summary)
      .toBe('Kept "Use Convex Auth" over "Switch authentication to Clerk"');
    const sync = await callTool(t, claude.apiKey, "sync_workspace");
    expect(sync.resolved_conflicts).toMatchObject([{
      outcome: "retained_current", note: "Not now",
      in_effect: [{ id: current.id, text: "Use Convex Auth" }], not_in_effect: ["Switch authentication to Clerk"],
    }]);
  });

  it("keeps both when a person says it isn't a conflict", async () => {
    const { alex, workspaceId, id } = await conflicted();
    await alex.mutation(api.context.decideContextProposal, { proposalId: id, decision: "approved", resolution: "kept_both" });
    expect((await alex.query(api.context.getDetails, { workspaceId })).decisions.map((e) => [e.text, e.status])).toEqual([
      ["Use Convex Auth", "active"],
      ["Switch authentication to Clerk", "active"],
    ]);
  });

  it("rejects a resolution that doesn't match the decision, or an overlong note", async () => {
    const { alex, id } = await conflicted();
    expect(await errorData(alex.mutation(api.context.decideContextProposal, { proposalId: id, decision: "approved", resolution: "retained_current" })))
      .toMatchObject({ code: "INVALID_INPUT", field: "resolution" });
    expect(await errorData(alex.mutation(api.context.decideContextProposal, { proposalId: id, decision: "rejected", note: "x".repeat(2001) })))
      .toMatchObject({ code: "INVALID_INPUT", field: "note" });
  });

  it("only lets owners and admins resolve, and only members list conflicts", async () => {
    const { sam, workspaceId, id } = await conflicted();
    expect(await errorData(sam.mutation(api.context.decideContextProposal, { proposalId: id, decision: "approved" })))
      .toMatchObject({ code: "FORBIDDEN" });
    expect((await sam.query(api.context.listConflicts, { workspaceId })).pending).toMatchObject([{ id, conflict: { status: "conflict" } }]);
  });
});

describe("propose_context_change over MCP", () => {
  it("returns the conflict with the approved target, its text and context_version, and says it's not in effect", async () => {
    const { t, claude, approve } = await setup();
    stubModel(contradicts);
    const d1 = await approve("decision", "Use Convex Auth");
    const r = await callTool(t, claude.apiKey, "propose_context_change", {
      field: "decisions", proposed_value: "Use Clerk", rationale: "SSO", supersedes: d1.id,
    });
    expect(r.deduplicated).toBe(false);
    expect(r.proposal).toMatchObject({
      status: "pending", resolution: null, decision_note: null,
      conflict: {
        status: "conflict", method: "structural", reason: null,
        items: [{ kind: "replaces", uncertain: false, target_type: "decision", target_id: d1.id, target_text: "Use Convex Auth",
          target_by: { actor_type: "human" }, context_version: 2, confidence: null }],
      },
    });
    const steps = r.next_steps.join(" ");
    expect(steps).toMatch(/NOT in effect/);
    expect(steps).toContain(`approved decision ${d1.id} ("Use Convex Auth") at context_version 2`);
    const sync = await callTool(t, claude.apiKey, "sync_workspace");
    expect(sync.pending_proposals).toMatchObject([{ id: r.proposal.id, conflict: { status: "conflict" } }]);
    expect(sync.context.decisions).toMatchObject([{ id: d1.id, status: "active" }]);
  });

  it("returns checking with next steps when the verdict isn't back yet, then the verdict via get_approvals", async () => {
    const { t, chatgpt, approve, settle } = await setup();
    stubModel(contradicts);
    await approve("decision", "Use Convex Auth");
    const r = await callTool(t, chatgpt.apiKey, "propose_context_change", {
      field: "decisions", proposed_value: "Switch authentication to Clerk", rationale: "SSO",
    });
    expect(r.proposal.conflict.status).toBe("checking");
    expect(r.next_steps[0]).toMatch(/still running.*NOT in effect/);
    await settle();
    const approvals = await callTool(t, chatgpt.apiKey, "get_approvals");
    expect(approvals.proposals).toMatchObject([{ id: r.proposal.id, status: "pending",
      conflict: { status: "conflict", method: "semantic", items: [{ kind: "contradicts", target_text: "Use Convex Auth" }] } }]);
  });
});

describe("demo: two assistants, one auth decision", () => {
  const CONVEX = "Use Convex Auth for authentication";
  const CLERK = "Switch authentication to Clerk";
  // What each resolution leaves in effect, as decision texts.
  const outcomes = {
    accepted: { decision: "approved", active: [CLERK], inEffect: [CLERK], notInEffect: [CONVEX] },
    kept_both: { decision: "approved", active: [CONVEX, CLERK], inEffect: [CLERK, CONVEX], notInEffect: [] },
    retained_current: { decision: "rejected", active: [CONVEX], inEffect: [CONVEX], notInEffect: [CLERK] },
    rejected: { decision: "rejected", active: [CONVEX], inEffect: [CONVEX], notInEffect: [CLERK] },
  } as const;
  const cases = (["accepted", "kept_both", "retained_current", "rejected"] as const).flatMap((resolution) =>
    [false, true].map((supersedes) => ({ resolution, supersedes })),
  );

  it.each(cases)("$resolution (supersedes: $supersedes): both assistants see the authoritative decision", async ({ resolution, supersedes }) => {
    const { t, alex, workspaceId, claude, chatgpt, settle } = await setup();
    const fetch = stubModel(contradicts);
    const texts = (decisions: { text: string; status: string }[]) =>
      decisions.filter((e) => e.status === "active").map((e) => e.text);

    // Claude proposes the decision, and a person approves it.
    const a = await callTool(t, claude.apiKey, "propose_context_change", { field: "decisions", proposed_value: CONVEX, rationale: "Spec" });
    expect(a.proposal).toMatchObject({ status: "pending", conflict: null });
    await alex.mutation(api.context.decideContextProposal, { proposalId: a.proposal.id, decision: "approved" });
    const convexAuth = (await alex.query(api.context.getDetails, { workspaceId })).decisions.find((e) => e.text === CONVEX)!;
    const version = (await alex.query(api.context.getDetails, { workspaceId })).revision;

    // ChatGPT proposes the contradicting change.
    const b = await callTool(t, chatgpt.apiKey, "propose_context_change", {
      field: "decisions", proposed_value: CLERK, rationale: "SSO", ...(supersedes ? { supersedes: convexAuth.id } : {}),
    });
    const target = { target_type: "decision", target_id: convexAuth.id, target_text: CONVEX, context_version: version };
    if (supersedes) {
      // Structural: found inline, without the LLM.
      expect(b.proposal.conflict).toMatchObject({ status: "conflict", method: "structural", items: [{ kind: "replaces", ...target }] });
      expect(b.next_steps.join(" ")).toContain(`approved decision ${convexAuth.id} ("${CONVEX}") at context_version ${version}`);
    } else {
      expect(b.proposal.conflict).toMatchObject({ status: "checking", items: [] });
    }
    await settle();
    expect(fetch).toHaveBeenCalledTimes(supersedes ? 0 : 1);

    // Both assistants see the held proposal as a blocker, not as context.
    const cursors: Record<string, string> = {};
    for (const [name, agent] of [["claude", claude], ["chatgpt", chatgpt]] as const) {
      const brief = await callTool(t, agent.apiKey, "sync_workspace", { detail: "brief" });
      expect(brief.brief.active_decisions).toEqual([{ id: convexAuth.id, text: CONVEX }]);
      expect(brief.brief.blockers.conflicts).toEqual([{
        proposal_id: b.proposal.id, field: "decisions", proposed_value: CLERK, proposed_by: expect.objectContaining({ actor_type: "agent" }),
        status: "conflict", conflicts_with: [{ type: "decision", id: convexAuth.id, text: CONVEX }], context_version: version,
      }]);
      const full = await callTool(t, agent.apiKey, "sync_workspace");
      expect(full.pending_proposals).toMatchObject([{
        id: b.proposal.id, conflict: { status: "conflict", items: [{ kind: supersedes ? "replaces" : "contradicts", ...target }] },
      }]);
      expect(texts(full.context.decisions)).toEqual([CONVEX]);
      cursors[name] = full.cursor;
    }

    // A person resolves it from the card they saw.
    const { pending } = await alex.query(api.context.listConflicts, { workspaceId });
    expect(pending.map((p) => p.id)).toEqual([b.proposal.id]);
    const expected = outcomes[resolution];
    await alex.mutation(api.context.decideContextProposal, {
      proposalId: b.proposal.id, decision: expected.decision, resolution, note: "Settled in standup", expectedRevision: pending[0]!.revision,
    });
    const decisions = (await alex.query(api.context.getDetails, { workspaceId })).decisions;
    const idOf = (text: string) => decisions.find((e) => e.text === text)!.id;
    expect(texts(decisions)).toEqual(expected.active);

    const resolved = {
      proposal_id: b.proposal.id, field: "decisions", proposed_value: CLERK, outcome: resolution, note: "Settled in standup",
      resolved_by: { actor_type: "human" },
      in_effect: expected.inEffect.map((text) => ({ id: idOf(text), text })),
      not_in_effect: expected.notInEffect,
    };
    for (const [name, agent] of [["claude", claude], ["chatgpt", chatgpt]] as const) {
      const since = await callTool(t, agent.apiKey, "sync_workspace", { since: cursors[name] });
      expect(since.resolved_conflicts).toMatchObject([resolved]);
      expect(texts(since.context.decisions)).toEqual(expected.active);
      expect(since.pending_proposals).toEqual([]);
      const snapshot = await callTool(t, agent.apiKey, "sync_workspace", { detail: "brief" });
      expect(snapshot.resolved_conflicts).toMatchObject([resolved]);
      expect(snapshot.brief.active_decisions.map((e: { text: string }) => e.text)).toEqual(expected.active);
      expect(snapshot.brief.blockers.conflicts).toEqual([]);
    }
  });
});

describe("dedupe only catches true repeats", () => {
  it("re-applies an applied change that was since replaced, but still dedupes one in effect", async () => {
    const { alex, workspaceId, claude, chatgpt, propose } = await setup();
    stubModel(contradicts);
    await alex.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "automatic" });
    const first = await propose(claude, { field: "goal", proposedValue: "Ship the beta" });
    expect(first.proposal.status).toBe("applied");
    // Still in effect: a retry returns the same proposal.
    expect(await propose(claude, { field: "goal", proposedValue: "Ship the beta" })).toMatchObject({
      deduplicated: true, proposal: { id: first.proposal.id },
    });
    await propose(chatgpt, { field: "goal", proposedValue: "Win Cal Hacks" });
    // Replaced since: setting it back is a new change, not a retry.
    const back = await propose(claude, { field: "goal", proposedValue: "Ship the beta" });
    expect(back.deduplicated).toBe(false);
    expect(back.proposal.id).not.toBe(first.proposal.id);
    expect((await alex.query(api.context.getDetails, { workspaceId })).goal?.text).toBe("Ship the beta");
  });

  it("never dedupes two people's identical proposals", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    stubModel(contradicts);
    const change = { workspaceId, field: "open_question" as const, proposedValue: "Who reviews auth?", rationale: "Spec", sourceFileIds: [] };
    const a = await alex.mutation(api.context.proposeContextChange, change);
    const b = await sam.mutation(api.context.proposeContextChange, change);
    expect(a.id).not.toBe(b.id);
    expect(await t.run((ctx) => ctx.db.query("context_proposals").collect())).toHaveLength(2);
  });
});

describe("context that changes during the check", () => {
  it("checks again when a contradicting decision is approved while the LLM call is in flight", async () => {
    const { alex, workspaceId, chatgpt, propose, approve, proposal, settle } = await setup();
    await approve("decision", "Use Postgres for storage");
    await alex.mutation(api.workspaces.setContextApproval, { workspaceId, mode: "automatic" });
    let calls = 0;
    const inner = stubModel((_proposed, candidate) =>
      candidate.includes("Convex Auth") ? { relation: "contradicts", confidence: 0.95 } : { relation: "compatible", confidence: 0.9 },
    );
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      // A person approves a contradicting decision mid-call.
      if (calls++ === 0) await approve("decision", "Use Convex Auth");
      return inner(url, init);
    }));
    const r = await propose(chatgpt, { field: "decision", proposedValue: "Switch authentication to Clerk" });
    await settle();
    expect(calls).toBe(2);
    const held = await proposal(r.proposal.id);
    // Not applied over the new decision: held for a person instead.
    expect(held).toMatchObject({ status: "pending", conflict: { status: "conflict", items: [{ kind: "contradicts", targetText: "Use Convex Auth" }] } });
    expect((await alex.query(api.context.getDetails, { workspaceId })).decisions.map((e) => e.text))
      .toEqual(["Use Postgres for storage", "Use Convex Auth"]);
  });

  it("drops a competing item whose rival was rejected while the LLM call was in flight", async () => {
    const { alex, claude, chatgpt, propose, proposal, settle } = await setup();
    const inner = stubModel(contradicts);
    const rival = await propose(claude, { field: "decision", proposedValue: "Use Convex Auth" });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      if (calls++ === 0)
        await alex.mutation(api.context.decideContextProposal, { proposalId: rival.proposal.id, decision: "rejected" });
      return inner(url, init);
    }));
    const r = await propose(chatgpt, { field: "decision", proposedValue: "Switch authentication to Clerk" });
    await settle();
    expect(calls).toBe(1);
    expect(await proposal(r.proposal.id)).toMatchObject({ status: "pending", conflict: { status: "clear", items: [] } });
  });
});
