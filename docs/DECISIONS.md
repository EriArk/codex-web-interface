# Architecture and Product Decisions

This file records decisions that should be treated as fixed unless the owner explicitly changes them.

## D01 — Linux Hub is the only Internet-facing machine

**Decision:** The public website/API lives on the Linux server. Execution machines are not exposed directly to the Internet.

**Consequence:** Public traffic terminates at the Hub. The Hub reaches execution machines over LAN or Tailnet.

---

## D02 — Primary v1 execution machine is native Windows

**Decision:** The first remote target is the user's Windows PC on the same local network as the Linux server.

**Consequence:** Windows behavior is not an afterthought. Command quoting, executable resolution, path handling, SSH behavior and GUI-session limitations must be tested on real Windows early.

---

## D03 — Remote Codex uses SSH + stdio

**Decision:** For v1, the Hub starts Codex on Windows through OpenSSH and talks to `codex app-server` over stdio.

**Why:** This avoids exposing a Codex network service on the PC and lets the existing Windows Codex environment/toolchain stay where it is.

**Consequence:** The Hub needs a robust Windows command launcher and Codex protocol adapter.

---

## D04 — Browser never talks directly to raw Codex App Server

**Decision:** Browser <-> Hub uses our own stable API/event contract.

**Why:** Codex App Server evolves independently. Keeping a compatibility boundary prevents protocol changes from leaking throughout the frontend.

---

## D05 — Local Linux Codex is a first-class backend

**Decision:** The Hub can also spawn Codex locally for projects that live on the server.

**Consequence:** UI behavior must not depend on whether a project is local or remote.

---

## D06 — Project is the primary object

**Decision:** Navigation is project-first. A project maps to a machine and absolute working directory.

**Consequence:** The user opens `Case Maker`, not `Windows-PC -> C:\...`.

---

## D07 — iPad 13 landscape is the reference wide UI

**Decision:** Primary wide-workspace client is a 13-inch iPad in landscape, preferably installed as a standalone PWA.

**Consequence:** Touch-first behavior, independent pane scrolling, software keyboard handling and safe areas are core requirements, not polish.

---

## D08 — Three-zone layout for wide workspace

**Decision:** Main landscape layout is:

```text
Navigation | Codex Chat | Results / Files / Activity / Remote
```

Chat remains clean. Results are a separate chronological feed.

This layout is for sufficiently wide workspaces. It must not be blindly compressed onto iPhone.

---

## D09 — Remote Desktop is embedded and secondary

**Decision:** Remote appears as a mode of the right pane on wide layouts and can expand fullscreen.

On mobile, Remote becomes the primary full-width workspace view while active rather than being placed beside Chat.

Preferred transport is Windows RDP through Apache Guacamole when the Windows edition supports RDP hosting. The provider remains abstract so VNC or another Guacamole-supported transport can be substituted.

---

## D10 — Do not assume SSH shares the interactive Windows desktop

**Decision:** Processes launched through Windows OpenSSH are treated as non-interactive relative to the user's visible desktop.

**Consequence:** v1 must not promise that GUI apps launched by SSH-hosted Codex appear in Remote Desktop or can be automatically screenshotted from the SSH process.

---

## D11 — No custom Windows network agent in v1

**Decision:** v1 does not require a custom daemon/listener on the Windows PC.

**Future option:** A local-only Windows Companion may later run in the logged-in user session to launch/capture GUI applications. It should communicate locally (for example named pipes) and expose no network listener.

---

## D12 — Hub storage uses SQLite + filesystem

**Decision:** Single-user Hub metadata lives in SQLite. Binary results/artifacts live on the Hub filesystem with metadata in SQLite.

**Consequence:** Do not introduce PostgreSQL/Redis/object storage without a demonstrated need.

---

## D13 — Single-user authentication

**Decision:** There is no public registration or multi-user permissions model in v1.

**Still required:** strong password hashing, session security, rate limiting and normal web protections.

---

## D14 — One UI implementation, multiple themes

**Decision:** Organizer, CRT and Hi-Tech themes are skins of the same component tree and semantic tokens.

**Consequence:** Do not fork page implementations by theme. Theme decoration may be reduced on narrow mobile screens to protect usable area.

---

## D15 — Platform features are incremental

