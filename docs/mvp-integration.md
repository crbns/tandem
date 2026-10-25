# MVP integration contract: dashboard and MCP

This document describes the integration boundary between the dashboard, MCP server, and Convex. It is intended to keep parallel frontend and MCP work aligned.

## What is connected today

| Surface                             | Current implementation                                                                                 | Shared data?                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Dashboard (`apps/web`)              | Existing session/provider and `TandemApi` layers, backed by Convex Auth and generated Convex functions | Yes, uses `NEXT_PUBLIC_CONVEX_URL`                                                   |
| MCP (`packages/backend/convex/mcp.ts`) | `@convex-dev/mcp` in Convex HTTP actions at `<CONVEX_SITE_URL>/mcp`: 15 tools, OAuth 2.1 (DCR, PKCE, refresh) and API keys | Yes: same deployment and core helpers as the dashboard (see "Agent path" below) |
| Mock MCP (`apps/mcp`)               | Stateless Streamable HTTP over `MockBackend` (dev tokens), for the skill eval only                     | No, in-memory                                                                        |
| Backend (`packages/backend/convex`) | Workspace membership, files, revisions, project context                                                | Dashboard functions are authenticated; MCP tools call internal functions with the component-verified principal |

The dashboard supports sign-in, workspace selection and first-workspace creation, file listing and creation, text editing with optimistic version checks, revision history, and the project context. It uses bounded one-shot Convex calls through `TandemApi` and a reactive `getWorkspaceInfo` subscription that refreshes lists after workspace events. Lists also refresh on window focus. The MCP server exposes the full tool surface in AGENTS.md.

## Shared data and naming

Convex is the source of truth. Use the backend functions under `packages/backend/convex`; don't add a second database or let the mock become the integration target.

| Operation                | Convex function                      | Notes                                                                                  |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------- |
| List workspaces          | `api.workspaces.listWorkspaces`      | Authenticated member scope; bounded to 100                                             |
| Create invite | `api.workspaces.createWorkspaceInvite` | Owner/admin; `{ workspaceId, role: "admin" \| "member" }`; returns `{ inviteId, token, expiresAt }` once |
| Accept invite | `api.workspaces.acceptWorkspaceInvite` | Signed-in user; `{ token }` returns `{ workspaceId }`; membership, acceptance, and event commit atomically |
| List invites | `api.workspaces.listWorkspaceInvites` | Owner/admin; newest 100 invite metadata; never returns tokens or hashes |
| Revoke invite | `api.workspaces.revokeWorkspaceInvite` | Owner/admin of invite's own workspace; `{ inviteId }` |
| Workspace details/events | `api.workspaces.getWorkspaceInfo`    | Requires workspace membership                                                          |
| Project context          | `api.workspaces.getWorkspaceContext` | Requires workspace membership                                                          |
| List/search file names   | `api.files.listFiles`                | Requires `paginationOpts: { numItems, cursor }` (1–200 items); returns `{ page, isDone, continueCursor }`. `query` uses a workspace-scoped filename search index (term/prefix matching), optionally filtered by `folderId`                 |
| Read latest file         | `api.files.readFile`                 | Returns metadata plus nullable text content                                            |
| Create text document     | `api.files.createDocument`           | Creates file version 1 and a workspace event atomically                                |
| Update text document     | `api.files.updateDocument`           | Requires `expectedVersion`; stale writes throw `VERSION_CONFLICT`                      |
| File history             | `api.files.getFileVersions`          | Bounded by `limit` (maximum 100)                                                       |
| Change context           | `api.context.changeContext`          | Any member. Add a goal, scope, decision, constraint, ownership or open question, or resolve/remove an entry by `entryId`; applies at once. Ownership takes `ownerUserId` (a current member) with the area as `value`. Returns `{ version, entryId, deduplicated }`; optional `expectedVersion` gives `VERSION_CONFLICT` when stale |
| Edit a context value     | `api.context.updateContextField`     | Any member. Replaces a value or an entry's text by `entryId`/`entryIndex`               |

Convex uses camelCase fields and table IDs. The MCP tool contract uses snake_case (`workspace_id`, `file_id`, `expected_version`, `updated_at`, `updated_by`). Keep that translation in `convex/lib/mcpContract.ts`; don't change public tool argument names independently. A version conflict must surface as MCP error code `VERSION_CONFLICT`, preserving the current and expected versions so the assistant can reread and reconcile.

## Agent path (MCP → Convex)

