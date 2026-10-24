# Contract notes (web ↔ Convex backend)

The dashboard calls Convex directly through the `TandemApi` boundary (`lib/api/tandemApi.ts`). `lib/api/convex.ts` maps each method to a generated `@repo/backend` function reference; `lib/api/mock.ts` implements the same interface in memory. Components never import Convex.

All arguments use camelCase; timestamps are epoch milliseconds; IDs are Convex IDs. Fixtures in `test/convexAdapter.test.ts` and `test/approvalsAndConnections.test.ts` are typed from the generated function types, so a backend shape change fails `check-types`.

## Function map

| Dashboard method | Convex function | Args → return |
|---|---|---|
| `listWorkspaces()` | `workspaces:listWorkspaces` | `{}` → `{ id, name, role }[]` |
| `createWorkspace(name)` | `workspaces:createWorkspace` | `{ name }` → workspace ID |
| `createInvite(workspaceId, role)` | `workspaces:createWorkspaceInvite` | `{ workspaceId, role }` → `{ inviteId, token, expiresAt }`; owner/admin only |
| `acceptInvite(token)` | `workspaces:acceptWorkspaceInvite` | `{ token }` → `{ workspaceId }` |
| `listInvites(workspaceId)` | `workspaces:listWorkspaceInvites` | `{ workspaceId }` → newest 100, safe metadata; owner/admin only |
| `revokeInvite(inviteId)` | `workspaces:revokeWorkspaceInvite` | `{ inviteId }` → null |
| `listFiles(workspaceId)` | `files:listFiles` | `{ workspaceId, paginationOpts: { numItems: 100, cursor } }` → `{ page, isDone, continueCursor }`, every page followed |
| `createFile(workspaceId, input)` | `files:createDocument` | `{ workspaceId, name, mimeType, content }` → file metadata |
| `readFile(fileId)` | `files:readFile` | `{ fileId }` → `{ file, content }` |
| `updateFileContent(fileId, update)` | `files:updateDocument` | `{ fileId, expectedVersion, content }` → file metadata, or `VERSION_CONFLICT` |
| `listRevisions(fileId)` | `files:getFileVersions` | `{ fileId, limit: 100 }` → newest-first metadata, no bodies |
| `getRevision(fileId, version)` | `files:getFileRevision` | `{ fileId, version }` → revision with content, or null |
| `getContext(workspaceId)` | `workspaces:getWorkspaceContext` | `{ workspaceId }` → approved context or null |
| `listProposals(workspaceId, status?)` | `context:getApprovals` | `{ workspaceId, status? }` → newest 100 proposals; any member |
| `decideProposal(proposal, decision)` | `context:decideContextProposal` (+ `context:getApprovals` with `status: "stale"` after an approval) | `{ proposalId, decision }` → null |
| `createAgentConnection(workspaceId, input)` | `agentConnections:createAgentConnection` | `{ workspaceId, client, displayName? }` → `{ connectionId, token, createdAt }` |
| `listAgentConnections(workspaceId)` | `agentConnections:listAgentConnections` | `{ workspaceId }` → caller's own; owner/admin see all. Never a token or hash |
| `revokeAgentConnection(connectionId)` | `agentConnections:revokeAgentConnection` | `{ connectionId }` → null; the connection's person or an owner/admin |
| `watchWorkspace(workspaceId, onChange)` | `workspaces:getWorkspaceInfo` (reactive `watchQuery`) | fires `onChange` when the newest of `recentEvents` changes |

`workspaceId` is always explicit: the backend never guesses a workspace from memberships.

## Attribution

Convex stores actors as `{ type: "human" | "agent" | "system", userId?, agentConnectionId?, label, client?, userName? }`. `toActor` (exported from `lib/api/convex.ts`) maps them to the dashboard `Actor`:

- **agent** → `{ actorType: "agent", userId, userName, agentName: label, agentClient: client }`. `agentConnectionId` is never surfaced (issue #12 fix). `client` is omitted when the backend didn't record one.
- **human** → `{ actorType: "human", userId, userName: userName ?? label }`.
- **system** → rendered as a human-shaped actor named by its label (e.g. "Tandem"), never as an agent.

The identity plate (`components/common/ActorBadge.tsx`) renders an agent write as **"Alex via Claude"**: the person, then the client's product name (`lib/actors.ts` maps `claude`/`chatgpt`/`gemini`; other clients fall back to the label). Human writes show the person only. This applies to the file register, custody record, file header, save bar, conflict panel and revision history.

## Approvals

- Every member can read proposals; only owner/admin humans see Approve/Reject (`lib/proposals.ts` `canDecideProposals`). The backend enforces this independently: `decideContextProposal` calls `requireHumanSession` (agent-bound identities get `APPROVAL_REQUIRED`) and rejects non-owner/admin members with `FORBIDDEN`.
- **Stale approvals.** Goal/scope proposals record the value they were based on. When that field changed since, the backend marks the proposal `stale` and returns `null` instead of throwing. The adapter therefore re-reads `getApprovals({ status: "stale" })` after an approval and rejects with `VERSION_CONFLICT` if the proposal is there; the approvals screen shows it as contested (ochre) with an explanation. If the backend later throws `VERSION_CONFLICT` or `PROPOSAL_STALE` directly, that maps to the same code and the extra read becomes a no-op. Append-only proposals (constraint, decision, ownership, open question) don't go stale.
- `PROPOSAL_ALREADY_DECIDED` and `PROPOSAL_NOT_FOUND` map to the dashboard's `PROPOSAL_DECIDED` ("Already decided").

## Agent connections

- Tokens are `tdm_` + 256 random bits. The backend stores only the SHA-256 hash and returns the plaintext once from `createAgentConnection`; the dialog shows it once with a copy button and a Claude Code command: `claude mcp add --transport http tandem <NEXT_PUBLIC_MCP_URL>/mcp --header "Authorization: Bearer <token>"`. The token lives only in that dialog's state and is gone when it closes.
- Connections are created for the signed-in person only. The list shows **Last MCP action** and **Last sync** as relative times ("never" when unset). There is no "online" state anywhere.
- Revoke asks for confirmation; history written through the connection is kept.

## Freshness

`watchWorkspace` holds one bounded reactive subscription (`getWorkspaceInfo`, newest 20 events) per mounted list. Every commit, proposal, decision and connect/revoke records a workspace event, so an assistant's new file or save shows up in the file list, approved goal and pending approvals without a reload. Lists also refetch on window focus. Read-only MCP calls update `lastMcpActionAt` without an event, so those times refresh on focus or Refresh.

## Errors

Every business error is a `ConvexError({ code, ... })`. `lib/api/errors.ts` normalizes backend codes into stable UI codes (e.g. `INVALID_NAME` → `INVALID_INPUT`, `WORKSPACE_NOT_FOUND` → `FORBIDDEN`). A `VERSION_CONFLICT` on save may include `currentVersion`, `currentContent` and `updatedBy` (Convex actor shape); the save machine keeps the draft and shows the conflict panel without retrying.

## Invites and authentication

The Password provider sends no verification email. Owners/admins create single-use invite links (seven-day expiry, hash stored, atomic consumption); signed-in recipients accept them. `/invite/<token>` survives sign-in via `safeNext`. Invalid/expired/revoked/used invites map to distinct `INVITE_*` codes.

## Paginated file lists

The adapter follows every `files:listFiles` cursor and rejects with `LIST_LIMIT_EXCEEDED` past 10,000 files / 100 pages (or on a repeated or empty nonterminal cursor), so it never returns a silently partial list.