**Decision:** Notes, Plan, Machines, Files, Git and similar modules are desirable, but the first milestone is the remote Codex workflow.

**Consequence:** Architecture should leave extension points without forcing all modules into the initial implementation.

---

## D16 — iPhone is a first-class mobile client

**Decision:** iPhone support is required. It is not a generic responsive fallback or a later desktop-shrinking exercise.

The phone uses the same Hub/backend, projects, threads, results and authentication, but a dedicated mobile information architecture:

```text
Project/thread sheet
        +
Chat | Results | Remote
(one primary view at a time)
```

**Consequences:**

- portrait iPhone must support the full core Codex workflow;
- projects/threads use a sheet/drawer instead of a permanent left column;
- Chat is the default mobile workspace;
- Results is a separate full-width feed;
- Remote uses the full available workspace while active;
- Files/Activity may be secondary/overflow screens on narrow widths;
- Safari and standalone PWA modes must both work;
- iOS keyboard, safe areas, rotation, suspend/reconnect and touch behavior must be tested on real hardware;
- responsive behavior should use available layout width, not user-agent/device-name sniffing.

See `docs/MOBILE.md`.

---

## Deployment choices intentionally left configurable

These are not architecture blockers and should be configuration, not hard-coded assumptions:

- public hostname/domain;
- Windows LAN IP/hostname;
- Windows username;
- Windows edition and therefore preferred Remote provider;
- exact project paths;
- SSH key path/host alias;
- local Linux project paths;
- idle timeout values;
- whether Tailnet transport is enabled later.

## D17 — Early local-only Companion for Windows Session 0

The owner approved bringing forward the local-only Companion after a real read-only command failed under the SSH-hosted Codex sandbox (runner pipe timeout / Windows application initialization failure). The same sandboxed command succeeds in the interactive session.

The main flow remains system SSH and stdio. A fixed bridge forwards it to a local named pipe; a limited user-session task starts the configured Codex App Server with an allowlisted working directory. Remote pipe clients are rejected by the Windows pipe API. No Codex TCP listener, generic command endpoint or copied authentication is introduced. This overrides only D11's timing, not its prohibition on a custom network agent. Visible GUI automation remains outside this release.

## D18 — Password-only enrollment and bounded history

The first password is chosen by the owner, not set by deployment scripts. A private one-use link prevents public first-visitor account takeover. Later login asks only for the password. Hub storage uses Argon2id and opaque server-side sessions.

Initial history contains 20 latest messages. The explicit older-history button fetches another 20 and preserves the reading position. Reconnect uses an event cursor and falls back to a bounded snapshot when the backlog is large. Result-to-turn navigation fetches a bounded context page.

## D19 — Per-thread Codex controls and uploads

Model choices, reasoning effort and Work/Plan mode are required in the initial release. Discover supported values from the configured Codex backend and validate them at the Hub. Use the native collaborationMode protocol, including its built-in mode instructions, rather than simulating planning with a user prompt. Save choices per thread.

Files/images are attached to a draft, can be removed before sending, and remain private behind the same auth boundary. Originals live on the Hub, with generated JPEG previews for supported raster images. Transfer files through system SSH to a generated private directory on Windows; use localImage for vision and absolute file references for other formats. The browser never supplies an arbitrary destination path.

## D20 — Native project discovery and continuity

The owner requested automatic access to real desktop projects and conversations plus project creation from the website. This brings native catalog discovery forward from the original roadmap. Use App Server project APIs and metadata-only thread discovery, with stable Hub mappings and bounded native history. Keep one App Server per machine, launched through the existing configured seed directory. No broader Companion API is introduced. See [sync behavior](SYNC_AND_REMOTE.md), including the separate desktop saved-folder list and lack of coordination for concurrent clients editing one thread.

## D21 — Phone trackpad and reference-based themes

The owner requested phone trackpad input, tablet touch/stylus, unobstructed landscape Remote and faithful treatment of the drawn references. Use one Pointer Events controller and floating controls; connected compact Remote removes navigation and decorative frames. Theme identity comes from paper/binding, CRT housing and light silver/cyan hardware, using the same feature markup. Physical iOS checks remain an explicit validation requirement.

## D22 — Native writer conflicts are explicit

