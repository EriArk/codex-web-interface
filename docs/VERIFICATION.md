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

## Repository verification

Per the owner's 2026-09-11 decision, builds and checks run on the Linux server; GitHub Actions is disabled and its workflow removed. GitHub remains the source history, issues, PR and release service. Hosted check status is not a deployment prerequisite.

Use the pinned Node and pnpm versions and frozen lockfile. The portable commands are `node scripts/check-repository.mjs`, `pnpm install --frozen-lockfile`, `pnpm test` (includes the build), `pnpm typecheck` and `pnpm lint`. Run the relevant `tests/*.browser.mjs` suites in the Linux Playwright 1.62.0 container, preserving Chromium and WebKit coverage. Windows-specific checks remain in `tests/*.tests.ps1` and are run when a Windows change needs them. Select checks appropriate to the change; documentation-only edits do not require a full rebuild.

The tracked-file guard rejects runtime/build directories, private configuration and recognizable key/token formats without printing their contents. This is a focused guard, not a guarantee that arbitrary secret formats can be identified. Portable tests do not require production credentials, a Windows host, a Codex account or a live Remote connection. Existing idle guards and post-deployment verification remain required.

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

## External activity, native queue and compatibility — 2026-09-06

- Linux typecheck/build and 48 Node tests pass, including native-status read-only fixture checks, stale unfinished records, historical/read baselines, repeat completion handling, queue edit revision races, exact-turn Steer, dequeue races and uncertain transfer recovery without retries.
- A read-only probe of currently active desktop tasks confirmed that raw native metadata reports inProgress while another App Server's thread/read and turns/list report notLoaded/interrupted. The fixed SSH reader and isolated Hub detected current work without acquiring any owner thread. The observer reads metadata only.
- scripts/qa-real-queue.mjs passed against Windows Codex 0.153.4 through the authenticated Hub API: native queue add/edit/delete, exact-turn Steer without duplicate queue execution, automatic second turn and one live user message. Only its disposable test conversation was archived.
- scripts/qa-queue.mjs passed Chromium and WebKit on phone and wide/tablet layouts: queue editing/deletion, refresh persistence, second-device synchronization, Steer, automatic next turn, no page errors and no horizontal overflow. Screenshots were inspected. Browser tests use a matching Playwright 1.63 driver/browser pair in an isolated Linux runner; repository Node tests retain the pinned workspace tools.
- Compatibility tests cover unverified version warnings, explicit unsupported Plan/config degradation to available Work, rejection of an unsupported selected mode before turn/start, and distinct offline/login/core-method failures. The real native probe reports the installed version.
- Physical iPhone/iPad checks, including actual software keyboard behavior and background suspension, remain issue #10.


- Native image regression: the owner's paged Windows conversation returned exactly 20 messages; its actual localImage was copied read-only through SSH, normalized into a 471,860-byte private PNG preview and fetched from cache. The service-file wrapper was removed from displayed text; the native history was unchanged. A WebKit session against the isolated native Hub showed three active project spinners, the current chat spinner, the real image and its enlarged viewer without page errors. Organizer/CRT/hi-tech screenshots were inspected.
- Native image tests cover cached availability after the source disappears, no source-path exposure in Hub image references, wrapper removal restricted to structured attachments, rejection of remote URLs/non-image paths/invalid raster contents and restart-compatible message references.
- The opt-in native queue verification also probes initialize/account, project/list, thread/list/read/start/resume, model/collaboration choices and paged turns/items. All exercised shapes passed on Windows Codex 0.153.4.
- The production schema-3 snapshot was restored and migrated to schema 4 in a disposable location. Owner authentication, native mappings, messages, Results and attachments compared equal using the original columns; only restored sessions were revoked. The restored Hub booted successfully.


