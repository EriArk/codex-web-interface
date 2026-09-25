# CodexWeb

**A private, self-hosted AI development workspace for your own projects, machines and accounts.**

CodexWeb lets you work with native Codex, consumer ChatGPT, project files, GitHub, generated results, collaborators and Remote Desktop from one browser/PWA interface. It is built around a simple idea: **the Project is the center of the workflow; machines and AI runtimes are implementation details underneath it.**

The main target is iPad/iPhone/desktop use without spending the day inside a remote Windows desktop.

## What it feels like

A normal project can move through a flow like this:

```text
idea / Brainstorm
        ↓
   Project GPT
        ↓
 Prepare for Codex
        ↓
    Codex Work
        ↓
Files / Results / Review
        ↓
 Git / GitHub / PR
        ↓
Activity / collaborators / Intake
```

You can stay in the web app for most of that loop. Remote Desktop is there when you really need to touch the actual GUI.

## The mental model

CodexWeb deliberately separates a few things that are easy to blur together:

- **Codex** is the implementation agent. It works against a real project checkout and can edit/build/run through the configured execution machine.
- **Project GPT** is your private project companion for discussion, architecture, impact analysis and preparation. It does not silently become another code worker.
- **Project Intake** is a persistent read-only Codex lane for studying incoming Issues, PRs, Activity and feedback before handing reviewed work to the normal Project Work chat.
- **Results** are durable outputs: files, images, previews, generated artifacts and other things worth keeping separate from the conversation.
- **GitHub** is the engineering source of truth for repositories, commits, Issues, PRs and Reviews.
- **Collaboration Spaces** connect real users and real Projects without inventing a fake shared code project.
- **Brainstorm Rooms** are intentionally pre-project: board, chat, voice and a private room GPT, with an explicit path into a real Project later.

That separation is the core of the product.

## What is implemented

### Codex workspace

- Discover and open real projects and native Codex conversations.
- Continue the same native thread with streaming output, questions, approvals and interrupt.
- Native model/mode/reasoning controls and project-aware conversation rotation.
- File/image attachments with durable staging and recovery.
- Live work progress, command output, diffs, context and bounded history.
- Chat-bound one-time and recurring **Codex schedules** with timezone handling, queueing and no-blind-replay recovery.
- Project-specific behavior profiles and optional personal `CODEXWEB.md` rules without taking ownership of the user's `AGENTS.md`.

### Project workspace

Projects are more than folder shortcuts. A Project can carry:

- Project Core;
- Notes and Tasks;
- Plans and ordinary Reports;
- Review and Delivery state;
- Results and generated artifacts;
- Project GPT;
- Project Intake;
- Issue Drawer;
- repository identity and GitHub state;
- the user's exact machine/checkout/chat bindings.

**Prepare for Codex** turns settled Project GPT discussion into a reviewed package of docs/references/Issues, publishes it through explicit GitHub operations, then hands the exact result back to the Project without automatically starting implementation.

### Files and Git

The Files/Git workspace has grown into a real working surface rather than a read-only inspector.

Local/project files support:

- CodeMirror editing;
- search, line numbers, undo/redo and draft recovery;
- upload/download;
- create, rename, copy, move and delete;
- multi-select batch operations;
- explicit collision handling;
- folder merge with per-file decisions;
- private ZIP download of selected files/folders;
- durable operation receipts and recovery after lost acknowledgements.

The integrated GitHub file view can also edit the repository **without mutating the local checkout**:

- open and edit text files;
- create files/folders;
- rename/delete files or directories;
- create a branch;
- commit reviewed changes;
- open a pull request;
- recover uncertain branch/commit/PR operations without blindly repeating them.

GitHub permissions and branch protection remain authoritative.

### Universal file viewer

The same themed viewer is reused from Files, Git, Results and authorized shared files.

Current viewer families include:

- images;
- PDF;
- text/code/JSON/YAML/TOML/XML/CSV;
- Markdown;
- isolated HTML;
- sanitized SVG;
- STEP/STP and IGES/IGS;
- STL, OBJ, 3MF and GLB/glTF;
- DXF with layers and inspection guides;
- audio/video supported by the browser;
- ZIP navigation;
- DOCX content viewing;
- XLSX sheet/formula-value inspection.

These are inspection tools, not claims of full CAD/Office editing fidelity. Original bytes remain downloadable.

### Consumer ChatGPT / GPT

CodexWeb can connect a private per-user consumer ChatGPT runtime on the Hub and expose the useful parts of that account inside the workspace:

- chats and projects;
- model / effort selection;
- attachments and generated media;
- durable sends and recovery;
- history and Results projection;
- Project GPT and Brainstorm GPT bindings;
- native account operations supported by the pinned adapter.

Hub/browser history uses bounded incremental projections so unchanged messages, Results, scroll state, drafts and loaded images stay stable instead of being rebuilt on every refresh.

The native provider is intentionally version-pinned and fail-closed. It is not a generic proxy for undocumented account internals.

### Collaboration Spaces

CodexWeb supports a small trusted team while keeping each person's private workspace separate.

A Space can contain:

- several users;
- several real CodexWeb Projects;
- per-Project access policy;
- each participant's own checkout and AI accounts;
- one human Space chat;
- GitHub collaboration;
- a shared Activity view.

For full/direct access, GitHub Write can be granted through the owner's verified GitHub identity and accepted through the participant's own verified account. There is no owner-account fallback.

Participant working copies support managed provenance and safe upstream synchronization. Clean copies can be explicitly fast-forwarded or reconciled; conflicts and dirty work stop automatic mutation instead of being overwritten.

### Activity and attention

The Space Activity view is a compact collaboration timeline built from real sources rather than AI-written status reports.

It includes meaningful GitHub/project events such as commits, PRs, Issues, review state and supported shared-work events. It can:

- group related commits;
- filter by Project / author;
- reopen exact sources in the internal GitHub viewer;
- retain scroll/filter/cache state;
- attach lightweight reactions;
- hold short exact-source discussions;
- route addressed replies/review requests to Notifications;
- hand exact bounded evidence to Project GPT or Project Intake.

**Activity is for awareness. Notifications are for things that need attention.**

### Communication and Result sharing

Outside a Space, users can have private direct conversations and small group chats with:

- files/images;
- mentions;
- unread state;
- mobile messenger-style navigation.

A Result can be captured as an immutable shared material and granted to a person, group, Space or Brainstorm room without exposing the sender's private filesystem path or source conversation.

A shared Result can also be prepared for one of the sender's own GPT conversations without automatically sending a message.

### Brainstorm Rooms

Brainstorm is the place for ideas that are not Projects yet.

A room supports:

- a shared board;
- notes, links, files/images/PDF references and simple drawings;
- groups and links between cards;
- search and board filtering;
- common chat;
- lightweight voice;
- one private persistent GPT per user × room;
- immutable snapshots;
- export;
- reviewed conversion into a normal Project.

Turning a room into a Project reuses the ordinary Project setup flow and can carry selected shared context into the participants' own Project GPTs.

### Mobile, Remote and everyday UX

CodexWeb is designed as a PWA, not a desktop UI squeezed into a phone.

It includes:

- dedicated phone / tablet / wide layouts;
- preserved drafts and mounted workspaces across popups/views;
- four visual themes;
- contextual F1/help plus a searchable in-app guide;
- Ctrl/Cmd+Enter send shortcuts;
- dictation and read-aloud;
- push/in-app attention;
- device terminals and diagnostics;
- Guacamole-backed Remote Desktop with touch and trackpad-style controls.

Remote is intentionally a fallback for hands-on work, not the primary development interface.

## Architecture

The browser never talks directly to Codex, SSH, GitHub credentials or Remote Desktop services.