A real Codex 0.153.4 Windows probe established that the desktop App Server can retain a paginated conversation writer while idle. The separately launched Hub App Server cannot resume that thread until the writer is released. Unix daemon proxy transport is unavailable on this installation, and the configured Companion remains limited to App Server stdio.

Return HTTP 409 with a readable message, preserve the draft, and offer an optional explicit fork of completed native context. Use a new native thread ID, retain pending attachments on the original, copy them privately to the fork, and require the user to press Send for the new draft. Never auto-fork, auto-retry an uncertain send, stop the desktop or modify private desktop state to fake same-thread continuity. See SYNC_AND_REMOTE.md for the concrete limitation.

## D23 — Project trees, useful results and compact typography

The owner requested expandable project/thread trees and a separate list of projectless conversations. Use virtual per-machine Hub buckets for unmatched native conversations, preserving their actual cwd; never create native projects just for navigation.

Show turn progress and pending choices next to the composer. Keep code and commands behind disclosures; show loaded image results first. Use locally bundled Roboto Condensed in organizer/hi-tech, sharp monospace in CRT, shared mobile spacing and 44px touch targets. Small visible parameter captions overlay full-size native selects so the selector text can be compact while keeping native picker/accessibility behavior.

## D24 — Web as the primary client

The owner clarified that the completed website will be the only primary client. Windows runs Codex through the independently scheduled local-only Companion; keeping desktop ChatGPT/Codex open is not a dependency. This supersedes D22's copy-first UI fallback: preserve native IDs and drafts, explain the one-time desktop exit needed to release an existing writer, and expose a same-thread access retry. Do not forcibly quit an active desktop task. The Hub retains loaded writers between turns, with existing idle teardown and restart recovery.

A version manifest tied to the built JavaScript and stylesheet assets lets a long-lived mobile page offer an explicit update. Never auto-reload an in-progress draft or upload. The HTML, service worker and manifest use no-store headers; private API responses remain outside service-worker caches.

## D25 — Read-only activity across App Server processes

Windows Codex 0.153.4 returns runtime `notLoaded` and maps an externally running persisted turn to `interrupted` in `thread/turns/list`. A native read probe compared this with the desktop's active state and the raw persisted `inProgress` value. Consequently Hub turn notifications alone cannot describe desktop activity.

An optional administrator-configured `machines[].codex.activityNode` enables one fixed metadata query via the existing system SSH transport (or a local process on Linux). Node must support node:sqlite. The home comes from App Server initialize, IDs from the Hub catalog, queries open state_5.sqlite and thread_history_1.sqlite read-only/query-only, and output contains only latest turn IDs/status/timestamps. No private desktop state is mutated, no prompts/items/auth data are copied, and no Companion API or network listener is added. This is a narrow read-only compatibility adapter, verified against 0.153.4; unsupported schemas report unavailable observation.

The shared poll runs every four seconds while navigation clients are connected, with one in-flight request per Hub and at most 3000 known threads per machine. Native catalog refresh has its own cache. Hub-owned loaded writers retain structured event priority. Ten-minute-stale unfinished metadata becomes unknown; failure never fabricates completion. First observed historical completions start read. Subsequent terminal changes create the same durable unread receipts as web turns. Cached observations survive browser/Hub restarts. Native completed context is read/resumed before web work; known external activity is rejected before turn/start.

## D26 — Native message queue and explicit Steer

Use App Server thread/queue APIs for the durable queue, including cross-client list/add/update/delete and automatic continuation. Hub does not duplicate normal queue execution. Queued messages inherit the native thread's current model/mode settings. The web composer accepts text and attachments during a turn; queue entries expose edit/delete/Steer and survive page closure.

Steer requires a Hub-owned loaded writer and the exact expected turn ID. Native turn/steer does not consume its queued entry. Before transferring, keep a durable Hub recovery record, delete the native queued item only if deletion is confirmed, then steer. A completion/dequeue race never steers the next turn. Unknown outcomes retain the text for inspection/manual recovery, with no automatic resend. While another App Server owns the turn, native queue operations remain available; steering and interrupting that process are not supported. Native queued user messages are normalized into the live chat, including attachment identity.

