// Brings up the two live processes the scenario needs:
// - the local Convex deployment (reused when it's already serving, otherwise
//   `convex dev` is started from packages/backend and stopped afterwards), and
// - the real MCP server (apps/mcp, TANDEM_BACKEND=convex) on a free port.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    convexUrl: string;
    mcpUrl: string;
  }
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const backendDir = `${repoRoot}packages/backend`;
const mcpDir = `${repoRoot}apps/mcp`;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
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
  const convexUrl = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
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

  const port = await freePort();
  const mcpEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TANDEM_BACKEND: "convex",
    CONVEX_URL: convexUrl,
    HOST: "127.0.0.1",
    PORT: String(port),
  };
  // Mock-only settings; the Convex backend refuses to start with anon mode.
  delete mcpEnv.TANDEM_DEV_TOKENS;
  delete mcpEnv.TANDEM_DEV_ANON_USER;
  const mcp = await start("mcp", `${mcpDir}/node_modules/.bin/tsx`, ["src/index.ts"], {
    cwd: mcpDir,
    env: mcpEnv,
    ready: /listening on http/,
    timeoutMs: 60_000,
  });

  project.provide("convexUrl", convexUrl);
  project.provide("mcpUrl", `http://127.0.0.1:${port}/mcp`);

  return () => {
    stop(mcp);
    stop(convex);
  };
}
