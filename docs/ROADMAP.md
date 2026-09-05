# Roadmap

The project should grow in layers. Do not build the full personal platform before the core remote Codex workflow is proven.

The 13-inch iPad is the reference wide workspace, but iPhone is a first-class client and must not be deferred into an undefined future responsive pass.

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

### Plan / Tasks

- global/project tasks;
- status and priority;
- link task to project/thread;
- simple plan view, not a project-management suite;
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

Scaffold, authentication, real Windows Codex conversation, persistence/reconnect/approvals, basic Results, VNC Remote, mobile/wide shells and three themes are implemented. Model/mode/effort controls and file/image attachments were added to the first release at the owner's request. The local-only Companion was brought forward under D17 to resolve the real Windows Session 0 failure.

Automated Chromium/WebKit and real Windows checks are recorded in VERIFICATION.md. Physical iPhone/iPad acceptance is still required. Arbitrary generated-artifact collection, Notes, a general Files/Git browser, external-thread import and additional machines are later work. The local Linux transport exists but no separate authenticated Linux Codex is configured in the current deployment.
