// Context conflict detection and resolution helpers (docs/conflict-resolution.md).
// proposeContextChangeCore calls detectConflict and findDuplicateProposal;
// conflicts:checkProposal records the semantic verdict; decideProposalCore
// settles a conflict and retargets the proposals that competed with it.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "./auth";
import {
  type ContextField,
  listProposals,
  loadContext,
  normalizeContext,
  truncate,
} from "./ops";

type ReadCtx = QueryCtx | MutationCtx;

export type Conflict = NonNullable<Doc<"context_proposals">["conflict"]>;
export type ConflictItem = Conflict["items"][number];
export type Resolution = NonNullable<Doc<"context_proposals">["resolution"]>;

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Attribution for writes the conflict check makes on its own. */
export const CONFLICT_ACTOR: Actor = { type: "system", label: "Conflict check" };

/** conflict when any item is certain, uncertain when only doubtful ones remain. */
export function conflictStatus(items: readonly ConflictItem[]): "conflict" | "uncertain" | "clear" {
  return items.some((i) => !i.uncertain)
    ? "conflict"
    : items.length > 0
      ? "uncertain"
      : "clear";
}

/**
 * Mirrors `rival`'s competing item onto the pending proposal it targets, so
 * both proposals show the conflict and whichever is decided first retargets
 * the other.
 */
export async function markCompeting(
  ctx: MutationCtx,
  rival: Doc<"context_proposals">,
  item: ConflictItem,
  method: Conflict["method"],
) {
  const id = ctx.db.normalizeId("context_proposals", item.targetId);
  const target = id ? await ctx.db.get(id) : null;
  if (
    !target || target.status !== "pending" || target.workspaceId !== rival.workspaceId ||
    target.conflict?.items.some((i) => i.targetId === rival._id)
  )
    return;
  const items: ConflictItem[] = [
    ...(target.conflict?.items ?? []),
    {
      kind: "competing",
      ...(item.uncertain ? { uncertain: true } : {}),
      targetType: "proposal",
      targetId: rival._id,
      targetText: rival.proposedValue,
      targetBy: rival.createdBy,
      targetAt: rival.createdAt,
      contextVersion: item.contextVersion,
      explanation: item.explanation,
      ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    },
  ];
  const now = Date.now();
  await ctx.db.patch(target._id, {
    conflict: {
      ...(target.conflict ?? { method, checkedAt: now }),
      status: target.conflict?.status === "checking" ? "checking" : conflictStatus(items),
      items,
    },
    hasConflict: true,
    updatedBy: CONFLICT_ACTOR,
    updatedAt: now,
    revision: target.revision + 1,
  });
}

/** Case- and whitespace-insensitive form used for dedupe and equality. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function sameCreator(a: Actor, b: Actor): boolean {
  if (a.type !== b.type) return false;
  return a.type === "agent"
    ? a.agentConnectionId === b.agentConnectionId
    : a.userId === b.userId;
}

/**
 * A pending proposal, or one applied in the last DEDUPE_WINDOW_MS, from the
 * same creator with the same change. Retries return it instead of a new row.
 */
export async function findDuplicateProposal(
  ctx: MutationCtx,
  key: {
    workspaceId: Id<"workspaces">;
    actor: Actor;
    field: ContextField;
    operation?: "resolve" | "remove";
    proposedValue?: string;
    supersedes?: string;
    entryId?: string;
    ownerUserId?: Id<"users">;
  },
): Promise<Doc<"context_proposals"> | null> {
  const since = Date.now() - DEDUPE_WINDOW_MS;
  const pending = await listProposals(ctx, key.workspaceId, "pending", 100);
  const value = key.proposedValue === undefined ? undefined : normalizeText(key.proposedValue);
  // An applied add is only a duplicate while its value is still in effect:
  // re-adding something that was since replaced, resolved or superseded is new.
  const stored = value === undefined
    ? null
    : await ctx.db
        .query("structured_context")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", key.workspaceId))
        .unique();
  const inEffect = (text: string) => {
    if (!stored) return value === undefined;
    if (key.field === "goal" || key.field === "scope")
      return normalizeText(stored[key.field]?.text ?? "") === normalizeText(text);
    const normalized = normalizeContext(stored);
    const entries =
      key.field === "decision" ? normalized.decisions
      : key.field === "constraint" ? normalized.constraints
      : key.field === "open_question" ? normalized.openQuestions
      : normalized.ownership;
    return entries.some((e) => isActive(e) && normalizeText(e.text) === normalizeText(text));
  };
  const applied = (await listProposals(ctx, key.workspaceId, "applied", 50))
    .filter((p) => p.createdAt >= since && inEffect(p.proposedValue));
  return (
    [...pending, ...applied].find(
      (p) =>
        sameCreator(p.createdBy, key.actor) &&
        p.field === key.field &&
        p.operation === key.operation &&
        (value === undefined || normalizeText(p.proposedValue) === value) &&
        p.supersedes === key.supersedes &&
        p.entryId === key.entryId &&
        p.ownerUserId === key.ownerUserId,
    ) ?? null
  );
}

