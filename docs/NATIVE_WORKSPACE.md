# Native schedules, Canvas access and extended MCP forms

This personal-installation follow-up is separate from dictation, read-aloud, human reminders and executable project Plans. Two-way voice conversation remains explicitly excluded by the owner.

## Access and behavior

- **Tasks → ChatGPT schedules** opens the native account's schedules. The existing global human reminder list is unchanged. The schedule list and editor occupy separate panes on tablets and one view at a time on phones.
- Existing schedules expose their name, instruction, enabled state, next/previous run, native time zone and exact schedule. Change the name/instruction, select a new daily/weekday/weekly time, pause/resume, or explicitly confirm deletion. Existing complex schedules are preserved unless the owner selects a replacement. Event trigger rules remain editable in the protected native interface; this panel supports their pause/delete controls.
- **Create through GPT** sends one reviewed creation request in a separate native chat using the existing durable send pipeline and selected native model/effort. Its request identity survives closing the panel. Completion of the chat is not presented as proof of task creation: the account's canonical schedule list remains authoritative, and the reply link is available for clarification or a native refusal. Ordinary chat drafts are preserved.
- The GPT header's **Canvas documents** icon reads documents attached to the selected native conversation. It supports text/source copy, bounded version reads and an explicit restore to an earlier version. HTML/code is displayed as inert text, never executed in the host page.
- Direct Canvas editing/creation is **not claimed as implemented**. The current native test chat refused Canvas creation and produced no document. The client assets still expose saved-document reads, diffs and restore. Restore integration is covered by protocol/UI fixtures; there was no real saved Canvas fixture on which to claim a live restore/edit acceptance check. No unrelated Hub note is substituted for a native Canvas.

## Native contracts and failure handling

The account browser's current JavaScript client supplied the fixed automation routes and body shape. Read-only account inspection verified the projection. One disposable native schedule verified actual create, pause, revision rejection, name/instruction/time save and delete. It was scheduled in 2027, never executed and was removed after verification. In this account successful mutations return **201**, and a deleted automation read returns **410**; neither means a failed write. The adapter handles these as success/gone respectively. Permission failures and unavailable reads do not mean absence.

Hub writes are serialized with existing GPT work, model changes, project content and branch operations. Durable receipts use the existing `commands` table under the `gpt-workspace` scope. A revision check precedes dispatch; uncertainty is persisted before the native request. Confirmation reads the canonical object, not an assistant claim or HTTP acknowledgement alone. Restart/lost responses do not replay mutations. Unknown receipts block further GPT writes until verification or explicit owner acknowledgement of a readable current state. The normal maintenance inventory includes this work.

Only authenticated Hub routes expose normalized schedule/document fields and fixed operations. The browser profile, account token, raw account metadata and native response objects stay in the private connector. No public Windows listener, generic RPC proxy, new credential copy or alternative speech engine is introduced.

Official context: [ChatGPT automations](https://learn.chatgpt.com/docs/automations) distinguishes native scheduled work from the CLI/IDE, which do not expose this management UI. Consumer browser endpoints are observed contracts, not a public stable API.

## Extended OpenAI MCP forms

The installed desktop client 26.908.4834.0 and its initialization were inspected locally. The App Server connection advertises `mcpServerOpenaiFormElicitation` plus the observed `openai/elicitation` form extension. The shared request parser supports:

- `openaiForm` resource choices using `x-openai-input`: named file/directory URI choices, multiple selection and an optional manually entered native-machine file URI;
- legacy `openai/form` image pickers with bounded inline raster previews;
- a conservative non-exponential pattern subset in otherwise supported string fields.

Native resource options are returned by their exact values. Implicit defaults are visible selections, never automatic answers. Remote preview URLs/resource icons are not fetched; manually entered paths do not introduce a file-read API. Unknown widgets, nested/unsupported constraints, complex patterns and oversized forms remain explicitly unsupported instead of losing validation. Accept/decline/cancel, request identity and the current chat draft retain the existing behavior.

[App Server documentation](https://learn.chatgpt.com/docs/app-server) provides the elicitation and initialization capability context; the installed client supplied the precise extended field shapes. The live rejected desktop-tool inventory contained no unhandled tool names to implement; there is no generic host-tool execution bridge.

## Verification

- `tests/gpt-workspace.test.mjs`: exact retry, uncertainty/restart, canonical reconciliation, revision/permission/activity rejection, manual recovery, Canvas identity/version bounds, metadata projection and observed native HTTP statuses.
- `tests/gpt-workspace.browser.mjs`: real shared UI with simulated upstream replies in Chromium/WebKit, stale drafts, lost acknowledgement, native creation requests, Canvas version/restore controls, inert code, phone/tablet geometry and four themes.
- Existing elicitation unit/browser checks additionally exercise multi-file URI answers and inline image choice, preserving the message draft.
- Full repository tests, build/type checking and tracked-file checks run on Linux. Physical Safari/PWA keyboard, audio and device acceptance remain the owner's daily usage checks.

Engine/connector installation still requires genuine idle maintenance, including detached open terminals. The independent gateway does not own these operations and cannot replace their execution engine during an active task. Compatible existing UI publication remains independent; prepared native functionality must not be described as installed before the engine and connector postchecks pass.
