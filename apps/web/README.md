# Tandem web dashboard (`apps/web`)

Next.js (App Router) dashboard where people sign in, browse workspace files, edit Markdown/text with version-aware saves, and read revision history. It talks to Convex directly through one-shot queries and mutations, plus one small reactive subscription that tells lists to refetch when something lands in the workspace. The same Convex functions back the MCP server, so permission checks, `expectedVersion` locking, and revision inserts live in the backend, not here.

- Gate status: [`STATUS.md`](STATUS.md)
- Backend contract and requests for Person 2: [`CONTRACT_NOTES.md`](CONTRACT_NOTES.md)

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

Sign in with a user Person 2 seeded. Convex Auth secrets (`JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`) live in the Convex deployment's env, not here.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | real mode | Inlined at **build** time |
| `NEXT_PUBLIC_DEFAULT_WORKSPACE_ID` | no | Skip workspace lookup after sign-in |
| `NEXT_PUBLIC_USE_MOCKS` | no | `true` = in-memory backend + fake session. Forced to `false` in the Docker image |
| `NEXT_PUBLIC_MCP_URL` | no | Public base URL of the MCP server (e.g. `https://mcp.<domain>`). Used in the "Connect an assistant" setup command; inlined at **build** time |

## Scripts

```bash
pnpm --filter web test          # vitest: save machine, mock API, errors, helpers
pnpm --filter web check-types
pnpm --filter web lint
pnpm --filter web build
```

## Layout

```
app/                     routes: /, /sign-in, /invite/[token], /w/[workspaceId], …/approvals, …/assistants, …/files/[fileId], …/history
proxy.ts                 Convex Auth route protection (Next 16's name for middleware; no-op in mock mode)
lib/api/                 TandemApi interface, Convex + mock adapters, error normalization
lib/editor/saveMachine   pure save/conflict reducer: never discards a draft, never auto-retries
components/              shell, file table, editor, conflict panel, history, approvals, assistant connections
```

## Deploy to Vultr

The web image runs in the root stack (`deploy/compose.yml`, Caddy + web + MCP); the full runbook is [`docs/deploy.md`](../../docs/deploy.md). The image builds from the **repo root** (it runs `turbo prune web --docker`). `NEXT_PUBLIC_*` values are baked in at build time, so rebuild after changing them.

Local build check:

```bash
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud -t tandem-web .
```

Seed/reset of demo data is owned by Person 2 (`packages/backend`). Their reset instructions will be linked here once they exist.
