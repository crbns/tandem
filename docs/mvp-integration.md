# MVP integration contract: dashboard and MCP

This document describes the integration boundary between the dashboard, MCP server, and Convex. It is intended to keep parallel frontend and MCP work aligned.

## What is connected today

| Surface | Current implementation | Shared data? |
| --- | --- | --- |
| Dashboard (`apps/web`) | Convex Auth and generated Convex functions | Yes, uses the deployment in `apps/web/.env.local` |
| MCP (`apps/mcp`) | Stateless Streamable HTTP, static development bearer tokens, `MockBackend` | No, mock state is process-local and resets on restart |
| Backend (`packages/backend/convex`) | Workspace membership, files, revisions, workspace context, proposals, approvals | Dashboard functions are authenticated; MCP has no Convex adapter or OAuth bridge yet |

The dashboard's current test flow covers account sign-up/sign-in, workspace creation and listing, text-document create/read/update, optimistic version checks, and revision history. It does not yet show the approved goal or approval controls. The existing MCP server exposes only `list_files`, `read_file`, `create_document`, and `update_document`.

## Shared data and naming

Convex is the source of truth. Use the backend functions under `packages/backend/convex`; don't add a second database or let the mock become the integration target.

| Operation | Convex function | Notes |
| --- | --- | --- |
| List workspaces | `api.workspaces.listWorkspaces` | Authenticated member scope; bounded to 100 |
| Workspace details/events | `api.workspaces.getWorkspaceInfo` | Requires workspace membership |
| Approved project context | `api.workspaces.getWorkspaceContext` | Requires workspace membership |
| List/search file names | `api.files.listFiles` | `query` is a case-insensitive filename substring, not full-text search |
| Read latest file | `api.files.readFile` | Returns metadata plus nullable text content |
| Create text document | `api.files.createDocument` | Creates file version 1 and a workspace event atomically |
| Update text document | `api.files.updateDocument` | Requires `expectedVersion`; stale writes throw `VERSION_CONFLICT` |
| File history | `api.files.getFileVersions` | Bounded by `limit` (maximum 100) |
| Propose context change | `api.context.proposeContextChange` | Goal, scope, decisions, constraints, ownership, or open question; approval is separate |
| Read proposals/approvals | `api.context.getApprovals` | Returns proposals, optionally filtered by status |
| Approve/reject proposal | `api.context.decideContextProposal` | Human-only workflow; check backend role enforcement before exposing in UI |

Convex uses camelCase fields and table IDs. The MCP tool contract currently uses snake_case (`workspace_id`, `file_id`, `expected_version`, `updated_at`, `updated_by`). Keep that translation in the MCP backend adapter; don't change public tool argument names independently. A version conflict must surface as MCP error code `VERSION_CONFLICT`, preserving the current and expected versions so the assistant can reread and reconcile.

## Required before MCP can use shared Convex data

1. **Agree on OAuth identity claims.** The MCP OAuth layer must verify the access token and resolve the signed-in person to the same Convex `users` identity used by the dashboard. Never accept a user ID from MCP tool arguments. Bind the OAuth client to an active `agent_connections` record in the selected workspace.
2. **Make Convex recognize the agent identity.** The current Convex functions use `requireUser` and `humanActor`; they do not yet authorize an agent connection or write agent attribution. Add an explicit authenticated agent path that checks user membership and connection membership, and records both the person and agent on each event/revision. Do not label an agent write as a human write.
3. **Implement the MCP Convex adapter.** Preserve the `TandemBackend` interface and map IDs, timestamps, camelCase fields, and Convex errors into the MCP DTOs and `TandemError` codes. Do not pass a deployment/admin key as a substitute for user authorization.
4. **Complete the MVP MCP tool surface.** Add `sync_workspace`, `search_files`, `publish_work`, `propose_context_change`, `get_approvals`, `get_file_versions`, and `get_workspace_info`. Existing backend functions cover proposals, approvals, versions, workspace info, and filename matching. `sync_workspace` needs a defined cursor/event contract; `publish_work` needs a defined distinction between publishing a file reference and changing structured context.
5. **Keep human approval explicit.** Agents may propose goal, scope, major decision, or ownership changes. Only a permitted human may approve or reject them. Ordinary published findings must not silently mutate those fields.
6. **Document two real-client connection setups.** The static development token resolver is not OAuth and is only for local mock use. The native client setup needs the final OAuth issuer, registration/redirect flow, scopes, callback behavior, and deployed MCP URL.

## Integration sequence

1. Keep the frontend using generated Convex APIs and the MCP tool schemas stable while the OAuth and Convex-agent authorization contract is agreed.
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