Desktop restart checks: `tests/desktop.test.mjs` covers auth, CSRF/Origin/strict request rejection, Hub/native activity guards, duplicates, unknown acknowledgement recovery and read-only metadata. `tests/desktop-control.tests.ps1` extracts only the maintenance function and simulates every OS effect. Seven cases cover idle restart scope, preserving Companion's independent App Server, active/unknown activity, Session 0, expired requests, harmless probe and no completed-operation replay. `scripts/qa-desktop.mjs` uses real isolated Hub/auth and simulated desktop responses to verify phone/tablet Settings across themes in Chromium/WebKit, confirmation/cancel, reload during restart, completion and unavailable states.

On the owner's installation, real system-SSH status and the demand-only interactive Probe passed while the same desktop and Companion processes remained running. The actual owner desktop was not restarted during development. Physical restart/relaunch remains a user-triggered acceptance check after current work finishes.


Access and recovery update (2026-09-06): new tests cover opt-in full permission profiles, managed denial, explicit normal reduction, settings acknowledgement reconciliation, persisted desktop handoff with no passive reacquisition, confirmed hard restart despite unavailable activity, and attachment staging failure followed by exactly one explicit retry. Steer tests retain accepted receipts until the matching user event and prevent changing an accepted message. Progress tests permit only bounded native public summaries and actions, reject raw reasoning content and scope results to the selected turn. Usage tests identify a weekly window in either native slot and omit billing fields.

Real Windows Codex 0.153.4 checks used disposable native conversations: text plus a generated solid-color image was transferred and correctly interpreted; full access survived closing/reopening the Hub session, and normal access was restored natively. After manual handoff, another App Server resumed the same native conversation while passive Hub reads did not reclaim it; explicit return to the Hub then succeeded. Force-disconnecting a running second turn in a persisted disposable conversation left the native turn interrupted and the recovered Hub idle. No owner desktop or Companion restart was performed. Nine PowerShell cases simulate every process effect, including hard restart with active/unknown activity and refusal in Session 0.


Final access/recovery verification: 63 Node tests, TypeScript checks and Biome checks passed on Linux. Chromium and WebKit passed scripts/qa-access.mjs and scripts/qa-desktop.mjs with no page errors. Coverage includes all three themes at 390x844, 375x667, 844x390 and 1366x1024; 44px access controls; edge-swipe guards; image draft preservation after staging failure; enabled Stop during transfer; visible accepted Steer receipt until native echo; one expandable/collapsible recent-work panel with collapsed commands; task boundaries; native-shaped weekly quota display; manual handoff/return and confirmed hard restart with simulated OS responses. Screenshots of phone, landscape, tablet, all themes, progress, queue receipts, boundaries, quotas and confirmation were inspected. Synthetic touch events do not replace physical iPhone Safari/PWA edge-gesture acceptance.

The installed Codex also returned native account/rateLimits/read data successfully, including a weekly primary window and separately named limits. Quota reads were read-only. Deployment is deferred until all Hub-owned turns finish because the development conversation itself uses the production Hub; a pinned prebuilt image, online SQLite backup, unchanged enrollment check, public asset/auth verification and independent service report guard activation.

## Active client handoff (2026-09-06)

The isolated two-client Windows Codex 0.153.4 probe verified a blocked second writer, explicit interruption, resume of the same native thread from another App Server, preservation of pending queue text and remembered context, and return to the original native ID. A resume alone started no new turn. Tests use disposable native threads; they do not press the owner's desktop Retry or interrupt owner tasks. Actual desktop UI Retry remains a manual acceptance check.

Hub tests cover waiting for the native completion event, concurrent write/duplicate handoff rejection, unknown ownership and in-flight write refusal, a lost interrupt acknowledgement, explicit reverse-close confirmation, native-close idempotency, background recovery after a lost acknowledgement, and rejection of failed/unrelated operation results. The Windows harness simulates every process effect and checks ForceRelease closes only the desktop tree without relaunching or touching Companion-owned App Servers.

Validation passed: 70 Node tests, TypeScript and production build; 11 Windows maintenance checks with simulated effects. Chromium and WebKit covered cancellation, confirmed active handoff, reverse-close confirmation, page reload during return, hard-restart isolation, phone/tablet layouts and all three themes without page errors. Mobile confirmation screenshots were inspected. The installed Windows handler was backed up, hash-verified and checked with Status only; desktop process IDs were unchanged.

