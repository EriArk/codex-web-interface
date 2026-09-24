# Managed participant checkout synchronization

Stage 24 September 2026, issue #198. Existing create/connect-copy flow is retained. A participant opens Git → Delivery → Working copy; only that participant's own bound project is inspected. Catalog reads never fetch Git or mutate GitHub.

## Provenance and authority

The private account database persists `checkout_provenance`: Space/logical project, project owner, participant, exact repository, authorized machine/config binding, root, original observed branch/HEAD, Git directory/common directory, verified numeric GitHub account/repository, and upstream ref/SHA. Existing copies are adopted at their first successful observation; this is explicitly an observed baseline, not a reconstructed clone date. Switching a worktree, repository identity or GitHub account fails closed. Scope changes invalidate prepared actions. No private owner checkout path is read.

The authoritative ref is the repository's current default branch from GitHub, resolved through origin to an exact SHA. An open Delivery panel checks at most once per minute while visible and idle; explicit refresh is also available. Checks fetch missing objects only, with no FETCH_HEAD, tracking-ref, index or working-file change. Previous cards remain mounted. Owner availability and current membership/grant are checked before and after reads and before dispatch. Revocation disables new sync and review actions without deleting local files. Already dispatched receipts can still be inspected through their exact private machine binding to recover an uncertain result; status never replays.

## Update and reconciliation

Clean behind copies offer an explicitly reviewed fast-forward. Clean divergence offers an explicitly reviewed merge commit preserving both parents, using Git's merge-tree result and normal fast-forward checkout. Nothing is pushed or merged into GitHub. Dirty work, unfinished Git operations, detached HEAD, unrelated history, unavailable upstream and conflicting merges never enter this mutation path. Ignored files are protected with `--no-overwrite-ignore`; no reset, stash, rebase or force-push is used. Repository-defined external merge drivers are not executed by inspection.

Merge-tree previews show bounded conflict-marked text for up to 20 non-private paths (32 KiB each, 256 KiB total). Binary, oversized and sensitive paths are not exposed as text. “Разобрать в Codex” prepares an exact-observation investigation in the participant's project, requiring the normal separate send confirmation. The task asks for a preservation plan before any resolution edits. This is not an automatic conflict resolver. Existing Git/file tools and the confirmed delivery/PR workflow remain the means to implement and propose a resolution.

The durable delivery operation records exact local fingerprint, upstream SHA/ref, GitHub numeric identities and scope before apply. Apply rechecks them and takes the existing execution/delivery admission and machine receipt lock. Recovery identifies the recorded resulting commit and never repeats an uncertain merge. Git retains its own worktree/index/ref guards; unsynchronized manual external Git operations are not automatically undone.

## Remaining #198 scope

Optional isolated test-service provisioning/bindings and service lifecycle remain a separate future stage. This release does not create services or reuse the owner's production services. Do not mark the entire issue closed on the basis of checkout sync alone.

## Verification

Focused tests cover exact upstream detection, fast-forward, two-parent merge, conflicts without worktree writes, dirty/ignored-file protection, stale remote/local state, private receipt recovery, linked worktrees, revoked scopes, numeric identity changes, forged personal scope and deferred Codex submission. Browser checks cover explicit confirmation, conflict inspection, preserved drafts, phone/keyboard-height/tablet layout and four themes. Physical-device acceptance remains pending.
