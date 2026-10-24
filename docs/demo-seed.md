# Demo seed: operating guide

One command puts a Convex deployment into the demo's starting state. Run it before a rehearsal, after a rehearsal, and before the live demo.

```sh
pnpm demo:reset
```

## What it creates

| | |
|---|---|
| Users | Alex `alex@demo.tandem.test` (owner), Blake `blake@demo.tandem.test` (member), Casey `casey@demo.tandem.test` (member). All three are Password users and share one password. |
| Workspace | "Onboarding refresh" |
| Files | `brief.md` v1 (Alex); `research/support-tickets.md` v1 (Casey); `research/interview-notes.md` v2 (Blake: v1 had five interviews, v2 adds a sixth and a quotes section, so there is a real diff to ask about); `requirements/setup-checklist.md` v1 (Blake) |
| Approved context | Goal: "Cut new-customer time-to-first-value from 9 days to 3 by the end of Q1." Scope: welcome emails, setup checklist and three how-to guides are in; pricing, a new help center and localization are out. Both are sourced from `brief.md` and approved by Alex. They go through the normal propose-and-approve path, so the Approvals page and event log show them. |
| Working context | Decision: first value means "first project created". Ownership: Blake owns the welcome email sequence. Constraint: launch before the January 15 billing cycle. Open question: do the guides live in the app or the existing help center? All approved by Alex. |
| Tasks | "Draft the welcome email sequence" (in progress, Blake), "Write the three how-to guides" (open), "Pull the top setup questions from support" (done, Casey) |
| Pending proposal | Casey's Gemini proposes moving the guides to a new help-center platform. It contradicts the approved scope on purpose, so the Approvals page has something to reject live. |
| Agent connections | Alex's Claude, Blake's Claude, Casey's Gemini (one token each) |

`proposal.md` is deliberately missing. In the demo, Alex's Claude creates it live.

The content lives in `packages/backend/convex/seed.ts` (`DEMO_BRIEF`, `DEMO_GOAL`, `DEMO_SCOPE`, `DEMO_PEOPLE`, and `seedStory` for everything after the goal and scope). Edit it there.

## What a reset does

1. It checks the inputs (password length, token format, tokens that are duplicated or used outside the demo). If any check fails, it stops before changing anything.
2. It creates the three users. For users that already exist, it sets their password and deletes their sessions and refresh tokens. A dashboard sign-in token issued before the reset keeps working until it expires (at most an hour).
3. It deletes the seeded demo workspace and everything in it (folders, files, revisions, proposals, approvals, tasks, events, connections, invites, stored blobs). The seeded workspace carries a `demoSeed` marker, so a workspace Alex creates with the same name is not touched.
4. It builds the workspace again as described above, in one transaction. Everything it creates carries the reset's timestamp, so the activity feed reads "just now", except `research/interview-notes.md` v1, which is dated a day earlier so its history shows a real gap between versions.

Nothing else is touched. Other workspaces, including any the demo users created themselves, survive a reset. Running it repeatedly always ends in the same state.

It runs as the internal Convex function `seed:resetDemo`, so it needs the deployment's admin access (`npx convex run`). Nobody can trigger it from the dashboard or over MCP.

## Prerequisites

- `pnpm install` at the repo root.
- A Convex deployment that `npx convex run` can reach from `packages/backend`:
  - Local: `npx convex dev` is running (see [local-dev.md](local-dev.md) step 1).
  - Cloud: `CONVEX_DEPLOY_KEY` is set, or pass `--prod` while logged in to the Convex CLI.
- Convex Auth keys on that deployment (`node scripts/setup-auth-env.mjs` in `packages/backend`, once per deployment). The seed itself works without them, but nobody can sign in to the dashboard until they're set.

## Running it

### Local

```sh
pnpm demo:reset
```

The output looks like this:

```
Demo reset: workspace "Onboarding refresh" (ms75hk…)
Dashboard: http://localhost:3000/w/ms75hk…
Password (all three): demo-035h565j683z08012r
MCP server: http://127.0.0.1:3211/mcp (claude.ai: add it as a custom connector and sign in)

Alex (owner): alex@demo.tandem.test
  claude API key: mcp_sk_…
  claude mcp add --transport http tandem http://127.0.0.1:3211/mcp --header "Authorization: Bearer mcp_sk_…"
Blake (member): blake@demo.tandem.test
  …
Casey (member): casey@demo.tandem.test
  gemini API key: mcp_sk_…

To keep these across resets:
  DEMO_PASSWORD='…' DEMO_TOKEN_ALEX=mcp_sk_… DEMO_TOKEN_BLAKE=mcp_sk_… DEMO_TOKEN_CASEY=mcp_sk_…
```

### Cloud (demo deployment)

```sh
CONVEX_DEPLOY_KEY=… pnpm demo:reset
# or, logged in to the Convex CLI:
pnpm demo:reset --prod
```

Any extra arguments go straight to `npx convex run`. Set `TANDEM_WEB_URL` so the printed dashboard link points at the deployed dashboard. The MCP URL is the deployment's own `<CONVEX_SITE_URL>/mcp`; `TANDEM_MCP_URL` overrides what's printed.

### Keeping the password and tokens stable

Without pinning, every reset generates a new password and new tokens, which breaks any Claude Code connector you configured earlier. To keep them, copy the last line of the output into your shell (or a local, uncommitted `.env` you source):

```sh
export DEMO_PASSWORD='…'
export DEMO_TOKEN_ALEX=mcp_sk_… DEMO_TOKEN_BLAKE=mcp_sk_… DEMO_TOKEN_CASEY=mcp_sk_…
pnpm demo:reset
```

