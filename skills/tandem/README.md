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
> header, and auto-sync in fresh chats) was measured by the eval harness on
> 2026-10-23. On claude.ai web, adding the connector and tool discovery were
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

1. Starts a fresh mock MCP server.
2. Creates an empty temp project, with only `SKILL.md` in
   `.claude/skills/tandem` for `WITH_SKILL` and no skill for `NO_SKILL`.
3. Runs `claude -p` with `--strict-mcp-config --setting-sources project`, so
   your own plugins, skills and MCP servers stay out (the `init` event is
   checked each run). `CLAUDE.md` and memory exclusion was verified by a
   manual probe on 2026-10-23, not by the harness itself.
4. Allows only the Tandem tools and read-only built-ins. Bash, Edit, Write,
   web, subagent and scheduling tools are denied.

Prompts are in `eval/prompts.json`: the 5 fresh-chat prompts from
`COMPATIBILITY.md`, plus 2 unrelated controls. Results go to
`eval/results/<date>-claude-code[-<tag>].{json,md}`; the harness refuses to
overwrite existing results unless you pass `--tag <s>` or `--force`. It flags
any isolation leaks it sees in the session `init` event. Ctrl-C or SIGTERM
stops the servers and `claude` processes it started and removes its temp dirs.
Use `--help` for the other options (`--prompts`, `--conditions`,
`--concurrency`, `--keep`, ...). Each run uses your logged-in Claude Code
account. The default 28 runs cost about $1.

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
file now; no run called a saved file private. `update_document` and
`VERSION_CONFLICT` recovery were not exercised, and n=2 per cell is
directional only. See `COMPATIBILITY.md` for the full breakdown.

## Updating the skill

Edit `SKILL.md`, rebuild the zip, and re-upload (Claude) or re-copy (Claude
Code). Keep tool names in `SKILL.md` identical to the MCP server's tool names.
