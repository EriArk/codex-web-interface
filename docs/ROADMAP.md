# Roadmap

## Current owner-approved sequence (2026-09-23)

Latest owner choice: first optimize GPT history/Results, then Brainstorm. [Incremental Hub/browser history and Results](GPT_INCREMENTAL_HISTORY.md) are implemented and verified; native canonical graph ingestion remains unchanged and #188 is not declared fully closed. The confirmed **Очень высокое (`xhigh`)** Brainstorm stage now implements rooms, board/chat, private room GPT, bounded voice and snapshot-to-project handoff; see [scope, recovery and verification](BRAINSTORM.md). Physical-device acceptance remains pending. The focused usability follow-up fixes cross-device Project wizard recovery and voice cancellation/participant turnover. Physical-device acceptance remains separate. Board organization now includes named groups, directed idea links, persistent local search/filtering and exact target navigation. The owner-requested correction adds direct touch/mouse positioning, drag/tap connections and drawing surfaces that keep their gestures separate from scrolling. Physical-device acceptance of these gestures remains pending. The [24 September backlog review](BACKLOG_REVIEW_2026-09-24.md) is complete: the catalog has 64 open issues, many covering implemented or partial foundations. The approved **Prepare for Codex (#201)** stage now provides reviewed documentation/reference packages, exact file collision choices, isolated GitHub branch/commit/PR receipts, reused Issue Drawer publication and an explicit private Codex plan handoff; see [preparation flow and limits](PROJECT_PREPARATION.md). The next proposed stage is independent messaging plus Result sharing (#202/#213), **Высокое (`high`)**. Wait for the owner's continuation before starting it. Further access downgrade/removal work is deferred. The historical sequence below describes completed preceding stages, not a request to restart them.

