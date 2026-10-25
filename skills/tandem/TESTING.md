# Native-client manual measurement protocol

Status: **PENDING (human)** for Claude web, Claude desktop, ChatGPT and Gemini.
No account eligibility, GUI installation, write confirmation, screenshot, or video
result is implied by these instructions. Claude Code measurements are separate in
[COMPATIBILITY.md](./COMPATIBILITY.md).

## Prepare a disposable workspace

Use a team-approved test deployment and workspace with two human members, a
canonical `brief.md`, and a recorded goal and ownership. Do not reset the shared
demo or mutate production to prepare a test. A remote web connector needs a
publicly reachable HTTPS `/mcp` endpoint; `127.0.0.1` from the CLI measurement is
not reachable from hosted clients. Obtain the URL from the Assistants page:

```text
https://<approved-test-deployment>.convex.site/mcp
```

Record date, tester, client name/version, exact subscription plan, organization
settings, model, deployment, workspace, and installed skill revision. Capture the
project goal and original brief revision for comparison. Redact API keys,
passwords, OAuth codes and private conversation content from artifacts.

Build the skill from the repository root:

```sh
sh skills/package.sh
unzip -l dist/tandem-skill.zip
```

Expected archive: `tandem/SKILL.md` and `tandem/README.md`. Test prompts/results
stay outside the archive.

## Connect and install instructions

For Claude web and Claude desktop, test each separately:

1. Open Settings → Connectors → Add custom connector (record the actual labels
   if the UI differs). Name it Tandem and paste the approved HTTPS URL above.
2. Follow OAuth to Tandem, sign in as a test member, select the disposable
   workspace/assistant and allow access. Record any administrator restriction.
3. Enable the connector in the chat tools menu. Expand tool discovery and
   record all exposed tool names; the expected surface is the fifteen tools
   listed in `SKILL.md`.
4. Open Settings → Capabilities → Skills, enable skills, upload
   `dist/tandem-skill.zip`, and enable `tandem`. Record missing menus or plan
   restrictions as BLOCKED rather than assuming installation succeeded.
5. Start a new chat with no pasted project context or attached files.

For a second vendor, first have the account owner confirm eligibility in the
actual account; record the evidence. Repository planning assumptions are that
ChatGPT full writes require Business/Enterprise/Edu beta access (Pro read-only;
Plus unsuitable), and Gemini custom MCP apps have eligibility limits. These are
requirements to verify, not measured account compatibility.

For ChatGPT, open the account's Apps/Connectors developer configuration, create a
custom MCP app using the URL above, complete OAuth, enable the app's tools in a
new chat, and verify that **write tools** are exposed. For Gemini, have the
eligible account's owner register a custom MCP app with the same URL, complete
OAuth, enable it, and record the actual configuration route. If the interface or
eligibility is unavailable, stop that client's checks at BLOCKED and record the
missing capability. Do not represent these unmeasured menu paths as verified.

If a client has no skill upload facility, paste the full body of `SKILL.md` into
its project/GPT/Gem instructions and record **instructions fallback, not native
skill installation**. Start each trial in that same configured project/Gem. Do
not paste instructions into the test chat itself. Record instructions visibility
and connector enablement separately; manual connector selection is a limitation.

## Read, create, update and conflict recovery

Send these in one dedicated functionality chat, replacing bracketed values with
actual IDs/names. Expand tool results and record inputs, output versions and
confirmation dialogs. A normal final answer alone is not proof of a successful
write; verify the saved document in the dashboard.

```text
Read brief.md from our connected project and report its file ID, version,
and the opening paragraph. Do not change anything yet.
```

```text
Create a shared document named client-check-[client]-[timestamp].md with
content "Native client write test". You have my permission to save it for
the team. Report the file ID and saved version.
```

```text
Read that test document and append "First edit" using update_document
with expected_version set to the version just read. Report the saved version.
```

Now stage an actual stale write, using only this disposable test file:

