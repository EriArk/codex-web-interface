# Verification record

Checks were run on the Linux server against the user's Windows machine and in isolated browser containers during the initial implementation.

## Real environment

- Windows OpenSSH key authentication, strict pinned host key and Hub-only inbound firewall rules.
- Codex 0.153.4 initialize/account capabilities and native model/mode discovery.
- A read-only Codex turn actually opened the Windows project README through the Companion.
- The Hub kept a real Windows turn running after its browser event socket disconnected; event replay worked on reconnect.
- A real GPT-6-Astra turn with low effort and native Plan mode read a unique word from an SSH-staged text attachment and identified a solid-blue image.
- Guacamole 1.6.0 connected to TightVNC on Windows Home and rendered the 1920×1080 desktop.
- Built the production image on Linux with Node 24.18.0 and pnpm 11.13.1.
- Public HTTPS assets and password-enrollment form were checked without enrolling the owner. Unauthenticated data access and invalid setup tokens were rejected.
- After a hostname-specific Windows DNS correction, normal Windows DNS, HTTPS health and the actual browser login page all loaded successfully.

## Automated tests

Node tests cover bounded 20-message history, delta aggregation, cursor non-overlap, idempotency, unknown outcomes on restart, approval/question scoping, password enrollment, Argon2id storage, cookies, Origin/CSRF enforcement, unauthenticated API/WebSocket rejection and logout revocation.

Additional checks cover model/effort validation, actual collaborationMode payloads, plan events, attachment ownership, image normalization, original file integrity, authenticated download, removal before sending and fragmented Guacamole instructions. The Remote regression prevents keepalive messages from being inserted into incomplete frame data.

The browser suite runs Chromium and WebKit in a Linux Playwright 1.62.0 container at 390×844 and 1366×1024. It checks initial history size, manual history loading without scroll jumps, project shell behavior, drafts across views, result-to-turn navigation, settings after reload, file attachment/removal, approvals after reload, real Remote connection/screenshot, themes, wide layout and absence of page errors.

Browser Codex replies and approval requests are simulated deliberately. The separate smoke tests above establish actual Windows Codex execution and real file/image input.

## Still requiring owner hardware verification

Physical iPhone/iPad Safari and standalone PWA installation, real iOS software keyboard/rotation, background suspension and extended touch Remote use. Linux WebKit is a useful regression engine, not a physical iOS device.

The configured deployment uses Windows Codex and VNC. A separately authenticated local Linux Codex, RDP hosting, optional extra projects/machines, general filesystem/Git UI and automatic import of external threads have not been exercised in this installation.

No real website password is created by verification; test enrollment uses random credentials in an isolated, in-memory QA server.
