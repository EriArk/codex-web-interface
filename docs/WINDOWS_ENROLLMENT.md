# Connecting a personal Windows PC

Candidate implementation for #151, #6 and #37. The stable production installation is not replaced by this work. The friend does not need to attend development verification; their real installation and account checks remain a later acceptance step.

## Member workflow

1. Accept the owner's invitation and set a personal login/password.
2. Open Settings → Connections → My computers. Name the computer and download the installer ZIP on that Windows PC.
3. Extract the ZIP and open `Connect.cmd`. Accept Windows elevation using the same logged-in Windows account.
4. The wizard installs missing Tailscale, Node.js LTS, Git, GitHub CLI and the native Codex application. It opens the required native login flows; passwords remain in those applications. Select a local project folder in the normal folder picker.
5. After preparation, compare the displayed computer fingerprint with the administrator's review card. The administrator verifies private SSH, the Windows user/machine identity, Companion and the approved roots. Activate the approved computer from the member's own connection card when their tasks are idle.

The user never types SSH commands, edits configuration files or copies account tokens. Tailscale login/membership, Windows elevation, account consent and folder selection are intentional user actions. GitHub's short device code is displayed inside the wizard and its official login page opens automatically.

The package lasts one day. Reopening the same package uses its saved folder choice and exact submitted report. A lost website response or repeated download retains the same enrollment ID and keys. The browser remembers the pending download within its account-scoped session. If the package expired, was revoked or the computer identity changed, create a new connection; the old registration is not silently replaced.

## Installation owner

Configure `team.hubTailnetAddress` only after the Hub has a real private Tailscale IPv4 address and the member's PC can reach it. Without it the website shows an explicit setup state and cannot produce a misleading installer. At this checkpoint the running Hub has not been enrolled in Tailscale or otherwise reconfigured.

The installer preserves existing SSH configuration and unrelated keys. It adds distinct no-PTY command and PTY terminal keys restricted to the Hub address, with forwarding disabled. It scopes the standard OpenSSH firewall rule with an explicit Windows-side confirmation and stops for custom broader SSH rules instead of rewriting them. Existing SSH sessions and active Companion tasks are not terminated. Non-standard Windows/domain/OpenSSH installations may need local review.

Approval reads the machine through pinned system SSH and performs a harmless Companion readiness probe. It does not start/resume a native conversation. Personal-runtime activation blocks active or uncertain native work and permits replacing verified idle terminal sessions. Another user's runtime stays mounted.

Registry backups retain the approved owner/machine identity and private transport keys. A restored installation blocks native admission until host-side release checks; copying a snapshot cannot reconnect to live writers automatically. Offboarding key/Tailnet cleanup and full browser-profile restore admission remain part of the team's lifecycle gate.

## Verification and remaining work

The current checks cover installer packaging and PS5 UTF-8 decoding, native status handling, fingerprint display, firewall rule classification, exact retry, root containment, approval authorization, owner-only transport materialization, runtime recovery and identity-preserving backups. Windows checks render controls offscreen and use harmless native fixture commands; they do not install software or change the owner's SSH/firewall/accounts.

The first real friend-PC installation, simultaneous native-account workflows, Windows Remote setup and final lifecycle acceptance remain tracked in [the roadmap](ROADMAP.md). Personal GPT provisioning and its isolated browser are described in [TEAM_GPT.md](TEAM_GPT.md). An installed package is not evidence of a completed hardware test.

Native Codex installation follows [OpenAI's Windows instructions](https://learn.chatgpt.com/docs/windows/windows-app). Dependencies use their official WinGet sources; GitHub authorization remains in [GitHub CLI](https://cli.github.com/manual/gh_auth_login).
