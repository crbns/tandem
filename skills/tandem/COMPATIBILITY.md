# Tandem client compatibility

Measured in this session on **2026-10-24** against a **local Convex-backed MCP
server**, not the Node mock. Claude Code CLI is the only native client measured
end to end here. **Issue #31's two-native-client acceptance is still BLOCKED on
human GUI/account testing.** A CLI test does not verify Claude web or desktop.

## Claude Code CLI — measured

Client: `2.1.310 (Claude Code)`, headless `claude -p`, model `sonnet` (reported
`claude-sonnet-5-5`). Backend: anonymous local Convex 1.46.0 at
`http://127.0.0.1:3240`; HTTP actions/MCP at `http://127.0.0.1:3241/mcp`.
Seed: local `pnpm demo:reset --json`, workspace **Onboarding refresh**. Agent
credential: seeded Alex API key; conflict injector: seeded Blake API key.
No shared cloud reset, deployment, or mutation was performed.

Evidence:

- [12 clean-chat/conflict trials](./eval/results/2026-10-24-claude-code-convex-local.md)
  ([JSON](./eval/results/2026-10-24-claude-code-convex-local.json)).
- [4 create/control trials](./eval/results/2026-10-24-claude-code-convex-create-control.md)
  ([JSON](./eval/results/2026-10-24-claude-code-convex-create-control.json)).
- [2 mock-default regression trials](./eval/results/2026-10-24-claude-code-mock-smoke-d12.md),
  kept separate from Convex compatibility evidence.

| Check                                                | Result                        | Evidence / limits                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector configuration                              | PASS                          | `claude mcp add --scope project --transport http` with Bearer header succeeded in a temporary directory; generated `.mcp.json` checked, then `claude mcp remove --scope project` succeeded and temp directory removed. No global MCP config was installed.  |
| Actual native-client connection                      | PASS                          | All 16 Convex-backed trial init events show `tandem:connected`; isolated `--mcp-config` with Bearer API key, not OAuth.                                                                                                                                     |
| Tool discovery                                       | PASS                          | All 11 Tandem tools listed in each of the 16 trial init events.                                                                                                                                                                                             |
| Skill installed                                      | PASS                          | Only `SKILL.md` copied into project `.claude/skills/tandem`; `tandem` listed in all 8 WITH_SKILL init events, absent in all 8 NO_SKILL events. Skill explicitly invoked in 4/8 WITH_SKILL chats; availability is distinct from invocation.                  |
| `read_file`                                          | PASS                          | Called without tool error in 12/16 trials, including all 6 conflict trials and both create-check chats.                                                                                                                                                     |
| `create_document`                                    | PASS (one successful call)    | WITH_SKILL `p7-create-document` saved `client-check.md`; NO_SKILL rep 1 found that existing file and declined to overwrite it. This is persistent-state interference, not a matched create comparison.                                                      |
| `update_document` with `expected_version`            | PASS                          | All 6 conflict trials made a stale attempt and one successful retry with the reread version.                                                                                                                                                                |
| `VERSION_CONFLICT` recovery                          | PASS                          | 3/3 WITH_SKILL and 3/3 NO_SKILL: conflict, reread, exactly one successful retry, changed head with teammate marker preserved; 0 loops/clobbers. Injection 14–18 ms, before next tool call in all 6 trials.                                                  |
| Fresh goal/ownership chat sync without naming Tandem | MEASURED 3/3 vs 3/3           | Prompt `What's our current project goal, and who owns which parts?`; successful sync and first Tandem call = sync in 3/3 WITH_SKILL and 3/3 NO_SKILL clean chats. Explicit skill invocation 1/3 WITH_SKILL. No evidence of a skill advantage in this setup. |
| Unrelated control                                    | MEASURED 0/1 vs 0/1           | `Write a haiku about rain.`: no Tandem calls in either condition (Convex-backed run).                                                                                                                                                                       |
| Write-confirmation prompts                           | UNTESTED interactive behavior | Harness uses `--permission-mode dontAsk --allowedTools mcp__tandem__*`; no permission denials recorded. This does not measure interactive dialogs.                                                                                                          |
| Subscription plan required                           | UNTESTED                      | Existing authenticated CLI account used; exact plan and minimum-plan eligibility not measured.                                                                                                                                                              |
| OAuth in Claude Code                                 | UNTESTED                      | These trials use API keys.                                                                                                                                                                                                                                  |
| Screenshots / backup video                           | PENDING (human)               | Committed JSON and Markdown are terminal evidence, not GUI footage. See TESTING.md.                                                                                                                                                                         |

Both project and conflict prompts never mention Tandem, MCP, the workspace, or
the skill. Read-only goal prompts give the least ambiguous spontaneous-sync
measurement. All 6 edit chats also synced first; both create chats synced first.
Report those separately from the 3-repetition goal prompt rather than treating
different tasks as identical samples.

Limits: serial trials share one persistent local backend. Before each conflict
trial the harness replaces the supplied brief with its synthetic Cal Hacks
fixture; the workspace's approved context still describes onboarding. Later
chats can see prior revisions and documents. The literal teammate marker says
"sam", while the actual second credential is Blake. The goal prompt's first
repetition preceded fixture replacement; later repetitions followed it. Rates
are small-sample behavior in an empty project with Tandem as the only MCP
server. Conflicts are simple append/intro edits; overlapping edits and a second
retry conflict were not tested. Expected VERSION_CONFLICT errors remain in the
harness error totals even when recovery succeeds. No CLI failures or timeouts
occurred in the 16 Convex trials; the six injected conflict errors are expected.
Total CLI-reported Convex evaluation cost: **$1.03**.

## GUI clients — untested / PENDING (human)

Use the copy-paste [manual test protocol](./TESTING.md) for connector OAuth,
`skills/package.sh` skill packaging/install, read/create/update, deliberate
stale-write recovery, clean-chat rates, write confirmations, exact plan and
eligibility, screenshots and backup footage. These rows intentionally contain
no compatibility pass claims.

| Client         | Connector + skill | Read/create/update | Conflict recovery | Clean-chat sync k/n | Write prompts | Plan/eligibility | Footage |
| -------------- | ----------------- | ------------------ | ----------------- | ------------------- | ------------- | ---------------- | ------- |
| Claude web     | PENDING (human)   | PENDING            | PENDING           | PENDING             | PENDING       | PENDING          | PENDING |
| Claude desktop | PENDING (human)   | PENDING            | PENDING           | PENDING             | PENDING       | PENDING          | PENDING |
| ChatGPT        | PENDING (human)   | PENDING            | PENDING           | PENDING             | PENDING       | PENDING          | PENDING |
| Gemini         | PENDING (human)   | PENDING            | PENDING           | PENDING             | PENDING       | PENDING          | PENDING |

No qualifying second-vendor account was supplied. Confirm actual write-capable
account access before selecting ChatGPT or Gemini; do not infer eligibility
from their presence in a menu. Repository plan assumptions and the exact
checks to make are in TESTING.md, labeled as unverified requirements.

## Historical artifacts

The committed [2026-10-23 mock run](./eval/results/2026-10-23-claude-code.md),
[realistic mock run](./eval/results/2026-10-23-claude-code-realistic.md), and
[mock conflict run](./eval/results/2026-10-23-claude-code-conflict-bare.md) remain
archived. They were not remeasured here and are not evidence for Convex-backed
or GUI-client compatibility. Earlier manually reported connector observations
also do not substitute for the pending end-to-end GUI protocol.
