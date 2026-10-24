# Contract notes (web ↔ Convex backend)

For Person 2. The dashboard calls Convex directly. These are the functions it expects, how it reaches them, and what's missing.

## Backend state when this was written (Oct 23)

`packages/backend/convex/` has only an empty `schema.ts`: no functions, no `auth.ts`, no `_generated/`. Per conflict rule 3 the dashboard is built and verified in **mock mode** (`NEXT_PUBLIC_USE_MOCKS=true`). Convex wiring is `PENDING (backend)`.

Since `_generated/api` doesn't exist, `lib/api/convex.ts` references functions by name with `makeFunctionReference("module:export")`. Once the backend lands, swap these for `api.files.list` etc. for type safety. If Convex reports `Could not find public function`, the adapter surfaces it as `NOT_IMPLEMENTED` (see `lib/api/errors.ts`), so a missing function shows "Not available yet" instead of crashing.

## Function mapping

**All requested from Person 2.** None exist yet.

| Dashboard method | Convex function | Args | Expected return |
|---|---|---|---|
| `listWorkspaces()` | `workspaces:mine` (query) | `{}` | `{ id, name }[]` for the signed-in user |
| `listFiles(workspaceId)` | `files:list` (query) | `{ workspaceId }` | `FileSummary[]` |
| `createFile(workspaceId, input)` | `files:create` (mutation) | `{ workspaceId, name, mimeType, content? }` | `{ id, version: 1 }` |
| `readFile(fileId)` | `files:get` (query) | `{ fileId }` | `FileDetail` |
| `updateFileContent(fileId, update)` | `files:updateContent` (mutation) | `{ fileId, expectedVersion, content }` | `{ version }` |
| `listRevisions(fileId)` | `revisions:list` (query) | `{ fileId }` | `Revision[]`, **newest first** |

Shapes (`lib/api/types.ts`):

```ts
Actor       { actorType: "human" | "agent", actorId: string, actorName?: string }
FileSummary { id, workspaceId, parentId: string | null, name, mimeType, version, updatedAt: number, updatedBy: Actor }
FileDetail  FileSummary & { content: string | null, permissions: { canEdit: boolean } }
Revision    Actor & { version, createdAt: number, content?: string }
```

**Authorization (please confirm):** functions that take only a `fileId` (`files:get`, `files:updateContent`, `revisions:list`) must check membership through the **file's own `workspaceId`**, never a workspace passed by the client. The dashboard also refuses to show a file whose `workspaceId` doesn't match the URL (it renders "File not found"), but that's cosmetic: Convex is the enforcement point.

**Requested: `custody` on `FileSummary` (optional).** This is the actor type of each recent version, oldest first and head last, e.g. `["agent", "human", "agent"]`; the last 8 versions are plenty. The file register draws one custody mark per version from it. Without it, the dashboard shows earlier versions as neutral "unknown" marks and only the head mark carries an actor, so nothing is guessed.

**Requested: "on behalf of" for agent actors.** Every teammate brings their own assistant, so "Agent · Claude" alone doesn't say whose Claude edited. Please add an optional `onBehalfOfName` (the human who connected that assistant) to `Actor` for agent writes; the badge will render "Claude (for Alex)".

If your functions return raw `Doc<"files">` (`_id`, `_creationTime`, …) or a different actor shape, either return the shapes above or tell Person 3, who will map them in `lib/api/convex.ts` only. Components won't change.

## Errors

The dashboard expects business errors as `ConvexError` with a `data.code`:

| `data.code` | When | Extra `data` fields used |
|---|---|---|
| `VERSION_CONFLICT` | `expectedVersion` ≠ head | `currentVersion` (number, required), `currentContent` (string, optional; saves a refetch), `updatedBy` (`Actor`, optional) |
| `FORBIDDEN` | not a member / can't edit | none |
| `FILE_NOT_FOUND` | unknown or other-tenant file id | none |
| `UNAUTHENTICATED` | no identity | none |

`new ConvexError("VERSION_CONFLICT")` (bare string) is accepted too. Plain `throw new Error("Not authenticated")` is mapped to `UNAUTHENTICATED` by message as a fallback, but please prefer `ConvexError`.

## Auth

Client side uses `@convex-dev/auth` Password provider: `signIn("password", { email, password, flow: "signIn" })`. Needs from Person 2: `convex/auth.ts` + `auth.config.ts` with the Password provider. **`convex/auth.ts` must export `isAuthenticated`** from `convexAuth({...})` (`export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth(...)`). The Next.js proxy calls `auth:isAuthenticated` on every `/w/*` and `/sign-in` request and fails without it. Also needed: the `http.ts` auth routes, `JWT_PRIVATE_KEY` / `JWKS` / `SITE_URL` in the Convex deployment env, and seeded users.

**Requested:** a `users:viewer` query returning `{ name, email }`, so the header can show the user's name. Until then it shows the sign-in email.

## Revisions content

The history page shows a revision's content when `Revision.content` is present and metadata only when it isn't. Including `content` is preferred for the demo.
