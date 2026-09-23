# Writable Files and text editor

## User flow

Files and Git open locked. **Разблокировать файлы** obtains a short-lived grant for the current login session, personal Project, machine and checkout. Existing project activity/handoff guards apply when unlocking and on each mutation. Closing the window or changing Project releases the grant; reloading starts locked. This controls CodexWeb file actions, not arbitrary commands in the user's own terminal.

Supported text files expose **Редактировать** after unlocking. Git explicitly edits the working file, including when viewing a staged diff. CodeMirror loads lazily and provides highlighting, line numbers, search, undo/redo, wrapping and Ctrl/Cmd+S. Save refreshes Files/Git without staging, committing or disturbing the chat draft. Dirty close offers saving, discarding, continuing or retaining the local draft.

Files additionally supports creating files/folders, renaming, copying, moving and deleting a named target after confirmation. A pending operation survives reload in account-local storage, bound to the checkout; **Проверить файловую операцию** uses the original identity. It does not create a new operation automatically after a lost acknowledgement.

## Write boundary and recovery

- Authenticated typed Hub routes resolve the personal Project/machine; callers cannot supply absolute roots or shell commands. The existing SSH/Node path supports Windows, with no new listener. Local Linux uses the same helper.
- Grants bind session and exact checkout, expire after 30 minutes, and never bypass current project/machine authorization or active/unknown work guards. They are held only in memory; restart relocks writes.
- Canonical paths reject traversal, links, Windows device/stream names and private credential paths. Baseline fingerprints reject detected external changes. Text reads are bounded and complete, with explicit UTF-8 validation.
- Save stages complete bytes in a sibling, preserves applicable permissions and atomically replaces the working file after a fresh baseline check. BOM and uniform LF/CRLF/CR endings are retained. Mixed endings are refused for writable editing to avoid silent normalization.
- Copy/move exclusively creates destination entries instead of renaming over an existing path. Directory moves are copy/verify/remove operations, not atomic directory renames. Source capture is checked again before recursive removal. Detected capture conflicts preserve recovery bytes in a `.codexweb-file-*` sibling instead of erasing them.
- Machine-local receipts bind exact request IDs and fingerprints. Completed move/delete receipts remain available after the source disappears. An interrupted save can reconcile exact saved text/BOM. Other incomplete/ambiguous effects remain unknown; partial copies are not blindly repeated or removed. Transport failures retain the original client operation.

For local Linux execution, receipts live beside the personal runtime database on its persistent volume, not in the disposable engine container home. Windows receipts remain on the execution machine in the user's private `.codex-web/file-operations` directory.

Filesystem checks cannot form a transaction with arbitrary external editors/processes. The normal Hub work guard prevents competing known Codex operations; fingerprint checks detect observed external changes. In particular, atomic replacement is not an OS-level compare-and-swap against an unrelated process writing in the final check/replace interval. Do not claim universal race-free filesystem access. Partial/unknown operations may require inspecting the actual files and the retained private receipt/recovery bytes.

## Bounds

Text editing: 2 MiB of UTF-8 content; no binary or unsupported encoding. Tree operations/fingerprints: at most 10,000 entries and 128 MiB per scan, with a 60-second traversal deadline. SSH response/time bounds remain in place. These editor limits do not reduce existing downloadable Result limits. Local drafts depend on available browser storage; storage errors retain mounted text and are surfaced before it can be silently discarded.

## Verification (2026-09-23)

- Linux TypeScript and production web build.
- Focused file-helper/Hub checks: exact bytes/mode, stale baselines, move/delete receipts, exclusive destination races, directory operations, unsafe paths, binary/size rejection, interrupted save reconciliation, changed source capture and session/root/relock/active-work boundaries.
- Existing inspector and Git Delivery regression tests retained.
- Chromium and WebKit with a real disposable Hub: edit/save/diff, conflict/draft retention, lost save acknowledgement/reload, lost delete acknowledgement/reload with the same operation ID, relock, file creation/deletion, chat draft continuity and four-theme phone/tablet layouts including a constrained-height viewport. Screenshots inspected; physical iPhone/iPad acceptance remains ordinary owner usage.
- Actual existing Hub → system SSH → Windows Node transport exercised only in a disposable project-local fixture: create/read/save/move/delete and completed receipt recovery. No desktop restart or live source-file mutation.

This feature completes the implementation session following the [draft review](FILES_DRAFT_REVIEW_2026-09-23.md). Installation status is tracked separately by the normal guarded updater and its checkpoint receipts.
