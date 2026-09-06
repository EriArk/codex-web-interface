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

Record the source revision, image digest, schema version and pre-upgrade snapshot for each deployment. Reverting application code is not a database downgrade: use a compatible schema or restore the pre-upgrade snapshot into a separate target first.
