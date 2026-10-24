# Contract notes (web ↔ Convex backend)

For Person 2. The dashboard calls Convex directly. These are the functions it expects, how it reaches them, and what's missing.

## Backend state (updated Oct 23, evening)

The backend now exists on the unmerged branch `codex/backend-convex-vultr` (`packages/backend/convex/{files,workspaces,context}.ts`). `lib/api/convex.ts` calls its **real function names**, and `lib/api/convexMappers.ts` maps its return shapes to the web types in `lib/api/types.ts`, so components didn't change. `test/convexAdapter.test.ts` feeds backend-shaped fixtures through that mapping. Mock mode (`NEXT_PUBLIC_USE_MOCKS=true`) is untouched.

Functions are still referenced by name with `makeFunctionReference("module:export")`, since the web app doesn't import the backend's `_generated/api` yet. If Convex reports `Could not find public function`, the adapter surfaces it as `NOT_IMPLEMENTED` (see `lib/api/errors.ts`).

## Canonical wire shape (web and MCP)

One shape for every Convex function, so the dashboard and the MCP server can never disagree:

- **camelCase keys** (`workspaceId`, `expectedVersion`, `currentVersion`). The backend matches.
- **Numeric timestamps** in epoch milliseconds (`updatedAt: number`). The backend matches.
- **MCP maps at its tool boundary.** snake_case keys and ISO strings (`workspace_id`, `updated_at`) are MCP's *tool* format, converted inside `apps/mcp`. Convex never stores or returns them.
- **One set of function names for both callers**, so there's one write path and one optimistic-lock check. The agreed set is the backend's own names below, which also match MCP's tool names (`readFile`, `createDocument`, `updateDocument`, `getFileVersions`). This replaces the earlier `files:read` / `files:create` / `files:update` proposal.

## Function mapping (agreed)

| Dashboard method | Convex function | Args sent | Backend returns | Adapter maps to |
|---|---|---|---|---|
| `listWorkspaces()` | `workspaces:listWorkspaces` (query) | `{}` | `{ id, name, role, updatedAt }[]` | `{ id, name }[]` |
| `listFiles(workspaceId)` | `files:listFiles` (query) | `{ workspaceId }` | file metadata `[]` (max 100) | `FileSummary[]` |
| `createFile(workspaceId, input)` | `files:createDocument` (mutation) | `{ workspaceId, name, mimeType, content }` | file metadata | `{ id, version }` |
| `readFile(fileId)` | `files:readFile` (query) | `{ fileId }` | `{ file, content }` | `FileDetail`, `canEdit: true` |
| `updateFileContent(fileId, update)` | `files:updateDocument` (mutation) | `{ fileId, expectedVersion, content }` | file metadata | `{ version }` |
| `listRevisions(fileId)` | `files:getFileVersions` (query) | `{ fileId }` (default limit 20) | `{ id, version, content, actor, createdAt }[]` | `Revision[]`, newest first |
| `getContext(workspaceId)` | `workspaces:getWorkspaceContext` (query) | `{ workspaceId }` | structured context or `null` | `ProjectContext \| null` |

Not called by the dashboard yet (P1): `workspaces:getWorkspaceInfo`, `context:getApprovals`, `context:proposeContextChange`, `context:decideContextProposal`. These cover the earlier `context:listProposals` / `context:approve` asks.

**How the adapter maps backend shapes:**

- **Actor.** Backend `{ type, userId?, agentConnectionId?, label }` maps to web `Actor`:
  - `human`: `userName = label`.
  - `agent`: `agentName = label`, `agentClient = agentConnectionId` (a Convex id, not a client name like `"claude"`; nothing renders it today).
  - `system`: rendered as a named human-type actor (`userId: "system"`, `userName = label`). The web `Actor` has no third type, and a system write isn't an assistant acting for someone, so it must not read "(agent)".
  - A missing `userId` becomes `""`.
- **Context.** `goal.text` → `goal`, `scope?.text ?? ""` → `scope`, entry `text` lists → `constraints` / `decisions`, `revision` → `version`, `goal.updatedAt` → `approvedAt`. The backend creates an empty context row with every workspace, so **no goal means `null`** ("No approved goal yet"). `ownership` and `openQuestions` aren't shown in P0.
- **Revisions** are sorted by `version` descending in the adapter, even though the backend already orders them.
- **Errors.** See below: `errors.ts` recognises the backend's plain `Error("CODE…")` messages, but only under `convex dev`.

## Gaps that need backend changes (for Person 2)

In priority order. Nothing here blocks local `convex dev` demos except #2.

1. **Errors must be `ConvexError`, not `Error`.** The backend throws `new Error("VERSION_CONFLICT: current version is N; expected M")`, `new Error("FORBIDDEN")` and so on. Production Convex redacts every non-`ConvexError` message to "Server Error", so deployed, a stale save arrives as `UNKNOWN` and the user sees "Something went wrong" instead of the conflict screen. Nothing is overwritten (the backend still rejects the write), but the reconcile flow never opens. Please throw:
   ```ts
   throw new ConvexError({ code: "VERSION_CONFLICT", currentVersion: file.version,
                           currentContent: file.content, updatedBy: file.updatedBy });
   ```
   Do the same with `{ code }` for `FORBIDDEN`, `FILE_NOT_FOUND`, `UNAUTHENTICATED` and the `INVALID_*` codes (the dashboard maps those to `INVALID_INPUT`). Until then, `errors.ts` parses `Uncaught Error: CODE` (and `current version is N`) from dev-mode messages as a stopgap, and refetches the file to show "theirs".
