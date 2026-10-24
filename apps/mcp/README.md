# Tandem MCP server

Remote MCP server (Streamable HTTP, stateless) that lets assistants read and edit Tandem workspace files.

Tools: `list_files`, `read_file`, `create_document`, `update_document` (optimistic versioning via `expected_version`).

## Run locally

```sh
pnpm install
TANDEM_DEV_TOKENS=alex-dev-token:user_alex,sam-dev-token:user_sam pnpm --filter mcp dev
```

- MCP endpoint: `POST http://localhost:8787/mcp` (GET/DELETE return 405 because the server is stateless)
- Health check: `GET http://localhost:8787/healthz` returns `{"ok":true}`

Every `/mcp` request needs `Authorization: Bearer <token>`. Missing or unknown tokens get `401` with a `WWW-Authenticate: Bearer` header. The env vars are read from the process environment; the server doesn't load `.env` files itself.

Production build: `pnpm --filter mcp build && node apps/mcp/dist/index.js`.

## Connect MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector UI choose transport **Streamable HTTP**, URL `http://localhost:8787/mcp`, and under Authentication set the bearer token to one from `TANDEM_DEV_TOKENS` (e.g. `alex-dev-token`).

## Environment

| Variable            | Default | Meaning                                                                                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`              | `8787`  | HTTP port                                                                                                                            |
| `TANDEM_BACKEND`    | `mock`  | Storage backend. `mock` is in-memory and seeded with workspace `ws_demo` (members `user_alex`, `user_sam`) containing `brief.md` v1. |
| `TANDEM_DEV_TOKENS` | empty   | Comma-separated `token:user_id` pairs for the dev identity resolver                                                                  |

## Layout

- `src/server.ts`: HTTP routing, bearer auth, per-request MCP server and transport
- `src/tools.ts`: tool definitions; maps `TandemError` to `isError` results
- `src/auth.ts`: `IdentityResolver` interface and the dev token resolver (swap for OAuth/JWT later)
- `src/backend/types.ts`: `TandemBackend` interface; `src/backend/mock.ts`: in-memory implementation
- `src/errors.ts`: `TandemError` and its error codes

The caller's identity always comes from the bearer token, never from tool arguments.

## Tests

`pnpm --filter mcp test` starts the server on an ephemeral port and drives it with the SDK client.
