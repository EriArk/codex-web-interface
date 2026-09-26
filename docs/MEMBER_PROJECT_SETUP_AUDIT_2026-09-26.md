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

## Offline diagnostic package follow-up

After the reported reboot, Hub SSH still timed out and the enrolled Tailscale
peer retained the same offline last-seen timestamp. A recipient-run package was
prepared instead of changing the enrollment or trusting an unpinned address.

`ops/windows/Test-CodexWebConnection.ps1` reads an adjacent
`diagnostic-target.json` containing only the approved Hub IPv4, Windows SID and
machine GUID (never repository credentials, pairing tokens or private keys).
The personalized package is generated into the ignored export cache, not Git.
It writes a text summary and a JSON technical report on the recipient's desktop;
there is no automatic upload. Full Tailscale JSON, auth URLs, credentials and
raw subprocess stderr are excluded.

`Start-ConnectionDiagnostic.ps1 -RepairExistingServices` offers interactive
Windows elevation and only starts stopped, already installed Tailscale/sshd
services on the exact bound Windows user and PC. Running services and scheduled
tasks are untouched. Before starting sshd it verifies that Windows Firewall is
enabled and the existing explicit service boundary excludes all sources other
than the approved Hub. Missing/disabled components, wrong network/login,
unverifiable boundaries and different Windows identity remain findings for
manual follow-up; no new enrollment, key replacement, firewall opening or
startup-policy change is performed.

Windows PowerShell 5.1 syntax checks and `tests/member-connection-diagnostic.ps1`
pass with synthetic services/firewall/Tailscale/tasks: no access mutation on a
wrong identity or without elevation, no restart of running services, no SSH
start without the exact private boundary, and no sensitive report fields. The
personalized ZIP is verified by extraction/CRC and includes file hashes.
Actual execution on the recipient's PC and restored incoming SSH remain pending.
