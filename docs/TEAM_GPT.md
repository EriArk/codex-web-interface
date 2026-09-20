# Private ChatGPT profiles

## Native member clients (2026-09-20)

This section supersedes the browser-only provisioning description below. Configure new installations with `team.gptProfiles.runtime: "native"`. The explicit `browser` mode and configurations without a runtime retain compatibility with existing browser profiles; changing the mode never migrates or replaces an existing container silently.

Each member prepares an empty Linux client, opens their own protected connection page, signs in normally, then presses **Activate ChatGPT**. The client records that user's native account binding. Reopening the client retains the binding; another native account cannot silently replace it. The owner's configured client remains untouched. The engine derives the member socket from its private user directory; neither an HTTP parameter nor a missing member profile can select the owner's account.

Host configuration adds `CODEX_WEB_GPT_NATIVE_IMAGE=codex-web-gpt-native:<verified-revision>`. `CODEX_WEB_GPT_IMAGE` still supplies the mount-free egress helper and must contain `public-egress.mjs`. The updated host service passes the pinned `ops/gpt-native/seccomp.json`; native profiles keep the existing isolated Docker network, private Guacamole transport and public-only proxy. The login gateway additionally needs `GPT_TEAM_ROOT` set to the **host-side** absolute team root. The engine's `/data/team` path is not the host path. Long host-side socket paths use a checked directory descriptor to avoid Linux's Unix-socket path-length limit.

The native supervisor can start before login using a private `enrollment.json` containing only the Hub user ID. Activation creates the account binding and enables the same supported native capabilities used by the owner; no API key or copied consumer credentials are needed. Manual Remote sessions and resume controls are scoped to that user.

Verification: `tests/gpt-member-deletion.test.mjs` covers two distinct bindings/private runtimes, owner preservation and restart behavior; `tests/team-native-host.linux.mjs` starts and removes an actual empty native profile. This establishes provisioning, not a completed friend-account sign-in or hardware acceptance. The next isolation/revocation pass precedes enabling registration.

### Background chat deletion

The Hub saves a tombstone and a durable deletion job before acknowledging the confirmed delete. The chat disappears immediately; unsubmitted queued prompts for it are cancelled. Existing work is allowed to finish. Native deletion is attempted while idle with bounded retry delays. Unknown outcomes are reconciled from the same receipt after reconnect/restart rather than resent. Such a receipt blocks only that deleted conversation, not ordinary sends in another chat. A native chat already absent completes without another write. Project deletion keeps its existing separate semantics.

Candidate implementation for #151. Production `379fa17` and the original GPT browser/profile remain unchanged. This is an extension of the existing consumer ChatGPT adapter, not an API billing account.

## Member experience

Settings → Connections → My ChatGPT → Prepare. The server prepares an empty personal browser. Open **My ChatGPT and sign in**, complete the normal native account flow, then activate the connection when personal work is idle. Each member uses their own subscription, projects, messages, quota and dictation. Neither a missing profile nor a failed connection falls back to the installation owner's account.

Repeated preparation retains the same profile, connector keys and pending request. Startup is polled asynchronously; an explicit retry rechecks the same containers. Existing browsers are not replaced automatically. Other people's private runtimes are unaffected.

## Host preparation at release admission

Prerequisites: Linux Docker 28 or newer with bridge `isolated` gateway mode, UID/GID 1000, the built candidate GPT image and available memory. The default profile limit is two **including the existing owner's browser**. Each additional profile has a 2 GiB browser limit plus two 128 MiB helpers; measure real pressure before increasing the limit. Profile data is private under `team.root/users/<user-id>/gpt`.

Enable `team.gptProfiles` in the candidate's private config:

```json
{ "enabled": true, "maxProfiles": 2, "portBase": 8900 }
```

Reserve loopback ports `portBase + slot` for the authenticated adapter and `portBase + 100 + slot` for that user's Guacamole transport. The engine and login gateway run in the existing host network arrangement. No member browser or VNC listener is published publicly.

