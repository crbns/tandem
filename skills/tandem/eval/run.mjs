#!/usr/bin/env node
// Measures whether the Tandem skill makes Claude Code reach for the Tandem MCP
// tools on its own, in fresh headless chats that never mention Tandem.
//
//   node skills/tandem/eval/run.mjs --model sonnet --reps 2
//
// Each trial gets a fresh mock MCP server (no state leaks between trials) and
// a fresh temp project dir. WITH_SKILL copies only SKILL.md into
// <project>/.claude/skills/tandem (README/COMPATIBILITY hold the prompts and
// expected answers); NO_SKILL is the same without it. Only the Tandem MCP
// tools, Skill, ToolSearch and read-only built-ins are permitted; Bash/Edit/
// Write, web, agent and scheduling tools are denied. No npm dependencies.
//
// --env bare (default) is the setup above: an empty project and Tandem as the
// only MCP server. --env realistic adds competing sources of truth: a small,
// out-of-date local project tree (fixtures.mjs) readable with Read/Glob/Grep
// scoped to the project, plus two distractor MCP servers (stub-mcp.mjs).
//
// Prompts marked "conflict": true get a teammate injector: right after the
// agent's first successful read_file of file_brief, the harness saves a
// teammate edit as user_sam over its own JSON-RPC call, so the agent's next
// update_document with the old version hits VERSION_CONFLICT. The final head
// is read back at trial end to tell recovery from clobbering.
//
// Prompts with "folders" get the fixtures FOLDER_SEED tree (folders and files
// saved as user_sam before the trial) and a folder grader: "create_in" checks
// where the new document landed, "read" checks the seeded file was read (by
// path or id) and its marker phrase is in the answer.
//
// Prompts with "loop" get a loop grader: every step in loop.require (sync,
// read, save, propose, ...) needs a successful call, and no step in
// loop.forbid may be attempted. An ordinary edit or draft requires sync + save
// and forbids publish_work and propose_context_change: Tandem's context
// manager records the work from the saved files.
//
// On SIGINT/SIGTERM (or any exit) the harness kills the live MCP servers and
// claude processes (each runs in its own process group) and removes in-flight
// temp dirs.

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOLDER_SEED,
  LOCAL_TREE,
  STALE_MARKERS,
  TANDEM_BRIEF,
  TANDEM_MARKERS,
  TEAMMATE_MARKER,
} from "./fixtures.mjs";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(EVAL_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps/mcp/dist/index.js");
const STUB_ENTRY = join(EVAL_DIR, "stub-mcp.mjs");
const DEV_TOKEN = "alex-dev-token";
// The teammate the injector acts as. The agent only ever holds DEV_TOKEN.
const SAM_TOKEN = "sam-dev-token";
const BRIEF_ID = "file_brief";
const ENVS = ["bare", "realistic"];
// Distractor MCP servers in realistic mode, and the tools each must list.
const DISTRACTORS = {
  notes: ["notes_search", "notes_read"],
  tracker: ["list_tickets", "get_ticket"],
};
// The user's live tunnel uses this port; never bind it.
const RESERVED_PORTS = new Set([8788]);
const LOCAL_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set([
  "create_document",
  "update_document",
  "create_folder",
  "move_file",
  "move_folder",
  "publish_work",
  "propose_context_change",
]);
// Loop grader steps: the Tandem tools that count for each.
const LOOP_STEPS = {
  sync: ["sync_workspace"],
  read: ["read_file", "search_files"],
  save: ["create_document", "update_document"],
  publish: ["publish_work"],
  propose: ["propose_context_change"],
};
const CONDITIONS = ["WITH_SKILL", "NO_SKILL"];
// Built-ins from the CLI's init tool list that the eval never needs. Names
// that don't exist in a given CLI version are ignored by --disallowedTools.
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TaskStop",
  "ListAgents",
  "SendMessage",
  "Workflow",
  "Monitor",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "EnterWorktree",
  "ExitWorktree",
  "DesignSync",
  "ReportFindings",
];
const USAGE = `Usage: node skills/tandem/eval/run.mjs [options]
  --mcp-url <url>       external Streamable HTTP endpoint (TANDEM_MCP_URL);
                        skips mock build/start; uses persistent server state
  --mcp-key <key>       Bearer API key (TANDEM_MCP_KEY); prefer env to argv
  --mcp-teammate-key <key> optional second actor (TANDEM_MCP_TEAMMATE_KEY)
  --brief-id <id>       external brief for conflict injection (TANDEM_BRIEF_ID);
                        conflict/realistic trials replace its content!
                        External runs require --concurrency 1 and a disposable workspace.
  --model <name>        Claude model alias or id (default: sonnet)
  --reps <n>            repetitions per prompt per condition (default: 2)
  --max-turns <n>       claude --max-turns (default: 6)
  --timeout <sec>       per-trial timeout (default: 180)
  --concurrency <n>     trials in parallel (default: 2)
  --env <bare|realistic> bare: empty project, Tandem is the only MCP server;
                        realistic: stale local files + notes/tracker MCP stubs
                        (default: bare)
  --port <n>            first port to try; each slot takes free ports from
                        here up, 1 (bare) or 3 (realistic), never 8788
                        (default: 8931)
  --prompts <ids>       comma-separated prompt ids to run (default: all)
  --conditions <list>   WITH_SKILL,NO_SKILL (default: both)
  --out <dir>           results dir (default: skills/tandem/eval/results)
  --tag <s>             suffix for result file names (default: none)
  --force               overwrite existing result files with the same name
  --no-build            skip building apps/mcp
  --keep                keep temp dirs and raw stream-json logs
  --rerender <json>     rewrite the .md next to an existing results .json
                        (no trials run)`;

// Live child processes and in-flight temp roots, cleaned up on abort/exit.
const live = { children: new Set(), roots: new Set() };
let opts;
let aborting = false;

