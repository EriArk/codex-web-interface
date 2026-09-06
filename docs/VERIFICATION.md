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

The configured deployment uses Windows Codex and VNC. A separately authenticated local Linux Codex, RDP hosting, additional machines and general filesystem/Git UI have not been exercised in this installation.

No real website password is created by verification; test enrollment uses random credentials in an isolated, in-memory QA server.

## Native catalog and Remote revision — 2026-09-06

- Native App Server project discovery returned 10 real local Windows projects. Read-only checks opened the 13 then-listed non-archived conversations, covering both paginated and legacy history.
- Real authenticated Hub API checks discovered those projects, checked every project machine status, fetched non-overlapping 20-message pages and rejected anonymous access and a project creation without CSRF.
- A unique temporary project and empty Windows folder were created through native APIs. A real turn remembered a random word; after App Server teardown, the same conversation resumed and recalled it. An unsent draft also survived a separate App Server restart. Test threads were archived and verified empty test folders removed.
- Native project creation was visible through App Server project/list. The running desktop application did not immediately add it to its separate saved-folder sidebar. This is documented; no desktop state-file mutation was used.
- 19 Node tests passed, including source catalog identity/deletion, command-heavy history paging, native/stream reconciliation, legacy Results navigation, empty drafts, relative/direct pointer coordinates, stylus, cancellation, two-finger scroll/right-click and pinch detection.
- Chromium and WebKit completed login/history/model/mode/effort/attachment/approval/reconnect scenarios with simulated Codex and real Windows VNC. A rendered desktop screenshot was saved through the authenticated Results API.
- At 844×390, the connected Remote surface occupied the full 390px viewport height and mobile navigation was hidden. Switching touch modes kept the session connected.
- All three themes were captured and inspected. The layout suite covered 390×844, 375×667, 844×390, 820×1180 and 1366×1024 in both engines: 30 theme/viewport combinations, with no horizontal overflow or clipped composer. Project creation and the directory picker were also exercised in both browsers.
- Actual Apple Pencil/iPhone gestures and standalone iOS behavior still require owner hardware verification. Browser engine simulation is recorded separately from the native Windows protocol checks.

## iPhone Remote keyboard revision — 2026-09-06

- Replaced the zero-size Guacamole InputSink and its deferred focus with a nonzero native textarea focused synchronously by the keyboard button. The same button now closes the keyboard and reflects focus state.
- Keep touch-to-click activation intact in WebKit; prevent only mouse-driven focus loss when toggling. A pointerdown cancellation blocked the synthetic touch click in the regression browser and was removed before release.
- Keep text input working after IME composition and suppress a duplicate final composition input. Reuse one Guacamole keyboard per mounted pane and clear connection callbacks on teardown.
- The dedicated `scripts/qa-remote-keyboard.mjs` check runs Chromium and WebKit with touch at 390×844, then 844×390. It covers synchronous tap focus, nonzero input geometry, open/close, Russian text, composition commit without duplicates, subsequent text, Backspace/Enter, chat input isolation and reconnect without duplicate keys.
- This focused suite uses the actual vendored Guacamole keyboard with a simulated display/transport. No test keystrokes are sent to the owner's Windows desktop. Real VNC transport/rendering was checked separately in the previous revision.
- Native iOS keyboard appearance and behavior in installed PWA/Safari still require the owner's physical iPhone. The browser engine check does not establish that a system software keyboard appeared.
