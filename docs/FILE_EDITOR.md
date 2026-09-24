# Writable Files and text editor

## User flow

Files and Git open locked. **Разблокировать файлы** obtains a short-lived grant for the current login session, personal Project, machine and checkout. Owner update, 24 September: manual writes and uploads remain available while native Codex work runs. Unlock verifies the checkout without acquiring the native/Git idle guard; manual mutations serialize only with other manual writes to the same machine/checkout. Authentication and execution authority still apply. Closing the window or changing Project releases the grant; reloading starts locked. This controls CodexWeb file actions, not arbitrary commands in the user's own terminal.

Supported text files expose **Разблокировать и редактировать** while locked, and **Редактировать** after unlocking. Git explicitly edits the working file, including when viewing a staged diff. CodeMirror loads lazily and provides highlighting, line numbers, search, undo/redo, wrapping and Ctrl/Cmd+S. Save refreshes Files/Git without staging, committing or disturbing the chat draft. Dirty close offers saving, discarding, continuing or retaining the local draft.

The universal viewer exposes editing for supported text from every entry point. An exact working-copy URL obtains its own grant when needed. The editor opens above the mounted viewer; successful saving refreshes its bytes, and closing returns to the same file. The Git index viewer, saved Results, uploads and shared publications do not silently acquire a writable working-copy identity. Git's separate, explicitly named working-file edit action remains available.

**Предпросмотр** opens a frozen snapshot of the current editor draft in the common file workspace without writing the project. Markdown renders as a document, HTML uses the existing isolated private sandbox, SVG uses the static sanitizer, and other supported sources remain text. **К редактору** and Escape return to the mounted editor with its undo history and draft intact. **Скачать черновик** exports its exact UTF-8 bytes, including retained BOM/line endings, independently of saving the project. The toolbar groups save/preview and text controls in explicit rows; editor dialogs are centered on the available viewport independently of parent windows.

Files additionally supports creating files/folders, renaming, copying, moving and deleting a named target after confirmation. A pending operation survives reload in account-local storage, bound to the checkout; **Проверить файловую операцию** uses the original identity. It does not create a new operation automatically after a lost acknowledgement.

## Write boundary and recovery

### Multiple selection and batch actions

After unlocking Files, **Выбрать несколько** exposes touch checkboxes. Up to 100 entries can be selected across folders, sorting, filters and pages; **Выбрать на странице** adds only loaded entries. The filename still opens its file/folder. Relocking, closing Files, or changing Project clears this transient selection. Selecting a folder includes its contents; selected descendants are excluded from the execution list to avoid acting twice.

**Копировать** and **Вырезать** capture current source fingerprints, then **Вставить сюда** opens a review for the current destination folder. **Удалить** opens a source list and requires **Подтвердить удаление**, including folder contents. The queue executes authenticated file operations sequentially, reports each result, and refreshes the list without losing the conversation. Conflicts offer another name, skipping, or **Заменить выбранную версию** when both entries are files. Replacement binds the exact inspected destination fingerprint; any detected change requires a new choice. The complete source is staged and verified before replacement, and a moved source is removed only after verification. Copying to the source's own name requires another name. Folder merging/replacement is not supported.

Before each request, account-local storage records its exact ID, source fingerprint and destination. A transport/unknown result stops the queue; after reopening or reload, **Проверить результат** uses that same operation identity, including moves whose source has disappeared. Successful entries are not rerun. Definitive conflicts remain individually actionable; changed sources require a new selection and review. **Остановить после текущего** and closing the review stop before the next entry; an already sent filesystem operation is not interrupted. Cancelling remaining entries cannot erase an unresolved pending receipt. Failure to persist recovery metadata blocks the write. Batches are not filesystem transactions: completed entries remain completed if a later one fails or is cancelled.

The initial batch selection pass was web-only. Exact replacement extends the Hub/inline probe contract and ships with the complete file-workflow engine release. Hub grants, per-project work guards, machine-local receipts, path rules and tree limits remain in force. The updated probe runs through configured Windows Node over existing SSH on each request; no permanently installed Companion or GitHub helper change is required.

### Download selected files as ZIP

**Скачать ZIP** opens a themed review of the selected files/folders. The archive retains project-relative paths, binary bytes and empty folders; a selected folder covers its selected descendants. Preparation checks the same private-path, symlink and Windows-name boundaries as the file manager and detects observed file changes during capture. ZIP uses store mode (packaging without compression) with at most 100 selected roots, 2000 captured entries and 32 MiB of source bytes. It never modifies project files.

The account-local recovery record contains only the exact archive ID and selected paths. After a lost acknowledgement or reload, **Подготовить / проверить** reuses that ID; a completed archive returns its original snapshot even if source files subsequently change. **Скачать ZIP** then uses an authenticated private download. Closing retains recovery metadata. Cancelling/discarding removes only the prepared archive, not source files. An interrupted incomplete capture may be retried explicitly because it is read-only.

