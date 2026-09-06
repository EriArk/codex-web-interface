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

## Repository CI

GitHub Actions runs the portable build, Node tests, typecheck and lint on pull requests and main using the pinned Node and pnpm versions and frozen lockfile. A tracked-file guard rejects runtime/build directories, private configuration and recognizable key/token formats without printing their contents. This is a focused guard, not a guarantee that arbitrary secret formats can be identified. No production credentials, Windows host, Codex account or live Remote connection is required.

Private integration scripts and physical iOS acceptance remain separate opt-in evidence.

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

## Send, questions and visual coherence revision — 2026-09-06

- Build and TypeScript checks passed on Linux; 24 Node tests passed. New cases cover HTML/empty gateway responses, native writer-conflict classification, attachment copy ownership/integrity, unassigned native chat mapping and structured multi-question answers. Biome exits successfully with existing CSS specificity/reduced-motion warnings and style suggestions.
- scripts/qa-real-send.mjs ran an authenticated Hub against real Windows Codex with an isolated in-memory database and temporary test threads. It sent a native Plan-mode turn, received a real tool/requestUserInput choice, answered through the Hub API, observed completion/progress, reproduced the second-writer 409, forked completed context, and verified recall of a random word in a second turn. Temporary native threads were archived; the owner's database and original conversation were not modified.
- The same original native ID cannot be written by both App Servers while the desktop retains its writer, including some idle states. A supported writer takeover is unavailable in installed Windows Codex; the explicit-copy fallback is documented rather than described as seamless same-thread continuation.
- scripts/qa-workflow.mjs passes Chromium and WebKit at phone/wide sizes: multiple project expansion, standalone-only tab, image-first/collapsed-code Results, readable simulated gateway/writer failures, preserved draft, explicit copy with pending file, immediate work state and native-shaped multi-question/choice/free-text answers including reload recovery. Network-error injection deliberately disables service workers in this suite.
- scripts/qa-pwa-send.mjs separately passes both engines with an active service worker and real HTTP requests to the isolated QA Hub: create a new chat, send, restore a pending approval after reload, respond, and return to idle. Codex in this browser suite is simulated; the real protocol check is separate.
- The theme suite covers 30 combinations (three themes, five viewports, two engines) with an actual populated QA chat, no page overflow and a visible composer. It also creates QA projects and opens the directory picker.
- scripts/qa-visual-audit.mjs captures 46 additional WebKit screens across the three themes: login, settings, project/projectless lists, new project/folder picker, populated chat, Results/image viewer, remote start/connected/controls/landscape and wide chat/Activity. Local font loading and 44px picker geometry are checked. Remote uses a simulated display; no owner desktop input is sent. Screenshots exposed and helped fix stale remote canvas reuse after leaving the connected view. Rotation captures wait for visualViewport/ResizeObserver updates; the landscape controls fit the available height.
- The dedicated Remote keyboard suite passed again after teardown changes in Chromium/WebKit, including synchronous touch focus, Russian input, IME, Backspace/Enter and reconnect without duplicate keys. Native iOS keyboard appearance, hardware gestures and installed-PWA suspension still require physical iPhone/iPad testing.
- Screenshots/reports and random QA credentials remain in ignored .local directories. Bundled font license/source are in apps/web/public/fonts; production fonts are served from the Hub.

## Web-primary writer and update revision — 2026-09-06