const CANDIDATE_LIMIT = 30;

export type ConflictCandidate = Pick<
  ConflictItem,
  "targetType" | "targetId" | "targetText" | "targetBy" | "targetAt"
>;

export const isActive = (e: { status?: string }) => !e.status || e.status === "active";

/**
 * What a decision or constraint addition is semantically checked against:
 * active decisions and constraints and pending decision and constraint
 * additions, newest CANDIDATE_LIMIT. `before` keeps only proposals made
 * earlier than the one being checked.
 */
export async function conflictCandidates(
  ctx: ReadCtx,
  context: Doc<"structured_context">,
  opts: { supersedes?: string; exclude: ReadonlySet<string>; before?: number },
): Promise<ConflictCandidate[]> {
  const normalized = normalizeContext(context);
  const skip = (id: string) => id === opts.supersedes || opts.exclude.has(id);
  const entries = (["decision", "constraint"] as const).flatMap((type) =>
    normalized[type === "decision" ? "decisions" : "constraints"]
      .filter((e) => isActive(e) && !skip(e.id))
      .map((e) => ({
        targetType: type,
        targetId: e.id,
        targetText: e.text,
        targetBy: e.updatedBy,
        targetAt: e.updatedAt,
      })),
  );
  const pending = (await listProposals(ctx, context.workspaceId, "pending", 100))
    .filter(
      (p) =>
        !p.operation &&
        (p.field === "decision" || p.field === "constraint") &&
        !skip(p._id) &&
        (opts.before === undefined || p._creationTime < opts.before),
    )
    .map((p) => ({
      targetType: "proposal" as const,
      targetId: p._id as string,
      targetText: p.proposedValue,
      targetBy: p.createdBy,
      targetAt: p.createdAt,
    }));
  return [...entries, ...pending]
    .sort((a, b) => b.targetAt - a.targetAt)
    .slice(0, CANDIDATE_LIMIT);
}

/**
 * Structural conflicts, found in the proposing transaction without an LLM:
 * an explicit supersedes replaces that decision, and another pending
 * proposal on the same goal/scope, or superseding the same decision,
 * competes. A decision or constraint addition with semantic candidates is
 * "checking" until conflicts:checkProposal records a verdict. Undefined means
 * nothing to check.
 */
export async function detectConflict(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    field: ContextField;
    proposedValue: string;
    supersedes?: string;
    context: Doc<"structured_context">;
  },
): Promise<Conflict | undefined> {
  const { field, context } = args;
  const normalized = normalizeContext(context);
  const contextVersion = context.revision;
  const items: ConflictItem[] = [];
  if (args.supersedes !== undefined) {
    const target = normalized.decisions.find((e) => e.id === args.supersedes);
    if (target)
      items.push({
        kind: "replaces",
        targetType: "decision",
        targetId: target.id,
        targetText: target.text,
        targetBy: target.updatedBy,
        targetAt: target.updatedAt,
        contextVersion,
        explanation: "Supersedes this approved decision.",
      });
  }
  if (field === "goal" || field === "scope" || args.supersedes !== undefined) {
    const rivals = (await listProposals(ctx, args.workspaceId, "pending", 100)).filter(
      (p) =>
        p.field === field &&
        !p.operation &&
        (args.supersedes === undefined || p.supersedes === args.supersedes),
    );
    for (const p of rivals)
      items.push({
        kind: "competing",
        targetType: "proposal",
        targetId: p._id,
        targetText: p.proposedValue,
        targetBy: p.createdBy,
        targetAt: p.createdAt,
        contextVersion,
        explanation:
          args.supersedes === undefined
            ? `Another pending proposal also changes the ${field}.`
            : "Another pending proposal also supersedes this decision.",
      });
  }
  let check = false;
  if (field === "decision" || field === "constraint") {
    // Already approved: adding it again would only duplicate the entry.
    const value = normalizeText(args.proposedValue);
    const exact = [...normalized.decisions, ...normalized.constraints].find(
      (e) => isActive(e) && normalizeText(e.text) === value,
    );
    if (exact)
      throw new ConvexError({
        code: "ALREADY_IN_CONTEXT",
        entryId: exact.id,
        message: `This is already approved context (entry ${exact.id}); nothing to propose.`,
      });
    check = (await conflictCandidates(ctx, context, {
      supersedes: args.supersedes,
      exclude: new Set(items.map((i) => i.targetId)),
    })).length > 0;
  }
  if (check) return { status: "checking", method: "semantic", items };
  if (items.length > 0)
    return { status: "conflict", method: "structural", checkedAt: Date.now(), items };
  return undefined;
}

