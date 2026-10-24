# Contract notes (web ↔ Convex backend)

The dashboard calls Convex directly. PR #10's adapter maps its UI methods to the generated backend references below. The MCP server remains mock-only and is not yet a Convex caller.

## Backend functions

All arguments use camelCase; timestamps are epoch milliseconds. IDs are Convex IDs.

| Dashboard operation | Convex reference | Arguments | Return |
| --- | --- | --- | --- |
| List workspaces | `workspaces.listWorkspaces` | `{}` | Workspaces for the signed-in user |
| List files | `files.listFiles` | `{ workspaceId, folderId?, query? }` | File metadata array |
| Create file | `files.createDocument` | `{ workspaceId, parentId?, name, mimeType, content }` | Created file metadata |
| Read file | `files.readFile` | `{ fileId }` | `{ file, content }` |
| Update file | `files.updateDocument` | `{ fileId, expectedVersion, content }` | Updated file metadata |
| List revision history | `files.getFileVersions` | `{ fileId, limit? }` | Metadata, newest first |
| Read one revision | `files.getFileRevision` | `{ fileId, version }` | Revision content and metadata, or `null` |
| Read approved context | `workspaces.getWorkspaceContext` | `{ workspaceId }` | Context or `null` |

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

Approving a proposal requires an owner/admin human session. Agent-bound Convex
identities must carry a signed `agentConnectionId` claim and receive
`APPROVAL_REQUIRED`. The future MCP OAuth adapter must issue that claim; until
then MCP remains disconnected from Convex.

## Authentication and membership

The current Password provider does not send verification email. Workspace
owners/admins can add an already registered account by email; the verification
check is intentionally omitted so the P0 two-member workspace flow works. Add
email verification or an invite-acceptance flow before relying on email as proof
of account ownership outside the hackathon prototype.