// Importing analysis helpers must not launch trials or install CLI signal handlers.
if (
  process.argv[1] &&
  safeRealpath(resolve(process.argv[1])) ===
    safeRealpath(fileURLToPath(import.meta.url))
) {
  process.on("exit", () => {
    for (const c of live.children) killGroup(c, "SIGKILL");
    removeRoots();
  });
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(sig, () => abort(sig, code));
  }

  main().catch((err) => {
    if (aborting) return; // abort() cleans up and sets the exit code.
    if (err.usage) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.rerender) {
    const r = JSON.parse(readFileSync(opts.rerender, "utf8"));
    const md = opts.rerender.replace(/\.json$/, ".md");
    writeFileSync(md, renderMarkdown(r));
    console.log(`Wrote ${relative(REPO_ROOT, md)}`);
    return;
  }
  const promptFile = JSON.parse(
    readFileSync(join(EVAL_DIR, "prompts.json"), "utf8"),
  );
  let prompts = promptFile.prompts;
  if (opts.prompts) {
    const ids = new Set(opts.prompts.split(","));
    for (const id of ids) {
      if (!prompts.some((p) => p.id === id))
        throw usageError(
          `Unknown prompt id ${id} (have: ${prompts.map((p) => p.id).join(", ")})`,
        );
    }
    prompts = prompts.filter((p) => ids.has(p.id));
  }
  const conditions = opts.conditions ? opts.conditions.split(",") : CONDITIONS;
  for (const c of conditions) {
    if (!CONDITIONS.includes(c)) throw usageError(`Unknown condition ${c}`);
  }

  if (opts.mcp_url && prompts.some((p) => p.conflict) && !opts.brief_id)
    throw usageError(
      "External conflict trials require --brief-id (a disposable document)",
    );

  // Refuse up front, before spending anything, rather than overwrite results.
  const startedAt = new Date();
  const date = localDate(startedAt);
  const stem = `${date}-claude-code${opts.tag ? `-${opts.tag}` : ""}`;
  const jsonPath = join(opts.out, `${stem}.json`);
  const mdPath = join(opts.out, `${stem}.md`);
  for (const p of [jsonPath, mdPath]) {
    if (existsSync(p) && !opts.force)
      throw new Error(
        `${relative(REPO_ROOT, p)} exists; pass --tag <s> or --force`,
      );
  }

  if (opts.build && !opts.mcp_url) {
    console.log("Building apps/mcp ...");
    const b = spawnSync("pnpm", ["--filter", "mcp", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (b.status !== 0) throw new Error("apps/mcp build failed");
  }
  if (!opts.mcp_url && !existsSync(SERVER_ENTRY))
    throw new Error(`${SERVER_ENTRY} missing; build apps/mcp first`);

  const cliVersion = spawnSync("claude", ["--version"], {
    encoding: "utf8",
  }).stdout.trim();
  if (!cliVersion) throw new Error("`claude` CLI not found on PATH");

  // Deterministic order, interleaving conditions so drift over time hits both.
  const jobs = [];
  for (let rep = 1; rep <= opts.reps; rep++) {
    for (const prompt of prompts) {
      for (const condition of conditions) jobs.push({ prompt, condition, rep });
    }
  }

  // One slot per concurrent trial: { tandem, notes?, tracker? } ports.
  const perSlot = opts.env === "realistic" ? 3 : 1;
  const slots = [];
  for (let i = 0, p = opts.port; i < opts.concurrency; i++) {
    const got = [];
    for (; got.length < perSlot; p++) {
      if (!RESERVED_PORTS.has(p) && (await portFree(p))) got.push(p);
    }
    slots.push({ tandem: got[0], notes: got[1], tracker: got[2] });
  }

  console.log(
    `Claude Code ${cliVersion}, model ${opts.model}, env ${opts.env}, ${jobs.length} trials, concurrency ${opts.concurrency}, ports ${slots.map((s) => Object.values(s).filter(Boolean).join("/")).join(",")}`,
  );

  const trials = [];
  let next = 0;
  let fatal = null;
  await Promise.all(
    slots.map(async (slot) => {
      while (next < jobs.length && !fatal && !aborting) {
        const job = jobs[next++];
        try {
          const t = await runTrial(job, slot);
          trials.push(t);
          const label = `[${trials.length}/${jobs.length}] ${job.prompt.id} ${job.condition} rep${job.rep}`;
          const extra = [
            opts.env === "realistic" &&
              `local=${t.local_file_calls} distractor=${t.distractor_calls} stale=${t.answered_from_stale_local}`,
            t.conflict && `conflict=${t.conflict.outcome}`,
            t.folders && `folders=${t.folders.outcome}`,
          ]
            .filter(Boolean)
            .join(" ");
          console.log(
            `${label}: tools=${t.tools.join(" > ") || "(none)"} | sync=${t.sync_called} write=${t.write_called}${extra ? ` ${extra}` : ""}${t.timed_out ? " TIMEOUT" : ""}${t.error ? ` ERROR=${t.error}` : ""}`,
          );
        } catch (err) {
          fatal = err;
        }
      }
    }),
  );
  if (fatal) throw fatal;

  trials.sort(
    (a, b) =>
      prompts.findIndex((p) => p.id === a.prompt_id) -
        prompts.findIndex((p) => p.id === b.prompt_id) ||
      conditions.indexOf(a.condition) - conditions.indexOf(b.condition) ||
      a.rep - b.rep,
  );

  const summary = summarize(trials, prompts, conditions);
  const conflictSummary = summarizeConflict(trials, prompts, conditions);
  const folderSummary = summarizeFolders(trials, prompts, conditions);
  const loopSummary = summarizeLoop(trials, prompts, conditions);
  const isolation = summarizeIsolation(trials);
  const results = redactSecrets(
    {
      date,
      stem,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      client: "claude-code",
      cli_version: cliVersion,
      model_requested: opts.model,
      models_reported: [...new Set(trials.map((t) => t.model).filter(Boolean))],
      settings: {
        env: opts.env,
        reps: opts.reps,
        max_turns: opts.max_turns,
        timeout_sec: opts.timeout,
        concurrency: opts.concurrency,
        conditions,
        claude_flags: claudeFlags("<mcp-config>", opts).filter(
          (f) => !f.startsWith("<"),
        ),
        server: opts.mcp_url
          ? `External Convex-backed endpoint ${opts.mcp_url}, Bearer API key; persistent state, serial trials`
          : "apps/mcp mock backend, fresh process per trial, api-key auth as user_alex",
        ...(opts.mcp_url && {
          mcp_url: opts.mcp_url,
          brief_id: opts.brief_id,
          teammate_actor: opts.mcp_teammate_key
            ? "separate API key"
            : "same API key as agent",
        }),
        brief_seed: opts.mcp_url
          ? "External seed retained except conflict trials, which replace the supplied brief with fixtures TANDEM_BRIEF before injecting an edit"
          : opts.env === "realistic"
            ? "brief.md saved as v2 (fixtures TANDEM_BRIEF) by user_sam before every trial"
            : "brief.md saved as v2 (fixtures TANDEM_BRIEF) by user_sam before conflict trials only; other trials use the server's v1 seed",
        ...(opts.env === "realistic" && {
          local_tree: Object.keys(LOCAL_TREE),
          distractor_servers: DISTRACTORS,
          stale_markers: STALE_MARKERS,
          tandem_markers: TANDEM_MARKERS,
        }),
        ...(prompts.some((p) => p.conflict) && {
          teammate_marker: TEAMMATE_MARKER,
        }),
        ...(prompts.some((p) => p.folders) && {
          folder_seed: {
            folders: FOLDER_SEED.folders,
            files: FOLDER_SEED.files.map((f) => `${f.folder_path}/${f.name}`),
            saved_by: opts.mcp_url ? "teammate key" : "user_sam",
          },
        }),
      },
      prompts,
      isolation,
      summary,
      conflict_summary: conflictSummary,
      folder_summary: folderSummary,
      loop_summary: loopSummary,
      trials,
    },
    [opts.mcp_key, opts.mcp_teammate_key],
  );

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(results, null, 2) + "\n");
  writeFileSync(mdPath, renderMarkdown(results));
  console.log(
    `\nWrote ${relative(REPO_ROOT, jsonPath)} and ${relative(REPO_ROOT, mdPath)}`,
  );
  console.log("\n" + renderSummaryTable(summary, opts.env, trials));
  if (conflictSummary.length)
    console.log("\n" + renderConflictTable(conflictSummary, trials));
  if (folderSummary.length)
    console.log("\n" + renderFolderTable(folderSummary));
  if (loopSummary.length) console.log("\n" + renderLoopTable(loopSummary));
}

async function runTrial({ prompt, condition, rep }, slot) {
  const realistic = opts.env === "realistic";
  const root = mkdtempSync(join(tmpdir(), "tandem-eval-"));
  live.roots.add(root);
  const project = join(root, "project");
  mkdirSync(project);
  // The CLI reports realpaths (/private/var/... on macOS); analyze() rewrites
  // both forms to <project>/... so results carry no machine paths.
  const projectPaths = [...new Set([realpathSync(project), project])];
  if (realistic) {
    for (const [rel, text] of Object.entries(LOCAL_TREE)) {
      mkdirSync(dirname(join(project, rel)), { recursive: true });
      writeFileSync(join(project, rel), text);
    }
  }
  if (condition === "WITH_SKILL") {
    const dest = join(project, ".claude/skills/tandem");
    mkdirSync(dest, { recursive: true });
    copyFileSync(join(SKILL_DIR, "SKILL.md"), join(dest, "SKILL.md"));
  }
  // Config lives outside the project dir so the model can't stumble on it.
  const mcpServers = {
    tandem: mcpConnection(opts, slot.tandem),
  };
  if (realistic) {
    for (const kind of Object.keys(DISTRACTORS))
      mcpServers[kind] = {
        type: "http",
        url: `http://127.0.0.1:${slot[kind]}/mcp`,
      };
  }
  const mcpConfig = join(root, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers }), { mode: 0o600 });

  const servers = [];
  let run;
  let injector = null;
  let head = null;
  let seedError = null;
  let folderSeed = null;
  const started = Date.now();
  try {
    if (!opts.mcp_url) servers.push(await startServer(slot.tandem));
    if (realistic) {
      for (const kind of Object.keys(DISTRACTORS))
        servers.push(await startStub(kind, slot[kind]));
    }
    if (realistic || prompt.conflict) {
      try {
        await seedBrief(slot.tandem);
      } catch (err) {
        seedError = `brief seed failed: ${err.message}`;
      }
    }
    if (prompt.folders && !seedError) {
      try {
        folderSeed = await seedFolders(slot.tandem);
      } catch (err) {
        seedError = `folder seed failed: ${err.message}`;
      }
    }
    if (prompt.conflict && !seedError) injector = conflictInjector(slot.tandem);
    run = await runClaude(prompt.text, project, mcpConfig, injector?.onEvent);
    if (injector) {
      await injector.settled();
      try {
        head = await rpc(slot.tandem, opts.mcp_key ?? DEV_TOKEN, "read_file", {
          file_id: opts?.brief_id ?? BRIEF_ID,
        });
      } catch (err) {
        head = { error: err.message };
      }
    }
  } finally {
    for (const s of servers) await stopChild(s);
    if (!run || !opts.keep) {
      cleanEmptyProjectMemory(project);
      rmSync(root, { recursive: true, force: true });
    }
    live.roots.delete(root);
  }
  if (aborting) throw new Error("aborted");

  const trial = analyze(
    run,
    { prompt, condition, rep, projectPaths, folderSeed },
    prompt.conflict ? { injector, head } : null,
  );
  if (seedError) trial.error = trial.error ?? seedError;
  trial.duration_ms = Date.now() - started;

  if (opts.keep) {
    cleanEmptyProjectMemory(project);
    writeFileSync(join(root, "stream.jsonl"), run.stdout);
    writeFileSync(join(root, "stderr.txt"), run.stderr);
    trial.kept_dir = root;
  }

  if (trial.auth_error) {
    throw new Error(`claude -p auth/permission failure: ${trial.auth_error}`);
  }
  return trial;
}