The rules:

- The password needs at least 8 characters.
- A token must be an `mcp_sk_` API key in the form the reset printed. Make your own with a reset that has no pins, and copy its keys. Old `tdm_` tokens from before #21 no longer work.
- A token pinned for two people, or already used by a connection outside the demo, is rejected with `INVALID_INPUT`.

Treat the password and tokens as secrets on a public deployment. Anyone who has them can act as that demo user.

### Raw output

`pnpm demo:reset --json` prints the result as JSON (workspace id, `mcpUrl`, `briefFileId`, password, and per member: user id, connection id, token). `npx convex run seed:resetDemo '{"password":"…","tokens":{"alex":"mcp_sk_…"}}'` from `packages/backend` does the same without the wrapper.

## Connecting the assistants

- **Claude Code:** run the `claude mcp add …` line printed for Alex (and for Blake, if you need a second Claude). If an older `tandem` server is configured, remove it first with `claude mcp remove tandem`.
- **A reset disconnects claude.ai.** It deletes every connection to the demo workspace, OAuth ones included, and the rebuilt workspace has a new id. Pinned `DEMO_TOKEN_*` keep only the seeded API keys (Claude Code) working. So do the final reset first, then connect claude.ai, and don't reset again after connecting the chat client you'll demo with.
- **claude.ai:** Settings → Connectors → Add custom connector with the printed MCP server URL. After a reset, Disconnect and Connect again. Claude opens Tandem's consent page: sign in as Alex (or Blake), pick "Onboarding refresh", choose Claude, Allow. This adds a new OAuth connection next to the seeded one; for the consent page to be the deployed dashboard, set `MCP_CONSENT_URL` (or `SITE_URL`) on the Convex deployment to the dashboard origin.
- **ChatGPT, Gemini:** not tested. Casey's Gemini key exists so the connection shows up on the Assistants page.
- **Dashboard:** sign in as any of the three emails with the printed password.

## Checking it works

```sh
pnpm test:demo
```

This command does the following:

1. Resets the demo.
2. Checks the seed (brief.md v1 alone at the root, approved goal and scope, exactly one pending proposal from Casey's Gemini), then runs the P0 slice on it: Alex's Claude creates `proposal.md` v1, Blake signs in with the seeded password and saves v2, the agent reads v2, a stale v1 update gets `VERSION_CONFLICT`, and history names both editors.
3. Resets again and prints the new credentials.

It follows `DEMO_PASSWORD` and `DEMO_TOKEN_*`, so pin them first if you don't want them to change. It talks to `CONVEX_URL` (default `http://127.0.0.1:3210`) and that deployment's own `/mcp` (`MCP_URL` overrides it). Against the cloud demo deployment, run it like this:

```sh
CONVEX_URL=https://<deployment>.convex.cloud CONVEX_DEPLOY_KEY=… pnpm test:demo
```

It doesn't run as part of `pnpm test:e2e`, where the suite shows as skipped.

## Rehearsal and demo-day checklist

1. Pin `DEMO_PASSWORD` and `DEMO_TOKEN_*` (see above) so connectors survive resets.
2. Run `pnpm test:demo` against the demo deployment. All 6 steps should pass, and it leaves the demo clean.
3. Configure Claude Code with Alex's token. Sign in to the dashboard as Blake in a second browser profile.
4. Rehearse.
5. Run `pnpm demo:reset` (the final reset). The output should match your pinned values. Sign out and back in as Alex and Blake: the reset ends sessions, though an open tab can keep working for up to an hour on its current token. Open the printed `/w/<id>/overview` link.
6. Check the Overview against the seed: 4 files (`brief.md` v1, `research/interview-notes.md` v2, `research/support-tickets.md` v1, `requirements/setup-checklist.md` v1) in 2 folders, no `proposal.md`, the approved goal, exactly one pending proposal (Casey's Gemini: move the guides to a new help-center platform), and 3 tasks.
7. Only now connect claude.ai, if you're demoing it (see "Connecting the assistants"). Have each assistant sync once off stage so the Assistants page shows when it was last heard from.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `convex run` targets the wrong deployment | It uses `packages/backend/.env.local`, or `CONVEX_DEPLOY_KEY` when that's set. Check with `npx convex env list` in `packages/backend`. |
| Dashboard sign-in fails right after a reset on a new deployment | The Convex Auth keys are missing. Run `node scripts/setup-auth-env.mjs` in `packages/backend`. |
| Sign-in fails with the old password | Expected: each reset sets a new password unless `DEMO_PASSWORD` is pinned. Use the password from the last reset. |
| Claude Code gets 401 after a reset | Expected without pinned tokens, because the old connections were deleted. Re-add with the new token, or pin `DEMO_TOKEN_*`. |
| claude.ai gets 401 or sees no workspace after a reset | Expected: a reset deletes OAuth connections and the workspace id changes. Disconnect and Connect the connector again, consent as Alex, and pick "Onboarding refresh". |
| `WEAK_PASSWORD` | `DEMO_PASSWORD` is shorter than 8 characters. |
| `INVALID_INPUT` with `field: "tokens.<name>"` | That pinned token is malformed, pinned for two people, or used by a connection outside the demo. Drop the pin to get a new one. |
| The reset fails | Input errors (`WEAK_PASSWORD`, `INVALID_INPUT`) are caught before any account changes. If it fails later, the passwords may already be reset but the rebuild is one transaction, so the demo workspace is either fully replaced or left as it was. Fix the cause and rerun; the passwords and tokens printed by the next successful reset are the valid ones. |