Core protocol failures, unsupported methods, offline transport and expired native login stay distinct. Optional Plan/config reads degrade only on explicit method-not-supported; no silent Work substitution for a selected Plan request. Runtime identity/version is included in capabilities; unverified versions display a compatibility note.


## D27 — Render structured native image attachments

The owner requested images in place of desktop attachment paths. Register only structured native localImage references or bounded inline raster image data from the paged history, returning opaque authenticated Hub image URLs. The browser cannot submit arbitrary filesystem paths or remote URLs. A fixed system-SSH read copies a raster source of at most 8 MiB; decoding/resizing runs on Linux, one image at a time. Cached normalized PNGs use the existing ResultStore artifact files and backup contract. Never rewrite native messages.

The displayed text removes only the known desktop file wrapper corresponding to its structured image references. Other text and unrelated file references are preserved. Both native and web-uploaded images display useful-sized previews in the message and open in a touch-accessible viewer. Missing sources have a retry action. Image fetching is lazy and does not load older chat pages.

Unconfirmed native queue additions also retain a Hub recovery record and bound attachment metadata. Observing the matching native queued item/user message reconciles that record; it does not resend the message.


## D28 — Explicit desktop restart from Settings

The owner requested a Codex restart button. Optional machines[].codex.desktopControl points to the installed fixed PowerShell control script. Hub exposes authenticated status and confirmed restart endpoints, never process IDs, executable paths or caller-supplied commands. System SSH invokes only Status/Restart with a UUID. A demand-only Scheduled Task launches its fixed action using the owner's Interactive logon, Highest run level (needed for administrator-launched Codex), and IgnoreNew. Its private user/SYSTEM/Administrators directory contains fixed scripts/config and one latest operation record. No network listener or Companion change is added.

The task resolves the installed OpenAI.Codex package for the pinned family and current owner. It closes only that package's UI and captured direct native App Server children, checking creation identity before forced exit. Companion-owned native processes remain separate. Relaunch occurs in the same nonzero interactive session. State is queued/restarting/completed/failed/unknown; completion requires observing the new desktop process. Stale requests never execute after a later login; uncertain outcomes are read back, never replayed automatically.

Hub checks its own active turns. Windows independently queries all non-archived native latest-turn metadata read-only (bounded to 10000 threads), applying D25's ten-minute freshness rule. Active or unreadable state blocks restart. The task repeats this check immediately before close and before forced exit. A desktop task beginning during the narrow close window cannot be coordinated atomically through the current protocol; use this explicit maintenance action between tasks. No automatic restart on errors or writer conflicts is introduced.


## D29 — Per-conversation access

Normal access uses workspace-write/on-request; explicit full access uses the native :danger-full-access profile and never approval policy. Hub checks permissionProfile/list and configRequirements/read before accepting full access. Missing/denied capabilities fail closed. The choice is stored with thread settings, applied on native start/resume/turn start and changed for future turns through thread/settings/update when the Hub owns the loaded thread. A native settings notification reconciles accepted changes if the request acknowledgement is lost. An active external writer cannot have its defaults changed. Forks start with normal access. Global configuration and already-pending approvals are never rewritten or automatically accepted.

The composer exposes only “Обычный доступ / Полный доступ”, with a distinct full-access state. This is the owner's requested opt-in native policy control, not an application authentication bypass.

## D30 — Explicit desktop handoff and hard recovery

The owner extended D28 with a separate hard restart and manual client handoff. A persisted per-machine desktop/web selection belongs to Hub preferences, writable only through the authenticated dedicated client endpoint. Desktop handoff refuses active/unknown Hub tasks and in-flight writes, closes the selected machine's loaded App Server connection and blocks create/resume/send/settings/queue mutations until explicit return. Read-only discovery may reconnect without loading a writer. No desktop state files are edited and native thread IDs remain unchanged.

The hard restart endpoint requires confirmStopTasks=true, CSRF/Origin, a UUID and bounded request rate. It first puts the machine in desktop mode and disconnects its Hub App Server; the existing Companion job object tears down that process tree when the pipe closes. The fixed Windows Scheduled Task accepts ForceRestart in addition to ordinary Restart. Only this explicit hard action skips activity checks and the graceful-close wait; process/package/owner/session identity checks, expiration, cooldown and duplicate protection still apply. It closes only the configured desktop package and its captured direct App Server children. Companion and unrelated Codex processes remain intact. The user explicitly returns control to the website afterwards. No generic PID/command API is exposed.

