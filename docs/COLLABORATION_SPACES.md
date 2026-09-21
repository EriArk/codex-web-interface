# Collaboration Spaces — #215

## First block: membership and navigation

The new Codex navigation mode groups **existing personal Projects**, without creating new native threads or moving files. A Project bound into a space appears under that space instead of personal navigation. Closing a space or leaving removes only collaboration metadata; personal Projects, native thread IDs, files, drafts and history remain intact. The creator curates the container but does not own another participant's Project or native session.

Two creation/acceptance paths are available:

- **One project:** the creator chooses an existing Project and a Hub contact. The recipient chooses their own existing/local Project for the same canonical GitHub repository. The existing Project creation popup can create/connect the recipient's checkout and returns to the space wizard.
- **Space:** each participant contributes their own Project. The creator grants a proposed working mode on their Project and may request a mode on the recipient's Project. The recipient explicitly chooses their own grant; a requested higher mode is never treated as consent.

The first bell contains invitations only. A single cheap catalog refresh runs per mounted Codex workspace (30 seconds while visible, coalesced with focus refresh); it queries only private Team metadata. No background machine checks, history loads, native sends, credential changes or new admission requirements are added. Project repository inspection happens once on explicit creation/acceptance, via the existing inspector and the actor's own Project catalog. Acknowledgement retries reuse the existing Team receipt mechanism and skip repository reinspection.

Storage uses the existing Team SQLite database and transaction/receipt services. `collaboration_spaces` stores a bounded metadata aggregate; `collaboration_space_people` indexes member/invite visibility. Public responses contain project names/repository URLs and only the current viewer's local Project IDs; foreign local paths, thread IDs and private history are never serialized. The tables are additive and included in existing whole-database backups. No synthetic legacy Team Project is created merely for navigation.

## Second block: projects and working agreements

Space settings now provide adding/removing one's own Projects, connecting or replacing one's own copy of another Project, per-participant grants controlled by the Project owner, explicit Direct access requests, and curator removal of participants/pending invitations. Removing metadata restores personal navigation and leaves repositories and native history intact. Further invitations beyond the initial pair remain follow-up work; the curator must not silently grant a new participant access to someone else's Project.

Existing Git delivery checks the current agreement when preparing and immediately before applying publication. Collaborative work uses a working branch and PR; publishing the default branch/main/master through these actions is rejected. Direct/Owner follows existing GitHub permissions and branch protections. Local commits remain available. There is no new credential flow or GitHub permission mutation.

Normal native turns receive the current public project context through native collaboration settings, including meaningful commit/push of completed verified work and explicit approval before creating issues. Queue submissions update the native thread defaults; Steer preserves the active turn. No visible wrapper message, replacement chat, AGENTS.md edit, foreign local path or private history is introduced. Changed agreements affect subsequent native submissions, not already-running work. These native instructions guide the model; they are **not a shell sandbox** or a replacement for GitHub branch protection. A personal checkout remains personal after leaving a space.

The notifications shortcut now includes requests for access to one's own Projects. Project names, members and repository metadata refresh through the existing cheap catalog; no machine polling is added. The triangle control uses shared theme materials and a collaboration icon, with a front-facing cap and text-safe overlap of the adjacent tabs.

Then deliver one human chat per space with attachments and aggregated unread counts, followed by personal Project GPT and optional local CODEXWEB.md. Do not add technical event noise, a duplicate issue tracker, or automatically create GitHub issues. The full issue's final acceptance still needs the actual two users, separately from the disposable checks below.

## Focused verification

- `tests/collaboration-spaces.test.mjs`: asymmetric grants, invite-only visibility, own-checkout identity, same-repository acceptance, existing idempotent receipts, stale revisions, leave/close, persistence, project/member removal and explicit access elevation; route tests use disposable real Git repositories.
- `tests/queue.test.mjs` and `tests/project-delivery.test.mjs`: native instructions on turn/queue defaults, unchanged Steer and prepared publication rejected after access changes. Together with the store/routes checks: 17 focused cases.
- `tests/collaboration-spaces.browser.mjs`: actual Hub/auth/space routes with disposable owner/member accounts, simulated native Codex RPC only; WebKit phone/tablet create/invite/accept, ordinary Project popup return, checkout binding, access request/approval, own-project add/remove and same native thread IDs after switching modes and leaving. Wizard geometry is checked at four widths in all themes, including constrained keyboard height. No production test chats or member installations are created.
- Linux TypeScript checks and frontend build. Broad unrelated GPT/installer suites are intentionally outside this pass.
