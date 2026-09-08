# Deployment and operations

Examples use /srv/codex-web for private runtime state, /opt/codex-web for source and codex.example.com for the public origin. Replace them with your own values. Machine addresses in config.example.yaml are documentation examples, not defaults for your network.

## Supported layout

The browser connects only to the Linux Hub through HTTPS. Use your own reverse proxy or the optional Cloudflare tunnel service in ops/linux/compose.yaml. Only port 443 of the Hub/ingress should be public. Do not expose Windows Codex, SSH, VNC/RDP or guacd to the Internet.

The configured Windows machine stays in the trusted LAN/Tailnet. The Hub uses system SSH and pinned host keys. The user-session Companion carries App Server stdio over a local-only named pipe; Windows must be running with the user logged in. Desktop ChatGPT/Codex does not need to stay open. After finishing a desktop-owned conversation, fully quit that client once to release its writer for the website.

Windows Pro may host RDP. Windows Home generally needs a configured VNC provider. Both are carried through Guacamole. Restrict Windows inbound SSH and Remote ports to the Hub address, and use encrypted LAN/Tailnet transport if the underlying LAN is not trusted.

## Private state

Create a directory owned by the service user, mode 0700:

```text
/srv/codex-web/
  config.json        # Based on config.example.yaml; YAML or JSON accepted
  deploy.env         # CODEX_WEB_STATE=/srv/codex-web
  remote.env         # Only configured Remote secret variables, mode 0600
  ssh/config         # System SSH configuration with IdentityFile and pinned host keys
  ssh/windows_key    # Dedicated private key, mode 0600
  ssh/known_hosts
  data/app.db
  data/results/
  backups/           # Private snapshots; never serve over HTTP
  tunnel/config.yml  # Optional ingress configuration
  tunnel/TUNNEL.json # Only this tunnel's credential, mode 0600
```

Keep SSH keys, Remote passwords, ingress credentials and the website database out of Git. Do not copy native Codex auth.json or source repositories into Hub state. The tunnel container needs only its tunnel credential, not an account-wide Cloudflare certificate. Use your ingress provider's supported setup for your hostname and certificate.

## Windows setup

Use elevated PowerShell for service/firewall installation. Supply your actual Hub IPv4 address and Windows account explicitly; the scripts have no owner-specific defaults:

```powershell
.\ops\windows\Enable-CodexHubSsh.ps1 -HubAddress HUB_LAN_IP -WindowsUser YOUR_USER -PublicKeyFile C:\Private\hub.pub
.\ops\windows\Install-Companion.ps1 -CodexCommand C:\Path\To\codex.exe -WorkingDirectories C:\Projects
.\ops\windows\Install-RemoteDesktop.ps1 -HubAddress HUB_LAN_IP -Installer C:\Private\tightvnc.msi -SecretFile C:\Private\remote.env
```

Inspect each script's parameters before installation. The Companion runs with the user's limited interactive token. The VNC installer script checks the official package signature and refuses to silently overwrite an existing server. For desktop-bundled Codex, Companion installation copies the complete selected runtime (Codex and its three helper executables) into its own versioned runtime directory and verifies SHA-256 hashes. Desktop updates cannot retire files underneath the independent App Server. Upgrades remain explicit: after active web work finishes, reinstall Companion with the current complete desktop bundle. Custom/standalone CLI paths remain unchanged. Older snapshots are retained because running App Servers may still use their helpers; incomplete staging directories can be reviewed after a failed installation.

## Start and first login

Use the pinned Node 24.18.x and pnpm 11.13.1 for builds. The repository's Dockerfile contains the same pinned versions. Build on Linux:

```bash
cd /opt/codex-web
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
SOURCE_REVISION=$(git rev-parse HEAD) docker compose --env-file /srv/codex-web/deploy.env -f ops/linux/compose.yaml build hub
docker compose --env-file /srv/codex-web/deploy.env -f ops/linux/compose.yaml up -d hub
```

Configure/start the optional tunnel separately if you use it. When another reverse proxy terminates HTTPS, the Hub still uses its canonical HTTPS publicBaseUrl and secureCookies=true.

At first start, the Hub writes data/setup-link.txt with a private single-use enrollment link. Open it and choose a password of at least 12 characters. There is no username or default password. Enrollment consumes the token atomically. Later visits use the normal site URL. SQLite stores an Argon2id password hash and opaque session digests, not plaintext passwords.

The setup link is not a forgotten-password backdoor. Password recovery/change/global revocation is tracked separately in issue #8; never delete the database to reset access.