2. **Agent attribution: person plus agent.** Every mutation records `humanActor(user)`, so an assistant's MCP write is attributed to the person alone with no agent, and history can't tell Alex from Alex's Claude. This breaks the AGENTS.md rule. Agent writes need `{ type: "agent", userId, agentConnectionId, label }`. Please also denormalise the two display fields the dashboard needs onto the actor, so reads don't need a join:
   - `client` from `agent_connections.client` (e.g. `"claude"`), for `agentClient`.
   - The person's name, for `userName`. That turns "Claude (agent)" into "Claude for Alex".
3. **`approvedBy` on context.** `getWorkspaceContext` drops `updatedBy`, which the table stores per entry. Please return `goal.updatedBy` (the approver, as an actor). Until then the approved-goal card says "approved by A teammate".
4. **`custody` on file summaries (optional).** `listFiles` doesn't return it. This is the actor type of each recent version, oldest first and head last, e.g. `["agent", "human", "agent"]`; the last 8 versions are plenty. Without it the register shows earlier versions as neutral "unknown" marks.
5. **`permissions.canEdit` on `readFile` (optional).** It isn't returned. The adapter assumes `true`, because any member can call `updateDocument` today. Add it once roles gate edits.
6. **`users:viewer` (optional).** Return `{ name, email }`, so the header can show a name instead of the sign-in email.
7. **`listFiles` / `createDocument` default workspace.** These fall back to the caller's first membership when `workspaceId` is omitted. The dashboard always sends it, so this is fine for web; flagged only so MCP doesn't rely on it with multi-workspace users.

Shapes (`lib/api/types.ts`):

```ts
// Person AND agent, always (AGENTS.md). Mirrors MCP Attribution { actor_type, user_id, client }.
Actor          { actorType: "human" | "agent", userId: string, userName?: string,
                 agentClient?: string /* agent writes: "claude" | "chatgpt" | … */, agentName?: string }
FileSummary    { id, workspaceId, parentId: string | null, name, mimeType, version, updatedAt: number,
                 updatedBy: Actor, custody?: ("human" | "agent")[] }
FileDetail     FileSummary & { content: string | null, permissions: { canEdit: boolean } }
Revision       Actor & { version, createdAt: number, content?: string }
ProjectContext { goal: string, scope: string, constraints: string[], decisions: string[],
                 version: number, approvedBy: Actor, approvedAt: number }
```

**Attribution is required structure, not a display hint.** Every agent write carries both `userId` (whose assistant it is) and `agentClient`. The dashboard renders that as "Claude for Alex", so two teammates' Claudes are never confused in history or in conflicts.

**Authorization.** The backend branch does both of these (`getAuthorizedFile` and `requireMembership`), and returns `FILE_NOT_FOUND` for another tenant's file:
- Functions that take only a `fileId` (`files:readFile`, `files:updateDocument`, `files:getFileVersions`) must check membership through the **file's own `workspaceId`**, never a workspace passed by the client.
- Functions that take a `workspaceId` (`files:listFiles`, `files:createDocument`, `workspaces:getWorkspaceContext`) must check that the caller is a member of **that** workspace.
- The dashboard also refuses to show a file whose `workspaceId` doesn't match the URL (it renders "File not found"). That's cosmetic: Convex is the enforcement point.

## Errors

**Every business error must be a `ConvexError({ code, … })`.** The backend doesn't do this yet (gap #1). In production, Convex redacts the message of any other thrown error to a generic "Server Error". The dashboard's message-matching fallback for `UNAUTHENTICATED` and `NOT_IMPLEMENTED` only works against `convex dev`. Deployed, those errors would arrive as `UNKNOWN`.

| `data.code` | When | Extra `data` fields used |
|---|---|---|
| `VERSION_CONFLICT` | `expectedVersion` ≠ head | `currentVersion` (number, required); `currentContent` (string, optional, saves a refetch); `updatedBy` (`Actor`, optional but needed to say who saved) |
| `FORBIDDEN` | not a member / can't edit | none |
| `FILE_NOT_FOUND` | unknown or other-tenant file id | none |
| `UNAUTHENTICATED` | no identity | none |
| `APPROVAL_REQUIRED` | an agent tried to change goal, scope, decisions or ownership | none |
| `INVALID_INPUT` | validation failed | none |

`new ConvexError("VERSION_CONFLICT")` (bare string) is accepted too.

## Auth

The client uses the `@convex-dev/auth` Password provider: `signIn("password", { email, password, flow: "signIn" })`. The backend branch's `convex/auth.ts` has the Password provider and exports `isAuthenticated`. Still needed from Person 2 at deploy time:

- Keep exporting `isAuthenticated` from `convexAuth({...})`. The Next.js proxy calls `auth:isAuthenticated` on every `/w/*` and `/sign-in` request and fails without it.
- `JWT_PRIVATE_KEY` / `JWKS` / `SITE_URL` in the Convex deployment env.
- Seeded users.

`users:viewer` is still requested (gap #6).

## Revisions content

The history page shows a revision's content when `Revision.content` is present, and metadata only when it isn't. `files:getFileVersions` includes `content`, so the demo shows it.
