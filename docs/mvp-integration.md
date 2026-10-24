# MVP integration contract: dashboard and MCP

This document describes the integration boundary between the dashboard, MCP server, and Convex. It is intended to keep parallel frontend and MCP work aligned.

## What is connected today

| Surface                             | Current implementation                                                                                 | Shared data?                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Dashboard (`apps/web`)              | Existing session/provider and `TandemApi` layers, backed by Convex Auth and generated Convex functions | Yes, uses `NEXT_PUBLIC_CONVEX_URL`                                                   |
| MCP (`apps/mcp`)                    | Stateless Streamable HTTP; `MockBackend` (dev tokens) by default, `ConvexBackend` with `TANDEM_BACKEND=convex` | Yes with `TANDEM_BACKEND=convex`: agent connection tokens verified by Convex (see "Agent path" below) |
| Backend (`packages/backend/convex`) | Workspace membership, files, revisions, workspace context, proposals, approvals                        | Dashboard functions are authenticated; MCP has no Convex adapter or OAuth bridge yet |

The dashboard supports sign-in, workspace selection and first-workspace creation, file listing and creation, text editing with optimistic version checks, revision history, and the approved goal. It uses bounded one-shot Convex calls through `TandemApi`; file lists refresh on window focus. It does not yet expose context proposal approvals. The existing MCP server exposes only `list_files`, `read_file`, `create_document`, and `update_document`.

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
| Approved project context | `api.workspaces.getWorkspaceContext` | Requires workspace membership                                                          |
| List/search file names   | `api.files.listFiles`                | Requires `paginationOpts: { numItems, cursor }` (1–200 items); returns `{ page, isDone, continueCursor }`. `query` uses a workspace-scoped filename search index (term/prefix matching), optionally filtered by `folderId`                 |
| Read latest file         | `api.files.readFile`                 | Returns metadata plus nullable text content                                            |
| Create text document     | `api.files.createDocument`           | Creates file version 1 and a workspace event atomically                                |
| Update text document     | `api.files.updateDocument`           | Requires `expectedVersion`; stale writes throw `VERSION_CONFLICT`                      |
| File history             | `api.files.getFileVersions`          | Bounded by `limit` (maximum 100)                                                       |
| Propose context change   | `api.context.proposeContextChange`   | Goal, scope, decisions, constraints, ownership, or open question; approval is separate. Ownership takes `ownerUserId` (a current member, re-checked on approval) with the area as `proposedValue` |
| Read proposals/approvals | `api.context.getApprovals`           | Returns proposals, optionally filtered by status                                       |
| Approve/reject proposal  | `api.context.decideContextProposal`  | Human-only workflow; check backend role enforcement before exposing in UI              |

Convex uses camelCase fields and table IDs. The MCP tool contract currently uses snake_case (`workspace_id`, `file_id`, `expected_version`, `updated_at`, `updated_by`). Keep that translation in the MCP backend adapter; don't change public tool argument names independently. A version conflict must surface as MCP error code `VERSION_CONFLICT`, preserving the current and expected versions so the assistant can reread and reconcile.

## Agent path (MCP → Convex)

A signed-in member creates an agent connection for one workspace (`api.agentConnections.createAgentConnection({ workspaceId, client, displayName? })` → `{ connectionId, token, createdAt }`, token shown once, only its SHA-256 hash stored). `listAgentConnections({ workspaceId })` returns the caller's connections (owners/admins: all) with `lastMcpActionAt`/`lastSyncAt`/`revokedAt`; `revokeAgentConnection({ connectionId })` is for the connection's person or an owner/admin.

The MCP server forwards the token to `api.mcp.*` (`verifyToken`, `listWorkspaces`, `getConnection`, `listFiles`, `searchFiles`, `readFile`, `getFileVersions`, `createDocument`, `updateDocument`, `syncWorkspace`, `proposeContextChange`, `getApprovals`, `publishWork`). Each verifies the token, revocation, and current membership, and writes with `{ type: "agent", userId, agentConnectionId, client, label }` attribution through the same core helpers as the dashboard (`convex/lib/ops.ts`). There is no agent function for deciding proposals, and `decideContextProposal` rejects agent-bound identities itself. `workspace_events` carry a per-workspace `seq` assigned in the writing transaction; `syncWorkspace` pages by it. `createDocument` (dashboard and MCP) rejects a duplicate name in the same folder (`nameKey`: trimmed, case-folded) with `NAME_EXISTS`, and `updateDocument` returns `VERSION_CONFLICT` with `currentVersion`/`expectedVersion` for any mismatch. Local setup: [`docs/local-dev.md`](local-dev.md).

