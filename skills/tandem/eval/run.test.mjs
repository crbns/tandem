import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, rates, renderLoopTable, summarizeLoop } from "./run.mjs";

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

const call = (id, tool, input) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id, name: `mcp__tandem__${tool}`, input }],
  },
});
const seed = {
  folder_ids: { "/specs": "fold_specs", "/meeting-notes": "fold_notes" },
  file_ids: { "/specs/api-spec.md": "file_spec" },
};
const folderTrial = (folders, events) =>
  analyze(
    {
      stdout: [init, ...events, final].map((e) => JSON.stringify(e)).join("\n"),
      stderr: "",
      code: 0,
      timedOut: false,
    },
    {
      ...context,
      prompt: { id: "f", kind: "project", folders },
      folderSeed: seed,
    },
  ).folders;
const inNotes = { expect: "create_in", folder: "/meeting-notes" };

test("folder grader: a create into the expected folder passes, by returned path or argument", () => {
  const byResult = folderTrial(inNotes, [
    call("ls", "list_files", {}),
    toolResult("ls"),
    call("mk", "create_document", {
      name: "s.md",
      content: "x",
      folder_path: "meeting-notes/",
    }),
    toolResult(
      "mk",
      false,
      JSON.stringify({ id: "f1", path: "/Meeting-Notes/s.md" }),
    ),
  ]);
  assert.equal(byResult.outcome, "in_folder");
  assert.equal(byResult.passed, true);
  assert.equal(byResult.looked_first, true);
  assert.equal(byResult.used_folder_path, true);
  const byParentId = folderTrial(inNotes, [
    call("mk", "create_document", {
      name: "s.md",
      content: "x",
      parent_id: "fold_notes",
    }),
    toolResult("mk", false, "created"),
  ]);
  assert.equal(byParentId.outcome, "in_folder");
  assert.equal(byParentId.used_parent_id, true);
  assert.equal(byParentId.looked_first, false);
});

test("folder grader: root, other folder, failed and missing creates fail", () => {
  const root = folderTrial(inNotes, [
    call("mk", "create_document", { name: "s.md", content: "x" }),
    toolResult("mk", false, "created"),
  ]);
  assert.equal(root.outcome, "root");
  assert.equal(root.passed, false);
  const other = folderTrial(inNotes, [
    call("dir", "create_folder", { path: "/meetings" }),
    toolResult("dir"),
    call("mk", "create_document", {
      name: "s.md",
      content: "x",
      folder_path: "/meetings",
    }),
    toolResult("mk", false, "created"),
  ]);
  assert.equal(other.outcome, "other_folder:/meetings");
  assert.deepEqual(other.create_folder_paths, ["/meetings"]);
  const failed = folderTrial(inNotes, [
    call("mk", "create_document", {
      name: "s.md",
      content: "x",
      folder_path: "/meeting-notes",
    }),
    toolResult("mk", true, "NAME_EXISTS: taken"),
  ]);
  assert.equal(failed.outcome, "create_failed");
  assert.equal(folderTrial(inNotes, []).outcome, "no_create");
});

test("folder grader: create_folder then create_document into a new folder passes", () => {
  const r = folderTrial(
    { expect: "create_in", folder: "/retros", new_folder: true },
    [
      call("dir", "create_folder", { path: "/retros" }),
      toolResult("dir"),
      call("mk", "create_document", {
        name: "r.md",
        content: "x",
        folder_path: "/retros",
      }),
      toolResult(
        "mk",
        false,
        JSON.stringify({ id: "f2", path: "/retros/r.md" }),
      ),
    ],
  );
  assert.equal(r.outcome, "in_folder");
  assert.deepEqual(r.create_folder_paths, ["/retros"]);
});