function claudeFlags(mcpConfig, o) {
  // Realistic mode scopes reads to the project dir: Read rules also govern
  // Glob and Grep, and reads outside it are denied in dontAsk mode.
  const allowed =
    o.env === "realistic"
      ? [
          "mcp__tandem__*",
          ...Object.keys(DISTRACTORS).map((k) => `mcp__${k}__*`),
          "Skill",
          "ToolSearch",
          "Read(./**)",
        ]
      : ["mcp__tandem__*", "Skill", "ToolSearch", "Read", "Glob", "Grep"];
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--model",
    o.model,
    "--max-turns",
    String(o.max_turns),
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...allowed,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];
}

// onEvent, if given, sees each stream-json event as it arrives.
function runClaude(promptText, cwd, mcpConfig, onEvent) {
  return new Promise((resolvePromise) => {
    const child = track(
      spawn("claude", ["-p", promptText, ...claudeFlags(mcpConfig, opts)], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      }),
    );
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!onEvent) return;
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // Non-JSON noise.
        }
        onEvent(event);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
    }, opts.timeout * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, timedOut });
    });
  });
}

export function analyze(
  run,
  { prompt, condition, rep, projectPaths = [], folderSeed = null },
  conflictCtx,
) {
  const events = [];
  for (const line of run.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON noise.
    }
  }
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.find((e) => e.type === "result");

  // Only the main conversation counts; subagent turns carry parent_tool_use_id.
  const calls = [];
  const byId = new Map();
  let subagentCalls = 0;
  for (const e of events) {
    if (e.parent_tool_use_id) {
      if (e.type === "assistant")
        subagentCalls += (e.message?.content ?? []).filter(
          (b) => b.type === "tool_use",
        ).length;
      continue;
    }
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        const call = { name: b.name, input: b.input, ok: false, error: null };
        calls.push(call);
        byId.set(b.id, call);
      }
    } else if (e.type === "user") {
      const content = e.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "tool_result" && byId.has(b.tool_use_id)) {
          const call = byId.get(b.tool_use_id);
          call.ok = !b.is_error;
          if (b.is_error)
            call.error = textOf(b.content).slice(0, 300) || "tool result error";
          // Kept in memory for the folder grader; never persisted.
          else call.result = textOf(b.content);
        }
      }
    }
  }

  const display = (c) =>
    c.name === "Skill" ? `Skill:${c.input?.skill ?? "?"}` : c.name;
  const tandemCalls = calls.filter((c) => c.name.startsWith("mcp__tandem__"));
  const tandemNames = tandemCalls.map((c) =>
    c.name.slice("mcp__tandem__".length),
  );
  const writes = tandemCalls.filter((c) =>
    WRITE_TOOLS.has(c.name.slice("mcp__tandem__".length)),
  );

  const resultText = typeof result?.result === "string" ? result.result : "";
  const localCalls = calls.filter((c) => LOCAL_TOOLS.has(c.name));
  const projectRel = (p) => {
    if (typeof p !== "string") return p;
    const base = projectPaths.find((b) => p === b || p.startsWith(`${b}/`));
    return base ? `<project>${p.slice(base.length)}` : p;
  };
  // Read: file_path. Glob/Grep: pattern plus the optional search root, so an
  // out-of-project search shows up in the JSON.
  const localTarget = (c) =>
    [
      projectRel(c.input?.file_path ?? c.input?.pattern ?? ""),
      c.input?.path !== undefined && `in ${projectRel(c.input.path)}`,
    ]
      .filter(Boolean)
      .join(" ");
  const distractorCalls = calls.filter((c) =>
    Object.keys(DISTRACTORS).some((k) => c.name.startsWith(`mcp__${k}__`)),
  );
  const mentions = (markers) =>
    markers.some((m) => resultText.toLowerCase().includes(m.toLowerCase()));
  const tandemMarker = mentions(TANDEM_MARKERS);
  const staleLocal = mentions(STALE_MARKERS.local);
  const staleDistractor = mentions(STALE_MARKERS.distractor);
  // Abort the whole run only for a CLI/account auth failure: the CLI exited
  // non-zero on its own (not our timeout) with a login/API-key message. A
  // successful run whose answer mentions "authentication" doesn't count.
  const failText = `${resultText}\n${run.stderr}`;
  const authError =
    run.code !== 0 &&
    !run.timedOut &&
    (!init || result?.is_error) &&
    /not logged in|run \/login|invalid api key|authentication_error|oauth token (?:has )?expired/i.test(
      failText,
    )
      ? failText.trim().slice(0, 500)
      : null;

  return {
    prompt_id: prompt.id,
    kind: prompt.kind,
    condition,
    rep,
    model: init?.model ?? null,
    exit_code: run.code,
    timed_out: run.timedOut,
    error: !init
      ? `no init event: ${run.stderr.trim().slice(0, 300)}`
      : !result
        ? "no final result event"
        : run.code !== 0
          ? `claude exited with code ${run.code}`
          : result.is_error
            ? result.subtype || "final result error"
            : null,
    auth_error: authError,
    tools: calls.map(display),
    tandem_tools: tandemNames,
    tandem_called: tandemCalls.length > 0,
    sync_called: tandemNames.includes("sync_workspace"),
    sync_ok: tandemCalls.some(
      (c) => c.name === "mcp__tandem__sync_workspace" && c.ok,
    ),
    first_tandem_is_sync: tandemNames[0] === "sync_workspace",
    skill_invoked: calls.some(
      (c) => c.name === "Skill" && c.input?.skill === "tandem",
    ),
    write_called: writes.length > 0,
    write_ok: writes.some((c) => c.ok),
    write_tools: writes.map((c) => ({
      tool: c.name.slice("mcp__tandem__".length),
      ok: c.ok,
      error: c.error,
    })),
    tandem_errors: tandemCalls
      .filter((c) => c.error)
      .map((c) => ({
        tool: c.name.slice("mcp__tandem__".length),
        error: c.error,
      })),
    permission_denials: (result?.permission_denials ?? []).map(
      (d) => d.tool_name ?? d,
    ),
    subagent_tool_calls: subagentCalls,
    local_file_calls: localCalls.length,
    local_file_targets: localCalls.map(
      (c) => `${c.name}:${localTarget(c)}${c.error ? " (error)" : ""}`,
    ),
    used_local_files: localCalls.length > 0,
    distractor_calls: distractorCalls.length,
    distractor_tools: distractorCalls.map((c) => c.name),
    used_distractor_mcp: distractorCalls.length > 0,
    answer_has_tandem_marker: tandemMarker,
    answer_has_stale_local_marker: staleLocal,
    answer_has_stale_distractor_marker: staleDistractor,
    answered_from_stale_local: staleLocal && !tandemMarker,
    answered_from_stale_distractor: staleDistractor && !tandemMarker,
    ...(prompt.loop && { loop: analyzeLoop(tandemCalls, prompt.loop) }),
    ...(prompt.folders && {
      folders: analyzeFolders(
        tandemCalls,
        resultText,
        prompt.folders,
        folderSeed,
      ),
    }),
    ...(conflictCtx && {
      conflict: analyzeConflict(
        calls,
        resultText,
        conflictCtx.injector,
        conflictCtx.head,
      ),
    }),
    num_turns: result?.num_turns ?? null,
    cost_usd: result?.total_cost_usd ?? null,
    result_text: resultText.slice(0, 4000),
    init: init
      ? {
          mcp_servers: (init.mcp_servers ?? []).map(
            (s) => `${s.name}:${s.status}`,
          ),
          non_tandem_mcp_tools: (init.tools ?? []).filter(
            (t) => t.startsWith("mcp__") && !t.startsWith("mcp__tandem__"),
          ),
          builtin_tools: (init.tools ?? []).filter(
            (t) => !t.startsWith("mcp__"),
          ),
          tandem_tool_count: (init.tools ?? []).filter((t) =>
            t.startsWith("mcp__tandem__"),
          ).length,
          skills: init.skills ?? [],
          plugins: (init.plugins ?? []).map((p) => p.source ?? p.name),
          permission_mode: init.permissionMode,
        }
      : null,
  };
}

// Grades the loop: `missing` lists required steps with no successful call,
// `unwanted` forbidden steps that were attempted (even if they failed).
export function analyzeLoop(calls, spec) {
  const require = spec.require ?? [];
  const forbid = spec.forbid ?? [];
  for (const step of [...require, ...forbid])
    if (!LOOP_STEPS[step]) throw new Error(`Unknown loop step ${step}`);
  const tool = (c) => c.name.slice("mcp__tandem__".length);
  const of = (step) => calls.filter((c) => LOOP_STEPS[step].includes(tool(c)));
  const missing = require.filter((step) => !of(step).some((c) => c.ok));
  const unwanted = forbid.filter((step) => of(step).length > 0);
  return {
    require,
    forbid,
    missing,
    unwanted,
    passed: missing.length === 0 && unwanted.length === 0,
    write_calls: calls.filter((c) => WRITE_TOOLS.has(tool(c))).length,
    publish_calls: of("publish").length,
    propose_calls: of("propose").length,
  };
}