## Required before MCP can use shared Convex data

1. **Agree on OAuth identity claims.** The MCP OAuth layer must verify the access token and resolve the signed-in person to the same Convex `users` identity used by the dashboard. Never accept a user ID from MCP tool arguments. Bind the OAuth client to an active `agent_connections` record in the selected workspace.
2. **Make Convex recognize the agent identity.** The current Convex functions use `requireUser` and `humanActor`; they do not yet authorize an agent connection or write agent attribution. Add an explicit authenticated agent path that checks user membership and connection membership, and records both the person and agent on each event/revision. Do not label an agent write as a human write.
3. **Implement the MCP Convex adapter.** Preserve the `TandemBackend` interface and map IDs, timestamps, camelCase fields, and Convex errors into the MCP DTOs and `TandemError` codes. Do not pass a deployment/admin key as a substitute for user authorization.
4. **Complete the MVP MCP tool surface.** Add `sync_workspace`, `search_files`, `publish_work`, `propose_context_change`, `get_approvals`, `get_file_versions`, and `get_workspace_info`. Existing backend functions cover proposals, approvals, versions, workspace info, and filename matching. `sync_workspace` needs a defined cursor/event contract; `publish_work` needs a defined distinction between publishing a file reference and changing structured context.
5. **Keep human approval explicit.** Agents may propose goal, scope, major decision, or ownership changes. Only a permitted human may approve or reject them. Ordinary published findings must not silently mutate those fields.
6. **Document two real-client connection setups.** The static development token resolver is not OAuth and is only for local mock use. The native client setup needs the final OAuth issuer, registration/redirect flow, scopes, callback behavior, and deployed MCP URL.

## Integration sequence

1. Keep the dashboard's `TandemApi` boundary and MCP tool schemas stable while the OAuth and Convex-agent authorization contract is agreed.
2. Add the agent authorization path in Convex and review tenant-boundary checks.
3. Implement and select the Convex MCP backend only after it can forward a verified user/agent identity accepted by Convex.
4. Add the remaining tool schemas and map each to the shared Convex functions/events.
5. Configure the dashboard and MCP server against the same Convex deployment; verify same-workspace visibility, cross-workspace denial, revision history, and stale-write conflicts.
6. Connect at least two native MCP clients through OAuth before calling the MVP integration complete.

## Stable development commands

From the repository root, run the dashboard and MCP in separate terminals:

```sh
pnpm --filter web dev
```

```sh
TANDEM_DEV_TOKENS=alex-dev-token:user_alex,sam-dev-token:user_sam pnpm --filter mcp dev
```

The dashboard uses `apps/web/.env.local`. The MCP server reads environment variables from its process and defaults to `TANDEM_BACKEND=mock`. These two commands intentionally exercise different data stores until the identity bridge and Convex adapter are implemented.

## Workspace invite links

Email-based member addition has been replaced by bearer invite tokens, independent of Password email verification. Owners/admins create a member link on the workspace page and copy it for a teammate; `/invite/<token>` signs the recipient in with a same-origin return path and then accepts the invite. Treat the link as a credential and share it only with its intended recipient.

Tokens have 256 random bits from `crypto.getRandomValues`; only SHA-256 hashes are stored. They expire after seven days, can be revoked, and admit one new member. A current member following a valid unused link returns to the workspace without consuming it. Invalid, expired, revoked, and used links return `INVITE_INVALID`, `INVITE_EXPIRED`, `INVITE_REVOKED`, and `INVITE_USED`. Creation/revocation require owner/admin; invite roles never include owner. Invite records carry attribution, revision, and timestamps.

## File listing pagination

`files:listFiles` authenticates membership before querying the workspace index or `search_name` index. All queries constrain `workspaceId`; folder queries also constrain `parentId`. Filename search follows Convex token/prefix semantics rather than arbitrary substring matching. Callers must follow `continueCursor` until `isDone`.

The dashboard's `TandemApi.listFiles(workspaceId)` retains its complete-array contract: the Convex adapter loads pages of 100 and rejects with `LIST_LIMIT_EXCEEDED` rather than returning a partial list after 10,000 files or 100 pages. It also rejects repeated/empty continuation cursors. The dashboard continues filtering the loaded complete list locally.
