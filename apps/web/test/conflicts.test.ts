import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, MOCK_WORKSPACE_ID as workspaceId } from "@/lib/api/mock";
import type { Actor, ContextProposal } from "@/lib/api/types";
import { CONFLICT_ACTIONS, conflictMethodLabel, needsConflictReview, proposalStatusLabel } from "@/lib/proposals";
import { ConflictCard } from "@/components/approvals/ConflictCard";

const owner: Actor = { actorType: "human", userId: "user_owner", userName: "Owner" };
const agent: Actor = { ...owner, actorType: "agent", agentName: "Claude", agentClient: "claude" };
const setup = () => {
  let actor = owner;
  return { api: createMockApi({ latencyMs: [0, 0], getActor: () => actor }), as: (next: Actor) => (actor = next) };
};
const seededConflict = async (api: ReturnType<typeof setup>["api"]) =>
  (await api.listConflicts(workspaceId)).pending.find((p) => p.id === "proposal_conflict")!;

describe("mock conflict resolution", () => {
  it("lists the seeded conflict as pending and a settled one in history", async () => {
    const { api } = setup();
    const { pending, resolved } = await api.listConflicts(workspaceId);
    expect(pending.map((p) => p.id)).toEqual(["proposal_conflict"]);
    expect(pending[0]!.conflict).toMatchObject({ status: "conflict", method: "semantic", items: [{ kind: "contradicts" }] });
    expect(resolved).toEqual([expect.objectContaining({ id: "proposal_conflict_resolved", resolution: "retained_current" })]);
  });

  it("accepting supersedes the approved target and records the outcome", async () => {
    const { api } = setup();
    const conflict = await seededConflict(api);
    const target = conflict.conflict!.items[0]!;
    await api.decideProposal(conflict, "approved", { resolution: "accepted", note: "Agreed in standup", expectedRevision: conflict.revision });

    const details = await api.getContextDetails(workspaceId);
    const replacement = details.decisions.find((entry) => entry.text === conflict.proposedValue)!;
    expect(replacement.status).toBe("active");
    expect(details.decisions.find((entry) => entry.id === target.targetId)).toMatchObject({ status: "superseded", supersededBy: replacement.id });
    expect((await api.getContext(workspaceId))!.decisions).not.toContain(target.targetText);

    const { pending, resolved } = await api.listConflicts(workspaceId);
    expect(pending).toEqual([]);
    expect(resolved[0]).toMatchObject({
      id: conflict.id, status: "approved", resolution: "accepted", decisionNote: "Agreed in standup",
      decidedBy: owner, revision: conflict.revision + 1,
    });
  });

  it("keeping the current value changes nothing in the context", async () => {
    const { api } = setup();
    const conflict = await seededConflict(api);
    const before = await api.getContextDetails(workspaceId);
    await api.decideProposal(conflict, "rejected", { resolution: "retained_current", expectedRevision: conflict.revision });
    expect(await api.getContextDetails(workspaceId)).toEqual(before);
    const [decided] = (await api.listProposals(workspaceId)).filter((p) => p.id === conflict.id);
    expect(decided).toMatchObject({ status: "rejected", resolution: "retained_current", decisionNote: null });
  });

  it("keeping both adds the proposal and supersedes nothing", async () => {
    const { api } = setup();
    const conflict = await seededConflict(api);
    await api.decideProposal(conflict, "approved", { resolution: "kept_both" });
    const details = await api.getContextDetails(workspaceId);
    expect(details.decisions.find((entry) => entry.id === conflict.conflict!.items[0]!.targetId)?.status).toBe("active");
    expect(details.decisions.find((entry) => entry.text === conflict.proposedValue)?.status).toBe("active");
  });

  it("rejects a second decision, and a decision made on an outdated card", async () => {
    const { api } = setup();
    const conflict = await seededConflict(api);
    const before = await api.getContextDetails(workspaceId);
    await expect(api.decideProposal(conflict, "approved", { expectedRevision: conflict.revision - 1 }))
      .rejects.toMatchObject({ code: "PROPOSAL_CHANGED" });
    expect(await api.getContextDetails(workspaceId)).toEqual(before);

    await api.decideProposal(conflict, "rejected", { resolution: "rejected", expectedRevision: conflict.revision });
    await expect(api.decideProposal(conflict, "approved", { resolution: "accepted" })).rejects.toMatchObject({ code: "PROPOSAL_DECIDED" });
    expect(await api.getContextDetails(workspaceId)).toEqual(before);
  });

  it("refuses a resolution that doesn't match the decision", async () => {
    const { api } = setup();
    const conflict = await seededConflict(api);
    await expect(api.decideProposal(conflict, "rejected", { resolution: "accepted" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(api.decideProposal(conflict, "approved", { note: "x".repeat(2001) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("flags an explicit supersedes and holds it even in an automatic workspace", async () => {
    const { api, as } = setup();
    await api.listWorkspaces();
    await api.setContextApproval(workspaceId, "automatic");
    const original = (await api.getContextDetails(workspaceId)).decisions[0]!;
    as(agent);
    const result = await api.proposeContextChange(workspaceId, {
      field: "decision", proposedValue: "Use two clients", rationale: "Coverage", sourceFileIds: [], supersedes: original.id,
    });
    expect(result.status).toBe("pending");
    as(owner);
    const proposal = (await api.listConflicts(workspaceId)).pending.find((p) => p.id === result.id)!;
    expect(proposal.conflict).toMatchObject({
      status: "conflict", method: "structural",
      items: [{ kind: "replaces", targetType: "decision", targetId: original.id, targetText: original.text }],
    });
  });

  it("retargets or clears competing proposals when the one they compete with is decided", async () => {
    const { api } = setup();
    const seededGoal = (await api.listProposals(workspaceId, "pending")).find((p) => p.field === "goal")!;
    const first = await api.proposeContextChange(workspaceId, { field: "goal", proposedValue: "Ship by Sunday", rationale: "More time", sourceFileIds: [] });
    const competing = (await api.listProposals(workspaceId)).find((p) => p.id === first.id)!;
    expect(competing.conflict?.items).toEqual([expect.objectContaining({ kind: "competing", targetType: "proposal", targetId: seededGoal.id })]);
    expect(needsConflictReview(competing)).toBe(true);

    await api.decideProposal(seededGoal, "rejected");
    const after = (await api.listProposals(workspaceId)).find((p) => p.id === first.id)!;
    expect(after.conflict).toMatchObject({ status: "clear", items: [] });
    expect(after.revision).toBe(competing.revision + 1);
    expect(needsConflictReview(after)).toBe(false);
  });
});

describe("conflict labels", () => {
  it("maps status and resolution to pending, accepted or rejected", () => {
    expect(proposalStatusLabel({ status: "pending", resolution: null })).toEqual({ label: "Pending", tone: "muted" });
    expect(proposalStatusLabel({ status: "approved", resolution: "accepted" })).toEqual({ label: "Accepted", tone: "archive" });
    expect(proposalStatusLabel({ status: "approved", resolution: "kept_both" })).toEqual({ label: "Accepted", detail: "kept both", tone: "archive" });
    expect(proposalStatusLabel({ status: "approved", resolution: null })).toMatchObject({ label: "Accepted" });
    expect(proposalStatusLabel({ status: "rejected", resolution: "retained_current" })).toEqual({ label: "Rejected", detail: "kept current", tone: "muted" });
    expect(proposalStatusLabel({ status: "rejected", resolution: "rejected" })).toEqual({ label: "Rejected", tone: "muted" });
    expect(proposalStatusLabel({ status: "stale", resolution: null })).toEqual({ label: "Stale", tone: "warn" });
    expect(proposalStatusLabel({ status: "applied", resolution: null })).toMatchObject({ label: "Recorded" });
  });

  it("pairs each action with the decision and resolution the backend expects", () => {
    expect(CONFLICT_ACTIONS.accept).toMatchObject({ decision: "approved", resolution: "accepted" });
    expect(CONFLICT_ACTIONS.keep_current).toMatchObject({ decision: "rejected", resolution: "retained_current" });
    expect(CONFLICT_ACTIONS.reject).toMatchObject({ decision: "rejected", resolution: "rejected" });
    expect(CONFLICT_ACTIONS.keep_both).toMatchObject({ decision: "approved", resolution: "kept_both" });
  });

  it("names how a conflict was found", () => {
    expect(conflictMethodLabel({ status: "checking", method: "semantic" })).toBe("Checking for conflicts…");
    expect(conflictMethodLabel({ status: "conflict", method: "semantic" }, { kind: "contradicts" })).toBe("AI check");
    expect(conflictMethodLabel({ status: "uncertain", method: "semantic" }, { kind: "contradicts", uncertain: true })).toBe("AI unsure — needs review");
    expect(conflictMethodLabel({ status: "conflict", method: "structural" }, { kind: "replaces" })).toBe("Structural: supersedes");
    expect(conflictMethodLabel({ status: "conflict", method: "structural" }, { kind: "competing" })).toBe("Same field changed by another proposal");
  });

  it("only routes checking, conflicted or uncertain pending proposals to the conflict card", () => {
    const conflict = (status: "checking" | "clear" | "conflict" | "uncertain") => ({ status, method: "semantic" as const, items: [] });
    expect(needsConflictReview({ status: "pending", conflict: conflict("checking") })).toBe(true);
    expect(needsConflictReview({ status: "pending", conflict: conflict("uncertain") })).toBe(true);
    expect(needsConflictReview({ status: "pending", conflict: conflict("clear") })).toBe(false);
    expect(needsConflictReview({ status: "pending", conflict: null })).toBe(false);
    expect(needsConflictReview({ status: "rejected", conflict: conflict("conflict") })).toBe(false);
  });
});

describe("ConflictCard", () => {
  const render = (proposal: ContextProposal, canDecide: boolean) =>
    renderToStaticMarkup(createElement(ConflictCard, { proposal, canDecide, deciding: null, busy: false, onDecide: () => {} }));

  it("shows both values, who set each, why, and the actions for deciders only", async () => {
    const { api } = setup();
    const proposal = await seededConflict(api);
    const html = render(proposal, true);
    expect(html).toContain("Current (approved)");
    expect(html).toContain(proposal.conflict!.items[0]!.targetText);
    expect(html).toContain(proposal.proposedValue);
    expect(html).toContain("ChatGPT");
    expect(html).toContain("93% confidence");
    expect(html).toContain("AI check");
    for (const action of Object.values(CONFLICT_ACTIONS)) expect(html).toContain(action.label);
    expect(render(proposal, false)).not.toContain("Accept proposed");
  });

  it("shows a spinner while the check runs", async () => {
    const { api } = setup();
    const proposal = await seededConflict(api);
    const html = render({ ...proposal, conflict: { status: "checking", method: "semantic", items: [] } }, true);
    expect(html).toContain("Checking for conflicts…");
    expect(html).toContain('aria-busy="true"');
  });
});