// Paths compare case-insensitively with surrounding and repeated "/" ignored,
// close enough to the server's nameKey for the fixture names.
const normPath = (p) =>
  typeof p === "string"
    ? `/${p.split("/").filter(Boolean).join("/")}`.toLowerCase()
    : null;
const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// `calls` are the main conversation's Tandem calls in order. `seed` is
// seedFolders()'s { folder_ids, file_ids } (path -> id), or null if unseeded.
export function analyzeFolders(calls, resultText, spec, seed) {
  const tool = (c) => c.name.slice("mcp__tandem__".length);
  const pathById = new Map(
    Object.entries({ ...seed?.folder_ids, ...seed?.file_ids }).map(
      ([path, id]) => [id, path],
    ),
  );
  if (spec.expect === "read") {
    const target = normPath(spec.path);
    const reads = calls.filter((c) => tool(c) === "read_file");
    const byPath = reads.filter((c) => normPath(c.input?.path) === target);
    const byId = reads.filter(
      (c) => normPath(pathById.get(c.input?.file_id)) === target,
    );
    const marker = FOLDER_SEED.files.find(
      (f) => normPath(`${f.folder_path}/${f.name}`) === target,
    )?.marker;
    const answerHasMarker = Boolean(
      marker && resultText.toLowerCase().includes(marker.toLowerCase()),
    );
    const readOk = [...byPath, ...byId].some((c) => c.ok);
    return {
      expect: "read",
      path: spec.path,
      outcome: byPath.some((c) => c.ok)
        ? "read_by_path"
        : byId.some((c) => c.ok)
          ? "read_by_id"
          : reads.length
            ? "read_other"
            : "not_read",
      read_paths: reads.map(
        (c) =>
          c.input?.path ?? pathById.get(c.input?.file_id) ?? c.input?.file_id,
      ),
      answer_has_marker: answerHasMarker,
      passed: readOk && answerHasMarker,
    };
  }

  const target = normPath(spec.folder);
  const creates = calls.filter((c) => tool(c) === "create_document");
  const firstCreate = calls.indexOf(creates[0]);
  // Where each successful create landed: the returned path when the
  // result parses, else the folder argument it was given.
  const landed = creates
    .filter((c) => c.ok)
    .map((c) => {
      // create_document returns the file metadata itself.
      const path = jsonOf(c.result)?.path;
      if (typeof path === "string") return parentOf(normPath(path));
      if (c.input?.folder_path !== undefined)
        return normPath(c.input.folder_path);
      if (c.input?.parent_id !== undefined)
        return normPath(pathById.get(c.input.parent_id)) ?? "(unknown folder)";
      return "/";
    });
  const folderCalls = calls.filter((c) => tool(c) === "create_folder");
  return {
    expect: "create_in",
    folder: spec.folder,
    outcome: landed.includes(target)
      ? "in_folder"
      : landed.includes("/")
        ? "root"
        : landed.length
          ? `other_folder:${landed[0]}`
          : creates.length
            ? "create_failed"
            : "no_create",
    landed_in: landed,
    looked_first:
      firstCreate >= 0 &&
      calls
        .slice(0, firstCreate)
        .some((c) =>
          ["list_files", "search_files", "sync_workspace"].includes(tool(c)),
        ),
    used_folder_path: creates.some((c) => c.input?.folder_path !== undefined),
    used_parent_id: creates.some((c) => c.input?.parent_id !== undefined),
    create_folder_paths: folderCalls.map((c) => c.input?.path ?? null),
    passed: landed.includes(target),
  };
}

// A question in the final answer about the conflict or the teammate's edit.
const MERGE_QUESTION =
  /conflict|merge|teammate|\bsam\b|overwrit|their (edit|change)|which version|both (change|edit|version)|newer version|keep (the|their|sam|both)/i;

function analyzeConflict(calls, resultText, injector, head) {
  const st = injector?.state ?? { injected: false, skipped: "seed_failed" };
  const name = (c) => c.name.replace(/^mcp__tandem__/, "");
  const updates = calls.filter((c) => name(c) === "update_document");
  const idx = calls.findIndex(
    (c) =>
      name(c) === "update_document" && /VERSION_CONFLICT/.test(c.error ?? ""),
  );
  const after = idx >= 0 ? calls.slice(idx + 1) : [];
  const retries = after.filter((c) => name(c) === "update_document");
  const headContent = typeof head?.content === "string" ? head.content : null;
  const markerKept =
    headContent !== null && headContent.includes(TEAMMATE_MARKER);
  const recovered =
    st.injected && markerKept && headContent !== st.teammate_content;
  const clobbered = st.injected && headContent !== null && !markerKept;
  const questions = (resultText.match(/[^.!?\n]*\?/g) ?? [])
    .map((q) => q.trim())
    .filter(Boolean);
  const mergeQuestions = questions.filter((q) => MERGE_QUESTION.test(q));
  const askedUser = mergeQuestions.length > 0;

  let outcome;
  if (!st.injected) outcome = `no_inject:${st.skipped ?? "never_read"}`;
  else if (clobbered) outcome = "clobbered";
  else if (recovered)
    outcome = idx >= 0 ? "recovered" : "landed_without_conflict";
  else if (idx >= 0)
    outcome = askedUser ? "conflict_asked_user" : "conflict_unresolved";
  else if (!updates.length) outcome = askedUser ? "no_write_asked" : "no_write";
  else outcome = "other";

  return {
    outcome,
    injected: st.injected,
    inject_skipped: st.injected ? null : (st.skipped ?? "never_read"),
    inject_error: st.error ?? null,
    inject_latency_ms: st.latency_ms ?? null,
    injected_before_next_call: st.injected_before_next_call ?? null,
    read_version: st.read_version ?? null,
    teammate_version: st.teammate_version ?? null,
    update_calls: updates.length,
    conflict_hit: idx >= 0,
    reread_after_conflict: after.some((c) => name(c) === "read_file"),
    retry_count: retries.length,
    retry_ok: retries.some((c) => !c.error),
    looped: retries.length > 1,
    recovered,
    clobbered,
    asked_user: askedUser,
    merge_questions: mergeQuestions.slice(0, 3),
    head_version: head?.file?.version ?? null,
    head_updated_by: head?.file?.updated_by?.user_id ?? null,
    head_has_marker: markerKept,
    head_error: head?.error ?? null,
  };
}

// Watches the stream for the agent's first successful read_file of the brief
// and immediately saves a teammate edit on top of the version it read.
function conflictInjector(port) {
  const state = {
    injected: false,
    skipped: null,
    error: null,
    latency_ms: null,
    read_version: null,
    teammate_version: null,
    teammate_content: null,
    injected_before_next_call: null,
  };
  const reads = new Set();
  let wroteFirst = false;
  let fired = false;
  let task = Promise.resolve();

  async function inject(text, t0) {
    try {
      const read = JSON.parse(text);
      const version = read?.file?.version;
      if (!Number.isInteger(version) || typeof read?.content !== "string")
        throw new Error(`unparseable read_file result: ${text.slice(0, 120)}`);
      state.read_version = version;
      const content = `${read.content.replace(/\n*$/, "")}\n\n${TEAMMATE_MARKER}\n`;
      const meta = await rpc(
        port,
        opts?.mcp_teammate_key ?? opts?.mcp_key ?? SAM_TOKEN,
        "update_document",
        {
          file_id: opts?.brief_id ?? BRIEF_ID,
          content,
          expected_version: version,
        },
      );
      Object.assign(state, {
        injected: true,
        latency_ms: Date.now() - t0,
        teammate_version: meta.version,
        teammate_content: content,
      });
    } catch (err) {
      state.error = err.message;
      state.skipped = "inject_failed";
    }
  }

  function onEvent(e) {
    if (e.parent_tool_use_id) return;
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === "assistant") {
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        if (fired) {
          // Did the teammate edit land before the agent's next tool call?
          state.injected_before_next_call ??= state.injected;
          continue;
        }
        if (b.name === "mcp__tandem__update_document") wroteFirst = true;
        if (
          b.name === "mcp__tandem__read_file" &&
          b.input?.file_id === (opts?.brief_id ?? BRIEF_ID)
        )
          reads.add(b.id);
      }
    } else if (e.type === "user" && !fired) {
      for (const b of blocks) {
        if (b.type !== "tool_result" || !reads.has(b.tool_use_id) || b.is_error)
          continue;
        fired = true;
        if (wroteFirst) state.skipped = "write_before_read";
        else task = inject(textOf(b.content), Date.now());
        return;
      }
    }
  }

  return { state, onEvent, settled: () => task };
}

