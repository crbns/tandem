# Workspace file system

Tandem's files form a real file system per workspace: nested folders holding
files and subfolders, addressed by id or by path. The dashboard and the MCP
server share one implementation (`packages/backend/convex/lib/fs.ts`); this
document is the contract every layer (Convex core, dashboard API, MCP tools,
the `apps/mcp` mock harness and the skill) follows.

## Model

- A workspace has an implicit root folder (`parentId` absent / `null`, path `/`).
- `folders` rows nest via `parentId`. `files.parentId` places a file in a folder.
- **Paths** are `/` + names joined by `/`: `/specs/api/endpoints.md`. Root is `/`.
  A folder path has no trailing slash (`/specs/api`). Paths are resolved
  segment by segment using the same collision key as names (`nameKey` in
  `lib/names.ts`): case-insensitive, NFKC, whitespace-collapsed. Input paths
  may omit the leading `/`, and a trailing `/` is ignored. Every tool and
  helper parses paths the same way (`splitPath`): the empty path `""`, empty
  segments (`//`, or a segment of only whitespace or zero-width characters),
  `.` and `..` (after `storedName`, so `"\u200B."` is `.`) are `INVALID_PATH`;
  a path below more than 32 folders (more than 33 segments) is
  `FOLDER_TOO_DEEP`. Segment errors are checked before depth.
- **Names** (files and folders) follow `storedName`/`nameKey`, 1–255 chars,
  and may not contain `/`, or be `.` or `..` (`INVALID_NAME`). The `/` rule
  applies to new names only (create, rename, move with rename); legacy rows are
  left alone.
- **One namespace per folder:** a file and a folder in the same parent cannot
  share a `nameKey`, and neither can two files or two folders. Collisions throw
  `NAME_EXISTS` with `{ kind: "file", fileId, name, currentVersion }` or
  `{ kind: "folder", folderId, name }`. (Existing file collisions keep their
  current payload plus `kind: "file"`.)
- **Depth limit:** at most 32 nested folders (`FOLDER_TOO_DEEP`, details
  `{ maxDepth: 32 }`). Moving a
  folder measures its whole subtree; a subtree of more than 2000 folders is
  `FOLDER_TOO_LARGE` (`limit: 2000`) rather than measured partially.
- **Soft delete only.** Deleting a folder soft-deletes it and its whole subtree
  (folders and files, history kept), at most 500 items per call
  (`FOLDER_TOO_LARGE` otherwise; nothing is written). Each deleted file gets a
  `file.deleted` event (sync tombstone); the folder gets one `folder.deleted`
  event. Deleted rows release their `nameKey`.

## Schema changes (`folders`)

Add, all optional for legacy rows: `nameKey`, `deletedAt`, `deletedBy`.
Folders keep `revision` as their optimistic-lock counter
(`expectedRevision`; stale → `VERSION_CONFLICT` with `currentRevision`).
New indexes: `by_workspace_and_parent_and_name_key`
(`workspaceId, parentId, nameKey`),
`by_workspace_and_parent_and_name_key_and_deleted_at`
(`workspaceId, parentId, nameKey, deletedAt`) and
`by_workspace_and_deleted_at_and_parent` (`workspaceId, deletedAt, parentId`).
Backfill: a legacy folder or file without `nameKey` is treated as having
`nameKey(name)` for path resolution and collision checks (compute on read
when absent) — no migration needed. The legacy lookup reads only live rows
without `nameKey` (`nameKey` and `deletedAt` both absent, at most 500 per
parent), so soft-deleted rows, which also release their key, never crowd it
out. `files` has the same `by_workspace_and_parent_and_name_key_and_deleted_at`
index for this. A legacy file gets its key stored the next time it moves.

## Core helpers (`convex/lib/fs.ts`)

Used by both dashboard functions and `mcpTools.ts`; callers authorize first.

