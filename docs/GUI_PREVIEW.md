# Configured Windows application previews

Project Overview and Files/Git expose **Предпросмотр приложения**. Choose a configured action to launch its application in the logged-in Windows session, wait for its visible window, and save a private image Result. The action's target chat is frozen before launch; changing Current chat or closing the browser does not move the result or repeat the launch. The image opens in the existing Results viewer. Remote remains an independent explicit connection.

Install `ops/windows/Install-GuiPreview.ps1` in the owner's user session with a stable Node executable. The fixed limited-privilege `CodexWebGuiPreview` Scheduled Task and private file mailbox are separate from the Companion, so installation does not restart Codex. The helper opens no network listener. Hub uses existing system SSH and the same authenticated/CSRF-protected API boundary.

The trusted local allowlist is `%LOCALAPPDATA%/CodexWeb/gui-preview/actions.json`. It starts empty, and installation preserves existing entries. Example (adjust the paths to a real built application):

```json
[
  {
    "id": "app",
    "label": "Открыть приложение",
    "projectRoot": "D:/Projects/Example",
    "executable": "D:/Projects/Example/dist/Example.exe",
    "args": [],
    "workingDirectory": "D:/Projects/Example",
    "capture": "window",
    "startupTimeoutSeconds": 20,
    "keepAliveMinutes": 30
  }
]
```

Use an executable/cwd inside the project where practical. A trusted local entry can explicitly approve an installed runtime with fixed arguments for frameworks that require it. The browser supplies only an action ID and an existing project chat identity; it cannot supply paths, arguments, commands or window handles. Windows validates absolute local paths and rejects symlink/reparse traversal before launch. Actions must have unique IDs within their exact project root. No automatic build command is added.

## Ownership and lifetime

An application is created suspended, assigned to a new unnamed Windows Job Object, then resumed. Only visible windows belonging to that job can be captured. No matching by window title, executable name, or arbitrary PID is used. Applications that redirect to an unrelated existing instance are not adopted. Reuse is disabled. Up to two previews can run, with one active instance per project action.

The helper retains its job handle for 1–120 configured minutes (30 by default), allowing interaction through Remote. An explicit confirmed Close action closes only that preview's process tree; unsaved changes in it can be lost. Timeout, early exit, helper exit or loss of its supervising worker closes the job. Closing the website leaves the preview available until its own expiry. Restarting the Hub preserves machine receipts and reconciles pending results without relaunching applications.

This follows the Windows [Job Object lifecycle](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). The child is assigned before it can spawn descendants. No breakaway flags are enabled. Fixed helper processes use the interactive user's existing OS permissions.

## Capture and recovery

Default capture uses [PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow), with a separate five-second deadline because the native call is synchronous. Buffer and window coordinates use the target window's DPI awareness; explicit desktop crops use physical monitor coordinates. Startup waits for stable bounds and rejects blank/oversize buffers. GPU-only/custom-rendered applications may not support PrintWindow: failures are shown, never silently replaced with a desktop screenshot.

Only a locally configured `capture: "desktop-crop"` permits a physical desktop-region capture, labeled **Область рабочего стола** in the action and Result. It can include overlapping windows. Full desktop fallback is not implemented. Images are bounded to 8 MiB, 8192 pixels per side, 32 million pixels; uploaded bytes pass the normal Hub artifact validation.

Schema 25 stores operation identity, project/machine/root binding, exact thread and result linkage. Windows publishes immutable operation receipts before launching. Exact retries read them; uncertain outcomes are checked, never blindly relaunched. Image artifact metadata, Result, operation and event are committed together. Windows deletes transferred PNG staging only after the Hub confirms storage. Saved results follow the ordinary private artifact policy and backups. Operation receipts remain durable with explicit capacity bounds; they are not silently evicted to make an old ID reusable.

## Verification

`tests/gui-preview.test.mjs` covers allowlist input limits, authentication/CSRF, root/thread binding, one launch across lost acknowledgements, one private Result and explicit close. Browser coverage checks background completion, pending request recovery, draft preservation and four themes at phone/tablet widths.

`tests/gui-preview-native.tests.ps1` compiles the helper and checks Windows quoting. Its explicit `-Interactive` mode creates disposable sample windows, verifies distinct captures for two identical titles, ensures closing one leaves the other alive, and covers early exit/startup timeout. It also rejects unpainted DPI borders. This mode never restarts Codex or touches existing owner applications. Physical iPhone/iPad acceptance remains the owner's normal usage check.
