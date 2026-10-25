/// <reference types="vite/client" />
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ingestMcpCall } from "./activityLog";
import { recordWorkspaceEvent } from "./lib/auth";
import { INTEL_ACTOR } from "./lib/intelQueue";
import { sha256Hex } from "./lib/mcpConfig";
import { PAYLOAD_MAX_CHARS, redactPayload, redactText } from "./lib/redact";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

const modules = import.meta.glob("./**/*.ts");
const SITE = "https://tandem-test.convex.site";
const SECRET_KEY = `mcp_sk_${"a".repeat(43)}`;
const ANTHROPIC_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = SITE;
  process.env.SITE_URL = "https://tandem.example";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function newTest() {
  return convexTest(schema, modules);
}
type Test = ReturnType<typeof newTest>;
type Caller = ReturnType<Test["withIdentity"]>;

async function connect(as: Caller, args: { workspaceId: Id<"workspaces">; client: string }) {
  const created = await as.action(api.agentConnections.createAgentConnection, args);
  return { connectionId: created.connectionId, apiKey: created.token };
}

async function callTool(t: Test, bearer: string, name: string, args: Record<string, unknown> = {}) {
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).result as { isError?: boolean; structuredContent: Record<string, any> };
}

function postHook(t: Test, bearer: string | null, body: unknown) {
  return t.fetch("/activity/claude-code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function setup() {
  const t = newTest();
  mcpTest.register(t);
  const insertUser = (name: string) =>
    t.run((ctx) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@example.com` }));
  const alexId = await insertUser("Alex");
  const samId = await insertUser("Sam");
  const jordanId = await insertUser("Jordan");
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session`, name: undefined });
  const alex = as(alexId);
  const sam = as(samId);
  const jordan = as(jordanId);
  const workspaceId = await alex.mutation(api.workspaces.createWorkspace, { name: "Demo" });
  const invite = await alex.mutation(api.workspaces.createWorkspaceInvite, { workspaceId, role: "member" });
  await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: invite.token });
  const otherWorkspaceId = await jordan.mutation(api.workspaces.createWorkspace, { name: "Other" });
  return { t, alex, sam, jordan, samId, workspaceId, otherWorkspaceId };
}

const events = (t: Test, workspaceId: Id<"workspaces">) =>
  t.run((ctx) =>
    ctx.db
      .query("activity_events")
      .withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId))
      .collect(),
  );

const mcpEvents = async (t: Test, workspaceId: Id<"workspaces">) =>
  (await events(t, workspaceId)).filter((e) => e.source === "mcp");

const intelState = (t: Test, workspaceId: Id<"workspaces">) =>
  t.run((ctx) =>
    ctx.db
      .query("context_intel_state")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );

const payloadOf = (row: { payload?: string }) => JSON.parse(row.payload ?? "null");

describe("redaction", () => {
  it("redacts secret keys and secret-looking values, and caps size", () => {
    const stored = redactPayload({
      password: "hunter2",
      nested: { api_key: "x", Authorization: "Basic abc", note: `use ${SECRET_KEY} and ${ANTHROPIC_KEY}` },
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      aws: "AKIAIOSFODNN7EXAMPLE",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      cmd: "curl -H 'Authorization: Bearer abcdef123456' API_TOKEN=supersecret https://x",
      long: "x".repeat(2000),
      list: Array.from({ length: 50 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: 1 } } } } },
    })!;
    for (const leaked of ["hunter2", "mcp_sk_", "sk-ant-", "eyJhbGci", "AKIAIOSFODNN7", "MIIEow", "abcdef123456", "supersecret", "Basic abc"])
      expect(stored).not.toContain(leaked);
    const parsed = JSON.parse(stored);
    expect(parsed.password).toBe("[redacted]");
    expect(parsed.nested.api_key).toBe("[redacted]");
    expect(parsed.long.length).toBe(500);
    expect(parsed.list).toHaveLength(21);
    expect(parsed.deep.a.b.c).toBe("[depth]");
    expect(redactText(`key ${SECRET_KEY}`, 10)).toBe("key [reda…");
    const huge = redactPayload({ items: Array.from({ length: 20 }, () => ({ a: "y".repeat(500), b: "z".repeat(500) })) })!;
    expect(huge.length).toBeLessThanOrEqual(PAYLOAD_MAX_CHARS);
    expect(() => JSON.parse(huge)).not.toThrow();
  });
});

