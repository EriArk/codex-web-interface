# Collaboration Spaces — #215

## Current status (2026-09-23)

The owner confirmed on 22 September in [#215](https://github.com/EriArk/codex-web-interface/issues/215), [#195](https://github.com/EriArk/codex-web-interface/issues/195) and [#198](https://github.com/EriArk/codex-web-interface/issues/198) that the friend is connected, the real two-user Space flow works and the participant's own checkout is usable. That live report supersedes pending first-friend acceptance language in the implementation history below. Automated tests remain fixture evidence, not physical-device verification.

Keep #215 for concrete polish/edge cases and #198 for managed provenance, synchronization, conflicts and optional test environments. [#218](https://github.com/EriArk/codex-web-interface/issues/218) adds Activity as a separate layer, replacing automatic Work Reports. Follow the current [Roadmap](ROADMAP.md); do not rebuild Space membership, checkout creation or Project GPT bindings. Earlier geometry/follow-up statements below are historical; the round key and current AGENTS.md navigation rules take precedence.

## Workspace navigation corrections

The human chat opens as a separate popup from the central workspace header. Left navigation contains no chat-launch buttons, only unread counts. Entering Shared mode (and switching spaces) hides the previous personal conversation and Results until an explicit shared Project/chat selection; the prior mounted conversation, draft and background work are retained. A themed empty state prompts selection. Wide navigation uses the same draggable grip as Results, with a device-local 260–420 px width shared across Codex and GPT; compact phone drawers are unchanged.

## Completion block: additional invitations and personal recommendations

The curator can now invite more Hub contacts from Space Settings. Each offered Project has an explicit grant from its own owner. The curator chooses grants only for their own Projects; other owners can grant a pending invitee access from their Project card before acceptance, or grant access after they join. A missing grant remains missing and cannot bind a checkout. A recipient contributing a new Project chooses access separately for every existing member. Cancelling, declining or removing an invitation/member clears its grants; reinviting never resurrects prior permissions.

Creation and additional invitations offer optional Codex recommendations. The recipient can deselect any suggested preset and edit/remove the custom text in the final wizard step. Selected preferences merge into the user's existing local rules before membership is accepted; an installation failure leaves the invitation available to retry. A private receipt prevents a completed retry from overwriting later personal settings. Declining all suggestions creates no file and leaves any existing preferences unchanged. Space Settings → Project → **Мои настройки Codex** edits those same personal rules without opening GPT. Mandatory commit/push guidance remains in the existing native collaboration context.

The completed implementation is checked with disposable Hub users and Git repositories. `collaboration-spaces.browser.mjs` now covers creation with recommendations, recipient opt-out, a third invitation, a foreign Project owner's grant, acceptance, local rules, settings changes and leaving, alongside the existing chat/files/unread/native-identity workflow. New invitation forms are checked at phone/tablet widths in four themes with a constrained keyboard viewport. Native transport is simulated; this does not claim the real owner/friend's GitHub credentials, permissions or physical devices have been accepted. Brainstorm remains outside #215.

## First block: membership and navigation

The new Codex navigation mode groups **existing personal Projects**, without creating new native threads or moving files. A Project bound into a space appears under that space instead of personal navigation. Closing a space or leaving removes only collaboration metadata; personal Projects, native thread IDs, files, drafts and history remain intact. The creator curates the container but does not own another participant's Project or native session.

Two creation/acceptance paths are available:

- **One project:** the creator chooses an existing Project and a Hub contact. The recipient chooses their own existing/local Project for the same canonical GitHub repository. The existing Project creation popup can create/connect the recipient's checkout and returns to the space wizard.
- **Space:** each participant contributes their own Project. The creator grants a proposed working mode on their Project and may request a mode on the recipient's Project. The recipient explicitly chooses their own grant; a requested higher mode is never treated as consent.

The first bell contained invitations only. The current catalog refresh runs once per mounted Codex workspace (10 seconds while visible, coalesced with focus refresh); it queries only private Team metadata. No background machine checks, history loads, native sends, credential changes or new admission requirements are added. Project repository inspection happens once on explicit creation/acceptance, via the existing inspector and the actor's own Project catalog. Acknowledgement retries reuse the existing Team receipt mechanism and skip repository reinspection.

Storage uses the existing Team SQLite database and transaction/receipt services. `collaboration_spaces` stores a bounded metadata aggregate; `collaboration_space_people` indexes member/invite visibility. Public responses contain project names/repository URLs and only the current viewer's local Project IDs; foreign local paths, thread IDs and private history are never serialized. The tables are additive and included in existing whole-database backups. No synthetic legacy Team Project is created merely for navigation.

## Second block: projects and working agreements

Space settings provide adding/removing one's own Projects, connecting or replacing one's own copy of another Project, per-participant grants controlled by the Project owner, explicit Direct access requests, and curator removal of participants/pending invitations. Removing metadata restores personal navigation and leaves repositories and native history intact. Additional invitations are implemented in the completion block above; the curator cannot grant access to someone else's Project.

Existing Git delivery checks the current agreement when preparing and immediately before applying publication. Collaborative work uses a working branch and PR; publishing the default branch/main/master through these actions is rejected. Direct/Owner follows existing GitHub permissions and branch protections. Local commits remain available. There is no new credential flow or GitHub permission mutation.

Normal native turns receive the current public project context through native collaboration settings, including meaningful commit/push of completed verified work and explicit approval before creating issues. Queue submissions update the native thread defaults; Steer preserves the active turn. No visible wrapper message, replacement chat, AGENTS.md edit, foreign local path or private history is introduced. Changed agreements affect subsequent native submissions, not already-running work. These native instructions guide the model; they are **not a shell sandbox** or a replacement for GitHub branch protection. A personal checkout remains personal after leaving a space.

The notifications shortcut now includes requests for access to one's own Projects. Project names, members and repository metadata refresh through the existing cheap catalog; no machine polling is added. The triangle control uses shared theme materials and a collaboration icon, with a front-facing cap and text-safe overlap of the adjacent tabs.

Personal Project GPT and optional local CODEXWEB.md are implemented in the fourth block below. Do not add technical event noise, a duplicate issue tracker, or automatically create GitHub issues. The full issue's final acceptance still needs the actual two users, separately from the disposable checks below.

## Third block: human chat and shared navigation

Each space has one human chat popup, opened from the chat icon in the central workspace header or from aggregated unread Notifications. The left navigation retains unread counts only. It contains text/Markdown links, files and inline uploaded images. Technical actions and native Codex/GPT messages are not inserted. Personal chat selection, native identity and composer remain behind the popup. Shared navigation retains the central collaboration key, enlarged another third to 85×80 px, between **Пространства** and **Брейншторм**. Brainstorm is only a themed future-room placeholder in this block.

Chat uses additive tables in the existing Team SQLite database; immutable file bytes live under the Team root in `space-chat-files` and are included in whole-installation checkpoints. Uploads are at most 32 MiB each, eight per message, with a 1 GiB chat file pool; unattached stages expire after seven days and are swept on later uploads. No personal machine/native runtime is consulted. Every read/download/send checks current space membership; another participant cannot use or download an unpublished upload. Leaving/closing never changes personal Projects or chats.

Initial/older history pages contain 20 messages. An open visible popup coalesces incremental reads every 2.5 seconds and on focus; hidden pages stop polling. Canonical read cursors are independent of send acknowledgements so simultaneous replies cannot skip intervening messages. Per-user read cursors advance monotonically only while the displayed history is at its end, with own posts excluded from unread. The catalog has one aggregate per space and the bell aggregates these with invitations/access requests, without a notification item per message.

Draft text and uploaded attachment references use account-local storage. Send UUIDs and durable receipts make an explicit retry idempotent; a received canonical message also reconciles an acknowledgement lost in transit. Identical intentional consecutive messages have different UUIDs. Closing/reopening preserves the draft; no automatic native send or replay is introduced.

Focused checks add real Hub file byte/download, sender binding, pagination, persistent independent unread and receipt cases to `tests/collaboration-spaces.test.mjs`. The two-user WebKit test covers human messages, links, uploaded PNG/text, live replies, unread clearing and popup draft continuity, plus theme/navigation and constrained-keyboard geometry. It uses disposable accounts/files only, with native RPC simulated. This is not physical owner/friend acceptance.

## Fourth block: personal Project GPT and optional preferences

Open **GPT проекта** from a Codex Project overview. The themed popup leaves Codex mounted underneath and reuses the normal personal GPT composer, native send queue, history, public progress, files and categorized Results. Its settings bind an existing personal GPT chat or start a new one on the first explicit message. Closing the popup never cancels native work. Bindings persist per personal runtime database; opening another user's same-named Project never shares the binding or transcript. The ordinary GPT selection and blank draft are not changed; Project GPT has its own draft scope.

Every explicit send includes a collapsed public project-context envelope: name, cached repository URL, a bounded brief from the personal Project core, current space/related repository names and effective agreement, plus the optional preferences. Only publicly shared space metadata is included, never another member's paths, chats or credentials. Own repository metadata refreshes at most once per five minutes when the popup is opened; an unavailable computer does not block opening GPT. This context grants no GitHub or file access. GPT can use the user's connected tools, and must not claim it has read code when it has not. Publishing issues remains an explicit user request. No automatic issue creation or separate Space GPT is added.

Private binding/send-intent tables supplement the existing durable GPT outbox. Retries freeze the original context/native identity and reuse the exact receipt. A completed native chat identity is recovered from that receipt even after a process interruption. A pending first send cannot create a second chat; a stale device cannot silently send into a changed binding. Selecting another chat leaves the earlier chat and its work intact.

Optional preferences are edited under the popup's settings. Applying selected preferences writes a managed **CODEXWEB.md** in that user's project root and excludes it through Git's local `info/exclude`, including linked worktrees; `AGENTS.md` and shared `.gitignore` stay intact. No file is created until preferences are selected. Disabling all preferences removes only the managed file. An existing unmanaged or tracked file is preserved. Subsequent Codex turns/queue defaults request reading CODEXWEB.md alongside AGENTS.md; active turns and Steer remain unchanged. GPT receives the same preferences in subsequent messages. Propagating optional defaults through new invitations is still follow-up scope, not implied acceptance by another participant.

The latest navigation correction replaces the triangle with the existing matte round mode-key material. The key is now **left of** the tabs, in the former magnifier position; the navigation search button is removed in both clients. Notifications stays in the lower shortcuts. Earlier central/triangle geometry descriptions above record superseded stages.

Focused verification: `tests/project-gpt.test.mjs` exercises actual native-provider/outbox routes, retry/context changes, late identity recovery, independent personal stores and real Git exclusion/rule removal. `tests/project-gpt.browser.mjs` uses WebKit and the actual Hub with simulated native transport for popup draft/binding/send/completion/reopen, rules, Results and phone/tablet/theme/keyboard geometry. The existing two-user space browser check covers the relocated round control and preserved shared navigation. These are disposable checks, not physical owner/friend acceptance.

## Opening a linked Project (2026-09-21)

Linked Projects are clickable project rows. An already connected personal copy opens the ordinary Project overview, with existing Files, Git, materials and personal Codex conversations. Without a copy, the same entry offers selecting an existing Project or creating a checkout through the normal themed Project wizard, prefilled with the shared repository and name. Closing that wizard returns to the selection.

Connecting the copy creates a personal introductory Codex chat and sends its first message with the GitHub URL, Project and Space names and related repository URLs. It asks Codex to inspect project instructions and structure and explain the project before making changes. Account-local durable receipts reuse the same chat and submission across repeated requests/devices; uncertain sends are never replayed. Native work runs in the participant's own copy with the existing agreement. Other participants' chats and credentials stay private.

The focused two-user WebKit scenario covers opening the linked row, checkout wizard return, binding, initial native prompt, duplicate-request handling and reopening the ordinary overview. Native RPC is simulated; no real GitHub changes or user prompts are made during verification.

## Earlier block verification details

- `tests/collaboration-spaces.test.mjs`: asymmetric grants, invite-only visibility, own-checkout identity, same-repository acceptance, existing idempotent receipts, stale revisions, leave/close, persistence, project/member removal and explicit access elevation; route tests use disposable real Git repositories.
- `tests/queue.test.mjs` and `tests/project-delivery.test.mjs`: native instructions on turn/queue defaults, unchanged Steer and prepared publication rejected after access changes. Together with the store/routes checks: 17 focused cases.
- `tests/collaboration-spaces.browser.mjs`: actual Hub/auth/space routes with disposable owner/member accounts, simulated native Codex RPC only; WebKit phone/tablet create/invite/accept, ordinary Project popup return, checkout binding, access request/approval, own-project add/remove and same native thread IDs after switching modes and leaving. Wizard geometry is checked at four widths in all themes, including constrained keyboard height. No production test chats or member installations are created.
- Linux TypeScript checks and frontend build. Broad unrelated GPT/installer suites are intentionally outside this pass.
