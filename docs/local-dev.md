# Local development: Convex + dashboard + MCP

Everything runs on your machine against one local Convex deployment: no Convex account, cloud deployment, or deploy key is needed.

## 1. Start the local Convex backend

```sh
cd packages/backend
CONVEX_AGENT_MODE=anonymous npx convex dev
```

The first run creates an anonymous local deployment and writes `packages/backend/.env.local` (`CONVEX_DEPLOYMENT`, `CONVEX_URL=http://127.0.0.1:3210`, `CONVEX_SITE_URL=http://127.0.0.1:3211`; gitignored). Later runs reuse it. `CONVEX_AGENT_MODE=anonymous` is only needed when the CLI isn't logged in; it's harmless otherwise.

`npx convex dev` keeps running: it serves the backend on ports 3210/3211, pushes functions and regenerates `convex/_generated` whenever `convex/` changes. Stop it with Ctrl-C (or `kill` the process); data persists in the local deployment and comes back on the next `npx convex dev`. Use `npx convex dev --once` to push and run codegen, then exit (the backend stops with it).

## 2. Configure Convex Auth (once per deployment)

With `npx convex dev` running, in another terminal:

```sh
cd packages/backend
node scripts/setup-auth-env.mjs
npx convex env list   # JWKS, JWT_PRIVATE_KEY, SITE_URL
```

The script generates an RS256 key pair with `jose` and sets `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL=http://localhost:3000` (override with `SITE_URL=...`) on the current deployment without printing the keys. Rerunning it rotates the keys and signs everyone out.

## 3. Run the dashboard

`apps/web/.env.local` must contain `NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210` (create it if it's missing). Then:

```sh
pnpm --filter web dev   # http://localhost:3000
```

## 4. Use the MCP server

There is no separate MCP process: `@convex-dev/mcp` serves it from the deployment's HTTP actions at `<CONVEX_SITE_URL>/mcp` (`http://127.0.0.1:3211/mcp` locally), together with the OAuth endpoints (`/mcp/oauth/*`) and the discovery documents under `/.well-known/`. The tools live in `packages/backend/convex/mcp.ts`.

Get an API key: create one in the dashboard (Assistants page → Create API key), or for scripted tests:

```sh
cd packages/backend
TOKEN=$(CONVEX_URL=http://127.0.0.1:3210 node scripts/dev-agent-token.mjs)
```

`dev-agent-token.mjs [email] [password] [client]` signs up or signs in a Password user (default `dev@example.com`), creates a workspace if they have none, and prints a new `mcp_sk_…` key for one connection. It's for local deployments only.

```sh
curl -s http://127.0.0.1:3211/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

OAuth clients (claude.ai custom connectors) need a public HTTPS URL, so they can't reach a local deployment directly. Locally, the OAuth flow is covered by `convex/agent.test.ts` and step 10 of the e2e test. The consent page is `http://localhost:3000/oauth/consent`: the deployment's `SITE_URL` (step 2) decides where the component sends people, and `MCP_CONSENT_URL` overrides it.

`apps/mcp` is now only a mock-backed harness for the skill eval (`TANDEM_DEV_TOKENS`, `TANDEM_DEV_ANON_USER`); it never talks to Convex.

## 5. Demo seed and reset

```sh
pnpm demo:reset
```

Deletes and rebuilds only the demo workspace (Alex, Blake and Casey, research and requirements files, approved context, three tasks, one pending proposal, and one agent connection each; the full list is in [demo-seed.md](demo-seed.md#what-it-creates)), then prints sign-in credentials and agent tokens. `pnpm test:demo` runs the P0 slice on the seeded workspace. See [demo-seed.md](demo-seed.md) for pinning the password and tokens, cloud deployments, and the rehearsal checklist.

## Existing deployments: context entry IDs

Deploy the widened schema/functions before backfilling older context rows. With
that deployment selected in `packages/backend/.env.local`, run from the repo root:

```sh
pnpm --filter @repo/backend exec convex run contextMigrations:backfillEntryIds '{"paginationOpts":{"cursor":null,"numItems":50}}'
```

Repeat with the returned `continueCursor` as `cursor` until `isDone` is true.
The migration is idempotent and preserves the IDs already exposed by legacy
reads. Stored IDs remain optional so older snapshots/seeds can still load;
new list writes include IDs and reads tolerate rows awaiting backfill.

## Tests

```sh
pnpm --filter @repo/backend test         # convex-test unit tests (no running backend needed)
pnpm --filter @repo/backend check-types
pnpm --filter mcp test                   # the eval harness's mock server
pnpm --filter web test
```

End to end (tests/e2e): `pnpm test:e2e` runs the P0 slice against the live local deployment, its MCP endpoint (API keys and a full OAuth consent flow) and the dashboard's own data layer (`apps/web/lib/api/convex.ts`). It reuses a running `npx convex dev` at `CONVEX_URL` (default `http://127.0.0.1:3210`) or starts one and stops it afterwards. The MCP URL is `CONVEX_SITE_URL` + `/mcp`; without it, the e2e uses the next port after `CONVEX_URL`'s. It needs step 2 done once. Every run signs up fresh users and creates fresh workspaces, so reruns pass. Set `E2E_EVIDENCE=<path>` to write the ids and results of each step as JSON. It is not part of `pnpm test`.
