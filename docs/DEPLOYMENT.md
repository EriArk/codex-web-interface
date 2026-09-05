# Deployment and operations

## Current installation

- Public URL: https://codex.abysstail.art
- Linux source: /home/abysscloud/codex-web-interface
- Private runtime directory: /home/abysscloud/services/codex-web (0700)
- Hub binds 127.0.0.1:8780. guacd binds 127.0.0.1:4822.
- Docker Compose runs codex-web-hub, codex-web-guacd and codex-web-tunnel.
- Cloudflare tunnel: codex-web, f90dae12-4045-4dd9-8df3-d7af991b3b61.
- Windows project: D:\\Projects\\CodexWeb, via the main-windows SSH alias.
- Windows Companion scheduled task: CodexWebCompanion, interactive logon, limited token.
- Windows services: sshd and tvnserver, automatic startup.
- Windows firewall rules: CodexWeb-Hub-SSH and CodexWeb-Hub-VNC allow only 192.168.50.122.

Other services and Cloudflare tunnels on the server are independent. Do not stop or reconfigure them when updating this app. No router forwarding is needed.

The PC must be powered on and the owner must have logged into Windows for the Companion to be available. Locking the session does not create a public Windows endpoint. Remote behavior at the Windows secure desktop may differ from the normal desktop.

## First login

On first startup the Hub writes a private link to:

```text
/home/abysscloud/services/codex-web/data/setup-link.txt
```

Open that link, choose a password of at least 12 characters and confirm it. There is no username field. The link fragment is sent only to the setup endpoint and consumed atomically; it stops working after enrollment. This prevents a stranger who reaches the public domain first from claiming the installation.

SQLite stores an Argon2id hash, never the password. Further visits use the normal website URL and that password. A session lasts seven days; logout also closes its event and Remote sockets. There is no default or temporary website password.

Keep the setup link private. A protected local copy may be supplied to the owner for first access. Once enrollment has completed, the setup link file can be removed; the Hub removes its copy on the next start. Losing the password currently requires administrator recovery; do not delete the entire database.

## Runtime files

```text
config.json          # Non-secret machine/project configuration
remote.env           # VNC/RDP password; 0600
deploy.env           # CODEX_WEB_STATE=/home/abysscloud/services/codex-web
ssh/config           # System SSH aliases; explicit identity and pinned host keys
ssh/windows_ed25519  # Private key; never move into Git
ssh/known_hosts
data/app.db          # SQLite metadata, sessions, thread mappings, history
data/results/        # Private screenshots and uploads
tunnel/config.yml
tunnel/<id>.json     # Credentials for this tunnel only; 0600
```

The tunnel container receives only its tunnel credential, not the account-wide Cloudflare certificate. Containers run with bounded resources and dropped capabilities. The Hub image includes system OpenSSH but no copied Codex authentication.

Uploaded originals remain private on the Hub. Images are validated and a JPEG preview, bounded to 2048 pixels per side, is used for vision. Originals and previews are copied over SSH into the Windows user's LocalAppData/CodexWeb/attachments directory. Generic files are referenced by absolute path; they are not executed during upload. Unsent Hub uploads expire after 24 hours and are cleaned on the next upload. Sent files remain available for thread resume. The initial Hub upload quota is 2 GiB. Server backups containing uploads are sensitive.

## Update

Run these commands on Linux, after source review and when no live Codex turn needs to survive a Hub restart:

```bash
cd /home/abysscloud/codex-web-interface
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
docker compose --env-file /home/abysscloud/services/codex-web/deploy.env -f ops/linux/compose.yaml build hub
docker compose --env-file /home/abysscloud/services/codex-web/deploy.env -f ops/linux/compose.yaml up -d
docker compose --env-file /home/abysscloud/services/codex-web/deploy.env -f ops/linux/compose.yaml ps
curl --fail http://127.0.0.1:8780/api/health
```

Image and package versions are pinned. pnpm 11.12.0 was deprecated upstream as broken; use 11.13.1.

Before replacing an existing release, tag the current Hub image as a rollback image and take a consistent backup. A browser disconnect is safe for a running turn; restarting the Hub terminates its App Servers. The UI marks interrupted transport outcomes as unknown and does not resend them automatically.

## Backups and recovery

For a simple consistent manual backup, stop only codex-web-hub, copy the private runtime directory into protected backup storage, then start the Hub again. Include SQLite, results/uploads, SSH configuration, tunnel credential and Remote secret; protect the backup at least as strictly as the original. Never commit it.

A database-only online backup should use SQLite's backup API or VACUUM INTO, not copy just app.db while WAL writes are active. The source repositories remain on their execution machines and need their own backups.

## Windows maintenance

The scripts in ops/windows require an elevated PowerShell for service/firewall/task setup. Normal Companion execution is not elevated.

- Enable-CodexHubSsh.ps1 configures key-only access, pins allowed source IP in authorized_keys, restricts inbound SSH and preserves a timestamped sshd configuration backup.
- Install-Companion.ps1 builds the small named-pipe bridge with the Windows .NET Framework compiler, writes its allowlisted working directories and installs the interactive task.
- Install-RemoteDesktop.ps1 verifies the official TightVNC installer signature and configures VNC without a public HTTP viewer. It refuses to overwrite an existing installation silently.

After a Codex desktop update, check that the configured codex.exe path still exists. To change the Companion binary/configuration, first finish web turns and stop only CodexWebCompanion, then rerun its installer with the intended CodexCommand and WorkingDirectories. Do not copy auth.json to Linux.

Useful read-only checks:

```powershell
Get-Service sshd,tvnserver
Get-ScheduledTask -TaskName CodexWebCompanion
Get-NetFirewallRule -Name CodexWeb-Hub-SSH,CodexWeb-Hub-VNC | Get-NetFirewallAddressFilter
```

## Diagnostics

The home router initially returned NXDOMAIN for the new hostname even though public DNS was correct. Windows now has an NRPT rule named `Codex Web domain DNS` for the exact hostname `codex.abysstail.art`, using Cloudflare resolvers `1.1.1.1` and `1.0.0.1`. Other domains still use the existing network DNS. Normal Windows resolution, HTTPS health and the browser login page were verified after applying it.

This rule affects only that Windows PC. Devices using the router's DNS may still need a corrected router resolver or their own DNS setting. Once the router resolves the hostname correctly, remove only this rule from an elevated PowerShell:

```powershell
Get-DnsClientNrptRule | Where-Object {
  $_.DisplayName -eq 'Codex Web domain DNS' -and
  $_.Namespace.Count -eq 1 -and
  $_.Namespace[0] -eq 'codex.abysstail.art'
} | Remove-DnsClientNrptRule -Force
Clear-DnsClientCache
```

```bash
docker logs --tail 80 codex-web-hub
docker logs --tail 40 codex-web-tunnel
ssh -F /home/abysscloud/services/codex-web/ssh/config main-windows whoami
```

Do not publish raw credentials, complete environment dumps or private conversation files with a bug report. Smoke scripts are opt-in: some consume a small amount of Codex usage and create disposable verification conversations. Browser tests use an isolated loopback server with an in-memory database, simulated Codex and the real Remote provider.
