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

`renderer.mjs` / `renderer-read.mjs` implement the next **lab-only, read-only** adapter. They call the pinned app's existing native request service, without copying tokens or relying on its one-minute tool cache. Only `inspectAccount()` and `readConversation({conversationId, accountFingerprint, before?})` are available. Account inspection proposes a binding; it must not automatically enroll or replace a production user's binding.

The reader checks the actual app version, exactly one main window, account fingerprint before/after the request, native `expectedIdentity`, exact conversation ID and current-branch ancestry. It returns up to 20 public messages with native IDs; hidden reasoning, tool internals, account data and signed media URLs stay inside the app. Structured media is explicitly unresolved. It is **not yet a complete Hub history/media contract**.

The transport requires a temporary debugger on container loopback `127.0.0.1:9222`; no host port, HTTP endpoint, generic evaluate API or write operation is provided. Normal `start.sh` deliberately does not enable it. Restore ordinary startup and verify the inspector is closed after lab work. Production supervision/transport admission remains a separate migration gate.

```sh
node --test tests/gpt-native-renderer*.test.mjs tests/gpt-native-ipc.test.mjs
```
