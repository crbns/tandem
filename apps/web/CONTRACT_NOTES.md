# Contract notes (web ↔ Convex backend)

For Person 2. The dashboard calls Convex directly. These are the functions it expects, how it reaches them, and what's missing.

## Backend state when this was written (Oct 23)

`packages/backend/convex/` has only an empty `schema.ts`: no functions, no `auth.ts`, no `_generated/`. Per conflict rule 3 the dashboard is built and verified in **mock mode** (`NEXT_PUBLIC_USE_MOCKS=true`). Convex wiring is `PENDING (backend)`.

Since `_generated/api` doesn't exist, `lib/api/convex.ts` references functions by name with `makeFunctionReference("module:export")`. Once the backend lands, swap these for `api.files.list` etc. for type safety. If Convex reports `Could not find public function`, the adapter surfaces it as `NOT_IMPLEMENTED` (see `lib/api/errors.ts`), so a missing function shows "Not available yet" instead of crashing.

## Canonical wire shape (web and MCP)

One shape for every Convex function, so the dashboard and the MCP server can never disagree:

- **camelCase keys** (`workspaceId`, `expectedVersion`, `currentVersion`).
- **Numeric timestamps** in epoch milliseconds (`updatedAt: number`), which is what Convex stores.
- **MCP maps at its tool boundary.** snake_case keys and ISO strings (`workspace_id`, `updated_at`) are MCP's *tool* format, converted from this shape inside `apps/mcp`. Convex never stores or returns them.
- **One set of function names for both callers**, so there's one write path and one optimistic-lock check: `files:read` / `files:create` / `files:update`. MCP's `readFile` / `createDocument` / `updateDocument` call these same functions.

As a safety net, the dashboard's error parser also accepts snake_case conflict keys (`current_version`, `current_content`, `updated_by: { actor_type, user_id, client }`), in case the backend reuses MCP's `versionConflict()` helper. Don't rely on it: camelCase is the contract.

## Function mapping

**All requested from Person 2.** None exist yet.

| Dashboard method | Convex function | Args | Expected return |
|---|---|---|---|
| `listWorkspaces()` | `workspaces:mine` (query) | `{}` | `{ id, name }[]` for the signed-in user |
| `listFiles(workspaceId)` | `files:list` (query) | `{ workspaceId }` | `FileSummary[]` |
| `createFile(workspaceId, input)` | `files:create` (mutation) | `{ workspaceId, name, mimeType, content }` (`content` **required**) | `{ id, version: 1 }` |
| `readFile(fileId)` | `files:read` (query) | `{ fileId }` | `FileDetail` |
| `updateFileContent(fileId, update)` | `files:update` (mutation) | `{ fileId, expectedVersion, content }` | `{ version }` |
| `listRevisions(fileId)` | `revisions:list` (query) | `{ fileId }` | `Revision[]`, **newest first** |
| `getContext(workspaceId)` | `context:get` (query) | `{ workspaceId }` | `ProjectContext \| null`, the **approved** version only |

`getContext` backs the approved goal on the files page (P0 in AGENTS.md: "dashboard with files, editor, revisions, and the approved goal").

**P1 asks, listed now so the human-approval rule has a backend counterpart:**
- `context:listProposals` takes `{ workspaceId }` and returns pending proposals, each with its proposer `Actor`.
- `context:approve` takes `{ proposalId, expectedVersion }`. It is for humans only; an agent gets `APPROVAL_REQUIRED`.

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

**Authorization (please confirm):**
- Functions that take only a `fileId` (`files:read`, `files:update`, `revisions:list`) must check membership through the **file's own `workspaceId`**, never a workspace passed by the client.
- Functions that take a `workspaceId` (`files:list`, `files:create`, `context:get`) must check that the caller is a member of **that** workspace.
- The dashboard also refuses to show a file whose `workspaceId` doesn't match the URL (it renders "File not found"). That's cosmetic: Convex is the enforcement point.

**Requested: `custody` on `FileSummary` (optional).** This is the actor type of each recent version, oldest first and head last, e.g. `["agent", "human", "agent"]`; the last 8 versions are plenty. The file register draws one custody mark per version from it. Without it, the dashboard shows earlier versions as neutral "unknown" marks and only the head mark carries an actor, so nothing is guessed.

If your functions return raw `Doc<"files">` (`_id`, `_creationTime`, …), either return the shapes above or tell Person 3, who will map them in `lib/api/convex.ts` only. Components won't change.

## Errors

**Every business error must be a `ConvexError({ code, … })`.** In production, Convex redacts the message of any other thrown error to a generic "Server Error". The dashboard's message-matching fallback for `UNAUTHENTICATED` and `NOT_IMPLEMENTED` only works against `convex dev`. Deployed, those errors would arrive as `UNKNOWN`.

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

The client uses the `@convex-dev/auth` Password provider: `signIn("password", { email, password, flow: "signIn" })`. Person 2 needs to provide:

- `convex/auth.ts` and `auth.config.ts` with the Password provider.
- **`convex/auth.ts` must export `isAuthenticated`** from `convexAuth({...})`, i.e. `export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth(...)`. The Next.js proxy calls `auth:isAuthenticated` on every `/w/*` and `/sign-in` request and fails without it.
- The `http.ts` auth routes.
- `JWT_PRIVATE_KEY` / `JWKS` / `SITE_URL` in the Convex deployment env.
- Seeded users.

**Requested:** a `users:viewer` query returning `{ name, email }`, so the header can show the user's name. Until then it shows the sign-in email.

## Revisions content

The history page shows a revision's content when `Revision.content` is present, and metadata only when it isn't. Including `content` is preferred for the demo.
