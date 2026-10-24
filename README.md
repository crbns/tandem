# Tandem

Shared workspace files and project context for people and the assistants they use. The MVP has a Next.js dashboard, a Convex backend, and a Streamable HTTP MCP server.

## Current integration status

- `packages/backend` (Convex) is the single source of truth: workspaces, members and invites, files with optimistic revisions, structured context, proposals and approvals, and agent connections.
- `apps/web` signs people up and in with Convex Auth. It covers files, the editor with version conflicts, revision history, approvals, and assistant connections.
- `apps/mcp` serves the full MCP tool surface over Streamable HTTP against Convex (`TANDEM_BACKEND=convex`).
  - Each assistant authenticates with a per-person, per-workspace `tdm_` token created in the dashboard. Convex verifies the token on every call and attributes writes to "person via client".
  - The in-memory mock backend remains for the skill eval.
- Not yet built: OAuth for claude.ai web connectors. Claude Code connects with the token as a Bearer header.

See [`docs/mvp-integration.md`](docs/mvp-integration.md) for the shared web/MCP data contract.

## Run locally

```sh
pnpm install
```

[`docs/local-dev.md`](docs/local-dev.md) runs everything against one local Convex deployment: backend, dashboard, MCP server, and the end-to-end test (`pnpm test:e2e`). In short:

```sh
cd packages/backend && CONVEX_AGENT_MODE=anonymous npx convex dev   # terminal 1: local deployment on :3210
pnpm --filter web dev            # terminal 2, http://localhost:3000 (apps/web/.env.local: NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210)
TANDEM_BACKEND=convex CONVEX_URL=http://127.0.0.1:3210 pnpm --filter mcp dev   # terminal 3
```

Sign-in keys need a one-time `node scripts/setup-auth-env.mjs` in `packages/backend`; see the guide for details.

## Validate

```sh
pnpm check-types
pnpm test
pnpm --filter web lint
pnpm test:e2e    # needs a local Convex deployment; see docs/local-dev.md
```

## Deployment

Convex Cloud hosts the backend. One Vultr instance runs Caddy (HTTPS), the dashboard and the MCP server from [`deploy/compose.yml`](deploy/compose.yml):

```sh
docker compose -f deploy/compose.yml --env-file .env up -d --build
```

The runbook, covering the Convex production deploy and sign-in keys, the Vultr instance, DNS, env vars and the smoke test, is [`docs/deploy.md`](docs/deploy.md).