## D31 — Resilient attachments, visible Steer and compact progress

Windows attachment staging now uses a newline-framed base64 payload with an exact expected length. Windows OpenSSH can keep standard input open after client EOF, so ReadToEnd is not a valid completion signal. A staging failure occurs before user input reaches Codex; it preserves unbound attachments and releases the idempotency key for an explicit retry. Unknown outcomes after native submission remain protected from replay.

A confirmed Steer retains a “Принято” card in the queue until the matching native user message is observed. It cannot be edited/deleted/resubmitted as a queued item after acceptance. Matching native events reconcile the receipt, including the event-before-ack race. Lost acknowledgements retain the existing explicit recovery behavior.

The status row toggles a small scrollable recent-work panel. The Hub contract returns at most eight recent steps from bounded event queries, scoped to the selected turn. Commands start collapsed. Only item/reasoning/summaryTextDelta and completed reasoning.summary enter this view; raw reasoning text/content is ignored. Summary snapshots are bounded and throttled, and the panel polls only while open and visible. The newer-message navigation button stays inside the chat viewport so it does not cover queue controls.


## D32 — Native usage and task boundaries

Settings reads account/rateLimits/read through the existing machine transport. The stable Hub response contains only group labels, bounded window durations, remaining percentages and reset timestamps. Weekly means 10080 minutes and can occur in either the primary or secondary slot. Prefer the main codex bucket and retain additional named buckets in collapsed sections; do not infer unavailable values or expose credit/billing fields. Read-only usage checks remain possible after desktop handoff and do not acquire a thread writer.

Conversation separators mark the end of a finished turn, including interrupted/failed boundaries without describing them as successful. Do not split multiple messages or accepted Steer input within the same active turn. Native thread/turn IDs and pagination remain unchanged.

## D33 — Confirmed active handoff and verified return

The owner approved stopping an active turn before transferring the same native conversation. This extends D30: the ordinary idle handoff still refuses active work; an explicit confirmInterrupt=true requests native turn/interrupt for each known Hub-owned active thread. New writes are gated before interruption. Hub waits for native completion events before closing its App Server connection. Unknown ownership or in-flight input refuses handoff; a stop timeout retains the writer and reports pending rather than forcing teardown. Queue entries are preserved.

Retry corresponds to thread/resume, which loads the existing conversation but does not start a new turn. Explicit user input continues from saved context. Installed Windows Codex 0.153.4 has no supported live writer transfer. Ordinary mobile ChatGPT chats do not participate in this native writer connection; official Remote does.

Returning to web while the desktop is running requires releaseDesktop=true and confirmStopTasks=true. The fixed Scheduled Task accepts ForceRelease: attempt graceful desktop close, then stop only captured package/session/owner-matching processes and their direct native children if needed, without relaunch. Companion-owned processes are excluded. No generic command or PID endpoint is introduced.

Hub persists the operation ID before dispatch, blocks writes while returning, and enables web mode only after a matching completed DESKTOP_RELEASED result and running=false. Bounded background status polling completes an accepted return even if the browser disconnects or Hub restarts; uncertain requests are never replayed. Failed or expired operations leave desktop mode in place. Hard restart invalidates an old pending return. The website still acquires a conversation writer only on an explicit write/resume operation.

## D34 — Reference materials and classic dark

The owner requested stronger CRT character and a fourth classic dark theme. crt-green uses unmodified IBM Plex Mono Regular/SemiBold 2.5.0 WOFF2 fonts from the official IBM package (complete font files with Cyrillic support, SIL OFL shipped with provenance). Only the two font assets are bundled, with no package runtime/scripts; they total 99,848 bytes and load from the Hub on demand. Existing organizer/hi-tech and classic-dark use Roboto Condensed.

Static raster/glass backgrounds sit behind pane contents; bounded text/edge shadows provide phosphor glow without filtering or transforming glyphs, images or the desktop canvas. Inputs and expanded code remain unglowed. Increased-contrast/forced-colors preferences disable raster and text glow. Compact Remote keeps its entire viewport.

