# Tandem MCP server

Remote MCP server (Streamable HTTP, stateless) that lets assistants read and edit Tandem workspace files and project context.

Tools:

- Read: `get_workspace_info` (caller identity, workspaces, roles, the default workspace's `members` as `{ user_id, name, role }` for ownership proposals, and this connection's `last_synced_at` / `last_action_at`), `list_files`, `search_files` (name/content match with snippets), `read_file`, `get_file_versions` (revision history with authors, no content), `get_approvals` (context proposals by status, newest first)
- Sync: `sync_workspace` (approved context, pending proposal summaries, changed files, events, and an opaque `cursor`; pass it back as `since` for incremental syncs). It only records the last sync time.
- Write: `create_document`, `update_document` (optimistic versioning via `expected_version`), `propose_context_change` (creates a pending proposal, never changes context), `publish_work` (records an authorized deliverable or finding)

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

Every `/mcp` request needs an `api-key: <key>` header with a key from `TANDEM_DEV_TOKENS` (unless dev anon mode is on; see below). A missing, empty, comma-containing (e.g. a repeated header), or unknown key gets `401` with `WWW-Authenticate: ApiKey realm="tandem"` and `{"error":{"code":"UNAUTHENTICATED",...}}`. With the mock backend the `Authorization` header is ignored (the Convex backend accepts it; see "Run against Convex"). This is temporary until OAuth lands (see `docs/mcp-auth-design.md`). The env vars are read from the process environment; the server doesn't load `.env` files itself.

```sh
curl -s http://localhost:8787/mcp \
  -H "api-key: $ALEX_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Production build: `pnpm --filter mcp build && node apps/mcp/dist/index.js`. The dev script sets `NODE_ENV=development`; the production command doesn't, so dev anon mode refuses to start there.

## Run against Convex

`TANDEM_BACKEND=convex CONVEX_URL=<deployment url>` swaps the mock for `src/backend/convex.ts`, which calls the token-verifying functions in `packages/backend/convex/mcp.ts`. Local setup, including how to get a token, is in [`docs/local-dev.md`](../../docs/local-dev.md).

- **Auth.** Each request carries an agent connection token (`tdm_…`, created per person and workspace in the dashboard) as `Authorization: Bearer <token>` or `api-key: <token>`. The server asks Convex to verify it (`mcp:verifyToken`) and forwards it on every backend call; Convex is the authority and re-checks the connection, revocation and membership each time. No deploy or admin key is used. A missing or rejected token gets `401` with `WWW-Authenticate: Bearer realm="tandem"`. Sending both headers with different tokens is rejected.
- **Workspace scope.** A connection belongs to one workspace, which is its default; `get_workspace_info` lists only that workspace, and its `members` only that workspace's members (`mcp:listMembers`: ids, names and roles, at most 100 with `members_truncated`; never emails), and any other `workspace_id` gets `FORBIDDEN`. Presence (`last_synced_at`, `last_action_at`) is per connection; every tool call updates `last_action_at`, including failed ones (a failing Convex mutation rolls back its own update, so the server then calls `mcp:touchConnection`; it skips that after successes and after `UNAUTHENTICATED`). `sync_workspace` also records the cursor it returned in `sync_cursors`, one row per connection; clients still send their own `since`.
- **Proposals: one value per proposal, the same in the mock and Convex.** `goal`/`scope`: the new text. `decisions`: one decision. `constraints`: one new constraint as a string; approval appends it (lists are rejected, and existing constraints can't be edited or removed through a proposal). `ownership`: `{ area, owner_user_id }`; Convex rejects an owner who isn't a current member of the workspace with `INVALID_INPUT`, checks again on approval, stores the owner's user id with the area, shows approvers "area: member name", and on approval replaces any owner of the same area (trimmed, case-insensitive). `get_approvals` and `sync_workspace` may also show `open_questions` proposals (created from the dashboard) and the `stale` status (the context changed before approval, so it wasn't applied); `get_approvals` accepts `status: "stale"` to list them.
- **Versions.** Any `expected_version` other than the current one, older or newer, is `VERSION_CONFLICT` (the mock returns `INVALID_INPUT` for a newer one).
- **Events.** `sync_workspace` events also include Convex-only types such as `workspace.created`, `agent.connected`, and `context.stale`.
- **Files.** `folder_id`/`parent_id` accept Convex folder ids. `list_files` returns at most the 200 most recently updated files; with `query` it uses the name search index over the whole workspace (word-prefix matching, so `road` finds `roadmap.md` but `map` doesn't), returns up to 200 matches, and `truncated` means more files matched; `search_files` content-matches the 200 most recent files (older files still match by name). `read_file` on a binary upload returns `INVALID_INPUT`.

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
- This mode is temporary and will be removed once Convex OAuth lands.

## Environment

| Variable                 | Default     | Meaning                                                                                                                                                |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                   | `8787`      | HTTP port                                                                                                                                              |
| `HOST`                   | `127.0.0.1` | Interface to bind. Use `0.0.0.0` only inside a container.                                                                                              |
| `NODE_ENV`               | unset       | Must be exactly `development` or `test` for dev anon mode. The `dev` script sets `development`.                                                        |
| `TANDEM_ALLOWED_ORIGINS` | empty       | Comma-separated browser origins allowed to call `/mcp`. Any other `Origin` gets `403`; requests without `Origin` are unaffected. Trailing `/` is OK.   |
| `CONVEX_URL`             | unset       | Convex deployment URL; required with `TANDEM_BACKEND=convex`.                                                                                          |
| `TANDEM_BACKEND`         | `mock`      | Storage backend: `mock` or `convex` (see "Run against Convex"). `mock` is in-memory and seeded with `ws_demo` (owner `user_alex`, admin `user_taylor`, member `user_sam`) containing `brief.md` v1 and project context, and `ws_other` (owner `user_jordan`).                   |
| `TANDEM_DEV_TOKENS`      | empty       | Comma-separated `key:user_id` pairs (split on the first `:`); clients send the key in the `api-key` header. Generate keys with `openssl rand -hex 24`. |
| `TANDEM_DEV_ANON_USER`   | unset       | TEMPORARY. Requests with no `api-key` header act as this user. Mock backend and `NODE_ENV=development`/`test` only (see above).                        |

## Deploy (Docker)

The image always runs with `TANDEM_BACKEND=convex`, `HOST=0.0.0.0` and `PORT=8787`, as a non-root user. `CONVEX_URL` is read at runtime, so one image works against any deployment. Build from the repo root, since the Dockerfile runs `turbo prune mcp`:

```sh
docker build -f apps/mcp/Dockerfile -t tandem-mcp .
docker run --rm -p 8787:8787 -e CONVEX_URL=https://<deployment>.convex.cloud tandem-mcp
curl http://127.0.0.1:8787/healthz   # {"ok":true}
```

On Vultr it runs in the root stack (`deploy/compose.yml`) behind Caddy, which serves `https://$MCP_DOMAIN/mcp`; the dashboard's `NEXT_PUBLIC_MCP_URL` is `https://$MCP_DOMAIN`. Runbook: [`docs/deploy.md`](../../docs/deploy.md).

