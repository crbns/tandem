# Tandem MCP server

Remote MCP server (Streamable HTTP, stateless) that lets assistants read and edit Tandem workspace files.

Tools:

- Read: `get_workspace_info` (caller identity, workspaces, roles), `list_files`, `search_files` (name/content match with snippets), `read_file`, `get_file_versions` (revision history with authors, no content)
- Write: `create_document`, `update_document` (optimistic versioning via `expected_version`)

## Run locally

```sh
pnpm install
TANDEM_DEV_TOKENS=alex-dev-token:user_alex,sam-dev-token:user_sam pnpm --filter mcp dev
```

- MCP endpoint: `POST http://localhost:8787/mcp` (GET/DELETE return 405 because the server is stateless)
- Health check: `GET http://localhost:8787/healthz` returns `{"ok":true}`

Every `/mcp` request needs an `api-key: <key>` header with a key from `TANDEM_DEV_TOKENS` (unless dev anon mode is on; see below). A missing, empty, or unknown key gets `401` with `{"error":{"code":"UNAUTHENTICATED",...}}`. The `Authorization` header is ignored. This is temporary until OAuth lands (see `docs/mcp-auth-design.md`). The env vars are read from the process environment; the server doesn't load `.env` files itself.

```sh
curl -s http://localhost:8787/mcp \
  -H "api-key: alex-dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Production build: `pnpm --filter mcp build && node apps/mcp/dist/index.js`.

## Connect MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector UI choose transport **Streamable HTTP**, URL `http://localhost:8787/mcp`, and under **Custom Headers** add `api-key` = `alex-dev-token` (any key from `TANDEM_DEV_TOKENS`) with its toggle on.

## Connect Claude Code

```sh
claude mcp add --transport http tandem http://localhost:8787/mcp --header "api-key: alex-dev-token"
```

## Test from claude.ai (temporary)

claude.ai custom connectors can't send a static `api-key` header, so until Convex OAuth lands (see `docs/mcp-auth-design.md`) there is a dev-only anonymous mode: with `TANDEM_DEV_ANON_USER` set, `/mcp` requests that have **no** `api-key` header act as that user (attributed with client `dev-anon`). Requests that send a key still go through `TANDEM_DEV_TOKENS`, and an empty or unknown key still gets `401`. The server refuses to start in this mode if `NODE_ENV=production` or `TANDEM_BACKEND` isn't `mock`.

1. Start the server in anon mode:

   ```sh
   TANDEM_DEV_ANON_USER=user_alex TANDEM_DEV_TOKENS=alex-dev-token:user_alex,sam-dev-token:user_sam pnpm --filter mcp dev
   ```

2. Expose it with a quick tunnel (in another terminal):

   ```sh
   cloudflared tunnel --url http://localhost:8787
   ```

3. In claude.ai, go to **Settings → Connectors → Add custom connector**, set the URL to `https://<random>.trycloudflare.com/mcp` (the hostname cloudflared printed), and leave the OAuth fields empty.
4. Enable the connector in a chat (the tools/connectors menu in the composer) and ask Claude to list the workspace files.

Caveats:

- Data is the in-memory mock and resets every time the server restarts.
- While the tunnel runs, the URL is public and anyone who has it can read and write as `TANDEM_DEV_ANON_USER`. Stop `cloudflared` when you're done.
- This mode is temporary and will be removed once Convex OAuth lands.

## Environment

| Variable               | Default | Meaning                                                                                                                                                               |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `8787`  | HTTP port                                                                                                                                                             |
| `TANDEM_BACKEND`       | `mock`  | Storage backend. `mock` is in-memory and seeded with `ws_demo` (owner `user_alex`, member `user_sam`) containing `brief.md` v1, and `ws_other` (owner `user_jordan`). |
| `TANDEM_DEV_TOKENS`    | empty   | Comma-separated `key:user_id` pairs for the dev identity resolver; clients send the key in the `api-key` header                                                       |
| `TANDEM_DEV_ANON_USER` | unset   | TEMPORARY. Requests with no `api-key` header act as this user. Mock backend and non-production only (see above).                                                      |

## Layout

- `src/server.ts`: HTTP routing, `api-key` auth, per-request MCP server and transport
- `src/tools.ts`: tool definitions; maps `TandemError` to `isError` results
- `src/auth.ts`: `IdentityResolver` interface, the dev token resolver, and the temporary dev anon wrapper (swap for OAuth/JWT later)
- `src/backend/types.ts`: `TandemBackend` interface; `src/backend/mock.ts`: in-memory implementation
- `src/errors.ts`: `TandemError` and its error codes

The caller's identity always comes from the `api-key` header (or the server's anon config), never from tool arguments.

## Tests

`pnpm --filter mcp test` starts the server on an ephemeral port and drives it with the SDK client.
