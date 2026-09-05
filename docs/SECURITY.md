# Security

## Security goal

This is a single-user private tool with unusually powerful backend access: Codex can modify projects and run commands, and Remote Desktop can control a Windows machine.

Treat authentication and network boundaries as core product requirements even though there is only one user.

## Primary invariant

**Only the Linux Hub is Internet-facing.**

Intended public exposure:

```text
Internet -> HTTPS :443 -> Linux Hub
```

Not intended:

```text
Internet -X-> Windows SSH
Internet -X-> Windows RDP/VNC
Internet -X-> Codex App Server
Internet -X-> guacd
Internet -X-> SQLite/files
```

## Network rules

### Linux Hub

- expose only required HTTPS endpoint publicly;
- keep Hub admin/internal ports loopback/private;
- `guacd` should not be directly Internet-accessible;
- database/filesystem are local/private;
- SSH client initiates connections to execution machines.

### Windows PC

Windows firewall should restrict inbound management protocols to the Hub LAN/Tailnet address where practical.

At minimum:

- SSH: Hub only;
- RDP/VNC: Hub only;
- no Codex App Server network listener required for v1;
- no router port forwarding to Windows.

If Tailscale is added later, equivalent ACL rules should restrict access to the Hub identity/address.

## Authentication

v1 has one configured account, no registration.

Requirements:

- store password using Argon2id or another current password-hashing recommendation;
- use a unique salt automatically provided by the password hashing library;
- rate-limit login attempts;
- avoid user-enumeration differences in login errors;
- issue a random opaque session identifier;
- use `Secure`, `HttpOnly` and appropriate `SameSite` cookie attributes;
- rotate/invalidate sessions on password change;
- support explicit logout;
- define a sensible session lifetime with optional trusted-device persistence.

TOTP/passkeys may be added later but are not required to prove MVP.

## CSRF / Origin / WebSocket protection

Because the application uses authenticated state-changing APIs and WebSockets:

- enforce same-origin policy intentionally;
- validate `Origin` on WebSocket upgrades;
- use CSRF protection for cookie-authenticated state-changing HTTP routes where applicable;
- do not accept wildcard public origins in production;
- do not put session tokens in query strings/loggable URLs.

## Authorization

Single-user does not mean authorization can be skipped.

Every privileged operation still requires a valid authenticated session:

- sending prompts;
- approvals;
- interrupting turns;
- opening Remote;
- reading Results artifacts;
- accessing project files/status;
- changing machine/project configuration;
- Notes/Plan later.

Do not serve artifact files from a public static directory without auth checks unless they contain no private data and that choice is explicit.

## SSH

Use system OpenSSH and normal host-key verification.

Requirements:

- dedicated SSH key for Hub -> Windows is preferred;
- private key lives in the Hub OS account's protected filesystem, never repository/SQLite/browser;
- do not disable host-key checking globally;
- prefer `~/.ssh/config` alias for machine-specific connection details;
- restrict the Windows firewall to the Hub;
- SSH should run as the Windows user whose Codex environment/project permissions are intended.

Avoid placing passwords on SSH command lines.

## Codex secrets

The target machine owns Codex authentication/configuration.

Never:

- copy `.codex/auth.json` into Hub storage;
- return Codex tokens/auth files to browser;
- include auth content in diagnostics;
- include target environment dumps in issue reports without redaction.

The Hub needs protocol access, not Codex account credentials.

## Remote Desktop secrets

RDP/VNC credentials must remain server-side.

Preferred options:

- deployment secret file/environment with strict permissions;
- later encrypted secret storage if UI-managed credentials are desired.

Do not:

- commit them;
- place them in frontend bundles;
- include them in connection URLs that may be logged;
- send them to browser code when Guacamole can mediate server-side.

## Guacamole/guacd

- bind `guacd` only where the Hub/Guacamole integration needs it;
- do not expose `guacd` publicly;
- validate/allowlist machine connection targets instead of accepting arbitrary client-provided hosts;
- browser asks for `machineId`, not raw `rdp://host:port`;
- Hub resolves the trusted configured host/provider.

This prevents the Remote feature becoming an authenticated SSRF/network pivot tool.

## Machine/project configuration

Treat machine addresses, paths and commands as privileged admin configuration.

Do not let ordinary runtime requests supply arbitrary:

- SSH hostname;
- username;
- executable path;
- working directory outside configured project;
- Remote target host/port.

v1 can use config files plus a settings UI later.

## Command injection

Windows remote launching is a high-risk quoting boundary.

Rules:

- keep structured command specs internally;
- centralize Windows shell quoting;
- avoid concatenating browser strings into PowerShell/cmd source;
- project IDs resolve to configured paths server-side;
- machine IDs resolve to configured SSH aliases server-side;
- test paths with spaces, quotes and non-ASCII characters.

## Artifact/result storage

Results may contain private source screenshots/files.

- use opaque IDs in download routes;
- enforce project/session auth before access;
- sanitize filenames and MIME types;
- do not execute uploaded/generated artifacts on the Hub;
- set download headers deliberately;
- store outside the public static root where possible;
- apply storage quotas/cleanup policy later.

## Logs

Useful logs:

- session lifecycle;
- machine connection failures;
- Codex process exit;
- protocol errors;
- Remote connection state;
- login failures/rate limiting.

Redact/avoid:

- passwords;
- cookies/session IDs;
- Authorization headers;
- SSH private keys;
- Codex auth/token contents;
- RDP/VNC credentials;
- full environment variable dumps;
- prompt/source content unless explicitly needed for local debugging.

## Browser security headers

Production should set a restrictive baseline appropriate for the final frontend/integration, including:

- Content Security Policy;
- frame policy / `frame-ancestors`;
- `X-Content-Type-Options`;
- Referrer Policy;
- HSTS when HTTPS deployment is stable;
- Permissions Policy as useful.

Guacamole/WebSocket integration may require deliberate CSP allowances. Keep them narrow.

## Dependency policy

This application sits on a privileged machine boundary. Prefer mature dependencies and keep dependency count reasonable.

- pin lockfile;
- update dependencies intentionally;
- avoid unmaintained auth/security packages;
- do not import random terminal/SSH/RDP libraries when system OpenSSH and Guacamole already solve the problem.

## Future Windows Companion security

If an interactive companion is introduced:

- no public/listening TCP port;
- run in normal user context unless a privileged operation absolutely requires otherwise;
- local IPC with explicit ACL;
- authenticate/authorize IPC requests where necessary;
- allowlist operations rather than implementing an unrestricted hidden shell;
- keep Hub -> Companion path auditable;
- never weaken Windows interactive-session security by trying to make `sshd` interactive.

## Backups

Hub backup eventually needs:

- SQLite database;
- result files that should be retained;
- deployment configuration excluding or separately protecting secrets.

Source repositories already have their own Git storage and should not be duplicated into Hub backups by default.
