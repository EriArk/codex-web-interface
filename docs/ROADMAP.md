# Roadmap

The project should grow in layers. Do not build the full personal platform before the core remote Codex workflow is proven.

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
- development README/scripts.

Acceptance:

- `pnpm install` (or chosen workspace equivalent) works from repo root;
- one command starts web + Hub in development;
- Hub serves health endpoint;
- PWA shell loads on iPad/Safari;
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
- user can log in from iPad;
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

From iPad/browser:

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
- right-side Results feed;
- result-to-turn links;
- image viewer;
- file-change summary card;
- build/check card for recognized outcomes;
- generated artifact/file card;
- Activity view for verbose tool/command events.

Acceptance:

- normal chat is not flooded by technical output;
- user can tap a result and jump back to originating turn;
- long Results feed scrolls independently from Chat;
- artifacts remain private behind authentication.

## Phase 5 — Remote Desktop

Goal: provide occasional manual control without leaving the workspace.

Deliverables:

- `RemoteProvider` abstraction;
- Guacamole/`guacd` integration;
- RDP provider configuration;
- VNC-compatible fallback path/config shape;
- right-pane Remote mode;
- fullscreen Remote;
- iPad touch/trackpad modes as supported;
- touch toolbar for keyboard/special keys;
- Remote availability indicator.

Acceptance:

- from active project, tap Remote and reach the configured Windows desktop;
- browser never connects directly to Windows;
- Remote port is restricted to Hub on LAN;
- returning to Results/Chat preserves state;
- Codex session is independent from Remote connect/disconnect.

## Phase 6 — iPad/PWA polish

Goal: make it feel like a dedicated iPad application.

Deliverables:

- three-pane landscape layout tuned on 13-inch iPad;
- collapsible nav;
- resizable right pane;
- independent scroll regions;
- software keyboard/`visualViewport` fixes;
- safe-area handling;
- installable PWA manifest/icons;
- reconnect after iPad background/suspend;
- portrait tabbed layout;
- useful hardware keyboard shortcuts.

Acceptance:

- no critical hover-only action;
- composer never hides behind software keyboard;
- interface works comfortably by touch only;
- app recovers after being backgrounded;
- all primary controls remain readable/tappable at default iPad scaling.

## Phase 7 — Themes

Goal: implement the visual identity without forking behavior.

Deliverables:

- semantic theme-token system;
- Organizer theme;
- CRT Green theme with curved display effect;
- Hi-Tech 2000s theme;
- theme selector/persistence;
- reduced CRT effects if needed for performance/readability.

Acceptance:

- same functionality/markup behavior across themes;
- theme switch does not reset workspace state;
- CRT text remains crisp enough for long work sessions;
- references in `references/` are recognizably represented without pixel-copying them.

## Phase 8 — Personal workspace modules

Goal: begin growing beyond Codex chat.

Add gradually, based on actual use:

### Notes

- global notes;
- project notes;
- pin/link note to thread/result;
- lightweight Markdown.

### Plan / Tasks

- global/project tasks;
- status and priority;
- link task to project/thread;
- simple plan view, not a project-management suite.

### Machines

- online/last-seen;
- CPU/RAM/disk summary where useful;
- Codex availability/version;
- Remote availability;
- connection diagnostics.

### Files/Git

- changed files;
- Git status/branch;
- lightweight read-only file preview;
- diff view;
- generated artifact access.

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

The practical MVP is Phases 0-6 with at least a basic Results feed and working Remote provider.

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
- do all of this with only the Linux Hub exposed publicly.
