# Private Hub connection to member PCs

The original owner's Windows PC continues through its existing LAN SSH/Companion connection. Member enrollment uses a separate `codex-web-hub` Tailscale node. It does not reuse or reconfigure the Books service's node, profile or network. Member setup never gates the owner's ordinary work.

## Host setup

Use [the pinned Compose file](../ops/linux/tailnet.compose.yaml), based on the [official Tailscale Docker deployment](https://tailscale.com/docs/features/containers/docker). On the Linux host, copy it to a private service directory. Create `state/` owned by root with mode `0700`; the daemon runs as root with only its required network capabilities. Keep an adjacent `.env` containing the absolute `CODEX_WEB_TAILNET_STATE` path. It contains no login key.

```sh
docker compose up -d
docker exec codex-web-tailnet tailscale --socket=/tmp/tailscaled.sock up \
  --hostname=codex-web-hub --accept-dns=false --accept-routes=false \
  --shields-up=true --ssh=false --timeout=5s
```

The owner opens the displayed one-use login link and chooses the intended network. No permanent auth key is included in the installer or repository. Check `tailscale status --json` through the same socket after sign-in. The dedicated `codex-tailnet` TUN interface supports normal system SSH routing; a userspace-only SOCKS node would not provide that route to the Hub's existing transport.

The node does not accept inbound connections, change host DNS, accept subnet routes, run Tailscale SSH or advertise an exit node. The public app still uses HTTPS at its ordinary address. Preserve the host's existing default/LAN route and other services. `.env` and the private state survive container recreation; keep state backups private because they retain node identity.

## Enrollment

Set `team.hubTailnetAddress` to this node's actual IPv4 address in the private Hub configuration, with a configuration backup and the normal guarded engine update. Keep `registrationEnabled` false until the intended invitation admission. Do not substitute the original owner's LAN address or another service's Tailscale address.

The friend must join this chosen network through its owner's invitation/approval, or explicitly share their PC with the Hub's network identity under a compatible access policy. Signing into an unrelated personal network alone does not connect the two nodes. The existing administrator computer-approval step verifies Hub → member PC SSH and identity; no extra per-message network gate is added. An inbound ping to the shielded Hub is not the readiness criterion.

## Installation evidence — 2026-09-20

The owner completed login for the separate Hub node. Restart retained its node identity and address; the default route and Books node remained unchanged. The private first-login state checkpoint is stored alongside deployment backups. Host paths and the selected private IP are recorded in the deployment's private `tailnet-admission.json`, not in a public installer template. The updated Hub setting travels with the queued member release.

Automated browser admission verifies registration, deferred setup, project invitations, shared materials and revocation with disposable identities. It does not prove the friend's real network, Windows installation or native accounts. Those remain explicit first-use acceptance items.

To remove this new network attachment, stop only this Compose service and remove its address from future member enrollment configuration through a guarded update. Preserve private state for recovery; do not log out or delete unrelated nodes as part of rollback.
