# Deployment and Machine Setup

This document describes the intended deployment shape. It is not a copy-paste production installer yet.

## Machines

### Linux Hub

Runs:

- public HTTPS endpoint;
- Hub backend;
- PWA assets;
- SQLite/result storage;
- system OpenSSH client;
- Guacamole/`guacd` for Remote Desktop;
- optional local Codex backend.

### Windows PC

Runs its normal development environment:

- Codex;
- project repositories;
- build/test toolchains;
- OpenSSH Server for trusted-LAN Hub access;
- Remote Desktop host (RDP if available, otherwise configured fallback).

No Codex web service is exposed on Windows.

## Linux Hub prerequisites

Exact packages depend on distro/deployment, but the host needs:

- current Node.js LTS suitable for chosen workspace tooling;
- `ssh` OpenSSH client;
- build/runtime dependencies for the Hub;
- reverse proxy/TLS termination if not handled directly by Hub;
- SQLite support through application dependency;
- Guacamole/`guacd` when Remote phase is implemented.

The Hub OS account should have a normal `~/.ssh/config` and private key with strict filesystem permissions.

## Windows OpenSSH

Use the Windows OpenSSH Server feature.

The Hub should connect as the Windows user whose:

- project permissions are correct;
- Codex installation/config are available;
- Git identity/toolchain environment is intended.

Test manually from the Linux Hub before coding around it:

```bash
ssh main-windows 'whoami'
```

Then test Windows-native commands, for example through the configured shell:

```text
where.exe codex
codex --version
```

Do not disable SSH host-key checking as a shortcut.

## SSH alias

Prefer machine details in Hub OS SSH config:

```sshconfig
Host main-windows
    HostName 192.168.1.50
    User YOUR_WINDOWS_USER
    IdentityFile ~/.ssh/codex-web-main-windows
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

The application can then store/use `main-windows` as the SSH target instead of handling keys directly.

Connection multiplexing can be added to SSH config on the Linux side if testing shows it is useful.

## Windows firewall

Intended policy:

- SSH inbound allowed from Linux Hub IP only;
- RDP/VNC inbound allowed from Linux Hub IP only;
- no router forwarding for these ports;
- no public Codex listener.

Exact firewall commands should be generated/documented during deployment work after real interface/IP names are known.

## Codex remote launch smoke test

Before integrating with the web app, create a tiny Hub-side diagnostic script/test that proves:

1. SSH works;
2. target project directory exists;
3. Codex executable is resolvable;
4. `codex app-server` starts over stdio;
5. initialization succeeds;
6. process can be terminated cleanly.

Keep stdout protocol-clean during this test.

## Windows shell choice

The implementation should intentionally choose a Windows shell for remote launch rather than depend on whatever OpenSSH default shell happens to be configured.

Support an explicit configuration override.

The launcher must be tested with:

- path containing spaces;
- native `codex.exe` if present;
- npm `codex.cmd` shim if present;
- non-ASCII project path if the real environment needs it.

## Remote Desktop setup

### RDP provider

When Windows supports hosting RDP:

- enable Remote Desktop on the PC;
- ensure the intended Windows user may log in;
- firewall-restrict RDP to Hub IP;
- configure Guacamole/Hub provider server-side.

### Fallback provider

If the Windows edition cannot host RDP, configure a Guacamole-supported VNC-compatible host instead.

The frontend should not change — only machine provider configuration changes.

## Public HTTPS

Only the Hub needs a public domain/HTTPS route.

Production requirements:

- valid TLS;
- redirect/reject plaintext HTTP as appropriate;
- secure cookies;
- WebSocket proxy support;
- upload/body limits;
- rate limiting;
- no public directory browsing of result storage.

Cloudflare Tunnel/reverse proxy is compatible with the architecture as long as only the Hub is published and WebSockets work correctly.

## Data directories

Do not write mutable runtime data inside source-controlled folders in production.

Suggested configurable paths:

```text
/var/lib/codex-web/app.db
/var/lib/codex-web/results/
/etc/codex-web/config.yaml
```

Exact locations may follow the deployment environment.

## Secrets

Do not put secrets in `config.yaml` if the repository/deployment process might expose it.

Prefer references to environment variables/secret files for:

- Hub session secret/key material;
- initial account password/bootstrap secret;
- RDP/VNC password if required.

SSH private keys stay in the Hub user's SSH directory.

## Backups

Minimum useful backup once the application matters:

- SQLite database;
- retained result artifacts;
- non-secret config;
- separately protected secret/config material as appropriate.

Project repositories are not part of the Hub backup strategy unless explicitly configured elsewhere.

## Tailscale later

A machine outside the physical LAN can be assigned a Tailscale address/SSH alias and use the same transport architecture.

Do not redesign project/session APIs around Tailscale. It is just another trusted route to a configured machine.