- The owner selected the website as the primary, intended sole client. The independently scheduled Windows Companion runs without the desktop ChatGPT/Codex UI. Existing desktop-held conversations need a one-time full desktop exit after its active work finishes; the Hub does not force that exit.
- Linux build/typecheck and 25 Node tests passed, including retaining the same imported native writer across consecutive completed turns without unsubscribe/resume.
- scripts/qa-real-handoff.mjs reproduced an idle writer conflict on real Windows Codex using only an isolated test conversation. After stopping that test's first App Server, a second Hub session resumed the original native ID and recalled its random marker in two successive turns. No fork or owner-desktop shutdown occurred; the temporary conversation was archived.
- Updated scripts/qa-workflow.mjs passed Chromium and WebKit: failed and successful same-thread access checks retain the draft and uploaded file, never fork or automatically send, then allow an explicit send with structured question/answer recovery. Existing navigation, Results, compact selectors and wide layout checks passed.
- Updated scripts/qa-pwa-send.mjs passed both engines with active service workers: a simulated stylesheet-only release is detected, updating remains explicit, and the draft plus uploaded file survive reload. HTML, sw.js and version.json return no-store. Real HTTP send to the isolated QA Hub and pending approval after reload still pass. Browser Codex replies are simulated; the real Windows handoff check is separate.
- WebKit phone screenshots of the update notice and restored composer were inspected. Physical iOS/PWA acceptance remains the hardware check described above.

## Storage, diagnostics and repository baseline — 2026-09-06

- PR #1 landed in main after its clean GitHub CI run passed; v0.1.0 identifies the exact deployed application source b269368.
- Linux build/typecheck and 33 Node tests passed. CI now bounds each test file to 30 seconds. Migration cases cover an empty DB, the deployed version-1 schema with data, automatic private checkpointing, atomic rollback on failure and rejection of a newer schema.
- Snapshot tests cover a live WAL database, exact file bytes, preserved auth/native mappings, old-session revocation, unknown pending work, safe retention, refusal to overwrite a target and rejection of corrupted/missing/symlink files and native-auth packaging.
- scripts/qa-real-restore.mjs restored an isolated Hub snapshot and continued the same real Windows Codex conversation, recalling its random marker. The original Hub/native IDs and pending file survived; old browser sessions were rejected. Only the test's own App Servers/conversation were touched.
- A full protected snapshot of the actual production schema-1 database/configuration was restored into a disposable directory, migrated to schema 2 and booted successfully. Auth, threads, messages, Results, uploads and native catalog projections compared equal; restored sessions were revoked. Production remained unchanged during the rehearsal.
- Doctor tests preserve running thread/session rows and exclude sensitive injected configuration/RPC fields. A real read-only report passed Hub HTTP, SSH, Companion stdio, Codex 0.153.4/login, project/model/Plan metadata, guacd and Remote TCP/secret presence. Pending migration and unrestricted project roots were reported as warnings rather than hidden.
- Daily backup unit templates passed systemd verification. Their source mount is read-only, output private, network disabled and image pinned. The private owner runbook was preserved before replacing repository instructions with generic paths; Windows setup now requires explicit account/Hub/project inputs.

## Live navigation and realtime output — 2026-09-06

- Linux build, typecheck, lint and 37 Node tests pass. New tests verify aggregate counts beyond the 200-row navigation bound, stable active ordering, archived/disabled filtering, completion/read persistence, stale receipt safety, duplicate completion handling, metadata-only delivery and two-client WebSocket updates/logout cleanup. A request-budget regression covers 650 asset requests, the bounded API read budget, independent writes and the unchanged five-attempt password limit.
- scripts/qa-activity.mjs exercises phone Chromium/WebKit and a second wide client: streaming text and new image/check cards before completion, active-first navigation, badges surviving reload, cross-device read receipts, standalone counts, unread scrollback and offline event replay. Wide image overlays defer read receipts, and held old result responses cannot replace a newly selected thread's feed. Resize observation keeps the chat anchored across font/chip/keyboard layout changes unless the reader scrolls away. Screenshot outputs cover the three semantic themes.
- scripts/qa-real-stream.mjs uses an isolated Hub and an actual Windows Codex conversation. A print/wait-only command produced a structured check card through the authenticated Hub stream before turn completion; assistant text streamed too. The result event preceded completion by about five seconds. The temporary conversation was archived; owner threads and production storage were untouched.
- The actual production schema-2 snapshot was restored into a disposable directory and migrated to schema 3. Existing owner credentials and all conversation/result/file mappings compared equal; historical work starts read and only the restored sessions were revoked.
- Physical iPhone/iPad Safari/PWA checks remain tracked separately in issue #10; browser emulation does not close them.