function summarize(trials, prompts, conditions) {
  const rows = [];
  for (const p of prompts) {
    for (const c of conditions) {
      const ts = trials.filter(
        (t) => t.prompt_id === p.id && t.condition === c,
      );
      if (ts.length)
        rows.push({
          prompt_id: p.id,
          kind: p.kind,
          condition: c,
          ...rates(ts),
        });
    }
  }
  const totals = [];
  for (const kind of ["project", "conflict", "control"]) {
    for (const c of conditions) {
      const ts = trials.filter((t) => t.kind === kind && t.condition === c);
      if (ts.length) totals.push({ kind, condition: c, ...rates(ts) });
    }
  }
  return { rows, totals };
}

export function rates(ts) {
  const count = (f) => ts.filter(f).length;
  const costs = ts.map((t) => t.cost_usd).filter((x) => typeof x === "number");
  return {
    n: ts.length,
    skill_invoked: count((t) => t.skill_invoked),
    any_tandem: count((t) => t.tandem_called),
    sync: count((t) => t.sync_called),
    sync_ok: count((t) => t.sync_ok),
    first_is_sync: count((t) => t.first_tandem_is_sync),
    write: count((t) => t.write_called),
    write_ok: count((t) => t.write_ok),
    used_local_files: count((t) => t.used_local_files),
    used_distractor_mcp: count((t) => t.used_distractor_mcp),
    answered_from_stale_local: count((t) => t.answered_from_stale_local),
    answered_from_stale_distractor: count(
      (t) => t.answered_from_stale_distractor,
    ),
    tool_errors: count((t) => t.tandem_errors.length > 0),
    errors_or_timeouts: count(
      (t) => t.error || t.timed_out || t.tandem_errors.length > 0,
    ),
    cost_usd: costs.reduce((a, b) => a + b, 0),
  };
}

function summarizeConflict(trials, prompts, conditions) {
  const rows = [];
  for (const p of prompts.filter((x) => x.conflict)) {
    for (const c of conditions) {
      const ts = trials.filter(
        (t) => t.prompt_id === p.id && t.condition === c && t.conflict,
      );
      if (!ts.length) continue;
      const count = (f) => ts.filter((t) => f(t.conflict)).length;
      const lat = ts
        .map((t) => t.conflict.inject_latency_ms)
        .filter((x) => typeof x === "number")
        .sort((a, b) => a - b);
      const costs = ts.map((t) => t.cost_usd ?? 0);
      rows.push({
        prompt_id: p.id,
        condition: c,
        n: ts.length,
        injected: count((x) => x.injected),
        no_inject: count((x) => !x.injected),
        conflict_hit: count((x) => x.conflict_hit),
        reread_after_conflict: count((x) => x.reread_after_conflict),
        retried: count((x) => x.retry_count > 0),
        looped: count((x) => x.looped),
        recovered: count((x) => x.recovered),
        clobbered: count((x) => x.clobbered),
        asked_user: count((x) => x.asked_user),
        outcomes: Object.fromEntries(
          [...new Set(ts.map((t) => t.conflict.outcome))].map((o) => [
            o,
            ts.filter((t) => t.conflict.outcome === o).length,
          ]),
        ),
        inject_latency_ms_median: lat.length
          ? lat[Math.floor(lat.length / 2)]
          : null,
        inject_latency_ms_max: lat.length ? lat[lat.length - 1] : null,
        cost_usd: costs.reduce((a, b) => a + b, 0),
      });
    }
  }
  return rows;
}

function summarizeFolders(trials, prompts, conditions) {
  const rows = [];
  for (const p of prompts.filter((x) => x.folders)) {
    for (const c of conditions) {
      const ts = trials.filter(
        (t) => t.prompt_id === p.id && t.condition === c && t.folders,
      );
      if (!ts.length) continue;
      rows.push({
        prompt_id: p.id,
        condition: c,
        n: ts.length,
        passed: ts.filter((t) => t.folders.passed).length,
        outcomes: Object.fromEntries(
          [...new Set(ts.map((t) => t.folders.outcome))].map((o) => [
            o,
            ts.filter((t) => t.folders.outcome === o).length,
          ]),
        ),
      });
    }
  }
  return rows;
}

export function summarizeLoop(trials, prompts, conditions) {
  const rows = [];
  for (const p of prompts.filter((x) => x.loop)) {
    for (const c of conditions) {
      const ts = trials.filter(
        (t) => t.prompt_id === p.id && t.condition === c && t.loop,
      );
      if (!ts.length) continue;
      const tally = (key) =>
        Object.fromEntries(
          [...new Set(ts.flatMap((t) => t.loop[key]))].map((step) => [
            step,
            ts.filter((t) => t.loop[key].includes(step)).length,
          ]),
        );
      const sum = (key) => ts.reduce((a, t) => a + t.loop[key], 0);
      rows.push({
        prompt_id: p.id,
        condition: c,
        n: ts.length,
        passed: ts.filter((t) => t.loop.passed).length,
        missing: tally("missing"),
        unwanted: tally("unwanted"),
        write_calls: sum("write_calls"),
        publish_calls: sum("publish_calls"),
        propose_calls: sum("propose_calls"),
      });
    }
  }
  return rows;
}

function summarizeIsolation(trials) {
  const userSkills = new Set(listDir(join(homedir(), ".claude/skills")));
  const leaks = [];
  const pluginSources = new Set();
  const mcpServers = new Set();
  const skillSets = { WITH_SKILL: new Set(), NO_SKILL: new Set() };
  const realistic = opts.env === "realistic";
  // Servers and their tools that are expected in this env, not leaks.
  const expectedServers = [
    "tandem",
    ...(realistic ? Object.keys(DISTRACTORS) : []),
  ];
  const expectedTools = new Set(
    realistic
      ? Object.entries(DISTRACTORS).flatMap(([k, tools]) =>
          tools.map((t) => `mcp__${k}__${t}`),
        )
      : [],
  );
  const distractorListed = new Set();
  const builtins = new Set();
  const localErrors = [];
  let distractorListedAll = 0;
  let withInit = 0;
  for (const t of trials) {
    if (!t.init) continue;
    withInit++;
    const where = `${t.prompt_id}/${t.condition}/rep${t.rep}`;
    t.init.mcp_servers.forEach((s) => mcpServers.add(s));
    t.init.plugins.forEach((p) => pluginSources.add(p));
    t.init.skills.forEach((s) => skillSets[t.condition]?.add(s));
    t.init.builtin_tools?.forEach((b) => builtins.add(b));
    for (const s of t.init.mcp_servers) {
      if (!expectedServers.some((e) => s.startsWith(`${e}:`)))
        leaks.push(`${where}: extra MCP server ${s}`);
    }
    for (const e of expectedServers) {
      if (!t.init.mcp_servers.includes(`${e}:connected`))
        leaks.push(
          `${where}: ${e} MCP server not connected (${t.init.mcp_servers.join(", ")})`,
        );
    }
    for (const tool of t.init.non_tandem_mcp_tools) {
      if (expectedTools.has(tool)) distractorListed.add(tool);
      else leaks.push(`${where}: extra MCP tool ${tool}`);
    }
    if (
      [...expectedTools].every((x) => t.init.non_tandem_mcp_tools.includes(x))
    )
      distractorListedAll++;
    else
      leaks.push(
        `${where}: distractor tools missing from init (${t.init.non_tandem_mcp_tools.join(", ") || "none"})`,
      );
    if (realistic) {
      for (const target of t.local_file_targets.filter((x) =>
        x.endsWith("(error)"),
      ))
        localErrors.push(`${where}: ${target}`);
    }
    for (const p of t.init.plugins) {
      if (!String(p).endsWith("@builtin"))
        leaks.push(`${where}: non-builtin plugin ${p}`);
    }
    for (const s of t.init.skills) {
      if (s.includes(":")) leaks.push(`${where}: plugin skill ${s}`);
      else if (s !== "tandem" && userSkills.has(s))
        leaks.push(`${where}: user skill ${s}`);
    }
    if ((t.condition === "WITH_SKILL") !== t.init.skills.includes("tandem")) {
      leaks.push(
        `${where}: tandem skill ${t.condition === "WITH_SKILL" ? "missing" : "present"}`,
      );
    }
  }
  return {
    clean: leaks.length === 0,
    leaks: [...new Set(leaks)],
    env: opts.env,
    expected_mcp_servers: expectedServers,
    mcp_servers_seen: [...mcpServers],
    ...(realistic && {
      distractor_tools_listed: [...distractorListed],
      trials_listing_all_distractor_tools: `${distractorListedAll}/${withInit}`,
      allowed_builtins: [
        "Skill",
        "ToolSearch",
        "Read(./**) (also governs Glob, Grep)",
      ],
      local_tool_errors: localErrors,
    }),
    builtin_tools_seen: [...builtins],
    plugins_seen: [...pluginSources],
    skills_only_with_skill: [...skillSets.WITH_SKILL].filter(
      (s) => !skillSets.NO_SKILL.has(s),
    ),
    builtin_skills_seen: [...skillSets.NO_SKILL],
    notes: [
      "--setting-sources project and --strict-mcp-config exclude user settings, user plugins and user/claude.ai MCP servers.",
      "The init event doesn't show memory files. That --setting-sources project also keeps out the user's ~/.claude/CLAUDE.md and auto-memory was verified manually by the Step C reviewer's probe on 2026-10-23, not by this harness.",
      "Built-in plugins (@builtin) and built-in skills ship with the CLI and are present in both conditions.",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 is set; the CLI may still create an empty ~/.claude/projects/<tmp-slug>/memory dir, which the harness removes only if empty.",
      ...(realistic
        ? [
            "Realistic env: the notes and tracker MCP servers and their tools are expected, not leaks; every trial must list all four distractor tools in init.",
            "Realistic env: reads are allowed as Read(./**) relative to the temp project. A manual probe on 2026-10-23 (same flags) showed Glob and Grep inside the project working, and Read of /etc/hosts and ~/.zshrc and Grep in ~ denied in dontAsk mode.",
          ]
        : []),
    ],
  };
}

