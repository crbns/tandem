# Contract notes (web ↔ Convex backend)

The dashboard calls Convex directly through the `TandemApi` boundary (`lib/api/tandemApi.ts`). `lib/api/convex.ts` maps each method to a generated `@repo/backend` function reference; `lib/api/mock.ts` implements the same interface in memory. Components never import Convex.

All arguments use camelCase; timestamps are epoch milliseconds; Record IDs are Convex IDs; context entry IDs are opaque stable strings returned by the backend. Fixtures in `test/convexAdapter.test.ts` and `test/approvalsAndConnections.test.ts` are typed from the generated function types, so a backend shape change fails `check-types`.

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
| `getContextDetails(workspaceId)` | `context:getDetails` | `{ workspaceId }` → entries with stable `id`, lifecycle status and attribution |
| `updateContextField(workspaceId, input)` | `context:updateContextField` | `{ workspaceId, field, proposedValue, sourceFileIds, expectedVersion, entryId?, entryIndex?, ownerUserId? }` → `{ version }`; UI edits use `entryId` |
| `proposeContextChange(workspaceId, input)` | `context:proposeContextChange` | `{ workspaceId, field, proposedValue?, rationale, sourceFileIds, operation?, entryId?, supersedes?, expectedVersion?, ownerUserId? }` → `{ id, status: "pending" \| "applied" }` |
| `listProposals(workspaceId, status?)` | `context:getApprovals` | `{ workspaceId, status? }` → newest 100 proposals; any member |
| `decideProposal(proposal, decision)` | `context:decideContextProposal` (+ `context:getApprovals` with `status: "stale"` after an approval) | `{ proposalId, decision }` → null |
| `createAgentConnection(workspaceId, input)` | `agentConnections:createAgentConnection` | `{ workspaceId, client, displayName? }` → `{ connectionId, token, createdAt, mcpUrl }` |
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
- **Revision checks.** Proposals store `contextRevision`. Approval rejects missing revision metadata as stale; legacy goal/scope proposals without `baseValue` compare the current revision. New goal/scope proposals compare the field value, so unrelated context edits do not invalidate them (`convex/context.ts`, `decideProposalCore`).
- **Stale approvals.** Goal/scope proposals record the value they were based on. When that field changed since, the backend marks the proposal `stale` and returns `null` instead of throwing. The adapter therefore re-reads `getApprovals({ status: "stale" })` after an approval and rejects with `VERSION_CONFLICT` if the proposal is there; the approvals screen shows it as contested (ochre) with an explanation. If the backend later throws `VERSION_CONFLICT` or `PROPOSAL_STALE` directly, that maps to the same code and the extra read becomes a no-op. A decision proposal with `supersedes` also becomes stale when its target is no longer active.
- `PROPOSAL_ALREADY_DECIDED` and `PROPOSAL_NOT_FOUND` map to the dashboard's `PROPOSAL_DECIDED` ("Already decided").

## Context lifecycle

Each workspace's `contextApproval` setting (the dropdown on the Approvals page; owners and admins change it with `workspaces.setContextApproval`) decides what happens to proposals. `"manual"`, the default, holds every proposal for human approval: every field, plus resolve and remove (stored with `operation` and `entryId`, and marked stale on approval if the entry is gone). `"automatic"` applies every proposal at once, and it appears as **Recorded**. Owner/admin direct edits (`updateContextField`) always apply.

Entries retain backend IDs through list edits. Open questions can be resolved with resolver attribution and time; resolved entries remain visible and can be removed by a human. Humans can remove constraints and open questions; both resolve and remove send `entryId` and `expectedVersion`, and conflicts refresh the page for review. Decision replacement uses `supersedes` and waits for approval before the old entry shows **Superseded**; compact context summaries include active entries only.

## Agent connections

- API keys are `mcp_sk_` + 256 random bits, minted by the `createAgentConnection` action. The `@convex-dev/mcp` component stores only the SHA-256 hash; the plaintext comes back once, with `mcpUrl` (`<CONVEX_SITE_URL>/mcp`, from the backend, no build-time env). The dialog shows it once with a copy button and a Claude Code command: `claude mcp add --transport http tandem <mcpUrl> --header "Authorization: Bearer <key>"`. The key lives only in that dialog's state and is gone when it closes. claude.ai connects with OAuth instead: it opens `/oauth/consent?request=<id>`, where the person picks the workspace and assistant (`oauth.getConsentRequest`, `oauth.decideConsent`).
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

For context proposals, `proposedValue` is required only for `add`. Resolve/remove load the entry by ID and ignore any supplied value; send `entryId` and `expectedVersion` instead.
