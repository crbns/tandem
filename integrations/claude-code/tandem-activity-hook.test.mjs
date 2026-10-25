// node --test integrations/claude-code/
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { activityUrl, buildEvent, eventId, redact, sendEvents } from "./tandem-activity-hook.mjs";

const SCRIPT = fileURLToPath(new URL("./tandem-activity-hook.mjs", import.meta.url));
const NOW = 1_761_350_400_000;
const CWD = "/Users/sam/work/tandem-app";
const common = { session_id: "sess-1", transcript_path: "/Users/sam/.claude/projects/x/t.jsonl", cwd: CWD, permission_mode: "default" };

describe("redact", () => {
  it("removes the secret classes the server also redacts", () => {
    const secrets = [
      ["key mcp_sk_AbC123_-xyz", "mcp_sk_AbC123"],
      ["sk-ant-api03-SECRETSECRET", "SECRETSECRET"],
      ["curl -H 'Authorization: Bearer abc.def-123'", "abc.def-123"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3"],
      ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
      ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
      ["DATABASE_PASSWORD=hunter2 npm start", "hunter2"],
      ['{"api_key": "abc123def"}', "abc123def"],
      ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG", "wJalrXUtnFEMI"],
      ["export GITHUB_TOKEN=ghp_abcdef", "ghp_abcdef"],
    ];
    for (const [text, secret] of secrets) {
      const out = redact(text);
      assert.ok(!out.includes(secret), `${text} -> ${out}`);
      assert.match(out, /REDACTED/);
    }
    assert.equal(redact("pnpm test -- auth"), "pnpm test -- auth");
  });
});

describe("buildEvent", () => {
  it("sends a passing test command with its outcome and output tail", () => {
    const event = buildEvent(
      {
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        tool_input: { command: "pnpm test auth", description: "Run tests" },
        tool_response: { stdout: "x".repeat(2000) + "\n 12 passed", stderr: "", interrupted: false },
      },
      {},
      NOW,
    );
    assert.deepEqual(Object.keys(event).sort(), [
      "command", "cwd_name", "event_id", "exit_code", "file_paths", "hook_event_name", "occurred_at",
      "output_tail", "session_id", "success", "tool_name", "tool_use_id",
    ]);
    assert.equal(event.cwd_name, "tandem-app");
    assert.equal(event.success, true);
    assert.equal(event.exit_code, 0);
    assert.equal(event.command, "pnpm test auth");
    assert.ok(event.output_tail.length <= 500);
    assert.ok(event.output_tail.endsWith("12 passed"));
    assert.equal(event.event_id, eventId("sess-1", "PostToolUse", "toolu_1", NOW));
    assert.ok(!JSON.stringify(event).includes("transcript"));
    assert.ok(!JSON.stringify(event).includes("/Users/sam"));
  });

  it("parses a failing command's exit code and clips error and command", () => {
    const event = buildEvent(
      {
        ...common,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_use_id: "toolu_2",
        tool_input: { command: `npx vitest run ${"a".repeat(400)}` },
        error: `Exit code 1\nFAIL auth.test.ts\n${"e".repeat(1000)}\nToken mcp_sk_leak`,
      },
      {},
      NOW,
    );
    assert.equal(event.success, false);
    assert.equal(event.exit_code, 1);
    assert.ok(event.command.length <= 300);
    assert.ok(event.error.length <= 300);
    assert.ok(event.error.startsWith("Exit code 1"));
    assert.ok(event.output_tail.length <= 500);
    assert.ok(!event.output_tail.includes("mcp_sk_leak"));
  });

  it("sends no output for ordinary commands and redacts the command", () => {
    const event = buildEvent(
      {
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "t",
        tool_input: { command: "API_KEY=secret123 ls -la" },
        tool_response: { stdout: "private listing", stderr: "" },
      },
      {},
      NOW,
    );
    assert.equal(event.output_tail, undefined);
    assert.ok(!event.command.includes("secret123"));
    assert.ok(!JSON.stringify(event).includes("private listing"));
  });

  it("sends edited file paths relative to the project, never file content", () => {
    const event = buildEvent(
      {
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "t",
        tool_input: { file_path: `${CWD}/src/auth.ts`, old_string: "OLD-SECRET", new_string: "NEW-SECRET" },
        tool_response: { filePath: `${CWD}/src/auth.ts` },
      },
      {},
      NOW,
    );
    assert.deepEqual(event.file_paths, ["src/auth.ts"]);
    assert.equal(event.command, undefined);
    assert.equal(event.exit_code, undefined);
    assert.ok(!JSON.stringify(event).includes("SECRET"));
    const outside = buildEvent(
      { ...common, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "t", tool_input: { file_path: join(homedir(), "notes.md"), content: "x" } },
      {},
      NOW,
    );
    assert.deepEqual(outside.file_paths, ["~/notes.md"]);
    const notebook = buildEvent(
      { ...common, hook_event_name: "PostToolUse", tool_name: "NotebookEdit", tool_use_id: "t", tool_input: { notebook_path: `${CWD}/a.ipynb` } },
      {},
      NOW,
    );
    assert.deepEqual(notebook.file_paths, ["a.ipynb"]);
  });

  it("skips Tandem's own MCP tools, reads and searches, and unknown events", () => {
    for (const tool_name of ["mcp__tandem__update_document", "mcp__claude_ai_Tandem__sync_workspace", "Read", "Grep", "Glob", "LS"])
      assert.equal(buildEvent({ ...common, hook_event_name: "PostToolUse", tool_name, tool_input: {} }, {}, NOW), null);
    assert.notEqual(buildEvent({ ...common, hook_event_name: "PostToolUse", tool_name: "mcp__github__create_pr", tool_input: {} }, {}, NOW), null);
    assert.equal(buildEvent({ ...common, hook_event_name: "PreToolUse", tool_name: "Bash" }, {}, NOW), null);
    assert.equal(buildEvent(null, {}, NOW), null);
  });

  it("sends prompts only with TANDEM_CAPTURE_PROMPTS=1", () => {
    const input = { ...common, hook_event_name: "UserPromptSubmit", prompt: `Implement auth with sk-ant-abc123 ${"p".repeat(3000)}` };
    const off = buildEvent(input, {}, NOW);
    assert.deepEqual(off, {
      event_id: eventId("sess-1", "UserPromptSubmit", "", NOW),
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-1",
      occurred_at: NOW,
      prompt_captured: false,
    });
    const on = buildEvent(input, { TANDEM_CAPTURE_PROMPTS: "1" }, NOW);
    assert.equal(on.prompt_captured, true);
    assert.ok(on.prompt.startsWith("Implement auth"));
    assert.ok(on.prompt.length <= 2000);
    assert.ok(!on.prompt.includes("abc123"));
  });

  it("sends session start and stop as bare events", () => {
    const start = buildEvent({ ...common, hook_event_name: "SessionStart", source: "startup" }, {}, NOW);
    assert.deepEqual(Object.keys(start).sort(), ["cwd_name", "event_id", "hook_event_name", "occurred_at", "session_id"]);
    const stop = buildEvent({ ...common, hook_event_name: "Stop", last_assistant_message: "PRIVATE reply" }, {}, NOW);
    assert.ok(!JSON.stringify(stop).includes("PRIVATE"));
  });
});

describe("delivery", () => {
  it("derives the activity URL from the MCP URL", () => {
    assert.equal(activityUrl({ TANDEM_MCP_URL: "https://x.convex.site/mcp" }), "https://x.convex.site/activity/claude-code");
    assert.equal(activityUrl({ TANDEM_MCP_URL: "https://x.convex.site/mcp/" }), "https://x.convex.site/activity/claude-code");
    assert.equal(activityUrl({ TANDEM_ACTIVITY_URL: "http://localhost:1/a", TANDEM_MCP_URL: "https://x/mcp" }), "http://localhost:1/a");
    assert.equal(activityUrl({}), null);
  });

  it("posts with the bearer key and never throws", async () => {
    const calls = [];
    const status = await sendEvents({ events: [] }, { TANDEM_API_KEY: "mcp_sk_k", TANDEM_MCP_URL: "https://x/mcp" }, {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { status: 202 };
      },
    });
    assert.equal(status, 202);
    assert.equal(calls[0].url, "https://x/activity/claude-code");
    assert.equal(calls[0].init.headers.Authorization, "Bearer mcp_sk_k");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    const failed = await sendEvents({}, { TANDEM_API_KEY: "k", TANDEM_MCP_URL: "https://x/mcp" }, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal(failed, null);
    assert.equal(await sendEvents({}, {}), null);
  });

  it("exits 0 with no stdout against an unreachable endpoint, and on garbage input", () => {
    const env = { ...process.env, TANDEM_HOOK_DEBUG: "", TANDEM_API_KEY: "mcp_sk_test", TANDEM_ACTIVITY_URL: "http://127.0.0.1:9/activity/claude-code" };
    const input = JSON.stringify({ ...common, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "t", tool_input: { file_path: `${CWD}/a.ts` } });
    for (const stdin of [input, "not json", ""]) {
      const run = spawnSync(process.execPath, [SCRIPT], { input: stdin, env, encoding: "utf8", timeout: 10_000 });
      assert.equal(run.status, 0);
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, "");
    }
  });

  it("gives up on an endpoint that never answers within the timeout", async () => {
    const server = createServer(() => {}); // accepts, never responds
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const env = { ...process.env, TANDEM_HOOK_DEBUG: "", TANDEM_API_KEY: "mcp_sk_test", TANDEM_ACTIVITY_URL: `http://127.0.0.1:${port}/activity/claude-code` };
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stdin.end(JSON.stringify({ ...common, hook_event_name: "Stop" }));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    server.closeAllConnections();
    server.close();
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.ok(Date.now() - started < 4500, `took ${Date.now() - started}ms`);
  });
});

describe("replay", () => {
  it("turns the demo script into ordered simulated events", async () => {
    const { readFileSync } = await import("node:fs");
    const { readInputs, simulatedEvents } = await import("./replay.mjs");
    const inputs = readInputs(readFileSync(new URL("./demo-events.jsonl", import.meta.url), "utf8"));
    const events = simulatedEvents(inputs, {}, NOW);
    assert.equal(events.length, inputs.length);
    assert.ok(events.every((e) => e.simulated === true && e.session_id === "demo-agent-a"));
    assert.deepEqual(events.map((e) => e.occurred_at), events.map((_, i) => NOW + i));
    assert.equal(new Set(events.map((e) => e.event_id)).size, events.length);
    const tests = events.filter((e) => e.command === "pnpm test src/auth");
    assert.deepEqual(tests.map((e) => [e.success, e.exit_code]), [[false, 1], [true, 0]]);
    assert.match(tests[1].output_tail, /5 passed/);
    // Prompts stay out unless the replay opts in like the hook does.
    assert.equal(events[1].prompt, undefined);
    assert.match(simulatedEvents(inputs, { TANDEM_CAPTURE_PROMPTS: "1" }, NOW)[1].prompt, /JWT/);
  });
});
