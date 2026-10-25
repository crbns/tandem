"use client";

import { mcpEndpoint } from "@/lib/assistants";
import { CopyButton } from "./CopyButton";

/** Where the hook script lives in the Tandem repo (docs/claude-code-hooks.md). */
const HOOK_SCRIPT = "integrations/claude-code/tandem-activity-hook.mjs";
const SCRIPT_PLACEHOLDER = "/ABS/PATH/tandem-activity-hook.mjs";
const TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash";

/**
 * Claude Code settings that send this connection's activity to Tandem. Mirrors
 * integrations/claude-code/settings.example.json, with the URL and key filled in.
 */
export function claudeCodeHooksSettings(baseUrl: string, token: string): string {
  const hook = [{ type: "command", command: `node ${SCRIPT_PLACEHOLDER}`, timeout: 5, async: true }];
  return JSON.stringify(
    {
      env: { TANDEM_MCP_URL: mcpEndpoint(baseUrl), TANDEM_API_KEY: token },
      hooks: {
        SessionStart: [{ hooks: hook }],
        UserPromptSubmit: [{ hooks: hook }],
        PostToolUse: [{ matcher: TOOL_MATCHER, hooks: hook }],
        PostToolUseFailure: [{ matcher: TOOL_MATCHER, hooks: hook }],
        Stop: [{ hooks: hook }],
      },
    },
    null,
    2,
  );
}

/** Optional Claude Code activity hooks, shown with a freshly created key. */
export function ClaudeCodeHooksSetup({ mcpUrl, token }: { mcpUrl: string; token: string }) {
  const settings = claudeCodeHooksSettings(mcpUrl, token);
  return (
    <details className="group grid gap-3 rounded-md border bg-card px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Claude Code activity hooks <span className="font-normal text-muted-foreground">(optional)</span>
      </summary>
      <div className="mt-3 grid gap-3">
        <p className="text-muted-foreground">
          Lets Tandem see what this Claude Code session edits and runs (files, commands, test results), so
          teammates&apos; assistants get it at their next sync without anyone writing a status update. Tandem never
          receives file contents, full command output or your transcript, and prompts stay on your machine unless you
          also set <code className="font-mono text-xs">TANDEM_CAPTURE_PROMPTS=1</code>.
        </p>
        <ol className="grid list-decimal gap-1.5 pl-5 text-muted-foreground">
          <li>
            Copy <code className="font-mono text-xs">{HOOK_SCRIPT}</code> from the Tandem repo to your machine (Node
            18 or later).
          </li>
          <li>
            Paste this into <code className="font-mono text-xs">.claude/settings.local.json</code> in your project
            (it holds the key, so keep it out of git) and replace{" "}
            <code className="font-mono text-xs">{SCRIPT_PLACEHOLDER}</code> with the script&apos;s absolute path.
          </li>
          <li>
            Restart Claude Code. If nothing shows up, run it with{" "}
            <code className="font-mono text-xs">TANDEM_HOOK_DEBUG=1</code> and see docs/claude-code-hooks.md.
          </li>
        </ol>
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          {settings}
        </pre>
        <CopyButton value={settings} label="Copy settings" />
      </div>
    </details>
  );
}
