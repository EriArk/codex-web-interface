# AGENTS.md

This repository is intended to be implemented primarily with Codex. Read this file before changing architecture or starting a large feature.

## Product in one sentence

Build a **private, iPad-first PWA with first-class iPhone support** that lets one user work with Codex running either on a Windows PC in the same LAN as the Linux Hub or locally on the Hub, while keeping execution machines off the public Internet.

## Source-of-truth order

When documents disagree, use this order:

1. `AGENTS.md`
2. `docs/DECISIONS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/UX.md`, `docs/MOBILE.md`, `docs/SECURITY.md`, `docs/CODEX_INTEGRATION.md`, `docs/REMOTE_DESKTOP.md`
5. `docs/ROADMAP.md`
6. `README.md`
7. visual references

Do not silently change a fixed decision. If a constraint is blocking implementation, document the conflict and propose the smallest compatible change.

## Fixed constraints

- Primary wide client: **13-inch iPad in landscape, standalone PWA**.
- First-class mobile client: **iPhone**, primarily portrait, with a dedicated mobile shell rather than compressed desktop columns.
- Primary execution machine for v1: **native Windows PC on the same LAN as the Linux server**.
- Public machine: **Linux Hub only**.
- Windows PC must not expose Codex, Remote Desktop, a custom web server, or a custom agent to the Internet.
- Remote Codex transport for v1: **Hub -> system OpenSSH -> Windows -> `codex app-server` over stdio**.
- Do not open a Codex TCP/WebSocket listener on the Windows PC for the main flow.
- Browser talks only to the Hub API. Never expose raw Codex App Server directly to the browser.
- Also support a local Linux backend that spawns Codex on the Hub itself.
- Remote Desktop is secondary/manual. Prefer RDP through Guacamole when available; keep the provider abstract.
- Single-user product. Authentication is still mandatory.
- Project is the primary UX entity; machine is infrastructure behind it.
- One functional UI, multiple themes. Do not create separate implementations per theme or per device.

## Important Windows rule

OpenSSH-spawned processes on Windows must be treated as **non-interactive** with respect to the visible desktop.

Do **not** assume:

- `ssh windows-pc notepad.exe` creates a window visible in the user's desktop;
- a GUI app started by Codex over the SSH-hosted App Server will be visible in an RDP session;
- desktop screenshots can be captured reliably from the SSH session.

For v1, Codex over SSH is for code/files/build/test/CLI work. Manual GUI inspection is done through the Remote pane/view.

A future optional **Windows Companion** may bridge into the logged-in interactive session. If implemented, it must be local-only (for example a user-session process plus named-pipe IPC) and must not listen on a network port.

## Preferred repository shape

Start simple. A likely structure is:

```text
apps/
  web/        # React PWA
  hub/        # Fastify server
packages/
  shared/     # shared types/contracts
  codex/      # Codex protocol adapter
  machines/   # local/SSH machine transports
  ui/         # optional shared UI primitives/theme tokens
docs/
references/
data/         # runtime only, gitignored
```

Use a TypeScript workspace. Avoid adding orchestration layers unless there is a demonstrated need.

## Core abstractions

Keep these boundaries explicit from the beginning:

```text
MachineTransport
  - LocalMachineTransport
  - SshWindowsTransport
  - SshLinuxTransport (later)

CodexBackend
  - LocalCodexBackend
  - RemoteCodexBackend

RemoteProvider
  - GuacamoleRdpProvider
  - GuacamoleVncProvider / fallback

ResultStore
  - metadata in SQLite
  - binary artifacts on Hub filesystem
```

The frontend should consume a stable Hub contract, not App Server JSON directly.

## Remote Codex process rules

- Launch the Windows App Server through SSH and stdio.
- Treat stdout as protocol-only. Send diagnostics/logging to stderr or Hub logs.
- Windows command resolution must handle `codex.exe`, `codex.cmd`, PATH differences and PowerShell/cmd quoting.
- Prefer an explicitly configured Codex command when provided; otherwise probe with `where.exe codex`.
- Use the system `ssh` executable and normal `~/.ssh/config` rather than embedding a JS SSH stack in v1.
- Reuse SSH connections where practical.
- Hub owns long-lived Codex sessions. A browser tab closing must not immediately kill a running turn.
- Add timeouts, cancellation and clean child-process teardown.

## Thread behavior for v1

- A project has a configured machine and absolute working directory.
- Threads created through this app are mapped to that project in Hub storage.
- Store enough metadata to resume the Codex thread later.
- Do not make v1 depend on perfect automatic import of every historical Codex thread created outside this app.
- Historical thread discovery/import can be added after the core workflow is stable.

## Results behavior

The chat is for conversation. Technical output belongs in the Results feed/view.

Normalize useful events into result cards such as:

- screenshots/images;
- generated artifacts;
- build/test success or failure;
- file-change summary/diff link;
- preview URL;
- explicit errors requiring attention.

Do not dump raw command logs into chat. Put detailed logs in Activity.

Whenever the Codex protocol provides a structured event, prefer it over parsing assistant prose.

## UX rules — wide workspace

