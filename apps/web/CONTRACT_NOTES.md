# Contract notes (web ↔ Convex backend)

The dashboard calls Convex directly through the `TandemApi` boundary (`lib/api/tandemApi.ts`). `lib/api/convex.ts` maps each method to a generated `@repo/backend` function reference; `lib/api/mock.ts` implements the same interface in memory. Components never import Convex.

All arguments use camelCase; timestamps are epoch milliseconds; Record IDs are Convex IDs; context entry IDs are opaque stable strings returned by the backend. Fixtures in `test/convexAdapter.test.ts` and `test/agentConnections.test.ts` are typed from the generated function types, so a backend shape change fails `check-types`.

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
| `getContext(workspaceId)` | `workspaces:getWorkspaceContext` | `{ workspaceId }` → compact project context or null |
| `getContextDetails(workspaceId)` | `context:getDetails` | `{ workspaceId }` → entries with stable `id`, lifecycle status and attribution |
| `updateContextField(workspaceId, input)` | `context:updateContextField` | `{ workspaceId, field, proposedValue, sourceFileIds, expectedVersion, entryId?, entryIndex?, ownerUserId? }` → `{ version }`; any member; UI edits use `entryId` |
| `changeContext(workspaceId, input)` | `context:changeContext` | `{ workspaceId, field, operation?, value?, ownerUserId?, entryId?, supersedes?, expectedVersion?, sourceFileIds }` → `{ version, entryId, deduplicated }`; any member |
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

## Context changes

There is no approval step. Every change to project context applies at once and is attributed to whoever made it: a member on the Project context page, an assistant over MCP (`update_context`), or Tandem's context manager. Both mutations need a human session (an agent-bound identity gets `APPROVAL_REQUIRED`) and accept any member, whatever their role.

- `changeContext` adds a value (`operation` "add", the default; `value` required, and for ownership `value` is the area plus a member's `ownerUserId`). Goal and scope replace the current value; ownership replaces the owner of an equal area; a decision may `supersedes` an active decision, which then shows **Superseded**. An addition the context already holds (same text, or same owner and area) writes nothing and returns `deduplicated: true`, which the panel reports as "Already in project context".
- `operation` "resolve" (open questions) and "remove" (constraints and open questions) need `entryId` and omit `value`. A repeated resolve is deduplicated.
- `expectedVersion` is the context revision the person saw; a stale one fails with `VERSION_CONFLICT` and the panel asks them to reopen the editor.
- `updateContextField` edits a value in place (goal/scope, or one active entry by `entryId`).

Entries keep backend IDs through list edits. Resolved entries stay visible with resolver attribution and can be removed; compact context summaries include active entries only.

Every change records a `context.updated` workspace event ("Updated decision", "Resolved open question", "Removed constraint"), shown on Live as a context change. Older history may still hold `context.proposed`, `context.approved`, `context.rejected` and similar kinds, and `proposal` resources: Live renders them generically and links them to the Project context page.

## Agent connections

- API keys are `mcp_sk_` + 256 random bits, minted by the `createAgentConnection` action. The `@convex-dev/mcp` component stores only the SHA-256 hash; the plaintext comes back once, with `mcpUrl` (`<CONVEX_SITE_URL>/mcp`, from the backend, no build-time env). The dialog shows it once with a copy button and a Claude Code command: `claude mcp add --transport http tandem <mcpUrl> --header "Authorization: Bearer <key>"`. The key lives only in that dialog's state and is gone when it closes. claude.ai connects with OAuth instead: it opens `/oauth/consent?request=<id>`, where the person picks the workspace and assistant (`oauth.getConsentRequest`, `oauth.decideConsent`).
- Connections are created for the signed-in person only. The list shows **Last MCP action** and **Last sync** as relative times ("never" when unset). There is no "online" state anywhere.
- Revoke asks for confirmation; history written through the connection is kept.

## Freshness

`watchWorkspace` holds one bounded reactive subscription (`getWorkspaceInfo`, newest 20 events) per mounted list. Every commit, context change and connect/revoke records a workspace event, so an assistant's new file, save or context change shows up in the file list, goal card and Project context page without a reload. Lists also refetch on window focus. Read-only MCP calls update `lastMcpActionAt` without an event, so those times refresh on focus or Refresh.

## Errors

Every business error is a `ConvexError({ code, ... })`. `lib/api/errors.ts` normalizes backend codes into stable UI codes (e.g. `INVALID_NAME` → `INVALID_INPUT`, `WORKSPACE_NOT_FOUND` → `FORBIDDEN`). A `VERSION_CONFLICT` on save may include `currentVersion`, `currentContent` and `updatedBy` (Convex actor shape); the save machine keeps the draft and shows the conflict panel without retrying.

## Invites and authentication

The Password provider sends no verification email. Owners/admins create single-use invite links (seven-day expiry, hash stored, atomic consumption); signed-in recipients accept them. `/invite/<token>` survives sign-in via `safeNext`. Invalid/expired/revoked/used invites map to distinct `INVITE_*` codes.

## Paginated file lists

The adapter follows every `files:listFiles` cursor and rejects with `LIST_LIMIT_EXCEEDED` past 10,000 files / 100 pages (or on a repeated or empty nonterminal cursor), so it never returns a silently partial list.
