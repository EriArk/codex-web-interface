# Storage and retention

The Hub keeps full conversation messages, result references, public progress, idempotency receipts and sent attachments. Maintenance never removes source repositories, native conversation files, the ChatGPT browser profile, or Windows staging that native history may still reference.

## Limits and visibility

Settings → Storage and the authenticated `GET /api/storage` report Hub database/WAL, images, uploads and cached previews. Windows staging is an estimate from sent attachment metadata, not a disk scan. The GPT connection reports indexed bridge file totals separately; an incomplete inventory is flagged.

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

Only these objects are eligible after 30 days:
- Intermediate assistant deltas with a later complete item that still exactly matches the durable message and belongs to a terminal turn.
- Recognized Hub image/upload/preview filenames that have no durable reference. Job-owned GPT uploads remain protected even if their upload metadata is missing.

Full messages, completion events, user messages, Results, public progress and idempotency receipts remain unchanged. Existing cleanup of unsent Codex upload drafts is unchanged.

## Weekly Linux unit

`ops/linux/codex-web-maintenance.service` and `.timer` use the same private `backup.env` as backups. They run the pinned Hub image with no network, a read-only root filesystem and bounded memory/CPU. The supplied unit assumes the configured database and results live under the runtime's `data` directory. Adapt paths only when the deployment layout differs.

Install both units into `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, then `systemctl --user enable --now codex-web-maintenance.timer` after publishing the matching Hub image. It runs weekly; skipped busy runs leave data intact for the next run. Check its journal and the normal doctor report. Restore uses the existing verified backup/restore workflow in [Maintenance](MAINTENANCE.md).