- Design against a 13-inch iPad landscape viewport first for the wide layout.
- Three zones: navigation / chat / results.
- Navigation can collapse; right pane can switch among Results, Files, Activity and Remote.
- Remote can expand to nearly/full screen without losing chat state.
- All panes scroll independently.
- No hover-only controls.
- Important touch targets should be approximately 44pt or larger.
- Support the iPad software keyboard and `visualViewport` changes correctly.
- Portrait/tablet compact mode becomes a tabbed/drawer layout instead of three tiny columns.
- Use CSS safe-area insets for standalone PWA mode.
- Keep theme effects readable and performant; CRT effects must not blur actual text.

## UX rules — iPhone/mobile

Read `docs/MOBILE.md` before implementing responsive behavior.

Do **not** obtain mobile support by shrinking the three-column layout.

At iPhone-class widths:

- show one primary workspace view at a time;
- default to Chat;
- provide persistent/simple access to `Chat`, `Results`, and `Remote`;
- move projects/threads into a mobile sheet/drawer;
- use Remote as a full-width workspace while active;
- keep Files/Activity secondary if necessary rather than overloading the bottom navigation;
- preserve project/thread/view/scroll state while switching views;
- handle iOS software keyboard, safe areas, orientation changes, PWA/browser suspension and WebSocket reconnect;
- support normal Safari as well as standalone Add-to-Home-Screen PWA;
- never require hover, pointer, or hardware keyboard for a core action;
- use actual available layout width/container state rather than device-name/user-agent sniffing.

Core mobile workflow must include login, project/thread selection, send/stream, approvals, interrupt, Results inspection, result<->turn navigation, and brief Remote access.

## Theme rules

Themes use semantic tokens and decorative layers, not divergent feature markup.

Initial themes:

- `organizer`
- `crt-green`
- `hitech-2000s`

Visual references live in `references/`.

On narrow mobile layouts, reduce decorative margins/bezels/effects when necessary to preserve working area. Theme identity must remain, but functionality wins over decoration.

## Security rules

- Only Hub port 443 should be public in the intended deployment.
- Never commit passwords, SSH keys, Codex auth data, RDP credentials or session secrets.
- Do not copy `.codex/auth.json` to the Hub.
- Windows firewall should restrict SSH and Remote Desktop to the Hub's LAN/Tailnet address.
- Use password hashing suitable for login credentials (Argon2id preferred), server-side sessions or opaque session IDs, Secure/HttpOnly/SameSite cookies, rate limiting and Origin/CSRF protections.
- Redact secrets in logs.
- Treat any future shell/file browser endpoint as privileged functionality behind the same authentication boundary.

## Storage rules

Hub-owned state belongs in SQLite and/or the Hub filesystem:

- users/session metadata;
- machines;
- projects;
- project/thread mappings;
- notes/tasks later;
- result metadata;
- UI preferences/themes.

Do not duplicate source repositories into Hub storage just for the UI.

## Implementation order

Follow `docs/ROADMAP.md`. In particular:

1. scaffold Hub + PWA + auth;
2. prove one remote Windows Codex conversation end-to-end;
3. add thread persistence/reconnect/approvals;
4. add Results feed;
5. add Remote Desktop;
6. polish both 13-inch iPad and iPhone PWA/client UX;
7. add themes;
8. then add Notes/Plan/Machines/Files/Git and optional Windows Companion.

Do not start with a giant dashboard.

## Definition of a good first milestone

From the iPad, the user can log in, open one configured Windows project, start/resume a Codex thread, send a prompt, watch streaming output, approve/deny requests, disconnect/reconnect the browser, and see a clean result summary — while the Windows PC has no Codex web port exposed.

Before mobile support is considered complete, the same core workflow must also work comfortably from iPhone using the dedicated single-view mobile shell described in `docs/MOBILE.md`.

## Owner-approved implementation updates (2026-09-06)

- Implement and verify the iPhone/mobile workflow first, retaining the 13-inch iPad as the wide-layout reference.
- Include model selection, native Work/Plan collaboration mode, reasoning-effort selection and file/image attachments in the first working release.
- Open chats with the latest 20 messages; older history is fetched explicitly in pages of 20.
- Authentication is password-only. The owner creates the first password via a private one-use enrollment link; no default/test production password.
- A local-only Windows Companion is approved now because the installed Codex sandbox runner fails when spawned directly in Windows OpenSSH Session 0. SSH carries the bridge's stdio into a named pipe restricted to the local user, and the Companion launches only the configured App Server for allowlisted project directories in the logged-in session. It must not create a network listener or expose arbitrary GUI/command APIs. This is a narrow exception to delaying the Companion until Phase 9.
- Run backend builds and heavy verification on Linux. Keep the Windows PC as the existing execution environment.
- Discover actual desktop Codex projects and conversations automatically, and allow creation/connection of project folders from the web. Continue native thread IDs across clients; keep history paged. Do not mutate private desktop state files to force sidebar synchronization.
- Default phone Remote to trackpad; support tablet direct touch and stylus. Connected phone Remote, especially landscape, must keep its full viewport with floating controls.
- Revisit all three owner-drawn theme references. Organizer binding/paper, CRT housing/green text and light silver/cyan hitech materials are part of the intended design.
