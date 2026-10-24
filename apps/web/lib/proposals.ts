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
 * Only owners and admins approve or reject proposals; members read them. The
 * backend enforces this (and rejects agent callers); the UI just doesn't offer
 * buttons that would fail.
 */
export function canDecideProposals(role: Workspace["role"] | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
