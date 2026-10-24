# Tandem MCP server

Remote MCP server (Streamable HTTP, stateless) that lets assistants read and edit Tandem workspace files.

Tools: `list_files`, `read_file`, `create_document`, `update_document` (optimistic versioning via `expected_version`).

## Run locally

```sh
pnpm install
export ALEX_KEY=$(openssl rand -hex 24) SAM_KEY=$(openssl rand -hex 24)
TANDEM_DEV_TOKENS=$ALEX_KEY:user_alex,$SAM_KEY:user_sam pnpm --filter mcp dev
```

Generate dev keys with `openssl rand -hex 24` rather than reusing guessable ones; anyone who can reach the server and knows a key acts as that user.

- MCP endpoint: `POST http://localhost:8787/mcp` (GET/DELETE return 405 because the server is stateless)
- Health check: `GET http://localhost:8787/healthz` returns `{"ok":true}`
- The server binds `127.0.0.1` by default, so it isn't reachable from your LAN. Set `HOST` (e.g. `HOST=0.0.0.0` in a container) to change that.
- `/mcp` requests that carry an `Origin` header not listed in `TANDEM_ALLOWED_ORIGINS` get `403` (DNS-rebinding protection). Server-side clients (claude.ai, Claude Code, curl) send no `Origin` and are unaffected.

Every `/mcp` request needs an `api-key: <key>` header with a key from `TANDEM_DEV_TOKENS` (unless dev anon mode is on; see below). A missing, empty, comma-containing (e.g. a repeated header), or unknown key gets `401` with `WWW-Authenticate: ApiKey realm="tandem"` and `{"error":{"code":"UNAUTHENTICATED",...}}`. The `Authorization` header is ignored. This is temporary until OAuth lands (see `docs/mcp-auth-design.md`). The env vars are read from the process environment; the server doesn't load `.env` files itself.

```sh
curl -s http://localhost:8787/mcp \
  -H "api-key: $ALEX_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Production build: `pnpm --filter mcp build && node apps/mcp/dist/index.js`. The dev script sets `NODE_ENV=development`; the production command doesn't, so dev anon mode refuses to start there.

## Connect MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector UI choose transport **Streamable HTTP**, URL `http://localhost:8787/mcp`, and under **Custom Headers** add `api-key` = your `$ALEX_KEY` (any key from `TANDEM_DEV_TOKENS`) with its toggle on. If you use the Inspector's direct (browser) connection instead of its proxy, add its origin, e.g. `TANDEM_ALLOWED_ORIGINS=http://localhost:6274`.

## Connect Claude Code

```sh
claude mcp add --transport http tandem http://localhost:8787/mcp --header "api-key: $ALEX_KEY"
```

## Test from claude.ai (temporary)

claude.ai custom connectors can't send a static `api-key` header, so until Convex OAuth lands (see `docs/mcp-auth-design.md`) there is a dev-only anonymous mode: with `TANDEM_DEV_ANON_USER` set, `/mcp` requests that have **no** `api-key` header act as that user (attributed with client `dev-anon`). Requests that send a key still go through `TANDEM_DEV_TOKENS`, and an empty or unknown key still gets `401`. The server refuses to start in this mode unless the backend is the mock and `NODE_ENV` is exactly `development` or `test`. `pnpm --filter mcp dev` sets `NODE_ENV=development`; if you run the server another way, set it yourself.

1. Start the server in anon mode:

   ```sh
   TANDEM_DEV_ANON_USER=user_alex TANDEM_DEV_TOKENS=$ALEX_KEY:user_alex,$SAM_KEY:user_sam pnpm --filter mcp dev
   ```

2. Expose it with a quick tunnel (in another terminal):

   ```sh
   cloudflared tunnel --url http://localhost:8787
   ```

3. In claude.ai, go to **Settings → Connectors → Add custom connector**, set the URL to `https://<random>.trycloudflare.com/mcp` (the hostname cloudflared printed), and leave the OAuth fields empty.
4. Enable the connector in a chat (the tools/connectors menu in the composer) and ask Claude to list the workspace files.

Caveats:

- Data is the in-memory mock and resets every time the server restarts.
- cloudflared connects to `localhost`, so the default `127.0.0.1` bind is enough; don't set `HOST=0.0.0.0` for this.
- While the tunnel runs, the URL is public and anyone who has it can read and write as `TANDEM_DEV_ANON_USER`. Stop `cloudflared` when you're done.
- This mode is temporary and will be removed once Convex OAuth lands.

## Environment

| Variable                 | Default     | Meaning                                                                                                                                                |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                   | `8787`      | HTTP port                                                                                                                                              |
| `HOST`                   | `127.0.0.1` | Interface to bind. Use `0.0.0.0` only inside a container.                                                                                              |
| `NODE_ENV`               | unset       | Must be exactly `development` or `test` for dev anon mode. The `dev` script sets `development`.                                                        |
| `TANDEM_ALLOWED_ORIGINS` | empty       | Comma-separated browser origins allowed to call `/mcp`. Any other `Origin` gets `403`; requests without `Origin` are unaffected.                       |
| `TANDEM_BACKEND`         | `mock`      | Storage backend. `mock` is in-memory and seeded with workspace `ws_demo` (members `user_alex`, `user_sam`) containing `brief.md` v1.                   |
| `TANDEM_DEV_TOKENS`      | empty       | Comma-separated `key:user_id` pairs (split on the first `:`); clients send the key in the `api-key` header. Generate keys with `openssl rand -hex 24`. |
| `TANDEM_DEV_ANON_USER`   | unset       | TEMPORARY. Requests with no `api-key` header act as this user. Mock backend and `NODE_ENV=development`/`test` only (see above).                        |

## Layout

- `src/server.ts`: HTTP routing, `api-key` auth, per-request MCP server and transport
- `src/tools.ts`: tool definitions; maps `TandemError` to `isError` results
- `src/auth.ts`: `IdentityResolver` interface, the dev token resolver, and the temporary dev anon wrapper (swap for OAuth/JWT later)
- `src/backend/types.ts`: `TandemBackend` interface; `src/backend/mock.ts`: in-memory implementation
- `src/errors.ts`: `TandemError` and its error codes
- `src/names.ts`: `nameKey`, the file-name normalization used for `NAME_EXISTS`

The caller's identity always comes from the `api-key` header (or the server's anon config), never from tool arguments.

## Tests

`pnpm --filter mcp test` starts the server on an ephemeral port and drives it with the SDK client.