```text
                         Browser / PWA
                              │
                         HTTPS / WSS
                              │
                    ┌─────────▼─────────┐
                    │     Linux Hub     │
                    │                   │
                    │ Web/API gateway   │
                    │ auth + CSRF       │
                    │ project registry  │
                    │ private runtimes  │
                    │ SQLite + artifacts│
                    │ queues + receipts │
                    │ collaboration     │
                    │ GPT orchestration │
                    └──────┬─────┬──────┘
                           │     │
                  trusted  │     │ private
                  machine  │     │ provider
                           │     │
              ┌────────────▼─┐ ┌─▼────────────────┐
              │ Windows/Linux│ │ ChatGPT runtime  │
              │ execution    │ │ per user on Hub │
              │              │ └──────────────────┘
              │ native Codex │
              │ project files│
              │ git / gh     │
              └──────┬───────┘
                     │
                RDP/VNC via guacd
```

### Windows execution

Windows stays a normal user machine.

The Hub reaches it over trusted LAN/Tailnet using system SSH. Codex runs through the logged-in local Companion / private local IPC path rather than a public Codex listener. Fixed helpers perform bounded file/Git/GitHub operations. RDP/VNC is reachable only through the Hub's Remote gateway.

### Linux execution

Projects can also run directly on the Hub or another configured Linux execution target through the same Project model.

### Multi-user isolation

Each authenticated user gets a separate private runtime namespace for things such as:

- Codex/GPT bindings and queues;
- private SQLite state;
- artifacts/results;
- machine configuration;
- drafts and personal settings;
- private conversations.

Shared Team/Space state is stored separately. Being an installation administrator does **not** automatically make another user's private chats/files/Remote session readable through the product.

## Reliability and safety model

A lot of CodexWeb's code exists for the boring cases that happen after a request was sent but before the browser got an answer.

The project follows a few strict rules:

- **Exact identity over guessing.** User, Project, checkout, repository, branch, conversation and source object are bound explicitly.
- **No blind replay.** If an external mutation may have happened, its state becomes unknown and is reconciled before another write.
- **Durable receipts.** Important file, GitHub, AI and scheduling operations record intent/identity so reloads and restarts can recover safely.
- **Revision/fingerprint checks.** File and GitHub writes detect stale source/destination state instead of silently overwriting newer work.
- **Authorization is rechecked around asynchronous work.**
- **GitHub remains authoritative** for repository permissions, branch protection, PRs and Issues.
- **Only the Linux Hub is Internet-facing.** Windows SSH/Remote, guacd, native AI runtimes and storage stay private.
- **Guarded updates and backups** keep source verification, deployment and real-device acceptance as separate states.

See [Security](docs/SECURITY.md), [Maintenance](docs/MAINTENANCE.md) and [Verification](docs/VERIFICATION.md).

## Deployment

CodexWeb is currently an operator-managed private installation, not a one-click public SaaS package.

The normal shape is:

1. Linux Hub with HTTPS.
2. One or more explicitly configured/enrolled execution machines.
3. System SSH between Hub and remote machines.
4. Optional RDP/VNC + `guacd` for Remote.
5. Optional private consumer ChatGPT runtime.
6. Git/GitHub authenticated on the user's own execution environment where GitHub workflows are needed.

Start with [Deployment](docs/DEPLOYMENT.md). For adding another trusted user/machine, see [Friend quick start](docs/FRIEND_QUICKSTART.md) and [Windows enrollment](docs/WINDOWS_ENROLLMENT.md).

Do not expose Windows SSH/RDP/VNC, `guacd`, Codex App Server or SQLite directly to the Internet.

## Development

Requirements:

- Node.js 24.18.x
- pnpm 11.13.1
- system OpenSSH for real remote-machine work
- Chromium/WebKit tooling for browser regression tests

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm build
pnpm typecheck
pnpm lint
pnpm test

HUB_CONFIG=/absolute/path/config.yaml pnpm start
```

For loopback development, use `publicBaseUrl: http://127.0.0.1:8780` and disable secure cookies. Non-loopback deployments require HTTPS.