// Sum the raw per-trial costs and round once. Older results JSON stores
// summary costs pre-rounded to 4 places, which double-rounds (0.1750064 ->
// 0.175 -> "0.17"), so the renderer doesn't use them.
function costCell(trials, match) {
  const sum = trials.filter(match).reduce((a, t) => a + (t.cost_usd ?? 0), 0);
  return `$${sum.toFixed(2)}`;
}

function renderSummaryTable(summary, env, trials) {
  const realistic = env === "realistic";
  const cols = [
    "Prompt",
    "Condition",
    "n",
    "Skill invoked",
    "Any Tandem call",
    "Sync attempted",
    "Sync OK",
    "First Tandem call = sync",
    "Write attempted",
    "Write OK",
    ...(realistic
      ? [
          "Local files (Read/Glob/Grep)",
          "Distractor MCP",
          "Stale local answer",
          "Mentions distractor-only phrase",
        ]
      : []),
    "Tool errors",
    "Errors/timeouts (incl. tool errors)",
    "Cost",
  ];
  const head = `| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n`;
  // Results recorded before the success/tool-error split lack those counts.
  const fmt = (k, n) => (k === undefined ? "n/a" : `${k}/${n}`);
  const row = (label, r, match) =>
    `| ${[
      label,
      r.condition,
      r.n,
      ...[
        r.skill_invoked,
        r.any_tandem,
        r.sync,
        r.sync_ok,
        r.first_is_sync,
        r.write,
        r.write_ok,
        ...(realistic
          ? [
              r.used_local_files,
              r.used_distractor_mcp,
              r.answered_from_stale_local,
              r.answered_from_stale_distractor,
            ]
          : []),
        r.tool_errors,
        r.errors_or_timeouts,
      ].map((k) => fmt(k, r.n)),
      costCell(trials, (t) => match(t) && t.condition === r.condition),
    ].join(" | ")} |`;
  return (
    head +
    summary.rows
      .map((r) =>
        row(`\`${r.prompt_id}\``, r, (t) => t.prompt_id === r.prompt_id),
      )
      .join("\n") +
    "\n" +
    summary.totals
      .map((r) => row(`**All ${r.kind}**`, r, (t) => t.kind === r.kind))
      .join("\n") +
    "\n"
  );
}

function renderConflictTable(rows, trials) {
  const fmt = (k, n) => `${k}/${n}`;
  return (
    "| Prompt | Condition | n | Injected | Conflict hit | Re-read after conflict | Retried | Looped (>1 retry) | Recovered | Clobbered | Asked user | Outcomes | Inject latency median/max | Cost |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n" +
    rows
      .map(
        (r) =>
          `| \`${r.prompt_id}\` | ${r.condition} | ${r.n} | ${[
            r.injected,
            r.conflict_hit,
            r.reread_after_conflict,
            r.retried,
            r.looped,
            r.recovered,
            r.clobbered,
            r.asked_user,
          ]
            .map((k) => fmt(k, r.n))
            .join(" | ")} | ${Object.entries(r.outcomes)
            .map(([o, k]) => `${o} ×${k}`)
            .join(
              ", ",
            )} | ${r.inject_latency_ms_median ?? "-"}/${r.inject_latency_ms_max ?? "-"} ms | ${costCell(
            trials,
            (t) =>
              t.prompt_id === r.prompt_id &&
              t.condition === r.condition &&
              t.conflict,
          )} |`,
      )
      .join("\n") +
    "\n"
  );
}

function renderConflictSection(r) {
  if (!r.conflict_summary?.length) return "";
  const detail = r.trials
    .filter((t) => t.conflict)
    .map((t) => {
      const c = t.conflict;
      return `| \`${t.prompt_id}\` | ${t.condition} | ${t.rep} | ${c.outcome} | ${c.injected ? `v${c.read_version}→v${c.teammate_version}, ${c.inject_latency_ms} ms${c.injected_before_next_call === false ? " (after next call)" : ""}` : (c.inject_skipped ?? "-")} | ${c.update_calls} | ${c.conflict_hit ? "yes" : "no"} | ${c.reread_after_conflict ? "yes" : "no"} | ${c.retry_count}${c.retry_count ? (c.retry_ok ? " (ok)" : " (failed)") : ""} | v${c.head_version ?? "?"} by ${c.head_updated_by ?? "?"}${c.injected ? `, marker ${c.head_has_marker ? "kept" : "LOST"}` : " (no teammate edit)"} | ${c.merge_questions.map((q) => q.replace(/\|/g, "/").slice(0, 120)).join(" / ") || "-"} |`;
    })
    .join("\n");
  return `## VERSION_CONFLICT recovery

Prompts marked \`"conflict": true\`. Right after the agent's first successful \`read_file\` of the trial's brief, the harness (using ${r.settings.teammate_actor ?? "\`user_sam\`"}, over its own JSON-RPC call) saves the read content plus the line \`${TEAMMATE_MARKER}\` with \`expected_version\` = the version just read. The agent's next \`update_document\` with the old version then gets \`VERSION_CONFLICT\`. The final head is read back over JSON-RPC at trial end.

- **Recovered** = final head contains the teammate marker and differs from the teammate's version (the agent's change landed on top). **Clobbered** = final head lacks the marker. **Looped** = more than one \`update_document\` after the first conflict. **Asked user** = the final answer has a question about the conflict, merge, or teammate edit (regex heuristic; questions are listed below for audit).
- Outcomes: \`recovered\`; \`landed_without_conflict\` (re-read before writing, so no conflict, marker kept); \`conflict_asked_user\` / \`conflict_unresolved\` (conflict, nothing landed, marker kept); \`no_write\` / \`no_write_asked\`; \`clobbered\`; \`no_inject:<reason>\` (\`never_read\`, \`write_before_read\`, \`inject_failed\`).

${renderConflictTable(r.conflict_summary, r.trials)}
| Prompt | Condition | Rep | Outcome | Injection | update_document calls | Conflict | Re-read | Retries | Final head | Merge questions |
|---|---|---|---|---|---|---|---|---|---|---|
${detail}

`;
}

function renderFolderTable(rows) {
  return (
    "| Prompt | Condition | n | Passed | Outcomes |\n|---|---|---|---|---|\n" +
    rows
      .map(
        (r) =>
          `| \`${r.prompt_id}\` | ${r.condition} | ${r.n} | ${r.passed}/${r.n} | ${Object.entries(
            r.outcomes,
          )
            .map(([o, k]) => `${o} ×${k}`)
            .join(", ")} |`,
      )
      .join("\n") +
    "\n"
  );
}

function renderFolderSection(r) {
  if (!r.folder_summary?.length) return "";
  const seed = r.settings.folder_seed;
  const detail = r.trials
    .filter((t) => t.folders)
    .map((t) => {
      const f = t.folders;
      const how =
        f.expect === "read"
          ? `read ${f.read_paths.map((p) => `\`${p}\``).join(", ") || "-"}; marker ${f.answer_has_marker ? "in answer" : "missing"}`
          : `landed ${f.landed_in.map((p) => `\`${p}\``).join(", ") || "-"}; ${f.used_folder_path ? "folder_path" : f.used_parent_id ? "parent_id" : "no folder arg"}; create_folder ${f.create_folder_paths.map((p) => `\`${p}\``).join(", ") || "-"}; looked first ${f.looked_first ? "yes" : "no"}`;
      return `| \`${t.prompt_id}\` | ${t.condition} | ${t.rep} | ${f.outcome} | ${f.passed ? "yes" : "no"} | ${how} |`;
    })
    .join("\n");
  return `## Folders

Prompts with \`folders\`. Before each trial the harness saves (as ${seed?.saved_by ?? "\`user_sam\`"}) the folders ${seed?.folders.map((p) => `\`${p}\``).join(", ") ?? "-"} and files ${seed?.files.map((p) => `\`${p}\``).join(", ") ?? "-"}.

