# Result downloads and standalone return — 2026-09-24

The directDownload branch bypassed prepared-file system sharing and navigated
to an authenticated attachment. The owner observed iOS standalone presenting a
native file screen without a return control.

Where Web Share and canShare exist, direct result downloads now prepare the
original private file in a compact themed modal. A fresh explicit tap invokes
file sharing, preserving user activation after slow preparation. Cancel is quiet;
errors remain retryable; Close is always present, including loading/failed fetch.
No automatic share occurs. Closing cancels preparation and invalidates stale
share callbacks. Results category, focus, scroll and composer stay mounted.

The common component also covers shared result cards and archive save actions.
File viewing remains separate. Browsers without file-sharing APIs retain direct
downloads. The existing 32 MiB preparation memory budget is unchanged: unsupported
or large files offer explicit browser download; the app cannot add controls to
the browser's native screen. No Hub, authorization or installed helper changes.

Checks: real Codex Results cards in Chromium/WebKit, original filename/MIME/bytes,
fresh share activation, cancel/error/retry/slow close, source focus/feed scroll/
draft preservation, fallback anchor contract; four themes at phone, keyboard and
wide sizes. Mocked sharing does not reproduce the native iOS sheet; physical
hardware acceptance remains pending.