Hub storage is private per account, with one active build per account/two per process and a cache of at most four archives, expiring after 30 minutes with lazy eviction on preparation. ZIP size is also capped at 40 MiB. Every status/download/cancel checks current account/project/machine access and checkout identity; a copied URL grants no authority. There are no native sends, browser-stored binary files or external download services. As with filesystem writes below, capture is not an OS transaction against arbitrary concurrent external writers.

### Uploads from the device

Unlocked Files exposes **Загрузить файлы** for the selected folder. The queue holds up to 32 files, retains individual destination folders, and sends files sequentially in 4 MiB chunks. Binary and empty files are supported. Names can be changed before starting. Conflict choices are **Заменить старый**, **Другое имя**, and **Пропустить**; choosing another name preserves both files. Replacement binds the exact inspected old fingerprint and checks it again before committing. A changed destination requires a new choice; folders cannot be replaced by files.

Progress distinguishes browser-to-Hub transfer from final saving on the execution computer. Cancellation discards only partial staging; final commit cannot be cancelled through the dialog. Closing pauses the queue. Reload restores account-local metadata, not file bytes; explicit **Продолжить / проверить** retrieves the original receipt or continues staged bytes. Reselecting an incomplete source validates already-saved chunks byte-for-byte before appending, including same-name/same-size impostors. A lost completion acknowledgement never creates a second operation automatically.

The Hub uses a separate private staging directory/table, with a per-user budget equal to the configured attachment storage limit, at most 64 unfinished transfers, and lazy cleanup after 24 hours of inactivity. This budget is separate from ordinary attachment usage; free disk space is also checked. Existing-file replacement retains the 128 MiB fingerprint scan limit below; larger new files can be uploaded within the configured staging budget. Expired transfer metadata may require a new upload after inspecting its destination. No new public Windows endpoint or permanent helper is installed: final bytes use existing SSH/SFTP, and the updated self-contained file probe runs through configured Windows Node on each request. Uploaded bytes and their complete sibling copy are hash-verified before exclusive creation or approved atomic replacement.

Upload routes require the same session/project/checkout-bound write grant on every request and recheck access around asynchronous transfer. Relocking, revoked access, checkout changes, and active/unknown project work block final saving. Completed receipts and cancellation tombstones remain private to the account. Native chats are never sent or replayed by upload recovery.

- Authenticated typed Hub routes resolve the personal Project/machine; callers cannot supply absolute roots or shell commands. The existing SSH/Node path supports Windows, with no new listener. Local Linux uses the same helper.
- Grants bind session and exact checkout, expire after 30 minutes, and never bypass current project/machine authorization or active/unknown work guards. They are held only in memory; restart relocks writes.
- Canonical paths reject traversal, links, Windows device/stream names and private credential paths. Baseline fingerprints reject detected external changes. Text reads are bounded and complete, with explicit UTF-8 validation.
- Save stages complete bytes in a sibling, preserves applicable permissions and atomically replaces the working file after a fresh baseline check. BOM and uniform LF/CRLF/CR endings are retained. Mixed endings are refused for writable editing to avoid silent normalization.
- Copy/move exclusively creates destination entries unless an exact existing-file replacement was explicitly selected. Directory moves are copy/verify/remove operations, not atomic directory renames. Source capture is checked again before recursive removal. Detected capture conflicts preserve recovery bytes in a `.codexweb-file-*` sibling instead of erasing them.
- Machine-local receipts bind exact request IDs and fingerprints. Completed move/delete receipts remain available after the source disappears. An interrupted save can reconcile exact saved text/BOM. Other incomplete/ambiguous effects remain unknown; partial copies are not blindly repeated or removed. Transport failures retain the original client operation.

For local Linux execution, receipts live beside the personal runtime database on its persistent volume, not in the disposable engine container home. Windows receipts remain on the execution machine in the user's private `.codex-web/file-operations` directory.

Filesystem checks cannot form a transaction with arbitrary external editors/processes. The owner explicitly permits concurrent native and manual work; fingerprint checks detect observed external changes. In particular, atomic replacement is not an OS-level compare-and-swap against an unrelated process writing in the final check/replace interval. Do not claim universal race-free filesystem access. Partial/unknown operations may require inspecting the actual files and the retained private receipt/recovery bytes.

## Bounds

Text editing: 2 MiB of UTF-8 content; no binary or unsupported encoding. Tree operations/fingerprints: at most 10,000 entries and 128 MiB per scan, with a 60-second traversal deadline. SSH response/time bounds remain in place. These editor limits do not reduce existing downloadable Result limits. Local drafts depend on available browser storage; storage errors retain mounted text and are surfaced before it can be silently discarded.

An unresolved save receipt requires close handling even if the user undoes text back to the old baseline. Save-and-close waits for confirmed receipt reconciliation and a matching current draft. Closing with a local draft is refused if browser storage fails. Restored drafts retain their original line endings even when the disk version changed; explicitly loading the current disk version updates the editor's line separator and BOM baseline together. Definitive failures clear the persisted pending operation, while uncertain writes retain their original identity.

