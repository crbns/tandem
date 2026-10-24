# Tandem MCP mock server (eval harness)

> **Not the real MCP server.** Tandem's MCP server is `@convex-dev/mcp` in the Convex deployment, at `https://<deployment>.convex.site/mcp`, with OAuth and API keys (`packages/backend/convex/mcp.ts`, setup in [`docs/local-dev.md`](../../docs/local-dev.md)). This package is an in-memory mock with the same 14 tools, used by the skill eval (`skills/tandem/eval`) and for local tool experiments. It never talks to Convex and never deploys.

Stateless Streamable HTTP server over `MockBackend`.

Tools:

- Read: `get_workspace_info` (caller identity, workspaces, roles, the default workspace's `members` as `{ user_id, name, role }` for ownership proposals, and this connection's `last_synced_at` / `last_action_at`), `list_files` (a folder's folders and files, or a flattened subtree with `recursive`; every entry has a `path`), `search_files` (name/content match with snippets), `read_file` (by `file_id` or `path`), `get_file_versions` (revision history with authors, no content), `get_approvals` (context proposals by status, newest first)
- Sync: `sync_workspace` (approved context, pending proposal summaries, changed files, events, and an opaque `cursor`; pass it back as `since` for incremental syncs). It only records the last sync time.
- Write: `create_document` (in a folder via `parent_id` or `folder_path`), `update_document` (optimistic versioning via `expected_version`), `create_folder` (idempotent `mkdir -p`), `move_file` (versioned like an edit), `move_folder` (checked by `expected_revision`), `propose_context_change` (creates a pending proposal, never changes context), `publish_work` (records an authorized deliverable or finding)

Loop guidance: the server sends `MCP_INSTRUCTIONS` at initialize, and successful `sync_workspace`, `create_document`, `update_document`, `publish_work` and `propose_context_change` results carry `next_steps` (fixed text plus server-generated ids and versions, never workspace content) restating "read before, write back after": `sync_workspace` adds a step to seed an empty approved context from the files the assistant reads or saves, and saves ask to propose what the file shows that the context lacks, citing its id in `source_ids`. Both say to skip anything a pending proposal already covers (a pending proposal leaves the context empty, and nothing dedupes proposals). `src/loop.ts` is a copy of the Convex server's `convex/lib/mcpLoop.ts`; `test/loopParity.test.ts` keeps them identical.

Approving or rejecting proposals is not an MCP tool: humans do it in the dashboard (`TandemBackend.decideProposal`, owners and admins only). `TandemBackend.applyContextChange` always throws `APPROVAL_REQUIRED` for agents.

## Data model

Documented as the `TandemBackend` contract in `src/backend/types.ts`:

- **StructuredContext** per workspace, versioned by `context_version`: goal, scope, constraints, approved decisions, ownership, open questions. Only a human owner or admin can change it.
- **ContextProposal**: a pending change to one field (`goal`, `scope`, `constraints`, `decisions`, `ownership`) with rationale, source file ids, `base_context_version`, and who proposed and decided it. Approval requires that base version to match the current `context_version`, otherwise it fails with `VERSION_CONFLICT` without changing the context or proposal; stale proposals can still be rejected. Direct human context changes also increment `context_version` and invalidate pending approvals.
- **PublishedWork**: a deliverable or finding with title, summary, and file ids.
- **WorkspaceEvent**: per-workspace monotonic `seq` for file, context, and publish changes. Summaries are short metadata, never document content. The sync cursor is base64url JSON of the workspace id and last seq.
- **AgentConnection**: per user and client, `last_synced_at` and `last_action_at`. Presence is these timestamps, never "online".

## Run locally

```sh
pnpm install
export ALEX_KEY=$(openssl rand -hex 24) SAM_KEY=$(openssl rand -hex 24)
TANDEM_DEV_TOKENS=${ALEX_KEY}:user_alex,${SAM_KEY}:user_sam pnpm --filter mcp dev
```

Generate dev keys with `openssl rand -hex 24` rather than reusing guessable ones; anyone who can reach the server and knows a key acts as that user. Keep the braces in `${ALEX_KEY}:user_alex`: zsh reads an unbraced `$ALEX_KEY:u` as a modifier and drops the colon, which leaves every key unusable.

The keys are exported only in the terminal running the server. Before using `$ALEX_KEY` anywhere else (curl, Claude Code, MCP Inspector), run `echo $ALEX_KEY` in the server terminal and copy the value, or export the same value in the other terminal.

- MCP endpoint: `POST http://localhost:8787/mcp` (GET/DELETE return 405 because the server is stateless)
- Health check: `GET http://localhost:8787/healthz` returns `{"ok":true}`
- The server binds `127.0.0.1` by default, so it isn't reachable from your LAN. Set `HOST` (e.g. `HOST=0.0.0.0` in a container) to change that.
- `/mcp` requests that carry an `Origin` header not listed in `TANDEM_ALLOWED_ORIGINS` get `403` (DNS-rebinding protection). Server-side clients (claude.ai, Claude Code, curl) send no `Origin` and are unaffected.

Every `/mcp` request needs an `api-key: <key>` header with a key from `TANDEM_DEV_TOKENS` (unless dev anon mode is on; see below). A missing, empty, comma-containing (e.g. a repeated header), or unknown key gets `401` with `WWW-Authenticate: ApiKey realm="tandem"` and `{"error":{"code":"UNAUTHENTICATED",...}}`. The `Authorization` header is ignored. The env vars are read from the process environment; the server doesn't load `.env` files itself.

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

## Test from claude.ai against the mock (dev only)

To try tool behavior in claude.ai against mock data, there is a dev-only anonymous mode (the real server uses OAuth instead): with `TANDEM_DEV_ANON_USER` set, `/mcp` requests that have **no** `api-key` header act as that user (attributed with client `dev-anon`). Requests that send a key still go through `TANDEM_DEV_TOKENS`, and an empty or unknown key still gets `401`. The server refuses to start in this mode unless the backend is the mock and `NODE_ENV` is exactly `development` or `test`. `pnpm --filter mcp dev` sets `NODE_ENV=development`; if you run the server another way, set it yourself.

1. Start the server in anon mode:

   ```sh
   TANDEM_DEV_ANON_USER=user_alex TANDEM_DEV_TOKENS=${ALEX_KEY}:user_alex,${SAM_KEY}:user_sam pnpm --filter mcp dev
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

## Environment

| Variable                 | Default     | Meaning                                                                                                                                                |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                   | `8787`      | HTTP port                                                                                                                                              |
| `HOST`                   | `127.0.0.1` | Interface to bind. Use `0.0.0.0` only inside a container.                                                                                              |
| `NODE_ENV`               | unset       | Must be exactly `development` or `test` for dev anon mode. The `dev` script sets `development`.                                                        |
| `TANDEM_ALLOWED_ORIGINS` | empty       | Comma-separated browser origins allowed to call `/mcp`. Any other `Origin` gets `403`; requests without `Origin` are unaffected. Trailing `/` is OK.   |
| `TANDEM_BACKEND`         | `mock`      | Only `mock` is supported. It is in-memory and seeded with `ws_demo` (owner `user_alex`, admin `user_taylor`, member `user_sam`) containing `brief.md` v1 and project context, and `ws_other` (owner `user_jordan`).                   |
| `TANDEM_DEV_TOKENS`      | empty       | Comma-separated `key:user_id` pairs (split on the first `:`); clients send the key in the `api-key` header. Generate keys with `openssl rand -hex 24`. |
| `TANDEM_DEV_ANON_USER`   | unset       | TEMPORARY. Requests with no `api-key` header act as this user. Mock backend and `NODE_ENV=development`/`test` only (see above).                        |

## Layout

- `src/server.ts`: HTTP routing, `api-key` auth, per-request MCP server and transport
- `src/tools.ts`: tool definitions; maps `TandemError` to `isError` results
- `src/auth.ts`: `IdentityResolver` interface, the dev token resolver, and the temporary dev anon wrapper (swap for OAuth/JWT later)
- `src/backend/types.ts`: `TandemBackend` interface; `src/backend/mock.ts`: in-memory implementation; `src/backend/cursor.ts`: sync cursor encoding
- `src/errors.ts`: `TandemError` and its error codes
- `src/names.ts`: `nameKey`, the file-name normalization used for `NAME_EXISTS`

The caller's identity always comes from the `api-key` header (or the server's anon config), never from tool arguments.

## Keeping the mock in step

The tool names, descriptions and result shapes mirror the Convex server, whose mapping lives in `packages/backend/convex/lib/mcpContract.ts`. When you change a tool there, change it here too so the eval measures what assistants really see.

## Tests

`pnpm --filter mcp test` starts the server on an ephemeral port and drives it with the SDK client.
