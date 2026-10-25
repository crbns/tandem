# Tandem web dashboard (`apps/web`)

Next.js (App Router) dashboard where people sign in, browse workspace files, edit Markdown/text with version-aware saves, and read revision history. It talks to Convex directly through one-shot queries and mutations, plus one small reactive subscription that tells lists to refetch when something lands in the workspace. The same Convex functions back the MCP server, so permission checks, `expectedVersion` locking, and revision inserts live in the backend, not here.

- Gate status: [`STATUS.md`](STATUS.md)
- Backend contract: [`CONTRACT_NOTES.md`](CONTRACT_NOTES.md)

## Run locally

This repo uses pnpm (`packageManager` in the root `package.json`). If `pnpm` isn't on your PATH, `npx pnpm@11.25.0 …` works the same.

### Mock mode (no backend needed)

```bash
cp apps/web/.env.example apps/web/.env.local
pnpm install
pnpm --filter web dev
```

Open http://localhost:3000 and sign in as `demo@tandem.dev` / `demo1234` (or `alex@tandem.dev`). The mock store is in memory: a full page reload resets it.

To demo a conflict: open `proposal.md`, click **Simulate agent edit** (mock mode only), type something, and press **Save** (or Ctrl/Cmd+S).

### Real mode (Convex)

In `apps/web/.env.local`:

```
NEXT_PUBLIC_CONVEX_URL=https://<dev-deployment>.convex.cloud
NEXT_PUBLIC_DEFAULT_WORKSPACE_ID=      # optional
NEXT_PUBLIC_USE_MOCKS=false
```

Sign in with an existing account or create one. Convex Auth secrets (`JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`) live in the Convex deployment's env, not here.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | real mode | Inlined at **build** time |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | no | Override HTTP actions origin for local binary previews |
| `NEXT_PUBLIC_DEFAULT_WORKSPACE_ID` | no | Skip workspace lookup after sign-in |
| `NEXT_PUBLIC_USE_MOCKS` | no | `true` = in-memory backend + fake session. Forced to `false` in the Docker image |

## Scripts

```bash
pnpm --filter web test          # vitest: save machine, mock API, errors, helpers
pnpm --filter web check-types
pnpm --filter web lint
pnpm --filter web build
```

## Layout

```
app/                     routes: /, /sign-in, /invite/[token], /w/[workspaceId], …/context, …/live, …/assistants, …/files/[fileId], …/history
proxy.ts                 Convex Auth route protection (Next 16's name for middleware; no-op in mock mode)
lib/api/                 TandemApi interface, Convex + mock adapters, error normalization
lib/editor/saveMachine   pure save/conflict reducer: never discards a draft, never auto-retries
components/              shell, file table, editor, conflict panel, history, project context, Live, assistant connections
deploy/                  optional container self-hosting examples
```

## Deployment

Vercel hosts the dashboard. Use `apps/web` as the project root and set `NEXT_PUBLIC_CONVEX_URL` to the Convex Cloud deployment URL. Set `NEXT_PUBLIC_USE_MOCKS=false`. Public env values are embedded at build time; rebuild after changing them.

Convex Cloud hosts the backend and `/mcp` endpoint. Set the deployment's `SITE_URL` to the dashboard origin. The MCP OAuth consent page lives at `/oauth/consent` on that dashboard. See [local setup](../../docs/local-dev.md) and [demo seed instructions](../../docs/demo-seed.md).

`Dockerfile` and `deploy/` are optional container examples, separate from the Vercel deployment. Their build has not been verified in this cleanup.