classic-dark uses graphite surfaces and quiet blue-gray accents without hardware bezels or texture. Frontend theme metadata drives the same picker and browser chrome color. Hub preferences allowlist includes the fourth ID; validated local cache applies before React renders login/loading, and authenticated preference loading remains authoritative. Existing native workflow, authentication and storage schema are unchanged.

The owner subsequently requested another review of the other references, especially Hi-Tech 2000s. Hi-tech now uses neutral silver chassis surfaces, dark seams, inset display edging, chrome bevels and concentrated cyan highlights on selected controls rather than a blue wash across every surface. Wide-only screw/vent details stay outside the working content. Organizer keeps its existing warm paper/binding/tab structure with lighter pages, oval rings and restrained message fills. Compact layouts reduce chassis decoration; all four themes retain the shared functional markup.

## D35 — Binary attachment staging over system SFTP

A real 1 MiB attachment reproduced UPLOAD_TRANSFER_TIMEOUT in the previous PowerShell console-stdin transfer, although tiny image fixtures passed. Use the installed OpenSSH SFTP subsystem for file bytes over the same private SSH connection. Codex remains stdio through SSH/Companion; no listener, credentials or public port is added. PowerShell only creates the generated destination and verifies/finalizes the file.

The SFTP batch contains quoted absolute local/Windows paths, with control characters rejected. Upload into a generated temporary file, verify native byte length and SHA-256, then move to the generated final name. Validate the acknowledgement before adding a native localImage or file reference. The whole attachment preparation shares a 40-second deadline; failed partial transfers get bounded cleanup. Preparation failures return a specific 503 JSON response before the former 60-second gateway timeout, release protected files/idempotency state and leave text/files available for an explicit retry. No prompt is automatically replayed.

Remove the duplicate chat-pane heading/status and keep the top connection label about connectivity. The existing composer progress control remains expandable and shows attachment transfer while sending files.

## 2026-09-06 — Optional real-account ChatGPT browser backend

The owner requested a complete GPT mode with existing chats, files, image generation and actual model selection, and approved a ready browser integration. Consumer ChatGPT does not provide the Codex App Server transport used by the Windows execution backend. GPT therefore uses an isolated, persistent Linux Chromium profile with owner-performed login. The Codex/Companion path remains independent.

The optional connector runs the MIT-licensed chatgpt-bridge extension/runtime pinned at 96802cc0d2ea0b7449cf465f8adb3c228decd297. This revision precedes an unavailable optional ZIP dependency. Only the browser bridge, file store and HTTP adapter are loaded. Compatibility patches require successful attachment preparation and support the current native model/power menu. Canonical readback confirms completed image-only turns and supplies protected image bytes.

The browser profile and connector secrets stay on the Linux host. Public clients use the authenticated Hub API and a protected Guacamole connection page. Jobs are durable and serialized; browser disconnects do not cancel them. Uncertain native submissions require explicit review and are never automatically replayed. Public output is whitelisted; hidden reasoning and adapter diagnostics are discarded.

The shared web shell provides native chat history, send/progress, file/image input, model/power selection and image results. The protected original ChatGPT interface remains available for account controls and other native workflows. Consumer UI changes can require adapter updates; exact UI parity is not assumed.

## Interactive self-contained HTML Results (2026-09-06)

The owner requested the interactive design studies used in TrainerOs. Support them as authenticated, bounded HTML artifacts with an opaque-origin sandbox, sourced from structured HTML resources/file changes or explicit assistant HTML blocks/local file links. Keep Windows private and fetch only within the selected project. This is an artifact viewer, not a general reverse proxy to development servers. Native chat order is authoritative; the live Hub supplement inserts only unpersisted messages at matching sequence anchors and must not promote older-page records to the tail.

## GPT continuity and public progress (2026-09-07)

Retain the visited GPT pages, native job state and reader position across chat/client switches. A bounded same-tab session cache restores the view after a brief navigation or reload; it is used only after Hub authentication, expires after 30 minutes and is cleared on logout or a rejected session. In-flight responses cannot repopulate a cleared cache or overwrite a newer request. No account tokens, signed asset URLs or private native records enter this cache.

