// Ingestion into activity_events (docs/context-intelligence.md): one helper
// that stores a redacted, deduplicated row and wakes the context manager for
// significant ones, plus the pure rules that decide what is significant and
// how a Claude Code hook body becomes an event. Imports from ./auth are
// type-only: lib/auth's recordWorkspaceEvent calls into this module.
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./auth";
import { requestIntelRun } from "./intelQueue";
import { redactPayload, redactTail, redactText, type RedactOptions } from "./redact";

const SUMMARY_MAX = 200;
const RESOURCE_MAX = 10;
const RESOURCE_LABEL_MAX = 80;
// Hooks may arrive late, never meaningfully early.
const FUTURE_SKEW_MS = 60 * 1000;

export type ActivityEventResource = Doc<"activity_events">["resources"][number];

export interface ActivityEventInput {
  workspaceId: Id<"workspaces">;
  agentConnectionId?: Id<"agent_connections">;
  actor: Actor;
  source: Doc<"activity_events">["source"];
  type: string;
  tool?: string;
  outcome: Doc<"activity_events">["outcome"];
  errorCode?: string;
  summary: string;
  /** Any JSON-ish value; always stored through redactPayload. */
  payload?: unknown;
  redact?: RedactOptions;
  resources?: ActivityEventResource[];
  sessionId?: string;
  correlationId?: string;
  dedupeKey: string;
  significant: boolean;
  occurredAt?: number;
}