## Reference theme refresh and classic dark (2026-09-06)

The isolated theme-style browser audit checks all four themes at 390x844, 375x667, 844x390, 820x1180 and 1366x1024 in Chromium and WebKit. It covers settings, project drawer, chat, Results, image viewer and Remote idle. All four themes also cover Activity, simulated connected Remote portrait/landscape and browser chrome; CRT and classic dark cover cached login. It verifies saved Hub preference reloads, draft preservation across theme changes, local Cyrillic font loading, increased-contrast text, unfiltered images/canvas, visible composer and full Remote bounds. The owner desktop is never connected or operated by the fixture. Screenshots remain in ignored private review directories.

Final checks passed: 70 Node tests, TypeScript, production build and Chromium/WebKit audit (110 screenshots). All four themes were visually inspected against the owner references on phone and tablet; preference round trips, local font requests, increased contrast and full-size simulated Remote passed. Physical Safari/PWA appearance remains device acceptance.

## Large attachment transfer and upper status cleanup (2026-09-06)

The previous SSH/PowerShell stdin implementation reproduced a 60-second timeout with a generated 1 MiB blob. The replacement system SFTP staging transferred and hash-verified a generated 25 MiB blob on the installed Windows machine in approximately two seconds. An isolated authenticated Hub with an in-memory database sent text plus an 8.2 MB PNG under normal permissions and a 2.6 MB JPEG under full permissions; each transfer/start took about three seconds. Native Codex identified the image color, native permission state matched the selected mode, and repeating the same idempotency key produced no duplicate user message. Only disposable native conversations were created and archived; owner threads and desktop processes were untouched.

79 Node tests passed, including SFTP argument injection rejection, fragmented Unicode acknowledgements, unavailable SSH/SFTP, timeout cleanup, oversized responses, invalid destinations and wrong integrity acknowledgements. TypeScript and production build passed. The browser audit exercises four themes, removal of the duplicate upper status, retained expandable progress, preserved text/image after a staged-send error and a successful explicit retry with the same request key.


Standalone progress duplicate correction: the extra working/spinner row after the messages is removed, leaving the single expandable composer progress control. Targeted Chromium/WebKit screenshots at 390x844 and 1366x1024 verify an active turn, absence of the extra row, one composer progress control and expand/collapse without page errors. Production build passed.

## GPT, multi-device chronology and HTML demos (2026-09-07)

The optional private Linux browser backend was verified against the owner's signed-in ChatGPT account using disposable conversations: real catalog/projects/history, native model and power changes with restoration, a new conversation, text plus a TXT file and an image in one send, streamed output, and image generation. The generated PNG was downloaded through the authenticated Hub asset route and visually checked. A send accepted through the custom web form completed after that browser was closed and appeared on a second WebKit client. The isolated browser retained its login after moving to the persistent Compose service; the protected gateway is a persistent user service.

Tests cover serialized/idempotent GPT jobs, ambiguous submission and restart without replay, hidden-output filtering, native active-branch history and old outbox entries. Chromium and WebKit inspect real GPT history/images on phone and tablet across four themes. Screenshots were visually reviewed. This does not imply exact parity for every ChatGPT control: the original protected interface remains available.

The chronology regression is reproduced with a long active turn where older Hub users fall outside the newest native page, and with bound photo attachment envelopes. Latest pages and older pagination preserve all unique messages in order. A read-only copy of the actual affected native conversation and Hub messages passed three independent fresh-client history reconstructions, without changing production data.

Actual TrainerOs HTML was fetched from Windows through the bounded SSH reader and its hash checked. Chromium mouse and WebKit touch verify native demo tabs, material controls, phone fit/960px sizing, close/return to chat, and authenticated access. The sandbox blocks parent DOM, cookies, storage and network fetch. Browser screenshots on phone/tablet were inspected. Chromium's CDP touch path double-subtracts sandboxed cross-process iframe offsets, so touch acceptance uses WebKit; no compensating coordinate code is applied to the app. Playwright service-worker blocking is disabled for this fixture because its injected hook tries to access sandbox-denied navigator.serviceWorker.

