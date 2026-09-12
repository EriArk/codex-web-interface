# Native work visibility

The Hub consumes native `turn/plan/updated`, `thread/tokenUsage/updated`, `turn/diff/updated` and `item/commandExecution/outputDelta` notifications. See the [official App Server event contract](https://learn.chatgpt.com/docs/app-server). Raw reasoning streams remain excluded.

Schema 28 stores one bounded plan/diff/usage snapshot per turn and command logs keyed by Hub thread, native turn and native item. Output is coalesced at 500 ms rather than saving every delta as an Activity event. Each command retains the last 256,000 characters; the reader displays the last 64,000 and offers an authenticated plain-text download. All command logs share a 64 MiB retention budget, evicting completed logs first. Existing historical command events remain readable when a longer log is unavailable. Truncation is explicit; a download does not claim to recover bytes outside retention.

Progress contains native steps, collapsed combined changes and lazy live terminal output. Activity preserves access after completion. Context shows the last request's native input/output/cache counts and reported capacity; it never derives capacity from the model name or substitutes total lifetime usage. Account rate-limit notifications invalidate machine-scoped navigation metadata; clients refetch canonical limits without publishing the account payload.

The project capabilities disclosure lists native skills, installed plugins and MCP configuration with bounded output. Unsupported list methods remain independent failures. It does not install plugins, connect servers, acquire a conversation writer or expose arbitrary RPC operations. Actual rejected desktop tool names are grouped from existing result records.

Visible GPT content that cannot be rendered retains a source-bound audio/video/interactive/other placeholder alongside supported text and files. Hidden channels and reasoning formats remain absent; raw payload fields are never sent to the web client. The placeholder links to the exact original consumer conversation.

Verification includes native event fixtures, reconstruction, sparse metrics, log truncation, authenticated download boundaries, exact item/turn/thread isolation and shared Chromium/WebKit phone/tablet surfaces. Physical Apple acceptance remains the owner's everyday usage check.

## Native ChatGPT actions

Message actions expose native user-text editing, answer regeneration and version previews. A preview is read-only and includes at most the last 20 visible messages, with up to 40 versions and an explicit limit notice. Continuing a selected version creates a native branch only after the owner writes its first prompt. It preserves the original chat and does not silently replace the project's Current chat.

Each mutation persists an exact idempotency receipt and canonical source identity before entering the connector. Editing verifies the current branch, exact text and original attachment identities; regeneration requires a new public completed answer. A fork requires the selected visible context plus the exact first prompt and a confirmed new native chat ID. Unknown results block new mutations until read-only reconciliation or explicit manual review; they never replay a native click. Manual recovery cannot release the writer while the connector call is still in flight. Ordinary composer drafts remain separate from editing/branch drafts.

The browser integration uses the owner's authenticated consumer session and native controls. Read-only native version previews never expose hidden channels, internal tool payloads or signed asset URLs. Model/effort checks remain in the existing verified send path. Private connection view remains available for native controls whose current contract is not supported.

## Native ChatGPT project content

Project Overview opens **Instructions and files in ChatGPT**, separate from Hub Project Core. The editor lists native project files, downloads them through authenticated Hub endpoints, uploads a new source and explicitly confirms native source deletion. Uploads are limited to 25 MiB; downloads to 32 MiB. The browser's project-file download contract includes the validated project ID; it differs from ordinary conversation attachment downloads.

The saved editing revision covers instructions, name, appearance, permissions and source identities. Preflight revision checks run both on the Hub and immediately before the native update. The current native PATCH requires name/appearance fields alongside instructions, so those fields are preserved. Native PATCH provides no verified atomic conditional-write contract: preflight checks reduce stale writes but are not a server-side compare-and-swap guarantee. Refresh explicitly rebases a preserved draft; polling does not silently rebase it.

Project mutations share the GPT writer guard with sends, model changes, branch operations and library changes. Their durable receipts survive lost acknowledgements and engine restarts without automatic replay. Upload confirmation requires a new source with the exact name and byte size; an old or partly uploaded file cannot confirm it. Native source deletion refuses ambiguous duplicate-name rows instead of choosing a different file. The original project view is the fallback for these native ambiguities.

## Content search

The sidebar search icon opens content search; the existing field still filters navigation titles. Search covers global Notes, Tasks, Plans, Reports and Codex messages already stored on the Hub. The selected GPT chat is searched separately along its canonical visible current branch. Hits open the exact item/message through the existing bounded source-navigation path.

Each explicit page inspects up to 500 public records. The UI states its coverage and offers the next scan; it does not crawl all native chats, download historical Codex rollouts or acquire a writer. Queries are literal, Unicode-normalized and case-insensitive. Hidden reasoning and tool records remain excluded.

## Release and acceptance

These features require the schema-28 engine and matching GPT connector; the UI declares schema 28 compatibility and cannot be published against schema 27. Engine installation uses the existing guarded idle maintenance procedure, preserving a pre-migration SQLite backup and the independent Windows execution environment. Browser profile/login and connector secrets remain in their original private storage.

Disposable native-account checks verified text edit, regeneration, version continuation, instructions, source upload/download/removal. All disposable chats/projects were removed and the original selected chat/model/effort restored. Browser checks cover four themes, phone/tablet widths, exact retry, revision conflicts, lost acknowledgement, live output and source navigation. They are not physical iPhone/iPad acceptance.
