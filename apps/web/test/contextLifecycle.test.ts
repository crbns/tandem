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
const question = { field: "open_question" as const, value: "When do we launch?", sourceFileIds: [] };
const edit = { field: "open_question" as const, proposedValue: "When do we launch?", sourceFileIds: [] };
const setup = () => {
  let actor = human;
  return { mock: createMockApi({ latencyMs: [0, 0], getActor: () => actor }), as: (next: Actor) => { actor = next; } };
};

describe("context lifecycle", () => {
  it("applies additions, resolves and removals at once, keeping stable IDs and resolver attribution", async () => {
    const { mock } = setup();
    await mock.listWorkspaces();
    const changed = vi.fn();
    mock.watchWorkspace(workspaceId, changed);
    const before = await mock.getContextDetails(workspaceId);
    const added = await mock.changeContext(workspaceId, question);
    expect(added).toMatchObject({ version: before.version + 1, deduplicated: false });
    let context = await mock.getContextDetails(workspaceId);
    const entry = context.openQuestions[0]!;
    expect(entry).toMatchObject({ id: added.entryId, status: "active", updatedBy: human, resolvedAt: null });
    await mock.changeContext(workspaceId, { field: question.field, operation: "resolve", entryId: entry.id, expectedVersion: context.version, sourceFileIds: [] });
    context = await mock.getContextDetails(workspaceId);
    expect(context.openQuestions[0]).toMatchObject({ id: entry.id, status: "resolved", resolvedBy: human, resolvedAt: expect.any(Number) });
    const resolvedVersion = context.version;
    // A retried resolve changes nothing.
    expect(await mock.changeContext(workspaceId, { field: question.field, operation: "resolve", entryId: entry.id, sourceFileIds: [] }))
      .toEqual({ version: resolvedVersion, entryId: entry.id, deduplicated: true });
    await expect(mock.updateContextField(workspaceId, { ...edit, entryId: entry.id, expectedVersion: resolvedVersion })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.changeContext(workspaceId, { field: question.field, operation: "remove", entryId: entry.id, expectedVersion: resolvedVersion - 1, sourceFileIds: [] })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await mock.changeContext(workspaceId, { field: question.field, operation: "remove", entryId: entry.id, expectedVersion: resolvedVersion, sourceFileIds: [] });
    expect((await mock.getContextDetails(workspaceId)).openQuestions).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("writes nothing when the context already holds the addition", async () => {
    const { mock } = setup();
    const context = await mock.getContextDetails(workspaceId);
    const constraint = context.constraints[0]!;
    expect(await mock.changeContext(workspaceId, { field: "constraint", value: ` ${constraint.text.toUpperCase()} `, sourceFileIds: [] }))
      .toEqual({ version: context.version, entryId: constraint.id, deduplicated: true });
    expect(await mock.changeContext(workspaceId, { field: "goal", value: context.goal!.text, sourceFileIds: [] }))
      .toEqual({ version: context.version, entryId: "goal", deduplicated: true });
    expect((await mock.getContextDetails(workspaceId)).version).toBe(context.version);
  });

  it("is for people's dashboard sessions: an assistant identity gets APPROVAL_REQUIRED", async () => {
    const { mock, as } = setup();
    await mock.listWorkspaces();
    as(agent);
    await expect(mock.changeContext(workspaceId, question)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("requires an entry and the right field for lifecycle writes, and checks optional add versions", async () => {
    const { mock } = setup();
    const context = await mock.getContextDetails(workspaceId);
    await expect(mock.changeContext(workspaceId, { ...question, operation: "resolve", entryId: "unknown" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.changeContext(workspaceId, { field: "constraint", operation: "resolve", entryId: context.constraints[0]!.id, sourceFileIds: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.changeContext(workspaceId, { field: "decision", operation: "remove", entryId: context.decisions[0]!.id, sourceFileIds: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.changeContext(workspaceId, { field: "open_question", operation: "remove", sourceFileIds: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mock.changeContext(workspaceId, { ...question, expectedVersion: context.version - 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await mock.getContextDetails(workspaceId)).version).toBe(context.version);
  });

  it("uses stable IDs after removal shifts list indexes", async () => {
    const { mock } = setup();
    let context = await mock.getContextDetails(workspaceId);
    const [first, second] = context.constraints;
    await mock.changeContext(workspaceId, { field: "constraint", operation: "remove", entryId: first!.id, expectedVersion: context.version, sourceFileIds: [] });
    context = await mock.getContextDetails(workspaceId);
    await mock.updateContextField(workspaceId, { ...edit, field: "constraint", entryId: second!.id, proposedValue: "Still required", expectedVersion: context.version });
    expect((await mock.getContextDetails(workspaceId)).constraints).toEqual([expect.objectContaining({ id: second!.id, text: "Still required" })]);
  });

  it("supersedes a decision at once and preserves both decision IDs", async () => {
    const { mock } = setup();
    const before = await mock.getContextDetails(workspaceId);
    const original = before.decisions[0]!;
    const result = await mock.changeContext(workspaceId, { field: "decision", value: "Use two clients", supersedes: original.id, sourceFileIds: [] });
    const after = await mock.getContextDetails(workspaceId);
    const replacement = after.decisions.at(-1)!;
    expect(result).toEqual({ version: before.version + 1, entryId: replacement.id, deduplicated: false });
    expect(after.decisions[0]).toMatchObject({ id: original.id, status: "superseded", supersededBy: replacement.id });
    expect(replacement).toMatchObject({ status: "active", text: "Use two clients" });
    expect((await mock.getContext(workspaceId))?.decisions).not.toContain(original.text);
    await expect(mock.changeContext(workspaceId, { field: "decision", value: "Use three clients", supersedes: original.id, sourceFileIds: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("preserves ownership identity across targeted edits", async () => {
    const { mock } = setup();
    await mock.listWorkspaces();
    let context = await mock.getContextDetails(workspaceId);
    await mock.changeContext(workspaceId, { field: "ownership", value: "Original area", ownerUserId: human.userId, sourceFileIds: [], expectedVersion: context.version });
    context = await mock.getContextDetails(workspaceId);
    const id = context.ownership[0]!.id;
    for (const target of [{ entryId: id }, { entryIndex: 0 }]) {
      await mock.updateContextField(workspaceId, { field: "ownership", proposedValue: `Renamed ${context.version}`, ownerUserId: human.userId, sourceFileIds: [], expectedVersion: context.version, ...target });
      context = await mock.getContextDetails(workspaceId);
      expect(context.ownership).toHaveLength(1);
      expect(context.ownership[0]).toMatchObject({ id, ownerUserId: human.userId });
    }
  });

  it("edits, resolves, and removes a question after its source is deleted", async () => {
    const { mock } = setup();
    const file = await mock.createFile(workspaceId, { name: "source.md", mimeType: "text/markdown", content: "Evidence" });
    await mock.changeContext(workspaceId, { ...question, sourceFileIds: [file.id] });
    await mock.deleteFile(file.id, file.version);
    let context = await mock.getContextDetails(workspaceId);
    const entry = context.openQuestions[0]!;
    await mock.updateContextField(workspaceId, { ...edit, proposedValue: "Edited", sourceFileIds: [file.id], entryId: entry.id, expectedVersion: context.version });
    context = await mock.getContextDetails(workspaceId);
    expect(context.openQuestions[0]).toMatchObject({ id: entry.id, text: "Edited", sourceFileIds: [file.id] });
    await mock.changeContext(workspaceId, { field: question.field, operation: "resolve", entryId: entry.id, sourceFileIds: [], expectedVersion: context.version });
    context = await mock.getContextDetails(workspaceId);
    expect(context.openQuestions[0]).toMatchObject({ status: "resolved", sourceFileIds: [file.id] });
    await mock.changeContext(workspaceId, { field: question.field, operation: "remove", entryId: entry.id, sourceFileIds: [], expectedVersion: context.version });
    expect((await mock.getContextDetails(workspaceId)).openQuestions).toEqual([]);
  });

  it("rejects new deleted or nonexistent sources even when another entry already links them", async () => {
    const { mock } = setup();
    const file = await mock.createFile(workspaceId, { name: "source.md", mimeType: "text/markdown", content: "Evidence" });
    await mock.changeContext(workspaceId, { ...question, sourceFileIds: [file.id] });
    await mock.deleteFile(file.id, file.version);
    const context = await mock.getContextDetails(workspaceId);
    for (const sourceFileIds of [[file.id], ["missing-file"]]) {
      await expect(mock.updateContextField(workspaceId, { ...edit, proposedValue: "Another question", sourceFileIds, expectedVersion: context.version })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(mock.changeContext(workspaceId, { field: "decision", value: "Another decision", sourceFileIds })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("keeps an existing goal's deleted source when the goal is edited or replaced", async () => {
    const { mock } = setup();
    const file = await mock.createFile(workspaceId, { name: "source.md", mimeType: "text/markdown", content: "Evidence" });
    let context = await mock.getContextDetails(workspaceId);
    await mock.updateContextField(workspaceId, { ...edit, field: "goal", sourceFileIds: [file.id], expectedVersion: context.version });
    await mock.deleteFile(file.id, file.version);
    context = await mock.getContextDetails(workspaceId);
    await mock.updateContextField(workspaceId, { ...edit, field: "goal", proposedValue: "Edited goal", sourceFileIds: [file.id], expectedVersion: context.version });
    await mock.changeContext(workspaceId, { field: "goal", value: "Replaced goal", sourceFileIds: [file.id] });
    expect((await mock.getContextDetails(workspaceId)).goal).toMatchObject({ text: "Replaced goal", sourceFileIds: [file.id] });
  });

  it("maps resolver actors without losing backend lifecycle IDs", () => {
    const entry = { id: "backend-stable-id", text: "Question", sourceFileIds: [], updatedBy: { type: "human" as const, label: "Owner" }, updatedAt: 1,
      status: "resolved" as const, resolvedBy: { type: "agent" as const, label: "Claude", client: "claude", userName: "Owner" }, resolvedAt: 2, supersededBy: null };
    const context: FunctionReturnType<typeof api.context.getDetails> = { goal: null, scope: null, constraints: [], decisions: [], ownership: [], openQuestions: [entry], revision: 3, updatedAt: 2, updatedBy: entry.updatedBy };
    expect(toContextDetails(context).openQuestions[0]).toMatchObject({ id: entry.id, status: "resolved", resolvedAt: 2, resolvedBy: { actorType: "agent", agentName: "Claude", agentClient: "claude", userName: "Owner" } });
  });
});

const entry: ContextEntry = { id: "entry_1", text: "Launch?", sourceFileIds: [], updatedBy: human, updatedAt: 1, status: "active", resolvedBy: null, resolvedAt: null, supersededBy: null };
function panel(field: ContextField, value = entry, canEdit = true) {
  const { mock } = setup();
  return renderToStaticMarkup(createElement(TandemApiContext.Provider, { value: mock }, createElement(ContextFieldPanel, {
    workspaceId, field, label: "Context", entries: [value], version: 1, canEdit, files: [], members: [], onSaved: () => {},
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
    expect(panel("open_question", { ...entry, status: "resolved" })).not.toContain("Edit Open question");
    expect(panel("decision", { ...entry, status: "superseded" })).not.toContain("Edit Decision");
    const superseded = panel("decision", { ...entry, status: "superseded", supersededBy: "entry_2" });
    expect(superseded).toContain(`Superseded by ${displayId("entry_2")}`);
    expect(superseded).not.toContain("Supersede decision");
  });
});
