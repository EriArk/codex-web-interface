# Linux ChatGPT evaluation — #193

Date: 2026-09-19. **Isolated evaluation, not a production provider migration.** The owner has signed in. Consumer GPT catalog/history and an exact-once direct follow-up are proven; the full web provider and decision gate remain open.

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

The fresh answer appeared visually before the IPC read returned it. The exact cause of that cache/refresh delay is not yet established. A minute-long fresh-tail delay makes the current read-only tool contract insufficient as the sole live-chat transport.

| Capability | Actual evidence | Remaining gap |
| --- | --- | --- |
| Consumer catalog / history | Real authenticated reads, native IDs, public user/agent messages | Larger history, branch fidelity and fresh live updates |
| Existing Chat follow-up | Real direct IPC send and exact canonical prompt/answer, no replay | Native streaming, stop and durable provider integration |
| Ordinary Chat creation | Works in the native UI | `create_thread` only offers Codex/projectless/ChatGPT Work cloud targets |
| Model / effort | Consumer UI exposes model control | Tool overrides are Codex-only; no direct ordinary-GPT picker contract here |
| Attachments / generated media | Existing native app UI remains available | Send schema has no attachment input; advertised `attach_artifact` is PR-only, not a file upload API |
| Projects, branches, Canvas, schedules | Some related tool/UI surfaces exist | No complete parity proof; preserve current capabilities through migration |
| Account / recovery | Owner login and protected view work; container restart preserves login and both exact test turns | Host reboot, reauthentication and sustained-use acceptance |
| Team | Native lab denies other users | Per-member native provisioning, lifecycle and backup admission remain unimplemented |

`ops/gpt-native/ipc.mjs` / `probe.mjs` are a build-gated **read-only research interface**, not an HTTP provider. Requests have bounded frames, exact response IDs, timeouts and no automatic retries. The disposable write proof was a one-off private receipt-guarded lab script; the web client cannot invoke arbitrary tools or send through this spike.

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

The direct IPC path is real and useful, but does not yet cover the required live-chat contract. Next evaluate the native semantic renderer/main-process interfaces for fresh stream events, ordinary Chat creation, model/effort and media. Do not turn pixel clicking or arbitrary injected code into the normal provider architecture. Keep #193 open until the hybrid/direct choice has lifecycle, media and comparable resource evidence.

Reuse the existing Hub provider-facing types, durable serialized operations, source IDs and local history projection. A provider switch must retain draft associations, Results backlinks, projects and unknown receipts. Unknown old sends stay unknown until canonical reconciliation; migration never authorizes replay. Introduce no account-token extraction or native fallback across users.

For recovery, restore the saved user-service drop-in (or remove only the native-lab drop-in to return to the original service), reload user systemd and restart **only** `codex-web-gpt-login.service`. Preserve both profiles and all engine databases. Ordinary Codex recovery remains independent.
