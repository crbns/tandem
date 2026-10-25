# Tandem Agent Skill

`SKILL.md` teaches an AI assistant how to use the Tandem remote MCP server:
sync workspace context, read canonical files, save edits with
`expected_version`, recover from `VERSION_CONFLICT`, publish only authorized
work, and propose (not apply) changes to goal, scope, major decisions, and
ownership.

You need two pieces in each client:

1. **The Tandem MCP connector**, which provides the tools.
2. **This skill**, which tells the assistant when and how to use them.

**The loop.** Once Tandem is used in a chat, the skill and the server both tell
the assistant to run the same loop on every later project request: sync, read
the relevant files, do the work, write back (`update_document` /
`create_document`), log the request with `publish_work` (even when no file
changed), propose context changes (seeding an empty context from the files it
reads or saves, otherwise anything a saved file shows that the context lacks,
skipping what is already pending), and report.
The server sends the loop as MCP `instructions` at initialize and restates it
as `next_steps` on `sync_workspace`, save, publish, and propose results, so it
reaches assistants without the skill too. `TESTING.md` → "Continuous loop"
measures it.

**Observed activity.** Tandem also records assistants' MCP calls and, with the
optional Claude Code hooks (`docs/claude-code-hooks.md`), their Claude Code
activity. Its context manager turns that into the `observed` section of every
`sync_workspace` result, labeled with evidence and never treated as approved
context. Assistants read it to see what teammates' assistants are doing, so
they no longer write progress updates by hand.

> **Limits.** A skill only nudges the model. Whether it activates, and whether
> the assistant calls `sync_workspace`/`list_files`, is probabilistic. A skill
> cannot force tool calls, and Tandem cannot wake a native chat when files
> change. Measure real behavior with [COMPATIBILITY.md](./COMPATIBILITY.md)
> (in the repo's `skills/tandem/`; not shipped in the zip).

> **Status:** Claude Code CLI was measured against an isolated local
> Convex-backed `/mcp` endpoint on 2026-10-24, using Bearer API keys and
> project-scoped skill installation. See `COMPATIBILITY.md` for the exact
> counts and limits. Claude web/desktop, ChatGPT and Gemini remain pending
> human testing under `TESTING.md`; CLI results do not establish GUI support.

## Build the skill zip

From the repo root:

```sh
pnpm skill:zip    # same as: sh skills/package.sh
```

This produces `dist/tandem-skill.zip`, with the `tandem/` folder (`SKILL.md`
and `README.md` only) at the top level of the archive. `COMPATIBILITY.md` and
`eval/` stay in the repo: they hold the test prompts and results. `dist/` is
gitignored; don't commit the zip.

## Claude (web and desktop)

Claude remote MCP connectors work on all plans and Claude is the primary test
target.

### a. Add the Tandem connector (to verify)

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Name: `Tandem`. URL: the server URL on your workspace's **Assistants**
   page, `https://<deployment>.convex.site/mcp`.
4. Complete the OAuth sign-in: Tandem opens its consent page, where you sign
   in, pick the workspace and the assistant, and choose **Allow**. The
   connection then shows on the Assistants page, where you can revoke it.
5. In a new chat, open the tools/connectors menu and confirm the Tandem tools
   are listed and enabled.

On Team/Enterprise plans an owner may need to add the connector at org level
first. _(to verify)_

### b. Install the skill (to verify)

1. Build `dist/tandem-skill.zip` (see above).
2. Open **Settings → Capabilities** (Skills section). Enable skills if they are
   off, then **Upload skill** and pick `tandem-skill.zip`.
3. Make sure the `tandem` skill is toggled on.
4. Run the fresh-chat protocol in `COMPATIBILITY.md` to check whether it
   activates without mentioning Tandem.

The exact menu labels may differ by plan or app version. _(to verify)_

## Claude Code

### a. Add the connector

Create an API key on the workspace's **Assistants** page (it is shown once,
with this command filled in):

```sh
claude mcp add --scope project --transport http tandem https://<deployment>.convex.site/mcp \
  --header "Authorization: Bearer <API key>"
```

Or _(to verify)_ drop `--header` and run `/mcp` inside Claude Code to sign in
with OAuth instead. Either way, check that the `mcp__tandem__*` tools are
listed. (The 2026-10-24 evaluation measured Bearer auth against local Convex via
`--mcp-config`; project-scoped add/remove was also checked in a temporary directory.)