- \`create_in\` passes when a successful \`create_document\` landed in the expected folder (from the returned \`path\`, else the \`folder_path\`/\`parent_id\` argument). Outcomes: \`in_folder\`, \`root\`, \`other_folder:<path>\`, \`create_failed\`, \`no_create\`.
- \`read\` passes when the seeded file was read successfully (by \`path\` or its \`file_id\`) and the final answer contains its marker phrase. Outcomes: \`read_by_path\`, \`read_by_id\`, \`read_other\`, \`not_read\`.

${renderFolderTable(r.folder_summary)}
| Prompt | Condition | Rep | Outcome | Passed | Detail |
|---|---|---|---|---|---|
${detail}

`;
}

export function renderLoopTable(rows) {
  const steps = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "-";
  return (
    "| Prompt | Condition | n | Passed | Missing required | Unwanted writes | Write calls | publish_work | propose_context_change |\n|---|---|---|---|---|---|---|---|---|\n" +
    rows
      .map(
        (r) =>
          `| \`${r.prompt_id}\` | ${r.condition} | ${r.n} | ${r.passed}/${r.n} | ${steps(r.missing)} | ${steps(r.unwanted)} | ${r.write_calls} | ${r.publish_calls} | ${r.propose_calls} |`,
      )
      .join("\n") +
    "\n"
  );
}

function renderLoopSection(r) {
  if (!r.loop_summary?.length) return "";
  const specs = r.prompts
    .filter((p) => p.loop)
    .map(
      (p) =>
        `\`${p.id}\` requires ${p.loop.require.join(" + ") || "nothing"}, forbids ${p.loop.forbid.join(", ") || "nothing"}`,
    )
    .join("; ");
  return `## Loop

Prompts with \`loop\`. A trial passes when every required step had a successful call (sync: \`sync_workspace\`; read: \`read_file\`/\`search_files\`; save: \`create_document\`/\`update_document\`; propose: \`propose_context_change\`) and no forbidden step was attempted. Missing and unwanted columns count trials per step; call columns sum calls. Specs: ${specs}.

${renderLoopTable(r.loop_summary)}
`;
}

function renderMarkdown(r) {
  const trialRows = r.trials
    .map((t) => {
      const writes =
        t.write_tools
          .map((w) => `${w.tool}${w.ok ? "" : " (error)"}`)
          .join(", ") || "-";
      const flags = [
        t.timed_out && "timeout",
        t.error,
        ...t.tandem_errors.map(
          (e) =>
            `${e.tool}: ${e.error.replace(/\s+/g, " ").replace(/\|/g, "\\|")}`,
        ),
        t.permission_denials.length &&
          `denied: ${t.permission_denials.join(",")}`,
        t.tools.some((x) => DISALLOWED_TOOLS.includes(x)) &&
          `tried disallowed: ${[...new Set(t.tools.filter((x) => DISALLOWED_TOOLS.includes(x)))].join(",")}`,
      ]
        .filter(Boolean)
        .join("; ");
      return `| \`${t.prompt_id}\` | ${t.condition} | ${t.rep} | ${t.tools.join(" → ") || "(none)"} | ${writes} | ${t.num_turns ?? "-"} | ${t.cost_usd === null ? "-" : `$${t.cost_usd.toFixed(3)}`} | ${flags || "-"} |`;
    })
    .join("\n");
  const answers = r.trials
    .map(
      (t) =>
        `**\`${t.prompt_id}\` ${t.condition} rep${t.rep}:** ${t.result_text.replace(/\s+/g, " ").slice(0, 300).trimEnd() || "(empty)"}`,
    )
    .join("\n\n");
  const iso = r.isolation;
  const realistic = r.settings.env === "realistic";
  const envLine = realistic
    ? `- Env: **realistic**. Each temp project has an out-of-date local tree (${r.settings.local_tree.map((f) => `\`${f}\``).join(", ")}) whose goal/owners differ from Tandem, readable via \`Read(./**)\` (Read/Glob/Grep scoped to the project). Two distractor MCP servers sit beside \`tandem\` in the same \`--mcp-config\`: ${Object.entries(
        r.settings.distractor_servers,
      )
        .map(([k, ts]) => `\`${k}\` (${ts.join(", ")})`)
        .join(" and ")}. ${r.settings.brief_seed}.`
    : `- Env: **bare**. Empty temp project; \`tandem\` is the only MCP server. ${r.settings.brief_seed}.`;
  const staleNote = realistic
    ? `\n\n"Local files" = any Read/Glob/Grep call. "Distractor MCP" = any notes/tracker call. "Stale local answer" = the final answer contains a phrase only the local tree has (${r.settings.stale_markers.local.map((m) => `"${m}"`).join(", ")}) and not the Tandem value (${r.settings.tandem_markers.map((m) => `"${m}"`).join(", ")}); "Mentions distractor-only phrase" is the same check for the stubs' phrase (${r.settings.stale_markers.distractor.map((m) => `"${m}"`).join(", ")}; JSON field \`answered_from_stale_distractor\`). It only says the phrase appears, not that the answer relied on it. Marker checks are substring matches on the final answer: a draft that quotes a stale phrase as "outdated" still counts, so read the answers below before drawing conclusions.`
    : "";
  return `# Tandem skill eval: Claude Code, ${r.date}

Generated by \`skills/tandem/eval/run.mjs\`. Raw data: \`${r.stem}.json\`.

- Client: Claude Code CLI \`${r.cli_version}\`, headless (\`claude -p\`)
- Model: \`${r.model_requested}\` (reported: ${r.models_reported.map((m) => `\`${m}\``).join(", ") || "n/a"})
- Trials: ${r.trials.length} (${r.settings.reps} reps × ${r.prompts.length} prompts × ${r.settings.conditions.length} conditions), \`--max-turns ${r.settings.max_turns}\`, ${r.settings.timeout_sec}s timeout
- Server: ${r.settings.server}
${envLine}
- Conditions: **WITH_SKILL** = \`skills/tandem/SKILL.md\` (only) copied to \`<project>/.claude/skills/tandem\`; **NO_SKILL** = same MCP servers, files and flags, no skill
- Total cost reported by CLI: $${r.trials.reduce((a, t) => a + (t.cost_usd ?? 0), 0).toFixed(2)}

## Summary

Counts are k/n trials. Sync/write attempted count trials with matching tool calls; Sync/write OK require at least one matching non-error tool result. Write tools are create_document, update_document, create_folder, move_file, move_folder, publish_work, propose_context_change. First Tandem call = sync measures attempted order. Tool errors counts trials with at least one Tandem tool error, even if the final answer succeeds. Errors/timeouts includes tool errors, CLI failures (including nonzero exit or a missing final result), and timeouts; these trials still count in n. Tool calls made inside subagents are excluded. Columns shown as n/a were not recorded by that run.${staleNote}

${renderSummaryTable(r.summary, r.settings.env, r.trials)}
${renderConflictSection(r)}${renderFolderSection(r)}${renderLoopSection(r)}## Isolation

- Clean: **${iso.clean ? "yes" : "NO"}**${iso.leaks.length ? `\n- Leaks:\n${iso.leaks.map((l) => `  - ${l}`).join("\n")}` : ""}
- Expected MCP servers (${iso.env} env): ${iso.expected_mcp_servers.map((s) => `\`${s}\``).join(", ")}
- MCP servers seen: ${iso.mcp_servers_seen.map((s) => `\`${s}\``).join(", ")}${
    realistic
      ? `
- Distractor tools listed in init: ${iso.distractor_tools_listed.map((s) => `\`${s}\``).join(", ") || "none"} (all four in ${iso.trials_listing_all_distractor_tools} trials)
- Allowed built-ins: ${iso.allowed_builtins.map((s) => `\`${s}\``).join(", ")}
- Local tool calls that errored: ${iso.local_tool_errors.length ? iso.local_tool_errors.map((s) => `\`${s}\``).join(", ") : "none"}`
      : ""
  }
- Built-in tools in init: ${iso.builtin_tools_seen.map((s) => `\`${s}\``).join(", ") || "n/a"}
- Plugins seen: ${iso.plugins_seen.map((s) => `\`${s}\``).join(", ") || "none"}
- Skills present only WITH_SKILL: ${iso.skills_only_with_skill.map((s) => `\`${s}\``).join(", ") || "none"}
- Built-in skills present in both conditions: ${iso.builtin_skills_seen.map((s) => `\`${s}\``).join(", ") || "none"}
${iso.notes.map((n) => `- ${n}`).join("\n")}

## Trials

| Prompt | Condition | Rep | Tool calls (in order) | Writes | Turns | Cost | Flags |
|---|---|---|---|---|---|---|---|
${trialRows}

## Final answers (first 300 chars)

