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
> change. Measure real behavior with [COMPATIBILITY.md](./COMPATIBILITY.md).

> **Status:** none of the steps below have been tested end to end yet. Each one
> is marked **to verify**. Record results in `COMPATIBILITY.md`.

## Build the skill zip

From the repo root:

```sh
cd skills && zip -r tandem.zip tandem -x '*.DS_Store'
```

This produces `skills/tandem.zip`, with the `tandem/` folder (containing
`SKILL.md`) at the top level of the archive. Don't commit the zip.

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

1. Build `tandem.zip` (see above).
2. Open **Settings → Capabilities** (Skills section). Enable skills if they are
   off, then **Upload skill** and pick `tandem.zip`.
3. Make sure the `tandem` skill is toggled on.
4. Run the fresh-chat protocol in `COMPATIBILITY.md` to check whether it
   activates without mentioning Tandem.

The exact menu labels may differ by plan or app version. *(to verify)*

## Claude Code

### a. Add the connector (to verify)

```sh
claude mcp add --transport http tandem https://<tandem-mcp-host>/mcp
```

Then run `/mcp` inside Claude Code to authenticate and check that the tools are
listed.

### b. Install the skill (to verify)

Personal (all projects):

```sh
mkdir -p ~/.claude/skills && cp -R skills/tandem ~/.claude/skills/tandem
```

Or project-scoped: copy to `.claude/skills/tandem` in the target repo. Restart
Claude Code and check that `tandem` appears among available skills.

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

## Updating the skill

Edit `SKILL.md`, rebuild the zip, and re-upload (Claude) or re-copy (Claude
Code). Keep tool names in `SKILL.md` identical to the MCP server's tool names.
