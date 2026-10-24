# Tandem client compatibility

Measured results only. Nothing here has been tested yet. Replace `untested`
with `pass`, `fail`, `partial`, or `n/a`, and fill in Date, Tester, and Notes.
Note the client version and plan in Notes.

Plan context as of Oct 2026 (see `AGENTS.md`): Claude remote MCP connectors
work on all plans. ChatGPT full write MCP is Business/Enterprise/Edu beta only
(Pro is read-only, Plus isn't viable). Gemini custom MCP apps have eligibility
limits.

## Checklist

### Claude web

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
