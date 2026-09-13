# Private ChatGPT profiles

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

Registry snapshots preserve profile ownership, slot and generated connector keys. Browser files require a **separate consistent stopped-profile backup** before relocation or restore; the profile lifecycle and release-readmission procedure is still an outstanding gate. A restored team registry blocks native admission and host provisioning, so a copied snapshot cannot start a second native writer.

Linux fixture tests cover exact retry, wrong-user access, tampered container identity, private ingress, account switching and revocation of the real login gateway process. `tests/team-gpt-host.linux.mjs` additionally starts a disposable empty profile and verifies real Docker routing, authenticated service health, public HTTP and the dedicated Guacamole handshake. It uses no native login, message send, original profile or production config. Real friend-account login/dictation/streaming and stopped-profile recovery remain explicit acceptance items.
