# Roadmap

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