Final portable suite: 92 tests; production build, TypeScript, Biome (no errors), repository content guard and optional connector syntax checks. Physical iPhone/iPad Safari/PWA acceptance remains with the owner.


## Recovery of interrupted outbox work — 2026-09-08

Replaces the incomplete outbox change in 94bf034 with the recovered server work. Failed GPT submissions can be deleted with the shared confirmed menu or replaced atomically when resent. Dismissed records retain their idempotency fingerprint, cannot be replayed by a delayed retry, and disappear from other clients. Unknown outcomes require the existing explicit review; they cannot be dismissed as if cancelled. Cancellation during async preflight never reaches the native composer.

Codex deletion now recognizes an empty web-created thread that has no native rollout after reconnect, and recognizes a native archive even when Hub metadata is stale. Nonempty/unconfirmed/active/queued chats retain their guards. Native error classification preserves actionable rejection messages.

Windows Companion was still launching a desktop bundle whose helper executables had been retired by an application update. Installation now snapshots the complete explicitly selected desktop runtime and verifies hashes, leaving custom CLI paths unchanged. The live Companion was switched to the private snapshot; the owner's desktop process was not restarted.

Validation: 151 Linux server/unit tests, build, typecheck, lint and tracked-file checks; Chromium/WebKit copy, GPT preparation/outbox, Remote input and 25 preview-isolation vectors; Windows PowerShell runtime pinning/cleanup/reinstall tests. A disposable native Windows conversation proved streamed output, a real command through the repaired tool host, text/image attachment preparation and recognition, and subsequent native deletion. An empty native web draft was also deleted after its original App Server closed. The actual deployed doctor confirms authenticated Codex, model/Plan discovery, GPT read/send readiness, private connector state, Remote and public HTTPS. Physical iPhone/iPad acceptance remains the owner's ongoing usage checks.

## Send-time web handoff receipt regression — 2026-09-08

The first send from a desktop-owned conversation was stored as an uncertain command even
though ownership rejected it before submission. Confirmation then reused the correctly
preserved send key and hit COMMAND_OUTCOME_UNKNOWN. Check ownership before external
activity and classify failures before the local message commit as NotSubmittedError;
retain uncertain receipts once message commitment starts. No old unknown receipt is reset.

Regression coverage uses the actual Hub routes and Store, with isolated native RPC and
desktop process effects: desktop activity, repeated rejection/cancellation, ownership
changing during preflight, the same native conversation and key with text/attachments,
and a lost native turn acknowledgement that cannot replay. Chromium/WebKit run the full
built application against an isolated HTTP Hub, exercising upload, cancel, confirmation,
draft clearance, one native send and no restart. The browser check is included in CI.
No live owner desktop handoff/restart is exercised.

## GPT files and installed-PWA saving — 2026-09-08

Canonical visible assistant sandbox links now resolve to conversation/message-scoped Hub
downloads and appear in Files/Images Results. Download requests revalidate the current
native branch and exact linked path. The private connector obtains native signed URLs
inside the authenticated ChatGPT origin; only bounded binary content leaves it. No native
credentials or signed asset URL is exposed to the client.

Shared save controls fetch into a closable in-app dialog before a fresh tap invokes file
sharing. Cancellation, slow transfers and errors preserve the workspace and draft. Ordinary
download fallback uses a separate target and neutral binary MIME for executable documents;
closing cancels preparation and releases object URLs/file buffers. WebKit requires fresh
activation for sharing: https://webkit.org/blog/13862/the-user-activation-api/ . The reported
installed-PWA trap is documented at https://bugs.webkit.org/show_bug.cgi?id=236943 .

