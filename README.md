# Codex Web Interface

Private Codex workspace for iPhone, iPad and desktop. The browser talks to a Linux Hub; Codex and project files stay on the configured execution machine.

## Available now

- Password-only login. The owner chooses the first password through a private, single-use setup link.
- Automatic discovery of real Windows Codex projects and conversations; create a project or choose an existing folder from the website.
- Continue the same native thread, with streaming, resume, approvals, questions and interrupt.
- Live model discovery, native Work/Plan mode and model-specific reasoning effort, saved per thread.
- File and image attachments with preview/removal before sending. Up to eight files, 25 MiB each, 64 MiB per message.
- Latest 20 chat messages on open; an explicit button loads 20 more without moving the reading position.
- Results for file changes, checks, plans and Remote screenshots; detailed commands in Activity.
- Manual Remote Desktop through Guacamole: phone trackpad, tablet touch/stylus, pinch zoom and controls over the full landscape screen.
- Dedicated single-view phone shell, three-pane wide layout, PWA manifest and three shared themes.

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

Native Codex project discovery and bounded external history are implemented. [Sync and Remote behavior](docs/SYNC_AND_REMOTE.md) explains the desktop saved-folder limitation and continuation semantics. Notes, a general file/Git browser, additional machines and automatic collection of arbitrary generated artifacts remain later modules. The local Linux transport is implemented; this deployment has only the authenticated Windows backend configured.

Read [AGENTS.md](AGENTS.md), [decisions](docs/DECISIONS.md), [architecture](docs/ARCHITECTURE.md), [mobile UX](docs/MOBILE.md) and [security](docs/SECURITY.md) before substantial changes.

### Optional GPT and interactive design demos

The Codex/GPT switch can connect a separately signed-in private ChatGPT browser on the Linux Hub. It shows the real account's conversations and projects, sends text/files/images, selects native models and power, and retrieves generated images. The protected original interface remains available for other native controls. See [installation and boundaries](ops/gpt/README.md).

Self-contained HTML designs can appear as interactive Results from native HTML resources, HTML file changes, assistant HTML blocks or local project-file links. See [the artifact contract](docs/CODEX_INTEGRATION.md#interactive-html-result-contract). Previews run in an isolated frame and do not require a public Windows development server.
