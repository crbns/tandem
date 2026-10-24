# Contract notes (web ↔ Convex backend)

The dashboard calls Convex directly. PR #10's adapter maps its UI methods to the generated backend references below. The MCP server remains mock-only and is not yet a Convex caller.

## Backend functions

All arguments use camelCase; timestamps are epoch milliseconds. IDs are Convex IDs.

| Dashboard operation | Convex reference | Arguments | Return |
| --- | --- | --- | --- |
| List workspaces | `workspaces.listWorkspaces` | `{}` | Workspaces for the signed-in user |
| List files | `files.listFiles` | `{ workspaceId, folderId?, query?, paginationOpts }` | `{ page, isDone, continueCursor }` |
| Create file | `files.createDocument` | `{ workspaceId, parentId?, name, mimeType, content }` | Created file metadata |
| Read file | `files.readFile` | `{ fileId }` | `{ file, content }` |
| Update file | `files.updateDocument` | `{ fileId, expectedVersion, content }` | Updated file metadata |
| List revision history | `files.getFileVersions` | `{ fileId, limit? }` | Metadata, newest first |
| Read one revision | `files.getFileRevision` | `{ fileId, version }` | Revision content and metadata, or `null` |
| Read approved context | `workspaces.getWorkspaceContext` | `{ workspaceId }` | Context or `null` |

## Current backend

The dashboard imports the generated API through the declared `@repo/backend` workspace dependency. Convex Auth and the functions below are connected in real mode; the in-memory mock implements the same TandemApi interface.

`workspaceId` is required for both listing and creating files. The caller must
select the intended workspace; the backend never guesses from memberships.

Revision-history results omit document bodies to keep reads bounded. Fetch a
selected revision's body with `files.getFileRevision`.

## Attribution and errors

Convex stores actors as `{ type, userId?, agentConnectionId?, label, client?, userName? }`.
The dashboard adapter maps this to its frontend `Actor` shape. MCP's development
identities are not Convex identities and must not be used for production writes.

Every business error is a `ConvexError({ code, ... })`. The frontend normalizes
backend-specific validation and membership codes into its stable UI error codes.
A `VERSION_CONFLICT` may include `currentVersion`, `currentContent`, and
`updatedBy` (the stored Convex actor shape).

## Context approvals

Proposals to change the goal or scope record the field value they were based on.
An approval becomes stale only if that same field changed; independent pending
proposals remain approvable. Legacy proposals without a base revision are marked
stale when approved. Append-only proposals (constraints, decisions, ownership,
and open questions) do not conflict with unrelated updates.

| Dashboard method | Convex function | Args / return |
|---|---|---|
| `listWorkspaces()` | `workspaces:listWorkspaces` | `{}` → `{ id, name, role }[]` |
| `createWorkspace(name)` | `workspaces:createWorkspace` | `{ name }` → workspace ID |
| `listFiles(workspaceId)` | `files:listFiles` | `{ workspaceId, paginationOpts: { numItems: 100, cursor } }` → `{ page, isDone, continueCursor }` |
| `createFile(workspaceId, input)` | `files:createDocument` | `{ workspaceId, name, mimeType, content }` → `{ id, version }` |
| `readFile(fileId)` | `files:readFile` | `{ fileId }` → `{ file, content }`, mapped to FileDetail |
| `updateFileContent(fileId, update)` | `files:updateDocument` | `{ fileId, expectedVersion, content }` → file metadata |
| `listRevisions(fileId)` | `files:getFileVersions` | `{ fileId, limit: 100 }` → newest-first revisions |
| `getContext(workspaceId)` | `workspaces:getWorkspaceContext` | `{ workspaceId }` → approved context or null |
| `createInvite(workspaceId, role)` | `workspaces:createWorkspaceInvite` | `{ workspaceId, role }` → `{ inviteId, token, expiresAt }`; owner/admin only |
| `acceptInvite(token)` | `workspaces:acceptWorkspaceInvite` | `{ token }` → `{ workspaceId }`; signed-in user |
| `listInvites(workspaceId)` | `workspaces:listWorkspaceInvites` | `{ workspaceId }` → newest 100 safe metadata; owner/admin only |
| `revokeInvite(inviteId)` | `workspaces:revokeWorkspaceInvite` | `{ inviteId }` → null; owner/admin of invite workspace |

Invites replace `addWorkspaceMember`: no verified-email dependency. Raw tokens are returned once, hashes remain private, expiry is seven days, and consumption is atomic with membership/event creation. Existing members do not consume an unused invite. Invalid/expired/revoked/used errors map to distinct `INVITE_*` error codes and user copy. The invite route preserves `/invite/<token>` through sign-in using `safeNext`.

Approving a proposal requires an owner/admin human session. Agent-bound Convex
identities must carry a signed `agentConnectionId` claim and receive
`APPROVAL_REQUIRED`. The future MCP OAuth adapter must issue that claim; until
then MCP remains disconnected from Convex.

## Authentication and membership

The current Password provider does not send verification email. Workspace
owners/admins create single-use token invites; signed-in recipients accept
them without relying on email as proof of account ownership.

## Paginated file lists

The Convex adapter follows every `files:listFiles` cursor and maps all page metadata before returning a `FileSummary[]`. It rejects `LIST_LIMIT_EXCEEDED` at 10,000 files / 100 pages (and on repeated or empty nonterminal cursors), so it never silently returns an incomplete list. Backend page sizes are 1–200. Optional `query` uses the `search_name` index with required workspace equality and optional parent equality; search matches terms/prefixes, not arbitrary substrings.
