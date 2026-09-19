# Isolated Linux ChatGPT evaluation

This is the #193 research runtime, **not yet the production GPT provider**. See [the technical record](../../docs/GPT_NATIVE_LINUX.md) for real-account proof, current gaps and rollback.

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
