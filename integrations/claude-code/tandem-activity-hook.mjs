#!/usr/bin/env node
// Tandem activity hook for Claude Code (docs/claude-code-hooks.md).
//
// Claude Code runs this on SessionStart, UserPromptSubmit, PostToolUse,
// PostToolUseFailure and Stop with the hook's JSON on stdin. It sends a
// small, redacted summary of the event to Tandem's
// POST <deployment>.convex.site/activity/claude-code, where the context
// manager turns it into observed workspace context.
//
// It must never get in Claude Code's way: it prints nothing to stdout (on
// SessionStart and UserPromptSubmit stdout would become context for Claude),
// always exits 0, and gives up on the network after 2.5 s. Node >= 18, no
// dependencies.
//
// Env:
//   TANDEM_API_KEY          the mcp_sk_ key the Claude Code MCP connection uses
//   TANDEM_MCP_URL          https://<deployment>.convex.site/mcp
//   TANDEM_ACTIVITY_URL     override; default is TANDEM_MCP_URL with /mcp
//                           replaced by /activity/claude-code
//   TANDEM_CAPTURE_PROMPTS  1 to send prompt text (off by default)
//   TANDEM_HOOK_DEBUG       1 to log what happens to stderr
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const HOOK_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);
// Tandem's own tools are already logged server-side; reporting them again
// would double-count and could loop.
export const TANDEM_TOOL = /^mcp__.*tandem.*__/i;
// Reads and searches are noise for the context manager.
export const NOISE_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
// Commands whose result is evidence (a passing test, a failed build, a
// push), so their output tail is worth sending.
const OUTCOME_COMMAND =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|deploy|check-types|typecheck|lint)\b|npx\s+(vitest|jest|tsc|playwright|convex\s+deploy|vercel)\b|(vitest|jest|pytest|mocha|tsc|playwright|cargo\s+(test|build)|go\s+(test|build)|make|gradle|mvn|vercel|git)\b)/;

const LIMITS = { command: 300, outputTail: 500, error: 300, prompt: 2000, path: 300 };
export const TIMEOUT_MS = 2500;

// Same classes of secret as the server's redaction (lib/redact.ts), applied
// before anything leaves the machine.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\bmcp_sk_[A-Za-z0-9_-]+/g, "mcp_sk_[REDACTED]"],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[REDACTED JWT]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(["']?)(?!\[REDACTED)[^\s"'&,;]+/gi,
    "$1$2$3[REDACTED]",
  ],
];