## Verification (2026-09-23)

- Complete file-workflow block: 15 focused archive/upload/file-operation tests and a two-account archive isolation test passed. Chromium/WebKit cover exact replacement, changed-target refusal and ZIP response loss/reload/direct download of immutable bytes, alongside batch recovery. All four themes include phone, constrained phone and tablet archive screenshots. Actual live Hub → SSH → configured Windows Node verified binary/empty-directory capture, copy/move replacement, changed-target rejection and repeated receipts in a disposable fixture. Physical-device acceptance and guarded installation remain separate.
- Batch follow-up: Chromium and WebKit against disposable Hub/file fixtures verify cross-folder selection, parent/child deduplication, copy collisions, same-folder duplication, lost move acknowledgement and exact-ID recovery after reload, confirmed deletion, changed-source refusal, cancellation, stop-after-current and browser storage failure before writing. Long project names and selection/review controls are checked in all four themes at phone, constrained phone and tablet widths; screenshots inspected. No backend/Windows helper changes; physical-device acceptance remains pending.
- Upload follow-up: 16 focused upload/chunk/file-operation tests and 8 selected Team isolation checks passed. Chromium and WebKit exercise multi-file/empty/binary uploads, replace/rename/skip, changed replacement baselines, final acknowledgement loss across reload, interrupted chunk recovery and wrong-source rejection, cancellation, system picker cancellation, preserved chat drafts and all four themes with long titles and constrained phone height. Real Hub → SSH/SFTP → Windows tests verified binary/empty files, exact replacement and repeated receipt reads in a disposable fixture. Production packaging and guarded installation are tracked separately.
- Linux TypeScript and production web build.
- Focused file-helper/Hub checks: exact bytes/mode, stale baselines, move/delete receipts, exclusive destination races, directory operations, unsafe paths, binary/size rejection, interrupted save reconciliation, changed source capture and session/root/relock/active-work boundaries.
- Existing inspector and Git Delivery regression tests retained.
- Chromium and WebKit with a real disposable Hub: edit/save/diff, conflict/draft retention, lost save acknowledgement/reload, lost delete acknowledgement/reload with the same operation ID, relock, file creation/deletion, chat draft continuity and four-theme phone/tablet layouts including a constrained-height viewport. Screenshots inspected; physical iPhone/iPad acceptance remains ordinary owner usage.
- Follow-up in both engines: viewer → editor → frozen draft preview → editor → save → refreshed original viewer; Escape closes only the top window. Exact draft downloads, rendered Markdown, sandboxed HTML without saving, full browser-storage refusal, pending-close protection, restored CRLF versus externally changed LF/BOM and explicit disk-version reload passed. Four-theme centered phone/tablet screenshots and existing Results preview/download regressions passed. This follow-up changes only web assets; no Windows helper or engine contract changes.
- Actual existing Hub → system SSH → Windows Node transport exercised only in a disposable project-local fixture: create/read/save/move/delete and completed receipt recovery. No desktop restart or live source-file mutation.

This feature completes the implementation session following the [draft review](FILES_DRAFT_REVIEW_2026-09-23.md). Installation status is tracked separately by the normal guarded updater and its checkpoint receipts.


## Universal editing and direct GitHub files (24 September)

Results, uploads and immutable shared publications open complete UTF-8 bytes in
CodeMirror as an editable copy (up to 2 MiB), never just the viewer excerpt.
Save As offers an exact-byte download or an explicitly chosen project/folder.
Project saving reuses the ordinary chunk upload, receipt and replace/rename/skip
collision flow. The source artifact stays unchanged. Working-copy URLs preserve
the exact project and path; successful saves refresh the mounted viewer.

Git → Files GitHub reads a selected branch and immutable HEAD through the
installed Windows GitHub worker. Supported UTF-8 files up to 96 KiB open in the
same editor. A separate review shows the diff, branch, filename and commit title;
preparation checks repository/account, old file SHA and branch HEAD. The explicit
commit uses expectedHeadOid; protected-branch policy is honored by GitHub.
Manual edits may target policy files and the default branch. Existing automated
project-preparation restrictions remain separate and unchanged.

Per-account SQLite `repository_file_operations` records intent before dispatch
and retains machine receipts. Unknown outcomes block only a fresh operation for
that project and are checked by status; repeated confirmation never replays a
commit. Active/unknown writes also participate in deployment admission. Local
checkout files are not changed by the remote commit. Private recovery drafts are
account-local and retain exact repository/identity/branch/source context.

Verification: focused Hub/file/upload/GitHub worker tests cover active Codex,
identity changes, stale branch/file versions, path checks, lost acknowledgements
and single-commit reconciliation. Browser acceptance and installed worker checks
are recorded in the release evidence; physical-device acceptance remains pending.
