# Linux ChatGPT evaluation — #193

Date: 2026-09-19. **Owner integration candidate verified; coordinated main-engine installation still waits for active Codex work.** The private native runtime now uses Chromium's sandbox. Main-site wiring, native dictation and account isolation are implemented; real ordinary-web new-chat/upload/reload and Russian transcription passed. Earlier dated sections are historical. See the final admission section for actual installed/pending scope; full native feature parity is not claimed.

## Package and runtime

The official [Linux documentation](https://developers.openai.com/es-419/docs/linux/linux-app) links `https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb`. The installed package is `chatgpt` **26.915.31945**, amd64, SHA-256 `d27a9c02919cfe484dcc5f34584b9ea9fd0d7a65c69dcc872b5bdcfa0efb5983`. The mutable latest URL must not silently upgrade the evaluated version: a changed checksum/build requires a new compatibility pass.

`/usr/bin/chatgpt` wraps `/usr/lib/chatgpt/ChatGPT`. This is the official combined Electron application with Chat and Work modes, not the older Chat-only UI. The owner explicitly accepts that difference. It bundles Codex and renderer/helper processes; normal Chat mode shows the owner's existing consumer conversations.

The original-owner lab `codex-web-gpt-native-lab` runs on Ubuntu 24.04 with Xvfb `:92`, DBus, Openbox and private VNC. State is under `/home/abysscloud/codex-web-native-lab/state`, mode 0700, owned by UID 1000. The app profile is under `/data/.config/Codex`, with app-owned Codex state in `/data/.codex`; the temporary authentication browser has its own `/data/auth-browser`. No Windows or old browser authentication was copied.

The container runs as UID 1000, drops all capabilities, uses no-new-privileges and publishes **no host ports**. Limits: 3 GiB RAM, 4 GiB memory+swap, 1.5 CPUs, 256 MiB shared memory and 512 PIDs. VNC 5900 is private Docker-network only; X11 has no TCP listener. VNC credentials stay in private mode-0600 files. No debugger listener is enabled. Chromium/Electron `--no-sandbox` is an explicit limitation of this container spike, not approval to weaken the eventual production provider.

A pre-login idle sample was about 855 MiB / 0.54% CPU. An authenticated sample with the sign-in browser still open was 1.752 GiB / 6.92% CPU; after the restart check, the authenticated runtime used 1.147 GiB / 4.85% CPU. These are individual observations, not a comparable long-chat benchmark. They do not support a claim that the native stack is lighter or more stable than the old browser.

## IPC and real-account proof

The app creates a private same-user Unix socket under mode-0700 `/tmp/codex-browser-use`. The app-tools socket has mode 0600 and uses four-byte little-endian length-prefixed JSON-RPC. A separate browser-control socket (0700) appears after login; it is a different protocol and must not be selected merely because it has a `.sock` name. Discovery fails closed if more than one app-tools socket qualifies.

`tools/list` returns native `codex_app` schemas. `tools/call` also needs a readable calling Codex thread: a never-submitted empty thread was not persistent and did not work. One isolated, named diagnostic carrier was therefore created on the Linux lab, with read-only/never-approve permissions and one minimal `OK` reply. It uses no Windows writer. That calling context enables the app's own read and follow-up handlers.

Authenticated `list_threads` returned both `chatgpt` and `codex` entries. `read_thread` successfully read one ordinary existing ChatGPT conversation, exposing structured public user/agent messages and native identities. The wrapper never dumps hidden reasoning, account credentials or arbitrary history into logs.

A new **disposable consumer Chat** was created through the observed native UI, in Chat rather than Work mode. A unique diagnostic prompt was sent once and its exact user message and `nativegptok` answer were verified through native IPC. A second unique prompt was sent through `send_message_to_thread` directly. The app acknowledged in **1,087 ms**; canonical readback confirmed one exact prompt and one `nativeipcok` answer after **63,120 ms**, with no duplicate and no retry of the mutation. Receipts remain private in the lab. UI coordinates used for this one-off observation are not a proposed production adapter.

The fresh answer appeared visually before the IPC read returned it. Inspection of the pinned renderer identifies the cache: `read_thread` reaches `S0r(scope, id)` through `PHi -> pHi -> b0r`, using `query.getOrFetch(wj, id)`. The `wj` query calls `rjr`, whose `staleTime` is `ONE_MINUTE`. The send handler explicitly refetches before sending, but the read tool has no force-refresh input. A minute-long fresh-tail delay makes this tool contract insufficient as the sole live-chat transport.

## Native UI/renderer follow-up

A temporary inspector bound to loopback **inside the isolated container**, without a host port, was used for this research. It was removed after testing; a final connection probe verified it closed. The original startup was restored and the app restarted with its login intact. This is not a new production debug endpoint.

The main window is an `app://-/index.html` renderer with an in-memory route, not a normal ChatGPT webpage URL. Its public DOM exposes accessible composer, send, model, file-input and preview controls, and public assistant Markdown. Sidebar entries have labels but no native thread-ID attribute was found in this bounded inspection. The preload exposes renderer/main messaging; inspecting arbitrary React internals or exporting credentials is not the proposed provider boundary.

In the same disposable chat, another unique prompt was dispatched once via the native tool. A matching public response was observed in the live renderer after **4,370 ms**, with acknowledgement at **1,252 ms**. Later canonical readback confirmed one exact prompt and one answer. This proves the renderer can expose a fresh public reply before the tool's history cache refreshes; it is one observation, not a latency benchmark or a proven streaming adapter.

Two synthetic fixtures were then attached through the native file input: a small text file with marker `cobalt-742` and a PNG containing red/blue halves. The typed prompt was checked in the empty composer, a private dispatch receipt was written before the single send click, and GPT correctly returned the marker and both colours in order. Canonical history confirmed the exact prompt plus the native one-file/one-image summary envelope once. This verifies text/image delivery without uploading the owner's private files.

The answer also exposed native file preview/save controls. Opening the preview showed the **original fixture text**, so this is an attachment reference, not evidence of a newly generated downloadable file. `read_thread` reduced those references to `:chatgpt-content-reference{index=...}` placeholders; it does not alone provide the media contract needed by Results. Generated image/file download remains unproven. The model menu exposed selectable radio entries; changing model/effort and maintaining that selection through sends are not yet verified.

After removing the inspector and restarting, readback confirmed **four exact test prompts and four answers**, with no duplicate/replayed send and an idle authenticated chat. All research writes stayed in that disposable consumer chat and the separate local diagnostic carrier.

| Capability | Actual evidence | Remaining gap |
| --- | --- | --- |
| Consumer catalog / history | Real authenticated canonical reads, native IDs, public messages and bounded Hub projection | Long-chat benchmarking, complete media fidelity and live streaming |
| Existing Chat follow-up | Real IPC send, 4.37-second live UI observation and exact canonical prompt/answer, no replay | Native streaming, stop and durable provider integration |
| Ordinary Chat creation | Typed disposable composer creates a real consumer Chat, reconciles canonical ID and exact first prompt | Production receipt integration, project association and new-chat model selection remain |
| Model / effort | Native catalog/picker adapter, one real send confirms model and effort, restart readback | Reapply version/preset at send time; atomic dispatch guard and full Hub integration remain |
| Attachments / generated media | Typed TXT/PNG upload; generated sandbox TXT/PNG download through native host and Hub with exact IDs/checksums | 1 MiB lab bound; native image-generation pointers, larger streams and primary Results integration remain |
| Projects, branches, Canvas, schedules | Some related tool/UI surfaces exist | No complete parity proof; preserve current capabilities through migration |
| Account / recovery | Owner login, private pipe, protected trackpad recovery and durable manual leases; restart preserves both disposable chats | Host reboot, reauthentication and sustained-use acceptance |
| Team | Native lab denies other users | Per-member native provisioning, lifecycle and backup admission remain unimplemented |

`ops/gpt-native/ipc.mjs` / `probe.mjs` are a build-gated **read-only research interface**, not an HTTP provider. Requests have bounded frames, exact response IDs, timeouts and no automatic retries. The disposable write proof was a one-off private receipt-guarded lab script; the web client cannot invoke arbitrary tools or send through this spike.

## Fresh canonical reader implementation (2026-09-19)

The pinned renderer exports its existing native request service as `kWt` from `app-initial-430deae5a13a.js`. Calling its fixed `safeGet('/conversation/{conversation_id}', ...)` reads fresh canonical history without the `read_thread` query's one-minute cache. Authentication remains inside the native host HTTP service; no token or browser credential is extracted. This is an internal, version-specific contract, not a supported public OpenAI API.

`ops/gpt-native/renderer.mjs` and `renderer-read.mjs` now implement a limited lab reader. Account metadata comes from the native `accessInputs.readAccountInfo()` service and is reduced to a SHA-256 fingerprint. History requests require a previously selected fingerprint, check it before/after the request and pass native `{accountId,userId}` as `expectedIdentity`. The app's host checks this principal at request dispatch. The reader deliberately avoids the pinned service's `retry:false` shortcut because that implementation drops `expectedIdentity`; bounded native read recovery is not a mutation/replay mechanism.

The reader selects exactly one main app renderer, checks actual app version, exact conversation ID and the complete current-node ancestor chain, then returns a page of 20 public messages with native node/message IDs and explicit ancestor cursor. Cycles, missing ancestors, oversized responses, changed accounts and off-branch cursors fail closed. Analysis, system/tool messages, non-public recipients, hidden metadata and arbitrary structured content are excluded **inside the renderer**, before transport. Unknown media is reported as unresolved, never silently claimed supported. This projection is not yet the full existing Hub history/media contract.

The existing disposable consumer chat passed a real run of this implementation: four exact user messages, four assistant answers and all four expected markers; a wrong account fingerprint was rejected and cancellation passed. No additional prompt was sent. Nineteen focused Linux tests cover the reader, bounded transport and existing native IPC, including account changes, branch paging, public-content filtering, ambiguous windows, external target rejection, disconnect, cancellation and response bounds. Test data/receipts and the lab-only account binding remain private under `/data`; no production user binding was created.

This stage used a temporary container-loopback inspector only. Ordinary startup was restored afterward. There is no new HTTP endpoint, production polling, web write route or automatic migration. The production engine/browser and their durable jobs are unchanged. Resolve native navigation/send/stop, media and model/effort contracts, then supervised private transport and per-user provisioning before enabling a reversible Hub provider switch.

## Exact navigation, follow-up receipts and Stop (2026-09-19)

The next lab stage implements `renderer-control.mjs` and `followup.mjs`. Native navigation uses `appActions.runInPrimaryWindow` with `windows.show_thread`, explicit `kind: chatgpt` and the canonical conversation ID. `app.get_summary` supplies both the native route and thread identity; both must match. Titles and React internals are not used. Only fixed selection/state/Stop operations are exposed by the private adapter, never a generic native-action endpoint.

State inspection reads identity and controls without fetching history. An initial proof showed why this matters: reloading canonical history before every control check delayed Stop until a short answer had already finished. The revised Stop checks the expected latest **user message ID**, rechecks route/account, and clicks one visible enabled native `Stop` button. It reports `stopIssued`, not completed generation. Real readback and native idle status are separate evidence. Nonempty native text drafts block navigation; attachment-only draft handling and atomic account/route/turn dispatch still need production admission work. Manual recovery and a mutation must not be allowed to race in the eventual provider.

The disposable follow-up writer calls the existing native `send_message_to_thread` tool with exact target/caller IDs. A private SQLite ledger commits a dispatch intention before IPC, serializes pending work and binds receipts to build/account/chat/caller. Repeating an operation key returns its receipt; changed payloads are rejected. Lost acknowledgement, process loss during dispatch, missing history baseline and ambiguous readback stay unknown, with no replay. Canonical reconciliation confirms **submission**, not answer completion. Because this tool has no client message ID, this lab writer requires the operation UUID inside the diagnostic prompt; it is explicitly forbidden outside disposable tests. Production must reuse Hub jobs and resolve that native dispatch contract, not append diagnostic markers to owner prompts or create a second production queue.

Three additional requests were made only in the existing disposable chat: a first native Stop observation preserved partial public text; one ledger-backed short response finished before the original slow Stop check; the revised ledger-backed test sent exactly once despite a repeated key and issued Stop successfully. Canonical native readback confirmed all three exact prompts once, both ledger receipts, seven total user messages and idle state. The first four proof turns remain intact. Thirty-six focused Linux tests passed, covering wrong route/turn/account, draft preservation, disabled/ambiguous controls, lightweight status reads, pending-write serialization, crash/acknowledgement loss, exact reconciliation, pinned transport and public history.

After the proof, ordinary lab startup was restored and the temporary inspector removed again. Restart checks confirmed all seven exact prompts, the first four answers, both confirmed ledger receipts and native idle state; the inspector was closed. The original production engine/gateway/browser remained unchanged and running. No web send or Stop has been migrated. Model/effort verification, ordinary chat creation, media, atomic mutation guards, supervised private transport and Hub integration remain open under #193.

## Native model and power controls (2026-09-19)

`renderer-read.mjs` now projects the pinned app's native `/models` catalog with the same account fingerprint and `expectedIdentity` guards as history. Only bounded version IDs/labels, enabled state and preset IDs/labels/model slugs/efforts/availability leave the renderer. Unknown shapes, duplicate identities or account changes fail closed; this is not a hardcoded list of offered models. The native tool's `model`/`thinking` arguments are Codex-only: its consumer-Chat handler uses the selected native composer state.

`renderer-settings.mjs` adds fixed `inspectSettings` / `selectSettings` lab operations. It binds the exact native chat and account, requires an idle text composer, refuses an already-open manual picker, and verifies one native model trigger. Model radio entries are selected only in the active menu view; inactive/inert entries are never clicked. Power changes use the native keyboard control, checking its accessible announcement against the current catalog after every step. Disabled/locked items, mismatched slider counts, unexpected selection changes and unconfirmed key events abort. The adapter closes only its own picker on the same account/chat and never clicks access/upgrade controls or sends a prompt. A renderer-local lock prevents concurrent settings operations; it is not a lock against manual recovery or other native controls.

The observed catalog has separate model versions and native power presets. In this account, preset ID `6` is **Extra High**, fourth of five positions, with `thinking_effort: max`; Medium uses `standard`, and High uses `extended`. These are GPT-native semantics, independent of Codex's six reasoning enum values. The adapter reads the offered mapping and checks the UI instead of equating IDs, indexes or translated labels. This pinned English picker contract fails closed if localization or a changed native UI makes the accessible announcement incompatible.

Real proof changed the existing disposable chat from **Latest / Instant** to **GPT-5.6 Sol / Medium**, then sent one new short diagnostic request using the existing private ledger. Repeating its key returned the same receipt without another send. Fresh canonical history confirmed the exact prompt once, a completed `nativemodelok` answer, `model_slug: gpt-5-6-thinking` and `thinking_effort: standard`. The public reader now projects just those two bounded metadata strings; it does not return arbitrary native metadata.

After a native-container restart, canonical readback still confirmed that one request and both parameters. UI inspection showed the same model/effort, but the version alias had changed from `5.6` to `latest`. Therefore model/effort persistence is demonstrated, **exact version-alias persistence is not**. Reapply and verify the desired version/preset before every eventual Hub send; never assume a restored native window retains the exact web selection. The original test selection was restored before closing the inspector.

Forty-eight focused Linux tests passed, including catalog identity/shape bounds, account changes, unknown/locked presets, nonsequential IDs, native selection confirmation, manual-picker/draft preservation, concurrent settings exclusion and canonical metadata filtering, alongside existing history/transport/receipt/Stop tests. After restoring normal startup, read-only IPC confirmed all **eight** diagnostic user messages once, all three ledger receipts confirmed, the first four answers intact, authenticated idle state and the inspector closed. Original production engine/gateway/browser containers remained unchanged and running.

This completes a lab model/effort slice, **not** the main GPT-provider migration. No web send route or production model picker changed. Remaining admission work includes attachment-only drafts, an atomic account/route/turn guard at actual dispatch (checks around UI operations do not eliminate that race), ordinary Chat creation, media resolution, supervised private transport, per-user lifecycle and integration with existing Hub jobs. No additional production queue or credentials copy is introduced.

## Ordinary Chat creation and bounded attachments (2026-09-19)

`renderer-composer.mjs` adds explicit **disposable-only** operations for a new consumer Chat. `windows.show_home` opens the native home screen; the adapter requires the real Chat mode, one native composer, no text or file draft and no active response. It does not silently switch Work mode, create a Codex carrier or select a project. The existing carrier remains solely the lab's read-tool context.

Preparation creates an in-memory lease bound to the operation UUID, account fingerprint and exact composer DOM element. Text insertion uses the native editable control and verifies its exact contents. The diagnostic UUID is mandatory; no owner prompt is modified or sent through this lab API. File staging accepts at most four simple-name TXT/PNG fixtures, at most 1 MiB in aggregate, with matching MIME types and SHA-256 checks before constructing native input `File` objects. It uses the observed `Attach files` input and the app's normal upload handler, without a host filesystem path or credential export. Upload intention is retained in the lease before the change event; a failed/unknown upload is not retried automatically. Staging is not readiness: inspection checks exact attachment-chip names, unchanged text and the enabled native Send control.

Submission requires a supervisor-persisted intent, exact text and file hashes, the same account/home/Chat/DOM lease and an enabled Send button. It marks that lease dispatched **before** the click, and never clicks twice. The lab proof supervisor used a private one-shot receipt; this is not a replacement for Hub durable jobs or a completed crash-safe production creation queue. Renderer loss leaves the supervisor responsible for reconciliation, never automatic replay. Cross-control/manual-recovery arbitration and atomic account dispatch admission are still open.

Real creation revealed a native identity distinction: immediately after a successful first send, `app.get_summary` retains a `local-chatgpt:<UUID>` client identity while its route pathname already contains `/c/<canonical-server-UUID>`. The adapter accepts only matching native route/thread identities and that strict local-alias form; it returns the pathname's UUID as **unconfirmed**. `confirmCreatedChat` then uses the account-bound fresh canonical reader and requires one exact diagnostic first user message, matching attachment presence and no older history page. Only that readback confirms the new chat's identity/submission. It does not claim answer completion or byte fidelity from a Send click. Existing native controls also recognize the local alias only when its canonical route matches the requested chat exactly.

One separate disposable Chat was created with a TXT marker and a red/blue PNG through the implemented adapter. Canonical history confirmed one exact first prompt with attachments and a completed answer containing the correct marker, both colours in order and the requested diagnostic marker. The real native-ID confirmation operation passed. No retry or second send was made. After normal startup was restored and the inspector closed, read-only native IPC confirmed that same new chat, one prompt with the native one-file/one-image envelope, the answer and idle state. The previous disposable chat still contains its eight original requests once each and confirmed receipts; production engine/gateway/browser remained unchanged and running.

Fifty-nine focused Linux tests passed. New coverage includes preserving text/attachment-only drafts, rejecting Work mode, lease/account/key changes, file hash/name/MIME/bounds checks, upload non-replay, disabled Send, single-click admission, local-to-canonical identity validation and exact first-message confirmation. Navigation/settings/follow-up readiness now also detects attachment-only drafts, including hover-hidden remove controls inside the composer.

This is an implemented lab creation/upload slice, not a main-provider release. Larger/arbitrary files, progress/cancel/error recovery, durable new-chat jobs, exact native file IDs, project-associated creation, model/effort selection on the home composer, and generated media/downloads still require integration. The next bounded stage is resolving generated files/images into authenticated Results, followed by supervised transport and production dispatch/receipt admission.

## Generated sandbox artifacts (2026-09-19)

`renderer-artifacts.mjs` adds typed lab `listArtifacts` / `readArtifact` operations. Discovery uses one canonical public page and its existing paging cursor. Only assistant Markdown sandbox links are projected, with code examples, invalid/traversing paths, user uploads and non-current branches excluded. The artifact ID uses the same SHA-256 of `[conversationId, messageId, path]` as the existing Hub sandbox Results projector, preserving the exact identity needed for future backlinks. No lookup by filename is introduced.

The public reader gained an exact-message mode restricted to the canonical current branch. Download rereads that message and recomputes its link identity before resolving anything; old artifacts do not require exporting all intervening history. Hidden/system/tool/analysis messages remain excluded even when their message ID is supplied. The typed native `/conversation/{conversation_id}/interpreter/download` request includes exact message/path and `expectedIdentity`, with account fingerprint checks before and after resolution and binary reading.

The actual resolver returns ChatGPT's `/backend-api/estuary/content` URL with private parameters. Plain renderer fetch is insufficient: the official native host binary service is required, using its fixed `X-OpenAI-Attach-Auth: 1` opt-in marker and `expectedIdentity`. The app attaches its own authentication; the adapter never reads tokens/cookies or exports that URL. Only this exact HTTPS ChatGPT route or HTTPS `*.oaiusercontent.com` hosts are accepted; external CDN requests omit credentials and reject redirects. The native host owns estuary redirect behavior; this is not a separately proven redirect policy. Errors expose fixed codes, never raw upstream details. Stream size is bounded to **1 MiB in this lab**, with timeout/cancellation and SHA-256 readback. Existing production large-file/download limits are unchanged.

One additional diagnostic request in the original disposable chat created `native-result.txt` and a 64×32 red/blue PNG using Python. The private send ledger confirmed the exact prompt once; no owner conversation was used. The adapter resolved and downloaded the actual 16-byte TXT and 123-byte PNG, checked the text marker and PNG signature/dimensions, and verified checksums. Their stable IDs and byte hashes survived a native-container restart and a second read without another send. This proves generated **sandbox** image/file downloads, not native image-generation pointers, Canvas, arbitrary downloads or expired-asset recovery.

Sixty-eight focused Linux tests passed, including public-only link parsing, exact older-message lookup, cross-message/branch rejection, principal-bound resolver/binary reads, signed-URL confinement, wrong-origin rejection, account-change discard, size limits, stream cancellation and sanitized failures, alongside existing creation/history/model/Stop/receipt tests. After restoring normal startup, final read-only checks confirmed nine original-chat user requests once each, four confirmed ledger receipts, the separate one-request creation chat and closed inspector. Original production engine/gateway/browser remained unchanged and running.

This is an implemented lab download slice, **not a deployed Results integration or provider cutover**. Native service image pointers, larger streaming downloads, project media, supervised private transport and the existing Hub's queue/storage/projection admission remain open. The next bounded stage should establish supervised private transport and serialize manual recovery against adapter operations, retaining the old provider and all uncertain receipts.

## Supervised read adapter, Hub projection and Remote arbitration (2026-09-19)

The separate native runtime now starts a supervised **read-only** adapter from the pinned `codex-web-gpt-native:26.915.31945-reader` image. Its manifest digest is `sha256:5a760a02ad0944f930d4f1472111d9f387033cedde947cc7ef5c76776db77adf`. The official application inherits fd 3/4 for Chromium's debugging pipe; there is no temporary inspector and no debugger TCP listener. `pipe.mjs` bounds frames, validates session/reply IDs, selects exactly one guarded main renderer, cancels reads and detaches sessions. Actual native canonical history and sandbox downloads passed through this transport. The container retains private display/VNC, no published ports, resource limits, profile isolation and the existing restart policy. `--no-sandbox` remains the previously documented container-spike limitation; this stage does not silently approve main-provider production admission.

An explicit private `binding.json` pins the evaluated build, original owner ID and previously verified account fingerprint. The adapter never enrolls a user automatically or rebinds after an account change. `service.mjs` listens only on a mode-0600 Unix socket inside a mode-0700 directory shared through the existing private state mount. Its fixed request allowlist covers status, public read operations and manual-control coordination. Caller-supplied credentials, fingerprints, arbitrary URLs, scripts, tools and mutations are rejected. All native sends, Stop and UI selection changes remain outside this service. The production `GptService` and durable queues are unchanged.

Opening the protected native Remote first acquires a durable lease; in-flight reads refuse takeover, and active leases block adapter reads. Multiple manual tabs hold separate leases. Closing a tunnel destroys its VNC transport before releasing that lease. A crashed gateway cannot make a timeout silently restore automated access: leases survive supervisor/container restart. The native page adds **Готово**, which closes native tunnels and explicitly returns control to the website. It also clears abandoned leases after a crash. New Remote admission is blocked during that operation, and the POST requires the active original-owner session and exact Origin. This is coordination of the protected gateway, not a claim to control arbitrary host-admin access to the private desktop.

`apps/hub/src/gpt-native.ts` validates the same-UID private socket and typed responses, checks authorization before/after calls, and maps public native message IDs, phases, timestamps and page cursors into the existing Hub history shape. Sandbox files retain the existing Results IDs. Binary downloads independently verify exact conversation/message/artifact identity, byte length and SHA-256, before emitting a private response. There is no token/signed-URL export, automatic retry, cache replacement or job migration. Unresolved structured media remains explicitly unsupported.

The staged recovery gateway imports this Hub client and exposes an original-owner-only read namespace: `/gpt-connect/native/status`, `/gpt-connect/native/history/:id` and `/gpt-connect/native/downloads/:conversationId/:messageId/:id`. History/download delivery rechecks the live session. The ordinary GPT workspace has **not** switched to these canary endpoints. This provides an authenticated integration boundary for the next provider stage without letting old queued/unknown sends reach a new writer.

Verification passed **111 Linux tests**, including the native adapter suite and complete team-isolation suite. Tests cover pipe fragmentation/session binding/disconnect/cancellation, exact private ownership and socket permissions, read/manual exclusion, multi-tab leases, restart persistence, explicit recovery, revocation, checksum failures, denied methods, cross-user HTTP access and Origin rejection. Chromium and WebKit passed the shared phone trackpad/zoom/reconnect flow and the new Done/return action. Physical phone acceptance remains the owner's usage check.

Real Hub reads returned 18 public messages from the original disposable chat and downloaded both generated fixtures with their previous IDs/hashes. A diagnostic manual lease was persisted, the native container restarted, and a new Hub process verified that reads stayed blocked until explicitly releasing that lease. History and identical bytes then read successfully again. No prompt or VNC input was sent during this stage; previous native receipts/chats remain intact.

Installation saved a private stopped-profile archive `backups/native-before-reader.tar`, retained the old native container stopped with restart disabled, and retained the prior recovery-service drop-in at `gateway-backup/before-native-reader.conf`. The new native image and `gateway-native-reader` recovery service are installed. Original main engine/gateway/old-browser IDs and start times remain unchanged. Host-boot acceptance, sustained-use benchmarking and member provisioning are still unverified. Rollback must restore the prior recovery configuration and native startup together, with only one container allowed to own the profile; it never restores/replays production send jobs.

## Existing-chat dispatch through Hub jobs (2026-09-19)

The installed optional native canary now implements `prepareDispatch`, `dispatchText` and `reconcileDispatch` behind an explicit private disposable-chat allowlist. `NativeGptJobs` operates on the existing `gpt_jobs` schema in an isolated Hub `Store`, with an additive per-job receipt/public-message table. The normal `GptService`, production database, web send routes and provider selection remain unchanged. This is integration evidence for the next provider, not a main-workspace release.

Static inspection of the pinned app found its exported ordinary consumer submission routine (`mDt` / native `n0r`) and message builder (`lDt` / `uP`). They accept `userCompletionMessages`, including a caller-supplied user-message UUID, explicit parent/model/effort and a dispatch-acceptance callback. The adapter uses those native routines rather than the diagnostic app-tool send path. It preserves the exact prompt; no marker, diagnostic nonce, developer instruction or carrier thread is added. A temporary read-only app-action registry wrapper captures the native route scope and is restored immediately. No React-private tree inspection or new generic action endpoint is introduced.

Preparation verifies the account fingerprint, exact chat/branch, idle composer, absence of text/files and the native model/preset. A per-call proxy of the native scope/completion service validates the final request's chat, parent, model, effort, UUID and exact content before invoking the original stream method with `expectedIdentity`. Its synchronous current-request guard blocks route/account changes and every second POST attempt. The native service still handles authentication/integrity internally. Automatic stream-resume handling is disabled in this canary; raw stream/analysis data is not exported. Completion is determined by fresh canonical public history, not by a click, request acknowledgement or partial commentary.

The Hub atomically commits its receipt and existing job transition before dispatch with FULL SQLite synchronization. The supervisor separately commits an at-most-once dispatch receipt before invoking the renderer. These receipts are not another work queue. Hub/renderer/adapter loss, timeout, changed branch or missing readback remain unknown; identical operation keys never invoke the writer again. Native-side pending receipts exclude another send and Remote admission. Existing public output is retained through transient read failures. An exact public final message at the canonical current node, with successful status and `end_turn`, is required for completion. The pending barrier's owner-facing resolution UX is still missing, so ordinary chats remain disabled.

One new plain-text request was sent to the second disposable chat using the real Hub worker, private socket and native routine. First reconciliation was unknown while the response arrived; the next confirmed one exact user UUID and `nativequeueok`. After a native image replacement/restart and a fresh Hub process, canonical readback still found exactly one request, the same response and a completed durable job. Original disposable history remained at 18 public messages; previous TXT/PNG files retained their exact hashes. Main production engine/gateway/browser IDs and start times remained unchanged. No owner conversation received a prompt.

The final installed image is `codex-web-gpt-native:26.915.31945-dispatch`; a stopped-profile archive `backups/native-before-dispatch.tar`, dispatch/Hub receipt archive and stopped prior containers are retained privately. Never start retained containers against the same live profile. The production recovery gateway remains on its prior read/Remote routes. The canary allowlist is host-owned and contains only the disposable chat.

119 focused native/recovery/user-isolation tests passed, including final-principal changes, native request substitution, replay refusal, durable receipts, unknown outcomes, public-only response reconciliation, partial-output preservation and revoked owners. This is not evidence of a long-chat benchmark or formal phone/tablet acceptance. Remaining work: integrate new chats/projects/uploads into the same receipt path, expose the provider through the actual workspace with explicit unknown recovery, complete media/catalog parity and lifecycle/member checks, then make a reversible main-provider switch.

## Phone recovery fixes

`/gpt-connect?runtime=native` opens the protected original-owner lab. Plain `/gpt-connect` remains the old browser. This does not switch the main GPT provider, replay pending work or change a chat's identity.

Access requires the exact configured active original-owner ID, the normal authenticated session and correct WebSocket Origin. Session revocation and connection limits remain enforced. Native asset URLs retain the runtime/workspace selection, so recovery does not depend on old-browser readiness. There is no public IPC/debug or arbitrary-command endpoint.

The page uses the same `apps/web/src/remoteInput.ts` as PC Remote, transformed by the repository-pinned Node 24 gateway. Touch acts as a laptop trackpad: relative motion, tap at the current cursor, two-finger scrolling, hold/second-tap dragging, visible cursor and zoom. Reconnect disposes listeners and releases buttons. Physical mouse input remains normal.

Two concrete bugs were fixed:

1. Guacamole appends connection data using `?`. Putting runtime in its base URL produced two query separators and lost the native selection. All query parameters now pass through `connect()` once.
2. The official desktop file advertises HTTP/HTTPS and was its own default browser, so sign-in links reopened ChatGPT. The lab explicitly assigns HTTP/HTTPS to private Chromium and retains `codex://` for return to the application. The browser is ordinary headed Chromium, without automation/debug flags or anti-bot modifications. The owner completed the real sign-in manually.

## Verification and installation boundary

- Native RPC fixtures cover fragmented UTF-8, mismatched/oversized responses, disconnects, timeouts, build guards and rejected mutations.
- Protected-page fixtures deny another user even with the owner's workspace, and retain live Remote revocation checks.
- Chromium/WebKit with real Guacamole and shared input verify relative movement, tap without relocation, two-finger scroll without accidental clicks, reconnect cleanup and full native coordinate bounds while zoomed out.
- Separate Chromium/WebKit QA against the actual private VNC framebuffer rendered the native app at 390×760 without horizontal overflow or JS errors. Test click/scroll packets were intercepted before VNC, leaving the owner's sign-in controls untouched by these automated tests.
- The built image's `xdg-open` chain was tested in a disposable network-disabled container: it launched Chromium and retained the native callback handler.
- An actual container restart initially exposed a stale X11 lock that prevented display startup. The runtime now mounts `/tmp` as tmpfs and creates its private runtime directory before DBus starts. A stopped-profile backup was saved privately before this repair; the replaced container remains stopped with restart disabled. After rebuilding/replacing and restarting the new container, authenticated readback confirmed both exact test prompts and answers once each, without another send. The runtime is healthy with zero automatic restarts and no OOM indication.
- The owner's successful phone login is real evidence. A formal physical-device acceptance pass, sustained stability and benchmark comparison are not claimed.

Only the user service `codex-web-gpt-login.service` was updated to a staged recovery gateway; the separate native lab was rebuilt/replaced for the restart repair above. Previous unit/drop-in copies remain privately under `gateway-backup`. Original `codex-web-engine`, `codex-web-hub` and `codex-web-gpt-connect` IDs/start times remained identical to the pre-install snapshot, including after the final restart check. Engine/gateway containers still use `65accdd`; the old GPT browser uses `c31d22f`. The rebuilt pinned image contains the auth-browser and startup configuration. Repository HEAD is not evidence of a main-provider release.

## Next decision / migration gates

The evidence favors a **typed native service/UI provider with canonical reconciliation**, rather than the current tool-only path. The limited fresh reader above is implemented; native controls remain necessary for the unimplemented operations. This is a working direction, not a completed Outcome B decision: no comparable long-chat benchmark, sustained-use pass or complete provider exists yet. Do not turn pixel clicking or a generic injected-code endpoint into the normal provider architecture. Keep #193 open.

The next bounded implementation gates are:

1. Extend the installed supervised read boundary into production send/creation admission using the existing Hub durable jobs. Bind account, exact chat, model/effort, attachments and dispatch intention atomically; retain manual-recovery exclusion and unknown outcomes without replay. Existing disposable writers are not a production queue.
2. Complete public streaming/reconciliation, native image-generation pointers, project/catalog/reference parity and larger file transport, preserving partial public messages and source IDs. The proven sandbox read canary is not complete Results/media coverage.
3. Compare a long-chat workload and restart recovery with the existing connector; verify host boot supervision and per-member provisioning. Only then stage a reversible primary provider switch. No generic evaluation/UI-control API may reach the browser.

Reuse the existing Hub provider-facing types, durable serialized operations, source IDs and local history projection. A provider switch must retain draft associations, Results backlinks, projects and unknown receipts. Unknown old sends stay unknown until canonical reconciliation; migration never authorizes replay. Introduce no account-token extraction or native fallback across users.

For recovery, restore the saved user-service drop-in (or remove only the native-lab drop-in to return to the original service), reload user systemd and restart **only** `codex-web-gpt-login.service`. Preserve both profiles and all engine databases. Ordinary Codex recovery remains independent.

## Ordinary new Chat through Hub jobs (2026-09-19, preceding installation)

The existing `NativeGptJobs` canary now accepts an unassigned new Chat with `nativeId: null` only for an explicit host-configured disposable creation job. It uses the same `gpt_jobs` queue and receipt transition as existing-chat dispatch. Native home preparation refuses Work mode, active responses and existing text/file drafts, and verifies the requested native model/power selection. The first message UUID and parent are committed before the native app is asked to create/send. No diagnostic nonce is appended to the prompt.

Native creation uses a caller-owned `local-chatgpt:<user-message-UUID>` identity and the app's ordinary Chat submission routine. An assigned server UUID is only a candidate until fresh account-bound canonical history confirms the exact first user UUID, parent and text with no earlier user/project/Work association. Adapter/Hub creation bindings persist separately from the original null-target intent; confirmed identity and public output update the Hub job atomically. The per-call expected-principal, exact-body and one-POST-attempt guards remain in force.

The private reader/client also expose a fresh 20-entry conversation catalog. If renderer loss erases the candidate before persistence, a bounded read-only recovery checks the newest page and at most five sufficiently recent unassigned ordinary chats, matching the exact first user identity. It never identifies a chat by title/prompt alone or creates another chat. Unknown or ambiguous recovery stays unknown. The induced missing-candidate crash path is tested with simulated native services; real-account evidence below covers normal creation, catalog and restart continuity.

Real proof through the isolated Hub Store created one disposable consumer Chat, confirmed exactly one first user message and the requested `nativecreationok` reply, then replaced/restarted the native container and reopened the Hub worker. Readback retained the same canonical conversation, message and completed job. The fresh catalog returned 20 entries and contained the new chat. The earlier existing-chat queue proof still had its one exact submitted message, and the first disposable chat retained 18 public messages with unchanged TXT/PNG download checksums. No new prompt was sent during post-restart verification.

Validation: Hub TypeScript build and **128** native/recovery/isolation tests passed on Linux. These include creation opt-in, native draft/Work/active-response preservation, wrong-account/route/branch refusal, immutable IDs, lost acknowledgements, missing-candidate recovery limits, exact first-message proof, metadata filtering and private catalog/manual-access boundaries. No browser UI changed in this pass. Physical-device acceptance is not claimed.

Installed native image: `codex-web-gpt-native:26.915.31945-creation`, manifest-list digest `sha256:f751154bb975364fb7ce2f22d33df3a23ba5dbe471183df066f0a5774c43f1e8`; container ID `55214e3ce0d1758a0fc4dfa3601d4fcdb8b7612a22f3c2ed687938d471f0cf9b`. The former `00bf3a3d14ee...` dispatch container remains stopped as `codex-web-gpt-native-lab-before-creation`; the first creation-proof container is also stopped, with restart disabled. Never run them concurrently on the profile. Private backups are `backups/native-before-creation.tar` (stopped profile plus test Store) and `backups/native-creation-receipts.tar` (post-proof adapter receipts/binding and test Store). Main engine/gateway/old GPT-browser IDs and start times still match the baseline; the protected gateway is healthy and anonymous native reads return 401. No public native port was introduced.

**Remaining next:** durable uploads and attachment identity/content reconciliation; project association/catalog and generated media parity; actual main `GptService` integration with public progress and owner-facing unknown-send recovery. Static upload research identified the native create-entry → binary upload → process-ready pipeline, but this pass does not wire it into the Hub queue. Existing TXT/PNG UI fixture success must not be presented as completed durable upload support. Keep #193 open and preserve the current main provider until the remaining admission gates pass.


## Durable bounded attachments through Hub jobs (2026-09-19, current stage)

`NativeGptJobs` now prepares small TXT and PNG attachments through the same native app and existing isolated Hub queue. A caller-supplied private upload resolver binds an authorized Hub file ID to bytes; arbitrary URLs/filesystem paths never reach the native adapter. The worker snapshots file metadata and SHA-256 before uploads, rechecks the complete job in the dispatch transaction, and persists native attachment IDs with the message intent. Preparation interruption fails without submitting; dispatch uncertainty remains readback-only.

The adapter's FULL-synchronous `uploads` receipts bind operation, conversation, Hub file ID, name, MIME, size and hash before creating a native file entry. Confirmed uploads survive restarts and reuse their metadata without another upload. Unknown uploads are retained and refused rather than recreated automatically; they currently require a future explicit recovery flow. Dispatch refuses substituted, omitted, extra or cross-conversation attachment receipts.

The pinned native pipeline is create file entry → upload bytes → process stream with an explicit `file.processing.file_ready`. Authenticated creation/processing use native `postResponse` with expected account identity and bounded non-retrying calls. Estuary uploads use the native auth marker. Real-account object storage returned a signed `*.oaiusercontent.com` PUT: this receives no account-auth marker or token. This build's host cannot validate `expectedIdentity` on an unauthenticated signed PUT, so that operation uses its account-bound signed capability, account checks before/after and a one-attempt guard; processing and message submission again require native-host principal validation. No credential or signed URL leaves the renderer. Endpoint/schema/size/time limits remain explicit; no generic fetch API is exposed.

Message construction uses native attachment metadata and image asset pointers. Canonical readback verifies exact user UUID, parent, text, attachment IDs/names/MIME/sizes and image pointer/dimensions; JSON property order does not affect proof. TXT+PNG delivery was verified through the real isolated Hub worker: one user message, both attachment identities, and the expected word read from the TXT. After native/Hub restart, the same completed receipt and one message remained. Image delivery/dimensions are proven; image interpretation quality is not claimed.

Five earlier preparation-only probes failed while identifying the native storage route and its unauthenticated transport semantics. Their failed jobs and unknown file-entry receipts remain private and intact; none reached message dispatch and none was silently retried. The successful proof is a distinct explicitly created disposable test. Owner chats and production jobs were not used.

Validation: Linux Hub TypeScript build, Biome on changed Hub/tests, **136 native/recovery/isolation tests**, plus **18 focused upload/dispatch tests** after strengthening conversation binding. These cover checksums, changed accounts, untrusted destinations, explicit ready acknowledgement, unknown-upload no-replay, Hub restart, canonical attachment substitution and cross-conversation rejection. Main engine, gateway and old browser remain on the original baseline; public native writes are still disabled.

Limits: TXT/PNG only, at most four files and **1 MiB total per job**, PNG up to 4096×4096. This does not alter production upload/export limits. Remaining: larger/other formats and upload recovery, project catalog/association, generated image-service pointers, main GptService integration, public progress/unknown-send recovery and provider migration admission. #193 stays open. The owner-facing GPT workspace still uses the old provider.

Backup: stopped full native state and isolated test Store in private `backups/native-after-uploads.tar`, 2,572,298,240 bytes, SHA-256 `bd81f55766903d0b8d1011db281022a23390c94053a20330c3ac8ab5447e3e45`; latest metadata additionally in `backups/native-upload-final-receipts.tar`. Retain all ambiguous receipts on rollback. The preceding creation image/profile backup and stopped containers remain available; never start two containers on the profile. Current image identity and final recovery checks are recorded below.

Installed image: `codex-web-gpt-native:26.915.31945-attachments-v2`, manifest-list digest `sha256:95683ad66f4e836bcb8d16979e3cd847874ac36ddc8d9c582c7926eddb753329`; container `cf69392ecd9d34eca40a5e83e02f2ba9efc5f211a8ee05f268b9a58a711cd804`. Final readback confirmed the successful attachment receipt and earlier new-chat receipt once each, the first test chat's 18 public messages and unchanged TXT/PNG download bytes. Protected recovery is active, anonymous reads return 401, and production engine/gateway/old-browser IDs and start times still match the baseline. No owner UI/engine release occurred in this stage.


## Large-file transport and native project foundation (2026-09-19)

The native canary accepts larger document formats with immutable metadata/SHA-256 snapshots and the existing at-most-once file/send receipts. A real **33,554,432-byte PDF** passed through the actual Hub worker, private adapter, signed storage PUT and native processing. ChatGPT read `largefileok` from its page. Canonical reconciliation confirmed one exact user message, the expected attachment size/identity and the answer. After restarting both the native runtime and the worker process, the same completed receipt and one message remained. No owner conversation received a test prompt.

The official [consumer file FAQ](https://help.openai.com/en/articles/8555545-file-uploads-faq), checked 2026-09-19, states 512 MB per file, 20 MB per image, approximately 50 MB for spreadsheets depending on rows, and 2 million tokens per text/document file. Native account/project/rate/type restrictions remain authoritative. The approximate spreadsheet limit is guidance, not a fabricated byte-exact rejection. The implementation uses binary MiB for byte ceilings. The [App Server input contract](https://learn.chatgpt.com/docs/app-server) does not establish a universal 25 MB cap for arbitrary source files: this app's Codex workflow transfers files to the selected machine and submits local paths. Do not substitute the separate API Uploads limits for consumer ChatGPT limits.

### Implemented transport

- Browser → Hub: shared authenticated per-user chunk endpoints, immutable upload UUID/target/name/size, 4 MiB maximum fragment, fsync before committed offset, exact duplicate-fragment comparison, streaming final SHA-256, restart recovery and idempotent attachment publication. A short network failure retries the same fragment. In-memory File identity permits resumption within that page; full browser reload/file reselection resumption is not claimed. Session termination aborts client transfers. Upload percentages appear in both composers. Aggregate storage reservations, actual free-space checks and 24-hour stale staging cleanup remain enforced.
- Codex: file-backed attachment ingestion/copy and unchanged system SFTP transport with final remote size/hash verification. The old 25 MiB source check and 64 MiB batch size are removed from this path. The configured private attachment storage quota (default 2 GiB) still applies. Eight attachments per message remains an app batch guard; it is not represented as a native Codex limit. Ordinary file-browser, download/export, shared-publication and staging-maintenance policies are unchanged.
- Native GPT: non-images stage on the private adapter disk in 1 MiB chunks, verify SHA-256, then stream to native-authorized object storage without a whole-file base64/renderer allocation. The native app still performs authenticated entry creation and process-ready acknowledgement using its expected principal. The signed upload capability now crosses **only renderer → private supervisor**; it never reaches Hub/browser output, logs or saved receipts. This is a deliberate change from the earlier small-upload renderer-only capability boundary. There is no credential extraction. Only validated HTTPS object-storage hosts/header names are admitted; redirects are refused. A 15-minute transfer deadline, bounded 4 GiB private staging reservation and stale-part cleanup remain. The large-file path currently requires the direct signed storage route proven on this account; large Estuary uploads are not yet supported.
- Images retain the native renderer path, now staged in sub-256 KiB IPC frames. The Hub's existing normalized image behavior remains; this is not an original-quality image archival feature. Unknown native file creation/processing is never automatically replayed. Confirmed file receipts can be reused only with exactly matching job/chat/file metadata and checksum.

The source also adds bounded typed native project/catalog/membership reads and a public conversation graph projection for the existing Hub history/versions/results adapters. Private analysis/tool payloads are excluded. Project changes during preparation prevent dispatch. Project reads returned an empty real-account list in this run; nonempty project shape/membership behavior is fixture-verified, not claimed as a real-project acceptance pass.

### Verification and release status

Linux Hub/web builds and **68 focused tests** passed across the changed upload, SFTP, native receipt/renderer and existing GPT modules. They cover >25 MiB transfers, quotas including concurrent admission, resumed/changed chunks, revoked access, login/CSRF, processing readiness, wrong-account/destination refusal, exact attachment binding and preserved legacy sends. Chromium and WebKit each uploaded 32 MiB through the actual web/Hub chunk route with a deliberately lost first-fragment acknowledgement; both retained exactly one file and the draft despite a delayed attachment inventory. These are browser-engine checks, not physical iPhone acceptance.

Installed **only in the isolated native runtime**: `codex-web-gpt-native:26.915.31945-large-files`, manifest-list digest `sha256:277ec90362ae71fcb6561f38574f39b7064e781219fbec80c724949249d54c23`, container `2c78ae3f8360b4e72c07f1f76feeacefbfdda51346102be6d1b72407fd1ac1ab`. Private backup `backups/native-before-large-files.tar` is 2,572,943,360 bytes, SHA-256 `f4a93584072be3f41586e6f88a5cc13844acd00247e79401c262cde294ea69ec`; both SQLite databases extracted from it passed integrity checks. Post-proof receipts are separately retained in `backups/native-large-proof-receipts.tar`, SHA-256 `533246c0c5ec90a902894433a130b5b2c68093f049d3dd6f45de3610337b2855`. The preceding native container is stopped with restart disabled; never start it on the live profile concurrently.

**Not installed in the main engine/UI.** The native public send admission and main `GptService` integration are still missing. Therefore the old GPT bridge keeps its 25 MiB buffered-request safety guard; a large file must never turn into a 512 MiB base64 request to that bridge. The main project-upload bridge also still uses the legacy path. Do not publish the new upload UI as “full GPT” until it uses the native provider. Main engine/gateway/old browser IDs and start times remain unchanged, protected recovery stays healthy, anonymous native access is denied, and no native port is public. Keep #193 open.


## Shared GPT workspace integration (2026-09-19)

The normal `GptService` and authenticated `/api/gpt/*` routes now accept an explicit private `NativeGptWorkspace` dependency. This is the same web composer/history/navigation, not another chat UI. The dependency has no public configuration endpoint, is not inherited by team members, and remains restricted by the supervisor's disposable-chat/creation-key admission. It is **not enabled in the production engine**.

- Native catalog, pins, archived lists, project catalog, public conversation graphs and models feed the existing Hub normalizers, history paging and Results identity contracts. Project enumeration follows bounded cursors rather than silently dropping later pages. Real native reads returned three model versions, nine pins and a 20-chat page; the account's project list remains empty, so nonempty projects are fixture coverage.
- Presets are returned per model. The shared model picker updates the power choices and discards unavailable combinations when the model changes. Private client calls serialize competing frontend reads and recheck authorization after waiting, instead of generating supervisor BUSY collisions. No write is automatically retried.
- `gpt_job_providers` durably labels each outbox entry `browser` or `native`. Existing entries default to browser unless an existing native receipt proves otherwise; native queued work is never consumed by the browser pump and old browser work is never submitted by native. Unknown native receipts are read back, never replayed or blindly dismissed. Native cached history uses its own directory. Full production migration/review of old queued entries remains an admission task.
- The normal queue now runs the native worker, retains public commentary/progress and answers, invalidates displayed history after observations, and resumes read-only reconciliation after restart. Disconnected/unknown reads back off to one minute. Preparation cancellation prevents later dispatch; native Stop is bound to the persisted exact user-message ID, is issued at most once, and only marks cancellation after canonical same-turn readback plus the idle selected composer. Stop/account/cancellation races are simulated; this pass did not stop an owner's real task.
- Attachment-only sends preserve empty user text; they do not invent a prompt. Existing native guards still include the 32 KiB prompt transport bound, eight attachments, 20 MiB normalized images and direct-signed-storage requirements for large documents. Broader native feature parity must not be inferred from this integrated send path.

### Evidence

Linux builds/typechecks and focused queue, provider, native reader/dispatch/authorization and legacy GPT tests pass. Chromium and WebKit each exercised the actual authenticated Hub routes/shared web UI (a simulated native boundary): per-model presets, lost dispatch acknowledgement, public output, one send and reload. Those checks do not claim real iPhone hardware acceptance.

A separate **real native browser check** used the same web build, authenticated Hub routes and `GptService` in a private isolated Store. Through the ordinary composer it uploaded a 33,554,432-byte PDF, sent it to the disposable existing chat, and received the exact `largefileok` marker from the PDF. Canonical history contains one exact native user-message ID. Page reload and reopening GptService preserved the completed job, answer and one-message count. The one-shot proof and SQLite receipts are private in `codex-web-native-lab/workspace-proof`; never rerun its send script or reuse its job key for changed input. No real owner conversation was used.

Installed only in the native lab: image `codex-web-gpt-native:26.915.31945-workspace`, manifest-list digest `sha256:cf133ec0152d759c2e6033bff1e75ce4ef2872e32e595e8ed0117969034f8c88`, container `19fe2b689f7206ee0196c3ae6d08c8f255770a16b95e1d27e31bc3800a6cc19d`. Installed adapter modules match source. The preceding container `codex-web-gpt-native-lab-before-workspace` is stopped with restart disabled; do not run both against the profile.

Stopped-runtime backup `backups/native-before-workspace.tar`: 2,575,226,880 bytes, SHA-256 `1292c8898d05d068a62a87d2f6b129fda9206faa95c9b2a182531eb31a4277aa`; both extracted SQLite databases passed integrity checks. Post-proof receipt backup `backups/native-workspace-proof-receipts.tar`: 778,240 bytes, SHA-256 `1ec9683e5d3b6e13472419708265160b26101e9f678d278be52b4f41c53f8051`.

Main engine/gateway/old-browser IDs and start times are unchanged; protected recovery is healthy, anonymous requests are denied, and the native runtime has no published ports. The working owner site still uses the old provider and has not received the new upload UI/engine. Keep #193 open. Next: missing mutations/project content/media/dictation and explicit unknown-send review, then per-user production wiring and coordinated reversible release. Merely removing the canary allowlist is not release admission.


## Library actions through the shared UI (2026-09-19)

The native provider now implements thread rename, pin/unpin, archive/unarchive and confirmed delete through the existing library endpoint and shared EntityMenu. Project rename/pins/delete have the same typed path behind a separate host `projectIds` allowlist; project archive remains Hub-only. Project rename preserves freshly read instructions, emoji and theme. No project is admitted on the current account, whose native project list was empty; project behavior is fixture coverage, not real-project acceptance.

`gpt_native_library` persists the Hub intent and target/provider binding. The native `library_receipts` table shares the account-bound dispatch database. It commits unknown intent before exactly one fixed mutation, records explicit rejection separately, and reads canonical state to confirm the effect. Unknown library operations block new native sends/uploads and manual takeover through the existing barrier. An old browser command key cannot become a native mutation. Deleted chats keep send jobs and receipts instead of violating native receipt foreign keys or discarding proof of prior effects.

The pinned renderer builds only the four fixed native library requests. Its direct native transport retains expectedIdentity, abort signal, retry:false and a one-attempt guard; request URL/headers never leave the renderer. It checks fresh baseline metadata and refuses a native text/file draft or Stop control. Project mutation also requires native write permission. The stock safePatch/safeDelete retry:false route was not used because it does not propagate the same identity/current-request guards in this pinned build.

After a lost acknowledgement, opening the object's menu restores its exact pending action and offers **Проверить результат**. Existing Hub intents use the separate read-only `reconcileLibrary` operation; it cannot create a missing native receipt or execute a mutation. A rejected action permits a fresh explicit attempt. Ambiguous/missing receipts are retained. General manual review, including an uncertain delete whose object is no longer listed, remains part of the production recovery gate; no blind dismiss/retry is implemented.

### Validation and installed state

Linux Hub build, web build/typecheck and targeted dispatch/provider/service/library checks passed. Six dedicated library tests cover durable lost acknowledgement across receipt reopening, mutual exclusion, altered key/payload refusal, account change, draft preservation, fixed mutation transport, shared authenticated route recovery, retained jobs on delete, and project rename metadata preservation. Chromium and WebKit both used the real shared menu/Hub routes with a simulated native boundary: rename acknowledgement lost, page reloaded, exact pending action restored and verified without a second write. No physical-device acceptance is implied.

Real-account proof through authenticated Hub routes and a separate Store applied six operations to the already admitted disposable chat: rename/restore name, archive/unarchive, pin/unpin. All six are completed in both Hub and adapter receipts. Original name and pin state were restored, the chat remains unarchived, and no prompt was sent. A prior attempt against a different disposable chat outside the host allowlist was rejected before native mutation; its rejected Hub intent remains preserved. Existing 32 MiB web-upload proof was reopened after the native restart and still has its completed answer and exactly one canonical user message.

Installed **only in the native lab**: image `codex-web-gpt-native:26.915.31945-library`, manifest-list digest `sha256:485278ced518510dba59cd01c958f8f33f5c11265bd23249e7be726f94e41f14`, container `4f71a1615e04a572168199b2edfa9e556f1040618f8842293751d7cfb4ee5331`. The former `codex-web-gpt-native-lab-before-library` is stopped, restart disabled, and must never run concurrently on this profile. Installed adapter source was compared with the QA source, allowing line-ending normalization only.

Stopped-runtime backup `backups/native-before-library.tar`: 2,577,500,160 bytes, SHA-256 `cedfa58a93786aea7052042292bef973675fe0fcd1a33f0cef6589480bd05ea4`; all three extracted SQLite databases passed integrity checks. Private post-proof archive `backups/native-library-proof-receipts.tar`: 1,515,520 bytes, SHA-256 `d37aa591cf7df5171bbf840cdc0d6174ca25274cf768056e72ab3541c5334788`. Proof plans and Stores remain under `library-proof` and `library-allowed-proof`; do not rerun their one-shot scripts or reuse keys.

Main engine/gateway/old GPT browser IDs and start times are unchanged. Protected recovery is healthy, anonymous native access returns 401, and there is no published native port. The owner site has **not switched providers**. Remaining #193 work includes project content/files, edit/regenerate/fork, generated media/download parity, native dictation, scheduled/Canvas reads, explicit unknown-send/manual review, and production/per-member admission. This stage does not claim those features or full GPT parity.


## Native project sources: implementation and unresolved live acceptance (2026-09-19)

Project instructions, source upload and exact-ID removal now use the shared project window and `GptProjectContent` through a native strategy. Hub operation IDs are durably labelled by provider; a browser receipt cannot be reconciled or replayed as native. Native permission plus a separate host project allowlist gates writes. Revisions cover freshly read instructions, appearance, permissions and files; stale forms retain their text and cannot overwrite a newer snapshot. Instruction PATCH preserves the name, emoji and theme.

Project sources use the pinned client's `gizmo` entry/processing pipeline, then fixed project-file association. Browser/Hub/private-supervisor transfers remain chunked and checksum-verified, supporting the existing 512 MiB document and 20 MiB image ceilings without a 25 MiB base64 bridge. Processing retains the exact native file ID and optional library ID. Reconciliation matches that identity and size/name, never filename alone. Unknown transfer/association receipts block new native mutations and are not replayed. Native project-source download is still missing: the shared window displays source names and an honest native-client download note instead of offering a broken download. Legacy download behavior is unchanged.

The window now displays upload progress and resumes fast polling immediately when an operation starts; previously an idle 30-second refresh interval could leave a completed upload looking stuck. Native unknown operations offer read-only verification, without the legacy blind manual-dismiss control. The pinned native HTTP transport throws on non-2xx responses: project/library fixed requests now distinguish explicit HTTP rejections from uncertain network/timeout failures, retaining account/current-request guards and one-attempt dispatch.

Validation: Linux Hub/web builds, 19 targeted project/library/legacy-project tests after the final HTTP handling change, and Chromium/WebKit checks using the actual authenticated Hub and shared project UI with a simulated native boundary. Both browser engines recovered an instructions acknowledgement without replay, uploaded and hashed 32 MiB, displayed the source promptly and removed its exact ID; no chat send occurred. Earlier focused large-upload/service checks also passed. This is not live-account project acceptance or physical-device acceptance.

**Live acceptance remains unresolved.** A separately host-admitted, one-shot disposable project creation returned `NATIVE_READ_UNAVAILABLE`. Its unknown creation intent is preserved under `project-proof/creation.json` and `project_creations`; subsequent canonical catalog reads found no matching project. That absence alone has not been used to clear the intent, infer rejection, or repeat creation. The precise original upstream failure is not proven by the later HTTP handling fix. No live project instructions/upload/remove proof was reached, and no owner project was changed. The unknown creation currently keeps the isolated native mutation/manual-takeover barrier closed; ordinary production Codex and the legacy GPT runtime are unaffected. Resolve this private test receipt with explicit evidence before another native mutation, then finish source downloads and real-project acceptance.

Installed only in the native lab: image `codex-web-gpt-native:26.915.31945-projects-v2`, manifest-list digest `sha256:b947e45e5640862ca7cb8685f03b1cbd3214fc489d19fae0602780afacba0022`, container `26fbd3c8a3311abec6a1abc2c2168e60d0c64fe62ca28fab2aa1a0704ab47478`. Previous containers are stopped with restart disabled. Never run them concurrently against this profile or use an older adapter to bypass the new unknown-project barrier.

Stopped pre-stage backup `backups/native-before-projects.tar`: 2,580,776,960 bytes, SHA-256 `6ba82ece689813632cacaae8d8c55e0c7f9d3afbea6843ddaf24d9480f410eef`; all four extracted SQLite databases passed integrity checks. Later unknown intent/configuration and proof files are separately preserved in `backups/native-project-unknown-receipts.tar`, 92,160 bytes, SHA-256 `060fd3b1bb7d532b5f712fc4db2f7d731f4b172361f0e834454f2e14c7651292`. Rollback must retain this receipt and compatible barrier, not just restore an older profile/configuration.

After restart, the prior real 32 MiB chat-upload proof still reopens completed with one exact native user message. The protected gateway is healthy, anonymous native access returns 401, and no native port is published. Production engine/gateway/old-browser IDs and start times still match baseline. **The primary GPT workspace has not switched providers.** #193 remains open; this stage adds implementation and fixture acceptance, not a completed live project milestone.


## Owner workspace admission and dictation (2026-09-19)

The host-only `nativeGpt` configuration binds the original Team owner UUID, the
already approved account fingerprint and one private Unix socket. The personal
runtime creates a single queued native client for chat, project reads and
dictation. Other members never inherit either the host binding or an injected
owner adapter. Identity checks run lazily on every request: a missing socket,
unsafe permissions, changed binding or unavailable account disables GPT without
preventing Codex startup. There is no automatic old-provider fallback.

Owner admission replaces disposable conversation UUID lists with validated native
identities, retaining the same account checks, idempotent Hub jobs and native
receipts. Existing `browser` jobs cannot be picked up by `native`, including after
restart. The production inventory at admission had 153 completed, 10 failed and 5
cancelled browser jobs, with no active or unknown GPT jobs. Their data and the old
connector/profile are retained. Project **creation** remains separately restricted;
ordinary new chats and chats in existing projects use the native durable path.

The prior disposable project-create operation `7108395c-ff62-41d4-8e59-3b1e4644948c`
had no confirmed native identity. Its exact receipt was explicitly abandoned with
possible-orphan acknowledgement after checking the same native account. Evidence
remains in SQLite; repeating its key cannot create again. This does not assert the
project was never created and does not permit discarding unknown chat sends.

Real ordinary-web acceptance used host configuration (not an injected test
allowlist): a new unassigned chat, TXT upload, exact answer `ownerintegrationok`
and reload passed through the shared phone UI. Receipt and screenshots are private
in `owner-proof`. The previous real 32 MiB PDF receipt still reconciles to exactly
one native user message after the runtime restart. These are browser automation
checks, not physical iPhone acceptance.

Dictation now uses the pinned client's native `/transcribe` transport and signed-in
consumer identity. Audio is bounded at 6 MiB, staged with SHA-256 through the
private pipe, checked against the account before/after transcription and cleared.
No chat, model or conversation mutation is involved. Existing shared dictation
jobs preserve cancellation and explicit retry. Real local synthetic Russian audio
(181132 bytes) returned exactly «Проверка голосового ввода. Сегодня хорошая погода.».
The same implementation serves both Codex and GPT. Actual phone microphone input
remains the owner's usage check.

Both the application and its sign-in browser now start **without `--no-sandbox`**.
The pinned Playwright seccomp allowlist plus `chroot` permits Chromium's own
unprivileged namespace sandbox; container capabilities remain empty,
no-new-privileges stays enabled and AppArmor remains active. Real renderer processes
have distinct user/PID/network namespaces and two seccomp filters. No privileged
container, globally relaxed host policy or debugger listener is introduced. See
[the seccomp provenance](../ops/gpt-native/SECCOMP.md).

Native Settings recovery opens the native client, not the retired browser.
Unsupported edit/regenerate/fork and scheduled/Canvas mutations reject before
creating a blocking receipt; the unsupported message controls are not offered in
native mode. Project files/instructions retain the existing verified native
transport. These advanced operations, project creation, complete generated-media
parity and member-native provisioning remain open under #193.

The private profile checkpoint `backups/native-before-owner.tar` is 2590023680
bytes, SHA-256 `865b743f478a51ea181b6eed33e25fad2c59af911f8059dc7343d4333201a332`;
the extracted dispatch database passed integrity verification. A second receipt
checkpoint precedes dictation installation. Main-engine cutover uses the existing
coordinated Team checkpoint/admission/rollback guard and retains the old engine
image. A stale Bridge Doctor association was rebound through its normal API to
its same existing idle diagnostic thread; automatic diagnostics are temporarily
paused across cutover, with original settings preserved for restoration. Actual
Codex tasks remain maintenance blockers and must not be interrupted.

## Prepared parity and concurrent-chat corrections (2026-09-20)

**Prepared source, not installed.** The owner reported an active, long-running
mail-cleanup task. The native client/profile and production engine were not
restarted for this work. Production remains on `24eeb0f`; do not interpret the
following fixture results as completed real-account admission.

Read-only diagnostics found repeated upstream history HTTP 429 responses. Two
independent implementation defects compounded the problem: a native send held
the queue for every conversation until its entire response finished, and receipt
reconciliation required the original prompt to remain in the latest 20-message
page. The prepared implementation scopes send barriers to the conversation,
serializes preparation/submission, and reconciles the exact user identity against
the bounded canonical branch. UI history remains paged in twenties. Stop also
checks the full public branch and selects the exact target conversation before
issuing its native action.

Canonical reads share a short renderer cache with a 64 MiB aggregate bound and a
per-conversation cooldown after 429. They use one principal-bound native request
without the transport's automatic history retries. Temporary read failures keep
confirmed work running; native history errors now enter the existing saved-history
fallback. Routine receipt checks have no warning banner. Persistent uncertainty
still requires attention after 45 seconds and never permits automatic replay.
Manual receipt review requires canonical checks plus an idle exact conversation.

The prepared native adapter also connects the existing edit/regenerate/fork and
scheduled-task/Canvas contracts, preserving durable provider-labelled receipts,
model/effort verification, revision checks and explicit confirmations. These
controls reuse the shared UI. Reply actions and workspace mutations retain their
conservative mutation barriers; this is not a claim that every action can already
run concurrently with every other action. Canvas authoring, project creation and
member-native provisioning have not been added by this change.

Native attachments, generated images, sandbox exports and project-source downloads
use exact private source identities and checked 256 KiB chunks, with a 512 MiB
ceiling and at most two active downloads. Signed URLs stay inside the renderer.
The authenticated HTTP route streams files without creating a file-sized Hub or
browser buffer. Account changes, cancellation, offset/hash/length failures and
timeouts close the transfer. The retired connector keeps its prior 32 MiB bound.

Validation was run in the isolated Linux `parity-source` checkout: Hub/web build,
typecheck, targeted history/receipt/queue/media/action/workspace tests, legacy
operation/workspace/download checks, and the shared native-provider phone flow in
Chromium and WebKit. Tests include a long turn exceeding 20 public messages, two
independent chats, same-chat ordering, 429 with cached history, exact Stop identity,
lost acknowledgements, account replacement and streamed checksums. They do not
constitute live native-feature or physical-device acceptance.

Remaining installation/admission work after the owner's task finishes:

1. Confirm all native work is idle; preserve the current profile and all receipts
   with a stopped, verified checkpoint. Do not clone a live authenticated profile
   into a second runtime or dismiss an uncertain receipt merely to update.
2. Exercise a disposable native parallel-chat scenario and the new media,
   edit/regenerate/fork, scheduled-task and Canvas paths against the pinned client.
   The latter routes are implemented but still lack real-account acceptance.
3. Build the exact committed release and complete its image/Team/Codex recovery
   admission. Apply through guarded maintenance, retaining a compatible rollback
   with the new receipts. Record installed versus pending functionality explicitly.

Issue #193 remains open. No update is silently scheduled by this source change.


### Send-path correction (2026-09-20)

Release `36420c7` and native `parity-82ff520` were installed, preserving the
owner profile and receipts. Everyday sends then exposed a preparation failure
(`NATIVE_DISPATCH_CONTEXT_CHANGED`) that read-only admission did not exercise.

Simplify ordinary sends: select the conversation once, resolve the requested
model/preset from the native catalog, and pass those values to the native
completion action. Do not operate the visual model picker or require its derived
model, UI history hydration and background-fetch flags to match before sending.
The final native request still binds the exact account, conversation, canonical
parent, text/files and model/effort; durable intent prevents duplicate sends.
Confirmation is silent; investigate only failed delivery. Keep genuine same-chat
active-turn ordering and drafts. This correction does not change downloads.


Installed native runtime: `26.915.31945-direct-87bf789`; Hub stays on
`36420c7` (no engine or Codex restart). Preparation also no longer waits for a
mounted visual composer. The native navigation keeps existing drafts intact.

Validation: the focused dispatch tests passed, including stale picker/hydration,
explicit model/effort, wrong-account/route rejection and at-most-once POST. The
reported Instant preparation now passes. One ordinary authenticated Hub send in
the existing disposable native chat reached `completed` and returned the expected
short reply. No downloads or broad suites were rerun. Removed 13 obsolete local
failed/cancelled cards at the owner's request, retaining native history and
idempotency records. A verified profile/receipt checkpoint and previous image
remain available. This is send-path evidence, not acceptance of every GPT feature.


### Recovery cards (#190, 2026-09-20)

Confirmed failed/cancelled sends in existing chats can be dismissed individually
through the existing owner-scoped endpoint. Their idempotency identities survive;
no native message is removed or sent. Unknown sends remain visible/reconcilable
and cannot use this dismiss action.

Recovery cards have a secondary 44px close target. Restore-to-draft persists exact
text/files before dismissing the card, confirms replacement of a different draft,
and does not let a late dismissal response overwrite another chat's draft. New-chat
recovery moves to the ordinary new-chat composer. Both paths survive reload.

### Navigation after PWA tab eviction (2026-09-20)

The conversation catalog now has a separate account-scoped local snapshot (seven
days, under 500,000 characters). Only navigation metadata and pagination survive;
message history keeps its existing short session cache. Logout clears both.
Restored catalogs refresh in the background, and cold catalog reads start without
waiting for the native connection status. A first visit without a snapshot shows
a loading label instead of an unexplained blank list.

The focused navigation browser check passes in Chromium and WebKit after removing
session storage and disabling the network, including all 20 restored rows,
pagination metadata and logout cleanup. Physical iPhone verification remains the
owner's everyday usage check.

### Public live output (2026-09-20)

The pinned client's `createCompletionStreamHandlers.onUpdate` emits decoded
`{type: "message", conversationId, message}` snapshots (verified in installed
26.915.31945). A passive observer preserves the original callback and writer.
It caches only public assistant text from final/commentary channels, excluding
hidden/tool-directed messages and native citation control tokens. No raw stream,
analysis, credentials or diagnostics cross the private renderer boundary.

The current chat's existing jobs poll also reads this local cache, normally every
1.2 seconds; this is sampled native streaming, not token-by-token browser SSE and
not more upstream history polling. Private receipt/account/user-message binding,
bounded text/cache lifetime and a short independent deadline apply. Optional live
reads bypass the writer queue and never confirm delivery or completion. Failure
silently retains the existing canonical reconciliation/history fallback.

The collapsed bottom strip shows a short recognized action and icon. Text streams
only in the expanded panel; scrolling upward pauses following. Results → Reasoning
groups public commentary/actions by native user-message ID. The main chat displays
completed final responses and user messages. No hidden analysis or tool payloads
are exported. Action labels are localized categories derived from recognized native
tool identities, not invented detailed descriptions or copies of raw tool output.

Active native job reconciliation warms the owner-scoped Hub history cache in the
background (at most once per ten seconds per chat, immediately on completion).
It reuses the native canonical read cache and coalesces pending reads; a returning
client can display the warm snapshot without waiting for another network fetch.
The existing twelve-chat / 16 MiB memory bound and private disk snapshots remain.
This does not crawl inactive chats or retry submissions. Public final rich text,
links, files and results continue to come from canonical history.
