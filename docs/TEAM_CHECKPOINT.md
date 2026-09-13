# Checkpoint at the end of the long team pass — 2026-09-13

The owner asked to finish this pass and continue in short sessions. Code is on `feat/team-workspaces`; checked stages are committed and pushed. This document is the restart point, not a claim that every team acceptance gate is complete.

## First window pass installed — 2026-09-13

Web-only revision `ac39079` is installed at the standard public address. `/version.json` and the HTML release stamp both confirm `78e4a0d081a08b28c041fac3096e01c21cdd14c25f76bb4355a55dbcbd44d2c4`. Engine/gateway remain `60b326892`, GPT remains `7f25d37`; container IDs and start times were unchanged across publication. Live read-only Doctor confirmed SSH, Companion, Codex login/capabilities and GPT health before publication, without acquiring a conversation writer.

Installed: a single material/window lifecycle, «Общие» in the same five-button row, independent Tasks/Notes/Plans/Reports windows, direct shared-material windows and matching fields/controls. Tablet/desktop list-and-editor layouts and compact keyboard behavior are verified. Existing drafts, revision/receipt checks and explicit execution remain intact. Eight browser suites passed in Chromium/WebKit; see [verification](VERIFICATION.md).

The previous web release `8791306c355b71179b2014798a9321d66974560201bc1bd8d43b4d43d2121972` is retained, and all 49 manifest files were checksum-verified before publication. Its pointer/manifest and container continuity receipt are stored privately as `backups/web-before-ac39079.json`; the earlier full stable checkpoint is untouched. The `ac39079` image is labelled `web-only` and was used solely as the asset publisher, not installed as an engine.

Next: separate purpose-sized Files/Git windows and project-only Results. The owner additionally wants real file-manager operations behind an explicit read-only lock; this is recorded with #169 and requires #158's already-enabled-Team upgrade/restore path before its engine changes. No cosmetic unlock or writable file API was shipped in this UI pass. Remaining forms outside these modules still need the same material review.

## Installation confirmed at the subsequent audit

Read-only inspection on 2026-09-13 confirmed engine/gateway `60b326892` healthy and Maintenance `installed`; GPT remains `7f25d37` with its original profile. The owner's Team workspace is enabled and new-member registration stays closed. The previous queue observation below is historical, not the current release state. No separate friend-PC/account acceptance is implied.

The owner has now requested an issue/visual audit before continuing. Use [the complete remaining-work map](ISSUE_AUDIT_2026-09-13.md) and the updated [ROADMAP](ROADMAP.md) for the next short passes, including #176/#177, independent workspace windows, separate Files/Git windows and project-only Results. Those new UI changes have not been implemented by this documentation pass.

## Implemented candidate

- Private identities, account-scoped runtime/storage, root restrictions and guided Windows enrollment foundations; isolated GPT provisioning and stopped-profile backup/restore.
- Shared projects, explicit membership and single ownership, per-user checkout/Current, revisioned common materials, assignee-owned Plan execution and selective publication.
- Consented Links, bounded consultations and Bridges with the chosen project's coordinator account.
- Own-machine GitHub operations with reviewed targets and exact receipts; no automatic merge or force push.
- Frozen-period shared Reports with explicit publication, Task → Plan, backlinks and paged personal/author/assignee filters.
- Shared rotation: common Core and common saved state plus only the acting user's previous-chat handoff. Revocation or changed bindings block creation/bootstrap without moving another user's Current.
- Native Plan → Implement (#165); #166 has a documented diagnosis only.

## Release boundary

Owner login preparation: `auth.ownerLogin` is `eriark` for the first team migration. The existing `auth.username`/personal password record remains unchanged. Team initialization copies its current password hash into the original owner's account with that login; an already-created team identity is never renamed by restarting with this option. The reserved login is persisted in the installation configuration for the later team-enabled release.

The original owner must skip member onboarding. Continue the existing machines, native Codex identity/history, original GPT browser profile and machine-local GitHub credentials; do not provision fresh replacements or require reenrollment. New-member wizard #173 must branch on the stable original-owner identity, not merely whether a setup checklist exists.

Stable owner installation at the start of this checkpoint: engine/gateway `379fa17`, GPT `7f25d37`. A protected, checksum-verified stable backup and isolated restore exist; the running original GPT profile is preserved in place.

The owner superseded the team-disabled `99953827f` queue with a request to enable the prepared owner functionality and login now. That installer was stopped while still waiting, before any production change. The replacement uses the guarded **first-owner team activation**, `eriark` plus the old password, preserved current sessions and `registrationEnabled: false`. Shared modules remain available to the owner; registration of a new member is blocked in the backend until the separate admission checks pass.

This activation requires a migration rehearsal, exact-image login/session and rollback checks, and read-only Codex continuity verification. It still waits for active/unknown Codex/GPT work; verified idle shells alone do not block it. Before public admission, failure restores the prior configuration/database/image and preserves the failed registry privately. Already-enabled team upgrades must use coordinated team backups, not this first-owner rollback. The actual installed/pending revision comes from authenticated Maintenance and the deployment receipt, never Git HEAD. The original GPT profile remains in place.

At the end of the previous long pass, release `60b326892` had passed the first-owner checks and all 526 tests and was queued by `codex-web-owner-team-60b326892.service`. The last observation in that pass was **waiting**, with healthy `379fa17` still serving the owner; the guard saw Codex work/unknown state and GPT activity/browser work. The later installation is confirmed above. Evidence is stored privately under `verification-60b326892` on the Hub. Matching Windows GitHub delivery helpers were installed with a local backup, and a read-only worker check confirmed the existing EriArk identity/repository access.

## Remaining functional work at the previous checkpoint

This list preserves the previous checkpoint; the latest ordered passes, including the owner's UI revision, are in ROADMAP and the linked audit above.

1. **Finish new-member admission and subsequent team updates.** Audit all remaining private capability/background-revocation families and coordinated identity/profile restoration/readmission; complete the general team-aware deployment/rollback boundary. Keep stable recovery usable. Gates A/B/E remain open until their recorded checks pass. Owner-only activation does not satisfy those gates.
2. **Complete shared work follow-through.** Explicit accepted-result reconciliation into the exact shared Plan revision, relevant notifications and the remaining draft/checkout picker details. Existing private Plan reconciliation does not yet update a common Plan automatically; do not claim that it does.
3. **Connect the friend.** Configure actual Tailnet admission, install matching helpers, finish the persistent invite-to-ready web guide (#173), then verify real PC/accounts and smaller tablet. Current Windows wizard/provisioning fixtures do not constitute real friend acceptance.
4. **Focused personal defects.** #168 exact generated artifact navigation, #166 native Computer Use lifecycle. Keep #167 engineering viewer and #169 writable editor as separate scoped changes.

## Newly filed work, recorded without extending this pass

Open Issues were checked again at wrap-up. New #170–175 are not implemented by this checkpoint:

- #170: protected per-user server execution sandboxes — separate infrastructure design, no shared shell shortcut.
- #171: usage/reset visibility in the main Settings view.
- #172: quick project GitHub Issue creation from the top bar.
- #173: continuous invite-driven setup, building on existing enrollment/provisioning.
- #174: categorized in-app guide after the feature set stabilizes.
- #175: independent per-user text and interface scaling through shared layout tokens.

GitHub Issues and ROADMAP remain the task source. Do not duplicate this backlog into the owner's personal application Plans. Actual installation and friend/hardware acceptance remain separate from code/test completion.
