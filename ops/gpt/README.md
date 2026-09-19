# Optional ChatGPT backend

The existing browser is still the main provider. The separate official Linux-client evaluation (#193), protected native recovery and phone trackpad are documented in [GPT_NATIVE_LINUX.md](../../docs/GPT_NATIVE_LINUX.md). Installing that recovery page does not migrate chats or submissions.

This connects the owner's real consumer ChatGPT account using a private Linux Chromium profile. The existing Codex SSH/Companion backend is independent. It does not use an OpenAI API billing key.

The owner signs in directly on the protected connection page. Browser credentials stay in the browser profile. Never copy Windows Codex/ChatGPT authentication data, print browser sessions, publish this state directory, or forward raw adapter diagnostics to the web client.

## Installation

1. Run the preparation script with the deployment's absolute private state directory: node ops/gpt/prepare.mjs /absolute/state.
2. Build and start the optional **gpt** Compose profile in ops/linux/compose.yaml. The state directory must be owned by the container's configured user (1000:1000 in this deployment).
3. Add a gpt configuration object to the Hub: endpoint http://127.0.0.1:8786, tokenSecret GPT_SERVICE_TOKEN. Load GPT_SERVICE_TOKEN from gpt/service-token into the Hub's private environment file; never commit its value.
4. Run login-gateway.mjs as a persistent user service. Set GPT_PUBLIC_ORIGIN to the public HTTPS origin and GPT_VNC_PASSWORD_FILE to the absolute gpt/vnc-password path. GPT_HUB_URL defaults to http://127.0.0.1:8780. The gateway listens only on 127.0.0.1:8787.
5. Route only the /gpt-connect path prefix from the public reverse proxy to that gateway. All assets and remote connections require the normal Hub session; WebSockets additionally validate Origin. The browser API is never publicly routed.
6. Open /gpt-connect after logging into Codex Web and perform the ChatGPT login personally.

The browser container shares the private Compose network with guacd; VNC has no host port. Only the connector's port 8786 is published, on loopback. The intended public entry remains HTTPS on the Hub.

The profile survives container restarts. Its exclusive lock and fixed hostname prevent concurrent Chromium owners. Do not start a second browser against the same profile. Capture profile backups only while its browser is stopped, or sign in again after restoration. GPT outbox and uploaded files are stored in the Hub database/results directory and follow the normal Hub backup policy.

## Behavior

- The branded Codex/GPT switch selects the shared web shell for actual ChatGPT history, model/power selection, send/progress, files and image results.
- Native conversation history follows the active branch and is delivered in pages of 20 visible messages.
- Browser-controlled sends are serialized and idempotent. Closing the web page does not cancel the Hub worker.
- A lost or ambiguous native confirmation never automatically replays the prompt. Text and file references remain in the outbox for explicit review.
- An image-only turn may be completed using canonical native history, even when the browser adapter cannot recognize its final UI state.
- Only visible assistant output and native image results cross the public Hub contract. Hidden analysis, thoughts, internal tool output, signed URLs and extension diagnostics are excluded.
- The protected original ChatGPT interface remains available for account settings and workflows outside the primary chat surface. Exact feature parity in custom controls is not assumed.
- Uploads are bounded to 25 MB per file, 8 files / 64 MB per message. Images are decoded and normalized before native upload.
- Deployment must wait for both Codex turns and GPT queued/preparing/running jobs to finish.

## Pinned dependency

The browser bridge is https://github.com/DrA1ex/chatgpt-bridge, MIT license, revision 96802cc0d2ea0b7449cf465f8adb3c228decd297. Its repository and license remain in the browser image. This revision avoids an unavailable optional ZIP dependency in the subsequent release. Only the minimal browser runtime is used, not its workflow manager or Codex RPC layer.

Compatibility patches are explicit and fail the image build if pinned attachment source changes. They enforce attachment readiness, support image-only filename chips/native renames and restrict removal to actual attachment controls. Model/power selection uses the current accessible ChatGPT menu and is verified before sending. Consumer UI changes may require an adapter update.


## New-chat preparation and recovery

Before applying model/power settings, session preparation verifies the selected browser client, target conversation URL and usable composer. An already-empty new chat is reused without clicking New again. A lost extension acknowledgement is accepted only when that exact navigation effect is independently confirmed; the navigation command is never automatically replayed. An unconfirmed or busy target stops preparation before prompt submission.

Model selection checks the active advanced view before touching its toggle, closes the menu using Escape and permits one bounded recovery attempt for an interrupted menu. The chosen model and power are read back before sending. This retries explicit settings only, never the chat prompt. Failed preparation keeps the text/files and identifies whether conversation opening, settings or attachments failed.

Regression coverage: `tests/gpt-preparation.test.mjs` and `tests/gpt.test.mjs`; `tests/gpt-preparation.browser.mjs` in CI exercises Chromium/WebKit with isolated ChatGPT DOM fixtures and no network. The real-account acceptance used two distinct disposable new conversations with Latest/High and verified their replies before deleting only those fixtures.

## Connection lifecycle

The private browser `/status` contract identifies its pinned bridge revision, bridge 6.3.14 / extension protocol 5, login state, composer/file/model/effort capabilities and private profile ownership/lock checks. It reads the authenticated browser session in place and returns only normalized flags. The Hub validates this contract and exposes disabled, starting, healthy, login-required, incompatible, busy, degraded or unavailable states. Account tokens, native URLs and browser diagnostics are never part of that response.

Each queued job checks compatibility before native navigation. Session setup still proves the target chat; settings must return the exact selected model and effort before attachments or prompt dispatch. Missing capabilities leave unsubmitted work queued. A failed settings readback blocks further dispatch until an explicit connection recheck succeeds. An unavailable/login-required connector is rechecked with bounded delay; recovery may resume queued work but never replays or clears an unknown submission. Settings offers the existing protected sign-in page and a recheck action. Healthy connections add no new login step or composer explanation.

Doctor includes the normalized state, pinned versions, active/unknown counts and private-state flags. Offline doctor skips connector probes. Chromium/WebKit fixtures cover login recovery, missing native controls and rejected settings readback; deterministic service tests cover offline/degraded queues and unknown outcomes. Real-account checks remain opt-in and should be read-only unless a disposable send is explicitly part of acceptance.

### Upgrading the browser bridge

1. Review the new upstream revision and attachment patches; update both the image pin and Hub compatibility contract together. Build a versioned browser image, never a floating dependency.
2. Run unit checks and Chromium/WebKit fixtures with no account credentials. Verify source, protocol and settings readback; do not waive a failed gate by disabling a supported feature.
3. Confirm Hub jobs and native browser requests are idle. Stop only the optional browser container, preserve its private state directory, and take a stopped-profile backup if changing browser/profile format. Never run two Chromium instances against that profile.
4. Start the versioned connector with the same fixed hostname, exclusive lock and user. Read `/status`, catalog/history and model choices through the protected contract. Login-required uses the ordinary connection page; unknown jobs stay unresolved.
5. Deploy the matching Hub after its own active turns finish. Retain the prior image pair and normal Hub backup for rollback; never replay prompts as an upgrade check.

## Attachment-only messages

The pinned bridge's `/chat` and `/sessions/:id/messages` HTTP guards are patched to accept attachments without text, matching its native extension behavior. No placeholder prompt is inserted. Image normalization, attachment readiness and the exact file list remain enforced. The image build runs `verify-bridge.mjs` against the actual pinned router with an isolated fake writer; empty, whitespace-only and text-plus-three-image sends are checked without an account.

Only the bridge's exact pre-dispatch validation refusal receives `X-Codex-Gpt-Dispatch: not-submitted` on the private connector contract. The Hub keeps that job failed with its text/files available for explicit retry. Other HTTP errors, stream errors and dropped confirmations remain unknown and are never replayed automatically. No adapter diagnostics are included in the public job.

## Browser resilience

The optional browser container defaults to 2 GiB RAM (3 GiB including swap), configurable with GPT_MEMORY_LIMIT/GPT_MEMORY_SWAP_LIMIT. The owner's 1 GiB container hit a cgroup OOM that killed Chromium on 2026-09-09; a parent process can restart without Docker reporting OOMKilled=true. Inspect kernel/cgroup events as well as container state. Execution stays on Linux.

Chrome starts with its crash-restore bubble suppressed, without changing the persistent profile or login. Shutdown has a 30-second grace period. Before session/model preparation, the connector dismisses only recognized promotional dialogs using their native Close/Not now controls. Login, payment, consent, deletion, editable and unknown dialogs remain intact and produce an Open ChatGPT action. Read-only health probes never click controls.

Session preparation tolerates document/extension replacement, waits for the exact target and dispatches at most one navigation command. It never retries a prompt. Preparation diagnostics contain fixed stage codes, not DOM excerpts or account contents.

Before a new submission, inspect the pinned extension's selected-tab lease. A `RELEASE_CLEANUP_TIMEOUT` quarantine can remain after cancellation even though native generation stopped. Only that quarantine, with no active bridge requests, unresolved effects/downloads/commands, composer draft, attachments, active editor or dialog, permits replacing the idle document at its exact ChatGPT URL. Native inline writing blocks are permanently editable; preserve their current text/markup in a private `/data/recovery` snapshot before replacement. Backup failure blocks recovery. Recheck immediately before closing the tab and verify a new ready tab without a lease. This uses normal tab teardown, never edits the extension lease or replays failed/unknown sends. Missing evidence blocks recovery; keep the replacement available if loading fails. Concurrent checks share one recovery attempt.

New image-only chats can publish their canonical URL before the user-message DOM exists. The pinned observation adapter now defers this provisional WEB-id transition only for the same accepted request/tab/lease/server and one canonical candidate. It does not adopt that candidate or expose an answer until the native submitted-user boundary is proven. Existing conversation mismatches still fail, and the original acknowledgement deadline/no-replay policy remains in force. Image builds exercise the real pinned adapter and state reducer against both the delayed transition and foreign identities.
The private active-request projection also withholds an unconfirmed new conversation ID from the Hub history fallback until the same native request has a submitted user-turn boundary. A URL change alone cannot confirm completion.