The Hub coalesces canonical history reads and keeps only normalized public messages in a bounded memory cache. Latest-page requests carry a revision and a prefix fingerprint. Unchanged history returns no messages; ordinary completion retains explicitly loaded older pages, while a native branch edit invalidates an incompatible prefix. First reads and older-page fetches remain 20 messages. Background revalidation updates native changes without clearing the pane.

Persist up to 24 short public progress labels per Hub GPT job in schema 6. Accept only structured DOM-observation items from the pinned adapter's visible cot/shimmer/transition controls. The expandable composer panel retains prior stages; completed stages remain collapsible near the answer. Raw thinking snapshots, native analysis/thought content, tool internals and diagnostics remain excluded. Some native models expose only a generic Thinking label; do not fabricate a more detailed reasoning trace.

## Release notices use the booted build identity (2026-09-07)

The build writes one deterministic fingerprint of all bundled JavaScript/CSS filenames to both HTML and version.json. Compare this identity rather than the styles currently mounted in the DOM: lazy GPT CSS is absent in an ordinary Codex view and previously caused a permanent false update notice. Explicit update navigation preserves URL state and drafts, adds a temporary cache-busting release marker, and confirms the target identity after boot. A stale/offline document retains a retry notice; an actual updated document briefly confirms success and removes the notice. Do not unregister the service worker or clear the owner's application data.

## Desktop preparation on handoff (2026-09-07)

The owner extended the explicit Settings handoff with desktop launch, maximization and selection of the current native conversation. Hub resolves an optional authenticated Hub thread ID against the selected machine before releasing writers, then sends only the native UUID through the existing SSH control to the demand-only interactive Scheduled Task. The installed OpenAI.Codex 26.901.5280.0 package registers the codex protocol and handles codex://threads/<UUID> as a local conversation route; this compatibility path was verified in the installed package, not inferred from an API endpoint. No desktop state files are edited.

Open never closes a process or checks active work as a reason to stop it. A second launch forwards the validated link to the existing app. Window activation is restricted to the configured package, owner and interactive session. Completion requires a visible maximized window; foreground denial is reported separately. No thread-navigation acknowledgement is available from the native URL handler, so the result confirms window preparation and link delivery, not an in-memory turn transfer.

Handoff remains in desktop mode if opening fails. Read-only status recovers the result after browser loss; an explicit Open retry is available. Pending or uncertain Open blocks return to web so a delayed scheduled launch cannot grab a newly acquired writer. The existing expiry, single-task lock and idempotency guards remain. No network listener or generic launch endpoint is added.


## 2026-09-07 — Native navigation actions and shared menus

Chats and projects expose Pin, Rename, Archive and Delete in that order. Delete requires a named confirmation and uses a red action. A shared dialog/menu supplies touch and keyboard behavior in both modes.

Codex chat names, archive state and deletion use App Server methods; project names/deletion use its project catalog. Deleting a project detaches chats and never calls a filesystem deletion method. The installed 0.153.4 schema has no isPinned field in thread/metadata/update, even though newer public docs describe it, so pins live in Hub SQLite. Whole-project archiving is a reversible Hub view preference for both clients. Archived native Codex threads are read in pages of 20; their queues cannot be read until unarchived.

An empty Codex thread may have no native rollout yet. Its archive is a Hub preference until it contains a message. After a connection restart, only a provably empty, web-created placeholder with no messages or queue transfers may receive a new native placeholder ID. Existing conversation history never takes this path and prompts are never replayed.

ChatGPT chat archive, rename and deletion and chat/project pins use the current consumer client's native contracts. Project rename preserves instructions, emoji and theme while changing its name. Project deletion uses the native API and deletes its chats/files. The native ten-item pin limit is retained, without evicting existing pins.

Schema 7 adds library_entities, private Hub metadata for pins, project archives, names and deletion tombstones. Tombstones prevent stale browser/catalog snapshots from recreating deleted entries. All mutations use authenticated Hub routes, strict allowlists and idempotency keys. Active/queued/uncertain work blocks destructive changes; queue writes are serialized with catalog changes. Source files, authentication credentials and execution topology remain unchanged.

Validation includes disposable native Codex project/chat lifecycles, empty-chat reconnect, a disposable ChatGPT project/chat lifecycle, native pin-limit rejection and unpin, mock race/guard tests and Chromium/WebKit phone/tablet visual checks.
