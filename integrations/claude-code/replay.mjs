#!/usr/bin/env node
// Development only: replays a JSONL file of Claude Code hook inputs (one
// stdin payload per line) against Tandem's activity endpoint, through the same
// buildEvent as the real hook, with `simulated: true` on every event. The
// dashboard labels these "simulator"; they are never real assistant activity.
//
//   node integrations/claude-code/replay.mjs [file.jsonl] [--delay 1200] [--batch] [--dry-run]
//
// Uses the hook's env (TANDEM_API_KEY, TANDEM_MCP_URL or TANDEM_ACTIVITY_URL,
// TANDEM_CAPTURE_PROMPTS). Defaults to demo-events.jsonl next to this file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activityUrl, buildEvent, sendEvents } from "./tandem-activity-hook.mjs";

function parseArgs(argv) {
  const opts = {
    file: fileURLToPath(new URL("./demo-events.jsonl", import.meta.url)),
    delayMs: 1200,
    batch: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--delay") opts.delayMs = Number(argv[++i]);
    else if (arg === "--batch") opts.batch = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else opts.file = arg;
  }
  if (!Number.isFinite(opts.delayMs) || opts.delayMs < 0) throw new Error("--delay takes milliseconds");
  return opts;
}

/** Hook inputs from JSONL, skipping blank lines and # comments. */
export function readInputs(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`line ${i + 1} is not JSON`);
      }
    });
}

/** Simulated events, in order, with increasing occurred_at from `start`. */
export function simulatedEvents(inputs, env, start = Date.now()) {
  return inputs
    .map((input, i) => buildEvent(input, env, start + i))
    .filter(Boolean)
    .map((event) => ({ ...event, simulated: true }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: replay.mjs [file.jsonl] [--delay ms] [--batch] [--dry-run]");
    return;
  }
  const env = process.env;
  const inputs = readInputs(readFileSync(opts.file, "utf8"));
  if (opts.dryRun) {
    for (const event of simulatedEvents(inputs, env)) console.log(JSON.stringify(event));
    return;
  }
  const url = activityUrl(env);
  if (!url || !env.TANDEM_API_KEY) {
    console.error("Set TANDEM_API_KEY and TANDEM_MCP_URL (or TANDEM_ACTIVITY_URL).");
    process.exitCode = 1;
    return;
  }
  console.log(`Replaying ${inputs.length} simulated hook events from ${opts.file} to ${url}`);
  if (opts.batch) {
    const events = simulatedEvents(inputs, env);
    console.log(`batch of ${events.length}: ${(await sendEvents({ events }, env)) ?? "failed"}`);
    return;
  }
  for (const [i, input] of inputs.entries()) {
    const [event] = simulatedEvents([input], env);
    if (!event) {
      console.log(`${i + 1}. ${input.hook_event_name} ${input.tool_name ?? ""} skipped`);
      continue;
    }
    const status = await sendEvents(event, env);
    console.log(`${i + 1}. ${event.hook_event_name} ${event.tool_name ?? ""} -> ${status ?? "failed"}`);
    if (i < inputs.length - 1 && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