| Helper | Behaviour |
| --- | --- |
| `createFolderCore(ctx, { workspaceId, parentId?, name, actor })` | Validates parent (live, same workspace), name, collision, depth. Inserts, records `folder.created`. Returns the doc. |
| `ensureFolderPathCore(ctx, { workspaceId, path, actor })` | `mkdir -p`: resolves each segment, creating missing folders. Returns `{ folder, created: boolean }` (`created` true if the last segment was new). A segment that names a **file** → `NAME_EXISTS` (`kind: "file"`). |
| `renameFolderCore(ctx, { folder, name, expectedRevision, actor })` | Collision-checked; `folder.renamed`. |
| `moveFolderCore(ctx, { folder, parentId: Id \| null, expectedRevision, name?, actor })` | Rejects moving into itself or a descendant (`INVALID_MOVE`), depth overflow, collisions; `folder.moved`. A no-op move (see below) returns the folder unchanged. |
| `deleteFolderCore(ctx, { folder, expectedRevision, actor })` | Recursive soft delete described above. Returns `{ deletedFiles, deletedFolders }`. |
| `moveFileCore(ctx, { file, parentId: Id \| null, expectedVersion, name?, actor })` | Like `renameFileCore`: version N+1, a revision row carrying the same content, `file.moved` event (summary `Moved a.md to /specs`, plus ` as b.md` when renamed). Name collisions in the destination → `NAME_EXISTS`. A no-op move returns the file unchanged. |
| `resolvePath(ctx, workspaceId, path)` | Returns `{ kind: "root" } \| { kind: "folder", folder } \| { kind: "file", file } \| null`. |
| `folderPath(ctx, folderId?)` / `filePath(ctx, file)` | Path strings. |
| `loadFolderIndex(ctx, workspaceId)` | One read of the workspace's live folders (≤ 2000) returning a map that computes many paths without per-row reads; use it in listings. |

**No-op moves.** A move whose destination is the current parent and that
has no `name`, or a `name` whose `storedName` equals the current name
exactly, changes nothing: no version or revision bump, no revision row, no
event. The version/revision check still runs first, so a stale one is still
`VERSION_CONFLICT`. A case-only rename (`plan.md` → `Plan.md`) is a real move.

Order of checks in `moveFileCore`/`moveFolderCore`: version/revision
(`VERSION_CONFLICT` for any mismatch, older or newer), destination parent,
no-op, then (folders) cycle and depth, then the new name and collisions. The
MCP tools resolve the destination argument (`PATH_NOT_FOUND` /
`FOLDER_NOT_FOUND`) before calling the core, so a missing destination is
reported before a stale version.

Existing `createDocumentCore`, `renameFileCore` also reject collisions with a
sibling **folder**, reject names containing `/`, and reject a deleted parent.

Event kinds added: `folder.renamed`, `folder.moved`, `folder.deleted`,
`file.moved`. (`folder.created` exists.)

## Dashboard API (Convex public functions)

New module `convex/folders.ts` (membership-checked like `files.ts`):

- `listDirectory({ workspaceId, folderId? })` →
  `{ folder: FolderRow | null, breadcrumbs: { id, name }[], folders: FolderRow[], files: FileRow[] }`
  — immediate children, folders then files sorted by name; `FolderRow =
  { id, workspaceId, parentId, name, path, revision, updatedAt, updatedBy }`;
  `FileRow` is the existing file metadata plus `path`. Throws `FOLDER_NOT_FOUND`
  for a missing/deleted/foreign folder. Children capped at 500 each.
- `listFolderTree({ workspaceId })` → `FolderRow[]` (all live folders, for the
  sidebar tree and the move picker).
- `createFolder({ workspaceId, parentId?, name })` → `FolderRow`.
- `renameFolder({ folderId, name, expectedRevision })` → `FolderRow`.
- `moveFolder({ folderId, parentId: Id | null, expectedRevision })` → `FolderRow`.
- `deleteFolder({ folderId, expectedRevision })` → `{ deletedFiles, deletedFolders }`.
- `files.moveFile({ fileId, parentId: Id | null, expectedVersion })` → `{ version }`.
- `files.finalizeUpload` gains optional `parentId` (new uploads only) so "Upload"
  lands in the current folder.

`workspaces.createFolder` stays as a thin wrapper over `createFolderCore` so
existing callers (seed, tests) keep working.

## MCP tools

All file outputs gain `path` (string). Folder outputs are
`{ id, parent_id, name, path, revision, updated_at }`.