Tests cover normalization, path/branch scope, native URL handling, retry, close during
download, cancelled share, exact file bytes/names, phone/tablet return and non-share fallback
in Chromium/WebKit. Native sharing is simulated in browser automation; physical iPhone
share-sheet acceptance remains the owner's normal device usage. Actual owner-provided
Markdown, JSON, TXT, PDF, DOCX, XLSX, Python and ZIP artifacts were fetched through the
private connector with successful status, nonzero content and SHA-256 checks.


## 2026-09-08 — Recovery, desktop dynamic workspace tool and notification reload

175 portable tests pass. New protocol regressions exercise readonly runtime lookup,
argument/namespace rejection, normal failure for unknown tools, deduplicated redacted
Results and native resume status after an empty excluded-turn response. A real Linux
SSH probe found the owner's Windows bundled runtime 26.905.11957, Node/Python executables
and document plugin paths without installing software or touching any conversation.
Chromium and WebKit pass slow recovery, double-click guard, failure/retry, running/idle
feedback, preserved drafts and zero prompt replay/restart. The notification test now
holds preference writes across a cold reload and checks GPT immediate reload as well.
Phone screenshots were inspected; physical iPhone/PWA acceptance remains owner usage.

The earlier whole-host reboot had an unclean journal boundary; available logs did not
establish power loss versus hard reset or host hang. These client recovery changes are
not evidence of a repaired hardware/power cause.


## 2026-09-08 — Project Results library and artifact snapshots

181 portable tests, including new source-intent/path/reparse/oversize cases, immutable
bytes and checksums after source mutation, failure/restart/retry without duplicate cards,
aggregate quota, authenticated downloads, project/category paging and backup verification.
A real system-SSH read of Windows README.md matched the local SHA-256 exactly (5304 bytes).
Chromium/WebKit phone/tablet workflows cover the project scope, category filtering, file
preview, cross-chat origin, preserved drafts and zero writer acquisition. Screenshots cover
all four themes and the requested brighter public commentary; these are browser checks,
not a claim of a completed physical iPhone/iPad acceptance pass.


## Project Files/Git inspector — 2026-09-08

- Real Windows read-only probe: browsed `apps/web/public`, read the current branch and 12 commits through the configured SSH/Node path. Native writers and desktop maintenance were not invoked.
- Raw SSH PNG transfer matched the Windows source exactly: 5420 bytes, SHA-256 `4da6f3c02d18169dbe5fc1979d4be818add08ea46c98e852588b35d9eb227203`.
- Portable tests cover bounded directory pages, secret/path/symlink exclusions, large file refusal, unborn/staged/working/untracked/renamed Unicode files, nested projects, detached state, binary and truncated diffs, invalid repositories and index preservation. Marker scripts configured as fsmonitor/external diff/text conversion never execute.
- Authenticated routes are tested for exact binary bytes, filename headers, no-store, authentication, parameter rejection and absence of writer acquisition.
- Chromium/WebKit workflow exercises closable previews, current Git diff, Results-to-file navigation, preserved draft and phone/landscape/wide layouts across shared themes. Device acceptance continues through the owner's actual iPhone/iPad usage.
- Before the preceding schema11 artifact deployment, an isolated copy of the real schema10 database migrated with unchanged row counts and integrity `ok`. Rollback rehearsal refuses changed application data and restores an untouched schema-only upgrade copy. Production is not used for rollback testing.

- A disposable Windows fixture verified Cyrillic/percent filenames and rejected an actual NTFS junction plus parent traversal. The small fixture remains under ignored `.local` after cleanup was blocked by automatic review. Rapid navigation reads share a small bounded queue, avoiding a spurious busy error when a prior tab read is still finishing.


## Focused machine diagnostics — 2026-09-08

