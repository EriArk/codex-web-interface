# Codex Web Interface

Private AI-development workspace for iPhone, iPad and desktop. The browser talks to a Linux Hub while Codex, project files, Git/toolchains and native user identities stay on the configured execution machine or private runtime.

CodexWeb is Project-first rather than machine-first: Codex does implementation work, GPT can act as a private project companion, Results/Files/Git keep durable evidence beside the conversation, and Remote is available when direct GUI interaction is faster.

For the short current-status map, including what is implemented versus installed/accepted, start with [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md).

## Available now

- Authenticated personal workspaces with private stores, native identities, machines, Codex/GPT sessions, artifacts and background work.
- Automatic discovery of real Windows Codex projects and conversations; create a project or choose an existing folder from the website.
- Continue the same native Codex thread with streaming, resume, approvals, questions, interrupt, Work/Plan mode and model-specific reasoning effort.
- File and image attachments with preview/removal before sending. Up to eight files, 25 MiB each, 64 MiB per message.
- Paged chat history, durable drafts and mounted-workspace navigation that preserves active work.
- Results for generated files/images, checks, plans, diffs, links and other useful outputs; verbose execution detail belongs in Activity.
- Exact generated-file/image reveal inside the workspace instead of page reloads. Short text/code blocks stay inline; longer completed blocks become durable Results while keeping an exact source link in the message.
- Real consumer ChatGPT projects/chats through the user's private native/profile binding, including durable sends, files/images, editing/regeneration and project-bound GPT conversations.
- Tasks, Notes, executable Plans, Reports, Project Core, current-chat rotation, Review/Delivery and bounded project consultations.
- Files/Git with repository metadata, README/releases, system diagnostics, private device terminals and configured GUI previews.
- Native work progress, context/diff, live command output and bounded content search.
- Manual Remote Desktop through Guacamole: phone trackpad, tablet touch/stylus, pinch zoom and controls over the full landscape screen.
- Native dictation with waveform/timer, system or background read-aloud, account usage/resets and shared appearance/settings infrastructure.
- Independent web gateway and persistent execution engine with guarded updates, private snapshots, receipts, reconciliation and recovery.
- Invitation-only member admission and owner-enabled multi-user infrastructure with isolated personal runtimes.
- [Collaboration Spaces](docs/COLLABORATION_SPACES.md): explicit per-project access agreements, invitations, one human chat per Space, personal Project GPT, linked-project entry through each participant's own checkout and collaboration-aware Codex/Git delivery.

Collaboration Spaces also has real two-user usage now: a second user is connected, the basic shared flow works, and their own project copy can be created/connected and used for work. Disposable browser checks still cover regression/edge cases; broader polish remains separate from this basic real-user acceptance.

## Deployment

Choose your own hostname and Linux runtime directory. Supported deployment, first login and updates are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); snapshot/restore and diagnostics are in [docs/MAINTENANCE.md](docs/MAINTENANCE.md). [docs/RELEASES.md](docs/RELEASES.md) and [docs/VERIFICATION.md](docs/VERIFICATION.md) record exact baselines/evidence. Do not assume current `main` is already installed merely because source exists.

```text
Safari / PWA → HTTPS / Cloudflare Tunnel → Linux Hub
                                              ├─ private user/runtime state
                                              ├─ SSH / local transport → execution machine → Codex + Git/toolchain
                                              ├─ private GPT/native profile integration
                                              └─ guacd → LAN/Tailnet-only VNC / RDP
```

Use RDP where the Windows edition supports hosting it, or a configured VNC provider. Restrict SSH and Remote inbound rules to the Hub's LAN/Tailnet address. No Codex web listener runs on Windows.

Windows Codex execution uses a local-only Companion in the logged-in user session where required by the installed sandbox/runtime behavior. It exposes local IPC rather than a public network port. See [D17](docs/DECISIONS.md#d17--early-local-only-companion-for-windows-session-0).

## Development on the Linux server

Node 24.18.x, pnpm 11.13.1 and system OpenSSH are required. SQLite is provided by Node. Build and browser-test workloads run on Linux.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
HUB_CONFIG=/absolute/path/config.yaml pnpm start
```

Copy [config.example.yaml](config.example.yaml) outside the repository and fill in the machine/project paths. Optional Remote secrets are supplied through the deployment environment; website passwords are never stored in an environment file.

For loopback development, use `publicBaseUrl: http://127.0.0.1:8780` and `secureCookies: false`. Non-loopback deployments require HTTPS.

## Repository

| Directory | Purpose |
| --- | --- |
| apps/hub | Authenticated workspace APIs, private runtimes, SQLite, sessions/results, uploads, GPT orchestration, collaboration and Remote |
| apps/web | React mobile/wide PWA with shared workspace/navigation and semantic theme tokens |
| packages/shared | Validated configuration and stable client contracts |
| packages/codex | App Server JSONL RPC framing, cancellation and timeouts |
| packages/machines | System SSH/local transports, inspection and attachment staging |
| ops | Linux deployment plus Windows/native helpers |
| scripts | Explicit opt-in smoke and isolated browser checks |
| tests | Automated regression, isolation and browser checks |

## Documentation map

- [Current state](docs/CURRENT_STATE.md) — concise source/status map and the remaining major blocks.
- [Vision](docs/VISION.md) — current product model and enduring principles.
- [Architecture](docs/ARCHITECTURE.md) — runtime, trust and ownership boundaries.
- [Roadmap](docs/ROADMAP.md) — current milestone first, then dated implementation history.
- [Security](docs/SECURITY.md) — security and authorization invariants.
- [Collaboration Spaces](docs/COLLABORATION_SPACES.md) and [Team Workspace](docs/TEAM_WORKSPACE.md) — current shared-work UX and private-runtime model.
- [Verification](docs/VERIFICATION.md) / [Releases](docs/RELEASES.md) — exact evidence and installed baselines.
- [Decisions](docs/DECISIONS.md) and dated audits — historical reasoning; they should not be read as the current status shortcut.

Physical Safari/PWA acceptance remains separate from Chromium/WebKit fixture coverage. Additional large features such as the Technical Viewer, writable file editor, Codex chat scheduling, broader GitHub collaboration surfaces and Brainstorm are tracked in the roadmap/issues rather than being implied complete here.