- `list_files` — `folder_id` now works; new optional `path` (folder path,
  alternative to `folder_id`) and `recursive` (bool, default false). Without
  `query`: lists the folder's immediate `folders` and `files` (root when
  neither `folder_id` nor `path` is given), or the whole subtree flattened when
  `recursive`. With `query`, searches the folder's whole subtree (the whole
  workspace without a folder; `recursive` is implied) with one rule for files
  and folders (`queryTerms`/`matchesQuery` in `lib/names.ts`, identical in the
  mock): the query's `nameKey` is split on spaces into terms, and an entry
  matches when **every term is a substring of the entry name's `nameKey`**
  (so case-insensitive, NFKC, zero-width characters ignored; `"spec"` matches
  `myspecs.md`, `"api spec"` matches `spec-api.md`). A blank or
  whitespace-only query is no query. Convex scans up to 1000 live files in
  scope (plus name-index hits) and sets `truncated` when the scan stopped
  early; `truncated` also means more than 500 folders or files matched.
  Returns `{ folder: {id|null, path}, folders, files, truncated }`.
- `search_files` — results include `path`. A blank query is `INVALID_INPUT`
  (`field: "query"`).
- `read_file` — accepts `file_id` **or** `path`.
- `create_document` — `parent_id` now works; new optional `folder_path`
  (alternative to `parent_id`; the folder must exist — use `create_folder`).
- `create_folder` (new) — `path` (required, `mkdir -p` semantics, idempotent:
  returns the existing folder with `created: false`). Returns
  `{ folder, created }`.
- `move_file` (new) — `file_id`, `expected_version`, destination
  `to_folder_id` or `to_folder_path` (`"/"` = root), optional `new_name`.
  Version N+1; `VERSION_CONFLICT` on stale version. No-op moves return the
  file unchanged (see above).
- `move_folder` (new) — `folder_id`, `expected_revision`, destination
  `to_folder_id`/`to_folder_path`, optional `new_name`.
- `sync_workspace` — snapshot gains `folders` (all live folders, ≤ 200,
  `folders_truncated`); `changed_files` entries gain `path`. Folder events
  appear in `events` like file events. With `since`, a `folder.renamed` or
  `folder.moved` event in the page also adds every live file in that folder's
  current subtree to `changed_files`, with its new path (deduplicated with
  files touched by file events; at most 50 `changed_files` in all,
  `files_truncated` when more).
- Folder deletion is dashboard-only (no MCP delete, matching files).

New MCP error codes (mapped in `lib/mcpContract.ts` with a recovery hint):
`INVALID_PATH`, `PATH_NOT_FOUND`, `FOLDER_NOT_FOUND`, `INVALID_MOVE`,
`FOLDER_TOO_DEEP`, `FOLDER_TOO_LARGE`; `NAME_EXISTS` gains `kind`.
MCP reports `INVALID_NAME` as `INVALID_INPUT` (the existing MCP convention,
shared with the `apps/mcp` mock) with `field: "name"` and a message saying why:
the name contains `/`, is `.` or `..`, or is not 1–255 characters.

Error codes are the same in every tool and in the mock:

- `INVALID_PATH` for `""` and malformed segments in any path argument
  (`path`, `folder_path`, `to_folder_path`); `FOLDER_TOO_DEEP` (`max_depth`)
  for a path below more than 32 folders, and for `create_folder` of a 33rd
  level.
- `VERSION_CONFLICT` whenever `expected_version`/`expected_revision` differs
  from the current one, older or newer; below 1 is `INVALID_INPUT`.
- `INVALID_MOVE` carries `folder_id`.
- Recovery hints fit the failing tool: a `NAME_EXISTS` file clash suggests
  merging with `update_document` only for `create_document`; for
  `create_folder` it says to choose another folder path, for `move_*` another
  `new_name` or destination. A `/` in `move_*`'s `new_name` points at
  `to_folder_path`; `FOLDER_TOO_LARGE` from `move_folder` counts folders (2000)
  and suggests moving subfolders separately.

## Dashboard UI

The workspace page is a directory browser: `?folder=<folderId>` selects the
current folder, breadcrumbs show the path, folder rows open the folder, and
"New folder", "New file" and "Upload" act in the current folder. Files and
folders have Move… (folder picker from `listFolderTree`) and Rename; folders
also Delete (confirm shows the count it will remove). The file page shows the
file's path as breadcrumbs. Realtime: listings are reactive queries.
