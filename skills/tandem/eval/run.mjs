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

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(EVAL_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps/mcp/dist/index.js");
const DEV_TOKEN = "alex-dev-token";
const WRITE_TOOLS = new Set([
  "create_document",
  "update_document",
  "publish_work",
  "propose_context_change",
]);
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
  --model <name>        Claude model alias or id (default: sonnet)
  --reps <n>            repetitions per prompt per condition (default: 2)
  --max-turns <n>       claude --max-turns (default: 6)
  --timeout <sec>       per-trial timeout (default: 180)
  --concurrency <n>     trials in parallel (default: 2)
  --port <n>            first MCP server port; slot i uses port+i (default: 8931)
  --prompts <ids>       comma-separated prompt ids to run (default: all)
  --conditions <list>   WITH_SKILL,NO_SKILL (default: both)
  --out <dir>           results dir (default: skills/tandem/eval/results)
  --tag <s>             suffix for result file names (default: none)
  --force               overwrite existing result files with the same name
  --no-build            skip building apps/mcp
  --keep                keep temp dirs and raw stream-json logs`;

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

  if (opts.build) {
    console.log("Building apps/mcp ...");
    const b = spawnSync("pnpm", ["--filter", "mcp", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (b.status !== 0) throw new Error("apps/mcp build failed");
  }
  if (!existsSync(SERVER_ENTRY))
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

  const ports = [];
  for (let i = 0, p = opts.port; i < opts.concurrency; i++, p++) {
    while (!(await portFree(p))) p++;
    ports.push(p);
  }

  console.log(
    `Claude Code ${cliVersion}, model ${opts.model}, ${jobs.length} trials, concurrency ${opts.concurrency}, ports ${ports.join(",")}`,
  );

  const trials = [];
  let next = 0;
  let fatal = null;
  await Promise.all(
    ports.map(async (port) => {
      while (next < jobs.length && !fatal && !aborting) {
        const job = jobs[next++];
        try {
          const t = await runTrial(job, port);
          trials.push(t);
          const label = `[${trials.length}/${jobs.length}] ${job.prompt.id} ${job.condition} rep${job.rep}`;
          console.log(
            `${label}: tools=${t.tools.join(" > ") || "(none)"} | sync=${t.sync_called} write=${t.write_called}${t.timed_out ? " TIMEOUT" : ""}${t.error ? ` ERROR=${t.error}` : ""}`,
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
  const isolation = summarizeIsolation(trials);
  const results = {
    date,
    stem,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    client: "claude-code",
    cli_version: cliVersion,
    model_requested: opts.model,
    models_reported: [...new Set(trials.map((t) => t.model).filter(Boolean))],
    settings: {
      reps: opts.reps,
      max_turns: opts.max_turns,
      timeout_sec: opts.timeout,
      concurrency: opts.concurrency,
      conditions,
      claude_flags: claudeFlags("<mcp-config>", opts).filter(
        (f) => !f.startsWith("<"),
      ),
      server:
        "apps/mcp mock backend, fresh process per trial, api-key auth as user_alex",
    },
    prompts,
    isolation,
    summary,
    trials,
  };

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(results, null, 2) + "\n");
  writeFileSync(mdPath, renderMarkdown(results));
  console.log(
    `\nWrote ${relative(REPO_ROOT, jsonPath)} and ${relative(REPO_ROOT, mdPath)}`,
  );
  console.log("\n" + renderSummaryTable(summary));
}

async function runTrial({ prompt, condition, rep }, port) {
  const root = mkdtempSync(join(tmpdir(), "tandem-eval-"));
  live.roots.add(root);
  const project = join(root, "project");
  mkdirSync(project);
  if (condition === "WITH_SKILL") {
    const dest = join(project, ".claude/skills/tandem");
    mkdirSync(dest, { recursive: true });
    copyFileSync(join(SKILL_DIR, "SKILL.md"), join(dest, "SKILL.md"));
  }
  // Config lives outside the project dir so the model can't stumble on it.
  const mcpConfig = join(root, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        tandem: {
          type: "http",
          url: `http://localhost:${port}/mcp`,
          headers: { "api-key": DEV_TOKEN },
        },
      },
    }),
  );

  let server;
  let run;
  const started = Date.now();
  try {
    server = await startServer(port);
    run = await runClaude(prompt.text, project, mcpConfig);
  } finally {
    if (server) await stopChild(server);
    if (!run || !opts.keep) {
      cleanEmptyProjectMemory(project);
      rmSync(root, { recursive: true, force: true });
    }
    live.roots.delete(root);
  }
  if (aborting) throw new Error("aborted");

  const trial = analyze(run, { prompt, condition, rep });
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
    "mcp__tandem__*",
    "Skill",
    "ToolSearch",
    "Read",
    "Glob",
    "Grep",
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];
}