Every MCP credential acts for one `agent_connections` row: the component's grant (or API key) is created with `userId` set to that row's id, so a tool receives the connection id as `user.userId` and `lib/agent.ts` `requireAgent` loads the connection, its person and their current membership. Identity never comes from tool arguments.

- **OAuth (claude.ai and other connectors).** The client discovers the server (`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`), registers (DCR), and sends the person to `/mcp/oauth/authorize`, which redirects to the dashboard's `/oauth/consent?request=<id>`. There the signed-in person picks the workspace and assistant (`api.oauth.getConsentRequest`), then approves or denies (`api.oauth.decideConsent`). Approval creates the `agent_connections` row (`authKind: "oauth"`) and binds the authorization code to it in one transaction. Tokens are opaque, audience-bound to `<CONVEX_SITE_URL>/mcp`, and stored hashed by the component.
- **API keys (Claude Code, scripts).** `api.agentConnections.createAgentConnection({ workspaceId, client, displayName? })` (an action) returns `{ connectionId, token, createdAt, mcpUrl }` once; `token` is an `mcp_sk_` key whose hash the component stores. Send it as `Authorization: Bearer <key>`.
- **Listing and revoking.** `listAgentConnections({ workspaceId })` returns the caller's connections (owners/admins: all) with `authKind`, the unverified `oauthClientName`, `lastMcpActionAt`/`lastSyncAt`/`revokedAt`. `revokeAgentConnection({ connectionId })` (the connection's person or an owner/admin) marks the row revoked and deletes its grants and tokens in the same transaction, so the next MCP request gets 401.

Each tool calls exactly one internal mutation in `convex/mcpTools.ts`, which checks the connection, membership and (for writes) the `tandem:write` scope, then writes with `{ type: "agent", userId, agentConnectionId, client, label }` attribution through the same core helpers as the dashboard (`convex/lib/ops.ts`); `update_context` uses `changeContextCore`, like the dashboard's `changeContext`, and applies at once with the agent's attribution. `workspace_events` carry a per-workspace `seq` assigned in the writing transaction; `syncWorkspace` pages by it. `createDocument` (dashboard and MCP) rejects a duplicate name in the same folder (`nameKey`: trimmed, case-folded) with `NAME_EXISTS`, and `updateDocument` returns `VERSION_CONFLICT` with `currentVersion`/`expectedVersion` for any mismatch. Local setup: [`docs/local-dev.md`](local-dev.md). Design and decisions: [`docs/mcp-auth-design.md`](mcp-auth-design.md).

## Required before MCP can use shared Convex data

These integration prerequisites are implemented. `apps/mcp` is not a deployment adapter; the Convex HTTP endpoint uses internal mutations directly.

| Prerequisite | Code evidence |
|---|---|
| Trusted workspace-scoped identity and presence | `lib/agent.ts`, `mcpTools.ts`: component-verified connection, membership, `lastMcpActionAt` / `lastSyncAt` |
| Shared document writes and attribution | `lib/ops.ts`: dashboard and MCP use the same core helpers; writes include the agent actor |
| Ordered incremental sync | `lib/auth.ts`, `lib/ops.ts`, `mcpTools.ts`: transactional event sequences and per-connection `sync_cursors` |
| Context model | `lib/mcpContract.ts`, `context.ts`, `lib/ops.ts` `changeContextCore`: singular backend fields mapped to public names, stable entry IDs, dedupe and `expectedVersion` checks; one core for people, assistants and the context manager |
| Publish and workspace discovery | `mcpTools.ts`, `schema.ts`: `published_work`, `work.published` events, member count and one connection-bound default workspace |
| Errors, history and binary reads | `lib/mcpContract.ts`, `mcpTools.ts`: coded errors; history metadata and UTF-8 sizes; binaries return a dashboard-view message |
| Dashboard mapping and UI | `apps/web/lib/api/convex.ts`, context and assistants routes: actor names/clients, context editing and connection management |

## Still open

- Native-client verification is separate from code coverage. This cleanup did not connect claude.ai, ChatGPT or Gemini. See the Phase D client reports for measured results.
- Search inspects the newest 200 files plus bounded filename-index hits. It does not guarantee substring matches across every older file's content (`searchFilesCore`).
- The skill eval starts a fresh mock process per trial; it has no external MCP URL/key mode or isolated live seed setup (`skills/tandem/eval/run.mjs`).

People can change project context directly or direct their assistants to do so, with attribution and history. The context manager and published findings produce observations, not authoritative context changes.
