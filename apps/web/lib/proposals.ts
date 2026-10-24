import type { ContextField, Workspace } from "./api/types";

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
