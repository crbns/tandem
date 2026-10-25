# Claude Code activity hooks

Optional. With these hooks installed, Claude Code reports what a session
edits and runs to Tandem, and Tandem's context manager turns it into the
`observed` section of every `sync_workspace` result
(`docs/context-intelligence.md`). Teammates' assistants then see "Sam's
assistant is implementing JWT auth; tests pass (verified)" at their next sync,
without anyone writing a status update.

MCP tool calls are recorded server-side whether or not the hooks are
installed. The hooks add what happens *outside* Tandem's tools: file edits,
shell commands, and test/build results.

Files: `integrations/claude-code/`

| File | What it is |
| --- | --- |
| `tandem-activity-hook.mjs` | The hook. Node ≥ 18, no dependencies. Reads the hook JSON on stdin, POSTs a redacted summary, prints nothing, always exits 0. |
| `settings.example.json` | The Claude Code `hooks` (and `env`) config to paste. |
| `replay.mjs`, `demo-events.jsonl` | Development-only simulator (see [Replay](#replay-simulated-development-only)). |
| `tandem-activity-hook.test.mjs` | `pnpm --filter @repo/claude-code-hooks test` (also part of `pnpm test`), or `node --test integrations/claude-code/*.test.mjs` |

## Setup

1. **Create an API key** on the workspace's **Assistants** page. With
   Claude (or Other) selected, the key dialog shows the `claude mcp add`
   command and, under **Claude Code activity hooks**, a settings snippet with
   this deployment's URL and the new key already filled in.
2. **Connect Claude Code** with the command from step 1, as in
   `skills/tandem/README.md` → "Claude Code":

   ```sh
   claude mcp add --scope project --transport http tandem https://<deployment>.convex.site/mcp \
     --header "Authorization: Bearer mcp_sk_…"
   ```

   The hooks use the same `mcp_sk_` key, so the activity is attributed to that
   same assistant connection and workspace.
3. **Copy the hook script** somewhere stable on your machine, for example
   `~/.claude/hooks/tandem-activity-hook.mjs`, and note its absolute path.
4. **Set the environment.** Either keep the `env` block of the snippet or
   export the variables in the shell that starts Claude Code:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `TANDEM_API_KEY` | yes | The `mcp_sk_…` key from step 1. |
   | `TANDEM_MCP_URL` | yes* | `https://<deployment>.convex.site/mcp`. The hook posts to the same host at `/activity/claude-code`. |
   | `TANDEM_ACTIVITY_URL` | no | Full endpoint URL; overrides the one derived from `TANDEM_MCP_URL` (*then `TANDEM_MCP_URL` isn't needed). |
   | `TANDEM_CAPTURE_PROMPTS` | no | `1` to send your prompt text. Off by default. |
   | `TANDEM_HOOK_DEBUG` | no | `1` to log each event and the HTTP result to stderr. |

   Hook processes inherit Claude Code's environment. A settings `env` block in
   project or local settings applies only after you trust the folder, and the
   docs don't say explicitly that hooks get it (not verified here); if the
   debug log says the variables are missing, export them in the shell instead.

5. **Paste the hooks config** into `.claude/settings.local.json` in the
   project (it holds the key, so keep it out of git; `.claude/settings.json`
   works too if you move the key into your shell environment instead). Replace
   `/ABS/PATH/tandem-activity-hook.mjs` with the path from step 3. If the file
   already has `hooks`, merge the five events into it.
6. Restart Claude Code (or open `/hooks` to check they're loaded) and do some
   work. The Live page shows the events, and the next `sync_workspace` carries
   what the context manager made of them.

### The config

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node /ABS/PATH/tandem-activity-hook.mjs", "timeout": 5, "async": true }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node /ABS/PATH/tandem-activity-hook.mjs", "timeout": 5, "async": true }] }],
    "PostToolUse":        [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "node /ABS/PATH/tandem-activity-hook.mjs", "timeout": 5, "async": true }] }],
    "PostToolUseFailure": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "node /ABS/PATH/tandem-activity-hook.mjs", "timeout": 5, "async": true }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "node /ABS/PATH/tandem-activity-hook.mjs", "timeout": 5, "async": true }] }]
  }
}
```

Checked against the Claude Code hooks reference
(<https://code.claude.com/docs/en/hooks>) on 2026-10-24:

- All five event names exist, including `PostToolUseFailure` (fires when a
  tool fails; a Bash command that exits non-zero arrives here with an
  `error` whose first line is `Exit code N`).
- `matcher` filters tool events by tool name (`Edit|Write` is an exact-name
  list). `SessionStart` matches on its `source`; omitted means all.
  `UserPromptSubmit` and `Stop` take no matcher.
- `async: true` is supported on `type: "command"` hooks: the hook runs in the
  background and never blocks Claude. Claude Code doesn't enforce `timeout`
  on async hooks; the script has its own 2.5 s network timeout and a hard exit
  shortly after, so `timeout: 5` only matters if you drop `async`.
- `timeout` is in seconds.
- On `SessionStart` and `UserPromptSubmit`, plain-text stdout is added to
  Claude's context, which is why the script never writes to stdout. Exit code
  2 blocks on some events, which is why it always exits 0.
- `PostToolUse` for Bash has `tool_response` `{ stdout, stderr, interrupted,
  isImage }` (no exit code: success means exit 0); Edit/Write have
  `tool_input.file_path`; MCP tools are named `mcp__<server>__<tool>`.

`MultiEdit` is kept in the matcher for older Claude Code versions; matching a
tool that doesn't exist is harmless.

## What is captured

One small JSON event per hook, POSTed to
`POST https://<deployment>.convex.site/activity/claude-code` with
`Authorization: Bearer <key>` (the endpoint answers 202; the key decides the
workspace, never the body):

