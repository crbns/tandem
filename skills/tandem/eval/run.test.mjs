import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, rates } from "./run.mjs";

const context = {
  prompt: { id: "synthetic", kind: "project" },
  condition: "WITH_SKILL",
  rep: 1,
};
const init = { type: "system", subtype: "init", model: "synthetic" };
const final = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done",
};
const toolUse = (id, tool) => ({
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id, name: `mcp__tandem__${tool}`, input: {} },
    ],
  },
});
const toolResult = (id, isError = false, content = "OK") => ({
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, is_error: isError, content },
    ],
  },
});
const trial = (events, overrides = {}) =>
  analyze(
    {
      stdout: events.map((e) => JSON.stringify(e)).join("\n"),
      stderr: "",
      code: 0,
      timedOut: false,
      ...overrides,
    },
    context,
  );

for (const isError of [true, false]) {
  test(`sync and write ${isError ? "errors survive a successful final answer" : "succeed with non-error results"}`, () => {
    const t = trial([
      init,
      toolUse("sync", "sync_workspace"),
      toolResult(
        "sync",
        isError,
        isError ? "UNAUTHENTICATED" : "workspace context",
      ),
      toolUse("write", "create_document"),
      toolResult(
        "write",
        isError,
        isError ? "UNAUTHENTICATED" : "document created",
      ),
      final,
    ]);
    const r = rates([t]);
    assert.equal(t.error, null);
    assert.equal(r.sync, 1);
    assert.equal(r.first_is_sync, 1);
    assert.equal(r.write, 1);
    assert.equal(r.sync_ok, isError ? 0 : 1);
    assert.equal(r.write_ok, isError ? 0 : 1);
    assert.equal(r.tool_errors, isError ? 1 : 0);
    assert.equal(r.errors_or_timeouts, isError ? 1 : 0);
    assert.equal(t.write_tools[0].ok, !isError);
    if (isError) assert.equal(t.tandem_errors[0].error, "UNAUTHENTICATED");
  });
}

test("unreturned tool calls count only as attempts and missing final result fails", () => {
  const t = trial([
    init,
    toolUse("sync", "sync_workspace"),
    toolUse("write", "create_document"),
  ]);
  const r = rates([t]);
  assert.equal(t.error, "no final result event");
  assert.equal(r.sync, 1);
  assert.equal(r.write, 1);
  assert.equal(r.sync_ok, 0);
  assert.equal(r.write_ok, 0);
  assert.equal(r.tool_errors, 0);
  assert.equal(r.errors_or_timeouts, 1);
});

test("nonzero CLI exit fails even with a successful final result", () => {
  const t = trial([init, final], { code: 1 });
  assert.equal(t.error, "claude exited with code 1");
  assert.equal(rates([t]).errors_or_timeouts, 1);
});

test("an empty error result still counts as a tool error", () => {
  const t = trial([
    init,
    toolUse("sync", "sync_workspace"),
    toolResult("sync", true, ""),
    final,
  ]);
  assert.equal(rates([t]).tool_errors, 1);
  assert.equal(rates([t]).sync_ok, 0);
});

test("a successful retry counts as OK while preserving the tool error", () => {
  const t = trial([
    init,
    toolUse("sync1", "sync_workspace"),
    toolResult("sync1", true, "UNAUTHENTICATED"),
    toolUse("sync2", "sync_workspace"),
    toolResult("sync2"),
    final,
  ]);
  const r = rates([t]);
  assert.equal(r.sync, 1);
  assert.equal(r.sync_ok, 1);
  assert.equal(r.tool_errors, 1);
  assert.equal(r.errors_or_timeouts, 1);
});

test("external flags override env and use Bearer auth without changing the mock default", async () => {
  const { parseArgs, mcpConnection } = await import("./run.mjs");
  const mock = parseArgs([], {});
  assert.equal(mock.mcp_url, null);
  assert.equal(mock.concurrency, 2);
  assert.deepEqual(mcpConnection(mock, 9000).headers, {
    "api-key": "alex-dev-token",
  });
  const external = parseArgs(
    [
      "--mcp-url",
      "http://127.0.0.1:3241/mcp",
      "--mcp-key",
      "flag-key",
      "--concurrency",
      "1",
    ],
    {
      TANDEM_MCP_URL: "https://unused.example/mcp",
      TANDEM_MCP_KEY: "env-key",
      TANDEM_MCP_TEAMMATE_KEY: "teammate",
      TANDEM_BRIEF_ID: "brief",
    },
  );
  assert.equal(external.mcp_key, "flag-key");
  assert.equal(external.mcp_teammate_key, "teammate");
  assert.equal(external.brief_id, "brief");
  assert.deepEqual(mcpConnection(external, 9000), {
    type: "http",
    url: "http://127.0.0.1:3241/mcp",
    headers: { Authorization: "Bearer flag-key" },
  });
  assert.equal(
    mcpConnection(external, 9000, "teammate").headers.Authorization,
    "Bearer teammate",
  );
});

