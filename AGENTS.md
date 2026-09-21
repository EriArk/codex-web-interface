# AGENTS.md

## Owner-requested main-branch completion (2026-09-21)

- Keep `main` current with completed, verified work. Finishing a stage includes committing, pushing and integrating its changes into `main`; do not leave accepted releases accumulating only on a feature branch.
- Use temporary branches only when isolation serves the task. Prefer a fast-forward when possible, preserve existing history, and never force-push `main`. Deployment still follows the existing maintenance rules.

## Owner-requested root-cause fixes and quiet UI (2026-09-21)

- Fix the underlying failure and verify the intended operation succeeds. Adding an error message, fallback card or retry control is not a substitute for fixing a reproducible bug.
- Keep the interface uncluttered. Do not add diagnostic notices or extra failure UI as incidental bug-fix scope; use existing feedback where necessary.

## Temporary owner-requested forced updates (2026-09-21)

- Expose an additional “Обновить жёстко” action only to the original installation owner while the host updater enables it. Other users, including administrators, cannot invoke it.
- After explicit confirmation, the action may bypass active/unknown work and terminal waiting for the exact pending release. This supersedes idle-only deployment for that explicit action. Retain backups, integrity checks, private account isolation, rollback and uncertain-send receipts; never replay interrupted sends.
- Ordinary updates retain idle waiting. The host enables the temporary option with `--allow-owner-force`; omit it to remove the control.

## Owner-confirmed installation authority and LAN exception (2026-09-20)

- The original owner is the installation's principal administrator. Do not demote or disable that account through team administration, including when other admins exist; another admin cannot issue owner password recovery. Preserve owner self/host recovery.
- Keep the owner's existing Windows PC on its direct LAN SSH/Companion connection. Member Tailscale enrollment and readiness requirements never replace or gate this connection or force owner onboarding. Preserve the owner's accounts, sessions and projects.

## Owner-approved independent-member passes and background GPT deletion (2026-09-20)

- Complete member readiness in four bounded passes: personal native GPT profiles/login; remaining isolation and revocation; PC installer and continuous setup; new-user acceptance. Use focused checks for the affected behavior rather than repeating unrelated large suites.
- Confirmed GPT chat deletion hides the chat after a fast durable Hub acknowledgement. Perform native deletion in the background when idle, retain its receipt across restarts, and do not block other chats on an uncertain deletion. Preserve the existing confirmation for irreversible native deletion.
- New native member profiles start empty and bind only their own authenticated account. Preserve the owner's existing native profile and workflow. Do not enable public member registration before the remaining admission pass.

## Owner-requested Canvas removal (2026-09-20)

- Remove Canvas from the product UI and planned work, including its cards, viewer and background metadata reads. This supersedes the earlier Canvas navigation/evaluation requests. Retain normal file artifacts, text blocks and HTML demos; HTML canvas elements are unrelated. Do not delete native documents as part of UI removal.

## Owner-requested immediate GPT choices (2026-09-20)

- Keep the last GPT model/power catalog and selection in bounded account-local storage so both pickers remain usable while the connection/history loads, including after PWA tab eviction. Fetch choices independently and refresh quietly without replacing a still-valid selection. Clear on logout; cached metadata never grants send readiness or bypasses native model/effort validation.

## Owner-requested compact navigation and queue controls (2026-09-20)

- Put the search magnifier to the left of Projects/Dialogs, with the tabs and drawer close control in one row. Expand the title filter only on demand; preserve full content search.
- Allow Codex reasoning effort changes during a running turn for subsequent queued work. Apply native thread settings for subsequent turns; Steer keeps the active turn's settings. Native queues use thread defaults, not unsupported per-item overrides.
- Keep the send icon visible. Show a tiny centered loading indicator above the message field, never over it or inside Send. GPT durable enqueue does not wait for browser history rendering; retain model selection, account binding, attachment and exact-send protections.

## Owner-requested Results tab order (2026-09-20)

- GPT Results tabs: Files, Images, Links, Demos, Reasoning. Codex Results tabs: Files, Images, Links, Demos, Work (owner update 2026-09-21).
- Remove the All tab in both clients; default to Files. Exact result navigation selects its category. Keep aggregate counts and backend compatibility.

## Owner-requested public GPT progress and warm active history (2026-09-20)

- GPT chat shows user messages and completed final responses. Public commentary and recognized public tool-action categories belong in Results → Reasoning, grouped by the exact native user message, and in the expanded running progress panel.
- Results → Reasoning → response history also includes the final public answer after its intermediate messages (owner update 2026-09-21).
- The collapsed progress control shows only a short action with its icon, never a scrolling answer. Keep live public text in the expanded panel. Never expose hidden analysis, raw tool arguments/results or internal diagnostics.
- Keep active native chats warm on the Hub independently of the open browser page. Reuse canonical reads, coalesce concurrent loads and bound refresh frequency/cache size. Refresh completion immediately; never replay sends or preload the entire catalog. Returning viewers see available cached history while background work continues.
- Retain recently viewed GPT history for 30 minutes after use. Pins and the ten latest unpinned catalog chats have no time expiry in memory, subject to a shared 32-chat / 32 MiB per-user budget. Prefer active work, pins, then the recent ten during eviction. Restore available private disk snapshots without polling inactive native chats; refresh an opened chat quietly.
- Retain Results metadata with the same history; never preload binary files for navigation. Show cached first pages immediately and refresh canonically in the background. Bound the browser first-page cache to 64 chat/category scopes and 4 MiB, expire after 30 minutes of inactivity, and clear on logout. Keep account isolation, exact source navigation and branch replacement intact.