1. In chat A, ask to read the test file and remember its version `N`, without
   writing. Record its file ID and `N` from the result.
2. As the other member in the dashboard (or a separately authenticated client),
   append `Teammate note: preserve this line.` and save. Verify head `N+1`.
3. In chat A, send the following (substitute the captured numeric `N`):

```text
For this deliberate version-conflict test, first attempt update_document
on the test file with expected_version=[N] and content "Native client
write test\nFirst edit\nAssistant edit". If the server reports
VERSION_CONFLICT, reread the canonical file, preserve the teammate's line,
merge in "Assistant edit", and retry once using the new version.
Tell me the outcome and stop if the retry also conflicts.
```

Verify the first call actually uses stale `N` and returns `VERSION_CONFLICT`.
If the client rereads before the first write, mark the conflict **not exercised**
and repeat; do not call that a conflict-recovery pass. A recovery passes only
when a reread follows the error, one retry succeeds, the final head includes
both edits, and revision history contains the teammate revision and new head.
Overlapping edits and repeated conflicts are separate, unmeasured branches.

## Folders

In the same functionality chat (it assumes the workspace has no `/client-check`
folder yet):

```text
Create a folder /client-check/[client] and save a shared document named
notes.md in it with content "Folder test". You have my permission to save
it for the team. Then read it back by its path and report the path and version.
```

