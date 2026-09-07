# Optional ChatGPT backend

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

Regression coverage: `tests/gpt-preparation.test.mjs` and `tests/gpt.test.mjs`; the opt-in `tests/gpt-preparation.browser.mjs` exercises Chromium/WebKit with isolated ChatGPT DOM fixtures and no network. The real-account acceptance used two distinct disposable new conversations with Latest/High and verified their replies before deleting only those fixtures.
