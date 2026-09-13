# Connecting a personal Windows PC

Candidate implementation for #151, #6 and #37. The stable production installation is not replaced by this work. The friend does not need to attend development verification; their real installation and account checks remain a later acceptance step.

## Member workflow

1. Accept the owner's invitation and set a personal login/password.
2. Open Settings → Connections → My computers. Name the computer and download the installer ZIP on that Windows PC.
3. Extract the ZIP and open `Connect.cmd`. Accept Windows elevation using the same logged-in Windows account.
4. The wizard installs missing Tailscale, Node.js LTS, Git, GitHub CLI and the native Codex application. It opens the required native login flows; passwords remain in those applications. Select a local project folder in the normal folder picker.
5. Choose whether to connect Remote. A fresh supported 64-bit Windows PC can receive TightVNC through the same wizard; an existing unmanaged TightVNC installation is preserved. No Windows account password is requested.
6. After preparation, compare the displayed computer fingerprint with the administrator's review card. The administrator verifies private SSH, the Windows user/machine identity, Companion, approved roots and the selected Remote authentication. Activate the approved computer from the member's own connection card when their tasks are idle.

The user never types SSH commands, edits configuration files or copies account tokens. Tailscale login/membership, Windows elevation, account consent and folder selection are intentional user actions. GitHub's short device code is displayed inside the wizard and its official login page opens automatically.

The package lasts one day. Reopening the same package uses its saved folder choice and exact submitted report. A lost website response or repeated download retains the same enrollment ID and keys. The browser remembers the pending download within its account-scoped session. If the package expired, was revoked or the computer identity changed, create a new connection; the old registration is not silently replaced.

## Installation owner

Configure `team.hubTailnetAddress` only after the Hub has a real private Tailscale IPv4 address and the member's PC can reach it. Without it the website shows an explicit setup state and cannot produce a misleading installer. At this checkpoint the running Hub has not been enrolled in Tailscale or otherwise reconfigured.

The installer preserves existing SSH configuration and unrelated keys. It adds distinct no-PTY command and PTY terminal keys restricted to the Hub address, with forwarding disabled. It scopes the standard OpenSSH firewall rule with an explicit Windows-side confirmation and stops for custom broader SSH rules instead of rewriting them. Existing SSH sessions and active Companion tasks are not terminated. Non-standard Windows/domain/OpenSSH installations may need local review.

Approval reads the machine through pinned system SSH and performs a harmless Companion readiness probe. It does not start/resume a native conversation. Personal-runtime activation blocks active or uncertain native work and permits replacing verified idle terminal sessions. Another user's runtime stays mounted.

Registry backups retain the approved owner/machine identity and private transport keys. A restored installation blocks native admission until host-side release checks; copying a snapshot cannot reconnect to live writers automatically. Offboarding key/Tailnet cleanup and full browser-profile restore admission remain part of the team's lifecycle gate.

## Optional private desktop

The existing abstract Remote provider retains RDP support. Fresh enrollment uses VNC for the same visible Windows session, including Windows Home, without needing the Windows account password. The pinned [official TightVNC 2.8.88 installer](https://www.tightvnc.com/download.php) must match its SHA-256 and a valid GlavSoft Authenticode signature. Installation includes only the server; HTTP access is disabled, VNC authentication is mandatory and configuration access has a separate random password. The wizard stays responsive during download/installation.

Windows firewall must be enabled with inbound blocking. Only the Hub's exact Tailscale address may reach TCP 5900; effective rules are checked before starting the service. A disabled, broader or conflicting rule fails visibly instead of being silently rewritten. The original installation and unrelated rules/services are not changed. This deliberately depends on Tailscale's encrypted private transport: [RFB's legacy VNC password authentication](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.2.2) does not itself encrypt the desktop stream.

The PC generates an independent eight-character VNC connection secret and saves it in a Windows-user/System/Administrators-only configuration directory. Its private HTTPS enrollment report carries this generated connection secret, never the Windows/Codex/GitHub account credentials. Exact retries preserve it. The Hub's private registry/backup retains it; browser/admin lists expose only readiness, never the secret. Approval sends only the RFB authentication handshake, then disconnects before ClientInit: it does not request a framebuffer, screenshot or input. Only the owner's authenticated personal runtime can open the desktop.

## Verification and remaining work

The current checks cover installer packaging and PS5 UTF-8 decoding, native status handling, fingerprint display, firewall rule classification, exact retry, root containment, approval authorization, owner-only transport materialization, runtime recovery and identity-preserving backups. Windows checks render controls offscreen and use harmless native fixture commands; they do not install software or change the owner's SSH/firewall/accounts.

Windows Remote enrollment is implemented in the candidate. Authentication-only protocol fixtures, credential projection/ownership, exact report retry and backup restoration pass, as do native PS5 parsing and 16 firewall classification checks. The registry setting names were verified against the official TightVNC source. No MSI installation or live desktop connection was exercised on the owner's PC.

The first real friend-PC installation, simultaneous native-account workflows, actual Windows Remote use and final lifecycle acceptance remain tracked in [the roadmap](ROADMAP.md). Personal GPT provisioning and its isolated browser are described in [TEAM_GPT.md](TEAM_GPT.md). An installed package is not evidence of a completed hardware test.

Native Codex installation follows [OpenAI's Windows instructions](https://learn.chatgpt.com/docs/windows/windows-app). Dependencies use their official WinGet sources; GitHub authorization remains in [GitHub CLI](https://cli.github.com/manual/gh_auth_login).
