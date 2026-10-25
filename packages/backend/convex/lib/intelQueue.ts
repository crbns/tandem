// The context manager's trigger (docs/context-intelligence.md). Ingestion
// calls requestIntelRun in the same transaction that stores a significant
// activity_events row; it schedules one debounced intel.processWorkspace per
// workspace, so a burst of events becomes one bounded batch.
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./auth";

declare const process: { env: Record<string, string | undefined> };

/** Attribution for everything the context manager writes. */
export const INTEL_ACTOR: Actor = { type: "system", label: "Tandem context manager" };

export const DEFAULT_CONTEXT_MODEL = "claude-haiku-5-5";

const SCHEDULE_GRACE_MS = 60_000;

/** CONTEXT_MODEL, else the default Haiku model. */
export function contextModel(): string {
  return process.env.CONTEXT_MODEL || DEFAULT_CONTEXT_MODEL;
}

/** How long events are buffered before a batch runs (INTEL_BATCH_WINDOW_MS). */
export function batchWindowMs(): number {
  const ms = Number(process.env.INTEL_BATCH_WINDOW_MS ?? 5000);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 120_000) : 5000;
}

/** INTEL_DISABLED=1 turns the context manager off; events are still logged. */
export function intelDisabled(): boolean {
  return process.env.INTEL_DISABLED === "1";
}

/**
 * Schedules a batch for the workspace unless one is already scheduled or
 * running (a running batch re-checks for pending events when it finishes) or
 * a retry backoff is in effect. Only writes when it schedules, so concurrent
 * ingests mostly share a read and don't contend.
 */
export async function requestIntelRun(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  if (intelDisabled()) return;
  const now = Date.now();
  const state = await ctx.db
    .query("context_intel_state")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  // A scheduled run that never claimed (disabled at fire time, or it died
  // before claimBatch committed) would otherwise hold the workspace forever.
  if (state?.status === "scheduled" && (state.scheduledFor ?? 0) + SCHEDULE_GRACE_MS > now) return;
  if (state?.status === "running" && (state.leaseExpiresAt ?? 0) > now) return;
  if (state?.nextRetryAt !== undefined && state.nextRetryAt > now) return;
  const delay = batchWindowMs();
  await ctx.scheduler.runAfter(delay, internal.intel.processWorkspace, { workspaceId });
  if (state) {
    await ctx.db.patch(state._id, {
      status: "scheduled",
      scheduledFor: now + delay,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("context_intel_state", {
      workspaceId,
      status: "scheduled",
      scheduledFor: now + delay,
      consecutiveFailures: 0,
      entriesRevision: 0,
      updatedAt: now,
    });
  }
}

/** Files one backfill mutation reads; a continuation takes the next page. */
export const BACKFILL_PAGE = 200;

/**
 * Queues one file.backfill activity event per live text file on this page
 * of the workspace's files (binaries have nothing to read), so the context
 * manager reads documents nobody has edited since it started. Inserted
 * directly, never through recordWorkspaceEvent, so nothing mirrors or loops;
 * the dedupe key makes re-queuing the same version a no-op. Schedules the
 * next page when there is one; with requestRun, also asks for a batch.
 */
export async function enqueueBackfillPage(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  cursor: string | null,
  options: { requestRun: boolean },
): Promise<{ queued: number; isDone: boolean }> {
  const page = await ctx.db
    .query("files")
    .withIndex("by_workspace_and_deleted_at_and_updated_at", (q) =>
      q.eq("workspaceId", workspaceId).eq("deletedAt", undefined),
    )
    .paginate({ numItems: BACKFILL_PAGE, cursor });
  const now = Date.now();
  let queued = 0;
  for (const file of page.page) {
    if (file.storageId !== undefined || typeof file.content !== "string") continue;
    const dedupeKey = `backfill:${file._id}:v${file.version}`;
    const existing = await ctx.db
      .query("activity_events")
      .withIndex("by_workspace_and_dedupe_key", (q) =>
        q.eq("workspaceId", workspaceId).eq("dedupeKey", dedupeKey),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("activity_events", {
      workspaceId,
      actor: INTEL_ACTOR,
      source: "workspace",
      type: "file.backfill",
      outcome: "ok",
      summary: `Read existing document ${file.name} (v${file.version})`.slice(0, 200),
      payload: JSON.stringify({ version: file.version }),
      resources: [{ type: "file", id: file._id, label: file.name.slice(0, 80) }],
      dedupeKey,
      significant: true,
      intelStatus: "pending",
      occurredAt: now,
      createdAt: now,
    });
    queued++;
  }
  if (!page.isDone)
    await ctx.scheduler.runAfter(0, internal.intel.continueBackfill, {
      workspaceId,
      cursor: page.continueCursor,
    });
  if (queued > 0 && options.requestRun) await requestIntelRun(ctx, workspaceId);
  return { queued, isDone: page.isDone };
}
