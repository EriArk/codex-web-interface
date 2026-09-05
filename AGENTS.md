# AGENTS.md

This repository is intended to be implemented primarily with Codex. Read this file before changing architecture or starting a large feature.

## Product in one sentence

Build a **private, iPad-first PWA** that lets one user work with Codex running either on a Windows PC in the same LAN as the Linux Hub or locally on the Hub, while keeping execution machines off the public Internet.

## Source-of-truth order

When documents disagree, use this order:

1. `AGENTS.md`
2. `docs/DECISIONS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/UX.md`, `docs/SECURITY.md`, `docs/CODEX_INTEGRATION.md`, `docs/REMOTE_DESKTOP.md`
5. `docs/ROADMAP.md`
6. `README.md`
7. visual references

Do not silently change a fixed decision. If a constraint is blocking implementation, document the conflict and propose the smallest compatible change.

## Fixed constraints

- Primary client: **13-inch iPad in landscape, standalone PWA**.
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
- One functional UI, multiple themes. Do not create separate implementations per theme.

## Important Windows rule

OpenSSH-spawned processes on Windows must be treated as **non-interactive** with respect to the visible desktop.

Do **not** assume:

- `ssh windows-pc notepad.exe` creates a window visible in the user's desktop;
- a GUI app started by Codex over the SSH-hosted App Server will be visible in an RDP session;
- desktop screenshots can be captured reliably from the SSH session.

For v1, Codex over SSH is for code/files/build/test/CLI work. Manual GUI inspection is done through the Remote pane.

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

The chat is for conversation. Technical output belongs in the right-side Results feed.

Normalize useful events into result cards such as:

- screenshots/images;
- generated artifacts;
- build/test success or failure;
- file-change summary/diff link;
- preview URL;
- explicit errors requiring attention.

Do not dump raw command logs into chat. Put detailed logs in Activity.

Whenever the Codex protocol provides a structured event, prefer it over parsing assistant prose.

## UX rules

- Design against a 13-inch iPad landscape viewport first.
- Three zones: navigation / chat / results.
- Navigation can collapse; right pane can switch among Results, Files, Activity and Remote.
- Remote can expand to nearly/full screen without losing chat state.
- All panes scroll independently.
- No hover-only controls.
- Important touch targets should be approximately 44pt or larger.
- Support the iPad software keyboard and `visualViewport` changes correctly.
- Portrait mode becomes a tabbed layout instead of three tiny columns.
- Use CSS safe-area insets for standalone PWA mode.
- Keep theme effects readable and performant; CRT effects must not blur actual text.

## Theme rules

Themes use semantic tokens and decorative layers, not divergent feature markup.

Initial themes:

- `organizer`
- `crt-green`
- `hitech-2000s`

Visual references live in `references/`.

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
6. polish iPad/PWA/themes;
7. then add Notes/Plan/Machines/Files/Git and optional Windows Companion.

Do not start with a giant dashboard.

## Definition of a good first milestone

From the iPad, the user can log in, open one configured Windows project, start/resume a Codex thread, send a prompt, watch streaming output, approve/deny requests, disconnect/reconnect the browser, and see a clean result summary — while the Windows PC has no Codex web port exposed.