test("folder grader: read by path or id needs the marker in the answer", async () => {
  const { FOLDER_SEED } = await import("./fixtures.mjs");
  const spec = FOLDER_SEED.files.find((f) => f.name === "api-spec.md");
  const readSpec = { expect: "read", path: "/specs/api-spec.md" };
  const answer = (text) => ({ ...final, result: text });
  const run = (events, text) =>
    analyze(
      {
        stdout: [init, ...events, answer(text)]
          .map((e) => JSON.stringify(e))
          .join("\n"),
        stderr: "",
        code: 0,
        timedOut: false,
      },
      {
        ...context,
        prompt: { id: "r", kind: "project", folders: readSpec },
        folderSeed: seed,
      },
    ).folders;
  const byPath = run(
    [call("rd", "read_file", { path: "/specs/api-spec.md" }), toolResult("rd")],
    `Clients get ${spec.marker}.`,
  );
  assert.equal(byPath.outcome, "read_by_path");
  assert.equal(byPath.passed, true);
  const byId = run(
    [call("rd", "read_file", { file_id: "file_spec" }), toolResult("rd")],
    "No idea.",
  );
  assert.equal(byId.outcome, "read_by_id");
  assert.deepEqual(byId.read_paths, ["/specs/api-spec.md"]);
  assert.equal(byId.passed, false);
  const errored = run(
    [
      call("rd", "read_file", { path: "/specs/api-spec.md" }),
      toolResult("rd", true, "PATH_NOT_FOUND"),
    ],
    spec.marker,
  );
  assert.equal(errored.outcome, "read_other");
  assert.equal(errored.passed, false);
  assert.equal(run([], spec.marker).outcome, "not_read");
});

test("folder prompts target the seeded tree", async () => {
  const { readFileSync } = await import("node:fs");
  const { FOLDER_SEED } = await import("./fixtures.mjs");
  const { prompts } = JSON.parse(
    readFileSync(new URL("./prompts.json", import.meta.url), "utf8"),
  );
  assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length);
  const files = FOLDER_SEED.files.map((f) => `${f.folder_path}/${f.name}`);
  const folderPrompts = prompts.filter((p) => p.folders);
  assert.ok(folderPrompts.some((p) => p.folders.expect === "create_in"));
  assert.ok(folderPrompts.some((p) => p.folders.expect === "read"));
  for (const p of folderPrompts) {
    if (p.folders.expect === "read") {
      assert.ok(files.includes(p.folders.path), p.id);
      assert.ok(
        FOLDER_SEED.files.find(
          (f) => `${f.folder_path}/${f.name}` === p.folders.path,
        ).marker,
        p.id,
      );
    } else {
      assert.equal(p.folders.expect, "create_in", p.id);
      assert.equal(
        FOLDER_SEED.folders.includes(p.folders.folder),
        !p.folders.new_folder,
        p.id,
      );
    }
  }
  for (const f of FOLDER_SEED.files) {
    assert.ok(FOLDER_SEED.folders.includes(f.folder_path), f.name);
    if (f.marker) assert.ok(f.content.includes(f.marker), f.name);
  }
});

const edit = {
  require: ["sync", "read", "save"],
  forbid: ["publish", "propose"],
};
const loopTrial = (loop, events) =>
  analyze(
    {
      stdout: [init, ...events, final].map((e) => JSON.stringify(e)).join("\n"),
      stderr: "",
      code: 0,
      timedOut: false,
    },
    { ...context, prompt: { id: "l", kind: "project", loop } },
  );

test("loop grader: sync, read and save with no publish or propose passes an edit", () => {
  const t = loopTrial(edit, [
    toolUse("s", "sync_workspace"),
    toolResult("s"),
    toolUse("r", "read_file"),
    toolResult("r"),
    // A conflict then a successful retry still counts as a save.
    toolUse("u1", "update_document"),
    toolResult("u1", true, "VERSION_CONFLICT"),
    toolUse("u2", "update_document"),
    toolResult("u2"),
  ]);
  assert.deepEqual(t.loop, {
    require: edit.require,
    forbid: edit.forbid,
    missing: [],
    unwanted: [],
    passed: true,
    write_calls: 2,
    publish_calls: 0,
    propose_calls: 0,
  });
});

