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
| Files | `brief.md` v1, written by Alex |
| Approved context | Goal: "Cut new-customer time-to-first-value from 9 days to 3 by the end of Q1." Scope: welcome emails, setup checklist and three how-to guides are in; pricing, a new help center and localization are out. Both are sourced from `brief.md` and approved by Alex. They go through the normal propose-and-approve path, so the Approvals page and event log show them. |
| Agent connections | Alex's Claude, Blake's Claude, Casey's Gemini (one token each) |

`proposal.md` is deliberately missing. In the demo, Alex's Claude creates it live.

The content lives in `packages/backend/convex/seed.ts` (`DEMO_BRIEF`, `DEMO_GOAL`, `DEMO_SCOPE`, `DEMO_PEOPLE`). Edit it there.

## What a reset does

1. It checks the inputs (password length, token format, tokens that are duplicated or used outside the demo). If any check fails, it stops before changing anything.
2. It creates the three users. For users that already exist, it sets their password and deletes their sessions and refresh tokens. A dashboard sign-in token issued before the reset keeps working until it expires (at most an hour).
3. It deletes the seeded demo workspace and everything in it (files, revisions, proposals, approvals, events, connections, invites, stored blobs). The seeded workspace carries a `demoSeed` marker, so a workspace Alex creates with the same name is not touched.
4. It builds the workspace again as described above, in one transaction.

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

Alex (owner): alex@demo.tandem.test
  claude token: tdm_…
  claude mcp add --transport http tandem http://127.0.0.1:8787/mcp --header "Authorization: Bearer tdm_…"
Blake (member): blake@demo.tandem.test
  …
Casey (member): casey@demo.tandem.test
  gemini token: tdm_…

To keep these across resets:
  DEMO_PASSWORD='…' DEMO_TOKEN_ALEX=tdm_… DEMO_TOKEN_BLAKE=tdm_… DEMO_TOKEN_CASEY=tdm_…
```

### Cloud (demo deployment)

```sh
CONVEX_DEPLOY_KEY=… pnpm demo:reset
# or, logged in to the Convex CLI:
pnpm demo:reset --prod
```

Any extra arguments go straight to `npx convex run`. Set `TANDEM_WEB_URL` and `TANDEM_MCP_URL` so the printed dashboard link and `claude mcp add` command point at the deployed services. These two only change what's printed.

### Keeping the password and tokens stable

Without pinning, every reset generates a new password and new tokens, which breaks any Claude Code connector you configured earlier. To keep them, copy the last line of the output into your shell (or a local, uncommitted `.env` you source):

```sh
export DEMO_PASSWORD='…'
export DEMO_TOKEN_ALEX=tdm_… DEMO_TOKEN_BLAKE=tdm_… DEMO_TOKEN_CASEY=tdm_…
pnpm demo:reset
```

The rules:

- The password needs at least 8 characters.
- A token must have the `tdm_` form the reset printed. Make your own with a reset that has no pins, and copy its tokens.
- A token pinned for two people, or already used by a connection outside the demo, is rejected with `INVALID_INPUT`.

Treat the password and tokens as secrets on a public deployment. Anyone who has them can act as that demo user.

### Raw output

`pnpm demo:reset --json` prints the result as JSON (workspace id, `briefFileId`, password, and per member: user id, connection id, token). `npx convex run seed:resetDemo '{"password":"…","tokens":{"alex":"tdm_…"}}'` from `packages/backend` does the same without the wrapper.

## Connecting the assistants

- **Claude Code:** run the `claude mcp add …` line printed for Alex (and for Blake, if you need a second Claude). If an older `tandem` server is configured, remove it first with `claude mcp remove tandem`.
- **claude.ai, ChatGPT, Gemini:** these can't send a bearer header. They need the OAuth path from issue #21. Until that ships, Casey's Gemini token exists only so the connection shows up on the Assistants page.
- **Dashboard:** sign in as any of the three emails with the printed password.

## Checking it works

```sh
pnpm test:demo
```

This command does the following:

1. Resets the demo.
2. Runs the P0 slice on it: Alex's Claude creates `proposal.md` v1, Blake signs in with the seeded password and saves v2, the agent reads v2, a stale v1 update gets `VERSION_CONFLICT`, and history names both editors.
3. Resets again and prints the new credentials.

It follows `DEMO_PASSWORD` and `DEMO_TOKEN_*`, so pin them first if you don't want them to change. It talks to `CONVEX_URL` (default `http://127.0.0.1:3210`) and spawns a local MCP server unless `MCP_URL` points at a deployed one. Against the cloud demo deployment, run it like this:

```sh
CONVEX_URL=https://<deployment>.convex.cloud CONVEX_DEPLOY_KEY=… \
  MCP_URL=https://<mcp host>/mcp pnpm test:demo
```

It doesn't run as part of `pnpm test:e2e`, where the suite shows as skipped.

## Rehearsal and demo-day checklist

1. Pin `DEMO_PASSWORD` and `DEMO_TOKEN_*` (see above) so connectors survive resets.
2. Run `pnpm test:demo` against the demo deployment. All 6 steps should pass, and it leaves the demo clean.
3. Configure Claude Code with Alex's token. Sign in to the dashboard as Blake in a second browser profile.
4. Rehearse.
5. Run `pnpm demo:reset`. The output should match your pinned values. Sign out and back in as Blake: the reset ends sessions, though an open tab can keep working for up to an hour on its current token.
6. Check the dashboard: only `brief.md` (v1), the approved goal is shown, and there are no pending approvals.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `convex run` targets the wrong deployment | It uses `packages/backend/.env.local`, or `CONVEX_DEPLOY_KEY` when that's set. Check with `npx convex env list` in `packages/backend`. |
| Dashboard sign-in fails right after a reset on a new deployment | The Convex Auth keys are missing. Run `node scripts/setup-auth-env.mjs` in `packages/backend`. |
| Sign-in fails with the old password | Expected: each reset sets a new password unless `DEMO_PASSWORD` is pinned. Use the password from the last reset. |
| Claude Code gets 401 after a reset | Expected without pinned tokens, because the old connections were deleted. Re-add with the new token, or pin `DEMO_TOKEN_*`. |
| `WEAK_PASSWORD` | `DEMO_PASSWORD` is shorter than 8 characters. |
| `INVALID_INPUT` with `field: "tokens.<name>"` | That pinned token is malformed, pinned for two people, or used by a connection outside the demo. Drop the pin to get a new one. |
| The reset fails | Input errors (`WEAK_PASSWORD`, `INVALID_INPUT`) are caught before any account changes. If it fails later, the passwords may already be reset but the rebuild is one transaction, so the demo workspace is either fully replaced or left as it was. Fix the cause and rerun; the passwords and tokens printed by the next successful reset are the valid ones. |
