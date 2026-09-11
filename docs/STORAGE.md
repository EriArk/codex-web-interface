# Storage and retention

The Hub keeps full conversation messages, result references, public progress, idempotency receipts and sent attachments. Maintenance never removes source repositories, native conversation files, the ChatGPT browser profile, or Windows staging that native history may still reference.

## Limits and visibility

Settings → Storage and the authenticated `GET /api/storage` report Hub database/WAL, images, uploads and cached previews. Windows staging initially shows an estimate from sent attachment metadata. **Check computer copies** requests an actual, read-only inventory through the existing system SSH connection (`GET /api/storage/staging`, cached for 60 seconds). It reports complete and unfinished attachment copies and unacknowledged GUI screenshots separately. Missing machines and incomplete scans remain explicit; this never acquires a Codex writer or returns private filesystem paths. The GPT connection reports indexed bridge file totals separately.

Optional `hub.storage` configuration (bytes, unless noted):

| Property | Default | Effect |
| --- | --- | --- |
| artifactBytes | 8 GiB | Reject new Hub images above quota; retain existing results |
| attachmentBytes | 2 GiB | Aggregate Codex uploads |
| gptUploadBytes | 2 GiB | Aggregate original GPT uploads |
| databaseWarningBytes | 512 MiB | Warning only; do not truncate visible history |
| transientDays | 30 | Minimum age for covered streaming fragments; minimum 7 |
| orphanDays | 30 | Minimum age for proven unreferenced Hub files; minimum 7 |
| batchSize | 1000 | Maximum events and files per run; maximum 10000 |

The GPT container separately accepts `GPT_UPLOAD_MAX_BYTES` (2 GiB) and `GPT_ARTIFACT_MAX_BYTES` (8 GiB). Its adapter's former ten-artifact eviction is disabled: reaching the quota rejects new storage instead of silently deleting earlier images. Completed upload transport copies are released through the private connector. Schema 9 records these file IDs durably and retries cleanup after a busy connector or process restart. Failed, cancelled and uncertain jobs retain their copies; cleanup never resends a prompt.

Cached HTML previews keep their existing bounded cache. Original user uploads and history remain durable. Database, receipt and Windows staging totals are monitored rather than hard-capped; automatic destructive history retention is intentionally not implemented.

## Maintenance

Read-only report:

```sh
node apps/hub/dist/storage-cli.js --config /absolute/private/config.json
```

Apply one bounded batch, with a mandatory private backup destination:

```sh
node apps/hub/dist/storage-cli.js --apply --config /absolute/private/config.json --destination /absolute/private/backups
```

The command refuses active or uncertain Codex/GPT work, pending/unknown command receipts, missing referenced bytes, partial inventories and symlinks. It creates and verifies a snapshot before mutation, including selected orphan files so they can be restored. It rechecks work state under a SQLite write transaction. There is no automatic vacuum.

The same guard includes open device terminals, pending project setup/work, Git delivery and unfinished GUI captures. Results, frozen Reviews, GUI receipts and captured Notes protect referenced artifacts even when their catalog row is missing; a metadata gap stops cleanup for investigation. Each file is rechecked against current references under a short SQLite write lock before removal, rather than trusting the original inventory.

Only these objects are eligible after 30 days:
- Intermediate assistant deltas with a later complete item that still exactly matches the durable message and belongs to a terminal turn.
- Recognized Hub image/upload/preview filenames that have no durable reference. Job-owned GPT uploads remain protected even if their upload metadata is missing.

Full messages, completion events, user messages, Results, public progress and idempotency receipts remain unchanged. Existing cleanup of unsent Codex upload drafts is unchanged.

## Retention matrix