${answers}
`;
}

// ---------- helpers ----------

function startServer(port) {
  return startHttpChild(
    [SERVER_ENTRY],
    {
      PORT: String(port),
      TANDEM_BACKEND: "mock",
      TANDEM_DEV_TOKENS: `${DEV_TOKEN}:user_alex,${SAM_TOKEN}:user_sam`,
      TANDEM_DEV_ANON_USER: "",
    },
    `http://localhost:${port}/healthz`,
  );
}

function startStub(kind, port) {
  return startHttpChild(
    [STUB_ENTRY, kind, String(port)],
    {},
    `http://127.0.0.1:${port}/healthz`,
  );
}

async function startHttpChild(args, env, healthUrl) {
  const child = track(
    spawn("node", args, {
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; i < 50 && !aborting; i++) {
    if (exited(child)) throw new Error(`MCP server exited: ${stderr}`);
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return child;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stopChild(child);
  throw new Error(
    `MCP server did not become healthy at ${healthUrl}: ${stderr}`,
  );
}

// One stateless tools/call against a trial's Tandem server, outside the agent.
async function rpc(port, token, name, args) {
  const connection = mcpConnection(opts, port, token);
  const res = await fetch(connection.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...connection.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const body = parseRpcResponse(await res.text());
  const r = body.result;
  if (!r) throw new Error(`${name}: ${JSON.stringify(body.error ?? body)}`);
  if (r.isError) throw new Error(`${name}: ${textOf(r.content)}`);
  return r.structuredContent ?? JSON.parse(textOf(r.content));
}

// Saves the richer brief as v2 by user_sam, so there's an intro to edit.
async function seedBrief(port) {
  const { file } = await rpc(
    port,
    opts?.mcp_teammate_key ?? opts?.mcp_key ?? SAM_TOKEN,
    "read_file",
    {
      file_id: opts?.brief_id ?? BRIEF_ID,
    },
  );
  await rpc(
    port,
    opts?.mcp_teammate_key ?? opts?.mcp_key ?? SAM_TOKEN,
    "update_document",
    {
      file_id: opts?.brief_id ?? BRIEF_ID,
      content: TANDEM_BRIEF,
      expected_version: file.version,
    },
  );
}

// Saves FOLDER_SEED as user_sam and returns { folder_ids, file_ids } keyed
// by path. Re-runnable against a persistent server: create_folder is
// idempotent, and a file that already exists (NAME_EXISTS) is kept as is.
async function seedFolders(port) {
  const token = opts?.mcp_teammate_key ?? opts?.mcp_key ?? SAM_TOKEN;
  const folder_ids = {};
  const file_ids = {};
  for (const path of FOLDER_SEED.folders) {
    const { folder } = await rpc(port, token, "create_folder", { path });
    folder_ids[path] = folder.id;
  }
  for (const f of FOLDER_SEED.files) {
    const path = `${f.folder_path}/${f.name}`;
    let file;
    try {
      file = await rpc(port, token, "create_document", {
        name: f.name,
        content: f.content,
        folder_path: f.folder_path,
      });
    } catch (err) {
      if (!/NAME_EXISTS/.test(err.message)) throw err;
      ({ file } = await rpc(port, token, "read_file", { path }));
    }
    file_ids[path] = file.id;
  }
  return { folder_ids, file_ids };
}

// Children run detached (own process group) so a signal to the harness alone
// doesn't orphan them, and so killing the group also reaches grandchildren.
function track(child) {
  live.children.add(child);
  child.once("exit", () => live.children.delete(child));
  return child;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function killGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  }
}

// SIGTERM, then SIGKILL after graceMs. Never waits on a child that already exited.
async function stopChild(child, graceMs = 3000) {
  if (exited(child)) return;
  const done = new Promise((r) => child.once("exit", r));
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => killGroup(child, "SIGKILL"), graceMs);
  await done;
  clearTimeout(timer);
}

function removeRoots() {
  for (const root of live.roots) {
    cleanEmptyProjectMemory(join(root, "project"));
    rmSync(root, { recursive: true, force: true });
  }
  live.roots.clear();
}

async function abort(sig, code) {
  if (aborting) return;
  aborting = true;
  console.error(
    `\n${sig}: stopping ${live.children.size} child process(es), removing ${live.roots.size} temp dir(s)`,
  );
  await Promise.all([...live.children].map((c) => stopChild(c, 2000)));
  removeRoots();
  process.exit(code);
}

function usageError(message) {
  return Object.assign(new Error(message), { usage: true });
}

function portFree(port) {
  return new Promise((r) => {
    const s = createServer();
    s.once("error", () => r(false));
    s.listen(port, () => s.close(() => r(true)));
  });
}

// Claude Code may create ~/.claude/projects/<cwd-slug>/memory for each temp
// project. Remove only those exact dirs, and only when empty (rmdir fails otherwise).
function cleanEmptyProjectMemory(project) {
  for (const p of new Set([project, safeRealpath(project)])) {
    const dir = join(
      homedir(),
      ".claude/projects",
      p.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    for (const d of [join(dir, "memory"), dir]) {
      try {
        rmdirSync(d);
      } catch {
        // Missing or not empty: leave it.
      }
    }
  }
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p.startsWith("/var/") ? `/private${p}` : p;
  }
}

function listDir(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join(" ");
  return JSON.stringify(content ?? "");
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseArgs(argv, env = process.env) {
  const o = {
    mcp_url: env.TANDEM_MCP_URL ?? null,
    mcp_key: env.TANDEM_MCP_KEY ?? null,
    mcp_teammate_key: env.TANDEM_MCP_TEAMMATE_KEY ?? null,
    brief_id: env.TANDEM_BRIEF_ID ?? null,
    model: "sonnet",
    reps: 2,
    max_turns: 6,
    timeout: 180,
    concurrency: 2,
    port: 8931,
    env: "bare",
    prompts: null,
    conditions: null,
    out: join(EVAL_DIR, "results"),
    tag: null,
    force: false,
    build: true,
    keep: false,
    rerender: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw usageError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--mcp-url":
        o.mcp_url = val();
        break;
      case "--mcp-key":
        o.mcp_key = val();
        break;
      case "--mcp-teammate-key":
        o.mcp_teammate_key = val();
        break;
      case "--brief-id":
        o.brief_id = val();
        break;
      case "--model":
        o.model = val();
        break;
      case "--reps":
        o.reps = posInt(a, val());
        break;
      case "--max-turns":
        o.max_turns = posInt(a, val());
        break;
      case "--timeout":
        o.timeout = posInt(a, val());
        break;
      case "--concurrency":
        o.concurrency = posInt(a, val());
        break;
      case "--port":
        o.port = posInt(a, val());
        break;
      case "--env":
        o.env = val();
        if (!ENVS.includes(o.env))
          throw usageError(`--env must be one of ${ENVS.join(", ")}`);
        break;
      case "--prompts":
        o.prompts = val();
        break;
      case "--conditions":
        o.conditions = val();
        break;
      case "--out":
        o.out = resolve(val());
        break;
      case "--tag":
        o.tag = val();
        break;
      case "--force":
        o.force = true;
        break;
      case "--no-build":
        o.build = false;
        break;
      case "--keep":
        o.keep = true;
        break;
      case "--rerender":
        o.rerender = resolve(val());
        break;
      case "-h":
      case "--help":
        o.help = true;
        break;
      default:
        throw usageError(`Unknown option ${a}`);
    }
  }
  if (o.mcp_url) {
    let url;
    try {
      url = new URL(o.mcp_url);
    } catch {
      throw usageError("--mcp-url must be an HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw usageError(
        "--mcp-url must be HTTP(S), without embedded credentials, query, or fragment",
      );
    if (!o.mcp_key)
      throw usageError("--mcp-url requires --mcp-key or TANDEM_MCP_KEY");
    if (o.concurrency !== 1)
      throw usageError("External server state is shared; use --concurrency 1");
    if (o.env === "realistic")
      throw usageError(
        "External mode currently supports --env bare only (mock marker fixtures differ)",
      );
  } else if (o.mcp_key || o.mcp_teammate_key || o.brief_id) {
    throw usageError("External credentials and --brief-id require --mcp-url");
  }
  return o;
}

export function redactSecrets(value, secrets) {
  let json = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean))
    json = json.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]");
  return JSON.parse(json);
}

export function mcpConnection(o, port, token = o?.mcp_key ?? DEV_TOKEN) {
  return {
    type: "http",
    url: o?.mcp_url ?? `http://localhost:${port}/mcp`,
    headers: o?.mcp_url
      ? { Authorization: `Bearer ${token}` }
      : { "api-key": token },
  };
}

export function parseRpcResponse(text) {
  // Streamable HTTP permits JSON or SSE, including multi-line data fields.
  try {
    return JSON.parse(text);
  } catch {
    /* SSE below */
  }
  for (const event of text.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const body = JSON.parse(data);
    if (body.result || body.error) return body;
  }
  throw new Error("No JSON-RPC result in MCP response");
}

function posInt(flag, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw usageError(`${flag} must be a positive integer`);
  return n;
}
