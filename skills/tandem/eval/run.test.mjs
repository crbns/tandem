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
