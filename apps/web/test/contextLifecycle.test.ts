import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TandemApiContext } from "@/lib/api";
import { ContextFieldPanel } from "@/components/context/ContextFieldPanel";
import { createMockApi, MOCK_WORKSPACE_ID as workspaceId } from "@/lib/api/mock";
import { displayId } from "@/lib/files";
import { toContextDetails } from "@/lib/api/convex";
import type { Actor, ContextEntry, ContextField } from "@/lib/api/types";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@repo/backend/convex/_generated/api.js";

const human: Actor = { actorType: "human", userId: "owner", userName: "Owner" };
const agent: Actor = { ...human, actorType: "agent", agentName: "Claude", agentClient: "claude" };
const input = { field: "open_question" as const, proposedValue: "When do we launch?", rationale: "Planning", sourceFileIds: [] };
const setup = () => {
  let actor = human;
  return { mock: createMockApi({ latencyMs: [0, 0], getActor: () => actor }), as: (next: Actor) => { actor = next; } };
};

describe("context lifecycle", () => {
  it("immediately records agent working context, retains stable IDs and resolver attribution, and lets a human remove it", async () => {
    const { mock, as } = setup();
    await mock.listWorkspaces();
    const changed = vi.fn();
    mock.watchWorkspace(workspaceId, changed);
    as(agent);
    const result = await mock.proposeContextChange(workspaceId, input);
    expect(result.status).toBe("applied");
    const before = await mock.getContext(workspaceId);
    // Reads from the dashboard use a human session.
    as(human);
    let context = await mock.getContextDetails(workspaceId);
    const entry = context.openQuestions[0]!;
    expect(entry).toMatchObject({ status: "active", updatedBy: agent, resolvedAt: null });
    expect(entry.id).toBeTruthy();
    as(agent);
    await mock.proposeContextChange(workspaceId, { field: input.field, rationale: input.rationale, sourceFileIds: [], operation: "resolve", entryId: entry.id, expectedVersion: context.version });
    as(human);
    context = await mock.getContextDetails(workspaceId);
    expect(context.openQuestions[0]).toMatchObject({ id: entry.id, status: "resolved", resolvedBy: agent, resolvedAt: expect.any(Number) });
    expect(context.version).toBe(before!.version + 1);
    const resolvedVersion = context.version;
    await expect(mock.updateContextField(workspaceId, { ...input, entryId: entry.id, expectedVersion: resolvedVersion })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(mock.proposeContextChange(workspaceId, { ...input, operation: "remove", entryId: entry.id, expectedVersion: resolvedVersion - 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    as(agent);
    await expect(mock.proposeContextChange(workspaceId, { ...input, operation: "remove", entryId: entry.id, expectedVersion: resolvedVersion })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    as(human);
    await mock.proposeContextChange(workspaceId, { field: input.field, rationale: input.rationale, sourceFileIds: [], operation: "remove", entryId: entry.id, expectedVersion: resolvedVersion });
    expect((await mock.getContextDetails(workspaceId)).openQuestions).toEqual([]);
    expect((await mock.listProposals(workspaceId, "applied")).find((p) => p.id === result.id)).toMatchObject({ createdBy: agent, supersedes: null });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("requires a version and the right field for lifecycle writes, and checks optional add versions", async () => {
    const { mock } = setup();
    const context = await mock.getContextDetails(workspaceId);
    await expect(mock.proposeContextChange(workspaceId, { ...input, operation: "resolve", entryId: "unknown" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.proposeContextChange(workspaceId, { ...input, field: "constraint", operation: "resolve", entryId: context.constraints[0]!.id, expectedVersion: context.version })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.proposeContextChange(workspaceId, { ...input, field: "decision", operation: "remove", entryId: context.decisions[0]!.id, expectedVersion: context.version })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.proposeContextChange(workspaceId, { ...input, expectedVersion: context.version - 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await mock.getContextDetails(workspaceId)).version).toBe(context.version);
  });

  it("uses stable IDs after removal shifts list indexes", async () => {
    const { mock } = setup();
    let context = await mock.getContextDetails(workspaceId);
    const [first, second] = context.constraints;
    await mock.proposeContextChange(workspaceId, { ...input, field: "constraint", operation: "remove", entryId: first!.id, expectedVersion: context.version });
    context = await mock.getContextDetails(workspaceId);
    await mock.updateContextField(workspaceId, { ...input, field: "constraint", entryId: second!.id, proposedValue: "Still required", expectedVersion: context.version });
    expect((await mock.getContextDetails(workspaceId)).constraints).toEqual([expect.objectContaining({ id: second!.id, text: "Still required" })]);
  });

  it("keeps a superseding decision pending until approval and preserves both decision IDs", async () => {
    const { mock, as } = setup();
    const before = await mock.getContextDetails(workspaceId);
    const original = before.decisions[0]!;
    as(agent);
    const proposal = await mock.proposeContextChange(workspaceId, { ...input, field: "decision", proposedValue: "Use two clients", supersedes: original.id });
    expect(proposal.status).toBe("pending");
    as(human);
    expect((await mock.getContextDetails(workspaceId)).version).toBe(before.version);
    expect((await mock.listProposals(workspaceId)).find((p) => p.id === proposal.id)?.supersedes).toBe(original.id);
    await mock.decideProposal({ id: proposal.id, workspaceId }, "approved");
    const after = await mock.getContextDetails(workspaceId);
    const replacement = after.decisions.at(-1)!;
    expect(after.decisions[0]).toMatchObject({ id: original.id, status: "superseded", supersededBy: replacement.id });
    expect(replacement).toMatchObject({ status: "active", text: "Use two clients" });
    expect((await mock.getContext(workspaceId))?.decisions).not.toContain(original.text);
  });

  it("preserves ownership identity across targeted edits", async () => {
    const { mock } = setup();
    await mock.listWorkspaces();
    let context = await mock.getContextDetails(workspaceId);
    await mock.updateContextField(workspaceId, { field: "ownership", proposedValue: "Original area", ownerUserId: human.userId, sourceFileIds: [], expectedVersion: context.version });
    context = await mock.getContextDetails(workspaceId);
    const id = context.ownership[0]!.id;
    for (const target of [{ entryId: id }, { entryIndex: 0 }]) {
      await mock.updateContextField(workspaceId, { field: "ownership", proposedValue: `Renamed ${context.version}`, ownerUserId: human.userId, sourceFileIds: [], expectedVersion: context.version, ...target });
      context = await mock.getContextDetails(workspaceId);
      expect(context.ownership).toHaveLength(1);
      expect(context.ownership[0]).toMatchObject({ id, ownerUserId: human.userId });
    }
  });

  it("maps resolver actors without losing backend lifecycle IDs", () => {
    const entry = { id: "backend-stable-id", text: "Question", sourceFileIds: [], updatedBy: { type: "human" as const, label: "Owner" }, updatedAt: 1,
      status: "resolved" as const, resolvedBy: { type: "agent" as const, label: "Claude", client: "claude", userName: "Owner" }, resolvedAt: 2, supersededBy: null };
    const context: FunctionReturnType<typeof api.context.getDetails> = { goal: null, scope: null, constraints: [], decisions: [], ownership: [], openQuestions: [entry], revision: 3, updatedAt: 2, updatedBy: entry.updatedBy };
    expect(toContextDetails(context).openQuestions[0]).toMatchObject({ id: entry.id, status: "resolved", resolvedAt: 2, resolvedBy: { actorType: "agent", agentName: "Claude", agentClient: "claude", userName: "Owner" } });
  });
});

const entry: ContextEntry = { id: "entry_1", text: "Launch?", sourceFileIds: [], updatedBy: human, updatedAt: 1, status: "active", resolvedBy: null, resolvedAt: null, supersededBy: null };
function panel(field: ContextField, value = entry, canPropose = true, canEdit = false) {
  const { mock } = setup();
  return renderToStaticMarkup(createElement(TandemApiContext.Provider, { value: mock }, createElement(ContextFieldPanel, {
    workspaceId, field, label: "Context", entries: [value], version: 1, canEdit, canPropose, files: [], members: [], onSaved: () => {},
  })));
}

describe("context lifecycle controls", () => {
  it("shows compact working controls to members and no decision remove control", () => {
    expect(panel("open_question")).toContain("Resolve open question 1");
    expect(panel("open_question")).toContain("Remove Open question 1");
    expect(panel("constraint")).toContain("Remove Constraint 1");
    expect(panel("constraint")).not.toContain(">Resolve<");
    expect(panel("decision")).toContain("Supersede decision 1");
    expect(panel("decision")).not.toContain("Remove Decision");
    expect(panel("open_question", entry, false)).not.toContain("Resolve open question");
  });

  it("labels history and hides resolve/supersede actions on inactive entries", () => {
    const resolved = panel("open_question", { ...entry, status: "resolved", resolvedBy: human, resolvedAt: 2 });
    expect(resolved).toContain("Resolved");
    expect(resolved).not.toContain("Resolve open question");
    expect(resolved).toContain("Remove Open question");
    expect(panel("open_question", { ...entry, status: "resolved" }, false, true)).not.toContain("Edit Open question");
    expect(panel("decision", { ...entry, status: "superseded" }, false, true)).not.toContain("Edit Decision");
    const superseded = panel("decision", { ...entry, status: "superseded", supersededBy: "entry_2" });
    expect(superseded).toContain(`Superseded by ${displayId("entry_2")}`);
    expect(superseded).not.toContain("Supersede decision");
  });
});