| Field | Source |
| --- | --- |
| `event_id` | sha256 of session id, hook, tool_use_id and time (idempotency) |
| `hook_event_name`, `session_id`, `occurred_at` (ms) | every event |
| `cwd_name` | the **basename** of the working directory only |
| `tool_name`, `tool_use_id` | tool events |
| `file_paths` | `file_path` / `notebook_path` / `path` from the tool input, relative to the project (or `~/…`) |
| `command` | Bash command, ≤ 300 chars |
| `success`, `exit_code` | tool events (`exit_code` for Bash) |
| `output_tail` | last ≤ 500 chars of stdout/stderr (or the failure text), **only** for test, build, type-check, lint, deploy and git commands |
| `error` | failure text, ≤ 300 chars |
| `prompt`, `prompt_captured` | `UserPromptSubmit`: the prompt (≤ 2000 chars) only with `TANDEM_CAPTURE_PROMPTS=1`; otherwise just `prompt_captured: false` |

Everything text-like is redacted on your machine before sending (and again on
the server): `mcp_sk_…` and `sk-ant-…` keys, `Bearer …` tokens, JWTs, AWS
access keys, private key blocks, and `key=value` / `"key": "value"` pairs whose
name looks like a password, secret, token, API key, access key or credential.

**Never captured:** the transcript (`transcript_path` or its contents), file
contents (Write `content`, Edit `old_string`/`new_string`), full tool output,
output of ordinary commands, Claude's replies (`last_assistant_message`), or
the full working-directory path.

**Skipped entirely:** Tandem's own MCP tools (any `tool_name` matching
`/^mcp__.*tandem.*__/i`; the server already records those calls, and
reporting them again would loop) and `Read`, `Grep`, `Glob`, `LS` (noise).

### Prompts are opt-in

Without `TANDEM_CAPTURE_PROMPTS=1` Tandem learns only that a prompt was
submitted, which marks the start of a request. With it, the prompt text lets
the context manager record what the assistant was *asked* to do (evidence
level `requested`). Turn it on only if you're comfortable with your
teammates' assistants seeing what you ask for on this project; it never
includes the rest of the conversation.

## Troubleshooting

Run Claude Code with `TANDEM_HOOK_DEBUG=1` in its environment; each hook then
logs to stderr (visible in the debug log: start with `claude --debug`, or type `/debug` in a new session), for example:

```
[tandem-hook] event {"event_id":"…","hook_event_name":"PostToolUse",…}
[tandem-hook] POST https://…convex.site/activity/claude-code -> 202
```

Or test the script by hand:

```sh
echo '{"hook_event_name":"PostToolUse","session_id":"s1","cwd":"/tmp/proj","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"pnpm test"},"tool_response":{"stdout":"5 passed","stderr":""}}' \
  | TANDEM_HOOK_DEBUG=1 TANDEM_API_KEY=mcp_sk_… TANDEM_MCP_URL=https://<deployment>.convex.site/mcp \
    node /ABS/PATH/tandem-activity-hook.mjs
```

| Symptom | Fix |
| --- | --- |
| `not sent: set TANDEM_API_KEY and TANDEM_MCP_URL` | The variables aren't reaching the hook; set them in `env` or the shell that starts Claude Code. |
| `-> 401` | The key was revoked or mistyped; create a new one on the Assistants page. |
| `-> 404` | Wrong host, or `TANDEM_MCP_URL` doesn't end in `/mcp`; set `TANDEM_ACTIVITY_URL` explicitly. |
| `failed: TimeoutError` / `fetch failed` | Network or deployment unreachable. Claude Code is unaffected; the event is dropped. |
| `skipped` | Expected for Tandem's own tools, reads/searches and other hook events. |
| Nothing logged | Check `/hooks` lists the five events and the script path is absolute. |

## Replay (simulated, development only)

`replay.mjs` sends a JSONL file of hook inputs (one stdin payload per line)
through the same `buildEvent` as the real hook, with `simulated: true` on
every event. The dashboard labels these **simulator**; they are never real
assistant activity and should only be used for demos and development.

```sh
export TANDEM_API_KEY=mcp_sk_… TANDEM_MCP_URL=https://<deployment>.convex.site/mcp
node integrations/claude-code/replay.mjs                      # demo-events.jsonl, 1.2 s apart
node integrations/claude-code/replay.mjs my-events.jsonl --delay 300
node integrations/claude-code/replay.mjs --batch               # one POST with { events: [...] }
node integrations/claude-code/replay.mjs --dry-run             # print the payloads, send nothing
TANDEM_CAPTURE_PROMPTS=1 node integrations/claude-code/replay.mjs   # include the scripted prompt
```

`demo-events.jsonl` scripts the demo: Agent A (session `demo-agent-a`) is
asked to implement JWT authentication, writes `src/auth/jwt.ts`, edits the
login route, adds tests, runs `pnpm test src/auth` (1 failing), fixes
`jwt.ts`, reruns the tests (5 passing), commits, and stops, which is where it
tells its user it's done. The context manager should record the task with
`verified` evidence from the passing run, not just the assistant's claim.
Each run generates fresh `event_id`s, so a replay is never deduplicated
against an earlier one.