## Layout

- `src/server.ts`: HTTP routing, `api-key` auth, per-request MCP server and transport
- `src/tools.ts`: tool definitions; maps `TandemError` to `isError` results
- `src/auth.ts`: `IdentityResolver` interface, the dev token resolver, and the temporary dev anon wrapper (swap for OAuth/JWT later)
- `src/backend/types.ts`: `TandemBackend` interface; `src/backend/mock.ts`: in-memory implementation; `src/backend/convex.ts`: Convex adapter (snake_case/ISO ↔ camelCase/epoch ms, `ConvexError` codes → `TandemError`); `src/backend/cursor.ts`: sync cursor encoding
- `src/errors.ts`: `TandemError` and its error codes
- `src/names.ts`: `nameKey`, the file-name normalization used for `NAME_EXISTS`

The caller's identity always comes from the `api-key` header (or the server's anon config), or with Convex from the token Convex verifies, never from tool arguments.

## Backend contract (shared with the web dashboard)

The dashboard calls the same Convex functions directly, so both callers must agree on one shape. The full contract is in [`apps/web/CONTRACT_NOTES.md`](../web/CONTRACT_NOTES.md). In short:

- **Convex speaks camelCase with numeric (epoch ms) timestamps.** The snake_case keys and ISO strings in `src/backend/types.ts` are this server's *tool* format. Convert at the tool boundary when a Convex-backed `TandemBackend` replaces the mock; never store or return them from Convex.
- **One set of function names**: `files:read` / `files:create` / `files:update` back `readFile` / `createDocument` / `updateDocument`, so there's a single write path and a single optimistic-lock check.
- **Attribution names person and agent.** `Attribution { actor_type, user_id, client, agent_connection_id?, label? }` maps from the Convex `Actor { type, userId, client, agentConnectionId, label }`; `agent_connection_id` tells apart two connections of the same person and client.
- **Business errors are `ConvexError({ code })`.** Production Convex redacts other errors' messages, so codes like `VERSION_CONFLICT` and `UNAUTHENTICATED` must travel in `data.code`.

## Tests

`pnpm --filter mcp test` starts the server on an ephemeral port and drives it with the SDK client.
