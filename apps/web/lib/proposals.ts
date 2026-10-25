import type { ConflictItem, ConflictResolution, ContextField, ContextProposal, ProposalConflict, Workspace } from "./api/types";

export const FIELD_LABELS: Record<ContextField, string> = {
  goal: "Goal",
  scope: "Scope",
  constraint: "Constraint",
  decision: "Decision",
  ownership: "Ownership",
  open_question: "Open question",
};

/** Goal and scope replace the current value; the other fields add an entry. */
export function replacesValue(field: ContextField): boolean {
  return field === "goal" || field === "scope";
}

/**
 * The approved scope to show beside a proposed decision, constraint or owner,
 * so whoever decides can see at a glance whether it fits. Goal and scope
 * changes show what they replace instead; open questions don't commit to
 * anything.
 */
export function scopeReference(field: ContextField, approvedScope: string | undefined): string | undefined {
  if (!approvedScope) return undefined;
  return field === "decision" || field === "constraint" || field === "ownership" ? approvedScope : undefined;
}

/**
 * Only owners and admins approve or reject proposals; members read them. The
 * backend enforces this (and rejects agent callers); the UI just doesn't offer
 * buttons that would fail.
 */
export function canDecideProposals(role: Workspace["role"] | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * A pending proposal a person has to settle as a conflict: the check is still
 * running, found a conflict, or wasn't sure. Clear or unchecked proposals use
 * the ordinary card.
 */
export function needsConflictReview(proposal: Pick<ContextProposal, "status" | "conflict">): boolean {
  const status = proposal.conflict?.status;
  return proposal.status === "pending" && (status === "checking" || status === "conflict" || status === "uncertain");
}

/** What each conflict button sends (docs/conflict-resolution.md, Resolution). */
export type ConflictAction = "accept" | "keep_current" | "reject" | "keep_both";

export const CONFLICT_ACTIONS: Record<ConflictAction, { decision: "approved" | "rejected"; resolution: ConflictResolution; label: string }> = {
  accept: { decision: "approved", resolution: "accepted", label: "Accept proposed" },
  keep_current: { decision: "rejected", resolution: "retained_current", label: "Keep current" },
  reject: { decision: "rejected", resolution: "rejected", label: "Reject" },
  keep_both: { decision: "approved", resolution: "kept_both", label: "Not a conflict — keep both" },
};

export type StatusTone = "muted" | "archive" | "warn";

/**
 * The status badge: pending, accepted or rejected, plus how a conflict was
 * settled when that adds something ("kept current", "kept both").
 */
export function proposalStatusLabel(
  proposal: Pick<ContextProposal, "status" | "resolution">,
): { label: string; detail?: string; tone: StatusTone } {
  switch (proposal.status) {
    case "pending":
      return { label: "Pending", tone: "muted" };
    case "applied":
      return { label: "Recorded", tone: "archive" };
    case "stale":
      return { label: "Stale", tone: "warn" };
    case "approved":
      return proposal.resolution === "kept_both"
        ? { label: "Accepted", detail: "kept both", tone: "archive" }
        : { label: "Accepted", tone: "archive" };
    case "rejected":
      return proposal.resolution === "retained_current"
        ? { label: "Rejected", detail: "kept current", tone: "muted" }
        : { label: "Rejected", tone: "muted" };
  }
}

/** The outcome in words, for the conflict history. */
export const RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  accepted: "Accepted proposed",
  kept_both: "Kept both",
  retained_current: "Kept current",
  rejected: "Rejected",
};

/** How one conflict was found, in a reviewer's words. */
export function conflictMethodLabel(conflict: Pick<ProposalConflict, "status" | "method">, item?: Pick<ConflictItem, "kind" | "uncertain">): string {
  if (conflict.status === "checking") return "Checking for conflicts…";
  if (item?.uncertain || (!item && conflict.status === "uncertain")) {
    return conflict.method === "heuristic" ? "Possible overlap — needs review" : "AI unsure — needs review";
  }
  if (conflict.method === "semantic") return "AI check";
  if (conflict.method === "heuristic") return "Word overlap check";
  return item?.kind === "competing" ? "Same field changed by another proposal" : "Structural: supersedes";
}
