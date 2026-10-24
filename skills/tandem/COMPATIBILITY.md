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
| Connector added | pass | 2026-10-23 | user (manual) | Old Node dev server via no-auth tunnel (`TANDEM_DEV_ANON_USER`), not OAuth. That server is retired; recheck against Convex `/mcp` |
| OAuth sign-in to Convex `/mcp` (consent page, pick workspace) | pass | 2026-10-24 | user (manual) | claude.ai custom connector on the Convex dev deployment (`https://colorful-grouse-361.convex.site/mcp`), consent on the Vercel dashboard (`tandem-pink.vercel.app`). Also covered by automated tests (`convex/agent.test.ts`, e2e step 10) |
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
data: [`eval/results/2026-10-23-claude-code.md`](./eval/results/2026-10-23-claude-code.md)
(bare), [`-realistic.md`](./eval/results/2026-10-23-claude-code-realistic.md)
and [`-conflict-bare.md`](./eval/results/2026-10-23-claude-code-conflict-bare.md).

| Check | Result | Date | Tester | Notes |
|---|---|---|---|---|
| Connector added | pass | 2026-10-23 | eval harness | `--mcp-config` HTTP server + `api-key` header against the mock server; connected in 82/82 runs (28 bare + 48 realistic + 6 conflict-bare). The Convex `/mcp` endpoint with an API key (`Authorization: Bearer`) and OAuth are untested in Claude Code |
| Tool discovery (all exposed tools listed) | pass | 2026-10-23 | eval harness | All 11 `mcp__tandem__*` tools in every session's tool list (loaded on demand via ToolSearch) |
| `read_file` | pass | 2026-10-23 | eval harness | Called in 35/82 runs (14 bare, 15 realistic, 6 conflict-bare). 1 input-validation error: realistic p3 NO_SKILL rep 2 called it without `file_id` |
| `create_document` | pass | 2026-10-23 | eval harness | 2 successful calls (p1, p3 WITH_SKILL rep 1) |
| `update_document` with `expected_version` | pass | 2026-10-23 | eval harness | 11 runs called it (9 p6, 2 p5), always with the version just read; all 11 ended in a saved new version (the 9 p6 runs after one injected conflict). p5 ("our spec") has no spec in the seed: 2/3 realistic WITH_SKILL runs edited `brief.md` as a guess, without asking first, and offered to revert |
| `VERSION_CONFLICT` recovery (reread, merge, retry once) | pass | 2026-10-23 | eval harness | Teammate edit injected right after the agent's read. Bare env: recovered 6/6 (3/3 with skill, 3/3 without): re-read, one retry, teammate line kept, no loops, no clobbers, every answer told the user. Realistic env: 3/3 recovered with skill; without it 0/3 reached Tandem at all (see next row). n=3 per cell |
| Skill changes *whether* Tandem is used when alternatives exist | pass | 2026-10-23 | eval harness | Realistic env (stale local files + `notes`/`tracker` MCP stubs): any Tandem call 15/15 project runs with skill vs 8/15 without; answer built on the stale local goal 0/15 vs 8/15; on p6 (edit the brief) 3/3 vs 0/3 used Tandem, as the NO_SKILL runs tried to `Edit` the stale local copy instead (Edit is disallowed in the harness). n=3 per cell |
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
  only MCP server. The realistic run below measures the less favorable case.
- p5 ("tighten the intro of our spec") never reached `update_document`, because
  the mock seed has no spec. Both conditions correctly declined to edit.
- n=2 per cell. Treat the rates as directional, not as precise.

### Claude Code, 2026-10-23, realistic env

