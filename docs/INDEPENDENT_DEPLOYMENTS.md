# Independent website and execution lifetimes

The public `hub` container is a small web/API gateway. It serves versioned PWA assets and streams the existing HTTP/WebSocket contract over an owner-only Unix socket to `engine`. It has no database, SSH credentials or GPT connector token. The engine retains authentication, CSRF checks, durable receipts, native writers, approvals, queues, event replay, GPT orchestration and terminal processes. Neither container opens a Windows listener. `/internal/*` is never forwarded publicly.

Restarting/replacing **hub only** disconnects browser transports temporarily. Engine work continues. Clients use existing history/queue/outbox reconciliation and reconnect; the proxy does not retry HTTP mutations or replay terminal input. The public contract remains the same for already-open clients. Replacing the engine is a different operation and still requires safe idle/drain admission.

## Public assets

`engine-compat.json` declares the protocol and supported schema range. The publisher checks the running engine twice, copies immutable assets, rejects hash conflicts, retains old hashed assets for open clients and atomically changes `current.json`. It checks `/version.json` after publication and rolls the pointer back if that check fails. A failed candidate never becomes an installed release. Public files are confined to the release manifest/retained assets, excluding maps and private status records.

Build and verify on Linux, then run:

```
CODEX_WEB_STATE=/private/state python3 ops/linux/publish-web.py <verified-image-revision>
```

This does not restart either service, run migrations or consult active turns. Keep old release directories/assets until explicitly maintaining storage; never delete assets solely because another client has installed the new UI. A publisher lock prevents concurrent switches. A stale lock after a killed publisher requires checking `current.json`, status and active publisher processes before manual removal.

## Gateway and engine upgrades

Compose pins `WEB_REVISION` and `ENGINE_REVISION` separately. After verifying compatibility, update only the gateway with `docker compose up -d --no-deps hub`; do not use a blanket compose restart/down. The gateway verifies its running engine at startup. An incompatible API/protocol change requires a coordinated maintenance release, not an unsafe hot swap.

The initial split and engine/schema changes use the existing guarded maintenance path: check native/GPT/unknown work, pending receipts, project operations and terminals; take a consistent backup; recheck under SQLite admission lock; stop only the admitted engine; migrate/start; verify health, auth and postconditions. Never roll an older engine across a newer database schema. Restore the pre-migration backup only before admitting new user writes, otherwise recover forward. The owner now permits replacing verified idle terminal sessions (2026-09-13). Shell lifecycle notifications and read-only process checks must confirm idle work; active commands/background jobs and unavailable state still block replacement. The final check freezes terminal input/creation through the private engine socket. Opening Settings does not reserve or close sessions.

`ops/linux/upgrade-engine.py` implements this guarded path and requires the expected installed revision, a clean verified release worktree and a verification receipt. Its `--check` mode performs read-only admission checks. The first split also retains the previous monolithic UI's hashed assets. Once the new public gateway admits requests, a failed postcheck preserves the new engine/database for forward repair instead of risking new owner work by rollback.

Deployment controllers write bounded `maintenance.json` beside the atomic web status: `kind: engine`, `revision`, `state` (`staged`, `waiting`, `installing`, `installed`, `failed`, `rolled_back`), `startedAt`, `updatedAt`, optional `installedAt` and fixed error `code`. The authenticated Settings panel shows these outcomes, waiting time and current blockers. It distinguishes terminal presence from verified command activity and never labels a staged build as installed.

Before starting the initial engine, create owner-only `engine/` and `web-releases/` directories. Start `engine` without `hub`, seed the initial assets using the publisher without a public postcheck, then start the gateway and perform the guarded public postchecks before recording success. The engine's socket startup refuses to unlink a live engine or a non-socket; only an owner-owned stale socket is removed.

## Verification boundary

Disposable native/connector/PTY fixtures test streaming, pending form identity, exact approval response, queued sends, uncertain receipts, GPT streaming and terminal buffers through actual Unix-socket HTTP/WebSocket proxy connections and gateway restarts. Publication tests cover compatibility rejection, old asset availability and rollback. Browser tests cover phone/tablet draft, history and scroll continuity. These checks do not imply formal physical iPhone/iPad acceptance; the owner continues that through everyday use.
