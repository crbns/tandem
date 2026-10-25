# Tandem

Shared workspace files and project context for people and the assistants they use. The MVP has a Next.js dashboard and a Convex backend that also serves the remote MCP server.

Live app: https://tandem-pink.vercel.app

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

Vercel hosts `apps/web`. Set its root directory to `apps/web` and provide `NEXT_PUBLIC_CONVEX_URL` at build time. Set `NEXT_PUBLIC_USE_MOCKS=false` for shared data. The optional `NEXT_PUBLIC_CONVEX_SITE_URL` overrides the HTTP actions origin for local binary previews.
