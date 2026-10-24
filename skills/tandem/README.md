# Tandem Agent Skill

`SKILL.md` teaches an AI assistant how to use the Tandem remote MCP server:
sync workspace context, read canonical files, save edits with
`expected_version`, recover from `VERSION_CONFLICT`, publish only authorized
work, and propose (not apply) changes to goal, scope, major decisions, and
ownership.

You need two pieces in each client:

1. **The Tandem MCP connector**, which provides the tools.
2. **This skill**, which tells the assistant when and how to use them.

> **Limits.** A skill only nudges the model. Whether it activates, and whether
> the assistant calls `sync_workspace`/`list_files`, is probabilistic. A skill
> cannot force tool calls, and Tandem cannot wake a native chat when files
> change. Measure real behavior with [COMPATIBILITY.md](./COMPATIBILITY.md)
> (in the repo's `skills/tandem/`; not shipped in the zip).

> **Status:** Claude Code (skill install, the connector with the dev `api-key`
> header, auto-sync in fresh chats, `update_document`, and `VERSION_CONFLICT`
> recovery) was measured by the eval harness on 2026-10-23. On claude.ai web, adding the connector and tool discovery were
> checked by hand against the no-auth dev tunnel. Everything else is still
> marked **to verify**. Results live in `COMPATIBILITY.md`.

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
3. Name: `Tandem`. URL: `https://<tandem-mcp-host>/mcp` (replace with the
   deployed MCP server host).
4. Complete the OAuth sign-in with your Tandem account.
5. In a new chat, open the tools/connectors menu and confirm the Tandem tools
   are listed and enabled.

On Team/Enterprise plans an owner may need to add the connector at org level
first. *(to verify)*

### b. Install the skill (to verify)

1. Build `dist/tandem-skill.zip` (see above).
2. Open **Settings → Capabilities** (Skills section). Enable skills if they are
   off, then **Upload skill** and pick `tandem-skill.zip`.
3. Make sure the `tandem` skill is toggled on.
4. Run the fresh-chat protocol in `COMPATIBILITY.md` to check whether it
   activates without mentioning Tandem.

The exact menu labels may differ by plan or app version. *(to verify)*

## Claude Code

### a. Add the connector

With the current dev server (static `api-key` header; the eval measured header auth via `--mcp-config`, not this `claude mcp add` command):

```sh
claude mcp add --transport http tandem https://<tandem-mcp-host>/mcp \
  --header "api-key: <your-dev-token>"
```

Once OAuth lands *(to verify)*: drop `--header` and run `/mcp` inside Claude
Code to authenticate. Either way, check that the `mcp__tandem__*` tools are
listed.

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
`~/.claude/skills` path is *to verify*.

## ChatGPT: UNTESTED

- Full write MCP (needed for `create_document`, `update_document`,
  `publish_work`, `propose_context_change`) is a **Business / Enterprise / Edu
  beta** only, as of Oct 2026.
- **Pro** is read-only for custom MCP. Expect read tools (`list_files`,
  `read_file`, `search_files`) only.
- **Plus** isn't viable.
- ChatGPT has no `SKILL.md` loader. Paste the body of `SKILL.md` into the
  custom instructions for a project or GPT as a fallback. *(to verify)*
- Connector setup: add a custom MCP connector/app (developer mode) pointing at
  `https://<tandem-mcp-host>/mcp`. *(to verify: exact path and labels)*

## Gemini: UNTESTED

- Custom MCP apps have eligibility limits (account type, region, plan) as of
  Oct 2026. Confirm the test account is eligible before demoing.
- No `SKILL.md` loader is assumed. Paste the `SKILL.md` body into a Gem's
  instructions as a fallback. *(to verify)*
- Connector setup path: *to verify*.

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
`COMPATIBILITY.md`, a conflict prompt (`p6-conflict-edit`), plus 2 unrelated
controls.

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
Claude Code account. The default (8 prompts × 2 conditions × 2 reps = 32 runs)
should cost about $1.25 (the 28 runs before p6 cost about $1, and a bare p6
run about $0.06); `--env realistic --reps 3 --max-turns 8 --timeout 240` (48
runs) cost $1.88. The committed results were run as:

```sh
node skills/tandem/eval/run.mjs --model sonnet --reps 2      # 2026-10-23-claude-code (before p6 existed)
node skills/tandem/eval/run.mjs --env realistic --reps 3 --max-turns 8 --timeout 240 --concurrency 3 --tag realistic
node skills/tandem/eval/run.mjs --prompts p6-conflict-edit --reps 3 --max-turns 8 --timeout 240 --tag conflict-bare
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
though, Claude Code *still* used Tandem tools in 10/10 project chats, because
the tool descriptions were enough in a setup where Tandem is the only MCP
server and the project dir is empty. So the skill doesn't decide *whether*
Tandem gets used here. It changes *how*: it syncs the approved context first
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
  conflict). With
  the skill: Tandem in 15/15, `sync_workspace` first in 15/15, and 0/15
  answers used the stale goal. Controls: 0/12 tool calls either way.
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
