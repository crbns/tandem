# Tandem

Shared workspace files and project context for people and the assistants they use. The MVP has a Next.js dashboard, a Convex backend, and a Streamable HTTP MCP server.

## Current integration status

- `apps/web` authenticates with Convex Auth and uses Convex for workspace and document CRUD, optimistic revisions, and revision history.
- `apps/mcp` currently serves four file tools over Streamable HTTP against an in-memory mock with local static bearer tokens.
- The MCP mock is **not connected to the dashboard's Convex deployment**. OAuth, verified agent identity, and agent-attributed Convex writes remain integration work.

See [`docs/mvp-integration.md`](docs/mvp-integration.md) for the shared web/MCP data contract, known gaps, and handoff checklist.

## Run locally

Install dependencies once:

```sh
pnpm install
```

Start the dashboard in one terminal:

```sh
pnpm --filter web dev
```

Start the local mock MCP server in another terminal:

```sh
TANDEM_DEV_TOKENS=alex-dev-token:user_alex,sam-dev-token:user_sam pnpm --filter mcp dev
```

The dashboard reads `NEXT_PUBLIC_CONVEX_URL` from `apps/web/.env.local`. The MCP server reads environment variables from the process and does not load `.env` files itself. See [`apps/mcp/README.md`](apps/mcp/README.md) for Inspector connection details and seeded mock data.

## Validate builds

```sh
pnpm --filter web check-types
pnpm --filter mcp check-types
pnpm --filter mcp build
```

## Deployment

The web Docker image uses Next.js standalone output and is designed for Vultr. `NEXT_PUBLIC_CONVEX_URL` is embedded at build time. Convex functions are deployed separately from `packages/backend` with a deployment key. Do not point an unreviewed MCP server at shared or production data; the current MCP backend is mock-only.