function runClaude(promptText, cwd, mcpConfig) {
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
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
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

export function analyze(run, { prompt, condition, rep }) {
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
  for (const kind of ["project", "control"]) {
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
    tool_errors: count((t) => t.tandem_errors.length > 0),
    errors_or_timeouts: count(
      (t) => t.error || t.timed_out || t.tandem_errors.length > 0,
    ),
    cost_usd: Number(costs.reduce((a, b) => a + b, 0).toFixed(4)),
  };
}

function summarizeIsolation(trials) {
  const userSkills = new Set(listDir(join(homedir(), ".claude/skills")));
  const leaks = [];
  const pluginSources = new Set();
  const mcpServers = new Set();
  const skillSets = { WITH_SKILL: new Set(), NO_SKILL: new Set() };
  for (const t of trials) {
    if (!t.init) continue;
    const where = `${t.prompt_id}/${t.condition}/rep${t.rep}`;
    t.init.mcp_servers.forEach((s) => mcpServers.add(s));
    t.init.plugins.forEach((p) => pluginSources.add(p));
    t.init.skills.forEach((s) => skillSets[t.condition]?.add(s));
    for (const s of t.init.mcp_servers) {
      if (!s.startsWith("tandem:"))
        leaks.push(`${where}: extra MCP server ${s}`);
    }
    if (!t.init.mcp_servers.includes("tandem:connected")) {
      leaks.push(
        `${where}: tandem MCP server not connected (${t.init.mcp_servers.join(", ")})`,
      );
    }
    for (const tool of t.init.non_tandem_mcp_tools)
      leaks.push(`${where}: extra MCP tool ${tool}`);
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
    mcp_servers_seen: [...mcpServers],
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
    ],
  };
}