describe("MCP call capture", () => {
  it("captures a successful call with redacted args, a digest and a correlation id", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const body = `# Notes\n${"lorem ipsum ".repeat(600)}\nTAIL_MARKER ${SECRET_KEY}`;
    const created = await callTool(t, apiKey, "create_document", { name: "notes.md", content: body });
    expect(created.isError).toBeUndefined();
    const fileId = created.structuredContent.id as string;
    const updated = await callTool(t, apiKey, "update_document", {
      file_id: fileId,
      content: `${body}\nmore`,
      expected_version: 1,
    });
    expect(updated.structuredContent.version).toBe(2);

    const rows = await mcpEvents(t, workspaceId);
    expect(rows.map((r) => r.tool)).toEqual(["create_document", "update_document"]);
    const row = rows[1]!;
    expect(row).toMatchObject({
      agentConnectionId: connectionId,
      source: "mcp",
      type: "mcp.tool_call",
      outcome: "ok",
      significant: true,
      intelStatus: "pending",
      sessionId: connectionId,
      summary: "update_document ok on /notes.md v2",
      resources: [{ type: "file", id: fileId, label: "/notes.md" }],
      actor: { type: "agent", agentConnectionId: connectionId },
    });
    expect(row.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.dedupeKey).toBe(`mcp:${row.correlationId}`);
    expect(row.correlationId).not.toBe(rows[0]!.correlationId);
    const payload = payloadOf(row);
    // Content reduced to its length and a short preview; never the body or the key.
    expect(payload.args.content.chars).toBe(body.length + 5);
    expect(payload.args.content.preview.length).toBeLessThanOrEqual(200);
    expect(payload.args.expected_version).toBe(1);
    expect(payload.result).toMatchObject({ id: fileId, name: "notes.md", version: 2 });
    expect(payload.result.next_steps).toBeUndefined();
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.payload).not.toContain("TAIL_MARKER");
    expect(row.payload).not.toContain("mcp_sk_");
    expect(row.payload!.length).toBeLessThanOrEqual(PAYLOAD_MAX_CHARS);
    // The write woke the context manager.
    expect((await intelState(t, workspaceId))?.status).toBe("scheduled");
    // agent_activity (Live page) is untouched by the new log.
    const live = await t.run((ctx) =>
      ctx.db
        .query("agent_activity")
        .withIndex("by_connection_and_created", (q) => q.eq("agentConnectionId", connectionId))
        .collect(),
    );
    expect(live.map((r) => r.tool)).toEqual(["create_document", "update_document"]);
  });

  it("captures read_file without the document body", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const created = await callTool(t, apiKey, "create_document", { name: "a.md", content: "SECRET_BODY text" });
    await callTool(t, apiKey, "read_file", { file_id: created.structuredContent.id });
    const read = (await mcpEvents(t, workspaceId)).find((r) => r.tool === "read_file")!;
    expect(read).toMatchObject({ significant: false, intelStatus: "skipped", outcome: "ok" });
    expect(read.payload).not.toContain("SECRET_BODY");
    expect(payloadOf(read).result.file).toMatchObject({ id: created.structuredContent.id, version: 1 });
  });

  it("captures failed calls: version conflicts and bad arguments", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const created = await callTool(t, apiKey, "create_document", { name: "plan.md", content: "v1" });
    const fileId = created.structuredContent.id as string;
    await callTool(t, apiKey, "update_document", { file_id: fileId, content: "v2", expected_version: 1 });
    const stale = await callTool(t, apiKey, "update_document", { file_id: fileId, content: "v3", expected_version: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent.error.code).toBe("VERSION_CONFLICT");
    const bad = await callTool(t, apiKey, "update_document", { file_id: fileId, content: "v3", expected_version: 0 });
    expect(bad.structuredContent.error.code).toBe("INVALID_INPUT");

    const rows = (await mcpEvents(t, workspaceId)).filter((r) => r.tool === "update_document");
    expect(rows.map((r) => [r.outcome, r.errorCode ?? null, r.significant])).toEqual([
      ["ok", null, true],
      ["conflict", "VERSION_CONFLICT", true],
      ["error", "INVALID_INPUT", true],
    ]);
    expect(rows[1]).toMatchObject({
      summary: "update_document conflict (VERSION_CONFLICT) on plan.md",
      resources: [{ type: "file", id: fileId, label: "plan.md" }],
    });
    expect(payloadOf(rows[2]!).args.expected_version).toBe(0);
    expect(payloadOf(rows[2]!).result).toBeUndefined();
  });

  it("marks reads and syncs insignificant without scheduling the context manager", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    await callTool(t, apiKey, "sync_workspace", { detail: "brief" });
    await callTool(t, apiKey, "list_files");
    await callTool(t, apiKey, "manage_task", { operation: "list" });
    const rows = await mcpEvents(t, workspaceId);
    expect(rows.map((r) => [r.tool, r.significant, r.intelStatus])).toEqual([
      ["sync_workspace", false, "skipped"],
      ["list_files", false, "skipped"],
      ["manage_task", false, "skipped"],
    ]);
    expect(await intelState(t, workspaceId)).toBeNull();
  });

  it("redacts secrets in tool arguments", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    await callTool(t, apiKey, "update_context", {
      field: "constraints",
      value: `Deploy with ${ANTHROPIC_KEY}, password=hunter2 and ${SECRET_KEY}`,
    });
    const row = (await mcpEvents(t, workspaceId)).find((r) => r.tool === "update_context")!;
    expect(row.outcome).toBe("ok");
    for (const leaked of ["sk-ant-", "mcp_sk_", "hunter2"]) expect(row.payload).not.toContain(leaked);
    expect(row.resources[0]).toMatchObject({ type: "context", label: "constraints" });
  });

  it("never changes the tool result when telemetry fails", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    // convex-test runs a registered function's _handler.
    vi.spyOn(ingestMcpCall as unknown as { _handler: () => Promise<null> }, "_handler").mockRejectedValue(
      new Error("telemetry down"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = await callTool(t, apiKey, "create_document", { name: "ok.md", content: "hello" });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ name: "ok.md", version: 1 });
    const failed = await callTool(t, apiKey, "update_document", {
      file_id: created.structuredContent.id,
      content: "x",
      expected_version: 5,
    });
    expect(failed.structuredContent.error.code).toBe("VERSION_CONFLICT");
    expect(await mcpEvents(t, workspaceId)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("records nothing for an unknown or revoked connection", async () => {
    const { t, sam, workspaceId } = await setup();
    const { connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const base = {
      tool: "create_document",
      outcome: "ok" as const,
      durationMs: 3,
      correlationId: crypto.randomUUID(),
    };
    await t.run((ctx) => ctx.db.patch(connectionId, { revokedAt: Date.now() }));
    expect(
      await t.mutation(internal.activityLog.ingestMcpCall, {
        ...base,
        principal: { userId: connectionId, scopes: ["tandem:write"], connectionId: "c" },
      }),
    ).toBeNull();
    expect(
      await t.mutation(internal.activityLog.ingestMcpCall, {
        ...base,
        principal: { userId: "not-a-connection", scopes: ["tandem:write"], connectionId: "c" },
      }),
    ).toBeNull();
    expect(await mcpEvents(t, workspaceId)).toEqual([]);
  });
});

describe("Claude Code hook endpoint", () => {
  it("authenticates with the connection's key: 401, 403, 400, 413, 202", async () => {
    const { t, sam, samId, workspaceId } = await setup();
    const { apiKey, connectionId } = await connect(sam, { workspaceId, client: "claude" });
    const event = { hook_event_name: "SessionStart", session_id: "s1", source: "startup" };

    expect((await postHook(t, null, event)).status).toBe(401);
    expect((await postHook(t, `mcp_sk_${"b".repeat(43)}`, event)).status).toBe(401);

    // A read-only key can't report activity.
    const readOnlyKey = `mcp_sk_${"r".repeat(43)}`;
    await t.mutation(components.mcp.grants.createApiKey, {
      userId: connectionId,
      name: "read only",
      scopes: ["tandem:read"],
      resource: `${SITE}/mcp`,
      hash: await sha256Hex(readOnlyKey),
    });
    expect((await postHook(t, readOnlyKey, event)).status).toBe(403);

    expect((await postHook(t, apiKey, "{not json")).status).toBe(400);
    expect((await postHook(t, apiKey, { hook_event_name: "PreCompact" })).status).toBe(400);
    expect((await postHook(t, apiKey, [event])).status).toBe(400);
    expect((await postHook(t, apiKey, { events: [] })).status).toBe(400);
    expect((await postHook(t, apiKey, { events: Array.from({ length: 26 }, () => event) })).status).toBe(400);
    expect((await postHook(t, apiKey, { ...event, padding: "x".repeat(70 * 1024) })).status).toBe(413);

    const ok = await postHook(t, apiKey, event);
    expect(ok.status).toBe(202);
    const okBody = await ok.json();
    expect(okBody).toMatchObject({ ok: true, duplicate: false });
    const rows = await events(t, workspaceId);
    expect(rows.filter((r) => r.source === "claude_code")).toEqual([
      expect.objectContaining({
        _id: okBody.id,
        type: "claude_code.session_start",
        agentConnectionId: connectionId,
        sessionId: "s1",
        significant: false,
        intelStatus: "skipped",
        summary: "Claude Code session started (startup)",
      }),
    ]);

    // A person who left the workspace: their key still verifies, but records nothing.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspace_members")
        .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", samId))
        .unique();
      await ctx.db.delete(membership!._id);
    });
    expect((await postHook(t, apiKey, { ...event, session_id: "s2" })).status).toBe(403);
  });

  it("maps tool uses, failures, prompts and stops, with significance and redaction", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const res = await postHook(t, apiKey, {
      events: [
        { hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "t1", tool_name: "Read", tool_input: { file_path: "/repo/a.ts" } },
        { hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "t2", tool_name: "Edit", tool_input: { file_path: "/repo/src/auth.ts", old_string: "a", new_string: "b" } },
        {
          hook_event_name: "PostToolUse",
          session_id: "s",
          tool_use_id: "t3",
          tool_name: "Bash",
          tool_input: { command: `GITHUB_TOKEN=ghp_secret123 pnpm vitest run --reporter ${SECRET_KEY}` },
          tool_response: { stdout: `${"ok\n".repeat(400)}Tests 12 passed`, stderr: "" },
        },
        { hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "t4", tool_name: "Bash", tool_input: { command: "ls -la" }, tool_response: { stdout: "files" } },
        { hook_event_name: "PostToolUseFailure", session_id: "s", tool_use_id: "t5", tool_name: "Bash", tool_input: { command: "pnpm build" }, error: `Exit 1 with Bearer ${"z".repeat(30)}` },
        { hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "t6", tool_name: "mcp__tandem__update_document", tool_input: {} },
        { hook_event_name: "UserPromptSubmit", session_id: "s", event_id: "p1", prompt: "my password is hunter2" },
        { hook_event_name: "UserPromptSubmit", session_id: "s", event_id: "p2", prompt: `Fix auth, key ${ANTHROPIC_KEY}`, capture_prompts: true },
        { hook_event_name: "Stop", session_id: "s", event_id: "stop1" },
      ],
    });
    expect(res.status).toBe(202);
    expect((await res.json()).results).toHaveLength(9);
    const rows = (await events(t, workspaceId)).filter((r) => r.source === "claude_code");
    expect(rows.map((r) => [r.type, r.tool ?? null, r.outcome, r.significant])).toEqual([
      ["claude_code.tool_use", "Read", "ok", false],
      ["claude_code.tool_use", "Edit", "ok", true],
      ["claude_code.tool_use", "Bash", "ok", true],
      ["claude_code.tool_use", "Bash", "ok", false],
      ["claude_code.tool_failure", "Bash", "error", true],
      ["claude_code.tool_use", "mcp__tandem__update_document", "ok", false],
      ["claude_code.prompt", null, "ok", false],
      ["claude_code.prompt", null, "ok", true],
      ["claude_code.stop", null, "ok", true],
    ]);
    const edit = payloadOf(rows[1]!);
    expect(edit).toMatchObject({ tool: "Edit", file_paths: ["/repo/src/auth.ts"], success: true });
    expect(rows[1]!.summary).toBe("Edit: auth.ts");
    const test = payloadOf(rows[2]!);
    expect(test.command).toContain("pnpm vitest run");
    expect(test.output_tail.length).toBeLessThanOrEqual(500);
    expect(test.output_tail).toContain("Tests 12 passed");
    expect(payloadOf(rows[3]!).output_tail).toBeUndefined();
    expect(payloadOf(rows[4]!)).toMatchObject({ success: false, command: "pnpm build" });
    // Uncaptured prompts keep no text; captured ones are redacted.
    expect(payloadOf(rows[6]!)).toEqual({ hook: "UserPromptSubmit", prompt_captured: false });
    expect(payloadOf(rows[7]!).prompt).toContain("Fix auth");
    const all = rows.map((r) => r.payload ?? "").join("\n");
    for (const leaked of ["hunter2", "ghp_secret123", "mcp_sk_", "sk-ant-", "z".repeat(30)])
      expect(all).not.toContain(leaked);
    expect((await intelState(t, workspaceId))?.status).toBe("scheduled");
  });

  it("accepts the hook script's flattened fields, with prompt_captured as the opt-in", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const occurredAt = Date.now() - 5000;
    const common = { session_id: "w3", cwd_name: "/Users/sam/code/tandem", occurred_at: occurredAt };
    const res = await postHook(t, apiKey, {
      events: [
        {
          ...common,
          event_id: "w3-1",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "tu-1",
          command: `pnpm test --token ${SECRET_KEY}`,
          success: false,
          exit_code: 1,
          output_tail: "FAIL src/auth.test.ts\nTests 1 failed",
          file_paths: [],
        },
        {
          ...common,
          event_id: "w3-2",
          hook_event_name: "PostToolUse",
          tool_name: "MultiEdit",
          tool_use_id: "tu-2",
          file_paths: ["/repo/src/auth.ts", "/repo/src/auth.ts", "/repo/src/jwt.ts"],
          success: true,
        },
        {
          ...common,
          event_id: "w3-3",
          hook_event_name: "PostToolUseFailure",
          tool_name: "Write",
          tool_use_id: "tu-3",
          file_paths: ["/repo/README.md"],
          error: "Permission denied",
        },
        { ...common, event_id: "w3-4", hook_event_name: "UserPromptSubmit", prompt: "Add JWT refresh", prompt_captured: true },
        { ...common, event_id: "w3-5", hook_event_name: "UserPromptSubmit", prompt: "not opted in", prompt_captured: false },
        { ...common, event_id: "w3-6", hook_event_name: "SubagentStop", simulated: true },
      ],
    });
    expect(res.status).toBe(202);
    const rows = (await events(t, workspaceId)).filter((r) => r.sessionId === "w3");
    expect(rows.map((r) => [r.dedupeKey, r.type, r.outcome, r.significant, r.source])).toEqual([
      ["cc:w3-1", "claude_code.tool_use", "error", true, "claude_code"],
      ["cc:w3-2", "claude_code.tool_use", "ok", true, "claude_code"],
      ["cc:w3-3", "claude_code.tool_failure", "error", true, "claude_code"],
      ["cc:w3-4", "claude_code.prompt", "ok", true, "claude_code"],
      ["cc:w3-5", "claude_code.prompt", "ok", false, "claude_code"],
      ["cc:w3-6", "claude_code.stop", "ok", true, "simulator"],
    ]);
    expect(rows.every((r) => r.occurredAt === occurredAt)).toBe(true);
    const bash = payloadOf(rows[0]!);
    expect(bash).toMatchObject({ tool: "Bash", exit_code: 1, success: false, cwd_name: "tandem" });
    expect(bash.command).toContain("pnpm test");
    expect(bash.output_tail).toContain("Tests 1 failed");
    expect(rows[0]!.payload).not.toContain("mcp_sk_");
    expect(rows[0]!.payload).not.toContain("/Users/sam");
    expect(payloadOf(rows[1]!).file_paths).toEqual(["/repo/src/auth.ts", "/repo/src/jwt.ts"]);
    expect(payloadOf(rows[2]!)).toMatchObject({ file_paths: ["/repo/README.md"], error: "Permission denied", success: false });
    expect(payloadOf(rows[3]!)).toMatchObject({ prompt: "Add JWT refresh", prompt_captured: true });
    expect(payloadOf(rows[4]!)).toEqual({ hook: "UserPromptSubmit", prompt_captured: false, cwd_name: "tandem" });
  });

  it("dedupes on event_id, clamps future timestamps and labels simulated events", async () => {
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    const event = {
      hook_event_name: "Stop",
      session_id: "s",
      event_id: "evt-1",
      timestamp: Date.now() + 60 * 60 * 1000,
      simulated: true,
    };
    const first = await (await postHook(t, apiKey, event)).json();
    const again = await (await postHook(t, apiKey, event)).json();
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ ok: true, id: first.id, duplicate: true });
    // Without an event_id, the session, hook and tool_use_id identify it.
    const tool = { hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "tu", tool_name: "Write", tool_input: { file_path: "x" } };
    await postHook(t, apiKey, tool);
    expect((await (await postHook(t, apiKey, tool)).json()).duplicate).toBe(true);
    const rows = await events(t, workspaceId);
    const simulated = rows.filter((r) => r.type === "claude_code.stop");
    expect(simulated).toHaveLength(1);
    expect(simulated[0]!.source).toBe("simulator");
    expect(simulated[0]!.occurredAt).toBeLessThanOrEqual(Date.now() + 60 * 1000);
    expect(rows.filter((r) => r.tool === "Write")).toHaveLength(1);
  });

  it("writes only into the key's own workspace, whatever the body says", async () => {
    const { t, jordan, workspaceId, otherWorkspaceId } = await setup();
    const { apiKey, connectionId } = await connect(jordan, { workspaceId: otherWorkspaceId, client: "claude" });
    const res = await postHook(t, apiKey, {
      hook_event_name: "Stop",
      session_id: "s",
      workspace_id: workspaceId,
      workspaceId,
      connection_id: "someone-else",
    });
    expect(res.status).toBe(202);
    expect(await events(t, workspaceId)).toEqual([]);
    expect((await events(t, otherWorkspaceId)).filter((r) => r.source === "claude_code")).toEqual([
      expect.objectContaining({ agentConnectionId: connectionId, type: "claude_code.stop" }),
    ]);
  });

  it("stores concurrent events from two connections", async () => {
    const { t, alex, sam, workspaceId } = await setup();
    const a = await connect(alex, { workspaceId, client: "claude" });
    const b = await connect(sam, { workspaceId, client: "claude" });
    const edit = (session: string) => ({
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_use_id: "same-id",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/a.ts" },
    });
    const [ra, rb] = await Promise.all([postHook(t, a.apiKey, edit("sa")), postHook(t, b.apiKey, edit("sb"))]);
    expect([ra.status, rb.status]).toEqual([202, 202]);
    const rows = (await events(t, workspaceId)).filter((r) => r.source === "claude_code");
    expect(new Set(rows.map((r) => r.agentConnectionId))).toEqual(new Set([a.connectionId, b.connectionId]));
  });
});

