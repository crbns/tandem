# Tandem MCP server

Stateless Streamable HTTP MCP server for workspace files. The local server currently uses an in-memory mock backend and development-only static bearer tokens. It is useful for exercising the MCP transport and tool contract; it is **not connected to the Convex data used by the web app** and is not production authentication.

Current tools: `list_files`, `read_file`, `create_document`, and `update_document`. Writes use optimistic versioning: `expected_version` must match the latest file version.

## Run locally

From the repository root, start the web app and MCP server in separate terminals:

```sh
pnpm --filter web dev
```

```sh
TANDEM_DEV_TOKENS=alex-dev-token:user_alex,sam-dev-token:user_sam pnpm --filter mcp dev
```

The web app uses `apps/web/.env.local` and `NEXT_PUBLIC_CONVEX_URL`. The MCP process reads its configuration from the process environment; it does not load `.env` files itself.

- Web: `http://localhost:3000`
- MCP endpoint: `POST http://localhost:8787/mcp` (stateless mode; GET and DELETE return 405)
- Health check: `GET http://localhost:8787/healthz` returns `{"ok":true}`
- Every MCP request requires `Authorization: Bearer <token>`. Missing or unknown tokens receive `401` and a `WWW-Authenticate` header.

The mock is reset when the MCP process restarts. Its seed workspace is `ws_demo`, with members `user_alex` and `user_sam`, and file `brief.md` at version 1. `user_jordan` is seeded in a separate workspace for tenant-isolation checks.

These static tokens are local test credentials only. Do not expose the MCP port publicly or reuse these identities outside the mock.

## Connect MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, URL `http://localhost:8787/mcp`, and bearer token `alex-dev-token` or `sam-dev-token`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `TANDEM_BACKEND` | `mock` | Only `mock` is implemented today. |
| `TANDEM_DEV_TOKENS` | empty | Comma-separated `token:user_id` pairs for the local mock identity resolver. Empty means all MCP calls return 401. |

## Integration status

See [`../../docs/mvp-integration.md`](../../docs/mvp-integration.md) for the shared web/MCP data contract and the work required before connecting MCP to the Convex deployment. In particular, the current bearer-token resolver and mock `user_id` values are not Convex Auth identities, and production agent writes need verified identity plus agent attribution.

## Source layout

- `src/server.ts`: HTTP routing, bearer auth, and one MCP server per request
- `src/tools.ts`: MCP tool schemas and domain-error mapping
- `src/auth.ts`: identity-resolver contract and local static-token resolver
- `src/backend/types.ts`: backend contract
- `src/backend/mock.ts`: in-memory local implementation
- `src/errors.ts`: stable MCP-facing error codes

The caller identity comes from the verified bearer token, never from tool arguments. The static resolver is intentionally suitable only for the mock backend.

## Build and test

```sh
pnpm --filter mcp build
pnpm --filter mcp test
```
