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
