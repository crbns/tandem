# Tandem client compatibility

Measured results only. Replace `untested` with `pass`, `fail`, `partial`, or
`n/a`, and fill in Date, Tester, and Notes. Note the client version and plan in
Notes. Claude Code rows come from the automated harness in
[`eval/`](./eval/) (see [Measured results](#measured-results)); anything it did
not exercise stays `untested`.

Plan context as of Oct 2026 (see `AGENTS.md`): Claude remote MCP connectors
work on all plans. ChatGPT full write MCP is Business/Enterprise/Edu beta only
(Pro is read-only, Plus isn't viable). Gemini custom MCP apps have eligibility
limits.

## Checklist

### Claude web

| Check | Result | Date | Tester | Notes |
|---|---|---|---|---|
| Connector added | pass | 2026-10-23 | user (manual) | Dev server via no-auth tunnel (`TANDEM_DEV_ANON_USER`), not OAuth |
| Tool discovery (all exposed tools listed) | pass | 2026-10-23 | user (manual) | All 4 tools that existed then worked, including a `VERSION_CONFLICT` response. Later tools (11 total now) not rechecked on web |
| `read_file` | untested | | | |
| `create_document` | untested | | | |
| `update_document` with `expected_version` | untested | | | |
| `VERSION_CONFLICT` recovery (reread, merge, retry once) | untested | | | |
| Skill installed | untested | | | |
| Skill auto-invokes sync in fresh chat without mentioning Tandem | untested | | | |
| Write-confirmation prompts (does the client ask before write tools?) | untested | | | |
| Plan required | untested | | | |

### Claude desktop

| Check | Result | Date | Tester | Notes |
|---|---|---|---|---|
| Connector added | untested | | | |
| Tool discovery (all exposed tools listed) | untested | | | |
| `read_file` | untested | | | |
| `create_document` | untested | | | |
| `update_document` with `expected_version` | untested | | | |
| `VERSION_CONFLICT` recovery (reread, merge, retry once) | untested | | | |
| Skill installed | untested | | | |
| Skill auto-invokes sync in fresh chat without mentioning Tandem | untested | | | |
| Write-confirmation prompts (does the client ask before write tools?) | untested | | | |
| Plan required | untested | | | |

### Claude Code

Measured via `skills/tandem/eval` on 2026-10-23: Claude Code CLI 2.1.310,
headless `claude -p`, model `sonnet` (`claude-sonnet-5-5`), mock backend. Raw
data: [`eval/results/2026-10-23-claude-code.md`](./eval/results/2026-10-23-claude-code.md).

| Check | Result | Date | Tester | Notes |
|---|---|---|---|---|
| Connector added | pass | 2026-10-23 | eval harness | `--mcp-config` HTTP server + `api-key` header; connected in 28/28 runs. OAuth untested |
| Tool discovery (all exposed tools listed) | pass | 2026-10-23 | eval harness | All 11 `mcp__tandem__*` tools in every session's tool list (loaded on demand via ToolSearch) |
| `read_file` | pass | 2026-10-23 | eval harness | Called in 14 runs, no errors |
| `create_document` | pass | 2026-10-23 | eval harness | 2 successful calls (p1, p3 WITH_SKILL rep 1) |
| `update_document` with `expected_version` | untested | | | Never called: seed has no spec, so p5 stopped and asked |
| `VERSION_CONFLICT` recovery (reread, merge, retry once) | untested | | | Not exercised by the harness |
| Skill installed | pass | 2026-10-23 | eval harness | Project-scoped `.claude/skills/tandem` (only `SKILL.md`); listed in `init.skills` in 14/14 WITH_SKILL runs |
| Skill auto-invokes sync in fresh chat without mentioning Tandem | pass | 2026-10-23 | eval harness | `sync_workspace` first in 10/10 project runs with skill vs 0/10 without; 0/4 tool calls on unrelated controls in both conditions |
| Write-confirmation prompts (does the client ask before write tools?) | untested | | | Headless runs pre-approve `mcp__tandem__*`; interactive prompting not measured |
| Plan required | untested | | | Ran on a logged-in subscription account; plan dependence not tested |

### ChatGPT

| Check | Result | Date | Tester | Notes |
|---|---|---|---|---|
| Connector added | untested | | | |
| Tool discovery (all exposed tools listed) | untested | | | |
| `read_file` | untested | | | |
| `create_document` | untested | | | Write needs Business/Enterprise/Edu beta |
| `update_document` with `expected_version` | untested | | | Write needs Business/Enterprise/Edu beta |
| `VERSION_CONFLICT` recovery (reread, merge, retry once) | untested | | | |
| Skill installed | untested | | | No SKILL.md loader; instructions fallback |
| Skill auto-invokes sync in fresh chat without mentioning Tandem | untested | | | |
| Write-confirmation prompts (does the client ask before write tools?) | untested | | | |
| Plan required | untested | | | |

### Gemini

| Check | Result | Date | Tester | Notes |
|---|---|---|---|---|
| Connector added | untested | | | Custom MCP eligibility limits |
| Tool discovery (all exposed tools listed) | untested | | | |
| `read_file` | untested | | | |
| `create_document` | untested | | | |
| `update_document` with `expected_version` | untested | | | |
| `VERSION_CONFLICT` recovery (reread, merge, retry once) | untested | | | |
| Skill installed | untested | | | No SKILL.md loader; Gem instructions fallback |
| Skill auto-invokes sync in fresh chat without mentioning Tandem | untested | | | |
| Write-confirmation prompts (does the client ask before write tools?) | untested | | | |
| Plan required | untested | | | |

## Fresh-chat auto-invocation test protocol

Goal: measure whether the skill makes the assistant reach for Tandem on its own.

Setup:

1. Seed the workspace with at least one canonical doc (e.g. `launch-plan.md`)
   and an approved goal.
2. Connector added and authenticated; skill installed and enabled.
3. Open a **new** chat for each prompt. Don't mention Tandem, the workspace,
   MCP, or the skill. Don't attach files.

Prompts (send one per fresh chat, verbatim):

1. "Draft a one-page brief for our launch plan that I can share with the team."
2. "What's our current project goal, and who owns which parts?"
3. "Write this week's status update for the project."
4. "We've decided to cut the mobile app from v1. Can you record that?"
5. "Tighten up the intro section of our spec."

Record for each prompt:

| # | Client | Skill activated? | First Tandem tool called (`sync_workspace` / `list_files` / none) | Read canonical file before answering? | Correct write path? | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | `create_document`, or asks before publishing | |
| 2 | | | | | n/a (read-only) | |
| 3 | | | | | asks before `publish_work` | |
| 4 | | | | | `propose_context_change`, reported as pending | |
| 5 | | | | | `read_file` then `update_document` with `expected_version` | |

Run each prompt at least twice per client, since activation is probabilistic.
Report activation as N of M runs, not as yes or no.

## Measured results

### Claude Code, 2026-10-23

`node skills/tandem/eval/run.mjs --model sonnet --reps 2`: 7 prompts × 2
conditions × 2 reps = 28 headless runs, with the `SKILL.md` that states saved
files are visible to every member (§5). Each run had a fresh mock server and an
empty temp project dir. Isolation was clean: only the `tandem` MCP server, no
user plugins, skills, or MCP servers, no errors or timeouts, no subagent tool
calls. `--setting-sources project` keeping out the user's `CLAUDE.md` and
memory was verified separately by the Step C reviewer's manual probe on
2026-10-23. Full table:
[`eval/results/2026-10-23-claude-code.md`](./eval/results/2026-10-23-claude-code.md).

| Prompts | Condition | Skill invoked | Any Tandem call | Sync attempted | First Tandem call = sync | Write attempted | CLI errors/timeouts (legacy) |
|---|---|---|---|---|---|---|---|
| 5 project prompts | WITH_SKILL | 10/10 | 10/10 | 10/10 | 10/10 | 4/10 | 0/10 |
| 5 project prompts | NO_SKILL | 0/10 | 10/10 | 0/10 | 0/10 | 2/10 | 0/10 |
| 2 unrelated controls | WITH_SKILL | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 |
| 2 unrelated controls | NO_SKILL | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 |

The historical table counts attempted sync/write calls. The committed JSON
contains analyzed calls and tool errors, but omits raw tool-result events, so
it cannot prove successful syncs under the updated harness; the committed
results were left unchanged and no paid trials were rerun. Its legacy error
column counts CLI errors/timeouts only (the recorded `tandem_errors` arrays
are all empty).

New harness summaries distinguish `sync`/`write` (attempted) from
`sync_ok`/`write_ok` (at least one matching non-error tool result). `tool_errors`
counts trials with one or more Tandem MCP errors, even when the final answer
succeeds. `errors_or_timeouts` includes tool errors, CLI failures (including
nonzero exit or missing final result), and timeouts. First-call order measures
attempts, and all trials remain in the denominator.

What the numbers do and don't show:

- **Without the skill, Claude Code still used Tandem in 10/10 project runs.** In
  this setup the tool descriptions alone are enough to get Tandem tools used.
  The skill did not decide whether Tandem gets used. It changed how: with it,
  every run synced first and read the approved context. Without it, no run
  synced. NO_SKILL paths varied: p4 went straight to `propose_context_change`;
  the other 8 runs found `brief.md` via `list_files` (all 8), plus
  `get_workspace_info` (p2, p3) or `search_files` (p1, one p5 run), and then
  read it.
  They answered from `brief.md` alone, missing the approved goal and ownership.
- Drafts (p1, p3): with the skill, 2/4 were saved with `create_document` and
  not announced with `publish_work`; the other 2 drafted inline and asked
  before saving. Without the skill, 0/4 were saved.
- **Visibility statements:** 0 of the 2 WITH_SKILL `create_document` runs
  claimed the doc was hidden from teammates; both said every workspace member
  can see it now. The 2 unsaved WITH_SKILL drafts also said saving would make
  it visible to every member. (The pre-fix skill told the user a saved doc was
  not visible to the team in 2 of 4 `create_document` runs.)
- Both conditions sent "cut mobile" through `propose_context_change` and
  reported it as pending (4/4).
- The setup is favorable to Tandem: an empty project dir with Tandem as the
  only MCP server. In a real repo with local files or other connectors, the
  baseline (and maybe the skill) may use Tandem less. That isn't measured here.
- p5 ("tighten the intro of our spec") never reached `update_document`, because
  the mock seed has no spec. Both conditions correctly declined to edit.
- n=2 per cell. Treat the rates as directional, not as precise.
