# Member project setup audit — 26 September 2026

Scope: the reported neflores failure at New Project → GitHub, and the member's independent shared-project workflow.

## Live observations

- Member account is active with an approved Windows enrollment and an existing catalog project.
- The member's private Hub database has no project setup operation for the reported attempt. The displayed “operation saved” text is not evidence that creation began: the repository-list request used the same generic error as an uncertain write.
- Hub SSH to the approved PC times out. Tailscale reports the PC offline, last seen 25 September 2026 at 10:31:08 UTC. The owner believes the PC was switched off.
- This establishes present unavailability, **not the original screenshot's root cause**. Current container logs contain no matching setup requests; replacement containers do not retain the original request trace.
- No live creation, clone, GitHub invitation, credential change or member reset was performed. Pending enrollments were retained.

## Confirmed defects fixed

1. Connect GitHub treated a pasted repository URL as a general search query. HTTPS URLs, SSH clone addresses and owner/repository now select an exact repository locally; the existing read-only review verifies access and the destination through the selected PC before creation is authorized.
2. Loading the GitHub catalog implicitly combined the account login with the project name, enabling review without selecting a repository. Connection now requires an explicit selection. Create mode still uses the PC's authenticated account.
3. Old repository reads could outlive search edits or dialog closure. Requests are cancelled and generation-checked, so stale results cannot replace the explicit selection. Draft and parent conversation are preserved.
4. Pre-creation read failures no longer claim an operation has been saved. Uncertain apply operations retain their durable receipt and existing reconciliation flow.
5. Review uses the inspected remote's actual visibility for connected repositories, rather than the creation form's default.

These fixes are in the Hub/browser. Windows setup probe/worker and wire contracts are unchanged; they do not require replacing a running member helper.

## Verification

- 33 focused Node tests: project setup/probe, Hub receipts and recovery, Space grants/acceptance, checkout synchronization, per-user GitHub boundaries, guide content.
- Chromium and WebKit: offline catalog/review, exact URL/SSH/shorthand selection, explicit selection requirement, no background creation, close/reopen draft, stale response isolation and inspected visibility.
- Chromium and WebKit member bootstrap: a member without projects confirms their own numeric GitHub identity, receives and accepts Write internally, creates their own exact checkout and restores its scoped draft. Existing receipt and revocation tests verify recovery without duplicate writes.
- Phone, tablet and desktop screenshots across all four themes; long project titles and reachable close controls. Browser automation uses isolated temporary accounts, Git repositories and simulated native/GitHub services. It is not acceptance on the member's physical Windows PC.
- TypeScript backend/web checks and production web build pass. Release build and exact-image admission evidence are retained with the staged deployment.

## Resume when the PC is online

1. Read-only Hub → approved member SSH: verify pinned machine/user binding, installed setup worker/probe/runner hashes, configured Node executable and Scheduled Task last result.
2. Verify the actual installed task can list repositories and inspect the exact requested repository using the member's own GitHub account. Inspect machine receipts before taking any action; no uncertain operation replay.
3. If a helper fault is found, repair/update the exact idle installation with a backup and hash verification. Do not replace the owner's helper as a proxy for testing this PC.
4. Confirm the real member can complete project review/creation, sharing, participant Write acceptance and their independent working copy. Physical-device acceptance remains pending.

Private machine IDs, transport configuration and account metadata are retained only in the ignored audit cache, not this document.
