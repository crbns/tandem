// Brings up the live process the scenario needs: the local Convex deployment
// (reused when it's already serving, otherwise `convex dev` is started from
// packages/backend and stopped afterwards). The MCP server is part of it:
// @convex-dev/mcp serves /mcp from the deployment's HTTP actions origin
// (MCP_URL overrides it, e.g. for a deployed endpoint).
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    convexUrl: string;
    mcpUrl: string;
  }
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const backendDir = `${repoRoot}packages/backend`;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The HTTP actions origin for a deployment URL: CONVEX_SITE_URL when set,
 * `.convex.site` for a cloud `.convex.cloud` URL, and the next port for a
 * local backend (3210 serves the API, 3211 HTTP actions).
 */
function siteUrlFor(convexUrl: string): string {
  if (process.env.CONVEX_SITE_URL) return process.env.CONVEX_SITE_URL.replace(/\/+$/, "");
  const url = new URL(convexUrl);
  if (url.hostname.endsWith(".convex.cloud")) {
    url.hostname = url.hostname.replace(/\.convex\.cloud$/, ".convex.site");
  } else {
    url.port = String(Number(url.port) + 1);
  }
  return url.origin;
}

/** Spawns a process in its own group and resolves once `ready` appears in its output. */
function start(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; ready: RegExp; timeoutMs: number },
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      stop(child);
      reject(new Error(`${name} not ready after ${options.timeoutMs}ms:\n${output}`));
    }, options.timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${chunk}`);
      if (options.ready.test(output)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited (${code}) before it was ready:\n${output}`));
    });
  });
}

function stop(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export default async function setup(project: TestProject) {
  // Each worktree can have its own local backend ports. Read its configuration
  // before falling back to the conventional port, so we test the right functions.
  const envPath = `${backendDir}/.env.local`;
  const backendEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  const convexUrl = process.env.CONVEX_URL ?? backendEnv.CONVEX_URL ?? backendEnv.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
  let convex: ChildProcess | undefined;
  if (!(await reachable(convexUrl))) {
    if (process.env.CONVEX_URL)
      throw new Error(`Convex is not reachable at CONVEX_URL=${convexUrl}`);
    // The local anonymous deployment from docs/local-dev.md. It also pushes the
    // current functions before reporting ready.
    convex = await start("convex", `${backendDir}/node_modules/.bin/convex`, ["dev"], {
      cwd: backendDir,
      env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
      ready: /Convex functions ready/,
      timeoutMs: 150_000,
    });
  }

  project.provide("convexUrl", convexUrl);
  project.provide("mcpUrl", process.env.MCP_URL ?? `${siteUrlFor(convexUrl)}/mcp`);

  return () => {
    stop(convex);
  };
}