This repository is intended to be implemented primarily with Codex. Read this file before changing architecture or starting a large feature.

## Product in one sentence

Build a **private, iPad-first PWA with first-class iPhone and desktop support** containing independent personal Codex/GPT workspaces and explicitly shared development projects for a small trusted team. Execution machines remain off the public Internet.

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
- Authentication is mandatory. The existing single-owner installation is the migration baseline; team access must remain disabled until user identity and complete private-resource isolation are verified.
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

Follow the current milestones in `docs/ROADMAP.md` and the approved team specification in `docs/TEAM_WORKSPACE.md`. The original implementation order below is historical; its personal-workspace modules already exist:

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

- Drawer and Settings close controls stay compact and unframed with 44px touch targets. Focus the panel on opening instead of highlighting the close button or activating the client picker; retain keyboard focus visibility. Leftward touch swipes close either panel in Codex/GPT while preserving vertical scroll and input gestures.


## Owner-requested GPT pinned order (2026-09-08)

- In GPT navigation, pinned panels remain above active unpinned chats. Activity raises a chat to the top of its own unpinned group, never above the pinned panel. Pending new sends also appear below that panel.
- Apply the same grouping to GPT project chat lists; retain Codex activity-first ordering. This is a GPT-specific update to the earlier activity-first presentation rule, not a change to native pins or execution.

- A Codex project with one visible chat opens that chat directly from the project row. Its project action menu starts with New chat, followed by the existing Pin/Rename/Archive/Delete actions. Two or more chats restore inline expansion; preserve both the chat draft and the other project's pending work when navigating.


## Owner-requested stable inactive navigation (2026-09-08)

- Codex inactive projects/chats retain their order through state polling, reconnect and viewing completion badges. Sort by real work recency, with active work still first; unread completion remains an indicator, not a separate sorting tier.
- Native catalog refresh must not roll back a more recent Hub activity timestamp. Observed desktop activity uses its native event time rather than the time of the probe.

## Owner-requested background read-aloud and Remote placement (2026-09-08)

- Support reading a reply while the iPhone screen is locked through an optional local Linux speech worker and one private audio track. Keep system-voice fallback; actual iPhone verification remains the owner's physical-device check. Text/audio never goes to a third-party speech service.
- Remove Remote from workspace tabs. Place an icon-only Remote shortcut beside the Codex/GPT branding in each sidebar. An explicit click connects and opens the full available viewport, with a clear way back and floating controls.


## Owner-requested GPT stability priority (2026-09-10)