export function redact(text) {
  let out = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const head = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const tail = (text, max) => (text.length > max ? `…${text.slice(-(max - 1))}` : text);
const str = (value) => (typeof value === "string" ? value : "");

/** TANDEM_ACTIVITY_URL, else TANDEM_MCP_URL with its trailing /mcp swapped. */
export function activityUrl(env) {
  if (env.TANDEM_ACTIVITY_URL) return env.TANDEM_ACTIVITY_URL;
  const mcp = str(env.TANDEM_MCP_URL).trim();
  if (!/\/mcp\/?$/.test(mcp)) return null;
  return mcp.replace(/\/mcp\/?$/, "/activity/claude-code");
}

/** Relative to the project when inside it, else with the home dir as ~. */
function displayPath(path, cwd) {
  let p = path;
  if (cwd && p.startsWith(cwd + sep)) p = p.slice(cwd.length + 1);
  else {
    const home = homedir();
    if (home && p.startsWith(home + sep)) p = `~${p.slice(home.length)}`;
  }
  return head(redact(p), LIMITS.path);
}

export function eventId(sessionId, hook, toolUseId, occurredAt) {
  return createHash("sha256")
    .update(`${sessionId}\u0000${hook}\u0000${toolUseId}\u0000${occurredAt}`)
    .digest("hex");
}

/**
 * The payload for one hook input, or null when it shouldn't be sent. Pure:
 * no I/O. Never copies transcript_path, full tool output, file contents or
 * (without TANDEM_CAPTURE_PROMPTS=1) the prompt.
 */
export function buildEvent(input, env = {}, now = Date.now()) {
  if (!input || typeof input !== "object") return null;
  const hook = str(input.hook_event_name);
  if (!HOOK_EVENTS.has(hook)) return null;
  const sessionId = head(str(input.session_id), 200);
  const toolName = str(input.tool_name);
  const toolUseId = head(str(input.tool_use_id), 200);
  const base = {
    event_id: eventId(sessionId, hook, toolUseId, now),
    hook_event_name: hook,
    session_id: sessionId,
    occurred_at: now,
  };
  if (hook === "UserPromptSubmit") {
    if (env.TANDEM_CAPTURE_PROMPTS !== "1") return { ...base, prompt_captured: false };
    return {
      ...base,
      cwd_name: basename(str(input.cwd)),
      prompt: head(redact(str(input.prompt)), LIMITS.prompt),
      prompt_captured: true,
    };
  }
  const event = { ...base, cwd_name: basename(str(input.cwd)) };
  if (hook !== "PostToolUse" && hook !== "PostToolUseFailure") return event;

  if (!toolName || TANDEM_TOOL.test(toolName) || NOISE_TOOLS.has(toolName)) return null;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const cwd = str(input.cwd);
  const filePaths = [toolInput.file_path, toolInput.notebook_path, toolInput.path]
    .filter((p) => typeof p === "string" && p)
    .map((p) => displayPath(p, cwd));
  const failed = hook === "PostToolUseFailure";
  Object.assign(event, {
    tool_name: toolName,
    tool_use_id: toolUseId,
    file_paths: [...new Set(filePaths)],
    success: !failed,
  });
  const command = toolName === "Bash" ? str(toolInput.command) : "";
  if (command) event.command = head(redact(command), LIMITS.command);
  const errorText = failed ? str(input.error) : "";
  if (failed) {
    // Bash failures start with "Exit code N"; other tools have free text.
    const code = /^Exit code (\d+)/.exec(errorText);
    if (code) event.exit_code = Number(code[1]);
    if (errorText) event.error = head(redact(errorText), LIMITS.error);
  } else if (toolName === "Bash") {
    // A Bash command that exits non-zero fires PostToolUseFailure instead.
    event.exit_code = 0;
  }
  if (command && OUTCOME_COMMAND.test(command)) {
    const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
    const output = failed
      ? errorText
      : [str(response.stdout), str(response.stderr)].filter(Boolean).join("\n");
    if (output) event.output_tail = tail(redact(output.trimEnd()), LIMITS.outputTail);
  }
  return event;
}

function debug(env, ...args) {
  if (env.TANDEM_HOOK_DEBUG === "1") console.error("[tandem-hook]", ...args);
}

/**
 * POSTs one event or `{ events }` to the activity endpoint. Resolves to the
 * HTTP status, or null on any network failure or timeout; never throws.
 */
export async function sendEvents(body, env, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = activityUrl(env);
  const key = str(env.TANDEM_API_KEY).trim();
  if (!url || !key) {
    debug(env, "not sent: set TANDEM_API_KEY and TANDEM_MCP_URL (or TANDEM_ACTIVITY_URL)");
    return null;
  }
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    debug(env, `POST ${url} -> ${res.status}`);
    return res.status;
  } catch (err) {
    debug(env, `POST ${url} failed: ${err?.name ?? "Error"}: ${err?.message ?? err}`);
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const env = process.env;
  try {
    const raw = await readStdin();
    const event = buildEvent(JSON.parse(raw), env);
    if (!event) {
      debug(env, "skipped");
      return;
    }
    debug(env, "event", JSON.stringify(event));
    await sendEvents(event, env);
  } catch (err) {
    debug(env, `error: ${err?.message ?? err}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Backstop in case stdin never closes: never outlive the network timeout by much.
  setTimeout(() => process.exit(0), TIMEOUT_MS + 1500).unref();
  main().finally(() => process.exit(0));
}