/**
 * A decided conflict as sync reports it: what the person chose, and which
 * entries are authoritative now (inEffect) versus not (notInEffect).
 */
export function toResolvedConflict(
  p: Doc<"context_proposals">,
  context: Awaited<ReturnType<typeof loadContext>>,
) {
  const inEffect: { id: string; text: string }[] = [];
  const notInEffect: string[] = [];
  const items = p.conflict?.items ?? [];
  if (p.field === "goal" || p.field === "scope") {
    const current = context[p.field];
    if (current) inEffect.push({ id: p.field, text: current.text });
    for (const text of [p.proposedValue, ...items.map((i) => i.targetText)])
      if (!current || normalizeText(text) !== normalizeText(current.text))
        notInEffect.push(text);
  } else {
    const entries = [...context.decisions, ...context.constraints];
    const ids = [
      ...(p.appliedEntryId !== undefined ? [p.appliedEntryId] : []),
      ...items
        .filter((i) => i.targetType === "decision" || i.targetType === "constraint")
        .map((i) => i.targetId),
    ];
    for (const id of new Set(ids)) {
      const entry = entries.find((e) => e.id === id);
      if (entry?.status === "active") inEffect.push({ id, text: entry.text });
      else if (entry) notInEffect.push(entry.text);
    }
    if (!inEffect.some((e) => e.id === p.appliedEntryId))
      notInEffect.unshift(p.proposedValue);
  }
  return {
    proposalId: p._id,
    field: p.field,
    proposedValue: p.proposedValue,
    outcome: p.resolution ?? (p.status === "approved" ? "accepted" as const : "rejected" as const),
    note: p.decisionNote ?? null,
    resolvedBy: p.decidedBy!,
    resolvedAt: p.decidedAt!,
    inEffect,
    notInEffect: [...new Set(notInEffect)],
  };
}

/** What the resolver chose when there was a conflict (docs/conflict-resolution.md). */
export function conflictSummary(
  proposal: Doc<"context_proposals">,
  resolution: Resolution,
): string {
  const quote = (text: string) => `"${truncate(text, 60)}"`;
  const proposed = quote(proposal.proposedValue);
  const target = proposal.conflict?.items[0];
  const current = target ? quote(target.targetText) : "the current value";
  switch (resolution) {
    case "accepted":
      return `Accepted ${proposed} over ${current}`;
    case "kept_both":
      return `Kept both ${proposed} and ${current}`;
    case "retained_current":
      return `Kept ${current} over ${proposed}`;
    case "rejected":
      return `Rejected ${proposed}`;
  }
}

/**
 * Pending proposals that competed with `decided`: on approval they now
 * contradict the entry it added; on rejection the item is dropped, and a
 * proposal with no items left is clear (it still waits for a person, even in
 * an automatic workspace).
 */
export async function retargetCompeting(
  ctx: MutationCtx,
  decided: Doc<"context_proposals">,
  decision: "approved" | "rejected",
  approvedEntryId: string | undefined,
  actor: Doc<"context_proposals">["updatedBy"],
  now: number,
) {
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", decided.workspaceId))
    .unique();
  const pending = await listProposals(ctx, decided.workspaceId, "pending", 100);
  for (const other of pending) {
    const conflict = other.conflict;
    if (!conflict?.items.some((i) => i.kind === "competing" && i.targetId === decided._id))
      continue;
    const targetType: ConflictItem["targetType"] =
      decided.field === "goal" || decided.field === "scope"
        ? decided.field
        : decided.field === "constraint"
          ? "constraint"
          : "decision";
    const scalar = targetType === "goal" || targetType === "scope";
    const items = conflict.items.flatMap((i): ConflictItem[] => {
      if (i.kind !== "competing" || i.targetId !== decided._id) return [i];
      if (decision === "rejected" || (!scalar && approvedEntryId === undefined))
        return [];
      return [{
        ...i,
        kind: "contradicts",
        targetType,
        targetId: scalar ? targetType : approvedEntryId!,
        targetAt: now,
        contextVersion: context?.revision ?? i.contextVersion,
      }];
    });
    await ctx.db.patch(other._id, {
      conflict: {
        ...conflict,
        items,
        status: conflict.status === "checking" ? "checking" : conflictStatus(items),
      },
      updatedBy: actor,
      updatedAt: now,
      revision: other.revision + 1,
    });
  }
}