- Stabilize GPT before the project-workspace expansion (#83-#89). Preserve native features, drafts, and the single-password experience.
- Suppress Chromium crash-restore UI on startup without modifying login/profile data. Keep browser memory sufficient for real long conversations and log process exits with fixed, non-content diagnostic codes.
- During explicit GPT preparation, dismiss recognized optional ChatGPT promotions through native negative/close controls. Leave login, consent, payment, editable and unknown dialogs to the owner with a direct connection-page action.
- Transient navigation/context replacement and metadata-read failures should recover without stale warning banners. Never replay an uncertain send or silently bypass model/effort verification.


## Owner-requested explicit read-aloud modes (2026-09-10)

- Expose a compact shared System voice / Background audio choice in Codex/GPT Settings and remember it on the device. Default to system speech when supported; Piper availability must not override the owner's choice.
- System mode uses installed local voices and must not call the speech worker. Keep delayed voice discovery, pause/resume/stop and cancellation guards. Background mode retains private media playback and Media Session controls. Switching modes stops the previous engine.
- Physical iPhone/iPad audio remains the owner's usage check; simulated browser voices are not hardware acceptance.

## Owner-requested global human Tasks (2026-09-10)

- Tasks is one global human reminder list, separate from native collaboration Plan mode and future AI Plans. Sidebar entries open all projects; Project Home opens the same storage filtered to its project.
- Provide single-tap Codex/GPT project filters, unassigned tasks, priority/status/due dates and existing links. Keep paged queries, durable drafts, exact retry idempotency and explicit revision conflicts.
- Task actions use only Hub metadata and never acquire a native writer, submit a prompt or change the selected chat. Preserve tasks and their project association through archive, deletion and future chat rotation; show unavailable associations.

## Owner-requested global Notes and direct capture (2026-09-10)

- Notes is a global personal notebook with project and unassigned filters, shared by Codex/GPT. Project Home opens the same storage filtered to that project.
- Save visible messages directly to Notes, preserving exact text and an immutable source snapshot with client, role, native/thread/message/turn identities and capture time. Editing the note does not rewrite its original source.
- Capture only writes Hub metadata. Preserve chat drafts, selection, scroll, native ownership and unread state. Exact retry idempotency prevents duplicate captures.
- Source navigation uses bounded history context; it never silently jumps to the newest message or downloads an entire chat. Missing/deleted sources keep the captured note readable.

## Owner-requested project continuity foundation (2026-09-10)

- Maintain an owner-edited Project Core distinct from dynamic Tasks, Notes, Plans, Reports and chat handoffs. Include purpose, behavior, rules, constraints, architecture and preferences.
- Core writes require explicit revisions; retain the last 40 owner versions with explicit restore. Preserve Core and history through project/chat archive or deletion. Do not rewrite repository instructions or promote model output into Core.
- New current-chat bootstrap includes the saved Core; ordinary messages do not repeat it automatically.

## Owner-requested complete project workspace (2026-09-10)

- Keep human Tasks, captured Notes, executable ordered Plans, checkpointed Reports and owner-edited Core distinct, with shared project filters and four-theme phone/tablet layouts.
- Project actions target one Current chat. Explicit rotation sends bounded canonical Core plus separate dynamic state/handoff through ordinary native creation and durable send receipts; change Current only on confirmed identity/submission. Preserve previous chats and every project-owned item/backlink.
- Never blindly retry unknown creation/bootstrap. For GPT verify canonical project membership and the exact submitted bootstrap. Existing ownership, permissions, model/effort checks and unknown-send recovery still apply.


## Owner-requested project Files/Git access (2026-09-10)

- Put one Files/Git shortcut between New chat and Settings in the Codex header; bind every read and late response to the selected project. Remove the Settings entry. File actions expand at the selected row.
- Show the local README, repository identity, branches, tags, recent commits, worktree changes and GitHub releases without acquiring a Codex writer or mutating Git.
- Private GitHub releases reuse the existing Windows user-session GitHub CLI login through a dedicated fixed read-only Scheduled Task when SSH cannot access that login. It accepts only validated repository coordinates, returns bounded release metadata and adds no listener, credentials copy or desktop process control.


## Owner-requested workflow completion (2026-09-10, #102, #103, #105, #106)

- Selecting an existing GPT chat shows that chat's identity and an explicit history loading/retry state. Only a truly new chat uses the empty composer shell. Cached history remains visible during bounded revalidation; late replies cannot overwrite another selection.
- The project wizard uses Project / Folder / optional GitHub / Review. Preserve the existing no-Git folder workflow. Git mutations are a narrow, explicit exception to the read-only Files/Git inspector: create a repository, initialize Git, clone, or add an absent matching origin through typed operations after Review. No automatic commit/push, reset, force, unrelated merge, or non-empty destination replacement.
- Use a separate fixed local Windows user-session Scheduled Task for wizard GitHub access. Keep authentication on the execution machine; no listener, PAT transfer, caller commands or general GUI API. Hub and execution-machine receipts persist operation identity, review fingerprints and uncertain outcomes. Reconcile postconditions before continuing; native grouping is registered only after setup is confirmed.
- Sidebar Search and close stay at the top. Refresh/Archive live in Settings. One bottom row holds Settings, icon-only Remote and a larger direct icon-only Codex/GPT toggle. This supersedes the former branding-header placement without removing Remote or either client.
- Project Overview is a modal over the mounted current workspace. Merely opening/closing it must preserve project/thread, drafts/files, scroll, unread state, support pane and native work. Explicit links can navigate; existing workspace modules are reused.

## Owner-requested Bridge Doctor and completion reading (2026-09-10, #107, #108)

- Persistent qualified GPT faults may send one diagnostic request to a dedicated project-scoped Bridge Doctor native chat, separate from Current Chat. This is explicit authorization for bounded diagnostic sends only. Normal work and desktop ownership take priority; unknown creation/submission never causes blind replay. The association and private incidents survive restarts/backups.
- Ignore normal busy/brief startup/recovered network failures and owner-controlled login/payment/consent flows. Apply startup grace, persistent-fault thresholds, fingerprint deduplication, rate bounds and sustained-health recovery. Unknown dialogs are observed, never clicked by Doctor.
- Automatic Doctor turns use native read-only sandbox policy with no escalation, and deterministic diagnosis-only instructions. They do not authorize file changes, arbitrary project execution, restart/deploy, credential changes, GPT sends or automatic repairs.
- Evidence contains only allowlisted fixed diagnostics. A sanitized native screenshot hides all text, user/account/media regions and composer contents; retain only structural layout. Omit evidence when owner flows or reliable capture cannot be excluded. It remains private behind Hub authentication.
- While following a live response, successful completion moves to the start of its final/main assistant answer once. Manual scrolling, source/history views, hidden panels, old completions and another conversation's late responses take precedence. Use the internal scroller, keep focus/drafts intact and prevent later layout changes from pulling the reader back to the bottom.


## Owner-requested informative notifications (2026-09-10)

- Work notifications show project/chat context, an outcome and a bounded public final-answer excerpt or non-secret question. Use only existing Hub metadata and the exact event/job; no native reads, writer acquisition, automatic sends or AI summary requests. Keep diagnostics/commands/secret questions out of previews.
- Detailed display is enabled for subscribed devices after this explicit owner request. A compact per-device setting can hide names and answer previews while retaining generic status delivery. Keep encrypted push, opt-in device enrollment, deduplication, draft-preserving authenticated navigation and compatibility with already-installed workers.

## Owner-requested tablet materials and layout (2026-09-10)

- Make theme identity clearer across the workspace and new Tasks/Notes/Plans/Reports/Core/Files/Git surfaces. Organizer uses paper, binding and pastel divider details; Hi-Tech uses restrained metal, recessed displays and physical controls inspired by 2000s devices. Use shared semantic materials and existing space, never separate functional markup.
- CRT is the screen atmosphere, not a monitor housing: use crisp phosphor text, restrained glow and background raster without a thick frame, flicker, media filters or wasted working area. This supersedes the earlier CRT housing request, including the previous-layout option.
- Modest tablet layout refinements are approved. Provide a concise shared device-local “Прежняя компоновка” checkbox restoring previous pane/chrome proportions without reverting functional fixes or losing drafts, selection or native work.

## Owner-requested Devices workspace (2026-09-10)

- Add an icon-only Devices shortcut beside Remote in the shared sidebar footer. Start with the Linux host and Windows PC; other LAN devices are added explicitly later. Do not scan the LAN or invent Odin connection details.
- Devices is infrastructure management independent of Codex/GPT chat writers. Hub owns bounded system-SSH PTYs; the browser uses the existing private Hub auth, CSRF and WebSocket boundary. This is an explicit exception permitting an authenticated terminal, not an expansion of the Companion's fixed APIs or a Windows network listener.
- Use a separate Hub-restricted Windows SSH key allowing PTY. Preserve the original Codex no-PTY key and all forwarding restrictions. Server sessions SSH into the actual host rather than the Hub container.
- Keep terminal creation idempotent and commands/output private. Closing the UI detaches without replaying input or terminating work; explicit termination, logout, expiry or a Hub restart ends the corresponding terminal. Deployment waits for open terminals as well as Codex/GPT work.
- System information uses bounded read-only probes and honest unavailable sensor states. Power/mount actions name the selected machine, require confirmation, run in a separate terminal, and use that machine's normal OS permissions. Never exercise real reboot/shutdown during development. Windows network drive mappings are for the remote logon session.
- Existing Results command cards reveal their exact saved terminal output lazily in a separate collapsed block with copy support. No native writer acquisition or hidden reasoning content.

## Owner-approved project review and delivery loop (2026-09-11)

- Implement #113–#117 and the configured Windows project preview #38 as focused changes over existing modules. Additional execution machines #37 and project-root restrictions #6 remain deferred; physical Apple acceptance continues through owner usage.
- Completed implementation actions have an exact, durable Review with frozen public answer, Results/check observations and source identity. Owner acceptance is metadata, separate from native completion and technical verification. Ordinary chats do not require acceptance.
- Needs fixes preserves an owner note and prepares a normal idempotent correction action to confirmed Current Chat; show a changed chat before submission. Never replay the original implementation, implicitly change ownership or commit/push from Accept.
- Plan reconciliation proposes changes for the exact executed revision. Only explicit owner-selected application changes saved Plan state. Delivery mutations are a narrow owner-approved extension: reviewed commit, normal push and PR creation with machine-local GitHub credentials, operation receipts and verified postconditions. No automatic force push, merge/release or repair loop.
- Quick Capture writes existing Notes/Tasks without disturbing the current workspace. Windows project previews use a configured allowlist through a fixed local user-session helper and existing SSH; no arbitrary browser command API or listener.

## Owner-requested polymer surfaces (2026-09-11)

- Use TrainerOS's tinted polymer, bevels, contact shadows and recessed screens as the material reference for CRT and Hi-Tech structural panels. CRT uses a substantially darker casing; Hi-Tech may be substantially restyled toward TrainerOS and spend modest additional space on the casing. This supersedes the earlier blanket no-housing constraint for these panels; phone content, safe areas and controls must remain usable.
- Offer a separately remembered casing color for CRT and Hi-Tech in the shared appearance settings. Keep content/status colors independent, with one functional UI and the existing previous-layout option.
- Make the circular Codex/GPT control a recessed, dimensional physical button with a mounting well, bevel and pressed feedback. Preserve its direct one-tap action, keyboard focus and touch size.

## Owner-requested server verification (2026-09-11)

- Do not use GitHub Actions for this project. GitHub is for source history, issues, pull requests and releases. Do not wait for hosted CI, troubleshoot its billing or report its absence as a release blocker.
- Keep builds and appropriate automated verification on Linux, retaining the existing tests, pinned tools, repository guard and safe idle deployment checks. Run Windows-specific checks only when needed for a Windows change; simulate desktop effects as already required.

## Owner-requested native message dictation (2026-09-11)

- Add message dictation to Codex and GPT only through native OpenAI recognition using the existing consumer account. The owner explicitly rejected a lower-quality/local recognition substitute. Do not request an API billing key or silently fall back to another engine.
- Dictation inserts text into the exact current draft and never sends automatically. Preserve typed text/files, stop microphone capture on cancellation or navigation, discard late results from another chat, and allow explicit retry after uncertain recognition acknowledgement.
- Show an explicit empty state when Codex confirms zero earned usage resets. An unsupported or unavailable native field is not evidence that the account has zero resets.

## Owner-requested recording interaction (2026-09-12)

- The microphone toggles recording: first tap starts, second tap stops, transcribes and submits through the ordinary Codex/GPT send or queue flow. This explicit second tap supersedes draft-only dictation. Preserve handoff/approval checks, attachments, exact retry and drafts on send failure. Cancel, navigation, backgrounding and recording-duration limits never authorize sending.
- Show a scrolling waveform derived from actual microphone amplitude and elapsed recording time; no fabricated activity. Keep a separate Cancel control and release microphone/audio-meter resources promptly.
- While editing, both message fields grow with the number of text lines up to twice their normal height, then scroll internally. Keep the shared themes, viewport/keyboard handling and compact layout.

## Owner-approved linked projects and independent web deployment (2026-09-12)

- Linked Codex projects exchange bounded read-only consultations through their explicitly confirmed Current chats. Each link has a 1–10 round limit and optional trusted forwarding; either participant may resolve early. Unknown outcomes never replay, owner stop prevents further messages, and Work prepares an explicitly executable Plan. Native dynamic relay tools are registered only on new web-created chats because the installed runtime cannot add them on resume; do not rotate old chats implicitly.
- The public `hub` is a web/API gateway. Persistent `engine` owns SQLite, auth, native RPC/SSH, approvals, queues, GPT orchestration and PTYs over an owner-only Unix socket. Gateway restart and compatible atomic public-asset publication preserve that engine and its work. Keep the existing browser API and single-password login.
- Version compatibility and retained immutable assets protect open clients. Initial separation, engine changes and migrations still use guarded idle maintenance. The earlier terminal-on-Hub-restart rule now applies to the execution engine, not the independently replaceable web gateway. Never auto-close an owner's terminal to deploy; surface pending release, honest blockers, waiting time and postcheck outcome in Settings.

## Owner-requested control geometry and editor continuity (2026-09-12)

- Header icon controls share square 44px geometry while retaining each theme's rounded corners. Center the sidebar Settings control vertically and put Tasks, Notes, Plans and Reports in one evenly spaced row.
- Keep modal editors within the visible software-keyboard viewport, including its iOS pan offset; their close controls remain reachable and long fields scroll inside the editor. Apply the shared behavior to both clients and project forms.
- Reconcile native image echoes against the exact bound upload preview or staged preview path. Repair existing history presentation without deleting files, hiding unrelated images or resending messages.

## Owner-requested casing palette and continuous frames (2026-09-12)

- Offer twelve clearly distinguishable pastel plastic colors, including black and white. Preserve existing color preference identifiers and independent CRT/Hi-Tech choices.
- In both material themes, connect control rails to narrow continuous rims around the navigation, chat and Files/Git/Results reading wells. CRT content stays dark phosphor green; its casing is no longer forced almost black. Keep phone trim compact and preserve the previous-layout option.
- Selected casing controls use a recessed cap in the chosen plastic color, including mobile Chat/Results tabs. Resolve casing text/icons independently of screen text, with dark ink on light plastic and light ink on dark plastic. Content/status semantics remain intact.
- Deepen casing colors and separate keycap tones using crisp contact shadows, edge highlights and restrained one-pixel lettering relief. CRT is the evening variant: darken its plastic with neutral charcoal, without a green filter. Organizer and Classic Dark use the same independently remembered palette for accents while retaining their paper/graphite reading surfaces.
- White, yellow and silver are deliberately very light, glossy plastic exceptions in both material themes. Keep dark lettering on these shells and the green CRT reading surface; deepen the remaining CRT casing colors further.
- The remaining dark CRT shells are matte and deeper still: remove casing light washes and bright edge glints, keeping relief through contact shadows and restrained seams.

## Owner-prioritized personal installation (2026-09-12)

- Focus current development on completing the owner's personal daily workflow, missing Codex/GPT functionality and reliability on the existing installation.
- Defer guided installers, transfer to other people's infrastructure, clean second-user installations and distribution-specific packaging/generalization. This supersedes the earlier distribution milestone sequencing; #11 and the distribution portion of #14 are outside the current work scope until the owner explicitly resumes them.
- Continue backups, recovery, security and compatible updates needed by the owner's installation. Existing owner deferrals for #6 and #37 remain unchanged.

## Owner-requested settings organization (2026-09-12)

- Codex and GPT share six settings categories: Appearance, Sound and notifications, Connections, Projects and history, Maintenance, and Access. Keep all existing controls and their safety/ownership rules.
- On phones, open a category index and provide a clear Back action from each category. Wider dialogs keep category navigation beside independently scrolling content. Preserve unsaved forms across category changes, and keep the header within the visible software-keyboard viewport.
- Poll settings diagnostics/status only while their category is visible. Browsing settings does not authorize a native send, restart or handoff.

## Owner-requested books voices and mixed-language speech (2026-09-12)

- Reuse the books narrator's Eugene and Kseniya Silero voices alongside Piper Ruslan, with a device-local server-voice choice in shared Sound settings. Retain System voice as an independent mode.
- Route English insertions through the existing local English Piper model and combine Russian/English into one private audio track with consistent sample rate, restrained pauses and matched level. No hosted TTS or larger future speech system is required.
- Match the books player default of 0.85× for every server voice, preserving pitch. Keep the copied narration tuning, network-isolated worker, resource limits and guarded engine maintenance.

## Owner-approved idle terminal maintenance (2026-09-13)

- An open terminal at a verified idle shell prompt must not block engine updates. The owner authorizes replacing these idle sessions during maintenance. Active commands, background jobs and unverified shell state still block it; quiet output or low CPU is not proof of idle work.
- Use shell lifecycle signals and bounded read-only process checks. Freeze terminal creation/input during the final maintenance check so a verified idle terminal cannot accept a new command before engine replacement. Never replay terminal input after reconnect.
- This supersedes the earlier blanket rule that every open terminal blocks deployment. Preserve all unrelated Codex/GPT work and the gateway/engine separation.

## Owner-approved private team workspaces (2026-09-13)

- Implement issues #149–160, prerequisite machine roots #6 and additional machines #37, and confirmed reliability defects in one integrated pass. First acceptance is the friend's complete independent workspace on the current Hub; both shared-project and related-private-project collaboration follow in this pass. Actual acceptance, not a calendar target, determines completion.
- The owner now authorizes onboarding a second user and their Windows PC through an invitation and guided script. This supersedes single-user and #6/#37 deferrals. Distribution of a separate Hub installation (#11), full Canvas, global GPT-history search, additional native integrations and duplex voice remain outside this pass. Do not use GitHub Actions.
- Every user owns their Codex/GPT/GitHub identities, machine, native chats, drafts, usage, settings and notifications. Admin manages installation/access metadata but receives no implicit application access to private content or another user's terminal/Remote. Temporary machine delegation is deferred. Host administration remains with the installation owner; no end-to-end encryption claim is made.
- Safely migrate all existing personal state to the original owner, preserving identities, password, referenced files and uncertain operation receipts. Back up the stable installation before changing data or installing team changes; verify restoration separately. Never expose a second login to the existing unscoped services.
- The friend selects allowed project roots during PC enrollment; normal website project browsing cannot expand those roots. Use private Tailscale/system SSH and pinned machine identity, with admin approval before activation. Keep native credentials on the respective machine/profile and retain the local-only Companion.
- Separate logical shared Project from per-user Checkout. Every user keeps an independent Current/Previous Chat chain and Git state. Sharing never grants source-chat, machine or unpublished artifact access. Existing project materials are selected explicitly when sharing; new Notes/Tasks/Plans/Reports inside an already shared project are shared by default, with an explicit personal alternative.
- Use Viewer/Collaborator/Owner roles, attributed writes, revision conflicts and assignment-bound execution. Publishing findings must not silently publish their private source. A collaborator cannot change another user's Current Chat or execute work on their machine.
- Cross-user links require mutual consent. Automatic read-only consultation is explicitly authorized per link and bounded by depth/stop/early resolution. Implementation still requires the target user's explicit ordinary action.
- Each Bridge belongs to a chosen logical project. That project's owner supplies the coordinator Codex account/machine; other projects answer with their own accounts. Preserve bounded shared handoffs/decisions and exact receipts. A Bridge does not enlarge link permissions or automatically mutate repositories.
- GitHub project membership, repository access and individual GitHub identities remain separate. Typed actions cover invitations, Issues and PR coordination; never auto-merge, force push or copy tokens to the Hub.
- Build revocation, identity-preserving backup and access audit foundations with initial identity work, then verify full offboarding/re-add at the end. Preserve historical attribution and active/unknown receipts without replay. Engine maintenance considers every user's active work.
- Keep one responsive themed UI across PC, tablet and phone. Documentation and GitHub issues are the authoritative roadmap/tasks; do not duplicate this implementation backlog into personal application Plans.
- The owner explicitly requires continuing everyday work on stable `379fa17` until the replacement is ready. Develop team changes on an isolated branch/runtime/database; do not publish intermediate UI or migrate production while implementing. Prepare verified backup/restore and release admission checks before any cutover. Never acquire the owner's native writers through a staging copy.
- The friend's absence does not block implementation or fixture verification: finish the available work independently, then record the friend's real PC/account acceptance separately. Provide one guided installer/script with automatic prerequisite installation; native sign-in, Windows confirmations and folder selection are the only ordinary member setup steps. Do not label simulated checks as completed friend-PC acceptance.
- When inviting a participant or proposing a project Link, choose the person from an authenticated contact-style Hub user list, rather than typing a login. The list exposes only active users' display identity, never their private projects, machine, account status or content. This owner clarification supersedes the proposed login-only recipient flow.

## Owner-approved staged updates with recovery continuity (2026-09-13)

- The owner now permits installing verified stages before the entire team pass is finished, provided ordinary Codex work and the owner's ability to request recovery remain operational. This supersedes the blanket prohibition on intermediate publication; it does not authorize installing an unverified or incomplete working tree.
- Before each installation, verify the Codex connection/recovery path, preserve a restorable prior release and use the applicable gateway/engine maintenance guard. Never acquire an owner writer in staging or interrupt active native work merely to update. Explain actual installed and pending portions separately.

## Owner login and migration continuity (2026-09-13)

- The original owner's public team login is `eriark`; retain the existing password. `auth.ownerLogin` selects the first team login without changing the existing personal credential lookup in `auth.username`. Preserve the original owner ID after creation; a restart must not rename an existing account implicitly.
- The original owner bypasses new-user onboarding/setup wizards. Continue the existing machines, projects/chats, Codex identity, original GPT profile and machine-local GitHub login. Team activation must not replace these with empty member configuration or require reenrollment/native sign-in as part of migration.
- Member invitations/setup are for new users. After setup, everyone uses the standard `https://codex.abysstail.art` address; invitation/recovery links are not everyday login URLs.

## Owner-requested functional activation (2026-09-13)

- The owner now requests enabling as much of the verified prepared functionality as possible, including the login/password experience, on the current installation for evaluation without a second user. Replace the earlier team-disabled staged release with a verified first-owner team activation.
- Preserve the owner's existing session, native credentials/profiles, projects and ordinary Codex recovery. Do not force logout or run onboarding for the original owner. New-member registration remains closed until its separate admission checks pass; this does not hide the owner's shared-project/workspace modules.
- Activation still waits for native work through the maintenance guard. Verify the first-owner migration and rollback before public admission, save the prior configuration and retain failed registry state for recovery. Never silently use a single-database rollback for a previously enabled multi-user installation.

## Owner-requested interface consolidation and remaining-work audit (2026-09-13)

- Audit all issues and produce the remaining-work plan before further feature work. Continue in short verified passes; the current inventory and UI findings are in `docs/ISSUE_AUDIT_2026-09-13.md`, ordered by `docs/ROADMAP.md`.
- Shared projects belong in the same evenly styled shortcut row as Tasks, Notes, Plans and Reports. Use a short clear visible label (planned: «Общие») and a full accessible name; do not retain the separate oversized shared-project shortcut.
- Tasks, Notes, Plans and Reports each open as an independent popup window. Files and Git also use separate popup windows, superseding their combined support-pane placement. Reuse existing contracts/stores and shared window primitives; preserve project/checkout binding, drafts, scroll and active native work.
- Results show the whole project without the Dialog scope picker, in both Codex and GPT. Preserve exact source chat/turn identities and authorization for backlinks; project-wide presentation must not expose another user's private results.
- Audit existing as well as new forms and panels. Extend the physical casing/recessed-screen design consistently in CRT and Hi-Tech, including controls/cards/fields, while retaining Organizer/Classic Dark identities. Keep the approved dark matte CRT casing, light glossy exceptions and all surface-specific contrast rules.
- Phone windows use the available keyboard viewport with compact rims and reachable close/save controls. Larger screens use purpose-sized windows; avoid stacks of generic nested tabs, flat cards and oversized empty forms.

## Owner-requested tool-window layout and writable Files (2026-09-13)

- Recompose each independent window for its task instead of retaining a narrow support-pane column. Wide Notes/Tasks/Plans/Reports use a list and content area; Git gets a broad repository overview, and Files a proper folder-navigation/file-content layout. Compact clients retain a single usable view.
- Files starts read-only. An explicit lock control enables file management for the selected authorized project/checkout: create files/folders, rename, copy and move; deletion names the target and requires confirmation. Changing project or closing the window relocks it. The control must reflect real server capabilities, never a cosmetic unlock.
- Use typed authenticated operations through the existing machine transport, constrained to canonical project roots and the acting user's checkout. Preserve revision/conflict checks and uncertain-operation receipts; no caller shell commands, silent overwrites, credential transfer or public machine listener. This is an explicit extension of the former read-only Files inspector; Git mutations retain their existing separate review flow.
- Record writable file management with #169 and the Files/Git window pass. Its engine changes still require the coordinated enabled-Team upgrade/restore prerequisite in #158; compatible UI-only releases remain independent.

## Owner-requested window controls and accurate color previews (2026-09-13)

- Restore the earlier unframed icon/label appearance of the sidebar Tasks/Notes/Plans/Reports/Shared shortcuts. Keep their common row, placement and touch targets; do not turn them into individual raised keycaps.
- In CRT and Hi-Tech, tool-window headings and project/tool controls belong to the physical casing above the inset reading area. Project filters use a dropdown, replacing horizontal project-chip strips; retain All/unassigned scopes and bounded catalog pagination.
- Settings color swatches must preview the actual current-theme material using the same color/shading definitions as the installed casing (or actual accent in Organizer/Classic Dark). Preserve existing panel brightness, matte CRT darkness and glossy white/yellow/silver exceptions; change the swatches, not the panels.

## Owner-requested direct project tools (2026-09-13)

- Files and Git have separate icon-only buttons in the Codex header, each opening its own window directly for the selected project. This supersedes the combined header shortcut/menu. Keep equal square touch targets and preserve chat state.
- Remove the Settings button from the top bar in both Codex and GPT; Settings remains in the sidebar footer.

## Historical Canvas navigation follow-up (2026-09-13, cancelled 2026-09-20)

- On the next GPT Results pass, include existing Canvas documents as Results cards and open the existing document viewer from them. Remove the separate Canvas header shortcut. Keep exact private conversation/document identities. This is a deferred navigation task, not approval to expand into full Canvas authoring now.

## Owner-requested artifact links and large exports (2026-09-14)

- Prioritize #168 and the reported reader-case ZIP download. An assistant file/image link opens its exact object in Results/Preview, preserving mounted chat, draft, staged attachments and live output. Do not infer identity from a filename or navigate the browser to a local/native file URL.
- Saved Codex exports support up to 512 MiB through a bounded, checksum-verified machine-to-Hub stream and authenticated streaming HTTP downloads. Keep the aggregate storage quota and exact source snapshot semantics. Large downloads use browser downloads instead of a file-sized JavaScript Blob; small file previews/sharing retain their existing limits. Do not relax ordinary file-browser, upload, GPT or shared-publication limits as a side effect.

## Owner-requested everyday usage summary (#171, 2026-09-14)

- Show Codex usage and earned reset availability below the main Settings category list as well as in Connections. Reuse one settings-scoped canonical snapshot/poller per authorized machine and the existing confirmed, durable reset operation; category changes never spend a second reset or run hidden connection checks. Keep machine labels and zero/count-only/unsupported/unknown states distinct.

## Owner-requested unified Settings and PC Remote (2026-09-14)

- Codex and GPT open one shared Settings host, preserving form state across client switches. Appearance, sound/notifications, maintenance and access are common; Connections and project/history controls clearly separate Codex, GPT and machine-specific actions. Codex limits and earned resets are visible from the Settings overview in either client, using the same authorized machine data and confirmed reset flow.
- Both sidebar Remote shortcuts open the authorized Windows PC above the mounted current workspace. Prefer the selected Codex project's PC, use the sole available PC otherwise, and offer a machine choice when ambiguous. Preserve the current client, conversation, composer and draft; closing releases remote input and returns to that workspace. An unavailable PC must not silently connect to the server browser.
- The protected server ChatGPT browser lives in the GPT Connections zone as an explicit new-tab action. This supersedes the GPT sidebar's former `/gpt-connect?immersive=1` shortcut; retain recovery links and the existing private browser/session boundary.

## Owner-requested Linux ChatGPT priority (#193, 2026-09-19)

- Prioritize evaluating the official Linux ChatGPT client on the Hub. Prefer native local IPC; evaluate a native renderer adapter for missing operations. Keep the old connector, profiles, durable send receipts and ordinary Codex recovery intact until the replacement passes real-account acceptance. Record actual evidence in `docs/GPT_NATIVE_LINUX.md`.
- Use a separate private Linux runtime/profile, never copied Windows or old browser credentials. The owner has completed native sign-in and accepts the combined ChatGPT/Codex package if ordinary GPT works.
- Phone recovery uses laptop-style relative trackpad motion, tap at the current cursor, two-finger scroll, visible cursor and zoom, sharing the PC Remote gesture implementation. Native sign-in opens a system browser in that same protected desktop. Login, consent and bot challenges remain manual owner actions.

## Owner-requested reasoning-effort guidance (2026-09-19)

- Before each new work session or substantial stage, state the recommended reasoning level and a brief task-specific reason, so the owner can choose it before work begins. Also recommend the next stage's level when wrapping up. Do not claim to change the setting yourself.
- Group related implementation, integration and verification into a larger coherent work session. The owner finds individual small adapter proofs too short; finish a useful integrated stage before handing back, while preserving safe deployment boundaries and concise progress updates.
- Prefer the lowest level adequate for the work: low for straightforward edits and routine operations, medium for ordinary implementation and focused fixes, high for difficult debugging, architecture, authentication and data migrations; reserve very high/maximal levels for demonstrated exceptional complexity. Recommend increasing or decreasing effort when the scope changes, rather than keeping an expensive level for every task. Keep this guidance short; do not start an unrelated audit merely to choose a level.
- Name the exact web selector label and protocol value together. Its six-level order is Низкое (`low`), Среднее (`medium`), Высокое (`high`), Очень высокое (`xhigh`), Максимум (`max`), Ультра (`ultra`). `high` is the third option; do not conflate Extra High with Max or infer the current selection from an example screenshot of another chat.


## Owner-requested actual upload limits (2026-09-19)

- Remove the app's arbitrary 25 MiB per-file and 64 MiB per-message transfer restrictions from the new Codex/native-GPT path. Preserve user storage quotas, disk-space checks, attachment identity, checksums, private isolation and unknown-send receipts.
- Consumer ChatGPT documents the 512 MB file and 20 MB image ceilings; spreadsheet processing is approximately 50 MB and text/document processing is limited to 2 million tokens. Do not confuse these with API Uploads limits or invent a native Codex arbitrary-file ceiling: Codex receives verified local paths through the existing machine transport.
- Stream large files through bounded, acknowledged chunks and disk staging. A retry of an upload fragment must never authorize a second chat submission. Keep visible upload progress and stop private transfers on session termination.
- Preserve the old GPT connector/profile until native provider admission is complete. Repository upload support and disposable native acceptance are not evidence that the primary GPT workspace has switched providers.


## Owner-requested simpler GPT submission (2026-09-20)

- Ordinary GPT flow is send, then silently confirm delivery. Diagnose only an actual failure; do not gate sends on repeated UI/model-picker/hydration probes.
- Pass the selected model/effort explicitly to the native completion action. Retain exact account/conversation binding, draft preservation and durable at-most-once dispatch.
- Remove obsolete local failed/limbo send cards when the owner requests cleanup, preserving native conversation history and idempotency receipts. Never replay an uncertain send as cleanup.
- Verify the changed path with focused checks; do not repeat unrelated download or broad regression suites without a new reason.


## Owner-requested quiet recovery UX (2026-09-20)

- Recover transient connection/read failures quietly before asking the owner to act. Show manual recovery only after automatic recovery fails; suppress routine success/delivery-check banners.
- Never turn this into blind retries of sends, mutations, terminal input, permission changes or native sign-in. Keep existing identities, drafts, receipts and active work.
- Internal initial GPT outbox queuing is ordinary sending, not a user-visible waiting queue. Show waiting only for actual preceding work in the same chat.
- Recovery UX inventory and next actions: `docs/UX_RECOVERY_AUDIT_2026-09-20.md`.