test("external mode rejects missing auth, unsafe URLs, concurrent writes and misleading fixtures", async () => {
  const { parseArgs } = await import("./run.mjs");
  assert.throws(
    () => parseArgs(["--mcp-url", "https://test.example/mcp"], {}),
    /requires --mcp-key/,
  );
  const base = ["--mcp-key", "key", "--concurrency", "1"];
  for (const url of [
    "garbage",
    "file:///tmp/mcp",
    "https://user:secret@test.example/mcp",
    "https://test.example/mcp?key=secret",
    "https://test.example/mcp#secret",
  ]) {
    assert.throws(() => parseArgs([...base, "--mcp-url", url], {}), /HTTP/);
  }
  assert.throws(
    () =>
      parseArgs(
        ["--mcp-url", "https://test.example/mcp", "--mcp-key", "key"],
        {},
      ),
    /concurrency 1/,
  );
  assert.throws(
    () =>
      parseArgs(
        [
          ...base,
          "--mcp-url",
          "https://test.example/mcp",
          "--env",
          "realistic",
        ],
        {},
      ),
    /bare only/,
  );
  assert.throws(() => parseArgs(["--mcp-key", "key"], {}), /require --mcp-url/);
});

test("external RPC accepts JSON and SSE responses, including CRLF and multiline data", async () => {
  const { parseRpcResponse } = await import("./run.mjs");
  const body = { jsonrpc: "2.0", id: 1, result: { content: [] } };
  assert.deepEqual(parseRpcResponse(JSON.stringify(body)), body);
  assert.deepEqual(
    parseRpcResponse(`event: message\r\ndata: ${JSON.stringify(body)}\r\n\r\n`),
    body,
  );
  assert.deepEqual(
    parseRpcResponse(
      'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"content":[]}}\n\n',
    ),
    body,
  );
  assert.throws(() => parseRpcResponse("event: ping\n\n"), /No JSON-RPC/);
});

test("persisted results redact credentials even in errors and answers", async () => {
  const { redactSecrets } = await import("./run.mjs");
  assert.deepEqual(
    redactSecrets({ error: 'Bearer secret"key', nested: ["other-key"] }, [
      'secret"key',
      "other-key",
      null,
    ]),
    {
      error: "Bearer [REDACTED]",
      nested: ["[REDACTED]"],
    },
  );
});

test("a conflict recovery requires a changed head with the teammate marker", async () => {
  const { TEAMMATE_MARKER } = await import("./fixtures.mjs");
  const events = [
    init,
    toolUse("read", "read_file"),
    toolResult("read"),
    toolUse("stale", "update_document"),
    toolResult("stale", true, "VERSION_CONFLICT"),
    toolUse("reread", "read_file"),
    toolResult("reread"),
    toolUse("retry", "update_document"),
    toolResult("retry"),
    final,
  ];
  const run = {
    stdout: events.map(JSON.stringify).join("\n"),
    stderr: "",
    code: 0,
    timedOut: false,
  };
  const state = {
    injected: true,
    teammate_content: `old intro\n${TEAMMATE_MARKER}`,
    read_version: 1,
    teammate_version: 2,
  };
  const recovered = analyze(run, context, {
    injector: { state },
    head: { file: { version: 3 }, content: `new intro\n${TEAMMATE_MARKER}` },
  });
  assert.equal(recovered.conflict.outcome, "recovered");
  assert.equal(recovered.conflict.reread_after_conflict, true);
  assert.equal(recovered.conflict.retry_count, 1);
  assert.equal(recovered.conflict.retry_ok, true);
  const clobbered = analyze(run, context, {
    injector: { state },
    head: { file: { version: 3 }, content: "new intro" },
  });
  assert.equal(clobbered.conflict.outcome, "clobbered");
});
