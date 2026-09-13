# Native Computer Use in Companion sessions (#166)

Read-only diagnosis, 2026-09-13. No global configuration, native account, owner conversation, desktop process, helper lifecycle or AltarApps file was changed.

## Finding

The missing endpoint is a **per-desktop-process named pipe**, not a missing installation directory. The installed desktop owns its creation and approval/lifecycle integration. CodexWeb's standalone Companion App Server does not create that desktop integration. A fixed pipe address in the explicit `node_repl` environment points to no running pipe owner in the observed session. Changing the runtime executable path or substituting another UUID cannot fix this lifecycle mismatch.

This explains the observed connection failure before listing windows. It does not prove that the account has the native Computer Use feature enabled, or that launching any executable would establish an approved integration.

## Evidence

- Installed package: `OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0`, healthy package path; configured App Server reports `codex-cli 0.153.4`.
- Observed chain: the local `CodexWebCompanion.exe` launches its configured `codex.exe app-server --listen stdio://`. The Electron desktop was not running. Its absence is expected in the owner's independent web-client workflow.
- The configured `node_repl.exe`, Node executable/module directories and trusted paths exist. The “old installation path disappeared” hypothesis was not confirmed.
- The explicit global `node_repl` environment retains application version `26.901.51231` and one concrete `codex-computer-use-<UUID>` pipe. No pipe with that prefix existed at inspection. The version field is stale, but that alone does not account for the missing server.
- Read-only installed `app.asar` inspection (SHA-256 `2bd5b96a48232f3ccf3df6be50965920699ea3a1b4512dcdd770e209fd1f009e`): the desktop main bundle `.vite/build/main-D8abTQQE.js` creates a fresh native pipe path, owns `WindowsHelperTransport`, binds approval/activity to its App Server and disposes the transport with the desktop process. The path is supplied to its `node_repl` environment during desktop bootstrap. Initialization is gated by both native Computer Use feature flags.
- Repository inspection found no writer of `SKY_CUA_NATIVE_PIPE_DIRECTORY`, `BROWSER_USE_CODEX_APP_VERSION` or global `node_repl` overrides. The Companion source launches the configured stdio App Server and does not bootstrap Electron's Computer Use transport. The historical author of the explicit global override is unknown.

## Supported boundary and next use

Use the installed desktop's own session for its native Computer Use integration, subject to that account's feature availability and native permissions. Existing explicit Settings handoff can release web writers and open the same native conversation when the owner chooses. Merely starting the desktop does not establish that a pre-existing Companion session has inherited its fresh pipe or approval bindings.

CodexWeb must not advertise a discovered MCP executable as proof that native desktop control works. Its allowlisted GUI Preview and manual Remote remain separate capabilities. This investigation adds neither a protocol clone nor a manual helper launcher. No successful native `list_windows`/screenshot acceptance is claimed; that requires a future explicit native-desktop session check. ClubManager's earlier SSH resource leak is a separate defect.
