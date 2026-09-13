# Codex Web Interface

Private Codex/GPT workspace for iPhone, iPad and desktop. The browser talks to a Linux Hub; Codex and project files stay on the configured execution machine. The current installation includes owner-enabled [private team workspace](docs/TEAM_WORKSPACE.md) functionality; registration of additional members remains closed pending independent-account and isolation acceptance. See [the current issue and interface audit](docs/ISSUE_AUDIT_2026-09-13.md) for what is installed, unfinished and planned.

## Available now

- Authenticated access: initial personal enrollment uses a private single-use setup link; the migrated owner uses their login and existing password, preserving native accounts and workflow. Member invitation/setup remains a separate admission step.
- Automatic discovery of real Windows Codex projects and conversations; create a project or choose an existing folder from the website.
- Continue the same native thread, with streaming, resume, approvals, questions and interrupt.
- Live model discovery, native Work/Plan mode and model-specific reasoning effort, saved per thread.
- File and image attachments with preview/removal before sending. Up to eight files, 25 MiB each, 64 MiB per message.
- Latest 20 chat messages on open; an explicit button loads 20 more without moving the reading position.
- Results for file changes, checks, plans and Remote screenshots; detailed commands in Activity.
- Manual Remote Desktop through Guacamole: phone trackpad, tablet touch/stylus, pinch zoom and controls over the full landscape screen.
- Dedicated single-view phone shell, adaptive wide layout, PWA manifest and four shared themes.
- Real consumer ChatGPT projects/chats, durable sends, files/images, editing/regeneration and native project instructions/files.
- Tasks, Notes, executable Plans, Reports, Project Core, current-chat rotation, Review/Delivery and bounded project consultations.
- Files/Git with README/releases, system diagnostics, private device terminals and configured GUI previews.
- Native dictation with waveform/timer, system or background read-aloud, account usage/resets and six settings categories.
- Native work progress, context/diff, live command output, content search, ChatGPT schedules and bounded saved Canvas access. See the documented native limitations below.
- Independent web gateway and persistent execution engine, with guarded updates, private snapshots and recovery.

## Deployment

Choose your own hostname and Linux runtime directory. Supported deployment, first login and updates are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); snapshot/restore and diagnostics are in [docs/MAINTENANCE.md](docs/MAINTENANCE.md). The default branch contains the working product; [RELEASES.md](docs/RELEASES.md) records verified source/image baselines.

```text
Safari / PWA → HTTPS / Cloudflare Tunnel → Linux Hub
                                              ├─ SSH → Windows bridge → local named pipe → Codex stdio
                                              └─ guacd → LAN-only VNC / RDP
```

Use RDP where the Windows edition supports hosting it, or a configured VNC provider. Restrict SSH and Remote inbound rules to the Hub's LAN/Tailnet address. No Codex web listener runs on Windows.

A local-only Companion runs in the logged-in Windows session. This is the owner-approved workaround for the installed Codex sandbox runner failing when launched directly in Windows SSH Session 0. It exposes a named pipe, not a network port. See [D17](docs/DECISIONS.md#d17--early-local-only-companion-for-windows-session-0).

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

Copy [config.example.yaml](config.example.yaml) outside the repository and fill in the machine/project paths. The optional remote password is supplied through the environment; website passwords are never set in an environment file.

For loopback development, use publicBaseUrl `http://127.0.0.1:8780` and secureCookies `false`. Non-loopback deployments require HTTPS.

## Repository

| Directory | Purpose |
| --- | --- |
| apps/hub | Authentication, SQLite, normalized sessions/results, upload and Remote APIs |
| apps/web | React mobile/wide PWA with semantic theme tokens |
| packages/shared | Validated configuration and stable client contracts |
| packages/codex | App Server JSONL RPC framing, cancellation and timeouts |
| packages/machines | System SSH/local process transports and attachment staging |
| ops | Linux container deployment and Windows setup |
| scripts | Explicit opt-in smoke and isolated browser checks |
| tests | Automated regression checks |

## Verification and remaining scope

[docs/VERIFICATION.md](docs/VERIFICATION.md) records real Windows checks separately from simulated browser fixtures. Mobile Chromium/WebKit checks do not substitute for testing Safari and standalone mode on a physical iPhone/iPad.

Native Codex project discovery and bounded external history are implemented. [Sync and Remote behavior](docs/SYNC_AND_REMOTE.md) explains the desktop saved-folder limitation and continuation semantics. Notes, Files/Git and generated artifact Results are implemented. Additional execution machines and selected project-root enforcement are prerequisites of the current team milestone. The local Linux transport exists; broad second-machine acceptance is tracked separately from configured device terminals.

[Roadmap](docs/ROADMAP.md) distinguishes implemented personal features, installed owner-enabled team functionality, pending member admission and physical acceptance. Further changes are developed and verified with isolated state before guarded updates. The full Canvas editor, global search through every native GPT conversation and a distributable separate-Hub installer are not part of this pass.

Read [AGENTS.md](AGENTS.md), [decisions](docs/DECISIONS.md), [architecture](docs/ARCHITECTURE.md), [mobile UX](docs/MOBILE.md) and [security](docs/SECURITY.md) before substantial changes.

### Optional GPT and interactive design demos

The Codex/GPT switch can connect a separately signed-in private ChatGPT browser on the Linux Hub. It shows the real account's conversations and projects, sends text/files/images, selects native models and power, and retrieves generated images. The protected original interface remains available for other native controls. See [installation and boundaries](ops/gpt/README.md).

Self-contained HTML designs can appear as interactive Results from native HTML resources, HTML file changes, assistant HTML blocks or local project-file links. See [the artifact contract](docs/CODEX_INTEGRATION.md#interactive-html-result-contract). Previews run in an isolated frame and do not require a public Windows development server.

Background read-aloud setup, limits and local voice attribution: [ops/speech/README.md](ops/speech/README.md).

Native ChatGPT schedules, saved Canvas versions and extended OpenAI MCP forms are documented in [Native workspace](docs/NATIVE_WORKSPACE.md), including current native availability and guarded installation requirements.
