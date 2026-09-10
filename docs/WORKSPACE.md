# Workspace modules

The global Tasks and Notes lists share project filters and compact split-list/detail geometry. Opening Project Home filters the same storage; it does not create another notebook or task collection. Phone editing uses a single screen with a back control; iPad retains independent list and editor scrolling.

## Notes / issue #84

Capture a visible Codex/GPT user or assistant message with the note icon next to copy. Choose a project or Unassigned and save directly to the authenticated Hub. A frozen source records exact visible text, role, native conversation identity, message/turn identity and capture time. The editable note body is independent. A unique source/content/destination fingerprint and a stable request UUID make lost-response retries idempotent.

The source action resolves the original message in a bounded context. GPT keeps this context through normal polling and completed-job refreshes until the owner explicitly returns to the latest page or sends. Codex uses cached context, saved Hub messages or bounded native turn pages; unavailable sources report that explicitly instead of loading the entire conversation. Deletion of a source never cascades into saved note text.

Schema 14 adds `workspace_note_sources`; existing notes, revisions, source links, pins and tasks remain intact. The normal full-SQLite backup includes source snapshots.

## Visual references

The owner requested an external UI review. Layout principles were reviewed against [Todoist boards](https://www.todoist.com/help/articles/board-layout-in-todoist-nutzen-AiAVsyEI), [Linear project overview](https://linear.app/docs/projects) and [Linear project updates](https://linear.app/docs/initiative-and-project-updates): compact lists, contextual filters and separate details, with the existing CodexWeb semantic themes and 44px controls retained. No third-party UI runtime or content service is introduced.

## Verification

Notes regression tests cover scoping, exact Unicode text, revisions, lost responses, unavailable sources and private-route boundaries. Chromium/WebKit browser tests exercise direct capture, immutable source display, retry without duplication, exact backlinks, draft continuity, phone/tablet geometry and theme screenshots. Physical iPhone/iPad checks remain the owner's everyday usage, not simulated hardware acceptance.

## Project Core / issue #87

Project Home opens the owner-maintained Core: purpose, behavior, rules, constraints, architecture and preferences. Six bounded fields remain distinct from dynamic activity. Edits use explicit revisions and durable device drafts. Lost save acknowledgements with identical contents are idempotent; conflicting edits show the other version before any explicit replacement.

Schema 15 stores Core and its last 40 versions independently of native project/chat records. Restoration creates a new version; it never deletes the intervening history. Version lists page ten metadata rows at a time. Deleting/archiving a native project retains its saved Core; no source folder, repository instructions or native writer is changed. The complete SQLite backup includes both tables.

Core text is available for the forthcoming current-chat bootstrap only. It is not automatically appended to ordinary messages. Chromium/WebKit check phone/tablet editing, draft preservation, conflicts, history and explicit restore with four-theme screenshots.


## Plans and Reports

Plans are project-owned ordered checklist packages, separate from human Tasks and native Work/Plan mode. Their saved version produces a reviewable ordinary request. Checked items remain explicit existing state. The confirmed action uses the existing native queue/turn or durable GPT outbox, per-chat permissions and desktop handoff. An uncertain receipt never automatically repeats work. Drafts survive closing the panel; edits use revision conflicts and exact-save retries.

Reports freeze a bounded Hub activity digest and the last successful report boundary at preparation. The checkpoint advances only after a confirmed native completion and stored visible final answer. A failed/unknown/image-only answer cannot advance it. Recent turns across chats, Results, Tasks, Plans, Notes and cached Git observations remain separate from claims of comprehensive verification. Saved answers and source links remain available after native chat deletion.

All four workspace sections share navigation and project filters. The wide view is a list/editor layout; phones show one at a time. Actions retain the underlying chat draft and do not navigate to execution unless requested.

Verification: backend tests cover exact retry, revision conflicts, ownership, native queues, unknown outcomes, report checkpoints and delayed final events. Chromium/WebKit journeys cover local drafts, lost save acknowledgement, explicit execution, report history, four themes and phone/tablet layout. Physical iPhone/iPad acceptance remains the owner's usage check.