Copy [config.example.yaml](config.example.yaml) outside the repository and keep secrets out of Git.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/web` | React PWA: Codex/GPT UI, project workspace, viewers, Files/Git, collaboration, Brainstorm and mobile layouts |
| `apps/hub` | Fastify Hub: auth, private runtimes, SQLite, queues, Results, GPT, collaboration, schedules, storage and Remote APIs |
| `packages/shared` | Validated shared contracts and schemas |
| `packages/codex` | Native Codex App Server framing/compatibility layer |
| `packages/machines` | Local/SSH machine operations, file/Git/GitHub helpers and project inspectors |
| `ops` | Linux deployment, native GPT runtime, Windows Companion/helpers and speech setup |
| `tests` | Node integration/regression tests plus Chromium/WebKit product flows |
| `docs` | Product contracts, feature notes, verification records, deployment/security docs and historical audits |

The test suite intentionally mixes pure contract tests, real Hub/browser fixtures and bounded real-machine probes. Browser emulation is not treated as proof of physical iPhone/iPad behavior.

## Current boundaries

CodexWeb is already large, but it is deliberately not trying to become everything:

- It is a **private personal/small-team tool**, not a public multi-tenant service.
- It is not VS Code in a browser: no general LSP/debugger/extension ecosystem.
- Remote Desktop remains an escape hatch, not the main workflow.
- CAD/Office/archive viewers are for inspection; they are not full editors/converters. PowerPoint viewing is intentionally not part of the current viewer set.
- Native ChatGPT history is incrementally projected inside CodexWeb, but the upstream canonical native graph is still read as a whole.
- Managed collaboration copies do not yet provision a complete isolated test-service stack automatically.
- A polished standalone one-click Hub installer is still later work.
- Physical iPhone/iPad/PWA/audio/gesture acceptance remains separate from Chromium/WebKit regression coverage.
- The repository evolves quickly; an open GitHub issue may describe a larger ideal end-state even when most of the feature already exists.

For the freshest implementation-vs-remainder review, see [the latest backlog review](docs/BACKLOG_REVIEW_2026-09-24.md) and [Roadmap](docs/ROADMAP.md).

## Documentation map

If you only want to use the product:

- [In-app guide contract](docs/USER_GUIDE.md)
- [Mobile / iPhone UX](docs/MOBILE.md)
- [Workspace](docs/WORKSPACE.md)

Projects and AI:

- [Project behavior profiles](docs/PROJECT_AGENT_PROFILES.md)
- [Prepare for Codex](docs/PROJECT_PREPARATION.md)
- [Project Intake](docs/PROJECT_INTAKE.md)
- [Issue Drawer](docs/ISSUE_DRAWER.md)
- [Codex schedules](docs/CODEX_SCHEDULES.md)
- [Conversation bindings](docs/CONVERSATION_BINDINGS.md)

Files, viewers and delivery:

- [Writable Files / editor](docs/FILE_EDITOR.md)
- [File viewers / technical formats](docs/FILE_VIEWERS.md)
- [Project Review](docs/PROJECT_REVIEW.md)
- [Project Delivery](docs/PROJECT_DELIVERY.md)

Collaboration:

- [Collaboration Spaces](docs/COLLABORATION_SPACES.md)
- [Activity Timeline](docs/SPACE_ACTIVITY.md)
- [GitHub Write in Spaces](docs/SPACE_GITHUB_WRITE.md)
- [Managed checkout sync](docs/CHECKOUT_SYNC.md)
- [Communication / Result sharing](docs/COMMUNICATION.md)
- [Brainstorm Rooms](docs/BRAINSTORM.md)

Operations:

- [Deployment](docs/DEPLOYMENT.md)
- [Security](docs/SECURITY.md)
- [Maintenance](docs/MAINTENANCE.md)
- [Verification](docs/VERIFICATION.md)
- [Native ChatGPT integration](docs/GPT_NATIVE_LINUX.md)

## Project philosophy

The shortest version is:

> **Use AI as part of a real development workflow, not as a separate chat tab.**

CodexWeb tries to keep the useful things connected — project context, discussion, implementation, files, results, GitHub and people — while keeping authority explicit and recovery conservative.