Pass: `create_folder` with that path (one call creates both levels), then
`create_document` with `folder_path` (or the new folder's id), then `read_file`
with `path: "/client-check/[client]/notes.md"`. Repeating `create_folder`
returns `created: false`. The dashboard shows the file inside the new folder.

For **every write**, record whether the client showed a confirmation prompt,
its exact wording/options, which option was chosen, and whether approval applies
to a single call, tool, chat or account. Explicit user authorization in the prompt
does not prove that the client omits its own confirmation dialog.

## Clean-chat sync rate

Run these verbatim in **separate fresh chats**, three repetitions per prompt:

```text
What's our current project goal, and who owns which parts?
```

```text
Draft a one-page brief for our launch plan that I can share with the team.
```

Never mention Tandem, MCP, sync, the workspace, or the skill in these chats.
Do not pre-call any tool, attach files or paste canonical context. Keep
connector/instructions configuration identical. If possible repeat with the
skill/instructions disabled as a separate NO_SKILL condition; do not mix that
condition into WITH_SKILL totals. Count all trials, including refusals and
errors. Do not retry only failed trials.

| Client/condition | Prompt | Rep | Skill visibly activated? | First connected tool | sync attempted/OK? | Read canonical file? | Error/confirmation | Artifact |
| ---------------- | ------ | --- | ------------------------ | -------------------- | ------------------ | -------------------- | ------------------ | -------- |
| PENDING (human)  |        |     |                          |                      |                    |                      |                    |          |

Report both `sync_workspace` successful / all trials and first Tandem call =
`sync_workspace` / all trials as **k/n**, plus any Tandem call / all trials.
Report project prompts separately from unrelated controls such as `Write a
haiku about rain.` (three fresh chats). Small samples measure behavior under
this setup; they do not promise automatic activation in all chats.

## Continuous loop (read before, write back after)

Measures whether, once Tandem is in use in a chat, the assistant keeps syncing
and reading before work and writing back after it **without being asked
again**. Use one fresh chat per run, three runs per client. Send these turns in
order in the same chat; only the first mentions Tandem:

```text
Use Tandem for this. What's our current project goal?
```

```text
Draft a short risks section for brief.md covering the top three launch risks.
```

```text
Add a one-paragraph status note for this week as a new doc.
```

```text
Which of these risks should we tackle first?
```

```text
We've decided to cut the mobile app from v1.
```

Between turns 1 and 2, have a teammate edit `brief.md` in the dashboard, so
the turn 2 edit must re-sync and re-read to get the new version, or hit
`VERSION_CONFLICT` and reconcile.

Expected, per turn (record each as yes / no / prompted):

| Turn | Read before                                                      | Write back after                                                                  |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | `sync_workspace` (brief); answer cites the project goal          | none (question only)                                                              |
| 2    | `sync_workspace` with `since` (sees the teammate edit), `read_file` of `brief.md` | `update_document` with the version read (keeping the teammate's edit; on `VERSION_CONFLICT`, re-read and merge), then `publish_work`; one-line report |
| 3    | `sync_workspace` with `since`                                    | `create_document`, then `publish_work`; one-line report                           |
| 4    | `sync_workspace` with `since`, `read_file` of `brief.md`         | no file change; still `publish_work` kind `"finding"` with the recommendation     |
| 5    | `sync_workspace` with `since`                                    | `update_context` (`decisions`), reported as applied; no file edit claims it      |

Also check in the dashboard: the new revisions, the published work, and the
recorded decision, each attributed to the assistant. Check that no published
summary quotes the chat beyond the work itself. Note every client
write-confirmation prompt; "Always allow" on Tandem's tools removes them.

| Client         | Run | T1 read | T2 read/write | T3 read/write | T4 finding | T5 context | Prompted? | Notes |
| -------------- | --- | ------- | ------------- | ------------- | ---------- | ---------- | --------- | ----- |
| Claude web     |     | PENDING | PENDING       | PENDING       | PENDING    | PENDING    |           |       |
| Claude desktop |     | PENDING | PENDING       | PENDING       | PENDING    | PENDING    |           |       |

**Empty-context run.** Send turns 1 to 3 once per client in a fresh chat on a
workspace with no goal, scope or entries, after seeding `brief.md` with a
goal, an owner and an open question in its text (turn 1 then finds no
recorded goal). Expected: the assistant reads and saves files but makes no
`update_context` call for what they show. Within a minute or two of the saves,
Tandem's context manager records the brief's claims as observations citing
the file. A later `sync_workspace` shows them under `observed` while
`active_context` stays empty. Record yes / no / prompted per client.

| Client         | Run | No unprompted `update_context` | Goal/owner stay observed | Cites the file | No duplicates | Notes |
| -------------- | --- | ------------------------------ | ----------------------------------- | -------------- | ------------- | ----- |
| Claude web     |     | PENDING                        | PENDING                             | PENDING        | PENDING       |       |
| Claude desktop |     | PENDING                        | PENDING                             | PENDING        | PENDING       |       |

## Record and replay

Save redacted screenshots of connector/skill installation, expanded successful
read/create/update results, the stale write error, recovered head/revisions,
confirmation dialogs and exact account plan. Record a short backup video of the
same functionality sequence plus one clean-chat trial; label any explicit
"sync" fallback as prompted rather than spontaneous activation. Link artifact
paths and the trial sheet from COMPATIBILITY.md. If automatic sync fails, record
that failure before demonstrating the honest fallback:

```text
Sync our connected project workspace, then read brief.md before answering.
```

| Client         | Connector + instructions | Read/create/update | Conflict recovery | Clean sync k/n | Write confirmations | Plan/eligibility | Screenshots/video |
| -------------- | ------------------------ | ------------------ | ----------------- | -------------- | ------------------- | ---------------- | ----------------- |
| Claude web     | PENDING (human)          | PENDING            | PENDING           | PENDING        | PENDING             | PENDING          | PENDING           |
| Claude desktop | PENDING (human)          | PENDING            | PENDING           | PENDING        | PENDING             | PENDING          | PENDING           |
| ChatGPT        | PENDING (human)          | PENDING            | PENDING           | PENDING        | PENDING             | PENDING          | PENDING           |
| Gemini         | PENDING (human)          | PENDING            | PENDING           | PENDING        | PENDING             | PENDING          | PENDING           |

Afterward remove test connectors/instructions as appropriate and archive or
delete only the disposable documents according to the team's test policy.
