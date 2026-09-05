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