test("loop grader: an unprompted publish or propose fails an edit, even when it errors", () => {
  const t = loopTrial(edit, [
    toolUse("s", "sync_workspace"),
    toolResult("s"),
    toolUse("r", "search_files"),
    toolResult("r"),
    toolUse("c", "create_document"),
    toolResult("c"),
    toolUse("p", "publish_work"),
    toolResult("p"),
    toolUse("q", "propose_context_change"),
    toolResult("q", true, "INVALID_INPUT"),
  ]).loop;
  assert.equal(t.passed, false);
  assert.deepEqual(t.missing, []);
  assert.deepEqual(t.unwanted, ["publish", "propose"]);
  assert.equal(t.write_calls, 3);
});

test("loop grader: a failed save or a missing sync is missing; a directed proposal passes", () => {
  const failed = loopTrial(edit, [
    toolUse("r", "read_file"),
    toolResult("r"),
    toolUse("u", "update_document"),
    toolResult("u", true, "VERSION_CONFLICT"),
  ]).loop;
  assert.deepEqual(failed.missing, ["sync", "save"]);
  assert.equal(failed.passed, false);
  const directed = loopTrial(
    { require: ["sync", "propose"], forbid: ["publish"] },
    [
      toolUse("s", "sync_workspace"),
      toolResult("s"),
      toolUse("q", "propose_context_change"),
      toolResult("q"),
    ],
  ).loop;
  assert.equal(directed.passed, true);
  assert.throws(
    () => loopTrial({ require: ["dance"], forbid: [] }, []),
    /Unknown loop step dance/,
  );
});

test("loop summary tallies trials per step and sums calls", () => {
  const pass = loopTrial(edit, [
    toolUse("s", "sync_workspace"),
    toolResult("s"),
    toolUse("r", "read_file"),
    toolResult("r"),
    toolUse("u", "update_document"),
    toolResult("u"),
  ]);
  const fail = loopTrial(edit, [
    toolUse("s", "sync_workspace"),
    toolResult("s"),
    toolUse("p", "publish_work"),
    toolResult("p"),
  ]);
  const rows = summarizeLoop(
    [pass, fail].map((t) => ({ ...t, prompt_id: "l" })),
    [{ id: "l", loop: edit }, { id: "x" }],
    ["WITH_SKILL", "NO_SKILL"],
  );
  assert.deepEqual(rows, [
    {
      prompt_id: "l",
      condition: "WITH_SKILL",
      n: 2,
      passed: 1,
      missing: { read: 1, save: 1 },
      unwanted: { publish: 1 },
      write_calls: 2,
      publish_calls: 1,
      propose_calls: 0,
    },
  ]);
  assert.match(
    renderLoopTable(rows),
    /\| `l` \| WITH_SKILL \| 2 \| 1\/2 \| read 1, save 1 \| publish 1 \| 2 \| 1 \| 0 \|/,
  );
});

test("loop prompts: ordinary edits and drafts need a save and forbid publish and propose", async () => {
  const { readFileSync } = await import("node:fs");
  const { prompts } = JSON.parse(
    readFileSync(new URL("./prompts.json", import.meta.url), "utf8"),
  );
  for (const p of prompts.filter((x) => x.kind !== "control"))
    assert.ok(p.loop, `${p.id} has a loop spec`);
  for (const id of [
    "p1-launch-brief",
    "p3-status-update",
    "p6-conflict-edit",
    "p7-create-document",
    "p8-folder-existing",
    "p9-folder-new",
  ]) {
    const { loop } = prompts.find((p) => p.id === id);
    assert.ok(loop.require.includes("save"), id);
    assert.deepEqual(
      loop.forbid.filter((s) => s !== "save"),
      ["publish", "propose"],
      id,
    );
  }
  // p5 has no spec to edit in the bare env, so it forbids the same writes
  // without requiring a save.
  assert.deepEqual(
    prompts.find((p) => p.id === "p5-tighten-intro").loop.forbid,
    ["publish", "propose"],
  );
  // Only a request that directs a context change expects a proposal.
  assert.deepEqual(
    prompts.filter((p) => p.loop?.require.includes("propose")).map((p) => p.id),
    ["p4-cut-mobile"],
  );
});
