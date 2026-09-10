# Devices

The Devices workspace is separate from execution projects. A device is a configured system SSH target, platform, display name and enabled action set. Initially it contains the Linux Hub host and Windows PC; discovery and arbitrary browser-supplied hosts are intentionally absent. Additional devices use the same contract when their SSH connection is configured.

Browser → authenticated Hub → system OpenSSH → selected device. Hub never proxies a public raw SSH/Codex listener. The Windows terminal has its own Hub-IP-restricted key with PTY enabled; the original no-PTY Codex key and Companion remain unchanged. The Linux terminal connects to the host, not its application container.

`GET /api/devices` exposes display metadata only. A fixed read-only snapshot collects OS, CPU, memory, uptime, disks and available thermal zones. A 15-second shared cache and bounded processes prevent polling from starting Codex or accumulating probes. ACPI/thermal-zone values retain their sensor names; missing sensors do not imply a zero-degree CPU.

An explicit terminal creation uses a durable idempotency receipt. SQLite schema 20 stores only terminal identity, owning login session, device, lifecycle and timestamps. Input/output stays in memory: at most eight open terminals, twelve retained closed screens, 64 KiB tail per terminal and 24-hour maximum lifetime. Browser closure detaches; reopening finds the existing terminal. Hub restart marks previous sessions closed and never replays commands. Deployments must wait for open sessions.

WebSocket attachment requires the same live login, exact Origin and a CSRF-protected single-use short-lived ticket sent in the first frame. Every input revalidates login; expiry/logout cleanup closes owner PTYs. Bound frame sizes, input rate and slow-client buffers. Remote OSC clipboard writes are suppressed; terminal output is interpreted only by xterm, never HTML. Password entry belongs to the native terminal and is not copied into HTTP requests, logs or SQLite.

Power and network-mount forms confirm a named target and open a separate command terminal, never inject commands into a running shell/program. Linux uses ordinary sudo permissions; SMB requires the host's cifs-utils and NFS requires its mount helper. Windows uses PowerShell and SMB mappings in the SSH logon session. An action can fail for OS permissions or missing helpers; its actual terminal output remains visible. No destructive action is exercised in automated or production smoke tests.

The UI shares theme tokens, uses a system/terminal split on wide tablets and two views on phones. Hiding the workspace preserves chat selection, drafts, scrolling and native work. Terminal code loads only when Devices is first opened.

Command-result output is a different, read-only feature: resolve the stored result's thread, turn and native command identity, then lazily retrieve its matching saved Activity event. Older cards work without duplicating output into every Results response. Empty output and no retained output are distinct states.
