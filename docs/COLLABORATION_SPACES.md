# Collaboration Spaces — #215

## First block: membership and navigation

The new Codex navigation mode groups **existing personal Projects**, without creating new native threads or moving files. A Project bound into a space appears under that space instead of personal navigation. Closing a space or leaving removes only collaboration metadata; personal Projects, native thread IDs, files, drafts and history remain intact. The creator curates the container but does not own another participant's Project or native session.

Two creation/acceptance paths are available:

- **One project:** the creator chooses an existing Project and a Hub contact. The recipient chooses their own existing/local Project for the same canonical GitHub repository. The existing Project creation popup can create/connect the recipient's checkout and returns to the space wizard.
- **Space:** each participant contributes their own Project. The creator grants a proposed working mode on their Project and may request a mode on the recipient's Project. The recipient explicitly chooses their own grant; a requested higher mode is never treated as consent.

The first bell contains invitations only. A single cheap catalog refresh runs per mounted Codex workspace (30 seconds while visible, coalesced with focus refresh); it queries only private Team metadata. No background machine checks, history loads, native sends, credential changes or new admission requirements are added. Project repository inspection happens once on explicit creation/acceptance, via the existing inspector and the actor's own Project catalog. Acknowledgement retries reuse the existing Team receipt mechanism and skip repository reinspection.

Storage uses the existing Team SQLite database and transaction/receipt services. `collaboration_spaces` stores a bounded metadata aggregate; `collaboration_space_people` indexes member/invite visibility. Public responses contain project names/repository URLs and only the current viewer's local Project IDs; foreign local paths, thread IDs and private history are never serialized. The tables are additive and included in existing whole-database backups. No synthetic legacy Team Project is created merely for navigation.

## Next block: make the agreed work modes operational

The recorded Collaborative/Direct selections are **agreements for the next integration stage**, not a completed GitHub/native policy implementation. This block does not change native execution or GitHub rights. Follow up with:

1. Add/remove own Projects and members, change grants as the owning participant, request foreign elevation, bind additional local copies.
2. Connect these Project × User agreements to the existing GitHub operations. Keep GitHub access as the upper bound; Collaborative work uses working branches and PR, Direct permits the agreed branches. Do not route anyone into another user's native writer or filesystem.
3. Attach the appropriate public project context and mandatory completed-work commit/push instruction to existing native chats without replacing their history or editing AGENTS.md.

Then deliver one human chat per space with attachments and aggregated unread counts, followed by personal Project GPT and optional local CODEXWEB.md. Do not add technical event noise, a duplicate issue tracker, or automatically create GitHub issues. The full issue's final acceptance still needs the actual two users, separately from the disposable checks below.

## Focused verification

- `tests/collaboration-spaces.test.mjs`: asymmetric grants, invite-only visibility, own-checkout identity, same-repository acceptance, existing idempotent receipts, stale revisions, leave/close and persistence; route tests use disposable real Git repositories.
- `tests/collaboration-spaces.browser.mjs`: actual Hub/auth/space routes with disposable owner/member accounts, simulated native Codex RPC only; WebKit phone/tablet create/invite/accept, ordinary Project popup return, same native thread IDs after switching modes and leaving. No production test chats or member installations are created.
- Linux TypeScript checks and frontend build. Broad unrelated GPT/installer suites are intentionally outside this pass.
