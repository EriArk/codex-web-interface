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

## Owner-requested primary client update (2026-09-06)

- The completed website is the owner's primary and intended sole client. Keep Windows execution independent of the desktop ChatGPT/Codex UI through the existing Companion.
- Continue existing native conversations after their desktop writer is released. Do not make copies or a desktop relay the ordinary solution for sending.
- Do not stop a running desktop task to migrate a writer. Finish the work, then explain the one-time full desktop exit if its writer is still held.

## Owner-requested workflow and density updates (2026-09-06)

- Projects expand their chat lists in place. The separate conversations tab is for chats without a project.
- Show persistent turn progress and pending questions near the mobile composer; validate native answer-choice requests.
- Collapse code/commands by default in Results and conversation Markdown; prioritize image result cards.
- Use a more compact mobile UI, especially the model/mode/effort row. Roboto Condensed is the selected face for organizer and hi-tech; retain CRT monospace and touch target sizes.
- Inspect screenshots across the main screens, orientations and all three themes; keep one shared functional UI.


## Owner-requested desktop maintenance (2026-09-06)

- Add an authenticated Settings action to restart the installed Windows Codex desktop app. This is an explicit user action, not an automatic writer-migration strategy.
- Use the existing system SSH connection and a dedicated fixed Scheduled Task in the owner's interactive session. No public Windows port or generic command/GUI API is added. Keep the Companion and its independent App Servers running.
- Block restart while tasks are known active or their state cannot be checked. Require an explicit in-app confirmation, guard against duplicate requests and expose the operation result. Do not restart the owner's desktop as part of development verification; use a harmless interactive probe and simulated process tests.


## Owner-requested access and recovery controls (2026-09-06)

- Allow an explicit per-conversation normal/full access choice using native permission profiles and approval policy. Default to normal; respect managed requirements. Keep the picker concise, without explanatory next-message copy.
- Add a left-edge rightward swipe to open the compact project drawer while preserving vertical scroll, input controls, dialogs and Remote gestures.
- Provide manual “work on the computer” handoff: close the Hub-owned App Server connection, persist the desktop choice and block automatic writer reacquisition. Returning to web control is explicit.
- The owner additionally authorizes an exceptional hard restart action with an in-app confirmation that active tasks will stop. This action may bypass the normal active/unknown activity guard, disconnect the selected machine's Hub-owned App Server tree and force-restart the fixed desktop package. Keep the Companion itself and unrelated processes intact. Never exercise this action on the owner's live desktop during development.
- Keep accepted Steer submissions visible until their matching native user message appears. Failed attachment preparation must not leave the draft blocked as already submitted.
- Make the turn-status row expand/collapse a small panel of recent actions and native public reasoning summaries. Never expose raw reasoning text/content. Keep commands collapsed and the panel bounded.

- Show native Codex usage windows in Settings, including the weekly remaining percentage and reset time. Determine windows by their duration rather than assuming primary/secondary order; do not expose billing credentials or credit balances.
- Add a clearly visible end-of-task separator in conversation history. Do not insert one inside an active turn or between Steer messages belonging to the same turn.

## Owner-approved active client handoff (2026-09-06)

- The owner explicitly approved interrupting a current turn to switch between the website and native desktop Codex, preserving the same native conversation. This supersedes the earlier finish-before-migration restriction for this explicit Settings action only.
- Confirm before interrupting Hub-owned work, wait for native interruption/completion, then release the machine's loaded writers. Block concurrent sends and queue mutations during handoff. Preserve pending native queue items; never replay a prompt or fork automatically.
- Desktop Retry opens the existing conversation after release; continuation may require a new message. Do not imply transfer of an in-memory running turn.
- Returning from native desktop can explicitly close its app through the existing fixed user-session Scheduled Task, after confirming that its active tasks will stop. Keep Companion and its independent App Servers running. Enable web writes only after verified desktop closure.
- Verify ownership switching using disposable native conversations and simulated Windows process effects. Do not interrupt or close the owner's desktop tasks during development checks.

## Owner-requested CRT refresh and classic dark theme (2026-09-06)

- Refresh crt-green toward the owner's terminal reference with phosphor glow, restrained raster/glass surfaces and an appropriate Cyrillic-capable monospace font. Keep glyphs crisp and mobile working area intact; no flickering or animated full-screen filters.
- Add classic-dark alongside the existing themes: graphite surfaces, quiet accents, clear contrast and the shared compact Roboto Condensed typography.
- Themes remain semantic tokens and decorative CSS over one functional UI. Images and Remote retain original colors. Persist the fourth theme through Hub preferences and apply the cached theme and browser chrome color before rendering login/workspace.

- Revisit organizer and especially Hi-Tech 2000s against the owner-drawn references in the same theme update. Hi-tech should emphasize a silver equipment chassis, dark joins, recessed light screens and cyan highlights. Organizer should retain clean paper, binding and pastel tabs. Keep all phone decoration compact.

## Owner-requested attachment reliability and status cleanup (2026-09-06)

- Remove the redundant upper chat status strip, including the standalone working/spinner row after the messages directly above the expandable progress control. Retain only the expandable recent-work control above the composer and compact navigation/header indicators.
- Transfer uploaded attachments through the existing system SSH/SFTP connection, with bounded staging and verified file size/hash before native submission. Preserve draft text/files and allow an explicit retry if preparation fails; do not change permissions or restart the desktop to recover an upload.

## Owner-requested tablet continuity controls (2026-09-06)