- Six portable tests cover normalized layers, unavailable SSH/Companion, malformed/logged-out accounts, redaction, client cleanup, cached/stale/last-seen state, request deduplication, auth/CSRF and rejection of browser-supplied hosts/commands. Linux OS metrics require no SSH.
- Real Windows probe confirmed SSH, Codex 0.153.4, Companion startup, native account/model responses and the configured Remote port. Fixed read-only CIM metrics returned memory/disk/CPU/boot time. The fresh protocol client did not load a conversation or invoke desktop maintenance.
- Chromium/WebKit exercise phone/landscape/tablet, explicit checks and offline feedback, preserved draft, entry from both Codex and GPT, and returning to a Codex project. The ordinary overview performs no SSH probe. Physical device acceptance remains the owner's everyday usage.

## Notes/Pins module — 2026-09-08

- 198 portable tests pass, including Unicode/literal search, scoped CRUD/pagination, optimistic conflicts, lost-response idempotency, missing Result/thread/note links and auth/CSRF.
- Existing full workspace snapshot/restore test now verifies note bodies/revisions/backlinks and generic pins alongside GPT uploads, HTML previews and native mappings.
- Chromium/WebKit: phone editor, close/reload draft recovery, Markdown/copy blocks, concurrent edits, lost save acknowledgement/retry, pin navigation, destructive confirmation, unavailable links, landscape/wide geometry, GPT draft preservation and return to the original Codex chat. No thread resume/start or desktop handoff occurs.
- Production installation is queued behind earlier verified idle deployments; these checks use isolated fixtures, not owner-device acceptance.

## Lightweight Plan module — 2026-09-08

- 202 portable tests: scoped CRUD/search/pagination, priorities, invalid/leap dates, local-date filtering, completion/reopen timestamps, revision conflicts, missing backlinks, auth/CSRF and full snapshot/restore retention.
- Chromium/WebKit phone/tablet checks cover persisted task drafts and fields, completion/reopen, task pins, Result → task → exact Result navigation, and GPT chat draft continuity. The shared Notes browser regression is also retained.
- Phone screenshot inspection found a clipped native date field; it now gets a full readable row. Builds and verification run on Linux using isolated fixtures; no owner task is interrupted. Deployment waits for idle after the preceding Notes release.

## Project overview — 2026-09-08

- Bounded-module tests verify active/unread counts, missing and empty project state, cached/offline machine and directory-bound Git summaries, auth and no native writer/desktop effects. Large technical output is excluded from the overview response. Native/signed image sources never become automatic thumbnails.
- Chromium/WebKit verify phone and 13-inch tablet layout across the four themes, Notes/Plan/exact Result/thread navigation, unchanged unread state and chat drafts, empty-project reload, cached GPT project context and exact GPT-to-Codex reference navigation.
- Screenshot review and regression fixed GPT composer visibility under Home. UI diagnostics use stored summaries, with no new project status probe when opening the overview. No physical-device acceptance or production installation is implied by fixture checks.


### Message read-aloud (#76, 2026-09-08)

Eight focused controller/text tests cover local voice selection, Markdown exclusion, long Unicode-safe chunk order, one active message, rapid duplicate starts, cancellation races, pause mid-utterance and at chunk boundaries, cleanup and errors. `tests/message-speech.browser.mjs` exercises the actual Codex/GPT interface in Chromium/WebKit with a mocked SpeechSynthesis device: delayed voices, sequential chunks, switching, stop, page/view cleanup, unsupported API, retained drafts and four-theme 390/1366px geometry. The test sends no native prompt and performs no desktop operation. These browser mocks verify integration and state; actual iPhone/iPad system audio and pause behavior remain the owner's physical-device usage check.


### Navigation shortcuts and GPT pin order (2026-09-08)

`pinned-navigation.browser.mjs` now verifies that GPT pinned panels precede active unpinned chats and pending new sends, while active chats still precede ordinary inactive chats and Codex retains its existing order. Search, three-pin collapse/persistence and all four themes remain covered. `single-project.browser.mjs` tests the actual Codex shell in Chromium/WebKit: direct single-chat selection, retained per-chat drafts, New chat as the first project action, transition to a collapsible two-chat list, one-tap initial discovery, and rejection of stale asynchronous folder navigation. Native creation is simulated with disposable fixture threads; no owner's prompt or desktop process is touched.