function clamp(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function cut(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : text.slice(0, max);
}

/**
 * Stores one activity event. A second event with the same dedupeKey in the
 * workspace returns the first one's id with `duplicate: true` and writes
 * nothing. A new significant event is `pending` and requests a context
 * manager run in the same transaction; everything else is `skipped`.
 */
export async function recordActivityEvent(
  ctx: MutationCtx,
  input: ActivityEventInput,
): Promise<{ id: Id<"activity_events">; duplicate: boolean }> {
  const dedupeKey = input.dedupeKey.slice(0, 200);
  const existing = await ctx.db
    .query("activity_events")
    .withIndex("by_workspace_and_dedupe_key", (q) =>
      q.eq("workspaceId", input.workspaceId).eq("dedupeKey", dedupeKey),
    )
    .first();
  if (existing) return { id: existing._id, duplicate: true };
  const now = Date.now();
  const occurredAt =
    input.occurredAt !== undefined && Number.isFinite(input.occurredAt) && input.occurredAt > 0
      ? Math.min(input.occurredAt, now + FUTURE_SKEW_MS)
      : now;
  const resources = (input.resources ?? []).slice(0, RESOURCE_MAX).map((r) => ({
    type: r.type,
    id: r.id.slice(0, 128),
    ...(r.label !== undefined ? { label: clamp(r.label, RESOURCE_LABEL_MAX) } : {}),
  }));
  const id = await ctx.db.insert("activity_events", {
    workspaceId: input.workspaceId,
    agentConnectionId: input.agentConnectionId,
    actor: input.actor,
    source: input.source,
    type: input.type.slice(0, 64),
    tool: cut(input.tool, 64),
    outcome: input.outcome,
    errorCode: cut(input.errorCode, 64),
    summary: clamp(input.summary, SUMMARY_MAX) || input.type.slice(0, 64),
    payload: redactPayload(input.payload, input.redact),
    resources,
    sessionId: cut(input.sessionId, 128),
    correlationId: cut(input.correlationId, 128),
    dedupeKey,
    significant: input.significant,
    intelStatus: input.significant ? "pending" : "skipped",
    occurredAt,
    createdAt: now,
  });
  if (input.significant) await requestIntelRun(ctx, input.workspaceId);
  return { id, duplicate: false };
}

// ---- MCP ------------------------------------------------------------------

/** Lookups and syncs: frequent, and they change nothing the team relies on. */
const MCP_READ_TOOLS = new Set([
  "sync_workspace",
  "get_workspace_info",
  "list_files",
  "search_files",
  "get_approvals",
  "get_file_versions",
  // Kept simple: reads are never significant. What an assistant does with
  // what it read shows up in its writes.
  "read_file",
]);

const MCP_WRITE_TOOLS = new Set([
  "create_document",
  "update_document",
  "create_folder",
  "move_file",
  "move_folder",
  "publish_work",
  "propose_context_change",
  "manage_task",
]);

/**
 * Whether an MCP call is worth the context manager's attention. Writes are,
 * whatever the outcome: a conflict or error on a write is a blocker. Reads
 * never are. manage_task's `list` operation is a read. An unknown tool only
 * when it failed.
 */
export function classifyMcpCall(
  tool: string,
  outcome: Doc<"activity_events">["outcome"],
  operation?: string,
): boolean {
  if (MCP_READ_TOOLS.has(tool)) return false;
  if (tool === "manage_task") return operation !== "list";
  if (MCP_WRITE_TOOLS.has(tool)) return true;
  return outcome !== "ok";
}

// ---- Claude Code hooks ----------------------------------------------------

export const HOOK_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStop",
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** A hook body after narrowing, clamping and redaction (normalizeHookEvent). */
export const hookEventValidator = v.object({
  hook: v.union(...HOOK_NAMES.map((name) => v.literal(name))),
  sessionId: v.optional(v.string()),
  eventId: v.optional(v.string()),
  // SessionStart's source: startup, resume, clear, compact.
  sessionSource: v.optional(v.string()),
  toolName: v.optional(v.string()),
  toolUseId: v.optional(v.string()),
  occurredAt: v.optional(v.number()),
  // The working directory's last segment only, never a full path.
  cwdName: v.optional(v.string()),
  filePaths: v.array(v.string()),
  command: v.optional(v.string()),
  success: v.optional(v.boolean()),
  exitCode: v.optional(v.number()),
  output: v.optional(v.string()),
  error: v.optional(v.string()),
  prompt: v.optional(v.string()),
  promptCaptured: v.boolean(),
  simulated: v.boolean(),
});
export type HookEvent = Infer<typeof hookEventValidator>;

const HOOK_TYPES: Record<HookName, string> = {
  SessionStart: "claude_code.session_start",
  UserPromptSubmit: "claude_code.prompt",
  PostToolUse: "claude_code.tool_use",
  PostToolUseFailure: "claude_code.tool_failure",
  Stop: "claude_code.stop",
  SubagentStop: "claude_code.stop",
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Bash commands that verify, ship or record work.
const MEANINGFUL_COMMAND = /\b(test|vitest|jest|pytest|tsc|build|deploy)\b|\bgit\s+(commit|push)\b/i;
// The subset whose output tail is worth keeping (pass/fail evidence).
const VERIFY_COMMAND = /\b(test|vitest|jest|pytest|tsc|build|deploy)\b/i;
// Tandem's own MCP tools are logged server-side by mcp.ts.
const TANDEM_MCP_TOOL = /^mcp__.*tandem/i;

const COMMAND_MAX = 300;
const OUTPUT_MAX = 500;
const PROMPT_MAX = 2000;

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function timestamp(value: unknown): number | undefined {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Narrows one hook body to a HookEvent, or an
 * error message for a 400. Accepts the hook script's flattened fields
 * (event_id, occurred_at, cwd_name, file_paths, command, success, exit_code,
 * output_tail, error, prompt, prompt_captured, simulated) as well as Claude
 * Code's raw hook JSON (tool_input, tool_response, timestamp). Prompt text is
 * kept only with an explicit opt-in: prompt_captured (or the capture_prompts /
 * prompt_capture aliases) set to true. Workspace or identity fields in the body are
 * ignored: those come only from the verified key. Secrets are redacted here,
 * before anything crosses into a mutation.
 */
export function normalizeHookEvent(raw: unknown): { event: HookEvent } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { error: "Each event must be a JSON object." };
  const body = raw as Record<string, unknown>;
  const hook = body.hook_event_name ?? body.hook;
  if (typeof hook !== "string" || !(HOOK_NAMES as readonly string[]).includes(hook))
    return { error: `hook_event_name must be one of ${HOOK_NAMES.join(", ")}.` };
  const name = hook as HookName;
  const promptCaptured =
    body.prompt_captured === true || body.capture_prompts === true || body.prompt_capture === true;
  const input = record(body.tool_input);
  const response = body.tool_response;
  const responseFields = record(response);
  const toolName = str(body.tool_name, 64);
  const filePaths = [
    ...(Array.isArray(body.file_paths) ? body.file_paths.slice(0, 10) : []),
    input.file_path,
    input.notebook_path,
    input.path,
  ]
    .map((p) => str(p, 300))
    .filter((p, i, all): p is string => p !== undefined && all.indexOf(p) === i)
    .slice(0, 10);
  const rawCommand = str(body.command, 10_000) ?? (toolName === "Bash" ? str(input.command, 10_000) : undefined);
  const command = rawCommand === undefined ? undefined : redactText(rawCommand, COMMAND_MAX);
  const exit = responseFields.exit_code ?? responseFields.exitCode ?? body.exit_code;
  const exitCode = typeof exit === "number" && Number.isInteger(exit) ? exit : undefined;
  let output: string | undefined;
  if (rawCommand !== undefined && VERIFY_COMMAND.test(rawCommand)) {
    const text =
      typeof body.output_tail === "string"
        ? body.output_tail
        : typeof response === "string"
          ? response
          : [responseFields.stdout, responseFields.stderr]
              .filter((part): part is string => typeof part === "string" && part.length > 0)
              .join("\n");
    if (text) output = redactTail(text, OUTPUT_MAX);
  }
  const error = typeof body.error === "string" && body.error ? redactText(body.error, OUTPUT_MAX) : undefined;
  const prompt =
    name === "UserPromptSubmit" && promptCaptured && typeof body.prompt === "string" && body.prompt.trim()
      ? redactText(body.prompt, PROMPT_MAX)
      : undefined;
  return {
    event: {
      hook: name,
      sessionId: str(body.session_id, 128),
      eventId: str(body.event_id, 128),
      sessionSource: name === "SessionStart" ? str(body.source, 32) : undefined,
      toolName,
      toolUseId: str(body.tool_use_id, 128),
      occurredAt: timestamp(body.occurred_at ?? body.timestamp),
      cwdName: typeof body.cwd_name === "string" ? str(basename(body.cwd_name), 100) : undefined,
      filePaths,
      command,
      success: typeof body.success === "boolean" ? body.success : undefined,
      exitCode,
      output,
      error,
      prompt,
      promptCaptured,
      simulated: body.simulated === true,
    },
  };
}

/** Whether a hook event is worth the context manager's attention. */
export function classifyHookEvent(event: HookEvent): boolean {
  switch (event.hook) {
    case "SessionStart":
      return false;
    // Without captured text a prompt says nothing beyond "they were working".
    case "UserPromptSubmit":
      return event.prompt !== undefined;
    case "PostToolUseFailure":
      return true;
    case "Stop":
    case "SubagentStop":
      return true;
    case "PostToolUse": {
      const tool = event.toolName ?? "";
      if (TANDEM_MCP_TOOL.test(tool)) return false;
      if (EDIT_TOOLS.has(tool) || event.success === false) return true;
      if (tool === "Bash")
        return (event.exitCode ?? 0) !== 0 || (event.command !== undefined && MEANINGFUL_COMMAND.test(event.command));
      return false;
    }
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The activity_events fields a hook event maps to (workspace and actor aside). */
export function describeHookEvent(event: HookEvent): {
  type: string;
  outcome: Doc<"activity_events">["outcome"];
  summary: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
} {
  const tool = event.toolName;
  const target = event.command ?? (event.filePaths[0] ? basename(event.filePaths[0]) : undefined);
  const failed = event.hook === "PostToolUseFailure" || event.success === false || (event.exitCode ?? 0) !== 0;
  let summary: string;
  switch (event.hook) {
    case "SessionStart":
      summary = `Claude Code session started${event.sessionSource ? ` (${event.sessionSource})` : ""}`;
      break;
    case "UserPromptSubmit":
      summary = event.prompt !== undefined ? "Claude Code prompt" : "Claude Code prompt (text not captured)";
      break;
    case "Stop":
      summary = "Claude Code finished a turn";
      break;
    case "SubagentStop":
      summary = "Claude Code subagent finished";
      break;
    default:
      summary = `${tool ?? "Tool"}${failed ? " failed" : ""}${target ? `: ${target}` : ""}${
        event.exitCode !== undefined && event.exitCode !== 0 ? ` (exit ${event.exitCode})` : ""
      }`;
  }
  const payload: Record<string, unknown> = { hook: event.hook };
  if (tool !== undefined) payload.tool = tool;
  if (event.filePaths.length) payload.file_paths = event.filePaths;
  if (event.command !== undefined) payload.command = event.command;
  if (event.exitCode !== undefined) payload.exit_code = event.exitCode;
  if (event.hook === "PostToolUse" || event.hook === "PostToolUseFailure") payload.success = !failed;
  if (event.output !== undefined) payload.output_tail = event.output;
  if (event.error !== undefined) payload.error = event.error;
  if (event.hook === "UserPromptSubmit") payload.prompt_captured = event.prompt !== undefined;
  if (event.prompt !== undefined) payload.prompt = event.prompt;
  if (event.sessionSource !== undefined) payload.session_source = event.sessionSource;
  if (event.cwdName !== undefined) payload.cwd_name = event.cwdName;
  if (event.simulated) payload.simulated = true;
  const dedupeKey = event.eventId
    ? `cc:${event.eventId}`
    : `cc:${shortHash(
        [event.sessionId ?? "", event.hook, event.toolUseId ?? String(event.occurredAt ?? Date.now())].join("|"),
      )}`;
  return {
    type: HOOK_TYPES[event.hook],
    outcome: failed ? "error" : "ok",
    summary,
    payload,
    dedupeKey,
  };
}

/** Prompt text is the longest field a hook payload keeps. */
export const HOOK_REDACT: RedactOptions = { maxString: PROMPT_MAX };

/** Non-cryptographic 64-bit FNV-1a, hex: a stable dedupe key, not a secret. */
export function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

// ---- Workspace mirror -----------------------------------------------------

const MIRRORED_CONTEXT_KINDS = new Set(["context.approved", "context.rejected", "context.updated"]);

/**
 * Copies a workspace event into activity_events when it is a file change or a
 * context decision. System actors (the context manager, the conflict check)
 * are never mirrored, so the context manager can't feed on its own writes.
 */
export async function mirrorWorkspaceEvent(
  ctx: MutationCtx,
  eventId: Id<"workspace_events">,
  event: {
    workspaceId: Id<"workspaces">;
    kind: string;
    entityType: string;
    entityId: string;
    summary: string;
    actor: Actor;
  },
): Promise<void> {
  if (event.actor.type === "system") return;
  const isFile = event.kind.startsWith("file.");
  if (!isFile && !MIRRORED_CONTEXT_KINDS.has(event.kind)) return;
  let version: number | undefined;
  let resource: ActivityEventResource;
  if (isFile) {
    const fileId = ctx.db.normalizeId("files", event.entityId);
    const file = fileId ? await ctx.db.get(fileId) : null;
    version = file?.version;
    resource = { type: "file", id: event.entityId, ...(file ? { label: file.name } : {}) };
  } else {
    resource = { type: event.entityType === "context_proposal" ? "proposal" : "context", id: event.entityId };
  }
  await recordActivityEvent(ctx, {
    workspaceId: event.workspaceId,
    agentConnectionId: event.actor.agentConnectionId,
    actor: event.actor,
    source: "workspace",
    type: event.kind,
    outcome: "ok",
    summary: event.summary,
    payload: { kind: event.kind, entityId: event.entityId, ...(version !== undefined ? { version } : {}) },
    resources: [resource],
    dedupeKey: `ws:${eventId}`,
    significant: true,
  });
}
