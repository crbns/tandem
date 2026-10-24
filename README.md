# Tandem

Shared workspace files and project context for people and the assistants they use. The MVP has a Next.js dashboard and a Convex backend that also serves the remote MCP server.

## Current integration status

- `apps/web` authenticates with Convex Auth and uses Convex for workspace and document CRUD, optimistic revisions, and revision history.
- The MCP server is `@convex-dev/mcp` inside the Convex deployment, at `<CONVEX_SITE_URL>/mcp` (`packages/backend/convex/mcp.ts`). It serves all 11 tools, is its own OAuth 2.1 authorization server for claude.ai-style connectors (consent page: `apps/web/app/oauth/consent`), and accepts per-connection API keys for Claude Code. Every credential acts for one `agent_connections` row: one person in one workspace, with agent attribution.
- `apps/mcp` is a mock-backed harness for the skill eval only. It never talks to Convex and never deploys.

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

The dashboard reads `NEXT_PUBLIC_CONVEX_URL` from `apps/web/.env.local`. The MCP server comes with the Convex deployment: see [`docs/local-dev.md`](docs/local-dev.md) for running Convex locally and calling `/mcp` with an API key. For the skill eval's mock server, see [`apps/mcp/README.md`](apps/mcp/README.md).

## Validate builds

```sh
pnpm --filter web check-types
pnpm --filter mcp check-types
pnpm --filter mcp build
```

## Deployment

The web Docker image uses Next.js standalone output and is designed for Vultr. `NEXT_PUBLIC_CONVEX_URL` is embedded at build time. Convex functions are deployed separately from `packages/backend` with a deployment key. Do not point an unreviewed MCP server at shared or production data; the current MCP backend is mock-only.
