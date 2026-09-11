# Project Delivery

Delivery is a compact Codex project surface opened from Files/Git, Project Overview or a saved Review. It uses the configured directory and machine. Merely opening it does not acquire a Codex writer. GPT keeps its native workflow; this module does not pretend that a GPT project is a local Git repository.

The owner selects changed files and writes a commit message, then reviews the branch, HEAD, paths and message before confirming. Push and PR creation are separate reviewed operations. Read state shows index/working/untracked counts, upstream and cached ahead/behind, normalized GitHub identity, matching PR and bounded checks for their exact pushed SHA. Refresh is explicit; only a running operation has a slow status poll.

## Commit semantics

A checkpoint commits the **working file contents** of the selected paths. A private Git index starts from HEAD; a second private index preserves every unrelated staged path. The operation hashes selected bytes, records modes and the existing real index, creates the exact tree and a normal commit object, then moves only the reviewed branch through `update-ref` compare-and-swap. It atomically updates selected real-index entries while retaining unrelated staging. Local working files are never replaced.

This narrow checkpoint uses Git plumbing, so local commit hooks do not run. Configured `commit.gpgsign` is honored; signing failure stops the operation. The UI states these semantics in a compact disclosure. There is no dummy commit, automatic reset/clean/rebase, branch creation, merge or release. Detached HEAD, parent/submodule boundaries, unmerged state, symlinks and credential paths are refused. Limits: 200 selected files, 8 MiB per file, 32 MiB total snapshot and 16 MiB index. Unavailable files remain on disk and are counted in the UI.

Known active/unknown Codex work in the same directory prevents Delivery mutation. During execution, new Hub sends into that directory are blocked with their draft preserved until the Git operation finishes. A changed branch/index/file/config invalidates the prepared operation. External desktop/terminal edits remain possible; Git locks, compare-and-swap and postcondition checks protect the boundary, and unresolved concurrency remains visible as unknown.

## Push, PR and CI

Only one matching fetch/push `origin` on github.com is accepted. Normal push uses the reviewed commit and explicit branch ref, without force, auto-pull, tags or submodule pushes. A changed remote stops preparation/apply. Rejection is a visible failure; an ambiguous transport failure is unknown and is checked without replay.

PR creation uses the repository's verified default branch and the current pushed head. Existing matching open PRs are opened instead of duplicated. A lost acknowledgement requires exact repository/head/base/SHA/title/body evidence before completion. No generic GitHub endpoint or caller command reaches the worker.

Checks show their exact SHA, names, state, links and observation time. Unavailable checks do not masquerade as success and do not erase an otherwise verified repository/PR. Failed CI can prepare a normal Current Chat action with immutable repository/branch/SHA/PR and failed-check metadata. It needs the normal explicit submission, permissions and ownership flow. Red CI never starts a repair loop. Completed earlier actions are reconciled before deciding whether a new action is a duplicate.

## Storage and recovery

Schema 24 adds durable `delivery_operations` and bounded transient `delivery_observations` (20 per project). Hub operations bind to the exact project directory and machine configuration. They persist prepared/running/completed/failed/unknown states and immutable inputs. Restart turns pending Hub operations into unknown. Worker receipts retain the operation ID and fingerprint, candidate commit/tree and before/after index hashes. Reconciliation may finish an interrupted index update for that same commit; it never blindly repeats commit, push or PR creation.

Terminal receipts remain private; completed/failed private index sidecars are removed. Unknown sidecars remain for recovery. A maximum of 10,000 Hub operation identities prevents unbounded operation creation without deleting history. Reports include bounded delivery metadata and Review backlinks; Review retains Plan and source-turn links.

Windows uses the separate fixed interactive Scheduled Task `CodexWebDelivery`, installed with `ops/windows/Install-Delivery.ps1` and Linux-built `deliveryProbe.js`. It runs under the owner's logged-in account with a stable Node executable. Requests/receipts live under private `%LOCALAPPDATA%/CodexWeb/delivery*` ACLs. Existing SSH carries only typed inspect/prepare/apply/status requests. There is no network listener, credential copy or desktop process control. Local Linux calls the same probe directly.

Verification uses isolated real Git repositories/worktrees plus simulated GitHub boundaries, authenticated Hub fixtures, and Chromium/WebKit phone/tablet scenarios. Owner repositories and active desktop work are not mutated during tests. Physical iPhone/iPad behavior remains the owner's usage check.