function renderSummaryTable(summary) {
  const head =
    "| Prompt | Condition | n | Skill invoked | Any Tandem call | Sync attempted | Sync OK | First Tandem call = sync | Write attempted | Write OK | Tool errors | Errors/timeouts (incl. tool errors) |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  const fmt = (k, n) => `${k}/${n}`;
  const row = (label, r) =>
    `| ${label} | ${r.condition} | ${r.n} | ${fmt(r.skill_invoked, r.n)} | ${fmt(r.any_tandem, r.n)} | ${fmt(r.sync, r.n)} | ${fmt(r.sync_ok, r.n)} | ${fmt(r.first_is_sync, r.n)} | ${fmt(r.write, r.n)} | ${fmt(r.write_ok, r.n)} | ${fmt(r.tool_errors, r.n)} | ${fmt(r.errors_or_timeouts, r.n)} |`;
  return (
    head +
    summary.rows.map((r) => row(`\`${r.prompt_id}\``, r)).join("\n") +
    "\n" +
    summary.totals.map((r) => row(`**All ${r.kind}**`, r)).join("\n") +
    "\n"
  );
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
      ]
        .filter(Boolean)
        .join("; ");
      return `| \`${t.prompt_id}\` | ${t.condition} | ${t.rep} | ${t.tools.join(" → ") || "(none)"} | ${writes} | ${t.num_turns ?? "-"} | ${flags || "-"} |`;
    })
    .join("\n");
  const answers = r.trials
    .map(
      (t) =>
        `**\`${t.prompt_id}\` ${t.condition} rep${t.rep}:** ${t.result_text.replace(/\s+/g, " ").slice(0, 300) || "(empty)"}`,
    )
    .join("\n\n");
  const iso = r.isolation;
  return `# Tandem skill eval: Claude Code, ${r.date}

Generated by \`skills/tandem/eval/run.mjs\`. Raw data: \`${r.stem}.json\`.

- Client: Claude Code CLI \`${r.cli_version}\`, headless (\`claude -p\`)
- Model: \`${r.model_requested}\` (reported: ${r.models_reported.map((m) => `\`${m}\``).join(", ") || "n/a"})
- Trials: ${r.trials.length} (${r.settings.reps} reps × ${r.prompts.length} prompts × ${r.settings.conditions.length} conditions), \`--max-turns ${r.settings.max_turns}\`, ${r.settings.timeout_sec}s timeout
- Server: ${r.settings.server}
- Conditions: **WITH_SKILL** = \`skills/tandem/SKILL.md\` (only) copied to \`<project>/.claude/skills/tandem\`; **NO_SKILL** = same MCP server and flags, no skill
- Total cost reported by CLI: $${r.trials.reduce((a, t) => a + (t.cost_usd ?? 0), 0).toFixed(2)}

## Summary

Counts are k/n trials. Sync/write attempted count trials with matching tool calls; Sync/write OK require at least one matching non-error tool result. Write tools are create_document, update_document, publish_work, propose_context_change. First Tandem call = sync measures attempted order. Tool errors counts trials with at least one Tandem tool error, even if the final answer succeeds. Errors/timeouts includes tool errors, CLI failures (including nonzero exit or a missing final result), and timeouts; these trials still count in n. Tool calls made inside subagents are excluded.

${renderSummaryTable(r.summary)}
## Isolation

- Clean: **${iso.clean ? "yes" : "NO"}**${iso.leaks.length ? `\n- Leaks:\n${iso.leaks.map((l) => `  - ${l}`).join("\n")}` : ""}
- MCP servers seen: ${iso.mcp_servers_seen.map((s) => `\`${s}\``).join(", ")}
- Plugins seen: ${iso.plugins_seen.map((s) => `\`${s}\``).join(", ") || "none"}
- Skills present only WITH_SKILL: ${iso.skills_only_with_skill.map((s) => `\`${s}\``).join(", ") || "none"}
- Built-in skills present in both conditions: ${iso.builtin_skills_seen.map((s) => `\`${s}\``).join(", ") || "none"}
${iso.notes.map((n) => `- ${n}`).join("\n")}

## Trials

| Prompt | Condition | Rep | Tool calls (in order) | Writes | Turns | Flags |
|---|---|---|---|---|---|---|
${trialRows}

## Final answers (first 300 chars)

${answers}
`;
}

// ---------- helpers ----------

async function startServer(port) {
  const child = track(
    spawn("node", [SERVER_ENTRY], {
      env: {
        ...process.env,
        PORT: String(port),
        TANDEM_BACKEND: "mock",
        TANDEM_DEV_TOKENS: `${DEV_TOKEN}:user_alex`,
        TANDEM_DEV_ANON_USER: "",
      },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; i < 50 && !aborting; i++) {
    if (exited(child)) throw new Error(`MCP server exited: ${stderr}`);
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return child;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stopChild(child);
  throw new Error(
    `MCP server did not become healthy on port ${port}: ${stderr}`,
  );
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

function parseArgs(argv) {
  const o = {
    model: "sonnet",
    reps: 2,
    max_turns: 6,
    timeout: 180,
    concurrency: 2,
    port: 8931,
    prompts: null,
    conditions: null,
    out: join(EVAL_DIR, "results"),
    tag: null,
    force: false,
    build: true,
    keep: false,
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
      case "-h":
      case "--help":
        o.help = true;
        break;
      default:
        throw usageError(`Unknown option ${a}`);
    }
  }
  return o;
}

function posInt(flag, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw usageError(`${flag} must be a positive integer`);
  return n;
}