- Opening another client or restoring history during a live turn must preserve all public assistant messages and summaries. A turn can contain multiple Steer messages; never reconcile user messages by turn ID alone.
- On the wide tablet layout, allow the right pane to collapse and remember that choice locally. Keep an accessible Remote shortcut and the pane toggle in the top bar. Explicit result/Remote navigation reveals the pane without losing chat state; compact layouts retain their existing bottom tabs.

## Owner-approved ChatGPT mode (2026-09-06)

- Add a Codex/GPT switch in the sidebar branding. GPT uses the owner's real consumer ChatGPT account, conversations, projects and available model/power choices; it is not a separate API account or a renamed Codex conversation.
- The owner approved a ready-made browser integration and personally completed login in an isolated Linux browser. Keep its persistent profile and connector tokens private on the Hub host. Do not copy Windows ChatGPT/Codex credentials or request an API billing key.
- The optional ChatGPT browser container has only a loopback Hub connector and private Docker-network VNC. The public client consumes authenticated Hub contracts, never raw extension events, tokens or signed native asset URLs.
- Hub-owned durable, idempotent sends continue when the web page closes. Serialize the browser writer and settings changes; preserve uncertain submissions without automatic replay. Read canonical native history in visible pages of 20, following its current branch.
- Normalize visible assistant text and generated image results only. Never expose hidden analysis, raw thoughts, tool internals or adapter diagnostics. A canonical completed native turn may confirm an image-only response when the UI adapter fails to recognize it.
- Keep native ChatGPT functionality accessible through the protected connection page; share the app's themes and responsive shell for the primary GPT chat workflow.

## Owner-requested history order and interactive demos (2026-09-06)

- Reopening a long live turn must not append older Hub messages below the latest native page. Reconcile known attachment envelopes using their bound attachment IDs and exact user text; preserve distinct Steer messages.
- Show interactive HTML design demos in Results when Codex emits an HTML block, a linked project HTML file, an HTML file change or an explicit MCP HTML resource.
- Read project HTML through the existing machine transport with bounded size and project-root checks. Never start a public preview server on Windows.
- Run demos in a separate opaque-origin sandbox with scripts, without same-origin privileges, network access, forms or host credentials. Keep source code collapsed and provide an accessible close control.

## Owner-requested desktop preparation (2026-09-07)

- The explicit Settings handoff must also open and maximize the installed Codex desktop app after its Hub writers are released. Pass the selected conversation through its native local thread link when available.
- Extend the existing fixed interactive Scheduled Task with Open; never stop processes for Open, accept caller URLs/commands or acquire a writer automatically. Only a Hub-resolved native UUID may identify a conversation. Keep failure visible and allow an explicit retry.
- Continue verifying desktop effects with simulated processes and harmless window probes, without exercising handoff on the owner's active conversation.


## Owner-requested navigation actions (2026-09-07)

- Codex and GPT share a small, always touch-accessible per-project/per-chat action menu. Order: Pin, Rename, Archive, Delete. Pin and Archive change to Unpin and Unarchive when applicable.
- Delete is red and requires a separate confirmation naming the selected object. A Codex project deletion removes native grouping and leaves source directories and conversations intact; ChatGPT project deletion uses its native destructive semantics and the confirmation names its chats/files.
- Use native rename/archive/delete operations and native ChatGPT pins. Installed Codex 0.153.4 has no thread pin operation; persist its pins on the Hub across devices. Whole-project archives are Hub presentation preferences in both modes.
- Provide an explicit Archive view with restoration. Keep active work ahead of pinned inactive entries. Mutations must update other clients and must not replay sends or interrupt active work.
- Preserve ChatGPT project instructions and appearance when renaming through its current PATCH contract. Native pin limits remain enforced; never unpin another item automatically.
- Existing Codex project creation must remain available for creating a folder or connecting an existing folder.
- Match the GPT mobile navigation geometry to Codex, including anchors, and correct demonstrated visual inconsistencies without a separate theme/device implementation.


## Owner-requested copy controls and stabilization priorities (2026-09-07)

- Provide always-visible, touch-accessible icon copy controls for both Codex/GPT messages and fenced code/text blocks, with brief success feedback. A block can be copied while collapsed; preserve exact whitespace and avoid copying interface labels.
- Defer issue #6 project-root restrictions pending the owner's decision; preserve the existing project workflow.
- Physical-device verification continues through the owner's everyday iPhone/iPad usage and reported fixes. Do not claim a separate completed formal hardware acceptance pass.
- Continue GPT recovery (#30), conservative storage maintenance (#5), and interactive preview isolation verification (#29), retaining features and the existing password-only experience.

## Owner-requested categorized results (2026-09-07)

- Codex and GPT share Results categories: All, Images, Demos, Files and Work. Filter before paginating so older media does not require loading technical logs.
- Generated images, interactive demos and downloadable assistant files belong in Results, with compact links from conversation messages. User uploads remain visible in the chat.
- Selecting media opens a Preview tab; allow expansion and return without discarding the demo's local state or chat state.
- Keep message and block copy controls available in both modes, including collapsed code.

## Owner-requested send-time handoff (2026-09-07)

- When sending to a computer-owned Codex conversation, offer a concise modal to continue on the website. After explicit confirmation, use the existing verified desktop-release action and send the preserved text/files once in the same chat. Cancel/failure/navigation must preserve the draft and never replay an uncertain send.
- Suppress old unread-completion badges while that same thread is active. A project may show both indicators only for different threads.