### b. Install the skill

Unzip the built skill so you get `.../skills/tandem/SKILL.md`:

```sh
pnpm skill:zip
# Project-scoped, in the target repo (measured):
mkdir -p .claude/skills && unzip -o /path/to/tandem-skill.zip -d .claude/skills
# Or personal, for all projects (to verify):
mkdir -p ~/.claude/skills && unzip -o dist/tandem-skill.zip -d ~/.claude/skills
```

Start a new Claude Code session and check that `tandem` appears among available
skills. Only the project-scoped path was measured: it is what the eval uses
(the `tandem` skill shows up in the session's `init` event). The personal
`~/.claude/skills` path is _to verify_.

## ChatGPT: UNTESTED

- Full write MCP (needed for `create_document`, `update_document`,
  `publish_work`, `propose_context_change`) is a **Business / Enterprise / Edu
  beta** only, as of Oct 2026.
- **Pro** is read-only for custom MCP. Expect read tools (`list_files`,
  `read_file`, `search_files`) only.
- **Plus** isn't viable.
- ChatGPT has no `SKILL.md` loader. Paste the body of `SKILL.md` into the
  custom instructions for a project or GPT as a fallback. _(to verify)_
- Connector setup: add a custom MCP connector/app (developer mode) pointing at
  `https://<tandem-mcp-host>/mcp`. _(to verify: exact path and labels)_

## Gemini: UNTESTED

- Custom MCP apps have eligibility limits (account type, region, plan) as of
  Oct 2026. Confirm the test account is eligible before demoing.
- No `SKILL.md` loader is assumed. Paste the `SKILL.md` body into a Gem's
  instructions as a fallback. _(to verify)_
- Connector setup path: _to verify_.

## Measure an external Convex-backed server

Use an isolated disposable workspace. The harness can replace the brief's
content and save shared documents; never point write trials at the team's
shared cloud seed without authorization. For a local backend:

```sh
cd packages/backend
CONVEX_AGENT_MODE=anonymous pnpm exec convex dev
# In another terminal, confirm .env.local points to that local deployment:
pnpm demo:reset --json
```

Keep the printed keys private. Supply credentials as environment variables
rather than command-line arguments (which may appear in process listings):

```sh
export TANDEM_MCP_URL='http://127.0.0.1:<local-site-port>/mcp'
read -r -s TANDEM_MCP_KEY; export TANDEM_MCP_KEY
read -r -s TANDEM_MCP_TEAMMATE_KEY; export TANDEM_MCP_TEAMMATE_KEY
export TANDEM_BRIEF_ID='<briefFileId from the local demo reset>'
node skills/tandem/eval/run.mjs --concurrency 1 \
  --prompts p2-goal-owners,p6-conflict-edit --reps 3 \
  --max-turns 12 --timeout 240 --tag convex-local
unset TANDEM_MCP_URL TANDEM_MCP_KEY TANDEM_MCP_TEAMMATE_KEY TANDEM_BRIEF_ID
```

Flags `--mcp-url`, `--mcp-key`, `--mcp-teammate-key`, and `--brief-id`
override their environment equivalents. External mode skips building/starting
the mock, uses `Authorization: Bearer`, requires serial trials and currently
supports `--env bare` only. The server state persists across trials. Conflict
trials require a real brief ID, replace its content with the synthetic fixture,
and inject via the second actor's key (or the same key if none is supplied).
The literal marker says "sam" even if the seeded second actor is Blake; results
record which credential arrangement was used. Do not interpret fixture markers
as tests of the external workspace's approved goal.

External results store the URL and brief ID, never credential settings; known
keys are redacted from saved errors and answers too. `--keep` retains temporary
MCP configuration containing credentials, so keep those directories private and
remove them afterward. Normal runs delete temporary configs. The harness uses
`--strict-mcp-config` and never adds to global Claude MCP settings.

For GUI clients and recording backup footage, follow `TESTING.md` in the repo.

## Measuring the skill (Claude Code)

`eval/run.mjs` (Node, no dependencies) checks whether the skill makes Claude
Code use Tandem on its own. Each fresh headless chat gets a prompt that never
mentions Tandem, and the run is repeated with and without the skill.

```sh
node skills/tandem/eval/run.mjs --model sonnet --reps 2
```

It builds `apps/mcp`, then for every trial does the following:

1. Starts a fresh mock MCP server (plus the two distractor stubs with
   `--env realistic`).
2. Creates a temp project (empty, or the stale local tree with
   `--env realistic`), with only `SKILL.md` in `.claude/skills/tandem` for
   `WITH_SKILL` and no skill for `NO_SKILL`.
3. Runs `claude -p` with `--strict-mcp-config --setting-sources project`, so
   your own plugins, skills and MCP servers stay out (the `init` event is
   checked each run). `CLAUDE.md` and memory exclusion was verified by a
   manual probe on 2026-10-23, not by the harness itself.
4. Allows only the Tandem tools (and the distractor tools in `realistic`) and
   read-only built-ins. Bash, Edit, Write, web, subagent and scheduling tools
   are denied.

Prompts are in `eval/prompts.json`: the 5 fresh-chat prompts from
`TESTING.md`, a conflict prompt (`p6-conflict-edit`), an explicitly authorized
create prompt (`p7-create-document`), 3 folder prompts, plus 2 unrelated
controls. Before a folder prompt the harness saves the `FOLDER_SEED` tree from
`eval/fixtures.mjs` (`/specs/api-spec.md`, `/meeting-notes/...`) and grades
where the new document landed (`p8-folder-existing` into `/meeting-notes`,
`p9-folder-new` into a new `/retros`) or whether `/specs/api-spec.md` was read
and quoted (`p10-read-path`). See the report's Folders section.

**Environments (`--env`).** `bare` (the default) is the setup above: an empty
project with Tandem as the only MCP server. `realistic` gives the model
plausible alternatives to Tandem:

- A small local project tree (`eval/fixtures.mjs`): `README.md`,
  `docs/brief.md`, `docs/notes/standup-2026-10-20.md`, `src/index.ts`. It is
  deliberately out of date versus Tandem (older goal "launch a mobile-first
  beta at the Spring Builders Summit", other owners), and readable with
  Read/Glob/Grep scoped to the project (`Read(./**)`).
- Two distractor MCP servers in the same `--mcp-config` (`eval/stub-mcp.mjs`,
  no deps): `notes` (`notes_search`, `notes_read`) and `tracker`
  (`list_tickets`, `get_ticket`), with their own stale phrase ("Bay Area Dev
  Days").
- Tandem's `brief.md` is saved as v2 by `user_sam` before each trial, so it
  differs from the local copy. The harness then records whether the model read
  local files or distractors, and whether the final answer contains a
  stale-only phrase and not the Tandem value ("Cal Hacks").

**Conflict injector.** For prompts marked `"conflict": true`, the harness
watches the stream. Right after the agent's first successful `read_file` of the
brief, it saves a teammate edit as `user_sam` over its own JSON-RPC call (the
read content plus the line `Teammate note (sam): budget approved — keep this
line.`), so the agent's next `update_document` with the old version gets
`VERSION_CONFLICT`. At trial end it reads the head back and records
injected/latency, conflict hit, re-read, retry count, looped (>1 retry),
recovered (marker kept and the agent's change on top), clobbered (marker lost)
and asked-user. If the agent writes before reading or never reads, the trial is
recorded as `no_inject`.

Results go to
`eval/results/<date>-claude-code[-<tag>].{json,md}`; the harness refuses to
overwrite existing results unless you pass `--tag <s>` or `--force`. It flags
any isolation leaks it sees in the session `init` event. Ctrl-C or SIGTERM
stops the servers and `claude` processes it started and removes its temp dirs.
Use `--help` for the other options (`--prompts`, `--conditions`,
`--concurrency`, `--keep`, `--rerender`, ...). Each run uses your logged-in
Claude Code account. The default is 9 prompts × 2 conditions × 2 reps = 36 runs. Costs vary; `--env realistic --reps 3 --max-turns 8 --timeout 240` (48
runs) cost $1.88. The committed results were run as:

```sh
node skills/tandem/eval/run.mjs --model sonnet --reps 2      # 2026-10-23-claude-code (before p6 existed)
node skills/tandem/eval/run.mjs --env realistic --reps 3 --max-turns 8 --timeout 240 --concurrency 3 --tag realistic
node skills/tandem/eval/run.mjs --prompts p6-conflict-edit --reps 3 --max-turns 8 --timeout 240 --concurrency 1 --tag conflict-bare
```

Summary counts are trials, not individual calls. `sync` and `write` measure
attempts; `sync_ok` and `write_ok` require at least one matching non-error tool
result. A write is any `create_document`, `update_document`, `publish_work`, or
`propose_context_change` call. `tool_errors` counts trials with at least one
Tandem MCP tool error, even if Claude returns a normal final answer.
`errors_or_timeouts` includes those tool errors, CLI failures (including a
nonzero exit or missing final result event), and timeouts. First-call order
measures attempts. Failed trials remain in the denominator.

Run the deterministic harness tests without Claude or an MCP server:

```sh
node --test skills/tandem/eval/
```

The committed 2026-10-23 JSON stores analyzed calls and errors, but not the raw
tool-result events needed to prove successful syncs. Its JSON and Markdown
results are unchanged; the historical sync/write columns measure attempts,
and its errors column predates tool-error aggregation. No paid trials were
rerun to update the metrics.

**What the 2026-10-23 results mean.** With the skill, Claude Code called
`sync_workspace` first in 10/10 project chats. Without it, it did so in 0/10.
Neither condition touched Tandem on the unrelated controls. Without the skill,
though, Claude Code _still_ used Tandem tools in 10/10 project chats, because
the tool descriptions were enough in a setup where Tandem is the only MCP
server and the project dir is empty. So the skill doesn't decide _whether_
Tandem gets used here. It changes _how_: it syncs the approved context first
(so answers use the approved goal and ownership), and it saved drafts with
`create_document` in 2/4 draft chats, against 0/4 without it. The other two
asked before saving. When it saved, it said every workspace member can see the
file now; no run called a saved file private. n=2 per cell is directional
only.

**What the realistic and conflict runs add** (2026-10-23, n=3 per cell, $1.88
for 48 realistic runs and $0.35 for 6 bare conflict runs):

- **With alternatives present, the skill decides whether Tandem is used.**
  With stale local files and two distractor MCP servers, Claude Code without
  the skill used Tandem in 8/15 project chats. It went to local files first
  (12/15), and 8/15 answers presented the stale local goal as current (a 9th,
  p3 NO_SKILL rep 2, used the stale goal as the draft's goal and flagged the
  conflict). With the skill: Tandem in 15/15, `sync_workspace` first in
  15/15, and 0/15 answers used the stale goal. Controls: 0/12 tool calls
  either way.
- **Conflict recovery works, with or without the skill, once the agent is in
  Tandem.** Each time the injected teammate edit caused a `VERSION_CONFLICT`
  (9/9: bare 3/3 with and 3/3 without the skill, realistic 3/3 with it), the
  agent re-read, retried exactly once, kept the teammate's line and saved its
  own change on top. No loops, no clobbers, and the user was told each time.
  The server's error text already spells out the procedure, so the skill isn't
  needed for this step in Claude Code. In the realistic env, though, the 3
  NO_SKILL runs never opened Tandem's brief: they tried to `Edit` the stale
  local `docs/brief.md` (the harness disallows Edit), so no conflict could
  happen.
- Limits: one model (`sonnet` / `claude-sonnet-5-5`), one CLI version
  (2.1.310), headless `claude -p` only. The fixtures are synthetic: the local
  tree is stale by construction and Tandem is the truth. The teammate edit is
  a single trivial end-of-file append, so overlapping merges are untested.
  n=3 per cell.
- Not exercised: the overlapping-edit "ask the user" branch and a second
  conflict on retry. p5 ("our spec", which doesn't exist) with the skill in
  the realistic env edited `brief.md` as a guess in 2/3 runs without asking
  first.
- Caveats: the stale-answer metrics are substring checks on the final answer
  (the 3/15 NO_SKILL answers that mention the distractor-only phrase all cite
  it as a discrepancy; 0/15 used it as the answer);
  local files name the product "Tandem"; Edit/Write are disallowed, which
  shapes what NO_SKILL runs could do with local files.

See `COMPATIBILITY.md` for the full breakdown.

## Updating the skill

Edit `SKILL.md`, rebuild the zip, and re-upload (Claude) or re-copy (Claude
Code). Keep tool names in `SKILL.md` identical to the MCP server's tool names.
