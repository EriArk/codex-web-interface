# Storage maintenance and diagnostics

Run these commands on the Linux Hub, as the account owning its private state. They do not need the website password and are not public API endpoints.

## Snapshot

```bash
node apps/hub/dist/maintenance.js backup --config /srv/codex-web/config.json --destination /srv/codex-web/backups/snapshots --keep 7 --revision COMMIT_SHA
```

The source database stays live. Node's SQLite online backup includes committed WAL data. The tool copies every DB-referenced Codex screenshot/upload, GPT upload and local-Linux staged upload, plus existing captured HTML preview documents. It records schema/application/revision metadata and SHA-256 checksums, verifies the result, then atomically publishes the snapshot directory. Notes such as chat/project pins are included with the complete SQLite snapshot.

Format 2 explicitly inventories captured HTML previews. Unopened previews retain their database source references without reading the execution machine during backup. Format 1 remains readable, but old snapshots missing a referenced GPT upload now fail verification; old format-1 snapshots cannot prove HTML cache coverage. Keep incomplete legacy snapshots for manual recovery rather than discarding them.

Artifacts/uploads are immutable after writing; deletion during a snapshot causes an incomplete snapshot to fail without publishing it. Retry the backup during a quiet period if that occurs. The tool never stops the Hub or another service. File copying/checksums use bounded buffers.

Destinations must be absolute private directories (0700) without symlinks, outside Results. Files use 0600. Do not use a public web directory or a shared mount with weaker effective permissions; use encrypted storage when backups leave the host.

The keep count applies only to verified directories created by this tool. Unrecognized, damaged and unrelated files are never pruned automatically. Old manual DB checkpoints in data/migration-backups are separate and should be reviewed after upgrade acceptance.

The data snapshot excludes unrelated files, source repositories, native Codex account/history and Windows staging outside Hub storage. The separate ChatGPT browser profile is not ordinary upload/cache data and is not copied by this tool; back it up only with its browser stopped or sign into ChatGPT again after recovery. Generated native ChatGPT assets continue to depend on the original account/connector. Native continuation still requires the original machine/account/native history. Restoring to a different Hub path does not rewrite absolute paths stored in native Linux conversations: keep the original configured paths when switching a real installation.

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

The target must not exist. The tool checks every checksum and required file, copies into a private temporary sibling, runs supported migrations, revokes all old sessions/bootstrap tokens and marks pending/active work unknown. It never overwrites the live installation. The password hash, original Hub/native thread IDs, history projections and results survive. GPT queued/preparing/running jobs are also marked unknown: they may have completed in the original installation after the backup. Their text/files and native IDs remain intact for explicit review; restoration never automatically resends them. Normal Hub restarts still retain ordinary queued-job behavior.

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

A successful metadata probe is not proof of the full turn contract. Codex 0.153.4 is the exercised Windows version; other versions receive a verification warning. The native compatibility gate is implemented; per-machine allowed project roots remain issue #6.


## Password change, logout and local recovery

Codex and GPT Settings share the same account controls. **Change password** asks for the current and new passwords; the new password retains the enrollment policy (at least 12 characters, Argon2id). It revokes every old session and gives the initiating browser a fresh cookie and CSRF token. **Sign out all devices** revokes all sessions including the initiating browser. Neither action stops native Codex work, queued prompts or durable GPT sends.

For a forgotten password, log into the Hub host as its service owner and create a private one-use link using the matching application version and the existing database:

```bash
node apps/hub/dist/maintenance.js recovery \
  --config /srv/codex-web/config.json \
  --output /srv/codex-web/private-recovery/link.txt
```

Use a new absolute output filename. The directory must be private (0700), without symlinks; the tool creates it if absent and creates the file exclusively with mode 0600. For a container installation run the same command from the matching Hub image (its entry file is `dist/maintenance.js`), with the existing database mounted writable and the private output directory mounted; no network access is needed for issuance. Do not run first enrollment again or delete the database.

The command prints only the output path and expiry time. Read the link from that private file and open it in the normal browser. The token is in a URL fragment, so it does not enter normal HTTP access logs. Issuing a link requires local filesystem access; the website has no API to issue one. Browser redemption accepts only the issued secret with the configured Origin. The form sets a new password and logs that browser in, revoking previous sessions and clearing the fragment.

Links expire after 15 minutes; only the latest link works. Redemption is atomic and single-use. Changing the password or signing out all devices also invalidates outstanding links. Remove the private link file after use. No email, phone, recovery question or fixed backup password is involved.

Session revocation closes navigation/chat streams, Windows Remote and the separate GPT connection page. The GPT gateway maintains an authenticated Hub watch and closes its Remote connection on revocation, Hub disconnect or heartbeat loss. Deploy the matching Hub first, then restart only the optional `codex-web-gpt-login.service` gateway; the persistent ChatGPT browser and active model jobs do not need a restart.

Recovery leaves native IDs, history, files and settings intact. Snapshot restoration always invalidates recovery links as well as sessions, preventing an older snapshot from bringing a consumed link back to life.

Storage quotas and conservative weekly compaction: [Storage](STORAGE.md).
