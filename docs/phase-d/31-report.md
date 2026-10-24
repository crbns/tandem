# Issue #31 / D12 — real-client measurement report

Date: 2026-10-24. Scope delivered: external-server eval support, measured Claude
Code CLI against isolated local Convex, committed evidence, and a manual GUI
protocol. **The original issue's two-native-client acceptance remains BLOCKED
(human): no Claude web/desktop or second-vendor end-to-end run was measured by
this worker.** This report does not claim issue #31 can be closed.

## Every issue task

| Issue task                                                                                           | Status                                                            | Evidence / remaining action                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude web and desktop: connector + packaged skill, read/create/update and VERSION_CONFLICT recovery | BLOCKED (human)                                                   | GUI accounts and human interaction not available in this dispatched CLI task. `skills/tandem/TESTING.md` has installation, OAuth/workspace selection, copy-paste prompts, deterministic stale-write staging and head/revision checks. Claude Code is measured separately below.                                                              |
| Measure automatic `sync_workspace` in clean chats that never mention Tandem                          | PASS for Claude Code; BLOCKED for GUI clients                     | `p2-goal-owners`, 3 fresh chats per condition: successful sync and first Tandem call = sync 3/3 WITH_SKILL and 3/3 NO_SKILL. Explicit skill invocation 1/3 WITH_SKILL. All 6 conflict chats also sync first; kept separate from the read-only rate. No measured skill advantage in this setup.                                               |
| Record write-confirmation prompts and plan required                                                  | BLOCKED (human)                                                   | CLI uses pre-approved MCP tools in `dontAsk` mode; no permission denials, but this cannot establish interactive prompt behavior. Existing authenticated CLI account was used; exact plan/minimum eligibility unmeasured. Manual protocol records wording, approval scope and exact plan.                                                     |
| Second client: confirm qualifying accounts and run same checks                                       | BLOCKED (human)                                                   | Coordinator states no ChatGPT/Gemini account eligibility information is available. All GUI clients remain PENDING; protocol explains checking write-tool eligibility and native skill versus instructions fallback.                                                                                                                          |
| Add external URL and key flags to eval harness                                                       | DONE / PASS                                                       | `--mcp-url`, `--mcp-key`, optional `--mcp-teammate-key`, `--brief-id`, plus `TANDEM_MCP_URL`, `TANDEM_MCP_KEY`, `TANDEM_MCP_TEAMMATE_KEY`, `TANDEM_BRIEF_ID`. External mode skips mock build/spawn, uses Bearer auth, supports JSON/SSE responses, requires serial/bare trials and a real brief ID for conflict tests. Mock remains default. |
| COMPATIBILITY.md measured results, backup footage and screenshots                                    | DONE for measured matrix; BLOCKED (human) for footage/screenshots | Matrix rewritten around this session's measured Convex results; historical mock artifacts retained as archives, GUI rows PENDING. Terminal JSON/Markdown and independent readback committed; these are not footage. TESTING.md specifies exact screenshot/video evidence to capture.                                                         |
| Acceptance: two native clients verified end to end                                                   | BLOCKED (human)                                                   | One native client (Claude Code CLI) verified. A second model/credential/condition or claude.ai connector bridge does not establish a second GUI client.                                                                                                                                                                                      |

## Implementation and measurement

`gh issue view 31` read before implementation. No backend source files were
changed. Work stays within `skills/tandem/**` and this explicitly owned report.
`skills/package.sh` and SKILL.md already satisfy packaging/skill requirements;
no changes were needed. Existing committed `p6-conflict-edit` already exercises
update_document and recovery; added `p7-create-document` for an explicitly
authorized create/read check.

Local-only setup:

```sh
cd packages/backend
CONVEX_AGENT_MODE=anonymous pnpm exec convex dev \
  --local-cloud-port 3240 --local-site-port 3241
# From repository root (after local deployment was confirmed):
pnpm demo:reset --json
```

Convex 1.46.0 configured an anonymous deployment at `http://127.0.0.1:3240`,
MCP `http://127.0.0.1:3241/mcp`; all functions/components became ready. The
initial `convex dev --local` attempt was rejected by the installed CLI as
deprecated; the command above worked. Seed stdout was kept only in a private
temporary file, never committed. Alex's API key acts as the measured client;
Blake's key injects teammate edits.

`claude mcp add --scope project --transport http tandem <local-mcp-url>
--header 'Authorization: Bearer <private-key>'` succeeded in a temporary
directory. Its `.mcp.json` was checked, project `.claude/skills/tandem/SKILL.md`
installed, then `claude mcp remove --scope project tandem` succeeded and the
directory was removed. Neither add nor remove used global scope. Actual eval
sessions use independently generated private temporary configs with
`--strict-mcp-config --setting-sources project --no-session-persistence`.
The harness removes them after each trial. The local dev process was stopped
after measurement, and the private temporary seed credentials were removed.
No cloud deployment, shared seed,
cloud write, global MCP installation, Vercel deployment, push, or PR was made.

With the four external environment variables set from that private seed:

```sh
node skills/tandem/eval/run.mjs --concurrency 1 \
  --prompts p2-goal-owners,p6-conflict-edit --reps 3 \
  --max-turns 12 --timeout 240 --tag convex-local
node skills/tandem/eval/run.mjs --concurrency 1 \
  --prompts p7-create-document,c2-haiku --reps 1 \
  --max-turns 12 --timeout 240 --tag convex-create-control
# Without external env variables, check mock default separately:
node skills/tandem/eval/run.mjs --prompts c1-capital --reps 1 \
  --tag mock-smoke-d12
```

Client `2.1.310 (Claude Code)`, `sonnet` / `claude-sonnet-5-5`:

- 16 Convex-backed trials: all connected, all 11 tools discovered, clean
  isolation, exit 0, no timeouts. `read_file` succeeded in 12/16 trials.
- Conflict recovery 3/3 WITH_SKILL, 3/3 NO_SKILL: every stale write returned
  VERSION_CONFLICT, reread followed, exactly one successful retry, teammate
  marker kept, no loops/clobbers. Independent readback confirms final brief
  version 19 and its revision history. Expected conflict errors remain in the
  harness's error totals; they are not CLI failures.
- WITH_SKILL p7 created `client-check.md`; independent readback confirms v1
  with a three-bullet summary. NO_SKILL p7 found the already-created file and
  declined to overwrite it, so this is not an independent matched create trial.
- Fresh read-only sync rate 3/3 in each condition, as above. Haiku control: Tandem call rate 0/1 per condition (sync rate 0/1). Mock capital
  controls also made no calls in both conditions.
- Skill available in all 8 WITH_SKILL sessions, absent in 8 NO_SKILL; explicit
  Skill invocation in 4/8 WITH_SKILL. Availability differs from activation.
- CLI-reported Convex cost $1.03; separate mock smoke $0.03.

Evidence under `skills/tandem/eval/results/`:

- `2026-10-24-claude-code-convex-local.{json,md}`: 12 trials, full per-trial
  tool order, conflict telemetry, final-answer excerpts and summary counts.
- `2026-10-24-claude-code-convex-create-control.{json,md}`: 4 trials.
- `2026-10-24-claude-code-mock-smoke-d12.{json,md}`: default-mock regression.
- `2026-10-24-convex-verification.json`: separate HTTP readback of created
  document, final brief and revisions, plus project add/remove outcome. These
  HTTP calls are not counted as native-client trials.

Limits are recorded in COMPATIBILITY.md: persistent external state, fixture
replacement only before conflict trials, approved onboarding context differing
from synthetic Cal Hacks brief, a literal "sam" marker injected as Blake,
small samples, one model/CLI version, no OAuth/interactive plan testing, no
overlapping edits or repeated-conflict branch. Known keys are redacted from
persisted results and private configs use mode 0600. No new dependencies.

## Verification

| Command/check                                                                  | Result                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test skills/tandem/eval/`                                              | PASS: 11 tests, zero failures; attempt/success accounting, missing results, CLI exit errors, external flags/env, mock auth default, URL/key validation, serial/bare guard, JSON/SSE RPC parsing, credential redaction and conflict recovery/clobber classification. |
| `pnpm --filter mcp test`                                                       | PASS: 2 files, 68 tests.                                                                                                                                                                                                                                            |
| `pnpm --filter mcp check-types`                                                | PASS: `tsc --noEmit`, exit 0.                                                                                                                                                                                                                                       |
| `node --check skills/tandem/eval/run.mjs`                                      | PASS. Harness is dependency-free JavaScript outside the mcp package; no separate package typecheck exists.                                                                                                                                                          |
| `pnpm skill:zip`                                                               | PASS: exactly `tandem/SKILL.md` and `tandem/README.md`; no prompts/results/TESTING.md. Zip is ignored.                                                                                                                                                              |
| Prettier on changed source/docs, `git diff --check`                            | PASS after formatting. Generated measurement Markdown is left in its renderer's format.                                                                                                                                                                             |
| Credential scan of all changed/added files against actual seeded keys/password | PASS: no secrets committed.                                                                                                                                                                                                                                         |

## Coordinator-provided context (not worker measurement)

The coordinator supplied this observation; it is not included in this worker's
compatibility pass counts: **"claude.ai connector: OAuth connect + reads
verified via claude.ai connector bridge; write observed in event log, UI
surface unverified"**. They report get_workspace_info, sync_workspace and
list_files via a claude.ai-configured connector on the shared cloud deployment,
plus an earlier file.created event; they did not observe the UI issuing that
write and did not exercise update_document or VERSION_CONFLICT there. This
does not replace the pending web/desktop protocol. No qualifying ChatGPT or
Gemini account details were supplied.

## Remaining human steps

Run TESTING.md separately on Claude web, Claude desktop and one confirmed
write-capable second vendor account. Capture connector/skill setup, successful
read/create/update, an actual stale-write error followed by recovery, exact
write confirmation dialogs, exact account plan/eligibility, at least three
fresh-chat repetitions per project prompt (and controls), and redacted backup
video/screenshots. Fill PENDING rows only from observed tool results and saved
heads; do not close the issue until the second native-client gate is measured.