Current follow-up: the unified file workspace and technical viewers (#167/#184) are implemented with [format limits and verification](FILE_VIEWERS.md). File management and the CodeMirror editor already exist; this pass adds shared full viewers and correct Git-index file opening. Physical iPhone/iPad and broader owner-DXF acceptance remain separate from browser fixtures. Deployment status is tracked by the guarded release, not this source checklist.

The viewer/editor flow now includes non-writing draft preview/download and close/conflict/line-ending recovery. Multi-file uploads add progress/cancellation, explicit collision choices and durable recovery. Multiple selection and reviewed batch copy/move/delete retain per-entry receipts and partial progress. The complete follow-up adds exact-version copy/move replacement and private ZIP downloads of selected files/folders with durable recovery, delivered together with the Hub/Windows inline probe changes. See [file editor flow](FILE_EDITOR.md). Keep connected functionality and its verification in one stage/release. The owner deferred manual testing until later; implementation and focused automated checks continue without claiming physical acceptance. There is still no user-facing file converter.

This section supersedes earlier priority lists and pending-acceptance statements below. The owner confirmed the sequence after the 22 September issue updates. Before each substantial session, recommend a reasoning level and wait for the owner's explicit confirmation that it is set; do not start the next stage automatically.

1. **Close the existing tails.** Roadmap alignment and [draft review](FILES_DRAFT_REVIEW_2026-09-23.md) are complete. The following implementation session adds the writable Files/editor with focused verification: [behavior, recovery and limits](FILE_EDITOR.md). Keep installed status separate from source completion and the guarded release queue.
2. **Activity Timeline, first useful slice (#218 + necessary #197 integration).** Implemented: themed Space Activity window, default-branch commits, recent PRs/Issues, exact authorized GitHub links, bounded commit grouping and project/GitHub-author filters. Reuses membership and the viewer's machine-local GitHub worker. [Scope, checks and limits](SPACE_ACTIVITY.md). Full #218 remains open for the following stages; installation follows the guarded release queue.
3. **Discuss with Project GPT (#200).** Implemented: selected event/group opens the existing private Project GPT with bounded authorized GitHub evidence, a removable context chip, preserved draft and ordinary explicit send. Frozen context and durable receipts protect lost acknowledgements. [Scope and verification](SPACE_ACTIVITY.md#discuss-in-project-gpt). Installation remains separately guarded.
4. **Reactions, replies and attention (#218/#205).** Implemented: four quiet local reactions, exact-source short discussions, explicit recipient/reply routing to Notifications, private drafts and durable retry receipts. Current native repository access gates all content. [Scope and installed Windows helper correction](SPACE_ACTIVITY.md#local-discussion-and-attention). Ordinary activity does not flood the bell; release installation remains separately guarded.
5. **Intake and Issue Drawer (#210/#211).** The minimal common conversation binding model (#209), Project GPT integration, persistent read-only Project Intake and private Issue Drawer are implemented: [bindings](CONVERSATION_BINDINGS.md), [Intake](PROJECT_INTAKE.md), [reviewed multi-repository publication, receipts and recipient routing](ISSUE_DRAWER.md). Integrated acceptance covers the entire two-user browser chain, lost publication acknowledgements, recipient privacy and read-only analysis. It found and fixes missing collection from freshly completed GPT sends, including exact source continuity for file links. Installed owner-side reads and Windows helper parity are verified. Live participant publication and physical-device acceptance remain separate; no real Issues were published by development tests. This does not complete all remaining roles in #209. The fix's installation is separately guarded. Next is ordinary usage acceptance and concrete usability corrections; recommend **Среднее (`medium`)** for focused polish and wait for owner confirmation before the next implementation session.

First collaboration outcome: a friend publishes a change, the owner sees it in the Space, opens the exact commit/PR and discusses the impact in Project GPT without copying context manually. Global Assistant and scheduled messages remain later stages. The Brainstorm baseline is described above.

Current baseline:

- The owner confirmed real two-user Collaboration Space and participant checkout use on 22 September in #215/#195/#198. This is owner-reported live evidence, separate from automated fixture tests. Do not repeat initial friend onboarding or rebuild working copy provisioning. #215 retains concrete polish/edge cases; #198 retains provenance/sync/conflict/test-environment work.
- #196 and automatic Work Reports #199 are superseded. #218 replaces the latter; ordinary user-created Reports remain supported.
- Latest read-only deployment verification on 24 September confirms engine `ed675e9` installed, including Brainstorm touch corrections. The earlier `dab5060` installation was verified on 23 September. The previous installed Doctor and owner-side Activity/GitHub/Project GPT/Intake reads passed; the actual Windows GitHub worker hash matches. Issue recollection after removal is installed. The follow-up separates incoming Intake drafts and aligns Activity/Intake controls under [recorded layout rules](UI_LAYOUT_RULES.md); its release remains separately guarded. Owner native GPT was last upgraded to `26.915.31945-audit-e744924`; its real models/catalog/history reads passed. The separate member native runtime was not upgraded in that pass. The [GPT audit](GPT_STABILITY_AUDIT_2026-09-23.md) records checks and limits.
- Writable Files #169 now has an integrated implementation and focused verification; the earlier unpublished draft status is historical. See [File editor](FILE_EDITOR.md) for exact scope and limitations.

## Historical implementation log

The dated entries below preserve earlier evidence and decisions. Their future-tense steps, old installation versions and pending friend-acceptance statements describe those dates, not the current work queue above.

## GPT stability pass (2026-09-23)

Owner-requested large native GPT audit: [findings, fixes, tests and limits](GPT_STABILITY_AUDIT_2026-09-23.md). Covers account-wide rate-limit cooldown, bounded canonical polling, durable paced background deletions, confirmed-delivery continuity, safe preparation recovery and mobile Remote reconnection. Keep release installation evidence separate from source verification; use the normal guarded engine/native rollout.

## Earlier priority: Collaboration Spaces (#215, 2026-09-21)

Completion block implemented: additional participant invitations in existing spaces; per-project grants remain with each Project owner, including pending invitees; recipient grants for their own Project are chosen per existing member. Optional recommendations are available during creation/invitation/acceptance, merge into personal local CODEXWEB.md exactly once, and can be edited from Space Settings. Focused disposable-account acceptance includes a third member, optional-rule opt-out, existing human chat/files/unread, private native identity, theme and keyboard geometry. The owner requested completing these features before involving the friend. Remaining: release installation and ordinary real owner/friend use with actual GitHub permissions; do not claim physical-device/native two-user acceptance from simulated transport. Brainstorm stays deferred.

Fourth block implemented in source: personal Project GPT popup from the Project overview, durable per-user/project chat binding, reuse of the existing GPT composer/history/results, current permitted collaboration metadata and optional local CODEXWEB.md preferences. The mode key is now round/matte and precedes the tabs, replacing the removed search button (latest owner correction). Next: additional participant invitations with explicit per-project grants and optional preferences during invitation acceptance, then actual owner/friend acceptance. Brainstorm remains deferred. See [current behavior and limits](COLLABORATION_SPACES.md).

Third block implemented in source: one human chat popup per space, text/links/files/images, per-participant unread and aggregated Notifications, paged live history and account-local drafts. The larger central collaboration key remains between Spaces/Brainstorm in shared mode; Brainstorm rooms themselves are deferred. Next: personal Project GPT and optional local CODEXWEB.md, with additional invitations and final real two-user acceptance still outstanding. See [current behavior](COLLABORATION_SPACES.md).

Second block implemented in source: own-project add/remove, own checkout binding, owner-controlled grants and access requests, participant removal, native Codex instructions/queue defaults and current-policy checks in existing Git delivery. UI stays within shared theme materials. Further member invitations beyond the initial pair remain follow-up work alongside the human space chat; no access to another owner's Project may be granted implicitly. See [implementation and limits](COLLABORATION_SPACES.md).

The owner selected [issue #215](https://github.com/EriArk/codex-web-interface/issues/215) as the next primary task. It supersedes the older Shared Projects/Links/Bridges UX plan below. The legacy sidebar “Общие” shortcut is removed now; the new ▼ workspace-mode switch belongs to the implementation of #215.

Reuse the existing team isolation, project, GitHub and integration services. Build a space around real Projects and users: existing native chats move in navigation without duplication, each participant keeps their own checkout, and Collaborative/Direct access is decided separately for every Project × User. GitHub remains authoritative for code, Issues and PR; no duplicate issue system or mandatory task/report workflow.

Implement in coherent stages: (1) spaces and invitation membership, consented per-project access choices, creation/acceptance wizards, personal/shared navigation and compact space cards; (2) project/member management and integration of the consented policy with existing GitHub actions and native Codex context; (3) one human chat per space with attachments and invitation/unread-only bell; (4) personal Project GPT popup and optional local CODEXWEB.md instructions, followed by the issue's real two-user acceptance. Reuse the existing Create Project popup. Do not expose internal Link/Bridge/Relay entities as the user workflow or rewrite users' AGENTS.md.

First block implemented in source: ▼ personal/shared mode, a space card list, the two creation templates, existing Project/contact selection, return from the ordinary Project wizard, invitations in the bell, acceptance using one's own Project, per-project consent choices, rename, leave/close and restoration to personal navigation. Local/native project and thread identifiers remain unchanged. One-project acceptance verifies the same GitHub repository; linked-project acceptance records the recipient's own explicit grant rather than treating the creator's request as authority. Catalog reads use Team SQLite only, never native history or machine polling.

The second block makes these agreements operational in native context and Hub Git delivery; it does not change GitHub permissions or add a shell sandbox. Additional invitations, Project GPT and optional local instructions remain next. Do not describe #215 as finished or claim real owner/friend acceptance based on disposable tests. See [implementation notes](COLLABORATION_SPACES.md).

Installer work remains deferred. This priority record does not claim #215 is implemented; the complete requirements and acceptance checklist remain in the issue.

## Owner priority correction (2026-09-21)

Preserve the remaining usage budget: pause installer/new-user bootstrap work and large new feature stages. First resolve or verify the recent user-visible defects and the updater regression, then make the existing Shared Projects workflow usable for the owner and the admitted friend. Do not rebuild the implemented Team foundation.

Current live evidence: engine `d174bfd` and owner native image `26.915.31945-fast-3ac88dd` are installed. The native post-install check hit transient `NATIVE_WINDOW_AMBIGUOUS`; subsequent checks returned healthy/send-ready GPT and three models. A disposable real send was acknowledged in 413 ms and completed with the exact expected answer in 5.55 seconds; its test chat was submitted for background deletion. One reported history loaded in 1.9 seconds. The owner will delete the other failing chat, “Оценка репозитория CodexWeb”; further diagnosis of that chat is out of scope. The Shared Projects and invitations endpoints returned 200 and empty owner lists. This proves endpoint availability, not a completed two-person collaboration acceptance.

The reported `wizard.png.json` download was the 116-byte `INVALID_IMAGE_PATH` response: saved native image paths had `/D:/` instead of `D:/`. Both affected rows were backed up and corrected on the live Hub; authenticated reads now return `200 image/png` with valid PNG bytes for `wizard.png` and `onboarding-tablet.png`. Read-time normalization for future and previously stored Windows paths is covered by a focused SSH test. The public Remote WebSocket completed the actual Guacamole handshake without desktop input. No additional error UI was added.

Updater follow-up: an unavailable existing Bridge Doctor chat must not count as an unfinished chat creation. The narrowed blocker retains active creation and uncertain send receipts; its regression test and owner-force authorization checks pass. These source fixes still need the next guarded engine release; the two image records are already repaired live.

Next bounded scope:

1. Finish the guarded release of the verified image-path and updater fixes. Do not revisit the chat the owner elected to delete. Keep checking only concrete regressions, without extra diagnostic UI or new recovery layers.
2. Exercise the existing shared-project path with disposable fixtures: create/publish a project, invitation acceptance, common task/note, assignee, independent checkout, and publication/review of a result. Fix concrete breaks and confusing navigation found in that path.
3. Prioritize a simple existing-project sharing entry point, clear personal/shared context, visible invitations and task responsibility. Add only missing steps needed for one shared task through GitHub and a reviewable result.

Defer installer consolidation, Brainstorm/voice, global AI helper, broad role-framework expansion and a large Inbox redesign. Project GPT/Intake may follow once ordinary two-person work is useful; they are not prerequisites for the first shared task.

## GPT reliability audit (2026-09-21)

Follow-up `3ac88dd` is built and queued by `codex-web-gpt-fast-3ac88dd.service`, superseding the waiting `1a4d056` engine update and retaining its Results/Remote fixes. It adds priority/coalesced native reads, shared instance-bound readiness, reduced send prechecks, completion wakeup, cache-only Results misses and bounded history-body reads with diagnostic codes. Linux build, 80 focused GPT tests (79 together plus the new stalled-body test), Chromium/WebKit cache checks and isolated production-image smoke passed. Fresh public owner doctor confirmed Codex SSH/Companion and GPT readiness with zero active/unknown GPT jobs. Production engine is still `1568870` while active Codex work prevents the idle switch. The queued post-install action checkpoints and replaces the owner's idle native runtime with `codex-web-gpt-native:26.915.31945-fast-3ac88dd`; member native-runtime rollout is separate. Do not claim either the new engine or native runtime is installed until their receipts confirm it. The two live history failures still require post-install reads.

The owner requested a full GPT performance/stability audit after slow sends and history/Results failures. Findings, evidence limits and the three implementation stages are recorded in [GPT performance audit](GPT_PERFORMANCE_AUDIT_2026-09-21.md). Prioritize send scheduling/readiness, then prompt completion reconciliation, then history/Results caching. The native supervisor heartbeat now bypasses the renderer FIFO in source, with a focused blocked-history/serialized-writer test; this audit change is not deployed. The native history timeout remains unresolved, including the newly reported second conversation.

## Results / Remote repair (2026-09-21, UI installed / engine queued)

- Remote: Guacamole adds its own query delimiter; pass the workspace binding together with width/height as connect data. This fixes team-account WebSocket rejection without removing account isolation. Disconnected status no longer says “Connecting”.
- Raster result artifacts use inline disposition, retaining authenticated reads and download controls; SVG/HTML and other files remain attachments. Safari had received a successful image response marked as a download.
- Codex Results now include Links between Images and Demos. Reuse the GPT public-Markdown parser and compact external-site popup links; normalize completed native messages and imported history, without reading tool internals.
- Focused Linux type checks, raster route/auth tests, link extraction/category tests and the actual Guacamole URL construction in Chromium/WebKit passed. Production image `1a4d056` passed isolated engine/gateway startup checks. Its web assets are installed without restarting the engine. The backend image is queued by `codex-web-media-remote-1a4d056.service`; its preflight reports active work, so raster delivery and link ingestion await the guarded idle switch from `1568870`.
- Separate live GPT incident: the owner's selected conversation graph repeatedly times out, while another conversation graph and status/model reads work. The owner confirms the affected chat opens in the normal ChatGPT app. Unsent draft remains retained; no send replay or native restart performed. Diagnosis remains open; this release does not claim to fix that native history timeout.

## Installed member release (2026-09-20)

Release `1568870` is installed on the engine and web gateway (deployment receipt: 16:45 UTC). The owner explicitly authorized interrupting running work to apply the release and begin the friend's admission. The one-use host deployment wrapper bypassed only the idle wait; production-image verification, coordinated backup, privacy admission and rollback remained intact. No permanent idle-check bypass was added to the application.

A coordinated checkpoint was created before switching. Post-install authenticated owner GPT reads returned healthy/send-ready with three models, five power choices and no active/unknown GPT jobs. Invitation-only registration is now enabled and the first member invitation has been issued privately. The original owner's login, native profile and direct LAN setup remain in place. Real friend-PC/native-account acceptance is the next step, not a completed check. These installed facts supersede the queued/registration-closed status in the historical entries below.

Friend setup instructions: [quick start](FRIEND_QUICKSTART.md).

## Independent-member work — four passes (2026-09-20)

1. **Personal native GPT:** per-user Linux client, empty profile, private login/Remote, account activation and own Hub runtime. Includes immediate local chat deletion with a durable background native queue. Implemented in the current candidate; deployment status is recorded separately from source completion.
2. **Isolation and revocation:** implemented native activation/session and provisioning-revocation fixes, with a concise administrator offboarding summary. Keep registration disabled until pass 4; live independent-account acceptance remains there.
3. **Friend PC setup:** implemented the member-only Computer → ChatGPT → Readiness flow, cross-session continuation and installer return, expired-package recovery, Windows step/identity checkpoint and post-login checks. Details and remaining infrastructure admission in [WINDOWS_ENROLLMENT.md](WINDOWS_ENROLLMENT.md).
4. **New-user acceptance:** the owner has connected the separate Hub Tailscale node; persistent identity and unchanged default/LAN routing were checked. Disposable Chromium/WebKit admission covers invitation registration, owner wizard bypass, deferred member setup, shared-project consent/materials and revocation. Shared checkout/ownership backend checks passed. Tablet navigation is slightly wider and all five shortcuts fit. The friend's actual Windows/network/native-account acceptance remains outstanding; registration stays disabled until admission. See [Hub network setup](HUB_TAILNET.md).

Pass 3 verification: Windows PowerShell 5 installer parsing, retained step/identity and native-login fixtures; five focused Hub checks; Chromium/WebKit reload/download, deferred setup across sessions, same-site installer return through login, expired packets and phone/tablet layout. Original-owner LAN configuration, legacy password/session and principal-admin protections are covered. The owner explicitly retains direct LAN SSH/Companion and never enters member enrollment; member network readiness is not a gate on the owner's existing work.

Release `1568870` contains passes 1–4 available without the friend's PC, including the owner-authority clarification, wider tablet navigation and legacy GPT deletion recovery. Built production image includes the updated Windows installer helpers; isolated image startup/private-socket/auth/public-assets checks and live owner Codex/GPT/Remote connectivity passed. The guarded `codex-web-member-1568870.service` replaces the still-waiting `21de04f` updater. The private Hub configuration now records the verified Tailnet address, with a separate prior-configuration backup; owner machines/auth remain unchanged. At this checkpoint the engine remains `b273f5e` and maintenance is `waiting`; a fresh coordinated backup precedes the eventual idle switch. This is a queued release, not an installation claim. Registration remains disabled. Real friend-PC/native-account acceptance is still outstanding.

GPT incident recovery: the running owner workspace was unblocked immediately by reconciling one confirmed legacy deletion, with a private metadata checkpoint and no replay/restart. Authenticated live reads then returned `canSend=true`, three models and five power choices. The permanent legacy-receipt migration and independent native model reads are in the queued release; see [the incident record](GPT_NATIVE_LINUX.md#legacy-delete-acknowledgement-recovery-2026-09-20).

Pass 1 evidence: focused account-binding/deletion tests, Chromium/WebKit immediate deletion with an unavailable native client, and one disposable real Linux native profile with private Remote, logged-out startup and idempotent host provisioning. No production account was copied and no large download suite was repeated.

Pass 2: native activation rechecks the initiating session and access epoch, including disable/re-enable while the operation is pending. Host provisioning uses the same epoch before promoting a profile to ready. Offboarding shows session/machine counts and the number of shared projects requiring transfer/archive, without disclosing their contents or private account credentials. Revocation preserves native login/data and uncertain receipts; it does not kill native work or remove GitHub/Tailnet access. Re-enabling requires fresh login and never restores revoked project links. Focused two-member tests cover the affected races, independent access and retained binding.

## Canvas removed from scope (2026-09-20)

The owner cancelled Canvas after evaluating its usefulness and the current native-model limitation. Remove Canvas cards, its viewer and background reads from the UI. Earlier Canvas plans and acceptance reminders below are historical and superseded; do not schedule Canvas implementation or more model probes. Ordinary downloadable files, frozen text blocks, images and HTML demos remain in scope. Native document data and low-level compatibility contracts are not deleted.

## Historical prioritization after the full issue audit (2026-09-20)

The [20 September audit](ISSUE_AUDIT_2026-09-20.md) maps all 67 open issues to implementation evidence, remaining scope and dependencies. Installed baseline: engine `b273f5e`, UI `15f50f8`, schema 28. This section supersedes the execution order and pending-installation statements in older dated sections below; those remain historical evidence, not new work orders.

Owner-approved sequence:

1. Finish everyday Results: durable text-block artifacts (#183) and the relevant explicit-preview criteria (#184). Canvas is cancelled.
2. Finish independent-member readiness: per-member native GPT (#151), remaining isolation/revocation (#150/#158), machine bootstrap and continuous setup (#152/#173). Preserve the owner's existing workflow.
3. Introduce minimal AI role bindings (#209), Project GPT (#200) and `CODEXWEB.md` (#207); then Intake/Issue Drawer/preparation (#210/#211/#201). Establish #195 ownership rules before exposing another owner's project context.
4. Complete the GitHub collaboration cycle (#195/#197/#198/#196), then reports and a minimal Inbox (#199/#205). Reuse the old Team foundation rather than implementing two competing workflows.
5. Interleave bounded personal improvements: scale (#175), message navigation (#186), writable Files (#169), Codex scheduling (#214). Engineering viewers (#167) are a separate substantial pass.
6. Communication and shared Results (#202/#213), then Brainstorm and room handoff (#203/#212/#204).
7. Global AI helper, advanced profiles, shortcuts and full help come later. Remote replacement requires a demonstrated benefit; a separate Hub installer (#11) remains deferred.

#178 is owner-observed resolved; #179 is observe-only. #188 still has an incremental-projection remainder, but installed caching must not be rebuilt. Narrow remaining acceptance gaps replace repeated broad GPT/download test passes. No GitHub issues were automatically closed by this audit. Documentation alignment (#176) continues alongside each affected feature.

### Results stage 1 implementation (2026-09-20)

Implemented Canvas cards in GPT Results → Files using the existing exact-document/version viewer; removed the separate header shortcut. Canvas metadata is read independently, coalesced and bounded per account, so it cannot hold up ordinary file results. The owner requested one retained demonstration chat before deciding whether Canvas is useful.

Completed public top-level fenced blocks now materialize exact UTF-8 `.md` artifacts on the Hub, including original line endings. Identity binds conversation, native message, block position and contents. Repeated reads reuse the same file; changed versions get another identity. Cards show a short prefix; ordinary prose and public intermediate steps do not become files. Limits: 2 MiB per block, 2,000 artifacts / up to 128 MiB per private account store. Overflow reports that the original message remains available. Metadata and files participate in normal storage inventory/backup.

Result cards separate explicit Preview from direct Download. The shared viewer supports bounded text (64 KiB), raster images (32 MiB), PDF (12 MiB) and isolated HTML/SVG (256 KiB); unsupported binary formats keep metadata and Download. The original file is never replaced by the preview prefix. Technical CAD formats (#167) remain a later stage, not a completion claim for all of #184.

Verification: exact bytes/idempotency/version identity, account isolation/revocation, Canvas metadata coalescing and exact navigation; Chromium and WebKit checks of explicit fetch/download behavior, preview failures and phone/tablet geometry in four themes. These are automated browser checks, not owner hardware acceptance. Deployment is a separate guarded engine operation with a fresh backup; this entry alone does not assert it has installed.

Release `c12e4cf` passed the production-image startup/private-socket/auth smoke and Codex connectivity preflight. Its guarded updater was queued against engine `b273f5e`; it waits for active work and creates a fresh checkpoint before switching. Do not call it installed until the deployment receipt confirms that revision. Focused lint still reports four pre-existing diagnostics in touched files; typecheck, build and focused functional checks passed.

The requested real Canvas example could not be created in the current native account: Latest and GPT-5.5 both reported no Canvas tool, and the canonical document list remained empty. The separate chat **Canvas - capability check** is retained for the owner. This is a creation-capability limitation observed in this account, not evidence that Canvas was globally removed or that old documents cannot be read. Existing-document navigation is implemented and browser-tested with fixtures; a real native Canvas-viewer acceptance remains open.

## Current GPT backlog correction (2026-09-20)

This status supersedes the older canary/pending-installation statements below. The native Linux GPT provider is in everyday owner use. Engine `b273f5e` and UI `15f50f8` were confirmed installed. Public progress/Reasoning cards, warm pinned/recent history, cached Results metadata, compact navigation and immediately restored per-user model/power choices are installed. Historical implementation notes below are evidence, not an instruction to repeat completed work.

Owner feedback and source review change the next-pass priority:

- **#178:** owner reports the large-response problem no longer occurs after the native-provider migration. Remove from active repair work; this is owner-observed resolution, not a claim of an exhaustive client memory benchmark.
- **#179:** owner reports the transient viewport problem is probably also gone. Keep as unconfirmed/observe-only unless a current reproducible case appears; do not invent a fix or run a broad investigation without one.
- **#183:** partially overlaps completed features. Code blocks already collapse/copy, generated files already appear in Results, and HTML blocks become demos. The distinct remaining requirement is automatic creation of a durable server-stored text artifact from an ordinary supported code/Markdown block, with exact source identity and direct download. That gap is implemented in the Results stage above; retain the explicit bounded-scope acceptance criteria and do not repeat the existing collapse/preview work.
- **#188:** cached-first history, background active reads and bounded per-user retention are installed. A durable incremental changed-tail projection is a separate remaining scope; an open issue does not mean those cache improvements are missing.
- **#189–193:** much of the reported loading/recovery/trackpad/provider work is implemented. Reconcile each acceptance criterion with current installed behavior before scheduling more work. Native-provider installation does not by itself prove new-member provisioning or every advanced native feature.

Before the next feature pass, use this distinction throughout the open GPT issues: installed, partially implemented with a precise remainder, owner-observed resolution, or currently reproducible defect. The open/closed flag alone is not a backlog assessment. No GitHub issue was closed by this documentation correction. The previously suggested #178 + #179 repair pass is withdrawn.

## Immediate priority — Linux ChatGPT client (#193, 2026-09-19)

The official isolated Linux client is installed and authenticated. Owner integration, native dictation and sandboxed runtime are now verified; the coordinated main-engine release is being prepared for the next safe idle point. Keep #193 open for advanced-feature parity. Preserve both profiles, existing/unknown jobs, and independent Windows Codex recovery. Current proof and installation scope: [owner admission](GPT_NATIVE_LINUX.md#owner-workspace-admission-and-dictation-2026-09-19).

Next native work after the integrated owner release: recoverable unknown-operation review, complete generated image/download support, edit/regenerate/fork, project creation, scheduled/Canvas contracts, then independent member-native provisioning. Do not call these completed merely because ordinary chat works.

Implemented and verified in the native canary:

- Shared library actions and durable read-only recovery: real disposable-chat rename/restore, archive/unarchive and pin/unpin passed through the authenticated Hub; delete and project rename preservation have focused fixture coverage. Shared mobile menus recover the exact pending action across reload in Chromium/WebKit. Native lab only; explicit review of unrecoverable/deleted-object receipts remains a release gate.

- Durable uploads through Hub jobs: real 32 MiB PDF accepted/read once by native GPT and preserved after restart. Disk-streamed documents support the 512 MiB ceiling; images use a bounded 20 MiB path. Eight-file batch guard remains separate from native account quotas. Browser-to-Hub chunks and larger Codex SFTP transfer are implemented and tested but not installed in the main engine/UI. Core GptService/shared-UI integration is now implemented and verified with a real 32 MiB PDF; production admission remains pending and the old browser connector retains its buffer guard. See [upload evidence and limits](GPT_NATIVE_LINUX.md#large-file-transport-and-native-project-foundation-2026-09-19).
- Phone trackpad/zoom, protected Remote and persistent manual-access leases.
- Supervised private inherited-pipe adapter; no debugger TCP port or published native port.
- Fresh account-bound public history, 20-message paging and exact branch/message identities.
- Native navigation, Stop and model/power selection; ordinary Chat creation with small TXT/PNG files has separate lab proof.
- Generated sandbox files/images with existing Results IDs and checksum-verified downloads.
- Existing-chat text dispatch through the Hub `gpt_jobs` schema in an isolated Store, exact native user-message UUIDs, durable intent and read-only reconciliation after lost acknowledgements/restart. No diagnostic text is appended. One real queue send and 119 native/recovery/isolation tests passed; the same message/answer and older file hashes survived native restart.
- Ordinary new Chat now uses that same queue/receipt path and native model/power checks. One real creation confirmed the exact first user message once, its answer and canonical chat ID; reopening the Hub worker and replacing the native container preserved all three. The native catalog pages by 20. Bounded exact-message lookup handles lost creation candidates without replay; its failure cases are simulated. The expanded native/recovery/isolation suite passes 128 tests.

Project-content candidate: native instructions/upload/exact-ID removal and provider-bound receipts now reach the shared project window. Linux focused tests and Chromium/WebKit 32 MiB upload/recovery/removal checks passed with a simulated native boundary. A real disposable project creation returned an unknown outcome; its receipt remains preserved and blocks native lab mutations/manual takeover. No live project mutation acceptance is claimed. Source downloads remain pending. See the latest [project evidence and blocker](GPT_NATIVE_LINUX.md#native-project-sources-implementation-and-unresolved-live-acceptance-2026-09-19).

Next coherent implementation block:

1. Resolve the unknown disposable project-creation receipt without replay; finish native project-source downloads and real-project mutation acceptance. Then complete edit/regenerate/fork, scheduled tasks/Canvas reads and dictation; complete generated-image and large downloadable-result parity. Project catalog/membership, native pins and archived catalog reads already reach the shared service.
2. Complete explicit unknown-send review/manual recovery and production capability/admission controls. Core shared `GptService`, durable send/progress/Stop, per-model presets and provider-bound outbox entries are implemented. The real web composer uploaded and sent a 32 MiB PDF once, displayed its answer and survived reload/service reopening; the supervisor still restricts sends to disposable chats. Unknown native receipts remain blocked from blind dismissal/replay. Old queued jobs retain their provider rather than being silently migrated.
3. Verify long-chat performance, host boot and per-member provisioning, then stage a reversible primary-provider switch. Main production remains unchanged until these admission gates pass.

Details, actual installed state and rollback: [GPT_NATIVE_LINUX.md](GPT_NATIVE_LINUX.md). Earlier stage findings remain in that technical record.

## Next short passes — audit of 2026-09-13

**Current UI pass:** Files and Git now have separate direct header buttons and independent wide material windows. File browsing retains inline actions on phones and adds a bounded side preview on wide clients; Git separates README from repository references. Settings stays in the sidebar footer in both modes. Codex Results now always uses the existing authorized project feed, including precise source-chat navigation. GPT currently has only a conversation Results contract: its project aggregation still needs a bounded server-side index/contract after #158, without fetching every native conversation from the browser. Writable Files remains with #169 after the same engine prerequisite. Publication evidence is recorded in `TEAM_CHECKPOINT.md`.

The current [issue and interface audit](ISSUE_AUDIT_2026-09-13.md) accounts for all 30 open and 50 closed issues, including new #176/#177. It distinguishes missing functionality from implemented work awaiting acceptance. The window series implements the shared material/window lifecycle, five-item shortcut row, independent Tasks/Notes/Plans/Reports and Files/Git windows. Remaining server contracts and functional extensions are distinguished above; installation evidence is recorded separately in the checkpoint.

Execution order: (1) shared window/material primitives and the five-item workspace shortcut row; (2) independent Tasks/Notes and Plans/Reports windows plus consistent forms; (3) separate Files/Git windows, project-only Results and exact artifact navigation #168; (4) everyday settings #171/#175/#177 and focused native #165/#166 checks; (5) finish team admission/bindings/onboarding/shared follow-through; (6) separate editor #169 and Technical Viewer #167; (7) protected server sandboxes #170; (8) final Help #174 and acceptance. Keep each step a short independently verified pass. Top-level documentation #176 is an immediate separate cleanup and stays current throughout.

2026-09-14 priority update: complete #168 and the reader-case large ZIP defect before the larger Files/editor work. Assistant references now open the exact captured file/image in Results/Preview; scoped reads reject missing or alien sources. Codex export capture/download supports 512 MiB with disk streaming and checksums, while browser previews remain bounded. This pass requires an engine release through the verified #158 guard; source completion and production installation are separate milestones.

**Release dependency:** the coordinated already-enabled-Team backup/upgrade/restore tooling for #158 is implemented and rehearsed separately from production. Every next engine release must supply its own build/admission proof and use this path; this tooling pass does not replace the live engine. Compatible web-only releases retain the independent assets path. Friend-PC admission does not gate owner-only UI polish; real independent accounts/hardware do gate team acceptance. Full acceptance details and remaining work per issue are in the audit; Gates A–E below retain their original scope.

**Next Results follow-up (owner clarification):** put GPT Canvas documents into Results as document cards, opening the existing document viewer on selection, and remove the separate Canvas header button. Retain exact chat/document identity and private access. This navigation change is distinct from full Canvas creation/editing, which remains deferred; implement it with the upcoming GPT project Results work.

**Files/Git clarification (2026-09-13):** compose broad independent tool windows, not a narrow inspector inside a larger empty dialog. Git uses repository overview and detail areas; Files uses folder navigation, a file list and selected-file content/actions. The owner also approved a read-only lock with real writable file management: create files/folders, rename, copy, move and confirmed deletion within the acting user's selected project. Relock on close/project change; preserve conflict checks and exact operation receipts. Deliver this functional extension with #169 after the #158 engine-update prerequisite; do not ship a fake unlock button ahead of backend capability.

## Current milestone — private team workspaces (approved 2026-09-13)

The personal-workspace foundation is implemented. The next pass follows [the agreed specification](TEAM_WORKSPACE.md) and [tracker #159](https://github.com/EriArk/codex-web-interface/issues/159). Initially two people use the current Hub, each with their own Windows PC and Codex/GPT/GitHub accounts. Desktop and mobile remain first-class clients.

Production was verified during the audit on engine/gateway `60b326892`, with maintenance status `installed`, healthy services and the original GPT `7f25d37` profile retained. Owner-only Team activation is enabled, login is `eriark` with the existing password, and new-member registration remains closed. `379fa17` is the preserved pre-team backup baseline. Ordinary Codex and recovery continuity remain required for every subsequent update; never connect a copied owner runtime to live native writers. Implementation, test evidence, installation and real acceptance are tracked separately.

The dated candidate-progress paragraphs below are historical development evidence, including their then-current “not installed” statements and test counts. They do not override the installed status above. Unchecked gates remain unchecked until their complete acceptance passes; deployed owner functionality alone does not satisfy independent-member acceptance.

### Gate 0 — stable checkpoint and decisions

- [x] Owner confirmed audience, first milestone, onboarding, privacy, sharing, Bridge ownership and scope.
- [x] Create protected stable checkpoint `stable-pre-team-379fa17-20260913T080408Z`: Hub data/files, selected private configuration, source bundle and exact Hub/GPT/speech/guacd images.
- [x] Verify snapshot checksums and restore into a separate directory. The live services were not replaced.
- [x] Publish current documentation/issue dependencies; preserve current production until candidate acceptance.

The approximately 2.58 GB checkpoint has 472 inventoried files plus its manifest. Native Windows repositories/Codex account history and the running ChatGPT browser profile are outside the Hub data snapshot. Preserve the original profile; any profile relocation/change requires a separate stopped-browser backup after idle verification.

### Gate A — identity and structural private-state isolation

Issues: #149, #150; initial revocation/backup foundations from #158.

- [x] Candidate: stable user identities, invitation acceptance, per-user credentials/sessions/recovery and admin/member roles. Not installed.
- [ ] Bind every personal runtime/store/artifact namespace and background operation to its owner; migrate existing state to the original owner without losing identities or receipts.
- [ ] Deny cross-user routes, search, events, media, device/Remote tickets and private-source navigation, including direct ID/URL attempts.
- [ ] Two-user tests and migration/restore of a copied production snapshot pass before a real second user is admitted.

Candidate foundation (2026-09-13): one authentication router dispatches the existing personal APIs into separate private SQLite/artifact runtimes through Unix sockets. The original owner's database and native IDs stay in place; new users start without any machine or GPT fallback. Account-bound browser drafts, session revocation, access audit, role changes, whole-installation backup/restore and all-user maintenance checks are implemented. This is a development checkpoint, not permission to admit real users or replace production.

Evidence so far: the full Linux suite passed 418 tests, followed by 10 focused isolation/recovery tests after the final role and artifact checks. Chromium and WebKit passed registration/account switching/private drafts and 24 theme/viewport combinations in a network-isolated test container. A metadata-only migration of copied stable state preserved all 61 private tables and 207,066 records. It opened no native connection. The remaining gate audit includes background-operation revocation and all private capability families; real independent native accounts and friend-PC acceptance belong to Gate B. See [verification](VERIFICATION.md).

### Gate B — friend's complete private workspace

Issues: #151, #6, #37, #152. Depends on Gate A.

- [ ] Isolate Codex/GPT/GitHub, browser profiles, queues, quotas, dictation, speech artifacts, preferences and notifications.
- [ ] Enforce selected roots; support independently configured LAN/Tailnet execution machines and per-machine failure handling.
- [ ] Invitation → Windows bootstrap/master → candidate → verified admin pairing → repairable doctor. No public Windows listener.
- [ ] Test complete private Codex/GPT workflows on desktop/mobile; the friend uses their own native identities and PC.

This is the first usable milestone, followed by both collaboration scenarios in the same implementation pass.

Root policy and the initial Windows enrollment master are implemented in the candidate. Optional enrolled roots constrain directory browsing, native discovery, creation, execution CWDs, Files/Git and previews; canonical checks reject links/junctions. Legacy owner configurations retain their folder workflow. New machines can discover projects before a first project exists.

The member downloads one ZIP and opens `Connect.cmd`: a Windows wizard installs missing prerequisites, guides native sign-ins and folder selection, sets separate restricted command/terminal keys and reports a pinned computer identity. Exact retries retain keys and the submitted report. The administrator verifies identity, then the member activates only their idle personal runtime. See [the connection guide](WINDOWS_ENROLLMENT.md). Linux passed 429 tests; Chromium/WebKit covered enrollment download/status and four themes at phone/tablet/PC widths; Windows PS5 parsing and harmless offscreen controls/native-status checks passed. No real friend-PC installation, Tailnet admission, Remote or independent GPT provisioning has been accepted yet. Production is unchanged.

Additional Gate B candidate progress: independent GPT profiles, account-bound login/Remote routing and a host provisioning service are implemented. Real disposable Docker checks passed private ingress, public-only egress, no direct LAN/Tailnet route and a dedicated Guacamole handshake. The original owner's profile remains untouched. See [GPT setup and remaining profile recovery work](TEAM_GPT.md). No friend native login has been tested.

Stopped GPT profile backup and isolated restore are now implemented and verified with two-user fixtures and a real disposable Chromium profile. The archive preserves owner mappings and connector identities; live mounts and concurrent provisioning are rejected using OS locks. Restored profiles remain staged with execution blocked. Full suite: 442 passed. Final readmission/activation of restored data remains part of Gate E.

Windows Remote has also been added to the candidate enrollment wizard: optional private VNC installation, pinned/signed MSI, Hub-only firewall scope, separate generated connection credential and admin verification without screen access. Existing desktop providers/settings are preserved. See [connection details](WINDOWS_ENROLLMENT.md); real friend installation remains outstanding.

### Gate C — shared project and independent workstations

Issues: #153, #154, #157. Depends on Gate B; shared-state schema/permission design starts in Gate A.

- [ ] Viewer/Collaborator/Owner membership and explicit sharing of selected existing materials.
- [ ] Per-user checkout, Current/Previous Chats, Git identity and private drafts; no implicit machine or source-chat access.
- [ ] New shared-project Notes/Tasks/Plans/Reports are visibly shared by default; personal capture stays available.
- [ ] Authorship, assignments, revision conflicts, duplicate-work detection, relevant activity/notifications and shared evidence.
- [ ] Two independent checkouts can work simultaneously; private sources remain private after publication.

Gate C candidate checkpoint (2026-09-13): logical projects have one owner, consent-based membership, owner transfer, revocable invitations and independent checkout bindings. Typed common Notes/Tasks/Core/Plans/Reports/Reviews/Results retain authorship and forty content revisions. Selected personal publication has a complete preview and exact receipt; source links remain private. Navigation, scoped workspace modules and Quick Capture expose common-by-default versus personal access. Assignment-bound Plan execution now prepares a frozen common Core/Plan for the assignee's own Current Chat, confirms explicitly and waits in a permission-aware Hub queue. Selected private Reviews and saved Codex/GPT files can be published as immutable checked copies, included in shared backup/restore. No production change has been made. Shared Report generation/audience, relevant activity notifications and the final workflow/revocation audit remain; the gate is not complete.

Verification: latest full Linux suite passed 486 tests, including two actual independent local Git directories, simulated native Work turns, queue/commit revocation races, short revoke/re-add cycles, unknown acknowledgements, selected file integrity and backup recovery. Chromium and WebKit exercised real two-user HTTP state, conflict drafts, incomplete Plan drafts, shared capture, explicit publication/download, queued Plan/cancel, contact selection and Link/consultation consent across 48 theme/viewport combinations. Native accounts and friend hardware are still fixture boundaries; this does not constitute friend-PC acceptance.

Additional Gate C candidate work: common-ledger Report drafts now have frozen periods, explicit edited publication, private preparation history, atomic checkpoints and exact acknowledgement recovery. Personal model-written Reports retain their existing explicit publication path. Tasks prepare one normal assignee-owned Plan per source revision with common backlinks; creation does not send to Codex. Mine/author/assignee/active-completed filters apply before pagination, and unavailable material deep links now show an error. Shared Codex rotation includes the agreed common Core and a bounded common-material snapshot alongside only the acting user's private handoff. Access, checkout, settings and Core are checked again before native creation/bootstrap; another member's Current never changes. See [workflow and bounds](TEAM_REPORTS.md). Shared Plan reconciliation, relevant notifications and final permission/recovery acceptance are still outstanding.

### Owner-requested end of this long pass (2026-09-13)

The owner explicitly requested wrapping up after roadmap/check verification and installing only a checked stage, with remaining work split into short passes. Do not interpret the original integrated-pass request as permission to continue indefinitely. [The current checkpoint](TEAM_CHECKPOINT.md) records implemented versus still-open work, the release boundary and newly filed #170–175. The owner then requested activating the prepared modules and login now: the replacement stage is first-owner team activation with new-member registration paused. Gates A–E are not all accepted; owner-only activation is not a completed multi-user rollout.

### Gate D — related projects, Bridges and GitHub

Issues: #160, #156, #155. Depends on private boundaries and the required shared-state subset of Gate C.

- [ ] Mutually accepted cross-user Links with explicit direction, target participant and bounded automatic consultation permission.
- [ ] Bridges have a chosen owning project; that project's owner provides the coordinator account/machine. Other projects answer with their own authorized accounts.
- [ ] Durable goal/handoffs/questions/decisions, bounded consultation and explicit target implementation actions.
- [ ] Correct GitHub identity for repository invitation, Issues/comments and PR coordination; no automatic full transcript mirroring or merge.
- [ ] Exercise both shared-repository development and coordination between private related projects.

Gate D candidate progress: contact-book selection and mutually accepted Links are implemented. The recipient chooses their own project; private project lists remain inaccessible. Read-only consultations use the correct project owner's runtime, explicit per-exchange consent or prior Link automation consent, a 1–10 round bound, early resolution with no extra message, stop, private source navigation, a per-root limit and no replay after unknown submission. Work proposals save a target-assigned shared Plan only after an explicit action. Disabling an account or transferring project ownership revokes its Links. See [Links and consultations](TEAM_LINKS.md).

Bridge implementation now includes independent goal/criteria rooms, explicit linked-owner invitations, attributed checkpoints, selected private finding previews, owner-only immutable source copies and target-assigned Plan proposals. The project owner reviews and confirms a bound coordinator request; one shared 1–10 request budget includes both coordinator and one-hop linked replies. Stop, revocation, early resolution, native unknown receipts and explicit new-owner adoption are implemented. Owner-only idle editing and history-wide filters are available. Ten backend Bridge fixtures and both browser engines passed, including two-user publication with a lost acknowledgement and retained private source. Full Linux run: 495 passed, then 19 focused tests after the last changes. See [Bridge usage](TEAM_BRIDGES.md). Typed GitHub coordination is now implemented in the candidate: own-machine identity/access checks, contact-bound repository invitations/removal, Issues/comments/state, exact-SHA PR coordination, immutable shared links and explicit assigned-Plan creation. Full Linux suite: 512 passed; Chromium/WebKit passed two-user acknowledgement recovery and 16 themed phone/tablet combinations. See [GitHub usage and limits](TEAM_GITHUB.md). Matching helper installation and real friend-account acceptance are pending. Remaining Gate C/E work is unfinished.

### Gate E — lifecycle and release acceptance

Issue #158, physical acceptance #10; foundations already required in Gate A.

- [ ] Revoke member/project/link access during idle and active/unknown work; preserve receipts and historical authorship.
- [ ] Test all personal stores plus shared state through backup/restore; reject missing ownership and stale capabilities.
- [ ] Real friend enrollment, independent accounts, shared checkout, linked project consultation, revoke and re-add.
- [ ] Linux builds, backend tests and Chromium/WebKit checks pass; record physical PC/mobile outcomes separately.
- [ ] Candidate release passes admission and rollback checks. Only then arrange cutover without losing current work or newer user writes.

### Deferred and separate

- #11: distributing a complete separate Hub installation. Friend-PC enrollment into this Hub is in scope.
- #14: historical stabilization/distribution tracker; ongoing personal reliability is relevant, old unchecked completed modules are not new backlog.
- Full Canvas creation/editing, cross-chat GPT search, extra native integrations and full voice conversation are outside this pass.
- GitHub Actions are excluded. Use Linux verification and preserve the owner's everyday hardware feedback loop.

New defects observed during this pass: #165 native Plan → Implement transition, and #166 native Computer Use pipe/lifecycle diagnosis. These are additional focused work; do not replace Computer Use with Preview or infer support from the existence of an executable.

The candidate now implements #165's native Plan → Work transition with exact structured-plan validation, Current Chat/settings binding, queue/ownership guards and a durable receipt. Native desktop inspection established the actual follow-up contract; five backend regressions and Chromium/WebKit lost-acknowledgement/reload/draft scenarios passed. Full Linux suite: 438 passed. See [native contract](NATIVE_PLAN.md). #166's [read-only diagnosis](COMPUTER_USE_DIAGNOSIS.md) identifies the desktop-owned pipe lifecycle missing from standalone Companion; no global settings or desktop lifecycle was changed. These additions remain isolated from production. Smaller-tablet viewport coverage is being added after the owner's clarification.

## Historical initial roadmap

The original phases below describe the path to the existing personal product. They are retained as history; they do not override the current gates or reclassify implemented modules as future work.

## Phase 0 — Repository scaffold

Goal: create a boring, debuggable base.

Deliverables:

- TypeScript workspace;
- `apps/web` React PWA;
- `apps/hub` Fastify server;
- shared types package;
- lint/typecheck/test scripts;
- SQLite migration/storage layer;
- production config loader;
- structured logging with secret redaction;
- development README/scripts;
- responsive shell foundation that can support wide, compact-tablet, and mobile layout modes without duplicating product components.

Acceptance:

- `pnpm install` (or chosen workspace equivalent) works from repo root;
- one command starts web + Hub in development;
- Hub serves health endpoint;
- PWA shell loads on iPad/Safari and iPhone/Safari;
- database initializes locally;
- no secrets committed.

## Phase 1 — Auth + project/machine registry

Goal: secure the public shell and model the target environment.

Deliverables:

- single-user login/password;
- secure session cookie;
- login rate limiting;
- authenticated WebSocket handshake;
- machine config/model;
- project config/model;
- project list UI;
- basic machine online check.

Initial configured machine types:

- local Linux Hub;
- remote Windows over SSH.

Acceptance:

- unauthenticated browser cannot access project data or WebSocket;
- user can log in from iPad and iPhone;
- `Case Maker`-style project can be mapped to Windows machine + Windows path;
- Hub can report remote Windows online/offline through SSH.

## Phase 2 — Remote Windows Codex proof

Goal: prove the most important architecture path before polishing UI.

Deliverables:

- system OpenSSH transport;
- Windows Codex command probing/resolution;
- remote process launcher;
- App Server stdio framing;
- initialize handshake;
- minimal normalized Hub event contract;
- start a Codex thread/turn in configured project;
- stream response to browser;
- clean teardown/cancellation.

Acceptance:

From browser/PWA:

1. open a Windows-backed project;
2. start a new thread;
3. ask Codex to inspect a harmless project file;
4. see streaming assistant output;
5. no Codex network port is open on Windows;
6. Windows repo/toolchain remains the execution environment.

This phase is the architecture checkpoint. Do not move on if it is flaky.

## Phase 3 — Real Codex workspace behavior

Goal: make the chat usable as an everyday client.

Deliverables:

- project/thread mappings in SQLite;
- thread list and new thread;
- resume previously mapped thread;
- active turn state;
- interrupt/stop;
- approvals Allow/Deny;
- browser reconnect without killing active turn;
- App Server error/restart handling;
- local Linux Codex backend through same internal API.

Acceptance:

- close/reload PWA during an active/idle session and recover cleanly;
- pending/active state is understandable;
- remote and local projects look the same in UI;
- one App Server failure does not crash Hub.

## Phase 4 — Results feed

Goal: separate useful output from conversation.

Deliverables:

- Result database model;
- authenticated artifact storage/download route;
- Results feed usable both as a right pane and full-width mobile view;
- result-to-turn links;
- image viewer;
- file-change summary card;
- build/check card for recognized outcomes;
- generated artifact/file card;
- Activity view for verbose tool/command events.

Acceptance:

- normal chat is not flooded by technical output;
- user can tap a result and jump back to originating turn;
- Results scroll state is independent from Chat;
- artifacts remain private behind authentication;
- image/result cards are usable at iPhone width without horizontal page scrolling.

## Phase 5 — Remote Desktop

Goal: provide occasional manual control without leaving the workspace.

Deliverables:

- `RemoteProvider` abstraction;
- Guacamole/`guacd` integration;
- RDP provider configuration;
- VNC-compatible fallback path/config shape;
- right-pane Remote mode for wide layouts;
- full-workspace Remote mode for mobile;
- fullscreen Remote;
- iPad/iPhone touch/trackpad modes as supported;
- touch toolbar for keyboard/special keys;
- Remote availability indicator.

Acceptance:

- from active project, tap Remote and reach the configured Windows desktop;
- browser never connects directly to Windows;
- Remote port is restricted to Hub on LAN;
- returning to Results/Chat preserves state;
- Codex session is independent from Remote connect/disconnect;
- iPhone can perform a brief useful Remote interaction without needing a desktop-sized side-by-side layout.

## Phase 6 — Apple mobile/PWA polish

Goal: make the application feel deliberately designed on both the reference iPad and occasional iPhone client.

### 6A — 13-inch iPad wide workspace

Deliverables:

- three-pane landscape layout tuned on 13-inch iPad;
- collapsible nav;
- resizable right pane;
- independent scroll regions;
- software keyboard/`visualViewport` fixes;
- safe-area handling;
- reconnect after iPad background/suspend;
- portrait compact/tabbed layout;
- useful hardware keyboard shortcuts.

Acceptance:

- no critical hover-only action;
- composer never hides behind software keyboard;
- interface works comfortably by touch only;
- app recovers after being backgrounded;
- all primary controls remain readable/tappable at default iPad scaling.

### 6B — iPhone mobile shell

Follow `docs/MOBILE.md`.

Deliverables:

- portrait-first single-view workspace;
- `Chat / Results / Remote` mobile navigation;
- project/thread sheet or drawer;
- Files/Activity secondary mobile entry points;
- mobile composer and iOS keyboard handling;
- result feed/image viewer tuned for narrow width;
- full-width Remote with compact special-key toolbar;
- safe-area handling for modern iPhones;
- normal Safari support;
- standalone Add-to-Home-Screen PWA support;
- rotation handling;
- reconnect/preservation after iOS background suspension;
- theme decoration reduction rules for mobile.

Acceptance:

On a real iPhone the user can:

1. log in;
2. choose project/thread;
3. send and stream a Codex turn;
4. approve/deny and interrupt;
5. inspect Results/screenshots/artifacts;
6. jump between a result and its chat turn;
7. open Remote and briefly control Windows;
8. background/reopen the app and continue;
9. do all core actions using touch only.

### Shared PWA deliverables

- installable PWA manifest/icons;
- safe startup/reconnect semantics;
- preserved active project/thread/view preferences;
- no reliance on a WebSocket surviving backgrounding.

## Phase 7 — Themes

Goal: implement the visual identity without forking behavior.

Deliverables:

- semantic theme-token system;
- Organizer theme;
- CRT Green theme with curved display effect;
- Hi-Tech 2000s theme;
- theme selector/persistence;
- reduced CRT effects if needed for performance/readability;
- responsive decoration rules so mobile keeps theme identity without wasting screen area.

Acceptance:

- same functionality/component behavior across themes and client sizes;
- theme switch does not reset workspace state;
- CRT text remains crisp enough for long work sessions;
- references in `references/` are recognizably represented without pixel-copying them;
- iPhone themes remain usable and do not become miniature framed desktop mockups.

## Phase 8 — Personal workspace modules

Goal: begin growing beyond Codex chat.

Add gradually, based on actual use. Each module must have a wide and mobile presentation rather than being desktop-only.

### Notes

- global notes;
- project notes;
- pin/link note to thread/result;
- lightweight Markdown;
- mobile full-width note list/editor.

### Tasks

- global/project tasks;
- status and priority;
- link task to project/thread;
- global human reminder list with single-tap project filters;
- compact mobile task list.

### Machines

- online/last-seen;
- CPU/RAM/disk summary where useful;
- Codex availability/version;
- Remote availability;
- connection diagnostics;
- mobile status cards rather than a dense dashboard.

### Files/Git

- changed files;
- Git status/branch;
- lightweight read-only file preview;
- diff view;
- generated artifact access;
- narrow-width navigation/readability.

Acceptance is defined per module. Do not implement all modules in one release.

## Phase 9 — Optional Windows Companion

Goal: bridge the Windows interactive GUI session only if real usage proves it valuable.

Potential capabilities:

- launch configured GUI app into logged-in user desktop;
- capture window/desktop screenshot into Results;
- enumerate selected visible apps;
- project-specific `Launch/Preview` actions.

Constraints:

- local-only user-session component;
- no public TCP listener;
- no replacement for SSH/Codex transport;
- narrow allowlisted operations;
- secure local IPC.

This phase is explicitly optional.

## Phase 10 — Additional machines / Tailnet

Goal: support devices outside the Hub's physical LAN without redesigning the app.

- Tailscale addresses/SSH aliases;
- optional additional Windows/Linux machines;
- transport preference/health;
- project remains mapped to one active execution machine at a time.

Do not implement custom NAT traversal.

# MVP definition

The practical MVP is Phases 0-6 with at least a basic Results feed and working Remote provider. iPhone support is part of the MVP client experience, not Phase 8+ platform expansion.

The MVP is successful when the user can:

- open the installed PWA on the 13-inch iPad;
- log in securely;
- choose a configured project;
- see/resume its web-managed Codex threads;
- run Codex on the Windows PC through Hub -> SSH -> stdio;
- approve/deny and interrupt turns;
- close/reopen the app without losing the workflow;
- inspect useful results separately from chat;
- open the Windows Remote desktop in the right pane when needed;
- optionally use a server-local Codex project through the same UI;
- do all of this with only the Linux Hub exposed publicly;
- perform the same core Codex/Results/brief-Remote workflow from iPhone using the dedicated mobile layout.

## Initial implementation checkpoint (2026-09-06)

Scaffold, authentication, real Windows Codex conversation, persistence/reconnect/approvals, basic Results, VNC Remote, mobile/wide shells and four themes are implemented. Model/mode/effort controls and file/image attachments were added to the first release at the owner's request. The local-only Companion was brought forward under D17 to resolve the real Windows Session 0 failure.

Automated Chromium/WebKit and real Windows checks are recorded in VERIFICATION.md. Physical iPhone/iPad acceptance is still required. Native Windows project and conversation discovery, legacy history import and web project creation are also implemented. Arbitrary generated-artifact collection, Notes, a general Files/Git browser and additional machines are later work. The local Linux transport exists but no separate authenticated Linux Codex is configured in the current deployment.
