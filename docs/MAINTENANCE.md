# Storage maintenance and diagnostics

Run these commands on the Linux Hub, as the account owning its private state. They do not need the website password and are not public API endpoints.

## Snapshot

```bash
node apps/hub/dist/maintenance.js backup --config /srv/codex-web/config.json --destination /srv/codex-web/backups/snapshots --keep 7 --revision COMMIT_SHA
```

The source database stays live. Node's SQLite online backup includes committed WAL data. The tool copies every DB-referenced screenshot/upload and local-Linux staged uploads, records schema/application/revision metadata and SHA-256 checksums, verifies the result, then atomically publishes the snapshot directory.

Artifacts/uploads are immutable after writing; deletion during a snapshot causes an incomplete snapshot to fail without publishing it. Retry the backup during a quiet period if that occurs. The tool never stops the Hub or another service. File copying/checksums use bounded buffers.

Destinations must be absolute private directories (0700) without symlinks, outside Results. Files use 0600. Do not use a public web directory or a shared mount with weaker effective permissions; use encrypted storage when backups leave the host.

The keep count applies only to verified directories created by this tool. Unrecognized, damaged and unrelated files are never pruned automatically. Old manual DB checkpoints in data/migration-backups are separate and should be reviewed after upgrade acceptance.

The data snapshot excludes unrelated files, source repositories, native Codex account/history and Windows staging outside Hub storage. Native continuation still requires the original machine/account/native history. Restoring to a different Hub path does not rewrite absolute paths stored in native Linux conversations: keep the original configured paths when switching a real installation.

## Deployment configuration and secrets

Opt in to specific configuration files by repeating --private-file. They are copied under private/ within the already protected snapshot:

```bash
node apps/hub/dist/maintenance.js backup --config /srv/codex-web/config.json --destination /srv/codex-web/backups/configuration --keep 3 --revision COMMIT_SHA \
  --private-file config.json=/srv/codex-web/config.json \
  --private-file remote.env=/srv/codex-web/remote.env \
  --private-file ssh/config=/srv/codex-web/ssh/config \
  --private-file ssh/windows_key=/srv/codex-web/ssh/windows_key \
  --private-file ssh/known_hosts=/srv/codex-web/ssh/known_hosts \
  --private-file tunnel/config.yml=/srv/codex-web/tunnel/config.yml \
  --private-file tunnel/TUNNEL.json=/srv/codex-web/tunnel/TUNNEL.json
```

The supported names are config.json/yaml/yml, remote.env, deploy.env, and individual ssh/ or tunnel/ files. Never include native auth.json or an ingress account-wide certificate. No secret values are printed by the command. Keep configuration snapshots in their own destination so routine data retention does not discard the last known credential backup.

## Verify and restore rehearsal

```bash
node apps/hub/dist/maintenance.js verify --snapshot /srv/codex-web/backups/snapshots/SNAPSHOT
node apps/hub/dist/maintenance.js restore --snapshot /srv/codex-web/backups/snapshots/SNAPSHOT --target /srv/codex-web/restore-check
```

The target must not exist. The tool checks every checksum and required file, copies into a private temporary sibling, runs supported migrations, revokes all old sessions/bootstrap tokens and marks pending/active work unknown. It never overwrites the live installation. The password hash, original Hub/native thread IDs, history projections and results survive.

The restored directory contains app.db, results/, optional private/ configuration and a restore.json receipt. Configure an isolated Hub on a separate loopback port, pointing databasePath/resultsPath there; log in with the existing password and inspect history/files. Use a disposable native conversation for any execution test, not an active owner's conversation.

For a real recovery, finish active work, stop only the Hub, select validated restored state and configuration, and start the matching application. Keep the old state for rollback. Do not replay unknown commands automatically. Source repositories/native account state require separate recovery on their execution machines.

Regression tests exercise live-WAL snapshots, login after restore, old-session revocation, native ID preservation, artifact/upload bytes, checksum failure, missing files, symlinks, retention and refusal to overwrite an existing target. The opt-in scripts/qa-real-restore.mjs additionally proves context recall by real Windows Codex after restore.

## Scheduled backup

The supplied user service runs an immutable Hub image with no network and read-only source state. It mounts only its protected snapshot destination writable. It does not restart the live Hub, guacd or ingress.

Copy ops/linux/codex-web-backup.service and .timer into the service user's ~/.config/systemd/user. Create ~/.config/codex-web/backup.env with mode 0600:

```ini
CODEX_WEB_STATE=/srv/codex-web
CODEX_WEB_CONFIG=/srv/codex-web/config.json
CODEX_WEB_BACKUPS=/srv/codex-web/backups/snapshots
CODEX_WEB_IMAGE=codex-web-hub:COMMIT_SHA
CODEX_WEB_REVISION=COMMIT_SHA
CODEX_WEB_UID=1000
CODEX_WEB_GID=1000
```

Create the destination as the same UID/GID, mode 0700. Use the actual service account IDs and tagged image. The default service includes the non-secret config; take the separate optional credential snapshot after installation and whenever credentials change.

```bash
systemctl --user daemon-reload
systemctl --user start codex-web-backup.service
systemctl --user enable --now codex-web-backup.timer
systemctl --user list-timers codex-web-backup.timer
```

The timer runs daily at 03:30 in the server timezone with up to 10 minutes jitter and catches up after downtime. Ensure the service account's user manager is available at boot (for example systemd linger). On each deployment, update the pinned image/revision in backup.env and run one manual service check.

## Doctor

```bash
node apps/hub/dist/doctor.js --config /srv/codex-web/config.json
node apps/hub/dist/doctor.js --config /srv/codex-web/config.json --json --revision COMMIT_SHA
```

Use --offline to skip network/executable probes; --public adds the configured public HTTPS health check. Exit 1 means an error was found, while warnings such as unrestricted project roots remain explicit.

The report checks Hub HTTP, SQLite schema/usage, private-path access, disk space, SSH/host-key/auth, Codex executable/version/login, Companion stdio, read-only model/project/planning capabilities, guacd and Remote TCP/secret presence. It does not create/resume/send a conversation, capture a desktop or modify the running Hub database. Windows probes start and close their own diagnostic App Server only.

Machine labels are anonymous indexes. Reports omit configured Windows paths, hostnames, account names, project names, tokens, prompts and raw RPC/SSH errors. The canonical public origin and numeric versions/counts are included. Human and JSON forms use the same normalized checks; no telemetry is sent.

A successful metadata probe is not proof of the full turn contract. Codex 0.153.4 is the exercised Windows version; other versions receive a verification warning. Full compatibility gating and allowed project roots remain issues #7 and #6.
