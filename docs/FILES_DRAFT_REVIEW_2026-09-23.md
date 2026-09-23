# Writable Files draft review — 2026-09-23

Follow-up: the owner confirmed the next implementation session. [Writable Files implementation](FILE_EDITOR.md) records the fixes, verification and explicit limits. The unpublished-state statements below describe the original reviewed draft.

Scope: the unfinished local implementation of [#169](https://github.com/EriArk/codex-web-interface/issues/169), reviewed during the owner-approved first planning session. This is a review of unpublished work, not a release claim. No real project files or user sessions were changed by the reproduction checks.

## Existing implementation

- Lazy CodeMirror editor with syntax highlighting, search, undo/redo, explicit save, local drafts and conflict UI.
- Typed Hub routes, project/machine resolution and existing writable/delivery guards. The delivery guard checks active/unknown Hub project work; do not replace it with a second lock framework.
- Local Linux / existing SSH-to-Windows helper; UTF-8 and size checks, root/link/secret-path checks, file fingerprints, sibling staging and machine-local operation receipts.
- File/folder creation, copying, moving and confirmed deletion UI.

Keep these useful parts. The draft is larger than a text editor alone because it also enables destructive file management.

## Reproduced blockers

Six focused checks ran on Linux Node 24 against the exact unpublished `fileToolsProbe.ts`, using disposable roots and an isolated receipt home inside a temporary directory. The fixture restores patched functions and removes its own temporary files. These are review probes, not a passing release regression suite.

| Check | Observed result | Required fix |
| --- | --- | --- |
| UTF-8 save with BOM and CRLF | Passed; expected bytes preserved through helper save | Retain coverage through the actual editor, not just the helper |
| External file change after read | Passed; `FILE_CHANGED`, external bytes retained | Retain canonical baseline checks |
| Same request after completed deletion | Failed with `ENOENT` despite completed receipt | Validate receipt identity before requiring the removed source to exist; reauthorize the scope on every read |
| Same request after completed move | Failed with `ENOENT` despite completed receipt | Reconcile from the exact durable operation/source/destination identity |
| Save a mode `0664` file under umask `0022` | Result mode became `0644` | Preserve applicable mode explicitly rather than passing it only to `open` |
| Destination appears after move precheck | Linux rename replaced the new destination with source bytes | No-clobber publication and postcondition/recovery handling; precheck alone is insufficient |

The move race was injected immediately before the real `fs.rename` by creating another fixture file at its destination. It demonstrates a deterministic no-overwrite violation in local Linux; it is not evidence of a live incident or a Windows reproduction.

## Additional review findings

1. **Write lock/capability is missing.** `ProjectFiles` replaces “read-only” with direct mutation buttons. `FileManagerActions` has no unlock state and the routes expose no prepared capability tied to the selected checkout. Implement the AGENTS.md explicit lock behavior, including relock on close/project change, and server-authorized writes.
2. **File-manager operation IDs live only in a component ref.** Unlike editor drafts, reload loses the pending operation identity. Preserve/reconcile the exact pending mutation across close/reload; an uncertain mutation must not become a fresh operation merely because the modal reopened.
3. **Stale UI completions need protection.** `FileManagerActions` invokes callbacks after async mutations without a mounted/scope check. Audit project/window switches and delayed replies, keep drafts bound to the exact checkout, and prevent a late response from opening/selecting a file in another scope.
4. **Destructive-operation concurrency needs focused coverage.** Fingerprinting and later rename/delete are separated by asynchronous work; only save performs an additional fingerprint check near publication. Cover source changes, link/reparse replacement, target collisions and partial copies. Do not claim checks alone form a filesystem transaction with external editors.
5. **Bounds and transport recovery need verification.** Tree fingerprinting limits entry count but not total bytes/time; local work lacks the SSH timeout wrapper. Bound work and preserve recoverable receipts when the response or connection is lost. Validate Windows names, mode behavior, link handling and process teardown through disposable fixtures.
6. **Editor edge cases remain unverified.** Mixed line endings, close/project switch with unsaved changes, quota-full draft persistence, restore during uncertain save, and conflict resolution need real browser tests. UTF-8 helper success is insufficient to claim byte-preserving editor behavior.

No dedicated editor/file-mutation tests are present in the draft. Existing inspector tests concern the prior read-only surface.

## Next implementation session

Recommended selector: **Высокое (`high`)** because this stage changes filesystem mutation, permissions and recovery. Wait for the owner's confirmation before starting.

1. Finish exact target/capability/unlock behavior and durable mutation identity, retaining existing project guards.
2. Fix receipt reconciliation, no-clobber operations and mode preservation; add regression tests for the reproduced failures and bounded concurrency cases.
3. Complete editor/navigation/draft behavior and focused Chromium/WebKit phone/tablet/theme/keyboard checks. Verify Files/Git refresh without staging or changing chat drafts.
4. Run Linux build/type checks/repository checks and disposable Windows transport checks; package only verified work. Follow coordinated backup/idle deployment and commit/push main. Do not automatically advance to Activity implementation in the same session.

The original draft remains intact for that session; this review changes documentation only. Activity Timeline follows this release, using the sequence in [Roadmap](ROADMAP.md).