The host service in `ops/linux/codex-web-team-gpt.service` reads a private `/etc/codex-web/team-host.env` containing `CODEX_WEB_SOURCE`, `CODEX_WEB_CONFIG`, and `CODEX_WEB_GPT_IMAGE`. Use an immutable verified `codex-web-gpt:<revision>` image. The pinned Guacamole image is defined in the reconciler. Its matching timer processes requests; the application gets neither the Docker socket nor a shell-command endpoint. Install/enable this service only during the admitted team cutover, not against the stable live installation while developing.

The login gateway needs `HUB_ENGINE_SOCKET` pointing to the owner-only team engine socket. Keep its existing owner VNC configuration for the original profile. With the socket configured, failure is closed: it cannot use the legacy browser for a member. HTML and WebSocket connections bind to the authenticated user; changing accounts invalidates an old page, and revocation ends its live tunnel. Credentials cross only the private engine socket, never HTML or the browser WebSocket.

## Network boundary

Each new profile has its own browser, Guacamole process and internal network with no host gateway/default route. It never connects to the legacy/shared Guacamole network. A separate mount-free edge process carries fixed inbound adapter/Guacamole streams and an outbound HTTP/HTTPS proxy. Outbound DNS resolves only to public IPv4; LAN, Tailnet, loopback, link-local, metadata, multicast and special-purpose destinations are refused. The proxy connects to the checked numeric address, preventing DNS rebinding. IPv6-only destinations are currently unsupported. OAuth pages can use normal public origins without an incomplete provider-domain allowlist.

Only the edge has an external network. It has no profile files or account credentials. Browser-side proxy changes or a terminal inside the remote browser do not create a direct route out. The original owner's existing browser retains its current network/profile; do not claim it has been retrofitted with this isolation.

Network behavior follows [Docker's isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/) and [Playwright proxy settings](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context-option-proxy). This is application/host isolation, not protection against the host administrator.

## Backup and remaining acceptance

Registry snapshots preserve profile ownership, slot and generated connector keys. A separate host command now copies **stopped browser profiles**, verifies the exact owner mapping and checks every file. It refuses any running/restarting container with an overlapping profile mount and holds the browser's OS lock throughout copying. The host reconciler uses a second common OS lock so profile preparation cannot race a backup. Neither command prints native credentials.

After verified all-user idle maintenance and stopping the relevant browsers, run from the candidate source as the deployment UID. These commands do not stop services or start any native writer:

```sh
node apps/hub/dist/team-profile-cli.js --config /private/team-config.json --destination /private/backups/gpt --legacy-profile /private/original-gpt-data
node apps/hub/dist/team-profile-cli.js --verify /private/backups/gpt/codex-gpt-backup-UUID
node apps/hub/dist/team-profile-cli.js --restore /private/backups/gpt/codex-gpt-backup-UUID --team-root /private/isolated-restore/team
```

Omit `--legacy-profile` only when this installation has no legacy GPT connector. The option identifies the existing browser's complete `/data` mount, not just its `profile` subdirectory. Preserve the matching normal team snapshot as well. Preparation must finish before taking a whole-profile checkpoint; a missing configured profile/container fails visibly instead of being silently omitted. Private files use 0600 and directories 0700; original files and profiles are not changed. Only Chromium's three transient Singleton entries and the advisory lock are omitted. There is no automatic profile-backup retention deletion.

Restore requires a matching, already restored team registry with `nativeAdmission=blocked`. It verifies checksums and connector ownership and atomically stages the profiles in `restored-gpt-profiles`; it refuses an existing destination. It does not install them into live browser mounts, overwrite newer state, revoke native accounts or enable execution. Coordinated release readmission (reviewing native receipts, pinned machines and the staged profile paths before enabling the engine) remains an outstanding gate. A copied snapshot cannot start a second native writer by itself.

Linux fixture tests cover exact retry, wrong-user access, tampered container identity, private ingress, account switching and revocation of the real login gateway process. `tests/team-gpt-host.linux.mjs` additionally starts a disposable empty profile and verifies real Docker routing, authenticated service health, public HTTP, the dedicated Guacamole handshake and stopped-profile backup. It uses no native login, message send, original profile or production config. Profile recovery tests cover two accounts, wrong mappings, held OS locks, corrupted files and blocked readmission. Real friend-account login/dictation/streaming remain explicit acceptance items.