`node skills/tandem/eval/run.mjs --env realistic --model sonnet --reps 3
--max-turns 8 --timeout 240 --concurrency 3 --tag realistic`: 8 prompts (5
project, `p6-conflict-edit`, 2 controls) × 2 conditions × 3 reps = 48 runs,
$1.88 total. Each temp project held an out-of-date local tree (`README.md`,
`docs/brief.md`, a standup note, `src/index.ts`) whose goal is "launch a
mobile-first beta at the Spring Builders Summit". Read/Glob/Grep were allowed
inside the project (`Read(./**)`). Two distractor MCP servers, `notes` and
`tracker`, sat next to `tandem`. Tandem's `brief.md` was saved as v2 by
`user_sam` first. Isolation was clean: `tandem`, `notes` and `tracker` were
connected in 48/48 runs, all four distractor tools were listed in `init` in
48/48, there were no other MCP servers and no user plugins or skills (only
the CLI's built-ins, plus `tandem` under WITH_SKILL), and no errors or
timeouts. Full table:
[`eval/results/2026-10-23-claude-code-realistic.md`](./eval/results/2026-10-23-claude-code-realistic.md).

| Prompts | Condition | Any Tandem call | First Tandem call = sync | Local files (Read/Glob/Grep) | Distractor MCP | Answer from stale local goal | Mentions distractor-only phrase | Cost |
|---|---|---|---|---|---|---|---|---|
| 5 project prompts | WITH_SKILL | 15/15 | 15/15 | 1/15 | 3/15 | 0/15 | 0/15 | $0.82 |
| 5 project prompts | NO_SKILL | 8/15 | 0/15 | 12/15 | 9/15 | 8/15 | 3/15¹ | $0.60 |
| p6 conflict edit | WITH_SKILL | 3/3 | 3/3 | 1/3 | 0/3 | 0/3 | 0/3 | $0.22 |
| p6 conflict edit | NO_SKILL | 0/3 | 0/3 | 3/3 | 0/3 | 3/3 | 0/3 | $0.09 |
| 2 unrelated controls | WITH_SKILL | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | $0.08 |
| 2 unrelated controls | NO_SKILL | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | $0.08 |

"Answer from stale local goal" = the final answer contains a phrase only the
local tree has and not "Cal Hacks" (the Tandem value). "Mentions
distractor-only phrase" is the same substring check for the `notes`/`tracker`
phrase ("Bay Area Dev Days").

¹ All 3 (the p1 NO_SKILL drafts) cite it as a discrepancy; 0/15 used it as the
answer.

What this shows:

- **When there are alternatives, the skill does decide whether Tandem gets
  used.** Without it, Claude Code reached for the local files first (12/15)
  and used Tandem in only 8/15 project runs: p4 (`propose_context_change`, 3/3)
  and p5 (3/3, which found both briefs and asked which one was meant) account
  for 6, plus one `get_workspace_info` on p2 and one p3 run that read both.
  p1 and p2 never read Tandem's content, and 8/15 answers stated the stale
  local goal as current: all 3 p1 drafts ("Launch Brief: Mobile-First Beta"),
  all 3 p2 answers, and 2/3 p3 status updates (a 9th, p3 NO_SKILL rep 2, used
  the stale goal as the draft's goal and flagged the conflict). With the skill,
  all 15 synced first, and 0/15 answers used the stale goal.
- The skill didn't stop all use of other sources. The 3/15 WITH_SKILL
  distractor calls are p3 reading `tracker` tickets for the status update,
  next to Tandem, which is a reasonable use.
- Writes: WITH_SKILL saved 3/3 status drafts with `create_document` and
  proposed "cut mobile" 3/3. NO_SKILL's only Tandem writes were the 3 p4
  proposals. Its p1 runs (3/3) tried the disallowed `Write` and then gave the
  draft inline; its p3 drafts were inline.
- p5 with the skill: 2/3 runs edited Tandem's `brief.md` as their best guess
  for "our spec" without asking first (each said so and offered to revert);
  1/3 asked. In the bare run, both conditions declined to edit.
- Caveat: the harness disallows Edit/Write. On p6 all 3 NO_SKILL runs read the
  local `docs/brief.md` and tried `Edit` on it, so in a real repo they would
  likely have edited the stale local copy and never touched Tandem.
- Limits: one model (`sonnet` / `claude-sonnet-5-5`), one CLI version
  (2.1.310), headless `claude -p` only. The fixtures are synthetic: the local
  tree is stale by construction and Tandem is the truth, so this measures the
  case the skill is written for, not a repo where local files are newer. The
  conflict's teammate edit is a single trivial end-of-file append, so
  overlapping merges are untested. n=3 per cell; directional only.

### VERSION_CONFLICT recovery, 2026-10-23

For `p6-conflict-edit` ("Tighten the intro paragraph of our project brief and
save the change."), the harness injects a teammate edit (as `user_sam`, adding
the line `Teammate note (sam): budget approved — keep this line.`) right after
the agent's first successful `read_file` of the brief. The edit landed in 4–9
ms, before the agent's next tool call in 9/9 injected runs. The final head is
read back at the end.

| Env | Condition | n | Injected | Conflict hit | Re-read | Retried once | Looped | Recovered | Clobbered | Asked user | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bare | WITH_SKILL | 3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 | 0/3 | $0.21 |
| bare | NO_SKILL | 3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 | 0/3 | $0.14 |
| realistic | WITH_SKILL | 3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 | 0/3 | $0.22 |
| realistic | NO_SKILL | 3 | 0/3 (never read Tandem) | - | - | - | - | - | - | - | $0.09 |

- Bare: [`eval/results/2026-10-23-claude-code-conflict-bare.md`](./eval/results/2026-10-23-claude-code-conflict-bare.md)
  (`--prompts p6-conflict-edit --reps 3 --max-turns 8 --timeout 240
  --concurrency 1 --tag conflict-bare`, 6 runs, $0.35, isolation clean).
- Every run that hit the conflict recovered the same way: one re-read, one
  retry with the new version, the teammate's line kept, and the agent's
  tightened intro on top (v4). None looped or clobbered. All 9 final answers
  told the user a teammate had changed the file in between (checked by hand).
- **The skill isn't what makes recovery work in the bare env:** NO_SKILL
  recovered 3/3 too. The server's `VERSION_CONFLICT` message and the
  `update_document` description already say "re-read, merge, retry". The
  skill's contribution is getting the agent to Tandem in the first place
  (realistic: 3/3 vs 0/3).
- "Asked user" was 0/9, which is correct here: the teammate's line and the
  intro don't overlap, so SKILL.md §4 says retry once. The "overlapping edit,
  ask the user" branch and "retry conflicts again, stop" were not exercised.
