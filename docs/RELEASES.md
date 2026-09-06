# Release history

The default branch contains the implemented product. Feature work starts from main and passes the portable GitHub checks before merging. Tags identify verified source baselines; physical Apple-device acceptance is tracked separately in issue #10.

## v0.1.0 — 2026-09-06

- Deployed source: b269368 (tag v0.1.0).
- Hub image: codex-web-hub:b269368.
- Image digest: sha256:cacbd2114b43d0a3a5e9e2c918972c6f71f5d310c82b5c5db2f60065a856b4e6.
- Known prior image/source: codex-web-hub:5adedf4.
- The full implementation landed through PR #1; main also includes portable CI from 642bacd.
- The CI-only change does not alter the deployed application files. This tag points to the exact deployed application source.
- Native send/answer-choice, same-thread writer handoff, browser workflows and PWA refresh were verified. Physical iOS acceptance remains open.

## Storage and operations — 2026-09-06

- Deployed source/image: fa1c008 / codex-web-hub:fa1c008 (PR #16, merged into main).
- Image digest: sha256:1d447cf4d25a98f6a94778487e1061052c14263e8cab14e3f315b667e1096ee8.
- Schema version 2; original owner login retained. Protected pre-upgrade snapshot and a schema-1-to-2 restore rehearsal succeeded.
- Daily private snapshots are enabled and their first run against the deployed image passed. Doctor passed inside the actual container.

## Live activity and unread completions

- Schema version 3 records completion/seen event cursors and a stable task-start ordering key. Existing historical work starts read.
- Backup jobs must use the new application image before the schema upgrade; a schema-2 backup tool refuses a schema-3 source. Keep the previous image and pre-upgrade database snapshot for rollback.
- Projects count active/unread projects; Dialogs counts active/unread standalone chats. Individual project lists count each chat once even if several turns completed while away.

Record the source revision, image digest, schema version and pre-upgrade snapshot for each deployment. Reverting application code is not a database downgrade: use a compatible schema or restore the pre-upgrade snapshot into a separate target first.
