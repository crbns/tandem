// Ingestion entry points for activity_events (docs/context-intelligence.md):
// one internal mutation per MCP tool call (mcp.ts run()) and one per Claude
// Code hook request (http.ts POST /activity/claude-code). Identity and
// workspace come only from the verified connection. Telemetry never fails the
// caller's work, so an unknown, revoked or ex-member connection records
// nothing and returns null instead of throwing.
import { vMcpUser } from "@convex-dev/mcp";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { agentActor } from "./lib/agent";
import {
  classifyHookEvent,
  classifyMcpCall,
  describeHookEvent,
  HOOK_REDACT,
  hookEventValidator,
  recordActivityEvent,
  type ActivityEventResource,
} from "./lib/activityLog";

const MAX_HOOK_BATCH = 25;

const ingestResult = v.object({ id: v.id("activity_events"), duplicate: v.boolean() });

const resourceValidator = v.object({
  type: v.union(
    v.literal("file"),
    v.literal("folder"),
    v.literal("proposal"),
    v.literal("task"),
    v.literal("published_work"),
    v.literal("context"),
  ),
  id: v.string(),
  label: v.optional(v.string()),
});

/** requireAgent without the throwing: null when the call can't be attributed. */
async function resolveConnection(ctx: MutationCtx, connectionId: string) {
  const id = ctx.db.normalizeId("agent_connections", connectionId);
  const connection = id ? await ctx.db.get(id) : null;
  if (!connection || connection.revokedAt !== undefined) return null;
  const user = await ctx.db.get(connection.userId);
  if (!user) return null;
  const membership = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_user", (q) =>
      q.eq("workspaceId", connection.workspaceId).eq("userId", user._id),
    )
    .unique();
  if (!membership) return null;
  return { connection, actor: agentActor(connection, user) };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * A failed call names its target only by the id it was given; label files and
 * tasks that exist in this workspace (never another workspace's names).
 */
async function labelResources(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  resources: ActivityEventResource[],
): Promise<ActivityEventResource[]> {
  return await Promise.all(
    resources.map(async (resource) => {
      if (resource.label !== undefined) return resource;
      let label: string | undefined;
      if (resource.type === "file") {
        const id = ctx.db.normalizeId("files", resource.id);
        const file = id ? await ctx.db.get(id) : null;
        if (file?.workspaceId === workspaceId) label = file.name;
      } else if (resource.type === "task") {
        const id = ctx.db.normalizeId("tasks", resource.id);
        const task = id ? await ctx.db.get(id) : null;
        if (task?.workspaceId === workspaceId) label = task.title;
      }
      return label === undefined ? resource : { ...resource, label };
    }),
  );
}

/** "update_document ok on notes.md v4", "move_file conflict (VERSION_CONFLICT) on a.md". */
function mcpSummary(
  tool: string,
  outcome: Doc<"activity_events">["outcome"],
  errorCode: string | undefined,
  resource: ActivityEventResource | undefined,
  version: unknown,
): string {
  const target = resource ? (resource.label ?? `${resource.type} ${resource.id}`) : undefined;
  return `${tool} ${outcome}${errorCode && outcome !== "ok" ? ` (${errorCode})` : ""}${
    target ? ` on ${target}` : ""
  }${typeof version === "number" && outcome === "ok" ? ` v${version}` : ""}`;
}

/**
 * One MCP tool call, success or failure. `args` and `result` are JSON the
 * endpoint already redacted and digested (no document bodies); they are
 * redacted again on the way in, so the stored payload is bounded regardless.
 */
export const ingestMcpCall = internalMutation({
  args: {
    principal: vMcpUser(),
    tool: v.string(),
    args: v.optional(v.string()),
    result: v.optional(v.string()),
    outcome: v.union(v.literal("ok"), v.literal("conflict"), v.literal("error")),
    errorCode: v.optional(v.string()),
    durationMs: v.number(),
    correlationId: v.string(),
    resources: v.optional(v.array(resourceValidator)),
  },
  returns: v.union(v.null(), ingestResult),
  handler: async (ctx, args) => {
    const resolved = await resolveConnection(ctx, args.principal.userId);
    if (!resolved) return null;
    const { connection, actor } = resolved;
    const toolArgs = parseJson(args.args);
    const result = parseJson(args.result);
    const operation = field(toolArgs, "operation");
    const version = field(result, "version") ?? field(field(result, "file"), "version");
    const resources = await labelResources(ctx, connection.workspaceId, args.resources ?? []);
    return await recordActivityEvent(ctx, {
      workspaceId: connection.workspaceId,
      agentConnectionId: connection._id,
      actor,
      source: "mcp",
      type: "mcp.tool_call",
      tool: args.tool,
      outcome: args.outcome,
      errorCode: args.errorCode,
      summary: mcpSummary(args.tool, args.outcome, args.errorCode, resources[0], version),
      payload: {
        args: toolArgs,
        ...(result !== undefined ? { result } : {}),
        duration_ms: Math.max(0, Math.round(args.durationMs)),
      },
      resources,
      sessionId: connection._id,
      correlationId: args.correlationId,
      dedupeKey: `mcp:${args.correlationId}`,
      significant: classifyMcpCall(args.tool, args.outcome, typeof operation === "string" ? operation : undefined),
    });
  },
});

/**
 * One Claude Code hook request (1–25 normalized events) for the connection
 * the endpoint verified. null when that connection can't record activity
 * (revoked, or its person left the workspace): the endpoint answers 403.
 */
export const ingestHookEvent = internalMutation({
  args: { connectionId: v.string(), events: v.array(hookEventValidator) },
  returns: v.union(v.null(), v.array(ingestResult)),
  handler: async (ctx, args) => {
    const resolved = await resolveConnection(ctx, args.connectionId);
    if (!resolved) return null;
    const { connection, actor } = resolved;
    const results = [];
    for (const event of args.events.slice(0, MAX_HOOK_BATCH)) {
      const described = describeHookEvent(event);
      results.push(
        await recordActivityEvent(ctx, {
          workspaceId: connection.workspaceId,
          agentConnectionId: connection._id,
          actor,
          source: event.simulated ? "simulator" : "claude_code",
          type: described.type,
          tool: event.toolName,
          outcome: described.outcome,
          summary: described.summary,
          payload: described.payload,
          redact: HOOK_REDACT,
          sessionId: event.sessionId,
          dedupeKey: described.dedupeKey,
          significant: classifyHookEvent(event),
          occurredAt: event.occurredAt,
        }),
      );
    }
    return results;
  },
});