describe("workspace mirror", () => {
  it("mirrors a dashboard file save with the file and version", async () => {
    const { t, alex, workspaceId } = await setup();
    const file = await alex.mutation(api.files.createDocument, {
      workspaceId,
      name: "spec.md",
      mimeType: "text/markdown",
      content: "v1",
    });
    await alex.mutation(api.files.updateDocument, { fileId: file.id as Id<"files">, content: "v2", expectedVersion: 1 });
    const rows = (await events(t, workspaceId)).filter((r) => r.source === "workspace");
    expect(rows.map((r) => r.type)).toEqual(["file.created", "file.updated"]);
    const updated = rows[1]!;
    expect(updated).toMatchObject({
      actor: { type: "human" },
      significant: true,
      intelStatus: "pending",
      resources: [{ type: "file", id: file.id, label: "spec.md" }],
    });
    expect(updated.agentConnectionId).toBeUndefined();
    expect(payloadOf(updated)).toEqual({ kind: "file.updated", entityId: file.id, version: 2 });
    const event = await t.run((ctx) =>
      ctx.db
        .query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", workspaceId))
        .order("desc")
        .first(),
    );
    expect(updated.dedupeKey).toBe(`ws:${event!._id}`);
    expect((await intelState(t, workspaceId))?.status).toBe("scheduled");
  });

  it("never mirrors system-actor events or unrelated kinds", async () => {
    const { t, workspaceId } = await setup();
    await t.run(async (ctx) => {
      await recordWorkspaceEvent(ctx, {
        workspaceId,
        kind: "file.updated",
        entityType: "file",
        entityId: "x",
        summary: "context manager",
        actor: INTEL_ACTOR,
      });
    });
    // workspace.created, member_added and agent.connected aren't mirrored either.
    expect(await events(t, workspaceId)).toEqual([]);
    expect(await intelState(t, workspaceId)).toBeNull();
  });
});

describe("retention", () => {
  it("prunes activity_events older than 14 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t, sam, workspaceId } = await setup();
    const { apiKey } = await connect(sam, { workspaceId, client: "claude" });
    await postHook(t, apiKey, { hook_event_name: "Stop", session_id: "old", event_id: "old" });
    vi.setSystemTime(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await postHook(t, apiKey, { hook_event_name: "Stop", session_id: "new", event_id: "new" });
    vi.setSystemTime(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.activity.pruneActivity, {});
    expect((await events(t, workspaceId)).map((r) => r.sessionId)).toEqual(["new"]);
  });
});