| Scope | Policy |
| --- | --- |
| Messages, semantic events, Results and pins, Notes, Tasks, Core, Plans, Reports, Reviews | Durable owner data; never swept because of age or project/chat archive/deletion. Artifact byte quotas refuse new bytes instead of evicting retained Results. |
| Covered assistant streaming fragments | Eligible only after the configured age, a terminal turn and an exact durable full-message projection. |
| Command, project operation, delivery, capture and GUI request receipts | Durable identities and recovery evidence. No time-based eviction that could make an old retry execute twice. Database usage has a soft warning; GUI helper limits new receipts to 1000 and refuses extra launches rather than erasing identities. |
| GPT jobs and outbox | Keep canonical branch/outcome, files and exact-send identities, including completed/failed/cancelled jobs. Unknown outcomes are never expired or replayed by maintenance. |
| GPT progress | Already bounded to 24 public entries per job, 500 characters per label. Retain these visible stages with their job rather than erasing the owner's answer timeline. |
| GPT transport copies | Release only on canonical completed jobs, with durable retry records; retain unknown, failed and cancelled jobs. Original uploads and generated assets remain subject to their byte quotas and durable references. |
| HTML preview cache | Bounded rebuildable cache; preserve metadata/source identity. Recognized orphan bytes follow the verified-backup maintenance policy. |
| Windows completed attachments | Durable because native Codex messages contain these paths. Never sweep them by age; exact explicit send retries reuse/re-stage the same verified path instead of multiplying copies. Hub upload quotas bound ordinary upload growth; the actual machine inventory exposes legacy copies too. |
| Windows unfinished transfers | Only recognized `.upload-UUID.part` files at least 30 days old, never submitted as native attachment paths, are eligible for explicit backed-up retirement. |
| Windows GUI screenshots | Acknowledge/remove the transport PNG only after its private Hub Artifact/Result is persisted. Unknown captures retain their bytes; launch/stop identities remain. |
| Native repositories/history and ChatGPT browser profile | Outside cleanup scope, always. |

Durable owner content and compact idempotency metadata have a documented retention policy, not a destructive total-history cap. Check the database warning and backups during normal maintenance. Passive WAL checkpoint follows compaction; `VACUUM` is not automatic and requires an offline backed-up maintenance window.

## Windows unfinished transfers

Read actual usage without changing files:

```sh
node apps/hub/dist/storage-cli.js --config /absolute/private/config.json --staging-machine main-windows
```

Explicitly retire one batch of old unfinished transfers (at most 100 files / 25 MiB) from the Linux host with the configured SSH identity:

```sh
node apps/hub/dist/storage-cli.js --apply --config /absolute/private/config.json --staging-machine main-windows --destination /absolute/private/backups
```

This is a separate administrator CLI operation, not an automatic browser action or part of the network-disabled weekly unit. It scans only the fixed `%LOCALAPPDATA%/CodexWeb` staging directories, rejects links and escaping paths, verifies file identity/age/size/hash, copies every selected partial file into a private Linux snapshot, reads it back, fsyncs files and directory entries, then rechecks work state and removes only the same unchanged partials. A change, incomplete scan or backup failure leaves source bytes intact; a lost cleanup response is reported as unconfirmed and the verified backup remains. Completed `upload-*` files and GUI receipts are never eligible.

The snapshot `manifest.json` records machine ID, original relative path, hash, size and backup filename. For an exceptional recovery, verify those hashes and explicitly copy the corresponding `part-N.bin` bytes back to that machine's recorded application-owned relative path while idle; do not overwrite a changed or newly created file. These are incomplete transfers, not usable user attachments. Normal retry restores the original full attachment through the existing verified transfer flow.

## Weekly Linux unit

`ops/linux/codex-web-maintenance.service` and `.timer` use the same private `backup.env` as backups. They run the pinned Hub image with no network, a read-only root filesystem and bounded memory/CPU. The supplied unit assumes the configured database and results live under the runtime's `data` directory. Adapt paths only when the deployment layout differs.

Install both units into `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, then `systemctl --user enable --now codex-web-maintenance.timer` after publishing the matching Hub image. It runs weekly; skipped busy runs leave data intact for the next run. Check its journal and the normal doctor report. Restore uses the existing verified backup/restore workflow in [Maintenance](MAINTENANCE.md).