## Upgrade and rollback

Wait for active web turns to finish before restarting the Hub. Closing the browser alone does not stop a turn. A Hub restart closes its App Servers and preserves uncertain outcomes for explicit recovery without automatically replaying prompts.

1. Select a reviewed commit with green CI and record the current image digest/revision.
2. Create and verify a snapshot with [the maintenance command](MAINTENANCE.md).
3. Build the selected source with SOURCE_REVISION set as above.
4. Restart only the Hub with compose up --detach --no-deps --wait hub. Do not stop unrelated services, Guacamole or ingress.
5. Run doctor and check HTTPS login/health.

The storage layer owns ordered migrations. Existing schema 1 upgrades to schema 2 at startup in one transaction; the compatible prototype columns/catalog are preserved. Before upgrading an existing DB, the Hub creates a private consistent database checkpoint in data/migration-backups. Startup refuses a newer schema. A failed migration rolls back the schema and its version together.

The database checkpoint is not a full file/config backup. The full snapshot command remains required before operational upgrades. Do not perform downgrade SQL: validate an older full snapshot in a fresh private target, then stop only the Hub and deliberately switch its configuration to the restored paths. Restore revokes all saved sessions, keeps the password hash and marks pending work unknown.

Image/source baselines are recorded in [RELEASES.md](RELEASES.md). Keep the prior image and pre-upgrade snapshot until the new deployment has been accepted.

## Troubleshooting

Run doctor first; its default report is safe to share and contains bounded status codes rather than prompts, environment dumps or credentials. See [MAINTENANCE.md](MAINTENANCE.md).

- SSH_HOST_KEY_FAILED: verify the Windows host identity locally before updating only its pinned key.
- SSH_AUTH_FAILED: inspect the intended account and dedicated key permissions.
- COMPANION_STDIO_UNAVAILABLE: verify interactive login, the Companion task and configured Codex executable.
- CODEX_LOGIN_REQUIRED: sign into native Codex on its execution machine.
- THREAD_IN_USE: finish work in the client holding that conversation and fully exit it once; retry the original chat on the website.
- MIGRATION_PENDING: run the supported backup/upgrade path.
- PROJECT_ROOTS_UNRESTRICTED: the coarse per-machine project-root boundary remains issue #6.
- NXDOMAIN on one device: compare its resolver with authoritative/public DNS, check the hostname and stale router cache. Correct DNS locally; do not weaken HTTPS or replace hostname validation.
- Remote TCP failure: verify the configured LAN target and firewall source restriction. Do not open a public Remote port.

Raw Docker/SSH logs may contain installation-specific details; review them before sharing. Native integration scripts create disposable test conversations and may consume small Codex usage. Portable CI and the isolated browser fixtures need no production secrets.

## Observing desktop activity

For the tested Codex 0.153.4 layout, optionally set `machines[].codex.activityNode` to the absolute path of Node 24+ on the execution machine. On Windows this is commonly `C:/Program Files/nodejs/node.exe`; verify the actual path. This setting only enables the fixed read-only metadata reader described in DECISIONS D25. It uses the existing SSH target and does not require a Companion restart or a listener. The machine must have node:sqlite and the native database layout expected by the reader. Unsupported or unreachable observation appears as unavailable, without writing to native files.

Schema 4 stores observation baselines and only uncertain queue-to-Steer transfer records. Pin the backup image to the deployed revision when upgrading. Restore rehearsal and old-image rollback require the matching pre-migration snapshot; never start a schema-3 image against schema 4.


## Optional Windows desktop restart

From Windows PowerShell 5.1 as the intended desktop user with administrator rights, run `ops/windows/Install-DesktopControl.ps1` (optionally supply `-NodeCommand` and `-CodexHome`). Node must support node:sqlite; the metadata check currently matches Codex 0.153.4. Installation creates the demand-only CodexWebDesktopRestart task and does not restart Codex or Companion. Set that machine's `codex.desktopControl` to the absolute installed path `%LOCALAPPDATA%/CodexWeb/desktop-control/CodexDesktopControl.ps1`, expanding the placeholder. Only configured Windows machines expose the Settings control.

Use the installed script's `-Action Status` for a read-only check. `-Action Probe -RequestId <new UUID>` exercises the scheduled interactive action without closing or launching Codex. Actual restart is requested from Settings and waits for no active tasks; a Windows login must remain available. The latest operation survives Hub/browser restarts. Never automatically retry an uncertain restart. Keep private desktop-control configuration and task definition in Windows backups. Reinstall the helper after a script change; no Companion restart is needed.
