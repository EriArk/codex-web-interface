> Current owner-integration admission is documented in [GPT_NATIVE_LINUX.md](../../docs/GPT_NATIVE_LINUX.md#owner-workspace-admission-and-dictation-2026-09-19). Earlier lab-only steps below retain their historical scope. The current runtime requires the [sandbox seccomp profile](SECCOMP.md); never restore `--no-sandbox` for an owner release.

# Isolated Linux ChatGPT evaluation

This is the #193 research runtime, **not yet the production GPT provider**. See [the technical record](../../docs/GPT_NATIVE_LINUX.md) for real-account proof, current gaps and rollback.

The supervised read stage below is installed in the original owner's separate runtime. It supersedes temporary debugger startup for ordinary adapter reads; the main GPT workspace still uses its existing provider.

Build on Linux with the checksum-pinned official `chatgpt_amd64.deb` beside the Dockerfile and scripts. Keep the package and all runtime state outside Git. A changed latest package must fail the checksum gate until explicitly evaluated. Run as UID 1000 with a private `/data` mount, exclusive runtime lock, private display/VNC, dropped capabilities, no-new-privileges and bounded resources; publish no ports. **Mount `/tmp` as tmpfs** (`--tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=512m`): X11 lock files and IPC sockets must not survive a container restart. The entry point creates the private runtime directory before DBus starts. Provision private VNC password/auth files before startup. Never reuse an existing browser or Windows account profile.

`configure-browser.sh` runs as the profile owner before the app: HTTP/HTTPS use the private Chromium profile, while `codex://` remains assigned to ChatGPT. The browser runs headed with no automation/debugging port and no copied login. Authentication and any upstream verification remain manual owner actions.

The existing login gateway accepts `GPT_NATIVE_USER_ID` and `GPT_NATIVE_VNC_PASSWORD_FILE` for exact original-owner recovery at `/gpt-connect?runtime=native`. Retain `apps/web/src/remoteInput.ts` with its compiled Hub / vendored Guacamole dependencies on repository-pinned Node 24; this shares PC Remote gestures rather than maintaining another implementation.

Copy `ipc.mjs` and `probe.mjs` into the private container for local research. `node probe.mjs --read` requires an explicitly created disposable calling-thread identity in `/data/carrier.json`; it never creates or prompts that thread itself. It prints sanitized flags/counts, not private chat content. No generic tool/mutation endpoint is exposed.

Verification on Linux, using the existing Hub build and pinned Playwright image:

```sh
node --test tests/gpt-native-ipc.test.mjs tests/gpt-native-recovery.test.mjs tests/gpt-recovery-tunnel.test.mjs
node --test --test-name-pattern='protected.GPT.connection' tests/team-isolation.test.mjs
node tests/gpt-native-remote.browser.mjs
```

Fixture success does not replace account/media, restart or sustained-use acceptance.

### Fresh public-history reader

`renderer.mjs` / `renderer-read.mjs` implement a **lab-only** adapter whose read operations are `inspectAccount()` and `readConversation({conversationId, accountFingerprint, before?})`. They call the pinned app's existing native request service, without copying tokens or relying on its one-minute tool cache. Account inspection proposes a binding; it must not automatically enroll or replace a production user's binding. The additional fixed lab controls are described below.

The reader checks the actual app version, exactly one main window, account fingerprint before/after the request, native `expectedIdentity`, exact conversation ID and current-branch ancestry. It returns up to 20 public messages with native IDs; hidden reasoning, tool internals, account data and signed media URLs stay inside the app. Structured media is explicitly unresolved. It is **not yet a complete Hub history/media contract**.

The transport requires a temporary debugger on container loopback `127.0.0.1:9222`; no host port, HTTP endpoint or generic evaluate API is provided. Normal `start.sh` deliberately does not enable it. Restore ordinary startup and verify the inspector is closed after lab work. Production supervision/transport admission remains a separate migration gate.

```sh
node --test tests/gpt-native-renderer*.test.mjs tests/gpt-native-ipc.test.mjs
```

### Disposable navigation/send/stop proof

The reader additionally offers fixed `selectConversation`, `inspectConversation` and `stopResponse` controls through `renderer-control.mjs`. Selection uses native exact-ID navigation and verifies both route/thread. Stop requires the latest canonical user message ID, the selected chat and one visible enabled native Stop control. A returned `stopIssued` is not a completed-response receipt. State polling does not fetch canonical history.

`NativeLabFollowup` is **only for an explicitly disposable chat**. Its private SQLite ledger binds the exact build/account/chat/caller, records intention before the native IPC send, rejects concurrent pending work and never replays unknown sends. Each diagnostic prompt must contain its operation UUID because this tool has no client-message-ID parameter. Reconciliation is bounded to 100 public messages and needs the exact prior baseline and one exact diagnostic user message. Do not use it for owner conversations or wire it to HTTP. Production must preserve/reuse the existing Hub queue and solve atomic account/turn admission, model/effort and attachment contracts first.

```sh
node --test tests/gpt-native-control.test.mjs tests/gpt-native-followup.test.mjs tests/gpt-native-renderer*.test.mjs tests/gpt-native-ipc.test.mjs
```

### Native Chat model and power selection

`readModels({accountFingerprint})` returns a bounded, account-bound projection of native model versions and intelligence presets. `inspectSettings(binding)` and `selectSettings({...binding, versionId, presetId})` operate the pinned native picker, verify its selected model and accessible slider announcement against that catalog, and close their own picker. These are serialized **lab controls**, not web endpoints. They refuse busy/manual pickers, text drafts, active responses, disabled/locked options, account/chat changes and ambiguous or unconfirmed UI state. They never submit a prompt or enter access/upgrade dialogs.

Preset IDs are not slider indexes, and GPT powers are not Codex reasoning enums. For example, the observed native GPT preset ID `6` is the fourth slider item, titled Extra High, with `thinking_effort: max`. Read the current catalog instead of maintaining a translated positional mapping. Unsupported/localized picker contracts fail closed.

Canonical public messages now include only bounded `model` and `effort` metadata strings for readback verification. A disposable real send confirmed both values. After restart, the selected model/effort survived but the version alias changed from `5.6` to `latest`; the eventual provider must reapply and verify the requested version/preset for every send. This does not solve atomic admission of sends versus manual account changes, attachment-only drafts, supervised transport or Hub queue integration.

```sh
node --test tests/gpt-native-*.test.mjs
```

### Disposable new Chat and file-input proof

`disposableComposer` wraps only the fixed operations in `renderer-composer.mjs`: `prepareNewChat`, `stageText`, `stageFiles`, `inspectDraft`, `submitDraft`, `inspectCreatedChat`, and `confirmCreatedChat`. All require `disposable: true`, an account fingerprint and diagnostic UUID. Preparation preserves any existing native text/file draft and refuses Work mode. The same account, home Chat, exact editor element, text and attachment names must remain bound through staging and submission. One renderer-local lease owns the draft; no generic selector/action or host file path is accepted.

`stageFiles` is deliberately limited to up to four TXT/PNG fixtures, 1 MiB total, with simple names, matching MIME and SHA-256 verification. It returns **not ready** until native upload controls can be inspected. `submitDraft` requires the lab supervisor to persist its intent first; its boolean assertion is not itself a durable receipt store. The renderer marks dispatched before clicking once. On process loss, reconcile the private receipt without replaying creation/upload/send. Production must use the existing Hub jobs instead.

New native Chat windows can retain a `local-chatgpt:<UUID>` client identity even after `/c/<server-UUID>` is assigned. Inspection returns only a candidate; confirmation reads fresh account-bound canonical history and checks the exact first diagnostic prompt and attachment presence. Real TXT/image contents and response completion were verified separately in the proof. Generated media, arbitrary uploads, home model/project selection, supervised transport and production creation admission are not complete.

### Generated sandbox file downloads

`listArtifacts({conversationId, accountFingerprint, before?})` projects sandbox links from one page of public current-branch assistant messages. `readArtifact({conversationId, accountFingerprint, messageId, artifactId})` rereads that exact canonical message, including older messages outside the newest page, before resolving bytes. Hidden messages, user uploads, code examples and invalid paths are excluded. IDs use the existing Hub sandbox Results hash of `[conversationId, messageId, path]`; filenames are labels, never lookup identities.

`renderer-artifacts.mjs` calls the pinned native interpreter-download route with `expectedIdentity`. Its returned signed URL stays inside the renderer. Only the exact ChatGPT estuary content route and HTTPS `*.oaiusercontent.com` hosts are accepted. Estuary uses the app's host-authenticated binary transport and fixed native attach-auth marker, without reading a credential. CDN reads omit credentials and reject redirects. Native-host redirect handling remains the app's responsibility. Account changes discard the result; errors expose fixed codes. The bounded lab response contains base64 bytes, length and SHA-256, at most **1 MiB**. This does not change existing production limits or implement a large-file transport.

Real proof generated and downloaded a TXT and a Python-created PNG, then downloaded identical IDs/bytes after a native restart. This covers sandbox image files, **not native image-generation/service pointers**, Canvas, expired-file regeneration or complete media parity. These methods are lab-only: no Hub Results UI/download route has switched providers. Continue to use the existing authenticated Hub storage/streaming contracts when the supervised provider is admitted; do not expose signed URLs, this inspector or a generic fetch endpoint.

### Supervised private reads and manual recovery

Provision `/data/native-adapter` mode 0700 and `binding.json` mode 0600 with exactly `build`, `userId` and the previously verified `accountFingerprint`. This is an explicit binding, never automatic enrollment. The pinned image starts `supervisor.mjs` only when that file exists. Without it, startup retains the ordinary app. The supervisor launches the same official app with `--remote-debugging-pipe` and inherited fd 3/4. `pipe.mjs` selects exactly one guarded main renderer, bounds frames, binds reply/session IDs, cancels pending reads and detaches sessions. **No debugger TCP port exists.** App exit ends the supervisor/container; Docker's existing restart policy restores the runtime/profile. The inherited pipe is local implementation detail, never a browser API.

By default, `service.mjs` exposes only status, public history/models/sandbox files, and fixed manual-recovery coordination on `/data/native-adapter/adapter.sock` (0600 in the private directory). It requires the configured user, injects the bound account fingerprint itself, rejects unknown fields/methods and serializes reads. Sending, navigation, selection changes, Stop, arbitrary URLs/scripts and account rebinding are not exposed by this default configuration. The ordinary owner Codex app and existing GPT jobs remain independent. The explicit disposable-send canary below is a separate opt-in.

The recovery gateway acquires a durable UUID lease **before** connecting native VNC. Reads cannot start while any manual lease exists, and manual admission refuses an in-flight read. A clean tunnel close destroys the VNC connection before releasing that lease. Abrupt gateway loss leaves the lease on disk across adapter/container restarts. The native page's **Готово** action closes its native tunnels and explicitly resumes website control; it can clear abandoned leases without restarting the app or sending anything. Admission is blocked while resuming. This controls the protected gateway, not arbitrary host-administrator VNC access.

The Hub's `NativeGptReadClient` verifies a same-UID private Unix socket, checks authorization before/after reads, validates response shapes and preserves message IDs/phases/paging. Sandbox links project to authenticated download URLs with the existing Results IDs; download bytes are independently checked for size and SHA-256. No production GPT cache, job queue or provider selection is changed. With `GPT_NATIVE_ADAPTER_SOCKET` configured, the protected original-owner gateway offers read canaries at `/gpt-connect/native/status`, `/gpt-connect/native/history/:id` and `/gpt-connect/native/downloads/:conversationId/:messageId/:id`. History/download responses recheck the live session before delivery. These are admission endpoints, not a replacement workspace UI.

```sh
pnpm exec tsc -b apps/hub --pretty false
node --test tests/gpt-native-*.test.mjs tests/gpt-recovery-tunnel.test.mjs tests/team-isolation.test.mjs
# Run the browser check in the repository-pinned Playwright image:
node tests/gpt-native-remote.browser.mjs
```

For rollback, retain the previous stopped container/image, stopped-profile archive and gateway drop-in. Never run two native containers on the same profile. Restore the prior recovery gateway first; stop the new native container before restoring the old image/startup. Binding removal disables the supervised reader on subsequent startup, so keep the gateway socket configuration and native startup in sync. No engine database restoration or send replay is part of this rollback.

### Existing-chat send canary over Hub jobs

An optional private `canary.json` (0600, same directory/owner as the binding) contains `conversationIds`, an explicit allowlist of at most four **disposable** conversations, and optionally `creationKeys`, at most four exact disposable Hub job UUIDs allowed to create an unassigned Chat. Without it the following methods are rejected. With it, the Unix boundary additionally admits `prepareDispatch`, `dispatchText` and `reconcileDispatch`. No public recovery-gateway write route exists; `writesEnabled: false` continues to describe main-workspace admission.

The host canary uses `NativeGptJobs` and the existing `Store`/`gpt_jobs` schema in a separate private test database. `gpt_native_receipts` is its additional per-job dispatch/public-output record, not a queue. The main `GptService` and production database are unchanged. Before dispatch, commit the exact native user-message UUID, chat, canonical parent, text, model/preset and intent with SQLite FULL synchronization. Reopening a receipt performs reconciliation only. Preserve unknown old-provider jobs; never feed them into this worker.

The adapter selects/verifies native settings, then calls the pinned app's own submission routine with a supplied native user-message UUID and exact text. No diagnostic nonce is appended and no Codex carrier is used. It obtains the native route scope through a temporary wrapper of the read-only `app.get_summary` registry handler, restored immediately in `finally`; it neither traverses React internals nor registers a custom action. A per-call scope/service proxy supplies the exact expected account principal to the native stream, checks its chat/parent/model/message payload and refuses a second POST attempt. Native automatic stream resume is disabled for this bounded canary; canonical reads handle uncertainty. No credentials or raw stream events cross the adapter.

`dispatch.sqlite` stores native-side at-most-once receipts before invocation. Lost acknowledgement, app/Hub restart or missing canonical identity never causes another invocation. Pending receipts block new sends and manual recovery admission. A completed, exact-ID public final message with native `end_turn` clears the pending barrier. This experimental barrier has no owner-facing unknown-receipt resolution UI yet: it is one reason not to enable ordinary conversations. Do not delete receipts or invent a new operation key to retry an ambiguous send.

The installed canary permits one existing disposable chat and one disposable creation job. Existing-chat and new-chat plain-text requests passed through the Hub queue and the official native app, then canonical readback confirmed their exact UUIDs once and the expected answers. Reopening the Hub process and restarting the native container preserved those receipts, responses and previous sandbox file hashes. This proves bounded existing/new-chat text sends, **not** project/attachment queue parity, live-stream acceptance or a production provider switch.

### Durable ordinary Chat creation and bounded catalog

Use `conversationId: null` only with an explicitly configured `creationKeys` job. Preparation navigates to an empty native **Chat** home, preserves text/file drafts and active responses, and verifies the native model/preset. It does not switch Work to Chat or select a project. Hub commits the job, first user-message UUID, random parent UUID and all selected settings before invoking the native writer. Its local conversation identity is `local-chatgpt:<user-message-UUID>`; this is a correlation key, never a confirmed server ID.

The pinned native `mDt` submission receives that local identity, exact first message, explicit ordinary/unassigned/non-temporary Chat options and the same principal/POST-retry guards as existing-chat sends. The native server-ID callback is only a candidate. Adapter `creations` and Hub `gpt_native_creations` record a confirmed server UUID only after canonical history verifies the exact user UUID, parent, text and absence of an earlier user/project/Work association. A different candidate or later attempted ID substitution is rejected. A new-chat receipt keeps its original null target; the separate confirmed binding updates `gpt_jobs.nativeId` atomically with public output. Reopening the job reconciles, never recreates.

`readCatalog` reads one fresh native `/conversations` page of 20 with an explicit account principal, bounded offset, identifiers/titles/timestamps and nullable project/origin metadata. It exposes no raw native record. The private Hub client has a matching typed `catalog()` method; the public workspace catalog has not switched providers.

If the renderer loses the local/server mapping before its candidate reaches disk, reconciliation may inspect the newest catalog page and at most five ordinary chats created since the receipt (with a 60-second clock allowance). `findCreation` confirms by the exact first user UUID/parent/text, never a title or matching text alone. Missing, excessive or ambiguous candidates remain unknown. No complete-history crawl, creation or replay occurs. Legacy receipts without a creation timestamp retain their existing candidate-only recovery. Simulated tests cover this crash window; real proof covers catalog access and normal creation/Hub/native restart, not an induced live crash between POST and first server-ID event.


### Bounded durable attachment canary

With an explicit canary allowlist, `uploadFile({key, conversationId, file})` accepts a Hub file UUID, sanitized name, TXT/PNG MIME, byte count, SHA-256 and canonical base64. The private socket admits at most 1.5 MB request JSON; per-file bytes are limited to 1 MiB. NativeGptJobs further limits four attachments to 1 MiB combined. Its private resolver must authorize the Hub upload ID before returning bytes; this is not a caller-path reader or browser write endpoint.

Native `uploads` receipts are committed before the file-entry operation. Ready results contain only native ID/name/MIME/size/dimensions, bound to the Hub ID/hash and exact operation/conversation. Ready retries return metadata; unknown uploads refuse replay. The three native stages retain signed URLs inside the renderer. Authenticated stages use host expectedIdentity; signed object PUTs have no auth marker and use the original account-bound capability with account checks around transfer. Require a process-ready event before dispatch. Fixed deadlines, no retry, bounded replies and a decoded PNG dimension ceiling apply.

`dispatchText` may include these exact attachment receipts. Canonical user proof matches both text and native file/image identities. Hub preparation/dispatch snapshots remain in the existing gpt_jobs lifecycle, with no second queue. Interrupted preparation never submits; an uncertain send stays readback-only. The main provider and public workspace remain unchanged. See the latest section in `docs/GPT_NATIVE_LINUX.md` for real proof, limits and pending admission.


### Durable library actions (current private candidate)

Optional `canary.json.projectIds` admits at most four disposable project IDs; absence admits none. Existing `conversationIds` also scope thread library mutations. `libraryMutation` and `reconcileLibrary` accept only fixed validated target/action fields. They share dispatch.sqlite and its owner/account binding; unknown library receipts block dispatch/upload/manual takeover. Only `libraryMutation` can create intent; `reconcileLibrary` rejects a missing receipt and never writes native state. Do not discard unknown rows to unlock the runtime.

The shared Hub stores provider-specific library intents, retains send receipts on deletion, and restores pending actions in EntityMenu. Project archive stays local. General manual recovery and real nonempty-project acceptance are still required before public provider admission. See the latest library section in `docs/GPT_NATIVE_LINUX.md` for actual runtime/backup/proof evidence; earlier small-file/read-only sections describe earlier candidates, not current limits.
