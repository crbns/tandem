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

## 4. Run the MCP server against Convex

Get an agent token: create one in the dashboard (Assistants page), or for scripted tests:

```sh
cd packages/backend
TOKEN=$(CONVEX_URL=http://127.0.0.1:3210 node scripts/dev-agent-token.mjs)
```

`dev-agent-token.mjs [email] [password] [client]` signs up or signs in a Password user (default `dev@example.com`), creates a workspace if they have none, and prints a new `tdm_…` token for one connection. It's for local deployments only.

```sh
TANDEM_BACKEND=convex CONVEX_URL=http://127.0.0.1:3210 pnpm --filter mcp dev
```

```sh
curl -s http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The token can also go in the `api-key` header. The MCP server holds no Convex credentials: it forwards the token, and Convex verifies it on every call. `TANDEM_DEV_TOKENS` and `TANDEM_DEV_ANON_USER` apply to the mock backend only (anon mode refuses to start with Convex).

## 5. Demo seed and reset

```sh
pnpm demo:reset
```

Deletes and rebuilds only the demo workspace (Alex, Blake and Casey, `brief.md` v1, an approved goal and scope, one agent connection each), then prints sign-in credentials and agent tokens. `pnpm test:demo` runs the P0 slice on the seeded workspace. See [demo-seed.md](demo-seed.md) for pinning the password and tokens, cloud deployments, and the rehearsal checklist.

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
pnpm --filter mcp test
pnpm --filter web test
```

End to end (tests/e2e): `pnpm test:e2e` runs the P0 slice against the live local deployment, the real MCP server (spawned on a free port with `TANDEM_BACKEND=convex`) and the dashboard's own data layer (`apps/web/lib/api/convex.ts`). It reuses a running `npx convex dev` at `CONVEX_URL` (default `http://127.0.0.1:3210`) or starts one and stops it afterwards. It needs step 2 done once. Every run signs up fresh users and creates fresh workspaces, so reruns pass. Set `E2E_EVIDENCE=<path>` to write the ids and results of each step as JSON. It is not part of `pnpm test`.
